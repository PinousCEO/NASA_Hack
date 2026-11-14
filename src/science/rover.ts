/**
 * Rover mobility and terrain slope analysis. Deterministic rigid-body statics:
 * a rover of mass m on a slope θ needs tractive force F = m g (sin θ + Crr cos θ).
 * Soil sinkage / slip (Bekker–Wong terramechanics) is NOT modelled.
 */
const DEG = Math.PI / 180;

export interface RoverMobilityInput {
  totalMassKg: number;
  gravityMS2: number;
  wheelCount: number;
  wheelRadiusM: number;
  /** Continuous torque available at each wheel after gearing, N·m. */
  wheelTorqueNm: number;
  /** Wheel–soil traction coefficient (dimensionless). */
  tractionCoefficient: number;
  rollingResistanceCoefficient: number;
  /** Shortest support half-span (half of wheelbase or track, whichever is smaller), m. */
  supportHalfSpanM: number;
  centerOfMassHeightM: number;
  speedMS: number;
  drivetrainEfficiency: number;
  siteSlopeDeg: number;
}

export interface RoverMobilityResult {
  weightN: number;
  tractionLimitSlopeDeg: number;
  torqueLimitSlopeDeg: number;
  tipOverSlopeDeg: number;
  maxClimbSlopeDeg: number;
  limitingFactor: "traction" | "torque" | "stability";
  requiredTractiveForceN: number;
  availableTractiveForceN: number;
  drivePowerW: number;
  energyPerKmWh: number;
  canTraverseSite: boolean;
  slopeMarginDeg: number;
}

export function roverMobility(input: RoverMobilityInput): RoverMobilityResult {
  const positive = ["totalMassKg", "gravityMS2", "wheelCount", "wheelRadiusM", "speedMS", "drivetrainEfficiency", "centerOfMassHeightM", "supportHalfSpanM"] as const;
  for (const k of positive) if (!(input[k] > 0)) throw new RangeError(`${k} must be > 0`);
  const W = input.totalMassKg * input.gravityMS2;
  const crr = input.rollingResistanceCoefficient;
  // Traction: mu * N >= F  ->  tan(theta) <= mu - Crr
  const traction = Math.max(0, Math.atan(input.tractionCoefficient - crr) / DEG);
  // Torque: n*tau/r >= W (sin θ + Crr cos θ). sin θ + Crr cos θ = sqrt(1+Crr²) sin(θ + atan Crr)
  const available = (input.wheelCount * input.wheelTorqueNm) / input.wheelRadiusM;
  const ratio = available / (W * Math.sqrt(1 + crr * crr));
  const torque = ratio >= 1 ? 90 : Math.max(0, (Math.asin(ratio) - Math.atan(crr)) / DEG);
  const tip = Math.atan(input.supportHalfSpanM / input.centerOfMassHeightM) / DEG;
  const limits = [
    ["traction", traction],
    ["torque", torque],
    ["stability", tip],
  ] as const;
  const [limitingFactor, maxClimb] = limits.reduce((a, b) => (b[1] < a[1] ? b : a));
  const theta = input.siteSlopeDeg * DEG;
  const required = W * (Math.sin(theta) + crr * Math.cos(theta));
  const drivePower = (required * input.speedMS) / input.drivetrainEfficiency;
  return {
    weightN: W,
    tractionLimitSlopeDeg: traction,
    torqueLimitSlopeDeg: torque,
    tipOverSlopeDeg: tip,
    maxClimbSlopeDeg: maxClimb,
    limitingFactor,
    requiredTractiveForceN: required,
    availableTractiveForceN: available,
    drivePowerW: drivePower,
    energyPerKmWh: (drivePower * (1000 / input.speedMS)) / 3600,
    canTraverseSite: input.siteSlopeDeg <= maxClimb,
    slopeMarginDeg: maxClimb - input.siteSlopeDeg,
  };
}

export interface SlopeAnalysisResult {
  rows: number;
  cols: number;
  maxSlopeDeg: number;
  meanSlopeDeg: number;
  p95SlopeDeg: number;
  /** Fraction of cells whose slope exceeds `thresholdDeg`. */
  fractionAboveThreshold: number;
  thresholdDeg: number;
}

/** Slope statistics of a regular-grid heightmap (metres) using central differences. */
export function slopeAnalysis(heightsM: number[][], cellSizeM: number, thresholdDeg: number): SlopeAnalysisResult {
  const rows = heightsM.length;
  const cols = heightsM[0]?.length ?? 0;
  if (rows < 2 || cols < 2) throw new RangeError("heightmap must be at least 2x2");
  if (heightsM.some((r) => r.length !== cols || r.some((h) => !Number.isFinite(h)))) {
    throw new RangeError("heightmap must be rectangular with finite values");
  }
  if (!(cellSizeM > 0)) throw new RangeError("cellSizeM must be > 0");
  const h = (r: number, c: number): number =>
    heightsM[Math.min(rows - 1, Math.max(0, r))]![Math.min(cols - 1, Math.max(0, c))]!;
  const slopes: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const spanX = (Math.min(cols - 1, c + 1) - Math.max(0, c - 1)) * cellSizeM;
      const spanY = (Math.min(rows - 1, r + 1) - Math.max(0, r - 1)) * cellSizeM;
      const dzdx = (h(r, c + 1) - h(r, c - 1)) / spanX;
      const dzdy = (h(r + 1, c) - h(r - 1, c)) / spanY;
      slopes.push(Math.atan(Math.hypot(dzdx, dzdy)) / DEG);
    }
  }
  const sorted = [...slopes].sort((a, b) => a - b);
  return {
    rows,
    cols,
    maxSlopeDeg: sorted[sorted.length - 1]!,
    meanSlopeDeg: slopes.reduce((s, v) => s + v, 0) / slopes.length,
    p95SlopeDeg: sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))]!,
    fractionAboveThreshold: slopes.filter((s) => s > thresholdDeg).length / slopes.length,
    thresholdDeg,
  };
}
