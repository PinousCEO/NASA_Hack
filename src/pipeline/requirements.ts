/**
 * Natural-language requirement analysis: free text → structured operations.
 *
 * Primary path: a language model with a schema-constrained response. Fallback when no
 * model is configured: a small deterministic pattern analyser that covers common requests
 * and says so (`analysis.method = "rule_based"`). Both inspect the current mission state.
 */
import { z } from "zod";
import { AssetSpecSchema } from "../capabilities/assets.js";
import { PatchSchema } from "../capabilities/mission.js";
import type { PatchOp } from "../core/paths.js";
import { getPath } from "../core/paths.js";
import { newId, type VerificationLevel } from "../core/types.js";
import type { LlmService } from "../llm/llm.js";
import { BODIES } from "../science/orbital.js";
import { type Component, ComponentSchema, type MissionConfig } from "../state/schema.js";
import type { MissionVersion } from "../state/store.js";
import { applyPatches } from "../core/paths.js";
import { parseMissionConfig } from "../state/schema.js";
import { SIGNALS, TARGET_FORMS } from "../systems/controller.js";
import { EXPR_FUNCTIONS } from "../systems/expr.js";
import { harnessPatches, installPart, portsOf } from "../systems/graph.js";
import { INTENTS, type Intent, type MissingInformation, OPERATION_CATEGORIES, type Operation, type OperationCategory, type StructuredRequirement } from "./types.js";

type Draft = Omit<Operation, "id">;
interface RuleResult {
  operations?: Draft[];
  missing?: MissingInformation[];
}
type Rule = (clause: string, config: MissionConfig) => RuleResult | null;

const NUM = "(\\d+(?:\\.\\d+)?)";
const grab = (text: string, pattern: string): number | undefined => {
  const m = new RegExp(pattern, "i").exec(text);
  return m ? Number(m[1]) : undefined;
};

function freshId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;
const allComponents = (c: MissionConfig): Component[] => [...c.spacecraft.components, ...(c.rover?.components ?? [])];

function addComponentOp(config: MissionConfig, clause: string, component: Component, assumptions: string[]): Draft {
  const target = /\brover\b/i.test(clause) ? "rover" : "spacecraft";
  return {
    category: "component_creation",
    intent: "add_component",
    description: `Add ${component.type.replace("_", " ")} "${component.name}" to the ${target}`,
    params: { target, component, withAsset: true },
    assumptions,
  };
}

