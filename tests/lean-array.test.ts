/**
 * The "descoped solar array" problem: a mission that starts short of power once its instruments are
 * on. It must be solvable in more than one way — hardware, or onboard control logic — and the ways
 * must really differ in what they cost.
 */
import { describe, expect, it } from "vitest";
import { flightEvents } from "../src/game/events.js";
import { generateMission, SCENARIOS } from "../src/game/scenarios.js";
import { simulateMission } from "../src/game/simulation.js";
import { recalculate } from "../src/state/recalc.js";
import { type Component, type MissionConfig, parseMissionConfig } from "../src/state/schema.js";
import { installPart, refitHarness } from "../src/systems/graph.js";

const item = (id: string, as: string): Component => ({ ...SCENARIOS[0]!.catalog.find((c) => c.id === id)!.component, id: as }) as Component;
const valid = (config: unknown): MissionConfig => {
  const parsed = parseMissionConfig(config);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.config;
};

describe("the descoped solar array problem", () => {
  for (const seed of [3, 21, 77]) {
    it(`starts short of power with the instruments on, and can be solved by a bigger array or by control logic (seed ${seed})`, () => {
      const nominal = generateMission("lunar-volatiles", seed, "engineer", "nominal");
      const lean = generateMission("lunar-volatiles", seed, "engineer", "lean-array");
      expect(lean.complication.id).toBe("lean-array");
      const area = (c: MissionConfig): number => c.spacecraft.components.filter((x) => x.type === "solar_panel").reduce((s, x) => s + (x as { areaM2: number }).areaM2, 0);
      expect(area(lean.config)).toBeCloseTo(area(nominal.config) * 0.5, 1);
      // It arrives wired, with lines sized for the array it actually has.
      expect(recalculate(lean.config).derived["systems.wiring"]!.value).toMatchObject({ wired: true, unconnected: [], limited: [] });

      const fitted = installPart(installPart(lean.config, item("ns", "inst1")), item("nac", "inst2"));
      const events = flightEvents(seed, "engineer", fitted);
      const short = simulateMission(fitted, { events });
      expect(short.kpis.daysPowerNegative).toBeGreaterThan(20); // the problem is real

      // Way 1: hardware. Give the array its planned area back and refit its line.
      const bigger = refitHarness(valid({ ...fitted, spacecraft: { ...fitted.spacecraft, components: fitted.spacecraft.components.map((x) => (x.type === "solar_panel" ? { ...x, areaM2: x.areaM2 * 2, massKg: x.massKg * 2 } : x)) } }));
      const hardware = simulateMission(bigger, { events });
      expect(hardware.kpis.daysPowerNegative).toBeLessThan(short.kpis.daysPowerNegative / 4);

      // Way 2: control logic. Shed instrument time only while power is short.
      const logic = valid({ ...fitted, systems: { ...fitted.systems, controllers: [{ id: "ctl", name: "Dark-season saver", hostId: "bus", memory: { saving: 0 }, rules: [
        { when: "power.marginW < 0 or battery.soc < 0.5", do: [{ target: "mem:saving", value: "1" }] },
        { when: "power.marginW > 5 and battery.soc > 0.9", do: [{ target: "mem:saving", value: "0" }] },
        { when: "mem.saving == 1", do: [{ target: "instruments", value: "nominal * 0.25" }] },
      ] }] } });
      const software = simulateMission(logic, { events });
      // Shedding load alone removes at least half of the short days; in a deep season the rest needs hardware as well.
      expect(software.kpis.daysPowerNegative).toBeLessThan(short.kpis.daysPowerNegative / 2);
      expect(software.kpis.daysInstrumentsOff).toBeLessThanOrEqual(short.kpis.daysInstrumentsOff);

      // The two ways cost different things: hardware costs mass, logic costs science collected in the dark season.
      const mass = (c: MissionConfig): number => (recalculate(c).derived["mass.budget"]!.value as { totalMassKg: number }).totalMassKg;
      expect(mass(bigger)).toBeGreaterThan(mass(logic));
      const collected = (s: typeof short): number => s.kpis.totalDataReturnedGb + s.kpis.totalDataLostGb;
      expect(collected(hardware)).toBeGreaterThan(collected(software));
    });
  }
});
