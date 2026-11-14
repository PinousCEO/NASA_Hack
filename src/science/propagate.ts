/**
 * Numerical orbit propagation with the J2 zonal harmonic (RK4, fixed step), plus the
 * closed-form secular J2 rates used to cross-check it.
 *
 * This is an approximation of a full-force model: it captures nodal regression and apsidal
 * rotation, and omits higher gravity terms (significant in low lunar orbit, where mascons
 * dominate), third bodies, drag and solar radiation pressure. For those, use GMAT.
 */
import { BODIES, type BodyId, type FullOrbit } from "./orbital.js";

/** Unnormalised J2 coefficients (Earth: EGM96; Moon: GRAIL GRGM660; Mars: MRO110). */
export const J2: Record<BodyId, number> = { earth: 1.08262668e-3, moon: 2.0321e-4, mars: 1.96045e-3 };

const DEG = Math.PI / 180;
type Vec3 = [number, number, number];
type State = [number, number, number, number, number, number];

export function elementsToState(orbit: FullOrbit): { r: Vec3; v: Vec3 } {
  const mu = BODIES[orbit.body].muKm3S2;
  const { semiMajorAxisKm: a, eccentricity: e } = orbit;
  const [i, O, w, nu] = [orbit.inclinationDeg * DEG, orbit.raanDeg * DEG, orbit.argPeriapsisDeg * DEG, orbit.trueAnomalyDeg * DEG];
  const p = a * (1 - e * e);
  const rMag = p / (1 + e * Math.cos(nu));
  const rp: Vec3 = [rMag * Math.cos(nu), rMag * Math.sin(nu), 0];
  const k = Math.sqrt(mu / p);
  const vp: Vec3 = [-k * Math.sin(nu), k * (e + Math.cos(nu)), 0];
  const [cO, sO, cw, sw, ci, si] = [Math.cos(O), Math.sin(O), Math.cos(w), Math.sin(w), Math.cos(i), Math.sin(i)];
  const rot = (v: Vec3): Vec3 => [
    (cO * cw - sO * sw * ci) * v[0] + (-cO * sw - sO * cw * ci) * v[1],
    (sO * cw + cO * sw * ci) * v[0] + (-sO * sw + cO * cw * ci) * v[1],
    sw * si * v[0] + cw * si * v[1],
  ];
  return { r: rot(rp), v: rot(vp) };
}

export interface OsculatingElements {
  semiMajorAxisKm: number;
  eccentricity: number;
  inclinationDeg: number;
  raanDeg: number;
}

export function stateToElements(body: BodyId, r: Vec3, v: Vec3): OsculatingElements {
  const mu = BODIES[body].muKm3S2;
  const rMag = Math.hypot(...r);
  const v2 = v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
  const h: Vec3 = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const hMag = Math.hypot(...h);
  const rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  const eVec = [0, 1, 2].map((k) => ((v2 - mu / rMag) * r[k]! - rv * v[k]!) / mu);
  const raan = Math.atan2(h[0], -h[1]);
  return {
    semiMajorAxisKm: 1 / (2 / rMag - v2 / mu),
    eccentricity: Math.hypot(eVec[0]!, eVec[1]!, eVec[2]!),
    inclinationDeg: Math.acos(h[2] / hMag) / DEG,
    raanDeg: ((raan / DEG) % 360 + 360) % 360,
  };
}

/** First-order secular rates due to J2, degrees per day. */
export function j2SecularRates(body: BodyId, semiMajorAxisKm: number, eccentricity: number, inclinationDeg: number): { raanRateDegPerDay: number; argPeriapsisRateDegPerDay: number } {
  const { muKm3S2: mu, radiusKm: R } = BODIES[body];
  const n = Math.sqrt(mu / semiMajorAxisKm ** 3);
  const p = semiMajorAxisKm * (1 - eccentricity ** 2);
  const factor = n * J2[body] * (R / p) ** 2;
  const i = inclinationDeg * DEG;
  const toDegPerDay = (86400 * 180) / Math.PI;
  return {
    raanRateDegPerDay: -1.5 * factor * Math.cos(i) * toDegPerDay,
    argPeriapsisRateDegPerDay: 0.75 * factor * (5 * Math.cos(i) ** 2 - 1) * toDegPerDay,
  };
}

function acceleration(body: BodyId, s: State): Vec3 {
  const { muKm3S2: mu, radiusKm: R } = BODIES[body];
  const [x, y, z] = s;
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2);
  const k = -mu / (r2 * r);
  const j = (1.5 * J2[body] * mu * R * R) / (r2 * r2 * r);
  const zr = (5 * z * z) / r2;
  return [k * x - j * x * (1 - zr), k * y - j * y * (1 - zr), k * z - j * z * (3 - zr)];
}

export interface PropagationResult {
  samples: { tS: number; positionKm: Vec3; velocityKmS: Vec3 }[];
  initial: OsculatingElements;
  final: OsculatingElements;
  raanDriftDeg: number;
  minAltitudeKm: number;
  impacted: boolean;
  steps: number;
}

export function propagateJ2(orbit: FullOrbit, durationS: number, stepS: number, maxSamples = 400): PropagationResult {
  if (!(durationS > 0) || !(stepS > 0)) throw new RangeError("durationS and stepS must be > 0");
  const steps = Math.ceil(durationS / stepS);
  if (steps > 3_000_000) throw new RangeError("propagation too long: increase stepS or reduce durationS");
  const R = BODIES[orbit.body].radiusKm;
  const { r, v } = elementsToState(orbit);
  let s: State = [r[0], r[1], r[2], v[0], v[1], v[2]];
  const deriv = (q: State): State => {
    const a = acceleration(orbit.body, q);
    return [q[3], q[4], q[5], a[0], a[1], a[2]];
  };
  const add = (q: State, d: State, h: number): State => q.map((x, k) => x + d[k]! * h) as State;
  const initial = stateToElements(orbit.body, r, v);
  const every = Math.max(1, Math.floor(steps / maxSamples));
  const samples: PropagationResult["samples"] = [];
  let minAlt = Infinity;
  let raanUnwrapped = initial.raanDeg;
  let lastRaan = initial.raanDeg;
  let impacted = false;
  let done = 0;
  for (let k = 0; k <= steps; k++) {
    const alt = Math.hypot(s[0], s[1], s[2]) - R;
    if (alt < minAlt) minAlt = alt;
    if (k % every === 0 || k === steps) {
      samples.push({ tS: k * stepS, positionKm: [s[0], s[1], s[2]], velocityKmS: [s[3], s[4], s[5]] });
      // Track RAAN continuously so drift beyond ±180° is not lost to wrapping.
      const raan = stateToElements(orbit.body, [s[0], s[1], s[2]], [s[3], s[4], s[5]]).raanDeg;
      let d = raan - lastRaan;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      raanUnwrapped += d;
      lastRaan = raan;
    }
    if (alt <= 0) {
      impacted = true;
      break;
    }
    if (k === steps) break;
    const k1 = deriv(s);
    const k2 = deriv(add(s, k1, stepS / 2));
    const k3 = deriv(add(s, k2, stepS / 2));
    const k4 = deriv(add(s, k3, stepS));
    s = s.map((x, n) => x + (stepS / 6) * (k1[n]! + 2 * k2[n]! + 2 * k3[n]! + k4[n]!)) as State;
    done++;
  }
  return {
    samples,
    initial,
    final: stateToElements(orbit.body, [s[0], s[1], s[2]], [s[3], s[4], s[5]]),
    raanDriftDeg: raanUnwrapped - initial.raanDeg,
    minAltitudeKm: minAlt,
    impacted,
    steps: done,
  };
}
