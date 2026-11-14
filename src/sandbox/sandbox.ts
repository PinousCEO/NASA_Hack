/**
 * Isolated script execution in QuickJS compiled to WebAssembly.
 *
 * The guest has no access to Node, the filesystem, the network or the host's globals.
 * Its only channel is `__host(name, jsonArgs)`, which dispatches to a fixed set of
 * permission-checked functions. State changes can only be *proposed*; they are returned
 * to the caller and go through the normal preview/approval pipeline.
 */
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import { applyPatch, getPath, type PatchOp } from "../core/paths.js";
import { linkBudget } from "../science/comms.js";
import { sunState } from "../science/ephemeris.js";
import { hohmannTransfer, orbitElements } from "../science/orbital.js";
import { eclipseFraction } from "../science/power.js";
import { roverMobility } from "../science/rover.js";
import type { Derived } from "../state/recalc.js";
import { CALC_FUNCTIONS, type CalcFunction, type ScriptPermission } from "./api.js";

export interface SandboxLimits {
  timeoutMs: number;
  memoryBytes: number;
  maxLogLines: number;
  maxProposals: number;
}

export const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 1000,
  memoryBytes: 32 * 1024 * 1024,
  maxLogLines: 200,
  maxProposals: 100,
};

export interface SandboxRun {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
  proposedPatches: PatchOp[];
  durationMs: number;
  deniedCalls: string[];
}

export interface SandboxInput {
  compiledJs: string;
  permissions: ScriptPermission[];
  config: unknown;
  derived: Derived;
  input: Record<string, unknown>;
  limits?: Partial<SandboxLimits>;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- calc inputs are validated by the science functions themselves */
const CALC: Record<CalcFunction, (input: any) => unknown> = {
  orbitElements: (i) => orbitElements(i),
  hohmannTransfer: (i) => hohmannTransfer(i.body, i.r1Km, i.r2Km),
  linkBudget: (i) => linkBudget(i),
  roverMobility: (i) => roverMobility(i),
  eclipseFraction: (i) => ({ eclipseFraction: eclipseFraction(i.body, i.orbitRadiusKm, i.betaDeg) }),
  sunState: (i) => sunState(i.centralBody, i.time),
};

const PRELUDE = `
"use strict";
const mission = Object.freeze({
  get: (path) => JSON.parse(__host("get", JSON.stringify([path]))),
  derived: (id) => JSON.parse(__host("derived", JSON.stringify([id]))),
  propose: (patch) => { __host("propose", JSON.stringify([patch])); },
  calc: (fn, input) => JSON.parse(__host("calc", JSON.stringify([fn, input]))),
  log: (message) => { __host("log", JSON.stringify([String(message)])); },
});
`;

export async function runInSandbox(args: SandboxInput): Promise<SandboxRun> {
  const limits = { ...DEFAULT_LIMITS, ...args.limits };
  const started = performance.now();
  const logs: string[] = [];
  const proposedPatches: PatchOp[] = [];
  const deniedCalls: string[] = [];
  const allowed = new Set(args.permissions);
  // Proposals are validated against a working copy so a script cannot propose nonsense paths.
  let working = structuredClone(args.config);

  const requirePermission = (name: string, permission: ScriptPermission): void => {
    if (!allowed.has(permission)) {
      deniedCalls.push(name);
      throw new Error(`Permission denied: mission.${name} requires "${permission}"`);
    }
  };
  const hostFunctions: Record<string, (...a: any[]) => unknown> = {
    get: (path: string) => {
      requirePermission("get", "state:read");
      return getPath(working, String(path)) ?? null;
    },
    derived: (id: string) => {
      requirePermission("derived", "state:read");
      return args.derived[String(id)]?.value ?? null;
    },
    propose: (patch: PatchOp) => {
      requirePermission("propose", "state:propose");
      if (proposedPatches.length >= limits.maxProposals) throw new Error("Too many proposals");
      if (!patch || typeof patch !== "object" || !["set", "append", "remove"].includes(patch.op) || typeof patch.path !== "string") {
        throw new Error("Invalid patch: expected { op: 'set'|'append'|'remove', path, value? }");
      }
      const clean: PatchOp = patch.op === "remove" ? { op: "remove", path: patch.path } : { op: patch.op, path: patch.path, value: patch.value };
      working = applyPatch(working, clean);
      proposedPatches.push(clean);
      return null;
    },
    calc: (fn: CalcFunction, input: unknown) => {
      requirePermission("calc", "calc");
      if (!CALC_FUNCTIONS.includes(fn)) throw new Error(`Unknown calculation "${String(fn)}"`);
      return CALC[fn](input);
    },
    log: (message: string) => {
      if (logs.length < limits.maxLogLines) logs.push(String(message).slice(0, 2000));
      return null;
    },
  };

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));
  const vm = runtime.newContext();
  try {
    const hostHandle = vm.newFunction("__host", (nameHandle, argsHandle) => {
      const name = vm.getString(nameHandle);
      const fn = Object.hasOwn(hostFunctions, name) ? hostFunctions[name] : undefined;
      if (!fn) throw new Error(`Unknown host function "${name}"`);
      const parsed = JSON.parse(vm.getString(argsHandle)) as unknown[];
      return vm.newString(JSON.stringify(fn(...parsed) ?? null));
    });
    vm.setProp(vm.global, "__host", hostHandle);
    hostHandle.dispose();

    const inputHandle = vm.newString(JSON.stringify(args.input));
    vm.setProp(vm.global, "__input", inputHandle);
    inputHandle.dispose();

    const program = `${PRELUDE}
const __exports = {};
(function (exports, module) {
${args.compiledJs}
})(__exports, { exports: __exports });
if (typeof __exports.run !== "function") throw new Error("module does not export run()");
const __result = __exports.run(JSON.parse(__input));
JSON.stringify(__result === undefined ? null : __result);
`;
    const evaluated = vm.evalCode(program, "module.js");
    if (evaluated.error) {
      const dumped = vm.dump(evaluated.error) as { name?: string; message?: string } | string;
      evaluated.error.dispose();
      const message = typeof dumped === "string" ? dumped : `${dumped.name ?? "Error"}: ${dumped.message ?? "unknown"}`;
      const timedOut = performance.now() - started >= limits.timeoutMs && /interrupted/i.test(message);
      return {
        ok: false,
        error: timedOut ? `Execution exceeded the ${limits.timeoutMs} ms time limit` : message,
        logs,
        proposedPatches: [],
        durationMs: performance.now() - started,
        deniedCalls,
      };
    }
    const text = vm.getString(evaluated.value);
    evaluated.value.dispose();
    return {
      ok: true,
      result: JSON.parse(text),
      logs,
      proposedPatches,
      durationMs: performance.now() - started,
      deniedCalls,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      logs,
      proposedPatches: [],
      durationMs: performance.now() - started,
      deniedCalls,
    };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
