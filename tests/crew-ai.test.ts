/**
 * Each crew member's AI: its own conversation, private until shared; operations that validation
 * rejects go back to the model for a corrected attempt; control logic is flown before it is offered;
 * a failing language model is reported and the next request still works.
 *
 * The language model here is a test double that answers from the prompt it is given, so that what
 * the server sends to the model (whose history, which validation errors) can be asserted.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { z } from "zod";
import type { LlmService } from "../src/llm/llm.js";
import { createPlatform, type Platform } from "../src/platform/platform.js";
import { createPlatformServer } from "../src/server/http.js";

interface Client { cookie: string; account: { id: string }; api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> }
let base = "";
async function signUp(username: string): Promise<Client> {
  const res = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "integration-test-password-1", displayName: username.toUpperCase() }) });
  if (res.status !== 201) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const account = ((await res.json()) as { account: { id: string } }).account;
  return { cookie, account, api: async (method, route, body) => {
    const r = await fetch(`${base}${route}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  } };
}
async function listen(client: Client, sessionId: string): Promise<{ ws: WebSocket; messages: any[]; until(p: (m: any) => boolean, label?: string): Promise<any> }> {
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws?session=${sessionId}`, { headers: { cookie: client.cookie } });
  const messages: any[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(String(d))));
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  return { ws, messages, until: async (p, label = "message") => {
    for (let i = 0; i < 500; i++) { const hit = messages.find(p); if (hit) return hit; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error(`Timed out waiting for ${label}`);
  } };
}

/** What the test double was asked, in order, and how it answers analysis prompts. */
const seen: { system: string; prompt: string }[] = [];
let analyse: (prompt: string) => unknown = () => ({ summary: "nothing", operations: [], missingInformation: [], directReply: "ok" });
let broken = false;
/** Modules the test double hands back, in order, when asked to write a script. */
const modules: { source: string; explanation: string; testInputJson: string }[] = [];
const llm: LlmService = {
  modelId: "scripted-test-model",
  status: () => ({ available: true }),
  structured: async <S extends z.ZodType>(args: { system: string; prompt: string; schema: S }): Promise<z.infer<S>> => {
    seen.push({ system: args.system, prompt: args.prompt });
    if (broken) throw new Error("upstream model unavailable (503)");
    if (args.system.includes("structured operations")) return args.schema.parse(analyse(args.prompt));
    if (args.system.includes("You write small TypeScript modules")) return args.schema.parse(modules.shift());
    // wording prompts: any object with an "answer" string
    return args.schema.parse({ answer: "Worded reply from the test double." });
  },
};
const userRequest = (prompt: string): string => /User request:\n([^\n]*)/.exec(prompt)?.[1] ?? "";
const op = (intent: string, params: unknown, description = intent) => ({ category: "engineering_design", intent, description, paramsJson: JSON.stringify(params), assumptions: [] });

