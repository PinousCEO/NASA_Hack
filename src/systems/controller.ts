/**
 * Onboard control logic.
 *
 * A controller is a list of rules — "when <condition> then set <target> to <value>" — written in
 * the small expression language of expr.ts. It runs on the bus flight computer or on an onboard
 * computer, once per simulated day, reads the spacecraft's state through named signals, and
 * commands the parts its host has a control line to. It can also remember numbers between days,
 * which is what makes it a state machine rather than a lookup, and it can set the order in which
 * instruments' data is sent down.
 *
 * Nothing here is eval'd. Rules are parsed into trees and walked; a rule can only produce a number,
 * and a number can only become a duty cycle of a part the controller is wired to, or one of its own
 * remembered values. A bad rule is rejected when the design is validated, before it can fly.
 */
import { type Controller, type MissionConfig, registerIntegrityRule } from "../state/schema.js";
import { INSTRUMENT_KINDS } from "../state/schema.js";
import { evaluate, type Expr, ExprError, parseExpr, refsOf } from "./expr.js";
import { analyse, BUS, sys, type Wiring } from "./graph.js";

/** The signals a rule can read, with what they mean. This list is the contract shown to players and to the AI. */
export const SIGNALS: { name: string; unit: string; meaning: string }[] = [
  { name: "day", unit: "days", meaning: "Days since the mission started" },
  { name: "battery.soc", unit: "0–1", meaning: "Energy reserve left, as a share of the battery (1 = full)" },
  { name: "power.marginW", unit: "W", meaning: "Today's generation minus load if every part ran at its normal setting" },
  { name: "power.generationW", unit: "W", meaning: "Today's orbit-average generation" },
  { name: "eclipse.fraction", unit: "0–1", meaning: "Share of each orbit spent in shadow today" },
  { name: "sun.distanceAu", unit: "AU", meaning: "Distance from the Sun today" },
  { name: "link.marginDb", unit: "dB", meaning: "Downlink margin today (negative = the link does not close)" },
  { name: "link.up", unit: "0/1", meaning: "1 when the downlink closes and the ground station is available" },
  { name: "storage.fill", unit: "0–1", meaning: "How full onboard storage is" },
  { name: "storage.gb", unit: "Gb", meaning: "Science data waiting on board" },
  { name: "data.generatedGbPerDay", unit: "Gb/day", meaning: "Data the instruments make per day at their normal settings" },
  { name: "data.downlinkGbPerDay", unit: "Gb/day", meaning: "Data the downlink can carry per day at its normal setting" },
  { name: "array.health", unit: "0–1", meaning: "Share of the solar array still working" },
  { name: "battery.health", unit: "0–1", meaning: "Share of the battery still working" },
  { name: "station.down", unit: "0/1", meaning: "1 while the ground station is out of service" },
];
const SIGNAL_NAMES = new Set(SIGNALS.map((s) => s.name));

export const TARGET_FORMS = [
  "instrument:<id> — one instrument's on-time (duty cycle, 0–1)",
  "kind:<instrument kind> — every instrument of that kind",
  "instruments — every instrument",
  "antenna:<id> / antennas — transmit time (duty cycle, 0–1)",
  "load:<id> / loads — a heater or other load (duty cycle, 0–1)",
  "mem:<name> — one of the controller's own remembered numbers",
];

type TargetType = "instrument" | "antenna" | "load";
type Target = { form: "one"; type: TargetType; id: string } | { form: "all"; type: TargetType } | { form: "kind"; kind: string } | { form: "mem"; name: string };

