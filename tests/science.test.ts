/** Reference-value tests for the deterministic science library. */
import { describe, expect, it } from "vitest";
import { dishGainDbi, freeSpacePathLossDb, linkBudget, slantRangeKm } from "../src/science/comms.js";
import { heliocentricPosition, norm, sunState } from "../src/science/ephemeris.js";
import { BODIES, hohmannTransfer, orbitElements, positionAtTrueAnomaly, trueAnomalyAt } from "../src/science/orbital.js";
import { betaAngle, eclipseFraction, panelPowerW, powerBudget, simulatePowerTimeline, solarFluxWM2 } from "../src/science/power.js";
import { roverMobility, slopeAnalysis } from "../src/science/rover.js";

describe("orbital mechanics", () => {
  it("reproduces the ISS orbital period (~92.7 min at 408 km)", () => {
    const r = orbitElements({ body: "earth", semiMajorAxisKm: BODIES.earth.radiusKm + 408, eccentricity: 0 });
    expect(r.periodS / 60).toBeGreaterThan(92.4);
    expect(r.periodS / 60).toBeLessThan(93.0);
    expect(r.velocityPeriapsisKmS).toBeCloseTo(7.66, 1);
  });

  it("reproduces the geostationary period (one sidereal day)", () => {
    const r = orbitElements({ body: "earth", semiMajorAxisKm: 42164.17, eccentricity: 0 });
    expect(Math.abs(r.periodS - 86164.1)).toBeLessThan(5);
  });

  it("reproduces a 100 km lunar orbit period (~118 min, as flown by LRO)", () => {
    const r = orbitElements({ body: "moon", semiMajorAxisKm: 1837.4, eccentricity: 0 });
    expect(r.periodS / 60).toBeGreaterThan(117);
    expect(r.periodS / 60).toBeLessThan(119);
  });

  it("flags orbits that intersect the surface and rejects open orbits", () => {
    expect(orbitElements({ body: "moon", semiMajorAxisKm: 1800, eccentricity: 0.1 }).intersectsSurface).toBe(true);
    expect(() => orbitElements({ body: "earth", semiMajorAxisKm: 7000, eccentricity: 1.2 })).toThrow(RangeError);
  });

  it("computes the LEO→GEO Hohmann transfer (~3.9 km/s, ~5.3 h)", () => {
    const r = hohmannTransfer("earth", 6678.137, 42164.17);
    expect(r.totalDeltaVKmS).toBeGreaterThan(3.85);
    expect(r.totalDeltaVKmS).toBeLessThan(3.95);
    expect(r.transferTimeS / 3600).toBeCloseTo(5.27, 1);
  });

  it("propagates a circular orbit by exactly one period back to the same point", () => {
    const orbit = { body: "moon" as const, semiMajorAxisKm: 1837.4, eccentricity: 0, inclinationDeg: 90, raanDeg: 0, argPeriapsisDeg: 0, trueAnomalyDeg: 30, epoch: "2027-03-01T00:00:00Z" };
    const period = orbitElements(orbit).periodS;
    const later = new Date(Date.parse(orbit.epoch) + period * 1000).toISOString();
    expect(trueAnomalyAt(orbit, later) * (180 / Math.PI)).toBeCloseTo(30, 3);
    const [x, y, z] = positionAtTrueAnomaly(orbit, 0);
    expect(Math.hypot(x, y, z)).toBeCloseTo(1837.4, 6);
  });
});

describe("ephemeris", () => {
  it("gives Earth's perihelion and aphelion distances", () => {
    expect(sunState("earth", "2027-01-03T00:00:00Z").distanceAu).toBeCloseTo(0.9833, 3);
    expect(sunState("earth", "2027-07-05T00:00:00Z").distanceAu).toBeCloseTo(1.0167, 3);
  });

  it("puts the Sun near ecliptic longitude 0° at the March equinox (J2000 frame)", () => {
    const lon = sunState("earth", "2027-03-20T20:25:00Z").eclipticLongitudeDeg;
    const offset = Math.min(lon, 360 - lon);
    expect(offset).toBeLessThan(0.6); // precession since J2000 is ~0.38°
  });

  it("keeps Mars between its perihelion and aphelion distances", () => {
    for (const date of ["2026-01-01T00:00:00Z", "2027-06-01T00:00:00Z", "2030-11-15T00:00:00Z"]) {
      const d = norm(heliocentricPosition("mars", date));
      expect(d).toBeGreaterThan(1.38);
      expect(d).toBeLessThan(1.67);
    }
    const mars = sunState("mars", "2027-02-19T00:00:00Z"); // 2027 opposition
    expect(mars.earthToBodyDistanceKm).toBeGreaterThan(0.6 * 149597870.7);
    expect(mars.earthToBodyDistanceKm).toBeLessThan(0.75 * 149597870.7);
  });
});

