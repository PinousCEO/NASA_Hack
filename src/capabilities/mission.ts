/**
 * Mission-state capabilities: inspect the shared state and stage changes in the request's
 * draft workspace. None of these can modify the published mission directly.
 */
import { standardLinks } from "../systems/graph.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { applyPatches, getPath, type PatchOp, pathsOverlap } from "../core/paths.js";
import { CapabilityError } from "../core/types.js";
import type { ResearchMemory } from "../memory/memory.js";
import { type Capability, defineCapability, type ExecutionContext } from "../registry/capability.js";
import { runInSandbox } from "../sandbox/sandbox.js";
import { validateModuleSource } from "../sandbox/typecheck.js";
import { recalculate } from "../state/recalc.js";
import { ComponentSchema, type MissionConfig, parseMissionConfig, SceneNodeSchema } from "../state/schema.js";

export const PatchSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("set"), path: z.string().min(1), value: z.unknown() }),
  z.object({ op: z.literal("append"), path: z.string().min(1), value: z.unknown() }),
  z.object({ op: z.literal("remove"), path: z.string().min(1) }),
]);

const scriptPermission = z.enum(["state:read", "state:propose", "calc"]);
/** Paths that may only be changed through their dedicated, validating capabilities. */
const RESERVED = ["scripts", "assets"];

/** Stage patches only if the resulting configuration is valid as a whole. */
export function proposeValidated(ctx: ExecutionContext, patches: PatchOp[], options: { allowReserved?: boolean } = {}): MissionConfig {
  if (!options.allowReserved) {
    const reserved = patches.find((p) => RESERVED.some((r) => pathsOverlap(p.path, r)));
    if (reserved) {
      throw new CapabilityError(`Path "${reserved.path}" is reserved: scripts and assets are added through their validating capabilities`, { code: "reserved_path" });
    }
  }
  let candidate: unknown;
  try {
    candidate = applyPatches(ctx.draft.workingConfig(), patches);
  } catch (err) {
    throw new CapabilityError(`Patch cannot be applied: ${err instanceof Error ? err.message : String(err)}`, { code: "invalid_patch" });
  }
  const parsed = parseMissionConfig(candidate);
  if (!parsed.ok) throw new CapabilityError(`Change would make the mission configuration invalid: ${parsed.issues.join("; ")}`, { code: "invalid_config" });
  for (const p of patches) ctx.draft.propose(p);
  return parsed.config;
}

function workingMission(ctx: ExecutionContext): MissionConfig {
  const parsed = parseMissionConfig(ctx.draft.workingConfig());
  if (!parsed.ok) throw new CapabilityError(`Draft configuration is invalid: ${parsed.issues.join("; ")}`);
  return parsed.config;
}