function parseTarget(text: string): Target | string {
  const t = text.trim();
  if (t === "instruments") return { form: "all", type: "instrument" };
  if (t === "antennas") return { form: "all", type: "antenna" };
  if (t === "loads") return { form: "all", type: "load" };
  const i = t.indexOf(":");
  if (i < 0) return `"${t}" is not a target (forms: ${TARGET_FORMS.map((f) => f.split(" — ")[0]).join("; ")})`;
  const head = t.slice(0, i);
  const rest = t.slice(i + 1).trim();
  if (!rest) return `"${t}" names nothing after the colon`;
  if (head === "instrument" || head === "antenna" || head === "load") return { form: "one", type: head, id: rest };
  if (head === "kind") return (INSTRUMENT_KINDS as readonly string[]).includes(rest) ? { form: "kind", kind: rest } : `"${rest}" is not an instrument kind (${INSTRUMENT_KINDS.join(", ")})`;
  if (head === "mem") return { form: "mem", name: rest };
  return `"${head}:" is not a kind of target`;
}

interface Compiled {
  rules: { when: Expr; actions: { target: Target; value: Expr }[] }[];
}
const cache = new WeakMap<Controller, Compiled | { error: string }>();

function compile(c: Controller): Compiled | { error: string } {
  const hit = cache.get(c);
  if (hit) return hit;
  let out: Compiled | { error: string };
  try {
    out = {
      rules: c.rules.map((r, i) => {
        let when: Expr;
        try { when = parseExpr(r.when); } catch (err) { throw new ExprError(`rule ${i + 1} condition "${r.when}": ${(err as Error).message}`); }
        const actions = r.do.map((a) => {
          const target = parseTarget(a.target);
          if (typeof target === "string") throw new ExprError(`rule ${i + 1}: ${target}`);
          let value: Expr;
          try { value = parseExpr(a.value); } catch (err) { throw new ExprError(`rule ${i + 1} value "${a.value}": ${(err as Error).message}`); }
          return { target, value };
        });
        return { when, actions };
      }),
    };
  } catch (err) {
    out = { error: (err as Error).message };
  }
  cache.set(c, out);
  return out;
}

/** Why a controller cannot fly, as a list of plain-language problems. Empty when it is valid. */
export function controllerIssues(config: MissionConfig, c: Controller, wiring: Wiring = analyse(config)): string[] {
  const label = `controller "${c.name || c.id}"`;
  const comps = config.spacecraft.components;
  if (c.hostId !== BUS && comps.find((x) => x.id === c.hostId)?.type !== "computer") return [`${label}: it must run on "bus" or on an onboard computer, and "${c.hostId}" is neither`];
  const compiled = compile(c);
  if ("error" in compiled) return [`${label}: ${compiled.error}`];
  const issues: string[] = [];
  const known = (name: string, inValue: boolean): boolean => SIGNAL_NAMES.has(name) || (name.startsWith("mem.") && name.slice(4) in c.memory) || (inValue && name === "nominal");
  const links = sys(config).links;
  const commanded = (id: string): boolean => !sys(config).wired || links.some((l) => l.kind === "control" && l.from.node === c.hostId && l.to.node === id);
  compiled.rules.forEach((r, i) => {
    for (const name of refsOf(r.when)) if (!known(name, false)) issues.push(`${label}, rule ${i + 1}: "${name}" is not a signal it can read (signals: ${[...SIGNAL_NAMES].join(", ")}${Object.keys(c.memory).length ? `, ${Object.keys(c.memory).map((m) => `mem.${m}`).join(", ")}` : ""})`);
    for (const a of r.actions) {
      for (const name of refsOf(a.value)) if (!known(name, a.target.form !== "mem")) issues.push(`${label}, rule ${i + 1}: "${name}" is not a signal it can read`);
      if (a.target.form === "mem" && !(a.target.name in c.memory)) issues.push(`${label}, rule ${i + 1}: it sets mem:${a.target.name}, which is not declared in its memory`);
      if (a.target.form === "one") {
        const part = comps.find((x) => x.id === (a.target as { id: string }).id);
        if (!part || part.type !== a.target.type) issues.push(`${label}, rule ${i + 1}: there is no ${a.target.type} "${a.target.id}" on the spacecraft`);
        else if (!commanded(part.id)) issues.push(`${label}, rule ${i + 1}: there is no control line from ${c.hostId === BUS ? "the bus" : c.hostId} to ${part.name} (${part.id}), so it cannot be commanded. Add a control line ${c.hostId}.control_out → ${part.id}.control_in`);
      }
    }
  });
  for (const id of c.downlinkPriority) if (comps.find((x) => x.id === id)?.type !== "instrument") issues.push(`${label}: downlink priority names "${id}", which is not an instrument on the spacecraft`);
  void wiring;
  return issues;
}

