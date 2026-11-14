/** End-to-end request pipeline, with and without a language model. */
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { type App, createApp } from "../src/app.js";
import { CapabilityError, type User } from "../src/core/types.js";
import type { LlmService } from "../src/llm/llm.js";
import { PlanExecutor } from "../src/pipeline/executor.js";
import { validateGraph } from "../src/pipeline/planner.js";
import type { Plan, PlanTask, RequestRecord, TraceEvent } from "../src/pipeline/types.js";
import { type Capability, DraftWorkspace } from "../src/registry/capability.js";
import { CapabilityRegistry } from "../src/registry/registry.js";

const engineer: User = { id: "eng-1", role: "engineer" };
const lead: User = { id: "lead-1", role: "lead" };
const viewer: User = { id: "view-1", role: "viewer" };
const noLlm: LlmService = { modelId: "none", status: () => ({ available: false, reason: "No credentials in test" }), structured: async () => { throw new Error("LLM must not be called"); } };

let app: App;
afterEach(async () => app?.close());

const run = async (text: string, user: User = engineer): Promise<RequestRecord> => app.requests.wait(app.requests.submit({ text, user }).id);
const stages = (r: RequestRecord): string[] => [...new Set(r.trace.map((e) => e.stage))];
const value = <T>(r: RequestRecord, taskSuffix: string): T => r.plan!.tasks.find((t) => t.id.endsWith(taskSuffix))!.result!.output as T;

