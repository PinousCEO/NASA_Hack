/**
 * Mission-duration simulation: one step per day, re-running the engineering models with
 * that day's Sun geometry, Earth range and array degradation. It answers what a single
 * snapshot cannot — whether the design survives its worst eclipse season and how much
 * science data it actually returns.
 *
 * Deterministic. It inherits every assumption of the underlying models (two-body orbit,
 * cylindrical shadow, fixed RAAN) and adds: daily averaging, and instruments switched off
 * on days when the battery reserve is exhausted.
 */
import { recalculate } from "../state/recalc.js";
import type { MissionConfig } from "../state/schema.js";

export interface MissionSimulation {
  days: number;
  kpis: {
    totalDataReturnedGb: number;
    totalDataLostGb: number;
    daysPowerNegative: number;
    daysInstrumentsOff: number;
    minPowerMarginW: number;
    maxDepthOfDischarge: number;
    minLinkMarginDb: number | null;
    worstDay: number;
    peakStorageGb: number;
  };
  timeline: { day: number; date: string; betaDeg: number; eclipseFraction: number; generationW: number; marginW: number; depthOfDischarge: number | null; linkMarginDb: number | null; returnedGb: number; storageGb: number; sunDistanceAu: number }[];
  events: { day: number; severity: "info" | "warn" | "critical"; message: string }[];
  assumptions: string[];
}

