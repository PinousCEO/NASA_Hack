/**
 * Direct (out-of-pipeline) invocation of a single read-only capability, used by the HTTP
 * API and the MCP server. Capabilities that stage changes are refused here: modifications
 * must go through a request so they get planning, preview and approval.
 */
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityError, newId, ROLE_PERMISSIONS, type User } from "../core/types.js";
import type { MissionStore } from "../state/store.js";
import { type CapabilityResult, DraftWorkspace } from "./capability.js";
import type { CapabilityRegistry } from "./registry.js";

export async function executeDirect(
  deps: { registry: CapabilityRegistry; store: MissionStore },
  capabilityId: string,
  input: unknown,
  user: User,
  signal?: AbortSignal,
): Promise<CapabilityResult> {
  const capability = deps.registry.get(capabilityId);
  if (!capability) throw new CapabilityError(`Unknown capability "${capabilityId}"`, { code: "not_found" });
  const d = capability.descriptor;
  if (!deps.registry.isUsable(d)) {
    throw new CapabilityError(`Capability "${d.id}" is ${d.developmentStatus === "planned" ? "planned, not implemented" : "unavailable"}: ${d.availability.reason ?? ""}`, { code: "unavailable" });
  }
  if (d.constraints.effect === "draft_write") {
    throw new CapabilityError(`"${d.id}" stages mission changes and can only run as part of a request (so the change is previewed and approved)`, { code: "requires_request" });
  }
  const missing = d.requiredPermissions.filter((p) => !ROLE_PERMISSIONS[user.role].includes(p));
  if (missing.length) throw new CapabilityError(`Role "${user.role}" lacks permissions: ${missing.join(", ")}`, { code: "forbidden" });
  const check = capability.validateInput(input);
  if (!check.ok) throw new CapabilityError(`Invalid input: ${check.errors.join("; ")}`, { code: "invalid_input" });

  const mission = deps.store.head();
  const stagingDir = path.join(os.tmpdir(), "mission-ai-direct", newId("d"));
  const draft = new DraftWorkspace(mission, stagingDir);
  const timeout = AbortSignal.timeout(d.constraints.timeoutMs);
  const started = performance.now();
  try {
    const result = await capability.execute(check.value ?? input, {
      requestId: "direct",
      user,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      mission,
      draft,
      log: () => {},
    });
    deps.registry.recordExecution(d.id, { ok: true, durationMs: performance.now() - started });
    return result;
  } catch (err) {
    deps.registry.recordExecution(d.id, { ok: false, durationMs: performance.now() - started, error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