const RULES: Rule[] = [
  // Code generation / modification
  (clause) => {
    if (!/\b(write|generate|create|implement|modify|refactor)\b.*\b(script|code|module|function|behaviou?r|controller|routine)\b/i.test(clause)) return null;
    const modifying = /\b(modify|refactor|change|update)\b/i.test(clause);
    return {
      operations: [{
        category: modifying ? "code_modification" : "code_generation",
        intent: "generate_script",
        description: "Generate a sandboxed TypeScript mission script",
        params: { task: clause, name: clause.slice(0, 60), permissions: /\b(propose|change|set|adjust|update)\b/i.test(clause) ? ["state:read", "state:propose", "calc"] : ["state:read", "calc"] },
        assumptions: [],
      }],
    };
  },
  // Wiring: "connect inst1", "wire up the neutron spectrometer"
  (clause, config) => {
    const m = /\b(?:connect|wire(?:\s+up)?|hook\s+up)\s+(?:the\s+)?(.+?)[.!]?\s*$/i.exec(clause);
    if (!m) return null;
    const wanted = m[1]!.toLowerCase();
    const parts = config.spacecraft.components;
    const part = parts.find((c) => c.id.toLowerCase() === wanted) ?? parts.find((c) => c.name.toLowerCase() === wanted) ?? parts.find((c) => c.name.toLowerCase().includes(wanted));
    if (!part) return { missing: [{ field: "componentId", blocking: true, question: `No part called "${m[1]}" is on the spacecraft. Parts on board: ${parts.map((c) => `${c.name} (${c.id})`).join(", ")}` }] };
    const patches = harnessPatches(config, part.id);
    if (!patches.length) return { missing: [{ field: "componentId", blocking: true, question: `${part.name} already has every line it needs, at a rating that carries it.` }] };
    return { operations: [{ category: "engineering_design", intent: "set_config", description: `Connect ${part.name} with its standard lines`, params: { patches, rationale: clause }, assumptions: ["Lines sized 25% above the part's peak power and data rate"] }] };
  },
  // 3D asset generation
  (clause) => {
    if (!/\b(generate|create|make|build)\b.*\b(3d|model|asset|mesh|glb|gltf)\b/i.test(clause)) return null;
    const dims = [...clause.matchAll(new RegExp(`${NUM}\\s*(?:m|meters?|metres?)\\b`, "gi"))].map((m) => Number(m[1]));
    const kinds: [RegExp, (d: number[]) => unknown, number][] = [
      [/solar\s+(panel|array)/i, (d) => ({ kind: "solar_panel", widthM: d[0], heightM: d[1] }), 2],
      [/\b(dish|antenna)\b/i, (d) => ({ kind: "dish_antenna", diameterM: d[0] }), 1],
      [/\brover\b/i, (d) => ({ kind: "rover_chassis", lengthM: d[0], widthM: d[1], heightM: d[2], wheelRadiusM: d[3] }), 4],
      [/\bwheel\b/i, (d) => ({ kind: "wheel", radiusM: d[0], widthM: d[1] }), 2],
      [/\b(box|cube|block)\b/i, (d) => ({ kind: "box", widthM: d[0], heightM: d[1] ?? d[0], depthM: d[2] ?? d[0] }), 1],
      [/\bcylinder\b/i, (d) => ({ kind: "cylinder", radiusM: d[0], heightM: d[1] }), 2],
      [/\b(sphere|ball)\b/i, (d) => ({ kind: "sphere", radiusM: d[0] }), 1],
    ];
    const match = kinds.find(([re]) => re.test(clause));
    const freeForm = { operations: [{ category: "asset_generation_3d" as const, intent: "generate_asset" as const, description: "Generate a 3D model from the description (text-to-3D)", params: { prompt: clause.slice(0, 600) }, assumptions: ["No exact parametric shape and dimensions were given, so the model is synthesised from the description"] }] };
    if (!match) return freeForm;
    const [, build, needed] = match;
    if (dims.length < needed) return freeForm;
    const spec = AssetSpecSchema.safeParse(build(dims));
    if (!spec.success) return { missing: [{ field: "assetSpec", blocking: true, question: `The dimensions are not usable: ${spec.error.issues[0]?.message}` }] };
    return { operations: [{ category: "asset_generation_3d", intent: "generate_asset", description: `Generate a parametric ${spec.data.kind} asset`, params: { assetSpec: spec.data, description: clause.slice(0, 200) }, assumptions: [] }] };
  },
  // Simulation
  (clause) => {
    if (!/\bsimulat/i.test(clause) || !/\b(power|battery|charge|energy)\b/i.test(clause)) return null;
    const orbits = grab(clause, `${NUM}\\s*orbits?`);
    return { operations: [{ category: "simulation", intent: "simulate_power", description: "Simulate battery state of charge over several orbits", params: orbits !== undefined ? { orbits } : {}, assumptions: orbits === undefined ? ["Simulating 5 orbits (default)"] : [] }] };
  },
  // Component creation
  (clause, config) => {
    if (!/\badd\b/i.test(clause)) return null;
    const ids = allComponents(config).map((c) => c.id);
    const massKg = grab(clause, `${NUM}\\s*kg\\b`);
    if (/solar\s+(panel|array)/i.test(clause)) {
      const areaM2 = grab(clause, `${NUM}\\s*(?:m2|m²|m\\^2|sq(?:uare)?\\.?\\s*m)`);
      if (areaM2 === undefined) return { missing: [{ field: "component.areaM2", blocking: true, question: "What area should the new solar panel have (in m²)?" }] };
      const efficiencyPct = grab(clause, `${NUM}\\s*%`);
      const assumptions = [
        ...(efficiencyPct === undefined ? ["Cell efficiency 29.5% (typical triple-junction GaAs)"] : []),
        ...(massKg === undefined ? ["Mass estimated at 3.5 kg/m² (heuristic for rigid panels)"] : []),
      ];
      const component = ComponentSchema.parse({ id: freshId("sp", ids), type: "solar_panel", name: `Solar panel ${areaM2} m²`, massKg: massKg ?? round3(areaM2 * 3.5), areaM2, efficiency: (efficiencyPct ?? 29.5) / 100 });
      return { operations: [addComponentOp(config, clause, component, assumptions)] };
    }
    if (/\bbatter/i.test(clause)) {
      const capacityWh = grab(clause, `${NUM}\\s*wh\\b`);
      if (capacityWh === undefined) return { missing: [{ field: "component.capacityWh", blocking: true, question: "What capacity should the new battery have (in Wh)?" }] };
      const component = ComponentSchema.parse({ id: freshId("bat", ids), type: "battery", name: `Battery ${capacityWh} Wh`, massKg: massKg ?? round3(capacityWh / 150), capacityWh });
      return { operations: [addComponentOp(config, clause, component, massKg === undefined ? ["Mass estimated at 150 Wh/kg (heuristic, pack level)"] : [])] };
    }
    if (/\b(antenna|dish)\b/i.test(clause)) {
      const diameterM = grab(clause, `${NUM}\\s*(?:m|meters?|metres?)\\b`);
      if (diameterM === undefined) return { missing: [{ field: "component.diameterM", blocking: true, question: "What dish diameter should the new antenna have (in metres)?" }] };
      const frequencyGHz = grab(clause, `${NUM}\\s*ghz`);
      const txPowerW = grab(clause, `${NUM}\\s*w\\b`);
      const rate = new RegExp(`${NUM}\\s*([kmg])?bps`, "i").exec(clause);
      const dataRateBps = rate ? Number(rate[1]) * ({ k: 1e3, m: 1e6, g: 1e9 }[rate[2]?.toLowerCase() ?? ""] ?? 1) : undefined;
      const assumptions = [
        ...(frequencyGHz === undefined ? ["X-band downlink at 8.45 GHz"] : []),
        ...(txPowerW === undefined ? ["10 W RF transmit power"] : []),
        ...(dataRateBps === undefined ? ["1 Mbit/s data rate"] : []),
        "DC power draw assumed at 4.5x RF power (amplifier efficiency ≈ 22%)",
        ...(massKg === undefined ? ["Mass estimated at 8 kg/m² of aperture plus 1 kg (heuristic)"] : []),
      ];
      const rf = txPowerW ?? 10;
      const component = ComponentSchema.parse({
        id: freshId("ant", ids), type: "antenna", name: `${diameterM} m dish antenna`,
        massKg: massKg ?? round3(1 + 8 * Math.PI * (diameterM / 2) ** 2), frequencyGHz: frequencyGHz ?? 8.45, diameterM,
        txPowerW: rf, dcPowerW: rf * 4.5, dataRateBps: dataRateBps ?? 1e6,
      });
      return { operations: [addComponentOp(config, clause, component, assumptions)] };
    }
    return null;
  },
  // Component removal
  (clause, config) => {
    const m = /\b(?:remove|delete)\s+(?:the\s+)?(?:component\s+)?([\w-]+)/i.exec(clause);
    if (!m) return null;
    const id = m[1]!;
    const target = config.spacecraft.components.some((c) => c.id === id) ? "spacecraft" : config.rover?.components.some((c) => c.id === id) ? "rover" : null;
    if (!target) return { missing: [{ field: "componentId", blocking: true, question: `No component with id "${id}". Existing ids: ${allComponents(config).map((c) => c.id).join(", ")}` }] };
    const patches: PatchOp[] = [
      ...config.scene.nodes.filter((n) => n.componentId === id).map((n): PatchOp => ({ op: "remove", path: `scene.nodes.${n.id}` })),
      { op: "remove", path: `${target}.components.${id}` },
    ];
    return { operations: [{ category: "mission_configuration", intent: "set_config", description: `Remove component "${id}" from the ${target}`, params: { patches, rationale: clause }, assumptions: [] }] };
  },
  // Orbit altitude
  (clause, config) => {
    const alt = grab(clause, `altitude\\s*(?:to|=|of)\\s*${NUM}\\s*km`);
    if (alt === undefined || !/\b(set|change|raise|lower|update|move|adjust)\b/i.test(clause)) return null;
    const patches: PatchOp[] = [{ op: "set", path: "orbit.semiMajorAxisKm", value: BODIES[config.centralBody].radiusKm + alt }];
    if (config.orbit.eccentricity !== 0) patches.push({ op: "set", path: "orbit.eccentricity", value: 0 });
    return { operations: [{ category: "mission_configuration", intent: "set_config", description: `Set a circular orbit at ${alt} km altitude`, params: { patches, rationale: clause }, assumptions: config.orbit.eccentricity !== 0 ? ["Orbit circularised (eccentricity set to 0)"] : [] }] };
  },
  (clause) => {
    const inc = grab(clause, `inclination\\s*(?:to|=|of)\\s*${NUM}`);
    if (inc === undefined) return null;
    return { operations: [{ category: "mission_configuration", intent: "set_config", description: `Set orbit inclination to ${inc}°`, params: { patches: [{ op: "set", path: "orbit.inclinationDeg", value: inc }], rationale: clause }, assumptions: [] }] };
  },
  // Mission time
  (clause) => {
    const m = /\b(?:mission\s+)?(?:time|date)\s*(?:to|=)\s*(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?)/i.exec(clause);
    if (!m) return null;
    const raw = m[1]!;
    const iso = new Date(/T/.test(raw) ? (/(Z|[+-]\d{2}:\d{2})$/.test(raw) ? raw : `${raw}Z`) : `${raw}T00:00:00Z`);
    if (Number.isNaN(iso.getTime())) return { missing: [{ field: "missionTime", blocking: true, question: `"${raw}" is not a valid date.` }] };
    return { operations: [{ category: "mission_configuration", intent: "set_config", description: `Set mission time to ${iso.toISOString()}`, params: { patches: [{ op: "set", path: "missionTime", value: iso.toISOString() }], rationale: clause }, assumptions: /T/.test(raw) ? [] : ["Time of day 00:00 UTC"] }] };
  },
  // Generic "set <path> to <value>"
  (clause, config) => {
    const m = /^\s*(?:please\s+)?(?:set|change|update)\s+([a-zA-Z][\w-]*(?:\.[\w-]+)+)\s*(?:to|=)\s*(.+?)\s*$/i.exec(clause);
    if (!m) return null;
    const path = m[1]!;
    if (getPath(config, path) === undefined) return { missing: [{ field: path, blocking: true, question: `"${path}" is not an existing configuration path.` }] };
    let value: unknown = m[2]!.replace(/[.\s]+$/, "");
    try {
      value = JSON.parse(value as string);
    } catch {
      /* keep as string */
    }
    const category: OperationCategory = path.startsWith("scene.") ? "scene_modification" : path.startsWith("rover.") || path.startsWith("spacecraft.") ? "engineering_design" : "mission_configuration";
    return { operations: [{ category, intent: "set_config", description: `Set ${path} to ${JSON.stringify(value)}`, params: { patches: [{ op: "set", path, value }], rationale: clause }, assumptions: [] }] };
  },
  // Precise ephemeris retrieval
  (clause) => {
    const m = /\b(position|ephemeris|where\s+is|distance\s+(?:to|of|from)|state\s+vector)\b.*?\b(mars|moon|earth|sun)\b/i.exec(clause);
    if (!m) return null;
    const target = m[2]!.toLowerCase();
    const date = /\d{4}-\d{2}-\d{2}/.exec(clause)?.[0];
    return {
      operations: [{
        category: "data_retrieval", intent: "retrieve_ephemeris", description: `Retrieve the state vector of ${target} from JPL Horizons`,
        params: { target, center: target === "sun" || target === "moon" ? "earth" : "sun", ...(date ? { time: `${date}T00:00:00Z` } : {}) },
        assumptions: date ? [] : ["Evaluated at the current mission time"],
      }],
    };
  },
  // Calculations
  (clause) => {
    const alt = grab(clause, `(?:hohmann|transfer|delta-?v).*?${NUM}\\s*km`);
    if (alt === undefined) return null;
    return { operations: [{ category: "scientific_research", intent: "compute", description: `Hohmann transfer to ${alt} km altitude`, params: { need: "calc.orbit.transfer", targetAltitudeKm: alt }, assumptions: [] }] };
  },
  (clause) =>
    /\b(link\s+(budget|margin)|data\s*rate|downlink|communication\s+performance)\b/i.test(clause)
      ? { operations: [{ category: "scientific_research", intent: "compute", description: "Compute the downlink budget", params: { need: "calc.comms.link" }, assumptions: [] }] }
      : null,
  (clause) =>
    /\b(power\s+(budget|margin|generation|balance)|eclipse)\b/i.test(clause)
      ? { operations: [{ category: "scientific_research", intent: "compute", description: "Compute the power budget", params: { need: "calc.power.budget" }, assumptions: [] }] }
      : null,
  (clause) => {
    if (!/\b(orbital?\s+(period|velocity|speed|parameters|elements)|how\s+long.*\borbit)\b/i.test(clause)) return null;
    const alt = grab(clause, `${NUM}\\s*km`);
    return { operations: [{ category: "scientific_research", intent: "compute", description: "Compute orbit period and velocities", params: { need: "calc.orbit.elements", ...(alt !== undefined ? { altitudeKm: alt } : {}) }, assumptions: [] }] };
  },
  (clause, config) => {
    if (!/\brover\b/i.test(clause) || !/\b(climb|slope|traverse|mobility|incline|gradient)\b/i.test(clause)) return null;
    if (!config.rover) return { missing: [{ field: "rover", blocking: true, question: "This mission has no rover defined. Add a rover to the mission configuration first." }] };
    const slope = grab(clause, `${NUM}\\s*(?:deg|°)`);
    return { operations: [{ category: "engineering_design", intent: "compute", description: "Assess rover slope capability", params: { need: "calc.rover.mobility", ...(slope !== undefined ? { slopeDeg: slope } : {}) }, assumptions: slope === undefined ? ["Evaluated at the configured site slope"] : [] }] };
  },
  // Knowledge reuse
  (clause) =>
    /\b(similar|previous|past|earlier|history)\b.*\b(designs?|missions?|requests?|changes?|work)\b/i.test(clause)
      ? { operations: [{ category: "data_retrieval", intent: "search_memory", description: "Search research memory for similar past work", params: { query: clause }, assumptions: [] }] }
      : null,
];

