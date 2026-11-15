/**
 * Turns a finished request into something a player can read: a short plain-language answer
 * and the handful of results it rests on.
 *
 * The numbers always come straight from the capabilities that ran (each keeps its own
 * verification level). Only the wording may come from a language model, and it is labelled
 * as such; without a model the answer is assembled from the results by template.
 */
import { z } from "zod";
import type { LlmService } from "../llm/llm.js";
import type { RequestRecord } from "./types.js";

export interface AnswerFact {
  label: string;
  value: string;
  /** Capability that produced the value. */
  source: string;
  verification: string;
}

export interface RequestAnswer {
  /** What kind of reply this is, for the conversation view. */
  verdict: "answer" | "explained" | "conditional" | "refuted" | "outside_model" | "built" | "built_breaks_limit" | "cannot" | "needs_input";
  text: string;
  /** How the sentence was written. It says nothing about where the numbers came from. */
  wording: "language_model" | "template";
  modelId?: string;
  facts: AnswerFact[];
}

const UNITS: [RegExp, string][] = [[/Km$/, "km"], [/Au$/, "AU"], [/Deg$/, "°"], [/Db$/, "dB"], [/Dbi$/, "dBi"], [/Kg$/, "kg"], [/Wh$/, "Wh"], [/W$/, "W"], [/Musd$/, "$M"], [/Bps$/, "bit/s"], [/Hz$/, "Hz"], [/GHz$/, "GHz"], [/Fraction$/, ""], [/KmS$/, "km/s"], [/MS$/, "m/s"], [/S$/, "s"], [/M$/, "m"], [/Days?$/, "days"]];

function show(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return Number.isFinite(value) ? (Number.isInteger(value) && Math.abs(value) < 1e9 ? String(value) : String(Number(value.toPrecision(5)))) : null;
  if (typeof value === "string") return value.length <= 80 ? value : `${value.slice(0, 77)}…`;
  if (Array.isArray(value) && value.length > 0 && value.length <= 4 && value.every((v) => typeof v === "number")) return `[${value.map((v) => Number((v as number).toPrecision(4))).join(", ")}]`;
  return null;
}

/** How engineering shorthand is written once a field name has been split into words. */
const WORDS: [RegExp, string][] = [[/\beb n ?0\b/g, "Eb/N0"], [/\bdb\b/g, "dB"], [/\bdbw\b/g, "dBW"], [/\bdbi\b/g, "dBi"], [/\bbps\b/g, "bit/s"], [/\bdod\b/g, "depth of discharge"], [/\bsoc\b/g, "state of charge"]];

export function label(key: string): { text: string; unit: string } {
  let name = key;
  let unit = "";
  for (const [pattern, u] of UNITS) {
    if (pattern.test(name) && name.replace(pattern, "").length > 2) {
      name = name.replace(pattern, "");
      unit = u;
      break;
    }
  }
  // Words are split at capitals and where letters meet digits ("maxDataRateBpsAt3DbMargin" → "max data rate bit/s at 3 dB margin").
  let text = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/(\d)([A-Za-z])/g, "$1 $2").replace(/[_.]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  for (const [pattern, written] of WORDS) text = text.replace(pattern, written);
  return { text: text.charAt(0).toUpperCase() + text.slice(1), unit };
}

/** Scalar results of every task that succeeded, a few per task, most informative first. */
export function collectFacts(record: RequestRecord, perTask = 8): AnswerFact[] {
  const facts: AnswerFact[] = [];
  for (const task of record.plan?.tasks ?? []) {
    if (task.status !== "succeeded" || !task.result) continue;
    const source = task.executedBy ?? task.capabilityId;
    if (source.startsWith("_")) continue; // internal validation steps
    const output = task.result.output;
    const entries: [string, unknown][] = output && typeof output === "object" && !Array.isArray(output) ? Object.entries(output as Record<string, unknown>) : [["result", output]];
    let taken = 0;
    const visit = (prefix: string, value: unknown, depth: number): void => {
      if (taken >= perTask) return;
      const shown = show(value);
      if (shown !== null) {
        const { text, unit } = label(prefix);
        facts.push({ label: text, value: unit && typeof value === "number" ? `${shown} ${unit}` : shown, source, verification: task.result!.verification });
        taken++;
      } else if (value && typeof value === "object" && !Array.isArray(value) && depth < 1) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(k, v, depth + 1);
      }
    };
    for (const [k, v] of entries) if (!["assumptions", "provenance", "frame", "note"].includes(k)) visit(k, v, 0);
  }
  return facts.slice(0, 16);
}

const Wording = z.object({ answer: z.string().min(1).max(1200) });
const SYSTEM = `You answer a player's question inside a space-mission design game. You are given the question and the results of the engineering tools that just ran.

Rules:
- Answer in the same language the question is written in.
- 2 to 5 short sentences, in plain words a newcomer can follow. Lead with the direct answer.
- Use only values present in the results. You may convert units (for example AU to km) and round sensibly; state the unit.
- Say in a few words what the result means for the mission when that is clear from the results.
- If the results do not answer the question, say what they do show. Never invent values, names or facts.`;

