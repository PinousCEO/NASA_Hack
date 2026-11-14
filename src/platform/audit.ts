/**
 * Append-only, tamper-evident audit log. Each entry carries the SHA-256 of the previous
 * entry, so removing or altering a line breaks the chain and is detected by `verify()`.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { redact } from "./secrets.js";

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  /** Session (mission room) the action belongs to, if any. */
  sessionId?: string;
  outcome: "ok" | "denied" | "error";
  detail?: unknown;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);
const digest = (e: Omit<AuditEntry, "hash">): string => createHash("sha256").update(JSON.stringify(e)).digest("hex");

export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly file: string | null;

  constructor(dir: string | null) {
    this.file = dir ? path.join(dir, "audit.jsonl") : null;
    if (dir) mkdirSync(dir, { recursive: true });
    if (this.file && existsSync(this.file)) {
      this.entries = readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as AuditEntry);
    }
  }

  record(event: { actor: string; action: string; sessionId?: string; outcome?: AuditEntry["outcome"]; detail?: unknown }): AuditEntry {
    const prev = this.entries[this.entries.length - 1];
    const base: Omit<AuditEntry, "hash"> = {
      seq: (prev?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      actor: event.actor,
      action: event.action,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      outcome: event.outcome ?? "ok",
      ...(event.detail !== undefined ? { detail: JSON.parse(redact(JSON.stringify(event.detail))) as unknown } : {}),
      prevHash: prev?.hash ?? GENESIS,
    };
    const entry: AuditEntry = { ...base, hash: digest(base) };
    this.entries.push(entry);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  query(filter: { sessionId?: string; actor?: string; action?: string; limit?: number } = {}): AuditEntry[] {
    const out = this.entries.filter(
      (e) =>
        (!filter.sessionId || e.sessionId === filter.sessionId) &&
        (!filter.actor || e.actor === filter.actor) &&
        (!filter.action || e.action.startsWith(filter.action)),
    );
    return out.slice(-(filter.limit ?? 200)).reverse();
  }

  /** Check the hash chain. Returns the sequence number of the first broken entry, if any. */
  verify(): { ok: boolean; entries: number; brokenAt?: number } {
    let prevHash = GENESIS;
    for (const e of this.entries) {
      const { hash, ...base } = e;
      if (e.prevHash !== prevHash || digest(base) !== hash) return { ok: false, entries: this.entries.length, brokenAt: e.seq };
      prevHash = hash;
    }
    return { ok: true, entries: this.entries.length };
  }
}