export function analyzeRuleBased(text: string, mission: MissionVersion): StructuredRequirement {
  const clauses = text.split(/;|\n|\band then\b|,\s*then\b/i).map((c) => c.trim()).filter(Boolean);
  const operations: Operation[] = [];
  const missing: MissingInformation[] = [];
  for (const clause of clauses) {
    let hit: RuleResult | null = null;
    for (const rule of RULES) {
      hit = rule(clause, mission.config);
      if (hit) break;
    }
    if (!hit) {
      missing.push({
        field: "request",
        blocking: true,
        question: `I could not interpret "${clause}" with the built-in pattern analyser (no language model is configured). Rephrase it as a concrete action, e.g. "set orbit altitude to 150 km", "add a 0.5 m2 solar panel", "connect the neutron spectrometer", "set rover.site.slopeDeg to 18", "simulate battery over 10 orbits", "compute the link budget".`,
      });
      continue;
    }
    for (const op of hit.operations ?? []) operations.push({ ...op, id: `op${operations.length + 1}` });
    missing.push(...(hit.missing ?? []));
  }
  return {
    id: newId("req"),
    originalText: text,
    summary: operations.length ? operations.map((o) => o.description).join("; ") : "Request not understood",
    operations,
    missingInformation: missing,
    analysis: { method: "rule_based", verification: "heuristic" },
    missionVersionInspected: mission.version,
  };
}

