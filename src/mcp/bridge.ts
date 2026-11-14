/**
 * MCP client bridge: connects to any number of external MCP servers and registers each of
 * their tools as a capability, discovered at runtime from the server's own tool list.
 * Nothing about an external tool is hard-coded; its schemas come from the server.
 */
import { existsSync, readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Ajv, type ValidateFunction } from "ajv";
import { z } from "zod";
import { CapabilityError, type JsonSchema, nowIso } from "../core/types.js";
import type { Capability, CapabilityDescriptor } from "../registry/capability.js";
import type { CapabilityRegistry } from "../registry/registry.js";

const verificationLevel = z.enum(["independently_verified", "deterministic_calculation", "external_data", "heuristic", "model_judgment", "unverified"]);

const ServerConfig = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "server name must be lowercase letters, digits or underscore"),
  description: z.string().default(""),
  transport: z.discriminatedUnion("type", [
    z.object({ type: z.literal("stdio"), command: z.string(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).optional(), cwd: z.string().optional() }),
    z.object({ type: z.literal("http"), url: z.url() }),
  ]),
  /** Semantic tags per tool, so recipe-based planning can select external tools. */
  provides: z.record(z.string(), z.array(z.string())).default({}),
  /** What kind of evidence this server's outputs constitute. Defaults to unverified. */
  outputVerification: verificationLevel.default("unverified"),
  timeoutMs: z.number().int().positive().default(30000),
  enabled: z.boolean().default(true),
});
export const McpConfigSchema = z.object({ servers: z.array(ServerConfig).default([]) });
export type McpServerConfig = z.infer<typeof ServerConfig>;

export interface McpConnectionStatus {
  name: string;
  connected: boolean;
  tools: number;
  error?: string;
  connectedAt?: string;
}

const sanitize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool";

export class McpBridge {
  private readonly clients = new Map<string, Client>();
  private readonly status = new Map<string, McpConnectionStatus>();
  private readonly ajv = new Ajv({ strict: false, allErrors: true });

  constructor(private readonly registry: CapabilityRegistry) {}

  static loadConfig(file: string): McpServerConfig[] {
    if (!existsSync(file)) return [];
    return McpConfigSchema.parse(JSON.parse(readFileSync(file, "utf8"))).servers.filter((s) => s.enabled);
  }

  statuses(): McpConnectionStatus[] {
    return [...this.status.values()];
  }

  /** Connect to every configured server. A server that fails to connect is reported, not fatal. */
  async connectAll(servers: McpServerConfig[]): Promise<McpConnectionStatus[]> {
    await Promise.all(servers.map((s) => this.connect(s).catch(() => undefined)));
    return this.statuses();
  }

