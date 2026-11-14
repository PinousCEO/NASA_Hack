/**
 * Planetary digital elevation models from the NASA Planetary Data System (PDS Geosciences Node).
 *
 *   moon  LRO LOLA gridded data record LDEM_4   — 4 px/deg, heights relative to a 1737.4 km sphere
 *   mars  MGS MOLA MEGDR megt90n000cb          — 4 px/deg, heights relative to the areoid
 *
 * Both are global simple-cylindrical grids of 1440 × 720 signed 16-bit samples, north at the
 * top, longitude 0…360°E. A product is fetched once, cached on disk and held in memory.
 *
 * Resolution is about 7.6 km (Moon) and 14.8 km (Mars) per pixel at the equator, so everything
 * derived here is REGIONAL: it says nothing about rocks, craters or slopes at lander scale.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CapabilityError } from "../core/types.js";

export type TerrainBody = "moon" | "mars";

interface DemProduct {
  body: TerrainBody;
  id: string;
  title: string;
  url: string;
  file: string;
  width: number;
  height: number;
  littleEndian: boolean;
  /** Metres per digital number. */
  scaleM: number;
  referenceRadiusKm: number;
  datum: string;
  credit: string;
}

export const DEM_PRODUCTS: Record<TerrainBody, DemProduct> = {
  moon: {
    body: "moon",
    id: "LRO-L-LOLA-4-GDR-V1.0 / LDEM_4",
    title: "LRO LOLA gridded lunar topography, 4 pixels per degree",
    url: "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/ldem_4.img",
    file: "ldem_4.img",
    width: 1440,
    height: 720,
    littleEndian: true,
    scaleM: 0.5,
    referenceRadiusKm: 1737.4,
    datum: "height above a 1737.4 km reference sphere",
    credit: "NASA/GSFC/MIT — Lunar Orbiter Laser Altimeter (LOLA), PDS Geosciences Node",
  },
  mars: {
    body: "mars",
    id: "MGS-M-MOLA-5-MEGDR-L3-V1.0 / megt90n000cb",
    title: "MGS MOLA mission experiment gridded data record, 4 pixels per degree",
    url: "https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg004/megt90n000cb.img",
    file: "megt90n000cb.img",
    width: 1440,
    height: 720,
    littleEndian: false,
    scaleM: 1,
    referenceRadiusKm: 3396.19,
    datum: "height above the MOLA areoid (Mars equipotential surface)",
    credit: "NASA/GSFC — Mars Orbiter Laser Altimeter (MOLA), PDS Geosciences Node",
  },
};

export interface TerrainGrid {
  product: DemProduct;
  width: number;
  height: number;
  /** Heights in metres, row 0 at the north pole, column 0 at 0°E. */
  heightsM: Float32Array;
  minM: number;
  maxM: number;
}

export interface TerrainSurvey {
  body: TerrainBody;
  latDeg: number;
  lonDeg: number;
  elevationM: number;
  /** Slope of the least-squares plane through a ring of samples `baselineKm` across. */
  regionalSlopeDeg: number;
  /** Downhill direction, degrees clockwise from north. */
  downhillAzimuthDeg: number;
  baselineKm: number;
  minM: number;
  maxM: number;
  reliefM: number;
  roughnessRmsM: number;
  resolutionKmPerPixel: number;
  product: string;
  datum: string;
  credit: string;
  caveats: string[];
}

const RAD = Math.PI / 180;

/** Point reached from (lat, lon) after travelling `angular` radians on bearing `bearing`. */
function destination(latDeg: number, lonDeg: number, bearing: number, angular: number): [number, number] {
  const lat1 = latDeg * RAD;
  const lon1 = lonDeg * RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1), Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2));
  return [lat2 / RAD, lon2 / RAD];
}

export class TerrainService {
  private grids = new Map<TerrainBody, Promise<TerrainGrid>>();

  /** @param cacheDir where downloaded products are kept; `null` keeps them in memory only. */
  constructor(private readonly cacheDir: string | null, private readonly fetchImpl: typeof fetch = fetch) {}