describe("eclipse and power", () => {
  it("computes the LEO eclipse fraction at beta = 0 (~39% of the orbit)", () => {
    expect(eclipseFraction("earth", 6778.137, 0)).toBeCloseTo(0.39, 2);
  });

  it("has no eclipse at high beta angles", () => {
    expect(eclipseFraction("earth", 6778.137, 80)).toBe(0);
    const critical = (Math.asin(6378.137 / 6778.137) * 180) / Math.PI;
    expect(eclipseFraction("earth", 6778.137, critical - 0.5)).toBeGreaterThan(0);
    expect(eclipseFraction("earth", 6778.137, critical + 0.5)).toBe(0);
  });

  it("computes beta from orbit normal and Sun direction", () => {
    const sun = { directionEquatorial: [1, 0, 0] as [number, number, number], directionEcliptic: [1, 0, 0] as [number, number, number] };
    expect(betaAngle("earth", 0, 0, sun).betaDeg).toBeCloseTo(0, 9); // equatorial orbit, Sun in plane
    expect(Math.abs(betaAngle("earth", 90, 90, sun).betaDeg)).toBeCloseTo(90, 6); // Sun along the orbit normal
    expect(betaAngle("mars", 45, 10, sun).assumptions.length).toBeGreaterThan(0);
  });

  it("scales solar flux with the inverse square of distance", () => {
    expect(solarFluxWM2(1)).toBe(1361);
    expect(solarFluxWM2(1.524)).toBeCloseTo(586, 0);
    expect(panelPowerW({ areaM2: 1, efficiency: 0.3, pointingLoss: 0, degradationPerYear: 0 }, 1)).toBeCloseTo(408.3, 1);
  });

  it("balances a power budget", () => {
    const r = powerBudget({
      panels: [{ areaM2: 1, efficiency: 0.3, pointingLoss: 0, degradationPerYear: 0 }],
      loads: [{ name: "bus", powerW: 100, dutyCycle: 1 }, { name: "tx", powerW: 50, dutyCycle: 0.2 }],
      batteryCapacityWh: 200, batteryMaxDepthOfDischarge: 0.3, sunDistanceAu: 1, eclipseFraction: 0.4, orbitPeriodS: 5400,
    });
    expect(r.orbitAverageGenerationW).toBeCloseTo(408.3 * 0.6, 1);
    expect(r.averageLoadW).toBe(110);
    expect(r.eclipseEnergyWh).toBeCloseTo((110 * 2160) / 3600, 6);
    expect(r.depthOfDischarge).toBeCloseTo(0.33, 2);
    expect(r.batteryAdequate).toBe(false);
    expect(r.positiveMargin).toBe(true);
  });

  it("simulates a sustainable and an unsustainable battery cycle", () => {
    const base = {
      panels: [{ areaM2: 1, efficiency: 0.3, pointingLoss: 0, degradationPerYear: 0 }],
      batteryCapacityWh: 200, batteryMaxDepthOfDischarge: 0.4, sunDistanceAu: 1, eclipseFraction: 0.4, orbitPeriodS: 5400,
      orbits: 6, stepS: 10, initialStateOfCharge: 1, chargeEfficiency: 0.9,
    };
    const ok = simulatePowerTimeline({ ...base, loads: [{ name: "bus", powerW: 100, dutyCycle: 1 }] });
    expect(ok.batteryDepleted).toBe(false);
    expect(ok.energyBalancedPerOrbit).toBe(true);
    expect(ok.minStateOfCharge).toBeCloseTo(1 - (100 * 0.4 * 5400) / 3600 / 200, 1);
    const bad = simulatePowerTimeline({ ...base, loads: [{ name: "bus", powerW: 300, dutyCycle: 1 }] });
    expect(bad.energyBalancedPerOrbit).toBe(false);
    expect(bad.batteryDepleted).toBe(true);
  });
});

