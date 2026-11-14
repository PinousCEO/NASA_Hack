/**
 * Live integration test against NASA/JPL Horizons, and an independent cross-check of the
 * analytic ephemeris against it. Skipped (not failed) when the service is unreachable.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { parseHorizonsVectors } from "../src/capabilities/data.js";
import { executeDirect } from "../src/registry/direct.js";
import { sunState } from "../src/science/ephemeris.js";

const app = createApp();
afterAll(() => app.close());

const reachable = await fetch("https://ssd.jpl.nasa.gov/api/horizons.api?format=json&COMMAND=%27MB%27", { signal: AbortSignal.timeout(10000) }).then((r) => r.ok, () => false);

describe("Horizons result parsing", () => {
  it("parses the CSV vector table and reports missing tables", () => {
    const text = "header\n$$SOE\n2461465.500000000, A.D. 2027-Mar-01 00:00:00.0000, -9.2E-01,  3.6E-01, -2.0E-05, -6.5E-03, -1.6E-02,  1.1E-06,\n$$EOE\nfooter";
    expect(parseHorizonsVectors(text)[0]).toMatchObject({ julianDateTdb: 2461465.5, positionAu: [-0.92, 0.36, -2.0e-5], velocityAuPerDay: [-6.5e-3, -1.6e-2, 1.1e-6] });
    expect(() => parseHorizonsVectors("No ephemeris for target")).toThrow(/no ephemeris table/);
  });
});

describe.skipIf(!reachable)("JPL Horizons (live)", () => {
  const user = { id: "eng-1", role: "engineer" as const };

  it("retrieves a state vector and agrees with the analytic Sun ephemeris", async () => {
    const time = "2027-03-01T00:00:00Z";
    const result = await executeDirect(app, "data.horizons.vectors", { target: "sun", center: "earth", time }, user);
    const live = result.output as { distanceAu: number; positionAu: [number, number, number]; source: string };
    expect(result.verification).toBe("external_data");
    expect(live.source).toMatch(/Horizons/);

    const analytic = sunState("earth", time);
    expect(Math.abs(live.distanceAu - analytic.distanceAu)).toBeLessThan(5e-4); // < 75,000 km of 148 million
    const liveDir = live.positionAu.map((v) => v / live.distanceAu);
    const cos = liveDir.reduce((s, v, i) => s + v * analytic.directionEcliptic[i]!, 0);
    expect((Math.acos(Math.min(1, cos)) * 180) / Math.PI).toBeLessThan(0.05); // direction within 3 arcminutes
  }, 30000);

  it("agrees with the analytic Earth–Mars range to within a fraction of a percent", async () => {
    const time = "2027-02-19T00:00:00Z";
    const result = await executeDirect(app, "data.horizons.vectors", { target: "mars", center: "earth", time }, user);
    const live = (result.output as { distanceKm: number }).distanceKm;
    const analytic = sunState("mars", time).earthToBodyDistanceKm;
    expect(Math.abs(live - analytic) / live).toBeLessThan(0.005);
  }, 30000);
});
