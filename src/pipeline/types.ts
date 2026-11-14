import type { RequestAnswer } from "./answer.js";
/** Data model shared by the request pipeline stages. */
import type { DiffEntry, PatchOp } from "../core/paths.js";
import type { Permission, Role, User, VerificationLevel } from "../core/types.js";
import type { CapabilityResult } from "../registry/capability.js";

export const OPERATION_CATEGORIES = [
  "scientific_research",
  "engineering_design",
  "asset_generation_3d",
  "scene_modification",
  "component_creation",
  "code_generation",
  "code_modification",
  "simulation",
  "data_retrieval",
  "mission_configuration",
] as const;
export type OperationCategory = (typeof OPERATION_CATEGORIES)[number];

/**
 * Intents are the contract between requirement analysis and planning. Every intent except
 * `custom` has a deterministic planning recipe; `custom` requires the model-based planner.
 */
export const INTENTS = [
  "set_config", // params: { patches: PatchOp[], rationale?: string }
  "add_component", // params: { target: "spacecraft"|"rover", component: Component, withAsset: boolean }
  "compute", // params: { need: capability tag, ...inputs }
  "simulate_power", // params: { orbits?: number }
  "retrieve_ephemeris", // params: { target, center?, time? }
  "generate_asset", // params: { assetSpec, description? }
  "generate_script", // params: { task, name, permissions? }
  "run_script", // params: { scriptId, input? }
  "search_memory", // params: { query }
  "custom", // params: free-form
] as const;
export type Intent = (typeof INTENTS)[number];

export interface Operation {
  id: string;
  category: OperationCategory;
  intent: Intent;
  description: string;
  params: Record<string, unknown>;
  /** Values the analyser filled in without the user stating them. */
  assumptions: string[];
}

export interface MissingInformation {
  field: string;
  question: string;
  /** Blocking items stop the pipeline until the user answers. */
  blocking: boolean;
}

export interface StructuredRequirement {
  id: string;
  originalText: string;
  summary: string;
  operations: Operation[];
  missingInformation: MissingInformation[];
  /** The model's own reply when no tool is needed, or when the idea cannot work (with the reason). */
  directReply?: string;
  /** How the analyser judged an idea the player put forward (model judgement until something is built and measured). */
  hypothesis?: "supported" | "conditional" | "refuted" | "outside_model";
  analysis: { repairs?: number; method: "llm" | "rule_based"; modelId?: string; verification: VerificationLevel; retrievedSources?: { n: number; id: string; source: string; verification: VerificationLevel }[] };
  missionVersionInspected: number;
}

export type FeasibilityClass =
  | "feasible"
  | "feasible_with_modifications"
  | "requires_additional_resources"
  | "requires_further_research"
  | "currently_unsupported"
  | "scientifically_unverified";

export interface FeasibilityFactor {
  factor: "tools" | "permissions" | "data" | "engineering" | "science" | "compatibility" | "dependencies" | "resources" | "time" | "safety";
  status: "ok" | "concern" | "blocker";
  detail: string;
  /** How this finding was established. */
  basis: VerificationLevel;
}

export interface FeasibilityAssessment {
  classification: FeasibilityClass;
  /** Whether the pipeline may go on to execute the plan. */
  proceed: boolean;
  summary: string;
  factors: FeasibilityFactor[];
  suggestedModifications: string[];
  /** Capability ids grouped by the kind of evidence their outputs constitute. */
  evidenceBasis: Partial<Record<VerificationLevel, string[]>>;
  estimatedDurationMs: number;
}

export interface Criterion {
  /** Path into the task output, e.g. "passed" or "sandbox.ok". */
  path: string;
  op: "exists" | "truthy" | "==" | "!=" | ">" | ">=" | "<" | "<=";
  value?: unknown;
}

export type TaskStatus = "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled" | "rolled_back";

export interface PlanTask {
  id: string;
  operationId: string;
  description: string;
  capabilityId: string;
  /** Why this capability was selected, and what else was considered. */
  selectionReason: string;
  alternativesConsidered: string[];
  dependsOn: string[];
  /** May contain { "$ref": "<taskId>", "path": "<path into that task's output>" } bindings. */
  input: unknown;
  expectedOutputs: string[];
  validation: Criterion[];
  status: TaskStatus;
  attempts: number;
  /** Capability that actually produced the result (differs after failure recovery). */
  executedBy?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
  result?: CapabilityResult;
}

export interface PlanIssue {
  operationId: string;
  kind: "no_capability" | "capability_planned" | "capability_unavailable" | "permission_denied" | "invalid_input" | "planner_unavailable" | "invalid_plan";
  detail: string;
  tag?: string;
  capabilityId?: string;
  missingPermissions?: Permission[];
}

export interface Plan {
  id: string;
  requestId: string;
  createdBy: "recipe" | "llm";
  modelId?: string;
  tasks: PlanTask[];
  status: "draft" | "running" | "succeeded" | "failed" | "cancelled";
  rolledBack: boolean;
}

export interface TestResult {
  id: string;
  description: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface Consequence {
  node: string;
  metric: string;
  before: unknown;
  after: unknown;
  delta?: number;
}

export interface Proposal {
  id: string;
  requestId: string;
  createdBy: User;
  createdAt: string;
  baseVersion: number;
  patches: PatchOp[];
  preview: {
    configDiff: DiffEntry[];
    affectedComponents: string[];
    recalculatedNodes: string[];
    consequences: Consequence[];
    explanation: string[];
  };
  tests: TestResult[];
  /** Weakest evidence level among the results this proposal is built on. */
  evidence: VerificationLevel;
  significance: "minor" | "significant";
  requiredRole: Role;
  status: "awaiting_approval" | "published" | "rejected" | "superseded";
  decision?: { by: User; at: string; action: "approved" | "rejected"; reason: string };
  publishedVersion?: number;
}

export interface TraceEvent {
  seq: number;
  at: string;
  stage: "state" | "analysis" | "memory" | "planning" | "selection" | "feasibility" | "execution" | "recovery" | "validation" | "test" | "decision" | "deployment";
  message: string;
  data?: unknown;
}

export type RequestStatus =
  | "queued"
  | "analyzing"
  | "awaiting_clarification"
  | "planning"
  | "infeasible"
  | "executing"
  | "completed"
  | "awaiting_approval"
  | "published"
  | "rejected"
  | "failed"
  | "cancelled";

export interface RequestRecord {
  id: string;
  text: string;
  user: User;
  trainingConsent: boolean;
  status: RequestStatus;
  /** 1-based place in the mission's request queue while waiting; absent once it is running. */
  queuePosition?: number;
  createdAt: string;
  updatedAt: string;
  requirement?: StructuredRequirement;
  similarPastWork: { id: string; kind: string; summary: string; score: number }[];
  feasibility?: FeasibilityAssessment;
  planIssues: PlanIssue[];
  plan?: Plan;
  proposalId?: string;
  error?: string;
  /** True for a direct action (a catalogue pick, a connection) rather than something said to an AI. */
  action?: boolean;
  /** True once its owner shares it with the crew, and for actions (a catalogue pick, a connection) that everyone sees anyway. A conversation with one's AI is private until then. */
  shared?: boolean;
  /** Plain-language answer and the results it rests on, once the request has run. */
  answer?: RequestAnswer;
  trace: TraceEvent[];
}