describe("request pipeline (rule-based analysis, no language model)", () => {
  it("answers a calculation request without touching the mission", async () => {
    app = createApp({ llm: noLlm });
    const r = await run("What is the orbital period?");
    expect(r.status).toBe("completed");
    expect(r.requirement!.analysis.method).toBe("rule_based");
    expect(r.requirement!.operations[0]).toMatchObject({ category: "scientific_research", intent: "compute" });
    expect(r.feasibility!.classification).toBe("feasible");
    const task = r.plan!.tasks[0]!;
    expect(task.capabilityId).toBe("science.orbit.elements");
    expect(task.selectionReason).toMatch(/Needs "calc.orbit.elements"/);
    expect((task.result!.output as { periodS: number }).periodS / 60).toBeCloseTo(117.8, 0);
    expect(task.result!.verification).toBe("deterministic_calculation");
    expect(r.proposalId).toBeUndefined();
    expect(app.store.head().version).toBe(1);
    expect(stages(r)).toEqual(expect.arrayContaining(["state", "analysis", "selection", "planning", "feasibility", "execution", "validation"]));
  });

  it("takes a configuration change through preview, approval, publication and rollback", async () => {
    app = createApp({ llm: noLlm });
    const published: number[] = [];
    app.store.on("published", (v) => published.push(v.version));

    const r = await run("Set orbit altitude to 150 km");
    expect(r.status).toBe("awaiting_approval");
    expect(r.plan!.tasks.map((t) => [t.capabilityId, t.status])).toEqual([["mission.inspect", "succeeded"], ["mission.propose_patch", "succeeded"]]);
    expect(app.store.head().version).toBe(1); // nothing published yet

    const proposal = app.proposals.get(r.proposalId!)!;
    expect(proposal.preview.configDiff).toEqual([{ path: "orbit.semiMajorAxisKm", kind: "changed", before: 1837.4, after: 1887.4 }]);
    expect(proposal.preview.recalculatedNodes).toEqual(expect.arrayContaining(["orbit.elements", "orbit.eclipse", "power.budget", "comms.link"]));
    expect(proposal.preview.consequences.find((c) => c.node === "orbit.elements" && c.metric === "periodS")!.delta).toBeGreaterThan(0);
    expect(proposal.tests.find((t) => t.id === "config.schema")!.status).toBe("pass");
    expect(proposal.tests.filter((t) => t.status === "fail")).toEqual([]);
    expect(proposal.significance).toBe("significant");
    expect(proposal.requiredRole).toBe("lead");
    expect(proposal.evidence).toBe("deterministic_calculation");

    await expect(app.proposals.approve(proposal.id, engineer, "looks fine")).rejects.toThrow(/requires approval by role "lead"/);
    const { version } = await app.proposals.approve(proposal.id, lead, "Higher orbit reduces eclipse time");
    app.requests.recordDecision(app.proposals.get(proposal.id)!, version);
    expect(version.version).toBe(2);
    expect(app.store.head().config.orbit.semiMajorAxisKm).toBe(1887.4);
    expect((app.store.head().derived["orbit.elements"]!.value as { periodS: number }).periodS).toBeGreaterThan(7070);
    expect(app.requests.get(r.id)!.status).toBe("published");
    const decision = app.requests.get(r.id)!.trace.find((e) => e.stage === "decision")!;
    expect(decision.message).toMatch(/approved by lead-1/);
    expect((decision.data as { reason: string }).reason).toBe("Higher orbit reduces eclipse time");
    await expect(app.proposals.approve(proposal.id, lead, "again")).rejects.toThrow(/published/);

    const back = app.store.rollback(1, lead.id, "test rollback");
    expect(back.version).toBe(3);
    expect(back.config.orbit.semiMajorAxisKm).toBe(1837.4);
    expect(published).toEqual([2, 3]);
    expect(app.memory.search("orbit altitude", { kinds: ["design_change"] }).length).toBeGreaterThan(0);
  });

  it("adds a component with a generated 3D asset and deploys the asset on approval", async () => {
    app = createApp({ llm: noLlm });
    const r = await run("Add a 0.8 m2 solar panel to the spacecraft");
    expect(r.status).toBe("awaiting_approval");
    expect(r.requirement!.operations[0]!.assumptions.join(" ")).toMatch(/3.5 kg\/m²/);
    const byCap = Object.fromEntries(r.plan!.tasks.map((t) => [t.capabilityId, t]));
    expect(Object.keys(byCap).sort()).toEqual(["asset.generate_parametric", "mission.add_component", "mission.inspect"]);
    expect(byCap["mission.add_component"]!.dependsOn).toEqual(expect.arrayContaining([byCap["asset.generate_parametric"]!.id, byCap["mission.inspect"]!.id]));

    const proposal = app.proposals.get(r.proposalId!)!;
    const assetId = value<{ assetId: string }>(r, "_asset").assetId;
    expect(proposal.preview.affectedComponents).toEqual(expect.arrayContaining(["spacecraft.components.sp2", "scene.nodes.node_sp2", `assets.${assetId}`]));
    expect(proposal.tests.find((t) => t.id === `asset.${assetId}`)!.status).toBe("pass");
    expect(proposal.preview.consequences.find((c) => c.node === "power.budget" && c.metric === "sunlitGenerationW")!.delta).toBeGreaterThan(200);
    expect(existsSync(path.join(app.assetsDir, `${assetId}.glb`))).toBe(false); // staged only

    await app.proposals.approve(proposal.id, lead, "More power margin");
    const head = app.store.head();
    expect(head.config.spacecraft.components.map((c) => c.id)).toContain("sp2");
    expect(head.config.scene.nodes[0]).toMatchObject({ id: "node_sp2", assetId, componentId: "sp2" });
    expect(existsSync(path.join(app.assetsDir, `${assetId}.glb`))).toBe(true);
  });

  it("binds later tasks to the drafted state, not the published one", async () => {
    app = createApp({ llm: noLlm });
    const before = (app.store.head().derived["power.budget"]!.value as { sunlitGenerationW: number }).sunlitGenerationW;
    const r = await run("Add a 1 m2 solar panel; compute the power budget");
    expect(r.status).toBe("awaiting_approval");
    const calc = r.plan!.tasks.find((t) => t.capabilityId === "science.power.budget")!;
    expect(calc.dependsOn.length).toBeGreaterThan(0); // ordered after the staged change
    expect((calc.result!.output as { sunlitGenerationW: number }).sunlitGenerationW).toBeGreaterThan(before + 300);
  });

  it("classifies a constraint-violating change as feasible with modifications and blocks its approval", async () => {
    app = createApp({ llm: noLlm });
    const r = await run("set spacecraft.components.sp1.areaM2 to 0.2");
    expect(r.feasibility!.classification).toBe("feasible_with_modifications");
    expect(r.feasibility!.suggestedModifications.join(" ")).toMatch(/solar array/);
    expect(r.feasibility!.factors.find((f) => f.factor === "engineering")).toMatchObject({ status: "concern", basis: "deterministic_calculation" });
    expect(r.status).toBe("awaiting_approval");
    const proposal = app.proposals.get(r.proposalId!)!;
    expect(proposal.tests.find((t) => t.id === "engineering.power.margin")!.status).toBe("fail");
    await expect(app.proposals.approve(proposal.id, lead, "force")).rejects.toThrow(/automated test\(s\) fail/);
    expect(app.store.head().version).toBe(1);
    const rejected = app.proposals.reject(proposal.id, lead, "Power margin negative");
    app.requests.recordDecision(rejected);
    expect(app.requests.get(r.id)!.status).toBe("rejected");
  });

  it("refuses configurations outside the supported model before executing anything", async () => {
    app = createApp({ llm: noLlm });
    const r = await run("set orbit.eccentricity to 1.4");
    expect(r.feasibility!.classification).toBe("currently_unsupported");
    expect(r.status).toBe("infeasible");
    expect(r.plan!.tasks.every((t) => t.status === "pending")).toBe(true);
  });

  it("reports missing resources instead of pretending: code generation without a model, and missing permissions", async () => {
    app = createApp({ llm: noLlm });
    await app.registry.get("code.generate_module")!.healthCheck!().then((h) => app.registry.setAvailability("code.generate_module", h.status, h.reason));
    const code = await run("Write a script that reports the power margin");
    expect(code.requirement!.operations[0]!.category).toBe("code_generation");
    expect(code.feasibility!.classification).toBe("requires_additional_resources");
    expect(code.planIssues[0]).toMatchObject({ kind: "capability_unavailable", capabilityId: "code.generate_module" });
    expect(code.status).toBe("infeasible");

    const denied = await run("Set orbit altitude to 120 km", viewer);
    expect(denied.feasibility!.classification).toBe("requires_additional_resources");
    expect(denied.planIssues[0]).toMatchObject({ kind: "permission_denied", missingPermissions: ["state:propose"] });
    expect(app.proposals.list()).toHaveLength(0);
  });

  it("asks for clarification only when a required value is missing, then continues", async () => {
    app = createApp({ llm: noLlm });
    const r = await run("Add a solar panel");
    expect(r.status).toBe("awaiting_clarification");
    expect(r.requirement!.missingInformation[0]).toMatchObject({ field: "component.areaM2", blocking: true });
    app.requests.clarify(r.id, "0.5 m2");
    const after = await app.requests.wait(r.id);
    expect(after.status).toBe("awaiting_approval");

    const unknown = await run("Make the mission more awesome");
    expect(unknown.status).toBe("awaiting_clarification");
    expect(unknown.requirement!.missingInformation[0]!.question).toMatch(/no language model is configured/);
  });

  it("generates a standalone asset, runs a simulation, and reuses memory", async () => {
    app = createApp({ llm: noLlm });
    const asset = await run("Generate a 3D model of a rover 0.8 m 0.5 m 0.2 m with 0.12 m wheels");
    expect(asset.status).toBe("awaiting_approval");
    expect(value<{ kind: string; triangles: number }>(asset, "_asset")).toMatchObject({ kind: "rover_chassis" });
    expect(app.proposals.get(asset.proposalId!)!.significance).toBe("minor");
    await app.proposals.approve(asset.proposalId!, engineer, "asset library addition"); // minor change: engineer may approve

    const sim = await run("Simulate the battery over 8 orbits");
    expect(sim.status).toBe("completed");
    expect(value<{ batteryDepleted: boolean; steps: number }>(sim, "_sim")).toMatchObject({ batteryDepleted: false });
    const rover = await run("Can the rover climb a 30 deg slope?");
    expect(value<{ canTraverseSite: boolean; limitingFactor: string }>(rover, "_calc")).toMatchObject({ canTraverseSite: false, limitingFactor: "traction" });

    const again = await run("Simulate the battery over 3 orbits");
    expect(again.similarPastWork.some((m) => m.kind === "simulation_result")).toBe(true);
    expect(app.memory.forRequest(sim.id).map((m) => m.kind)).toEqual(expect.arrayContaining(["user_request", "plan", "simulation_result"]));
  });

  it("rebases a proposal when the mission moved on, and re-runs its tests", async () => {
    app = createApp({ llm: noLlm });
    const first = await run("Set orbit inclination to 80");
    const second = await run("set groundStation.minElevationDeg to 15");
    await app.proposals.approve(first.proposalId!, lead, "first");
    const { proposal, version } = await app.proposals.approve(second.proposalId!, lead, "second");
    expect(proposal.baseVersion).toBe(2);
    expect(version.version).toBe(3);
    expect(version.config.orbit.inclinationDeg).toBe(80);
    expect(version.config.groundStation.minElevationDeg).toBe(15);
  });
});

