/**
 * The systems graph and onboard control logic: lines carry real flows, incompatible connections are
 * refused, and a controller that is installed changes what the flight simulation computes.
 */
import { describe, expect, it } from "vitest";
import { flightEvents } from "../src/game/events.js";
import { generateMission, SCENARIOS } from "../src/game/scenarios.js";
import { simulateMission } from "../src/game/simulation.js";
import { missionOutcome, type ObjectiveResult } from "../src/game/scoring.js";
import { analyzeRuleBased } from "../src/pipeline/requirements.js";
import { engineeringChecks, recalculate } from "../src/state/recalc.js";
import { type Component, type Controller, type Link, type MissionConfig, parseMissionConfig } from "../src/state/schema.js";
import { controllerIssues, stepControllers } from "../src/systems/controller.js";
import { evaluate, ExprError, parseExpr } from "../src/systems/expr.js";
import { analyse, harnessPatches, installPart, linkMassKg, portsOf, type Wiring } from "../src/systems/graph.js";

const lunar = (): MissionConfig => generateMission("lunar-volatiles", 1, "cadet").config;
const item = (id: string, as: string): Component => ({ ...SCENARIOS[0]!.catalog.find((c) => c.id === id)!.component, id: as }) as Component;
const valid = (config: unknown): MissionConfig => {
  const parsed = parseMissionConfig(config);
  if (!parsed.ok) throw new Error(parsed.issues.join("; "));
  return parsed.config;
};
const issues = (config: unknown): string[] => {
  const parsed = parseMissionConfig(config);
  return parsed.ok ? [] : parsed.issues;
};
const withLinks = (c: MissionConfig, ...links: Partial<Link>[]): unknown => ({ ...c, systems: { ...c.systems, links: [...c.systems.links, ...links] } });
const withController = (c: MissionConfig, ctl: Partial<Controller>): unknown => ({ ...c, systems: { ...c.systems, controllers: [...c.systems.controllers, ctl] } });
const node = <T>(c: MissionConfig, id: string): T => recalculate(c).derived[id]!.value as T;

