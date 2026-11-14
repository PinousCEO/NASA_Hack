/**
 * RF link budget (downlink). Deterministic calculation using the standard link equation:
 *   Eb/N0 = EIRP - FSPL - L_other + G/T - k - 10 log10(Rb)
 */
const BOLTZMANN_DBW = -228.6; // 10 log10(k), dBW/K/Hz
const C_M_S = 299792458;
const db = (x: number): number => 10 * Math.log10(x);

/** Parabolic dish gain, dBi. */
export function dishGainDbi(diameterM: number, frequencyGHz: number, apertureEfficiency = 0.55): number {
  const lambda = C_M_S / (frequencyGHz * 1e9);
  return db(apertureEfficiency * ((Math.PI * diameterM) / lambda) ** 2);
}

export const freeSpacePathLossDb = (rangeKm: number, frequencyGHz: number): number =>
  92.45 + 20 * Math.log10(rangeKm) + 20 * Math.log10(frequencyGHz);

/** Slant range (km) from a ground station to a satellite at orbit radius r, at a given elevation. */
export function slantRangeKm(bodyRadiusKm: number, orbitRadiusKm: number, elevationDeg: number): number {
  const el = (elevationDeg * Math.PI) / 180;
  const ratio = orbitRadiusKm / bodyRadiusKm;
  return bodyRadiusKm * (Math.sqrt(ratio ** 2 - Math.cos(el) ** 2) - Math.sin(el));
}

export interface LinkBudgetInput {
  frequencyGHz: number;
  txPowerW: number;
  txGainDbi: number;
  rxGainDbi: number;
  rxSystemNoiseTempK: number;
  rangeKm: number;
  dataRateBps: number;
  /** Sum of pointing, polarisation, atmospheric and implementation losses, dB. */
  otherLossesDb: number;
  /** Required Eb/N0 for the modulation/coding in use, dB (9.6 dB = uncoded BPSK at BER 1e-5). */
  requiredEbN0Db: number;
}

export interface LinkBudgetResult {
  eirpDbw: number;
  freeSpacePathLossDb: number;
  gOverTDbK: number;
  cOverN0DbHz: number;
  ebN0Db: number;
  marginDb: number;
  closes: boolean;
  /** Highest data rate that still closes the link with 3 dB margin, bit/s. */
  maxDataRateBpsAt3DbMargin: number;
}

export function linkBudget(input: LinkBudgetInput): LinkBudgetResult {
  for (const [k, v] of Object.entries(input)) {
    if (!Number.isFinite(v)) throw new RangeError(`${k} must be a finite number`);
  }
  if (!(input.txPowerW > 0 && input.rangeKm > 0 && input.dataRateBps > 0 && input.rxSystemNoiseTempK > 0)) {
    throw new RangeError("txPowerW, rangeKm, dataRateBps and rxSystemNoiseTempK must be > 0");
  }
  const eirp = db(input.txPowerW) + input.txGainDbi;
  const fspl = freeSpacePathLossDb(input.rangeKm, input.frequencyGHz);
  const gOverT = input.rxGainDbi - db(input.rxSystemNoiseTempK);
  const cn0 = eirp - fspl - input.otherLossesDb + gOverT - BOLTZMANN_DBW;
  const ebn0 = cn0 - db(input.dataRateBps);
  return {
    eirpDbw: eirp,
    freeSpacePathLossDb: fspl,
    gOverTDbK: gOverT,
    cOverN0DbHz: cn0,
    ebN0Db: ebn0,
    marginDb: ebn0 - input.requiredEbN0Db,
    closes: ebn0 - input.requiredEbN0Db >= 0,
    maxDataRateBpsAt3DbMargin: 10 ** ((cn0 - input.requiredEbN0Db - 3) / 10),
  };
}
