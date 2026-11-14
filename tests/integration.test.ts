/** HTTP API, WebSocket broadcast and MCP (server + client bridge) integration, over real transports. */
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type App, createApp, PROJECT_ROOT } from "../src/app.js";
import type { LlmService } from "../src/llm/llm.js";
import { executeDirect } from "../src/registry/direct.js";
import { createHttpServer } from "../src/server/http.js";

const noLlm: LlmService = { modelId: "none", status: () => ({ available: false, reason: "No credentials in test" }), structured: async () => { throw new Error("LLM must not be called"); } };
const lead = { id: "lead-1", role: "lead" };
const engineer = { id: "eng-1", role: "engineer" };

let app: App;
let base: string;
let server: ReturnType<typeof createHttpServer>;

beforeAll(async () => {
  app = createApp({ llm: noLlm });
  server = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await app.close();
});

const api = async (method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${route}`, { method, ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json() };
};

describe("HTTP API and WebSocket broadcast", () => {
  it("serves discovery, schema inspection and direct execution", async () => {
    const health = await api("GET", "/api/health");
    expect(health.body).toMatchObject({ ok: true, missionVersion: 1, llm: { available: false } });
    const found = await api("GET", "/api/capabilities?q=eclipse%20power%20budget&usable=1");
    expect(found.body[0].id).toBe("science.power.budget");
    const described = await api("GET", "/api/capabilities/science.comms.link_budget");
    expect(described.body.inputSchema.required).toContain("frequencyGHz");
    const executed = await api("POST", "/api/capabilities/science.orbit.hohmann/execute", { user: engineer, input: { body: "moon", r1Km: 1837.4, r2Km: 1937.4 } });
    expect(executed.body.verification).toBe("deterministic_calculation");
    expect(executed.body.output.totalDeltaVKmS).toBeGreaterThan(0.03);
    expect((await api("POST", "/api/capabilities/science.orbit.hohmann/execute", { input: {} })).status).toBe(401);
    expect((await api("GET", "/api/capabilities/nope")).status).toBe(404);
  });

  it("records human-authored knowledge without overstating its verification", async () => {
    const hypothesis = await api("POST", "/api/memory", { user: engineer, kind: "hypothesis", summary: "A frozen orbit would cut station-keeping delta-v", verification: "independently_verified", references: ["doi:x"] });
    expect(hypothesis.status).toBe(403); // an engineer cannot self-certify
    const stored = await api("POST", "/api/memory", { user: engineer, kind: "hypothesis", summary: "A frozen orbit would cut station-keeping delta-v" });
    expect(stored.status).toBe(201);
    expect(stored.body).toMatchObject({ kind: "hypothesis", verification: "unverified", provenance: { source: "user:eng-1" } });
    const evidence = await api("POST", "/api/memory", { user: lead, kind: "scientific_evidence", summary: "Frozen lunar orbits exist near 86 degrees inclination", verification: "independently_verified", references: ["Folta & Quinn 2006"] });
    expect(evidence.body.verification).toBe("independently_verified");
    const found = await api("GET", "/api/memory/search?q=frozen%20orbit");
    expect(found.body.map((m: { record: { kind: string } }) => m.record.kind).sort()).toEqual(["hypothesis", "scientific_evidence"]);
    expect((await api("POST", "/api/memory", { user: engineer, kind: "plan", summary: "x" })).status).toBe(400);
  });

  it("serves the web workspace and refuses path traversal", async () => {
    const page = await fetch(`${base}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect((await fetch(`${base}/..%2Fpackage.json`)).status).toBe(404);
    expect((await fetch(`${base}/assets/..%2F..%2Fpackage.json`)).status).toBe(404);
  });

  it("broadcasts the approved configuration and recalculated results to every connected client", async () => {
    const open = async (): Promise<{ socket: WebSocket; messages: any[] }> => {
      const socket = new WebSocket(`${base.replace("http", "ws")}/ws`);
      const messages: any[] = [];
      socket.on("message", (data) => messages.push(JSON.parse(String(data))));
      await new Promise((resolve, reject) => socket.once("open", resolve).once("error", reject));
      return { socket, messages };
    };
    const mr = await open(); // stands in for an MR headset
    const web = await open(); // and a browser client
    const until = async (predicate: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(predicate()).toBe(true);
    };
    await until(() => mr.messages.some((m) => m.type === "mission.snapshot") && web.messages.some((m) => m.type === "mission.snapshot"));

    const request = await api("POST", "/api/requests", { text: "Set orbit altitude to 200 km", user: engineer, wait: true });
    expect(request.status).toBe(202);
    expect(request.body.status).toBe("awaiting_approval");
    const proposal = await api("GET", `/api/proposals/${request.body.proposalId}`);
    expect(proposal.body.preview.explanation.length).toBeGreaterThan(2);
    await until(() => web.messages.some((m) => m.type === "proposal.created"));
    expect(web.messages.some((m) => m.type === "mission.version_published")).toBe(false); // nothing deployed before approval

    expect((await api("POST", `/api/proposals/${proposal.body.id}/approve`, { user: engineer, reason: "ok" })).status).toBe(400);
    const approved = await api("POST", `/api/proposals/${proposal.body.id}/approve`, { user: lead, reason: "Approved for relay coverage" });
    expect(approved.body.version).toBe(2);

    for (const client of [mr, web]) {
      await until(() => client.messages.some((m) => m.type === "mission.version_published"));
      const message = client.messages.find((m) => m.type === "mission.version_published").mission;
      expect(message.version).toBe(2);
      expect(message.config.orbit.semiMajorAxisKm).toBe(1937.4);
      // The broadcast carries recalculated simulation results, not just the visual change.
      expect(message.recalculated).toEqual(expect.arrayContaining(["orbit.elements", "orbit.eclipse", "power.budget", "comms.link"]));
      expect(message.derived["orbit.elements"].value.periodS).toBeGreaterThan(7500);
    }

    const trace = await api("GET", `/api/requests/${request.body.id}/trace`);
    const stages = new Set(trace.body.map((e: { stage: string }) => e.stage));
    for (const stage of ["state", "analysis", "selection", "feasibility", "execution", "test", "decision", "deployment"]) expect(stages.has(stage), stage).toBe(true);

    expect((await api("POST", "/api/mission/rollback", { user: engineer, version: 1 })).status).toBe(403);
    const rolledBack = await api("POST", "/api/mission/rollback", { user: lead, version: 1, reason: "integration test" });
    expect(rolledBack.body).toMatchObject({ version: 3, rollbackOf: 1 });
    await until(() => mr.messages.filter((m) => m.type === "mission.version_published").length === 2);
    expect((await api("GET", "/api/mission/versions")).body.map((v: { version: number }) => v.version)).toEqual([1, 2, 3]);
    mr.socket.close();
    web.socket.close();
  });
});