export function missionCapabilities(deps: { memory: ResearchMemory }): Capability[] {
  return [
    defineCapability({
      id: "mission.inspect",
      name: "Inspect mission state",
      description: "Read the shared mission configuration (including changes already drafted in this request) and its derived simulation results.",
      category: "internal_api",
      provides: ["state.read"],
      input: z.object({ paths: z.array(z.string()).default([]), includeDerived: z.boolean().default(true) }),
      output: z.object({
        publishedVersion: z.number(),
        missionName: z.string(),
        values: z.record(z.string(), z.unknown()),
        derived: z.record(z.string(), z.unknown()),
        componentIds: z.array(z.string()),
        hasRover: z.boolean(),
      }),
      requiredPermissions: ["state:read"],
      verification: { status: "self_tested", method: "Pipeline integration tests" },
      outputVerification: "deterministic_calculation",
      run: (input, ctx) => {
        const config = workingMission(ctx);
        const derived = ctx.draft.isEmpty ? ctx.mission.derived : recalculate(config, { config: ctx.mission.config, derived: ctx.mission.derived }).derived;
        return {
          output: {
            publishedVersion: ctx.mission.version,
            missionName: config.meta.name,
            values: Object.fromEntries(input.paths.map((p) => [p, getPath(config, p) ?? null])),
            derived: input.includeDerived ? Object.fromEntries(Object.entries(derived).map(([k, v]) => [k, v.value])) : {},
            componentIds: [...config.spacecraft.components, ...(config.rover?.components ?? [])].map((c) => c.id),
            hasRover: config.rover !== undefined,
          },
        };
      },
      defaultInput: ({ params }) => ({ paths: Array.isArray(params.paths) ? params.paths : [] }),
    }),
    defineCapability({
      id: "mission.propose_patch",
      name: "Propose configuration change",
      description: "Stage set/append/remove changes to the mission configuration in the draft workspace. The whole configuration must remain valid. Changes are published only after preview and approval.",
      category: "internal_api",
      provides: ["state.propose_patch"],
      input: z.object({ patches: z.array(PatchSchema).min(1), rationale: z.string().default("") }),
      output: z.object({ staged: z.number(), changedPaths: z.array(z.string()) }),
      requiredPermissions: ["state:propose"],
      constraints: { effect: "draft_write", idempotent: false },
      verification: { status: "self_tested", method: "Pipeline integration tests" },
      outputVerification: "deterministic_calculation",
      run: (input, ctx) => {
        proposeValidated(ctx, input.patches as PatchOp[]);
        return { output: { staged: input.patches.length, changedPaths: input.patches.map((p) => p.path) } };
      },
      defaultInput: ({ params }) => ({ patches: params.patches, rationale: typeof params.rationale === "string" ? params.rationale : "" }),
    }),
    defineCapability({
      id: "mission.add_component",
      name: "Add component",
      description: "Stage a new spacecraft or rover component (solar panel, battery, antenna or load), optionally with a scene node that shows a 3D asset for it.",
      category: "internal_api",
      provides: ["state.add_component"],
      input: z.object({
        target: z.enum(["spacecraft", "rover"]).default("spacecraft"),
        component: ComponentSchema,
        assetId: z.string().optional(),
        sceneNode: SceneNodeSchema.partial().optional(),
        /** Also run the part's standard power, data and control lines to the bus. */
        connect: z.boolean().default(false),
      }),
      output: z.object({ componentId: z.string(), sceneNodeId: z.string().nullable(), target: z.string(), lines: z.array(z.string()) }),
      requiredPermissions: ["state:propose"],
      constraints: { effect: "draft_write", idempotent: false },
      verification: { status: "self_tested", method: "Pipeline integration tests" },
      outputVerification: "deterministic_calculation",
      run: (input, ctx) => {
        const config = workingMission(ctx);
        if (input.target === "rover" && !config.rover) throw new CapabilityError("This mission has no rover to add components to", { code: "no_rover" });
        const patches: PatchOp[] = [{ op: "append", path: `${input.target}.components`, value: input.component }];
        let sceneNodeId: string | null = null;
        if (input.assetId) {
          sceneNodeId = input.sceneNode?.id ?? `node_${input.component.id}`;
          patches.push({
            op: "append",
            path: "scene.nodes",
            value: { name: input.component.name, ...input.sceneNode, id: sceneNodeId, assetId: input.assetId, componentId: input.component.id },
          });
        }
        // Lines are sized for the part as it is being added; a wired mission needs them for the part to do anything.
        const lines = input.connect && input.target === "spacecraft" && config.systems?.wired
          ? standardLinks({ ...config, spacecraft: { ...config.spacecraft, components: [...config.spacecraft.components, input.component] } }, input.component.id)
          : [];
        for (const line of lines) patches.push({ op: "append", path: "systems.links", value: line });
        proposeValidated(ctx, patches);
        return { output: { componentId: input.component.id, sceneNodeId, target: input.target, lines: lines.map((l) => `${l.kind} ${l.from.node}.${l.from.port} → ${l.to.node}.${l.to.port}${l.rating ? ` (${l.rating} ${l.kind === "power" ? "W" : "bit/s"})` : ""}`) } };
      },
      defaultInput: ({ params }) => ({ target: params.target ?? "spacecraft", component: params.component, assetId: params.assetId, connect: params.connect === true }),
    }),
    defineCapability({
      id: "mission.attach_script",
      name: "Attach script",
      description: "Statically validate a TypeScript module against the controlled mission API, run it in the isolated sandbox, and stage it as a mission script. Unvalidated code cannot be attached.",
      category: "code_generation",
      provides: ["state.attach_script"],
      input: z.object({
        name: z.string().min(1).max(80),
        source: z.string().min(1),
        permissions: z.array(scriptPermission).default(["state:read", "calc"]),
        testInput: z.record(z.string(), z.unknown()).default({}),
        origin: z.object({ kind: z.enum(["model_generated", "user_authored"]), modelId: z.string().optional() }),
      }),
      output: z.object({ scriptId: z.string(), sha256: z.string(), sandboxDurationMs: z.number(), sandboxResult: z.unknown() }),
      dependencies: ["code.validate_module"],
      requiredPermissions: ["state:propose", "code:execute_sandbox"],
      resources: { cpu: "medium", typicalDurationMs: 800, memoryMb: 64 },
      constraints: { effect: "draft_write", idempotent: false, timeoutMs: 20000 },
      verification: { status: "self_tested", method: "Sandbox escape and policy tests (tests/sandbox.test.ts)" },
      outputVerification: "deterministic_calculation",
      run: async (input, ctx) => {
        const checked = validateModuleSource(input.source);
        if (!checked.ok || !checked.compiledJs) {
          throw new CapabilityError(`Script failed static validation: ${[...checked.policyViolations, ...checked.diagnostics].join("; ")}`, { code: "script_invalid" });
        }
        const config = workingMission(ctx);
        const run = await runInSandbox({ compiledJs: checked.compiledJs, permissions: input.permissions, config, derived: ctx.mission.derived, input: input.testInput });
        if (!run.ok) throw new CapabilityError(`Script failed its sandbox test run: ${run.error}`, { code: "script_runtime_error" });
        const sha256 = createHash("sha256").update(input.source).digest("hex");
        const scriptId = `s${sha256.slice(0, 12)}`;
        if (!config.scripts.some((s) => s.id === scriptId)) {
          proposeValidated(
            ctx,
            [{ op: "append", path: "scripts", value: { id: scriptId, name: input.name, language: "typescript", source: input.source, compiledJs: checked.compiledJs, sha256, permissions: input.permissions, origin: input.origin } }],
            { allowReserved: true },
          );
        }
        return {
          output: { scriptId, sha256, sandboxDurationMs: run.durationMs, sandboxResult: run.result ?? null },
          assumptions: ["Sandbox test run used the provided test input only; behaviour for other inputs is not established"],
        };
      },
    }),
    defineCapability({
      id: "script.run",
      name: "Run mission script",
      description: "Execute an attached mission script in the isolated sandbox. Any configuration changes it proposes are staged in the draft workspace for approval.",
      category: "simulation",
      provides: ["script.run"],
      input: z.object({ scriptId: z.string(), input: z.record(z.string(), z.unknown()).default({}) }),
      output: z.object({ result: z.unknown(), logs: z.array(z.string()), stagedPatches: z.number(), durationMs: z.number() }),
      requiredPermissions: ["code:execute_sandbox", "state:propose"],
      resources: { cpu: "medium", typicalDurationMs: 300, memoryMb: 64 },
      constraints: { effect: "draft_write", idempotent: false, timeoutMs: 15000 },
      verification: { status: "self_tested", method: "Sandbox tests (tests/sandbox.test.ts)" },
      outputVerification: "deterministic_calculation",
      run: async (input, ctx) => {
        const config = workingMission(ctx);
        const script = config.scripts.find((s) => s.id === input.scriptId);
        if (!script) throw new CapabilityError(`Script "${input.scriptId}" is not attached to this mission`, { code: "script_not_found" });
        // Always recompile from source: the stored JavaScript is never trusted.
        const checked = validateModuleSource(script.source);
        if (!checked.ok || !checked.compiledJs) throw new CapabilityError("Stored script no longer passes static validation", { code: "script_invalid" });
        const run = await runInSandbox({ compiledJs: checked.compiledJs, permissions: script.permissions, config, derived: ctx.mission.derived, input: input.input });
        if (!run.ok) throw new CapabilityError(`Script failed: ${run.error}`, { code: "script_runtime_error" });
        if (run.proposedPatches.length) proposeValidated(ctx, run.proposedPatches);
        return {
          output: { result: run.result ?? null, logs: run.logs, stagedPatches: run.proposedPatches.length, durationMs: run.durationMs },
          assumptions: script.origin.kind === "model_generated" ? ["Script logic is model-generated; its results inherit that status unless independently checked"] : [],
        };
      },
    }),
    defineCapability({
      id: "memory.search",
      name: "Search research memory",
      description: "Retrieve similar past requests, design changes, simulation results, failures and outcomes from the research memory (lexical similarity).",
      category: "internal_api",
      provides: ["memory.search"],
      input: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) }),
      output: z.object({
        matches: z.array(z.object({ id: z.string(), kind: z.string(), summary: z.string(), score: z.number(), verification: z.string(), createdAt: z.string() })),
      }),
      requiredPermissions: ["memory:read"],
      verification: { status: "self_tested", method: "tests/memory.test.ts" },
      outputVerification: "heuristic",
      run: (input) => ({
        output: {
          matches: deps.memory.search(input.query, { limit: input.limit }).map(({ record, score }) => ({
            id: record.id,
            kind: record.kind,
            summary: record.summary,
            score,
            verification: record.verification,
            createdAt: record.createdAt,
          })),
        },
        assumptions: ["Lexical (TF-IDF) similarity; semantically related records with different wording may be missed"],
      }),
      defaultInput: ({ params }) => ({ query: params.query }),
    }),
  ];
}
