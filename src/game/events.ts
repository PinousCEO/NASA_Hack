/**
 * In-flight events: the things that go wrong after launch. A mission draws a small set of
 * events from its seed, so every crew flying the same brief meets the same events (a fair
 * comparison) while different briefs fly differently. Events are applied by the mission
 * simulation; a design survives them with margin — power to spare, storage to ride out a
 * station outage, a link that still closes after a loss.
 *
 * Game model: the event types are real classes of spacecraft anomaly, but their dates and
 * magnitudes are drawn for play, not taken from failure statistics.
 */
import type { MissionConfig } from "../state/schema.js";

export type FlightEventEffect =
  | { kind: "safe_mode"; arrayLossFraction: number }
  | { kind: "station_outage" }
  | { kind: "array_loss"; fraction: number }
  | { kind: "battery_loss"; fraction: number }
  | { kind: "link_loss"; db: number };

export interface FlightEvent {
  id: string;
  /** Mission day on which the event starts. */
  day: number;
  /** Days the temporary part of the event lasts (0 for a purely permanent change). */
  durationDays: number;
  title: string;
  description: string;
  /** What a design needs in order to shrug it off. */
  mitigation: string;
  effect: FlightEventEffect;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COUNT: Record<string, number> = { cadet: 1, engineer: 2, chief: 3 };

/** The events this mission will meet in flight, in date order. Same seed, same events. */
export function flightEvents(seed: number, difficulty: string, config: MissionConfig): FlightEvent[] {
  const random = rng((seed ^ 0x9e3779b9) >>> 0);
  const days = Math.round(config.meta.missionDurationDays);
  const between = (min: number, max: number): number => min + random() * (max - min);
  const pct = (f: number): string => `${Math.round(f * 100)}%`;
  const makers: ((day: number) => FlightEvent)[] = [
    (day) => {
      const duration = Math.round(between(3, 7));
      const loss = Math.round(between(0.02, 0.04) * 100) / 100;
      return { id: "solar-storm", day, durationDays: duration, title: "Solar particle storm", description: `A solar storm forces the spacecraft into safe mode for ${duration} days: instruments are off, and radiation takes ${pct(loss)} off the solar arrays for good.`, mitigation: "Power margin above the permanent array loss.", effect: { kind: "safe_mode", arrayLossFraction: loss } };
    },
    (day) => {
      const duration = Math.round(between(4, 10));
      return { id: "station-outage", day, durationDays: duration, title: "Ground station outage", description: `The ground station is down for ${duration} days. Nothing can be downlinked; science data piles up on board.`, mitigation: "Enough onboard storage to hold the backlog, and downlink capacity to clear it afterwards.", effect: { kind: "station_outage" } };
    },
    (day) => {
      const fraction = Math.round(between(0.08, 0.15) * 100) / 100;
      return { id: "array-string", day, durationDays: 0, title: "Solar array string failure", description: `One string of solar cells fails open. Power generation drops by ${pct(fraction)} for the rest of the mission.`, mitigation: `Power margin of at least ${pct(fraction)} of generation.`, effect: { kind: "array_loss", fraction } };
    },
    (day) => {
      const fraction = Math.round(between(0.15, 0.25) * 100) / 100;
      return { id: "battery-cell", day, durationDays: 0, title: "Battery cell failure", description: `A battery cell fails and is bypassed. Usable capacity drops by ${pct(fraction)}, so every eclipse drains the battery deeper.`, mitigation: "Depth of discharge well under the battery's limit.", effect: { kind: "battery_loss", fraction } };
    },
    (day) => {
      const db = Math.round(between(1.5, 3) * 10) / 10;
      return { id: "feed-damage", day, durationDays: 0, title: "Antenna feed degradation", description: `The downlink loses ${db} dB after a fault in the transmitter chain.`, mitigation: `Link margin of more than ${db} dB.`, effect: { kind: "link_loss", db } };
    },
  ];
  const count = Math.min(makers.length, COUNT[difficulty] ?? 2);
  // Draw without replacement, then place each event in its own slice of the mission.
  const pool = [...makers];
  const events: FlightEvent[] = [];
  for (let i = 0; i < count; i++) {
    const make = pool.splice(Math.floor(random() * pool.length), 1)[0]!;
    const sliceStart = 0.08 + (0.8 * i) / count;
    const day = Math.max(1, Math.min(days - 12, Math.round(days * between(sliceStart, sliceStart + 0.8 / count))));
    events.push(make(day));
  }
  return events.sort((a, b) => a.day - b.day);
}
