/**
 * MCP server exposing this system to MCP clients as one logically grouped server
 * ("mission-core"): every usable read-only capability is a tool, generated from the
 * registry at request time, plus registry discovery tools and (optionally) the request
 * pipeline. Capabilities that stage changes are reachable only through `mission_request`,
 * and approval is deliberately not exposed: a human approves in the workspace.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { JsonSchema, Role, User } from "../core/types.js";
import type { RequestService } from "../pipeline/service.js";
import { executeDirect } from "../registry/direct.js";
import type { CapabilityRegistry } from "../registry/registry.js";
import type { MissionStore } from "../state/store.js";

export interface McpServerDeps {
  registry: CapabilityRegistry;
  store: MissionStore;
  /** When provided, the natural-language request pipeline is exposed as tools. */
  requests?: RequestService;
  user?: User;
}

const toToolName = (capabilityId: string): string => capabilityId.replace(/\./g, "_");

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export function createMcpServer(deps: McpServerDeps): Server {
  const user: User = deps.user ?? { id: "mcp-client", role: (process.env.MISSION_MCP_ROLE as Role | undefined) ?? "engineer" };
  const server = new Server({ name: "mission-core", version: "0.1.0" }, { capabilities: { tools: {} } });

  const tools = (): ToolDef[] => {
    const meta: ToolDef[] = [
      {
        name: "registry_search",
        description: "Discover capabilities by free text, category or provided tag. Returns ids, descriptions, availability and evidence level.",
        inputSchema: { type: "object", properties: { text: { type: "string" }, category: { type: "string" }, provides: { type: "string" }, usableOnly: { type: "boolean" } }, additionalProperties: false },
        run: async (a) =>
          deps.registry
            .search({
              ...(typeof a.text === "string" ? { text: a.text } : {}),
              ...(typeof a.category === "string" ? { category: a.category as never } : {}),
              ...(typeof a.provides === "string" ? { provides: a.provides } : {}),
              usableOnly: a.usableOnly === true,
            })
            .map(({ descriptor: d, score }) => ({ id: d.id, name: d.name, description: d.description, category: d.category, provides: d.provides, availability: d.availability.status, developmentStatus: d.developmentStatus, outputVerification: d.outputVerification, score })),
      },
      {
        name: "registry_describe",
        description: "Full metadata for one capability: input/output schema, dependencies, permissions, resources, constraints, availability, version and verification status.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        run: async (a) => deps.registry.describe(String(a.id)) ?? { error: `Unknown capability "${String(a.id)}"` },
      },
    ];
    if (deps.requests) {
      const requests = deps.requests;
      meta.push(
        {
          name: "mission_request",
          description: "Submit a natural-language engineering request. It is analysed, checked for feasibility, planned and executed; any mission change stops at 'awaiting_approval' for a human to approve in the workspace.",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
          run: async (a) => {
            const record = await requests.wait(requests.submit({ text: String(a.text), user }).id);
            return { id: record.id, status: record.status, summary: record.requirement?.summary, missingInformation: record.requirement?.missingInformation, feasibility: record.feasibility, tasks: record.plan?.tasks.map((t) => ({ id: t.id, capabilityId: t.capabilityId, status: t.status, output: t.result?.output, verification: t.result?.verification, error: t.error })), proposalId: record.proposalId, error: record.error };
          },
        },
        {
          name: "request_trace",
          description: "Observability trace of a request: tools selected and why, inputs, outputs, tests and decisions.",
          inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
          run: async (a) => requests.get(String(a.id))?.trace ?? { error: "Unknown request" },
        },
      );
    }
    const direct: ToolDef[] = deps.registry
      .list()
      .filter((d) => d.source.type === "internal" && deps.registry.isUsable(d) && d.constraints.effect !== "draft_write")
      .map((d) => ({
        name: toToolName(d.id),
        description: `${d.description} [evidence: ${d.outputVerification.replace(/_/g, " ")}; v${d.version}]`,
        inputSchema: d.inputSchema,
        run: async (args) => {
          const result = await executeDirect(deps, d.id, args, user);
          return { output: result.output, verification: result.verification, assumptions: result.assumptions, provenance: result.provenance };
        },
      }));
    return [...meta, ...direct];
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema: { type: "object", ...inputSchema } })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools().find((t) => t.name === request.params.name);
    if (!tool) return { isError: true, content: [{ type: "text", text: `Unknown tool "${request.params.name}"` }] };
    try {
      const result = await tool.run(request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }] };
    }
  });

  return server;
}
