/**
 * Dependency-aware scientific recalculation.
 *
 * Every derived quantity is a node that declares which config paths and which other
 * nodes it depends on. When the config changes, only nodes downstream of the changed
 * paths are recomputed; everything else is carried over from the previous version.
 * Clients receive the config AND these derived results — never visuals alone.
 */
import { DELIVERY_PER_KG, launchOptions } from "../game/launch.js";
import { diff, pathsOverlap } from "../core/paths.js";
import type { VerificationLevel } from "../core/types.js";
import { dishGainDbi, linkBudget, slantRangeKm } from "../science/comms.js";
import { sunState } from "../science/ephemeris.js";
import { BODIES, orbitElements, positionAtTrueAnomaly, trueAnomalyAt } from "../science/orbital.js";
import { betaAngle, eclipseFraction, powerBudget, solarFluxWM2, type SolarPanelSpec } from "../science/power.js";
import { roverMobility, type RoverMobilityInput } from "../science/rover.js";
import "../systems/controller.js";
import { analyse, effectiveMission, type Wiring } from "../systems/graph.js";
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
  /** Evidence level of this node's output; defaults to a deterministic calculation. */
  verification?: VerificationLevel;
  /** True for nodes that count the parts as built (mass, cost, schedule); the others see the parts as they operate through their wiring. */
  asBuilt?: boolean;
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
    if (c.type === "load" || c.type === "instrument" || c.type === "adcs" || c.type === "computer") return [{ name: c.name, powerW: c.powerW, dutyCycle: c.dutyCycle }];
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

/** Pointing of a bus with no dedicated attitude-control unit: sun sensors and coarse actuators. */
export const BASELINE_POINTING = { accuracyDeg: 0.3, stabilityArcsec: 20 };
const ARCSEC = Math.PI / 648000;

/** Default development lead time by component type, months (game schedule model). */
const LEAD_MONTHS: Record<Component["type"], number> = { solar_panel: 4, battery: 3, antenna: 5, load: 2, instrument: 9, adcs: 6, computer: 5 };
/** Small, catalogue-class parts (under 2 kg) take half the time. */
export const leadMonths = (c: Component): number => c.leadTimeMonths ?? LEAD_MONTHS[c.type] * (c.massKg < 2 ? 0.5 : 1);

