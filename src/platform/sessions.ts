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
import { compactJson } from "../pipeline/requirements.js";
import { harnessPatches, portsOf, standardLinks } from "../systems/graph.js";
import { SIGNALS, TARGET_FORMS } from "../systems/controller.js";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyPatches, getPath, type PatchOp, pathsOverlap } from "../core/paths.js";
import { type Role, ROLE_PERMISSIONS, type User } from "../core/types.js";
import { flightEvents } from "../game/events.js";
import { type CatalogItem, type Difficulty, FULL_CATALOG, generateMission, getScenario, instantiateCatalogItem, type Objective, type Scenario , tierOf } from "../game/scenarios.js";
import { type Evaluation, evaluateMission , roleWatch, type RoleWatch } from "../game/scoring.js";
import { type MissionSimulation, simulateMission } from "../game/simulation.js";
import { type BriefService, kitFor, type MissionBrief, missionObjectives, type MissionWorld, type ProblemKit } from "../game/briefs.js";
import type { KnowledgeBase } from "../knowledge/knowledge.js";
import type { LlmService } from "../llm/llm.js";
import type { MemoryKind, ResearchMemory } from "../memory/memory.js";
import { parseGmatReport } from "../nasa/gmat.js";
import { propagateJ2 } from "../science/propagate.js";
import { assessConceptMaturity, type DisciplineId, DISCIPLINES, type MaturityAssessment } from "../nasa/lifecycle.js";
import { ProposalService } from "../pipeline/proposals.js";
import { RequestService } from "../pipeline/service.js";
import type { Proposal, RequestRecord } from "../pipeline/types.js";
import { executeDirect } from "../registry/direct.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import { type ConstraintCheck, type Derived, engineeringChecks, recalculate } from "../state/recalc.js";
import { type MissionConfig, parseMissionConfig } from "../state/schema.js";
import { MissionStore, type MissionVersion } from "../state/store.js";
import type { Account } from "./auth.js";
import type { AuditLog } from "./audit.js";

export const PHASES = ["concept", "trade", "design", "review", "submitted"] as const;
export type Phase = (typeof PHASES)[number];
/** Minimum concept maturity needed to enter each phase. */
const PHASE_GATE: Record<Phase, number> = { concept: 0, trade: 2, design: 3, review: 4, submitted: 0 };
/** The challenge is played solo or in teams of up to four. */
const MAX_MEMBERS = 4;
const LOCK_TTL_MS = 12_000;
/** Paths fixed by the scenario or reserved for validating capabilities; not editable live. */
const IMMUTABLE = ["meta.budgetMusd", "meta.massLimitKg", "meta.missionDurationDays", "meta.scheduleMonths", "meta.yearsInService", "centralBody", "groundStation", "scripts", "assets"];
/** A sandbox lets the crew move the programme limits too; only the destination and validated content stay fixed. */
const IMMUTABLE_SANDBOX = ["centralBody", "scripts", "assets"];
const MAX_SAVED_DESIGNS = 12;

/** The team's own definition of its mission: what it is for, what matters most, and what extra it commits to. */
export interface MissionCharter {
  statement: string;
  /** Id of the science objective the team names as primary (weighted ×1.5). */
  primary: string | null;
  /** Ids of the stretch goals the team commits to. */
  stretch: string[];
  by: string;
  at: string;
}

/** Headline numbers of one design, for side-by-side comparison. */
export interface DesignMetrics {
  score: number;
  failingChecks: number;
  totalMassKg: number | null;
  totalCostMusd: number | null;
  powerMarginW: number | null;
  depthOfDischarge: number | null;
  linkMarginDb: number | null;
  dataReturnGbPerDay: number | null;
  imagingResolutionM: number | null;
  developmentMonths: number | null;
  altitudeKm: number | null;
  inclinationDeg: number;
  launchVehicle: string | null;
  components: number;
}

/** A design a crew published for others to study, compare against and load. */
export interface SharedDesign {
  id: string;
  name: string;
  sessionId: string;
  sessionName: string;
  scenarioId: string;
  briefId: string | null;
  briefTitle: string | null;
  by: string;
  at: string;
  version: number;
  metrics: DesignMetrics;
  config: MissionConfig;
}

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
  /** Which crew member took which part of the problem (seat name → account id). */
  roleClaims?: Record<string, string>;
  /** Set when the team defines its mission; null until then. */
  charter?: MissionCharter | null;
  /** Named versions the team bookmarked to come back to or compare. */
  savedDesigns?: { id: string; name: string; version: number; at: string; by: string }[];
  submitted: { at: string; by: string; version: number; score: number; grade: string } | null;
}

export interface SessionMeta {
  id: string;
  name: string;
  /** The mission brief this session was started from, if any (shown to the crew as the problem statement). */
  brief?: { id: string; title: string; problem: string; whyItMatters: string; scienceQuestions: string[]; origin: "ai" | "built_in"; modelId?: string };
  /** The kit built with the problem: the controls that matter, the parts worth reaching for, a split of the work. */
  kit?: ProblemKit;
  /** This mission's own world: its spacecraft's name, the place it is about, its goals in its own words. */
  world?: MissionWorld;
  scenarioId: string;
  /** campaign: fixed programme limits, phase gates, ranked. sandbox: everything adjustable, unranked. */
  mode?: "campaign" | "sandbox";
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
  /** The brief the crew flew, so crews solving the same problem can be ranked against each other. */
  briefId?: string | null;
  briefTitle?: string | null;
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
  knowledge?: KnowledgeBase;
  briefs?: BriefService;
  audit: AuditLog;
  assetsDir: string;
  /** Root data directory, or null for in-memory sessions (tests). */
  dataDir: string | null;
  /** Scratch directory for draft staging when dataDir is null. */
  scratchDir: string;
  /** Is this the id of a mission that exists here? (Set by the session manager; used to cite only crews that can be looked up.) */
  knownSession?: (id: string) => boolean;
}