describe("wiring", () => {
  it("hands a mission over already wired: every starting part is connected and nothing is held back", () => {
    for (const s of SCENARIOS) {
      const c = generateMission(s.id, 5, "engineer").config;
      const w = analyse(c);
      expect(w.wired).toBe(true);
      expect(w.unconnected, s.id).toEqual([]);
      expect(w.limited, s.id).toEqual([]);
      expect(w.links.length).toBeGreaterThanOrEqual(c.spacecraft.components.length);
      expect(engineeringChecks(c, recalculate(c).derived).find((x) => x.id === "systems.wiring")!.status).toBe("pass");
    }
  });

  it("makes a part do nothing until its lines exist: power first, then data", () => {
    const base = lunar();
    const ns = item("ns", "inst1");
    const loose = valid({ ...base, spacecraft: { ...base.spacecraft, components: [...base.spacecraft.components, ns] } });
    const load = (c: MissionConfig): number => node<{ averageLoadW: number }>(c, "power.budget").averageLoadW;
    const made = (c: MissionConfig): number => node<{ generatedGbPerDay: number }>(c, "data.budget").generatedGbPerDay;
    // Bolted on with no lines: it adds mass and cost, draws nothing, measures nothing.
    expect(load(loose)).toBeCloseTo(load(base), 6);
    expect(made(loose)).toBeCloseTo(made(base), 6);
    expect(node<{ totalMassKg: number }>(loose, "mass.budget").totalMassKg).toBeGreaterThan(node<{ totalMassKg: number }>(base, "mass.budget").totalMassKg);
    expect(analyse(loose).parts.find((p) => p.id === "inst1")).toMatchObject({ power: 0, data: 0, commandable: false });
    // A power line alone: it now draws power, but its measurements still go nowhere.
    const powered = valid(withLinks(loose, { id: "l1", kind: "power", from: { node: "bus", port: "power" }, to: { node: "inst1", port: "power_in" }, rating: 100 }));
    expect(load(powered)).toBeGreaterThan(load(base));
    expect(made(powered)).toBeCloseTo(made(base), 6);
    expect(analyse(powered).parts.find((p) => p.id === "inst1")!.notes[0]).toMatch(/No data line/);
    // With the data line too, the measurements are recorded.
    const recording = valid(withLinks(powered, { id: "l2", kind: "data", from: { node: "inst1", port: "data_out" }, to: { node: "bus", port: "data_in" }, rating: 1e7 }));
    expect(made(recording)).toBeGreaterThan(made(base));
  });

  it("refuses connections that cannot exist, and says why", () => {
    const c = installPart(lunar(), item("ns", "inst1"));
    const bad = (link: Partial<Link>): string => issues(withLinks(c, { id: "bad1", lengthM: 1, ...link })).join(" ");
    expect(bad({ kind: "power", from: { node: "bus", port: "power" }, to: { node: "inst1", port: "data_out" }, rating: 50 })).toMatch(/power line cannot plug into .* data_out port, which carries data/);
    expect(bad({ kind: "data", from: { node: "bus", port: "data_in" }, to: { node: "inst1", port: "data_out" }, rating: 1e6 })).toMatch(/is an input; a line must start at an output/);
    expect(bad({ kind: "power", from: { node: "sp1", port: "power_out" }, to: { node: "inst1", port: "power_in" }, rating: 50 })).toMatch(/one end of a power line must be the bus/);
    expect(bad({ kind: "power", from: { node: "bus", port: "power" }, to: { node: "ghost", port: "power_in" }, rating: 50 })).toBe(""); // a line to a part that is not there is dropped, not kept dangling
    expect(bad({ kind: "data", from: { node: "inst1", port: "data_out" }, to: { node: "bus", port: "data_in" } })).toMatch(/needs a rating/);
    expect(bad({ kind: "control", from: { node: "bus", port: "control_out" }, to: { node: "inst1", port: "nope" } })).toMatch(/has no port "nope"/);
    expect(bad({ kind: "data", from: { node: "inst1", port: "data_out" }, to: { node: "bus", port: "data_in" }, rating: 5e6 })).toMatch(/already a data line between these two ports/);
    expect(portsOf("instrument").map((p) => `${p.name}:${p.kind}:${p.dir}:${p.unit}`)).toEqual(["power_in:power:in:W", "data_out:data:out:bit/s", "control_in:control:in:command"]);
  });

  it("carries only what a line is rated for: a bigger array behind the same line is clipped until the line is refitted", () => {
    const base = lunar();
    const panel = base.spacecraft.components.find((x) => x.type === "solar_panel")!;
    const gen = (c: MissionConfig): number => node<{ orbitAverageGenerationW: number }>(c, "power.budget").orbitAverageGenerationW;
    const bigger = valid({ ...base, spacecraft: { ...base.spacecraft, components: base.spacecraft.components.map((x) => (x.id === panel.id ? { ...x, areaM2: (x as typeof panel & { areaM2: number }).areaM2 * 3 } : x)) } });
    const status = analyse(bigger).parts.find((p) => p.id === panel.id)!;
    expect(status.power).toBeLessThan(1);
    expect(status.notes[0]).toMatch(/power line carries only/);
    expect(gen(bigger)).toBeLessThan(gen(base) * 1.5); // three times the area, but the line passes 1.25 times the old output
    expect(engineeringChecks(bigger, recalculate(bigger).derived).find((x) => x.id === "systems.wiring")!.status).toBe("warn");
    // Refitting the line costs mass and lets the whole array through.
    const patches = harnessPatches(bigger, panel.id);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ op: "set", path: expect.stringMatching(/^systems\.links\..+\.rating$/) });
    const refitted = valid({ ...bigger, systems: { ...bigger.systems, links: bigger.systems.links.map((l) => (patches[0]!.path === `systems.links.${l.id}.rating` ? { ...l, rating: patches[0]!.value as number } : l)) } });
    expect(gen(refitted)).toBeCloseTo(gen(base) * 3, 3);
    expect(analyse(refitted).harnessMassKg).toBeGreaterThan(analyse(bigger).harnessMassKg);
  });

  it("counts the harness in the mass budget and removes a part's lines with the part", () => {
    const base = lunar();
    const w = node<Wiring>(base, "systems.wiring");
    const mass = node<{ harnessMassKg: number; totalMassKg: number; busDryMassKg: number; componentMassKg: number }>(base, "mass.budget");
    expect(mass.harnessMassKg).toBeCloseTo(base.systems.links.reduce((s, l) => s + linkMassKg(l), 0), 9);
    expect(mass.totalMassKg).toBeCloseTo(mass.busDryMassKg + mass.componentMassKg + w.harnessMassKg, 9);
    const fitted = installPart(base, item("ns", "inst1"));
    expect(fitted.systems.links.filter((l) => l.from.node === "inst1" || l.to.node === "inst1")).toHaveLength(3);
    const removed = valid({ ...fitted, spacecraft: { ...fitted.spacecraft, components: fitted.spacecraft.components.filter((x) => x.id !== "inst1") } });
    expect(removed.systems.links.some((l) => l.from.node === "inst1" || l.to.node === "inst1")).toBe(false);
    expect(removed.systems.links).toHaveLength(base.systems.links.length);
  });
});

