/**
 * Real-time collaboration client. Shared by the desktop HUD and the WebXR workspace, so
 * both see the same authoritative mission state.
 *
 * - The server is the only source of mission state: we render what `mission.version` says.
 * - Edits are sent with the version they were made against; a conflict comes back with the
 *   current values rather than silently overwriting a teammate.
 * - On reconnect we say which version we last saw and receive a snapshot plus what we missed.
 */
import { api, wsUrl } from "./api";
import type { Check, Evaluation, Maturity, MissionVersion, Presence, Snapshot } from "./api";

export interface EditOutcome { ok: boolean; version?: number; reason?: string; detail?: string; conflict?: { paths: string[]; current: Record<string, unknown>; changedBy: string[] }; headVersion?: number }
export type Patch = { op: "set" | "append"; path: string; value: unknown } | { op: "remove"; path: string };

export interface CollabEvents {
  snapshot(snapshot: Snapshot & { you: any; presence: Presence[]; resumed: boolean; missed: any[] }): void;
  version(update: { mission: MissionVersion; checks: Check[]; evaluation: Evaluation; maturity: Maturity; roles?: Snapshot["roles"]; cause: { by: string; kind: string; summary: string; displayName: string } }): void;
  game(update: { game: any; evaluation: Evaluation; maturity: Maturity; roles?: Snapshot["roles"] }): void;
  presence(roster: Presence[]): void;
  presenceUpdate(p: Presence): void;
  locks(locks: Record<string, string>): void;
  request(request: any): void;
  proposal(proposal: any): void;
  members(members: any[]): void;
  transform(t: { clientId: string; nodeId: string; pose: number[]; color: string }): void;
  /** A message a crew member sent to the crew (also your own, echoed back). */
  say(message: CrewMessage): void;
  /** A crewmate turned the world or changed how fast time runs. */
  clock(c: { timeMs: number; rate: number; at: number; by: string }): void;
  status(status: "connecting" | "live" | "reconnecting" | "offline", detail?: string): void;
}

export interface CrewMessage { id: string; accountId: string; displayName: string; color: string; mode: string; text: string; at: number }

export class Collab {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, (r: EditOutcome) => void>();
  private lockWaiters = new Map<string, (granted: boolean) => void>();
  private retry = 0;
  private closed = false;
  private lastPresence = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;
  lastVersion = 0;
  mode: "desktop" | "xr" = "desktop";
  latencyMs: number | null = null;

  constructor(
    readonly sessionId: string,
    private readonly on: Partial<CollabEvents>,
  ) {}

  async connect(): Promise<void> {
    if (this.closed) return;
    this.on.status?.(this.retry ? "reconnecting" : "connecting");
    let ticket: string;
    try {
      ticket = (await api<{ ticket: string }>("POST", "/api/auth/ws-ticket")).ticket;
    } catch (err) {
      this.on.status?.("offline", err instanceof Error ? err.message : "sign-in required");
      return this.schedule();
    }
    const ws = new WebSocket(wsUrl(`/ws?session=${encodeURIComponent(this.sessionId)}&ticket=${encodeURIComponent(ticket)}`));
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      // Tell the server what we last saw so it can report what we missed while away.
      if (this.lastVersion > 0) this.send({ type: "hello", lastVersion: this.lastVersion, mode: this.mode });
      this.on.status?.("live");
      clearInterval(this.ping);
      this.ping = setInterval(() => this.send({ type: "ping", t: performance.now() }), 5000);
    };
    ws.onmessage = (event) => this.receive(JSON.parse(String(event.data)));
    ws.onclose = () => {
      clearInterval(this.ping);
      // Anything in flight is unknown: let callers decide after the resync.
      for (const resolve of this.pending.values()) resolve({ ok: false, reason: "disconnected", detail: "Connection lost before the server confirmed the change." });
      this.pending.clear();
      if (!this.closed) this.schedule();
    };
    ws.onerror = () => ws.close();
  }

  private schedule(): void {
    if (this.closed) return;
    this.on.status?.("reconnecting");
    const delay = Math.min(8000, 400 * 2 ** this.retry++) + Math.random() * 250;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private receive(m: any): void {
    switch (m.type) {
      case "welcome":
        this.lastVersion = m.mission.version;
        this.on.snapshot?.(m);
        this.on.presence?.(m.presence);
        for (const message of (m.chat ?? []) as CrewMessage[]) this.on.say?.(message);
        break;
      case "crew.say": this.on.say?.(m.message); break;
      case "mission.version":
        this.lastVersion = m.mission.version;
        this.on.version?.(m);
        break;
      case "game.updated": this.on.game?.(m); break;
      case "presence.joined": case "presence.left": this.on.presence?.(m.presence); break;
      case "members.updated": this.on.members?.(m.members); this.on.presence?.(m.presence); break;
      case "presence.update": this.on.presenceUpdate?.(m); break;
      case "locks.updated": this.on.locks?.(m.locks); break;
      case "request.updated": this.on.request?.(m.request); break;
      case "proposal.updated": this.on.proposal?.(m.proposal); break;
      case "transform.preview": this.on.transform?.(m); break;
      case "clock": this.on.clock?.(m); break;
      case "edit.result": this.pending.get(m.clientSeq)?.(m); this.pending.delete(m.clientSeq); break;
      case "lock.result": this.lockWaiters.get(m.path)?.(m.granted); this.lockWaiters.delete(m.path); break;
      case "pong": this.latencyMs = performance.now() - m.t; break;
    }
  }

  private send(message: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(message));
    return true;
  }

  /** Propose a change to the shared mission. Resolves with the server's verdict. */
  edit(patches: Patch[], summary: string, force = false): Promise<EditOutcome> {
    return new Promise((resolve) => {
      const clientSeq = ++this.seq;
      if (!this.send({ type: "edit", clientSeq, baseVersion: this.lastVersion, patches, summary, force })) {
        return resolve({ ok: false, reason: "disconnected", detail: "Not connected — the change was not sent." });
      }
      this.pending.set(clientSeq, resolve);
      setTimeout(() => {
        if (this.pending.delete(clientSeq)) resolve({ ok: false, reason: "timeout", detail: "The server did not answer in time." });
      }, 8000);
    });
  }

  lock(path: string, held: boolean): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.send({ type: "lock", path, held })) return resolve(false);
      this.lockWaiters.set(path, resolve);
      setTimeout(() => this.lockWaiters.delete(path) && resolve(false), 3000);
    });
  }

  /** Ephemeral presence (pose, focus). Throttled; never stored by the server. */
  presence(p: { head?: number[] | null; hands?: { left: number[] | null; right: number[] | null }; focus?: string | null; point?: number[] | null; mode?: "desktop" | "xr" }, urgent = false): void {
    const now = performance.now();
    if (!urgent && now - this.lastPresence < 80) return;
    this.lastPresence = now;
    if (p.mode) this.mode = p.mode;
    this.send({ type: "presence", ...p });
  }

  /** Say something to the whole crew. */
  say(text: string): void {
    this.send({ type: "say", text });
  }

  /** Share the moment this crew is looking at, and how fast time is running. */
  clock(timeMs: number, rate: number): void {
    this.send({ type: "clock", timeMs, rate });
  }

  /** An object being dragged but not yet released: relayed for smooth motion, not saved. */
  transform(nodeId: string, pose: number[]): void {
    this.send({ type: "transform", nodeId, pose });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.ping);
    this.ws?.close();
  }
}
