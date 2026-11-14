/**
 * NASA systems-engineering reference data used by the game flow, and a rule-based
 * assessment of a mission concept's maturity.
 *
 * Sources: NASA Systems Engineering Handbook (SP-2016-6105 Rev 2) and NPR 7120.5 for the
 * life cycle; Wessen et al., "Space Mission Concept Development Using Concept Maturity
 * Levels" (JPL) for CMLs; GSFC Mission Design Lab for the discipline seats.
 * The maturity assessment applies this platform's own checkable criteria — it is a
 * teaching aid, not a formal NASA or JPL review.
 */
import type { ConstraintCheck, Derived } from "../state/recalc.js";
import type { MissionConfig } from "../state/schema.js";

export const LIFE_CYCLE_PHASES = [
  { id: "pre-A", name: "Pre-Phase A: Concept Studies", purpose: "Produce a broad spectrum of ideas and alternatives for missions.", review: "MCR — Mission Concept Review" },
  { id: "A", name: "Phase A: Concept and Technology Development", purpose: "Determine feasibility and desirability; establish an initial baseline.", review: "SRR / MDR — System Requirements and Mission Definition Reviews" },
  { id: "B", name: "Phase B: Preliminary Design and Technology Completion", purpose: "Define the project in enough detail to establish a baseline that meets mission needs.", review: "PDR — Preliminary Design Review" },
  { id: "C", name: "Phase C: Final Design and Fabrication", purpose: "Complete the detailed design; fabricate hardware and code software.", review: "CDR — Critical Design Review" },
  { id: "D", name: "Phase D: System Assembly, Integration and Test, Launch", purpose: "Assemble and integrate the system, verify it, launch and check out.", review: "ORR / FRR — Operational and Flight Readiness Reviews" },
  { id: "E", name: "Phase E: Operations and Sustainment", purpose: "Conduct the mission and meet the identified need.", review: "PLAR / CERR — Post-Launch Assessment Review" },
  { id: "F", name: "Phase F: Closeout", purpose: "Decommission and analyse returned data and samples.", review: "DR — Decommissioning Review" },
] as const;

/** The four segments of a science mission (NASA Small Spacecraft Systems Engineering webinar series). */
export const MISSION_SEGMENTS = [
  { id: "launch", name: "Launch segment", description: "Launch vehicle and related services used to get the spacecraft to its destination." },
  { id: "space", name: "Space segment", description: "Spacecraft and its components: orbiters, landers, rovers and their instruments." },
  { id: "ground", name: "Ground segment", description: "Ground stations and mission control centres that communicate with the space segment." },
  { id: "user", name: "User segment", description: "Scientists and the public who use the data the mission collects." },
] as const;

export const CONCEPT_MATURITY_LEVELS = [
  { level: 1, name: "Cocktail Napkin", definition: "The science questions are articulated, the type of observations needed is proposed, and a rudimentary sketch of the concept and its high-level objectives exists." },
  { level: 2, name: "Initial Feasibility", definition: "The idea is questioned on feasibility from science, technical and programmatic viewpoints. Key performance parameters are quantified and basic calculations determine, to first order, the viability of the concept." },
  { level: 3, name: "Trade Space", definition: "Exploration has been done around the science objectives and architectural trades to understand the relationship between science return, cost and risk." },
  { level: 4, name: "Point Design", definition: "A specific design and cost that returns the desired science has been selected within the trade space and defined down to major subsystems, with acceptable margins and reserves." },
  { level: 5, name: "Baseline Concept", definition: "The implementation approach has been defined, including partners, integration and test approach, cost and schedule. The level needed for a Step 1 proposal or a Mission Concept Review." },
  { level: 6, name: "Integrated Concept", definition: "Expanded details on technical, management, cost and other elements have been defined and documented." },
  { level: 7, name: "Preliminary Implementation Baseline", definition: "Preliminary requirements and analyses, demonstrated margins and reserves, prototyping, risk assessments and mitigation plans are complete." },
  { level: 8, name: "PDR (Integrated Baseline)", definition: "Design and planning commensurate with a Preliminary Design Review." },
  { level: 9, name: "CDR", definition: "Design and planning commensurate with a Critical Design Review." },
] as const;

/** Discipline seats, modelled on a concurrent-engineering design lab. */
export const DISCIPLINES = [
  { id: "systems", name: "Mission Systems", owns: ["meta", "missionTime"], description: "Requirements, margins, mass and cost roll-up, review readiness." },
  { id: "flight_dynamics", name: "Flight Dynamics", owns: ["orbit"], description: "Orbit selection, eclipse geometry, coverage and delta-v." },
  { id: "power", name: "Electrical Power", owns: ["solar_panel", "battery"], description: "Array sizing, battery depth of discharge, power margin." },
  { id: "communications", name: "Communications", owns: ["antenna", "groundStation"], description: "Link budget, data rate and downlink capacity." },
  { id: "payload", name: "Science Payload", owns: ["instrument"], description: "Instrument selection, data volume and science return." },
  { id: "surface", name: "Surface Mobility", owns: ["rover"], description: "Rover mass, traction, slope capability and drive energy." },
] as const;
export type DisciplineId = (typeof DISCIPLINES)[number]["id"];

/** Margin thresholds this platform treats as "acceptable" for a point design. */
export const POINT_DESIGN_MARGINS = { massFraction: 0.1, powerFraction: 0.1, linkDb: 3, costFraction: 0 } as const;