describe("communications", () => {
  it("matches the textbook free-space path loss", () => {
    expect(freeSpacePathLossDb(1000, 1)).toBeCloseTo(152.45, 2);
    expect(freeSpacePathLossDb(384400, 8.45)).toBeCloseTo(222.68, 1);
  });

  it("computes parabolic dish gain", () => {
    expect(dishGainDbi(1, 8.4)).toBeCloseTo(36.3, 1);
    expect(dishGainDbi(34, 8.45)).toBeCloseTo(67.0, 0);
  });

  it("computes slant range at the zenith and the horizon", () => {
    expect(slantRangeKm(6378.137, 6778.137, 90)).toBeCloseTo(400, 6);
    expect(slantRangeKm(6378.137, 6778.137, 0)).toBeCloseTo(Math.sqrt(6778.137 ** 2 - 6378.137 ** 2), 6);
  });

  it("closes a link consistently with the link equation", () => {
    const input = { frequencyGHz: 8.45, txPowerW: 10, txGainDbi: 30, rxGainDbi: 68, rxSystemNoiseTempK: 30, rangeKm: 384400, dataRateBps: 1e6, otherLossesDb: 3, requiredEbN0Db: 4.5 };
    const r = linkBudget(input);
    expect(r.eirpDbw).toBeCloseTo(40, 6);
    expect(r.ebN0Db).toBeCloseTo(40 - r.freeSpacePathLossDb - 3 + (68 - 10 * Math.log10(30)) + 228.6 - 60, 6);
    expect(r.closes).toBe(true);
    // Raising the data rate tenfold costs exactly 10 dB of margin.
    expect(r.marginDb - linkBudget({ ...input, dataRateBps: 1e7 }).marginDb).toBeCloseTo(10, 6);
    expect(linkBudget({ ...input, dataRateBps: r.maxDataRateBpsAt3DbMargin }).marginDb).toBeCloseTo(3, 6);
  });
});

describe("rover mobility and terrain", () => {
  const rover = { totalMassKg: 30, gravityMS2: 1.625, wheelCount: 4, wheelRadiusM: 0.12, wheelTorqueNm: 3.5, tractionCoefficient: 0.5, rollingResistanceCoefficient: 0.1, supportHalfSpanM: 0.3, centerOfMassHeightM: 0.3, speedMS: 0.1, drivetrainEfficiency: 0.6, siteSlopeDeg: 10 };

  it("limits slope by traction when torque and stability are ample", () => {
    const r = roverMobility(rover);
    expect(r.tractionLimitSlopeDeg).toBeCloseTo((Math.atan(0.4) * 180) / Math.PI, 6);
    expect(r.limitingFactor).toBe("traction");
    expect(r.tipOverSlopeDeg).toBeCloseTo(45, 6);
    expect(r.canTraverseSite).toBe(true);
  });

  it("limits slope by torque when the motors are weak", () => {
    const r = roverMobility({ ...rover, wheelTorqueNm: 0.3 });
    expect(r.limitingFactor).toBe("torque");
    // At the torque limit, available force equals required force.
    const theta = (r.torqueLimitSlopeDeg * Math.PI) / 180;
    expect(r.weightN * (Math.sin(theta) + 0.1 * Math.cos(theta))).toBeCloseTo(r.availableTractiveForceN, 6);
  });

  it("computes drive power from tractive force", () => {
    const r = roverMobility(rover);
    expect(r.drivePowerW).toBeCloseTo((r.requiredTractiveForceN * 0.1) / 0.6, 9);
  });

  it("recovers the slope of an inclined plane", () => {
    const cell = 2;
    const heights = Array.from({ length: 6 }, () => Array.from({ length: 8 }, (_, c) => c * cell * Math.tan((10 * Math.PI) / 180)));
    const r = slopeAnalysis(heights, cell, 15);
    expect(r.maxSlopeDeg).toBeCloseTo(10, 6);
    expect(r.meanSlopeDeg).toBeCloseTo(10, 6);
    expect(r.fractionAboveThreshold).toBe(0);
    expect(() => slopeAnalysis([[1, 2], [3]], 1, 10)).toThrow(RangeError);
  });
});