export const DERIVED_NODES: DerivedNode[] = [
  {
    id: "systems.wiring",
    description: "What flows through the spacecraft's power, data and control lines, and which parts are held back by them",
    configDeps: ["spacecraft.components", "systems"],
    derivedDeps: [],
    asBuilt: true,
    compute: (c) => ({
      value: { ...analyse(c) },
      assumptions: c.systems?.wired
        ? ["Power is distributed as a star through the bus; line losses and voltage are not modelled", "A part behind an undersized line runs the matching share of the time", "Line mass is a rule-of-thumb harness figure by rating and length", "A rover's parts are treated as connected"]
        : ["This mission is not wired: every part is treated as connected"],
    }),
  },
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
    id: "adcs.pointing",
    description: "Pointing accuracy and stability from the attitude control system",
    configDeps: ["spacecraft.components"],
    derivedDeps: [],
    compute: (c) => {
      const units = c.spacecraft.components.filter((x) => x.type === "adcs");
      const best = units.length ? units.reduce((a, b) => (b.stabilityArcsec < a.stabilityArcsec ? b : a)) : null;
      return {
        value: {
          accuracyDeg: units.length ? Math.min(...units.map((u) => u.pointingAccuracyDeg)) : BASELINE_POINTING.accuracyDeg,
          stabilityArcsec: best?.stabilityArcsec ?? BASELINE_POINTING.stabilityArcsec,
          source: best?.name ?? "Bus baseline (coarse sensors)",
          dedicatedUnit: units.length > 0,
        },
        assumptions: ["Without a dedicated attitude-control unit the bus points to 0.3° and holds 20 arcsec", "The best installed unit governs; units do not combine"],
      };
    },
  },
  {
    id: "mass.budget",
    description: "Spacecraft mass roll-up",
    configDeps: ["spacecraft", "meta.massLimitKg", "systems"],
    derivedDeps: ["systems.wiring"],
    asBuilt: true,
    compute: (c, d) => {
      const componentMassKg = c.spacecraft.components.reduce((s, x) => s + x.massKg, 0);
      const harnessMassKg = (d["systems.wiring"]?.value as Wiring | null | undefined)?.harnessMassKg ?? 0;
      const total = c.spacecraft.busDryMassKg + componentMassKg + harnessMassKg;
      return {
        value: {
          busDryMassKg: c.spacecraft.busDryMassKg,
          componentMassKg,
          harnessMassKg,
          totalMassKg: total,
          massLimitKg: c.meta.massLimitKg ?? null,
          marginKg: c.meta.massLimitKg !== undefined ? c.meta.massLimitKg - total : null,
          marginFraction: c.meta.massLimitKg !== undefined ? (c.meta.massLimitKg - total) / c.meta.massLimitKg : null,
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
      return { value: { ...result, marginFraction: result.averageLoadW > 0 ? result.marginW / result.averageLoadW : null }, assumptions: ["Loads applied at their duty-cycle average", "No power conversion losses modelled"] };
    },
  },
  {
    id: "comms.link",
    description: "Downlink budget from each spacecraft antenna to the ground station",
    configDeps: ["spacecraft.components", "groundStation", "orbit.semiMajorAxisKm", "orbit.eccentricity", "centralBody"],
    derivedDeps: ["ephemeris.sun", "orbit.elements", "adcs.pointing"],
    compute: (c, d) => {
      const sun = need<{ earthToBodyDistanceKm: number }>(d, "ephemeris.sun");
      const el = need<{ apoapsisRadiusKm: number }>(d, "orbit.elements");
      const pointing = need<{ accuracyDeg: number }>(d, "adcs.pointing");
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
          // A dish has a narrow beam: half-power beamwidth ≈ 70 λ/D degrees, loss = 12 (error / beamwidth)² dB.
          const beamwidthDeg = a.gainDbi === undefined && a.diameterM ? (70 * (0.299792458 / a.frequencyGHz)) / a.diameterM : null;
          const pointingLossDb = beamwidthDeg ? Math.min(30, 12 * (pointing.accuracyDeg / beamwidthDeg) ** 2) : 0;
          const budget = linkBudget({
            frequencyGHz: a.frequencyGHz,
            txPowerW: a.txPowerW,
            txGainDbi,
            rxGainDbi: c.groundStation.antennaGainDbi,
            rxSystemNoiseTempK: c.groundStation.systemNoiseTempK,
            rangeKm,
            dataRateBps: a.dataRateBps,
            otherLossesDb: a.otherLossesDb + pointingLossDb,
            requiredEbN0Db: a.requiredEbN0Db,
          });
          return { antennaId: a.id, txGainDbi, beamwidthDeg, pointingLossDb, ...budget };
        });
      return {
        value: { rangeKm, links, worstMarginDb: links.length ? Math.min(...links.map((l) => l.marginDb)) : null },
        assumptions: [...assumptions, "Ground-station gain is taken at the antenna's frequency as configured", "Dish pointing loss = 12 (pointing error / half-power beamwidth)² dB, beamwidth ≈ 70 λ/D degrees; fixed-gain antennas are treated as wide-beam"],
      };
    },
  },
  {
    id: "data.budget",
    description: "Science data generated per orbit against downlink capacity and onboard storage",
    configDeps: ["spacecraft.components", "spacecraft.dataStorageGb"],
    derivedDeps: ["orbit.elements", "comms.link"],
    compute: (c, d) => {
      const el = need<{ periodS: number }>(d, "orbit.elements");
      const links = need<{ links: { antennaId: string; closes: boolean }[] }>(d, "comms.link").links;
      const instruments = c.spacecraft.components.filter((x) => x.type === "instrument");
      const antennas = c.spacecraft.components.filter((x) => x.type === "antenna");
      const computers = c.spacecraft.components.filter((x) => x.type === "computer");
      const compressionRatio = computers.length ? Math.max(...computers.map((x) => x.compressionRatio)) : 1;
      const storageGb = c.spacecraft.dataStorageGb + computers.reduce((s, x) => s + x.storageGb, 0);
      const generatedBitsPerOrbit = instruments.reduce((s, i) => s + i.dataRateBps * i.dutyCycle * el.periodS, 0);
      // Downlink capacity is counted in raw science bits: compression lets each transmitted bit carry more.
      const downlinkBitsPerOrbit = antennas.reduce((s, a) => s + (links.find((l) => l.antennaId === a.id)?.closes ? a.dataRateBps * a.dutyCycle * el.periodS : 0), 0) * compressionRatio;
      const orbitsPerDay = 86400 / el.periodS;
      const backlogGbPerDay = (Math.max(0, generatedBitsPerOrbit - downlinkBitsPerOrbit) * orbitsPerDay) / 1e9;
      return {
        value: {
          generatedGbPerDay: (generatedBitsPerOrbit * orbitsPerDay) / 1e9,
          downlinkCapacityGbPerDay: (downlinkBitsPerOrbit * orbitsPerDay) / 1e9,
          returnedGbPerDay: (Math.min(generatedBitsPerOrbit, downlinkBitsPerOrbit) * orbitsPerDay) / 1e9,
          downlinkUtilisation: downlinkBitsPerOrbit > 0 ? generatedBitsPerOrbit / downlinkBitsPerOrbit : null,
          backlogGbPerDay,
          daysUntilStorageFull: backlogGbPerDay > 0 ? storageGb / backlogGbPerDay : null,
          downlinkSufficient: generatedBitsPerOrbit <= downlinkBitsPerOrbit,
          compressionRatio,
          storageGb,
        },
        assumptions: ["Antenna duty cycle is the fraction of each orbit spent downlinking; a link that does not close returns no data", "Onboard compression is the computer's catalogue ratio applied to all science data; storage is counted in raw bits", "No protocol overhead or ground-station scheduling"],
      };
    },
  },
  {
    id: "science.return",
    description: "Per-instrument observation geometry: coverage latitude, footprint and diffraction-limited resolution",
    configDeps: ["spacecraft.components", "orbit.inclinationDeg", "orbit.semiMajorAxisKm", "orbit.eccentricity", "centralBody"],
    derivedDeps: ["orbit.elements", "data.budget", "adcs.pointing"],
    compute: (c, d) => {
      const el = need<{ periapsisAltitudeKm: number }>(d, "orbit.elements");
      const smearM = need<{ stabilityArcsec: number }>(d, "adcs.pointing").stabilityArcsec * ARCSEC * el.periapsisAltitudeKm * 1000;
      const data = need<{ generatedGbPerDay: number; returnedGbPerDay: number }>(d, "data.budget");
      const share = data.generatedGbPerDay > 0 ? data.returnedGbPerDay / data.generatedGbPerDay : 0;
      const instruments = c.spacecraft.components.filter((x) => x.type === "instrument").map((i) => {
        const wavelengthM = (i.wavelengthUm ?? (i.kind === "thermal_imager" ? 10 : 0.55)) * 1e-6;
        return {
          instrumentId: i.id,
          kind: i.kind,
          returnedGbPerDay: ((i.dataRateBps * i.dutyCycle * 86400) / 1e9) * share,
          // Rayleigh criterion at periapsis (1.22 λ h / D), blurred by however far the spacecraft drifts during an exposure.
          groundResolutionM: i.apertureM ? Math.max((1.22 * wavelengthM * el.periapsisAltitudeKm * 1000) / i.apertureM, smearM) : null,
          diffractionLimitM: i.apertureM ? (1.22 * wavelengthM * el.periapsisAltitudeKm * 1000) / i.apertureM : null,
          // Orbital neutron spectroscopy has a surface footprint of roughly 1.5x the altitude.
          footprintKm: i.kind === "neutron_spectrometer" ? 1.5 * el.periapsisAltitudeKm : null,
        };
      });
      const lat = Math.min(c.orbit.inclinationDeg, 180 - c.orbit.inclinationDeg);
      return {
        value: {
          maxCoverageLatitudeDeg: lat,
          reachesPoles: lat >= 85,
          instrumentKinds: [...new Set(instruments.map((i) => i.kind))],
          bestImagingResolutionM: instruments.reduce<number | null>((best, i) => (i.groundResolutionM !== null && (best === null || i.groundResolutionM < best) ? i.groundResolutionM : best), null),
          neutronFootprintKm: instruments.reduce<number | null>((best, i) => (i.footprintKm !== null && (best === null || i.footprintKm < best) ? i.footprintKm : best), null),
          totalReturnedGbPerDay: data.returnedGbPerDay,
          pointingSmearM: smearM,
          instruments,
        },
        assumptions: ["Resolution is the larger of the diffraction limit at periapsis and the pointing smear (altitude × pointing stability); no detector sampling or atmosphere", "Neutron spectrometer footprint ≈ 1.5 × altitude (rule of thumb for uncollimated orbital instruments)", "Downlinked data is shared between instruments in proportion to what they generate"],
      };
    },
  },
  {
    id: "launch.vehicle",
    description: "Launch vehicle options for this orbit, and whether the chosen one can lift the spacecraft",
    configDeps: ["meta.launchVehicleId", "meta.massLimitKg", "centralBody", "orbit.inclinationDeg"],
    derivedDeps: ["mass.budget"],
    verification: "heuristic",
    asBuilt: true,
    compute: (c, d) => {
      const mass = need<{ totalMassKg: number }>(d, "mass.budget");
      // The spacecraft is what the capacity is quoted for; a surface element rides on the same launch with its own allowance.
      const launchMassKg = mass.totalMassKg;
      const options = launchOptions(c);
      const chosen = options.find((o) => o.id === c.meta.launchVehicleId) ?? null;
      // Until a vehicle is chosen the reference is the mission's launch mass allocation.
      const reference = chosen?.capacityKg ?? c.meta.massLimitKg ?? null;
      return {
        value: { options, selectedId: chosen?.id ?? null, name: chosen?.name ?? null, launchMassKg, capacityKg: chosen?.capacityKg ?? null, marginKg: chosen ? chosen.capacityKg - launchMassKg : null, marginFraction: reference ? (reference - launchMassKg) / reference : null, costMusd: chosen?.costMusd ?? null },
        assumptions: ["Game model: vehicle classes are generic, with capacity and price set relative to the mission's launch mass allocation", "Capacity is quoted for the spacecraft; a rover and its landing stage ride on the same launch with their own allowance", "Earth orbits within 30° of polar lose part of the capacity; at the Moon and Mars inclination is set on arrival"],
      };
    },
  },
  {
    id: "cost.budget",
    description: "Programme cost roll-up in the platform's game cost model",
    configDeps: ["spacecraft", "rover", "meta.budgetMusd", "centralBody"],
    derivedDeps: ["mass.budget", "launch.vehicle"],
    verification: "heuristic",
    asBuilt: true,
    compute: (c, d) => {
      const mass = need<{ totalMassKg: number }>(d, "mass.budget");
      const componentCostMusd = [...c.spacecraft.components, ...(c.rover?.components ?? [])].reduce((s, x) => s + x.costMusd, 0);
      // Until a vehicle is chosen, delivery is priced per kilogram; afterwards it is the vehicle's price.
      const perKg = DELIVERY_PER_KG[c.centralBody];
      const vehicle = d["launch.vehicle"]?.value as { costMusd: number | null } | null | undefined;
      const roverMassKg = c.rover ? c.rover.chassisMassKg + c.rover.wheelCount * c.rover.wheelMassKg + c.rover.components.reduce((s, x) => s + x.massKg, 0) : 0;
      const launchCostMusd = vehicle?.costMusd ?? (mass.totalMassKg + roverMassKg) * perKg;
      const total = componentCostMusd + c.spacecraft.busCostMusd + launchCostMusd;
      return {
        value: { componentCostMusd, busCostMusd: c.spacecraft.busCostMusd, launchCostMusd, totalCostMusd: total, budgetMusd: c.meta.budgetMusd ?? null, marginMusd: c.meta.budgetMusd !== undefined ? c.meta.budgetMusd - total : null, marginFraction: c.meta.budgetMusd !== undefined ? (c.meta.budgetMusd - total) / c.meta.budgetMusd : null },
        assumptions: ["Game cost model: component prices are catalogue values and delivery is priced per kilogram by destination", "This is not a NASA cost estimate and excludes operations, reserves and development"],
      };
    },
  },
  {
    id: "schedule.budget",
    description: "Development time to launch readiness against the launch window (game schedule model)",
    configDeps: ["spacecraft.components", "rover", "meta.scheduleMonths"],
    derivedDeps: ["launch.vehicle"],
    verification: "heuristic",
    asBuilt: true,
    compute: (c, d) => {
      const allocation = c.meta.scheduleMonths ?? null;
      const parts = [...c.spacecraft.components, ...(c.rover?.components ?? [])].map((x) => ({ id: x.id, name: x.name, months: leadMonths(x) })).sort((a, b) => b.months - a.months);
      const longest = parts[0] ?? null;
      const others = parts.slice(1).reduce((s, p) => s + p.months, 0);
      // The bus is built while the long-lead part is; every further part adds integration and test time.
      const busMonths = allocation !== null ? allocation * 0.4 : 12;
      const integrationMonths = others * 0.2;
      const launch = d["launch.vehicle"]?.value as { options: { id: string; leadMonths: number }[]; selectedId: string | null } | null | undefined;
      const launchMonths = launch?.options.find((o) => o.id === launch.selectedId)?.leadMonths ?? 0;
      const total = busMonths + (longest?.months ?? 0) + integrationMonths + launchMonths;
      return {
        value: { developmentMonths: total, busMonths, longLeadItem: longest?.name ?? null, longLeadMonths: longest?.months ?? 0, integrationMonths, launchCampaignMonths: launchMonths, scheduleMonths: allocation, marginMonths: allocation !== null ? allocation - total : null, marginFraction: allocation !== null ? (allocation - total) / allocation : null },
        assumptions: ["Game schedule model: bus build + the longest-lead part + 20% of every other part's lead time for integration and test + the launch campaign", "Lead times are catalogue values by component type, not supplier quotes"],
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
  // Rewiring changes how the parts operate, so everything that reads the parts is recomputed with it.
  if (changedPaths.some((p) => pathsOverlap(p, "systems"))) changedPaths.push("spacecraft.components");
  const operating = effectiveMission(config);
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
      const out = node.compute(node.asBuilt ? config : operating, derived);
      derived[node.id] = { value: out.value, assumptions: out.assumptions ?? [], verification: node.verification ?? "deterministic_calculation" };
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
  const wiring = derived["systems.wiring"]?.value as Wiring | null | undefined;
  if (wiring?.wired) {
    const name = (id: string): string => wiring.parts.find((p) => p.id === id)?.name ?? id;
    const dead = wiring.unconnected.map((id) => `${name(id)}: ${wiring.parts.find((p) => p.id === id)!.notes[0] ?? "not connected"}`);
    const held = wiring.limited.map((id) => `${name(id)}: ${wiring.parts.find((p) => p.id === id)!.notes.join(" ")}`);
    add("systems.wiring", "Every part is connected by lines that can carry what it needs", dead.length || held.length ? "warn" : "pass", dead.length || held.length ? [...dead, ...held].join(" · ") : `${wiring.links.length} lines, harness ${wiring.harnessMassKg.toFixed(2)} kg`);
  }
  const mass = derived["mass.budget"]?.value as { marginKg: number | null; totalMassKg: number } | null | undefined;
  const launch = derived["launch.vehicle"]?.value as { selectedId: string | null; name: string | null; launchMassKg: number; capacityKg: number | null; marginKg: number | null; options: unknown[] } | null | undefined;
  if (launch && launch.options.length > 0) {
    if (launch.selectedId === null) add("launch.vehicle", "A launch vehicle is chosen", "warn", "no launch vehicle selected yet: delivery is priced per kilogram as a placeholder");
    else add("launch.vehicle", "The launch vehicle can lift the spacecraft to this orbit", launch.marginKg! >= 0 ? "pass" : "fail", `${launch.name}: ${launch.launchMassKg.toFixed(1)} kg to lift, capacity ${launch.capacityKg!.toFixed(1)} kg, margin ${launch.marginKg!.toFixed(1)} kg`);
  }
  // With a vehicle chosen, its capacity is the binding mass limit; the allocation applies only before that.
  if (mass && mass.marginKg !== null && !launch?.selectedId) {
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
  const cost = derived["cost.budget"]?.value as { marginMusd: number | null; totalCostMusd: number } | null | undefined;
  if (cost && cost.marginMusd !== null) {
    add("cost.limit", "Programme cost within the budget cap (game cost model)", cost.marginMusd >= 0 ? "pass" : "fail", `total $${cost.totalCostMusd.toFixed(1)}M, margin $${cost.marginMusd.toFixed(1)}M`);
  }
  const schedule = derived["schedule.budget"]?.value as { marginMonths: number | null; developmentMonths: number; scheduleMonths: number | null; longLeadItem: string | null } | null | undefined;
  if (schedule && schedule.marginMonths !== null) {
    add("schedule.window", "The spacecraft is ready before the launch window (game schedule model)", schedule.marginMonths >= 0 ? "pass" : "fail", `${schedule.developmentMonths.toFixed(1)} months to build against ${schedule.scheduleMonths} available, margin ${schedule.marginMonths.toFixed(1)} months${schedule.longLeadItem ? ` (long-lead item: ${schedule.longLeadItem})` : ""}`);
  }
  const data = derived["data.budget"]?.value as { downlinkSufficient: boolean; generatedGbPerDay: number; downlinkCapacityGbPerDay: number } | null | undefined;
  if (data && data.generatedGbPerDay > 0) {
    add("data.downlink", "Downlink capacity covers the science data generated", data.downlinkSufficient ? "pass" : "warn", `generated ${data.generatedGbPerDay.toFixed(2)} Gb/day, downlink capacity ${data.downlinkCapacityGbPerDay.toFixed(2)} Gb/day`);
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
