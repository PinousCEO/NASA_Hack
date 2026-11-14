/**
 * The systems graph: ports on every part, and the lines between them.
 *
 * A part does nothing by itself. A solar array feeds the spacecraft only through a power line to the
 * bus; an instrument runs only if a power line reaches it, and its measurements are kept only if a
 * data line carries them to storage; an antenna sends only what a data line feeds it; and onboard
 * control logic can command only the parts it has a control line to. Every line has a rating — what
 * it can carry — and a mass. A line that is too small limits the part behind it.
 *
 * `analyse` works out what actually flows; `effectiveSpacecraft` hands the engineering models the
 * parts as they really operate through their wiring. Nothing here is visual.
 *
 * Simplifications, stated: power is distributed as a star through the bus; line losses and voltage
 * are not modelled; a part behind an undersized line is treated as running the matching share of
 * the time; a rover's parts are not wired here (they are treated as connected).
 */
import { type Component, type Link, type MissionConfig, registerIntegrityRule } from "../state/schema.js";

export const BUS = "bus";
const EMPTY: MissionConfig["systems"] = { wired: false, links: [], controllers: [] };
/** The systems block, tolerating configurations written before it existed. */
export const sys = (config: MissionConfig): MissionConfig["systems"] => config.systems ?? EMPTY;
export type LinkKind = Link["kind"];

export interface Port {
  name: string;
  kind: LinkKind;
  dir: "in" | "out" | "both";
  unit: "W" | "bit/s" | "command";
  label: string;
}

const P = (name: string, kind: LinkKind, dir: Port["dir"], label: string): Port => ({ name, kind, dir, unit: kind === "power" ? "W" : kind === "data" ? "bit/s" : "command", label });

const PORTS: Record<Component["type"] | "bus", Port[]> = {
  bus: [P("power", "power", "both", "Power distribution"), P("data_in", "data", "in", "Onboard storage (in)"), P("data_out", "data", "out", "Onboard storage (out)"), P("control_out", "control", "out", "Flight computer commands")],
  solar_panel: [P("power_out", "power", "out", "Generated power")],
  battery: [P("power", "power", "both", "Charge / discharge")],
  antenna: [P("power_in", "power", "in", "Transmitter supply"), P("data_in", "data", "in", "Data to send"), P("control_in", "control", "in", "Commands")],
  load: [P("power_in", "power", "in", "Supply"), P("control_in", "control", "in", "Commands")],
  instrument: [P("power_in", "power", "in", "Supply"), P("data_out", "data", "out", "Measurements"), P("control_in", "control", "in", "Commands")],
  adcs: [P("power_in", "power", "in", "Supply")],
  computer: [P("power_in", "power", "in", "Supply"), P("data_in", "data", "in", "Data in"), P("data_out", "data", "out", "Processed data out"), P("control_out", "control", "out", "Commands")],
};

export const portsOf = (type: Component["type"] | "bus"): Port[] => PORTS[type];

const typeOf = (config: MissionConfig, node: string): Component["type"] | "bus" | null =>
  node === BUS ? BUS : (config.spacecraft.components.find((c) => c.id === node)?.type ?? null);

const nameOf = (config: MissionConfig, node: string): string => (node === BUS ? "the bus" : (config.spacecraft.components.find((c) => c.id === node)?.name ?? node));

/** Peak electrical power a part draws (or, for an array, makes at 1 AU facing the Sun), W. */
export function peakPowerW(c: Component): number {
  switch (c.type) {
    case "solar_panel": return c.areaM2 * c.efficiency * 1361;
    case "antenna": return c.dcPowerW;
    case "battery": return 0;
    default: return c.powerW;
  }
}

/** Mass of a line, kg: heavier for more current or more bandwidth (rule-of-thumb harness figures, not a supplier's). */
export function linkMassKg(link: Link): number {
  const perM = link.kind === "power" ? 0.02 + 0.00025 * (link.rating ?? 0) : link.kind === "data" ? 0.02 + 0.01 * Math.log10((link.rating ?? 0) / 1e6 + 1) : 0.01;
  return perM * link.lengthM;
}

