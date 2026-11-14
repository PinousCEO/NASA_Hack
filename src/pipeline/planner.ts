/**
 * Execution planning: structured requirement → dependency graph of tasks.
 *
 * Capabilities are never referenced by hard-coded id here. Recipes name the *kind* of
 * capability they need (a `provides` tag); the registry resolves that to whatever usable
 * capability currently provides it — internal service or MCP tool. Requests no recipe can
 * express go to the model-based planner, which composes tasks from the live catalogue.
 */
import { z } from "zod";
import { assetSpecForComponent } from "../capabilities/assets.js";
import { newId, type Permission, ROLE_PERMISSIONS, type User } from "../core/types.js";
import type { LlmService } from "../llm/llm.js";
import type { CapabilityDescriptor } from "../registry/capability.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import type { Component } from "../state/schema.js";
import type { MissionVersion } from "../state/store.js";
import type { Criterion, Operation, Plan, PlanIssue, PlanTask, StructuredRequirement } from "./types.js";

export interface PlanningResult {
  plan: Plan;
  issues: PlanIssue[];
}

export const ref = (taskId: string, path: string): { $ref: string; path: string } => ({ $ref: taskId, path });
export const isRef = (v: unknown): v is { $ref: string; path?: string } =>
  typeof v === "object" && v !== null && typeof (v as { $ref?: unknown }).$ref === "string";

/** Input placeholder: "build this input from mission state when the task runs". */
export const fromState = (params: Record<string, unknown>): { $fromState: Record<string, unknown> } => ({ $fromState: params });
export const isFromState = (v: unknown): v is { $fromState: Record<string, unknown> } =>
  typeof v === "object" && v !== null && typeof (v as { $fromState?: unknown }).$fromState === "object" && (v as { $fromState?: unknown }).$fromState !== null;

/** Task ids referenced anywhere inside an input value. */
export function collectRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (isRef(value)) out.add(value.$ref);
  else if (Array.isArray(value)) value.forEach((v) => collectRefs(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectRefs(v, out));
  return out;
}

/** Structural validation of a task graph: unique ids, known dependencies, no cycles. */
export function validateGraph(tasks: PlanTask[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) errors.push(`duplicate task id "${t.id}"`);
    ids.add(t.id);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) if (!ids.has(dep)) errors.push(`task "${t.id}" depends on unknown task "${dep}"`);
    for (const r of collectRefs(t.input)) {
      if (!ids.has(r)) errors.push(`task "${t.id}" references output of unknown task "${r}"`);
      else if (!t.dependsOn.includes(r)) t.dependsOn.push(r); // a data reference is a dependency
    }
  }
  if (errors.length) return errors;
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn)]));
  while (remaining.size) {
    const ready = [...remaining].filter(([, deps]) => deps.size === 0).map(([id]) => id);
    if (ready.length === 0) return [`dependency cycle among tasks: ${[...remaining.keys()].join(", ")}`];
    for (const id of ready) {
      remaining.delete(id);
      for (const deps of remaining.values()) deps.delete(id);
    }
  }
  return [];
}

interface Step {
  key: string;
  need: string;
  why: string;
  dependsOn?: string[];
  /** Explicit input (may contain refs); otherwise the capability's defaultInput is used. */
  input?: unknown;
  params?: Record<string, unknown>;
  expectedOutputs: string[];
  validation?: Criterion[];
}

const LlmPlan = z.object({
  tasks: z.array(
    z.object({
      id: z.string().describe("Short unique id, letters/digits/underscore"),
      description: z.string(),
      capabilityId: z.string(),
      reason: z.string().describe("Why this capability, and why not the alternatives"),
      dependsOn: z.array(z.string()),
      inputJson: z.string().describe("JSON input for the capability; may contain {\"$ref\": taskId, \"path\": \"output.path\"} bindings"),
      expectedOutputs: z.array(z.string()),
      validation: z.array(z.object({ path: z.string(), op: z.enum(["exists", "truthy", "==", "!=", ">", ">=", "<", "<="]), valueJson: z.string() })),
    }),
  ),
  unmetNeeds: z.array(z.string()).describe("Things the request needs that no listed capability can do"),
});

const PLANNER_SYSTEM = `You are the planning stage of a mission-engineering system. Given a structured requirement, the current mission state and a catalogue of capabilities, produce a dependency graph of tasks.

Rules:
- Use only capability ids from the catalogue, and give each task an input that satisfies that capability's input schema.
- To pass one task's output into another, put {"$ref": "<taskId>", "path": "<path inside that task's output>"} where the value goes. A task that references another depends on it.
- Tasks without dependencies between them run in parallel; add a dependency only when order matters.
- Inspect state before changing it. Capabilities with effect "draft_write" only stage changes; staging is how every modification is made. Nothing is published without human approval, so do not try to work around that.
- Prefer capabilities whose outputVerification is deterministic_calculation or external_data for any quantitative claim. Model-generated outputs (model_judgment) must be followed by a validating task where one exists.
- Add validation criteria for outputs that later tasks rely on.
- If the catalogue cannot satisfy part of the request, list it under unmetNeeds rather than approximating it with an unrelated capability.`;

