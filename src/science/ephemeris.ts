/**
 * Low-precision analytic ephemeris from JPL's "Keplerian Elements for Approximate
 * Positions of the Major Planets" (Standish, valid 1800–2050 AD).
 * https://ssd.jpl.nasa.gov/planets/approx_pos.html
 *
 * Accuracy is on the order of arcminutes — adequate for lighting, solar flux and link
 * range, not for navigation. Use the `data.horizons.vectors` capability for precise values.
 */
import { solveKepler } from "./orbital.js";

const DEG = Math.PI / 180;
export const AU_KM = 149597870.7;
export const OBLIQUITY_J2000_DEG = 23.43928;

interface ElementSet {
  a: [number, number]; // AU, AU/century
  e: [number, number];
  I: [number, number]; // deg
  L: [number, number]; // deg
  wBar: [number, number]; // longitude of perihelion, deg
  O: [number, number]; // longitude of ascending node, deg
}

const ELEMENTS: Record<"earth" | "mars", ElementSet> = {
  // Earth–Moon barycentre (differs from Earth's centre by < 4700 km)
  earth: {
    a: [1.00000261, 0.00000562],
    e: [0.01671123, -0.00004392],
    I: [-0.00001531, -0.01294668],
    L: [100.46457166, 35999.37244981],
    wBar: [102.93768193, 0.32327364],
    O: [0, 0],
  },
  mars: {
    a: [1.52371034, 0.00001847],
    e: [0.0933941, 0.00007882],
    I: [1.84969142, -0.00813131],
    L: [-4.55343205, 19140.30268499],
    wBar: [-23.94362959, 0.44441088],
    O: [49.55953891, -0.29257343],
  },
};

export type Vec3 = [number, number, number];

export function julianDate(iso: string): number {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid date: ${iso}`);
  return ms / 86400000 + 2440587.5;
}

/** Heliocentric position in the J2000 ecliptic frame, AU. */
export function heliocentricPosition(body: "earth" | "mars", iso: string): Vec3 {
  const T = (julianDate(iso) - 2451545.0) / 36525;
  const el = ELEMENTS[body];
  const at = (p: [number, number]): number => p[0] + p[1] * T;
  const a = at(el.a);
  const e = at(el.e);
  const I = at(el.I) * DEG;
  const wBar = at(el.wBar);
  const O = at(el.O);
  const w = (wBar - O) * DEG;
  let M = (at(el.L) - wBar) % 360;
  if (M > 180) M -= 360;
  if (M < -180) M += 360;
  const E = solveKepler(M * DEG, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const On = O * DEG;
  const [cw, sw, cO, sO, cI, sI] = [Math.cos(w), Math.sin(w), Math.cos(On), Math.sin(On), Math.cos(I), Math.sin(I)];
  return [
    (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
    (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
    sw * sI * xp + cw * sI * yp,
  ];
}

export const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
export const unit = (v: Vec3): Vec3 => {
  const n = norm(v);
  return [v[0] / n, v[1] / n, v[2] / n];
};
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function eclipticToEquatorial(v: Vec3): Vec3 {
  const eps = OBLIQUITY_J2000_DEG * DEG;
  return [v[0], Math.cos(eps) * v[1] - Math.sin(eps) * v[2], Math.sin(eps) * v[1] + Math.cos(eps) * v[2]];
}

export interface SunState {
  /** Distance from the central body to the Sun, AU. */
  distanceAu: number;
  /** Unit vector from the central body toward the Sun, J2000 ecliptic frame. */
  directionEcliptic: Vec3;
  /** Same vector in the J2000 Earth-equatorial frame. */
  directionEquatorial: Vec3;
  eclipticLongitudeDeg: number;
  /** Distance from Earth to the central body, km (0 for Earth). */
  earthToBodyDistanceKm: number;
  assumptions: string[];
}

export const MOON_MEAN_DISTANCE_KM = 384400;

/** Sun position as seen from a central body at a given time. */
export function sunState(centralBody: "earth" | "moon" | "mars", iso: string): SunState {
  const assumptions = ["JPL approximate Keplerian elements (arcminute-level accuracy, 1800–2050)"];
  const earth = heliocentricPosition("earth", iso);
  let bodyPos = earth;
  let earthToBodyDistanceKm = 0;
  if (centralBody === "mars") {
    bodyPos = heliocentricPosition("mars", iso);
    earthToBodyDistanceKm =
      norm([bodyPos[0] - earth[0], bodyPos[1] - earth[1], bodyPos[2] - earth[2]]) * AU_KM;
  } else if (centralBody === "moon") {
    earthToBodyDistanceKm = MOON_MEAN_DISTANCE_KM;
    assumptions.push(
      "Moon treated as co-located with the Earth–Moon barycentre for solar geometry (error < 0.3% in distance)",
      "Earth–Moon range uses the mean distance 384,400 km (actual varies 356,500–406,700 km)",
    );
  }
  const toSun: Vec3 = [-bodyPos[0], -bodyPos[1], -bodyPos[2]];
  const dir = unit(toSun);
  const lon = (Math.atan2(dir[1], dir[0]) / DEG + 360) % 360;
  return {
    distanceAu: norm(toSun),
    directionEcliptic: dir,
    directionEquatorial: eclipticToEquatorial(dir),
    eclipticLongitudeDeg: lon,
    earthToBodyDistanceKm,
    assumptions,
  };
}
