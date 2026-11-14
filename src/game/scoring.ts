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
}

export interface Evaluation {
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
      return config.spacecraft.components.some((c) => c.type === "instrument" && c.kind === m.kind) ? 1 : 0;
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
    return { id: o.id, title: o.title, description: o.description, category: o.category, weight: o.weight, value, unit: o.unit, target: o.fullAt, achieved, points: achieved * o.weight, feedback };
  });

  const totalWeight = objectives.reduce((s, o) => s + o.weight, 0) || 1;
  const objectivesScore = (results.reduce((s, r) => s + r.points, 0) / totalWeight) * 85;
  const categories = { science: { earned: 0, possible: 0 }, engineering: { earned: 0, possible: 0 }, programmatic: { earned: 0, possible: 0 } };
  for (const r of results) {
    categories[r.category].earned += r.points;
    categories[r.category].possible += r.weight;
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
  if (args.unverifiedContent > 0) penalties.push({ reason: `${args.unverifiedContent} model-generated script(s) in the design have not been independently verified`, points: Math.min(6, args.unverifiedContent * 2) });

  const score = Math.max(0, Math.round((objectivesScore + rigorScore - penalties.reduce((s, p) => s + p.points, 0)) * 10) / 10);
  const grade = score >= 90 ? "S" : score >= 78 ? "A" : score >= 62 ? "B" : score >= 45 ? "C" : "D";
  const ranked = [...results].sort((a, b) => b.points - a.points);
  return {
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
