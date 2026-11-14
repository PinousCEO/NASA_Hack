/**
 * Dependency-graph executor: runs independent tasks in parallel, dependent tasks in order,
 * with per-task timeouts, retries with backoff, result validation, failure recovery through
 * alternative capabilities, cancellation, and rollback of the draft workspace on failure.
 */
import { getPath } from "../core/paths.js";
import { CapabilityError, nowIso, ROLE_PERMISSIONS, type User } from "../core/types.js";
import type { Capability, CapabilityResult, DraftWorkspace } from "../registry/capability.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import { recalculate } from "../state/recalc.js";
import { parseMissionConfig } from "../state/schema.js";
import type { MissionVersion } from "../state/store.js";
import { isFromState, isRef, validateGraph } from "./planner.js";
import type { Criterion, Plan, PlanTask, TraceEvent } from "./types.js";

export interface ExecutionEnv {
  requestId: string;
  user: User;
  mission: MissionVersion;
  draft: DraftWorkspace;
  signal: AbortSignal;
  trace(stage: TraceEvent["stage"], message: string, data?: unknown): void;
  onProgress?(plan: Plan, task: PlanTask): void;
}

export interface ExecutorOptions {
  concurrency: number;
  retryBaseDelayMs: number;
}

const DEFAULTS: ExecutorOptions = { concurrency: 4, retryBaseDelayMs: 250 };

