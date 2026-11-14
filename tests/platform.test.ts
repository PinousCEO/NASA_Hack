/** Platform integration: science additions, scenarios, auth, audit, sessions, real-time collaboration, game flow, durability, knowledge. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { generateMission, SCENARIOS } from "../src/game/scenarios.js";
import { evaluateMission } from "../src/game/scoring.js";
import { simulateMission } from "../src/game/simulation.js";
import type { LlmService } from "../src/llm/llm.js";
import { exportGmatScript, gmatEpoch, gmatStatus, parseGmatReport } from "../src/nasa/gmat.js";
import { assessConceptMaturity } from "../src/nasa/lifecycle.js";
import { AuditLog } from "../src/platform/audit.js";
import { AuthService } from "../src/platform/auth.js";
import { createPlatform, type Platform } from "../src/platform/platform.js";
import { redact } from "../src/platform/secrets.js";
import { BODIES } from "../src/science/orbital.js";
import { elementsToState, j2SecularRates, propagateJ2, stateToElements } from "../src/science/propagate.js";
import { createPlatformServer } from "../src/server/http.js";
import { engineeringChecks, recalculate } from "../src/state/recalc.js";

const noLlm: LlmService = { modelId: "none", status: () => ({ available: false, reason: "No credentials in test" }), structured: async () => { throw new Error("LLM must not be called"); } };

describe("J2 propagation", () => {
  it("reproduces the sun-synchronous nodal rate (0.9856°/day at 600 km, 97.79°)", () => {
    const rates = j2SecularRates("earth", BODIES.earth.radiusKm + 600, 0, 97.79);
    expect(rates.raanRateDegPerDay).toBeCloseTo(0.9856, 2);
    expect(j2SecularRates("earth", 7000, 0, 90).raanRateDegPerDay).toBeCloseTo(0, 9); // polar orbits do not precess
  });

  it("matches the analytic secular rate numerically and conserves the orbit's size", () => {
    const orbit = { body: "earth" as const, semiMajorAxisKm: 7000, eccentricity: 0.001, inclinationDeg: 51.6, raanDeg: 40, argPeriapsisDeg: 0, trueAnomalyDeg: 0, epoch: "2027-01-01T00:00:00Z" };
    const result = propagateJ2(orbit, 2 * 86400, 10);
    const analytic = j2SecularRates("earth", 7000, 0.001, 51.6).raanRateDegPerDay;
    expect(result.raanDriftDeg / 2).toBeLessThan(0);
    expect(Math.abs(result.raanDriftDeg / 2 - analytic) / Math.abs(analytic)).toBeLessThan(0.03);
    expect(Math.abs(result.final.semiMajorAxisKm - 7000)).toBeLessThan(15); // J2 short-period oscillation only
    expect(result.final.inclinationDeg).toBeCloseTo(51.6, 1);
    expect(result.impacted).toBe(false);
  });

  it("round-trips elements and state, and detects impact", () => {
    const orbit = { body: "moon" as const, semiMajorAxisKm: 1837.4, eccentricity: 0.01, inclinationDeg: 88, raanDeg: 123, argPeriapsisDeg: 30, trueAnomalyDeg: 77, epoch: "2027-01-01T00:00:00Z" };
    const { r, v } = elementsToState(orbit);
    const back = stateToElements("moon", r, v);
    expect(back.semiMajorAxisKm).toBeCloseTo(1837.4, 6);
    expect(back.eccentricity).toBeCloseTo(0.01, 9);
    expect(back.inclinationDeg).toBeCloseTo(88, 9);
    expect(back.raanDeg).toBeCloseTo(123, 9);
    expect(propagateJ2({ ...orbit, eccentricity: 0.08 }, 86400, 20).impacted).toBe(true);
  });
});

describe("GMAT interface", () => {
  const mission = generateMission("lunar-volatiles", 7, "cadet").config;

  it("exports a script with the mission's epoch, frame, elements and force model", () => {
    const script = exportGmatScript(mission, { durationDays: 2, gravityDegree: 20, gravityOrder: 20 });
    expect(gmatEpoch("2027-03-01T06:30:15.250Z")).toBe("01 Mar 2027 06:30:15.250");
    for (const line of ["Create Spacecraft Sat;", "GMAT LunaInertial.Origin = Luna;", "GMAT Sat.CoordinateSystem = LunaInertial;", `GMAT Sat.SMA = ${mission.orbit.semiMajorAxisKm};`, `GMAT Sat.INC = ${mission.orbit.inclinationDeg};`, "GMAT FM.CentralBody = Luna;", "GMAT FM.GravityField.Luna.Degree = 20;", "GMAT FM.PointMasses = {Sun, Earth};", "BeginMissionSequence;", "Propagate Prop(Sat) {Sat.ElapsedDays = 2};"]) {
      expect(script, line).toContain(line);
    }
    expect(exportGmatScript(generateMission("leo-cubesat", 1).config, { durationDays: 1 })).toContain("GMAT Sat.CoordinateSystem = EarthMJ2000Eq;");
  });

  it("parses a ReportFile into trajectory samples and rejects other text", () => {
    const report = ["Sat.ElapsedSecs          Sat.LunaInertial.X       Sat.LunaInertial.Y       Sat.LunaInertial.Z       Sat.LunaInertial.VX      Sat.LunaInertial.VY      Sat.LunaInertial.VZ", "0                        1837.4                   0                        0                        0                        1e-16                    1.6335", "60                       1834.78                  0                        97.98                    -0.0871                  0                        1.6312"].join("\n");
    const parsed = parseGmatReport(report);
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.samples[1]).toEqual({ elapsedS: 60, positionKm: [1834.78, 0, 97.98], velocityKmS: [-0.0871, 0, 1.6312] });
    expect(() => parseGmatReport("not a report")).toThrow(/Not a recognised GMAT ReportFile/);
  });

  it("reports GMAT itself as unavailable rather than imitating it", async () => {
    expect(gmatStatus().available).toBe(false);
    const platform = createPlatform({ llm: noLlm });
    const cap = platform.registry.get("gmat.run")!;
    const health = await cap.healthCheck!();
    platform.registry.setAvailability("gmat.run", health.status, health.reason);
    expect(platform.registry.isUsable(cap.descriptor)).toBe(false);
    expect(cap.descriptor.availability.reason).toMatch(/GMAT_BIN/);
    expect(platform.registry.isUsable(platform.registry.get("gmat.export_script")!.descriptor)).toBe(true);
    await platform.close();
  });
});

describe("scenarios, simulation and scoring", () => {
  it("generates a valid, internally consistent mission for every scenario and difficulty", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.objectives.reduce((s, o) => s + o.weight, 0), scenario.id).toBe(100);
      for (const difficulty of ["cadet", "engineer", "chief"] as const) {
        for (const seed of [1, 2, 3, 99]) {
          const m = generateMission(scenario.id, seed, difficulty);
          const { derived } = recalculate(m.config);
          for (const [id, node] of Object.entries(derived)) expect(node.error, `${scenario.id}/${difficulty}/${seed}/${id}`).toBeUndefined();
        }
      }
      // The untouched starting design is viable on the easiest setting: no violated constraints.
      const cadet = generateMission(scenario.id, 1, "cadet");
      expect(engineeringChecks(cadet.config, recalculate(cadet.config).derived).filter((c) => c.status === "fail").map((c) => c.id), scenario.id).toEqual([]);
    }
  });

  it("is reproducible from a seed and varies between seeds", () => {
    expect(generateMission("lunar-volatiles", 42)).toEqual(generateMission("lunar-volatiles", 42));
    const budgets = new Set([1, 2, 3, 4, 5, 6].map((s) => generateMission("lunar-volatiles", s).config.meta.budgetMusd));
    expect(budgets.size).toBeGreaterThan(2);
    expect(generateMission("lunar-volatiles", 5, "chief").config.meta.budgetMusd!).toBeLessThan(generateMission("lunar-volatiles", 5, "cadet").config.meta.budgetMusd!);
  });

  it("simulates the mission day by day, consistently with the single-epoch models", () => {
    const { config } = generateMission("lunar-volatiles", 1, "cadet");
    const sim = simulateMission(config);
    expect(sim.days).toBe(365);
    expect(sim.timeline[0]!.marginW).toBeCloseTo((recalculate(config).derived["power.budget"]!.value as { marginW: number }).marginW, 6);
    const betas = sim.timeline.map((t) => t.betaDeg);
    expect(Math.max(...betas) - Math.min(...betas)).toBeGreaterThan(90); // a polar lunar orbit sweeps the full beta cycle in a year
    expect(sim.timeline.find((t) => Math.abs(t.betaDeg) > 80)!.eclipseFraction).toBe(0);
    expect(sim.kpis.totalDataReturnedGb).toBe(0); // no instruments on the starting design
    // An undersized array fails in eclipse season and the simulation says when.
    const weak = simulateMission({ ...config, spacecraft: { ...config.spacecraft, components: config.spacecraft.components.map((c) => (c.type === "solar_panel" ? { ...c, areaM2: 0.45 } : c)) } });
    expect(weak.kpis.daysPowerNegative).toBeGreaterThan(20);
    expect(weak.kpis.daysPowerNegative).toBeLessThan(365);
    expect(weak.events.some((e) => /Power margin turns negative/.test(e.message))).toBe(true);
  });

  it("scores objectives with partial credit, and rewards a better design", () => {
    const m = generateMission("lunar-volatiles", 1, "cadet");
    const score = (config: typeof m.config, withSim = true) => {
      const { derived } = recalculate(config);
      const checks = engineeringChecks(config, derived);
      const maturity = assessConceptMaturity(config, derived, checks, { objectivesDefined: m.objectives.length, tradeStudies: 0, tradeParameters: 0, simulationsRun: 0, risksRecorded: 0, reviewsHeld: 0 });
      return evaluateMission({ objectives: m.objectives, config, derived, checks, simulation: withSim ? simulateMission(config) : null, maturity, contributors: 1, unverifiedContent: 0 });
    };
    const base = score(m.config);
    expect(base.objectives.find((o) => o.id === "hydrogen")).toMatchObject({ achieved: 0, feedback: "Required instrument is missing." });
    expect(base.objectives.find((o) => o.id === "polar")!.achieved).toBe(1);
    expect(score(m.config, false).objectives.find((o) => o.id === "survive")!.feedback).toMatch(/run the mission simulation/);

    const ns = SCENARIOS[0]!.catalog.find((c) => c.id === "ns")!.component;
    const better = { ...m.config, spacecraft: { ...m.config.spacecraft, components: [...m.config.spacecraft.components, { ...ns, id: "inst1" } as never] } };
    const improved = score(better);
    expect(improved.objectives.find((o) => o.id === "hydrogen")!.achieved).toBe(1);
    expect(improved.objectives.find((o) => o.id === "footprint")!.achieved).toBeGreaterThan(0); // 150 km footprint at 100 km altitude: partial
    expect(improved.objectives.find((o) => o.id === "footprint")!.achieved).toBeLessThan(1);
    expect(improved.score).toBeGreaterThan(base.score);
    expect(improved.categories.science.earned).toBeGreaterThan(base.categories.science.earned);
  });
});

describe("authentication and audit", () => {
  it("hashes passwords, issues revocable sessions and single-use tickets", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
    try {
      const auth = new AuthService(dir);
      const admin = await auth.register({ username: "ada", password: "correct horse battery" });
      expect(admin.role).toBe("admin"); // first account
      expect((await auth.register({ username: "grace", password: "another long secret" })).role).toBe("member");
      await expect(auth.register({ username: "ADA", password: "correct horse battery" })).rejects.toThrow(/taken/);
      await expect(auth.register({ username: "bob", password: "short" })).rejects.toThrow(/at least 10/);
      await expect(auth.login("ada", "wrong password!!")).rejects.toThrow(/Incorrect/);
      await expect(auth.login("nobody", "whatever-it-is")).rejects.toThrow(/Incorrect/);
      const { token } = await auth.login("ada", "correct horse battery");
      expect(auth.authenticate(token)?.username).toBe("ada");
      expect(auth.authenticate("forged-token")).toBeUndefined();

      const stored = readFileSync(path.join(dir, "auth.json"), "utf8");
      expect(stored).not.toContain("correct horse battery");
      expect(stored).not.toContain(token); // only a digest of the token is kept

      const ticket = auth.issueTicket(admin.id);
      expect(auth.redeemTicket(ticket)?.id).toBe(admin.id);
      expect(auth.redeemTicket(ticket)).toBeUndefined(); // single use

      expect(new AuthService(dir).authenticate(token)?.username).toBe("ada"); // survives a restart
      auth.logout(token);
      expect(auth.authenticate(token)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throttles repeated failed logins", async () => {
    const auth = new AuthService(null);
    await auth.register({ username: "target", password: "a-very-long-password" });
    let throttled = false;
    for (let i = 0; i < 10 && !throttled; i++) {
      await auth.login("target", "guess-number-" + i).catch((err: { status?: number }) => {
        throttled = err.status === 429;
      });
    }
    expect(throttled).toBe(true);
  }, 30000);

  it("keeps a tamper-evident audit chain and redacts secrets", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "audit-test-"));
    try {
      process.env.NASA_API_KEY = "super-secret-nasa-key-123";
      const log = new AuditLog(dir);
      log.record({ actor: "u1", action: "auth.login" });
      log.record({ actor: "u1", action: "mission.edit", sessionId: "s1", detail: { note: "called api with super-secret-nasa-key-123" } });
      log.record({ actor: "u2", action: "proposal.approve", sessionId: "s1", outcome: "denied" });
      expect(log.verify()).toEqual({ ok: true, entries: 3 });
      expect(JSON.stringify(log.query({ sessionId: "s1" }))).not.toContain("super-secret-nasa-key-123");
      expect(redact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345")).toBe("Authorization: Bearer [redacted]");

      const file = path.join(dir, "audit.jsonl");
      writeFileSync(file, readFileSync(file, "utf8").replace('"outcome":"denied"', '"outcome":"ok"'));
      expect(new AuditLog(dir).verify()).toMatchObject({ ok: false, brokenAt: 3 });
    } finally {
      delete process.env.NASA_API_KEY;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- HTTP + WebSocket against a live server ----------
let platform: Platform;
let server: ReturnType<typeof createPlatformServer>;
let base: string;

interface Client {
  cookie: string;
  account: { id: string; username: string; role: string };
  api(method: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
}

async function signUp(username: string): Promise<Client> {
  const res = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "integration-test-password-1", displayName: username.toUpperCase() }) });
  if (res.status !== 201) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const account = ((await res.json()) as { account: Client["account"] }).account;
  return {
    cookie,
    account,
    api: async (method, route, body, headers = {}) => {
      const r = await fetch(`${base}${route}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
  };
}

interface Socket {
  ws: WebSocket;
  messages: any[];
  send(message: unknown): void;
  until(predicate: (m: any) => boolean, label?: string): Promise<any>;
  last(type: string): any;
}

async function connect(client: Client, sessionId: string, useTicket = false): Promise<Socket> {
  const query = useTicket ? `&ticket=${(await client.api("POST", "/api/auth/ws-ticket")).body.ticket}` : "";
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws?session=${sessionId}${query}`, useTicket ? {} : { headers: { cookie: client.cookie } });
  const messages: any[] = [];
  ws.on("message", (d) => messages.push(JSON.parse(String(d))));
  await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));
  const socket: Socket = {
    ws,
    messages,
    send: (m) => ws.send(JSON.stringify(m)),
    last: (type) => [...messages].reverse().find((m) => m.type === type),
    until: async (predicate, label = "message") => {
      for (let i = 0; i < 400; i++) {
        const hit = messages.find(predicate);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Timed out waiting for ${label}; got: ${messages.map((m) => m.type).join(", ")}`);
    },
  };
  await socket.until((m) => m.type === "welcome", "welcome");
  return socket;
}

describe("platform server", () => {
  let lead: Client, flight: Client, power: Client, comms: Client, outsider: Client;
  let sessionId: string;

  beforeAll(async () => {
    platform = createPlatform({ llm: noLlm });
    server = createPlatformServer(platform, { webDir: path.join(os.tmpdir(), "no-web-build-here") });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Sequential, so the first account (the platform administrator) is deterministic.
    lead = await signUp("lead");
    flight = await signUp("flight");
    power = await signUp("power");
    comms = await signUp("comms");
    outsider = await signUp("outsider");
  }, 60000);

  afterAll(async () => {
    (server as unknown as { collab: { close(): void } }).collab.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await platform.close();
  });

  it("requires authentication and derives identity from the session, never from the request body", async () => {
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/api/capabilities`)).status).toBe(401);
    expect((await fetch(`${base}/assets/anything.glb`)).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
    expect((await (await fetch(`${base}/api/scenarios`)).json() as unknown[]).length).toBe(3);
    const me = await outsider.api("GET", "/api/auth/me");
    expect(me.body.account.username).toBe("outsider");
    // Claiming to be someone else in the body changes nothing.
    const spoof = await outsider.api("POST", "/api/sessions", { scenarioId: "lunar-volatiles", user: { id: lead.account.id, role: "lead" }, name: "spoof" });
    expect(spoof.body.session.createdBy).toBe(outsider.account.id);
    // Admin-only surfaces.
    expect((await outsider.api("GET", "/api/admin/accounts")).status).toBe(403);
    expect((await outsider.api("GET", "/api/audit")).status).toBe(403);
    expect(lead.account.role).toBe("admin");
    expect((await lead.api("GET", "/api/admin/accounts")).body).toHaveLength(5);
    const info = await lead.api("GET", "/api/platform");
    expect(info.body.secrets.every((s: { configured: unknown }) => typeof s.configured === "boolean")).toBe(true);
    expect(JSON.stringify(info.body)).not.toMatch(/sk-ant|password/i);
    expect(info.body.audit.ok).toBe(true);
  });

  it("refuses cross-origin state changes and non-JSON bodies", async () => {
    expect((await lead.api("POST", "/api/sessions", { scenarioId: "lunar-volatiles" }, { origin: "https://evil.example" })).status).toBe(403);
    const form = await fetch(`${base}/api/sessions`, { method: "POST", headers: { cookie: lead.cookie, "content-type": "text/plain" }, body: '{"scenarioId":"lunar-volatiles"}' });
    expect(form.status).toBe(415);
  });

  it("creates a mission session and enforces membership and roles on the server", async () => {
    const created = await lead.api("POST", "/api/sessions", { scenarioId: "lunar-volatiles", name: "Team Artemis", seed: 11, difficulty: "cadet", visibility: "invite" });
    expect(created.status).toBe(201);
    sessionId = created.body.session.id;
    expect(created.body.mission.version).toBe(1);
    expect(created.body.inviteCode).toMatch(/^[0-9A-F]{6}$/);
    expect(created.body.evaluation.objectives).toHaveLength(12);
    expect(created.body.scenario.catalog.length).toBeGreaterThan(10);

    expect((await flight.api("GET", `/api/sessions/${sessionId}`)).status).toBe(403); // not a member yet
    expect((await flight.api("POST", `/api/sessions/${sessionId}/join`, { inviteCode: "WRONG1" })).status).toBe(403);
    for (const [client, discipline] of [[flight, "flight_dynamics"], [power, "power"], [comms, "communications"]] as const) {
      const joined = await client.api("POST", `/api/sessions/${sessionId}/join`, { inviteCode: created.body.inviteCode, discipline });
      expect(joined.body.member).toMatchObject({ role: "engineer", discipline });
    }
    const view = await flight.api("GET", `/api/sessions/${sessionId}`);
    expect(view.body.session.members).toHaveLength(4);
    expect(view.body.inviteCode).toBeUndefined(); // only the lead sees the code
    expect(view.body.session.inviteCode).toBeUndefined();

    // An engineer cannot promote themselves, approve as lead, roll back or submit.
    expect((await flight.api("POST", `/api/sessions/${sessionId}/members/${flight.account.id}`, { role: "lead" })).status).toBe(403);
    expect((await flight.api("POST", `/api/sessions/${sessionId}/rollback`, { version: 1 })).status).toBe(403);
    expect((await flight.api("POST", `/api/sessions/${sessionId}/submit`)).status).toBe(403);
    // A viewer cannot edit.
    await lead.api("POST", `/api/sessions/${sessionId}/members/${comms.account.id}`, { role: "viewer" });
    expect((await comms.api("POST", `/api/sessions/${sessionId}/edit`, { baseVersion: 1, patches: [{ op: "set", path: "orbit.inclinationDeg", value: 80 }] })).status).toBe(403);
    await lead.api("POST", `/api/sessions/${sessionId}/members/${comms.account.id}`, { role: "engineer" });
    // Scenario constraints are not editable by anyone.
    const cheat = await lead.api("POST", `/api/sessions/${sessionId}/edit`, { baseVersion: 1, patches: [{ op: "set", path: "meta.budgetMusd", value: 9999 }] });
    expect(cheat.status).toBe(403);
    expect(cheat.body.detail).toMatch(/set by the mission scenario/);
    expect((await outsider.api("GET", `/api/sessions/${sessionId}/versions`)).status).toBe(403);
  });

  it("synchronises four participants: authoritative state with recalculated results, conflicts, locks and reconnects", async () => {
    await expect(connect(outsider, sessionId)).rejects.toThrow(/403/);
    const anonymous = new WebSocket(`${base.replace("http", "ws")}/ws?session=${sessionId}`);
    await expect(new Promise((resolve, reject) => anonymous.once("open", resolve).once("error", reject))).rejects.toThrow(/401/);

    const sockets = await Promise.all([connect(lead, sessionId), connect(flight, sessionId, true), connect(power, sessionId), connect(comms, sessionId)]);
    const [a, b, c, d] = sockets as [Socket, Socket, Socket, Socket];
    expect((server as unknown as { collab: { connections(id: string): number } }).collab.connections(sessionId)).toBe(4);
    const roster = (await d.until((m) => m.presence?.length === 4, "roster of four")).presence as { color: string; displayName: string }[];
    expect(new Set(roster.map((p) => p.color)).size).toBe(4);
    expect(roster.map((p) => p.displayName).sort()).toEqual(["COMMS", "FLIGHT", "LEAD", "POWER"]);
    expect(a.last("welcome").mission.version).toBe(1);

    // 1. One participant changes the orbit; all four receive the new authoritative version.
    b.send({ type: "edit", clientSeq: 1, baseVersion: 1, patches: [{ op: "set", path: "orbit.semiMajorAxisKm", value: 1787.4 }], summary: "Lower orbit to 50 km" });
    expect((await b.until((m) => m.type === "edit.result" && m.clientSeq === 1)).ok).toBe(true);
    for (const s of sockets) {
      const update = await s.until((m) => m.type === "mission.version" && m.mission.version === 2, "version 2");
      expect(update.mission.config.orbit.semiMajorAxisKm).toBe(1787.4);
      expect(update.mission.recalculated).toEqual(expect.arrayContaining(["orbit.elements", "orbit.eclipse", "power.budget", "comms.link", "science.return"]));
      expect(update.mission.derived["orbit.elements"].value.periapsisAltitudeKm).toBeCloseTo(50, 6);
      expect(update.cause).toMatchObject({ kind: "edit", displayName: "FLIGHT", summary: "Lower orbit to 50 km" });
      expect(update.checks.length).toBeGreaterThan(5);
      expect(update.evaluation.score).toBeGreaterThanOrEqual(0);
    }

    // 2. Concurrent edits to different fields against the same base both apply (merge).
    c.send({ type: "edit", clientSeq: 1, baseVersion: 2, patches: [{ op: "set", path: "spacecraft.components.sp1.areaM2", value: 1.6 }] });
    d.send({ type: "edit", clientSeq: 1, baseVersion: 2, patches: [{ op: "set", path: "spacecraft.components.ant1.dataRateBps", value: 4e6 }] });
    expect((await c.until((m) => m.type === "edit.result")).ok).toBe(true);
    expect((await d.until((m) => m.type === "edit.result")).ok).toBe(true);
    const merged = await a.until((m) => m.type === "mission.version" && m.mission.version === 4, "version 4");
    expect(merged.mission.config.spacecraft.components.find((x: { id: string }) => x.id === "sp1").areaM2).toBe(1.6);
    expect(merged.mission.config.spacecraft.components.find((x: { id: string }) => x.id === "ant1").dataRateBps).toBe(4e6);

    // 3. Two edits to the same field: the stale one is rejected with the current value.
    a.send({ type: "edit", clientSeq: 7, baseVersion: 4, patches: [{ op: "set", path: "orbit.inclinationDeg", value: 88 }] });
    await a.until((m) => m.type === "edit.result" && m.clientSeq === 7);
    b.send({ type: "edit", clientSeq: 8, baseVersion: 4, patches: [{ op: "set", path: "orbit.inclinationDeg", value: 70 }] });
    const rejected = await b.until((m) => m.type === "edit.result" && m.clientSeq === 8);
    expect(rejected).toMatchObject({ ok: false, reason: "conflict", headVersion: 5, conflict: { paths: ["orbit.inclinationDeg"], current: { "orbit.inclinationDeg": 88 }, changedBy: ["LEAD"] } });

    // 4. Edit locks: while one participant holds an object, others cannot change it.
    c.send({ type: "lock", path: "spacecraft.components.sp1", held: true });
    expect((await c.until((m) => m.type === "lock.result")).granted).toBe(true);
    await d.until((m) => m.type === "locks.updated" && m.locks["spacecraft.components.sp1"] === power.account.id, "lock broadcast");
    d.send({ type: "edit", clientSeq: 9, baseVersion: 5, patches: [{ op: "set", path: "spacecraft.components.sp1.areaM2", value: 9 }] });
    expect(await d.until((m) => m.type === "edit.result" && m.clientSeq === 9)).toMatchObject({ ok: false, reason: "locked", detail: expect.stringMatching(/POWER is editing/) });

    // 5. In-flight transforms and presence are relayed but never stored.
    c.send({ type: "transform", nodeId: "node_sp1", pose: [0.1, 0.2, 0.3, 0, 0, 0, 1] });
    c.send({ type: "presence", mode: "xr", head: [0, 1.6, 0, 0, 0, 0, 1], hands: { left: null, right: [0.2, 1.2, -0.3, 0, 0, 0, 1] }, focus: "spacecraft.components.sp1" });
    expect(await a.until((m) => m.type === "transform.preview")).toMatchObject({ nodeId: "node_sp1", pose: [0.1, 0.2, 0.3, 0, 0, 0, 1] });
    expect(await a.until((m) => m.type === "presence.update")).toMatchObject({ mode: "xr", displayName: "POWER", focus: "spacecraft.components.sp1" });
    expect(platform.sessions.get(sessionId)!.store.head().version).toBe(5);

    // 6. A dropped connection releases its locks; on reconnect the client learns what it missed.
    c.ws.terminate();
    await d.until((m) => m.type === "locks.updated" && Object.keys(m.locks).length === 0, "lock released on disconnect");
    d.send({ type: "edit", clientSeq: 10, baseVersion: 5, patches: [{ op: "set", path: "missionTime", value: "2027-09-01T00:00:00Z" }], summary: "Move launch date" });
    await d.until((m) => m.type === "edit.result" && m.clientSeq === 10);
    const back = await connect(power, sessionId);
    back.messages.length = 0;
    back.send({ type: "hello", lastVersion: 5, mode: "desktop" });
    const resumed = await back.until((m) => m.type === "welcome" && m.resumed === true, "resume");
    expect(resumed.mission.version).toBe(6);
    expect(resumed.missed).toEqual([{ version: 6, by: "COMMS", note: "Move launch date", changedPaths: ["missionTime"] }]);
    expect(resumed.mission.recalculated).toEqual(expect.arrayContaining(["ephemeris.sun", "scene.lighting", "orbit.eclipse"]));

    // Malformed and oversized input is ignored without dropping well-behaved clients.
    a.ws.send("not json");
    a.send({ type: "transform", nodeId: "x", pose: ["bad"] });
    a.send({ type: "ping", t: 1 });
    expect((await a.until((m) => m.type === "pong")).headVersion).toBe(6);
    for (const s of [a, b, d, back]) s.ws.close();
  }, 30000);

  it("runs the natural-language runtime builder inside a session and deploys under the session policy", async () => {
    const socket = await connect(power, sessionId);
    // Catalogue pick → asset generated → staged → tested → auto-approved (open policy) → published → broadcast.
    const added = await power.api("POST", `/api/sessions/${sessionId}/catalog`, { itemId: "ns", wait: true });
    expect(added.status).toBe(202);
    const version = await socket.until((m) => m.type === "mission.version" && m.cause.kind === "proposal", "published proposal");
    const mission = version.mission;
    const inst = mission.config.spacecraft.components.find((x: { type: string }) => x.type === "instrument");
    expect(inst).toMatchObject({ id: "inst1", kind: "neutron_spectrometer", costMusd: 9 });
    const node = mission.config.scene.nodes.find((n: { componentId: string }) => n.componentId === "inst1");
    const asset = mission.config.assets.find((x: { id: string }) => x.id === node.assetId);
    const glb = await fetch(`${base}${asset.uri}`, { headers: { cookie: power.cookie } });
    expect(glb.status).toBe(200);
    expect(glb.headers.get("cache-control")).toMatch(/immutable/); // content-addressed, versioned by mission version
    expect(Buffer.from(await glb.arrayBuffer()).subarray(0, 4).toString()).toBe("glTF");
    expect(version.evaluation.objectives.find((o: { id: string }) => o.id === "hydrogen").achieved).toBe(1);
    const proposals = await power.api("GET", `/api/sessions/${sessionId}/proposals`);
    expect(proposals.body[0]).toMatchObject({ status: "published", decision: { by: { id: "policy:open" } } });

    // Free-text request through the same pipeline.
    const nl = await flight.api("POST", `/api/sessions/${sessionId}/requests`, { text: "Set orbit altitude to 40 km", wait: true });
    expect(nl.body.requirement.analysis.method).toBe("rule_based");
    expect(nl.body.feasibility.classification).toBe("feasible");
    await socket.until((m) => m.type === "mission.version" && m.mission.config.orbit.semiMajorAxisKm === 1777.4, "altitude change");
    expect(nl.body.trace.some((e: { stage: string }) => e.stage === "selection")).toBe(true);

    // A change that violates constraints is not auto-published.
    const before = platform.sessions.get(sessionId)!.store.head().version;
    const bad = await power.api("POST", `/api/sessions/${sessionId}/requests`, { text: "set spacecraft.components.sp1.areaM2 to 0.05", wait: true });
    expect(bad.body.status).toBe("awaiting_approval");
    expect(platform.sessions.get(sessionId)!.store.head().version).toBe(before);
    expect((await lead.api("POST", `/api/sessions/${sessionId}/proposals/${bad.body.proposalId}/approve`, { reason: "force" })).status).toBe(409);
    await lead.api("POST", `/api/sessions/${sessionId}/proposals/${bad.body.proposalId}/reject`, { reason: "Negative power margin" });

    // Read-only capabilities run against this session's mission; MCP is scoped the same way.
    const script = await flight.api("POST", `/api/sessions/${sessionId}/capabilities/gmat.export_script/execute`, { input: { durationDays: 3 } });
    expect(script.body.output.script).toContain("GMAT Sat.SMA = 1777.4;");
    expect((await flight.api("POST", `/api/sessions/${sessionId}/capabilities/mission.propose_patch/execute`, { input: { patches: [{ op: "set", path: "missionTime", value: "2028-01-01T00:00:00Z" }] } })).status).toBe(422);
    expect((await outsider.api("POST", `/mcp?session=${sessionId}`, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(403);
    socket.ws.close();
  }, 30000);

  it("plays the mission through trade studies, simulation, review, phase gates, submission and the leaderboard", async () => {
    const s = `/api/sessions/${sessionId}`;
    expect((await lead.api("POST", `${s}/phase`)).status).toBe(200); // concept → trade needs CML 2: the design is viable
    const gate = await lead.api("POST", `${s}/phase`); // trade → design needs CML 3: trade studies
    expect(gate.status).toBe(409);
    expect(gate.body.error).toMatch(/CML 3.*trade studies/s);

    const trade = await flight.api("POST", `${s}/trade`, { path: "orbit.semiMajorAxisKm", values: [1767.4, 1787.4, 1837.4, 1937.4], metrics: [{ node: "science.return", field: "neutronFootprintKm" }, { node: "orbit.eclipse", field: "eclipseFraction" }, { node: "power.budget", field: "marginW" }] });
    expect(trade.body.rows).toHaveLength(4);
    const footprints = trade.body.rows.map((r: { metrics: Record<string, number> }) => r.metrics["science.return.neutronFootprintKm"]);
    expect(footprints).toEqual([45, 75, 150, 300]); // lower orbit, smaller footprint
    const eclipse = trade.body.rows.map((r: { metrics: Record<string, number> }) => r.metrics["orbit.eclipse.eclipseFraction"]);
    expect(eclipse[0]).toBeGreaterThan(eclipse[3]); // …but more time in shadow: the trade
    await power.api("POST", `${s}/trade`, { path: "spacecraft.components.sp1.areaM2", values: [1.2, 1.6, 2.4], metrics: [{ node: "power.budget", field: "marginFraction" }, { node: "cost.budget", field: "marginMusd" }] });
    expect((await lead.api("POST", `${s}/phase`)).body.game.phase).toBe("design");

    const sim = await power.api("POST", `${s}/simulate`);
    expect(sim.body.days).toBe(365);
    expect(sim.body.kpis.totalDataReturnedGb).toBeGreaterThan(0);
    for (const risk of ["Mascon perturbations lower periapsis", "Eclipse season deeper than modelled", "Single ground station outage"]) {
      await flight.api("POST", `${s}/notes`, { kind: "mission_problem", summary: risk, mitigation: "Carry margin and re-plan" });
    }
    await comms.api("POST", `${s}/notes`, { kind: "hypothesis", summary: "A Ka-band link would double returned data at this range" });
    const review = await lead.api("POST", `${s}/review`);
    expect(review.body.aiReview).toBeNull(); // no model configured: no model critique is invented
    expect(review.body.maturity.level).toBeGreaterThanOrEqual(4);
    expect((await lead.api("POST", `${s}/phase`)).body.game.phase).toBe("review");

    const submitted = await lead.api("POST", `${s}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.evaluation.simulated).toBe(true);
    expect(submitted.body.evaluation.rigor.find((r: { item: string }) => r.item === "Collaboration").earned).toBe(3);
    expect(submitted.body.submission).toMatchObject({ scenarioId: "lunar-volatiles", difficulty: "cadet", cml: 5 });
    expect(submitted.body.submission.team).toHaveLength(4);

    // Frozen after submission.
    expect((await flight.api("POST", `${s}/edit`, { baseVersion: 99, patches: [{ op: "set", path: "orbit.inclinationDeg", value: 60 }] })).body.reason).toBe("frozen");
    expect((await lead.api("POST", `${s}/submit`)).status).toBe(409);

    const board = await (await fetch(`${base}/api/leaderboard?scenario=lunar-volatiles`)).json() as { rank: number; sessionName: string; score: number }[];
    expect(board[0]).toMatchObject({ rank: 1, sessionName: "Team Artemis", score: submitted.body.submission.score });

    // The research record captured the whole process, searchable.
    const kinds = new Set(platform.memory.all().map((r) => r.kind));
    for (const kind of ["mission_problem", "hypothesis", "user_contribution", "trade_study", "simulation_result", "validation_report", "mission_outcome", "tool_execution", "design_change"]) expect(kinds.has(kind as never), kind).toBe(true);
    const found = await comms.api("GET", "/api/research?q=Ka-band%20link%20returned%20data");
    expect(found.body.records[0].kind).toBe("hypothesis");
    expect(found.body.records[0].verification).toBe("unverified"); // a person's hypothesis is not evidence

    // The lead can read this mission's audit trail; the chain is intact.
    const trail = await lead.api("GET", `/api/audit?session=${sessionId}`);
    expect(trail.body.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["session.create", "session.join", "mission.edit", "catalog.add", "proposal.approve", "proposal.reject", "game.trade_study", "game.simulate", "game.submit"]));
    expect(platform.audit.verify().ok).toBe(true);
  }, 30000);

  it("serves retrieval for RAG from references, documents and research records", async () => {
    const docs = mkdtempSync(path.join(os.tmpdir(), "docs-test-"));
    try {
      writeFileSync(path.join(docs, "thermal-notes.txt"), "Radiators must reject avionics heat during lunar noon. Louvers reduce heater power in eclipse. A heat pipe couples the battery to the radiator.");
      expect(platform.knowledge.ingestDirectory(docs)).toMatchObject({ documents: 1 });
      const cml = await comms.api("GET", "/api/knowledge/search?q=trade%20space%20science%20return%20cost%20risk&kinds=reference");
      expect(cml.body[0].passage.source.locator).toBe("CML 3");
      const doc = await comms.api("GET", "/api/knowledge/search?q=radiator%20heat%20eclipse%20louvers");
      expect(doc.body[0].passage).toMatchObject({ kind: "document", source: { title: "thermal-notes.txt" }, verification: "external_data" });
      const context = await comms.api("POST", "/api/knowledge/context", { query: "What maturity level is a point design with acceptable margins?", k: 3 });
      expect(context.body.context).toMatch(/^\[1\] \(.*CML 4.*\)/);
      expect(context.body.citations[0]).toMatchObject({ n: 1, verification: "external_data" });
      const records = await comms.api("GET", "/api/knowledge/search?q=mission%20simulation%20negative%20power%20margin&kinds=record");
      expect(records.body[0].passage.kind).toBe("record");
    } finally {
      rmSync(docs, { recursive: true, force: true });
    }
  });
});

describe("durability", () => {
  it("restores accounts, sessions, mission versions and pending proposals after a restart", async () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), "platform-durable-"));
    try {
      const first = createPlatform({ dataDir, llm: noLlm });
      const account = await first.auth.register({ username: "durable", password: "a-long-enough-password" });
      const { token } = await first.auth.login("durable", "a-long-enough-password");
      const session = first.sessions.create(account, { scenarioId: "lunar-volatiles", seed: 3, difficulty: "cadet", policy: "review" });
      session.applyEdit(account.id, { baseVersion: 1, patches: [{ op: "set", path: "orbit.inclinationDeg", value: 86 }] });
      const request = await session.requests.wait(session.addFromCatalog(account.id, "wac").id);
      expect(request.status).toBe("awaiting_approval"); // review policy: waits for the lead
      const proposalId = request.proposalId!;
      expect(session.store.head().version).toBe(2);
      await first.close();

      const second = createPlatform({ dataDir, llm: noLlm });
      expect(second.auth.authenticate(token)?.username).toBe("durable");
      const restored = second.sessions.get(session.meta.id)!;
      expect(restored.meta.members[0]).toMatchObject({ accountId: account.id, role: "lead" });
      expect(restored.store.head().version).toBe(2);
      expect(restored.store.head().config.orbit.inclinationDeg).toBe(86);
      expect(restored.proposals.get(proposalId)).toMatchObject({ status: "awaiting_approval", significance: "significant" });
      expect(restored.requests.get(request.id)?.proposalId).toBe(proposalId);

      // The restored proposal still deploys: its staged asset survived on disk.
      const { version } = await restored.decide(account.id, proposalId, "approve", "Approved after restart");
      expect(version!.version).toBe(3);
      const assetId = version!.config.assets[0]!.id;
      expect(readFileSync(path.join(second.assetsDir, `${assetId}.glb`)).subarray(0, 4).toString()).toBe("glTF");
      expect(second.audit.verify().ok).toBe(true);
      expect(second.audit.query({ action: "proposal.approve" })[0]!.detail).toMatchObject({ proposalId, reason: "Approved after restart" });
      await second.close();

      const third = createPlatform({ dataDir, llm: noLlm });
      expect(third.sessions.get(session.meta.id)!.proposals.get(proposalId)!.status).toBe("published");
      expect(third.sessions.get(session.meta.id)!.store.head().version).toBe(3);
      await third.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30000);
});