  grid(body: TerrainBody): Promise<TerrainGrid> {
    let pending = this.grids.get(body);
    if (!pending) {
      pending = this.load(body);
      this.grids.set(body, pending);
      // A failed download must not poison the cache: the next call tries again.
      pending.catch(() => this.grids.delete(body));
    }
    return pending;
  }

  private async load(body: TerrainBody): Promise<TerrainGrid> {
    const product = DEM_PRODUCTS[body];
    const expected = product.width * product.height * 2;
    const cached = this.cacheDir ? path.join(this.cacheDir, product.file) : null;
    let bytes: Buffer | null = null;
    if (cached && existsSync(cached)) {
      const onDisk = readFileSync(cached);
      if (onDisk.length === expected) bytes = onDisk;
    }
    if (!bytes) {
      let response: Response;
      try {
        response = await this.fetchImpl(product.url, { signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        throw new CapabilityError(`Could not reach the PDS Geosciences Node for ${product.id}: ${err instanceof Error ? err.message : String(err)}`, { code: "dem_network", retryable: true });
      }
      if (!response.ok) throw new CapabilityError(`PDS returned HTTP ${response.status} for ${product.id}`, { code: "dem_http", retryable: response.status >= 500 });
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== expected) throw new CapabilityError(`${product.id}: expected ${expected} bytes, received ${bytes.length}`, { code: "dem_format" });
      if (cached) {
        mkdirSync(path.dirname(cached), { recursive: true });
        writeFileSync(cached, bytes);
      }
    }
    const heightsM = new Float32Array(product.width * product.height);
    let minM = Infinity;
    let maxM = -Infinity;
    for (let i = 0; i < heightsM.length; i++) {
      const h = (product.littleEndian ? bytes.readInt16LE(i * 2) : bytes.readInt16BE(i * 2)) * product.scaleM;
      heightsM[i] = h;
      if (h < minM) minM = h;
      if (h > maxM) maxM = h;
    }
    return { product, width: product.width, height: product.height, heightsM, minM, maxM };
  }

  /** Bilinear elevation (m). Pixel centres sit at half-pixel offsets from the grid edges. */
  static sample(grid: TerrainGrid, latDeg: number, lonDeg: number): number {
    const lat = Math.max(-90, Math.min(90, latDeg));
    const lon = ((lonDeg % 360) + 360) % 360;
    const fx = (lon / 360) * grid.width - 0.5;
    const fy = ((90 - lat) / 180) * grid.height - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.max(0, Math.min(grid.height - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(grid.height - 1, y0 + 1));
    const tx = fx - x0;
    const ty = Math.max(0, Math.min(1, fy - y0));
    const at = (x: number, y: number): number => grid.heightsM[y * grid.width + (((x % grid.width) + grid.width) % grid.width)]!;
    return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x0 + 1, y1) * tx) * ty;
  }

  async elevationM(body: TerrainBody, latDeg: number, lonDeg: number): Promise<number> {
    return TerrainService.sample(await this.grid(body), latDeg, lonDeg);
  }

