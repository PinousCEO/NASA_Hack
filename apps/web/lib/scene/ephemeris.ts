/**
 * Where things are at a given moment: the Sun and the Earth as seen from the mission's world,
 * how that world is turned, and (for the Moon) its phase as seen from Earth.
 *
 * This runs in the browser so the scene can follow the clock every frame while someone turns
 * the Moon. The Sun model is the same one the platform's engineering models use
 * (src/science/ephemeris.ts): JPL's approximate Keplerian elements, good to arcminutes for
 * 1800–2050. The Moon's position is the Astronomical Almanac's low-precision series (about
 * 0.3° in longitude). Rotation uses the IAU mean rotation rates. This is for showing light and
 * geometry; numbers the mission is scored on always come from the server.
 */
export type Body = "earth" | "moon" | "mars";
export type Vec3 = [number, number, number];

const DEG = Math.PI / 180;
const OBLIQUITY = 23.43928 * DEG;
export const AU_KM = 149597870.7;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const daysJ2000 = (ms: number): number => (ms - J2000_MS) / 86400000;

interface Elements { a: [number, number]; e: [number, number]; I: [number, number]; L: [number, number]; wBar: [number, number]; O: [number, number] }
const ELEMENTS: Record<"earth" | "mars", Elements> = {
  earth: { a: [1.00000261, 0.00000562], e: [0.01671123, -0.00004392], I: [-0.00001531, -0.01294668], L: [100.46457166, 35999.37244981], wBar: [102.93768193, 0.32327364], O: [0, 0] },
  mars: { a: [1.52371034, 0.00001847], e: [0.0933941, 0.00007882], I: [1.84969142, -0.00813131], L: [-4.55343205, 19140.30268499], wBar: [-23.94362959, 0.44441088], O: [49.55953891, -0.29257343] },
};

function kepler(M: number, e: number): number {
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 12; i++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  return E;
}

