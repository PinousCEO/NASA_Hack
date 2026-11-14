/**
 * The design decisions the challenge statement names beyond orbit and payload: attitude
 * control, onboard computing, launch vehicle, development time, in-flight events and the
 * team's own mission definition. Every assertion is against the deterministic models.
 */
import { describe, expect, it } from "vitest";
import { flightEvents } from "../src/game/events.js";
import { generateMission, SCENARIOS } from "../src/game/scenarios.js";
import { evaluateMission } from "../src/game/scoring.js";
import { simulateMission } from "../src/game/simulation.js";
import { assessConceptMaturity } from "../src/nasa/lifecycle.js";
import { engineeringChecks, recalculate } from "../src/state/recalc.js";
import { type Component, type MissionConfig, parseMissionConfig } from "../src/state/schema.js";
import { installPart } from "../src/systems/graph.js";

const lunar = (): MissionConfig => generateMission("lunar-volatiles", 1, "cadet").config;
const part = (scenarioId: string, itemId: string, id: string): Component => ({ ...SCENARIOS.find((s) => s.id === scenarioId)!.catalog.find((c) => c.id === itemId)!.component, id }) as Component;
const withParts = (config: MissionConfig, ...parts: Component[]): MissionConfig => {
  const parsed = parseMissionConfig(parts.reduce((c, p) => installPart(c, p), config));
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.config;
};
const value = <T>(config: MissionConfig, node: string): T => recalculate(config).derived[node]!.value as T;

describe("attitude control", () => {
  it("limits image sharpness by pointing stability until a control unit is fitted", () => {
    const camera = withParts(lunar(), part("lunar-volatiles", "nac", "cam1"));
    const coarse = value<{ bestImagingResolutionM: number; pointingSmearM: number; instruments: { diffractionLimitM: number }[] }>(camera, "science.return");
    // 20 arcsec at 100 km smears about 9.7 m, far above the 0.34 m diffraction limit of a 20 cm aperture.
    expect(coarse.pointingSmearM).toBeCloseTo(20 * (Math.PI / 648000) * 100e3, 3);
    expect(coarse.instruments[0]!.diffractionLimitM).toBeCloseTo(0.3355, 3);
    expect(coarse.bestImagingResolutionM).toBeCloseTo(coarse.pointingSmearM, 6);
    const fine = value<{ bestImagingResolutionM: number }>(withParts(camera, part("lunar-volatiles", "adcs-rw", "adcs1")), "science.return");
    expect(fine.bestImagingResolutionM).toBeCloseTo(2 * (Math.PI / 648000) * 100e3, 3);
    expect(value<{ source: string; dedicatedUnit: boolean }>(camera, "adcs.pointing")).toMatchObject({ dedicatedUnit: false });
  });

  it("charges a narrow antenna beam for pointing error: 12 (error / beamwidth)² dB", () => {
    const ka = withParts(lunar(), part("lunar-volatiles", "hga-ka", "ka1"));
    const link = (c: MissionConfig) => value<{ links: { antennaId: string; pointingLossDb: number; beamwidthDeg: number; marginDb: number }[] }>(c, "comms.link").links.find((l) => l.antennaId === "ka1")!;
    const coarse = link(ka);
    expect(coarse.beamwidthDeg).toBeCloseTo((70 * (0.299792458 / 32)) / 0.9, 6);
    expect(coarse.pointingLossDb).toBeCloseTo(12 * (0.3 / coarse.beamwidthDeg) ** 2, 6);
    const fine = link(withParts(ka, part("lunar-volatiles", "adcs-rw", "adcs1")));
    expect(fine.pointingLossDb).toBeLessThan(0.02);
    expect(fine.marginDb - coarse.marginDb).toBeCloseTo(coarse.pointingLossDb - fine.pointingLossDb, 6);
  });
});

