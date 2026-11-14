/**
 * Mission scenarios. A scenario is data: a briefing, a starting configuration, scored
 * objectives and a component catalogue. New scenarios are added to `SCENARIOS`; nothing
 * else in the platform is scenario-specific.
 *
 * `generateMission` derives a concrete mission from a scenario and a seed, so the same
 * seed always yields the same mission (fair leaderboards) while different seeds vary the
 * budget, mass allocation, launch date and a programme complication.
 */
import type { z } from "zod";
import type { DisciplineId } from "../nasa/lifecycle.js";
import { type Component, type MissionConfig, type MissionConfigSchema, parseMissionConfig } from "../state/schema.js";

export type ObjectiveMetric =
  | { type: "derived"; node: string; field: string }
  | { type: "instrument"; kind: string }
  | { type: "simulation"; field: string }
  | { type: "check"; id: string };

export interface Objective {
  id: string;
  title: string;
  description: string;
  category: "science" | "engineering" | "programmatic";
  weight: number;
  metric: ObjectiveMetric;
  /** Value at which the objective earns nothing / full credit; credit is linear in between. */
  zeroAt: number;
  fullAt: number;
  unit: string;
}

export interface CatalogItem {
  id: string;
  label: string;
  discipline: DisciplineId;
  description: string;
  /** Component template; the id is assigned when it is added to a mission. */
  component: Omit<Component, "id">;
}

export type Difficulty = "cadet" | "engineer" | "chief";

export interface Scenario {
  id: string;
  title: string;
  tagline: string;
  destination: "earth" | "moon" | "mars";
  briefing: string[];
  scienceQuestions: string[];
  references: string[];
  baseConfig: z.input<typeof MissionConfigSchema>;
  objectives: Objective[];
  catalog: CatalogItem[];
  disciplines: DisciplineId[];
}

export interface GeneratedMission {
  scenarioId: string;
  seed: number;
  difficulty: Difficulty;
  config: MissionConfig;
  objectives: Objective[];
  complication: { id: string; title: string; description: string };
}

const comp = <T extends Omit<Component, "id">>(c: T): T => c;