export class Planner {
  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly llm: LlmService,
  ) {}

  async plan(requirement: StructuredRequirement, mission: MissionVersion, user: User, requestId: string, signal?: AbortSignal): Promise<PlanningResult> {
    const permissions = ROLE_PERMISSIONS[user.role];
    if (requirement.operations.some((o) => o.intent === "custom")) {
      return this.planWithModel(requirement, mission, permissions, requestId, signal);
    }
    const tasks: PlanTask[] = [];
    const issues: PlanIssue[] = [];
    let previousWriter: string | undefined;
    for (const op of requirement.operations) {
      const built = this.buildOperation(op, mission, permissions, issues);
      // Operations run in request order once something has been staged, so every later
      // operation (including read-only calculations) sees the earlier drafted changes.
      if (previousWriter) for (const t of built) if (t.dependsOn.length === 0) t.dependsOn.push(previousWriter);
      const writers = built.filter((t) => this.registry.get(t.capabilityId)?.descriptor.constraints.effect === "draft_write");
      if (writers.length) previousWriter = writers[writers.length - 1]!.id;
      tasks.push(...built);
    }
    for (const error of validateGraph(tasks)) issues.push({ operationId: "*", kind: "invalid_plan", detail: error });
    return { plan: { id: newId("plan"), requestId, createdBy: "recipe", tasks, status: "draft", rolledBack: false }, issues };
  }

  /** Explain why nothing usable provides a tag (drives the feasibility classification). */
  private diagnose(op: Operation, tag: string, permissions: Permission[]): PlanIssue {
    const all = this.registry.search({ provides: tag }).map((m) => m.descriptor);
    if (all.length === 0) return { operationId: op.id, kind: "no_capability", tag, detail: `No registered capability provides "${tag}"` };
    const implemented = all.filter((d) => d.developmentStatus !== "planned");
    if (implemented.length === 0) {
      return { operationId: op.id, kind: "capability_planned", tag, capabilityId: all[0]!.id, detail: `"${all[0]!.id}" is planned but not implemented: ${all[0]!.availability.reason ?? ""}` };
    }
    const reachable = implemented.filter((d) => d.availability.status !== "unavailable");
    if (reachable.length === 0) {
      return { operationId: op.id, kind: "capability_unavailable", tag, capabilityId: implemented[0]!.id, detail: `"${implemented[0]!.id}" is unavailable: ${implemented[0]!.availability.reason ?? "unknown reason"}` };
    }
    const d = reachable[0]!;
    const missing = d.requiredPermissions.filter((p) => !permissions.includes(p));
    return { operationId: op.id, kind: "permission_denied", tag, capabilityId: d.id, missingPermissions: missing, detail: `"${d.id}" requires permissions the requesting user lacks: ${missing.join(", ")}` };
  }

  private buildOperation(op: Operation, mission: MissionVersion, permissions: Permission[], issues: PlanIssue[]): PlanTask[] {
    const steps = recipe(op);
    if (!steps) {
      issues.push({ operationId: op.id, kind: "planner_unavailable", detail: `No planning recipe for intent "${op.intent}"` });
      return [];
    }
    const tasks: PlanTask[] = [];
    const idOf = (key: string): string => `${op.id}_${key}`;
    for (const step of steps) {
      const matches = this.registry.search({ provides: step.need, usableOnly: true, permissions });
      const chosen: CapabilityDescriptor | undefined = matches[0]?.descriptor;
      if (!chosen) {
        issues.push(this.diagnose(op, step.need, permissions));
        return []; // an operation with a missing step cannot be partially planned
      }
      const capability = this.registry.get(chosen.id)!;
      const params = { ...op.params, ...step.params };
      // Inputs derived from mission state are bound at execution time, so a task that runs
      // after a staged change sees the drafted configuration, not the published one.
      const stateBound = step.input === undefined && capability.defaultInput !== undefined;
      const probe = step.input ?? (stateBound ? capability.defaultInput!({ config: mission.config, derived: mission.derived, params }) : params);
      const input = stateBound ? fromState(params) : probe;
      if (collectRefs(probe).size === 0) {
        const check = capability.validateInput(probe);
        if (!check.ok) {
          issues.push({ operationId: op.id, kind: "invalid_input", capabilityId: chosen.id, detail: `Not enough data to call "${chosen.id}": ${check.errors.join("; ")}` });
          return [];
        }
      }
      const alternatives = matches.slice(1).map((m) => m.descriptor.id);
      tasks.push({
        id: idOf(step.key),
        operationId: op.id,
        description: step.why,
        capabilityId: chosen.id,
        selectionReason:
          `Needs "${step.need}". Selected "${chosen.id}" (${chosen.outputVerification.replace(/_/g, " ")}, ${chosen.availability.status})` +
          (alternatives.length ? `; ranked above ${alternatives.join(", ")}.` : "; it is the only usable provider."),
        alternativesConsidered: alternatives,
        dependsOn: (step.dependsOn ?? []).map(idOf),
        input: mapRefs(input, idOf),
        expectedOutputs: step.expectedOutputs,
        validation: step.validation ?? [],
        status: "pending",
        attempts: 0,
      });
    }
    return tasks;
  }

  private async planWithModel(requirement: StructuredRequirement, mission: MissionVersion, permissions: Permission[], requestId: string, signal?: AbortSignal): Promise<PlanningResult> {
    const empty = (issues: PlanIssue[]): PlanningResult => ({ plan: { id: newId("plan"), requestId, createdBy: "llm", modelId: this.llm.modelId, tasks: [], status: "draft", rolledBack: false }, issues });
    const status = this.llm.status();
    if (!status.available) {
      return empty([{ operationId: "*", kind: "planner_unavailable", detail: `This request needs multi-tool planning by a language model, which is unavailable: ${status.reason}` }]);
    }
    const catalogue = this.registry.search({ usableOnly: true, permissions }).map(({ descriptor: d }) => ({
      id: d.id,
      description: d.description,
      provides: d.provides,
      effect: d.constraints.effect,
      outputVerification: d.outputVerification,
      inputSchema: d.inputSchema,
      outputSchema: d.outputSchema,
    }));
    const { assets: _assets, scripts, ...core } = mission.config;
    const out = await this.llm.structured({
      system: PLANNER_SYSTEM,
      schema: LlmPlan,
      ...(signal ? { signal } : {}),
      prompt: [
        `Capability catalogue:\n${JSON.stringify(catalogue)}`,
        `Mission configuration (version ${mission.version}):\n${JSON.stringify({ ...core, scripts: scripts.map((s) => ({ id: s.id, name: s.name })) })}`,
        `Structured requirement:\n${JSON.stringify({ summary: requirement.summary, operations: requirement.operations })}`,
      ].join("\n\n"),
    });
    const issues: PlanIssue[] = out.unmetNeeds.map((need) => ({ operationId: "*", kind: "no_capability" as const, detail: `Planner found no capability for: ${need}` }));
    const tasks: PlanTask[] = [];
    for (const t of out.tasks) {
      const descriptor = this.registry.get(t.capabilityId)?.descriptor;
      if (!descriptor || !this.registry.isUsable(descriptor)) {
        issues.push({ operationId: "*", kind: "invalid_plan", capabilityId: t.capabilityId, detail: `Planner selected "${t.capabilityId}", which is not a usable capability` });
        continue;
      }
      const missing = descriptor.requiredPermissions.filter((p) => !permissions.includes(p));
      if (missing.length) {
        issues.push({ operationId: "*", kind: "permission_denied", capabilityId: descriptor.id, missingPermissions: missing, detail: `"${descriptor.id}" requires ${missing.join(", ")}` });
        continue;
      }
      let input: unknown;
      const validation: Criterion[] = [];
      try {
        input = JSON.parse(t.inputJson);
        for (const v of t.validation) validation.push({ path: v.path, op: v.op, ...(v.op === "exists" || v.op === "truthy" ? {} : { value: JSON.parse(v.valueJson) as unknown }) });
      } catch {
        issues.push({ operationId: "*", kind: "invalid_plan", capabilityId: descriptor.id, detail: `Task "${t.id}" has unparsable JSON in its input or validation` });
        continue;
      }
      tasks.push({
        id: t.id,
        operationId: "*",
        description: t.description,
        capabilityId: descriptor.id,
        selectionReason: `${t.reason} [selected by ${this.llm.modelId}; model judgement]`,
        alternativesConsidered: this.registry.alternatives(descriptor.id).map((d) => d.id),
        dependsOn: [...t.dependsOn],
        input,
        expectedOutputs: t.expectedOutputs,
        validation,
        status: "pending",
        attempts: 0,
      });
    }
    for (const error of validateGraph(tasks)) issues.push({ operationId: "*", kind: "invalid_plan", detail: error });
    return { plan: { id: newId("plan"), requestId, createdBy: "llm", modelId: this.llm.modelId, tasks, status: "draft", rolledBack: false }, issues };
  }
}