describe("MCP", () => {
  it("discovers and calls tools on an external MCP server over stdio", async () => {
    // The project's own stdio server is launched as a separate process and treated as external.
    const status = await app.mcp.connect({
      name: "peer",
      transport: { type: "stdio", command: process.execPath, args: ["--import", "tsx", path.join(PROJECT_ROOT, "src", "mcp", "stdio.ts")], cwd: PROJECT_ROOT, env: { MISSION_DATA_DIR: path.join(app.assetsDir, "..", "peer-data") } },
      provides: { science_orbit_hohmann: ["calc.orbit.transfer"] },
    });
    expect(status.connected).toBe(true);
    expect(status.tools).toBeGreaterThan(8);

    const discovered = app.registry.search({ category: "mcp_server" }).map((m) => m.descriptor);
    const tool = discovered.find((d) => d.id === "mcp.peer.science_orbit_elements")!;
    expect(tool.source).toEqual({ type: "mcp", server: "peer", tool: "science_orbit_elements" });
    expect(tool.inputSchema).toMatchObject({ type: "object", required: expect.arrayContaining(["body", "semiMajorAxisKm"]) });
    expect(tool.outputVerification).toBe("unverified"); // external output is not trusted by default
    expect(discovered.some((d) => d.id.includes("propose_patch"))).toBe(false); // staging tools are not exported

    const result = await executeDirect(app, tool.id, { body: "earth", semiMajorAxisKm: 42164.17, eccentricity: 0 }, { id: "eng-1", role: "engineer" });
    expect(Math.abs((result.output as { output: { periodS: number } }).output.periodS - 86164.1)).toBeLessThan(5);
    expect(result.provenance.source).toBe("mcp:peer");
    await expect(executeDirect(app, tool.id, { body: "earth" }, { id: "eng-1", role: "engineer" })).rejects.toThrow(/Invalid input/);

    // The externally provided tool is now an alternative for the same need (failure recovery).
    expect(app.registry.alternatives("science.orbit.hohmann").map((d) => d.id)).toContain("mcp.peer.science_orbit_hohmann");
    expect(app.registry.resolve("calc.orbit.transfer")!.id).toBe("science.orbit.hohmann"); // deterministic internal ranks first

    await app.mcp.disconnect("peer");
    expect(app.registry.search({ category: "mcp_server" })).toHaveLength(0);
  }, 60000);

  it("serves the pipeline to MCP clients over Streamable HTTP, without exposing approval", async () => {
    const status = await app.mcp.connect({ name: "self_http", transport: { type: "http", url: `${base}/mcp` } });
    expect(status.connected).toBe(true);
    const ids = app.registry.search({ category: "mcp_server" }).map((m) => m.descriptor.id);
    expect(ids).toEqual(expect.arrayContaining(["mcp.self_http.registry_search", "mcp.self_http.registry_describe", "mcp.self_http.mission_request", "mcp.self_http.request_trace"]));
    expect(ids.some((id) => /approve/.test(id))).toBe(false);

    const user = { id: "eng-1", role: "engineer" as const };
    const search = await executeDirect(app, "mcp.self_http.registry_search", { text: "rover slope", usableOnly: true }, user);
    expect((search.output as { id: string }[])[0]!.id).toBe("science.rover.mobility");
    const submitted = await executeDirect(app, "mcp.self_http.mission_request", { text: "Compute the link budget" }, user);
    expect(submitted.output).toMatchObject({ status: "completed", tasks: [{ capabilityId: "science.comms.link_budget", status: "succeeded", verification: "deterministic_calculation" }] });
    await app.mcp.disconnect("self_http");
  }, 60000);

  it("reports a server that cannot be reached instead of failing startup", async () => {
    const statuses = await app.mcp.connectAll([{ name: "ghost", description: "", transport: { type: "stdio", command: "definitely-not-a-real-binary-xyz", args: [] }, provides: {}, outputVerification: "unverified", timeoutMs: 3000, enabled: true }]);
    expect(statuses.find((s) => s.name === "ghost")).toMatchObject({ connected: false, tools: 0 });
    expect(app.registry.search({ category: "mcp_server" })).toHaveLength(0);
  }, 30000);
});