const CATALOG: CatalogItem[] = [
  { id: "sa-1", label: "Solar array wing · 1.0 m²", discipline: "power", description: "Triple-junction GaAs, single-axis tracking.", component: comp({ type: "solar_panel", name: "Solar array wing 1.0 m²", massKg: 3.5, areaM2: 1.0, efficiency: 0.295, pointingLoss: 0.1, degradationPerYear: 0.02, costMusd: 1.8 }) },
  { id: "sa-2", label: "Solar array wing · 2.0 m²", discipline: "power", description: "Larger deployable wing.", component: comp({ type: "solar_panel", name: "Solar array wing 2.0 m²", massKg: 7.0, areaM2: 2.0, efficiency: 0.295, pointingLoss: 0.1, degradationPerYear: 0.02, costMusd: 3.2 }) },
  { id: "bat-400", label: "Li-ion battery · 400 Wh", discipline: "power", description: "Space-qualified 8s pack.", component: comp({ type: "battery", name: "Li-ion battery 400 Wh", massKg: 3.2, capacityWh: 400, maxDepthOfDischarge: 0.4, costMusd: 0.9 }) },
  { id: "bat-1000", label: "Li-ion battery · 1000 Wh", discipline: "power", description: "High-capacity pack for long eclipses.", component: comp({ type: "battery", name: "Li-ion battery 1000 Wh", massKg: 7.5, capacityWh: 1000, maxDepthOfDischarge: 0.4, costMusd: 1.9 }) },
  { id: "hga-x", label: "X-band high-gain antenna · 0.6 m", discipline: "communications", description: "8.45 GHz, 10 W RF, 2 Mbit/s.", component: comp({ type: "antenna", name: "X-band HGA 0.6 m", massKg: 3.1, frequencyGHz: 8.45, diameterM: 0.6, txPowerW: 10, dcPowerW: 45, dutyCycle: 0.3, dataRateBps: 2e6, otherLossesDb: 3, requiredEbN0Db: 4.5, costMusd: 2.4 }) },
  { id: "hga-ka", label: "Ka-band high-gain antenna · 0.9 m", discipline: "communications", description: "32 GHz, 20 W RF, 20 Mbit/s. Needs a Ka-capable ground station gain.", component: comp({ type: "antenna", name: "Ka-band HGA 0.9 m", massKg: 6.5, frequencyGHz: 32, diameterM: 0.9, txPowerW: 20, dcPowerW: 90, dutyCycle: 0.3, dataRateBps: 2e7, otherLossesDb: 5, requiredEbN0Db: 4.5, costMusd: 5.5 }) },
  { id: "ns", label: "Neutron spectrometer", discipline: "payload", description: "Maps hydrogen (water-ice proxy) in the top metre of regolith. Footprint scales with altitude.", component: comp({ type: "instrument", kind: "neutron_spectrometer", name: "Neutron spectrometer", massKg: 9, powerW: 12, dutyCycle: 1, dataRateBps: 2000, costMusd: 9 }) },
  { id: "nac", label: "Narrow-angle camera · 20 cm", discipline: "payload", description: "High-resolution panchromatic imager.", component: comp({ type: "instrument", kind: "camera", name: "Narrow-angle camera", massKg: 14, powerW: 22, dutyCycle: 0.15, dataRateBps: 4e6, apertureM: 0.2, wavelengthUm: 0.55, costMusd: 14 }) },
  { id: "wac", label: "Wide-angle camera · 5 cm", discipline: "payload", description: "Context imaging at modest resolution.", component: comp({ type: "instrument", kind: "camera", name: "Wide-angle camera", massKg: 2, powerW: 6, dutyCycle: 0.3, dataRateBps: 8e5, apertureM: 0.05, wavelengthUm: 0.55, costMusd: 3 }) },
  { id: "irs", label: "Infrared spectrometer", discipline: "payload", description: "Identifies water and hydroxyl absorption bands.", component: comp({ type: "instrument", kind: "spectrometer", name: "Infrared spectrometer", massKg: 6, powerW: 15, dutyCycle: 0.4, dataRateBps: 3e5, costMusd: 8 }) },
  { id: "tir", label: "Thermal imager · 10 cm", discipline: "payload", description: "Surface temperature maps; finds cold traps.", component: comp({ type: "instrument", kind: "thermal_imager", name: "Thermal imager", massKg: 8, powerW: 18, dutyCycle: 0.4, dataRateBps: 5e5, apertureM: 0.1, wavelengthUm: 10, costMusd: 7 }) },
  { id: "gpr", label: "Sounding radar", discipline: "payload", description: "Probes subsurface layering. Power-hungry.", component: comp({ type: "instrument", kind: "radar", name: "Sounding radar", massKg: 12, powerW: 60, dutyCycle: 0.1, dataRateBps: 2e6, costMusd: 11 }) },
  { id: "lola", label: "Laser altimeter", discipline: "payload", description: "Topography and permanently shadowed region mapping.", component: comp({ type: "instrument", kind: "lidar", name: "Laser altimeter", massKg: 10, powerW: 35, dutyCycle: 0.5, dataRateBps: 1e5, apertureM: 0.14, wavelengthUm: 1.064, costMusd: 9 }) },
  { id: "mag", label: "Magnetometer", discipline: "payload", description: "Low-mass fields instrument.", component: comp({ type: "instrument", kind: "magnetometer", name: "Magnetometer", massKg: 1.5, powerW: 3, dutyCycle: 1, dataRateBps: 5000, costMusd: 1.5 }) },
];

