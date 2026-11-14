/**
 * Preview, approval and deployment.
 *
 * A proposal is built from a request's draft workspace: the configuration diff, the
 * components it touches, the recalculated consequences, and automated test results.
 * Publishing requires an approver with the right role and no failing tests, creates a new
 * mission version, and is broadcast (configuration + derived results) by the store.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateGlb } from "../assets/glb.js";
import { diff, type DiffEntry } from "../core/paths.js";
import { newId, nowIso, type Role, type User, type VerificationLevel, weakestVerification } from "../core/types.js";
import { DraftWorkspace } from "../registry/capability.js";
import { runInSandbox } from "../sandbox/sandbox.js";
import { validateModuleSource } from "../sandbox/typecheck.js";
import { type Derived, engineeringChecks, recalculate, type RecalcResult } from "../state/recalc.js";
import { type MissionConfig, parseMissionConfig } from "../state/schema.js";
import type { MissionStore, MissionVersion } from "../state/store.js";
import type { Consequence, Plan, Proposal, TestResult } from "./types.js";

const ROLE_RANK: Record<Role, number> = { viewer: 0, engineer: 1, lead: 2 };
/** Derived keys that are bulky geometry rather than metrics worth diffing in a preview. */
const SKIP_KEYS = new Set(["pathKm", "samples", "currentPositionKm"]);

function flatten(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${(v as { antennaId?: string })?.antennaId ?? i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) if (!SKIP_KEYS.has(k)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, value);
  }
}

function consequencesOf(before: Derived, after: Derived, nodes: string[]): Consequence[] {
  const out: Consequence[] = [];
  for (const node of nodes) {
    const a = new Map<string, unknown>();
    const b = new Map<string, unknown>();
    flatten(before[node]?.value ?? null, "", a);
    flatten(after[node]?.value ?? null, "", b);
    for (const metric of new Set([...a.keys(), ...b.keys()])) {
      const [x, y] = [a.get(metric), b.get(metric)];
      if (typeof x === "number" && typeof y === "number") {
        if (Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(x), Math.abs(y))) out.push({ node, metric, before: x, after: y, delta: y - x });
      } else if (JSON.stringify(x) !== JSON.stringify(y)) {
        out.push({ node, metric, before: x ?? null, after: y ?? null });
      }
    }
    if (after[node]?.error && after[node]?.error !== before[node]?.error) out.push({ node, metric: "(error)", before: before[node]?.error ?? null, after: after[node]!.error });
  }
  return out;
}

function affectedComponents(entries: DiffEntry[]): string[] {
  const ids = new Set<string>();
  for (const e of entries) {
    const parts = e.path.split(".");
    if ((parts[0] === "spacecraft" || parts[0] === "rover") && parts[1] === "components" && parts[2]) ids.add(`${parts[0]}.components.${parts[2]}`);
    else if (parts[0] === "scene" && parts[2]) ids.add(`scene.nodes.${parts[2]}`);
    else if ((parts[0] === "assets" || parts[0] === "scripts") && parts[1]) ids.add(`${parts[0]}.${parts[1]}`);
    else if (parts[0] === "rover") ids.add("rover");
    else ids.add(parts[0]!);
  }
  return [...ids].sort();
}

function significanceOf(entries: DiffEntry[], regressions: number): "minor" | "significant" {
  const structural = entries.some(
    (e) =>
      e.path === "centralBody" ||
      e.path.startsWith("orbit.") ||
      e.path.startsWith("scripts") ||
      (/^(spacecraft|rover)\.components\.[^.]+$/.test(e.path) && e.kind !== "changed") ||
      (e.path === "rover" && e.kind !== "changed"),
  );
  return structural || regressions > 0 ? "significant" : "minor";
}

interface Entry {
  proposal: Proposal;
  draft: DraftWorkspace;
  /** Evidence level of the task results the draft was built from. */
  sourceEvidence: VerificationLevel;
  candidate: MissionConfig | null;
}

/** Flies a mission design through its simulated flight; supplied by the session, which knows the in-flight events. */
export type FlightTest = (config: MissionConfig) => { days: number; kpis: { totalDataReturnedGb: number; totalDataLostGb: number; daysPowerNegative: number; daysInstrumentsOff: number; scienceDeliveredFraction: number; daysControlActive: number }; controlLog: { day: number; effect: string; note?: string }[]; returnedByInstrument: { instrumentId: string; name: string; returnedGb: number; lostGb: number }[] };

export class ProposalService {
  /** When set, a change to the wiring or control logic is flown with and without the change, and the difference reported. */
  flightTest: FlightTest | null = null;

  private readonly entries = new Map<string, Entry>();