/** Compose the answer for a request that has finished executing (or was judged infeasible). */
export async function composeAnswer(record: RequestRecord, llm: LlmService, signal?: AbortSignal): Promise<RequestAnswer | undefined> {
  const facts = collectFacts(record);
  const summary = record.requirement?.summary ?? record.text;
  if (record.status === "infeasible" || (record.feasibility && !record.feasibility.proceed)) {
    const why = record.feasibility?.summary ?? "The request cannot be carried out as stated.";
    const next = record.feasibility?.suggestedModifications?.slice(0, 2).join(" ") ?? "";
    const template: RequestAnswer = { verdict: "cannot", text: `${why}${next ? ` ${next}` : ""}`, wording: "template", facts: [] };
    if (!llm.status().available) return template;
    try {
      const out = await llm.structured({ system: "A player in a space-mission design game asked their mission AI for something that the platform judged it cannot carry out. Tell them so in the language they wrote in, in 2 to 4 short plain sentences: what could not be done and why (use only the reasons given), and what they could ask for instead that is within reach. Do not invent capabilities or values.", schema: Wording, prompt: JSON.stringify({ playerSaid: record.text, understoodAs: summary, verdict: record.feasibility?.classification, reasons: (record.feasibility?.factors ?? []).filter((f) => f.status !== "ok").map((f) => f.detail), suggestions: record.feasibility?.suggestedModifications ?? [] }).slice(0, 7000), ...(signal ? { signal } : {}) });
      return { verdict: "cannot", text: out.answer.trim(), wording: "language_model", modelId: llm.modelId, facts: [] };
    } catch {
      return template;
    }
  }
  if (facts.length === 0) return undefined;
  const fallback: RequestAnswer = { verdict: "answer", text: `${summary.replace(/[.\s]+$/, "")}. ${facts.slice(0, 4).map((f) => `${f.label}: ${f.value}`).join("; ")}.`, wording: "template", facts };
  if (!llm.status().available) return fallback;
  try {
    const results = (record.plan?.tasks ?? []).filter((t) => t.status === "succeeded" && t.result).map((t) => ({ tool: t.executedBy ?? t.capabilityId, did: t.description, output: t.result!.output, assumptions: t.result!.assumptions }));
    const out = await llm.structured({ system: SYSTEM, schema: Wording, prompt: JSON.stringify({ question: record.text, understoodAs: summary, results }).slice(0, 9000), ...(signal ? { signal } : {}) });
    return { verdict: "answer", text: out.answer.trim(), wording: "language_model", modelId: llm.modelId, facts };
  } catch {
    return fallback;
  }
}

const BUILD_SYSTEM = `You are a crew member's own mission AI in a space-mission design game. The player asked for something, or proposed an idea ("if we had X, couldn't we solve Y?"). It has just been built in an isolated test copy of the mission and the engineering models were re-run.

Reply to the player in the language they wrote in, 2 to 5 short sentences, plain words:
- say what you built;
- say whether it does what they hoped, judging ONLY from the measured changes and test results given — quote the numbers that changed;
- if a test failed, say which limit it breaks and that it is their call whether to accept it;
- mention what it costs (mass, power, money, time) when the changes show it.
Never invent numbers. Do not tell them what to do next.`;

/** The reply for a request that built something: what was built, and what the engineering models measured. */
export async function composeBuildReply(record: RequestRecord, proposal: { preview: { explanation: string[]; affectedComponents: string[] }; tests: { id: string; status: string; description: string; detail: string }[]; evidence: string }, llm: LlmService, signal?: AbortSignal): Promise<RequestAnswer> {
  const failed = proposal.tests.filter((t) => t.status === "fail");
  const hard = failed.filter((t) => !t.id.startsWith("engineering."));
  const verdict: RequestAnswer["verdict"] = hard.length ? "cannot" : failed.length ? "built_breaks_limit" : "built";
  const facts: AnswerFact[] = proposal.preview.explanation.slice(0, 12).map((line) => ({ label: "Measured", value: line, source: "engineering models", verification: "deterministic_calculation" }));
  const summary = record.requirement?.summary ?? record.text;
  const template = `${hard.length ? "I could not build that" : "Built in a test copy"}: ${summary.replace(/[.\s]+$/, "")}. ${failed.length ? `It does not pass: ${failed.map((t) => `${t.description} (${t.detail})`).join("; ")}.` : "Every automated test passes."}`;
  if (!llm.status().available) return { verdict, text: template, wording: "template", facts };
  try {
    const out = await llm.structured({ system: BUILD_SYSTEM, schema: Wording, prompt: JSON.stringify({ playerSaid: record.text, understoodAs: summary, measuredChanges: proposal.preview.explanation.slice(0, 20), tests: proposal.tests.map((t) => ({ check: t.description, status: t.status, detail: t.detail })), containsAiGeneratedContent: ["model_judgment", "unverified"].includes(proposal.evidence) }).slice(0, 9000), ...(signal ? { signal } : {}) });
    return { verdict, text: out.answer.trim(), wording: "language_model", modelId: llm.modelId, facts };
  } catch {
    return { verdict, text: template, wording: "template", facts };
  }
}