const CUBESAT_CATALOG: CatalogItem[] = [
  { id: "cs-sa", label: "Deployable panel · 0.06 m²", discipline: "power", description: "Two-panel 3U-length deployable.", component: comp({ type: "solar_panel", name: "Deployable panel 0.06 m²", massKg: 0.25, areaM2: 0.06, efficiency: 0.29, pointingLoss: 0.25, degradationPerYear: 0.03, costMusd: 0.08 }) },
  { id: "cs-bat", label: "Battery pack · 40 Wh", discipline: "power", description: "18650-cell pack.", component: comp({ type: "battery", name: "Battery pack 40 Wh", massKg: 0.3, capacityWh: 40, maxDepthOfDischarge: 0.3, costMusd: 0.05 }) },
  { id: "cs-x", label: "X-band transmitter + patch", discipline: "communications", description: "8.2 GHz, 2 W RF, 10 Mbit/s.", component: comp({ type: "antenna", name: "X-band patch transmitter", massKg: 0.4, frequencyGHz: 8.2, gainDbi: 12, txPowerW: 2, dcPowerW: 12, dutyCycle: 0.08, dataRateBps: 1e7, otherLossesDb: 3, requiredEbN0Db: 4.5, costMusd: 0.35 }) },
  { id: "cs-cam", label: "Multispectral imager · 9 cm", discipline: "payload", description: "Ocean-colour bands.", component: comp({ type: "instrument", kind: "camera", name: "Multispectral imager 9 cm", massKg: 1.6, powerW: 7, dutyCycle: 0.15, dataRateBps: 6e6, apertureM: 0.09, wavelengthUm: 0.55, costMusd: 0.9 }) },
  { id: "cs-tir", label: "Thermal microbolometer · 3 cm", discipline: "payload", description: "Sea-surface temperature context.", component: comp({ type: "instrument", kind: "thermal_imager", name: "Thermal microbolometer", massKg: 0.5, powerW: 3, dutyCycle: 0.3, dataRateBps: 2e5, apertureM: 0.03, wavelengthUm: 10, costMusd: 0.25 }) },
  { id: "cs-mag", label: "Magnetometer", discipline: "payload", description: "Boom-mounted fluxgate.", component: comp({ type: "instrument", kind: "magnetometer", name: "Magnetometer", massKg: 0.2, powerW: 1, dutyCycle: 1, dataRateBps: 2000, costMusd: 0.1 }) },
];

const DSN_34M = { name: "34 m deep-space station", antennaGainDbi: 68.2, systemNoiseTempK: 30, minElevationDeg: 10 };

