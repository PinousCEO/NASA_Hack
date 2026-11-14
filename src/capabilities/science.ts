/**
 * Scientific calculation and simulation capabilities. All are deterministic computations
 * from stated inputs; their implementations are covered by reference-value unit tests.
 */
import { z } from "zod";
import { type Capability, defineCapability } from "../registry/capability.js";
import { dishGainDbi, linkBudget } from "../science/comms.js";
import { sunState } from "../science/ephemeris.js";
import { BODIES, hohmannTransfer, orbitElements } from "../science/orbital.js";
import { powerBudget, simulatePowerTimeline } from "../science/power.js";
import { roverMobility, slopeAnalysis } from "../science/rover.js";
import { powerInputsFromComponents, roverMobilityInput } from "../state/recalc.js";

const body = z.enum(["earth", "moon", "mars"]);
const fraction = z.number().min(0).max(1);
const TESTED = { status: "self_tested" as const, method: "Unit tests against published reference values (tests/science.test.ts)" };
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const panel = z.object({
  areaM2: z.number().positive(),
  efficiency: fraction,
  pointingLoss: fraction.default(0),
  degradationPerYear: fraction.default(0),
});

const powerInput = z.object({
  panels: z.array(panel),
  loads: z.array(z.object({ name: z.string(), powerW: z.number().min(0), dutyCycle: fraction })),
  batteryCapacityWh: z.number().min(0),
  batteryMaxDepthOfDischarge: fraction,
  sunDistanceAu: z.number().positive(),
  eclipseFraction: fraction,
  orbitPeriodS: z.number().positive(),
  yearsInService: z.number().min(0).default(0),
});

