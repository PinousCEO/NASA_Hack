/**
 * Mission sessions: one collaborative mission "room" per team. A session owns its
 * versioned mission state, proposals and requests, and layers on top of them:
 *
 *  - membership with server-side roles (lead / engineer / viewer) and discipline seats
 *  - live parameter edits with optimistic concurrency, field-level conflict detection
 *    and short-lived edit locks
 *  - the game: trade studies, mission simulation, concept-maturity assessment, phase
 *    gates, evaluation, submission and the leaderboard
 *
 * Every state change publishes a new mission version (configuration + recalculated
 * results); clients never receive visual-only updates.
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyPatches, getPath, type PatchOp, pathsOverlap } from "../core/paths.js";
import { type Role, ROLE_PERMISSIONS, type User } from "../core/types.js";
import { type Difficulty, generateMission, getScenario, instantiateCatalogItem, type Objective, type Scenario } from "../game/scenarios.js";
import { type Evaluation, evaluateMission } from "../game/scoring.js";
import { type MissionSimulation, simulateMission } from "../game/simulation.js";
import type { LlmService } from "../llm/llm.js";
import type { MemoryKind, ResearchMemory } from "../memory/memory.js";
import { assessConceptMaturity, type DisciplineId, DISCIPLINES, type MaturityAssessment } from "../nasa/lifecycle.js";
import { ProposalService } from "../pipeline/proposals.js";
import { RequestService } from "../pipeline/service.js";
import type { Proposal, RequestRecord } from "../pipeline/types.js";
import { executeDirect } from "../registry/direct.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import { type ConstraintCheck, engineeringChecks } from "../state/recalc.js";
import { parseMissionConfig } from "../state/schema.js";
import { MissionStore, type MissionVersion } from "../state/store.js";
import type { Account } from "./auth.js";
import type { AuditLog } from "./audit.js";

export const PHASES = ["concept", "trade", "design", "review", "submitted"] as const;
export type Phase = (typeof PHASES)[number];
/** Minimum concept maturity needed to enter each phase. */
const PHASE_GATE: Record<Phase, number> = { concept: 0, trade: 2, design: 3, review: 4, submitted: 0 };
const MAX_MEMBERS = 8;
const LOCK_TTL_MS = 12_000;
/** Paths fixed by the scenario or reserved for validating capabilities; not editable live. */
const IMMUTABLE = ["meta.budgetMusd", "meta.massLimitKg", "meta.missionDurationDays", "meta.yearsInService", "centralBody", "groundStation", "scripts", "assets"];

export interface Member {
  accountId: string;
  displayName: string;
  role: Role;
  discipline: DisciplineId | null;
  joinedAt: string;
}

export interface GameState {
  phase: Phase;
  phaseHistory: { phase: Phase; at: string; by: string }[];
  tradeStudies: { id: string; path: string; at: string; by: string }[];
  simulationsRun: number;
  simulation: MissionSimulation | null;
  simulationVersion: number | null;
  risks: number;
  reviews: number;
  contributors: string[];
  submitted: { at: string; by: string; version: number; score: number; grade: string } | null;
}

export interface SessionMeta {
  id: string;
  name: string;
  scenarioId: string;
  seed: number;
  difficulty: Difficulty;
  visibility: "public" | "invite";
  inviteCode: string;
  /** open: validated deterministic changes publish immediately; review: the lead approves significant changes. */
  policy: "open" | "review";
  createdBy: string;
  createdAt: string;
  complication: { id: string; title: string; description: string };
  members: Member[];
  game: GameState;
}

export interface Submission {
  id: string;
  sessionId: string;
  sessionName: string;
  scenarioId: string;
  scenarioTitle: string;
  difficulty: Difficulty;
  seed: number;
  score: number;
  grade: string;
  cml: number;
  categories: Evaluation["categories"];
  team: { displayName: string; discipline: string | null; role: Role }[];
  missionVersion: number;
  configHash: string;
  submittedAt: string;
}

export type EditResult =
  | { ok: true; version: MissionVersion }
  | { ok: false; reason: "conflict" | "locked" | "invalid" | "forbidden" | "frozen"; detail: string; conflict?: { paths: string[]; current: Record<string, unknown>; changedBy: string[] } };

export class SessionError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export interface SessionDeps {
  registry: CapabilityRegistry;
  memory: ResearchMemory;
  llm: LlmService;
  audit: AuditLog;
  assetsDir: string;
  /** Root data directory, or null for in-memory sessions (tests). */
  dataDir: string | null;
  /** Scratch directory for draft staging when dataDir is null. */
  scratchDir: string;
}