  /**
   * @param dir directory in which pending and decided proposals are persisted, or null to
   *            keep them in memory only. Persisted proposals are restored on construction.
   */
  constructor(
    private readonly store: MissionStore,
    private readonly assetsDir: string,
    private readonly dir: string | null = null,
  ) {
    if (!dir || !existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const saved = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { proposal: Proposal; sourceEvidence: VerificationLevel; draft: { stagingDir: string; stagedAssets: { id: string; stagedPath: string; fileName: string }[] } };
      const base = store.get(saved.proposal.baseVersion) ?? store.head();
      let draft: DraftWorkspace;
      try {
        // Pending proposals get their draft back; decided ones only need the record.
        draft = saved.proposal.status === "awaiting_approval" ? DraftWorkspace.restore(base, saved.draft.stagingDir, saved.proposal.patches, saved.draft.stagedAssets) : new DraftWorkspace(base, saved.draft.stagingDir);
      } catch {
        saved.proposal.status = "superseded";
        draft = new DraftWorkspace(base, saved.draft.stagingDir);
      }
      // The candidate configuration is recomputed against the current head when it is next needed.
      this.entries.set(saved.proposal.id, { proposal: saved.proposal, draft, sourceEvidence: saved.sourceEvidence, candidate: null });
    }
  }

