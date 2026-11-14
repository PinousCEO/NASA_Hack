/**
 * Mission evaluation. The score is a deterministic function of the engineering models,
 * the mission simulation and the team's recorded process — every point is traceable to a
 * number and a threshold. No model judgement contributes to the score.
 */
import type { MaturityAssessment } from "../nasa/lifecycle.js";
import type { ConstraintCheck, Derived } from "../state/recalc.js";
import type { MissionConfig } from "../state/schema.js";
import type { Objective } from "./scenarios.js";
import type { MissionSimulation } from "./simulation.js";

export interface ObjectiveResult {
  id: string;
  title: string;
  description: string;
  category: Objective["category"];
  weight: number;
  value: number | null;
  unit: string;
  target: number;
  /** 0..1 */
  achieved: number;
  points: number;
  feedback: string;
  primary?: boolean;
  stretch?: boolean;
}

/** Whether this is a mission that works, said in conditions with their evidence. This comes before the score. */
export interface MissionOutcome {
  verdict: "not_ready" | "ready_to_fly" | "success" | "partial" | "failed";
  headline: string;
  conditions: { id: string; title: string; met: boolean | null; evidence: string }[];
  /** The rule the verdict follows (a game rule, stated). */
  rule: string;
}

export function missionOutcome(results: ObjectiveResult[], derived: Derived, checks: ConstraintCheck[], sim: MissionSimulation | null): MissionOutcome {
  const science = results.filter((r) => r.category === "science" && !r.stretch);
  const possible = science.reduce((s, r) => s + r.weight, 0);
  const share = possible > 0 ? science.reduce((s, r) => s + r.points, 0) / possible : 0;
  const open = science.filter((r) => r.achieved < 1);
  const broken = checks.filter((c) => c.status === "fail");
  const launch = derived["launch.vehicle"]?.value as { selectedId: string | null; name: string | null; marginKg: number | null; options: unknown[] } | null | undefined;
  const needsLaunch = Boolean(launch && launch.options.length > 0);
  const lifted = !needsLaunch || (launch!.selectedId !== null && (launch!.marginKg ?? -1) >= 0);
  const delivered = sim ? sim.kpis.scienceDeliveredFraction : null;
  const offShare = sim ? sim.kpis.daysInstrumentsOff / Math.max(1, sim.days) : null;
  const flew = sim ? delivered! >= 0.5 && offShare! <= 0.25 : null;
  const conditions: MissionOutcome["conditions"] = [
    { id: "science", title: "It can do the science it is for", met: share >= 0.6, evidence: `${science.length - open.length} of ${science.length} science goals met in full, ${Math.round(share * 100)}% of the science credit${open.length ? `. Still open: ${open.slice(0, 3).map((r) => r.title).join(", ")}` : ""}` },
    { id: "limits", title: "No engineering limit is broken", met: broken.length === 0, evidence: broken.length ? broken.slice(0, 3).map((c) => `${c.description} (${c.detail})`).join("; ") : `all ${checks.length} checks hold` },
    ...(needsLaunch ? [{ id: "launch", title: "A launch vehicle is chosen and can lift it", met: lifted, evidence: launch!.selectedId === null ? "no launch vehicle chosen yet" : `${launch!.name}: ${(launch!.marginKg ?? 0).toFixed(1)} kg to spare` }] : []),
    { id: "flight", title: "It gets through the flight and brings the data home", met: flew, evidence: sim ? `flown ${sim.days} days: ${Math.round(delivered! * 100)}% of the science an untroubled flight would return, ${sim.kpis.totalDataReturnedGb.toFixed(0)} Gb home, instruments forced off on ${sim.kpis.daysInstrumentsOff} day(s), ${sim.flightEvents.length} in-flight event(s)` : "not flown yet: run the flight simulation" },
  ];
  const ground = conditions.filter((c) => c.id !== "flight");
  const unmet = ground.find((c) => !c.met);
  let verdict: MissionOutcome["verdict"];
  let headline: string;
  const lower = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1);
  if (unmet) { verdict = "not_ready"; headline = sim ? `Flown in simulation, but not a mission that could launch as designed: "${lower(unmet.title)}" does not hold.` : `Not ready to fly: "${lower(unmet.title)}" does not hold yet.`; }
  else if (!sim) { verdict = "ready_to_fly"; headline = "Ready to fly. Run the flight to see whether it comes through."; }
  else if (delivered! >= 0.9 && share >= 0.9 && offShare! <= 0.05) { verdict = "success"; headline = "Mission success: the science was done and the data came home."; }
  else if (flew) { verdict = "partial"; headline = "Partial success: the mission flew and returned science, short of everything it set out to do."; }
  else { verdict = "failed"; headline = "Mission failed in flight: too little of the science came home."; }
  return { verdict, headline, conditions, rule: "Game rule: ready to fly needs 60% of the science credit, no broken limit and a launch vehicle that can lift it. In flight, success is 90% of the science credit and 90% of an untroubled flight's data with the instruments almost never forced off; partial success is at least half the data; less is a failed mission." };
}