describe("control expressions", () => {
  const run = (src: string, env: Record<string, number> = {}): number => evaluate(parseExpr(src), (n) => env[n]);
  it("computes with signals, comparisons, logic and a few pure functions", () => {
    expect(run("1 + 2 * 3")).toBe(7);
    expect(run("battery.soc < 0.3 and not link.up", { "battery.soc": 0.2, "link.up": 0 })).toBe(1);
    expect(run("clamp(nominal * 2, 0, 1)", { nominal: 0.8 })).toBe(1);
    expect(run("if(storage.fill > 0.5, 1, 0.25)", { "storage.fill": 0.9 })).toBe(1);
    expect(run("10 / 0")).toBe(0);
    expect(run("mod(day, 7) == 0", { day: 14 })).toBe(1);
  });
  it("cannot reach anything but the numbers it is given", () => {
    for (const src of ["process.exit(1)", "constructor.constructor('return 1')()", "a = 1", "x[0]", "require('fs')", "while(1){}", "`${1}`", "1; 2", "this", "globalThis.fetch('http://x')", "(".repeat(40) + "1" + ")".repeat(40), "1 +".repeat(100) + "1"]) {
      let failed = false;
      try {
        const e = parseExpr(src);
        evaluate(e, () => undefined);
      } catch (err) {
        failed = err instanceof ExprError;
      }
      expect(failed, src).toBe(true);
    }
  });
});