/** Why a line cannot exist, or null when it is valid. This is what blocks an incompatible connection. */
export function linkIssue(config: MissionConfig, link: Link): string | null {
  const ends = [link.from, link.to].map((e) => {
    const type = typeOf(config, e.node);
    return { e, type, port: type ? portsOf(type).find((p) => p.name === e.port) : undefined };
  });
  for (const { e, type, port } of ends) {
    if (!type) return `line "${link.id}": there is no part "${e.node}" on the spacecraft`;
    if (!port) return `line "${link.id}": ${nameOf(config, e.node)} has no port "${e.port}" (its ports: ${portsOf(type).map((p) => p.name).join(", ")})`;
    if (port.kind !== link.kind) return `line "${link.id}": a ${link.kind} line cannot plug into ${nameOf(config, e.node)}'s ${port.name} port, which carries ${port.kind} (${port.unit})`;
  }
  const [from, to] = ends as [typeof ends[number], typeof ends[number]];
  if (link.from.node === link.to.node) return `line "${link.id}": both ends are on ${nameOf(config, link.from.node)}`;
  if (from.port!.dir === "in") return `line "${link.id}": ${nameOf(config, link.from.node)}'s ${from.port!.name} is an input; a line must start at an output`;
  if (to.port!.dir === "out") return `line "${link.id}": ${nameOf(config, link.to.node)}'s ${to.port!.name} is an output; a line must end at an input`;
  if (link.kind === "power" && link.from.node !== BUS && link.to.node !== BUS) return `line "${link.id}": power is distributed through the bus, so one end of a power line must be the bus`;
  if (link.kind !== "control" && link.rating === undefined) return `line "${link.id}": a ${link.kind} line needs a rating (${link.kind === "power" ? "W" : "bit/s"})`;
  return null;
}

export function systemsIssues(config: MissionConfig): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const link of sys(config).links) {
    const issue = linkIssue(config, link);
    if (issue) issues.push(issue);
    const key = `${link.kind}|${link.from.node}.${link.from.port}|${link.to.node}.${link.to.port}`;
    if (seen.has(key)) issues.push(`line "${link.id}": there is already a ${link.kind} line between these two ports; change its rating instead of adding a second`);
    seen.add(key);
  }
  return issues;
}
registerIntegrityRule(systemsIssues);

/** Lines that lost one of their ends (the part was removed) are removed with it. */
export function pruneSystems(config: MissionConfig): MissionConfig {
  const ids = new Set([BUS, ...config.spacecraft.components.map((c) => c.id)]);
  const links = sys(config).links.filter((l) => ids.has(l.from.node) && ids.has(l.to.node));
  const controllers = sys(config).controllers.map((c) => (c.downlinkPriority.every((id) => ids.has(id)) ? c : { ...c, downlinkPriority: c.downlinkPriority.filter((id) => ids.has(id)) }));
  if (links.length === sys(config).links.length && controllers.every((c, i) => c === sys(config).controllers[i])) return config;
  return { ...config, systems: { ...config.systems, links, controllers } };
}

/** A typical line run on this spacecraft, m: it scales with the size of the bus (a CubeSat's lines are centimetres, an orbiter's a metre or two). */
export const harnessRunM = (config: MissionConfig): number => Math.min(3, Math.max(0.15, Math.round(0.2 * Math.cbrt(config.spacecraft.busDryMassKg) * 20) / 20));

const sig = (v: number): number => (v <= 0 ? 0 : Number(v.toPrecision(2)));