export function simulateMission(config: MissionConfig, maxDays = 730): MissionSimulation {
  const days = Math.min(Math.round(config.meta.missionDurationDays), maxDays);
  const start = Date.parse(config.missionTime);
  const capacityWh = config.spacecraft.components.filter((c) => c.type === "battery").reduce((s, b) => s + b.capacityWh, 0);
  const storageCapGb = config.spacecraft.dataStorageGb;
  const timeline: MissionSimulation["timeline"] = [];
  const events: MissionSimulation["events"] = [];
  const keep = Math.max(1, Math.ceil(days / 180));
  let reserveWh = capacityWh;
  let storageGb = 0;
  let previous: ReturnType<typeof recalculate> | undefined;
  let previousConfig: MissionConfig | undefined;
  const k = { totalDataReturnedGb: 0, totalDataLostGb: 0, daysPowerNegative: 0, daysInstrumentsOff: 0, minPowerMarginW: Infinity, maxDepthOfDischarge: 0, minLinkMarginDb: null as number | null, worstDay: 0, peakStorageGb: 0 };
  let wasNegative = false;
  let wasFull = false;
  let linkWasDown = false;

  for (let day = 0; day < days; day++) {
    const date = new Date(start + day * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const dayConfig: MissionConfig = { ...config, missionTime: date, meta: { ...config.meta, yearsInService: config.meta.yearsInService + day / 365.25 } };
    const result = recalculate(dayConfig, previous && previousConfig ? { config: previousConfig, derived: previous.derived } : undefined);
    previous = result;
    previousConfig = dayConfig;
    const v = <T>(id: string): T | null => (result.derived[id]?.value as T | null | undefined) ?? null;
    const power = v<{ marginW: number; orbitAverageGenerationW: number; depthOfDischarge: number | null }>("power.budget");
    const eclipse = v<{ betaDeg: number; eclipseFraction: number }>("orbit.eclipse");
    const comms = v<{ worstMarginDb: number | null }>("comms.link");
    const data = v<{ generatedGbPerDay: number; downlinkCapacityGbPerDay: number }>("data.budget");
    const sun = v<{ distanceAu: number }>("ephemeris.sun");
    if (!power || !eclipse || !sun) throw new Error(`Engineering models failed on day ${day}: ${Object.entries(result.derived).filter(([, n]) => n.error).map(([id, n]) => `${id}: ${n.error}`).join("; ")}`);

    // Energy reserve carried between days: a deficit drains it, a surplus refills it.
    reserveWh = Math.min(capacityWh, reserveWh + power.marginW * 24);
    const instrumentsOff = reserveWh <= 0;
    if (reserveWh < 0) reserveWh = 0;
    const generated = instrumentsOff ? 0 : (data?.generatedGbPerDay ?? 0);
    const capacity = data?.downlinkCapacityGbPerDay ?? 0;
    const returned = Math.min(capacity, generated + storageGb);
    storageGb = storageGb + generated - returned;
    let lost = 0;
    if (storageGb > storageCapGb) {
      lost = storageGb - storageCapGb;
      storageGb = storageCapGb;
    }

    k.totalDataReturnedGb += returned;
    k.totalDataLostGb += lost;
    if (power.marginW < 0) k.daysPowerNegative++;
    if (instrumentsOff) k.daysInstrumentsOff++;
    if (power.marginW < k.minPowerMarginW) {
      k.minPowerMarginW = power.marginW;
      k.worstDay = day;
    }
    if ((power.depthOfDischarge ?? 0) > k.maxDepthOfDischarge) k.maxDepthOfDischarge = power.depthOfDischarge ?? 0;
    if (comms?.worstMarginDb !== null && comms?.worstMarginDb !== undefined && (k.minLinkMarginDb === null || comms.worstMarginDb < k.minLinkMarginDb)) k.minLinkMarginDb = comms.worstMarginDb;
    if (storageGb > k.peakStorageGb) k.peakStorageGb = storageGb;

    const negative = power.marginW < 0;
    if (negative && !wasNegative) events.push({ day, severity: "warn", message: `Power margin turns negative (${power.marginW.toFixed(0)} W) as beta angle reaches ${eclipse.betaDeg.toFixed(0)}° and eclipse covers ${(eclipse.eclipseFraction * 100).toFixed(0)}% of each orbit.` });
    if (!negative && wasNegative) events.push({ day, severity: "info", message: "Power margin recovers." });
    if (instrumentsOff && k.daysInstrumentsOff === 1) events.push({ day, severity: "critical", message: "Battery reserve exhausted: instruments are switched off until power recovers." });
    const full = lost > 0;
    if (full && !wasFull) events.push({ day, severity: "warn", message: `Onboard storage is full; science data is being overwritten (${lost.toFixed(2)} Gb lost today).` });
    const linkDown = comms?.worstMarginDb !== null && comms?.worstMarginDb !== undefined && comms.worstMarginDb < 0;
    if (linkDown && !linkWasDown) events.push({ day, severity: "critical", message: `Downlink no longer closes (margin ${comms!.worstMarginDb!.toFixed(1)} dB) at this Earth range.` });
    if (!linkDown && linkWasDown) events.push({ day, severity: "info", message: "Downlink closes again." });
    wasNegative = negative;
    wasFull = full;
    linkWasDown = Boolean(linkDown);

    if (day % keep === 0 || day === days - 1) {
      timeline.push({ day, date, betaDeg: eclipse.betaDeg, eclipseFraction: eclipse.eclipseFraction, generationW: power.orbitAverageGenerationW, marginW: power.marginW, depthOfDischarge: power.depthOfDischarge, linkMarginDb: comms?.worstMarginDb ?? null, returnedGb: returned, storageGb, sunDistanceAu: sun.distanceAu });
    }
  }
  if (events.length === 0) events.push({ day: 0, severity: "info", message: "No power, storage or link anomalies across the simulated mission." });
  return {
    days,
    kpis: { ...k, minPowerMarginW: Number.isFinite(k.minPowerMarginW) ? k.minPowerMarginW : 0 },
    timeline,
    events: events.slice(0, 40),
    assumptions: [
      "One step per day; each day uses that day's Sun direction, Sun distance and Earth range",
      "Orbit plane fixed inertially (no nodal precession), so the beta-angle cycle follows the Sun",
      "Solar array output degrades continuously at the configured annual rate",
      "Instruments are switched off on days when the battery reserve is exhausted",
    ],
  };
}