  /**
   * Regional description of a site. Slope comes from a least-squares plane through samples
   * on great-circle rings around the site, which stays well-conditioned at the poles where
   * the cylindrical grid converges.
   */
  async survey(body: TerrainBody, latDeg: number, lonDeg: number, radiusKm?: number): Promise<TerrainSurvey> {
    const grid = await this.grid(body);
    const product = grid.product;
    const resolutionKm = (2 * Math.PI * product.referenceRadiusKm) / grid.width;
    const radius = Math.max(resolutionKm, radiusKm ?? resolutionKm * 2);
    const centre = TerrainService.sample(grid, latDeg, lonDeg);
    const samples: { e: number; n: number; h: number }[] = [{ e: 0, n: 0, h: centre }];
    for (const fraction of [0.5, 1]) {
      for (let k = 0; k < 16; k++) {
        const bearing = (k / 16) * Math.PI * 2;
        const r = radius * fraction;
        const [la, lo] = destination(latDeg, lonDeg, bearing, r / product.referenceRadiusKm);
        samples.push({ e: Math.sin(bearing) * r * 1000, n: Math.cos(bearing) * r * 1000, h: TerrainService.sample(grid, la, lo) });
      }
    }
    // Plane h = a·e + b·n + c. The sample pattern is symmetric, so the normal equations decouple.
    const see = samples.reduce((s, p) => s + p.e * p.e, 0);
    const snn = samples.reduce((s, p) => s + p.n * p.n, 0);
    const a = samples.reduce((s, p) => s + p.e * p.h, 0) / see;
    const b = samples.reduce((s, p) => s + p.n * p.h, 0) / snn;
    const c = samples.reduce((s, p) => s + p.h, 0) / samples.length;
    const residual = Math.sqrt(samples.reduce((s, p) => s + (p.h - (a * p.e + b * p.n + c)) ** 2, 0) / samples.length);
    const heights = samples.map((p) => p.h);
    const minM = Math.min(...heights);
    const maxM = Math.max(...heights);
    return {
      body,
      latDeg,
      lonDeg,
      elevationM: centre,
      regionalSlopeDeg: Math.atan(Math.hypot(a, b)) / RAD,
      downhillAzimuthDeg: ((Math.atan2(-a, -b) / RAD) + 360) % 360,
      baselineKm: radius * 2,
      minM,
      maxM,
      reliefM: maxM - minM,
      roughnessRmsM: residual,
      resolutionKmPerPixel: resolutionKm,
      product: product.id,
      datum: product.datum,
      credit: product.credit,
      caveats: [
        `Grid resolution is ${resolutionKm.toFixed(1)} km per pixel: the slope is a regional trend over a ${(radius * 2).toFixed(0)} km baseline, not a slope a rover or lander would experience`,
        "Elevations are bilinearly interpolated between grid cells",
      ],
    };
  }

  /** Square patch of heights centred on a site (row 0 = north), for local terrain analysis. */
  async patch(body: TerrainBody, latDeg: number, lonDeg: number, sizeKm: number, samples: number): Promise<{ heightsM: number[][]; cellSizeM: number }> {
    const grid = await this.grid(body);
    const R = grid.product.referenceRadiusKm;
    const step = sizeKm / (samples - 1);
    const heightsM: number[][] = [];
    for (let row = 0; row < samples; row++) {
      const north = sizeKm / 2 - row * step;
      const line: number[] = [];
      for (let col = 0; col < samples; col++) {
        const east = -sizeKm / 2 + col * step;
        const distance = Math.hypot(east, north);
        const [la, lo] = distance === 0 ? [latDeg, lonDeg] : destination(latDeg, lonDeg, Math.atan2(east, north), distance / R);
        line.push(Math.round(TerrainService.sample(grid, la, lo) * 10) / 10);
      }
      heightsM.push(line);
    }
    return { heightsM, cellSizeM: step * 1000 };
  }

  /** Whole-body heights as little-endian int16 metres, optionally decimated, for rendering relief. */
  async raster(body: TerrainBody, width: number): Promise<{ width: number; height: number; data: Buffer; minM: number; maxM: number }> {
    const grid = await this.grid(body);
    const w = Math.max(90, Math.min(grid.width, Math.round(width)));
    const h = Math.round(w / 2);
    const data = Buffer.alloc(w * h * 2);
    for (let y = 0; y < h; y++) {
      const lat = 90 - ((y + 0.5) / h) * 180;
      for (let x = 0; x < w; x++) {
        const value = w === grid.width ? grid.heightsM[y * grid.width + x]! : TerrainService.sample(grid, lat, ((x + 0.5) / w) * 360);
        data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value))), (y * w + x) * 2);
      }
    }
    return { width: w, height: h, data, minM: grid.minM, maxM: grid.maxM };
  }
}