export const SCENARIOS: Scenario[] = [
  {
    id: "lunar-volatiles",
    title: "Lunar South Pole Volatiles Prospector",
    tagline: "Find the water. An orbiter and a rover, one launch, one budget.",
    destination: "moon",
    briefing: [
      "Permanently shadowed craters near the lunar south pole may hold water ice — a resource for future crews and a record of the inner Solar System's history.",
      "Your team is the concept study for a small orbiter that maps hydrogen and terrain from polar orbit and relays data for a scout rover on the Shackleton connecting ridge.",
      "You start from a bare relay orbiter. Choose the instruments, size the power and communications systems, pick the orbit, and keep the whole programme inside its mass and cost caps.",
    ],
    scienceQuestions: [
      "Where is hydrogen concentrated within the top metre of polar regolith, and at what spatial scale?",
      "Which permanently shadowed regions are cold enough to trap water ice, and can a rover reach their margins?",
    ],
    references: ["NASA Systems Engineering Handbook, SP-2016-6105 Rev 2", "Wessen et al., Space Mission Concept Development Using Concept Maturity Levels (JPL)", "LRO/LEND and Lunar Prospector neutron spectrometer results (context for objectives)"],
    disciplines: ["systems", "flight_dynamics", "power", "communications", "payload", "surface"],
    catalog: CATALOG,
    baseConfig: {
      meta: { name: "Lunar South Pole Volatiles Prospector", description: "Polar orbiter with hydrogen-mapping payload and a surface scout rover.", massLimitKg: 180, budgetMusd: 125, missionDurationDays: 365 },
      missionTime: "2027-03-01T00:00:00Z",
      centralBody: "moon",
      orbit: { semiMajorAxisKm: 1837.4, eccentricity: 0, inclinationDeg: 90, raanDeg: 0, argPeriapsisDeg: 0, trueAnomalyDeg: 0, epoch: "2027-03-01T00:00:00Z" },
      spacecraft: {
        name: "Prospector Orbiter",
        busDryMassKg: 95,
        busCostMusd: 28,
        dataStorageGb: 64,
        components: [
          { id: "sp1", type: "solar_panel", name: "Solar array +Y", massKg: 4.2, areaM2: 1.2, efficiency: 0.295, pointingLoss: 0.1, degradationPerYear: 0.02, costMusd: 2.0 },
          { id: "bat1", type: "battery", name: "Li-ion battery", massKg: 6.5, capacityWh: 800, maxDepthOfDischarge: 0.4, costMusd: 1.6 },
          { id: "ant1", type: "antenna", name: "X-band high-gain antenna", massKg: 3.1, frequencyGHz: 8.45, diameterM: 0.6, txPowerW: 10, dcPowerW: 45, dutyCycle: 0.3, dataRateBps: 2e6, otherLossesDb: 3, requiredEbN0Db: 4.5, costMusd: 2.4 },
          { id: "avionics", type: "load", name: "Avionics and thermal", massKg: 12, powerW: 85, dutyCycle: 1, costMusd: 0 },
          { id: "relay", type: "load", name: "Rover relay radio", massKg: 4, powerW: 30, dutyCycle: 0.5, costMusd: 1.2 },
        ],
      },
      groundStation: DSN_34M,
      rover: {
        name: "Scout Rover",
        chassisMassKg: 22, wheelCount: 4, wheelRadiusM: 0.12, wheelMassKg: 0.9, wheelTorqueNm: 3.5, supportHalfSpanM: 0.3, centerOfMassHeightM: 0.28, speedMS: 0.1, drivetrainEfficiency: 0.6,
        components: [
          { id: "rsp1", type: "solar_panel", name: "Rover deck array", massKg: 1.1, areaM2: 0.35, efficiency: 0.28, pointingLoss: 0.5, degradationPerYear: 0.02, costMusd: 0.5 },
          { id: "rbat1", type: "battery", name: "Rover battery", massKg: 2.4, capacityWh: 300, maxDepthOfDischarge: 0.6, costMusd: 0.4 },
          { id: "rcpu", type: "load", name: "Rover avionics", massKg: 1.8, powerW: 18, dutyCycle: 1, costMusd: 2.5 },
        ],
        site: { body: "moon", name: "Shackleton connecting ridge", slopeDeg: 12, tractionCoefficient: 0.55, rollingResistanceCoefficient: 0.15 },
      },
      scene: { nodes: [] },
      assets: [],
      scripts: [],
    },
    objectives: [
      { id: "hydrogen", title: "Map hydrogen", description: "Carry a neutron spectrometer.", category: "science", weight: 14, metric: { type: "instrument", kind: "neutron_spectrometer" }, zeroAt: 0, fullAt: 1, unit: "" },
      { id: "footprint", title: "Resolve hydrogen deposits", description: "Neutron footprint of 75 km or better (lower orbits resolve smaller deposits).", category: "science", weight: 10, metric: { type: "derived", node: "science.return", field: "neutronFootprintKm" }, zeroAt: 200, fullAt: 75, unit: "km" },
      { id: "polar", title: "Reach the poles", description: "Orbit inclination gives coverage to at least 85° latitude.", category: "science", weight: 8, metric: { type: "derived", node: "science.return", field: "maxCoverageLatitudeDeg" }, zeroAt: 60, fullAt: 85, unit: "°" },
      { id: "imaging", title: "Image the traverse", description: "Imaging resolution of 1 m or better for rover route planning.", category: "science", weight: 10, metric: { type: "derived", node: "science.return", field: "bestImagingResolutionM" }, zeroAt: 20, fullAt: 1, unit: "m" },
      { id: "data", title: "Return the data", description: "Return at least 15 Gbit of science data per day.", category: "science", weight: 8, metric: { type: "derived", node: "science.return", field: "totalReturnedGbPerDay" }, zeroAt: 1, fullAt: 15, unit: "Gb/day" },
      { id: "power", title: "Power margin", description: "Orbit-average generation exceeds load by 20%.", category: "engineering", weight: 8, metric: { type: "derived", node: "power.budget", field: "marginFraction" }, zeroAt: 0, fullAt: 0.2, unit: "×load" },
      { id: "battery", title: "Battery health", description: "Eclipse depth of discharge at or below 25%.", category: "engineering", weight: 6, metric: { type: "derived", node: "power.budget", field: "depthOfDischarge" }, zeroAt: 0.6, fullAt: 0.25, unit: "" },
      { id: "link", title: "Link margin", description: "Downlink closes with 6 dB of margin.", category: "engineering", weight: 6, metric: { type: "derived", node: "comms.link", field: "worstMarginDb" }, zeroAt: 0, fullAt: 6, unit: "dB" },
      { id: "rover", title: "Rover reaches the ridge", description: "Slope capability exceeds the site slope by 8°.", category: "engineering", weight: 6, metric: { type: "derived", node: "rover.performance", field: "slopeMarginDeg" }, zeroAt: 0, fullAt: 8, unit: "°" },
      { id: "survive", title: "Survive the eclipse season", description: "No days with negative power margin across the simulated mission.", category: "engineering", weight: 6, metric: { type: "simulation", field: "daysPowerNegative" }, zeroAt: 30, fullAt: 0, unit: "days" },
      { id: "mass", title: "Mass margin", description: "Hold 10% of the launch mass allocation in reserve.", category: "programmatic", weight: 8, metric: { type: "derived", node: "mass.budget", field: "marginFraction" }, zeroAt: 0, fullAt: 0.1, unit: "×limit" },
      { id: "cost", title: "Cost margin", description: "Finish with 8% of the budget unspent.", category: "programmatic", weight: 10, metric: { type: "derived", node: "cost.budget", field: "marginFraction" }, zeroAt: 0, fullAt: 0.08, unit: "×budget" },
    ],
  },
  {
    id: "leo-cubesat",
    title: "Coastal Watch 6U CubeSat",
    tagline: "A shoebox-sized satellite, a university budget, a real science product.",
    destination: "earth",
    briefing: [
      "Harmful algal blooms threaten coastal fisheries and drinking water. A 6U CubeSat in sun-synchronous orbit can image coastal waters every few days.",
      "CubeSats follow a standard: a 6U fits a 12 kg, 10 × 20 × 30 cm envelope and rides to orbit in a dispenser as a secondary payload.",
      "Fit an imager, power and a downlink into the mass cap, and close the link to a 3.7 m university ground station.",
    ],
    scienceQuestions: ["How do bloom extent and intensity change week to week along a coastline?", "Can a 6U platform deliver useful ocean-colour data products on a university budget?"],
    references: ["CubeSat 101: Basic Concepts and Processes for First-Time CubeSat Developers (NASA CubeSat Launch Initiative)", "CubeSat Design Specification (Cal Poly)"],
    disciplines: ["systems", "flight_dynamics", "power", "communications", "payload"],
    catalog: CUBESAT_CATALOG,
    baseConfig: {
      meta: { name: "Coastal Watch 6U CubeSat", description: "Sun-synchronous ocean-colour imaging CubeSat.", massLimitKg: 12, budgetMusd: 3.2, missionDurationDays: 365 },
      missionTime: "2027-06-01T00:00:00Z",
      centralBody: "earth",
      orbit: { semiMajorAxisKm: 6928.137, eccentricity: 0, inclinationDeg: 97.6, raanDeg: 150, argPeriapsisDeg: 0, trueAnomalyDeg: 0, epoch: "2027-06-01T00:00:00Z" },
      spacecraft: {
        name: "Coastal Watch",
        busDryMassKg: 4.2,
        busCostMusd: 0.9,
        dataStorageGb: 128,
        components: [
          { id: "sp1", type: "solar_panel", name: "Body-mounted cells", massKg: 0.4, areaM2: 0.1, efficiency: 0.28, pointingLoss: 0.35, degradationPerYear: 0.03, costMusd: 0.12 },
          { id: "bat1", type: "battery", name: "Battery pack 40 Wh", massKg: 0.3, capacityWh: 40, maxDepthOfDischarge: 0.3, costMusd: 0.05 },
          { id: "ant1", type: "antenna", name: "S-band patch transceiver", massKg: 0.25, frequencyGHz: 2.25, gainDbi: 6, txPowerW: 2, dcPowerW: 10, dutyCycle: 0.08, dataRateBps: 1e6, otherLossesDb: 3, requiredEbN0Db: 9.6, costMusd: 0.15 },
          { id: "avionics", type: "load", name: "Flight computer and ADCS", massKg: 1.1, powerW: 6, dutyCycle: 1, costMusd: 0.3 },
        ],
      },
      groundStation: { name: "3.7 m university station", antennaGainDbi: 35.5, systemNoiseTempK: 150, minElevationDeg: 10 },
      scene: { nodes: [] },
      assets: [],
      scripts: [],
    },
    objectives: [
      { id: "imager", title: "Carry an imager", description: "Fly a camera for ocean-colour imaging.", category: "science", weight: 16, metric: { type: "instrument", kind: "camera" }, zeroAt: 0, fullAt: 1, unit: "" },
      { id: "imaging", title: "Resolve coastal features", description: "Ground resolution of 5 m or better.", category: "science", weight: 14, metric: { type: "derived", node: "science.return", field: "bestImagingResolutionM" }, zeroAt: 60, fullAt: 5, unit: "m" },
      { id: "data", title: "Return the data", description: "Return at least 4 Gbit per day.", category: "science", weight: 14, metric: { type: "derived", node: "science.return", field: "totalReturnedGbPerDay" }, zeroAt: 0.2, fullAt: 4, unit: "Gb/day" },
      { id: "coverage", title: "Global coastlines", description: "Coverage to at least 80° latitude.", category: "science", weight: 6, metric: { type: "derived", node: "science.return", field: "maxCoverageLatitudeDeg" }, zeroAt: 40, fullAt: 80, unit: "°" },
      { id: "power", title: "Power margin", description: "Generation exceeds load by 25%.", category: "engineering", weight: 10, metric: { type: "derived", node: "power.budget", field: "marginFraction" }, zeroAt: 0, fullAt: 0.25, unit: "×load" },
      { id: "battery", title: "Battery cycle life", description: "Depth of discharge at or below 20% (thousands of eclipse cycles per year).", category: "engineering", weight: 8, metric: { type: "derived", node: "power.budget", field: "depthOfDischarge" }, zeroAt: 0.5, fullAt: 0.2, unit: "" },
      { id: "link", title: "Link margin", description: "Downlink closes with 6 dB of margin.", category: "engineering", weight: 8, metric: { type: "derived", node: "comms.link", field: "worstMarginDb" }, zeroAt: 0, fullAt: 6, unit: "dB" },
      { id: "survive", title: "Positive power all year", description: "No days with negative power margin in the simulation.", category: "engineering", weight: 6, metric: { type: "simulation", field: "daysPowerNegative" }, zeroAt: 30, fullAt: 0, unit: "days" },
      { id: "mass", title: "Fit the dispenser", description: "Hold 5% mass reserve under the 12 kg 6U limit.", category: "programmatic", weight: 10, metric: { type: "derived", node: "mass.budget", field: "marginFraction" }, zeroAt: 0, fullAt: 0.05, unit: "×limit" },
      { id: "cost", title: "Cost margin", description: "Finish with 8% of the budget unspent.", category: "programmatic", weight: 8, metric: { type: "derived", node: "cost.budget", field: "marginFraction" }, zeroAt: 0, fullAt: 0.08, unit: "×budget" },
    ],
  },
  {
    id: "mars-weather-relay",
    title: "Mars Weather and Relay Orbiter",
    tagline: "Forecast the dust. Keep the surface connected. 400 million kilometres from help.",
    destination: "mars",
    briefing: [
      "Dust storms can blanket Mars for weeks. Surface missions need daily weather maps and a dependable relay to Earth.",
      "Design a near-polar orbiter that images weather systems, maps surface temperature, and closes a deep-space link whose range changes sixfold over the mission.",
      "Sunlight at Mars is less than half as strong as at Earth, and the Earth–Mars distance at your mission date decides how much data comes home.",
    ],
    scienceQuestions: ["How do regional dust storms grow into planet-encircling events?", "What data return does a relay orbiter sustain when Mars is near conjunction?"],
    references: ["NASA Systems Engineering Handbook, SP-2016-6105 Rev 2", "JPL approximate planetary ephemerides (range and solar distance)"],
    disciplines: ["systems", "flight_dynamics", "power", "communications", "payload"],
    catalog: CATALOG.filter((c) => !["ns"].includes(c.id)),
    baseConfig: {
      meta: { name: "Mars Weather and Relay Orbiter", description: "Near-polar Mars orbiter for weather imaging and relay.", massLimitKg: 620, budgetMusd: 480, missionDurationDays: 687 },
      missionTime: "2029-01-15T00:00:00Z",
      centralBody: "mars",
      orbit: { semiMajorAxisKm: 3796.19, eccentricity: 0, inclinationDeg: 93, raanDeg: 30, argPeriapsisDeg: 0, trueAnomalyDeg: 0, epoch: "2029-01-15T00:00:00Z" },
      spacecraft: {
        name: "Weather Relay Orbiter",
        busDryMassKg: 320,
        busCostMusd: 95,
        dataStorageGb: 256,
        components: [
          { id: "sp1", type: "solar_panel", name: "Solar array wing A", massKg: 14, areaM2: 3.5, efficiency: 0.295, pointingLoss: 0.1, degradationPerYear: 0.015, costMusd: 5 },
          { id: "bat1", type: "battery", name: "Li-ion battery", massKg: 12, capacityWh: 1500, maxDepthOfDischarge: 0.4, costMusd: 2.8 },
          { id: "ant1", type: "antenna", name: "X-band HGA 1.5 m", massKg: 14, frequencyGHz: 8.45, diameterM: 1.5, txPowerW: 50, dcPowerW: 160, dutyCycle: 0.3, dataRateBps: 20000, otherLossesDb: 3, requiredEbN0Db: 4.5, costMusd: 9 },
          { id: "avionics", type: "load", name: "Avionics and thermal", massKg: 30, powerW: 170, dutyCycle: 1, costMusd: 0 },
        ],
      },
      groundStation: DSN_34M,
      scene: { nodes: [] },
      assets: [],
      scripts: [],
    },
    objectives: [
      { id: "weather", title: "Image the weather", description: "Carry a camera for daily global imaging.", category: "science", weight: 14, metric: { type: "instrument", kind: "camera" }, zeroAt: 0, fullAt: 1, unit: "" },
      { id: "thermal", title: "Map temperature", description: "Carry a thermal imager.", category: "science", weight: 12, metric: { type: "instrument", kind: "thermal_imager" }, zeroAt: 0, fullAt: 1, unit: "" },
      { id: "polar", title: "See the polar caps", description: "Coverage to at least 85° latitude.", category: "science", weight: 8, metric: { type: "derived", node: "science.return", field: "maxCoverageLatitudeDeg" }, zeroAt: 60, fullAt: 85, unit: "°" },
      { id: "data", title: "Return the data", description: "Return at least 1.5 Gbit per day at the mission date's Earth range.", category: "science", weight: 16, metric: { type: "derived", node: "science.return", field: "totalReturnedGbPerDay" }, zeroAt: 0.1, fullAt: 1.5, unit: "Gb/day" },
      { id: "power", title: "Power margin", description: "Generation exceeds load by 20% in worst-case eclipse.", category: "engineering", weight: 10, metric: { type: "derived", node: "power.budget", field: "marginFraction" }, zeroAt: 0, fullAt: 0.2, unit: "×load" },
      { id: "battery", title: "Battery health", description: "Depth of discharge at or below 30%.", category: "engineering", weight: 6, metric: { type: "derived", node: "power.budget", field: "depthOfDischarge" }, zeroAt: 0.6, fullAt: 0.3, unit: "" },
      { id: "link", title: "Link margin", description: "Deep-space link closes with 3 dB of margin.", category: "engineering", weight: 10, metric: { type: "derived", node: "comms.link", field: "worstMarginDb" }, zeroAt: -3, fullAt: 3, unit: "dB" },
      { id: "survive", title: "Through conjunction and aphelion", description: "No more than 5 days of negative power margin across a Mars year.", category: "engineering", weight: 6, metric: { type: "simulation", field: "daysPowerNegative" }, zeroAt: 60, fullAt: 5, unit: "days" },
      { id: "mass", title: "Mass margin", description: "Hold 10% of the launch mass allocation in reserve.", category: "programmatic", weight: 8, metric: { type: "derived", node: "mass.budget", field: "marginFraction" }, zeroAt: 0, fullAt: 0.1, unit: "×limit" },
      { id: "cost", title: "Cost margin", description: "Finish with 8% of the budget unspent.", category: "programmatic", weight: 10, metric: { type: "derived", node: "cost.budget", field: "marginFraction" }, zeroAt: 0, fullAt: 0.08, unit: "×budget" },
    ],
  },
];

