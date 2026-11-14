/**
 * The shared mission configuration: the single source of truth that MR and Web clients
 * render and that every simulation result is derived from.
 */
import { z } from "zod";

const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/, "id must be alphanumeric (with _ or -), starting with a letter");
const fraction = z.number().min(0).max(1);
const bodyId = z.enum(["earth", "moon", "mars"]);
/** Cost in the platform's game cost model, millions of US dollars. Not a NASA cost estimate. */
const costMusd = z.number().min(0).default(0);
/** Months needed to build and deliver the part (game schedule model). Defaults by component type when omitted. */
const leadTimeMonths = z.number().min(0).max(60).optional();

export const SolarPanelSchema = z.object({
  id,
  type: z.literal("solar_panel"),
  name: z.string(),
  massKg: z.number().min(0),
  areaM2: z.number().positive(),
  efficiency: fraction,
  pointingLoss: fraction.default(0.1),
  degradationPerYear: fraction.default(0.02),
  costMusd,
  leadTimeMonths,
});

export const BatterySchema = z.object({
  id,
  type: z.literal("battery"),
  name: z.string(),
  massKg: z.number().min(0),
  capacityWh: z.number().positive(),
  maxDepthOfDischarge: fraction.default(0.4),
  costMusd,
  leadTimeMonths,
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
  costMusd,
  leadTimeMonths,
});

export const LoadSchema = z.object({
  id,
  type: z.literal("load"),
  name: z.string(),
  massKg: z.number().min(0),
  powerW: z.number().min(0),
  dutyCycle: fraction.default(1),
  costMusd,
  leadTimeMonths,
});

export const INSTRUMENT_KINDS = ["camera", "spectrometer", "neutron_spectrometer", "radar", "magnetometer", "thermal_imager", "lidar"] as const;

/** A science instrument: draws power, produces data, and is what mission objectives are scored on. */
export const InstrumentSchema = z.object({
  id,
  type: z.literal("instrument"),
  name: z.string(),
  kind: z.enum(INSTRUMENT_KINDS),
  massKg: z.number().min(0),
  powerW: z.number().min(0),
  dutyCycle: fraction.default(0.5),
  /** Data produced while operating, bit/s. */
  dataRateBps: z.number().min(0),
  /** Optical aperture, for imaging instruments (drives diffraction-limited resolution). */
  apertureM: z.number().positive().optional(),
  wavelengthUm: z.number().positive().optional(),
  costMusd,
  leadTimeMonths,
});

/** Attitude determination and control: how accurately the spacecraft points, and how steadily it holds. */
export const AdcsSchema = z.object({
  id,
  type: z.literal("adcs"),
  name: z.string(),
  massKg: z.number().min(0),
  powerW: z.number().min(0),
  dutyCycle: fraction.default(1),
  /** Absolute pointing error, degrees (drives high-gain antenna pointing loss). */
  pointingAccuracyDeg: z.number().positive().max(10),
  /** Pointing stability during an exposure, arcseconds (drives image smear). */
  stabilityArcsec: z.number().positive().max(3600),
  costMusd,
  leadTimeMonths,
});

/** Onboard computer and data handling: storage, and compression before downlink. */
export const ComputerSchema = z.object({
  id,
  type: z.literal("computer"),
  name: z.string(),
  massKg: z.number().min(0),
  powerW: z.number().min(0),
  dutyCycle: fraction.default(1),
  /** Science data storage this unit adds, gigabits. */
  storageGb: z.number().min(0).default(0),
  /** Onboard compression: raw bits per downlinked bit. */
  compressionRatio: z.number().min(1).max(20).default(1),
  costMusd,
  leadTimeMonths,
});

export const ComponentSchema = z.discriminatedUnion("type", [SolarPanelSchema, BatterySchema, AntennaSchema, LoadSchema, InstrumentSchema, AdcsSchema, ComputerSchema]);
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
    /** Planetocentric site coordinates (east longitude), when known. */
    latDeg: z.number().min(-90).max(90).optional(),
    lonDeg: z.number().min(-360).max(360).optional(),
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