export interface SessionEvents {
  mission: [MissionVersion, { by: string; kind: "edit" | "proposal" | "rollback"; summary: string }];
  game: [GameState];
  members: [Member[]];
  request: [RequestRecord];
  proposal: [Proposal];
  locks: [Record<string, string>];
}

export class MissionSession extends EventEmitter<SessionEvents> {
  readonly store: MissionStore;
  readonly proposals: ProposalService;
  readonly requests: RequestService;
  readonly scenario: Scenario;
  readonly objectives: Objective[];
  private locks = new Map<string, { accountId: string; expiresAt: number }>();
  private readonly dir: string | null;

  constructor(
    readonly meta: SessionMeta,
    private readonly deps: SessionDeps,
    initialConfig?: unknown,
  ) {
    super();
    const scenario = getScenario(meta.scenarioId);
    if (!scenario) throw new SessionError(`Unknown scenario "${meta.scenarioId}"`, 404);
    this.scenario = scenario;
    this.objectives = scenario.objectives;
    this.dir = deps.dataDir ? path.join(deps.dataDir, "sessions", meta.id) : null;
    this.store = new MissionStore(this.dir ? path.join(this.dir, "mission") : null);
    if (this.store.isEmpty) {
      if (initialConfig === undefined) throw new SessionError(`Session "${meta.id}" has no mission state`, 404);
      this.store.publish(initialConfig, { by: "system", note: `Mission generated from scenario "${scenario.title}" (seed ${meta.seed})` });
    }
    this.proposals = new ProposalService(this.store, deps.assetsDir, this.dir ? path.join(this.dir, "proposals") : null);
    this.requests = new RequestService({
      registry: deps.registry,
      store: this.store,
      memory: deps.memory,
      llm: deps.llm,
      proposals: this.proposals,
      dataDir: this.dir,
      stagingDir: this.dir ? path.join(this.dir, "staging") : path.join(deps.scratchDir, meta.id),
    });
    this.requests.on("updated", (record) => this.emit("request", record));
    this.requests.on("proposal", (proposal) => {
      this.emit("proposal", proposal);
      void this.applyPolicy(proposal);
    });
    this.save();
  }