  async connect(configInput: z.input<typeof ServerConfig>): Promise<McpConnectionStatus> {
    const config = ServerConfig.parse(configInput);
    await this.disconnect(config.name);
    const client = new Client({ name: "mission-ai-core", version: "0.1.0" }, { capabilities: {} });
    const transport =
      config.transport.type === "stdio"
        ? new StdioClientTransport({
            command: config.transport.command,
            args: config.transport.args,
            ...(config.transport.env ? { env: { ...(process.env as Record<string, string>), ...config.transport.env } } : {}),
            ...(config.transport.cwd ? { cwd: config.transport.cwd } : {}),
            stderr: "ignore",
          })
        : new StreamableHTTPClientTransport(new URL(config.transport.url));
    try {
      await client.connect(transport);
      const tools: { name: string; description?: string; inputSchema: JsonSchema; outputSchema?: JsonSchema }[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...(page.tools as typeof tools));
        cursor = page.nextCursor;
      } while (cursor);
      for (const tool of tools) this.registry.register(this.toCapability(config, client, tool));
      this.clients.set(config.name, client);
      client.onclose = () => {
        // Keep the capabilities listed but mark them unavailable so planners route around them.
        for (const d of this.registry.list()) {
          if (d.source.type === "mcp" && d.source.server === config.name) this.registry.setAvailability(d.id, "unavailable", "MCP server connection closed");
        }
        const s = this.status.get(config.name);
        if (s) this.status.set(config.name, { ...s, connected: false, error: "connection closed" });
      };
      const status: McpConnectionStatus = { name: config.name, connected: true, tools: tools.length, connectedAt: nowIso() };
      this.status.set(config.name, status);
      return status;
    } catch (err) {
      await client.close().catch(() => undefined);
      this.registry.unregisterSource(config.name);
      const status: McpConnectionStatus = { name: config.name, connected: false, tools: 0, error: err instanceof Error ? err.message : String(err) };
      this.status.set(config.name, status);
      throw new Error(`MCP server "${config.name}" failed to connect: ${status.error}`);
    }
  }

  async disconnect(name: string): Promise<void> {
    const client = this.clients.get(name);
    if (client) {
      client.onclose = undefined;
      await client.close().catch(() => undefined);
      this.clients.delete(name);
    }
    this.registry.unregisterSource(name);
    this.status.delete(name);
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.keys()].map((name) => this.disconnect(name)));
  }

  private toCapability(config: McpServerConfig, client: Client, tool: { name: string; description?: string; inputSchema: JsonSchema; outputSchema?: JsonSchema }): Capability {
    let validate: ValidateFunction | null = null;
    try {
      validate = this.ajv.compile(tool.inputSchema);
    } catch {
      validate = null; // an uncompilable schema is reported in the descriptor; the server still validates
    }
    const descriptor: CapabilityDescriptor = {
      id: `mcp.${config.name}.${sanitize(tool.name)}`,
      name: tool.name,
      description: tool.description ?? `Tool "${tool.name}" from MCP server "${config.name}"`,
      category: "mcp_server",
      provides: config.provides[tool.name] ?? [],
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? {},
      dependencies: [`MCP server "${config.name}" (${config.transport.type})`],
      requiredPermissions: ["network:external"],
      resources: { network: config.transport.type === "http", cpu: "low", typicalDurationMs: 1000 },
      // Side effects of an external tool are unknown, so it is never retried blindly.
      constraints: { timeoutMs: config.timeoutMs, maxRetries: 0, idempotent: false, effect: "external_read" },
      availability: { status: "available", checkedAt: nowIso() },
      version: client.getServerVersion()?.version ?? "unknown",
      verification: { status: "unverified", method: validate ? "Schema discovered from the server; behaviour not independently tested" : "Input schema could not be compiled locally" },
      developmentStatus: "implemented",
      outputVerification: config.outputVerification,
      source: { type: "mcp", server: config.name, tool: tool.name },
    };
    return {
      descriptor,
      validateInput: (input) => {
        if (!validate) return { ok: true, errors: [], value: input };
        return validate(input)
          ? { ok: true, errors: [], value: input }
          : { ok: false, errors: (validate.errors ?? []).map((e) => `${e.instancePath || "(input)"} ${e.message ?? "is invalid"}`) };
      },
      execute: async (input, ctx) => {
        let result: Awaited<ReturnType<Client["callTool"]>>;
        try {
          result = await client.callTool({ name: tool.name, arguments: (input ?? {}) as Record<string, unknown> }, undefined, { signal: ctx.signal, timeout: config.timeoutMs });
        } catch (err) {
          throw new CapabilityError(`MCP tool "${tool.name}" on "${config.name}" failed: ${err instanceof Error ? err.message : String(err)}`, { code: "mcp_call_failed" });
        }
        const content = (result.content ?? []) as { type: string; text?: string }[];
        const text = content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
        if (result.isError) throw new CapabilityError(`MCP tool "${tool.name}" reported an error: ${text || "no details"}`, { code: "mcp_tool_error" });
        let output: unknown = result.structuredContent;
        if (output === undefined) {
          try {
            output = JSON.parse(text);
          } catch {
            output = { text, content };
          }
        }
        return {
          output,
          verification: config.outputVerification,
          assumptions: config.outputVerification === "unverified" ? [`Output of external MCP tool "${tool.name}" has not been verified`] : [],
          provenance: { source: `mcp:${config.name}`, capabilityId: descriptor.id, capabilityVersion: descriptor.version, retrievedAt: nowIso() },
        };
      },
      healthCheck: async () => {
        try {
          await client.ping({ timeout: 5000 });
          return { status: "available" };
        } catch (err) {
          return { status: "unavailable", reason: `MCP server "${config.name}" did not answer ping: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    };
  }
}