/** The standard harness for one part: lines sized 25% above what the part needs. */
export function standardLinks(config: MissionConfig, componentId: string): Link[] {
  const c = config.spacecraft.components.find((x) => x.id === componentId);
  if (!c) return [];
  const taken = new Set(sys(config).links.map((l) => l.id));
  const out: Link[] = [];
  const add = (suffix: string, kind: LinkKind, from: Link["from"], to: Link["to"], rating?: number): void => {
    let id = `ln-${componentId}-${suffix}`.slice(0, 60);
    for (let i = 2; taken.has(id); i++) id = `ln-${componentId}-${suffix}${i}`.slice(0, 60);
    taken.add(id);
    out.push({ id, kind, from, to, lengthM: harnessRunM(config), ...(rating !== undefined ? { rating } : {}) });
  };
  const has = (kind: LinkKind, port: string): boolean => sys(config).links.some((l) => l.kind === kind && ((l.from.node === c.id && l.from.port === port) || (l.to.node === c.id && l.to.port === port)));
  const power = Math.max(5, sig(peakPowerW(c) * 1.25));
  if (c.type === "solar_panel") { if (!has("power", "power_out")) add("pwr", "power", { node: c.id, port: "power_out" }, { node: BUS, port: "power" }, power); }
  else if (c.type === "battery") { if (!has("power", "power")) add("pwr", "power", { node: c.id, port: "power" }, { node: BUS, port: "power" }, Math.max(20, sig(c.capacityWh / 2))); }
  else if (!has("power", "power_in")) add("pwr", "power", { node: BUS, port: "power" }, { node: c.id, port: "power_in" }, power);
  if (c.type === "instrument") {
    if (!has("data", "data_out")) add("data", "data", { node: c.id, port: "data_out" }, { node: BUS, port: "data_in" }, Math.max(1e4, sig(c.dataRateBps * 1.25)));
    if (!has("control", "control_in")) add("ctl", "control", { node: BUS, port: "control_out" }, { node: c.id, port: "control_in" });
  }
  if (c.type === "antenna") {
    if (!has("data", "data_in")) add("data", "data", { node: BUS, port: "data_out" }, { node: c.id, port: "data_in" }, Math.max(1e4, sig(c.dataRateBps * 1.25)));
    if (!has("control", "control_in")) add("ctl", "control", { node: BUS, port: "control_out" }, { node: c.id, port: "control_in" });
  }
  if (c.type === "load" && !has("control", "control_in")) add("ctl", "control", { node: BUS, port: "control_out" }, { node: c.id, port: "control_in" });
  if (c.type === "computer") {
    if (!has("data", "data_out")) add("data", "data", { node: c.id, port: "data_out" }, { node: BUS, port: "data_in" }, 2e8);
  }
  return out;
}

/** Wire every part of a mission with its standard harness: the state a mission is handed to its crew in. */
export function prewire(config: MissionConfig): MissionConfig {
  let next: MissionConfig = { ...config, systems: { ...config.systems, wired: true } };
  for (const c of config.spacecraft.components) {
    next = { ...next, systems: { ...sys(next), links: [...sys(next).links, ...standardLinks(next, c.id)] } };
  }
  return next;
}

/**
 * What it takes to give a part a full harness: the lines it is missing, and a new rating for any line
 * that has become too small for it (after its power or data rate was raised).
 */
export function harnessPatches(config: MissionConfig, componentId: string): { op: "append" | "set"; path: string; value: unknown }[] {
  const c = config.spacecraft.components.find((x) => x.id === componentId);
  if (!c || !sys(config).wired) return [];
  const patches: { op: "append" | "set"; path: string; value: unknown }[] = standardLinks(config, componentId).map((l) => ({ op: "append" as const, path: "systems.links", value: l }));
  const bare: MissionConfig = { ...config, systems: { ...sys(config), links: [] } };
  for (const want of standardLinks(bare, componentId)) {
    if (want.rating === undefined) continue;
    const mine = sys(config).links.filter((l) => l.kind === want.kind && l.from.node === want.from.node && l.from.port === want.from.port && l.to.node === want.to.node && l.to.port === want.to.port);
    const need = want.rating / 1.25;
    if (mine.length === 1 && c.type !== "battery" && (mine[0]!.rating ?? 0) < need * 0.999) patches.push({ op: "set", path: `systems.links.${mine[0]!.id}.rating`, value: want.rating });
  }
  return patches;
}

/** The mission with every part's harness brought up to what the part now needs. */
export function refitHarness(config: MissionConfig): MissionConfig {
  let next = config;
  for (const c of config.spacecraft.components) {
    for (const p of harnessPatches(next, c.id)) {
      const links = sys(next).links;
      next = { ...next, systems: { ...sys(next), links: p.op === "append" ? [...links, p.value as Link] : links.map((l) => (p.path === `systems.links.${l.id}.rating` ? { ...l, rating: p.value as number } : l)) } };
    }
  }
  return next;
}

/** A part put on the spacecraft together with its standard harness (in a wired mission). */
export function installPart(config: MissionConfig, component: Component): MissionConfig {
  const withPart: MissionConfig = { ...config, spacecraft: { ...config.spacecraft, components: [...config.spacecraft.components, component] } };
  if (!sys(config).wired) return withPart;
  return { ...withPart, systems: { ...sys(withPart), links: [...sys(withPart).links, ...standardLinks(withPart, component.id)] } };
}

export interface PartStatus {
  id: string;
  name: string;
  type: Component["type"];
  /** Share of its power the wiring delivers (or, for an array, takes away), 0–1. */
  power: number;
  /** Share of its data the wiring carries, 0–1; null for parts with no data port. */
  data: number | null;
  /** Whether onboard control logic can command it; null for parts with no control port. */
  commandable: boolean | null;
  /** What is wrong, in plain words; empty when the part is fully connected. */
  notes: string[];
}

