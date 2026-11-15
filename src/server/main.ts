/** Server entry point: `npm run dev`. */
import path from "node:path";
import { PROJECT_ROOT } from "../app.js";
import { McpBridge } from "../mcp/bridge.js";
import { createPlatform } from "../platform/platform.js";
import { loadEnvFile } from "../platform/secrets.js";
import { createPlatformServer, tlsFromEnv } from "./http.js";

loadEnvFile(PROJECT_ROOT);

const port = Number(process.env.PORT ?? 8787);
// Loopback by default. Headsets on the LAN need HOST=0.0.0.0 and TLS (WebXR requires a secure context).
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.MISSION_DATA_DIR ?? path.join(PROJECT_ROOT, ".data");
const tls = tlsFromEnv();

const platform = createPlatform({ dataDir });

const servers = McpBridge.loadConfig(process.env.MISSION_MCP_CONFIG ?? path.join(PROJECT_ROOT, "config", "mcp-servers.json"));
for (const status of await platform.mcp.connectAll(servers)) {
  console.log(status.connected ? `MCP server "${status.name}": ${status.tools} tool(s) registered` : `MCP server "${status.name}" unavailable: ${status.error}`);
}
await platform.registry.refreshAvailability();

const ingest = platform.knowledge.ingestDirectory(platform.documentsDir);
console.log(`Knowledge base: ${ingest.documents} document(s), ${ingest.passages} passage(s)${ingest.skipped.length ? `; skipped ${ingest.skipped.map((s) => `${s.file} (${s.reason})`).join("; ")}` : ""}`);

const all = platform.registry.list();
console.log(`Capabilities: ${all.filter((d) => platform.registry.isUsable(d)).length} usable of ${all.length} registered`);
for (const d of all.filter((c) => !platform.registry.isUsable(c))) {
  console.log(`  - ${d.id}: ${d.developmentStatus === "planned" ? "planned" : "unavailable"} (${d.availability.reason ?? "no reason"})`);
}
const llm = platform.llm.status();
// New mission briefs every day: top up at start-up and every few hours while the server runs.
void platform.briefs.ensureDaily(6).then(() => console.log(`Mission briefs: ${JSON.stringify(platform.briefs.status())}`)).then(() => platform.briefs.backfillWorlds()).then((n) => { if (n) console.log(`Mission briefs: ${n} earlier brief(s) now have a world of their own (place, kind of site, what they need to see).`); });
// The AI keeps writing missions by itself: every 20 minutes it checks whether enough unplayed missions are on the board
// and writes more if not (the same check runs whenever a crew takes one). BRIEF_AUTOGEN=off turns this off;
// BRIEF_DAILY_CAP, when set, bounds how many it may write in a day (no bound by default: it writes only when the board runs low).
if (process.env.BRIEF_AUTOGEN !== "off") {
  const supply = (): void => void platform.briefs.keepSupplied((id) => (platform.sessions.briefStats()[id]?.crews ?? 0) > 0, process.env.BRIEF_DAILY_CAP ? { dailyCap: Number(process.env.BRIEF_DAILY_CAP) } : {}).then((made) => { if (made.length) console.log(`New mission(s) on the board: ${made.map((b) => `${b.title} (${b.origin})`).join("; ")}`); });
  setInterval(supply, 20 * 60 * 1000).unref();
}
// What the model has been asked so far, every ten minutes while there is something new to report.
let reported = 0;
setInterval(() => { const u = platform.llm.usage?.(); if (u && u.calls > reported) { reported = u.calls; console.log(`Language model so far: ${u.calls} requests · ${u.inputTokens} input tokens (${u.cachedInputTokens} cached) · ${u.outputTokens} output tokens (${u.reasoningTokens} reasoning) · ${Object.entries(u.byPurpose).map(([k, v]) => `${k}: ${v.calls}`).join(", ")}`); } }, 10 * 60 * 1000).unref();
console.log(llm.available ? `Language model: ${platform.llm.modelId}` : `Language model unavailable — using the rule-based analyser. ${llm.reason}`);
const chain = platform.audit.verify();
console.log(chain.ok ? `Audit log: ${chain.entries} entr${chain.entries === 1 ? "y" : "ies"}, chain intact` : `AUDIT LOG CHAIN BROKEN at entry ${chain.brokenAt}`);
if (platform.auth.accountCount === 0) console.log("No accounts yet: the first account registered becomes the administrator.");

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const server = createPlatformServer(platform, { allowedOrigins, ...(tls ? { tls } : {}) });
server.listen(port, host, () => {
  const scheme = tls ? "https" : "http";
  console.log(`Mission platform: ${scheme}://${host}:${port}/   API: /api   WebSocket: /ws   MCP: /mcp?session=<id>`);
  if (!tls && host !== "127.0.0.1" && host !== "localhost") console.log("Warning: serving plain HTTP on a non-loopback address. WebXR and secure cookies need TLS (TLS_CERT_FILE / TLS_KEY_FILE).");
});

const shutdown = (): void => {
  server.close();
  void platform.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
