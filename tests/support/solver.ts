/**
 * Test support: a design solver.
 *
 * It tries every simple move against the engineering models (add a catalogue part, remove a
 * part, change altitude or inclination, change launch vehicle, change an antenna's data rate)
 * and keeps the one that helps most, looking two moves ahead when no single move pays.
 *
 * It is deliberately NOT part of the game. The game never tells a player which part to add:
 * a mission has no single right design. The solver exists so the tests can prove two things
 * about the scenarios themselves — that each one can be finished, and that it can be finished
 * in more than one way.
 */
import { installPart, refitHarness } from "../../src/systems/graph.js";
import { applyPatches, type PatchOp } from "../../src/core/paths.js";
import type { MaturityAssessment } from "../../src/nasa/lifecycle.js";
import { BODIES } from "../../src/science/orbital.js";
import { type ConstraintCheck, engineeringChecks, recalculate } from "../../src/state/recalc.js";
import { type Component, type MissionConfig, parseMissionConfig } from "../../src/state/schema.js";
import type { CatalogItem, Objective } from "../../src/game/scenarios.js";
import { evaluateMission } from "../../src/game/scoring.js";

export interface Move {
  kind: "add" | "remove" | "altitude" | "inclination" | "vehicle" | "data_rate";
  /** Imperative, as it would read on a button. */
  label: string;
  /** Catalogue item to add (goes through the build-and-test pipeline). */
  itemId?: string;
  /** Direct parameter edit. */
  patches?: PatchOp[];
  /** One plain sentence on what this kind of move does. */
  teaches: string;
}

export interface Advice {
  move: Move | null;
  /** Set when the move itself does not pay, but makes room for this one. */
  enables?: string;
  scoreBefore: number;
  scoreAfter: number;
  failingBefore: string[];
  failingAfter: string[];
  /** Objectives whose credit changes, biggest first. */
  effects: { objective: string; from: number; to: number; points: number }[];
  /** Why nothing is suggested, when `move` is null. */
  reason?: string;
  evaluated: number;
}

const ALTITUDES: Record<string, number[]> = { moon: [30, 40, 50, 75, 100, 150, 200, 300, 400], earth: [400, 450, 500, 550, 600, 700, 800], mars: [250, 300, 350, 400, 500, 800, 1500] };
const LIMIT: Record<Component["type"], number> = { solar_panel: 5, battery: 4, antenna: 2, load: 9, instrument: 9, adcs: 1, computer: 2 };

interface State {
  config: MissionConfig;
  failing: string[];
  score: number;
  credit: Map<string, { title: string; achieved: number; points: number }>;
}