registerIntegrityRule((config) => sys(config).controllers.flatMap((c) => controllerIssues(config, c)));

export interface ControlStep {
  /** Commanded duty cycles by part id (0–1). Parts not listed run at their normal setting. */
  duty: Map<string, number>;
  /** Each controller's remembered numbers after this step. */
  memory: Record<string, Record<string, number>>;
  /** Which rules fired; `commands` lists the parts each one commanded. */
  fired: { controllerId: string; rule: number; note?: string; commands: string[] }[];
  /** Instrument ids in the order their data goes down, when a running controller sets one. */
  priority: string[] | null;
}

/** Run every enabled controller once against today's signals. Pure and deterministic. */
export function stepControllers(config: MissionConfig, signals: Record<string, number>, memory: Record<string, Record<string, number>>, wiring: Wiring = analyse(config)): ControlStep {
  const duty = new Map<string, number>();
  const fired: ControlStep["fired"] = [];
  const nextMemory: Record<string, Record<string, number>> = {};
  let priority: string[] | null = null;
  const comps = config.spacecraft.components;
  const status = new Map(wiring.parts.map((p) => [p.id, p]));
  for (const c of sys(config).controllers) {
    const mem = { ...c.memory, ...(memory[c.id] ?? {}) };
    nextMemory[c.id] = mem;
    if (!c.enabled) continue;
    // A controller on a computer that has no power does not run.
    if (c.hostId !== BUS && (status.get(c.hostId)?.power ?? 0) <= 0) continue;
    const compiled = compile(c);
    if ("error" in compiled) continue;
    const reach = (id: string): boolean => !sys(config).wired || sys(config).links.some((l) => l.kind === "control" && l.from.node === c.hostId && l.to.node === id);
    const env = (name: string): number | undefined => (name.startsWith("mem.") ? mem[name.slice(4)] : signals[name]);
    compiled.rules.forEach((r, i) => {
      let on: number;
      try { on = evaluate(r.when, env); } catch { return; }
      if (on === 0) return;
      const note = c.rules[i]?.note;
      const commands: string[] = [];
      fired.push({ controllerId: c.id, rule: i + 1, ...(note ? { note } : {}), commands });
      for (const a of r.actions) {
        if (a.target.form === "mem") {
          try { mem[a.target.name] = evaluate(a.value, env); } catch { /* leave as it was */ }
          continue;
        }
        const t = a.target;
        const parts = comps.filter((x) => (t.form === "one" ? x.id === t.id && x.type === t.type : t.form === "all" ? x.type === t.type : x.type === "instrument" && x.kind === t.kind));
        for (const part of parts) {
          if (!reach(part.id) || !("dutyCycle" in part)) continue;
          try {
            const v = evaluate(a.value, (name) => (name === "nominal" ? part.dutyCycle : env(name)));
            duty.set(part.id, Math.min(1, Math.max(0, v)));
            commands.push(part.id);
          } catch { /* a rule that cannot be evaluated commands nothing */ }
        }
      }
    });
    if (c.downlinkPriority.length && !priority) priority = c.downlinkPriority;
  }
  return { duty, memory: nextMemory, fired, priority };
}

/** The mission with today's commanded duty cycles applied. */
export function applyDuty(config: MissionConfig, duty: Map<string, number>): MissionConfig {
  if (!duty.size) return config;
  return { ...config, spacecraft: { ...config.spacecraft, components: config.spacecraft.components.map((c) => (duty.has(c.id) && "dutyCycle" in c ? { ...c, dutyCycle: duty.get(c.id)! } : c)) } };
}