describe("onboard control logic", () => {
  /** A mission whose power margin goes negative for part of the year, so that shedding load has something to save. */
  const stressed = (): MissionConfig => {
    const base = installPart(installPart(lunar(), item("ns", "inst1")), item("nac", "inst2"));
    for (const f of [0.9, 0.8, 0.7, 0.62, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2]) {
      const c = valid({ ...base, spacecraft: { ...base.spacecraft, components: base.spacecraft.components.map((x) => (x.type === "solar_panel" ? { ...x, areaM2: x.areaM2 * f } : x)) } });
      const k = simulateMission(c).kpis;
      if (k.daysPowerNegative > 20 && k.daysPowerNegative < 300) return c;
    }
    throw new Error("no stressed configuration found");
  };
  const saver: Partial<Controller> = {
    id: "ctl1", name: "Power saver", hostId: "bus", memory: { saving: 0 },
    rules: [
      { when: "power.marginW < 0", do: [{ target: "mem:saving", value: "1" }], note: "generation no longer covers the load" },
      { when: "power.marginW > 2", do: [{ target: "mem:saving", value: "0" }], note: "power is back" },
      { when: "mem.saving == 1", do: [{ target: "instruments", value: "nominal * 0.2" }], note: "run the instruments a fifth of the time" },
    ],
  };

  it("is rejected before it can fly when it reads a signal that does not exist, commands a part it has no control line to, or is not well formed", () => {
    const c = stressed();
    expect(issues(withController(c, { ...saver, rules: [{ when: "battery.charge < 3", do: [{ target: "instruments", value: "0" }] }] })).join(" ")).toMatch(/"battery.charge" is not a signal it can read/);
    expect(issues(withController(c, { ...saver, rules: [{ when: "day > (", do: [{ target: "instruments", value: "0" }] }] })).join(" ")).toMatch(/rule 1 condition/);
    expect(issues(withController(c, { ...saver, rules: [{ when: "day > 1", do: [{ target: "engine:x", value: "0" }] }] })).join(" ")).toMatch(/not a kind of target/);
    expect(issues(withController(c, { ...saver, rules: [{ when: "day > 1", do: [{ target: "mem:other", value: "1" }] }] })).join(" ")).toMatch(/not declared in its memory/);
    expect(issues(withController(c, { ...saver, hostId: "inst1" })).join(" ")).toMatch(/must run on "bus" or on an onboard computer/);
    // Cut the control line to the camera: a rule that names it can no longer be installed, and the message says which line to add.
    const cut = valid({ ...c, systems: { ...c.systems, links: c.systems.links.filter((l) => !(l.kind === "control" && l.to.node === "inst2")) } });
    const named = { ...saver, rules: [{ when: "battery.soc < 0.5", do: [{ target: "instrument:inst2", value: "0" }] }] };
    expect(issues(withController(cut, named)).join(" ")).toMatch(/no control line from the bus to .*Add a control line bus\.control_out → inst2\.control_in/);
    expect(issues(withController(c, named))).toEqual([]);
    expect(controllerIssues(c, valid(withController(c, saver)).systems.controllers[0]!)).toEqual([]);
  });

  it("runs in the flight simulation and changes the result: shedding load in the dark season keeps the power margin positive", () => {
    const c = stressed();
    const events = flightEvents(11, "engineer", c);
    const before = simulateMission(c, { events });
    const flown = valid(withController(c, saver));
    const after = simulateMission(flown, { events });
    expect(before.kpis.daysControlActive).toBe(0);
    expect(after.kpis.daysControlActive).toBeGreaterThan(10);
    expect(after.kpis.daysPowerNegative).toBeLessThan(before.kpis.daysPowerNegative);
    expect(after.kpis.minPowerMarginW).toBeGreaterThan(before.kpis.minPowerMarginW);
    expect(after.controlLog.find((e) => e.rule === 3)).toMatchObject({ controllerId: "ctl1", note: "run the instruments a fifth of the time", effect: expect.stringMatching(/Neutron spectrometer: 100% → 20% on-time/) });
    expect(after.controlLog.every((e) => e.rule === 3 || e.rule === 0)).toBe(true); // only rules that command a part are logged
    // (Letting go again when power returns is covered by the hysteresis test below; on this flight the dark season runs to the end.)
    // Nothing is free: the instruments ran less, so less was collected on those days.
    expect(after.kpis.totalDataReturnedGb + after.kpis.totalDataLostGb).toBeLessThan(before.kpis.totalDataReturnedGb + before.kpis.totalDataLostGb);
    // Same design, same events: the same flight, every time.
    expect(simulateMission(flown, { events }).kpis).toEqual(after.kpis);
    // Switched off, it is as if it were not there.
    const off = valid({ ...flown, systems: { ...flown.systems, controllers: flown.systems.controllers.map((x) => ({ ...x, enabled: false })) } });
    expect(simulateMission(off, { events }).kpis).toEqual(before.kpis);
  });

  it("remembers between days (hysteresis) and only commands what it is wired to", () => {
    const c = valid(withController(stressed(), saver));
    let memory: Record<string, Record<string, number>> = {};
    const day = (marginW: number): { duty: Map<string, number>; saving: number } => {
      const step = stepControllers(c, { "power.marginW": marginW, day: 0 }, memory);
      memory = step.memory;
      return { duty: step.duty, saving: memory.ctl1!.saving! };
    };
    expect(day(30).saving).toBe(0);
    expect(day(-5)).toMatchObject({ saving: 1 });
    const held = day(1); // between the two thresholds: stays in saving mode
    expect(held.saving).toBe(1);
    expect([...held.duty.keys()].sort()).toEqual(["inst1", "inst2"]);
    expect(day(25).saving).toBe(0);
    // Without its control line the camera keeps its normal setting; the spectrometer is still commanded.
    const cut: MissionConfig = { ...c, systems: { ...c.systems, links: c.systems.links.filter((l) => !(l.kind === "control" && l.to.node === "inst2")) } };
    memory = {};
    expect([...stepControllers(cut, { "power.marginW": -5, day: 0 }, memory).duty.keys()]).toEqual(["inst1"]);
  });

  it("sends the most important data first when a priority is set, and loses the least important when storage overflows", () => {
    const c = [["ns", "inst1"], ["nac", "inst2"], ["tir", "inst3"]].reduce((m, [id, as]) => installPart(m, item(id!, as!)), lunar());
    const sim = simulateMission(c);
    expect(sim.kpis.totalDataLostGb).toBeGreaterThan(0); // this design makes more than it can send
    const by = (s: typeof sim, id: string): { returnedGb: number; lostGb: number } => s.returnedByInstrument.find((r) => r.instrumentId === id)!;
    const prioritised = simulateMission(valid(withController(c, { id: "ctl2", name: "Hydrogen first", hostId: "bus", rules: [{ when: "day >= 0", do: [{ target: "mem:on", value: "1" }] }], memory: { on: 0 }, downlinkPriority: ["inst1"] })));
    // The totals are the same physics; who gets the downlink is what changed.
    expect(prioritised.kpis.totalDataReturnedGb).toBeCloseTo(sim.kpis.totalDataReturnedGb, 6);
    expect(by(prioritised, "inst1").returnedGb).toBeGreaterThan(by(sim, "inst1").returnedGb);
    expect(by(prioritised, "inst1").lostGb).toBeLessThan(by(sim, "inst1").lostGb + 1e-9);
    expect(by(prioritised, "inst3").returnedGb).toBeLessThan(by(sim, "inst3").returnedGb); // last in line gets what is left
    const sum = (s: typeof sim): number => s.returnedByInstrument.reduce((t, r) => t + r.returnedGb, 0);
    expect(sum(sim)).toBeCloseTo(sim.kpis.totalDataReturnedGb, 5);
    expect(sum(prioritised)).toBeCloseTo(prioritised.kpis.totalDataReturnedGb, 5);
  });
});

