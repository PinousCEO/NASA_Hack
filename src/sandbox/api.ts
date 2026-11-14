/**
 * The controlled API that generated/user scripts are written against. This declaration
 * file is the ONLY ambient surface scripts are type-checked with (no DOM, no Node),
 * and the host functions behind it are the only way out of the sandbox.
 */
export type ScriptPermission = "state:read" | "state:propose" | "calc";

export const CALC_FUNCTIONS = ["orbitElements", "hohmannTransfer", "linkBudget", "roverMobility", "eclipseFraction", "sunState"] as const;
export type CalcFunction = (typeof CALC_FUNCTIONS)[number];

export const MISSION_API_DTS = `
/** Read-only and proposal-only access to the shared mission. Injected by the runtime. */
interface MissionApi {
  /** Value at a mission-config path, e.g. "orbit.semiMajorAxisKm" or "spacecraft.components.sp1.areaM2". Requires "state:read". */
  get(path: string): unknown;
  /** Derived simulation result by node id, e.g. "power.budget". Requires "state:read". */
  derived(nodeId: string): unknown;
  /** Propose a configuration change. Proposals are collected for review; nothing is applied directly. Requires "state:propose". */
  propose(patch: { op: "set" | "append"; path: string; value: unknown } | { op: "remove"; path: string }): void;
  /** Deterministic science calculation. Requires "calc". */
  calc(fn: ${CALC_FUNCTIONS.map((f) => `"${f}"`).join(" | ")}, input: Record<string, unknown>): Record<string, unknown>;
  /** Append a line to the execution log. */
  log(message: string): void;
}
declare const mission: MissionApi;
`;

/** Contract: a script module exports `run(input)`; its return value must be JSON-serialisable. */
export const SCRIPT_CONTRACT =
  "export function run(input: Record<string, unknown>): unknown — synchronous, JSON-serialisable return value, no imports.";