const LlmRequirement = z.object({
  summary: z.string(),
  operations: z.array(
    z.object({
      category: z.enum(OPERATION_CATEGORIES),
      intent: z.enum(INTENTS),
      description: z.string(),
      paramsJson: z.string().describe("JSON object with the parameters for this intent"),
      assumptions: z.array(z.string()).describe("Values you filled in that the user did not state"),
    }),
  ),
  missingInformation: z.array(z.object({ field: z.string(), question: z.string(), blocking: z.boolean() })),
  directReply: z.string().optional().describe("Empty when operations are returned. Otherwise your reply to the player, in the player's language."),
  hypothesis: z.enum(["none", "supported", "conditional", "refuted", "outside_model"]).optional().describe("When the player put forward an idea: supported (it holds; you return the operations that build it), conditional (it can work only if something else changes — say what), refuted (it cannot work, for the reasons you give), outside_model (the engineering models here do not represent what the idea depends on, so it can be neither confirmed nor built). none for a plain question or instruction."),
});

const PORT_TABLE = `Ports — ${(["bus", "solar_panel", "battery", "instrument", "antenna", "computer", "load", "adcs"] as const).map((t) => `${t}: ${portsOf(t).map((p) => `${p.name} (${p.kind} ${p.dir})`).join(", ")}`).join("; ")}.`;
const SIGNAL_TABLE = SIGNALS.map((s) => `${s.name} [${s.unit}] ${s.meaning}`).join("; ");

