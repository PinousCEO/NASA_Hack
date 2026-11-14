/**
 * Dependency-aware scientific recalculation.
 *
 * Every derived quantity is a node that declares which config paths and which other
 * nodes it depends on. When the config changes, only nodes downstream of the changed
 * paths are recomputed; everything else is carried over from the previous version.
 * Clients receive the config AND these derived results — never visuals alone.
 */
import { diff, pathsOverlap } from "../core/paths.js";
import type { VerificationLevel } from "../core/types.js";
import { dishGainDbi, linkBudget, slantRangeKm } from "../science/comms.js";
import { sunState } from "../science/ephemeris.js";
import { BODIES, orbitElements, positionAtTrueAnomaly, trueAnomalyAt } from "../science/orbital.js";
import { betaAngle, eclipseFraction, powerBudget, solarFluxWM2, type SolarPanelSpec } from "../science/power.js";
import { roverMobility, type RoverMobilityInput } from "../science/rover.js";
import type { Component, MissionConfig } from "./schema.js";

export interface DerivedValue {
  value: Record<string, unknown> | null;
  assumptions: string[];
  verification: VerificationLevel;
  /** Set when the node could not be computed for this configuration. */
  error?: string;
}

export type Derived = Record<string, DerivedValue>;

interface DerivedNode {
  id: string;
  description: string;
  configDeps: string[];
  derivedDeps: string[];
  compute(config: MissionConfig, derived: Derived): { value: Record<string, unknown> | null; assumptions?: string[] };
}

const need = <T>(derived: Derived, id: string): T => {
  const node = derived[id];
  if (!node || node.value === null) throw new Error(`depends on "${id}", which is unavailable${node?.error ? `: ${node.error}` : ""}`);
  return node.value as T;
};

const orbitInput = (c: MissionConfig) => ({ body: c.centralBody, ...c.orbit });

export function powerInputsFromComponents(components: Component[]): {
  panels: SolarPanelSpec[];
  loads: { name: string; powerW: number; dutyCycle: number }[];
  batteryCapacityWh: number;
  batteryMaxDepthOfDischarge: number;
} {
  const panels = components.filter((c) => c.type === "solar_panel");
  const batteries = components.filter((c) => c.type === "battery");
  const loads = components.flatMap((c) => {
    if (c.type === "load") return [{ name: c.name, powerW: c.powerW, dutyCycle: c.dutyCycle }];
    if (c.type === "antenna") return [{ name: c.name, powerW: c.dcPowerW, dutyCycle: c.dutyCycle }];
    return [];
  });
  return {
    panels,
    loads,
    batteryCapacityWh: batteries.reduce((s, b) => s + b.capacityWh, 0),
    // The most restrictive battery governs the allowable depth of discharge.
    batteryMaxDepthOfDischarge: batteries.length ? Math.min(...batteries.map((b) => b.maxDepthOfDischarge)) : 0,
  };
}

export function roverMobilityInput(r: NonNullable<MissionConfig["rover"]>): RoverMobilityInput {
  return {
    totalMassKg: r.chassisMassKg + r.wheelCount * r.wheelMassKg + r.components.reduce((s, x) => s + x.massKg, 0),
    gravityMS2: BODIES[r.site.body].surfaceGravityMS2,
    wheelCount: r.wheelCount,
    wheelRadiusM: r.wheelRadiusM,
    wheelTorqueNm: r.wheelTorqueNm,
    tractionCoefficient: r.site.tractionCoefficient,
    rollingResistanceCoefficient: r.site.rollingResistanceCoefficient,
    supportHalfSpanM: r.supportHalfSpanM,
    centerOfMassHeightM: r.centerOfMassHeightM,
    speedMS: r.speedMS,
    drivetrainEfficiency: r.drivetrainEfficiency,
    siteSlopeDeg: r.site.slopeDeg,
  };
}

