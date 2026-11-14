/**
 * Eclipse geometry and electrical power budget. Deterministic calculations.
 * Eclipse model: cylindrical shadow, circular orbit of radius = semi-major axis
 * (standard beta-angle formulation, e.g. Wertz, "Space Mission Engineering", §11).
 */
import { type BodyId, BODIES } from "./orbital.js";
import { type Vec3, dot } from "./ephemeris.js";

const DEG = Math.PI / 180;
export const SOLAR_CONSTANT_W_M2 = 1361; // at 1 AU (Kopp & Lean 2011)

/** Unit normal of the orbit plane in the frame the elements are referenced to. */
export function orbitNormal(inclinationDeg: number, raanDeg: number): Vec3 {
  const i = inclinationDeg * DEG;
  const O = raanDeg * DEG;
  return [Math.sin(i) * Math.sin(O), -Math.sin(i) * Math.cos(O), Math.cos(i)];
}

export interface BetaAngleResult {
  betaDeg: number;
  assumptions: string[];
}

/**
 * Solar beta angle: angle between the Sun direction and the orbit plane.
 * Orbit elements are referenced to the central body's equator; the Sun vector must be
 * expressed in the same frame, which this function selects per body.
 */
export function betaAngle(
  body: BodyId,
  inclinationDeg: number,
  raanDeg: number,
  sun: { directionEquatorial: Vec3; directionEcliptic: Vec3 },
): BetaAngleResult {
  const n = orbitNormal(inclinationDeg, raanDeg);
  if (body === "earth") {
    return { betaDeg: Math.asin(dot(n, sun.directionEquatorial)) / DEG, assumptions: [] };
  }
  if (body === "moon") {
    return {
      betaDeg: Math.asin(dot(n, sun.directionEcliptic)) / DEG,
      assumptions: ["Lunar equator approximated by the ecliptic plane (true inclination 1.54°)"],
    };
  }
  return {
    betaDeg: 0,
    assumptions: [
      "Beta angle not computed for Mars (requires the Mars pole orientation); worst case beta = 0° (longest eclipse) assumed",
    ],
  };
}

/** Fraction of the orbit period spent in umbra (cylindrical shadow, circular orbit). */
export function eclipseFraction(body: BodyId, orbitRadiusKm: number, betaDeg: number): number {
  const R = BODIES[body].radiusKm;
  if (orbitRadiusKm <= R) throw new RangeError("orbit radius must exceed body radius");
  const beta = betaDeg * DEG;
  if (Math.abs(Math.sin(beta)) >= R / orbitRadiusKm) return 0;
  const x = Math.sqrt(orbitRadiusKm ** 2 - R ** 2) / (orbitRadiusKm * Math.cos(beta));
  return Math.acos(Math.min(1, x)) / Math.PI;
}

export const solarFluxWM2 = (sunDistanceAu: number): number => SOLAR_CONSTANT_W_M2 / sunDistanceAu ** 2;

export interface SolarPanelSpec {
  areaM2: number;
  efficiency: number; // 0..1, beginning of life
  /** Fractional loss for pointing/cosine, 0 = always normal to the Sun. */
  pointingLoss: number;
  /** Fractional degradation per year. */
  degradationPerYear: number;
}

export function panelPowerW(panel: SolarPanelSpec, sunDistanceAu: number, yearsInService = 0): number {
  return (
    solarFluxWM2(sunDistanceAu) *
    panel.areaM2 *
    panel.efficiency *
    (1 - panel.pointingLoss) *
    (1 - panel.degradationPerYear) ** yearsInService
  );
}

export interface PowerBudgetInput {
  panels: SolarPanelSpec[];
  loads: { name: string; powerW: number; dutyCycle: number }[];
  batteryCapacityWh: number;
  batteryMaxDepthOfDischarge: number; // 0..1
  sunDistanceAu: number;
  eclipseFraction: number;
  orbitPeriodS: number;
  yearsInService?: number;
}

export interface PowerBudgetResult {
  sunlitGenerationW: number;
  orbitAverageGenerationW: number;
  averageLoadW: number;
  marginW: number;
  eclipseDurationS: number;
  eclipseEnergyWh: number;
  depthOfDischarge: number | null; // null when there is no battery
  batteryAdequate: boolean;
  positiveMargin: boolean;
}

