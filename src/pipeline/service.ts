/**
 * Request orchestration: state inspection → requirement analysis → knowledge retrieval →
 * planning → feasibility → execution → preview/approval. Every stage appends to the
 * request's trace, which answers: which tools were selected and why, what went in, what
 * came out, which tests ran, and why the change was approved or rejected.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { newId, nowIso, type User } from "../core/types.js";
import type { LlmService } from "../llm/llm.js";
import type { MemoryKind, ResearchMemory } from "../memory/memory.js";
import { DraftWorkspace } from "../registry/capability.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import type { MissionStore, MissionVersion } from "../state/store.js";
import { PlanExecutor } from "./executor.js";
import { assessFeasibility } from "./feasibility.js";
import { Planner } from "./planner.js";
import type { ProposalService } from "./proposals.js";
import { RequirementAnalyzer } from "./requirements.js";
import type { Operation, Proposal, RequestRecord, RequestStatus, StructuredRequirement, TraceEvent } from "./types.js";

export interface RequestEvents {
  /** Fired whenever a request changes (status, plan progress, new trace events). */
  updated: [RequestRecord];
  proposal: [Proposal];
}

export interface RequestServiceDeps {
  registry: CapabilityRegistry;
  store: MissionStore;
  memory: ResearchMemory;
  llm: LlmService;
  proposals: ProposalService;
  /** Directory for draft staging areas and persisted request records; null keeps records in memory only. */
  dataDir: string | null;
  stagingDir: string;
}

const TERMINAL: RequestStatus[] = ["completed", "infeasible", "awaiting_clarification", "awaiting_approval", "published", "rejected", "failed", "cancelled"];

export class RequestService extends EventEmitter<RequestEvents> {
  private readonly requests = new Map<string, RequestRecord>();
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly structured = new Map<string, Operation[]>();
  private readonly analyzer: RequirementAnalyzer;
  private readonly planner: Planner;
  private readonly executor: PlanExecutor;

