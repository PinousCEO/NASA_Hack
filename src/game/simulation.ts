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
import { applyDuty, stepControllers } from "../systems/controller.js";
import { analyse, effectiveComponents, sys } from "../systems/graph.js";
import type { FlightEvent } from "./events.js";

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
    /** Science data the instruments would collect with nothing going wrong, Gb. */
    plannedDataGb: number;
    /** Returned data as a share of what the same design returns on a flight with no in-flight events. */
    scienceDeliveredFraction: number;
    /** Days on which onboard control logic commanded something. */
    daysControlActive: number;
  };
  /** Science data returned by each instrument over the flight, Gb. */
  returnedByInstrument: { instrumentId: string; name: string; returnedGb: number; lostGb: number }[];
  /** What the onboard control logic did, day by day (first entries). */
  controlLog: { day: number; controllerId: string; rule: number; note?: string; effect: string }[];
  /** The in-flight events this mission met, and what each one cost. */
  flightEvents: (FlightEvent & { outcome: string; dataLostGb: number })[];
  timeline: { day: number; date: string; betaDeg: number; eclipseFraction: number; generationW: number; marginW: number; depthOfDischarge: number | null; linkMarginDb: number | null; returnedGb: number; storageGb: number; sunDistanceAu: number }[];
  events: { day: number; severity: "info" | "warn" | "critical"; message: string }[];
  assumptions: string[];
}

