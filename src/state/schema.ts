/**
 * The shared mission configuration: the single source of truth that MR and Web clients
 * render and that every simulation result is derived from.
 */
import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, "id must be alphanumeric (with _ or -), starting with a letter");
const fraction = z.number().min(0).max(1);
const bodyId = z.enum(["earth", "moon", "mars"]);

export const SolarPanelSchema = z.object({
  id,
  type: z.literal("solar_panel"),
  name: z.string(),
  massKg: z.number().min(0),
  areaM2: z.number().positive(),
  efficiency: fraction,
  pointingLoss: fraction.default(0.1),
  degradationPerYear: fraction.default(0.02),
});

export const BatterySchema = z.object({
  id,
  type: z.literal("battery"),
  name: z.string(),
  massKg: z.number().min(0),
  capacityWh: z.number().positive(),
  maxDepthOfDischarge: fraction.default(0.4),
});

export const AntennaSchema = z.object({
  id,
  type: z.literal("antenna"),
  name: z.string(),
  massKg: z.number().min(0),
  frequencyGHz: z.number().positive(),
  /** Either a fixed gain or a dish diameter (gain is then computed). */
  gainDbi: z.number().optional(),
  diameterM: z.number().positive().optional(),
  txPowerW: z.number().positive(),
  /** DC power drawn while transmitting, W. */
  dcPowerW: z.number().min(0),
  dutyCycle: fraction.default(0.2),
  dataRateBps: z.number().positive(),
  otherLossesDb: z.number().min(0).default(3),
  requiredEbN0Db: z.number().default(9.6),
});

export const LoadSchema = z.object({
  id,
  type: z.literal("load"),
  name: z.string(),
  massKg: z.number().min(0),
  powerW: z.number().min(0),
  dutyCycle: fraction.default(1),
});

export const ComponentSchema = z.discriminatedUnion("type", [SolarPanelSchema, BatterySchema, AntennaSchema, LoadSchema]);
export type Component = z.infer<typeof ComponentSchema>;

const uniqueIds = (items: { id: string }[]): boolean => new Set(items.map((i) => i.id)).size === items.length;

export const RoverSchema = z.object({
  name: z.string(),
  chassisMassKg: z.number().positive(),
  wheelCount: z.number().int().min(3).max(12),
  wheelRadiusM: z.number().positive(),
  wheelMassKg: z.number().min(0),
  wheelTorqueNm: z.number().positive(),
  supportHalfSpanM: z.number().positive(),
  centerOfMassHeightM: z.number().positive(),
  speedMS: z.number().positive(),
  drivetrainEfficiency: z.number().gt(0).max(1),
  components: z.array(ComponentSchema).refine(uniqueIds, "component ids must be unique"),
  site: z.object({
    body: bodyId,
    name: z.string(),
    slopeDeg: z.number().min(0).max(89),
    tractionCoefficient: z.number().positive(),
    rollingResistanceCoefficient: z.number().min(0),
  }),
});

export const SceneNodeSchema = z.object({
  id,
  name: z.string(),
  assetId: z.string().optional(),
  /** Id of the mission component this node visualises, if any. */
  componentId: z.string().optional(),
  parentId: z.string().optional(),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  rotationEulerDeg: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  scale: z.tuple([z.number(), z.number(), z.number()]).default([1, 1, 1]),
});

export const AssetRecordSchema = z.object({
  id,
  uri: z.string(),
  format: z.literal("glb"),
  sha256: z.string(),
  bytes: z.number().int().positive(),
  triangles: z.number().int().min(0),
  generator: z.string(),
  description: z.string(),
});

export const ScriptRecordSchema = z.object({
  id,
  name: z.string(),
  language: z.literal("typescript"),
  source: z.string(),
  compiledJs: z.string(),
  sha256: z.string(),
  permissions: z.array(z.enum(["state:read", "state:propose", "calc"])),
  origin: z.object({ kind: z.enum(["model_generated", "user_authored"]), modelId: z.string().optional() }),
});
export type ScriptRecord = z.infer<typeof ScriptRecordSchema>;

export const MissionConfigSchema = z.object({
  meta: z.object({
    name: z.string(),
    description: z.string().default(""),
    /** Optional launch mass allocation used as an engineering constraint. */
    massLimitKg: z.number().positive().optional(),
    yearsInService: z.number().min(0).default(0),
  }),
  missionTime: z.iso.datetime({ offset: true }),
  centralBody: bodyId,
  orbit: z.object({
    semiMajorAxisKm: z.number().positive(),
    eccentricity: z.number().min(0).lt(1),
    inclinationDeg: z.number().min(0).max(180),
    raanDeg: z.number().min(0).lt(360),
    argPeriapsisDeg: z.number().min(0).lt(360),
    trueAnomalyDeg: z.number().min(0).lt(360),
    epoch: z.iso.datetime({ offset: true }),
  }),
  spacecraft: z.object({
    name: z.string(),
    busDryMassKg: z.number().positive(),
    components: z.array(ComponentSchema).refine(uniqueIds, "component ids must be unique"),
  }),
  groundStation: z.object({
    name: z.string(),
    antennaGainDbi: z.number(),
    systemNoiseTempK: z.number().positive(),
    minElevationDeg: z.number().min(0).max(90),
  }),
  rover: RoverSchema.optional(),
  scene: z.object({ nodes: z.array(SceneNodeSchema).refine(uniqueIds, "scene node ids must be unique") }),
  assets: z.array(AssetRecordSchema).refine(uniqueIds, "asset ids must be unique"),
  scripts: z.array(ScriptRecordSchema).refine(uniqueIds, "script ids must be unique"),
});

export type MissionConfig = z.infer<typeof MissionConfigSchema>;

/** Cross-field integrity rules that the structural schema cannot express. */
export function referentialIssues(config: MissionConfig): string[] {
  const issues: string[] = [];
  const assetIds = new Set(config.assets.map((a) => a.id));
  const nodeIds = new Set(config.scene.nodes.map((n) => n.id));
  const componentIds = new Set([
    ...config.spacecraft.components.map((c) => c.id),
    ...(config.rover?.components.map((c) => c.id) ?? []),
  ]);
  for (const node of config.scene.nodes) {
    if (node.assetId && !assetIds.has(node.assetId)) issues.push(`scene node "${node.id}" references missing asset "${node.assetId}"`);
    if (node.parentId && !nodeIds.has(node.parentId)) issues.push(`scene node "${node.id}" references missing parent "${node.parentId}"`);
    if (node.componentId && !componentIds.has(node.componentId)) {
      issues.push(`scene node "${node.id}" references missing component "${node.componentId}"`);
    }
  }
  for (const c of [...config.spacecraft.components, ...(config.rover?.components ?? [])]) {
    if (c.type === "antenna" && c.gainDbi === undefined && c.diameterM === undefined) {
      issues.push(`antenna "${c.id}" needs either gainDbi or diameterM`);
    }
  }
  return issues;
}

export function parseMissionConfig(input: unknown): { ok: true; config: MissionConfig } | { ok: false; issues: string[] } {
  const parsed = MissionConfigSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
  }
  const issues = referentialIssues(parsed.data);
  return issues.length ? { ok: false, issues } : { ok: true, config: parsed.data };
}
