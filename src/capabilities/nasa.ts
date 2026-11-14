/**
 * Capabilities for NASA tool interfaces, mission-level simulation, trade studies and the
 * knowledge base. Each states plainly whether it is a real integration, a deterministic
 * approximation, or unavailable in the current installation.
 */
import { z } from "zod";
import { applyPatch, getPath } from "../core/paths.js";
import { CapabilityError } from "../core/types.js";
import { simulateMission } from "../game/simulation.js";
import type { KnowledgeBase } from "../knowledge/knowledge.js";
import { exportGmatScript, gmatStatus, parseGmatReport, runGmat } from "../nasa/gmat.js";
import { type Capability, defineCapability, type ExecutionContext } from "../registry/capability.js";
import { j2SecularRates, propagateJ2 } from "../science/propagate.js";
import { engineeringChecks, recalculate } from "../state/recalc.js";
import { type MissionConfig, parseMissionConfig } from "../state/schema.js";

function working(ctx: ExecutionContext): MissionConfig {
  const parsed = parseMissionConfig(ctx.draft.workingConfig());
  if (!parsed.ok) throw new CapabilityError(`Draft configuration is invalid: ${parsed.issues.join("; ")}`);
  return parsed.config;
}

const gmatOptions = z.object({
  durationDays: z.number().positive().max(3650).default(1),
  gravityDegree: z.number().int().min(0).max(100).default(2),
  gravityOrder: z.number().int().min(0).max(100).default(0),
  thirdBodies: z.boolean().default(true),
});
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const trajectory = z.array(z.object({ elapsedS: z.number(), positionKm: vec3, velocityKmS: vec3 }));