export const DERIVED_NODES: DerivedNode[] = [
  {
    id: "ephemeris.sun",
    description: "Sun direction/distance and Earth range for the central body at mission time",
    configDeps: ["missionTime", "centralBody"],
    derivedDeps: [],
    compute: (c) => {
      const { assumptions, ...value } = sunState(c.centralBody, c.missionTime);
      return { value, assumptions };
    },
  },
  {
    id: "scene.lighting",
    description: "Directional light for the shared scene, driven by the Sun ephemeris",
    configDeps: [],
    derivedDeps: ["ephemeris.sun"],
    compute: (_c, d) => {
      const sun = need<{ distanceAu: number; directionEquatorial: number[]; directionEcliptic: number[] }>(d, "ephemeris.sun");
      return {
        value: {
          sunDirection: sun.directionEquatorial,
          solarFluxWM2: solarFluxWM2(sun.distanceAu),
          relativeIntensity: 1 / sun.distanceAu ** 2,
        },
        assumptions: ["Light direction given in the J2000 Earth-equatorial frame"],
      };
    },
  },
  {
    id: "orbit.elements",
    description: "Period, apsides and velocities of the spacecraft orbit",
    configDeps: ["orbit.semiMajorAxisKm", "orbit.eccentricity", "centralBody"],
    derivedDeps: [],
    compute: (c) => ({ value: { ...orbitElements(orbitInput(c)) } }),
  },
  {
    id: "orbit.trajectory",
    description: "Sampled orbit path and current spacecraft position (body-centred inertial frame)",
    configDeps: ["orbit", "centralBody", "missionTime"],
    derivedDeps: [],
    compute: (c) => {
      const orbit = orbitInput(c);
      const nu = trueAnomalyAt(orbit, c.missionTime);
      const path = Array.from({ length: 73 }, (_, k) => positionAtTrueAnomaly(orbit, (k / 72) * 2 * Math.PI));
      return {
        value: { currentTrueAnomalyDeg: (nu * 180) / Math.PI, currentPositionKm: positionAtTrueAnomaly(orbit, nu), pathKm: path },
        assumptions: ["Two-body propagation from the orbit epoch (no J2, drag or third-body perturbations)"],
      };
    },
  },
  {
    id: "orbit.eclipse",
    description: "Solar beta angle and eclipse fraction",
    configDeps: ["orbit.semiMajorAxisKm", "orbit.inclinationDeg", "orbit.raanDeg", "centralBody"],
    derivedDeps: ["ephemeris.sun", "orbit.elements"],
    compute: (c, d) => {
      const sun = need<{ directionEquatorial: [number, number, number]; directionEcliptic: [number, number, number] }>(d, "ephemeris.sun");
      const el = need<{ periodS: number }>(d, "orbit.elements");
      const beta = betaAngle(c.centralBody, c.orbit.inclinationDeg, c.orbit.raanDeg, sun);
      const fraction = eclipseFraction(c.centralBody, c.orbit.semiMajorAxisKm, beta.betaDeg);
      return {
        value: { betaDeg: beta.betaDeg, eclipseFraction: fraction, eclipseDurationS: fraction * el.periodS },
        assumptions: [
          ...beta.assumptions,
          "Cylindrical umbra; orbit treated as circular at the semi-major axis radius",
          "RAAN held at its configured value (no nodal precession)",
        ],
      };
    },
  },
  {
    id: "mass.budget",
    description: "Spacecraft mass roll-up",
    configDeps: ["spacecraft", "meta.massLimitKg"],
    derivedDeps: [],
    compute: (c) => {
      const componentMassKg = c.spacecraft.components.reduce((s, x) => s + x.massKg, 0);
      const total = c.spacecraft.busDryMassKg + componentMassKg;
      return {
        value: {
          busDryMassKg: c.spacecraft.busDryMassKg,
          componentMassKg,
          totalMassKg: total,
          massLimitKg: c.meta.massLimitKg ?? null,
          marginKg: c.meta.massLimitKg !== undefined ? c.meta.massLimitKg - total : null,
        },
      };
    },
  },
  {
    id: "power.budget",
    description: "Orbit-average power generation, load and battery depth of discharge",
    configDeps: ["spacecraft.components", "meta.yearsInService"],
    derivedDeps: ["ephemeris.sun", "orbit.eclipse", "orbit.elements"],
    compute: (c, d) => {
      const sun = need<{ distanceAu: number }>(d, "ephemeris.sun");
      const eclipse = need<{ eclipseFraction: number }>(d, "orbit.eclipse");
      const el = need<{ periodS: number }>(d, "orbit.elements");
      const result = powerBudget({
        ...powerInputsFromComponents(c.spacecraft.components),
        sunDistanceAu: sun.distanceAu,
        eclipseFraction: eclipse.eclipseFraction,
        orbitPeriodS: el.periodS,
        yearsInService: c.meta.yearsInService,
      });
      return { value: { ...result }, assumptions: ["Loads applied at their duty-cycle average", "No power conversion losses modelled"] };
    },
  },
  {
    id: "comms.link",
    description: "Downlink budget from each spacecraft antenna to the ground station",
    configDeps: ["spacecraft.components", "groundStation", "orbit.semiMajorAxisKm", "orbit.eccentricity", "centralBody"],
    derivedDeps: ["ephemeris.sun", "orbit.elements"],
    compute: (c, d) => {
      const sun = need<{ earthToBodyDistanceKm: number }>(d, "ephemeris.sun");
      const el = need<{ apoapsisRadiusKm: number }>(d, "orbit.elements");
      const assumptions: string[] = [];
      let rangeKm: number;
      if (c.centralBody === "earth") {
        rangeKm = slantRangeKm(BODIES.earth.radiusKm, el.apoapsisRadiusKm, c.groundStation.minElevationDeg);
        assumptions.push("Worst-case slant range: apoapsis at the station's minimum elevation");
      } else {
        rangeKm = sun.earthToBodyDistanceKm + el.apoapsisRadiusKm;
        assumptions.push("Range = Earth–body distance plus orbit apoapsis radius (worst case)");
      }
      const links = c.spacecraft.components
        .filter((x) => x.type === "antenna")
        .map((a) => {
          const txGainDbi = a.gainDbi ?? dishGainDbi(a.diameterM!, a.frequencyGHz);
          const budget = linkBudget({
            frequencyGHz: a.frequencyGHz,
            txPowerW: a.txPowerW,
            txGainDbi,
            rxGainDbi: c.groundStation.antennaGainDbi,
            rxSystemNoiseTempK: c.groundStation.systemNoiseTempK,
            rangeKm,
            dataRateBps: a.dataRateBps,
            otherLossesDb: a.otherLossesDb,
            requiredEbN0Db: a.requiredEbN0Db,
          });
          return { antennaId: a.id, txGainDbi, ...budget };
        });
      return {
        value: { rangeKm, links, worstMarginDb: links.length ? Math.min(...links.map((l) => l.marginDb)) : null },
        assumptions: [...assumptions, "Ground-station gain is taken at the antenna's frequency as configured"],
      };
    },
  },
  {
    id: "rover.performance",
    description: "Rover mass, slope capability and drive power at its site",
    configDeps: ["rover"],
    derivedDeps: [],
    compute: (c) => {
      if (!c.rover) return { value: null, assumptions: ["No rover in this mission"] };
      const r = c.rover;
      const mobilityInput = roverMobilityInput(r);
      const totalMassKg = mobilityInput.totalMassKg;
      const mobility = roverMobility(mobilityInput);
      const power = powerInputsFromComponents(r.components);
      const hotelLoadW = power.loads.reduce((s, l) => s + l.powerW * l.dutyCycle, 0);
      const totalDrivingPowerW = hotelLoadW + mobility.drivePowerW;
      return {
        value: {
          totalMassKg,
          ...mobility,
          hotelLoadW,
          totalDrivingPowerW,
          drivingEnduranceH:
            power.batteryCapacityWh > 0
              ? (power.batteryCapacityWh * power.batteryMaxDepthOfDischarge) / totalDrivingPowerW
              : null,
        },
        assumptions: [
          "Rigid-wheel statics; soil sinkage and slip are not modelled",
          "Traction and rolling-resistance coefficients are site inputs, not derived from soil data",
        ],
      };
    },
  },
];

