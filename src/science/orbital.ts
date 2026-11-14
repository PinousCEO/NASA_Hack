/**
 * Two-body orbital mechanics. All functions are deterministic closed-form calculations.
 * Constants: GM values from JPL DE440 (km^3/s^2); radii are IAU mean/equatorial radii.
 */
export type BodyId = "earth" | "moon" | "mars";

export interface Body {
  id: BodyId;
  muKm3S2: number;
  radiusKm: number;
  surfaceGravityMS2: number;
  /** Altitude below which an orbit is not sustainable (atmosphere), km. */
  minSafeAltitudeKm: number;
}

export const BODIES: Record<BodyId, Body> = {
  earth: { id: "earth", muKm3S2: 398600.4418, radiusKm: 6378.137, surfaceGravityMS2: 9.80665, minSafeAltitudeKm: 160 },
  moon: { id: "moon", muKm3S2: 4902.800066, radiusKm: 1737.4, surfaceGravityMS2: 1.625, minSafeAltitudeKm: 10 },
  mars: { id: "mars", muKm3S2: 42828.375214, radiusKm: 3396.19, surfaceGravityMS2: 3.72076, minSafeAltitudeKm: 120 },
};

export interface OrbitInput {
  body: BodyId;
  semiMajorAxisKm: number;
  eccentricity: number;
}

export interface OrbitElementsResult {
  periodS: number;
  meanMotionRadS: number;
  periapsisRadiusKm: number;
  apoapsisRadiusKm: number;
  periapsisAltitudeKm: number;
  apoapsisAltitudeKm: number;
  velocityPeriapsisKmS: number;
  velocityApoapsisKmS: number;
  specificEnergyKm2S2: number;
  intersectsSurface: boolean;
  belowSafeAltitude: boolean;
}

export function orbitElements(input: OrbitInput): OrbitElementsResult {
  const body = BODIES[input.body];
  const { semiMajorAxisKm: a, eccentricity: e } = input;
  if (!(a > 0)) throw new RangeError("semiMajorAxisKm must be > 0");
  if (!(e >= 0 && e < 1)) throw new RangeError("eccentricity must be in [0, 1) (closed orbits only)");
  const rp = a * (1 - e);
  const ra = a * (1 + e);
  const visViva = (r: number): number => Math.sqrt(body.muKm3S2 * (2 / r - 1 / a));
  return {
    periodS: 2 * Math.PI * Math.sqrt(a ** 3 / body.muKm3S2),
    meanMotionRadS: Math.sqrt(body.muKm3S2 / a ** 3),
    periapsisRadiusKm: rp,
    apoapsisRadiusKm: ra,
    periapsisAltitudeKm: rp - body.radiusKm,
    apoapsisAltitudeKm: ra - body.radiusKm,
    velocityPeriapsisKmS: visViva(rp),
    velocityApoapsisKmS: visViva(ra),
    specificEnergyKm2S2: -body.muKm3S2 / (2 * a),
    intersectsSurface: rp <= body.radiusKm,
    belowSafeAltitude: rp - body.radiusKm < body.minSafeAltitudeKm,
  };
}

export interface HohmannResult {
  deltaV1KmS: number;
  deltaV2KmS: number;
  totalDeltaVKmS: number;
  transferTimeS: number;
}

/** Hohmann transfer between two coplanar circular orbits of radius r1 and r2 (km). */
export function hohmannTransfer(body: BodyId, r1Km: number, r2Km: number): HohmannResult {
  const mu = BODIES[body].muKm3S2;
  if (!(r1Km > 0 && r2Km > 0)) throw new RangeError("radii must be > 0");
  const at = (r1Km + r2Km) / 2;
  const v1 = Math.sqrt(mu / r1Km);
  const v2 = Math.sqrt(mu / r2Km);
  const vt1 = Math.sqrt(mu * (2 / r1Km - 1 / at));
  const vt2 = Math.sqrt(mu * (2 / r2Km - 1 / at));
  const dv1 = Math.abs(vt1 - v1);
  const dv2 = Math.abs(v2 - vt2);
  return { deltaV1KmS: dv1, deltaV2KmS: dv2, totalDeltaVKmS: dv1 + dv2, transferTimeS: Math.PI * Math.sqrt(at ** 3 / mu) };
}

/** Solve Kepler's equation E - e sin E = M (radians) by Newton iteration. */
export function solveKepler(meanAnomalyRad: number, e: number): number {
  let E = e < 0.8 ? meanAnomalyRad : Math.PI;
  for (let i = 0; i < 50; i++) {
    const d = (E - e * Math.sin(E) - meanAnomalyRad) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  return E;
}

export interface FullOrbit extends OrbitInput {
  inclinationDeg: number;
  raanDeg: number;
  argPeriapsisDeg: number;
  /** True anomaly at `epoch`. */
  trueAnomalyDeg: number;
  epoch: string;
}

const DEG = Math.PI / 180;

/** Position (km) in the body-centred inertial frame for a given true anomaly. */
export function positionAtTrueAnomaly(orbit: FullOrbit, trueAnomalyRad: number): [number, number, number] {
  const { semiMajorAxisKm: a, eccentricity: e } = orbit;
  const r = (a * (1 - e * e)) / (1 + e * Math.cos(trueAnomalyRad));
  const u = orbit.argPeriapsisDeg * DEG + trueAnomalyRad;
  const O = orbit.raanDeg * DEG;
  const i = orbit.inclinationDeg * DEG;
  return [
    r * (Math.cos(O) * Math.cos(u) - Math.sin(O) * Math.sin(u) * Math.cos(i)),
    r * (Math.sin(O) * Math.cos(u) + Math.cos(O) * Math.sin(u) * Math.cos(i)),
    r * Math.sin(u) * Math.sin(i),
  ];
}

/** True anomaly (rad) at time `atIso`, propagating the epoch anomaly with two-body motion. */
export function trueAnomalyAt(orbit: FullOrbit, atIso: string): number {
  const e = orbit.eccentricity;
  const nu0 = orbit.trueAnomalyDeg * DEG;
  const E0 = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu0 / 2), Math.sqrt(1 + e) * Math.cos(nu0 / 2));
  const M0 = E0 - e * Math.sin(E0);
  const dt = (Date.parse(atIso) - Date.parse(orbit.epoch)) / 1000;
  if (!Number.isFinite(dt)) throw new RangeError("invalid epoch or time");
  const n = Math.sqrt(BODIES[orbit.body].muKm3S2 / orbit.semiMajorAxisKm ** 3);
  const twoPi = 2 * Math.PI;
  const M = (((M0 + n * dt) % twoPi) + twoPi) % twoPi;
  const E = solveKepler(M, e);
  return 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
}