export function nasaCapabilities(deps: { knowledge: KnowledgeBase }): Capability[] {
  return [
    defineCapability({
      id: "gmat.export_script",
      name: "Export GMAT script",
      description: "Generate a NASA GMAT script that propagates the mission orbit with a configurable gravity field and third bodies, writing an ephemeris ReportFile. Runs anywhere; executing the script needs GMAT.",
      category: "simulation",
      provides: ["gmat.script"],
      input: gmatOptions,
      output: z.object({ script: z.string(), reportFile: z.string(), centralBody: z.string() }),
      requiredPermissions: ["state:read"],
      verification: { status: "unverified", method: "Follows GMAT script syntax; not executed against GMAT in this environment (GMAT not installed)" },
      outputVerification: "deterministic_calculation",
      references: ["https://gmat.atlassian.net/wiki/spaces/GW/overview", "https://software.nasa.gov/software/GSC-17177-1"],
      run: (input, ctx) => {
        const config = working(ctx);
        return { output: { script: exportGmatScript(config, input), reportFile: "mission_ephemeris.txt", centralBody: config.centralBody }, assumptions: ["Drag and solar radiation pressure are switched off in the generated force model"] };
      },
    }),
    defineCapability({
      id: "gmat.import_report",
      name: "Import GMAT ephemeris report",
      description: "Parse a GMAT ReportFile (ElapsedSecs, X, Y, Z, VX, VY, VZ) into trajectory JSON for visualisation — the GMAT-to-web hand-off used by NASA's Web-based Space Mission Visualization workflow.",
      category: "external_data",
      provides: ["gmat.trajectory.import"],
      input: z.object({ report: z.string().min(10).max(50_000_000), maxSamples: z.number().int().min(2).max(5000).default(720) }),
      output: z.object({ samples: trajectory, sampleCount: z.number(), durationS: z.number(), minRadiusKm: z.number(), maxRadiusKm: z.number(), source: z.string() }),
      requiredPermissions: ["state:read"],
      verification: { status: "self_tested", method: "Parser unit tests on ReportFile-format text (tests/platform.test.ts)" },
      outputVerification: "external_data",
      references: ["https://nasa.github.io/mission-viz"],
      run: (input) => {
        let parsed;
        try {
          parsed = parseGmatReport(input.report);
        } catch (err) {
          throw new CapabilityError(err instanceof Error ? err.message : String(err), { code: "gmat_parse" });
        }
        const every = Math.max(1, Math.ceil(parsed.samples.length / input.maxSamples));
        const samples = parsed.samples.filter((_, i) => i % every === 0 || i === parsed.samples.length - 1);
        const radii = parsed.samples.map((s) => Math.hypot(...s.positionKm));
        return {
          output: { samples, sampleCount: parsed.samples.length, durationS: parsed.samples[parsed.samples.length - 1]!.elapsedS - parsed.samples[0]!.elapsedS, minRadiusKm: Math.min(...radii), maxRadiusKm: Math.max(...radii), source: "GMAT ReportFile supplied by the caller" },
          assumptions: ["The report's coordinate system and force model are whatever the GMAT script that produced it specified"],
        };
      },
    }),
    defineCapability({
      id: "gmat.run",
      name: "Run GMAT",
      description: "Propagate the mission orbit in a locally installed NASA GMAT and return its ephemeris. UNAVAILABLE unless GMAT_BIN points to a GMAT console executable.",
      category: "simulation",
      provides: ["sim.orbit.highfidelity"],
      input: gmatOptions,
      output: z.object({ samples: trajectory, sampleCount: z.number(), script: z.string(), source: z.string() }),
      dependencies: ["NASA GMAT (local installation, GMAT_BIN)"],
      requiredPermissions: ["state:read"],
      resources: { cpu: "high", typicalDurationMs: 20000 },
      constraints: { timeoutMs: 6 * 60 * 1000 },
      verification: { status: "unverified", method: "Requires a GMAT installation; not exercised in the development environment" },
      developmentStatus: "experimental",
      outputVerification: "independently_verified",
      healthCheck: async () => {
        const s = gmatStatus();
        return s.available ? { status: "available" } : { status: "unavailable", reason: s.reason ?? "GMAT unavailable" };
      },
      run: async (input, ctx) => {
        const result = await runGmat(working(ctx), input, ctx.signal).catch((err: unknown) => {
          throw new CapabilityError(err instanceof Error ? err.message : String(err), { code: "gmat_run" });
        });
        const every = Math.max(1, Math.ceil(result.samples.length / 720));
        return { output: { samples: result.samples.filter((_, i) => i % every === 0), sampleCount: result.samples.length, script: result.script, source: "NASA GMAT (local run)" } };
      },
    }),
    defineCapability({
      id: "simulation.orbit_j2",
      name: "J2 orbit propagation",
      description: "Numerically propagate the mission orbit with the J2 gravity term (RK4) and report nodal drift against the closed-form secular rate. An approximation of a full-force model: no higher harmonics, third bodies, drag or radiation pressure.",
      category: "simulation",
      provides: ["sim.orbit.j2"],
      input: z.object({ durationDays: z.number().positive().max(60).default(1), stepS: z.number().positive().max(300).default(20) }),
      output: z.looseObject({ raanDriftDeg: z.number(), analyticRaanRateDegPerDay: z.number(), minAltitudeKm: z.number(), impacted: z.boolean(), steps: z.number() }),
      requiredPermissions: ["state:read"],
      resources: { cpu: "medium", typicalDurationMs: 300 },
      constraints: { timeoutMs: 60000 },
      verification: { status: "self_tested", method: "Checked against the analytic J2 secular rate and the sun-synchronous condition (tests/platform.test.ts)" },
      outputVerification: "deterministic_calculation",
      references: ["Vallado, Fundamentals of Astrodynamics and Applications, §9.6"],
      run: (input, ctx) => {
        const config = working(ctx);
        const orbit = { body: config.centralBody, ...config.orbit };
        const result = propagateJ2(orbit, input.durationDays * 86400, input.stepS, 240);
        const rates = j2SecularRates(config.centralBody, config.orbit.semiMajorAxisKm, config.orbit.eccentricity, config.orbit.inclinationDeg);
        return {
          output: { ...result, samples: result.samples, analyticRaanRateDegPerDay: rates.raanRateDegPerDay, analyticArgPeriapsisRateDegPerDay: rates.argPeriapsisRateDegPerDay, numericRaanRateDegPerDay: result.raanDriftDeg / input.durationDays },
          assumptions: ["J2 only: no higher gravity harmonics (dominant for low lunar orbits), third bodies, drag or solar radiation pressure", "Fixed-step RK4"],
        };
      },
    }),
    defineCapability({
      id: "simulation.mission_run",
      name: "Mission-duration simulation",
      description: "Simulate the whole mission day by day: Sun geometry and eclipse season, array degradation, power margin and battery reserve, Earth range and link margin, science data generated, stored, returned and lost.",
      category: "simulation",
      provides: ["sim.mission"],
      input: z.object({ maxDays: z.number().int().positive().max(3650).default(730) }),
      output: z.looseObject({ days: z.number(), kpis: z.looseObject({ totalDataReturnedGb: z.number(), daysPowerNegative: z.number() }) }),
      requiredPermissions: ["state:read"],
      resources: { cpu: "medium", typicalDurationMs: 400 },
      constraints: { timeoutMs: 60000 },
      verification: { status: "self_tested", method: "Consistency tests against the single-epoch models (tests/platform.test.ts)" },
      outputVerification: "deterministic_calculation",
      run: (input, ctx) => {
        const sim = simulateMission(working(ctx), { maxDays: input.maxDays });
        return { output: { ...sim }, assumptions: sim.assumptions };
      },
    }),
    defineCapability({
      id: "analysis.trade_study",
      name: "Trade study",
      description: "Sweep one mission parameter over a set of values and tabulate chosen engineering metrics and constraint status for each — the science/cost/risk partials a trade-space exploration needs. Nothing is changed.",
      category: "scientific_calculation",
      provides: ["analysis.trade"],
      input: z.object({
        path: z.string().min(1).describe("Config path to vary, e.g. orbit.semiMajorAxisKm"),
        values: z.array(z.union([z.number(), z.string(), z.boolean()])).min(2).max(40),
        metrics: z.array(z.object({ node: z.string(), field: z.string() })).min(1).max(12),
      }),
      output: z.object({
        path: z.string(),
        baseline: z.unknown(),
        rows: z.array(z.object({ value: z.unknown(), valid: z.boolean(), error: z.string().optional(), metrics: z.record(z.string(), z.unknown()), failingChecks: z.array(z.string()), warningChecks: z.array(z.string()) })),
      }),
      requiredPermissions: ["state:read"],
      resources: { cpu: "medium", typicalDurationMs: 60 },
      verification: { status: "self_tested", method: "tests/platform.test.ts" },
      outputVerification: "deterministic_calculation",
      run: (input, ctx) => {
        const config = working(ctx);
        const baseline = recalculate(config);
        const baselineValue = getPath(config, input.path);
        if (baselineValue === undefined) throw new CapabilityError(`"${input.path}" is not an existing configuration path`, { code: "bad_path" });
        const rows = input.values.map((value) => {
          try {
            const parsed = parseMissionConfig(applyPatch(config as unknown, { op: "set", path: input.path, value }));
            if (!parsed.ok) return { value, valid: false, error: parsed.issues.join("; "), metrics: {}, failingChecks: [], warningChecks: [] };
            const derived = recalculate(parsed.config, { config, derived: baseline.derived }).derived;
            const checks = engineeringChecks(parsed.config, derived);
            return {
              value,
              valid: true,
              metrics: Object.fromEntries(input.metrics.map((m) => [`${m.node}.${m.field}`, (derived[m.node]?.value as Record<string, unknown> | null | undefined)?.[m.field] ?? null])),
              failingChecks: checks.filter((c) => c.status === "fail").map((c) => c.id),
              warningChecks: checks.filter((c) => c.status === "warn").map((c) => c.id),
            };
          } catch (err) {
            return { value, valid: false, error: err instanceof Error ? err.message : String(err), metrics: {}, failingChecks: [], warningChecks: [] };
          }
        });
        return { output: { path: input.path, baseline: baselineValue ?? null, rows }, assumptions: ["One parameter varied at a time; all other parameters held at their current values"] };
      },
    }),
    defineCapability({
      id: "knowledge.search",
      name: "Search knowledge base",
      description: "Retrieve passages from NASA reference material, ingested documents and the platform's research records, each with its source and evidence level. Suitable as retrieval for RAG.",
      category: "internal_api",
      provides: ["knowledge.search"],
      input: z.object({ query: z.string().min(1), k: z.number().int().min(1).max(20).default(6), kinds: z.array(z.enum(["reference", "document", "record"])).optional() }),
      output: z.object({ hits: z.array(z.object({ id: z.string(), kind: z.string(), text: z.string(), source: z.string(), verification: z.string(), score: z.number() })) }),
      requiredPermissions: ["memory:read"],
      verification: { status: "self_tested", method: "tests/platform.test.ts" },
      outputVerification: "heuristic",
      run: (input) => ({
        output: {
          hits: deps.knowledge.search(input.query, { k: input.k, ...(input.kinds ? { kinds: input.kinds } : {}) }).map(({ passage, score }) => ({
            id: passage.id,
            kind: passage.kind,
            text: passage.text,
            source: `${passage.source.title}${passage.source.locator ? `, ${passage.source.locator}` : ""}`,
            verification: passage.verification,
            score,
          })),
        },
        assumptions: ["Lexical BM25 retrieval: passages are ranked by term overlap, not meaning"],
      }),
      defaultInput: ({ params }) => ({ query: params.query }),
    }),
  ];
}