/** Scripted stand-in for the model, used only to exercise the model-driven code paths in tests. */
function scriptedLlm(responses: Record<string, unknown>): LlmService & { calls: string[] } {
  const calls: string[] = [];
  return {
    modelId: "scripted-test-model",
    calls,
    status: () => ({ available: true }),
    structured: async <S extends z.ZodType>(args: { system: string; prompt: string; schema: S }): Promise<z.infer<S>> => {
      const key = Object.keys(responses).find((k) => args.system.includes(k));
      if (!key) throw new Error("No scripted response for this prompt");
      calls.push(key);
      return args.schema.parse(responses[key]);
    },
  };
}

const GOOD_MODULE = `export function run(input: Record<string, unknown>): unknown {
  const budget = mission.derived("power.budget");
  const margin = budget !== null && typeof budget === "object" ? (budget as Record<string, unknown>).marginW : undefined;
  const threshold = typeof input.thresholdW === "number" ? input.thresholdW : 0;
  return { marginW: margin, healthy: typeof margin === "number" && margin > threshold };
}`;

describe("request pipeline (model-driven paths)", () => {
  const analysis = (operations: unknown[]) => ({ summary: "Model summary", operations, missingInformation: [] });

  it("generates, validates and stages a script, and marks the result as scientifically unverified", async () => {
    const llm = scriptedLlm({
      "You convert a user's natural-language request": analysis([{ category: "code_generation", intent: "generate_script", description: "Power margin monitor", paramsJson: JSON.stringify({ task: "Report whether the power margin is healthy", name: "Power margin monitor" }), assumptions: [] }]),
      "You write small TypeScript modules": { source: GOOD_MODULE, explanation: "Reads power.budget", testInputJson: '{"thresholdW": 10}' },
    });
    app = createApp({ llm });
    const r = await run("Write a script that reports whether the power margin is healthy");
    expect(r.requirement!.analysis).toMatchObject({ method: "llm", modelId: "scripted-test-model", verification: "model_judgment" });
    expect(r.feasibility!.classification).toBe("scientifically_unverified");
    expect(r.feasibility!.evidenceBasis.model_judgment).toEqual(["code.generate_module"]);
    expect(r.plan!.tasks.map((t) => [t.capabilityId, t.status])).toEqual([["code.generate_module", "succeeded"], ["code.validate_module", "succeeded"], ["mission.attach_script", "succeeded"]]);
    expect(value<{ passed: boolean; sandbox: { result: unknown } }>(r, "_validate")).toMatchObject({ passed: true, sandbox: { result: { healthy: true } } });

    const proposal = app.proposals.get(r.proposalId!)!;
    expect(proposal.evidence).toBe("model_judgment");
    expect(proposal.tests.find((t) => t.id === "evidence.unvalidated")!.status).toBe("warn");
    expect(proposal.significance).toBe("significant");
    await app.proposals.approve(proposal.id, lead, "Reviewed the source");
    const script = app.store.head().config.scripts[0]!;
    expect(script.origin).toEqual({ kind: "model_generated", modelId: "scripted-test-model" });

    const exec = await run("ignored");
    expect(exec.status).not.toBe("failed");
  });

  it("refuses to stage model-generated code that fails validation, and rolls the draft back", async () => {
    const llm = scriptedLlm({
      "You convert a user's natural-language request": analysis([{ category: "code_generation", intent: "generate_script", description: "Bad", paramsJson: JSON.stringify({ task: "x", name: "bad" }), assumptions: [] }]),
      "You write small TypeScript modules": { source: `import os from "node:os"; export function run() { return os.hostname(); }`, explanation: "escape attempt", testInputJson: "{}" },
    });
    app = createApp({ llm });
    const r = await run("Write a script that reads the hostname");
    expect(r.status).toBe("failed");
    const byCap = Object.fromEntries(r.plan!.tasks.map((t) => [t.capabilityId, t]));
    expect(byCap["code.validate_module"]!.status).toBe("failed");
    expect(byCap["code.validate_module"]!.error).toMatch(/Result validation failed: passed ==/);
    expect(byCap["mission.attach_script"]!.status).toBe("skipped");
    expect(r.plan!.rolledBack).toBe(true);
    expect(app.proposals.list()).toHaveLength(0);
    expect(app.memory.forRequest(r.id).some((m) => m.kind === "failure")).toBe(true);
  });

  it("plans a custom multi-tool request from the live catalogue and validates the model's plan", async () => {
    const llm = scriptedLlm({
      "You convert a user's natural-language request": analysis([{ category: "engineering_design", intent: "custom", description: "Check rover on a steeper slope and resize the array", paramsJson: '{"goal":"assess"}', assumptions: [] }]),
      "You are the planning stage": {
        tasks: [
          { id: "inspect", description: "Inspect rover", capabilityId: "mission.inspect", reason: "Need current rover", dependsOn: [], inputJson: '{"paths":["rover.site.slopeDeg"]}', expectedOutputs: ["values"], validation: [] },
          { id: "orbit", description: "Orbit at 200 km", capabilityId: "science.orbit.elements", reason: "Deterministic", dependsOn: [], inputJson: '{"body":"moon","semiMajorAxisKm":1937.4,"eccentricity":0}', expectedOutputs: ["periodS"], validation: [{ path: "periodS", op: ">", valueJson: "7000" }] },
          { id: "stage", description: "Apply orbit", capabilityId: "mission.propose_patch", reason: "Stage change", dependsOn: ["inspect"], inputJson: '{"patches":[{"op":"set","path":"orbit.semiMajorAxisKm","value":{"$ref":"orbit","path":"periapsisRadiusKm"}}],"rationale":"raise orbit"}', expectedOutputs: ["staged"], validation: [] },
        ],
        unmetNeeds: [],
      },
    });
    app = createApp({ llm });
    const r = await run("Assess and raise the orbit");
    expect(r.plan!.createdBy).toBe("llm");
    expect(r.plan!.tasks.find((t) => t.id === "stage")!.dependsOn.sort()).toEqual(["inspect", "orbit"]); // data reference became a dependency
    expect(r.plan!.tasks.find((t) => t.id === "orbit")!.selectionReason).toMatch(/model judgement/);
    expect(r.status).toBe("awaiting_approval");
    expect(app.proposals.get(r.proposalId!)!.preview.configDiff[0]).toMatchObject({ path: "orbit.semiMajorAxisKm", after: 1937.4 });
    expect(r.feasibility!.factors.some((f) => f.basis === "model_judgment")).toBe(true);
  });

  it("rejects a model plan that names capabilities that do not exist", async () => {
    const llm = scriptedLlm({
      "You convert a user's natural-language request": analysis([{ category: "scientific_research", intent: "custom", description: "x", paramsJson: "{}", assumptions: [] }]),
      "You are the planning stage": { tasks: [{ id: "t1", description: "Warp drive sizing", capabilityId: "science.warp.drive", reason: "plausible", dependsOn: [], inputJson: "{}", expectedOutputs: [], validation: [] }], unmetNeeds: [] },
    });
    app = createApp({ llm });
    const r = await run("Size a warp drive");
    expect(r.status).toBe("infeasible");
    expect(r.feasibility!.classification).toBe("currently_unsupported");
    expect(r.planIssues[0]!.detail).toMatch(/not a usable capability/);
  });
});

