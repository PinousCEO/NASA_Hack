/**
 * Shared vocabulary for evidence quality and provenance.
 *
 * The system never upgrades a result's verification level implicitly: a value
 * produced by a model stays `model_judgment` until an independent check says otherwise.
 */
export type VerificationLevel =
  | "independently_verified" // cross-checked against an independent source or test
  | "deterministic_calculation" // closed-form / numerical computation from stated inputs
  | "external_data" // retrieved from an authoritative external provider
  | "heuristic" // rule-based estimate
  | "model_judgment" // produced by an AI model, not validated
  | "unverified";

/** Ordered weakest → strongest, used to compute the weakest link of a chain of results. */
const VERIFICATION_ORDER: VerificationLevel[] = [
  "unverified",
  "model_judgment",
  "heuristic",
  "external_data",
  "deterministic_calculation",
  "independently_verified",
];

export function weakestVerification(levels: VerificationLevel[]): VerificationLevel {
  if (levels.length === 0) return "unverified";
  return levels.reduce((a, b) => (VERIFICATION_ORDER.indexOf(a) <= VERIFICATION_ORDER.indexOf(b) ? a : b));
}

export interface Provenance {
  source: string;
  capabilityId?: string;
  capabilityVersion?: string;
  modelId?: string;
  retrievedAt?: string;
  references?: string[];
}

export type Role = "viewer" | "engineer" | "lead";

export type Permission =
  | "state:read"
  | "state:propose"
  | "asset:write"
  | "code:generate"
  | "code:execute_sandbox"
  | "network:external"
  | "llm:invoke"
  | "memory:read";

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  viewer: ["state:read", "memory:read"],
  engineer: [
    "state:read",
    "memory:read",
    "state:propose",
    "asset:write",
    "code:generate",
    "code:execute_sandbox",
    "network:external",
    "llm:invoke",
  ],
  lead: [
    "state:read",
    "memory:read",
    "state:propose",
    "asset:write",
    "code:generate",
    "code:execute_sandbox",
    "network:external",
    "llm:invoke",
  ],
};

export interface User {
  id: string;
  role: Role;
}

export type JsonSchema = Record<string, unknown>;

export class CapabilityError extends Error {
  constructor(
    message: string,
    readonly options: { retryable?: boolean; code?: string } = {},
  ) {
    super(message);
    this.name = "CapabilityError";
  }
  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 46656;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36).padStart(3, "0")}${Math.random().toString(36).slice(2, 6)}`;
}

export const nowIso = (): string => new Date().toISOString();
