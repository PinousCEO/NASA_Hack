/**
 * HTTP API + WebSocket broadcast for the shared MR/Web workspace.
 *
 * Identity: callers state `user: { id, role }` (body) or `x-user-id` / `x-user-role`
 * headers. This layer does NOT authenticate; put it behind the workspace's real
 * authentication before exposing it beyond a trusted network.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { WebSocket, WebSocketServer } from "ws";
import { type App, PROJECT_ROOT } from "../app.js";
import { CapabilityError, type Role, type User } from "../core/types.js";
import { createMcpServer } from "../mcp/server.js";
import type { MemoryKind } from "../memory/memory.js";
import type { RequestRecord } from "../pipeline/types.js";
import type { CapabilityCategory } from "../registry/capability.js";
import { executeDirect } from "../registry/direct.js";
import type { MissionVersion } from "../state/store.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml",
};
const ROLES: Role[] = ["viewer", "engineer", "lead"];
const MAX_BODY_BYTES = 25 * 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object");
  }
}

function userFrom(req: IncomingMessage, body: Record<string, unknown>): User {
  const fromBody = body.user as { id?: unknown; role?: unknown } | undefined;
  const id = fromBody?.id ?? req.headers["x-user-id"];
  const role = fromBody?.role ?? req.headers["x-user-role"];
  if (typeof id !== "string" || !id || typeof role !== "string" || !ROLES.includes(role as Role)) {
    throw new HttpError(401, 'Identify the caller with user: { id, role } where role is "viewer", "engineer" or "lead"');
  }
  return { id, role: role as Role };
}

/** Send a file from inside `root`; refuses paths that escape it. */
function sendFile(res: ServerResponse, root: string, relative: string): void {
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "Not found");
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(file).pipe(res);
}

/** Compact request view for broadcast; the full record (with trace) is fetched on demand. */
const requestSummary = (r: RequestRecord): Record<string, unknown> => ({
  id: r.id,
  text: r.text,
  status: r.status,
  user: r.user,
  updatedAt: r.updatedAt,
  summary: r.requirement?.summary,
  feasibility: r.feasibility?.classification,
  tasks: r.plan?.tasks.map((t) => ({ id: t.id, capabilityId: t.capabilityId, status: t.status })),
  proposalId: r.proposalId,
  traceLength: r.trace.length,
});

const versionMessage = (v: MissionVersion): Record<string, unknown> => ({
  version: v.version,
  parentVersion: v.parentVersion,
  publishedAt: v.publishedAt,
  publishedBy: v.publishedBy,
  note: v.note,
  rollbackOf: v.rollbackOf,
  recalculated: v.recalculated,
  config: v.config,
  derived: v.derived,
});