export interface LinkFlow {
  id: string;
  kind: LinkKind;
  from: string;
  to: string;
  rating: number | null;
  /** What the line carries at the part's peak: W or bit/s. Null for control lines. */
  flow: number | null;
  unit: Port["unit"];
  utilisation: number | null;
  massKg: number;
  lengthM: number;
}

export interface Wiring {
  wired: boolean;
  parts: PartStatus[];
  links: LinkFlow[];
  harnessMassKg: number;
  /** Parts doing nothing because a line is missing. */
  unconnected: string[];
  /** Parts held back by an undersized line. */
  limited: string[];
}

const touches = (l: Link, node: string, port: string): boolean => (l.from.node === node && l.from.port === port) || (l.to.node === node && l.to.port === port);

/** What actually flows through the wiring. */
export function analyse(config: MissionConfig): Wiring {
  const links = sys(config).links.filter((l) => linkIssue(config, l) === null);
  const comps = config.spacecraft.components;
  const harnessMassKg = links.reduce((s, l) => s + linkMassKg(l), 0);
  if (!sys(config).wired) {
    return { wired: false, parts: comps.map((c) => ({ id: c.id, name: c.name, type: c.type, power: 1, data: c.type === "instrument" || c.type === "antenna" ? 1 : null, commandable: c.type === "instrument" || c.type === "antenna" || c.type === "load" ? true : null, notes: [] })), links: [], harnessMassKg: 0, unconnected: [], limited: [] };
  }
  const powerShare = (c: Component, port: string): number => {
    const mine = links.filter((l) => l.kind === "power" && touches(l, c.id, port) && (l.from.node === BUS || l.to.node === BUS));
    if (!mine.length) return 0;
    const peak = peakPowerW(c);
    return peak <= 0 ? 1 : Math.min(1, mine.reduce((s, l) => s + (l.rating ?? 0), 0) / peak);
  };
  const power = new Map<string, number>(comps.map((c) => [c.id, powerShare(c, c.type === "solar_panel" ? "power_out" : c.type === "battery" ? "power" : "power_in")]));
  const alive = (node: string): boolean => node === BUS || (power.get(node) ?? 0) > 0;
  const parts: PartStatus[] = comps.map((c) => {
    const p = power.get(c.id)!;
    const notes: string[] = [];
    let data: number | null = null;
    let commandable: boolean | null = null;
    if (p === 0) notes.push(c.type === "solar_panel" ? "No power line to the bus: what it generates goes nowhere." : c.type === "battery" ? "No power line to the bus: it is not charging or supplying anything." : "No power line from the bus: it is switched off.");
    else if (p < 1) notes.push(c.type === "solar_panel" ? `Its power line carries only ${(p * 100).toFixed(0)}% of what it can generate.` : `Its power line carries only ${(p * 100).toFixed(0)}% of what it draws, so it runs that share of the time.`);
    if (c.type === "instrument") {
      const out = links.filter((l) => l.kind === "data" && l.from.node === c.id && l.from.port === "data_out" && alive(l.to.node));
      data = !out.length ? 0 : c.dataRateBps <= 0 ? 1 : Math.min(1, out.reduce((s, l) => s + (l.rating ?? 0), 0) / c.dataRateBps);
      if (data === 0) notes.push("No data line to storage: its measurements are not recorded.");
      else if (data < 1) notes.push(`Its data line carries only ${(data * 100).toFixed(0)}% of what it measures; the rest is not recorded.`);
    }
    if (c.type === "antenna") {
      const feed = links.filter((l) => l.kind === "data" && l.to.node === c.id && l.to.port === "data_in" && alive(l.from.node));
      data = !feed.length ? 0 : Math.min(1, feed.reduce((s, l) => s + (l.rating ?? 0), 0) / c.dataRateBps);
      if (data === 0) notes.push("No data line feeding it: it has nothing to send.");
      else if (data < 1) notes.push(`The data line feeding it carries only ${(data * 100).toFixed(0)}% of its downlink rate.`);
    }
    if (c.type === "instrument" || c.type === "antenna" || c.type === "load") {
      commandable = links.some((l) => l.kind === "control" && l.to.node === c.id && alive(l.from.node));
    }
    if (c.type === "computer" && p > 0 && !links.some((l) => l.kind === "data" && (l.from.node === c.id || l.to.node === c.id))) notes.push("No data line: its storage and compression are not in the data path.");
    return { id: c.id, name: c.name, type: c.type, power: p, data, commandable, notes };
  });
  const byId = new Map(parts.map((p) => [p.id, p]));
  const flows: LinkFlow[] = links.map((l) => {
    const far = l.from.node === BUS ? l.to.node : l.from.node;
    const c = comps.find((x) => x.id === far) ?? comps.find((x) => x.id === l.to.node);
    let flow: number | null = null;
    if (l.kind === "power" && c) flow = Math.min(l.rating ?? 0, peakPowerW(c));
    if (l.kind === "data") {
      const src = comps.find((x) => x.id === l.from.node);
      const dst = comps.find((x) => x.id === l.to.node);
      const rate = src?.type === "instrument" ? src.dataRateBps : dst?.type === "antenna" ? dst.dataRateBps : (l.rating ?? 0);
      flow = Math.min(l.rating ?? 0, rate);
    }
    return { id: l.id, kind: l.kind, from: `${l.from.node}.${l.from.port}`, to: `${l.to.node}.${l.to.port}`, rating: l.rating ?? null, flow, unit: l.kind === "power" ? "W" : l.kind === "data" ? "bit/s" : "command", utilisation: flow !== null && l.rating ? flow / l.rating : null, massKg: linkMassKg(l), lengthM: l.lengthM };
  });
  return {
    wired: true,
    parts,
    links: flows,
    harnessMassKg,
    unconnected: parts.filter((p) => p.power === 0 || p.data === 0).map((p) => p.id),
    limited: parts.filter((p) => (p.power > 0 && p.power < 1) || (p.data !== null && p.data > 0 && p.data < 1)).map((p) => p.id).filter((id) => byId.get(id)!.power > 0),
  };
}