export function powerBudget(input: PowerBudgetInput): PowerBudgetResult {
  const sunlit = input.panels.reduce((s, p) => s + panelPowerW(p, input.sunDistanceAu, input.yearsInService ?? 0), 0);
  const avgGen = sunlit * (1 - input.eclipseFraction);
  const avgLoad = input.loads.reduce((s, l) => s + l.powerW * l.dutyCycle, 0);
  const eclipseS = input.eclipseFraction * input.orbitPeriodS;
  const eclipseWh = (avgLoad * eclipseS) / 3600;
  const dod = input.batteryCapacityWh > 0 ? eclipseWh / input.batteryCapacityWh : null;
  return {
    sunlitGenerationW: sunlit,
    orbitAverageGenerationW: avgGen,
    averageLoadW: avgLoad,
    marginW: avgGen - avgLoad,
    eclipseDurationS: eclipseS,
    eclipseEnergyWh: eclipseWh,
    depthOfDischarge: dod,
    batteryAdequate: eclipseWh === 0 || (dod !== null && dod <= input.batteryMaxDepthOfDischarge),
    positiveMargin: avgGen - avgLoad >= 0,
  };
}

export interface PowerTimelineInput extends PowerBudgetInput {
  orbits: number;
  stepS: number;
  initialStateOfCharge: number; // 0..1
  chargeEfficiency: number; // 0..1
}

export interface PowerTimelineResult {
  minStateOfCharge: number;
  finalStateOfCharge: number;
  energyBalancedPerOrbit: boolean;
  batteryDepleted: boolean;
  samples: { tS: number; inEclipse: boolean; stateOfCharge: number; netPowerW: number }[];
  steps: number;
}

/**
 * Time-stepped battery state-of-charge simulation over N orbits. The eclipse arc is
 * centred on the anti-Sun point of the orbit; loads are applied at their duty-cycle average.
 */
export function simulatePowerTimeline(input: PowerTimelineInput): PowerTimelineResult {
  if (!(input.stepS > 0) || !(input.orbits > 0)) throw new RangeError("stepS and orbits must be > 0");
  const total = input.orbits * input.orbitPeriodS;
  const steps = Math.ceil(total / input.stepS);
  if (steps > 2_000_000) throw new RangeError("simulation too long: reduce orbits or increase stepS");
  if (!(input.batteryCapacityWh > 0)) throw new RangeError("simulation requires a battery (capacity > 0)");
  const sunlit = input.panels.reduce((s, p) => s + panelPowerW(p, input.sunDistanceAu, input.yearsInService ?? 0), 0);
  const load = input.loads.reduce((s, l) => s + l.powerW * l.dutyCycle, 0);
  const halfArc = input.eclipseFraction / 2; // fraction of the orbit either side of the anti-Sun point
  let energyWh = input.initialStateOfCharge * input.batteryCapacityWh;
  let minSoc = input.initialStateOfCharge;
  let depleted = false;
  const sampleEvery = Math.max(1, Math.floor(steps / 400));
  const samples: PowerTimelineResult["samples"] = [];
  let socAtOrbitStart = energyWh;
  let balanced = true;
  for (let k = 0; k < steps; k++) {
    const t = k * input.stepS;
    const phase = (t / input.orbitPeriodS) % 1; // 0 = sub-solar point, 0.5 = anti-Sun point
    const inEclipse = Math.abs(phase - 0.5) < halfArc;
    const net = (inEclipse ? 0 : sunlit) - load;
    const dWh = (net * input.stepS) / 3600;
    energyWh += dWh > 0 ? dWh * input.chargeEfficiency : dWh;
    if (energyWh > input.batteryCapacityWh) energyWh = input.batteryCapacityWh;
    if (energyWh <= 0) {
      energyWh = 0;
      depleted = true;
    }
    const soc = energyWh / input.batteryCapacityWh;
    if (soc < minSoc) minSoc = soc;
    if (k % sampleEvery === 0) samples.push({ tS: t, inEclipse, stateOfCharge: soc, netPowerW: net });
    const nextPhase = (((k + 1) * input.stepS) / input.orbitPeriodS) % 1;
    if (nextPhase < phase) {
      // Completed an orbit: energy must not trend downward once the battery is off its cap.
      if (energyWh < socAtOrbitStart - 1e-9) balanced = false;
      socAtOrbitStart = energyWh;
    }
  }
  return {
    minStateOfCharge: minSoc,
    finalStateOfCharge: energyWh / input.batteryCapacityWh,
    energyBalancedPerOrbit: balanced && !depleted,
    batteryDepleted: depleted,
    samples,
    steps,
  };
}
