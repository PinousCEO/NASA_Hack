/**
 * Real-time collaboration hub. One WebSocket per participant per mission session.
 *
 * Authoritative state only ever flows server → clients as whole mission versions
 * (configuration + recalculated results). Clients send *intent*: parameter edits with the
 * version they were made against, edit locks, and ephemeral presence / in-flight transform
 * previews that are relayed but never stored.
 *
 * Reconnect: a client says which version it last saw; the server answers with a full
 * snapshot and the list of versions it missed, so the client can re-base pending edits.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import type { PatchOp } from "../core/paths.js";
import type { Account } from "../platform/auth.js";
import type { Platform } from "../platform/platform.js";
import type { MissionSession } from "../platform/sessions.js";

const COLORS = ["#4cc9f0", "#f72585", "#ffd166", "#06d6a0", "#b388ff", "#ff8c42", "#90e0ef", "#e63946"];
const MAX_MESSAGE_BYTES = 64 * 1024;
const RATE_PER_SECOND = 90;
const HEARTBEAT_MS = 15_000;

interface Peer {
  ws: WebSocket;
  account: Account;
  session: MissionSession;
  clientId: string;
  color: string;
  mode: "desktop" | "xr";
  presence: Record<string, unknown>;
  alive: boolean;
  tokens: number;
  lastRefill: number;
}

const isPose = (v: unknown): boolean => v === null || (Array.isArray(v) && v.length === 7 && v.every((n) => typeof n === "number" && Number.isFinite(n)));

export class CollabHub {
  private readonly peers = new Set<Peer>();
  private readonly wired = new Set<string>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
  private readonly heartbeat: NodeJS.Timeout;
  private nextClient = 1;

  constructor(
    private readonly platform: Platform,
    private readonly authenticate: (req: IncomingMessage, url: URL) => Account | undefined,
  ) {
    this.heartbeat = setInterval(() => {
      for (const peer of this.peers) {
        if (!peer.alive) {
          peer.ws.terminate();
          continue;
        }
        peer.alive = false;
        peer.ws.ping();
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  attach(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") return socket.destroy();
      const refuse = (status: number, text: string): void => {
        socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
      };
      const account = this.authenticate(req, url);
      if (!account) return refuse(401, "Unauthorized");
      const session = this.platform.sessions.get(url.searchParams.get("session") ?? "");
      if (!session) return refuse(404, "Not Found");
      if (!session.member(account.id)) return refuse(403, "Forbidden");
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, account, session));
    });
    server.on("close", () => this.close());
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const peer of this.peers) peer.ws.terminate();
    this.wss.close();
  }

  /** Number of live connections in a session (for tests and the lobby). */
  connections(sessionId: string): number {
    return [...this.peers].filter((p) => p.session.meta.id === sessionId).length;
  }

  private send(peer: Peer, message: Record<string, unknown>): void {
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify(message));
  }

  private broadcast(session: MissionSession, message: Record<string, unknown>, except?: Peer): void {
    const data = JSON.stringify(message);
    for (const peer of this.peers) {
      if (peer.session === session && peer !== except && peer.ws.readyState === WebSocket.OPEN) peer.ws.send(data);
    }
  }

  private roster(session: MissionSession): Record<string, unknown>[] {
    return [...this.peers]
      .filter((p) => p.session === session)
      .map((p) => {
        const m = session.member(p.account.id);
        return { clientId: p.clientId, accountId: p.account.id, displayName: p.account.displayName, role: m?.role, discipline: m?.discipline, color: p.color, mode: p.mode, ...p.presence };
      });
  }

  /** Subscribe once to a session's events and fan them out to its connected peers. */
  private wire(session: MissionSession): void {
    if (this.wired.has(session.meta.id)) return;
    this.wired.add(session.meta.id);
    session.on("mission", (version, cause) => {
      const author = session.member(cause.by);
      // Configuration, recalculated results, constraint status and score travel together.
      this.broadcast(session, { type: "mission.version", mission: version, checks: session.checks(), evaluation: session.evaluate(), maturity: session.maturity(), cause: { ...cause, displayName: author?.displayName ?? cause.by } });
    });
    session.on("game", (game) => this.broadcast(session, { type: "game.updated", game, evaluation: session.evaluate(), maturity: session.maturity() }));
    session.on("members", (members) => this.broadcast(session, { type: "members.updated", members, presence: this.roster(session) }));
    session.on("locks", (locks) => this.broadcast(session, { type: "locks.updated", locks }));
    session.on("request", (r) =>
      this.broadcast(session, { type: "request.updated", request: { id: r.id, text: r.text, status: r.status, user: r.user, updatedAt: r.updatedAt, summary: r.requirement?.summary, feasibility: r.feasibility?.classification, tasks: r.plan?.tasks.map((t) => ({ id: t.id, capabilityId: t.executedBy ?? t.capabilityId, status: t.status })), proposalId: r.proposalId, error: r.error, traceLength: r.trace.length } }),
    );
    session.on("proposal", (proposal) => this.broadcast(session, { type: "proposal.updated", proposal }));
  }

  private accept(ws: WebSocket, account: Account, session: MissionSession): void {
    this.wire(session);
    const used = new Set([...this.peers].filter((p) => p.session === session).map((p) => p.color));
    const peer: Peer = {
      ws,
      account,
      session,
      clientId: `c${this.nextClient++}`,
      color: COLORS.find((c) => !used.has(c)) ?? COLORS[this.peers.size % COLORS.length]!,
      mode: "desktop",
      presence: {},
      alive: true,
      tokens: RATE_PER_SECOND,
      lastRefill: Date.now(),
    };
    this.peers.add(peer);
    ws.on("pong", () => {
      peer.alive = true;
    });
    ws.on("message", (data) => this.receive(peer, data));
    ws.on("close", () => {
      this.peers.delete(peer);
      // Locks die with the connection so a dropped headset never blocks the team.
      if (![...this.peers].some((p) => p.session === session && p.account.id === account.id)) session.releaseLocks(account.id);
      this.broadcast(session, { type: "presence.left", clientId: peer.clientId, presence: this.roster(session) });
    });
    ws.on("error", () => ws.terminate());
    this.send(peer, { type: "welcome", you: { clientId: peer.clientId, accountId: account.id, color: peer.color, role: session.member(account.id)?.role }, ...session.snapshot(), presence: this.roster(session), resumed: false, missed: [] });
    this.broadcast(session, { type: "presence.joined", presence: this.roster(session) }, peer);
  }

  private receive(peer: Peer, data: RawData): void {
    // Token bucket: a misbehaving client is throttled, not allowed to starve the others.
    const now = Date.now();
    peer.tokens = Math.min(RATE_PER_SECOND, peer.tokens + ((now - peer.lastRefill) / 1000) * RATE_PER_SECOND);
    peer.lastRefill = now;
    if (peer.tokens < 1) return;
    peer.tokens -= 1;
    peer.alive = true;

    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(String(data));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const { session, account } = peer;
    switch (msg.type) {
      case "hello": {
        // Reconnect recovery: tell the client what it missed since the version it last saw.
        const last = typeof msg.lastVersion === "number" ? msg.lastVersion : 0;
        if (msg.mode === "xr" || msg.mode === "desktop") peer.mode = msg.mode;
        const missed = last > 0 ? session.store.list().filter((v) => v.version > last).map((v) => ({ version: v.version, by: session.member(v.publishedBy)?.displayName ?? v.publishedBy, note: v.note, changedPaths: v.changedPaths ?? [] })) : [];
        this.send(peer, { type: "welcome", you: { clientId: peer.clientId, accountId: account.id, color: peer.color, role: session.member(account.id)?.role }, ...session.snapshot(), presence: this.roster(session), resumed: last > 0, missed });
        this.broadcast(session, { type: "presence.joined", presence: this.roster(session) }, peer);
        return;
      }
      case "edit": {
        const result = session.applyEdit(account.id, {
          baseVersion: Number(msg.baseVersion),
          patches: (Array.isArray(msg.patches) ? msg.patches : []) as PatchOp[],
          ...(typeof msg.summary === "string" ? { summary: msg.summary } : {}),
          force: msg.force === true,
        });
        // The new version reaches everyone (including the author) through the session event.
        this.send(peer, result.ok ? { type: "edit.result", clientSeq: msg.clientSeq, ok: true, version: result.version.version } : { type: "edit.result", clientSeq: msg.clientSeq, ok: false, reason: result.reason, detail: result.detail, conflict: result.conflict, headVersion: session.store.head().version });
        return;
      }
      case "lock": {
        if (typeof msg.path !== "string" || msg.path.length > 200) return;
        let granted = false;
        try {
          granted = session.lock(account.id, msg.path, msg.held !== false);
        } catch {
          granted = false;
        }
        this.send(peer, { type: "lock.result", path: msg.path, held: msg.held !== false, granted });
        return;
      }
      case "presence": {
        const next: Record<string, unknown> = {};
        if (isPose(msg.head)) next.head = msg.head;
        const hands = msg.hands as { left?: unknown; right?: unknown } | undefined;
        if (hands && typeof hands === "object" && isPose(hands.left ?? null) && isPose(hands.right ?? null)) next.hands = { left: hands.left ?? null, right: hands.right ?? null };
        if (msg.focus === null || (typeof msg.focus === "string" && msg.focus.length <= 200)) next.focus = msg.focus;
        if (msg.mode === "xr" || msg.mode === "desktop") peer.mode = msg.mode;
        peer.presence = { ...peer.presence, ...next };
        this.broadcast(session, { type: "presence.update", clientId: peer.clientId, accountId: account.id, color: peer.color, mode: peer.mode, displayName: account.displayName, ...peer.presence }, peer);
        return;
      }
      case "transform": {
        // An object being moved but not yet released: relayed for smooth motion, never stored.
        // The move becomes real only when the client commits it as an edit.
        if (typeof msg.nodeId !== "string" || msg.nodeId.length > 80 || !isPose(msg.pose)) return;
        if (session.member(account.id)?.role === "viewer") return;
        this.broadcast(session, { type: "transform.preview", clientId: peer.clientId, nodeId: msg.nodeId, pose: msg.pose, color: peer.color }, peer);
        return;
      }
      case "ping":
        this.send(peer, { type: "pong", t: msg.t, serverTime: Date.now(), headVersion: session.store.head().version });
        return;
      default:
        return;
    }
  }
}