export function simulateMission(config: MissionConfig, options: { maxDays?: number; events?: FlightEvent[] } = {}): MissionSimulation {
  const days = Math.min(Math.round(config.meta.missionDurationDays), options.maxDays ?? 730);
  const flight = (options.events ?? []).filter((e) => e.day < days).map((e) => ({ ...e, outcome: "", dataLostGb: 0, undelivered: 0 }));
  const start = Date.parse(config.missionTime);
  const capacityWh = config.spacecraft.components.filter((c) => c.type === "battery").reduce((s, b) => s + b.capacityWh, 0);
  const storageCapGb = config.spacecraft.dataStorageGb + config.spacecraft.components.reduce((s, c) => s + (c.type === "computer" ? c.storageGb : 0), 0);
  const timeline: MissionSimulation["timeline"] = [];
  const events: MissionSimulation["events"] = [];
  const keep = Math.max(1, Math.ceil(days / 180));
  let reserveWh = capacityWh;
  let storageGb = 0;
  let previous: ReturnType<typeof recalculate> | undefined;
  let previousConfig: MissionConfig | undefined;
  const k = { totalDataReturnedGb: 0, totalDataLostGb: 0, daysPowerNegative: 0, daysInstrumentsOff: 0, minPowerMarginW: Infinity, maxDepthOfDischarge: 0, minLinkMarginDb: null as number | null, worstDay: 0, peakStorageGb: 0, plannedDataGb: 0, scienceDeliveredFraction: 0, daysControlActive: 0 };
  const controllers = sys(config).controllers.filter((c) => c.enabled);
  let controlMemory: Record<string, Record<string, number>> = {};
  const controlLog: MissionSimulation["controlLog"] = [];
  let lastControl = "";
  // Science data waits on board in one queue per instrument, so that what is sent first and what is lost can be told apart.
  const instruments = config.spacecraft.components.filter((c) => c.type === "instrument");
  const queue = new Map<string, number>(instruments.map((i) => [i.id, 0]));
  const returnedBy = new Map<string, number>(instruments.map((i) => [i.id, 0]));
  const lostBy = new Map<string, number>(instruments.map((i) => [i.id, 0]));
  let wasNegative = false;
  let wasFull = false;
  let linkWasDown = false;

  for (let day = 0; day < days; day++) {
    const date = new Date(start + day * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");
    // In-flight events: permanent losses apply from their day on, temporary ones while they last.
    let arrayFactor = 1;
    let batteryFactor = 1;
    let linkLossDb = 0;
    let safeMode = false;
    let stationDown = false;
    for (const e of flight) {
      if (day < e.day) continue;
      const active = day < e.day + e.durationDays;
      if (e.effect.kind === "array_loss") arrayFactor *= 1 - e.effect.fraction;
      if (e.effect.kind === "battery_loss") batteryFactor *= 1 - e.effect.fraction;
      if (e.effect.kind === "link_loss") linkLossDb += e.effect.db;
      if (e.effect.kind === "safe_mode") {
        arrayFactor *= 1 - e.effect.arrayLossFraction;
        if (active) safeMode = true;
      }
      if (e.effect.kind === "station_outage" && active) stationDown = true;
      if (day === e.day) events.push({ day, severity: "warn", message: `${e.title}: ${e.description}` });
    }
    const degraded = arrayFactor !== 1 || batteryFactor !== 1;
    const dayConfig: MissionConfig = {
      ...config,
      missionTime: date,
      meta: { ...config.meta, yearsInService: config.meta.yearsInService + day / 365.25 },
      ...(degraded ? { spacecraft: { ...config.spacecraft, components: config.spacecraft.components.map((c) => (c.type === "solar_panel" ? { ...c, efficiency: c.efficiency * arrayFactor } : c.type === "battery" ? { ...c, capacityWh: c.capacityWh * batteryFactor } : c)) } } : {}),
      ...(linkLossDb ? { groundStation: { ...config.groundStation, antennaGainDbi: config.groundStation.antennaGainDbi - linkLossDb } } : {}),
    };
    let result = recalculate(dayConfig, previous && previousConfig ? { config: previousConfig, derived: previous.derived } : undefined);
    previous = result;
    previousConfig = dayConfig;
    let flown = dayConfig;
    let priority: string[] | null = null;
    // Onboard control logic: it reads today's state and commands the parts it is wired to. In safe mode the spacecraft ignores it.
    if (controllers.length && !safeMode) {
      const n = <T>(id: string): T | null => (result.derived[id]?.value as T | null | undefined) ?? null;
      const p0 = n<{ marginW: number; orbitAverageGenerationW: number }>("power.budget");
      const c0 = n<{ worstMarginDb: number | null }>("comms.link");
      const d0 = n<{ generatedGbPerDay: number; downlinkCapacityGbPerDay: number }>("data.budget");
      const linkOk = c0?.worstMarginDb === null || c0?.worstMarginDb === undefined ? 0 : c0.worstMarginDb >= 0 ? 1 : 0;
      const signals: Record<string, number> = {
        day,
        "battery.soc": capacityWh * batteryFactor > 0 ? Math.max(0, Math.min(1, reserveWh / (capacityWh * batteryFactor))) : 0,
        "power.marginW": p0?.marginW ?? 0,
        "power.generationW": p0?.orbitAverageGenerationW ?? 0,
        "eclipse.fraction": n<{ eclipseFraction: number }>("orbit.eclipse")?.eclipseFraction ?? 0,
        "sun.distanceAu": n<{ distanceAu: number }>("ephemeris.sun")?.distanceAu ?? 1,
        "link.marginDb": c0?.worstMarginDb ?? -99,
        "link.up": linkOk && !stationDown ? 1 : 0,
        "storage.fill": storageCapGb > 0 ? Math.min(1, storageGb / storageCapGb) : 1,
        "storage.gb": storageGb,
        "data.generatedGbPerDay": d0?.generatedGbPerDay ?? 0,
        "data.downlinkGbPerDay": d0?.downlinkCapacityGbPerDay ?? 0,
        "array.health": arrayFactor,
        "battery.health": batteryFactor,
        "station.down": stationDown ? 1 : 0,
      };
      const step = stepControllers(dayConfig, signals, controlMemory);
      controlMemory = step.memory;
      priority = step.priority;
      if (step.duty.size) {
        flown = applyDuty(dayConfig, step.duty);
        // A day counts as "acted on" when a command differs from the part's normal setting.
        if (flown.spacecraft.components.some((c, i) => (c as { dutyCycle?: number }).dutyCycle !== (dayConfig.spacecraft.components[i] as { dutyCycle?: number }).dutyCycle)) {
          result = recalculate(flown);
          k.daysControlActive++;
        } else flown = dayConfig;
      }
      const stamp = step.fired.map((f) => f.controllerId + "#" + f.rule).join(",") + "|" + [...step.duty].map(([id, d]) => id + "=" + d.toFixed(2)).join(",");
      // The log records changes of command, one entry per rule that commanded a part: what it set, and from what.
      const commanding = step.fired.filter((f) => f.commands.length > 0);
      const changed = [...step.duty].filter(([id, d]) => Math.abs(d - (dayConfig.spacecraft.components.find((c) => c.id === id) as { dutyCycle?: number } | undefined)?.dutyCycle!) > 1e-9);
      const commandStamp = changed.length ? stamp : "";
      if (commandStamp && commandStamp !== lastControl && controlLog.length < 60) {
        for (const f of commanding) {
          const effect = f.commands.filter((id) => changed.some(([c]) => c === id)).map((id) => {
            const part = dayConfig.spacecraft.components.find((c) => c.id === id) as { name: string; dutyCycle?: number };
            return part.name + ": " + ((part.dutyCycle ?? 0) * 100).toFixed(0) + "% → " + (step.duty.get(id)! * 100).toFixed(0) + "% on-time";
          }).join("; ");
          if (effect) controlLog.push({ day, controllerId: f.controllerId, rule: f.rule, ...(f.note ? { note: f.note } : {}), effect });
        }
      }
      if (!commandStamp && lastControl && controlLog.length < 60) controlLog.push({ day, controllerId: "-", rule: 0, effect: "back to normal settings" });
      lastControl = commandStamp;
    }
    const v = <T>(id: string): T | null => (result.derived[id]?.value as T | null | undefined) ?? null;
    const power = v<{ marginW: number; orbitAverageGenerationW: number; depthOfDischarge: number | null }>("power.budget");
    const eclipse = v<{ betaDeg: number; eclipseFraction: number }>("orbit.eclipse");
    const comms = v<{ worstMarginDb: number | null }>("comms.link");
    const data = v<{ generatedGbPerDay: number; downlinkCapacityGbPerDay: number }>("data.budget");
    const sun = v<{ distanceAu: number }>("ephemeris.sun");
    if (!power || !eclipse || !sun) throw new Error(`Engineering models failed on day ${day}: ${Object.entries(result.derived).filter(([, n]) => n.error).map(([id, n]) => `${id}: ${n.error}`).join("; ")}`);

    // Energy reserve carried between days: a deficit drains it, a surplus refills it.
    reserveWh = Math.min(capacityWh * batteryFactor, reserveWh + power.marginW * 24);
    const instrumentsOff = reserveWh <= 0;
    if (reserveWh < 0) reserveWh = 0;
    const planned = data?.generatedGbPerDay ?? 0;
    const generated = instrumentsOff || safeMode ? 0 : planned;
    const capacity = stationDown ? 0 : (data?.downlinkCapacityGbPerDay ?? 0);
    k.plannedDataGb += planned;
    // Per-instrument bookkeeping: what each one made today joins its queue; the downlink empties the queues in priority
    // order when control logic sets one, otherwise in proportion; what does not fit in storage is dropped from the back.
    const made = effectiveComponents(flown, analyse(flown)).filter((c) => c.type === "instrument");
    const madeTotal = made.reduce((s, i) => s + i.dataRateBps * i.dutyCycle, 0);
    for (const i of made) if (madeTotal > 0) queue.set(i.id, (queue.get(i.id) ?? 0) + generated * ((i.dataRateBps * i.dutyCycle) / madeTotal));
    const returned = Math.min(capacity, generated + storageGb);
    const order = priority ? [...priority.filter((id) => queue.has(id)), ...[...queue.keys()].filter((id) => !priority!.includes(id))] : null;
    const waiting = [...queue.values()].reduce((s, q) => s + q, 0);
    if (order) {
      let left = returned;
      for (const id of order) { const take = Math.min(left, queue.get(id)!); queue.set(id, queue.get(id)! - take); returnedBy.set(id, (returnedBy.get(id) ?? 0) + take); left -= take; }
    } else if (waiting > 0) {
      for (const [id, q] of queue) { const take = returned * (q / waiting); queue.set(id, q - take); returnedBy.set(id, (returnedBy.get(id) ?? 0) + take); }
    }
    storageGb = storageGb + generated - returned;
    let lost = 0;
    if (storageGb > storageCapGb) {
      lost = storageGb - storageCapGb;
      storageGb = storageCapGb;
      const still = [...queue.values()].reduce((s, q) => s + q, 0);
      if (order) {
        let drop = lost;
        for (const id of [...order].reverse()) { const take = Math.min(drop, queue.get(id)!); queue.set(id, queue.get(id)! - take); lostBy.set(id, (lostBy.get(id) ?? 0) + take); drop -= take; }
      } else if (still > 0) {
        for (const [id, q] of queue) { const take = lost * (q / still); queue.set(id, q - take); lostBy.set(id, (lostBy.get(id) ?? 0) + take); }
      }
    }

    k.totalDataReturnedGb += returned;
    k.totalDataLostGb += lost;
    // Charge what was not collected or was overwritten to the event that was in force.
    for (const e of flight) if (day >= e.day && day < e.day + Math.max(e.durationDays, 1) + (e.effect.kind === "station_outage" ? 10 : 0)) e.dataLostGb += lost + (planned - generated);
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
  // The yardstick is this design's own event-free flight, so a link-limited mission is not charged for data it could never send.
  const calm = flight.length ? simulateMission(config, { ...(options.maxDays !== undefined ? { maxDays: options.maxDays } : {}) }).kpis.totalDataReturnedGb : k.totalDataReturnedGb;
  k.scienceDeliveredFraction = calm > 0 ? Math.min(1, k.totalDataReturnedGb / calm) : 0;
  const flightEvents = flight.map(({ undelivered: _u, ...e }) => ({ ...e, outcome: e.dataLostGb > 0.005 ? `Cost ${e.dataLostGb.toFixed(2)} Gb of science data.` : "Ridden out with no science data lost." }));
  return {
    days,
    kpis: { ...k, minPowerMarginW: Number.isFinite(k.minPowerMarginW) ? k.minPowerMarginW : 0 },
    flightEvents,
    returnedByInstrument: instruments.map((i) => ({ instrumentId: i.id, name: i.name, returnedGb: returnedBy.get(i.id) ?? 0, lostGb: lostBy.get(i.id) ?? 0 })),
    controlLog,
    timeline,
    events: events.slice(0, 40),
    assumptions: [
      "One step per day; each day uses that day's Sun direction, Sun distance and Earth range",
      "Orbit plane fixed inertially (no nodal precession), so the beta-angle cycle follows the Sun",
      "Solar array output degrades continuously at the configured annual rate",
      "Instruments are switched off on days when the battery reserve is exhausted",
      ...(controllers.length ? ["Onboard control logic runs once per simulated day on that day's state; it is ignored while the spacecraft is in safe mode", "Commanded on-times replace the parts' normal settings for that day and the engineering models are re-run with them"] : []),
      "In-flight events are drawn from the mission seed (game model): the event types are real anomaly classes, their dates and sizes are not failure statistics",
    ],
  };
}
