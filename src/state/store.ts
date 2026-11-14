/**
 * Versioned mission store. Every publish creates an immutable version containing the
 * configuration and its recalculated derived results. Rollback republishes an earlier
 * configuration as a new version, so history is never rewritten.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nowIso } from "../core/types.js";
import { type Derived, recalculate, type RecalcResult } from "./recalc.js";
import { type MissionConfig, parseMissionConfig } from "./schema.js";

export interface MissionVersion {
  version: number;
  parentVersion: number | null;
  config: MissionConfig;
  derived: Derived;
  recalculated: string[];
  /** Config paths this version changed relative to its parent. */
  changedPaths?: string[];
  publishedAt: string;
  publishedBy: string;
  note: string;
  proposalId?: string;
  rollbackOf?: number;
}

export interface MissionStoreEvents {
  published: [MissionVersion];
}

export class MissionStore extends EventEmitter<MissionStoreEvents> {
  private versions: MissionVersion[] = [];

  /** @param dir directory for persisted versions, or null for an in-memory store. */
  constructor(private readonly dir: string | null) {
    super();
    if (dir) {
      mkdirSync(dir, { recursive: true });
      for (const file of readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f)).sort()) {
        this.versions.push(JSON.parse(readFileSync(path.join(dir, file), "utf8")) as MissionVersion);
      }
      this.versions.sort((a, b) => a.version - b.version);
    }
  }

  get isEmpty(): boolean {
    return this.versions.length === 0;
  }

  head(): MissionVersion {
    const head = this.versions[this.versions.length - 1];
    if (!head) throw new Error("Mission store is empty: publish an initial configuration first");
    return head;
  }

  get(version: number): MissionVersion | undefined {
    return this.versions.find((v) => v.version === version);
  }

  list(): Omit<MissionVersion, "config" | "derived">[] {
    return this.versions.map(({ config: _c, derived: _d, ...meta }) => meta);
  }

  /** Validate, recalculate dependents and publish a new version. */
  publish(
    configInput: unknown,
    meta: { by: string; note: string; proposalId?: string; rollbackOf?: number },
  ): { version: MissionVersion; recalc: RecalcResult } {
    const parsed = parseMissionConfig(configInput);
    if (!parsed.ok) throw new Error(`Invalid mission configuration: ${parsed.issues.join("; ")}`);
    const prev = this.versions[this.versions.length - 1];
    const recalc = recalculate(parsed.config, prev ? { config: prev.config, derived: prev.derived } : undefined);
    const version: MissionVersion = {
      version: (prev?.version ?? 0) + 1,
      parentVersion: prev?.version ?? null,
      config: parsed.config,
      derived: recalc.derived,
      recalculated: recalc.recalculated,
      changedPaths: recalc.changedPaths,
      publishedAt: nowIso(),
      publishedBy: meta.by,
      note: meta.note,
      ...(meta.proposalId ? { proposalId: meta.proposalId } : {}),
      ...(meta.rollbackOf !== undefined ? { rollbackOf: meta.rollbackOf } : {}),
    };
    if (this.dir) {
      const file = path.join(this.dir, `v${String(version.version).padStart(6, "0")}.json`);
      if (existsSync(file)) throw new Error(`Version file already exists: ${file}`);
      writeFileSync(file, JSON.stringify(version, null, 2));
    }
    this.versions.push(version);
    this.emit("published", version);
    return { version, recalc };
  }

  rollback(targetVersion: number, by: string, reason: string): MissionVersion {
    const target = this.get(targetVersion);
    if (!target) throw new Error(`Version ${targetVersion} does not exist`);
    if (target.version === this.head().version) throw new Error(`Version ${targetVersion} is already the current version`);
    return this.publish(target.config, { by, note: `Rollback to v${targetVersion}: ${reason}`, rollbackOf: targetVersion }).version;
  }
}

/** Default mission used to initialise an empty store. Replace with config/seed-mission.json. */
export function loadSeedMission(seedFile: string): unknown {
  return JSON.parse(readFileSync(seedFile, "utf8"));
}
