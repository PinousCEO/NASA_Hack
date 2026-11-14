/** Capability registry, dependency-aware recalculation, versioned store and research memory. */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type App, createApp } from "../src/app.js";
import { applyPatch, applyPatches, diff, getPath } from "../src/core/paths.js";
import { ResearchMemory } from "../src/memory/memory.js";
import { executeDirect } from "../src/registry/direct.js";
import { DERIVED_NODES, engineeringChecks, recalculate } from "../src/state/recalc.js";
import { parseMissionConfig } from "../src/state/schema.js";

let app: App;
afterEach(async () => app?.close());

describe("config paths", () => {
  const doc = { a: { list: [{ id: "x", v: 1 }, { id: "y", v: 2 }] }, n: 1 };
  it("addresses array elements by id and index", () => {
    expect(getPath(doc, "a.list.y.v")).toBe(2);
    expect(getPath(doc, "a.list.0.v")).toBe(1);
    expect(getPath(doc, "a.missing.v")).toBeUndefined();
  });
  it("applies set, append and remove without mutating the input", () => {
    const out = applyPatches(doc, [{ op: "set", path: "a.list.x.v", value: 9 }, { op: "append", path: "a.list", value: { id: "z", v: 3 } }, { op: "remove", path: "a.list.y" }]);
    expect(out.a.list).toEqual([{ id: "x", v: 9 }, { id: "z", v: 3 }]);
    expect(doc.a.list).toHaveLength(2);
    expect(diff(doc, out).map((d) => `${d.kind}:${d.path}`).sort()).toEqual(["added:a.list.z", "changed:a.list.x.v", "removed:a.list.y"]);
  });
  it("rejects missing parents and prototype-polluting segments", () => {
    expect(() => applyPatch(doc, { op: "set", path: "nope.value", value: 1 })).toThrow(/does not exist/);
    expect(() => applyPatch(doc, { op: "set", path: "__proto__.polluted", value: 1 })).toThrow(/Forbidden/);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});

describe("capability registry", () => {
  it("exposes complete structured metadata for every capability", () => {
    app = createApp();
    const all = app.registry.list();
    expect(all.length).toBeGreaterThanOrEqual(20);
    for (const d of all) {
      expect(d.id).toMatch(/^[a-z][a-z0-9_.]+$/);
      expect(d.name && d.description, d.id).toBeTruthy();
      expect(d.inputSchema, d.id).toHaveProperty("type");
      expect(d.outputSchema, d.id).toBeTypeOf("object");
      expect(Array.isArray(d.dependencies) && Array.isArray(d.requiredPermissions) && d.provides.length > 0, d.id).toBe(true);
      expect(d.resources.typicalDurationMs, d.id).toBeGreaterThan(0);
      expect(d.constraints.timeoutMs, d.id).toBeGreaterThan(0);
      expect(["available", "degraded", "unavailable"]).toContain(d.availability.status);
      expect(d.version, d.id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(d.verification.method, d.id).toBeTruthy();
    }
  });

  it("never presents a planned capability as usable", async () => {
    app = createApp();
    const planned = app.registry.list().filter((d) => d.developmentStatus === "planned");
    expect(planned.map((d) => d.id).sort()).toEqual(["asset.text_to_3d", "data.terrain.dem"]);
    expect(app.registry.get("gmat.run")!.descriptor.developmentStatus).toBe("experimental");
    for (const d of planned) {
      expect(app.registry.isUsable(d)).toBe(false);
      expect(d.availability.reason).toMatch(/Planned/);
      await expect(executeDirect(app, d.id, {}, { id: "u", role: "lead" })).rejects.toThrow(/planned, not implemented/);
    }
    await app.registry.refreshAvailability();
    expect(app.registry.resolve("asset.generative")).toBeUndefined();
    expect(app.registry.search({ provides: "asset.generative" })).toHaveLength(1); // still discoverable
  });

  it("discovers capabilities by text, tag, category and permission", () => {
    app = createApp();
    expect(app.registry.search({ text: "link budget antenna" })[0]!.descriptor.id).toBe("science.comms.link_budget");
    expect(app.registry.resolve("calc.orbit.elements")!.id).toBe("science.orbit.elements");
    expect(app.registry.search({ provides: "calc.*", usableOnly: true }).length).toBeGreaterThanOrEqual(7);
    expect(app.registry.search({ category: "simulation" }).map((m) => m.descriptor.id)).toContain("simulation.power_timeline");
    const viewer = app.registry.search({ usableOnly: true, permissions: ["state:read", "memory:read"] }).map((m) => m.descriptor.id);
    expect(viewer).toContain("mission.inspect");
    expect(viewer).not.toContain("mission.propose_patch");
    expect(() => app.registry.register(app.registry.get("mission.inspect")!)).toThrow(/already registered/);
  });

  it("reports the language-model capability as unavailable without credentials", async () => {
    app = createApp({ llm: { modelId: "none", status: () => ({ available: false, reason: "No credentials" }), structured: async () => { throw new Error("unreachable"); } } });
    // Only probe the capability that depends on the model; do not touch the network here.
    const cap = app.registry.get("code.generate_module")!;
    const health = await cap.healthCheck!();
    expect(health).toEqual({ status: "unavailable", reason: "No credentials" });
  });

  it("executes read-only capabilities directly, validates input and tracks statistics", async () => {
    app = createApp();
    const user = { id: "eng", role: "engineer" as const };
    const result = await executeDirect(app, "science.orbit.elements", { body: "moon", semiMajorAxisKm: 1837.4, eccentricity: 0 }, user);
    expect(result.verification).toBe("deterministic_calculation");
    expect((result.output as { periodS: number }).periodS / 60).toBeCloseTo(117.8, 0);
    expect(result.provenance.capabilityId).toBe("science.orbit.elements");
    await expect(executeDirect(app, "science.orbit.elements", { body: "pluto" }, user)).rejects.toThrow(/Invalid input/);
    await expect(executeDirect(app, "mission.propose_patch", { patches: [{ op: "set", path: "missionTime", value: "x" }] }, user)).rejects.toThrow(/only run as part of a request/);
    await expect(executeDirect(app, "data.horizons.vectors", { target: "mars", time: "2027-01-01T00:00:00Z" }, { id: "v", role: "viewer" })).rejects.toThrow(/lacks permissions/);
    expect(app.registry.describe("science.orbit.elements")!.stats.calls).toBe(1);
  });
});

describe("dependency-aware recalculation", () => {
  it("computes every derived node for the seed mission with all constraints passing", () => {
    app = createApp();
    const head = app.store.head();
    expect(Object.keys(head.derived).sort()).toEqual(DERIVED_NODES.map((n) => n.id).sort());
    for (const [id, node] of Object.entries(head.derived)) expect(node.error, id).toBeUndefined();
    expect((head.derived["orbit.elements"]!.value as { periodS: number }).periodS / 60).toBeCloseTo(117.8, 0);
    const checks = engineeringChecks(head.config, head.derived);
    expect(checks.length).toBeGreaterThanOrEqual(6);
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  const change = (path: string, value: unknown) => {
    const head = app.store.head();
    const parsed = parseMissionConfig(applyPatch(head.config as unknown, { op: "set", path, value }));
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    return { head, next: recalculate(parsed.config, { config: head.config, derived: head.derived }) };
  };

  it("recalculates only what a ground-station change affects", () => {
    app = createApp();
    const { head, next } = change("groundStation.antennaGainDbi", 60);
    expect(next.recalculated).toEqual(["comms.link", "data.budget", "science.return"]);
    expect(next.derived["power.budget"]).toBe(head.derived["power.budget"]); // reused, not recomputed
    const before = (head.derived["comms.link"]!.value as { worstMarginDb: number }).worstMarginDb;
    expect((next.derived["comms.link"]!.value as { worstMarginDb: number }).worstMarginDb).toBeCloseTo(before - 8.2, 6);
  });

  it("propagates a mission-time change to celestial positions, lighting, eclipse and power", () => {
    app = createApp();
    const { next } = change("missionTime", "2027-06-01T00:00:00Z");
    expect(next.recalculated).toEqual(expect.arrayContaining(["ephemeris.sun", "scene.lighting", "orbit.trajectory", "orbit.eclipse", "power.budget", "comms.link"]));
    expect(next.reused).toEqual(expect.arrayContaining(["orbit.elements", "mass.budget", "rover.performance"]));
  });

  it("propagates an orbit change to trajectory, eclipse, power and communications", () => {
    app = createApp();
    const { head, next } = change("orbit.semiMajorAxisKm", 2737.4);
    expect(next.recalculated).toEqual(expect.arrayContaining(["orbit.elements", "orbit.trajectory", "orbit.eclipse", "power.budget", "comms.link"]));
    expect(next.reused).toEqual(expect.arrayContaining(["ephemeris.sun", "mass.budget", "rover.performance"]));
    const f = (d: typeof head.derived): number => (d["orbit.eclipse"]!.value as { eclipseFraction: number }).eclipseFraction;
    expect(f(next.derived)).toBeLessThan(f(head.derived)); // higher orbit, shorter eclipse fraction
  });

  it("limits a spacecraft component change to the nodes that read components, and a rover change to rover performance", () => {
    app = createApp();
    const panel = change("spacecraft.components.sp1.areaM2", 2.4);
    expect(panel.next.recalculated.sort()).toEqual(["comms.link", "cost.budget", "data.budget", "mass.budget", "power.budget", "science.return"]);
    const gen = (d: typeof panel.head.derived): number => (d["power.budget"]!.value as { sunlitGenerationW: number }).sunlitGenerationW;
    expect(gen(panel.next.derived)).toBeCloseTo(2 * gen(panel.head.derived), 6);
    const rover = change("rover.wheelTorqueNm", 0.2);
    expect(rover.next.recalculated.sort()).toEqual(["cost.budget", "rover.performance"]);
    expect(engineeringChecks(parseMissionConfigOrThrow(applyPatch(app.store.head().config as unknown, { op: "set", path: "rover.wheelTorqueNm", value: 0.2 })), rover.next.derived).find((c) => c.id === "rover.slope")!.status).toBe("fail");
  });
});

function parseMissionConfigOrThrow(input: unknown) {
  const parsed = parseMissionConfig(input);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.config;
}

describe("versioned mission store", () => {
  it("rejects invalid configurations and dangling references", () => {
    app = createApp();
    const head = app.store.head();
    expect(() => app.store.publish({ ...head.config, orbit: { ...head.config.orbit, eccentricity: 1.5 } }, { by: "t", note: "bad" })).toThrow(/Invalid mission configuration/);
    const dangling = { ...head.config, scene: { nodes: [{ id: "n1", name: "ghost", assetId: "missing" }] } };
    expect(() => app.store.publish(dangling, { by: "t", note: "bad" })).toThrow(/missing asset/);
    expect(app.store.head().version).toBe(1);
  });

  it("publishes new versions and rolls back by republishing, preserving history", () => {
    app = createApp();
    const v1 = app.store.head();
    const events: number[] = [];
    app.store.on("published", (v) => events.push(v.version));
    const { version: v2 } = app.store.publish(applyPatch(v1.config as unknown, { op: "set", path: "orbit.inclinationDeg", value: 60 }), { by: "lead", note: "change" });
    expect(v2.version).toBe(2);
    expect(v2.recalculated).toEqual(expect.arrayContaining(["orbit.eclipse", "orbit.trajectory"]));
    const v3 = app.store.rollback(1, "lead", "undo");
    expect(v3.version).toBe(3);
    expect(v3.rollbackOf).toBe(1);
    expect(v3.config).toEqual(v1.config);
    expect(v3.derived["orbit.eclipse"]!.value).toEqual(v1.derived["orbit.eclipse"]!.value);
    expect(app.store.list().map((v) => v.version)).toEqual([1, 2, 3]);
    expect(events).toEqual([2, 3]);
    expect(() => app.store.rollback(3, "lead", "noop")).toThrow(/already the current/);
  });
});

describe("persistence", () => {
  it("restores mission versions, memory and review state after a restart", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "mission-ai-persist-"));
    try {
      const first = createApp({ dataDir });
      first.store.publish(applyPatch(first.store.head().config as unknown, { op: "set", path: "orbit.inclinationDeg", value: 75 }), { by: "lead", note: "tilt" });
      const record = first.memory.add({ kind: "design_change", missionName: "m", missionVersion: 2, summary: "Tilted the orbit", data: {}, tags: [], provenance: { source: "test" }, assumptions: [], verification: "deterministic_calculation", trainingConsent: true });
      first.memory.markQualityReviewed(record.id, "lead-1");
      await first.close();

      const second = createApp({ dataDir });
      expect(second.store.head().version).toBe(2);
      expect(second.store.head().config.orbit.inclinationDeg).toBe(75);
      expect(second.store.list().map((v) => v.note)).toEqual(["Initial mission configuration", "tilt"]);
      expect(second.memory.search("tilted orbit")[0]!.record.id).toBe(record.id);
      expect(second.memory.trainingEligible().map((r) => r.id)).toEqual([record.id]);
      expect(second.store.publish(second.store.head().config, { by: "lead", note: "noop" }).version.version).toBe(3);
      await second.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("research memory", () => {
  const base = { missionName: "m", missionVersion: 1, data: {}, tags: [], provenance: { source: "test" }, assumptions: [] };
  it("retrieves similar records lexically", () => {
    const memory = new ResearchMemory(null);
    memory.add({ ...base, kind: "design_change", summary: "Increased solar array area to fix negative power margin", verification: "deterministic_calculation" });
    memory.add({ ...base, kind: "failure", summary: "Rover could not climb 25 degree slope: traction limited", verification: "deterministic_calculation" });
    memory.add({ ...base, kind: "simulation_result", summary: "Battery state of charge simulation over 10 orbits", verification: "deterministic_calculation" });
    const hits = memory.search("rover slope climbing traction");
    expect(hits[0]!.record.kind).toBe("failure");
    expect(memory.search("solar power margin", { kinds: ["design_change"] })).toHaveLength(1);
    expect(memory.search("zzz unrelated")).toEqual([]);
  });

  it("only releases records for training with consent, quality review and validated evidence", () => {
    const memory = new ResearchMemory(null);
    const noConsent = memory.add({ ...base, kind: "design_change", summary: "a", verification: "deterministic_calculation" });
    const consented = memory.add({ ...base, kind: "design_change", summary: "b", verification: "deterministic_calculation", trainingConsent: true });
    const modelOutput = memory.add({ ...base, kind: "plan", summary: "c", verification: "model_judgment", trainingConsent: true });
    expect(memory.trainingEligible()).toEqual([]);
    for (const r of [noConsent, consented, modelOutput]) memory.markQualityReviewed(r.id, "lead-1");
    expect(memory.trainingEligible().map((r) => r.id)).toEqual([consented.id]);
    expect(memory.get(consented.id)!.training.qualityReviewedBy).toBe("lead-1");
  });
});
