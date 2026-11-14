/**
 * Launch vehicles as a design choice. These are generic vehicle classes in the platform's
 * game model, not data for any real rocket: capacity and price are expressed relative to the
 * mission's launch mass allocation so the choice stays meaningful across every scenario,
 * difficulty and brief. A smaller vehicle is cheaper but forces a lighter spacecraft; a
 * larger one buys mass margin with budget. Around Earth, high-inclination orbits cost capacity
 * (the launch gets less help from the planet's rotation); at the Moon and Mars the orbit's
 * inclination is set on arrival and does not change what the launch vehicle can lift.
 */
import type { MissionConfig } from "../state/schema.js";

export interface LaunchVehicleClass {
  id: string;
  name: string;
  summary: string;
  /** Capacity as a fraction of the mission's launch mass allocation. */
  capacityFactor: number;
  /** Price as a fraction of the nominal delivery price for that allocation. */
  costFactor: number;
  /** Capacity lost when an Earth orbit's inclination is above 60° (polar insertion). */
  polarPenalty: number;
  /** Months the launch campaign adds to the schedule. */
  leadMonths: number;
}

export const LAUNCH_VEHICLES: LaunchVehicleClass[] = [
  { id: "rideshare", name: "Rideshare slot", summary: "Share a launch with other payloads: cheapest, least mass, and it loses the most to a polar orbit.", capacityFactor: 0.85, costFactor: 0.65, polarPenalty: 0.14, leadMonths: 0 },
  { id: "dedicated", name: "Dedicated small launcher", summary: "A launch of your own, sized to the nominal mass allocation.", capacityFactor: 1.0, costFactor: 1.0, polarPenalty: 0.08, leadMonths: 1 },
  { id: "heavy", name: "Heavy launcher", summary: "Plenty of mass margin at a much higher price.", capacityFactor: 1.3, costFactor: 1.3, polarPenalty: 0.03, leadMonths: 3 },
];

/** Nominal delivery price per kilogram by destination ($M/kg): a game parameter, order-of-magnitude only. */
export const DELIVERY_PER_KG: Record<MissionConfig["centralBody"], number> = { earth: 0.02, moon: 0.35, mars: 0.6 };

export interface LaunchOption {
  id: string;
  name: string;
  summary: string;
  capacityKg: number;
  costMusd: number;
  leadMonths: number;
}

/** What each vehicle class can deliver to this mission's orbit, and for how much. */
export function launchOptions(config: MissionConfig): LaunchOption[] {
  const allocation = config.meta.massLimitKg;
  if (!allocation) return [];
  const polar = config.centralBody === "earth" && Math.abs(90 - config.orbit.inclinationDeg) < 30;
  return LAUNCH_VEHICLES.map((v) => ({
    id: v.id,
    name: v.name,
    summary: v.summary,
    capacityKg: Math.round(allocation * v.capacityFactor * (polar ? 1 - v.polarPenalty : 1) * 10) / 10,
    costMusd: Math.round(allocation * DELIVERY_PER_KG[config.centralBody] * v.costFactor * 100) / 100,
    leadMonths: v.leadMonths,
  }));
}
