/**
 * Global planetary imagery from NASA map-tile services, proxied and cached on disk so the
 * web client can texture planets from the same origin (and keep working offline once warm).
 *
 *   moon         LRO LROC Wide Angle Camera global mosaic   (NASA Solar System Treks)
 *   mars         Viking MDIM 2.1 colour mosaic              (NASA Solar System Treks)
 *   earth        Blue Marble: shaded relief and bathymetry  (NASA GIBS)
 *   earth-night  VIIRS city lights 2012                     (NASA GIBS)
 *
 * Only these layers, and only coarse zoom levels, can be requested: this is not an open proxy.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ImageryLevel {
  z: number;
  cols: number;
  rows: number;
  /** Degrees of longitude (and latitude) covered by one tile. */
  degPerTile: number;
}

interface LayerSpec {
  id: string;
  title: string;
  credit: string;
  tileSize: number;
  extension: "jpg" | "jpeg";
  levels: ImageryLevel[];
  url(z: number, row: number, col: number): string;
}

/** Solar System Treks equirectangular pyramid: 2 × 1 tiles at level 0, doubling per level. */
const trekLevels = (max: number): ImageryLevel[] => Array.from({ length: max + 1 }, (_, z) => ({ z, cols: 2 << z, rows: 1 << z, degPerTile: 180 / (1 << z) }));
/** GIBS EPSG:4326 "500m" pyramid: 288° tiles at level 0, halving per level; edge tiles overhang the globe. */
const gibsLevels = (max: number): ImageryLevel[] => Array.from({ length: max + 1 }, (_, z) => {
  const degPerTile = 288 / (1 << z);
  return { z, cols: Math.ceil(360 / degPerTile), rows: Math.ceil(180 / degPerTile), degPerTile };
});

const LAYERS: LayerSpec[] = [
  {
    id: "moon",
    title: "LRO LROC WAC global mosaic",
    credit: "NASA/GSFC/Arizona State University (LROC), via NASA Solar System Treks",
    tileSize: 256,
    extension: "jpg",
    levels: trekLevels(4),
    url: (z, row, col) => `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${z}/${row}/${col}.jpg`,
  },
  {
    id: "mars",
    title: "Viking MDIM 2.1 colour mosaic",
    credit: "NASA/JPL/USGS (Viking Orbiter), via NASA Solar System Treks",
    tileSize: 256,
    extension: "jpg",
    levels: trekLevels(4),
    url: (z, row, col) => `https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/default/default028mm/${z}/${row}/${col}.jpg`,
  },
  {
    id: "earth",
    title: "Blue Marble: shaded relief and bathymetry",
    credit: "NASA Earth Observatory / Blue Marble, via NASA GIBS",
    tileSize: 512,
    extension: "jpeg",
    levels: gibsLevels(3),
    url: (z, row, col) => `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/default/2004-08-01/500m/${z}/${row}/${col}.jpeg`,
  },
  {
    id: "earth-night",
    title: "VIIRS city lights 2012",
    credit: "NASA Earth Observatory / Suomi NPP VIIRS, via NASA GIBS",
    tileSize: 512,
    extension: "jpeg",
    levels: gibsLevels(3),
    url: (z, row, col) => `https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/VIIRS_CityLights_2012/default/2012-01-01/500m/${z}/${row}/${col}.jpeg`,
  },
];

export class ImageryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class ImageryService {
  private inflight = new Map<string, Promise<Buffer>>();

  constructor(private readonly cacheDir: string | null, private readonly fetchImpl: typeof fetch = fetch) {}

  /** What the client needs to assemble a full-globe texture from tiles. */
  manifest(): { id: string; title: string; credit: string; tileSize: number; levels: ImageryLevel[] }[] {
    return LAYERS.map(({ id, title, credit, tileSize, levels }) => ({ id, title, credit, tileSize, levels }));
  }

  async tile(layerId: string, z: number, row: number, col: number): Promise<Buffer> {
    const layer = LAYERS.find((l) => l.id === layerId);
    if (!layer) throw new ImageryError("Unknown imagery layer", 404);
    const level = layer.levels.find((l) => l.z === z);
    if (!level || !Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= level.rows || col >= level.cols) throw new ImageryError("Tile is outside the available pyramid", 404);
    const key = `${layer.id}/${z}/${row}/${col}.${layer.extension}`;
    const file = this.cacheDir ? path.join(this.cacheDir, key) : null;
    if (file && existsSync(file)) return readFileSync(file);
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = (async () => {
        let response: Response;
        try {
          response = await this.fetchImpl(layer.url(z, row, col), { signal: AbortSignal.timeout(25_000) });
        } catch (err) {
          throw new ImageryError(`Could not reach the NASA tile service: ${err instanceof Error ? err.message : String(err)}`, 502);
        }
        if (!response.ok) throw new ImageryError(`NASA tile service returned HTTP ${response.status}`, 502);
        const bytes = Buffer.from(await response.arrayBuffer());
        // JPEG files start with FF D8: never cache or serve an HTML error page as an image.
        if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ImageryError("NASA tile service returned something that is not a JPEG", 502);
        if (file) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, bytes);
        }
        return bytes;
      })().finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }
}
