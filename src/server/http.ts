/**
 * HTTP API for the mission platform.
 *
 * Every route except the public ones (health, reference data, leaderboard, auth) requires
 * an authenticated account; every session route additionally requires membership of that
 * session, and the session enforces role checks server-side. Identity comes from an
 * HttpOnly session cookie or an `Authorization: Bearer` token — never from the request body.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttps } from "node:https";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PROJECT_ROOT } from "../app.js";
import { CapabilityError } from "../core/types.js";
import { SCENARIOS } from "../game/scenarios.js";
import { createMcpServer } from "../mcp/server.js";
import type { MemoryKind } from "../memory/memory.js";
import { CONCEPT_MATURITY_LEVELS, DISCIPLINES, LIFE_CYCLE_PHASES, MISSION_SEGMENTS, POINT_DESIGN_MARGINS } from "../nasa/lifecycle.js";
import { type Account, AuthError } from "../platform/auth.js";
import type { Platform } from "../platform/platform.js";
import { describeSecrets, redact } from "../platform/secrets.js";
import { type MissionSession, SessionError } from "../platform/sessions.js";
import type { CapabilityCategory } from "../registry/capability.js";
import { executeDirect } from "../registry/direct.js";
import { CollabHub } from "./collab.js";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".glb": "model/gltf-binary", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8", ".map": "application/json",
};
const COOKIE = "ms_session";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: data: blob: https://cdn.jsdelivr.net https://www.gstatic.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

export interface ServerOptions {
  /** Directory containing the exported web client. */
  webDir?: string;
  /** Extra origins allowed to call the API with credentials (frontend dev server). */
  allowedOrigins?: string[];
  tls?: { cert: Buffer; key: Buffer };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  if (!/^application\/json/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "Content-Type must be application/json");
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object");
  }
}

const cookieOf = (req: IncomingMessage): string | undefined =>
  (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === COOKIE)?.[1];
const bearerOf = (req: IncomingMessage): string | undefined => /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
const addressOf = (req: IncomingMessage): string => req.socket.remoteAddress ?? "unknown";

function sendFile(res: ServerResponse, root: string, relative: string, cache: string): boolean {
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep) || !existsSync(file) || !statSync(file).isFile()) return false;
  const type = MIME[path.extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": cache, ...(type.startsWith("text/html") ? { "content-security-policy": CSP } : {}) });
  createReadStream(file).pipe(res);
  return true;
}

