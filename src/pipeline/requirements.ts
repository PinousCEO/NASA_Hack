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
import { newId } from "../core/types.js";
import type { LlmService } from "../llm/llm.js";
import { BODIES } from "../science/orbital.js";
import { type Component, ComponentSchema, type MissionConfig } from "../state/schema.js";
import type { MissionVersion } from "../state/store.js";
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
    if (!match) {
      return { missing: [{ field: "assetSpec.kind", blocking: true, question: "Which shape should be generated? Supported parametric shapes: box, cylinder, sphere, solar panel, dish antenna, wheel, rover chassis. (Free-form generative 3D is not implemented.)" }] };
    }
    const [, build, needed] = match;
    if (dims.length < needed) {
      return { missing: [{ field: "assetSpec.dimensions", blocking: true, question: `Please give ${needed} dimension(s) in metres for this shape (found ${dims.length}).` }] };
    }
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
        question: `I could not interpret "${clause}" with the built-in pattern analyser (no language model is configured). Rephrase it as a concrete action, e.g. "set orbit altitude to 150 km", "add a 0.5 m2 solar panel", "set rover.site.slopeDeg to 18", "simulate battery over 10 orbits", "compute the link budget".`,
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
});

const ANALYSIS_SYSTEM = `You convert a user's natural-language request about a space-mission design into structured operations for an engineering pipeline. You do not execute anything.

Each operation has a category, an intent, and a JSON params object. Intents and their params:
- set_config: { "patches": [{"op":"set"|"append"|"remove","path":"dot.path","value":...}], "rationale": string } — change existing configuration values. Array elements are addressed by their id, e.g. "spacecraft.components.sp1.areaM2". Never patch "scripts" or "assets".
- add_component: { "target": "spacecraft"|"rover", "component": {...}, "withAsset": boolean } — component types and fields: solar_panel {id,type,name,massKg,areaM2,efficiency(0-1),pointingLoss,degradationPerYear}; battery {id,type,name,massKg,capacityWh,maxDepthOfDischarge}; antenna {id,type,name,massKg,frequencyGHz,diameterM or gainDbi,txPowerW,dcPowerW,dutyCycle,dataRateBps,otherLossesDb,requiredEbN0Db}; load {id,type,name,massKg,powerW,dutyCycle}. Choose an id not already in use.
- compute: { "need": tag, ... } — a calculation. Tags: calc.orbit.elements {altitudeKm?}, calc.orbit.transfer {targetAltitudeKm}, calc.power.budget, calc.comms.link {antennaId?, dataRateBps?}, calc.rover.mobility {slopeDeg?}, calc.ephemeris.sun {time?}.
- simulate_power: { "orbits"?: number }
- retrieve_ephemeris: { "target": "sun"|"earth"|"moon"|"mars", "center"?: same set, "time"?: ISO-8601 }
- generate_asset: { "assetSpec": {"kind":"box"|"cylinder"|"sphere"|"solar_panel"|"dish_antenna"|"wheel"|"rover_chassis", ...dimensions in metres}, "description"?: string }
- generate_script: { "task": string, "name": string, "permissions"?: ["state:read","state:propose","calc"], "scriptId"?: id of an attached script to modify (category code_modification) }
- run_script: { "scriptId": string, "input"?: object }
- search_memory: { "query": string }
- custom: { "goal": string } — only when none of the above can express the operation; it will need multi-tool planning.

Rules:
- Ground every path and id in the mission configuration you are given. Do not invent paths.
- If the request leaves out a value that materially changes the outcome and has no safe default, add a missingInformation entry with blocking=true instead of guessing. Ask only what is necessary; when a conventional default exists, use it and record it under assumptions.
- A request may contain several operations; keep them in the order they should happen.
- Do not judge feasibility or scientific validity here; later stages do that with calculations.`;

export class RequirementAnalyzer {
  constructor(private readonly llm: LlmService) {}

  async analyze(text: string, mission: MissionVersion, signal?: AbortSignal): Promise<StructuredRequirement> {
    if (!this.llm.status().available) return analyzeRuleBased(text, mission);
    const { assets: _a, scripts, scene, ...core } = mission.config;
    const parsed = await this.llm.structured({
      system: ANALYSIS_SYSTEM,
      schema: LlmRequirement,
      ...(signal ? { signal } : {}),
      prompt: [
        `Mission configuration (version ${mission.version}):\n${JSON.stringify(core)}`,
        `Scene node ids: ${scene.nodes.map((n) => n.id).join(", ") || "(none)"}`,
        `Attached scripts: ${scripts.map((s) => `${s.id} (${s.name})`).join(", ") || "(none)"}`,
        `Derived results:\n${JSON.stringify(Object.fromEntries(Object.entries(mission.derived).map(([k, v]) => [k, k === "orbit.trajectory" ? "(omitted)" : v.value])))}`,
        `User request:\n${text}`,
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
      analysis: { method: "llm", modelId: this.llm.modelId, verification: "model_judgment" },
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
