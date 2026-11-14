/**
 * Feasibility assessment, performed before anything is executed.
 *
 * Every finding states how it was established. Engineering findings come from a dry run
 * of the deterministic recalculation on the hypothetical configuration; nothing here asks
 * a model whether an idea "sounds plausible", and model-generated content in a plan is
 * surfaced as `scientifically_unverified` rather than folded into a positive verdict.
 */
import { applyPatches, type PatchOp } from "../core/paths.js";
import { ROLE_PERMISSIONS, type User, type VerificationLevel } from "../core/types.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import { engineeringChecks, recalculate } from "../state/recalc.js";
import { parseMissionConfig } from "../state/schema.js";
import type { MissionVersion } from "../state/store.js";
import type { FeasibilityAssessment, FeasibilityClass, FeasibilityFactor, Plan, PlanIssue, StructuredRequirement } from "./types.js";

const TIME_BUDGET_MS = 5 * 60 * 1000;

const HINTS: Record<string, string> = {
  "power.margin": "Increase solar array area or efficiency, or reduce load power / duty cycles.",
  "power.battery": "Increase battery capacity or reduce the load carried through eclipse.",
  "comms.margin": "Lower the data rate, raise transmit power, or use a larger antenna.",
  "orbit.periapsis": "Raise the periapsis above the body's minimum safe altitude.",
  "mass.limit": "Remove mass or raise the launch mass allocation.",
  "rover.slope": "Increase wheel torque or traction, lower the centre of mass, or choose a gentler route.",
};

/** Longest dependency chain by typical duration: the plan's expected wall-clock time. */
function criticalPathMs(plan: Plan, registry: CapabilityRegistry): number {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const memo = new Map<string, number>();
  const cost = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    const task = byId.get(id);
    if (!task || seen.has(id)) return 0;
    const own = registry.get(task.capabilityId)?.descriptor.resources.typicalDurationMs ?? 0;
    const total = own + Math.max(0, ...task.dependsOn.map((d) => cost(d, new Set([...seen, id]))));
    memo.set(id, total);
    return total;
  };
  return Math.max(0, ...plan.tasks.map((t) => cost(t.id, new Set())));
}

/** Configuration changes that can be evaluated before execution (from set_config / add_component operations). */
function knownPatches(requirement: StructuredRequirement): PatchOp[] {
  return requirement.operations.flatMap((op): PatchOp[] => {
    if (op.intent === "set_config" && Array.isArray(op.params.patches)) return op.params.patches as PatchOp[];
    if (op.intent === "add_component" && op.params.component) {
      return [{ op: "append", path: `${String(op.params.target ?? "spacecraft")}.components`, value: op.params.component }];
    }
    return [];
  });
}