export interface RecalcResult {
  derived: Derived;
  recalculated: string[];
  reused: string[];
  changedPaths: string[];
}

/** Topological order of the node list (nodes are validated to form a DAG at module load). */
function topoOrder(nodes: DerivedNode[]): DerivedNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const out: DerivedNode[] = [];
  const visit = (n: DerivedNode, stack: string[]): void => {
    if (done.has(n.id)) return;
    if (stack.includes(n.id)) throw new Error(`Cycle in derived graph: ${[...stack, n.id].join(" -> ")}`);
    for (const dep of n.derivedDeps) {
      const d = byId.get(dep);
      if (!d) throw new Error(`Derived node "${n.id}" depends on unknown node "${dep}"`);
      visit(d, [...stack, n.id]);
    }
    done.add(n.id);
    out.push(n);
  };
  for (const n of nodes) visit(n, []);
  return out;
}

const ORDERED = topoOrder(DERIVED_NODES);

export function recalculate(config: MissionConfig, previous?: { config: MissionConfig; derived: Derived }): RecalcResult {
  const changedPaths = previous ? diff(previous.config, config).map((d) => d.path) : [];
  const dirty = new Set<string>();
  const derived: Derived = {};
  for (const node of ORDERED) {
    const prev = previous?.derived[node.id];
    const isDirty =
      !prev ||
      node.configDeps.some((dep) => changedPaths.some((p) => pathsOverlap(p, dep))) ||
      node.derivedDeps.some((dep) => dirty.has(dep));
    if (!isDirty) {
      derived[node.id] = prev;
      continue;
    }
    dirty.add(node.id);
    try {
      const out = node.compute(config, derived);
      derived[node.id] = { value: out.value, assumptions: out.assumptions ?? [], verification: "deterministic_calculation" };
    } catch (err) {
      derived[node.id] = {
        value: null,
        assumptions: [],
        verification: "unverified",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return {
    derived,
    recalculated: ORDERED.filter((n) => dirty.has(n.id)).map((n) => n.id),
    reused: ORDERED.filter((n) => !dirty.has(n.id)).map((n) => n.id),
    changedPaths,
  };
}

export interface ConstraintCheck {
  id: string;
  description: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

/** Engineering constraint checks evaluated on derived results. Deterministic. */
export function engineeringChecks(config: MissionConfig, derived: Derived): ConstraintCheck[] {
  const checks: ConstraintCheck[] = [];
  const add = (id: string, description: string, status: ConstraintCheck["status"], detail: string): void => {
    checks.push({ id, description, status, detail });
  };
  for (const [nodeId, node] of Object.entries(derived)) {
    if (node.error) add(`derived.${nodeId}`, `Derived node ${nodeId} computes`, "fail", node.error);
  }
  const el = derived["orbit.elements"]?.value as { intersectsSurface: boolean; belowSafeAltitude: boolean; periapsisAltitudeKm: number } | null | undefined;
  if (el) {
    add(
      "orbit.periapsis",
      "Orbit periapsis is above the surface and the minimum safe altitude",
      el.intersectsSurface ? "fail" : el.belowSafeAltitude ? "warn" : "pass",
      `periapsis altitude ${el.periapsisAltitudeKm.toFixed(1)} km (minimum safe ${BODIES[config.centralBody].minSafeAltitudeKm} km)`,
    );
  }
  const mass = derived["mass.budget"]?.value as { marginKg: number | null; totalMassKg: number } | null | undefined;
  if (mass && mass.marginKg !== null) {
    add("mass.limit", "Total mass within the launch mass allocation", mass.marginKg >= 0 ? "pass" : "fail", `total ${mass.totalMassKg.toFixed(2)} kg, margin ${mass.marginKg.toFixed(2)} kg`);
  }
  const power = derived["power.budget"]?.value as { marginW: number; depthOfDischarge: number | null; batteryAdequate: boolean } | null | undefined;
  if (power) {
    add("power.margin", "Orbit-average generation covers the average load", power.marginW >= 0 ? "pass" : "fail", `margin ${power.marginW.toFixed(2)} W`);
    add(
      "power.battery",
      "Battery covers eclipse within its depth-of-discharge limit",
      power.batteryAdequate ? "pass" : "fail",
      power.depthOfDischarge === null ? "no battery installed" : `eclipse depth of discharge ${(power.depthOfDischarge * 100).toFixed(1)}%`,
    );
  }
  const comms = derived["comms.link"]?.value as { worstMarginDb: number | null } | null | undefined;
  if (comms && comms.worstMarginDb !== null) {
    add(
      "comms.margin",
      "Downlink closes with at least 3 dB margin",
      comms.worstMarginDb < 0 ? "fail" : comms.worstMarginDb < 3 ? "warn" : "pass",
      `worst link margin ${comms.worstMarginDb.toFixed(2)} dB`,
    );
  }
  const rover = derived["rover.performance"]?.value as { canTraverseSite: boolean; slopeMarginDeg: number; limitingFactor: string } | null | undefined;
  if (rover) {
    add(
      "rover.slope",
      "Rover can climb the slope at its site",
      !rover.canTraverseSite ? "fail" : rover.slopeMarginDeg < 5 ? "warn" : "pass",
      `slope margin ${rover.slopeMarginDeg.toFixed(1)}° (limited by ${rover.limitingFactor})`,
    );
  }
  return checks;
}
