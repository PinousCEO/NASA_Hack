/**
 * Stdio entry point for the "mission-core" MCP server (`npm run mcp`).
 * Exposes capability discovery and every read-only capability. The request pipeline is
 * not exposed over stdio: proposals need the shared workspace process (HTTP `/mcp`) so a
 * human can approve them.
 */
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createApp, PROJECT_ROOT } from "../app.js";
import { createMcpServer } from "./server.js";

const app = createApp({ dataDir: process.env.MISSION_DATA_DIR ?? path.join(PROJECT_ROOT, ".data") });
await app.registry.refreshAvailability();
const server = createMcpServer({ registry: app.registry, store: app.store });
await server.connect(new StdioServerTransport());
