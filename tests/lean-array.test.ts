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
  for (const seed of [3, 21, 77, 1426637116, 5, 999]) {
    it(`starts short of power with the instruments on, and can be solved by a bigger array or by control logic (seed ${seed})`, () => {
      const nominal = generateMission("lunar-volatiles", seed, "engineer", "nominal");
      const lean = generateMission("lunar-volatiles", seed, "engineer", "lean-array");
      expect(lean.complication.id).toBe("lean-array");
      const area = (c: MissionConfig): number => c.spacecraft.components.filter((x) => x.type === "solar_panel").reduce((s, x) => s + (x as { areaM2: number }).areaM2, 0);
      const cut = area(lean.config) / area(nominal.config);
      expect(cut).toBeLessThan(0.96);
      expect(cut).toBeGreaterThan(0.14);
      // It arrives wired, with lines sized for the array it actually has.
      expect(recalculate(lean.config).derived["systems.wiring"]!.value).toMatchObject({ wired: true, unconnected: [], limited: [] });

      const fitted = installPart(installPart(lean.config, item("ns", "inst1")), item("nac", "inst2"));
      const events = flightEvents(seed, "engineer", fitted);
      const short = simulateMission(fitted, { events });
      expect(short.kpis.daysPowerNegative).toBeGreaterThan(20); // the problem is real

      expect(short.kpis.daysPowerNegative).toBeLessThan(short.days); // and it is not short all year: there is a good season
      // Way 1: hardware. Give the array its planned area back and refit its line.
      const bigger = refitHarness(valid({ ...fitted, spacecraft: { ...fitted.spacecraft, components: fitted.spacecraft.components.map((x) => (x.type === "solar_panel" ? { ...x, areaM2: x.areaM2 / cut, massKg: x.massKg / cut } : x)) } }));
      const hardware = simulateMission(bigger, { events });
      expect(hardware.kpis.daysPowerNegative).toBeLessThan(short.kpis.daysPowerNegative / 4);

      // Way 2: control logic. Shed instrument time only while power is short.
      const logic = valid({ ...fitted, systems: { ...fitted.systems, controllers: [{ id: "ctl", name: "Dark-season saver", hostId: "bus", memory: { saving: 0 }, rules: [
        { when: "power.marginW < 0 or battery.soc < 0.5", do: [{ target: "mem:saving", value: "1" }] },
        { when: "power.marginW > 5 and battery.soc > 0.9", do: [{ target: "mem:saving", value: "0" }] },
        { when: "mem.saving == 1", do: [{ target: "instruments", value: "nominal * 0.25" }] },
      ] }] } });
      const software = simulateMission(logic, { events });
      // Shedding load removes short days; how many depends on how deep this mission's dark season is.
      expect(software.kpis.daysPowerNegative).toBeLessThan(short.kpis.daysPowerNegative);
      expect(software.kpis.daysControlActive).toBeGreaterThan(10);
      expect(software.kpis.daysInstrumentsOff).toBeLessThanOrEqual(short.kpis.daysInstrumentsOff);

      // The two ways cost different things: hardware costs mass, logic costs science collected in the dark season.
      const mass = (c: MissionConfig): number => (recalculate(c).derived["mass.budget"]!.value as { totalMassKg: number }).totalMassKg;
      expect(mass(bigger)).toBeGreaterThan(mass(logic));
      const collected = (s: typeof short): number => s.kpis.totalDataReturnedGb + s.kpis.totalDataLostGb;
      expect(collected(hardware)).toBeGreaterThan(collected(software));
    });
  }
});

describe("the mission board supplies itself", () => {
  it("writes more missions whenever too few unplayed ones are left, up to a daily cap, and always carries the power-short problem", async () => {
    const { createPlatform } = await import("../src/platform/platform.js");
    const platform = createPlatform({ llm: { modelId: "none", status: () => ({ available: false, reason: "test" }), structured: async () => { throw new Error("no model in this test"); } } });
    try {
      const today = new Date().toISOString().slice(0, 10);
      const onBoard = (): { id: string; title: string; day: string }[] => platform.briefs.list(60).filter((b) => b.day === today);
      // Nothing played yet: it tops the board up to four unplayed missions (plus the standing one).
      // (it writes at most three per pass, so two passes fill an empty board)
      await platform.briefs.keepSupplied(() => false);
      await platform.briefs.keepSupplied(() => false);
      const first = onBoard();
      expect(first.length).toBeGreaterThanOrEqual(4);
      expect(first.some((b) => b.title === "Short on power in the long shadow")).toBe(true);
      // Enough are waiting: asking again writes nothing.
      expect(await platform.briefs.keepSupplied(() => false)).toEqual([]);
      // Crews took every one of them: it writes replacements by itself.
      const taken = new Set(first.map((b) => b.id));
      const more = await platform.briefs.keepSupplied((id) => taken.has(id));
      expect(more.length).toBeGreaterThan(0);
      expect(more.every((b) => !taken.has(b.id))).toBe(true);
      // The daily cap bounds how many it may write.
      const count = onBoard().length;
      expect(await platform.briefs.keepSupplied(() => true, { dailyCap: count })).toEqual([]);
      expect(onBoard().length).toBe(count);
    } finally {
      await platform.close();
    }
  });
});
