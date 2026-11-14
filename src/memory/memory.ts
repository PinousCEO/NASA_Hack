/**
 * AI research memory: an append-only, provenance-preserving knowledge base of requests,
 * plans, tool executions, design changes, evidence, simulation results and outcomes.
 *
 * Retrieval is lexical (TF-IDF cosine) — deterministic and dependency-free. Records are
 * never eligible for model training unless the requester consented AND a reviewer
 * signed off on quality AND the content is not unvalidated model output.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { newId, nowIso, type Provenance, type VerificationLevel } from "../core/types.js";

export type MemoryKind =
  | "user_request"
  | "plan"
  | "tool_execution"
  | "design_change"
  | "hypothesis"
  | "scientific_evidence"
  | "simulation_result"
  | "validation_report"
  | "failure"
  | "improvement"
  | "mission_outcome"
  | "mission_problem"
  | "user_contribution"
  | "ai_evaluation"
  | "trade_study";

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  createdAt: string;
  missionName: string;
  missionVersion: number;
  requestId?: string;
  /** Short human-readable statement used for retrieval. */
  summary: string;
  data: unknown;
  tags: string[];
  provenance: Provenance;
  assumptions: string[];
  verification: VerificationLevel;
  training: { consent: boolean; qualityReviewedBy?: string; qualityReviewedAt?: string };
  /** Set on records that hold what one person said to their AI: only that person may read them. */
  visibility?: { ownerId: string };
}

/** May this account read this record? Records of a private conversation belong to the person who had it. */
export const readableBy = (r: MemoryRecord, accountId: string): boolean => !r.visibility || r.visibility.ownerId === accountId;

export type NewMemoryRecord = Omit<MemoryRecord, "id" | "createdAt" | "training"> & { trainingConsent?: boolean };

interface ReviewEvent {
  type: "quality_review";
  recordId: string;
  reviewer: string;
  at: string;
}

const tokenize = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9_.]+/).filter((t) => t.length > 2);

export class ResearchMemory {
  private readonly records = new Map<string, MemoryRecord>();
  private readonly file: string | null;

  /** @param dir directory for the JSONL log, or null for in-memory only. */
  constructor(dir: string | null) {
    this.file = dir ? path.join(dir, "memory.jsonl") : null;
    if (dir) mkdirSync(dir, { recursive: true });
    if (this.file && existsSync(this.file)) {
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as MemoryRecord | ReviewEvent;
        if ("type" in entry && entry.type === "quality_review") this.applyReview(entry);
        else this.records.set((entry as MemoryRecord).id, entry as MemoryRecord);
      }
    }
  }

  private append(entry: MemoryRecord | ReviewEvent): void {
    if (this.file) appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }

  private applyReview(event: ReviewEvent): void {
    const record = this.records.get(event.recordId);
    if (record) record.training = { ...record.training, qualityReviewedBy: event.reviewer, qualityReviewedAt: event.at };
  }

  add(input: NewMemoryRecord): MemoryRecord {
    const { trainingConsent, ...rest } = input;
    const record: MemoryRecord = { ...rest, id: newId("mem"), createdAt: nowIso(), training: { consent: trainingConsent ?? false } };
    this.records.set(record.id, record);
    this.append(record);
    return record;
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  all(): MemoryRecord[] {
    return [...this.records.values()];
  }

  forRequest(requestId: string): MemoryRecord[] {
    return [...this.records.values()].filter((r) => r.requestId === requestId);
  }

  markQualityReviewed(recordId: string, reviewer: string): MemoryRecord {
    if (!this.records.has(recordId)) throw new Error(`Memory record "${recordId}" not found`);
    const event: ReviewEvent = { type: "quality_review", recordId, reviewer, at: nowIso() };
    this.applyReview(event);
    this.append(event);
    return this.records.get(recordId)!;
  }

  /** Records that may be considered for future model training. */
  trainingEligible(): MemoryRecord[] {
    return [...this.records.values()].filter(
      (r) =>
        r.training.consent &&
        r.training.qualityReviewedBy !== undefined &&
        r.verification !== "model_judgment" &&
        r.verification !== "unverified",
    );
  }

  /** Lexical similarity search over summaries and tags. */
  search(query: string, options: { limit?: number; kinds?: MemoryKind[] } = {}): { record: MemoryRecord; score: number }[] {
    const pool = [...this.records.values()].filter((r) => !options.kinds || options.kinds.includes(r.kind));
    const docs = pool.map((r) => tokenize(`${r.summary} ${r.tags.join(" ")}`));
    const df = new Map<string, number>();
    for (const doc of docs) for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
    const idf = (t: string): number => Math.log(1 + pool.length / (1 + (df.get(t) ?? 0)));
    const vector = (tokens: string[]): Map<string, number> => {
      const v = new Map<string, number>();
      for (const t of tokens) v.set(t, (v.get(t) ?? 0) + idf(t));
      return v;
    };
    const q = vector(tokenize(query));
    const magnitude = (v: Map<string, number>): number => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
    const qMag = magnitude(q);
    if (qMag === 0) return [];
    return pool
      .map((record, i) => {
        const d = vector(docs[i]!);
        let dotProduct = 0;
        for (const [t, w] of q) dotProduct += w * (d.get(t) ?? 0);
        const dMag = magnitude(d);
        return { record, score: dMag ? dotProduct / (qMag * dMag) : 0 };
      })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit ?? 5);
  }
}
