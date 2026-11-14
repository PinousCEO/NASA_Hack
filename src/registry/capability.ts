/**
 * Capability model: the structured metadata every tool/service exposes to the AI,
 * plus the execution contract. A capability is the unit of discovery, selection,
 * permissioning and observability.
 */
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { validateGlb } from "../assets/glb.js";
import { applyPatch, applyPatches, type PatchOp } from "../core/paths.js";
import { CapabilityError, type JsonSchema, type Permission, type Provenance, type User, type VerificationLevel } from "../core/types.js";
import type { Derived } from "../state/recalc.js";
import type { MissionConfig } from "../state/schema.js";
import type { MissionVersion } from "../state/store.js";

export type CapabilityCategory =
  | "mcp_server"
  | "internal_api"
  | "scientific_calculation"
  | "simulation"
  | "asset_generation"
  | "code_generation"
  | "external_data";

export type AvailabilityStatus = "available" | "degraded" | "unavailable";
/** `planned` capabilities are listed for transparency but have no working implementation. */
export type DevelopmentStatus = "implemented" | "experimental" | "planned";

export interface CapabilityDescriptor {
  id: string;
  name: string;
  description: string;
  category: CapabilityCategory;
  /** Semantic tags the planner resolves against, e.g. "calc.orbit.elements", "asset.glb". */
  provides: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  /** Other capability ids or external services this capability relies on. */
  dependencies: string[];
  requiredPermissions: Permission[];
  resources: { network: boolean; cpu: "low" | "medium" | "high"; typicalDurationMs: number; memoryMb?: number };
  constraints: {
    timeoutMs: number;
    maxRetries: number;
    idempotent: boolean;
    /** read: no side effects; draft_write: writes only to the request's draft workspace; external_read: calls an outside service. */
    effect: "read" | "draft_write" | "external_read";
  };
  availability: { status: AvailabilityStatus; reason?: string; checkedAt: string };
  version: string;
  /** Verification status of the capability implementation itself. */
  verification: { status: "verified" | "self_tested" | "unverified"; method: string };
  developmentStatus: DevelopmentStatus;
  /** What kind of evidence this capability's outputs constitute. */
  outputVerification: VerificationLevel;
  source: { type: "internal" } | { type: "mcp"; server: string; tool: string };
}

export interface CapabilityResult {
  output: unknown;
  verification: VerificationLevel;
  assumptions: string[];
  provenance: Provenance;
}

export interface ExecutionContext {
  requestId: string;
  user: User;
  signal: AbortSignal;
  /** Published mission version the request started from (read-only). */
  mission: MissionVersion;
  draft: DraftWorkspace;
  log(message: string): void;
}

export interface InputValidation {
  ok: boolean;
  errors: string[];
  value?: unknown;
}

export interface DefaultInputArgs {
  config: MissionConfig;
  derived: Derived;
  params: Record<string, unknown>;
}

export interface Capability {
  descriptor: CapabilityDescriptor;
  validateInput(input: unknown): InputValidation;
  execute(input: unknown, ctx: ExecutionContext): Promise<CapabilityResult>;
  /** Build a schema-valid input from mission state and request parameters (used by the rule-based planner). */
  defaultInput?(args: DefaultInputArgs): unknown;
  /** Probe live availability (credentials, network reachability, ...). */
  healthCheck?(): Promise<{ status: AvailabilityStatus; reason?: string }>;
}

export interface StagedAsset {
  id: string;
  stagedPath: string;
  fileName: string;
}

/**
 * Per-request draft workspace. Capabilities can only stage changes here; nothing reaches
 * the shared mission until a proposal built from this draft is approved and published.
 */
export class DraftWorkspace {
  readonly patches: PatchOp[] = [];
  readonly stagedAssets: StagedAsset[] = [];
  private working: unknown;

  constructor(
    readonly base: MissionVersion,
    private readonly stagingDir: string,
  ) {
    this.working = structuredClone(base.config);
  }

  get isEmpty(): boolean {
    return this.patches.length === 0;
  }

  /** Rebuild a draft from persisted patches and staged files (durable proposals survive restarts). */
  static restore(base: MissionVersion, stagingDir: string, patches: PatchOp[], stagedAssets: StagedAsset[]): DraftWorkspace {
    const draft = new DraftWorkspace(base, stagingDir);
    for (const patch of patches) draft.propose(patch);
    draft.stagedAssets.push(...stagedAssets);
    return draft;
  }

  get directory(): string {
    return this.stagingDir;
  }

  /** Base configuration with all draft patches applied (not yet schema-validated). */
  workingConfig(): unknown {
    return structuredClone(this.working);
  }

  propose(patch: PatchOp): void {
    this.working = applyPatch(this.working, patch); // throws on invalid paths
    this.patches.push(patch);
  }