export function createPlatformServer(platform: Platform, options: ServerOptions = {}): Server {
  const webDir = options.webDir ?? path.join(PROJECT_ROOT, "apps", "web", "out");
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const secure = Boolean(options.tls);
  const { auth, audit, sessions } = platform;

  const accountOf = (req: IncomingMessage): Account | undefined => auth.authenticate(bearerOf(req) ?? cookieOf(req));
  const sessionCookie = (token: string, maxAgeS: number): string => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure ? "; Secure" : ""}`;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const method = req.method ?? "GET";
    const origin = req.headers.origin;

    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("permissions-policy", "xr-spatial-tracking=(self), microphone=(self)");
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("access-control-allow-headers", "content-type, authorization");
      res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      res.setHeader("vary", "origin");
    }
    if (method === "OPTIONS") {
      res.writeHead(204);
      return void res.end();
    }
    // CSRF defence in depth: a state-changing request from a browser must come from this origin.
    if (method !== "GET" && method !== "HEAD" && origin && !allowedOrigins.has(origin) && new URL(origin).host !== req.headers.host) {
      throw new HttpError(403, "Cross-origin request refused");
    }

    const json = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
      res.end(JSON.stringify(body));
    };
    const requireAccount = (): Account => {
      const account = accountOf(req);
      if (!account) throw new HttpError(401, "Sign in to continue");
      return account;
    };
    const requireAdmin = (): Account => {
      const account = requireAccount();
      if (account.role !== "admin") {
        audit.record({ actor: account.id, action: `admin.denied ${method} ${url.pathname}`, outcome: "denied" });
        throw new HttpError(403, "Administrator access required");
      }
      return account;
    };

    // ---------- MCP (Streamable HTTP), scoped to one session ----------
    if (parts[0] === "mcp") {
      const account = requireAccount();
      const session = sessions.get(url.searchParams.get("session") ?? "");
      const user = session?.userFor(account.id);
      if (!session || !user) throw new HttpError(403, "MCP access needs ?session=<id> for a mission you are a member of");
      const body = method === "POST" ? await readJson(req) : undefined;
      const server = createMcpServer({ registry: platform.registry, store: session.store, requests: session.requests, user });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // ---------- Assets: immutable, content-addressed GLBs ----------
    if (parts[0] === "assets" && method === "GET") {
      requireAccount();
      if (!sendFile(res, platform.assetsDir, parts.slice(1).join("/"), "private, max-age=31536000, immutable")) throw new HttpError(404, "Asset not found");
      return;
    }

    // ---------- Web client (static export) ----------
    if (parts[0] !== "api") {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
      const rel = parts.join("/");
      const immutable = parts[0] === "_next";
      const candidates = rel === "" ? ["index.html"] : [rel, `${rel}.html`, `${rel}/index.html`];
      for (const c of candidates) if (sendFile(res, webDir, c, immutable ? "public, max-age=31536000, immutable" : "no-cache")) return;
      if (!existsSync(path.join(webDir, "index.html"))) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        return void res.end("The web client has not been built yet. Run `npm run build:web`, then reload. The API is available under /api.");
      }
      if (sendFile(res, webDir, "404.html", "no-cache")) return;
      throw new HttpError(404, "Not found");
    }

    const [, resource, id, action, subId, subAction] = parts;
    const route = `${method} /${parts.slice(1).join("/")}`;

    // ---------- Public ----------
    if (route === "GET /health") return json(200, { ok: true, service: "mission-platform", secure });
    if (route === "GET /reference") return json(200, { lifeCycle: LIFE_CYCLE_PHASES, segments: MISSION_SEGMENTS, conceptMaturityLevels: CONCEPT_MATURITY_LEVELS, disciplines: DISCIPLINES, pointDesignMargins: POINT_DESIGN_MARGINS });
    if (route === "GET /leaderboard") {
      return json(200, sessions.leaderboard({ ...(url.searchParams.get("scenario") ? { scenarioId: url.searchParams.get("scenario")! } : {}), ...(url.searchParams.get("difficulty") ? { difficulty: url.searchParams.get("difficulty")! } : {}) }));
    }
    if (route === "GET /scenarios") {
      return json(200, SCENARIOS.map((s) => ({ id: s.id, title: s.title, tagline: s.tagline, destination: s.destination, briefing: s.briefing, scienceQuestions: s.scienceQuestions, references: s.references, objectives: s.objectives.map((o) => ({ id: o.id, title: o.title, description: o.description, category: o.category, weight: o.weight })), disciplines: DISCIPLINES.filter((d) => s.disciplines.includes(d.id)), catalogSize: s.catalog.length })));
    }

    // ---------- Authentication ----------
    if (resource === "auth") {
      if (route === "POST /auth/register" || route === "POST /auth/login") {
        const body = await readJson(req);
        const username = String(body.username ?? "");
        try {
          if (id === "register") {
            const created = await auth.register({ username, password: String(body.password ?? ""), ...(typeof body.displayName === "string" ? { displayName: body.displayName } : {}) }, addressOf(req));
            audit.record({ actor: created.id, action: "auth.register", detail: { username: created.username, role: created.role } });
          }
          const { account, token, expiresAt } = await auth.login(username, String(body.password ?? ""), addressOf(req));
          audit.record({ actor: account.id, action: "auth.login" });
          // Non-browser clients ask for the token explicitly; browsers only ever hold the HttpOnly cookie.
          return json(id === "register" ? 201 : 200, { account, expiresAt, ...(body.returnToken === true ? { token } : {}) }, { "set-cookie": sessionCookie(token, Math.floor((expiresAt - Date.now()) / 1000)) });
        } catch (err) {
          if (err instanceof AuthError) {
            audit.record({ actor: `anonymous:${username.slice(0, 32)}`, action: `auth.${id}`, outcome: "denied", detail: { reason: err.message } });
            throw new HttpError(err.status, err.message);
          }
          throw err;
        }
      }
      if (route === "POST /auth/logout") {
        const account = accountOf(req);
        auth.logout(bearerOf(req) ?? cookieOf(req));
        if (account) audit.record({ actor: account.id, action: "auth.logout" });
        return json(200, { ok: true }, { "set-cookie": sessionCookie("", 0) });
      }
      if (route === "GET /auth/me") {
        const account = accountOf(req);
        return json(200, { account: account ?? null });
      }
      if (route === "POST /auth/ws-ticket") return json(200, { ticket: auth.issueTicket(requireAccount().id) });
    }

    // ---------- Platform information ----------
    if (route === "GET /platform") {
      const account = requireAccount();
      return json(200, {
        llm: { modelId: platform.llm.modelId, ...platform.llm.status() },
        capabilities: { total: platform.registry.list().length, usable: platform.registry.list().filter((d) => platform.registry.isUsable(d)).length },
        mcpServers: platform.mcp.statuses(),
        knowledge: platform.knowledge.status(),
        ...(account.role === "admin" ? { secrets: describeSecrets(), audit: audit.verify() } : {}),
      });
    }
    if (resource === "capabilities") {
      requireAccount();
      if (route === "GET /capabilities") {
        const q = url.searchParams;
        return json(200, platform.registry.search({ ...(q.get("q") ? { text: q.get("q")! } : {}), ...(q.get("category") ? { category: q.get("category") as CapabilityCategory } : {}), ...(q.get("provides") ? { provides: q.get("provides")! } : {}), usableOnly: q.get("usable") === "1" }).map((m) => ({ ...m.descriptor, stats: m.stats, score: m.score })));
      }
      if (id && method === "GET") {
        const described = platform.registry.describe(id);
        if (!described) throw new HttpError(404, `Unknown capability "${id}"`);
        return json(200, described);
      }
    }

    // ---------- Knowledge base and research records ----------
    if (resource === "knowledge") {
      const account = requireAccount();
      if (route === "GET /knowledge/search") {
        const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean) as ("reference" | "document" | "record")[] | undefined;
        const recordKinds = url.searchParams.get("recordKinds")?.split(",").filter(Boolean);
        return json(200, platform.knowledge.search(url.searchParams.get("q") ?? "", { k: Math.min(30, Number(url.searchParams.get("k") ?? 8)), ...(kinds ? { kinds } : {}), ...(recordKinds ? { recordKinds } : {}) }));
      }
      if (route === "POST /knowledge/context") {
        const body = await readJson(req);
        if (typeof body.query !== "string" || !body.query.trim()) throw new HttpError(400, "query is required");
        return json(200, platform.knowledge.context(body.query, { ...(typeof body.k === "number" ? { k: Math.min(12, body.k) } : {}), ...(typeof body.maxChars === "number" ? { maxChars: Math.min(20000, body.maxChars) } : {}) }));
      }
      if (route === "GET /knowledge/status") return json(200, platform.knowledge.status());
      if (route === "POST /knowledge/ingest") {
        if (account.role !== "admin") throw new HttpError(403, "Administrator access required");
        const result = platform.knowledge.ingestDirectory(platform.documentsDir);
        audit.record({ actor: account.id, action: "knowledge.ingest", detail: result });
        return json(200, result);
      }
    }
    if (resource === "research") {
      const account = requireAccount();
      if (route === "GET /research") {
        const kind = url.searchParams.get("kind") as MemoryKind | null;
        const q = url.searchParams.get("q")?.trim();
        const all = platform.memory.all().filter((r) => !kind || r.kind === kind);
        const records = q ? platform.memory.search(q, { limit: 60, ...(kind ? { kinds: [kind] } : {}) }).map((m) => ({ ...m.record, score: m.score })) : all.slice(-80).reverse();
        return json(200, { total: all.length, records: records.map(({ data: _d, ...r }) => r) });
      }
      if (id && !action && method === "GET") {
        const record = platform.memory.get(id);
        if (!record) throw new HttpError(404, "Record not found");
        return json(200, record);
      }
      if (id && action === "review" && method === "POST") {
        if (account.role !== "admin") throw new HttpError(403, "Quality review requires an administrator");
        audit.record({ actor: account.id, action: "research.review", detail: { recordId: id } });
        return json(200, platform.memory.markQualityReviewed(id, account.id));
      }
      if (route === "GET /research/training-eligible") return json(200, platform.memory.trainingEligible());
    }

    // ---------- Audit and administration ----------
    if (route === "GET /audit/verify") {
      requireAdmin();
      return json(200, audit.verify());
    }
    if (route === "GET /audit") {
      const account = requireAccount();
      const sessionId = url.searchParams.get("session") ?? undefined;
      const lead = sessionId ? sessions.get(sessionId)?.member(account.id)?.role === "lead" : false;
      if (account.role !== "admin" && !lead) throw new HttpError(403, "The audit log is available to administrators, and to a mission's lead for that mission");
      return json(200, audit.query({ ...(sessionId ? { sessionId } : {}), ...(url.searchParams.get("action") ? { action: url.searchParams.get("action")! } : {}), limit: Math.min(1000, Number(url.searchParams.get("limit") ?? 200)) }));
    }
    if (resource === "admin") {
      const admin = requireAdmin();
      if (route === "GET /admin/accounts") return json(200, auth.listAccounts());
      if (id === "accounts" && action && subId === "role" && method === "POST") {
        const body = await readJson(req);
        if (body.role !== "admin" && body.role !== "member") throw new HttpError(400, 'role must be "admin" or "member"');
        if (action === admin.id && body.role !== "admin") throw new HttpError(409, "You cannot remove your own administrator role");
        audit.record({ actor: admin.id, action: "admin.role", detail: { accountId: action, role: body.role } });
        return json(200, auth.setRole(action, body.role));
      }
    }

    // ---------- Mission sessions ----------
    if (resource === "sessions") {
      const account = requireAccount();
      if (route === "GET /sessions") return json(200, sessions.list(account));
      if (route === "POST /sessions") {
        const body = await readJson(req);
        const session = sessions.create(account, body as never);
        return json(201, { ...session.snapshot(), inviteCode: session.meta.inviteCode });
      }
      const session: MissionSession | undefined = id ? sessions.get(id) : undefined;
      if (!session) throw new HttpError(404, "Mission not found");
      if (action === "join" && method === "POST") {
        const body = await readJson(req);
        const member = session.join(account, typeof body.inviteCode === "string" ? body.inviteCode : undefined, (body.discipline as never) ?? undefined);
        return json(200, { member, sessionId: session.meta.id });
      }
      // Everything below is for members only.
      const member = session.member(account.id);
      if (!member) {
        audit.record({ actor: account.id, action: `session.access ${route}`, sessionId: session.meta.id, outcome: "denied" });
        throw new HttpError(403, "You are not a member of this mission");
      }
      const user = { id: account.id, role: member.role };

      if (!action && method === "GET") return json(200, { ...session.snapshot(), you: member, ...(member.role === "lead" ? { inviteCode: session.meta.inviteCode } : {}) });
      if (action === "edit" && method === "POST") {
        const body = await readJson(req);
        const result = session.applyEdit(account.id, body as never);
        return json(result.ok ? 200 : result.reason === "conflict" || result.reason === "locked" || result.reason === "frozen" ? 409 : result.reason === "forbidden" ? 403 : 422, result.ok ? { ok: true, version: result.version.version } : result);
      }
      if (action === "requests") {
        if (!subId && method === "GET") return json(200, session.requests.list().map(({ trace, ...r }) => ({ ...r, traceLength: trace.length })));
        if (!subId && method === "POST") {
          const body = await readJson(req);
          if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "text is required");
          if (body.text.length > 4000) throw new HttpError(400, "Request text is too long");
          const record = session.submitRequest(account.id, body.text, body.trainingConsent === true);
          return json(202, body.wait === true ? await session.requests.wait(record.id) : record);
        }
        const record = subId ? session.requests.get(subId) : undefined;
        if (!record) throw new HttpError(404, "Request not found");
        if (!subAction && method === "GET") return json(200, record);
        if (subAction === "clarify" && method === "POST") {
          const body = await readJson(req);
          if (typeof body.answer !== "string" || !body.answer.trim()) throw new HttpError(400, "answer is required");
          if (record.user.id !== account.id && member.role !== "lead") throw new HttpError(403, "Only the requester or a lead can answer");
          session.requests.clarify(record.id, body.answer);
          return json(202, body.wait === true ? await session.requests.wait(record.id) : record);
        }
        if (subAction === "cancel" && method === "POST") {
          if (record.user.id !== account.id && member.role !== "lead") throw new HttpError(403, "Only the requester or a lead can cancel");
          return json(202, session.requests.cancel(record.id));
        }
      }
      if (action === "catalog" && method === "POST") {
        const body = await readJson(req);
        if (typeof body.itemId !== "string") throw new HttpError(400, "itemId is required");
        const record = session.addFromCatalog(account.id, body.itemId, body.target === "rover" ? "rover" : "spacecraft");
        return json(202, body.wait === true ? await session.requests.wait(record.id) : record);
      }
      if (action === "proposals") {
        if (!subId && method === "GET") return json(200, session.proposals.list());
        const proposal = subId ? session.proposals.get(subId) : undefined;
        if (!proposal) throw new HttpError(404, "Proposal not found");
        if (!subAction && method === "GET") return json(200, proposal);
        if ((subAction === "approve" || subAction === "reject") && method === "POST") {
          const body = await readJson(req);
          const result = await session.decide(account.id, proposal.id, subAction, typeof body.reason === "string" ? body.reason.slice(0, 500) : "");
          return json(200, { proposal: result.proposal, version: result.version?.version });
        }
      }
      if (action === "versions" && method === "GET") {
        if (!subId) return json(200, session.store.list());
        const version = session.store.get(Number(subId));
        if (!version) throw new HttpError(404, "Version not found");
        return json(200, version);
      }
      if (action === "rollback" && method === "POST") {
        const body = await readJson(req);
        if (typeof body.version !== "number") throw new HttpError(400, "version (number) is required");
        return json(200, { version: session.rollback(account.id, body.version, typeof body.reason === "string" ? body.reason : "").version });
      }
      if (action === "simulate" && method === "POST") return json(200, session.runSimulation(account.id));
      if (action === "trade" && method === "POST") return json(200, await session.runTradeStudy(account.id, (await readJson(req)) as never));
      if (action === "notes" && method === "POST") {
        const body = await readJson(req);
        if (!["mission_problem", "hypothesis", "scientific_evidence", "improvement"].includes(String(body.kind))) throw new HttpError(400, "kind must be mission_problem, hypothesis, scientific_evidence or improvement");
        session.recordNote(account.id, { kind: body.kind as never, summary: String(body.summary ?? ""), ...(typeof body.detail === "string" ? { detail: body.detail } : {}), ...(typeof body.mitigation === "string" ? { mitigation: body.mitigation } : {}) });
        return json(201, { ok: true, game: session.meta.game });
      }
      if (action === "review" && method === "POST") return json(200, await session.holdReview(account.id));
      if (action === "phase" && method === "POST") return json(200, { game: session.advancePhase(account.id), maturity: session.maturity() });
      if (action === "submit" && method === "POST") {
        const result = session.submit(account.id);
        sessions.recordSubmission(result.submission);
        return json(200, result);
      }
      if (action === "members" && subId && method === "POST") {
        const body = await readJson(req);
        return json(200, session.updateMember(account.id, subId, { ...(body.role !== undefined ? { role: body.role as never } : {}), ...(body.discipline !== undefined ? { discipline: body.discipline as never } : {}) }));
      }
      if (action === "capabilities" && subId && subAction === "execute" && method === "POST") {
        const body = await readJson(req);
        audit.record({ actor: account.id, action: "capability.execute", sessionId: session.meta.id, detail: { capabilityId: subId } });
        return json(200, await executeDirect({ registry: platform.registry, store: session.store }, subId, body.input ?? {}, user));
      }
    }

    throw new HttpError(404, `No route for ${method} ${url.pathname}`);
  };

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      const status = err instanceof HttpError ? err.status : err instanceof SessionError ? err.status : err instanceof AuthError ? err.status : err instanceof CapabilityError ? 422 : 400;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      // Error text goes to clients, so make sure no credential can ride along in it.
      res.end(JSON.stringify({ error: redact(err instanceof Error ? err.message : String(err)) }));
    });
  };
  const server: Server = options.tls ? (createHttps({ cert: options.tls.cert, key: options.tls.key }, listener) as unknown as Server) : createHttp(listener);

  const hub = new CollabHub(platform, (req, url) => auth.redeemTicket(url.searchParams.get("ticket") ?? undefined) ?? accountOf(req));
  hub.attach(server);
  (server as Server & { collab?: CollabHub }).collab = hub;
  return server;
}

/** Read TLS material named by TLS_CERT_FILE / TLS_KEY_FILE, if both are configured. */
export function tlsFromEnv(): { cert: Buffer; key: Buffer } | undefined {
  const { TLS_CERT_FILE: cert, TLS_KEY_FILE: key } = process.env;
  if (!cert || !key) return undefined;
  if (!existsSync(cert) || !existsSync(key)) throw new Error("TLS_CERT_FILE / TLS_KEY_FILE point to files that do not exist");
  return { cert: readFileSync(cert), key: readFileSync(key) };
}