export const getScenario = (id: string): Scenario | undefined => SCENARIOS.find((s) => s.id === id);

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIFFICULTY: Record<Difficulty, { budget: number; mass: number; label: string }> = {
  cadet: { budget: 1.12, mass: 1.08, label: "Cadet" },
  engineer: { budget: 1.0, mass: 1.0, label: "Engineer" },
  chief: { budget: 0.92, mass: 0.95, label: "Chief Engineer" },
};

export function generateMission(scenarioId: string, seed: number, difficulty: Difficulty = "engineer"): GeneratedMission {
  const scenario = getScenario(scenarioId);
  if (!scenario) throw new Error(`Unknown scenario "${scenarioId}"`);
  const random = rng(seed);
  const cfg = structuredClone(scenario.baseConfig);
  const d = DIFFICULTY[difficulty];
  const vary = (span: number): number => 1 + (random() * 2 - 1) * span;
  const round = (v: number, step: number): number => Math.round(v / step) * step;

  cfg.meta.budgetMusd = round(cfg.meta.budgetMusd! * d.budget * vary(0.05), cfg.meta.budgetMusd! > 50 ? 1 : 0.05);
  cfg.meta.massLimitKg = round(cfg.meta.massLimitKg! * d.mass * vary(0.04), cfg.meta.massLimitKg! > 50 ? 1 : 0.1);
  // Launch date within a year of the nominal one: changes Sun geometry, eclipse season and Earth range.
  const start = new Date(Date.parse(cfg.missionTime) + Math.floor(random() * 365) * 86400000).toISOString().replace(".000Z", "Z");
  cfg.missionTime = start;
  cfg.orbit.epoch = start;
  cfg.orbit.raanDeg = round(random() * 359, 1);

  const complications: { id: string; title: string; description: string; apply(): void }[] = [
    { id: "nominal", title: "Nominal programme", description: "No programme complications. Margins are yours to lose.", apply: () => {} },
    { id: "station", title: "Ground station downgrade", description: "The primary station is committed elsewhere; a smaller aperture with 6 dB less gain is assigned.", apply: () => { cfg.groundStation.antennaGainDbi -= 6; cfg.groundStation.name = `${cfg.groundStation.name} (backup aperture)`; } },
    { id: "aged-cells", title: "Flight-spare solar cells", description: "Arrays are built from flight spares with two years of storage degradation.", apply: () => { cfg.meta.yearsInService = 2; } },
    { id: "extended", title: "Extended mission", description: "The sponsor asks for a 25% longer mission on the same budget.", apply: () => { cfg.meta.missionDurationDays = Math.round(cfg.meta.missionDurationDays! * 1.25); } },
  ];
  if (cfg.rover) complications.push({ id: "steep-site", title: "Steeper landing site", description: "New terrain data puts the rover's route on a steeper slope.", apply: () => { cfg.rover!.site.slopeDeg = round(14 + random() * 5, 0.5); } });
  const complication = difficulty === "cadet" ? complications[0]! : complications[Math.floor(random() * complications.length)]!;
  complication.apply();
  cfg.meta.description = `${cfg.meta.description ?? ""} Complication: ${complication.title}.`.trim();

  const parsed = parseMissionConfig(cfg);
  if (!parsed.ok) throw new Error(`Scenario "${scenarioId}" produced an invalid mission: ${parsed.issues.join("; ")}`);
  return { scenarioId, seed, difficulty, config: parsed.config, objectives: scenario.objectives, complication: { id: complication.id, title: complication.title, description: complication.description } };
}

/** Instantiate a catalogue item as a component with an id that is unused in the mission. */
export function instantiateCatalogItem(scenarioId: string, itemId: string, config: MissionConfig): { item: CatalogItem; component: Component } {
  const item = getScenario(scenarioId)?.catalog.find((c) => c.id === itemId);
  if (!item) throw new Error(`Catalogue item "${itemId}" is not available in this mission`);
  const used = new Set([...config.spacecraft.components, ...(config.rover?.components ?? [])].map((c) => c.id));
  const prefix = { solar_panel: "sp", battery: "bat", antenna: "ant", load: "load", instrument: "inst" }[item.component.type];
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return { item, component: { ...item.component, id: `${prefix}${n}` } as Component };
}