export function scienceCapabilities(): Capability[] {
  return [
    defineCapability({
      id: "science.orbit.elements",
      name: "Orbit elements",
      description: "Two-body orbit period, apsides, velocities and specific energy for a closed orbit around Earth, Moon or Mars.",
      category: "scientific_calculation",
      provides: ["calc.orbit.elements"],
      input: z.object({ body, semiMajorAxisKm: z.number().positive(), eccentricity: z.number().min(0).lt(1) }),
      output: z.looseObject({ periodS: z.number(), periapsisAltitudeKm: z.number(), apoapsisAltitudeKm: z.number(), intersectsSurface: z.boolean() }),
      verification: TESTED,
      outputVerification: "deterministic_calculation",
      references: ["Vallado, Fundamentals of Astrodynamics and Applications, ch. 2"],
      run: (input) => ({ output: { ...orbitElements(input) }, assumptions: ["Two-body (Keplerian) motion; no perturbations"] }),
      defaultInput: ({ config, params }) => {
        const altitude = num(params.altitudeKm);
        return {
          body: config.centralBody,
          semiMajorAxisKm: altitude !== undefined ? BODIES[config.centralBody].radiusKm + altitude : config.orbit.semiMajorAxisKm,
          eccentricity: altitude !== undefined ? 0 : config.orbit.eccentricity,
        };
      },
    }),
    defineCapability({
      id: "science.orbit.hohmann",
      name: "Hohmann transfer",
      description: "Delta-v and time of flight for a Hohmann transfer between two coplanar circular orbits.",
      category: "scientific_calculation",
      provides: ["calc.orbit.transfer"],
      input: z.object({ body, r1Km: z.number().positive(), r2Km: z.number().positive() }),
      output: z.looseObject({ deltaV1KmS: z.number(), deltaV2KmS: z.number(), totalDeltaVKmS: z.number(), transferTimeS: z.number() }),
      verification: TESTED,
      outputVerification: "deterministic_calculation",
      run: (input) => ({ output: { ...hohmannTransfer(input.body, input.r1Km, input.r2Km) }, assumptions: ["Impulsive burns; coplanar circular orbits"] }),
      defaultInput: ({ config, params }) => ({
        body: config.centralBody,
        r1Km: config.orbit.semiMajorAxisKm,
        r2Km: num(params.targetAltitudeKm) !== undefined ? BODIES[config.centralBody].radiusKm + num(params.targetAltitudeKm)! : params.targetRadiusKm,
      }),
    }),
    defineCapability({
      id: "science.ephemeris.sun",
      name: "Sun state (analytic)",
      description: "Approximate Sun direction and distance, and Earth range, for a central body at a given time (JPL approximate Keplerian elements).",
      category: "scientific_calculation",
      provides: ["calc.ephemeris.sun"],
      input: z.object({ centralBody: body, time: z.iso.datetime({ offset: true }) }),
      output: z.looseObject({ distanceAu: z.number(), eclipticLongitudeDeg: z.number(), earthToBodyDistanceKm: z.number() }),
      verification: TESTED,
      outputVerification: "deterministic_calculation",
      references: ["https://ssd.jpl.nasa.gov/planets/approx_pos.html"],
      run: (input) => {
        const { assumptions, ...output } = sunState(input.centralBody, input.time);
        return { output, assumptions };
      },
      defaultInput: ({ config, params }) => ({ centralBody: config.centralBody, time: typeof params.time === "string" ? params.time : config.missionTime }),
    }),
    defineCapability({
      id: "science.power.budget",
      name: "Power budget",
      description: "Orbit-average solar generation, average load, power margin and eclipse battery depth of discharge.",
      category: "scientific_calculation",
      provides: ["calc.power.budget"],
      input: powerInput,
      output: z.looseObject({ orbitAverageGenerationW: z.number(), averageLoadW: z.number(), marginW: z.number(), positiveMargin: z.boolean() }),
      verification: TESTED,
      outputVerification: "deterministic_calculation",
      run: (input) => ({ output: { ...powerBudget(input) }, assumptions: ["Loads at duty-cycle average; no conversion losses"] }),
      defaultInput: ({ config, derived }) => ({
        ...powerInputsFromComponents(config.spacecraft.components),
        sunDistanceAu: (derived["ephemeris.sun"]?.value as { distanceAu: number } | null)?.distanceAu,
        eclipseFraction: (derived["orbit.eclipse"]?.value as { eclipseFraction: number } | null)?.eclipseFraction,
        orbitPeriodS: (derived["orbit.elements"]?.value as { periodS: number } | null)?.periodS,
        yearsInService: config.meta.yearsInService,
      }),
    }),
    defineCapability({
      id: "science.comms.link_budget",
      name: "RF link budget",
      description: "Downlink budget: EIRP, free-space path loss, C/N0, Eb/N0, margin and the maximum data rate at 3 dB margin.",
      category: "scientific_calculation",
      provides: ["calc.comms.link"],
      input: z.object({
        frequencyGHz: z.number().positive(),
        txPowerW: z.number().positive(),
        txGainDbi: z.number(),
        rxGainDbi: z.number(),
        rxSystemNoiseTempK: z.number().positive(),
        rangeKm: z.number().positive(),
        dataRateBps: z.number().positive(),
        otherLossesDb: z.number().min(0).default(3),
        requiredEbN0Db: z.number().default(9.6),
      }),
      output: z.looseObject({ ebN0Db: z.number(), marginDb: z.number(), closes: z.boolean(), maxDataRateBpsAt3DbMargin: z.number() }),
      verification: TESTED,
      outputVerification: "deterministic_calculation",
      references: ["Wertz, Everett & Puschell, Space Mission Engineering: The New SMAD, ch. 16"],
      run: (input) => ({ output: { ...linkBudget(input) } }),
      defaultInput: ({ config, derived, params }) => {
        const antennas = config.spacecraft.components.filter((c) => c.type === "antenna");
        const antenna = antennas.find((a) => a.id === params.antennaId) ?? antennas[0];
        if (!antenna) return {};
        return {
          frequencyGHz: antenna.frequencyGHz,
          txPowerW: antenna.txPowerW,
          txGainDbi: antenna.gainDbi ?? dishGainDbi(antenna.diameterM!, antenna.frequencyGHz),
          rxGainDbi: config.groundStation.antennaGainDbi,
          rxSystemNoiseTempK: config.groundStation.systemNoiseTempK,
          rangeKm: (derived["comms.link"]?.value as { rangeKm: number } | null)?.rangeKm,
          dataRateBps: num(params.dataRateBps) ?? antenna.dataRateBps,
          otherLossesDb: antenna.otherLossesDb,
          requiredEbN0Db: antenna.requiredEbN0Db,
        };
      },
    }),
    defineCapability({
      id: "science.rover.mobility",
      name: "Rover mobility",
      description: "Rover slope capability from traction, wheel torque and static stability, with tractive force and drive power at a given slope.",
      category: "scientific_calculation",
      provides: ["calc.rover.mobility"],
      input: z.object({
        totalMassKg: z.number().positive(),
        gravityMS2: z.number().positive(),
        wheelCount: z.number().int().min(3),
        wheelRadiusM: z.number().positive(),
        wheelTorqueNm: z.number().positive(),
        tractionCoefficient: z.number().positive(),
        rollingResistanceCoefficient: z.number().min(0),
        supportHalfSpanM: z.number().positive(),
        centerOfMassHeightM: z.number().positive(),
        speedMS: z.number().positive(),
        drivetrainEfficiency: z.number().gt(0).max(1),
        siteSlopeDeg: z.number().min(0).max(89),
      }),
      output: z.looseObject({ maxClimbSlopeDeg: z.number(), limitingFactor: z.string(), canTraverseSite: z.boolean(), drivePowerW: z.number() }),
      verification: TESTED,
      outputVerification: "deterministic_calculation",
      run: (input) => ({ output: { ...roverMobility(input) }, assumptions: ["Rigid-wheel statics; soil sinkage and slip not modelled"] }),
      defaultInput: ({ config, params }) => {
        if (!config.rover) return {};
        const base = roverMobilityInput(config.rover);
        return { ...base, siteSlopeDeg: num(params.slopeDeg) ?? base.siteSlopeDeg };
      },
    }),
    defineCapability({
      id: "science.terrain.slope_analysis",
      name: "Terrain slope analysis",
      description: "Slope statistics (max, mean, 95th percentile, fraction above a threshold) of a regular-grid heightmap supplied by the caller.",
      category: "scientific_calculation",
      provides: ["calc.terrain.slope"],
      input: z.object({
        heightsM: z.array(z.array(z.number())).min(2),
        cellSizeM: z.number().positive(),
        thresholdDeg: z.number().min(0).max(90).default(15),
      }),
      output: z.looseObject({ maxSlopeDeg: z.number(), meanSlopeDeg: z.number(), p95SlopeDeg: z.number(), fractionAboveThreshold: z.number() }),
      verification: TESTED,
      outputVerification: "deterministic_calculation",
      run: (input) => ({ output: { ...slopeAnalysis(input.heightsM, input.cellSizeM, input.thresholdDeg) }, assumptions: ["Central-difference gradients on the supplied grid"] }),
    }),
    defineCapability({
      id: "simulation.power_timeline",
      name: "Battery state-of-charge simulation",
      description: "Time-stepped simulation of battery state of charge over a number of orbits, with sunlit charging and eclipse discharge.",
      category: "simulation",
      provides: ["sim.power.timeline"],
      input: powerInput.extend({
        orbits: z.number().positive().max(500).default(5),
        stepS: z.number().positive().default(10),
        initialStateOfCharge: fraction.default(1),
        chargeEfficiency: fraction.default(0.9),
      }),
      output: z.looseObject({ minStateOfCharge: z.number(), finalStateOfCharge: z.number(), energyBalancedPerOrbit: z.boolean(), batteryDepleted: z.boolean() }),
      resources: { cpu: "medium", typicalDurationMs: 50 },
      constraints: { timeoutMs: 20000 },
      verification: { status: "self_tested", method: "Energy-balance unit tests (tests/science.test.ts)" },
      outputVerification: "deterministic_calculation",
      run: (input) => ({
        output: { ...simulatePowerTimeline(input) },
        assumptions: ["Eclipse arc centred on the anti-Sun point", "Constant sunlit array power; loads at duty-cycle average"],
      }),
      defaultInput: ({ config, derived, params }) => ({
        ...powerInputsFromComponents(config.spacecraft.components),
        sunDistanceAu: (derived["ephemeris.sun"]?.value as { distanceAu: number } | null)?.distanceAu,
        eclipseFraction: (derived["orbit.eclipse"]?.value as { eclipseFraction: number } | null)?.eclipseFraction,
        orbitPeriodS: (derived["orbit.elements"]?.value as { periodS: number } | null)?.periodS,
        yearsInService: config.meta.yearsInService,
        ...(num(params.orbits) !== undefined ? { orbits: num(params.orbits) } : {}),
      }),
    }),
  ];
}