function mapRefs(value: unknown, idOf: (key: string) => string): unknown {
  if (isRef(value)) return { ...value, $ref: idOf(value.$ref) };
  if (Array.isArray(value)) return value.map((v) => mapRefs(v, idOf));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapRefs(v, idOf)]));
  return value;
}

/** Deterministic recipes: the capability *needs* of each intent and how data flows between steps. */
function recipe(op: Operation): Step[] | null {
  const p = op.params;
  switch (op.intent) {
    case "set_config": {
      const patches = (p.patches as { path: string }[]) ?? [];
      return [
        { key: "inspect", need: "state.read", why: "Inspect the current values before changing them", params: { paths: patches.map((x) => x.path) }, expectedOutputs: ["values"] },
        { key: "stage", need: "state.propose_patch", why: op.description, dependsOn: ["inspect"], expectedOutputs: ["staged", "changedPaths"], validation: [{ path: "staged", op: ">=", value: 1 }] },
      ];
    }
    case "add_component": {
      const component = p.component as Component;
      const steps: Step[] = [{ key: "inspect", need: "state.read", why: "Inspect existing components before adding one", params: { paths: [`${String(p.target ?? "spacecraft")}.components`] }, expectedOutputs: ["componentIds"] }];
      const withAsset = p.withAsset !== false;
      if (withAsset) {
        steps.push({ key: "asset", need: "asset.glb", why: `Generate a 3D asset for "${component.name}"`, params: { assetSpec: assetSpecForComponent(component), description: component.name }, expectedOutputs: ["assetId", "uri"], validation: [{ path: "triangles", op: ">", value: 0 }] });
      }
      steps.push({
        key: "stage",
        need: "state.add_component",
        why: op.description,
        dependsOn: withAsset ? ["inspect", "asset"] : ["inspect"],
        input: { target: p.target ?? "spacecraft", component, ...(withAsset ? { assetId: ref("asset", "assetId") } : {}) },
        expectedOutputs: ["componentId", "sceneNodeId"],
      });
      return steps;
    }
    case "compute":
      return typeof p.need === "string" ? [{ key: "calc", need: p.need, why: op.description, expectedOutputs: ["result"] }] : null;
    case "simulate_power":
      return [{ key: "sim", need: "sim.power.timeline", why: op.description, expectedOutputs: ["minStateOfCharge", "energyBalancedPerOrbit"], validation: [{ path: "steps", op: ">", value: 0 }] }];
    case "retrieve_ephemeris":
      return [{ key: "fetch", need: "data.ephemeris.precise", why: op.description, expectedOutputs: ["positionAu", "distanceKm"], validation: [{ path: "distanceAu", op: ">", value: 0 }] }];
    case "generate_asset":
      if (!p.assetSpec && typeof p.prompt === "string") {
        return [{ key: "asset", need: "asset.generative", why: op.description, input: { prompt: p.prompt }, expectedOutputs: ["assetId", "uri", "sceneNodeId"], validation: [{ path: "triangles", op: ">", value: 0 }] }];
      }
      return [{ key: "asset", need: "asset.glb", why: op.description, expectedOutputs: ["assetId", "uri"], validation: [{ path: "triangles", op: ">", value: 0 }] }];
    case "generate_script":
      return [
        { key: "generate", need: "code.generate", why: "Generate the module source with a language model", expectedOutputs: ["source", "testInput"] },
        {
          key: "validate", need: "code.validate", why: "Type-check the generated module and run it in the isolated sandbox", dependsOn: ["generate"],
          input: { source: ref("generate", "source"), permissions: ref("generate", "permissions"), testInput: ref("generate", "testInput") },
          expectedOutputs: ["passed"], validation: [{ path: "passed", op: "==", value: true }],
        },
        {
          key: "attach", need: "state.attach_script", why: "Stage the validated module as a mission script", dependsOn: ["validate"],
          input: { name: typeof p.name === "string" ? p.name.slice(0, 80) : "Generated script", source: ref("generate", "source"), permissions: ref("generate", "permissions"), testInput: ref("generate", "testInput"), origin: { kind: "model_generated", modelId: ref("generate", "modelId") } },
          expectedOutputs: ["scriptId"],
        },
      ];
    case "run_script":
      return [{ key: "run", need: "script.run", why: op.description, input: { scriptId: p.scriptId, input: p.input ?? {} }, expectedOutputs: ["result", "stagedPatches"] }];
    case "search_memory":
      return [{ key: "search", need: "memory.search", why: op.description, expectedOutputs: ["matches"] }];
    default:
      return null;
  }
}
