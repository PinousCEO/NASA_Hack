/** GLB generation/validation and the isolated script sandbox. */
import { describe, expect, it } from "vitest";
import { box, buildGlb, cylinder, gltfJsonToGlb, type MeshPart, paraboloid, parseGlb, sphere, validateGlb } from "../src/assets/glb.js";
import { type AssetSpec, assetSpecForComponent, buildParts } from "../src/capabilities/assets.js";
import { runInSandbox } from "../src/sandbox/sandbox.js";
import { validateModuleSource } from "../src/sandbox/typecheck.js";

/** Fraction of triangles whose geometric normal agrees with their vertex normals. */
function windingAgreement(part: Pick<MeshPart, "positions" | "normals" | "indices">): number {
  let agree = 0;
  let total = 0;
  const v = (i: number, arr: number[]): [number, number, number] => [arr[i * 3]!, arr[i * 3 + 1]!, arr[i * 3 + 2]!];
  for (let t = 0; t < part.indices.length; t += 3) {
    const [a, b, c] = [part.indices[t]!, part.indices[t + 1]!, part.indices[t + 2]!];
    const [p, q, r] = [v(a, part.positions), v(b, part.positions), v(c, part.positions)];
    const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const e2 = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    if (Math.hypot(n[0]!, n[1]!, n[2]!) < 1e-12) continue; // degenerate (sphere poles)
    const vn = v(a, part.normals);
    total++;
    if (n[0]! * vn[0] + n[1]! * vn[1] + n[2]! * vn[2] > 0) agree++;
  }
  return agree / total;
}