/** One earlier exchange between a player and their AI. */
export interface Turn { said: string; replied: string; outcome: string }

/** Would these operations produce a valid mission? Returns the reasons when they would not. */
export function dryRun(operations: Operation[], config: MissionConfig): string[] {
  let next: unknown = config;
  try {
    for (const op of operations) {
      if (op.intent === "set_config") next = applyPatches(next, op.params.patches as PatchOp[]);
      if (op.intent === "add_component" && (op.params.target ?? "spacecraft") === "spacecraft") {
        const c = next as MissionConfig;
        next = op.params.connect === true ? installPart(c, op.params.component as Component) : { ...c, spacecraft: { ...c.spacecraft, components: [...c.spacecraft.components, op.params.component as Component] } };
      }
    }
  } catch (err) {
    return [err instanceof Error ? err.message : String(err)];
  }
  const parsed = parseMissionConfig(next);
  return parsed.ok ? [] : parsed.issues;
}

const ANALYSIS_SYSTEM = `You convert a user's natural-language request about a space-mission design into structured operations for an engineering pipeline. You do not execute anything.

Each operation has a category, an intent, and a JSON params object. Intents and their params:
- set_config: { "patches": [{"op":"set"|"append"|"remove","path":"dot.path","value":...}], "rationale": string } — change existing configuration values. Array elements are addressed by their id, e.g. "spacecraft.components.sp1.areaM2". Never patch "scripts" or "assets".
- add_component: { "target": "spacecraft"|"rover", "component": {...}, "withAsset": boolean } — component types and fields: solar_panel {id,type,name,massKg,areaM2,efficiency(0-1),pointingLoss,degradationPerYear}; battery {id,type,name,massKg,capacityWh,maxDepthOfDischarge}; antenna {id,type,name,massKg,frequencyGHz,diameterM or gainDbi,txPowerW,dcPowerW,dutyCycle,dataRateBps,otherLossesDb,requiredEbN0Db}; load {id,type,name,massKg,powerW,dutyCycle}; instrument {id,type,name,kind(camera|spectrometer|neutron_spectrometer|radar|magnetometer|thermal_imager|lidar),massKg,powerW,dutyCycle,dataRateBps,apertureM?,wavelengthUm?}; adcs {id,type,name,massKg,powerW,pointingAccuracyDeg,stabilityArcsec} (attitude control: sharper images, tighter antenna pointing); computer {id,type,name,massKg,powerW,storageGb,compressionRatio(1-20)} (onboard data handling). Every component may carry costMusd and leadTimeMonths. Choose an id not already in use.
- compute: { "need": tag, ... } — a calculation. Tags: calc.orbit.elements {altitudeKm?}, calc.orbit.transfer {targetAltitudeKm}, calc.power.budget, calc.comms.link {antennaId?, dataRateBps?}, calc.rover.mobility {slopeDeg?}, calc.ephemeris.sun {time?}.
- simulate_power: { "orbits"?: number }
- retrieve_ephemeris: { "target": "sun"|"earth"|"moon"|"mars", "center"?: same set, "time"?: ISO-8601 }
- generate_asset: either { "assetSpec": {"kind":"box"|"cylinder"|"sphere"|"solar_panel"|"dish_antenna"|"wheel"|"rover_chassis", ...dimensions in metres}, "description"?: string } for an exact parametric shape, or { "prompt": string } for a free-form object described in words (text-to-3D).
- generate_script: { "task": string, "name": string, "permissions"?: ["state:read","state:propose","calc"], "scriptId"?: id of an attached script to modify (category code_modification) }
- run_script: { "scriptId": string, "input"?: object }
- search_memory: { "query": string }
- custom: { "goal": string } — only when none of the above can express the operation; it will need multi-tool planning.

Wiring (config.systems.links). A part does nothing unless its lines exist: it needs a power line to or from the bus, an instrument needs a data line to storage for its measurements to be kept, an antenna needs a data line feeding it, and control logic can command only parts it has a control line to. Every line has a rating (W for power, bit/s for data) and a mass; an undersized line holds the part back. The derived result "systems.wiring" shows, for every part, what its lines deliver and what is wrong, and for every line what it carries.
${PORT_TABLE}
- To add a line: set_config with {"op":"append","path":"systems.links","value":{"id":"ln-…","kind":"power"|"data"|"control","from":{"node":"bus"|componentId,"port":…},"to":{"node":…,"port":…},"rating":number (omit for control),"lengthM":number}}. A line starts at an output port and ends at an input port of the same kind; one end of a power line is always the bus.
- To resize or remove a line: {"op":"set","path":"systems.links.<lineId>.rating","value":…} or {"op":"remove","path":"systems.links.<lineId>"}.
- add_component also accepts "connect": true, which runs the part's standard lines (sized 25% above what it needs). Use connect true when the player asks you to build or add something for use; leave it out only when they say they want to wire it themselves.
- A line's mass in kg is its length in metres times: power 0.02 + 0.00025 × rating in W; data 0.02 + 0.01 × log10(rating in bit/s ÷ 1,000,000 + 1); control 0.01. Use the length of the lines already on this spacecraft as the typical run. With these you can state what a proposed line weighs.
- When the player asks what lines something needs, answer in directReply from the port table and the part's numbers (its power, its data rate), say what rating each line needs and what it weighs, and build nothing.

Control logic (config.systems.controllers). A controller is new onboard behaviour: rules that run once per simulated day in the flight simulation, read the spacecraft's state, and command parts. This is how "make something that does X when Y" is built — not generate_script.
- To install one: set_config with {"op":"append","path":"systems.controllers","value":{"id":"ctl-…","name":…,"description":what it does in plain words,"hostId":"bus" or an onboard computer's id,"memory":{name:startValue,…},"rules":[{"when":condition,"do":[{"target":…,"value":expression}],"note":short reason}],"downlinkPriority":[instrument ids, most important first],"origin":{"kind":"model_generated","rationale":why this design}}}
- Conditions and values are expressions over these signals: ${SIGNAL_TABLE}; a controller's own memory as mem.<name>; and, in a value, nominal (the target's normal setting). Operators: + - * / < > <= >= == != and or not ( ). Functions: ${EXPR_FUNCTIONS.join(", ")}.
- Targets: ${TARGET_FORMS.join("; ")}.
- Every rule whose condition holds fires, in order, each day; a later rule overrides an earlier one on the same target; a part no rule commands runs at its normal setting. Use memory for hysteresis (enter saving mode below one threshold, leave it above another).
- A controller can command only parts with a control line from its host; if one is missing, add that control line in the same set_config.
- downlinkPriority sets whose data goes down first and whose is kept when storage overflows.
- When the player asks for control logic ("make a controller that…", "when X happens do Y"), build it now. Do not ask for thresholds or settings they left out: choose sensible ones from the mission's own numbers (for example the battery's depth-of-discharge limit), list each under assumptions, and say in the description that they can be changed. Ask only when the request does not say what the controller should do at all.
- A controller may be installed before the parts it will command exist: use group targets ("instruments", "kind:camera") so that it commands whatever is on board and wired when the mission flies.
- Installing control logic changes the flight, not the design snapshot: the pipeline flies the mission with and without it on the same in-flight events and reports the measured difference.

Rules:
- Ground every path and id in the mission configuration you are given. Do not invent paths.
- If the request leaves out a value that materially changes the outcome and has no safe default, add a missingInformation entry with blocking=true instead of guessing. Ask only what is necessary; when a conventional default exists, use it and record it under assumptions.
- A request may contain several operations; keep them in the order they should happen.
- The player is a crew member talking to their own mission AI, often thinking aloud: "if we had X, couldn't we solve Y?". When the idea is physically sound and can be expressed as operations, return the operations that build it — the pipeline then builds it in a test copy and measures whether it helps, which is a better answer than an opinion.
- Classify every idea in "hypothesis". An idea that depends on something these models do not represent (dust on arrays, thermal balance, radiation dose, propellant, structural loads, and anything else absent from the derived results) is outside_model: say plainly that this game's models do not cover it, what they do cover that is nearest, and do not invent a number for it.
- When the idea cannot work (the physics is wrong, it would not affect the problem named, or nothing here can express it), return no operations and say so in directReply: why it does not work, using numbers from the derived results, and what kinds of change would address the problem — as options with their costs, never as the single thing to do.
- Building an object: generate_asset with a "prompt" builds the 3D object AND attaches it to the spacecraft in the shared scene. Never add a second operation to place, attach, size or check it, and never use "custom" for that. One generate_asset operation is the whole request.
- Parts catalogue: when the mission context lists a catalogue part that matches what the player asks for, use add_component with exactly that part's component fields (choose a fresh id, withAsset true). If several catalogue parts could be meant, do not pick: return no operations and ask which in directReply, saying how they differ. A part that is not in the catalogue can still be built: give it realistic values and list every value you chose under assumptions.
- Use "custom" only when no other intent can express the operation.
- The mission context has "flight": the current design flown through its whole mission in simulation (totals, the periods when power is short with their dates, values through the year, in-flight events, data by instrument, what the control logic did). Answer questions about when something happens, how long it lasts and how bad it gets from it, in directReply, with the dates. It is a daily-average simulation with the stated sampling; say so when precision matters.
- You are this one player's AI. When told which seat they hold in the crew, start from that seat's concerns, and when their idea reaches into another seat's area (it costs power, mass, data rate, money) say which seat that is and who holds it, so they can talk to that crewmate. Never answer as if you spoke for the whole crew.
- Earlier turns of your conversation with this player, when given, are context: "it", "that one", "do it" refer to them. Other players have their own conversations you cannot see; the shared design is the mission configuration you are given, which already includes everyone's changes.
- If a previous attempt at this request was rejected by validation, the reasons are given: fix exactly those and return the corrected operations.
- When the player asks something you can answer from the configuration and derived results alone (what a part does, what it is connected to, why a number is what it is), answer in directReply and return no operations. Never invent values that are not in the material given.
- Do not judge feasibility or scientific validity here; later stages do that with calculations.
- Reference material, when present, is retrieved background with its evidence level. Use it to interpret terminology and conventions; it never overrides the mission configuration.`;