describe("onboard computer", () => {
  it("returns more science through the same link by compressing, and adds storage", () => {
    const m = generateMission("mars-weather-relay", 3, "cadet").config;
    const loaded = withParts(m, part("mars-weather-relay", "nac", "cam1"));
    const before = value<{ returnedGbPerDay: number; generatedGbPerDay: number; downlinkSufficient: boolean; storageGb: number }>(loaded, "data.budget");
    expect(before.downlinkSufficient).toBe(false); // the deep-space link is the bottleneck
    const after = value<{ returnedGbPerDay: number; compressionRatio: number; storageGb: number }>(withParts(loaded, part("mars-weather-relay", "obc-comp", "obc1")), "data.budget");
    expect(after.compressionRatio).toBe(4);
    expect(after.returnedGbPerDay).toBeCloseTo(Math.min(before.generatedGbPerDay, before.returnedGbPerDay * 4), 6);
    expect(after.storageGb).toBe(before.storageGb + 128);
  });
});

describe("development schedule", () => {
  it("grows with every part and fails the launch window when the design is overloaded", () => {
    const base = lunar();
    const schedule = (c: MissionConfig) => value<{ developmentMonths: number; marginMonths: number; longLeadMonths: number; scheduleMonths: number }>(c, "schedule.budget");
    const start = schedule(base);
    expect(start.scheduleMonths).toBe(36);
    expect(start.marginMonths).toBeGreaterThan(0);
    const one = schedule(withParts(base, part("lunar-volatiles", "ns", "i1")));
    expect(one.longLeadMonths).toBe(9); // an instrument becomes the long-lead item
    expect(one.developmentMonths).toBeGreaterThan(start.developmentMonths);
    const many = withParts(base, ...["ns", "nac", "irs", "tir", "gpr", "lola", "nac", "gpr", "lola", "tir", "irs", "ns"].map((id, i) => part("lunar-volatiles", id, `i${i}`)), part("lunar-volatiles", "adcs-fine", "a1"));
    const derived = recalculate(many).derived;
    expect((derived["schedule.budget"]!.value as { marginMonths: number }).marginMonths).toBeLessThan(0);
    expect(engineeringChecks(many, derived).find((c) => c.id === "schedule.window")!.status).toBe("fail");
    expect(derived["schedule.budget"]!.verification).toBe("heuristic"); // a game model, labelled as one
  });
});

describe("launch vehicle", () => {
  it("trades capacity against price and, around Earth, loses capacity to a polar orbit", () => {
    const base = generateMission("leo-cubesat", 1, "cadet").config;
    const options = (c: MissionConfig) => value<{ options: { id: string; capacityKg: number; costMusd: number }[] }>(c, "launch.vehicle").options;
    const polar = options(base);
    const equatorial = options({ ...base, orbit: { ...base.orbit, inclinationDeg: 20 } });
    expect(polar.map((o) => o.id)).toEqual(["rideshare", "dedicated", "heavy"]);
    for (let i = 0; i < 3; i++) expect(polar[i]!.capacityKg).toBeLessThan(equatorial[i]!.capacityKg);
    expect(polar[0]!.costMusd).toBeLessThan(polar[1]!.costMusd);
    expect(polar[2]!.capacityKg).toBeGreaterThan(polar[1]!.capacityKg);
    // At the Moon the orbit's inclination is set on arrival: it does not change what the launch can lift.
    const moon = lunar();
    expect(options({ ...moon, orbit: { ...moon.orbit, inclinationDeg: 20 } })).toEqual(options(moon));
    const small = { ...base, meta: { ...base.meta, launchVehicleId: "rideshare" } };
    const check = engineeringChecks(small, recalculate(small).derived).find((c) => c.id === "launch.vehicle")!;
    const launch = value<{ launchMassKg: number; capacityKg: number }>(small, "launch.vehicle");
    expect(check.status).toBe(launch.launchMassKg <= launch.capacityKg ? "pass" : "fail");
  });
});