  constructor(private readonly deps: RequestServiceDeps) {
    super();
    this.analyzer = new RequirementAnalyzer(deps.llm);
    this.planner = new Planner(deps.registry, deps.llm);
    this.executor = new PlanExecutor(deps.registry);
    if (deps.dataDir) {
      const dir = path.join(deps.dataDir, "requests");
      if (existsSync(dir)) {
        for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
          const record = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as RequestRecord;
          if (!TERMINAL.includes(record.status)) {
            // The process stopped while this request was in flight; its draft was never published.
            record.status = "failed";
            record.error = "Interrupted by a server restart before completion";
          }
          this.requests.set(record.id, record);
        }
      }
    }
  }

  get(id: string): RequestRecord | undefined {
    return this.requests.get(id);
  }

  list(): RequestRecord[] {
    return [...this.requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Start processing a request. Returns immediately; use `wait` or the `updated` event to follow it. */
  submit(args: { text: string; user: User; trainingConsent?: boolean }): RequestRecord {
    const text = args.text.trim();
    if (!text) throw new Error("Request text is empty");
    const record: RequestRecord = {
      id: newId("rq"),
      text,
      user: args.user,
      trainingConsent: args.trainingConsent ?? false,
      status: "analyzing",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      similarPastWork: [],
      planIssues: [],
      trace: [],
    };
    this.requests.set(record.id, record);
    this.start(record);
    return record;
  }

  /**
   * Start a request from operations that are already structured (a catalogue pick, an XR
   * tool, an API client). Natural-language analysis is skipped; everything after it —
   * planning, feasibility, execution, preview, approval — is identical.
   */
  submitOperations(args: { summary: string; operations: Omit<Operation, "id">[]; user: User; trainingConsent?: boolean }): RequestRecord {
    if (args.operations.length === 0) throw new Error("At least one operation is required");
    const record: RequestRecord = {
      id: newId("rq"),
      text: args.summary,
      user: args.user,
      trainingConsent: args.trainingConsent ?? false,
      status: "analyzing",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      similarPastWork: [],
      planIssues: [],
      trace: [],
    };
    this.structured.set(record.id, args.operations.map((op, i) => ({ ...op, id: `op${i + 1}` })));
    this.requests.set(record.id, record);
    this.start(record);
    return record;
  }

  /** Answer the clarification questions of a request; analysis restarts with the added detail. */
  clarify(id: string, answer: string): RequestRecord {
    const record = this.requests.get(id);
    if (!record) throw new Error(`Request "${id}" not found`);
    if (record.status !== "awaiting_clarification") throw new Error(`Request is ${record.status}; it is not waiting for clarification`);
    record.text = `${record.text} (clarification: ${answer.trim()})`;
    this.trace(record, "analysis", "Clarification received; re-analysing", { answer });
    this.setStatus(record, "analyzing");
    this.start(record);
    return record;
  }

  cancel(id: string): RequestRecord {
    const record = this.requests.get(id);
    if (!record) throw new Error(`Request "${id}" not found`);
    const run = this.running.get(id);
    if (!run) throw new Error(`Request is ${record.status}; nothing is running to cancel`);
    run.controller.abort();
    return record;
  }

  async wait(id: string): Promise<RequestRecord> {
    await this.running.get(id)?.done;
    const record = this.requests.get(id);
    if (!record) throw new Error(`Request "${id}" not found`);
    return record;
  }

  /** Called by the API layer after a proposal decision so the request and memory reflect it. */
  recordDecision(proposal: Proposal, version?: MissionVersion): void {
    const record = this.requests.get(proposal.requestId);
    if (!record || !proposal.decision) return;
    const approved = proposal.decision.action === "approved";
    this.trace(record, "decision", `Proposal ${proposal.id} ${proposal.decision.action} by ${proposal.decision.by.id} (${proposal.decision.by.role})`, {
      reason: proposal.decision.reason || "(no reason given)",
      requiredRole: proposal.requiredRole,
      significance: proposal.significance,
      tests: proposal.tests.map((t) => ({ id: t.id, status: t.status })),
      evidence: proposal.evidence,
    });
    if (approved && version) {
      this.trace(record, "deployment", `Published mission version ${version.version}; broadcast to connected clients`, { version: version.version, recalculated: version.recalculated });
    }
    this.remember(record, approved ? "design_change" : "failure", approved ? `Approved and published as v${version?.version}: ${record.requirement?.summary ?? record.text}` : `Rejected: ${record.requirement?.summary ?? record.text} — ${proposal.decision.reason}`, {
      proposalId: proposal.id,
      patches: proposal.patches,
      consequences: proposal.preview.consequences,
      tests: proposal.tests,
      decision: proposal.decision,
    }, proposal.evidence);
    this.setStatus(record, approved ? "published" : "rejected");
  }

  private start(record: RequestRecord): void {
    const controller = new AbortController();
    const done = this.process(record, controller.signal)
      .catch((err: unknown) => {
        record.error = err instanceof Error ? err.message : String(err);
        this.trace(record, "execution", `Request failed: ${record.error}`);
        this.remember(record, "failure", `Request failed: ${record.text} — ${record.error}`, { error: record.error }, "unverified");
        this.setStatus(record, controller.signal.aborted ? "cancelled" : "failed");
      })
      .finally(() => {
        this.running.delete(record.id);
        this.persist(record);
      });
    this.running.set(record.id, { controller, done });
  }

  private trace(record: RequestRecord, stage: TraceEvent["stage"], message: string, data?: unknown): void {
    record.trace.push({ seq: record.trace.length + 1, at: nowIso(), stage, message, ...(data !== undefined ? { data } : {}) });
    record.updatedAt = nowIso();
    this.emit("updated", record);
  }

  private setStatus(record: RequestRecord, status: RequestStatus): void {
    record.status = status;
    record.updatedAt = nowIso();
    this.emit("updated", record);
    if (TERMINAL.includes(status)) this.persist(record);
  }

  private persist(record: RequestRecord): void {
    if (!this.deps.dataDir) return;
    const dir = path.join(this.deps.dataDir, "requests");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record, null, 2));
  }

  private remember(record: RequestRecord, kind: MemoryKind, summary: string, data: unknown, verification: Parameters<ResearchMemory["add"]>[0]["verification"], extra: { assumptions?: string[]; capabilityId?: string; capabilityVersion?: string; modelId?: string } = {}): void {
    const head = this.deps.store.head();
    this.deps.memory.add({
      kind,
      missionName: head.config.meta.name,
      missionVersion: head.version,
      requestId: record.id,
      summary,
      data,
      tags: [kind, ...(record.requirement?.operations.flatMap((o) => [o.category, o.intent]) ?? [])],
      provenance: {
        source: extra.capabilityId ? "capability" : "pipeline",
        ...(extra.capabilityId ? { capabilityId: extra.capabilityId } : {}),
        ...(extra.capabilityVersion ? { capabilityVersion: extra.capabilityVersion } : {}),
        ...(extra.modelId ? { modelId: extra.modelId } : {}),
      },
      assumptions: extra.assumptions ?? [],
      verification,
      trainingConsent: record.trainingConsent,
    });
  }

  private async process(record: RequestRecord, signal: AbortSignal): Promise<void> {
    const { registry, store, memory, proposals } = this.deps;

    // 1. Inspect the shared mission state before anything else.
    const mission = store.head();
    this.trace(record, "state", `Inspected mission "${mission.config.meta.name}" at version ${mission.version}`, {
      version: mission.version,
      components: mission.config.spacecraft.components.map((c) => c.id),
      hasRover: mission.config.rover !== undefined,
    });

    // 2. Natural language → structured requirement.
    const preset = this.structured.get(record.id);
    const requirement: StructuredRequirement = preset
      ? { id: newId("req"), originalText: record.text, summary: record.text, operations: preset, missingInformation: [], analysis: { method: "rule_based", verification: "deterministic_calculation" }, missionVersionInspected: mission.version }
      : await this.analyzer.analyze(record.text, mission, signal);
    record.requirement = requirement;
    this.trace(record, "analysis", `Requirement analysed (${requirement.analysis.method}): ${requirement.summary}`, {
      method: requirement.analysis.method,
      modelId: requirement.analysis.modelId,
      operations: requirement.operations.map((o) => ({ id: o.id, category: o.category, intent: o.intent, description: o.description, assumptions: o.assumptions })),
      missingInformation: requirement.missingInformation,
    });
    this.remember(record, "user_request", record.text, { requirement }, requirement.analysis.verification, requirement.analysis.modelId ? { modelId: requirement.analysis.modelId } : {});
    if (requirement.missingInformation.some((m) => m.blocking)) {
      this.trace(record, "analysis", "Clarification needed before planning", { questions: requirement.missingInformation.filter((m) => m.blocking).map((m) => m.question) });
      return this.setStatus(record, "awaiting_clarification");
    }

    // 3. Retrieve similar past work to inform the user and (for model planning) the plan.
    record.similarPastWork = memory
      .search(requirement.summary, { limit: 5, kinds: ["design_change", "simulation_result", "failure", "mission_outcome", "validation_report"] })
      .filter((m) => m.record.requestId !== record.id)
      .map(({ record: r, score }) => ({ id: r.id, kind: r.kind, summary: r.summary, score }));
    if (record.similarPastWork.length) this.trace(record, "memory", `Found ${record.similarPastWork.length} similar past record(s)`, record.similarPastWork);

    // 4. Plan: resolve needs to capabilities and build the dependency graph.
    this.setStatus(record, "planning");
    const { plan, issues } = await this.planner.plan(requirement, mission, record.user, record.id, signal);
    record.plan = plan;
    record.planIssues = issues;
    for (const task of plan.tasks) {
      this.trace(record, "selection", `Task ${task.id} → ${task.capabilityId}`, { taskId: task.id, capabilityId: task.capabilityId, reason: task.selectionReason, alternativesConsidered: task.alternativesConsidered, dependsOn: task.dependsOn });
    }
    this.trace(record, "planning", `Plan created by ${plan.createdBy} planner: ${plan.tasks.length} task(s), ${issues.length} issue(s)`, { issues });
    this.remember(record, "plan", `Plan for: ${requirement.summary}`, { tasks: plan.tasks.map(({ id, capabilityId, dependsOn, description }) => ({ id, capabilityId, dependsOn, description })), issues }, plan.createdBy === "llm" ? "model_judgment" : "heuristic", plan.modelId ? { modelId: plan.modelId } : {});

    // 5. Feasibility, before any execution.
    const feasibility = assessFeasibility({ requirement, plan, issues, registry, mission, user: record.user });
    record.feasibility = feasibility;
    this.trace(record, "feasibility", `Feasibility: ${feasibility.classification} — ${feasibility.summary}`, { factors: feasibility.factors, suggestedModifications: feasibility.suggestedModifications, evidenceBasis: feasibility.evidenceBasis });
    if (!feasibility.proceed) {
      this.remember(record, "failure", `Not executed (${feasibility.classification}): ${requirement.summary}`, { feasibility }, "deterministic_calculation");
      return this.setStatus(record, "infeasible");
    }

    // 6. Execute the dependency graph against an isolated draft workspace.
    this.setStatus(record, "executing");
    const draft = new DraftWorkspace(mission, path.join(this.deps.stagingDir, record.id));
    await this.executor.run(plan, {
      requestId: record.id,
      user: record.user,
      mission,
      draft,
      signal,
      trace: (stage, message, data) => this.trace(record, stage, message, data),
      onProgress: () => this.emit("updated", record),
    });
    for (const task of plan.tasks) {
      if (!task.result) continue;
      const descriptor = registry.get(task.executedBy ?? task.capabilityId)?.descriptor;
      this.remember(
        record,
        descriptor?.category === "simulation" ? "simulation_result" : descriptor?.category === "scientific_calculation" || descriptor?.category === "external_data" ? "scientific_evidence" : "tool_execution",
        `${task.description} [${task.executedBy ?? task.capabilityId}: ${task.status}]`,
        { taskId: task.id, status: task.status, output: task.result.output },
        task.result.verification,
        { assumptions: task.result.assumptions, capabilityId: task.result.provenance.capabilityId ?? task.capabilityId, ...(task.result.provenance.capabilityVersion ? { capabilityVersion: task.result.provenance.capabilityVersion } : {}), ...(task.result.provenance.modelId ? { modelId: task.result.provenance.modelId } : {}) },
      );
    }
    if (plan.status === "cancelled") {
      this.trace(record, "execution", "Request cancelled; staged changes discarded");
      return this.setStatus(record, "cancelled");
    }
    if (plan.status === "failed") {
      const failed = plan.tasks.filter((t) => t.status === "failed");
      record.error = failed.map((t) => `${t.id}: ${t.error}`).join("; ");
      this.remember(record, "failure", `Execution failed: ${requirement.summary} — ${record.error}`, { failedTasks: failed.map((t) => ({ id: t.id, capabilityId: t.capabilityId, error: t.error })) }, "deterministic_calculation");
      return this.setStatus(record, "failed");
    }

    // 7. Changes go to preview and approval; read-only requests are complete.
    if (draft.isEmpty) {
      draft.discard();
      return this.setStatus(record, "completed");
    }
    const proposal = await proposals.create({ requestId: record.id, user: record.user, draft, plan });
    record.proposalId = proposal.id;
    for (const test of proposal.tests) this.trace(record, "test", `${test.status.toUpperCase()} ${test.id}: ${test.description}`, { detail: test.detail });
    this.trace(record, "validation", `Proposal ${proposal.id} ready: ${proposal.significance} change, approval by "${proposal.requiredRole}" required`, {
      affectedComponents: proposal.preview.affectedComponents,
      recalculatedNodes: proposal.preview.recalculatedNodes,
      evidence: proposal.evidence,
    });
    this.remember(record, "validation_report", `Validation of proposed change: ${requirement.summary}`, { tests: proposal.tests, consequences: proposal.preview.consequences }, "deterministic_calculation");
    this.emit("proposal", proposal);
    this.setStatus(record, "awaiting_approval");
  }
}