/** Something a crew before this one found out on the same kind of mission. Never anything from a private conversation. */
export interface Lesson { kind: string; text: string; mission: string; at: string }

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
    // A mission started from a brief that has since been given a world of its own takes it on.
    if (!meta.world && meta.brief?.id) { const w = deps.briefs?.get(meta.brief.id)?.world; if (w) meta.world = w; }
    // The mission's goals carry its own titles and its own thresholds (its place, the detail and data it needs);
    // what each one measures is the template's.
    this.scenario = meta.world ? { ...scenario, objectives: missionObjectives(scenario.id, scenario.objectives, meta.world) } : scenario;
    this.dir = deps.dataDir ? path.join(deps.dataDir, "sessions", meta.id) : null;
    this.store = new MissionStore(this.dir ? path.join(this.dir, "mission") : null);
    if (this.store.isEmpty) {
      if (initialConfig === undefined) throw new SessionError(`Session "${meta.id}" has no mission state`, 404);
      this.store.publish(initialConfig, { by: "system", note: `Mission generated from scenario "${scenario.title}" (seed ${meta.seed})` });
    }
    this.proposals = new ProposalService(this.store, deps.assetsDir, this.dir ? path.join(this.dir, "proposals") : null);
    this.proposals.flightTest = (config) => simulateMission(config, { events: flightEvents(this.meta.seed, this.meta.difficulty, config) });
    this.requests = new RequestService({
      registry: deps.registry,
      store: this.store,
      memory: deps.memory,
      llm: deps.llm,
      missionContext: () => this.aiContext(),
      playerContext: (userId) => this.playerContext(userId),
      ...(deps.knowledge ? { retrieve: (query: string) => deps.knowledge!.context(query, { k: 4, maxChars: 3000 }) } : {}),
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

  private lessonCache: { at: number; lessons: Lesson[]; records: number } | null = null;
  /**
   * What the platform has learned so far that bears on this mission: the outcomes, flights, trade studies and failed
   * ideas of other crews on the same kind of mission, newest first. This is the growing record every player's AI
   * reads before it answers (see aiContext): the more missions are played, the more it has to go on. It is retrieval
   * from the research archive, not training of the language model. Private conversations are never included.
   */
  knowledge(limit = 6): { lessons: Lesson[]; records: number } {
    const now = Date.now();
    if (this.lessonCache && now - this.lessonCache.at < 20000) return { lessons: this.lessonCache.lessons.slice(0, limit), records: this.lessonCache.records };
    const mine = `session:${this.meta.id}`;
    const kinds = new Set(["mission_outcome", "simulation_result", "failure", "trade_study", "hypothesis"]);
    const all = this.deps.memory.all();
    const perKind = new Map<string, number>();
    const lessons: Lesson[] = [];
    for (let i = all.length - 1; i >= 0 && lessons.length < 12; i--) {
      const r = all[i]!;
      if (r.visibility || !kinds.has(r.kind) || !r.tags.includes(this.meta.scenarioId) || r.tags.includes(mine)) continue;
      const sid = r.tags.find((t) => t.startsWith("session:"))?.slice(8);
      if (!sid || (this.deps.knownSession && !this.deps.knownSession(sid))) continue;
      if ((perKind.get(r.kind) ?? 0) >= 3) continue; // a spread of kinds, not twelve flights
      perKind.set(r.kind, (perKind.get(r.kind) ?? 0) + 1);
      lessons.push({ kind: r.kind, text: r.summary.replace(/\s+/g, " ").slice(0, 260), mission: r.missionName, at: r.createdAt });
    }
    this.lessonCache = { at: now, lessons, records: all.filter((r) => !r.visibility).length };
    return { lessons: lessons.slice(0, limit), records: this.lessonCache.records };
  }

  /** What a crew member's AI needs to know about the mission: the problem, where the goals stand, and the parts on offer. */
  private aiContext(): string {
    const evaluation = this.evaluate();
    const checks = this.checks();
    return compactJson({
      problem: this.meta.brief ? { title: this.meta.brief.title, statement: this.meta.brief.problem } : { title: this.scenario.title, statement: this.scenario.briefing.join(" ") },
      crux: this.meta.kit?.crux,
      // What other crews found out on this kind of mission (from the research archive; their designs differ from this one).
      learnedByEarlierCrews: this.knowledge(5).lessons.map((l) => `[${l.kind.replace(/_/g, " ")} · ${l.mission}] ${l.text}`),
      crewDefinition: this.meta.game.charter?.statement ?? null,
      goals: evaluation.objectives.map((o) => ({ goal: o.title, needs: o.description, status: o.feedback, credit: Math.round(o.achieved * 100) / 100 })),
      limitsBroken: checks.filter((c) => c.status === "fail").map((c) => `${c.description}: ${c.detail}`),
      // Parts already on board are in the configuration; the catalogue lists what could still be added.
      catalogue: this.catalog.map((i) => ({ id: i.id, label: i.label, what: i.description, component: i.component })),
      flight: this.flightPicture(),
    });
  }

  /** Who this player is in the crew, for their own AI: the seat they took and its task, and who holds the others. */
  private playerContext(userId: string): string {
    const me = this.member(userId);
    const claims = this.meta.game.roleClaims ?? {};
    const seats = this.meta.kit?.roles ?? [];
    const mine = seats.find((r) => claims[r.seat] === userId);
    const others = seats.filter((r) => r !== mine).map((r) => `${r.seat} (${r.task}) — ${claims[r.seat] ? `held by ${this.member(claims[r.seat]!)?.displayName ?? "a crewmate"}` : "nobody has taken it"}`);
    return [
      `Name: ${me?.displayName ?? "a crew member"}. Crew of ${this.meta.members.length} (up to 4).`,
      mine ? `Their seat: ${mine.seat} — ${mine.task}` : "They have not taken a seat yet (seats are offered under Crew).",
      others.length ? `Other seats: ${others.join("; ")}` : "",
    ].filter(Boolean).join("\n");
  }

  /**
   * What the design does over its whole flight, for the AI: flown now, on this mission's own in-flight events, so
   * questions about when something happens are answered from the simulation rather than guessed. Deterministic.
   */
  private flightPicture(): Record<string, unknown> {
    try {
      const config = this.store.head().config;
      const sim = simulateMission(config, { events: flightEvents(this.meta.seed, this.meta.difficulty, config) });
      const date = (day: number): string => new Date(Date.parse(config.missionTime) + day * 86400000).toISOString().slice(0, 10);
      // Stretches of the flight with negative power margin, from the sampled timeline.
      const spans: { fromDay: number; toDay: number; from: string; to: string; worstMarginW: number }[] = [];
      let open: (typeof spans)[number] | null = null;
      for (const t of sim.timeline) {
        if (t.marginW < 0) {
          if (!open) { open = { fromDay: t.day, toDay: t.day, from: date(t.day), to: date(t.day), worstMarginW: t.marginW }; spans.push(open); }
          open.toDay = t.day; open.to = date(t.day); open.worstMarginW = Math.round(Math.min(open.worstMarginW, t.marginW) * 10) / 10;
        } else open = null;
      }
      const sample = sim.timeline.filter((_, i) => i % Math.max(1, Math.round(sim.timeline.length / 7)) === 0).map((t) => ({ day: t.day, date: t.date.slice(0, 10), powerMarginW: Math.round(t.marginW * 10) / 10, shadowShareOfOrbit: Math.round(t.eclipseFraction * 100) / 100, linkMarginDb: t.linkMarginDb === null ? null : Math.round(t.linkMarginDb * 10) / 10, storedGb: Math.round(t.storageGb * 10) / 10 }));
      return {
        note: `Simulated flight of the current design: one step per day for ${sim.days} days from the mission date, with this mission's in-flight events. Sampled every ${Math.max(1, Math.ceil(sim.days / 180))} day(s).`,
        totals: sim.kpis,
        powerShortPeriods: spans.length ? spans : "none: the power margin stays positive for the whole flight",
        throughTheYear: sample,
        inFlightEvents: sim.flightEvents.map((e) => ({ day: e.day, date: date(e.day), what: e.title, cost: e.outcome })),
        byInstrument: sim.returnedByInstrument.map((r) => ({ instrument: r.name, returnedGb: Math.round(r.returnedGb * 10) / 10, lostOnBoardGb: Math.round(r.lostGb * 10) / 10 })),
        controlLogic: sim.controlLog.slice(0, 6),
      };
    } catch (err) {
      return { note: `The flight could not be simulated for this design: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  get sandbox(): boolean {
    return this.meta.mode === "sandbox";
  }

  /** Parts this crew can add: the scenario's catalogue, or every part in a sandbox. */
  get catalog(): CatalogItem[] {
    const all = (this.sandbox ? FULL_CATALOG : this.scenario.catalog).map((i) => ({ ...i, tier: tierOf(i.id) }));
    if (this.sandbox || this.meta.difficulty !== "cadet") return all;
    // Cadet level: the simple parts, and the parts this mission's kit lays out (so the problem can always be solved).
    const kit = new Set((this.meta.kit?.toolbox ?? []).map((t) => t.itemId));
    return all.filter((i) => i.tier === "simple" || kit.has(i.id));
  }

  /** The scored objectives: the scenario's, shaped by the team's mission definition. */
  get objectives(): Objective[] {
    const charter = this.meta.game.charter;
    if (!charter) return this.scenario.objectives;
    return [
      ...this.scenario.objectives.map((o) => (o.id === charter.primary ? { ...o, weight: o.weight * 1.5, primary: true } : o)),
      ...this.scenario.stretchGoals.filter((o) => charter.stretch.includes(o.id)).map((o) => ({ ...o, stretch: true })),
    ];
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
      const fixed = (this.sandbox ? IMMUTABLE_SANDBOX : IMMUTABLE).find((i) => pathsOverlap(p.path, i));
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
  submitRequest(accountId: string, text: string, trainingConsent = false, topic?: string): RequestRecord {
    const m = this.require(accountId, "viewer");
    if (this.meta.game.submitted) throw new SessionError("This mission has been submitted.", 409);
    this.deps.audit.record({ actor: accountId, action: "request.submit", sessionId: this.meta.id, detail: { text: text.slice(0, 500) } });
    return this.requests.submit({ text, user: { id: accountId, role: m.role }, trainingConsent, ...(topic ? { topic } : {}) });
  }

  /** Add a catalogue component through the pipeline (asset generation, staging, tests, policy). */
  addFromCatalog(accountId: string, itemId: string, target: "spacecraft" | "rover" = "spacecraft"): RequestRecord {
    const m = this.require(accountId, "engineer");
    if (this.meta.game.submitted) throw new SessionError("This mission has been submitted.", 409);
    const { item, component } = instantiateCatalogItem(this.catalog, itemId, this.store.head().config);
    this.deps.audit.record({ actor: accountId, action: "catalog.add", sessionId: this.meta.id, detail: { itemId, componentId: component.id, target } });
    return this.requests.submitOperations({
      summary: `Add ${item.label} to the ${target}`,
      user: { id: accountId, role: m.role },
      operations: [{ category: "component_creation", intent: "add_component", description: `Add ${item.label} to the ${target}`, params: { target, component, withAsset: true }, assumptions: [] }],
    });
  }

  /** Run a part's standard lines to the bus: power, and data and control where it has those ports. */
  connectPart(accountId: string, componentId: string): RequestRecord {
    const m = this.require(accountId, "engineer");
    if (this.meta.game.submitted) throw new SessionError("This mission has been submitted.", 409);
    const config = this.store.head().config;
    const part = config.spacecraft.components.find((c) => c.id === componentId);
    if (!part) throw new SessionError(`There is no part "${componentId}" on the spacecraft.`, 404);
    const patches = harnessPatches(config, componentId);
    if (!patches.length) throw new SessionError(`${part.name} already has every line it needs, at a rating that carries it.`, 409);
    const lines = standardLinks(config, componentId);
    const resized = patches.filter((p) => p.op === "set").length;
    this.deps.audit.record({ actor: accountId, action: "systems.connect", sessionId: this.meta.id, detail: { componentId, lines: lines.map((l) => l.id), resized } });
    return this.requests.submitOperations({
      summary: lines.length ? `Connect ${part.name}: ${lines.map((l) => l.kind).join(", ")} line(s)` : `Fit larger line(s) to ${part.name}`,
      user: { id: accountId, role: m.role },
      operations: [{ category: "engineering_design", intent: "set_config", description: lines.length ? `Connect ${part.name} with its standard ${lines.map((l) => l.kind).join(", ")} line(s)` : `Fit ${resized} larger line(s) to ${part.name}`, params: { patches, rationale: "Standard harness sized 25% above what the part needs" }, assumptions: ["Lines sized 25% above the part's peak power and data rate, at this spacecraft's typical line run"] }],
    });
  }

  /**
   * Draw a trajectory over the scene. "gmat" parses a GMAT ReportFile the team produced
   * outside the platform; "j2" propagates the current orbit numerically so nodal precession
   * becomes visible. Either way the overlay is a proposed design change like any other.
   */
  addTrajectory(accountId: string, input: { kind: "gmat"; report: string; name?: string } | { kind: "j2"; days: number }): RequestRecord {
    const m = this.require(accountId, "engineer");
    if (this.meta.game.submitted) throw new SessionError("This mission has been submitted.", 409);
    const config = this.store.head().config;
    if (config.scene.trajectories.length >= 6) throw new SessionError("A mission can hold six trajectory overlays; remove one first.", 409);
    const decimate = <T,>(items: T[], max: number): T[] => {
      const every = Math.max(1, Math.ceil(items.length / max));
      return items.filter((_, i) => i % every === 0 || i === items.length - 1);
    };
    let overlay: Record<string, unknown>;
    if (input.kind === "gmat") {
      if (typeof input.report !== "string" || input.report.length < 10 || input.report.length > 20_000_000) throw new SessionError("Paste the text of a GMAT ReportFile (ElapsedSecs, X, Y, Z, VX, VY, VZ).", 400);
      let parsed;
      try {
        parsed = parseGmatReport(input.report);
      } catch (err) {
        throw new SessionError(err instanceof Error ? err.message : String(err), 400);
      }
      if (parsed.samples.length < 2) throw new SessionError("The report has fewer than two samples.", 400);
      const samples = decimate(parsed.samples, 1200);
      overlay = {
        name: (input.name ?? "GMAT trajectory").slice(0, 80), source: "gmat_report", verification: "external_data",
        durationS: parsed.samples[parsed.samples.length - 1]!.elapsedS - parsed.samples[0]!.elapsedS,
        pointsKm: samples.map((s) => s.positionKm),
        note: `${parsed.samples.length} samples from a GMAT ReportFile; frame and force model are those of the script that produced it`,
      };
    } else {
      const days = Math.min(60, Math.max(0.05, Number(input.days) || 1));
      const result = propagateJ2({ body: config.centralBody, ...config.orbit }, days * 86400, 20, 1200);
      overlay = {
        name: `J2 propagation, ${days} d`, source: "j2_propagation", verification: "deterministic_calculation", durationS: days * 86400,
        pointsKm: result.samples.map((s) => s.positionKm),
        note: `RK4 with J2 only; node drift ${result.raanDriftDeg.toFixed(3)} deg over ${days} d. No higher harmonics, third bodies or drag`,
      };
    }
    const id = `traj_${randomBytes(4).toString("hex")}`;
    this.deps.audit.record({ actor: accountId, action: "trajectory.add", sessionId: this.meta.id, detail: { id, kind: input.kind } });
    return this.requests.submitOperations({
      summary: `Overlay ${overlay.name as string}`,
      user: { id: accountId, role: m.role },
      operations: [{ category: "simulation", intent: "set_config", description: `Overlay ${overlay.name as string} on the scene`, params: { patches: [{ op: "append", path: "scene.trajectories", value: { id, ...overlay } }], rationale: overlay.note }, assumptions: [] }],
    });
  }

  removeTrajectory(accountId: string, trajectoryId: string): RequestRecord {
    const m = this.require(accountId, "engineer");
    if (!this.store.head().config.scene.trajectories.some((t) => t.id === trajectoryId)) throw new SessionError("Trajectory not found", 404);
    return this.requests.submitOperations({
      summary: "Remove a trajectory overlay",
      user: { id: accountId, role: m.role },
      operations: [{ category: "simulation", intent: "set_config", description: "Remove a trajectory overlay", params: { patches: [{ op: "remove", path: `scene.trajectories.${trajectoryId}` }], rationale: "No longer needed" }, assumptions: [] }],
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

  /**
   * Approve or reject a proposed change. `acceptViolations` is a person's explicit decision to publish a change
   * whose only failing tests are engineering limits (too heavy, over budget…): the limit then shows as a violated
   * constraint to be fixed. It never applies to structural, integrity or script failures.
   */
  async decide(accountId: string, proposalId: string, action: "approve" | "reject", reason: string, acceptViolations = false): Promise<{ proposal: Proposal; version?: MissionVersion }> {
    const member = this.require(accountId, "engineer");
    if (!this.proposals.get(proposalId)) throw new SessionError("Proposal not found.", 404);
    const user: User = { id: accountId, role: member.role };
    try {
      if (action === "approve") {
        const { proposal, version } = await this.proposals.approve(proposalId, user, reason, { acceptEngineeringViolations: acceptViolations });
        this.requests.recordDecision(proposal, version);
        this.noteContribution(proposal.createdBy.id);
        const accepted = proposal.tests.filter((t) => t.status === "fail").map((t) => t.id);
        this.deps.audit.record({ actor: accountId, action: "proposal.approve", sessionId: this.meta.id, detail: { proposalId, version: version.version, reason, ...(accepted.length ? { acceptedViolations: accepted } : {}) } });
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

  /** Take one of the roles the problem came with (or let go of it). One role per crew member. */
  claimRole(accountId: string, seat: string | null): Record<string, string> {
    this.require(accountId, "viewer");
    const g = this.meta.game;
    const claims = { ...(g.roleClaims ?? {}) };
    for (const [s, who] of Object.entries(claims)) if (who === accountId) delete claims[s];
    if (seat !== null) {
      if (!this.meta.kit?.roles.some((r) => r.seat === seat)) throw new SessionError("That role is not part of this problem.", 400);
      if (claims[seat] && claims[seat] !== accountId) throw new SessionError(`${this.member(claims[seat]!)?.displayName ?? "A crewmate"} already took that role.`, 409);
      claims[seat] = accountId;
    }
    g.roleClaims = claims;
    this.save();
    this.emit("game", g);
    return claims;
  }

  // ---------- mission definition ----------
  /**
   * The team defines its mission: a statement of what it is for, the science objective it
   * treats as primary, and any stretch goals it commits to. Engineers may set it during the
   * concept phase; afterwards it is the lead's call, and it is frozen on submission.
   */
  defineMission(accountId: string, input: { statement?: unknown; primary?: unknown; stretch?: unknown }): MissionCharter {
    const member = this.require(accountId, "engineer");
    const g = this.meta.game;
    if (g.submitted) throw new SessionError("This mission has been submitted.", 409);
    if (g.phase !== "concept" && member.role !== "lead" && !this.sandbox) throw new SessionError("After the concept phase only the lead can change the mission definition.", 403);
    const statement = String(input.statement ?? "").trim().replace(/\s+/g, " ").slice(0, 400);
    if (statement.length < 20) throw new SessionError("Describe the mission's purpose in at least 20 characters.", 400);
    const science = this.scenario.objectives.filter((o) => o.category === "science");
    const primary = typeof input.primary === "string" && science.some((o) => o.id === input.primary) ? input.primary : null;
    if (!primary) throw new SessionError("Choose the science objective your mission treats as primary.", 400);
    const stretch = [...new Set(Array.isArray(input.stretch) ? input.stretch.filter((s): s is string => typeof s === "string") : [])].filter((s) => this.scenario.stretchGoals.some((o) => o.id === s));
    if (stretch.length > 2) throw new SessionError("A mission can commit to at most two stretch goals.", 400);
    const charter: MissionCharter = { statement, primary, stretch, by: accountId, at: new Date().toISOString() };
    g.charter = charter;
    this.save();
    this.noteContribution(accountId);
    this.remember("hypothesis", `Mission defined by ${member.displayName}: ${statement} Primary objective: ${science.find((o) => o.id === primary)!.title}.${stretch.length ? ` Stretch goals: ${this.scenario.stretchGoals.filter((o) => stretch.includes(o.id)).map((o) => o.title).join(", ")}.` : ""}`, { charter }, "unverified", accountId);
    this.deps.audit.record({ actor: accountId, action: "game.define", sessionId: this.meta.id, detail: { primary, stretch } });
    this.emit("game", g);
    return charter;
  }

  // ---------- designs: save, compare, load ----------
  private metricsOf(config: MissionConfig, derived: Derived): DesignMetrics {
    const v = <T>(node: string): T | null => (derived[node]?.value as T | null | undefined) ?? null;
    const checks = engineeringChecks(config, derived);
    const evaluation = evaluateMission({ objectives: this.objectives, config, derived, checks, simulation: null, maturity: this.maturity(), roles: this.meta.game.roleClaims ?? {}, contributors: this.meta.game.contributors.length, unverifiedContent: config.scripts.filter((s) => s.origin.kind === "model_generated").length });
    const launch = v<{ name: string | null }>("launch.vehicle");
    return {
      score: evaluation.score,
      failingChecks: checks.filter((c) => c.status === "fail").length,
      totalMassKg: v<{ totalMassKg: number }>("mass.budget")?.totalMassKg ?? null,
      totalCostMusd: v<{ totalCostMusd: number }>("cost.budget")?.totalCostMusd ?? null,
      powerMarginW: v<{ marginW: number }>("power.budget")?.marginW ?? null,
      depthOfDischarge: v<{ depthOfDischarge: number | null }>("power.budget")?.depthOfDischarge ?? null,
      linkMarginDb: v<{ worstMarginDb: number | null }>("comms.link")?.worstMarginDb ?? null,
      dataReturnGbPerDay: v<{ totalReturnedGbPerDay: number }>("science.return")?.totalReturnedGbPerDay ?? null,
      imagingResolutionM: v<{ bestImagingResolutionM: number | null }>("science.return")?.bestImagingResolutionM ?? null,
      developmentMonths: v<{ developmentMonths: number }>("schedule.budget")?.developmentMonths ?? null,
      altitudeKm: v<{ periapsisAltitudeKm: number }>("orbit.elements")?.periapsisAltitudeKm ?? null,
      inclinationDeg: config.orbit.inclinationDeg,
      launchVehicle: launch?.name ?? null,
      components: config.spacecraft.components.length,
    };
  }

  /** Bookmark the current version under a name. */
  saveDesign(accountId: string, name: string): NonNullable<GameState["savedDesigns"]>[number] {
    this.require(accountId, "engineer");
    const g = this.meta.game;
    const saved = (g.savedDesigns ??= []);
    if (saved.length >= MAX_SAVED_DESIGNS) throw new SessionError(`A mission keeps ${MAX_SAVED_DESIGNS} saved designs; older ones stay in the version history.`, 409);
    const head = this.store.head();
    const entry = { id: `sd_${randomBytes(4).toString("hex")}`, name: name.trim().slice(0, 50) || `Design v${head.version}`, version: head.version, at: new Date().toISOString(), by: accountId };
    saved.push(entry);
    this.save();
    this.deps.audit.record({ actor: accountId, action: "design.save", sessionId: this.meta.id, detail: { version: head.version, name: entry.name } });
    this.emit("game", g);
    return entry;
  }

  /** A design to publish: the named version's configuration with its headline numbers. */
  exportDesign(accountId: string, name: string, version?: number): Omit<SharedDesign, "id"> {
    const member = this.require(accountId, "engineer");
    const v = version === undefined ? this.store.head() : this.store.get(version);
    if (!v) throw new SessionError("That version does not exist.", 404);
    return {
      name: name.trim().slice(0, 50) || `${this.meta.name} v${v.version}`,
      sessionId: this.meta.id, sessionName: this.meta.name, scenarioId: this.meta.scenarioId,
      briefId: this.meta.brief?.id ?? null, briefTitle: this.meta.brief?.title ?? null,
      by: member.displayName, at: new Date().toISOString(), version: v.version,
      metrics: this.metricsOf(v.config, v.derived),
      // Scripts and generated assets stay with the mission that validated them.
      config: { ...v.config, scripts: [], assets: [], scene: { nodes: [], trajectories: [] } },
    };
  }

  /**
   * Compare two designs side by side. A reference is "head", a version number of this
   * mission, or a shared design from the gallery.
   */
  compare(accountId: string, a: { label: string; config: MissionConfig; derived?: Derived; metrics?: DesignMetrics }, b: { label: string; config: MissionConfig; derived?: Derived; metrics?: DesignMetrics }): { a: { label: string; metrics: DesignMetrics }; b: { label: string; metrics: DesignMetrics }; rows: { key: string; label: string; unit: string; a: number | string | null; b: number | string | null; better: "a" | "b" | null }[]; parts: { onlyA: string[]; onlyB: string[] } } {
    this.require(accountId, "viewer");
    const ma = a.metrics ?? this.metricsOf(a.config, a.derived!);
    const mb = b.metrics ?? this.metricsOf(b.config, b.derived!);
    const spec: [keyof DesignMetrics, string, string, "high" | "low" | null][] = [
      ["score", "Score (before the flight simulation)", "pts", "high"], ["failingChecks", "Hard limits broken", "", "low"], ["totalMassKg", "Spacecraft mass", "kg", "low"], ["totalCostMusd", "Total cost", "$M", "low"],
      ["powerMarginW", "Power margin", "W", "high"], ["depthOfDischarge", "Battery depth of discharge", "", "low"], ["linkMarginDb", "Link margin", "dB", "high"], ["dataReturnGbPerDay", "Science data returned", "Gb/day", "high"],
      ["imagingResolutionM", "Imaging resolution", "m", "low"], ["developmentMonths", "Development time", "months", "low"], ["altitudeKm", "Orbit altitude", "km", null], ["inclinationDeg", "Inclination", "°", null], ["launchVehicle", "Launch vehicle", "", null], ["components", "Parts on the spacecraft", "", null],
    ];
    const rows = spec.map(([key, label, unit, sense]) => {
      const va = ma[key];
      const vb = mb[key];
      const better = sense && typeof va === "number" && typeof vb === "number" && Math.abs(va - vb) > 1e-9 ? ((sense === "high" ? va > vb : va < vb) ? ("a" as const) : ("b" as const)) : null;
      return { key, label, unit, a: va, b: vb, better };
    });
    const names = (c: MissionConfig): string[] => c.spacecraft.components.map((x) => x.name);
    const count = (list: string[]): Map<string, number> => list.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map<string, number>());
    const [ca, cb] = [count(names(a.config)), count(names(b.config))];
    const only = (x: Map<string, number>, y: Map<string, number>): string[] => [...x].flatMap(([n, k]) => (k > (y.get(n) ?? 0) ? [k - (y.get(n) ?? 0) > 1 ? `${n} ×${k - (y.get(n) ?? 0)}` : n] : []));
    return { a: { label: a.label, metrics: ma }, b: { label: b.label, metrics: mb }, rows, parts: { onlyA: only(ca, cb), onlyB: only(cb, ca) } };
  }

  /** Load a shared design's orbit, parts and launch vehicle into this mission as one edit. */
  importDesign(accountId: string, design: SharedDesign): EditResult {
    if (design.scenarioId !== this.meta.scenarioId && !this.sandbox) return { ok: false, reason: "invalid", detail: "That design was built for a different mission template." };
    const head = this.store.head();
    const parts = new Set(design.config.spacecraft.components.map((c) => c.id));
    const patches: PatchOp[] = [
      { op: "set", path: "orbit.semiMajorAxisKm", value: design.config.orbit.semiMajorAxisKm },
      { op: "set", path: "orbit.eccentricity", value: design.config.orbit.eccentricity },
      { op: "set", path: "orbit.inclinationDeg", value: design.config.orbit.inclinationDeg },
      { op: "set", path: "spacecraft.components", value: design.config.spacecraft.components },
      // Scene nodes that showed parts this design does not have would dangle.
      { op: "set", path: "scene.nodes", value: head.config.scene.nodes.filter((n) => !n.componentId || parts.has(n.componentId) || head.config.rover?.components.some((c) => c.id === n.componentId)) },
      ...(design.config.meta.launchVehicleId ? [{ op: "set" as const, path: "meta.launchVehicleId", value: design.config.meta.launchVehicleId }] : []),
    ];
    return this.applyEdit(accountId, { baseVersion: head.version, patches, summary: `Loaded shared design "${design.name}" by ${design.by}`, force: true });
  }

  /**
   * The engineering models at another moment: the same design, with the clock moved. Nothing is published.
   * This is what lets the crew turn time and see power, eclipse and link respond.
   */
  at(accountId: string, iso: string): Record<string, unknown> {
    this.require(accountId, "viewer");
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) throw new SessionError("time must be an ISO date-time.", 400);
    const head = this.store.head();
    const time = new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    const { derived } = recalculate({ ...head.config, missionTime: time }, { config: head.config, derived: head.derived });
    const v = (node: string): Record<string, unknown> => (derived[node]?.value as Record<string, unknown> | null | undefined) ?? {};
    const [power, eclipse, link, sun, data] = [v("power.budget"), v("orbit.eclipse"), v("comms.link"), v("ephemeris.sun"), v("data.budget")];
    return {
      time, version: head.version,
      powerMarginW: power.marginW ?? null, generationW: power.orbitAverageGenerationW ?? null, depthOfDischarge: power.depthOfDischarge ?? null,
      betaDeg: eclipse.betaDeg ?? null, eclipseFraction: eclipse.eclipseFraction ?? null,
      linkMarginDb: link.worstMarginDb ?? null, earthRangeKm: sun.earthToBodyDistanceKm ?? null, sunDistanceAu: sun.distanceAu ?? null,
      returnedGbPerDay: data.returnedGbPerDay ?? null,
      failing: engineeringChecks({ ...head.config, missionTime: time }, derived).filter((c) => c.status === "fail").map((c) => c.id),
    };
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
      // Objectives count as stated once the team has defined its mission.
      objectivesDefined: g.charter || this.sandbox ? this.objectives.length : 0,
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
      roles: g.roleClaims ?? {},
      unverifiedContent: head.config.scripts.filter((s) => s.origin.kind === "model_generated").length,
    });
  }

  /** Every role this problem came with: what it answers for, whether that holds now, and who has taken it. */
  roleWatches(): RoleWatch[] {
    const head = this.store.head();
    const evaluation = this.evaluate();
    const claims = this.meta.game.roleClaims ?? {};
    return (this.meta.kit?.roles ?? []).map((r) => ({ seat: r.seat, holder: claims[r.seat] ?? null, ...roleWatch(r.seat, head.config, head.derived, this.checks(), evaluation.objectives) }));
  }

  runSimulation(accountId: string): MissionSimulation {
    this.require(accountId, "engineer");
    const head = this.store.head();
    const sim = simulateMission(head.config, { events: flightEvents(this.meta.seed, this.meta.difficulty, head.config) });
    const g = this.meta.game;
    g.simulation = sim;
    g.simulationVersion = head.version;
    g.simulationsRun++;
    this.save();
    this.remember("simulation_result", `Mission simulation of v${head.version} over ${sim.days} days: ${sim.kpis.totalDataReturnedGb.toFixed(0)} Gb returned (${(sim.kpis.scienceDeliveredFraction * 100).toFixed(0)}% of planned), ${sim.kpis.daysPowerNegative} day(s) of negative power margin, in-flight events: ${sim.flightEvents.map((e) => e.title).join(", ") || "none"}`, { kpis: sim.kpis, events: sim.events, flightEvents: sim.flightEvents, assumptions: sim.assumptions }, "deterministic_calculation", accountId);
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
    if (!g.charter && !this.sandbox) throw new SessionError("Define your mission first: state its purpose and choose its primary objective.", 409);
    if (maturity.level < PHASE_GATE[next] && !this.sandbox) {
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
    if (this.sandbox) throw new SessionError("Sandbox missions are for experimenting and are not ranked. Start a mission from the mission board to submit a score.", 409);
    if (!this.meta.game.charter) throw new SessionError("Define your mission before submitting it: state its purpose and choose its primary objective.", 409);
    const head = this.store.head();
    const launch = head.derived["launch.vehicle"]?.value as { selectedId: string | null; options: unknown[] } | null | undefined;
    if (launch && launch.options.length > 0 && !launch.selectedId) throw new SessionError("Choose a launch vehicle before submitting: the mission has no way to space yet.", 409);
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
      briefId: this.meta.brief?.id ?? null,
      briefTitle: this.meta.brief?.title ?? null,
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
      roles: this.roleWatches(),
      knowledge: this.knowledge(6),
      maturity: this.maturity(),
      evaluation: this.evaluate(),
      locks: this.activeLocks(),
      // What the wiring and control logic are made of: the ports of each kind of part, and what a controller can read and command.
      systemsGuide: { ports: Object.fromEntries((["bus", "solar_panel", "battery", "instrument", "antenna", "computer", "load", "adcs"] as const).map((t) => [t, portsOf(t)])), signals: SIGNALS, targets: TARGET_FORMS },
      scenario: { id: this.scenario.id, title: this.scenario.title, tagline: this.scenario.tagline, briefing: this.scenario.briefing, scienceQuestions: this.scenario.scienceQuestions, references: this.scenario.references, catalog: this.catalog, objectives: this.scenario.objectives.map((o) => ({ id: o.id, title: o.title, description: o.description, category: o.category, weight: o.weight, metric: o.metric })), stretchGoals: this.scenario.stretchGoals.map((o) => ({ id: o.id, title: o.title, description: o.description, weight: o.weight, metric: o.metric })), disciplines: DISCIPLINES.filter((d) => this.scenario.disciplines.includes(d.id)) },
      versions: this.store.list().slice(-40),
    };
  }
}

export class SessionManager {
  private sessions = new Map<string, MissionSession>();
  private submissions: Submission[] = [];
  private designs: SharedDesign[] = [];
  private readonly submissionsFile: string | null;
  private readonly designsFile: string | null;

  constructor(private readonly deps: SessionDeps) {
    deps.knownSession ??= (id) => this.sessions.has(id);
    this.submissionsFile = deps.dataDir ? path.join(deps.dataDir, "submissions.jsonl") : null;
    if (this.submissionsFile && existsSync(this.submissionsFile)) {
      this.submissions = readFileSync(this.submissionsFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Submission);
    }
    this.designsFile = deps.dataDir ? path.join(deps.dataDir, "designs.jsonl") : null;
    if (this.designsFile && existsSync(this.designsFile)) {
      this.designs = readFileSync(this.designsFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as SharedDesign);
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

  create(account: Account, input: { scenarioId: string; name?: string; difficulty?: Difficulty; seed?: number; visibility?: "public" | "invite"; policy?: "open" | "review"; discipline?: DisciplineId; briefId?: string; mode?: "campaign" | "sandbox" }): MissionSession {
    // A mission brief names its own engineering template and seed.
    const brief: MissionBrief | undefined = input.briefId ? this.deps.briefs?.get(input.briefId) : undefined;
    if (input.briefId && !brief) throw new SessionError("That mission brief no longer exists.", 404);
    const scenario = getScenario(brief?.template ?? input.scenarioId);
    if (!scenario) throw new SessionError(`Unknown scenario "${input.scenarioId}".`, 404);
    const difficulty: Difficulty = input.difficulty && ["cadet", "engineer", "chief"].includes(input.difficulty) ? input.difficulty : "engineer";
    const seed = brief ? brief.seed : Number.isInteger(input.seed) ? (input.seed as number) >>> 0 : randomBytes(4).readUInt32BE(0);
    const mission = generateMission(scenario.id, seed, difficulty, brief?.kit?.challenge);
    if (brief) {
      // The brief's programme constraints scale the template's budget, mass limit and duration.
      const m = mission.config.meta;
      if (m.budgetMusd) m.budgetMusd = Math.round(m.budgetMusd * brief.constraints.budgetFactor * 100) / 100;
      if (m.massLimitKg) m.massLimitKg = Math.round(m.massLimitKg * brief.constraints.massFactor * 10) / 10;
      if (m.missionDurationDays) m.missionDurationDays = Math.max(30, Math.round(m.missionDurationDays * brief.constraints.durationFactor));
      m.name = brief.title;
      if (brief.world?.craftName) mission.config.spacecraft.name = brief.world.craftName;
    }
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id: `ms_${randomBytes(6).toString("hex")}`,
      name: (input.name ?? "").trim().slice(0, 60) || `${brief?.title ?? scenario.title} — ${account.displayName}`.slice(0, 60),
      ...(brief ? { brief: { id: brief.id, title: brief.title, problem: brief.problem, whyItMatters: brief.whyItMatters, scienceQuestions: brief.scienceQuestions, origin: brief.origin, ...(brief.modelId ? { modelId: brief.modelId } : {}) } } : {}),
      kit: brief?.kit ?? kitFor(scenario.id),
      ...(brief?.world ? { world: brief.world } : {}),
      scenarioId: scenario.id,
      mode: input.mode === "sandbox" ? "sandbox" : "campaign",
      seed,
      difficulty,
      visibility: input.visibility === "invite" ? "invite" : "public",
      inviteCode: randomBytes(4).toString("hex").slice(0, 6).toUpperCase(),
      policy: input.policy === "review" ? "review" : "open",
      createdBy: account.id,
      createdAt: now,
      complication: mission.complication,
      members: [{ accountId: account.id, displayName: account.displayName, role: "lead", discipline: input.discipline && scenario.disciplines.includes(input.discipline) ? input.discipline : "systems", joinedAt: now }],
      game: { phase: "concept", phaseHistory: [{ phase: "concept", at: now, by: account.id }], tradeStudies: [], simulationsRun: 0, simulation: null, simulationVersion: null, risks: 0, reviews: 0, contributors: [], charter: null, savedDesigns: [], submitted: null },
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
  list(account: Account): { id: string; name: string; mode: string; briefTitle: string | null; scenarioId: string; scenarioTitle: string; difficulty: Difficulty; phase: Phase; members: number; maxMembers: number; isMember: boolean; visibility: string; version: number; submitted: boolean; createdAt: string }[] {
    return [...this.sessions.values()]
      .filter((s) => s.meta.visibility === "public" || s.member(account.id) || account.role === "admin")
      .map((s) => ({ id: s.meta.id, name: s.meta.name, mode: s.meta.mode ?? "campaign", briefTitle: s.meta.brief?.title ?? null, scenarioId: s.meta.scenarioId, scenarioTitle: s.scenario.title, difficulty: s.meta.difficulty, phase: s.meta.game.phase, members: s.meta.members.length, maxMembers: MAX_MEMBERS, isMember: Boolean(s.member(account.id)), visibility: s.meta.visibility, version: s.store.head().version, submitted: Boolean(s.meta.game.submitted), createdAt: s.meta.createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  recordSubmission(submission: Submission): void {
    this.submissions.push(submission);
    if (this.submissionsFile) appendFileSync(this.submissionsFile, `${JSON.stringify(submission)}\n`);
  }

  leaderboard(filter: { scenarioId?: string; difficulty?: string; briefId?: string; limit?: number } = {}): (Submission & { rank: number })[] {
    return this.submissions
      .filter((s) => (!filter.scenarioId || s.scenarioId === filter.scenarioId) && (!filter.difficulty || s.difficulty === filter.difficulty) && (!filter.briefId || s.briefId === filter.briefId))
      .sort((a, b) => b.score - a.score || a.submittedAt.localeCompare(b.submittedAt))
      .slice(0, filter.limit ?? 50)
      .map((s, i) => ({ ...s, rank: i + 1 }));
  }

  /** How many crews have flown each brief, and the score to beat. */
  briefStats(): Record<string, { crews: number; best: number }> {
    const stats: Record<string, { crews: number; best: number }> = {};
    for (const s of this.submissions) {
      if (!s.briefId) continue;
      const entry = (stats[s.briefId] ??= { crews: 0, best: 0 });
      entry.crews++;
      entry.best = Math.max(entry.best, s.score);
    }
    return stats;
  }

  /** Where a submission stands among crews that flew the same problem. */
  standing(submission: Submission): { rank: number; of: number; scope: "brief" | "scenario"; title: string } {
    const peers = submission.briefId ? this.leaderboard({ briefId: submission.briefId, limit: 1000 }) : this.leaderboard({ scenarioId: submission.scenarioId, limit: 1000 });
    return { rank: peers.find((p) => p.id === submission.id)?.rank ?? peers.length, of: peers.length, scope: submission.briefId ? "brief" : "scenario", title: submission.briefTitle ?? submission.scenarioTitle };
  }

  // ---------- shared designs ----------
  shareDesign(design: Omit<SharedDesign, "id">): SharedDesign {
    const shared: SharedDesign = { id: `dsn_${randomBytes(5).toString("hex")}`, ...design };
    this.designs.push(shared);
    if (this.designsFile) appendFileSync(this.designsFile, `${JSON.stringify(shared)}\n`);
    return shared;
  }

  design(id: string): SharedDesign | undefined {
    return this.designs.find((d) => d.id === id);
  }

  /** Shared designs, newest first, without their full configuration. */
  listDesigns(filter: { scenarioId?: string; briefId?: string } = {}): Omit<SharedDesign, "config">[] {
    return this.designs
      .filter((d) => (!filter.scenarioId || d.scenarioId === filter.scenarioId) && (!filter.briefId || d.briefId === filter.briefId))
      .slice(-60)
      .reverse()
      .map(({ config: _c, ...d }) => d);
  }

  /** Permissions a role grants, for clients that want to show what a member may do. */
  static permissions(role: Role): string[] {
    return ROLE_PERMISSIONS[role];
  }
}
