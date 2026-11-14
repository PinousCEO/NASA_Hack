/**
 * Research knowledge base with a retrieval interface suitable for RAG.
 *
 * Three kinds of passage share one index:
 *   - reference   curated NASA systems-engineering content built into the platform
 *   - document    text extracted from files in the Data directory (PDF via pdftotext)
 *   - record      research-memory records (problems, hypotheses, changes, results, outcomes)
 *
 * Retrieval is BM25 — deterministic and inspectable. Every passage carries its source and
 * a verification level, and `context()` returns a citation-numbered block ready to be
 * placed in a model prompt. A vector index can be added behind the same interface.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { VerificationLevel } from "../core/types.js";
import type { MemoryRecord, ResearchMemory } from "../memory/memory.js";
import { CONCEPT_MATURITY_LEVELS, DISCIPLINES, LIFE_CYCLE_PHASES, MISSION_SEGMENTS } from "../nasa/lifecycle.js";

export interface Passage {
  id: string;
  text: string;
  kind: "reference" | "document" | "record";
  source: { title: string; locator?: string; recordKind?: string; recordId?: string };
  verification: VerificationLevel;
}

export interface SearchHit {
  passage: Passage;
  score: number;
}

const STOP = new Set("the and for are was were with that this from have has had not but its into than then they them their there which will would can could should about over under between within without also each such any all per via one two our your you his her out off get got may might must been being more most less very much many some other only same own both few".split(" "));
const tokenize = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));

function chunk(text: string, size = 900): string[] {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const out: string[] = [];
  let current = "";
  for (const sentence of clean.split(/(?<=[.!?])\s+|\n\n/)) {
    if (current.length + sentence.length > size && current.length > 200) {
      out.push(current.trim());
      current = "";
    }
    current += `${sentence} `;
  }
  if (current.trim().length > 40) out.push(current.trim());
  return out;
}

export class KnowledgeBase {
  private passages: Passage[] = [];
  private ingested: { file: string; passages: number }[] = [];
  private skipped: { file: string; reason: string }[] = [];

  constructor(
    private readonly memory: ResearchMemory,
    private readonly cacheDir: string | null,
  ) {
    this.addBuiltInReferences();
  }

  private addBuiltInReferences(): void {
    const add = (id: string, title: string, locator: string, text: string): void => {
      this.passages.push({ id: `ref:${id}`, text, kind: "reference", source: { title, locator }, verification: "external_data" });
    };
    for (const p of LIFE_CYCLE_PHASES) add(`phase-${p.id}`, "NASA Systems Engineering Handbook (SP-2016-6105 Rev 2)", "Project life cycle", `${p.name}. Purpose: ${p.purpose} Key review: ${p.review}.`);
    for (const c of CONCEPT_MATURITY_LEVELS) add(`cml-${c.level}`, "Wessen et al., Space Mission Concept Development Using Concept Maturity Levels (JPL)", `CML ${c.level}`, `Concept Maturity Level ${c.level} — ${c.name}. ${c.definition}`);
    for (const s of MISSION_SEGMENTS) add(`segment-${s.id}`, "NASA Small Spacecraft Systems Engineering webinar: Design and Develop Science Missions", "Mission segments", `${s.name}: ${s.description}`);
    for (const d of DISCIPLINES) add(`discipline-${d.id}`, "Concurrent mission design lab practice (GSFC Mission Design Lab)", "Discipline seats", `${d.name} discipline. ${d.description}`);
  }

  /** Locate a pdftotext binary: PDFTOTEXT_BIN, or the one on PATH. */
  static pdftotext(): string | null {
    const gitForWindows = process.platform === "win32" ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")].filter((d): d is string => Boolean(d)).map((d) => path.join(d, "Git", "mingw64", "bin", "pdftotext.exe")).filter((f) => existsSync(f)) : [];
    const candidates = [process.env.PDFTOTEXT_BIN, "pdftotext", ...gitForWindows].filter((c): c is string => Boolean(c));
    for (const bin of candidates) {
      const probe = spawnSync(bin, ["-v"], { encoding: "utf8", windowsHide: true });
      if (!probe.error) return bin;
    }
    return null;
  }

  /** Index every readable document in a directory. PDFs need `pdftotext`; without it they are reported as skipped. */
  ingestDirectory(dir: string): { documents: number; passages: number; skipped: { file: string; reason: string }[] } {
    this.passages = this.passages.filter((p) => p.kind !== "document");
    this.ingested = [];
    this.skipped = [];
    if (!existsSync(dir)) return { documents: 0, passages: 0, skipped: [] };
    const pdftotext = KnowledgeBase.pdftotext();
    for (const file of readdirSync(dir).sort()) {
      const full = path.join(dir, file);
      if (!statSync(full).isFile()) continue;
      const ext = path.extname(file).toLowerCase();
      let pages: string[];
      if (ext === ".txt" || ext === ".md") {
        pages = [readFileSync(full, "utf8")];
      } else if (ext === ".pdf") {
        if (!pdftotext) {
          this.skipped.push({ file, reason: "pdftotext is not installed (set PDFTOTEXT_BIN); PDF text was not extracted" });
          continue;
        }
        const key = createHash("sha1").update(`${file}:${statSync(full).size}:${statSync(full).mtimeMs}`).digest("hex");
        const cached = this.cacheDir ? path.join(this.cacheDir, `${key}.txt`) : null;
        let text: string;
        if (cached && existsSync(cached)) {
          text = readFileSync(cached, "utf8");
        } else {
          const run = spawnSync(pdftotext, ["-enc", "UTF-8", full, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
          if (run.status !== 0 || !run.stdout) {
            this.skipped.push({ file, reason: `pdftotext failed: ${(run.stderr || "no output").slice(0, 120)}` });
            continue;
          }
          text = run.stdout;
          if (cached) {
            mkdirSync(this.cacheDir!, { recursive: true });
            writeFileSync(cached, text);
          }
        }
        pages = text.split("\f");
      } else {
        continue;
      }
      let count = 0;
      pages.forEach((page, pageIndex) => {
        chunk(page).forEach((text, n) => {
          this.passages.push({ id: `doc:${file}:${pageIndex + 1}:${n}`, text, kind: "document", source: { title: file, ...(pages.length > 1 ? { locator: `p. ${pageIndex + 1}` } : {}) }, verification: "external_data" });
          count++;
        });
      });
      this.ingested.push({ file, passages: count });
    }
    return { documents: this.ingested.length, passages: this.ingested.reduce((s, d) => s + d.passages, 0), skipped: this.skipped };
  }

  status(): { references: number; documents: { file: string; passages: number }[]; skipped: { file: string; reason: string }[]; records: number } {
    return { references: this.passages.filter((p) => p.kind === "reference").length, documents: this.ingested, skipped: this.skipped, records: this.memory.all().length };
  }

  private recordPassage(r: MemoryRecord): Passage {
    return {
      id: `rec:${r.id}`,
      text: `${r.summary}${r.assumptions.length ? ` Assumptions: ${r.assumptions.join("; ")}.` : ""}`,
      kind: "record",
      source: { title: `${r.missionName} — ${r.kind.replace(/_/g, " ")} (${r.createdAt.slice(0, 10)})`, recordKind: r.kind, recordId: r.id },
      verification: r.verification,
    };
  }

  /** BM25 search across references, documents and research records. */
  search(query: string, options: { k?: number; kinds?: Passage["kind"][]; recordKinds?: string[]; missionName?: string } = {}): SearchHit[] {
    const records = this.memory.all().filter((r) => (!options.recordKinds || options.recordKinds.includes(r.kind)) && (!options.missionName || r.missionName === options.missionName));
    const corpus = [...this.passages, ...records.map((r) => this.recordPassage(r))].filter((p) => !options.kinds || options.kinds.includes(p.kind));
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0 || corpus.length === 0) return [];
    const docs = corpus.map((p) => tokenize(`${p.text} ${p.source.title}`));
    const avgLen = docs.reduce((s, d) => s + d.length, 0) / docs.length;
    const df = new Map<string, number>();
    for (const t of terms) df.set(t, docs.reduce((n, d) => n + (d.includes(t) ? 1 : 0), 0));
    const [k1, b] = [1.4, 0.75];
    return corpus
      .map((passage, i) => {
        const doc = docs[i]!;
        let score = 0;
        for (const t of terms) {
          const n = df.get(t)!;
          if (n === 0) continue;
          const tf = doc.reduce((c, w) => c + (w === t ? 1 : 0), 0);
          if (tf === 0) continue;
          const idf = Math.log(1 + (corpus.length - n + 0.5) / (n + 0.5));
          score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / avgLen));
        }
        return { passage, score };
      })
      .filter((h) => h.score > 0)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, options.k ?? 6);
  }

  /** Retrieval-augmented context: numbered passages with citations, bounded in size. */
  context(query: string, options: { k?: number; maxChars?: number } = {}): { context: string; citations: { n: number; id: string; source: string; verification: VerificationLevel }[] } {
    const hits = this.search(query, { k: options.k ?? 5 });
    const max = options.maxChars ?? 4000;
    const blocks: string[] = [];
    const citations: { n: number; id: string; source: string; verification: VerificationLevel }[] = [];
    let used = 0;
    for (const { passage } of hits) {
      const source = `${passage.source.title}${passage.source.locator ? `, ${passage.source.locator}` : ""}`;
      const block = `[${citations.length + 1}] (${source}; evidence: ${passage.verification.replace(/_/g, " ")})\n${passage.text}`;
      if (used + block.length > max && blocks.length > 0) break;
      blocks.push(block.slice(0, max - used));
      used += block.length;
      citations.push({ n: citations.length + 1, id: passage.id, source, verification: passage.verification });
    }
    return { context: blocks.join("\n\n"), citations };
  }
}