export function assessFeasibility(args: {
  requirement: StructuredRequirement;
  plan: Plan;
  issues: PlanIssue[];
  registry: CapabilityRegistry;
  mission: MissionVersion;
  user: User;
}): FeasibilityAssessment {
  const { requirement, plan, issues, registry, mission, user } = args;
  const factors: FeasibilityFactor[] = [];
  const suggestions: string[] = [];
  const blockers = new Set<FeasibilityClass>();
  const descriptors = plan.tasks.map((t) => registry.get(t.capabilityId)?.descriptor).filter((d) => d !== undefined);

  // 1. Tools and services
  if (requirement.operations.length === 0) {
    blockers.add("requires_further_research");
    factors.push({ factor: "tools", status: "blocker", basis: "deterministic_calculation", detail: "The request was not translated into any executable operation." });
  }
  for (const issue of issues) {
    switch (issue.kind) {
      case "no_capability":
        blockers.add("requires_further_research");
        factors.push({ factor: "tools", status: "blocker", basis: "deterministic_calculation", detail: `${issue.detail}. No known method is registered for this; it needs a new capability or further study.` });
        break;
      case "capability_planned":
        blockers.add("currently_unsupported");
        factors.push({ factor: "tools", status: "blocker", basis: "deterministic_calculation", detail: issue.detail });
        break;
      case "capability_unavailable":
      case "planner_unavailable":
        blockers.add("requires_additional_resources");
        factors.push({ factor: "dependencies", status: "blocker", basis: "deterministic_calculation", detail: issue.detail });
        break;
      case "permission_denied":
        blockers.add("requires_additional_resources");
        factors.push({ factor: "permissions", status: "blocker", basis: "deterministic_calculation", detail: `${issue.detail}. A user with a role that grants them must make this request.` });
        break;
      case "invalid_input":
        blockers.add("requires_further_research");
        factors.push({ factor: "data", status: "blocker", basis: "deterministic_calculation", detail: issue.detail });
        break;
      case "invalid_plan":
        blockers.add("currently_unsupported");
        factors.push({ factor: "tools", status: "blocker", basis: "deterministic_calculation", detail: `The generated plan is not executable: ${issue.detail}` });
        break;
    }
  }
  if (issues.length === 0 && plan.tasks.length > 0) {
    factors.push({ factor: "tools", status: "ok", basis: "deterministic_calculation", detail: `All ${plan.tasks.length} task(s) map to available capabilities: ${[...new Set(plan.tasks.map((t) => t.capabilityId))].join(", ")}.` });
  }

  // 2. Permissions (plans produced by the model planner are re-checked here)
  const permissions = ROLE_PERMISSIONS[user.role];
  const missing = [...new Set(descriptors.flatMap((d) => d.requiredPermissions.filter((p) => !permissions.includes(p))))];
  if (missing.length) {
    blockers.add("requires_additional_resources");
    factors.push({ factor: "permissions", status: "blocker", basis: "deterministic_calculation", detail: `Role "${user.role}" lacks: ${missing.join(", ")}.` });
  } else if (plan.tasks.length) {
    factors.push({ factor: "permissions", status: "ok", basis: "deterministic_calculation", detail: `Role "${user.role}" holds every permission the plan requires.` });
  }

  // 3. Engineering constraints: dry-run the deterministic models on the hypothetical configuration.
  const patches = knownPatches(requirement);
  let engineeringConcern = false;
  if (patches.length) {
    let candidate: unknown;
    try {
      candidate = applyPatches(mission.config as unknown, patches);
    } catch (err) {
      candidate = undefined;
      blockers.add("currently_unsupported");
      factors.push({ factor: "engineering", status: "blocker", basis: "deterministic_calculation", detail: `The change cannot be applied to the current configuration: ${err instanceof Error ? err.message : String(err)}` });
    }
    const parsed = candidate === undefined ? null : parseMissionConfig(candidate);
    if (parsed && !parsed.ok) {
      blockers.add("currently_unsupported");
      factors.push({ factor: "engineering", status: "blocker", basis: "deterministic_calculation", detail: `The resulting configuration is outside what the mission model supports: ${parsed.issues.join("; ")}` });
    } else if (parsed?.ok) {
      const before = new Map(engineeringChecks(mission.config, mission.derived).map((c) => [c.id, c.status]));
      const after = engineeringChecks(parsed.config, recalculate(parsed.config, { config: mission.config, derived: mission.derived }).derived);
      const regressions = after.filter((c) => c.status === "fail" && before.get(c.id) !== "fail");
      const warnings = after.filter((c) => c.status === "warn" && before.get(c.id) === "pass");
      for (const c of regressions) {
        engineeringConcern = true;
        factors.push({ factor: "engineering", status: "concern", basis: "deterministic_calculation", detail: `Constraint violated after the change — ${c.description}: ${c.detail}.` });
        const hint = HINTS[c.id];
        if (hint) suggestions.push(hint);
      }
      for (const c of warnings) factors.push({ factor: "engineering", status: "concern", basis: "deterministic_calculation", detail: `Reduced margin — ${c.description}: ${c.detail}.` });
      if (!regressions.length && !warnings.length) {
        factors.push({ factor: "engineering", status: "ok", basis: "deterministic_calculation", detail: `Dry run of ${after.length} engineering constraint check(s) on the changed configuration shows no new violations.` });
      }
    }
  }

  // 4. Scientific evidence: what kind of evidence will the plan's results rest on?
  const evidenceBasis: Partial<Record<VerificationLevel, string[]>> = {};
  for (const d of descriptors) {
    const ids = (evidenceBasis[d.outputVerification] ??= []);
    if (!ids.includes(d.id)) ids.push(d.id);
  }
  const unvalidated = [...(evidenceBasis.model_judgment ?? []), ...(evidenceBasis.unverified ?? [])];
  const modelDriven = requirement.analysis.method === "llm" || plan.createdBy === "llm";
  if (unvalidated.length) {
    factors.push({
      factor: "science",
      status: "concern",
      basis: "deterministic_calculation",
      detail: `Results depend on output that is not scientifically validated (${unvalidated.join(", ")}). Automated checks establish execution safety and schema validity only; correctness needs independent verification.`,
    });
  } else if (descriptors.length) {
    factors.push({ factor: "science", status: "ok", basis: "deterministic_calculation", detail: "Every quantitative result comes from a deterministic calculation or an external data provider, each with stated assumptions." });
  }
  if (modelDriven) {
    factors.push({
      factor: "science",
      status: "ok",
      basis: "model_judgment",
      detail: `The interpretation of the request${plan.createdBy === "llm" ? " and the task plan were" : " was"} produced by a language model. That is a judgement about what was asked, not evidence that the result is valid.`,
    });
  }

  // 5. Data, compatibility, resources, time, safety
  const optionalMissing = requirement.missingInformation.filter((m) => !m.blocking);
  if (optionalMissing.length) factors.push({ factor: "data", status: "concern", basis: "heuristic", detail: `Open questions (defaults assumed): ${optionalMissing.map((m) => m.question).join(" ")}` });
  const assumed = requirement.operations.flatMap((o) => o.assumptions);
  if (assumed.length) factors.push({ factor: "data", status: "concern", basis: "heuristic", detail: `Values assumed during analysis: ${assumed.join("; ")}.` });

  if (descriptors.some((d) => d.category === "asset_generation" || d.category === "code_generation")) {
    factors.push({ factor: "compatibility", status: "ok", basis: "deterministic_calculation", detail: "Outputs are GLB 2.0 meshes and sandboxed TypeScript modules, both consumable by the MR and Web clients through the shared mission configuration." });
  }
  const network = descriptors.filter((d) => d.resources.network);
  if (network.length) factors.push({ factor: "dependencies", status: "ok", basis: "deterministic_calculation", detail: `Depends on external services: ${[...new Set(network.flatMap((d) => d.dependencies))].join(", ") || network.map((d) => d.id).join(", ")}.` });

  const estimatedDurationMs = criticalPathMs(plan, registry);
  const heavy = descriptors.filter((d) => d.resources.cpu === "high");
  factors.push({
    factor: "resources",
    status: heavy.length ? "concern" : "ok",
    basis: "heuristic",
    detail: heavy.length ? `CPU-intensive capabilities: ${heavy.map((d) => d.id).join(", ")}.` : "Computational load is light (no CPU-intensive capability in the plan).",
  });
  factors.push({
    factor: "time",
    status: estimatedDurationMs > TIME_BUDGET_MS ? "concern" : "ok",
    basis: "heuristic",
    detail: `Estimated execution time ≈ ${(estimatedDurationMs / 1000).toFixed(1)} s along the critical path (from typical capability durations).`,
  });
  const writes = descriptors.some((d) => d.constraints.effect === "draft_write");
  factors.push({
    factor: "safety",
    status: "ok",
    basis: "deterministic_calculation",
    detail: writes
      ? "Changes are staged in an isolated draft and published only after preview, automated tests and human approval. Generated code runs only in the QuickJS sandbox."
      : "Read-only request: the shared mission is not modified.",
  });

  // Classification: hard blockers first, then unverified science, then engineering concerns.
  const order: FeasibilityClass[] = ["currently_unsupported", "requires_further_research", "requires_additional_resources"];
  const blocker = order.find((c) => blockers.has(c));
  const classification: FeasibilityClass = blocker ?? (unvalidated.length ? "scientifically_unverified" : engineeringConcern ? "feasible_with_modifications" : "feasible");
  const proceed = blocker === undefined;
  const summaries: Record<FeasibilityClass, string> = {
    feasible: "Feasible: every step maps to an available capability and the dry run shows no new constraint violations.",
    feasible_with_modifications: "Feasible only with modifications: the change can be made, but it violates engineering constraints as specified. A preview will be produced; it cannot be approved until the violations are resolved.",
    requires_additional_resources: "Requires additional resources: a needed service, credential or permission is not currently available.",
    requires_further_research: "Requires further research: part of the request has no registered method or lacks the data needed to evaluate it.",
    currently_unsupported: "Currently unsupported: the request needs a capability or configuration the system does not implement.",
    scientifically_unverified: "Executable, but scientifically unverified: the outcome depends on model-generated or otherwise unvalidated content, which is flagged as such on every result and proposal.",
  };
  return {
    classification,
    proceed,
    summary: summaries[classification] + (unvalidated.length && engineeringConcern && !blocker ? " The dry run also shows engineering constraint violations." : ""),
    factors,
    suggestedModifications: [...new Set(suggestions)],
    evidenceBasis,
    estimatedDurationMs,
  };
}