export interface MaturityEvidence {
  objectivesDefined: number;
  tradeStudies: number;
  tradeParameters: number;
  simulationsRun: number;
  risksRecorded: number;
  reviewsHeld: number;
}

export interface MaturityCriterion {
  level: number;
  id: string;
  description: string;
  met: boolean;
  evidence: string;
}

export interface MaturityAssessment {
  /** Highest level whose criteria (and all lower levels') are met. 0 if none. */
  level: number;
  levelName: string;
  /** Highest level this platform can assess from its own records. */
  assessableUpTo: number;
  criteria: MaturityCriterion[];
  nextSteps: string[];
  basis: string;
}

export function assessConceptMaturity(config: MissionConfig, derived: Derived, checks: ConstraintCheck[], evidence: MaturityEvidence): MaturityAssessment {
  const value = <T>(id: string): T | null => (derived[id]?.value as T | null | undefined) ?? null;
  const types = new Set(config.spacecraft.components.map((c) => c.type));
  const failing = checks.filter((c) => c.status === "fail");
  const mass = value<{ marginFraction: number | null }>("mass.budget");
  const power = value<{ marginFraction: number | null }>("power.budget");
  const comms = value<{ worstMarginDb: number | null }>("comms.link");
  const cost = value<{ marginMusd: number | null }>("cost.budget");
  const errors = Object.entries(derived).filter(([, n]) => n.error).map(([id]) => id);
  const marginsOk =
    (mass?.marginFraction ?? 1) >= POINT_DESIGN_MARGINS.massFraction &&
    (power?.marginFraction ?? -1) >= POINT_DESIGN_MARGINS.powerFraction &&
    (comms?.worstMarginDb ?? -1) >= POINT_DESIGN_MARGINS.linkDb &&
    (cost?.marginMusd ?? 0) >= 0;

  const criteria: MaturityCriterion[] = [
    { level: 1, id: "objectives", description: "Science questions and mission objectives are stated", met: evidence.objectivesDefined > 0, evidence: `${evidence.objectivesDefined} objective(s) defined for this mission` },
    { level: 1, id: "sketch", description: "A rudimentary mission concept exists (destination, orbit, spacecraft)", met: true, evidence: `${config.centralBody} mission, ${config.spacecraft.components.length} spacecraft component(s)` },
    { level: 2, id: "calculations", description: "Key performance parameters are quantified by first-order calculations", met: errors.length === 0, evidence: errors.length ? `Models failing to compute: ${errors.join(", ")}` : `${Object.keys(derived).length} engineering models computed` },
    { level: 2, id: "viable", description: "The concept is viable to first order (orbit, power and link close)", met: !failing.some((c) => ["orbit.periapsis", "power.margin", "comms.margin"].includes(c.id)), evidence: failing.length ? `Failing: ${failing.map((c) => c.id).join(", ")}` : "Orbit, power and link checks pass" },
    { level: 3, id: "trades", description: "The trade space has been explored (at least two trade studies on different parameters)", met: evidence.tradeStudies >= 2 && evidence.tradeParameters >= 2, evidence: `${evidence.tradeStudies} trade study(ies) over ${evidence.tradeParameters} parameter(s)` },
    { level: 4, id: "subsystems", description: "The design is defined down to major subsystems (power generation, storage, communications, payload)", met: ["solar_panel", "battery", "antenna", "instrument"].every((t) => types.has(t as never)), evidence: `Subsystem types present: ${[...types].join(", ") || "none"}` },
    { level: 4, id: "margins", description: `Acceptable margins: mass ≥ ${POINT_DESIGN_MARGINS.massFraction * 100}%, power ≥ ${POINT_DESIGN_MARGINS.powerFraction * 100}%, link ≥ ${POINT_DESIGN_MARGINS.linkDb} dB, cost within budget`, met: marginsOk && failing.length === 0, evidence: `mass ${fmtPct(mass?.marginFraction)}, power ${fmtPct(power?.marginFraction)}, link ${comms?.worstMarginDb?.toFixed(1) ?? "n/a"} dB, cost margin ${cost?.marginMusd?.toFixed(1) ?? "n/a"} $M; ${failing.length} failing check(s)` },
    { level: 4, id: "simulated", description: "The point design has been simulated over the mission duration", met: evidence.simulationsRun > 0, evidence: `${evidence.simulationsRun} mission simulation(s) run` },
    { level: 5, id: "risks", description: "Risks are identified with mitigations (at least three recorded)", met: evidence.risksRecorded >= 3, evidence: `${evidence.risksRecorded} risk/problem record(s)` },
    { level: 5, id: "review", description: "A concept review has been held by the team", met: evidence.reviewsHeld > 0, evidence: `${evidence.reviewsHeld} review record(s)` },
  ];
  let level = 0;
  for (let l = 1; l <= 5; l++) {
    if (criteria.filter((c) => c.level === l).every((c) => c.met)) level = l;
    else break;
  }
  return {
    level,
    levelName: level ? CONCEPT_MATURITY_LEVELS[level - 1]!.name : "Not yet at CML 1",
    assessableUpTo: 5,
    criteria,
    nextSteps: criteria.filter((c) => c.level === level + 1 && !c.met).map((c) => c.description),
    basis: "Rule-based check of this platform's records against CML definitions (Wessen et al., JPL). CML 6–9 require project artefacts outside the platform and are not assessed.",
  };
}

const fmtPct = (v: number | null | undefined): string => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(0)}%`);