describe("GLB assets", () => {
  it("builds primitives with outward-facing, consistently wound triangles", () => {
    expect(windingAgreement(box(1, 2, 3))).toBe(1);
    expect(windingAgreement(cylinder(0.5, 2))).toBe(1);
    expect(windingAgreement(sphere(1))).toBe(1);
    expect(windingAgreement(paraboloid(1, 0.15))).toBe(1);
  });

  it("produces a valid GLB with correct bounds for every parametric kind", () => {
    const specs: AssetSpec[] = [
      { kind: "box", widthM: 1, heightM: 2, depthM: 3 },
      { kind: "cylinder", radiusM: 0.5, heightM: 2 },
      { kind: "sphere", radiusM: 1 },
      { kind: "solar_panel", widthM: 2, heightM: 1, thicknessM: 0.02 },
      { kind: "dish_antenna", diameterM: 0.6, depthRatio: 0.15 },
      { kind: "wheel", radiusM: 0.12, widthM: 0.08 },
      { kind: "rover_chassis", lengthM: 0.8, widthM: 0.5, heightM: 0.2, wheelRadiusM: 0.12, wheelCount: 6 },
    ];
    for (const spec of specs) {
      const glb = buildGlb(buildParts(spec), { name: spec.kind, generator: "test" });
      const stats = validateGlb(glb);
      expect(stats.triangles, spec.kind).toBeGreaterThan(0);
      expect(glb.byteLength % 4, spec.kind).toBe(0);
    }
    const boxStats = validateGlb(buildGlb(buildParts(specs[0]!), { name: "box", generator: "test" }));
    expect(boxStats.triangles).toBe(12);
    expect(boxStats.boundingBox.min).toEqual([-0.5, -1, -1.5]);
    expect(boxStats.boundingBox.max).toEqual([0.5, 1, 1.5]);
    const rover = validateGlb(buildGlb(buildParts(specs[6]!), { name: "rover", generator: "test" }));
    expect(rover.meshes).toBe(7); // chassis + 6 wheels
    expect(rover.boundingBox.min[1]).toBeCloseTo(0, 6); // wheels rest on the ground plane
  });

  it("sizes placeholder assets from component parameters", () => {
    const spec = assetSpecForComponent({ id: "sp9", type: "solar_panel", name: "p", massKg: 1, areaM2: 2, efficiency: 0.3, pointingLoss: 0, degradationPerYear: 0, costMusd: 0 });
    expect(spec.kind).toBe("solar_panel");
    if (spec.kind === "solar_panel") expect(spec.widthM * spec.heightM).toBeCloseTo(2, 9);
  });

  it("rejects corrupted GLB data", () => {
    const glb = buildGlb(buildParts({ kind: "sphere", radiusM: 1 }), { name: "s", generator: "test" });
    expect(() => validateGlb(glb.subarray(0, glb.byteLength - 8))).toThrow(/length/);
    const badMagic = glb.slice();
    badMagic[0] = 0;
    expect(() => validateGlb(badMagic)).toThrow(/magic/);
    expect(() => buildGlb([{ name: "bad", positions: [0, 0, 0], normals: [0, 1, 0], indices: [0, 1, 2], color: [1, 1, 1] }], { name: "x", generator: "t" })).toThrow(/indices/);
  });

  it("converts an embedded-buffer glTF document to an equivalent GLB", () => {
    const original = buildGlb(buildParts({ kind: "cylinder", radiusM: 0.5, heightM: 2 }), { name: "c", generator: "test" });
    const { json, bin } = parseGlb(original);
    const gltf = { ...json, buffers: [{ byteLength: bin.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(bin).toString("base64")}` }] };
    const converted = gltfJsonToGlb(JSON.stringify(gltf));
    expect(validateGlb(converted)).toEqual(validateGlb(original));
    expect(() => gltfJsonToGlb(JSON.stringify({ ...json, buffers: [{ byteLength: 4, uri: "mesh.bin" }] }))).toThrow(/external/);
  });
});

const config = { orbit: { semiMajorAxisKm: 1837.4 }, spacecraft: { components: [{ id: "sp1", areaM2: 1.2 }] } };
const derived = { "power.budget": { value: { marginW: 137 }, assumptions: [], verification: "deterministic_calculation" as const } };
const compile = (source: string): string => {
  const checked = validateModuleSource(source);
  expect(checked.diagnostics.concat(checked.policyViolations)).toEqual([]);
  return checked.compiledJs!;
};

describe("script validation", () => {
  it("accepts a module written against the mission API", () => {
    const checked = validateModuleSource(`
      export function run(input: Record<string, unknown>): unknown {
        const a = mission.get("orbit.semiMajorAxisKm");
        const factor = typeof input.factor === "number" ? input.factor : 1;
        return typeof a === "number" ? a * factor : null;
      }`);
    expect(checked.ok).toBe(true);
  });

  it("rejects imports, eval, Node globals and type errors", () => {
    const reject = (source: string, pattern: RegExp): void => {
      const checked = validateModuleSource(source);
      expect(checked.ok, source).toBe(false);
      expect([...checked.policyViolations, ...checked.diagnostics].join("\n")).toMatch(pattern);
    };
    reject(`import fs from "node:fs"; export function run() { return fs.readdirSync("."); }`, /imports are not allowed/);
    reject(`export function run() { return eval("1+1"); }`, /"eval" is not allowed/);
    reject(`export function run() { return process.env; }`, /"process" is not allowed/);
    reject(`export function run() { return new Function("return this")(); }`, /"Function" is not allowed/);
    reject(`export async function run() { return (await import("node:os")).hostname(); }`, /import\(\) is not allowed|TS/);
    reject(`export function run() { return fetch("https://example.com"); }`, /TS2304|Cannot find name/);
    reject(`export function run() { const a: number = mission.get("orbit"); return a; }`, /TS2322/);
    reject(`export function helper() { return 1; }`, /export function run/);
  });
});

describe("sandbox", () => {
  it("runs a module with read and calc access and returns its result", async () => {
    const js = compile(`
      export function run(input: Record<string, unknown>): unknown {
        const a = mission.get("orbit.semiMajorAxisKm") as number;
        const orbit = mission.calc("orbitElements", { body: "moon", semiMajorAxisKm: a, eccentricity: 0 });
        mission.log("period computed");
        return { periodMin: (orbit.periodS as number) / 60, margin: (mission.derived("power.budget") as { marginW: number }).marginW };
      }`);
    const run = await runInSandbox({ compiledJs: js, permissions: ["state:read", "calc"], config, derived, input: {} });
    expect(run.error).toBeUndefined();
    expect((run.result as { periodMin: number }).periodMin).toBeCloseTo(117.8, 0);
    expect((run.result as { margin: number }).margin).toBe(137);
    expect(run.logs).toEqual(["period computed"]);
  });

  it("collects proposals without applying them, and enforces permissions", async () => {
    const js = compile(`export function run(): unknown { mission.propose({ op: "set", path: "orbit.semiMajorAxisKm", value: 1900 }); return mission.get("orbit.semiMajorAxisKm"); }`);
    const allowed = await runInSandbox({ compiledJs: js, permissions: ["state:read", "state:propose"], config, derived, input: {} });
    expect(allowed.ok).toBe(true);
    expect(allowed.proposedPatches).toEqual([{ op: "set", path: "orbit.semiMajorAxisKm", value: 1900 }]);
    expect(config.orbit.semiMajorAxisKm).toBe(1837.4); // host state untouched

    const denied = await runInSandbox({ compiledJs: js, permissions: ["state:read"], config, derived, input: {} });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/Permission denied/);
    expect(denied.deniedCalls).toEqual(["propose"]);
    expect(denied.proposedPatches).toEqual([]);
  });

  it("has no access to host globals even for code that bypasses the type-checker", async () => {
    const probe = `exports.run = function () {
      return { process: typeof process, require: typeof require, fetch: typeof fetch, globalProcess: typeof globalThis.process, setTimeout: typeof setTimeout,
        ctor: (function(){}).constructor("return typeof process")() };
    };`;
    const run = await runInSandbox({ compiledJs: probe, permissions: [], config, derived, input: {} });
    expect(run.ok).toBe(true);
    expect(run.result).toEqual({ process: "undefined", require: "undefined", fetch: "undefined", globalProcess: "undefined", setTimeout: "undefined", ctor: "undefined" });
  });

  it("stops infinite loops and memory exhaustion", async () => {
    const spin = await runInSandbox({ compiledJs: `exports.run = function () { for (;;) {} };`, permissions: [], config, derived, input: {}, limits: { timeoutMs: 200 } });
    expect(spin.ok).toBe(false);
    expect(spin.error).toMatch(/time limit|interrupted/i);
    const hog = await runInSandbox({ compiledJs: `exports.run = function () { const a = []; for (;;) a.push(new Array(100000).fill(1)); };`, permissions: [], config, derived, input: {}, limits: { timeoutMs: 5000, memoryBytes: 8 * 1024 * 1024 } });
    expect(hog.ok).toBe(false);
  });

  it("rejects proposals to paths that do not exist and unknown host calls", async () => {
    const bad = await runInSandbox({ compiledJs: `exports.run = function () { mission.propose({ op: "set", path: "nope.deeper.value", value: 1 }); };`, permissions: ["state:propose"], config, derived, input: {} });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/does not exist/);
    const unknown = await runInSandbox({ compiledJs: `exports.run = function () { return __host("readFile", "[]"); };`, permissions: [], config, derived, input: {} });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Unknown host function/);
  });
});