  // ---------- persistence ----------
  save(): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(path.join(this.dir, "session.json"), JSON.stringify(this.meta, null, 2));
  }

  // ---------- membership and authorization ----------
  member(accountId: string): Member | undefined {
    return this.meta.members.find((m) => m.accountId === accountId);
  }

  /** Pipeline identity for a member; undefined when the account is not in this session. */
  userFor(accountId: string): User | undefined {
    const m = this.member(accountId);
    return m ? { id: accountId, role: m.role } : undefined;
  }

  private require(accountId: string, minimum: Role): Member {
    const m = this.member(accountId);
    if (!m) throw new SessionError("You are not a member of this mission.", 403);
    const rank: Record<Role, number> = { viewer: 0, engineer: 1, lead: 2 };
    if (rank[m.role] < rank[minimum]) throw new SessionError(`This action requires the "${minimum}" role; you are "${m.role}".`, 403);
    return m;
  }

  join(account: Account, inviteCode?: string, discipline?: DisciplineId | null): Member {
    const existing = this.member(account.id);
    if (existing) return existing;
    if (this.meta.visibility === "invite" && inviteCode?.trim().toUpperCase() !== this.meta.inviteCode && account.role !== "admin") {
      throw new SessionError("This mission needs a valid invite code.", 403);
    }
    if (this.meta.members.length >= MAX_MEMBERS) throw new SessionError(`This mission is full (${MAX_MEMBERS} participants).`, 409);
    const taken = new Set(this.meta.members.map((m) => m.discipline));
    const seat = discipline && this.scenario.disciplines.includes(discipline) ? discipline : (this.scenario.disciplines.find((d) => !taken.has(d)) ?? null);
    const member: Member = { accountId: account.id, displayName: account.displayName, role: "engineer", discipline: seat, joinedAt: new Date().toISOString() };
    this.meta.members.push(member);
    this.save();
    this.deps.audit.record({ actor: account.id, action: "session.join", sessionId: this.meta.id, detail: { discipline: seat } });
    this.emit("members", this.meta.members);
    return member;
  }

  updateMember(actorId: string, targetId: string, change: { role?: Role; discipline?: DisciplineId | null }): Member {
    const actor = this.member(actorId);
    const target = this.member(targetId);
    if (!actor || !target) throw new SessionError("Member not found.", 404);
    if (change.role !== undefined) {
      this.require(actorId, "lead");
      if (target.role === "lead" && change.role !== "lead" && this.meta.members.filter((m) => m.role === "lead").length === 1) throw new SessionError("A mission must keep at least one lead.", 409);
      target.role = change.role;
    }
    if (change.discipline !== undefined) {
      if (actorId !== targetId) this.require(actorId, "lead");
      if (change.discipline !== null && !this.scenario.disciplines.includes(change.discipline)) throw new SessionError("That discipline is not part of this mission.", 400);
      target.discipline = change.discipline;
    }
    this.save();
    this.deps.audit.record({ actor: actorId, action: "session.member.update", sessionId: this.meta.id, detail: { targetId, ...change } });
    this.emit("members", this.meta.members);
    return target;
  }

  // ---------- locks ----------
  activeLocks(): Record<string, string> {
    const now = Date.now();
    for (const [p, l] of this.locks) if (l.expiresAt <= now) this.locks.delete(p);
    return Object.fromEntries([...this.locks].map(([p, l]) => [p, l.accountId]));
  }

  /** Take or refresh a short edit lock on a path (e.g. while grabbing an object in XR). */
  lock(accountId: string, lockPath: string, held: boolean): boolean {
    this.require(accountId, "engineer");
    const locks = this.activeLocks();
    const blocking = Object.entries(locks).find(([p, owner]) => owner !== accountId && pathsOverlap(p, lockPath));
    if (held && blocking) return false;
    if (held) this.locks.set(lockPath, { accountId, expiresAt: Date.now() + LOCK_TTL_MS });
    else if (locks[lockPath] === accountId) this.locks.delete(lockPath);
    this.emit("locks", this.activeLocks());
    return true;
  }

  releaseLocks(accountId: string): void {
    let changed = false;
    for (const [p, l] of this.locks) {
      if (l.accountId === accountId) {
        this.locks.delete(p);
        changed = true;
      }
    }
    if (changed) this.emit("locks", this.activeLocks());
  }

  // ---------- live edits ----------
  /**
   * Apply a parameter edit made against `baseVersion`. Edits to fields nobody else has
   * changed since are merged onto the head; an edit to a field that was changed in the
   * meantime is rejected with the current values so the client can show the conflict.
   */
  applyEdit(accountId: string, edit: { baseVersion: number; patches: PatchOp[]; summary?: string; force?: boolean }): EditResult {
    const member = this.member(accountId);
    if (!member || member.role === "viewer") return { ok: false, reason: "forbidden", detail: "Only engineers and leads can change the mission." };
    if (this.meta.game.submitted) return { ok: false, reason: "frozen", detail: "This mission has been submitted and can no longer be changed." };
    if (!Array.isArray(edit.patches) || edit.patches.length === 0 || edit.patches.length > 50) return { ok: false, reason: "invalid", detail: "An edit needs between 1 and 50 patches." };
    for (const p of edit.patches) {
      if (!p || typeof p.path !== "string" || !["set", "append", "remove"].includes(p.op)) return { ok: false, reason: "invalid", detail: "Malformed patch." };
      const fixed = IMMUTABLE.find((i) => pathsOverlap(p.path, i));
      if (fixed) return { ok: false, reason: "forbidden", detail: `"${fixed}" is set by the mission scenario or managed by validated capabilities and cannot be edited directly.` };
    }
    const locks = this.activeLocks();
    const blocked = edit.patches.map((p) => Object.entries(locks).find(([lp, owner]) => owner !== accountId && pathsOverlap(lp, p.path))).find(Boolean);
    if (blocked) {
      const owner = this.member(blocked[1])?.displayName ?? "another participant";
      return { ok: false, reason: "locked", detail: `${owner} is editing "${blocked[0]}" right now.` };
    }
    const head = this.store.head();
    if (edit.baseVersion > head.version || edit.baseVersion < 1) return { ok: false, reason: "invalid", detail: `Unknown base version ${edit.baseVersion}.` };
    if (edit.baseVersion < head.version && !edit.force) {
      const later = this.store.list().filter((v) => v.version > edit.baseVersion);
      const conflicting = new Set<string>();
      const changedBy = new Set<string>();
      for (const v of later) {
        for (const changed of this.store.get(v.version)?.changedPaths ?? []) {
          for (const p of edit.patches) {
            if (p.op !== "append" && pathsOverlap(changed, p.path)) {
              conflicting.add(p.path);
              changedBy.add(this.member(v.publishedBy)?.displayName ?? v.publishedBy);
            }
          }
        }
      }
      if (conflicting.size) {
        return {
          ok: false,
          reason: "conflict",
          detail: `${[...changedBy].join(", ")} changed ${[...conflicting].join(", ")} after the version you were editing.`,
          conflict: { paths: [...conflicting], current: Object.fromEntries([...conflicting].map((p) => [p, getPath(head.config, p) ?? null])), changedBy: [...changedBy] },
        };
      }
    }
    let candidate: unknown;
    try {
      candidate = applyPatches(head.config as unknown, edit.patches);
    } catch (err) {
      return { ok: false, reason: "invalid", detail: err instanceof Error ? err.message : String(err) };
    }
    const parsed = parseMissionConfig(candidate);
    if (!parsed.ok) return { ok: false, reason: "invalid", detail: parsed.issues.join("; ") };
    const summary = (edit.summary ?? edit.patches.map((p) => `${p.op} ${p.path}`).join(", ")).slice(0, 300);
    const { version } = this.store.publish(parsed.config, { by: accountId, note: summary });
    this.noteContribution(accountId);
    this.remember("user_contribution", `${member.displayName}${member.discipline ? ` (${member.discipline})` : ""}: ${summary}`, { patches: edit.patches, version: version.version, recalculated: version.recalculated }, "deterministic_calculation", accountId);
    this.deps.audit.record({ actor: accountId, action: "mission.edit", sessionId: this.meta.id, detail: { version: version.version, patches: edit.patches.map((p) => ({ op: p.op, path: p.path })) } });
    this.emit("mission", version, { by: accountId, kind: "edit", summary });
    return { ok: true, version };
  }

  private noteContribution(accountId: string): void {
    if (!this.meta.game.contributors.includes(accountId)) {
      this.meta.game.contributors.push(accountId);
      this.save();
      this.emit("game", this.meta.game);
    }
  }

  private remember(kind: MemoryKind, summary: string, data: unknown, verification: "deterministic_calculation" | "unverified" | "model_judgment" | "heuristic", actor: string, modelId?: string): void {
    const head = this.store.head();
    this.deps.memory.add({
      kind,
      missionName: head.config.meta.name,
      missionVersion: head.version,
      summary,
      data,
      tags: [kind, this.meta.scenarioId, `session:${this.meta.id}`],
      provenance: { source: `session:${this.meta.id}:${actor}`, ...(modelId ? { modelId } : {}) },
      assumptions: [],
      verification,
    });
  }

  // ---------- AI runtime builder entry points ----------
  submitRequest(accountId: string, text: string, trainingConsent = false): RequestRecord {
    const m = this.require(accountId, "viewer");
    if (this.meta.game.submitted) throw new SessionError("This mission has been submitted.", 409);
    this.deps.audit.record({ actor: accountId, action: "request.submit", sessionId: this.meta.id, detail: { text: text.slice(0, 500) } });
    return this.requests.submit({ text, user: { id: accountId, role: m.role }, trainingConsent });
  }

  /** Add a catalogue component through the pipeline (asset generation, staging, tests, policy). */
  addFromCatalog(accountId: string, itemId: string, target: "spacecraft" | "rover" = "spacecraft"): RequestRecord {
    const m = this.require(accountId, "engineer");
    if (this.meta.game.submitted) throw new SessionError("This mission has been submitted.", 409);
    const { item, component } = instantiateCatalogItem(this.meta.scenarioId, itemId, this.store.head().config);
    this.deps.audit.record({ actor: accountId, action: "catalog.add", sessionId: this.meta.id, detail: { itemId, componentId: component.id, target } });
    return this.requests.submitOperations({
      summary: `Add ${item.label} to the ${target}`,
      user: { id: accountId, role: m.role },
      operations: [{ category: "component_creation", intent: "add_component", description: `Add ${item.label} to the ${target}`, params: { target, component, withAsset: true }, assumptions: [] }],
    });
  }

  /** Session change policy: publish validated, deterministic changes at once under "open"; otherwise wait for a lead. */
  private async applyPolicy(proposal: Proposal): Promise<void> {
    if (this.meta.policy !== "open") return;
    const touchesScripts = proposal.preview.configDiff.some((d) => d.path.startsWith("scripts"));
    const trusted = !["model_judgment", "unverified"].includes(proposal.evidence);
    if (touchesScripts || !trusted || proposal.tests.some((t) => t.status === "fail")) return;
    try {
      const reason = 'Auto-approved under the "open design" policy: all automated tests pass and the change rests on deterministic evidence';
      const { proposal: updated, version } = await this.proposals.approve(proposal.id, { id: "policy:open", role: "lead" }, reason);
      this.requests.recordDecision(updated, version);
      this.noteContribution(proposal.createdBy.id);
      this.deps.audit.record({ actor: "policy:open", action: "proposal.approve", sessionId: this.meta.id, detail: { proposalId: proposal.id, version: version.version, requestedBy: proposal.createdBy.id } });
      this.emit("proposal", updated);
      this.emit("mission", version, { by: proposal.createdBy.id, kind: "proposal", summary: this.requests.get(proposal.requestId)?.requirement?.summary ?? "Approved change" });
    } catch {
      /* stays pending for a human decision */
    }
  }

  async decide(accountId: string, proposalId: string, action: "approve" | "reject", reason: string): Promise<{ proposal: Proposal; version?: MissionVersion }> {
    const member = this.require(accountId, "engineer");
    if (!this.proposals.get(proposalId)) throw new SessionError("Proposal not found.", 404);
    const user: User = { id: accountId, role: member.role };
    try {
      if (action === "approve") {
        const { proposal, version } = await this.proposals.approve(proposalId, user, reason);
        this.requests.recordDecision(proposal, version);
        this.noteContribution(proposal.createdBy.id);
        this.deps.audit.record({ actor: accountId, action: "proposal.approve", sessionId: this.meta.id, detail: { proposalId, version: version.version, reason } });
        this.emit("proposal", proposal);
        this.emit("mission", version, { by: accountId, kind: "proposal", summary: this.requests.get(proposal.requestId)?.requirement?.summary ?? "Approved change" });
        return { proposal, version };
      }
      const proposal = this.proposals.reject(proposalId, user, reason);
      this.requests.recordDecision(proposal);
      this.deps.audit.record({ actor: accountId, action: "proposal.reject", sessionId: this.meta.id, detail: { proposalId, reason } });
      this.emit("proposal", proposal);
      return { proposal };
    } catch (err) {
      this.deps.audit.record({ actor: accountId, action: `proposal.${action}`, sessionId: this.meta.id, outcome: "denied", detail: { proposalId, error: err instanceof Error ? err.message : String(err) } });
      throw new SessionError(err instanceof Error ? err.message : String(err), 409);
    }
  }

  rollback(accountId: string, version: number, reason: string): MissionVersion {
    this.require(accountId, "lead");
    if (this.meta.game.submitted) throw new SessionError("This mission has been submitted.", 409);
    let result: MissionVersion;
    try {
      result = this.store.rollback(version, accountId, reason || "no reason given");
    } catch (err) {
      throw new SessionError(err instanceof Error ? err.message : String(err), 400);
    }
    this.remember("design_change", `Rolled back to v${version}: ${reason || "no reason given"}`, { rollbackOf: version }, "deterministic_calculation", accountId);
    this.deps.audit.record({ actor: accountId, action: "mission.rollback", sessionId: this.meta.id, detail: { to: version, newVersion: result.version, reason } });
    this.emit("mission", result, { by: accountId, kind: "rollback", summary: `Rolled back to v${version}` });
    return result;
  }

  // ---------- game ----------
  checks(): ConstraintCheck[] {
    const head = this.store.head();
    return engineeringChecks(head.config, head.derived);
  }

  maturity(): MaturityAssessment {
    const head = this.store.head();
    const g = this.meta.game;
    return assessConceptMaturity(head.config, head.derived, this.checks(), {
      objectivesDefined: this.objectives.length,
      tradeStudies: g.tradeStudies.length,
      tradeParameters: new Set(g.tradeStudies.map((t) => t.path)).size,
      simulationsRun: g.simulationVersion === head.version ? Math.max(1, g.simulationsRun) : 0,
      risksRecorded: g.risks,
      reviewsHeld: g.reviews,
    });
  }

  evaluate(): Evaluation {
    const head = this.store.head();
    const g = this.meta.game;
    return evaluateMission({
      objectives: this.objectives,
      config: head.config,
      derived: head.derived,
      checks: this.checks(),
      // A simulation of an older design says nothing about this one.
      simulation: g.simulationVersion === head.version ? g.simulation : null,
      maturity: this.maturity(),
      contributors: g.contributors.length,
      unverifiedContent: head.config.scripts.filter((s) => s.origin.kind === "model_generated").length,
    });
  }

  runSimulation(accountId: string): MissionSimulation {
    this.require(accountId, "engineer");
    const head = this.store.head();
    const sim = simulateMission(head.config);
    const g = this.meta.game;
    g.simulation = sim;
    g.simulationVersion = head.version;
    g.simulationsRun++;
    this.save();
    this.remember("simulation_result", `Mission simulation of v${head.version} over ${sim.days} days: ${sim.kpis.totalDataReturnedGb.toFixed(0)} Gb returned, ${sim.kpis.daysPowerNegative} day(s) of negative power margin`, { kpis: sim.kpis, events: sim.events, assumptions: sim.assumptions }, "deterministic_calculation", accountId);
    this.deps.audit.record({ actor: accountId, action: "game.simulate", sessionId: this.meta.id, detail: { version: head.version, kpis: sim.kpis } });
    this.emit("game", g);
    return sim;
  }

  async runTradeStudy(accountId: string, input: { path: string; values: (number | string | boolean)[]; metrics: { node: string; field: string }[] }): Promise<unknown> {
    const member = this.require(accountId, "engineer");
    const result = await executeDirect({ registry: this.deps.registry, store: this.store }, "analysis.trade_study", input, { id: accountId, role: member.role });
    const g = this.meta.game;
    g.tradeStudies.push({ id: randomBytes(4).toString("hex"), path: input.path, at: new Date().toISOString(), by: accountId });
    this.save();
    this.remember("trade_study", `Trade study on ${input.path} over ${input.values.length} values (${input.metrics.map((m) => `${m.node}.${m.field}`).join(", ")})`, result.output, "deterministic_calculation", accountId);
    this.deps.audit.record({ actor: accountId, action: "game.trade_study", sessionId: this.meta.id, detail: { path: input.path, values: input.values.length } });
    this.emit("game", g);
    return result.output;
  }

  /** Record a mission problem / risk, a hypothesis, or cited evidence in the research record. */
  recordNote(accountId: string, input: { kind: "mission_problem" | "hypothesis" | "scientific_evidence" | "improvement"; summary: string; detail?: string; mitigation?: string }): void {
    const member = this.require(accountId, "engineer");
    const summary = input.summary.trim().slice(0, 400);
    if (!summary) throw new SessionError("A summary is required.", 400);
    this.remember(input.kind, `${summary}${input.mitigation ? ` — mitigation: ${input.mitigation.slice(0, 300)}` : ""}`, { detail: input.detail ?? null, mitigation: input.mitigation ?? null, author: member.displayName, discipline: member.discipline }, "unverified", accountId);
    if (input.kind === "mission_problem" && input.mitigation?.trim()) {
      this.meta.game.risks++;
      this.save();
      this.emit("game", this.meta.game);
    }
    this.deps.audit.record({ actor: accountId, action: "research.note", sessionId: this.meta.id, detail: { kind: input.kind } });
  }

  /** Hold a concept review: records the evaluation, and a model critique when a model is configured. */
  async holdReview(accountId: string): Promise<{ evaluation: Evaluation; maturity: MaturityAssessment; aiReview: string | null }> {
    this.require(accountId, "lead");
    const evaluation = this.evaluate();
    this.meta.game.reviews++;
    this.save();
    const maturity = this.maturity();
    this.remember("validation_report", `Concept review of v${this.store.head().version}: score ${evaluation.score} (${evaluation.grade}), CML ${maturity.level}`, { evaluation, maturity }, "deterministic_calculation", accountId);
    let aiReview: string | null = null;
    if (this.deps.llm.status().available) {
      try {
        const { z } = await import("zod");
        const out = await this.deps.llm.structured({
          system: "You are a review-board member at a mission concept review. Critique the design from the evidence given: name the weakest margins, the risks the team has not addressed, and one trade worth re-opening. Be specific and brief. Do not restate the numbers back, and do not invent data that is not in the evidence.",
          schema: z.object({ critique: z.string() }),
          prompt: JSON.stringify({ scenario: this.scenario.title, objectives: evaluation.objectives.map((o) => ({ title: o.title, value: o.value, target: o.target, achieved: o.achieved })), checks: this.checks(), maturity: maturity.criteria, simulation: this.meta.game.simulation?.kpis ?? null }),
        });
        aiReview = out.critique;
        this.remember("ai_evaluation", `AI review-board critique of v${this.store.head().version}: ${aiReview.slice(0, 300)}`, { critique: aiReview }, "model_judgment", accountId, this.deps.llm.modelId);
      } catch {
        aiReview = null;
      }
    }
    this.deps.audit.record({ actor: accountId, action: "game.review", sessionId: this.meta.id, detail: { score: evaluation.score, cml: maturity.level, aiReview: aiReview !== null } });
    this.emit("game", this.meta.game);
    return { evaluation, maturity, aiReview };
  }

  advancePhase(accountId: string): GameState {
    this.require(accountId, "lead");
    const g = this.meta.game;
    const index = PHASES.indexOf(g.phase);
    const next = PHASES[index + 1];
    if (!next || next === "submitted") throw new SessionError("Submit the mission to finish it.", 409);
    const maturity = this.maturity();
    if (maturity.level < PHASE_GATE[next]) {
      throw new SessionError(`The ${next} phase needs concept maturity CML ${PHASE_GATE[next]}; the mission is at CML ${maturity.level}. Next: ${maturity.nextSteps.join("; ") || "meet the remaining criteria"}.`, 409);
    }
    g.phase = next;
    g.phaseHistory.push({ phase: next, at: new Date().toISOString(), by: accountId });
    this.save();
    this.deps.audit.record({ actor: accountId, action: "game.phase", sessionId: this.meta.id, detail: { phase: next, cml: maturity.level } });
    this.emit("game", g);
    return g;
  }

  submit(accountId: string): { submission: Submission; evaluation: Evaluation } {
    this.require(accountId, "lead");
    if (this.meta.game.submitted) throw new SessionError("This mission has already been submitted.", 409);
    const head = this.store.head();
    // Always score against a simulation of the design being submitted.
    if (this.meta.game.simulationVersion !== head.version) this.runSimulation(accountId);
    const evaluation = this.evaluate();
    const maturity = this.maturity();
    const g = this.meta.game;
    g.submitted = { at: new Date().toISOString(), by: accountId, version: head.version, score: evaluation.score, grade: evaluation.grade };
    g.phase = "submitted";
    g.phaseHistory.push({ phase: "submitted", at: g.submitted.at, by: accountId });
    this.save();
    const submission: Submission = {
      id: `sub_${randomBytes(6).toString("hex")}`,
      sessionId: this.meta.id,
      sessionName: this.meta.name,
      scenarioId: this.meta.scenarioId,
      scenarioTitle: this.scenario.title,
      difficulty: this.meta.difficulty,
      seed: this.meta.seed,
      score: evaluation.score,
      grade: evaluation.grade,
      cml: maturity.level,
      categories: evaluation.categories,
      team: this.meta.members.map((m) => ({ displayName: m.displayName, discipline: m.discipline, role: m.role })),
      missionVersion: head.version,
      configHash: createHash("sha256").update(JSON.stringify(head.config)).digest("hex"),
      submittedAt: g.submitted.at,
    };
    this.remember("mission_outcome", `Mission submitted: score ${evaluation.score} (${evaluation.grade}), CML ${maturity.level}, ${evaluation.objectives.filter((o) => o.achieved >= 1).length}/${evaluation.objectives.length} objectives met`, { submission, evaluation }, "deterministic_calculation", accountId);
    this.deps.audit.record({ actor: accountId, action: "game.submit", sessionId: this.meta.id, detail: { score: evaluation.score, version: head.version, configHash: submission.configHash } });
    this.emit("game", g);
    return { submission, evaluation };
  }

  /** Everything a client needs to render the mission, in one consistent snapshot. */
  snapshot(): Record<string, unknown> {
    const head = this.store.head();
    return {
      session: { ...this.meta, inviteCode: undefined },
      mission: head,
      checks: this.checks(),
      game: this.meta.game,
      maturity: this.maturity(),
      evaluation: this.evaluate(),
      locks: this.activeLocks(),
      scenario: { id: this.scenario.id, title: this.scenario.title, tagline: this.scenario.tagline, briefing: this.scenario.briefing, scienceQuestions: this.scenario.scienceQuestions, references: this.scenario.references, catalog: this.scenario.catalog, disciplines: DISCIPLINES.filter((d) => this.scenario.disciplines.includes(d.id)) },
      versions: this.store.list().slice(-40),
    };
  }
}