describe("in-flight events", () => {
  it("draws the same events for the same seed, more of them at higher difficulty", () => {
    const config = lunar();
    expect(flightEvents(7, "engineer", config)).toEqual(flightEvents(7, "engineer", config));
    expect(flightEvents(7, "cadet", config)).toHaveLength(1);
    expect(flightEvents(7, "engineer", config)).toHaveLength(2);
    expect(flightEvents(7, "chief", config)).toHaveLength(3);
    const kinds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].flatMap((s) => flightEvents(s, "chief", config).map((e) => e.effect.kind)));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    for (const e of flightEvents(99, "chief", config)) expect(e.day).toBeLessThan(config.meta.missionDurationDays);
  });

  it("flies them: a station outage costs data unless storage rides it out, and a string failure cuts power for good", () => {
    const design = withParts(lunar(), part("lunar-volatiles", "ns", "ns1"), part("lunar-volatiles", "nac", "cam1"));
    const calm = simulateMission(design);
    expect(calm.flightEvents).toEqual([]);
    expect(calm.kpis.plannedDataGb).toBeGreaterThan(0);
    const outage = { id: "station-outage", day: 100, durationDays: 8, title: "Ground station outage", description: "", mitigation: "", effect: { kind: "station_outage" as const } };
    const small = simulateMission({ ...design, spacecraft: { ...design.spacecraft, dataStorageGb: 2 } }, { events: [outage] });
    expect(small.flightEvents[0]!.dataLostGb).toBeGreaterThan(0);
    expect(small.kpis.totalDataReturnedGb).toBeLessThan(calm.kpis.totalDataReturnedGb);
    expect(small.events.some((e) => e.day === 100 && /Ground station outage/.test(e.message))).toBe(true);
    const roomy = simulateMission(withParts({ ...design, spacecraft: { ...design.spacecraft, dataStorageGb: 2 } }, part("lunar-volatiles", "obc-store", "mm1")), { events: [outage] });
    expect(roomy.flightEvents[0]!.dataLostGb).toBeLessThan(small.flightEvents[0]!.dataLostGb);
    const string = simulateMission(design, { events: [{ id: "array-string", day: 50, durationDays: 0, title: "Solar array string failure", description: "", mitigation: "", effect: { kind: "array_loss", fraction: 0.15 } }] });
    const day = (sim: typeof calm, d: number) => sim.timeline.find((t) => t.day >= d)!;
    expect(day(string, 60).generationW).toBeCloseTo(day(calm, 60).generationW * 0.85, 4);
    expect(day(string, 0).generationW).toBeCloseTo(day(calm, 0).generationW, 6);
  });
});

describe("mission definition in the score", () => {
  it("weights the primary objective up, pays a bonus for a delivered stretch goal and charges an undelivered one", () => {
    const m = generateMission("lunar-volatiles", 1, "cadet");
    const scenario = SCENARIOS.find((s) => s.id === "lunar-volatiles")!;
    const score = (config: MissionConfig, objectives: typeof m.objectives) => {
      const { derived } = recalculate(config);
      const checks = engineeringChecks(config, derived);
      const maturity = assessConceptMaturity(config, derived, checks, { objectivesDefined: objectives.length, tradeStudies: 0, tradeParameters: 0, simulationsRun: 0, risksRecorded: 0, reviewsHeld: 0 });
      return evaluateMission({ objectives, config, derived, checks, simulation: null, maturity, contributors: 1, unverifiedContent: 0 });
    };
    const stretch = [...m.objectives, { ...scenario.stretchGoals.find((o) => o.id === "s-thermal")!, stretch: true }];
    const plain = score(m.config, m.objectives);
    const promised = score(m.config, stretch);
    expect(promised.penalties.some((p) => /stretch goal/.test(p.reason) && p.points === 2)).toBe(true);
    expect(promised.score).toBeCloseTo(plain.score - 2, 6);
    const thermal = withParts(m.config, part("lunar-volatiles", "tir", "tir1"));
    const delivered = score(thermal, stretch);
    expect(delivered.penalties.some((p) => /stretch goal/.test(p.reason))).toBe(false);
    expect(delivered.objectives.find((o) => o.id === "s-thermal")).toMatchObject({ achieved: 1, stretch: true });
    // The bonus is on top of the baseline: the same design without the commitment scores lower.
    expect(delivered.objectivesScore).toBeGreaterThan(score(thermal, m.objectives).objectivesScore);
    const primary = score(m.config, m.objectives.map((o) => (o.id === "polar" ? { ...o, weight: o.weight * 1.5, primary: true } : o)));
    expect(primary.objectives.find((o) => o.id === "polar")).toMatchObject({ weight: 12, primary: true });
    expect(primary.objectivesScore).toBeGreaterThan(plain.objectivesScore); // "polar" is already met, so naming it primary pays
  });
});