describe("does the mission work? (shown before the score)", () => {
  const goal = (achieved: number, stretch = false): ObjectiveResult => ({ id: `g${achieved}`, title: "Goal", description: "", category: "science", weight: 10, value: 1, unit: "", target: 1, achieved, points: achieved * 10, feedback: "", ...(stretch ? { stretch: true } : {}) });
  const c = generateMission("lunar-volatiles", 1, "cadet").config;
  const derived = recalculate(c).derived;
  const checks = engineeringChecks(c, derived);
  const launched = recalculate({ ...c, meta: { ...c.meta, launchVehicleId: "dedicated" } }).derived;
  const sim = simulateMission(installPart(c, item("ns", "inst1")));
  const flight = (fraction: number, off = 0): typeof sim => ({ ...sim, kpis: { ...sim.kpis, scienceDeliveredFraction: fraction, daysInstrumentsOff: off } });

  it("names the first condition that does not hold, with its evidence, and needs a flight before it calls success", () => {
    const none = missionOutcome([goal(0), goal(1)], derived, checks, null);
    expect(none.verdict).toBe("not_ready");
    expect(none.conditions.map((k) => [k.id, k.met])).toEqual([["science", false], ["limits", true], ["launch", false], ["flight", null]]);
    expect(none.conditions[0]!.evidence).toMatch(/1 of 2 science goals met in full, 50% of the science credit/);
    expect(none.headline).toMatch(/Not ready to fly/);
    // Stretch goals do not count against a mission that does what it is for.
    expect(missionOutcome([goal(1), goal(1), goal(0, true)], launched, checks, null).verdict).toBe("ready_to_fly");
    const broken = [...checks, { id: "x", description: "Something", status: "fail" as const, detail: "is over" }];
    expect(missionOutcome([goal(1)], launched, broken, flight(1))).toMatchObject({ verdict: "not_ready", headline: expect.stringMatching(/Flown in simulation, but not a mission that could launch/) });
  });

  it("grades the flight: success, partial success, or a failed mission", () => {
    expect(missionOutcome([goal(1)], launched, checks, flight(0.95)).verdict).toBe("success");
    expect(missionOutcome([goal(1)], launched, checks, flight(0.7)).verdict).toBe("partial");
    expect(missionOutcome([goal(1), goal(0.5)], launched, checks, flight(0.95)).verdict).toBe("partial"); // flew well, but not all the science it set out to do
    expect(missionOutcome([goal(1)], launched, checks, flight(0.3)).verdict).toBe("failed");
    expect(missionOutcome([goal(1)], launched, checks, flight(0.95, 200)).verdict).toBe("failed"); // instruments dark for most of the flight
    expect(missionOutcome([goal(1)], launched, checks, flight(0.95)).rule).toMatch(/^Game rule/);
  });
});

describe("wiring without a language model", () => {
  it("understands a plain request to connect a part, and says so when there is nothing to connect or no such part", () => {
    const base = lunar();
    const loose = valid({ ...base, spacecraft: { ...base.spacecraft, components: [...base.spacecraft.components, item("ns", "inst1")] } });
    const at = (config: MissionConfig): never => ({ config, version: 1, derived: recalculate(config).derived }) as never;
    const r = analyzeRuleBased("connect the neutron spectrometer", at(loose));
    expect(r.operations).toHaveLength(1);
    expect(r.operations[0]).toMatchObject({ intent: "set_config", description: "Connect Neutron spectrometer with its standard lines" });
    expect((r.operations[0]!.params.patches as { value: { kind: string } }[]).map((p) => p.value.kind).sort()).toEqual(["control", "data", "power"]);
    expect(analyzeRuleBased("wire up inst1", at(loose)).operations).toHaveLength(1);
    expect(analyzeRuleBased("connect the neutron spectrometer", at(installPart(base, item("ns", "inst1")))).missingInformation[0]!.question).toMatch(/already has every line it needs/);
    expect(analyzeRuleBased("connect the flux capacitor", at(loose)).missingInformation[0]!.question).toMatch(/No part called "the flux capacitor"|No part called "flux capacitor"/);
  });
});