describe("plan executor", () => {
  const descriptor = (id: string, provides: string[], over: Partial<Capability["descriptor"]["constraints"]> = {}): Capability["descriptor"] => ({
    id, name: id, description: id, category: "internal_api", provides, inputSchema: { type: "object" }, outputSchema: {}, dependencies: [], requiredPermissions: [],
    resources: { network: false, cpu: "low", typicalDurationMs: 1 }, constraints: { timeoutMs: 1000, maxRetries: 2, idempotent: true, effect: "read", ...over },
    availability: { status: "available", checkedAt: "" }, version: "1.0.0", verification: { status: "self_tested", method: "test" }, developmentStatus: "implemented", outputVerification: "deterministic_calculation", source: { type: "internal" },
  });
  const cap = (d: Capability["descriptor"], execute: (input: unknown, signal: AbortSignal) => Promise<unknown>): Capability => ({
    descriptor: d,
    validateInput: (input) => ({ ok: true, errors: [], value: input }),
    execute: async (input, ctx) => ({ output: await execute(input, ctx.signal), verification: "deterministic_calculation", assumptions: [], provenance: { source: "test" } }),
  });
  const task = (id: string, capabilityId: string, dependsOn: string[] = [], input: unknown = {}): PlanTask => ({ id, operationId: "op", description: id, capabilityId, selectionReason: "", alternativesConsidered: [], dependsOn, input, expectedOutputs: [], validation: [], status: "pending", attempts: 0 });
  const execute = async (registry: CapabilityRegistry, tasks: PlanTask[], signal = new AbortController().signal) => {
    app = createApp({ llm: noLlm });
    const trace: TraceEvent[] = [];
    const draft = new DraftWorkspace(app.store.head(), path.join(app.assetsDir, "..", "staging-test"));
    const plan: Plan = { id: "p", requestId: "r", createdBy: "recipe", tasks, status: "draft", rolledBack: false };
    await new PlanExecutor(registry, { retryBaseDelayMs: 5 }).run(plan, { requestId: "r", user: engineer, mission: app.store.head(), draft, signal, trace: (stage, message, data) => trace.push({ seq: trace.length, at: "", stage, message, data }) });
    return { plan, trace, draft };
  };

  it("runs independent tasks in parallel and dependent tasks in order", async () => {
    const registry = new CapabilityRegistry();
    const log: string[] = [];
    let active = 0;
    let peak = 0;
    registry.register(cap(descriptor("t.slow", ["x"]), async (input) => {
      const name = (input as { name: string }).name;
      log.push(`start ${name}`);
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 40));
      active--;
      log.push(`end ${name}`);
      return input;
    }));
    const { plan } = await execute(registry, [task("a", "t.slow", [], { name: "a" }), task("b", "t.slow", [], { name: "b" }), task("c", "t.slow", ["b"], { name: "c", from: { $ref: "a", path: "name" } })]); // "a" becomes a dependency via the reference
    expect(plan.status).toBe("succeeded");
    expect(peak).toBe(2);
    expect(log.indexOf("start c")).toBeGreaterThan(Math.max(log.indexOf("end a"), log.indexOf("end b")));
    expect(plan.tasks[2]!.result!.output).toEqual({ name: "c", from: "a" }); // reference resolved from task a
  });

  it("retries transient failures, then falls back to an alternative capability", async () => {
    const registry = new CapabilityRegistry();
    let flakyCalls = 0;
    registry.register(cap(descriptor("t.flaky", ["a"]), async () => {
      if (++flakyCalls < 3) throw new CapabilityError("temporary outage", { retryable: true });
      return { ok: true };
    }));
    registry.register(cap(descriptor("t.broken", ["b"]), async () => { throw new CapabilityError("permanently broken"); }));
    registry.register(cap(descriptor("t.backup", ["b"]), async () => ({ from: "backup" })));
    const { plan, trace } = await execute(registry, [task("one", "t.flaky"), task("two", "t.broken")]);
    expect(plan.status).toBe("succeeded");
    expect(plan.tasks[0]).toMatchObject({ status: "succeeded", attempts: 3, executedBy: "t.flaky" });
    expect(plan.tasks[1]).toMatchObject({ status: "succeeded", executedBy: "t.backup" });
    expect(trace.filter((e) => e.stage === "recovery").map((e) => e.message).join("\n")).toMatch(/retrying[\s\S]*falling back from "t.broken" to alternative "t.backup"/);
    expect(registry.describe("t.flaky")!.stats).toMatchObject({ calls: 3, failures: 2 });
  });

  it("times out hung capabilities, skips dependents and rolls back the draft", async () => {
    const registry = new CapabilityRegistry();
    registry.register(cap(descriptor("t.stage", ["s"], { effect: "draft_write" }), async () => ({ staged: true })));
    registry.register(cap(descriptor("t.hang", ["h"], { timeoutMs: 60, maxRetries: 0 }), (_i, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))))));
    const { plan, trace } = await execute(registry, [task("stage", "t.stage"), task("hang", "t.hang", ["stage"]), task("after", "t.stage", ["hang"])]);
    expect(plan.status).toBe("failed");
    expect(plan.tasks.map((t) => t.status)).toEqual(["rolled_back", "failed", "skipped"]);
    expect(plan.tasks[1]!.error).toMatch(/Timed out after 60 ms/);
    expect(plan.rolledBack).toBe(true);
    expect(trace.some((e) => e.stage === "recovery" && /rolled back/.test(e.message))).toBe(true);
  });

  it("cancels running work and leaves pending tasks unexecuted", async () => {
    const registry = new CapabilityRegistry();
    registry.register(cap(descriptor("t.wait", ["w"], { timeoutMs: 5000 }), (_i, signal) => new Promise((res, rej) => {
      const timer = setTimeout(() => res({}), 2000);
      signal.addEventListener("abort", () => { clearTimeout(timer); rej(new Error("aborted")); });
    })));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const { plan } = await execute(registry, [task("first", "t.wait"), task("second", "t.wait", ["first"])], controller.signal);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(plan.status).toBe("cancelled");
    expect(plan.tasks.map((t) => t.status)).toEqual(["cancelled", "cancelled"]);
  });

  it("detects malformed task graphs", () => {
    expect(validateGraph([task("a", "x", ["b"]), task("b", "x", ["a"])])).toEqual([expect.stringMatching(/cycle/)]);
    expect(validateGraph([task("a", "x", ["zzz"])])).toEqual([expect.stringMatching(/unknown task "zzz"/)]);
    expect(validateGraph([task("a", "x"), task("a", "x")])).toEqual([expect.stringMatching(/duplicate/)]);
  });
});