/** Returns a citation-numbered context block for a query (the RAG hook). */
export type KnowledgeRetriever = (query: string) => { context: string; citations: { n: number; id: string; source: string; verification: VerificationLevel }[] };

export class RequirementAnalyzer {
  constructor(private readonly llm: LlmService, private readonly retrieve?: KnowledgeRetriever, private readonly missionContext?: () => string) {}

  async analyze(text: string, mission: MissionVersion, signal?: AbortSignal, history: Turn[] = [], player = ""): Promise<StructuredRequirement> {
    if (!this.llm.status().available) return analyzeRuleBased(text, mission);
    // The model's operations are tried against the mission before they are accepted; what validation rejects goes back to it, twice at most.
    let feedback: string[] = [];
    let last: StructuredRequirement | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await this.analyzeOnce(text, mission, signal, history, feedback, player);
      if (!last.operations.length) return last;
      const problems = dryRun(last.operations, mission.config);
      if (!problems.length) return attempt ? { ...last, analysis: { ...last.analysis, repairs: attempt } } : last;
      feedback = problems.slice(0, 8);
    }
    return { ...last!, operations: [], missingInformation: [...last!.missingInformation, { field: "operations", blocking: true, question: `I could not turn that into a change the mission accepts. The last attempt was rejected because: ${feedback.join("; ")}` }] };
  }

  private async analyzeOnce(text: string, mission: MissionVersion, signal: AbortSignal | undefined, history: Turn[], feedback: string[], player: string): Promise<StructuredRequirement> {
    const { assets: _a, scripts, scene, ...core } = mission.config;
    let retrieved: ReturnType<KnowledgeRetriever> | null = null;
    try {
      retrieved = this.retrieve?.(text) ?? null;
    } catch {
      retrieved = null; // retrieval is an aid, never a reason to fail a request
    }
    const parsed = await this.llm.structured({
      system: ANALYSIS_SYSTEM,
      schema: LlmRequirement,
      ...(signal ? { signal } : {}),
      prompt: [
        `Mission configuration (version ${mission.version}):\n${JSON.stringify(core)}`,
        `Scene node ids: ${scene.nodes.map((n) => n.id).join(", ") || "(none)"}`,
        `Attached scripts: ${scripts.map((s) => `${s.id} (${s.name})`).join(", ") || "(none)"}`,
        `Derived results:\n${JSON.stringify(Object.fromEntries(Object.entries(mission.derived).map(([k, v]) => [k, k === "orbit.trajectory" ? "(omitted)" : v.value])))}`,
        ...(this.missionContext ? [`Mission context (the problem the crew is solving, their goals, and the parts catalogue):\n${this.missionContext()}`] : []),
        ...(retrieved?.context ? [`Reference material (retrieved from the research knowledge base):\n${retrieved.context}`] : []),
        ...(player ? [`The player you are talking to:\n${player}`] : []),
        ...(history.length ? [`Your conversation with this player so far (oldest first):\n${history.map((t) => `Player: ${t.said}\nYou (${t.outcome}): ${t.replied}`).join("\n")}`] : []),
        `User request:\n${text}`,
        ...(feedback.length ? [`Your previous operations for this request were rejected by validation:\n- ${feedback.join("\n- ")}\nReturn corrected operations.`] : []),
      ].join("\n\n"),
    });
    const operations: Operation[] = [];
    const missing: MissingInformation[] = [...parsed.missingInformation];
    parsed.operations.forEach((op, i) => {
      const id = `op${i + 1}`;
      let params: unknown;
      try {
        params = JSON.parse(op.paramsJson);
      } catch {
        params = null;
      }
      const problem = validateParams(op.intent, params);
      if (problem) {
        missing.push({ field: `${id}.params`, blocking: true, question: `The request could not be turned into a valid "${op.intent}" operation (${problem}). Please restate it with explicit values.` });
        return;
      }
      operations.push({ id, category: op.category, intent: op.intent, description: op.description, params: params as Record<string, unknown>, assumptions: op.assumptions });
    });
    return {
      id: newId("req"),
      originalText: text,
      summary: parsed.summary,
      operations,
      missingInformation: missing,
      ...(parsed.directReply?.trim() && operations.length === 0 ? { directReply: parsed.directReply.trim() } : {}),
      ...(parsed.hypothesis && parsed.hypothesis !== "none" ? { hypothesis: parsed.hypothesis } : {}),
      analysis: { method: "llm", modelId: this.llm.modelId, verification: "model_judgment", ...(retrieved?.citations.length ? { retrievedSources: retrieved.citations.map((c) => ({ n: c.n, id: c.id, source: c.source, verification: c.verification })) } : {}) },
      missionVersionInspected: mission.version,
    };
  }
}

/** Structural check of model-produced params before they reach the planner. */
function validateParams(intent: Intent, params: unknown): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return "params is not a JSON object";
  const p = params as Record<string, unknown>;
  const issue = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): string | null =>
    r.success ? null : (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  switch (intent) {
    case "set_config":
      return issue(z.array(PatchSchema).min(1).safeParse(p.patches));
    case "add_component":
      return issue(ComponentSchema.safeParse(p.component));
    case "generate_asset":
      if (p.assetSpec === undefined && typeof p.prompt === "string" && p.prompt.trim().length >= 3) return null;
      return issue(AssetSpecSchema.safeParse(p.assetSpec));
    case "compute":
      return typeof p.need === "string" ? null : "need (capability tag) is missing";
    case "generate_script":
      return typeof p.task === "string" && p.task ? null : "task is missing";
    case "run_script":
      return typeof p.scriptId === "string" ? null : "scriptId is missing";
    case "search_memory":
      return typeof p.query === "string" ? null : "query is missing";
    default:
      return null;
  }
}