/** A trajectory drawn over the mission scene: imported from GMAT or propagated numerically. */
export const TrajectoryOverlaySchema = z.object({
  id,
  name: z.string().max(80),
  /** Where the samples came from, shown to users next to the overlay. */
  source: z.enum(["gmat_report", "j2_propagation"]),
  verification: z.enum(["external_data", "deterministic_calculation"]),
  durationS: z.number().nonnegative(),
  /** Positions in the central body's inertial equatorial frame, km. */
  pointsKm: z.array(z.tuple([z.number(), z.number(), z.number()])).min(2).max(1500),
  note: z.string().max(300).default(""),
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

/** A wire between two ports. Power lines carry watts, data lines bits per second, control lines commands. */
export const LinkSchema = z.object({
  id,
  kind: z.enum(["power", "data", "control"]),
  /** "bus" is the spacecraft bus (power distribution, onboard storage, flight computer); anything else is a component id. */
  from: z.object({ node: z.string().max(64), port: z.string().max(32) }),
  to: z.object({ node: z.string().max(64), port: z.string().max(32) }),
  /** What the line is rated to carry: W for power, bit/s for data. Control lines have no rating. */
  rating: z.number().positive().optional(),
  lengthM: z.number().positive().max(50).default(1.5),
});
export type Link = z.infer<typeof LinkSchema>;

/** One rule of a controller: when the condition holds, each action sets a commanded value. */
export const ControlRuleSchema = z.object({
  when: z.string().min(1).max(240),
  do: z.array(z.object({ target: z.string().min(1).max(80), value: z.string().min(1).max(160) })).min(1).max(8),
  note: z.string().max(200).optional(),
});

/** Control logic that runs on board, once per simulated day, in the flight simulation. */
export const ControllerSchema = z.object({
  id,
  name: z.string().max(80),
  description: z.string().max(600).default(""),
  /** Where it runs: "bus" (the flight computer) or the id of an onboard computer. */
  hostId: z.string().max(64).default("bus"),
  enabled: z.boolean().default(true),
  /** Named numbers the controller remembers between days, with their starting values. */
  memory: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/), z.number()).default({}),
  rules: z.array(ControlRuleSchema).min(1).max(24),
  /** Instrument ids, most important first: the order data is sent down, and kept when storage overflows. */
  downlinkPriority: z.array(z.string().max(64)).max(24).default([]),
  version: z.number().int().positive().default(1),
  origin: z.object({ kind: z.enum(["model_generated", "user_authored", "mission_package"]), modelId: z.string().optional(), rationale: z.string().max(600).optional() }).default({ kind: "user_authored" }),
});
export type Controller = z.infer<typeof ControllerSchema>;

export const SystemsSchema = z.object({
  /** True once the mission is wired: a part then works only through its lines. False keeps the pre-wiring behaviour (every part is assumed connected). */
  wired: z.boolean().default(false),
  links: z.array(LinkSchema).max(200).refine(uniqueIds, "link ids must be unique").default([]),
  controllers: z.array(ControllerSchema).max(8).refine(uniqueIds, "controller ids must be unique").default([]),
});

export const MissionConfigSchema = z.object({
  meta: z.object({
    name: z.string(),
    description: z.string().default(""),
    /** Optional launch mass allocation used as an engineering constraint. */
    massLimitKg: z.number().positive().optional(),
    /** Programme budget cap in the game cost model, $M. */
    budgetMusd: z.number().positive().optional(),
    missionDurationDays: z.number().positive().max(3650).default(365),
    /** Chosen launch vehicle class (see game/launch.ts). Unset until the team picks one. */
    launchVehicleId: z.string().max(40).optional(),
    /** Months from programme start to the launch window: the development-time allocation. */
    scheduleMonths: z.number().positive().max(240).optional(),
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
    busCostMusd: costMusd,
    /** Onboard science data storage, gigabits. */
    dataStorageGb: z.number().min(0).default(64),
    components: z.array(ComponentSchema).refine(uniqueIds, "component ids must be unique"),
  }),
  groundStation: z.object({
    name: z.string(),
    antennaGainDbi: z.number(),
    systemNoiseTempK: z.number().positive(),
    minElevationDeg: z.number().min(0).max(90),
  }),
  rover: RoverSchema.optional(),
  scene: z.object({
    nodes: z.array(SceneNodeSchema).refine(uniqueIds, "scene node ids must be unique"),
    trajectories: z.array(TrajectoryOverlaySchema).max(6).refine(uniqueIds, "trajectory ids must be unique").default([]),
  }),
  systems: SystemsSchema.default({ wired: false, links: [], controllers: [] }),
  assets: z.array(AssetRecordSchema).refine(uniqueIds, "asset ids must be unique"),
  scripts: z.array(ScriptRecordSchema).refine(uniqueIds, "script ids must be unique"),
});

export type MissionConfig = z.infer<typeof MissionConfigSchema>;

/** Cross-field integrity rules that the structural schema cannot express. */
/** Extra integrity rules contributed by other modules (the systems graph registers its own here). */
const EXTRA_RULES: ((config: MissionConfig) => string[])[] = [];
export function registerIntegrityRule(rule: (config: MissionConfig) => string[]): void {
  if (!EXTRA_RULES.includes(rule)) EXTRA_RULES.push(rule);
}

export function referentialIssues(config: MissionConfig): string[] {
  const issues: string[] = [];
  for (const rule of EXTRA_RULES) issues.push(...rule(config));
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
  // A line goes with the parts it joins: when a part is removed, its lines are removed with it.
  const data = parsed.data;
  const nodes = new Set(["bus", ...data.spacecraft.components.map((c) => c.id)]);
  const links = data.systems.links.filter((l) => nodes.has(l.from.node) && nodes.has(l.to.node));
  const config: MissionConfig = links.length === data.systems.links.length && data.systems.controllers.every((c) => c.downlinkPriority.every((id) => nodes.has(id)))
    ? data
    : { ...data, systems: { ...data.systems, links, controllers: data.systems.controllers.map((c) => ({ ...c, downlinkPriority: c.downlinkPriority.filter((id) => nodes.has(id)) })) } };
  const issues = referentialIssues(config);
  return issues.length ? { ok: false, issues } : { ok: true, config };
}