export class SessionManager {
  private sessions = new Map<string, MissionSession>();
  private submissions: Submission[] = [];
  private readonly submissionsFile: string | null;

  constructor(private readonly deps: SessionDeps) {
    this.submissionsFile = deps.dataDir ? path.join(deps.dataDir, "submissions.jsonl") : null;
    if (this.submissionsFile && existsSync(this.submissionsFile)) {
      this.submissions = readFileSync(this.submissionsFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Submission);
    }
    const root = deps.dataDir ? path.join(deps.dataDir, "sessions") : null;
    if (root && existsSync(root)) {
      for (const id of readdirSync(root)) {
        const file = path.join(root, id, "session.json");
        if (!existsSync(file)) continue;
        try {
          const session = new MissionSession(JSON.parse(readFileSync(file, "utf8")) as SessionMeta, deps);
          this.sessions.set(session.meta.id, session);
        } catch (err) {
          deps.audit.record({ actor: "system", action: "session.restore", sessionId: id, outcome: "error", detail: { error: err instanceof Error ? err.message : String(err) } });
        }
      }
    }
  }

  create(account: Account, input: { scenarioId: string; name?: string; difficulty?: Difficulty; seed?: number; visibility?: "public" | "invite"; policy?: "open" | "review"; discipline?: DisciplineId }): MissionSession {
    const scenario = getScenario(input.scenarioId);
    if (!scenario) throw new SessionError(`Unknown scenario "${input.scenarioId}".`, 404);
    const difficulty: Difficulty = input.difficulty && ["cadet", "engineer", "chief"].includes(input.difficulty) ? input.difficulty : "engineer";
    const seed = Number.isInteger(input.seed) ? (input.seed as number) >>> 0 : randomBytes(4).readUInt32BE(0);
    const mission = generateMission(scenario.id, seed, difficulty);
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: `ms_${randomBytes(6).toString("hex")}`,
      name: (input.name ?? "").trim().slice(0, 60) || `${scenario.title} — ${account.displayName}`,
      scenarioId: scenario.id,
      seed,
      difficulty,
      visibility: input.visibility === "invite" ? "invite" : "public",
      inviteCode: randomBytes(4).toString("hex").slice(0, 6).toUpperCase(),
      policy: input.policy === "review" ? "review" : "open",
      createdBy: account.id,
      createdAt: now,
      complication: mission.complication,
      members: [{ accountId: account.id, displayName: account.displayName, role: "lead", discipline: input.discipline && scenario.disciplines.includes(input.discipline) ? input.discipline : "systems", joinedAt: now }],
      game: { phase: "concept", phaseHistory: [{ phase: "concept", at: now, by: account.id }], tradeStudies: [], simulationsRun: 0, simulation: null, simulationVersion: null, risks: 0, reviews: 0, contributors: [], submitted: null },
    };
    const session = new MissionSession(meta, this.deps, mission.config);
    this.sessions.set(meta.id, session);
    this.deps.memory.add({ kind: "mission_problem", missionName: mission.config.meta.name, missionVersion: 1, summary: `Mission problem: ${scenario.title}. ${scenario.scienceQuestions.join(" ")} Complication: ${mission.complication.title}.`, data: { scenarioId: scenario.id, seed, difficulty, complication: mission.complication, objectives: scenario.objectives.map((o) => o.title) }, tags: ["mission_problem", scenario.id, `session:${meta.id}`], provenance: { source: `session:${meta.id}:system` }, assumptions: [], verification: "deterministic_calculation" });
    this.deps.audit.record({ actor: account.id, action: "session.create", sessionId: meta.id, detail: { scenarioId: scenario.id, seed, difficulty, policy: meta.policy } });
    return session;
  }

  get(id: string): MissionSession | undefined {
    return this.sessions.get(id);
  }

  /** Sessions visible to an account: its own, and public ones. */
  list(account: Account): { id: string; name: string; scenarioId: string; scenarioTitle: string; difficulty: Difficulty; phase: Phase; members: number; maxMembers: number; isMember: boolean; visibility: string; version: number; submitted: boolean; createdAt: string }[] {
    return [...this.sessions.values()]
      .filter((s) => s.meta.visibility === "public" || s.member(account.id) || account.role === "admin")
      .map((s) => ({ id: s.meta.id, name: s.meta.name, scenarioId: s.meta.scenarioId, scenarioTitle: s.scenario.title, difficulty: s.meta.difficulty, phase: s.meta.game.phase, members: s.meta.members.length, maxMembers: MAX_MEMBERS, isMember: Boolean(s.member(account.id)), visibility: s.meta.visibility, version: s.store.head().version, submitted: Boolean(s.meta.game.submitted), createdAt: s.meta.createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  recordSubmission(submission: Submission): void {
    this.submissions.push(submission);
    if (this.submissionsFile) appendFileSync(this.submissionsFile, `${JSON.stringify(submission)}\n`);
  }

  leaderboard(filter: { scenarioId?: string; difficulty?: string; limit?: number } = {}): (Submission & { rank: number })[] {
    return this.submissions
      .filter((s) => (!filter.scenarioId || s.scenarioId === filter.scenarioId) && (!filter.difficulty || s.difficulty === filter.difficulty))
      .sort((a, b) => b.score - a.score || a.submittedAt.localeCompare(b.submittedAt))
      .slice(0, filter.limit ?? 50)
      .map((s, i) => ({ ...s, rank: i + 1 }));
  }

  /** Permissions a role grants, for clients that want to show what a member may do. */
  static permissions(role: Role): string[] {
    return ROLE_PERMISSIONS[role];
  }
}