export function advise(args: { config: MissionConfig; objectives: Objective[]; catalog: CatalogItem[]; maturity: MaturityAssessment; contributors: number; /** Kinds of move the crew has ruled out (a commitment it made). */ forbid?: Move["kind"][] }): Advice {
  const { objectives, catalog, maturity, contributors } = args;
  let evaluated = 0;
  const assess = (config: MissionConfig): State => {
    evaluated++;
    const { derived } = recalculate(config);
    const checks: ConstraintCheck[] = engineeringChecks(config, derived);
    const evaluation = evaluateMission({ objectives, config, derived, checks, simulation: null, maturity, contributors, unverifiedContent: 0 });
    const noVehicle = Boolean(config.meta.massLimitKg) && !config.meta.launchVehicleId;
    return { config, failing: [...checks.filter((c) => c.status === "fail").map((c) => c.id), ...(noVehicle ? ["launch.vehicle:unselected"] : [])], score: evaluation.score, credit: new Map(evaluation.objectives.map((o) => [o.id, { title: o.title, achieved: o.achieved, points: o.points }])) };
  };
  const apply = (config: MissionConfig, move: Move): MissionConfig | null => {
    let candidate: unknown;
    try {
      if (move.itemId) {
        const item = catalog.find((i) => i.id === move.itemId)!;
        const used = new Set(config.spacecraft.components.map((c) => c.id));
        let n = 1;
        while (used.has(`adv${n}`)) n++;
        candidate = installPart(config, { ...item.component, id: `adv${n}` } as Component);
      } else {
        candidate = refitHarness(applyPatches(config as unknown, move.patches ?? []) as MissionConfig);
      }
    } catch {
      return null;
    }
    const parsed = parseMissionConfig(candidate);
    return parsed.ok ? parsed.config : null;
  };

  const moves = (config: MissionConfig): Move[] => {
    const out: Move[] = [];
    const comps = config.spacecraft.components;
    const count = (type: string): number => comps.filter((c) => c.type === type).length;
    const R = BODIES[config.centralBody].radiusKm;
    for (const item of catalog) {
      const c = item.component;
      if (count(c.type) >= LIMIT[c.type]) continue;
      // A second instrument of a kind already on board earns nothing; a second pointing unit does not combine.
      if (c.type === "instrument" && comps.some((x) => x.type === "instrument" && x.name === c.name)) continue;
      if (c.type === "adcs" && count("adcs") > 0) continue;
      if (c.type === "computer" && comps.some((x) => x.name === c.name)) continue;
      const teaches: Record<Component["type"], string> = {
        solar_panel: "More array area means more power, at the price of mass, money and build time.",
        battery: "A bigger battery is drained less deeply in each eclipse.",
        antenna: "A second downlink sends more data home, and draws power while it transmits.",
        load: "Extra equipment draws power all the time.",
        instrument: "An instrument is what earns the science; it also draws power and creates data the antenna must send home.",
        adcs: "Attitude control holds the spacecraft steady: sharper images and a tighter antenna beam.",
        computer: "An onboard computer compresses data so more science fits through the same radio link, and stores it through outages.",
      };
      out.push({ kind: "add", label: `Add ${item.label.split(" · ")[0]!.toLowerCase()}`, itemId: item.id, teaches: teaches[c.type] });
    }
    for (const c of comps) {
      if (c.type === "load") continue; // avionics and thermal control are not optional
      if (["solar_panel", "battery", "antenna"].includes(c.type) && count(c.type) <= 1) continue;
      const nodes = config.scene.nodes.filter((n) => n.componentId === c.id).map((n) => ({ op: "remove" as const, path: `scene.nodes.${n.id}` }));
      out.push({ kind: "remove", label: `Remove ${c.name.toLowerCase()}`, patches: [...nodes, { op: "remove", path: `spacecraft.components.${c.id}` }], teaches: "Every part costs mass, money and build time; one that earns no points is dead weight." });
    }
    const altitude = Math.round(config.orbit.semiMajorAxisKm - R);
    for (const a of ALTITUDES[config.centralBody] ?? []) {
      if (Math.abs(a - altitude) < 1) continue;
      out.push({ kind: "altitude", label: `Set altitude to ${a} km`, patches: [{ op: "set", path: "orbit.semiMajorAxisKm", value: R + a }], teaches: a < altitude ? "Flying lower sharpens every measurement, but the spacecraft spends more of each orbit in shadow." : "Flying higher shortens eclipses and lengthens radio contacts, at the price of coarser measurements." });
    }
    for (const inc of [90, 97.6, 51]) {
      if (Math.abs(config.orbit.inclinationDeg - inc) < 0.5) continue;
      out.push({ kind: "inclination", label: `Set inclination to ${inc}°`, patches: [{ op: "set", path: "orbit.inclinationDeg", value: inc }], teaches: "Inclination decides which latitudes are ever flown over; around Earth it also changes how much a launch vehicle can lift." });
    }
    for (const id of ["rideshare", "dedicated", "heavy"]) {
      if (config.meta.launchVehicleId === id || !config.meta.massLimitKg) continue;
      out.push({ kind: "vehicle", label: `Launch on the ${{ rideshare: "rideshare slot", dedicated: "dedicated small launcher", heavy: "heavy launcher" }[id]}`, patches: [{ op: "set", path: "meta.launchVehicleId", value: id }], teaches: "A bigger launch vehicle lifts more and costs more; the cheapest one that fits leaves the most budget for science." });
    }
    for (const a of comps) {
      if (a.type !== "antenna") continue;
      out.push({ kind: "data_rate", label: `Halve the data rate of ${a.name}`, patches: [{ op: "set", path: `spacecraft.components.${a.id}.dataRateBps`, value: a.dataRateBps / 2 }], teaches: "Sending slower puts more energy into each bit: half the rate gains 3 dB of link margin." });
      out.push({ kind: "data_rate", label: `Double the data rate of ${a.name}`, patches: [{ op: "set", path: `spacecraft.components.${a.id}.dataRateBps`, value: a.dataRateBps * 2 }], teaches: "Sending faster returns more data, and spends 3 dB of link margin to do it." });
    }
    return args.forbid?.length ? out.filter((m) => !args.forbid!.includes(m.kind)) : out;
  };

  const better = (a: State, b: State): boolean => a.failing.length < b.failing.length || (a.failing.length === b.failing.length && a.score > b.score + 0.049);
  const base = assess(args.config);
  const firsts = moves(base.config).map((move) => ({ move, config: apply(base.config, move) })).filter((x): x is { move: Move; config: MissionConfig } => x.config !== null).map((x) => ({ ...x, state: assess(x.config) }));

  let best: { move: Move; state: State; enables?: string } | null = null;
  for (const f of firsts) if (better(f.state, best?.state ?? base)) best = { move: f.move, state: f.state };

  if (!best) {
    // Two moves ahead: something that does not pay by itself may make room for something that does.
    for (const f of firsts) {
      // Only pairs that end with a part being added or the orbit changing are worth the search.
      for (const second of moves(f.config)) {
        if (second.kind !== "add" && second.kind !== "altitude") continue;
        const config = apply(f.config, second);
        if (!config) continue;
        const state = assess(config);
        if (better(state, best?.state ?? base)) best = { move: f.move, state, enables: second.label };
      }
    }
  }

  const effects = best
    ? [...best.state.credit].map(([id, after]) => ({ objective: after.title, from: base.credit.get(id)?.achieved ?? 0, to: after.achieved, points: after.points - (base.credit.get(id)?.points ?? 0) })).filter((e) => Math.abs(e.points) > 0.05).sort((a, b) => Math.abs(b.points) - Math.abs(a.points)).slice(0, 4)
    : [];
  return {
    move: best?.move ?? null,
    ...(best?.enables ? { enables: best.enables } : {}),
    scoreBefore: base.score,
    scoreAfter: best?.state.score ?? base.score,
    failingBefore: base.failing,
    failingAfter: best?.state.failing ?? base.failing,
    effects,
    ...(best ? {} : { reason: base.failing.length ? "No single change or pair of changes removes the violated limit." : "No single change or pair of changes scores higher: the design is at a local best for this mission." }),
    evaluated,
  };
}

/** Apply a move to a configuration (used by tests and offline play-throughs). */
export function applyMove(config: MissionConfig, move: Move, catalog: CatalogItem[]): MissionConfig {
  if (move.itemId) {
    const item = catalog.find((i) => i.id === move.itemId);
    if (!item) throw new Error(`Unknown catalogue item "${move.itemId}"`);
    const used = new Set(config.spacecraft.components.map((c) => c.id));
    let n = 1;
    while (used.has(`adv${n}`)) n++;
    const parsed = parseMissionConfig(installPart(config, { ...item.component, id: `adv${n}` } as Component));
    if (!parsed.ok) throw new Error(parsed.issues.join("; "));
    return parsed.config;
  }
  const parsed = parseMissionConfig(refitHarness(applyPatches(config as unknown, move.patches ?? []) as MissionConfig));
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.config;
}
