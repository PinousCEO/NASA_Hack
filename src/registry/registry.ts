/**
 * Central Capability Registry: discovery, schema inspection, availability tracking,
 * execution statistics and alternative lookup for failure recovery.
 * Capabilities come from in-process services and from any number of MCP servers.
 */
import { EventEmitter } from "node:events";
import { nowIso, type Permission, type VerificationLevel } from "../core/types.js";
import type { AvailabilityStatus, Capability, CapabilityCategory, CapabilityDescriptor } from "./capability.js";

export interface CapabilityQuery {
  /** Free-text query matched against id, name, description and tags. */
  text?: string;
  category?: CapabilityCategory;
  /** Require a `provides` tag (exact, or prefix when it ends with ".*"). */
  provides?: string;
  /** Exclude unavailable and planned capabilities. */
  usableOnly?: boolean;
  /** Only capabilities the given permission set can invoke. */
  permissions?: Permission[];
}

export interface CapabilityStats {
  calls: number;
  failures: number;
  totalDurationMs: number;
  lastError?: string;
  lastCalledAt?: string;
}

export interface CapabilityMatch {
  descriptor: CapabilityDescriptor;
  score: number;
  stats: CapabilityStats;
}

const VERIFICATION_RANK: Record<VerificationLevel, number> = {
  independently_verified: 5,
  deterministic_calculation: 4,
  external_data: 3,
  heuristic: 2,
  model_judgment: 1,
  unverified: 0,
};

const tokenize = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);

export class CapabilityRegistry extends EventEmitter<{ changed: [string] }> {
  private readonly capabilities = new Map<string, Capability>();
  private readonly stats = new Map<string, CapabilityStats>();

  register(capability: Capability): void {
    const { id } = capability.descriptor;
    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/.test(id)) throw new Error(`Invalid capability id "${id}"`);
    if (this.capabilities.has(id)) throw new Error(`Capability "${id}" is already registered`);
    this.capabilities.set(id, capability);
    this.stats.set(id, { calls: 0, failures: 0, totalDurationMs: 0 });
    this.emit("changed", id);
  }

  /** Remove every capability originating from one MCP server (e.g. on disconnect). */
  unregisterSource(server: string): number {
    let removed = 0;
    for (const [id, cap] of this.capabilities) {
      if (cap.descriptor.source.type === "mcp" && cap.descriptor.source.server === server) {
        this.capabilities.delete(id);
        this.stats.delete(id);
        removed++;
        this.emit("changed", id);
      }
    }
    return removed;
  }

  get(id: string): Capability | undefined {
    return this.capabilities.get(id);
  }

  /** Schema inspection: full metadata for one capability. */
  describe(id: string): (CapabilityDescriptor & { stats: CapabilityStats }) | undefined {
    const cap = this.capabilities.get(id);
    return cap ? { ...cap.descriptor, stats: this.stats.get(id)! } : undefined;
  }

  list(): CapabilityDescriptor[] {
    return [...this.capabilities.values()].map((c) => c.descriptor);
  }

  isUsable(d: CapabilityDescriptor): boolean {
    return d.availability.status !== "unavailable" && d.developmentStatus !== "planned";
  }

  /** Discover capabilities. Results are ranked by relevance, then evidence quality and reliability. */
  search(query: CapabilityQuery = {}): CapabilityMatch[] {
    const terms = query.text ? tokenize(query.text) : [];
    const matches: CapabilityMatch[] = [];
    for (const cap of this.capabilities.values()) {
      const d = cap.descriptor;
      if (query.category && d.category !== query.category) continue;
      if (query.usableOnly && !this.isUsable(d)) continue;
      if (query.permissions && !d.requiredPermissions.every((p) => query.permissions!.includes(p))) continue;
      if (query.provides) {
        const wanted = query.provides;
        const hit = wanted.endsWith(".*")
          ? d.provides.some((p) => p.startsWith(wanted.slice(0, -1)))
          : d.provides.includes(wanted);
        if (!hit) continue;
      }
      let score = 0;
      if (terms.length) {
        const strong = new Set(tokenize(`${d.id} ${d.name} ${d.provides.join(" ")}`));
        const weak = new Set(tokenize(d.description));
        for (const t of terms) score += strong.has(t) ? 3 : weak.has(t) ? 1 : 0;
        if (score === 0) continue;
      }
      const s = this.stats.get(d.id)!;
      const reliability = s.calls ? 1 - s.failures / s.calls : 1;
      score += VERIFICATION_RANK[d.outputVerification] / 10 + reliability / 10 + (d.availability.status === "available" ? 0.05 : 0);
      matches.push({ descriptor: d, score, stats: s });
    }
    return matches.sort((a, b) => b.score - a.score || a.descriptor.id.localeCompare(b.descriptor.id));
  }

  /** Best usable capability providing a tag, or undefined. */
  resolve(tag: string, permissions?: Permission[]): CapabilityDescriptor | undefined {
    return this.search({ provides: tag, usableOnly: true, ...(permissions ? { permissions } : {}) })[0]?.descriptor;
  }

  /** Other usable capabilities that provide at least one of the same tags (failure recovery). */
  alternatives(id: string): CapabilityDescriptor[] {
    const d = this.capabilities.get(id)?.descriptor;
    if (!d) return [];
    return this.list().filter((o) => o.id !== id && this.isUsable(o) && o.provides.some((p) => d.provides.includes(p)));
  }

  recordExecution(id: string, outcome: { ok: boolean; durationMs: number; error?: string }): void {
    const s = this.stats.get(id);
    if (!s) return;
    s.calls++;
    s.totalDurationMs += outcome.durationMs;
    s.lastCalledAt = nowIso();
    if (!outcome.ok) {
      s.failures++;
      if (outcome.error) s.lastError = outcome.error;
    }
  }

  setAvailability(id: string, status: AvailabilityStatus, reason?: string): void {
    const cap = this.capabilities.get(id);
    if (!cap) return;
    cap.descriptor.availability = { status, checkedAt: nowIso(), ...(reason ? { reason } : {}) };
    this.emit("changed", id);
  }

  /** Run every capability's health check and update availability. Planned capabilities stay unavailable. */
  async refreshAvailability(): Promise<void> {
    await Promise.all(
      [...this.capabilities.values()].map(async (cap) => {
        if (!cap.healthCheck || cap.descriptor.developmentStatus === "planned") return;
        try {
          const health = await cap.healthCheck();
          this.setAvailability(cap.descriptor.id, health.status, health.reason);
        } catch (err) {
          this.setAvailability(cap.descriptor.id, "unavailable", err instanceof Error ? err.message : String(err));
        }
      }),
    );
  }
}
