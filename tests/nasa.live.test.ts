/**
 * Live checks against NASA data services (PDS Geosciences Node, Solar System Treks, GIBS).
 * Products are cached under .data/cache, so only the first run downloads them.
 */
import { describe, expect, it } from "vitest";
import { cacheDir, createApp } from "../src/app.js";
import { ImageryService } from "../src/nasa/imagery.js";
import { TerrainService } from "../src/nasa/terrain.js";
import { executeDirect } from "../src/registry/direct.js";
import path from "node:path";

describe("NASA PDS terrain (live)", () => {
  const terrain = new TerrainService(path.join(cacheDir(), "dem"));

  it("reads lunar topography from LOLA LDEM_4 with the documented scale and datum", async () => {
    const grid = await terrain.grid("moon");
    expect(grid.width * grid.height).toBe(1440 * 720);
    // Published lunar extremes: about -9.1 km (Antoniadi, inside South Pole–Aitken) and +10.8 km (farside highlands).
    expect(grid.minM).toBeGreaterThan(-9500);
    expect(grid.minM).toBeLessThan(-8000);
    expect(grid.maxM).toBeGreaterThan(9500);
    expect(grid.maxM).toBeLessThan(11200);
    // South Pole–Aitken basin floor is kilometres below the datum; the farside highlands north of Korolev are kilometres above it.
    expect(await terrain.elevationM("moon", -55, 190)).toBeLessThan(-3000);
    expect(await terrain.elevationM("moon", 5.4, 201.4)).toBeGreaterThan(6000);
    // Mare Imbrium is a low, smooth plain.
    const imbrium = await terrain.survey("moon", 35, 345, 60);
    expect(imbrium.elevationM).toBeLessThan(-1500);
    expect(imbrium.regionalSlopeDeg).toBeLessThan(1);
  }, 120000);

  it("reads Martian topography from MOLA MEGDR: Olympus Mons, Hellas and the hemispheric dichotomy", async () => {
    const grid = await terrain.grid("mars");
    expect(grid.maxM).toBeGreaterThan(20500); // Olympus Mons summit, 21.2 km above the areoid
    expect(grid.maxM).toBeLessThan(21500);
    expect(grid.minM).toBeLessThan(-7500); // Hellas floor, about -8.2 km
    expect(grid.minM).toBeGreaterThan(-8600);
    expect(await terrain.elevationM("mars", 18.65, 226.2)).toBeGreaterThan(19000);
    expect(await terrain.elevationM("mars", -42.4, 70.5)).toBeLessThan(-6000);
    expect(await terrain.elevationM("mars", 70, 0)).toBeLessThan(await terrain.elevationM("mars", -70, 0)); // northern lowlands
    const flank = await terrain.survey("mars", 18.65, 229.5, 80);
    expect(flank.regionalSlopeDeg).toBeGreaterThan(1.5); // the shield's flank
    expect(flank.regionalSlopeDeg).toBeLessThan(12);
  }, 120000);

  it("is exposed as a usable capability that defaults to the rover's landing site", async () => {
    const app = createApp();
    try {
      await app.registry.refreshAvailability();
      expect(app.registry.resolve("data.terrain.dem")?.id).toBe("data.terrain.dem");
      const result = await executeDirect(app, "data.terrain.dem", { body: "moon", latDeg: -89.45, lonDeg: 222.7, radiusKm: 20 }, { id: "u", role: "engineer" });
      const out = result.output as { elevationM: number; regionalSlopeDeg: number; heightsM: number[][]; cellSizeM: number; product: string; caveats: string[] };
      expect(out.product).toMatch(/LDEM_4/);
      expect(Number.isFinite(out.elevationM)).toBe(true);
      expect(out.regionalSlopeDeg).toBeGreaterThan(0);
      expect(out.regionalSlopeDeg).toBeLessThan(25);
      expect(out.heightsM).toHaveLength(9);
      expect(out.cellSizeM).toBe(5000);
      expect(result.verification).toBe("external_data");
      expect(out.caveats[0]).toMatch(/not a slope a rover or lander would experience/);
    } finally {
      await app.close();
    }
  }, 120000);
});

describe("NASA imagery tiles (live)", () => {
  const imagery = new ImageryService(path.join(cacheDir(), "imagery"));
  const isJpeg = (bytes: Buffer): boolean => bytes.length > 2000 && bytes[0] === 0xff && bytes[1] === 0xd8;

  it("fetches Moon, Mars and Earth tiles at the zoom levels the client uses", async () => {
    expect(isJpeg(await imagery.tile("moon", 2, 1, 3))).toBe(true);
    expect(isJpeg(await imagery.tile("moon", 3, 7, 15))).toBe(true); // last tile of the level
    expect(isJpeg(await imagery.tile("mars", 2, 3, 7))).toBe(true);
    expect(isJpeg(await imagery.tile("earth", 2, 1, 2))).toBe(true);
    expect(isJpeg(await imagery.tile("earth", 3, 4, 9))).toBe(true);
    expect((await imagery.tile("earth-night", 2, 0, 2)).subarray(0, 2).toString("hex")).toBe("ffd8");
  }, 120000);
});
