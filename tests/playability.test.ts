/**
 * Is the game actually playable? Two properties of the scenarios themselves, checked with a
 * solver that lives only in the tests (the game never tells a player what to add):
 *
 *  1. Every scenario, at every difficulty, can be brought to a design that respects all its
 *     limits, survives its in-flight events and scores well.
 *  2. There is more than one good answer: crews that commit to different launch vehicles, or
 *     name a different primary objective, end up with different spacecraft that all score well.
 */
import { describe, expect, it } from "vitest";
import { flightEvents } from "../src/game/events.js";
import { type Difficulty, generateMission, type Objective, SCENARIOS } from "../src/game/scenarios.js";
import { evaluateMission } from "../src/game/scoring.js";
import { simulateMission } from "../src/game/simulation.js";
import { assessConceptMaturity } from "../src/nasa/lifecycle.js";
import { engineeringChecks, recalculate } from "../src/state/recalc.js";
import type { MissionConfig } from "../src/state/schema.js";
import { advise, applyMove, type Move } from "./support/solver.js";

/** A crew that has done the whole process: studies, simulation, risks, review. */
const EVIDENCE = { tradeStudies: 2, tradeParameters: 2, simulationsRun: 1, risksRecorded: 3, reviewsHeld: 1 };

function play(scenarioId: string, difficulty: Difficulty, seed: number, commitment: { vehicle?: string; primary?: string; forbid?: Move["kind"][] } = {}) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const mission = generateMission(scenarioId, seed, difficulty);
  const primary = commitment.primary ?? scenario.objectives.find((o) => o.category === "science")!.id;
  const objectives: Objective[] = scenario.objectives.map((o) => (o.id === primary ? { ...o, weight: o.weight * 1.5, primary: true } : o));
  let config: MissionConfig = commitment.vehicle ? { ...mission.config, meta: { ...mission.config.meta, launchVehicleId: commitment.vehicle } } : mission.config;
  const maturity = (c: MissionConfig) => {
    const { derived } = recalculate(c);
    return assessConceptMaturity(c, derived, engineeringChecks(c, derived), { objectivesDefined: objectives.length, ...EVIDENCE });
  };
  let moves = 0;
  for (; moves < 30; moves++) {
    const advice = advise({ config, objectives, catalog: scenario.catalog, maturity: maturity(config), contributors: 1, ...(commitment.forbid ? { forbid: commitment.forbid } : {}) });
    if (!advice.move) break;
    config = applyMove(config, advice.move, scenario.catalog);
  }
  const { derived } = recalculate(config);
  const checks = engineeringChecks(config, derived);
  const simulation = simulateMission(config, { events: flightEvents(seed, difficulty, config) });
  const evaluation = evaluateMission({ objectives, config, derived, checks, simulation, maturity: maturity(config), contributors: 1, unverifiedContent: 0 });
  return { config, moves, evaluation, failing: checks.filter((c) => c.status === "fail").map((c) => c.id), parts: config.spacecraft.components.map((c) => c.name).sort(), vehicle: config.meta.launchVehicleId ?? null, altitudeKm: Math.round(config.orbit.semiMajorAxisKm) };
}

describe("playability", () => {
  it("every scenario can be finished at every difficulty: limits respected, events survived, a good score", () => {
    const outcomes: string[] = [];
    for (const scenario of SCENARIOS) {
      for (const difficulty of ["cadet", "engineer", "chief"] as const) {
        for (const seed of [7, 21]) {
          const run = play(scenario.id, difficulty, seed);
          const where = `${scenario.id}/${difficulty}/${seed}`;
          expect(run.failing, where).toEqual([]);
          expect(run.vehicle, where).not.toBeNull(); // it has a way to space
          expect(run.moves, where).toBeLessThan(20);
          expect(run.evaluation.score, where).toBeGreaterThanOrEqual(80);
          expect(run.evaluation.objectives.find((o) => o.id === "resilience")!.achieved, where).toBeGreaterThan(0.8);
          outcomes.push(where + "=" + run.evaluation.outcome.verdict + " " + run.evaluation.outcome.conditions.filter((k) => !k.met).map((k) => k.id + ": " + k.evidence).join(" | "));
        }
      }
    }
    // The mission outcome can be won: a finished design is never "not ready" or "failed", and every scenario has a full success.
    expect(outcomes.filter((o) => !/=(success|partial) /.test(o))).toEqual([]);
    for (const scenario of SCENARIOS) expect(outcomes.some((o) => o.startsWith(scenario.id) && o.includes("=success ")), scenario.id).toBe(true);
  }, 120000);

  it("has more than one good answer: different commitments lead to different spacecraft that all score well", () => {
    for (const scenario of SCENARIOS) {
      const science = scenario.objectives.filter((o) => o.category === "science");
      const runs = [
        // Crews that commit to a launch vehicle up front and design to it.
        ...["rideshare", "dedicated"].map((vehicle) => ({ label: `launch: ${vehicle}`, run: play(scenario.id, "engineer", 7, { vehicle, forbid: ["vehicle"] }) })),
        // Crews that decide a different measurement is what the mission is for.
        ...[science[0]!, science[science.length - 1]!].map((o) => ({ label: `primary: ${o.id}`, run: play(scenario.id, "engineer", 7, { primary: o.id }) })),
        // A crew that will not change the orbit it was given.
        { label: "orbit kept", run: play(scenario.id, "engineer", 7, { forbid: ["altitude", "inclination"] }) },
      ];
      for (const { label, run } of runs) {
        expect(run.failing, `${scenario.id} · ${label}`).toEqual([]);
        expect(run.evaluation.score, `${scenario.id} · ${label}`).toBeGreaterThanOrEqual(75);
      }
      // The answers are not the same spacecraft: parts, launch vehicle or orbit differ.
      const designs = new Set(runs.map(({ run }) => JSON.stringify([run.parts, run.vehicle, run.altitudeKm])));
      console.info(`${scenario.id}: ${designs.size} distinct designs among ${runs.length} crews — ${runs.map(({ label, run }) => `${label} ${run.evaluation.score.toFixed(1)}`).join(", ")}`);
      expect(designs.size, `${scenario.id}: distinct designs among ${runs.length} crews`).toBeGreaterThanOrEqual(2);
    }
  }, 120000);
});