/** Heliocentric position, J2000 ecliptic frame, AU. */
function heliocentric(body: "earth" | "mars", ms: number): Vec3 {
  const T = daysJ2000(ms) / 36525;
  const el = ELEMENTS[body];
  const at = (p: [number, number]): number => p[0] + p[1] * T;
  const [a, e, I, wBar, O] = [at(el.a), at(el.e), at(el.I) * DEG, at(el.wBar), at(el.O)];
  const w = (wBar - O) * DEG;
  let M = (at(el.L) - wBar) % 360;
  if (M > 180) M -= 360;
  if (M < -180) M += 360;
  const E = kepler(M * DEG, e);
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const On = O * DEG;
  const [cw, sw, cO, sO, cI, sI] = [Math.cos(w), Math.sin(w), Math.cos(On), Math.sin(On), Math.cos(I), Math.sin(I)];
  return [(cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp, (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp, sw * sI * xp + cw * sI * yp];
}

/** Geocentric position of the Moon, J2000 ecliptic frame, km (Astronomical Almanac low-precision series). */
function moonGeocentric(ms: number): Vec3 {
  const T = daysJ2000(ms) / 36525;
  const s = (deg: number): number => Math.sin(deg * DEG);
  const c = (deg: number): number => Math.cos(deg * DEG);
  const lon = 218.32 + 481267.881 * T + 6.29 * s(135.0 + 477198.87 * T) - 1.27 * s(259.3 - 413335.36 * T) + 0.66 * s(235.7 + 890534.22 * T) + 0.21 * s(269.9 + 954397.74 * T) - 0.19 * s(357.5 + 35999.05 * T) - 0.11 * s(186.5 + 966404.03 * T);
  const lat = 5.13 * s(93.3 + 483202.02 * T) + 0.28 * s(228.2 + 960400.89 * T) - 0.28 * s(318.3 + 6003.15 * T) - 0.17 * s(217.6 - 407332.21 * T);
  const parallax = 0.9508 + 0.0518 * c(135.0 + 477198.87 * T) + 0.0095 * c(259.3 - 413335.36 * T) + 0.0078 * c(235.7 + 890534.22 * T) + 0.0028 * c(269.9 + 954397.74 * T);
  const r = 6378.14 / Math.sin(parallax * DEG);
  return [r * c(lat) * c(lon), r * c(lat) * s(lon), r * s(lat)];
}

const toEquatorial = (v: Vec3): Vec3 => [v[0], Math.cos(OBLIQUITY) * v[1] - Math.sin(OBLIQUITY) * v[2], Math.sin(OBLIQUITY) * v[1] + Math.cos(OBLIQUITY) * v[2]];
const unit = (v: Vec3): Vec3 => { const n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; };
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

export interface Sky {
  /**
   * Unit vector from the body to the Sun, in the frame the engineering models use for that body's equator:
   * J2000 Earth-equatorial for the Earth, the ecliptic for the Moon (its equator is 1.54° from it), and
   * J2000 Earth-equatorial for Mars as an approximation (the models do not orient Mars' pole).
   */
  sun: Vec3;
  sunDistanceAu: number;
  /** Unit vector from the body to the Earth (null when the body is the Earth). */
  earth: Vec3 | null;
  earthDistanceKm: number;
  /** Direction the body's prime meridian (longitude 0) faces, in the equatorial plane of the same frame. */
  primeMeridian: Vec3;
  /** For the Moon: the fraction of its Earth-facing disc that is lit (0 new, 1 full) and whether it is growing. */
  moonPhase: { illuminated: number; waxing: boolean; name: string } | null;
}

/** The sky of a mission's world at an instant. */
export function skyAt(body: Body, ms: number): Sky {
  const earthHelio = heliocentric("earth", ms);
  const d = daysJ2000(ms);
  if (body === "mars") {
    const mars = heliocentric("mars", ms);
    const toEarth = sub(earthHelio, mars);
    // IAU: W = 176.630 + 350.89198226 d, measured from the node of Mars' equator at right ascension α0 + 90°.
    const angle = (317.68143 + 90 + 176.63 + 350.89198226 * d) * DEG;
    return { sun: toEquatorial(unit([-mars[0], -mars[1], -mars[2]])), sunDistanceAu: Math.hypot(...mars), earth: toEquatorial(unit(toEarth)), earthDistanceKm: Math.hypot(...toEarth) * AU_KM, primeMeridian: [Math.cos(angle), Math.sin(angle), 0], moonPhase: null };
  }
  const sun = toEquatorial(unit([-earthHelio[0], -earthHelio[1], -earthHelio[2]]));
  const sunDistanceAu = Math.hypot(...earthHelio);
  if (body === "earth") {
    // Greenwich mean sidereal angle.
    const angle = (280.46061837 + 360.98564736629 * d) * DEG;
    return { sun, sunDistanceAu, earth: null, earthDistanceKm: 0, primeMeridian: [Math.cos(angle), Math.sin(angle), 0], moonPhase: null };
  }
  const moon = moonGeocentric(ms);
  // The Moon's sky is kept in the ecliptic frame, like the eclipse model: its pole is then the scene's pole,
  // so the lighting at the lunar poles is the grazing light it really is.
  const sunFromMoon = unit([-earthHelio[0], -earthHelio[1], -earthHelio[2]]);
  const toEarth = unit([-moon[0], -moon[1], -moon[2]]);
  // Phase: the Sun–Moon–Earth angle. Lit fraction of the Earth-facing disc = (1 + cos(angle)) / 2.
  const cosPhase = sunFromMoon[0] * toEarth[0] + sunFromMoon[1] * toEarth[1] + sunFromMoon[2] * toEarth[2];
  const illuminated = (1 + cosPhase) / 2;
  const T = d / 36525;
  const elongation = (((297.85 + 445267.1115 * T) % 360) + 360) % 360; // mean elongation of the Moon from the Sun
  const waxing = elongation < 180;
  const name = illuminated < 0.03 ? "New Moon" : illuminated > 0.97 ? "Full Moon" : Math.abs(illuminated - 0.5) < 0.06 ? (waxing ? "First quarter" : "Last quarter") : illuminated < 0.5 ? (waxing ? "Waxing crescent" : "Waning crescent") : waxing ? "Waxing gibbous" : "Waning gibbous";
  // Tidally locked: longitude 0 faces the Earth (the monthly wobble of a few degrees is left out).
  const flat = unit([toEarth[0], toEarth[1], 0]);
  return { sun: sunFromMoon, sunDistanceAu, earth: toEarth, earthDistanceKm: Math.hypot(...moon), primeMeridian: flat, moonPhase: { illuminated, waxing, name } };
}

/** Seconds for one turn of the body under the stars: how much time passes when it is turned once by hand. */
export const SPIN_PERIOD_S: Record<Body, number> = { earth: 86164.1, moon: 27.321661 * 86400, mars: 88642.66 };