export interface Evaluation {
  /** Does the mission work? Shown before the score. */
  outcome: MissionOutcome;
  score: number;
  grade: "S" | "A" | "B" | "C" | "D";
  objectivesScore: number;
  rigorScore: number;
  penalties: { reason: string; points: number }[];
  categories: Record<Objective["category"], { earned: number; possible: number }>;
  objectives: ObjectiveResult[];
  rigor: { item: string; earned: number; possible: number; detail: string }[];
  strengths: string[];
  improvements: string[];
  simulated: boolean;
  basis: string;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function metricValue(o: Objective, config: MissionConfig, derived: Derived, checks: ConstraintCheck[], sim: MissionSimulation | null): number | null {
  const m = o.metric;
  switch (m.type) {
    case "derived": {
      const v = (derived[m.node]?.value as Record<string, unknown> | null | undefined)?.[m.field];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    case "instrument":
    {
      // An instrument counts once it is on board and its lines let it run and record.
      const status = (derived["systems.wiring"]?.value as { wired: boolean; parts: { id: string; power: number; data: number | null }[] } | null | undefined);
      const works = (id: string): boolean => { const p = status?.wired ? status.parts.find((x) => x.id === id) : null; return !p || (p.power > 0 && (p.data ?? 1) > 0); };
      return config.spacecraft.components.some((c) => c.type === "instrument" && c.kind === m.kind && works(c.id)) ? 1 : 0;
    }
    case "simulation": {
      const v = sim ? (sim.kpis as Record<string, unknown>)[m.field] : null;
      return typeof v === "number" ? v : null;
    }
    case "check": {
      const c = checks.find((x) => x.id === m.id);
      return c ? (c.status === "pass" ? 1 : c.status === "warn" ? 0.5 : 0) : null;
    }
  }
}

export function evaluateMission(args: {
  objectives: Objective[];
  config: MissionConfig;
  derived: Derived;
  checks: ConstraintCheck[];
  simulation: MissionSimulation | null;
  maturity: MaturityAssessment;
  contributors: number;
  unverifiedContent: number;
}): Evaluation {
  const { objectives, config, derived, checks, simulation, maturity } = args;
  const results: ObjectiveResult[] = objectives.map((o) => {
    const value = metricValue(o, config, derived, checks, simulation);
    const achieved = value === null ? 0 : clamp01((value - o.zeroAt) / (o.fullAt - o.zeroAt));
    const show = (v: number): string => `${Number.isInteger(v) ? v : v.toPrecision(3)}${o.unit ? ` ${o.unit}` : ""}`;
    let feedback: string;
    if (value === null) {
      feedback = o.metric.type === "simulation" ? "Not evaluated: run the mission simulation." : o.metric.type === "derived" ? "Not achieved: the design has nothing that produces this measurement yet." : "Not evaluated.";
    } else if (o.metric.type === "instrument") {
      feedback = value ? "Instrument is on board." : "Required instrument is missing.";
    } else if (achieved >= 1) {
      feedback = `Met: ${show(value)} against a target of ${show(o.fullAt)}.`;
    } else if (achieved > 0) {
      feedback = `Partial: ${show(value)}; full credit at ${show(o.fullAt)}.`;
    } else {
      feedback = `Missed: ${show(value)}; credit starts at ${show(o.zeroAt)}.`;
    }
    return { id: o.id, title: o.title, description: o.description, category: o.category, weight: o.weight, value, unit: o.unit, target: o.fullAt, achieved, points: achieved * o.weight, feedback, ...(o.primary ? { primary: true } : {}), ...(o.stretch ? { stretch: true } : {}) };
  });

  // Stretch goals are a bonus on top of the baseline objectives, so they do not dilute them.
  const totalWeight = objectives.filter((o) => !o.stretch).reduce((s, o) => s + o.weight, 0) || 1;
  const objectivesScore = (results.reduce((s, r) => s + r.points, 0) / totalWeight) * 85;
  const categories = { science: { earned: 0, possible: 0 }, engineering: { earned: 0, possible: 0 }, programmatic: { earned: 0, possible: 0 } };
  for (const r of results) {
    categories[r.category].earned += r.points;
    if (!r.stretch) categories[r.category].possible += r.weight;
  }

  // Process rigour: how far the concept was matured, and whether it was a team effort.
  const rigor = [
    { item: "Concept maturity", earned: Math.min(4, maturity.level) * 3, possible: 12, detail: `CML ${maturity.level} (${maturity.levelName}); 3 points per level up to CML 4.` },
    { item: "Collaboration", earned: Math.min(3, args.contributors), possible: 3, detail: `${args.contributors} team member(s) contributed design changes.` },
  ];
  const rigorScore = rigor.reduce((s, r) => s + r.earned, 0);

  const penalties: Evaluation["penalties"] = [];
  const failing = checks.filter((c) => c.status === "fail");
  if (failing.length) penalties.push({ reason: `${failing.length} engineering constraint(s) violated: ${failing.map((c) => c.id).join(", ")}`, points: Math.min(20, failing.length * 6) });
  const undelivered = results.filter((r) => r.stretch && r.achieved < 1);
  if (undelivered.length) penalties.push({ reason: `${undelivered.length} stretch goal(s) the team committed to were not delivered: ${undelivered.map((r) => r.title).join(", ")}`, points: undelivered.length * 2 });
  if (args.unverifiedContent > 0) penalties.push({ reason: `${args.unverifiedContent} model-generated script(s) in the design have not been independently verified`, points: Math.min(6, args.unverifiedContent * 2) });

  const score = Math.min(100, Math.max(0, Math.round((objectivesScore + rigorScore - penalties.reduce((s, p) => s + p.points, 0)) * 10) / 10));
  const grade = score >= 90 ? "S" : score >= 78 ? "A" : score >= 62 ? "B" : score >= 45 ? "C" : "D";
  const ranked = [...results].sort((a, b) => b.points - a.points);
  return {
    outcome: missionOutcome(results, derived, checks, simulation),
    score,
    grade,
    objectivesScore: Math.round(objectivesScore * 10) / 10,
    rigorScore,
    penalties,
    categories,
    objectives: results,
    rigor,
    strengths: ranked.filter((r) => r.achieved >= 1).slice(0, 4).map((r) => `${r.title}: ${r.feedback}`),
    improvements: [
      ...results.filter((r) => r.achieved < 1).sort((a, b) => (1 - b.achieved) * b.weight - (1 - a.achieved) * a.weight).slice(0, 4).map((r) => `${r.title} (${(r.weight * (1 - r.achieved)).toFixed(1)} pts available): ${r.feedback}`),
      ...maturity.nextSteps.slice(0, 2).map((s) => `To reach CML ${maturity.level + 1}: ${s}`),
    ],
    simulated: simulation !== null,
    basis: "Deterministic: objectives are scored from the engineering models and the mission simulation with linear partial credit; rigour from recorded trade studies, simulations and reviews. The cost figures use the platform's game cost model.",
  };
}