/** The spacecraft's parts as they really operate through their wiring: what the engineering models are run on. */
export function effectiveComponents(config: MissionConfig, wiring: Wiring = analyse(config)): Component[] {
  if (!wiring.wired) return config.spacecraft.components;
  const status = new Map(wiring.parts.map((p) => [p.id, p]));
  const out: Component[] = [];
  for (const c of config.spacecraft.components) {
    const s = status.get(c.id)!;
    if (s.power === 1 && (s.data === null || s.data === 1) && s.notes.length === 0) { out.push(c); continue; }
    switch (c.type) {
      case "solar_panel": if (s.power > 0) out.push({ ...c, efficiency: c.efficiency * s.power }); break;
      case "battery": if (s.power > 0) out.push(c); break;
      case "adcs": if (s.power > 0) out.push({ ...c, dutyCycle: c.dutyCycle * s.power }); break;
      case "load": out.push({ ...c, dutyCycle: c.dutyCycle * s.power }); break;
      case "computer": if (s.power > 0) out.push(s.notes.length ? { ...c, dutyCycle: c.dutyCycle * s.power, storageGb: 0, compressionRatio: 1 } : { ...c, dutyCycle: c.dutyCycle * s.power }); break;
      case "instrument": out.push({ ...c, dutyCycle: c.dutyCycle * s.power, dataRateBps: c.dataRateBps * (s.data ?? 1) }); break;
      case "antenna": out.push({ ...c, dutyCycle: c.dutyCycle * s.power * (s.data ?? 1) }); break;
    }
  }
  return out;
}

/** The mission with its spacecraft parts replaced by how they operate through the wiring. */
export function effectiveMission(config: MissionConfig): MissionConfig {
  if (!sys(config).wired) return config;
  return { ...config, spacecraft: { ...config.spacecraft, components: effectiveComponents(config) } };
}

/** Ports and connections of one part, for the people and the AI looking at it. */
export function describePart(config: MissionConfig, id: string): { ports: (Port & { lines: { id: string; other: string; rating: number | null }[] })[]; status: PartStatus | null } | null {
  const type = typeOf(config, id);
  if (!type) return null;
  const wiring = analyse(config);
  return {
    ports: portsOf(type).map((p) => ({ ...p, lines: sys(config).links.filter((l) => touches(l, id, p.name)).map((l) => ({ id: l.id, other: l.from.node === id ? `${l.to.node}.${l.to.port}` : `${l.from.node}.${l.from.port}`, rating: l.rating ?? null })) })),
    status: wiring.parts.find((p) => p.id === id) ?? null,
  };
}