  /** Validate and stage a GLB; registers it in the draft's asset list. Content-addressed, so re-staging is idempotent. */
  stageGlb(bytes: Uint8Array, meta: { generator: string; description: string }): { assetId: string; uri: string; triangles: number; bytes: number; sha256: string } {
    const stats = validateGlb(bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const assetId = `a${sha256.slice(0, 12)}`;
    const fileName = `${assetId}.glb`;
    const record = { id: assetId, uri: `/assets/${fileName}`, format: "glb" as const, sha256, bytes: bytes.byteLength, triangles: stats.triangles, ...meta };
    const existing = (this.working as MissionConfig).assets.some((a) => a.id === assetId);
    if (!existing) {
      mkdirSync(this.stagingDir, { recursive: true });
      const stagedPath = path.join(this.stagingDir, fileName);
      writeFileSync(stagedPath, bytes);
      this.stagedAssets.push({ id: assetId, stagedPath, fileName });
      this.propose({ op: "append", path: "assets", value: record });
    }
    return { assetId, uri: record.uri, triangles: stats.triangles, bytes: bytes.byteLength, sha256 };
  }

  /** Drop all staged changes and files (rollback of an unpublished plan). */
  discard(): void {
    this.patches.length = 0;
    this.stagedAssets.length = 0;
    this.working = structuredClone(this.base.config);
    rmSync(this.stagingDir, { recursive: true, force: true });
  }

  /** Re-apply the draft patches onto another base configuration (used when the head moved). */
  rebaseOnto(config: MissionConfig): unknown {
    return applyPatches(config as unknown, this.patches);
  }
}

interface InternalCapabilitySpec<I extends z.ZodType, O extends z.ZodType> {
  id: string;
  name: string;
  description: string;
  category: CapabilityCategory;
  provides: string[];
  input: I;
  output: O;
  dependencies?: string[];
  requiredPermissions?: Permission[];
  resources?: Partial<CapabilityDescriptor["resources"]>;
  constraints?: Partial<CapabilityDescriptor["constraints"]>;
  version?: string;
  verification: CapabilityDescriptor["verification"];
  developmentStatus?: DevelopmentStatus;
  outputVerification: VerificationLevel;
  /** Static unavailability (e.g. planned capability). */
  unavailableReason?: string;
  references?: string[];
  run?(input: z.infer<I>, ctx: ExecutionContext): Promise<{ output: z.input<O>; assumptions?: string[]; modelId?: string }> | { output: z.input<O>; assumptions?: string[]; modelId?: string };
  defaultInput?(args: DefaultInputArgs): unknown;
  healthCheck?(): Promise<{ status: AvailabilityStatus; reason?: string }>;
}

/** Define an in-process capability with zod schemas; JSON Schemas for discovery are generated from them. */
export function defineCapability<I extends z.ZodType, O extends z.ZodType>(spec: InternalCapabilitySpec<I, O>): Capability {
  const planned = (spec.developmentStatus ?? "implemented") === "planned" || !spec.run;
  const descriptor: CapabilityDescriptor = {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: spec.category,
    provides: spec.provides,
    inputSchema: z.toJSONSchema(spec.input, { io: "input" }) as JsonSchema,
    outputSchema: z.toJSONSchema(spec.output, { io: "output" }) as JsonSchema,
    dependencies: spec.dependencies ?? [],
    requiredPermissions: spec.requiredPermissions ?? [],
    resources: { network: false, cpu: "low", typicalDurationMs: 5, ...spec.resources },
    constraints: { timeoutMs: 5000, maxRetries: 0, idempotent: true, effect: "read", ...spec.constraints },
    availability: planned
      ? { status: "unavailable", reason: spec.unavailableReason ?? "Not implemented yet", checkedAt: new Date().toISOString() }
      : { status: "available", checkedAt: new Date().toISOString() },
    version: spec.version ?? "1.0.0",
    verification: spec.verification,
    developmentStatus: planned ? "planned" : (spec.developmentStatus ?? "implemented"),
    outputVerification: spec.outputVerification,
    source: { type: "internal" },
  };
  return {
    descriptor,
    validateInput(input) {
      const parsed = spec.input.safeParse(input);
      return parsed.success
        ? { ok: true, errors: [], value: parsed.data }
        : { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`) };
    },
    async execute(input, ctx) {
      if (!spec.run) throw new CapabilityError(`Capability "${spec.id}" is planned and has no implementation`, { code: "not_implemented" });
      const parsedInput = spec.input.parse(input);
      const result = await spec.run(parsedInput, ctx);
      const output = spec.output.safeParse(result.output);
      if (!output.success) {
        throw new CapabilityError(`Capability "${spec.id}" produced output that violates its schema: ${output.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, { code: "invalid_output" });
      }
      return {
        output: output.data,
        verification: spec.outputVerification,
        assumptions: result.assumptions ?? [],
        provenance: {
          source: "internal",
          capabilityId: spec.id,
          capabilityVersion: descriptor.version,
          ...(result.modelId ? { modelId: result.modelId } : {}),
          ...(spec.references ? { references: spec.references } : {}),
        },
      };
    },
    ...(spec.defaultInput ? { defaultInput: spec.defaultInput } : {}),
    ...(spec.healthCheck ? { healthCheck: spec.healthCheck } : {}),
  };
}
