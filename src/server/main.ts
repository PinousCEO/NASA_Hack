/** Server entry point: `npm run dev`. */
import path from "node:path";
import { createApp, PROJECT_ROOT } from "../app.js";
import { McpBridge } from "../mcp/bridge.js";
import { createHttpServer } from "./http.js";

const port = Number(process.env.PORT ?? 8787);
// Loopback by default: the API trusts the caller's stated identity (see http.ts).
const host = process.env.HOST ?? "127.0.0.1";
const dataDir = process.env.MISSION_DATA_DIR ?? path.join(PROJECT_ROOT, ".data");

const app = createApp({ dataDir });

const servers = McpBridge.loadConfig(process.env.MISSION_MCP_CONFIG ?? path.join(PROJECT_ROOT, "config", "mcp-servers.json"));
for (const status of await app.mcp.connectAll(servers)) {
  console.log(status.connected ? `MCP server "${status.name}": ${status.tools} tool(s) registered` : `MCP server "${status.name}" unavailable: ${status.error}`);
}
await app.registry.refreshAvailability();

const usable = app.registry.list().filter((d) => app.registry.isUsable(d));
console.log(`Capabilities: ${usable.length} usable of ${app.registry.list().length} registered`);
for (const d of app.registry.list().filter((c) => !app.registry.isUsable(c))) {
  console.log(`  - ${d.id}: ${d.developmentStatus === "planned" ? "planned" : "unavailable"} (${d.availability.reason ?? "no reason"})`);
}
const llm = app.llm.status();
console.log(llm.available ? `Language model: ${app.llm.modelId}` : `Language model unavailable — using the rule-based analyser. ${llm.reason}`);

const server = createHttpServer(app);
server.listen(port, host, () => {
  console.log(`Mission "${app.store.head().config.meta.name}" at version ${app.store.head().version}`);
  console.log(`Workspace: http://${host}:${port}/   API: /api   WebSocket: /ws   MCP: /mcp`);
});

const shutdown = (): void => {
  server.close();
  void app.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