describe("each crew member's own AI", () => {
  let platform: Platform;
  let server: Server;
  let ana: Client, ben: Client;
  let sid = "";

  beforeAll(async () => {
    platform = createPlatform({ llm });
    server = createPlatformServer(platform, { webDir: path.join(os.tmpdir(), "no-web-build-here") });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    ana = await signUp("ana");
    ben = await signUp("ben");
    const created = await ana.api("POST", "/api/sessions", { scenarioId: "lunar-volatiles", name: "Crew AI", seed: 4, difficulty: "cadet", visibility: "public" });
    sid = created.body.session.id;
    expect((await ben.api("POST", `/api/sessions/${sid}/join`, {})).status).toBeLessThan(300);
  }, 60000);

  afterAll(async () => {
    (server as unknown as { collab: { close(): void } }).collab.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await platform.close();
  });

  it("keeps a conversation private: the other crew member sees a stub over HTTP and over the socket, until it is shared", async () => {
    const benSocket = await listen(ben, sid);
    analyse = () => ({ summary: "answered", operations: [], missingInformation: [], directReply: "The secret answer is 42 W." });
    const asked = await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "ana's private question about margins", wait: true });
    expect(asked.body.answer.text).toBe("The secret answer is 42 W.");
    const id = asked.body.id;
    // Ben, over HTTP.
    const benList = (await ben.api("GET", `/api/sessions/${sid}/requests`)).body;
    const stub = benList.find((r: { id: string }) => r.id === id);
    expect(stub).toMatchObject({ private: true, text: "", user: { id: ana.account.id } });
    expect(JSON.stringify(stub)).not.toMatch(/private question|secret answer/);
    expect((await ben.api("GET", `/api/sessions/${sid}/requests/${id}`)).status).toBe(403);
    expect((await ben.api("POST", `/api/sessions/${sid}/requests/${id}/share`, { shared: true })).status).toBe(403);
    // Ben, over the socket: every update he received about it was a stub.
    const updates = benSocket.messages.filter((m) => m.type === "request.updated" && m.request.id === id);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((m) => m.request.private === true)).toBe(true);
    expect(JSON.stringify(updates)).not.toMatch(/private question|secret answer/);
    // Nor does the research record give it away: the entry for what Ana asked is listed for Ana only.
    const benResearch = (await ben.api("GET", "/api/research")).body.records;
    const anaResearch = (await ana.api("GET", "/api/research")).body.records;
    expect(JSON.stringify(benResearch)).not.toMatch(/private question/);
    const entry = anaResearch.find((r: { kind: string; summary: string }) => r.kind === "user_request" && /private question/.test(r.summary));
    expect(entry).toBeTruthy();
    expect((await ben.api("GET", `/api/research/${entry.id}`)).status).toBe(404);
    expect((await ana.api("GET", `/api/research/${entry.id}`)).status).toBe(200);
    // Ana herself sees it all.
    expect((await ana.api("GET", `/api/sessions/${sid}/requests`)).body.find((r: { id: string }) => r.id === id).answer.text).toMatch(/42 W/);
    // Shared: now Ben can read it, live.
    expect((await ana.api("POST", `/api/sessions/${sid}/requests/${id}/share`, { shared: true })).body.shared).toBe(true);
    const shared = await benSocket.until((m) => m.type === "request.updated" && m.request.id === id && m.request.shared === true, "shared conversation");
    expect(shared.request.answer.text).toMatch(/42 W/);
    expect((await ben.api("GET", `/api/sessions/${sid}/requests/${id}`)).status).toBe(200);
    // And taken back.
    await ana.api("POST", `/api/sessions/${sid}/requests/${id}/share`, { shared: false });
    expect((await ben.api("GET", `/api/sessions/${sid}/requests/${id}`)).status).toBe(403);
    benSocket.ws.close();
  });

  it("gives each player their own thread: the model is shown that player's earlier turns and nobody else's", async () => {
    analyse = (prompt) => ({ summary: "answered", operations: [], missingInformation: [], directReply: `reply to: ${userRequest(prompt)}` });
    await ben.api("POST", `/api/sessions/${sid}/requests`, { text: "ben asks about the antenna", wait: true });
    seen.length = 0;
    await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "and what about that?", wait: true });
    const anaPrompt = seen.find((s) => s.system.includes("structured operations"))!.prompt;
    expect(anaPrompt).toMatch(/Your conversation with this player so far/);
    expect(anaPrompt).toMatch(/ana's private question about margins/);
    expect(anaPrompt).toMatch(/The secret answer is 42 W/);
    expect(anaPrompt).not.toMatch(/ben asks about the antenna/);
    seen.length = 0;
    await ben.api("POST", `/api/sessions/${sid}/requests`, { text: "do it", wait: true });
    const benPrompt = seen.find((s) => s.system.includes("structured operations"))!.prompt;
    expect(benPrompt).toMatch(/ben asks about the antenna/);
    expect(benPrompt).not.toMatch(/ana's private question|secret answer/);
    // Each AI knows whose it is: the seat its player took, and who holds the others.
    const seats = (await ana.api("GET", `/api/sessions/${sid}`)).body.session.kit.roles.map((r: { seat: string }) => r.seat);
    expect((await ben.api("POST", `/api/sessions/${sid}/role`, { seat: seats[1] })).status).toBe(200);
    seen.length = 0;
    await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "what should I look at first?", wait: true });
    const forAna = seen.find((s) => s.system.includes("structured operations"))!.prompt;
    expect(forAna).toMatch(/The player you are talking to:\nName: ANA/);
    expect(forAna).toMatch(/They have not taken a seat yet/);
    expect(forAna).toContain(`${seats[1]} (`);
    expect(forAna).toMatch(/held by BEN/);
    seen.length = 0;
    await ben.api("POST", `/api/sessions/${sid}/requests`, { text: "what should I look at first?", wait: true });
    expect(seen.find((s) => s.system.includes("structured operations"))!.prompt).toContain(`Their seat: ${seats[1]} — `);
    // Every character sent to the model is paid for: the whole request (rules + mission + results + catalogue + flight) stays small.
    const sent = seen.find((x) => x.system.includes("structured operations"))!;
    expect(sent.system.length + sent.prompt.length).toBeLessThan(34000);
    // Both read the same shared world.
    expect(benPrompt).toMatch(/"systems":\{"wired":true/);
  });

  it("sends operations that validation rejects back to the model with the reasons, and accepts the corrected attempt", async () => {
    const badLine = { id: "ln-x", kind: "power", from: { node: "bus", port: "power" }, to: { node: "sp1", port: "power_out" }, rating: 100, lengthM: 1 };
    const goodLine = { id: "ln-x", kind: "control", from: { node: "bus", port: "control_out" }, to: { node: "ant1", port: "control_in" }, lengthM: 1 };
    const head = (await ana.api("GET", `/api/sessions/${sid}`)).body.mission.config;
    const antenna = head.spacecraft.components.find((c: { type: string }) => c.type === "antenna");
    const panel = head.spacecraft.components.find((c: { type: string }) => c.type === "solar_panel");
    badLine.to.node = panel.id;
    // The antenna already has its control line; remove it first so the corrected line is new.
    const existing = head.systems.links.find((l: { kind: string; to: { node: string } }) => l.kind === "control" && l.to.node === antenna.id);
    goodLine.to.node = antenna.id;
    let attempts = 0;
    analyse = (prompt) => {
      attempts++;
      const rejected = /rejected by validation:\n- ([^\n]+)/.exec(prompt)?.[1];
      if (!rejected) return { summary: "add a line", operations: [op("set_config", { patches: [{ op: "append", path: "systems.links", value: badLine }] })], missingInformation: [] };
      expect(rejected).toMatch(/is an output; a line must end at an input/);
      return { summary: "replace the control line", operations: [op("set_config", { patches: [{ op: "remove", path: `systems.links.${existing.id}` }, { op: "append", path: "systems.links", value: goodLine }] }, "Replace the antenna's control line")], missingInformation: [] };
    };
    const r = await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "add a line for me", wait: true });
    expect(attempts).toBe(2);
    expect(r.body.requirement.analysis.repairs).toBe(1);
    expect(["published", "awaiting_approval"]).toContain(r.body.status);
    // Three rejected attempts: nothing is built and the reason is passed on, not hidden.
    attempts = 0;
    analyse = () => { attempts++; return { summary: "add a line", operations: [op("set_config", { patches: [{ op: "append", path: "systems.links", value: { ...badLine, id: "ln-y" } }] })], missingInformation: [] }; };
    const before = (await ana.api("GET", `/api/sessions/${sid}`)).body.mission.version;
    const failed = await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "add another line", wait: true });
    expect(attempts).toBe(3);
    expect(failed.body.status).toBe("awaiting_clarification");
    expect(failed.body.answer.text).toMatch(/could not turn that into a change the mission accepts.*must end at an input/);
    expect((await ana.api("GET", `/api/sessions/${sid}`)).body.mission.version).toBe(before);
  });

  it("flies new control logic before offering it, and reports the measured flight in the proposal", async () => {
    const controller = { id: "ctl-test", name: "Night saver", description: "Runs the antenna less while in long shadow.", hostId: "bus", memory: { low: 0 }, rules: [{ when: "eclipse.fraction > 0.01", do: [{ target: "antennas", value: "nominal * 0.5" }], note: "long shadow" }], origin: { kind: "model_generated" } };
    analyse = () => ({ summary: "install control logic", operations: [op("set_config", { patches: [{ op: "append", path: "systems.controllers", value: controller }] }, "Install the Night saver controller")], missingInformation: [] });
    const r = await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "make a controller that halves transmit time in shadow", wait: true });
    expect(r.body.proposalId).toBeTruthy();
    const p = (await ana.api("GET", `/api/sessions/${sid}/proposals/${r.body.proposalId}`)).body;
    const flight = p.tests.find((t: { id: string }) => t.id === "systems.flight");
    expect(flight).toMatchObject({ status: "pass", detail: expect.stringMatching(/Flown for \d+ days: it acted on \d+ day/) });
    expect(p.preview.explanation.join("\n")).toMatch(/Flight test over \d+ days with the same in-flight events/);
    expect(p.preview.explanation.join("\n")).toMatch(/days the control logic acted: 0 → \d+/);
    // A controller that names a signal that does not exist never reaches a proposal.
    analyse = (prompt) => (/rejected by validation/.test(prompt)
      ? { summary: "x", operations: [], missingInformation: [], directReply: "That signal does not exist in this model." }
      : { summary: "install", operations: [op("set_config", { patches: [{ op: "append", path: "systems.controllers", value: { ...controller, id: "ctl-bad", rules: [{ when: "reactor.temperature > 900", do: [{ target: "antennas", value: "0" }] }] } }] })], missingInformation: [] });
    const bad = await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "shut down when the reactor overheats", wait: true });
    expect(bad.body.proposalId).toBeUndefined();
    expect(bad.body.answer.text).toBe("That signal does not exist in this model.");
    expect(seen.some((s) => /"reactor.temperature" is not a signal it can read/.test(s.prompt))).toBe(true);
  });

  it("labels the AI's judgement of an idea: refuted, outside the models, or possible only under a condition — and builds nothing", async () => {
    const before = (await ana.api("GET", `/api/sessions/${sid}`)).body.mission.version;
    for (const [hypothesis, verdict] of [["refuted", "refuted"], ["outside_model", "outside_model"], ["conditional", "conditional"], ["none", "explained"]] as const) {
      analyse = () => ({ summary: "judged", operations: [], missingInformation: [], directReply: `Judged ${hypothesis}.`, hypothesis });
      const r = await ben.api("POST", `/api/sessions/${sid}/requests`, { text: `idea ${hypothesis}`, wait: true });
      expect(r.body.answer.verdict).toBe(verdict);
      expect(r.body.proposalId).toBeUndefined();
    }
    expect((await ana.api("GET", `/api/sessions/${sid}`)).body.mission.version).toBe(before);
    // Ben's refuted idea is his until he shares it; then Ana can read the reason.
    const mine = (await ben.api("GET", `/api/sessions/${sid}/requests`)).body.find((r: { text: string }) => r.text === "idea refuted");
    expect((await ana.api("GET", `/api/sessions/${sid}/requests`)).body.find((r: { id: string }) => r.id === mine.id).private).toBe(true);
    await ben.api("POST", `/api/sessions/${sid}/requests/${mine.id}/share`, { shared: true });
    expect((await ana.api("GET", `/api/sessions/${sid}/requests`)).body.find((r: { id: string }) => r.id === mine.id)).toMatchObject({ text: "idea refuted", answer: { verdict: "refuted", text: "Judged refuted." } });
  });

  it("checks a generated script as it is written and sends what the validator rejects back for a corrected version", async () => {
    const bad = { source: "export function run(): unknown { return window.location.href; }", explanation: "reads the page", testInputJson: "{}" };
    const good = { source: "export function run(): unknown { const b = mission.derived(\"power.budget\"); return { ok: b !== null }; }", explanation: "reads the power budget", testInputJson: "{}" };
    modules.length = 0;
    modules.push(bad, good);
    analyse = () => ({ summary: "write a script", operations: [{ category: "code_generation", intent: "generate_script", description: "Report the power budget", paramsJson: JSON.stringify({ task: "report the power budget", name: "Power report" }), assumptions: [] }], missingInformation: [] });
    seen.length = 0;
    const r = await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "write a script that reports the power budget", wait: true });
    expect(modules).toHaveLength(0); // both were asked for: the rejected one, then the corrected one
    expect(r.body.plan.tasks.map((t: { capabilityId: string; status: string }) => `${t.capabilityId}:${t.status}`)).toEqual(["code.generate_module:succeeded", "code.validate_module:succeeded", "mission.attach_script:succeeded"]);
    const second = seen.filter((x) => x.system.includes("You write small TypeScript modules"))[1]!.prompt;
    expect(second).toMatch(/Your previous module was rejected/);
    expect(second).toMatch(/window/);
    // Three bad attempts: the validation step fails honestly and nothing is attached.
    modules.push(bad, bad, bad);
    const before = (await ana.api("GET", `/api/sessions/${sid}`)).body.mission.version;
    const failed = await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "write another script", wait: true });
    expect(failed.body.plan.tasks.find((t: { capabilityId: string }) => t.capabilityId === "code.validate_module").status).toBe("failed");
    expect(failed.body.proposalId).toBeUndefined();
    expect((await ana.api("GET", `/api/sessions/${sid}`)).body.mission.version).toBe(before);
  });

  it("reports a failing language model as a failure, changes nothing, and recovers on the next request", async () => {
    const before = (await ana.api("GET", `/api/sessions/${sid}`)).body.mission.version;
    broken = true;
    const failed = await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "anything at all", wait: true });
    expect(failed.body.status).toBe("failed");
    expect(failed.body.error).toMatch(/upstream model unavailable/);
    expect((await ana.api("GET", `/api/sessions/${sid}`)).body.mission.version).toBe(before);
    broken = false;
    analyse = () => ({ summary: "answered", operations: [], missingInformation: [], directReply: "Back again." });
    const again = await ana.api("POST", `/api/sessions/${sid}/requests`, { text: "anything at all", wait: true });
    expect(again.body).toMatchObject({ status: "completed", answer: { text: "Back again." } });
  });
});