export function createHttpServer(app: App): Server {
  const webDir = path.join(PROJECT_ROOT, "web");

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };

    if (parts[0] === "mcp") {
      // Stateless Streamable HTTP: one server + transport per request.
      const body = method === "POST" ? await readJson(req) : undefined;
      const server = createMcpServer({ registry: app.registry, store: app.store, requests: app.requests });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (parts[0] === "assets" && method === "GET") return sendFile(res, app.assetsDir, parts.slice(1).join("/"));

    if (parts[0] !== "api") {
      if (method !== "GET") throw new HttpError(405, "Method not allowed");
      return sendFile(res, webDir, parts.length ? parts.join("/") : "index.html");
    }

    const route = `${method} /${parts.slice(1).join("/")}`;
    const [, resource, id, action] = parts;

    if (route === "GET /health") {
      return json(200, { ok: true, missionVersion: app.store.head().version, capabilities: app.registry.list().length, llm: { modelId: app.llm.modelId, ...app.llm.status() }, mcpServers: app.mcp.statuses() });
    }

    // --- Capability registry ---
    if (resource === "capabilities") {
      if (route === "GET /capabilities") {
        const q = url.searchParams;
        return json(200, app.registry.search({
          ...(q.get("q") ? { text: q.get("q")! } : {}),
          ...(q.get("category") ? { category: q.get("category") as CapabilityCategory } : {}),
          ...(q.get("provides") ? { provides: q.get("provides")! } : {}),
          usableOnly: q.get("usable") === "1",
        }).map((m) => ({ ...m.descriptor, stats: m.stats, score: m.score })));
      }
      if (route === "POST /capabilities/refresh") {
        await app.registry.refreshAvailability();
        return json(200, app.registry.list().map((d) => ({ id: d.id, availability: d.availability })));
      }
      if (id && method === "GET" && !action) {
        const described = app.registry.describe(id);
        if (!described) throw new HttpError(404, `Unknown capability "${id}"`);
        return json(200, described);
      }
      if (id && action === "execute" && method === "POST") {
        const body = await readJson(req);
        return json(200, await executeDirect(app, id, body.input ?? {}, userFrom(req, body)));
      }
    }

    // --- Mission state ---
    if (resource === "mission") {
      if (route === "GET /mission") return json(200, versionMessage(app.store.head()));
      if (route === "GET /mission/versions") return json(200, app.store.list());
      if (id === "versions" && action && method === "GET") {
        const version = app.store.get(Number(action));
        if (!version) throw new HttpError(404, `Version ${action} not found`);
        return json(200, versionMessage(version));
      }
      if (route === "POST /mission/rollback") {
        const body = await readJson(req);
        const user = userFrom(req, body);
        if (user.role !== "lead") throw new HttpError(403, 'Rollback requires role "lead"');
        if (typeof body.version !== "number") throw new HttpError(400, "version (number) is required");
        const reason = typeof body.reason === "string" && body.reason ? body.reason : "no reason given";
        const version = app.store.rollback(body.version, user.id, reason);
        app.memory.add({ kind: "design_change", missionName: version.config.meta.name, missionVersion: version.version, summary: `Rolled back to v${body.version}: ${reason}`, data: { rollbackOf: body.version, by: user }, tags: ["rollback"], provenance: { source: "pipeline" }, assumptions: [], verification: "deterministic_calculation" });
        return json(200, versionMessage(version));
      }
    }

    // --- Requests ---
    if (resource === "requests") {
      if (route === "GET /requests") return json(200, app.requests.list().map(requestSummary));
      if (route === "POST /requests") {
        const body = await readJson(req);
        if (typeof body.text !== "string") throw new HttpError(400, "text is required");
        const record = app.requests.submit({ text: body.text, user: userFrom(req, body), trainingConsent: body.trainingConsent === true });
        return json(202, body.wait === true ? await app.requests.wait(record.id) : record);
      }
      const record = id ? app.requests.get(id) : undefined;
      if (id && !record) throw new HttpError(404, `Request "${id}" not found`);
      if (record && method === "GET" && !action) return json(200, record);
      if (record && method === "GET" && action === "trace") return json(200, record.trace);
      if (record && method === "POST" && action === "clarify") {
        const body = await readJson(req);
        if (typeof body.answer !== "string" || !body.answer.trim()) throw new HttpError(400, "answer is required");
        app.requests.clarify(record.id, body.answer);
        return json(202, body.wait === true ? await app.requests.wait(record.id) : record);
      }
      if (record && method === "POST" && action === "cancel") return json(202, app.requests.cancel(record.id));
    }

    // --- Proposals: preview, approval, deployment ---
    if (resource === "proposals") {
      if (route === "GET /proposals") return json(200, app.proposals.list());
      const proposal = id ? app.proposals.get(id) : undefined;
      if (id && !proposal) throw new HttpError(404, `Proposal "${id}" not found`);
      if (proposal && method === "GET" && !action) return json(200, proposal);
      if (proposal && method === "POST" && (action === "approve" || action === "reject")) {
        const body = await readJson(req);
        const user = userFrom(req, body);
        const reason = typeof body.reason === "string" ? body.reason : "";
        if (action === "approve") {
          const { proposal: updated, version } = await app.proposals.approve(proposal.id, user, reason);
          app.requests.recordDecision(updated, version);
          return json(200, { proposal: updated, version: version.version });
        }
        const updated = app.proposals.reject(proposal.id, user, reason);
        app.requests.recordDecision(updated);
        return json(200, { proposal: updated });
      }
    }

    // --- Research memory ---
    if (resource === "memory") {
      if (route === "GET /memory/search") {
        const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean) as MemoryKind[] | undefined;
        return json(200, app.memory.search(url.searchParams.get("q") ?? "", { limit: Number(url.searchParams.get("limit") ?? 10), ...(kinds ? { kinds } : {}) }));
      }
      if (route === "GET /memory/training-eligible") return json(200, app.memory.trainingEligible());
      if (route === "POST /memory") {
        // Human-authored knowledge: hypotheses, improvements, outcomes and cited evidence.
        const body = await readJson(req);
        const user = userFrom(req, body);
        const kinds: MemoryKind[] = ["hypothesis", "improvement", "mission_outcome", "scientific_evidence"];
        if (user.role === "viewer") throw new HttpError(403, "Viewers cannot add memory records");
        if (!kinds.includes(body.kind as MemoryKind)) throw new HttpError(400, `kind must be one of: ${kinds.join(", ")}`);
        if (typeof body.summary !== "string" || !body.summary.trim()) throw new HttpError(400, "summary is required");
        const references = Array.isArray(body.references) ? body.references.filter((r): r is string => typeof r === "string") : [];
        // A person's statement is unverified unless a lead records it as independently verified, with references.
        const verified = body.verification === "independently_verified";
        if (verified && (user.role !== "lead" || references.length === 0)) throw new HttpError(403, 'Recording evidence as independently verified requires role "lead" and at least one reference');
        const head = app.store.head();
        return json(201, app.memory.add({
          kind: body.kind as MemoryKind,
          missionName: head.config.meta.name,
          missionVersion: head.version,
          summary: body.summary.trim(),
          data: body.data ?? null,
          tags: Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [],
          provenance: { source: `user:${user.id}`, ...(references.length ? { references } : {}) },
          assumptions: Array.isArray(body.assumptions) ? body.assumptions.filter((a): a is string => typeof a === "string") : [],
          verification: verified ? "independently_verified" : "unverified",
          trainingConsent: body.trainingConsent === true,
        }));
      }
      if (id && action === "review" && method === "POST") {
        const body = await readJson(req);
        const user = userFrom(req, body);
        if (user.role !== "lead") throw new HttpError(403, 'Quality review requires role "lead"');
        return json(200, app.memory.markQualityReviewed(id, user.id));
      }
    }

    throw new HttpError(404, `No route for ${method} ${url.pathname}`);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : err instanceof CapabilityError ? 422 : 400;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });

  // --- Broadcast to all connected MR and Web clients ---
  const wss = new WebSocketServer({ server, path: "/ws" });
  const broadcast = (message: Record<string, unknown>): void => {
    const data = JSON.stringify(message);
    for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
  };
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "mission.snapshot", mission: versionMessage(app.store.head()) }));
  });
  // Configuration and recalculated simulation results travel together — never visuals alone.
  app.store.on("published", (version) => broadcast({ type: "mission.version_published", mission: versionMessage(version) }));
  app.requests.on("updated", (record) => broadcast({ type: "request.updated", request: requestSummary(record) }));
  app.requests.on("proposal", (proposal) => broadcast({ type: "proposal.created", proposal }));
  app.registry.on("changed", (id) => broadcast({ type: "capability.changed", id }));
  server.on("close", () => wss.close());

  return server;
}
