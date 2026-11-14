/**
 * Code capabilities: model-driven TypeScript generation and deterministic validation.
 * Generated code is `model_judgment` until it has passed static validation and a sandbox
 * run, and even then only its *execution safety* is established, not its correctness.
 */
import { z } from "zod";
import type { LlmService } from "../llm/llm.js";
import { type Capability, defineCapability } from "../registry/capability.js";
import { MISSION_API_DTS, SCRIPT_CONTRACT } from "../sandbox/api.js";
import { runInSandbox } from "../sandbox/sandbox.js";
import { validateModuleSource } from "../sandbox/typecheck.js";
import { parseMissionConfig } from "../state/schema.js";

const scriptPermission = z.enum(["state:read", "state:propose", "calc"]);

const GeneratedModule = z.object({
  source: z.string().describe("Complete TypeScript module source"),
  explanation: z.string().describe("What the module does and which mission paths it reads or proposes changes to"),
  testInputJson: z.string().describe("JSON object to pass to run() for a smoke test"),
});

const SYSTEM = `You write small TypeScript modules that run inside a locked-down sandbox attached to a space-mission design workspace.

Module contract: ${SCRIPT_CONTRACT}

The only API available is the global \`mission\` object declared below. There is no DOM, no Node.js, no network, no timers and no imports — code that references anything else is rejected by the validator. The module is type-checked in strict mode, so values returned by mission.get/derived/calc are \`unknown\`/\`Record<string, unknown>\` and must be narrowed before use.

${MISSION_API_DTS}

State changes are proposals only: mission.propose() queues a change for human review. Prefer reading inputs from mission state over hard-coding numbers, and state units in identifiers.`;

export function codeCapabilities(deps: { llm: LlmService }): Capability[] {
  return [
    defineCapability({
      id: "code.generate_module",
      name: "Generate TypeScript module",
      description: "Use a language model to write a sandbox-compatible TypeScript module (export function run) against the controlled mission API. Output is unvalidated model output; validate it before attaching.",
      category: "code_generation",
      provides: ["code.generate"],
      input: z.object({
        task: z.string().min(1).describe("What the module should do"),
        permissions: z.array(scriptPermission).default(["state:read", "calc"]),
        existingSource: z.string().optional().describe("Source to modify, for code-modification requests"),
      }),
      output: z.object({
        source: z.string(),
        explanation: z.string(),
        testInput: z.record(z.string(), z.unknown()),
        permissions: z.array(scriptPermission),
        modelId: z.string(),
      }),
      dependencies: ["Anthropic Messages API"],
      requiredPermissions: ["code:generate", "llm:invoke"],
      resources: { network: true, cpu: "low", typicalDurationMs: 30000 },
      constraints: { timeoutMs: 180000, maxRetries: 1, idempotent: true, effect: "external_read" },
      verification: { status: "unverified", method: "Model output; correctness depends on downstream validation" },
      developmentStatus: "experimental",
      outputVerification: "model_judgment",
      healthCheck: async () => {
        const s = deps.llm.status();
        return s.available ? { status: "available" } : { status: "unavailable", reason: s.reason ?? "Language model unavailable" };
      },
      run: async (input, ctx) => {
        const config = parseMissionConfig(ctx.draft.workingConfig());
        const stateOutline = config.ok
          ? JSON.stringify({ ...config.config, assets: undefined, scripts: undefined, scene: undefined })
          : "(unavailable)";
        const generated = await deps.llm.structured({
          system: SYSTEM,
          schema: GeneratedModule,
          signal: ctx.signal,
          prompt: [
            `Task: ${input.task}`,
            `Permissions granted to the module: ${input.permissions.join(", ")}`,
            `Derived result node ids: ${Object.keys(ctx.mission.derived).join(", ")}`,
            `Current mission configuration (JSON):\n${stateOutline}`,
            input.existingSource ? `Modify this existing module:\n${input.existingSource}` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
        let testInput: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(generated.testInputJson);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) testInput = parsed as Record<string, unknown>;
        } catch {
          ctx.log("Model supplied an unparsable test input; using {}");
        }
        return {
          output: { source: generated.source, explanation: generated.explanation, testInput, permissions: input.permissions, modelId: deps.llm.modelId },
          assumptions: ["Source code is model-generated and has not been validated at this step"],
          modelId: deps.llm.modelId,
        };
      },
      defaultInput: ({ config, params }) => {
        // Code modification: start from the source of the script being changed.
        const existing = typeof params.scriptId === "string" ? config.scripts.find((s) => s.id === params.scriptId) : undefined;
        return {
          task: params.task,
          ...(Array.isArray(params.permissions) ? { permissions: params.permissions } : existing ? { permissions: existing.permissions } : {}),
          ...(existing ? { existingSource: existing.source } : {}),
        };
      },
    }),
    defineCapability({
      id: "code.validate_module",
      name: "Validate TypeScript module",
      description: "Policy-scan and strictly type-check a module against the controlled mission API, then execute it once in the isolated QuickJS sandbox with time and memory limits.",
      category: "code_generation",
      provides: ["code.validate"],
      input: z.object({
        source: z.string().min(1),
        permissions: z.array(scriptPermission).default(["state:read", "calc"]),
        testInput: z.record(z.string(), z.unknown()).default({}),
      }),
      output: z.object({
        passed: z.boolean(),
        diagnostics: z.array(z.string()),
        policyViolations: z.array(z.string()),
        sandbox: z
          .object({ ok: z.boolean(), error: z.string().optional(), result: z.unknown(), logs: z.array(z.string()), proposedPatches: z.array(z.unknown()), durationMs: z.number() })
          .nullable(),
      }),
      requiredPermissions: ["code:execute_sandbox"],
      resources: { cpu: "medium", typicalDurationMs: 800, memoryMb: 64 },
      constraints: { timeoutMs: 20000 },
      verification: { status: "self_tested", method: "Sandbox escape and policy tests (tests/sandbox.test.ts)" },
      outputVerification: "deterministic_calculation",
      run: async (input, ctx) => {
        const checked = validateModuleSource(input.source);
        if (!checked.ok || !checked.compiledJs) {
          return { output: { passed: false, diagnostics: checked.diagnostics, policyViolations: checked.policyViolations, sandbox: null } };
        }
        const run = await runInSandbox({
          compiledJs: checked.compiledJs,
          permissions: input.permissions,
          config: ctx.draft.workingConfig(),
          derived: ctx.mission.derived,
          input: input.testInput,
        });
        return {
          output: {
            passed: run.ok,
            diagnostics: [],
            policyViolations: [],
            sandbox: { ok: run.ok, ...(run.error ? { error: run.error } : {}), result: run.result ?? null, logs: run.logs, proposedPatches: run.proposedPatches, durationMs: run.durationMs },
          },
          assumptions: ["A passing run shows the module is safe to execute and works for the test input; it does not prove the logic is correct"],
        };
      },
    }),
  ];
}