  private persist(entry: Entry): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      path.join(this.dir, `${entry.proposal.id}.json`),
      JSON.stringify({ proposal: entry.proposal, sourceEvidence: entry.sourceEvidence, draft: { stagingDir: entry.draft.directory, stagedAssets: entry.draft.stagedAssets } }, null, 2),
    );
  }

  get(id: string): Proposal | undefined {
    return this.entries.get(id)?.proposal;
  }

  list(): Proposal[] {
    return [...this.entries.values()].map((e) => e.proposal);
  }

  /** Build the preview and run the automated tests against the current head. */
  private async evaluate(draft: DraftWorkspace, head: MissionVersion, sourceEvidence: VerificationLevel): Promise<Pick<Proposal, "baseVersion" | "preview" | "tests" | "significance" | "requiredRole" | "evidence"> & { candidate: MissionConfig | null }> {
    const tests: TestResult[] = [];
    let candidate: MissionConfig | null = null;
    let recalc: RecalcResult | null = null;
    try {
      const parsed = parseMissionConfig(draft.rebaseOnto(head.config));
      if (parsed.ok) {
        candidate = parsed.config;
        tests.push({ id: "config.schema", description: "Resulting configuration is structurally valid", status: "pass", detail: "Schema and referential integrity checks passed" });
      } else {
        tests.push({ id: "config.schema", description: "Resulting configuration is structurally valid", status: "fail", detail: parsed.issues.join("; ") });
      }
    } catch (err) {
      tests.push({ id: "config.apply", description: `Draft applies to mission version ${head.version}`, status: "fail", detail: `Conflict with the current version: ${err instanceof Error ? err.message : String(err)}` });
    }

    let configDiff: DiffEntry[] = [];
    let consequences: Consequence[] = [];
    let regressions = 0;
    if (candidate) {
      recalc = recalculate(candidate, { config: head.config, derived: head.derived });
      configDiff = diff(head.config, candidate).map((d) =>
        // Script bodies are shown by reference, not inlined into the preview.
        /^scripts\.[^.]+$/.test(d.path) && d.after ? { ...d, after: { ...(d.after as object), compiledJs: "(omitted)" } } : d,
      );
      consequences = consequencesOf(head.derived, recalc.derived, recalc.recalculated);
      const baseline = new Map(engineeringChecks(head.config, head.derived).map((c) => [c.id, c.status]));
      for (const check of engineeringChecks(candidate, recalc.derived)) {
        const preExisting = check.status === "fail" && baseline.get(check.id) === "fail";
        if (check.status === "fail" && !preExisting) regressions++;
        tests.push({
          id: `engineering.${check.id}`,
          description: check.description,
          status: preExisting ? "warn" : check.status,
          detail: preExisting ? `${check.detail} (already failing before this change)` : check.detail,
        });
      }
      for (const asset of draft.stagedAssets) {
        const record = candidate.assets.find((a) => a.id === asset.id);
        try {
          const bytes = readFileSync(asset.stagedPath);
          const stats = validateGlb(bytes);
          const sha = createHash("sha256").update(bytes).digest("hex");
          const ok = record !== undefined && record.sha256 === sha;
          tests.push({ id: `asset.${asset.id}`, description: `Asset ${asset.fileName} is a valid GLB matching its record`, status: ok ? "pass" : "fail", detail: ok ? `${stats.triangles} triangles, ${bytes.byteLength} bytes, sha256 verified` : "Staged file does not match its asset record" });
        } catch (err) {
          tests.push({ id: `asset.${asset.id}`, description: `Asset ${asset.fileName} is a valid GLB`, status: "fail", detail: err instanceof Error ? err.message : String(err) });
        }
      }
      const baseScripts = new Set(head.config.scripts.map((s) => s.id));
      for (const script of candidate.scripts.filter((s) => !baseScripts.has(s.id))) {
        const checked = validateModuleSource(script.source);
        const sha = createHash("sha256").update(script.source).digest("hex");
        if (!checked.ok || !checked.compiledJs || sha !== script.sha256) {
          tests.push({ id: `script.${script.id}`, description: `Script "${script.name}" passes static validation`, status: "fail", detail: sha !== script.sha256 ? "Source does not match its recorded hash" : [...checked.policyViolations, ...checked.diagnostics].join("; ") });
          continue;
        }
        const run = await runInSandbox({ compiledJs: checked.compiledJs, permissions: script.permissions, config: candidate, derived: recalc.derived, input: {} });
        tests.push({
          id: `script.${script.id}`,
          description: `Script "${script.name}" type-checks and loads in the sandbox`,
          // A runtime error with empty input is not a defect by itself: the script may require inputs.
          status: run.ok ? "pass" : "warn",
          detail: run.ok ? `Static validation passed; sandbox run completed in ${run.durationMs.toFixed(0)} ms` : `Static validation passed; sandbox run with empty input ended with: ${run.error}`,
        });
      }
    }

    const modelScripts = candidate?.scripts.filter((s) => s.origin.kind === "model_generated" && !head.config.scripts.some((b) => b.id === s.id)) ?? [];
    const evidence = weakestVerification([sourceEvidence, ...(modelScripts.length ? (["model_judgment"] as const) : [])]);
    if (evidence === "model_judgment" || evidence === "unverified") {
      tests.push({
        id: "evidence.unvalidated",
        description: "Change rests only on validated evidence",
        status: "warn",
        detail: "This proposal includes model-generated or unverified content. The automated tests cover structure, safety and engineering constraints; they do not establish scientific correctness.",
      });
    }

    // New onboard behaviour is tested by flying it: the same mission, the same in-flight events, with and without the change.
    const flightLines: string[] = [];
    if (candidate && this.flightTest && configDiff.some((d) => d.path.startsWith("systems.controllers"))) {
      try {
        const before = this.flightTest(head.config);
        const after = this.flightTest(candidate);
        const n = (v: number, digits = 1): string => v.toFixed(digits);
        flightLines.push(
          `Flight test over ${after.days} days with the same in-flight events — before → after this change:`,
          `science data returned: ${n(before.kpis.totalDataReturnedGb)} → ${n(after.kpis.totalDataReturnedGb)} Gb`,
          `science data lost on board: ${n(before.kpis.totalDataLostGb)} → ${n(after.kpis.totalDataLostGb)} Gb`,
          `days with negative power margin: ${before.kpis.daysPowerNegative} → ${after.kpis.daysPowerNegative}`,
          `days with instruments forced off by an empty battery: ${before.kpis.daysInstrumentsOff} → ${after.kpis.daysInstrumentsOff}`,
          `days the control logic acted: ${before.kpis.daysControlActive} → ${after.kpis.daysControlActive}`,
          ...after.returnedByInstrument.map((r) => { const b = before.returnedByInstrument.find((x) => x.instrumentId === r.instrumentId); return `${r.name}: returned ${n(b?.returnedGb ?? 0)} → ${n(r.returnedGb)} Gb, lost on board ${n(b?.lostGb ?? 0)} → ${n(r.lostGb)} Gb`; }),
          ...after.controlLog.slice(0, 4).map((e) => `day ${e.day}: ${e.note ? `${e.note} — ` : ""}${e.effect}`),
        );
        const acted = after.kpis.daysControlActive > 0 || after.controlLog.length > 0;
        tests.push({
          id: "systems.flight",
          description: "The control logic runs in the flight simulation",
          status: acted ? "pass" : "warn",
          detail: acted
            ? `Flown for ${after.days} days: it acted on ${after.kpis.daysControlActive} day(s); data returned ${n(before.kpis.totalDataReturnedGb)} → ${n(after.kpis.totalDataReturnedGb)} Gb, negative-power days ${before.kpis.daysPowerNegative} → ${after.kpis.daysPowerNegative}`
            : `Flown for ${after.days} days: its conditions never held, so it changed nothing on this flight`,
        });
      } catch (err) {
        tests.push({ id: "systems.flight", description: "The control logic runs in the flight simulation", status: "fail", detail: `The flight simulation failed with this change: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    const significance = significanceOf(configDiff, regressions);
    const explanation = [
      `${configDiff.length} configuration value(s) change relative to mission version ${head.version}.`,
      recalc ? `${recalc.recalculated.length} derived result(s) are recalculated (${recalc.recalculated.join(", ") || "none"}); ${recalc.reused.length} are unaffected.` : "The change could not be evaluated.",
      ...consequences
        .filter((c) => typeof c.delta === "number")
        .slice(0, 12)
        .map((c) => `${c.node} · ${c.metric}: ${Number(c.before).toPrecision(5)} → ${Number(c.after).toPrecision(5)}`),
      ...flightLines,
      tests.some((t) => t.status === "fail") ? "One or more automated tests fail; the proposal cannot be approved as it stands." : "All blocking automated tests pass.",
    ];
    return {
      baseVersion: head.version,
      preview: { configDiff, affectedComponents: affectedComponents(configDiff), recalculatedNodes: recalc?.recalculated ?? [], consequences, explanation },
      tests,
      significance,
      requiredRole: significance === "significant" ? "lead" : "engineer",
      evidence,
      candidate,
    };
  }

  async create(args: { requestId: string; user: User; draft: DraftWorkspace; plan: Plan }): Promise<Proposal> {
    const sourceEvidence = weakestVerification(args.plan.tasks.filter((t) => t.result).map((t) => t.result!.verification));
    const evaluated = await this.evaluate(args.draft, this.store.head(), sourceEvidence);
    const { candidate, ...fields } = evaluated;
    const proposal: Proposal = {
      id: newId("prop"),
      requestId: args.requestId,
      createdBy: args.user,
      createdAt: nowIso(),
      patches: [...args.draft.patches],
      status: "awaiting_approval",
      ...fields,
    };
    const entry: Entry = { proposal, draft: args.draft, sourceEvidence, candidate };
    this.entries.set(proposal.id, entry);
    this.persist(entry);
    return proposal;
  }

  /** Approve and publish. Throws with a reason when approval is not permitted. */
  async approve(id: string, approver: User, reason: string, options: { acceptEngineeringViolations?: boolean } = {}): Promise<{ proposal: Proposal; version: MissionVersion }> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Proposal "${id}" not found`);
    const { proposal, draft } = entry;
    if (proposal.status !== "awaiting_approval") throw new Error(`Proposal is ${proposal.status}; only proposals awaiting approval can be approved`);
    if (ROLE_RANK[approver.role] < ROLE_RANK[proposal.requiredRole]) {
      throw new Error(`A ${proposal.significance} change requires approval by role "${proposal.requiredRole}"; "${approver.id}" is "${approver.role}"`);
    }
    const head = this.store.head();
    if (head.version !== proposal.baseVersion || entry.candidate === null) {
      // The mission moved on since the preview (or the proposal was restored after a restart):
      // re-evaluate against the current head before deciding.
      const { candidate, ...fields } = await this.evaluate(draft, head, entry.sourceEvidence);
      Object.assign(proposal, fields);
      entry.candidate = candidate;
      if (ROLE_RANK[approver.role] < ROLE_RANK[proposal.requiredRole]) {
        throw new Error(`After rebasing onto version ${head.version} this is a ${proposal.significance} change and requires role "${proposal.requiredRole}"`);
      }
    }
    // Failing tests block approval. The one exception is a person's explicit decision to accept a change whose only
    // failures are engineering limits (too heavy, over budget, a link that no longer closes): the limit then stays
    // visible as a violated constraint and costs score until the design is fixed. Structural, integrity and script
    // failures can never be accepted.
    const failed = proposal.tests.filter((t) => t.status === "fail");
    const failing = options.acceptEngineeringViolations ? failed.filter((t) => !t.id.startsWith("engineering.")) : failed;
    if (failing.length || !entry.candidate) {
      throw new Error(`Cannot approve: ${failing.length} automated test(s) fail (${failing.map((t) => t.id).join(", ")})`);
    }
    mkdirSync(this.assetsDir, { recursive: true });
    for (const asset of draft.stagedAssets) copyFileSync(asset.stagedPath, path.join(this.assetsDir, asset.fileName));
    const { version } = this.store.publish(entry.candidate, { by: approver.id, note: reason || `Approved proposal ${proposal.id}`, proposalId: proposal.id });
    proposal.status = "published";
    proposal.publishedVersion = version.version;
    proposal.decision = { by: approver, at: nowIso(), action: "approved", reason };
    draft.discard();
    this.persist(entry);
    return { proposal, version };
  }

  reject(id: string, by: User, reason: string): Proposal {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Proposal "${id}" not found`);
    if (entry.proposal.status !== "awaiting_approval") throw new Error(`Proposal is already ${entry.proposal.status}`);
    if (ROLE_RANK[by.role] < ROLE_RANK.engineer) throw new Error(`Role "${by.role}" cannot reject proposals`);
    entry.proposal.status = "rejected";
    entry.proposal.decision = { by, at: nowIso(), action: "rejected", reason };
    entry.draft.discard();
    this.persist(entry);
    return entry.proposal;
  }
}