/** Keep traces readable: large arrays/strings are summarised, structure is preserved. */
export function compact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}… (${value.length} chars)` : value;
  if (Array.isArray(value)) {
    if (value.length > 24) return { $summary: `array of ${value.length} items`, first: value.slice(0, 3).map((v) => compact(v, depth + 1)) };
    return value.map((v) => compact(v, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth > 6) return "{…}";
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v, depth + 1)]));
  }
  return value;
}

export function evaluateCriterion(output: unknown, c: Criterion): { ok: boolean; detail: string } {
  const actual = getPath(output, c.path);
  const show = (v: unknown): string => JSON.stringify(v) ?? "undefined";
  const numeric = typeof actual === "number" && typeof c.value === "number";
  let ok: boolean;
  switch (c.op) {
    case "exists": ok = actual !== undefined && actual !== null; break;
    case "truthy": ok = Boolean(actual); break;
    case "==": ok = show(actual) === show(c.value); break;
    case "!=": ok = show(actual) !== show(c.value); break;
    case ">": ok = numeric && actual > (c.value as number); break;
    case ">=": ok = numeric && actual >= (c.value as number); break;
    case "<": ok = numeric && actual < (c.value as number); break;
    case "<=": ok = numeric && actual <= (c.value as number); break;
  }
  return { ok, detail: `${c.path} ${c.op}${c.value !== undefined ? ` ${show(c.value)}` : ""} (actual: ${show(actual)})` };
}

class TimeoutError extends Error {}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("cancelled"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export class PlanExecutor {
  private readonly options: ExecutorOptions;

  constructor(
    private readonly registry: CapabilityRegistry,
    options: Partial<ExecutorOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  async run(plan: Plan, env: ExecutionEnv): Promise<Plan> {
    // Never trust the graph: re-validate it here (this also turns data references into dependencies).
    const graphErrors = validateGraph(plan.tasks);
    if (graphErrors.length) {
      for (const t of plan.tasks) {
        t.status = "skipped";
        t.error = "Plan graph is invalid";
      }
      plan.status = "failed";
      plan.rolledBack = true;
      env.draft.discard();
      env.trace("execution", `Plan rejected before execution: ${graphErrors.join("; ")}`, { graphErrors });
      return plan;
    }
    plan.status = "running";
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    const running = new Map<string, Promise<void>>();
    const effectOf = (t: PlanTask): string => this.registry.get(t.capabilityId)?.descriptor.constraints.effect ?? "read";

    for (;;) {
      if (env.signal.aborted) {
        for (const t of plan.tasks) if (t.status === "pending") t.status = "cancelled";
        await Promise.allSettled(running.values());
        break;
      }
      // Propagate failure: a task whose dependency did not succeed can never run.
      let changed = true;
      while (changed) {
        changed = false;
        for (const t of plan.tasks) {
          if (t.status !== "pending") continue;
          const blocked = t.dependsOn.map((d) => byId.get(d)!).find((d) => ["failed", "skipped", "cancelled"].includes(d.status));
          if (blocked) {
            t.status = "skipped";
            t.error = `Skipped because dependency "${blocked.id}" ${blocked.status}`;
            env.trace("execution", `Task ${t.id} skipped`, { taskId: t.id, reason: t.error });
            env.onProgress?.(plan, t);
            changed = true;
          }
        }
      }
      const ready = plan.tasks.filter((t) => t.status === "pending" && t.dependsOn.every((d) => byId.get(d)!.status === "succeeded"));
      for (const task of ready) {
        if (running.size >= this.options.concurrency) break;
        // Draft writers are serialised; readers and external calls run alongside each other.
        const writerRunning = [...running.keys()].some((id) => effectOf(byId.get(id)!) === "draft_write");
        if (effectOf(task) === "draft_write" && writerRunning) continue;
        task.status = "running";
        const promise = this.runTask(task, byId, env).finally(() => {
          running.delete(task.id);
          env.onProgress?.(plan, task);
        });
        running.set(task.id, promise);
        env.onProgress?.(plan, task);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }

    const cancelled = env.signal.aborted;
    const failed = plan.tasks.some((t) => t.status === "failed");
    plan.status = cancelled ? "cancelled" : failed ? "failed" : "succeeded";
    if (plan.status !== "succeeded") {
      // Rollback: nothing was published, so discarding the draft undoes every staged change.
      const staged = env.draft.patches.length;
      const files = env.draft.stagedAssets.length;
      env.draft.discard();
      plan.rolledBack = true;
      for (const t of plan.tasks) if (t.status === "succeeded" && effectOf(t) === "draft_write") t.status = "rolled_back";
      env.trace("recovery", `Plan ${plan.status}; draft workspace rolled back`, { discardedPatches: staged, discardedAssetFiles: files });
    }
    return plan;
  }

  private resolveInput(task: PlanTask, capability: Capability, byId: Map<string, PlanTask>, env: ExecutionEnv): unknown {
    if (isFromState(task.input)) {
      const parsed = parseMissionConfig(env.draft.workingConfig());
      if (!parsed.ok) throw new CapabilityError(`Draft configuration is invalid: ${parsed.issues.join("; ")}`);
      const derived = env.draft.isEmpty ? env.mission.derived : recalculate(parsed.config, { config: env.mission.config, derived: env.mission.derived }).derived;
      // A fallback capability without a state binder receives the raw parameters.
      return capability.defaultInput?.({ config: parsed.config, derived, params: task.input.$fromState }) ?? task.input.$fromState;
    }
    const walk = (value: unknown): unknown => {
      if (isRef(value)) {
        const source = byId.get(value.$ref);
        if (!source?.result) throw new CapabilityError(`Reference to "${value.$ref}" cannot be resolved: that task has no result`);
        const resolved = value.path ? getPath(source.result.output, value.path.replace(/^output\./, "")) : source.result.output;
        if (resolved === undefined) throw new CapabilityError(`Reference "${value.$ref}.${value.path}" is not present in that task's output`);
        return resolved;
      }
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      return value;
    };
    return walk(task.input);
  }

  private async attempt(capability: Capability, input: unknown, task: PlanTask, env: ExecutionEnv): Promise<CapabilityResult> {
    const d = capability.descriptor;
    const timeout = new AbortController();
    const signal = AbortSignal.any([env.signal, timeout.signal]);
    const listeners = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const started = performance.now();
    try {
      const result = await Promise.race([
        capability.execute(input, {
          requestId: env.requestId,
          user: env.user,
          signal,
          mission: env.mission,
          draft: env.draft,
          log: (message) => env.trace("execution", `[${task.id}] ${message}`),
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timeout.abort();
            reject(new TimeoutError(`Timed out after ${d.constraints.timeoutMs} ms`));
          }, d.constraints.timeoutMs);
          if (env.signal.aborted) reject(new Error("cancelled"));
          env.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true, signal: listeners.signal });
        }),
      ]);
      this.registry.recordExecution(d.id, { ok: true, durationMs: performance.now() - started });
      return result;
    } catch (err) {
      this.registry.recordExecution(d.id, { ok: false, durationMs: performance.now() - started, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      clearTimeout(timer);
      listeners.abort();
    }
  }

  /** Execute with retries; returns the result or throws the last error. */
  private async executeWithRetries(capability: Capability, input: unknown, task: PlanTask, env: ExecutionEnv): Promise<CapabilityResult> {
    const d = capability.descriptor;
    for (let n = 0; ; n++) {
      task.attempts++;
      try {
        return await this.attempt(capability, input, task, env);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const retryable = (err instanceof CapabilityError && err.retryable) || (err instanceof TimeoutError && d.constraints.idempotent);
        if (env.signal.aborted || !retryable || n >= d.constraints.maxRetries) throw err;
        const delay = this.options.retryBaseDelayMs * 2 ** n;
        env.trace("recovery", `Task ${task.id}: attempt ${n + 1} on "${d.id}" failed (${message}); retrying in ${delay} ms`, { taskId: task.id, capabilityId: d.id, attempt: n + 1 });
        await sleep(delay, env.signal);
      }
    }
  }

  private async runTask(task: PlanTask, byId: Map<string, PlanTask>, env: ExecutionEnv): Promise<void> {
    task.startedAt = nowIso();
    const started = performance.now();
    const finish = (status: "succeeded" | "failed" | "cancelled", error?: string): void => {
      task.status = status;
      task.endedAt = nowIso();
      task.durationMs = Math.round(performance.now() - started);
      if (error) task.error = error;
    };
    const permissions = ROLE_PERMISSIONS[env.user.role];
    const primary = this.registry.get(task.capabilityId);
    if (!primary) return finish("failed", `Capability "${task.capabilityId}" is no longer registered`);

    // The primary capability first, then alternatives that provide the same thing.
    const candidates = [primary, ...this.registry.alternatives(primary.descriptor.id).map((d) => this.registry.get(d.id)!)];
    let lastError = "";
    for (const [index, capability] of candidates.entries()) {
      const d = capability.descriptor;
      if (index > 0) {
        env.trace("recovery", `Task ${task.id}: falling back from "${task.capabilityId}" to alternative "${d.id}"`, { taskId: task.id, failed: task.capabilityId, alternative: d.id, previousError: lastError });
      }
      const missing = d.requiredPermissions.filter((p) => !permissions.includes(p));
      if (missing.length) {
        lastError = `User "${env.user.id}" (${env.user.role}) lacks permissions for "${d.id}": ${missing.join(", ")}`;
        continue;
      }
      if (!this.registry.isUsable(d)) {
        lastError = `Capability "${d.id}" is unavailable: ${d.availability.reason ?? "unknown"}`;
        continue;
      }
      let input: unknown;
      try {
        input = this.resolveInput(task, capability, byId, env);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (index === 0) break; // reference problems are not fixed by switching capability
        continue;
      }
      const check = capability.validateInput(input);
      if (!check.ok) {
        lastError = `Input does not satisfy the schema of "${d.id}": ${check.errors.join("; ")}`;
        continue;
      }
      env.trace("execution", `Task ${task.id}: calling "${d.id}"`, { taskId: task.id, capabilityId: d.id, version: d.version, input: compact(input) });
      try {
        const result = await this.executeWithRetries(capability, check.value ?? input, task, env);
        const failures = task.validation.map((c) => evaluateCriterion(result.output, c)).filter((r) => !r.ok);
        env.trace("validation", `Task ${task.id}: ${task.validation.length - failures.length}/${task.validation.length} validation criteria passed`, {
          taskId: task.id,
          criteria: task.validation.map((c) => evaluateCriterion(result.output, c)),
        });
        if (failures.length) {
          task.result = result;
          lastError = `Result validation failed: ${failures.map((f) => f.detail).join("; ")}`;
          break; // the capability worked; its result is simply not acceptable
        }
        task.result = result;
        task.executedBy = d.id;
        env.trace("execution", `Task ${task.id}: "${d.id}" succeeded`, {
          taskId: task.id,
          capabilityId: d.id,
          output: compact(result.output),
          verification: result.verification,
          assumptions: result.assumptions,
          provenance: result.provenance,
          attempts: task.attempts,
        });
        return finish("succeeded");
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (env.signal.aborted) {
          env.trace("execution", `Task ${task.id} cancelled`, { taskId: task.id });
          return finish("cancelled", "Cancelled");
        }
        env.trace("execution", `Task ${task.id}: "${d.id}" failed`, { taskId: task.id, capabilityId: d.id, error: lastError, attempts: task.attempts });
      }
    }
    finish("failed", lastError);
  }
}
