/**
 * Features added after the first platform release: OpenAI provider, text-to-3D, terrain and
 * imagery services (offline, with stubbed transports), trajectory overlays, retrieval in
 * request analysis, full play-throughs of the CubeSat and Mars scenarios, and TLS serving.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildGlb, validateGlb } from "../src/assets/glb.js";
import { compileShapeProgram, composeFromKeywords, ShapeProgramSchema } from "../src/capabilities/text3d.js";
import { SCENARIOS } from "../src/game/scenarios.js";
import { createLlm, type LlmService, OpenAiLlm } from "../src/llm/llm.js";
import { ImageryService } from "../src/nasa/imagery.js";
import { DEM_PRODUCTS, TerrainService } from "../src/nasa/terrain.js";
import { createPlatform, type Platform } from "../src/platform/platform.js";
import { redact } from "../src/platform/secrets.js";
import { propagateJ2 } from "../src/science/propagate.js";
import { createPlatformServer } from "../src/server/http.js";

const noLlm: LlmService = { modelId: "none", status: () => ({ available: false, reason: "No credentials in test" }), structured: async () => { throw new Error("LLM must not be called"); } };
const TEST_KEY = "sk-test-key-not-real-000000000000";

describe("OpenAI provider", () => {
  const completion = (message: Record<string, unknown>, status = 200): Response =>
    new Response(JSON.stringify({ id: "chatcmpl-test", object: "chat.completion", created: 0, model: "test", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", refusal: null, ...message } }] }), { status, headers: { "content-type": "application/json" } });
  const schema = z.object({ answer: z.string(), confidence: z.number().min(0).max(1) });

  it("sends a JSON-schema request with the configured key and validates the reply", async () => {
    const seen: { url: string; auth: string | null; body: any }[] = [];
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return completion({ content: JSON.stringify({ answer: "polar orbit", confidence: 0.8 }) });
    }) as typeof fetch;
    const llm = new OpenAiLlm("unit-test-model", { apiKey: TEST_KEY, fetch: fetchStub });
    expect(llm.status().available).toBe(true);
    await expect(llm.structured({ system: "You answer.", prompt: "Which orbit?", schema })).resolves.toEqual({ answer: "polar orbit", confidence: 0.8 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toMatch(/\/chat\/completions$/);
    expect(seen[0]!.auth).toBe(`Bearer ${TEST_KEY}`);
    expect(seen[0]!.body.model).toBe("unit-test-model");
    expect(seen[0]!.body.response_format).toMatchObject({ type: "json_schema", json_schema: { name: "result", schema: { type: "object", required: ["answer", "confidence"] } } });
    expect(seen[0]!.body.messages[0].role).toBe("system");
  });

  it("asks once for a correction, then refuses to pass invalid output on", async () => {
    let calls = 0;
    const repairing = new OpenAiLlm("m", { apiKey: TEST_KEY, fetch: (async () => completion({ content: ++calls === 1 ? '{"answer": 5}' : '{"answer":"ok","confidence":1}' })) as typeof fetch });
    await expect(repairing.structured({ system: "s", prompt: "p", schema })).resolves.toEqual({ answer: "ok", confidence: 1 });
    expect(calls).toBe(2);
    const broken = new OpenAiLlm("m", { apiKey: TEST_KEY, fetch: (async () => completion({ content: "not json at all" })) as typeof fetch });
    await expect(broken.structured({ system: "s", prompt: "p", schema })).rejects.toMatchObject({ options: { code: "llm_invalid_output" } });
  });

  it("maps refusals and provider errors to pipeline errors", async () => {
    const refusing = new OpenAiLlm("m", { apiKey: TEST_KEY, fetch: (async () => completion({ content: null, refusal: "I cannot help with that" })) as typeof fetch });
    await expect(refusing.structured({ system: "s", prompt: "p", schema })).rejects.toMatchObject({ options: { code: "llm_refusal" } });
    const unauthorised = new OpenAiLlm("m", { apiKey: TEST_KEY, fetch: (async () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch });
    await expect(unauthorised.structured({ system: "s", prompt: "p", schema })).rejects.toMatchObject({ options: { code: "llm_auth" } });
  });

  it("is selected from the environment, is unavailable without a key, and its key is redacted", () => {
    const saved = { openai: process.env.OPENAI_API_KEY, provider: process.env.LLM_PROVIDER };
    try {
      delete process.env.LLM_PROVIDER;
      delete process.env.OPENAI_API_KEY;
      expect(new OpenAiLlm().status()).toMatchObject({ available: false, reason: expect.stringMatching(/OPENAI_API_KEY/) });
      process.env.OPENAI_API_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";
      expect(createLlm()).toBeInstanceOf(OpenAiLlm);
      expect(redact("failed with key sk-proj-abcdefghijklmnopqrstuvwxyz012345 in header")).toBe("failed with key [OPENAI_API_KEY] in header");
      delete process.env.OPENAI_API_KEY;
      expect(redact("leaked sk-proj-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe("leaked [redacted-key]");
    } finally {
      if (saved.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.openai;
      if (saved.provider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = saved.provider;
    }
  });
});

describe("text-to-3D", () => {
  it("compiles a shape program into a valid GLB with the stated sizes and poses", () => {
    const program = ShapeProgramSchema.parse({
      title: "test rig",
      notes: "",
      parts: [
        { name: "base", shape: "box", sizeM: [2, 0.2, 1], positionM: [0, 0, 0], rotationDeg: [0, 0, 0], material: "aluminum" },
        { name: "mast", shape: "cylinder", sizeM: [0.1, 3, 0.001], positionM: [5, 0, 0], rotationDeg: [0, 0, 90], material: "carbon" },
        { name: "nozzle", shape: "cone", sizeM: [0.6, 0.5, 0.2], positionM: [0, -1, 0], rotationDeg: [0, 0, 0], material: "black_kapton" },
        { name: "dish", shape: "dish", sizeM: [1, 0.15, 0.001], positionM: [0, 1, 0], rotationDeg: [0, 0, 0], material: "white_paint" },
      ],
    });
    const parts = compileShapeProgram(program);
    expect(parts).toHaveLength(4);
    const extent = (positions: number[], axis: number): [number, number] => {
      const values = positions.filter((_, i) => i % 3 === axis);
      return [Math.min(...values), Math.max(...values)];
    };
    expect(extent(parts[0]!.positions, 0)).toEqual([-1, 1]);
    // A 3 m cylinder rotated 90° about Z lies along X, centred at x = 5.
    const [x0, x1] = extent(parts[1]!.positions, 0);
    expect(x0).toBeCloseTo(3.5, 6);
    expect(x1).toBeCloseTo(6.5, 6);
    expect(extent(parts[1]!.positions, 1).every((v) => Math.abs(v) < 0.051)).toBe(true);
    for (const part of parts) for (let i = 0; i < part.normals.length; i += 3) expect(Math.hypot(part.normals[i]!, part.normals[i + 1]!, part.normals[i + 2]!)).toBeCloseTo(1, 3);
    expect(parts[1]!).toMatchObject({ metallic: 0.3, roughness: 0.5 });
    const stats = validateGlb(buildGlb(parts, { name: "test rig", generator: "test" }));
    expect(stats.triangles).toBeGreaterThan(200);
  });

  it("rejects programs outside the allowed bounds", () => {
    const part = { name: "p", shape: "box", sizeM: [1, 1, 1], positionM: [0, 0, 0], rotationDeg: [0, 0, 0], material: "aluminum" };
    expect(ShapeProgramSchema.safeParse({ title: "t", notes: "", parts: [{ ...part, sizeM: [500, 1, 1] }] }).success).toBe(false);
    expect(ShapeProgramSchema.safeParse({ title: "t", notes: "", parts: [{ ...part, material: "unobtainium" }] }).success).toBe(false);
    expect(ShapeProgramSchema.safeParse({ title: "t", notes: "", parts: Array.from({ length: 65 }, () => part) }).success).toBe(false);
    expect(ShapeProgramSchema.safeParse({ title: "t", notes: "", parts: [] }).success).toBe(false);
  });

  it("composes recognised parts by keyword, scaled to a stated size, and admits what it cannot do", () => {
    const boom = composeFromKeywords("a 2 m magnetometer boom with a small propellant tank")!;
    expect(boom.title).toBe("propellant tank + deployable boom");
    expect(boom.notes).toMatch(/no language model/i);
    expect(ShapeProgramSchema.safeParse(boom).success).toBe(true);
    expect(validateGlb(buildGlb(compileShapeProgram(boom), { name: boom.title, generator: "test" })).triangles).toBeGreaterThan(100);
    expect(composeFromKeywords("a friendly space whale")).toBeNull();
  });
});

describe("terrain and imagery services (stubbed transport)", () => {
  /** A synthetic lunar grid: 100 m of height per degree of latitude, so the slope is known. */
  const syntheticDem = (): Buffer => {
    const { width, height } = DEM_PRODUCTS.moon;
    const bytes = Buffer.alloc(width * height * 2);
    for (let y = 0; y < height; y++) {
      const lat = 90 - ((y + 0.5) / height) * 180;
      for (let x = 0; x < width; x++) bytes.writeInt16LE(Math.round((lat * 100) / 0.5), (y * width + x) * 2);
    }
    return bytes;
  };

  it("interpolates elevation and fits the regional slope, including near a pole", async () => {
    let fetches = 0;
    const terrain = new TerrainService(null, (async () => { fetches++; return new Response(new Uint8Array(syntheticDem())); }) as typeof fetch);
    expect(await terrain.elevationM("moon", 10, 45)).toBeCloseTo(1000, 0);
    expect(await terrain.elevationM("moon", -30.3, 400)).toBeCloseTo(-3030, 0);
    const expected = (Math.atan(100 / ((Math.PI / 180) * 1737.4 * 1000)) * 180) / Math.PI;
    const equator = await terrain.survey("moon", 0, 120, 60);
    expect(equator.regionalSlopeDeg).toBeCloseTo(expected, 3);
    expect(equator.downhillAzimuthDeg).toBeCloseTo(180, 0); // height increases northwards
    expect(equator.resolutionKmPerPixel).toBeCloseTo(7.58, 2);
    const polar = await terrain.survey("moon", -85, 222.7, 60);
    expect(polar.regionalSlopeDeg).toBeCloseTo(expected, 2);
    expect(polar.caveats.join(" ")).toMatch(/regional trend/);
    const patch = await terrain.patch("moon", 0, 0, 60, 5);
    expect(patch.cellSizeM).toBe(15000);
    expect(patch.heightsM[0]![2]!).toBeGreaterThan(patch.heightsM[4]![2]!); // row 0 is north
    const raster = await terrain.raster("moon", 360);
    expect(raster).toMatchObject({ width: 360, height: 180 });
    expect(raster.data.readInt16LE(0)).toBeGreaterThan(8900);
    expect(fetches).toBe(1); // one download serves every query
  });

  it("reports data-service failures without caching them", async () => {
    let attempt = 0;
    const terrain = new TerrainService(null, (async () => (++attempt === 1 ? new Response("gateway timeout", { status: 504 }) : new Response(new Uint8Array(syntheticDem())))) as typeof fetch);
    await expect(terrain.elevationM("moon", 0, 0)).rejects.toMatchObject({ options: { code: "dem_http", retryable: true } });
    expect(Math.abs(await terrain.elevationM("moon", 0, 0))).toBeLessThan(30);
    const truncated = new TerrainService(null, (async () => new Response(new Uint8Array(1000))) as typeof fetch);
    await expect(truncated.elevationM("mars", 0, 0)).rejects.toMatchObject({ options: { code: "dem_format" } });
  });

  it("serves only allow-listed tiles, caches them, and never passes off a non-image", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "imagery-test-"));
    try {
      const urls: string[] = [];
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
      const imagery = new ImageryService(dir, (async (input: string | URL | Request) => { urls.push(String(input)); return new Response(jpeg); }) as typeof fetch);
      expect(imagery.manifest().map((l) => l.id)).toEqual(["moon", "mars", "earth", "earth-night"]);
      expect(imagery.manifest().find((l) => l.id === "earth")!.levels[3]).toEqual({ z: 3, cols: 10, rows: 5, degPerTile: 36 });
      expect(imagery.manifest().find((l) => l.id === "moon")!.levels[2]).toEqual({ z: 2, cols: 8, rows: 4, degPerTile: 45 });
      expect([...(await imagery.tile("moon", 2, 1, 3))]).toEqual([...jpeg]);
      await imagery.tile("moon", 2, 1, 3);
      expect(urls).toEqual(["https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/2/1/3.jpg"]); // second read came from disk
      expect(existsSync(path.join(dir, "moon", "2", "1", "3.jpg"))).toBe(true);
      await expect(imagery.tile("moon", 2, 4, 0)).rejects.toMatchObject({ status: 404 });
      await expect(imagery.tile("moon", 9, 0, 0)).rejects.toMatchObject({ status: 404 });
      await expect(imagery.tile("../../etc", 0, 0, 0)).rejects.toMatchObject({ status: 404 });
      await expect(imagery.tile("moon", 1.5, 0, 0)).rejects.toMatchObject({ status: 404 });
      const html = new ImageryService(dir, (async () => new Response("<html>error</html>")) as typeof fetch);
      await expect(html.tile("mars", 0, 0, 0)).rejects.toMatchObject({ status: 502 });
      expect(existsSync(path.join(dir, "mars", "0", "0", "0.jpg"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- session-level behaviour over HTTP ----------
interface Client { cookie: string; api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> }
async function signUp(base: string, username: string): Promise<Client> {
  const res = await fetch(`${base}/api/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "integration-test-password-1", displayName: username }) });
  if (res.status !== 201) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return {
    cookie,
    api: async (method, route, body) => {
      const r = await fetch(`${base}${route}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : null };
    },
  };
}
async function serve(platform: Platform): Promise<{ base: string; close(): Promise<void> }> {
  const server = createPlatformServer(platform, { webDir: path.join(os.tmpdir(), "no-web-build-here") });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      (server as unknown as { collab: { close(): void } }).collab.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await platform.close();
    },
  };
}

describe("sessions: text-to-3D, trajectory overlays and scenario play-throughs", () => {
  let platform: Platform;
  let site: Awaited<ReturnType<typeof serve>>;
  let lead: Client;

  beforeAll(async () => {
    platform = createPlatform({ llm: noLlm });
    site = await serve(platform);
    lead = await signUp(site.base, "lead");
  }, 60000);
  afterAll(async () => site.close());

  it("builds a described object without a model, places it in the scene and deploys it as a versioned GLB", async () => {
    const created = await lead.api("POST", "/api/sessions", { scenarioId: "lunar-volatiles", name: "Text3D", seed: 5, difficulty: "cadet" });
    const s = `/api/sessions/${created.body.session.id}`;
    const done = await lead.api("POST", `${s}/requests`, { text: "Create a 3D model of a star tracker telescope with a radiator", wait: true });
    expect(done.body.requirement.operations[0]).toMatchObject({ intent: "generate_asset", params: { prompt: expect.stringMatching(/star tracker/) } });
    expect(done.body.plan.tasks[0].capabilityId).toBe("asset.text_to_3d");
    const proposal = (await lead.api("GET", `${s}/proposals`)).body[0];
    // Model-judgment evidence is never auto-published, even under the open policy.
    expect(proposal).toMatchObject({ status: "awaiting_approval", evidence: "model_judgment" });
    expect((await lead.api("POST", `${s}/proposals/${proposal.id}/approve`, { reason: "Looks right in preview" })).status).toBe(200);
    const mission = (await lead.api("GET", s)).body.mission;
    const node = mission.config.scene.nodes.find((n: { componentId?: string; assetId?: string }) => !n.componentId && n.assetId);
    expect(node.name).toBe("telescope + radiator");
    const asset = mission.config.assets.find((a: { id: string }) => a.id === node.assetId);
    expect(asset.generator).toBe("asset.text_to_3d@1.0.0 (keyword_composition)");
    const glb = await fetch(`${site.base}${asset.uri}`, { headers: { cookie: lead.cookie } });
    expect(validateGlb(new Uint8Array(await glb.arrayBuffer())).triangles).toBe(asset.triangles);

    const whale = await lead.api("POST", `${s}/requests`, { text: "Generate a 3D model of a friendly space whale", wait: true });
    expect(whale.body.status).toBe("failed");
    expect(JSON.stringify(whale.body)).toMatch(/only recognises common spacecraft parts/);
  }, 30000);

  it("uses a model-written shape program when a model is configured, with retrieved knowledge in the analysis prompt", async () => {
    const prompts: string[] = [];
    const llm: LlmService = {
      modelId: "scripted",
      status: () => ({ available: true }),
      structured: async (args) => {
        prompts.push(args.prompt);
        if (args.system.includes("You convert a user's natural-language request")) {
          return args.schema.parse({ summary: "Model a sample canister", operations: [{ category: "asset_generation_3d", intent: "generate_asset", description: "Sample canister mock-up", paramsJson: JSON.stringify({ prompt: "sample return canister, 30 cm tall" }), assumptions: [] }], missingInformation: [] });
        }
        if (args.system.includes("You design simple 3D mock-ups")) {
          return args.schema.parse({ title: "Sample canister", notes: "30 cm tall as requested", parts: [
            { name: "body", shape: "cylinder", sizeM: [0.16, 0.3, 0.001], positionM: [0, 0, 0], rotationDeg: [0, 0, 0], material: "aluminum" },
            { name: "lid", shape: "cone", sizeM: [0.16, 0.05, 0.08], positionM: [0, 0.175, 0], rotationDeg: [0, 0, 0], material: "gold_foil" },
          ] });
        }
        throw new Error("unexpected prompt");
      },
    };
    const s2 = await serve(createPlatform({ llm }));
    try {
      const user = await signUp(s2.base, "modeler");
      const created = await user.api("POST", "/api/sessions", { scenarioId: "lunar-volatiles", name: "LLM", seed: 5, difficulty: "cadet" });
      const s = `/api/sessions/${created.body.session.id}`;
      const done = await user.api("POST", `${s}/requests`, { text: "Model a sample canister for the concept maturity level review", wait: true });
      expect(done.body.requirement.analysis).toMatchObject({ method: "llm", verification: "model_judgment" });
      expect(prompts[0]).toMatch(/Reference material \(retrieved from the research knowledge base\)/);
      expect(prompts[0]).toMatch(/\[1\] \(/);
      expect(done.body.requirement.analysis.retrievedSources.length).toBeGreaterThan(0);
      const proposal = (await user.api("GET", `${s}/proposals`)).body[0];
      expect(proposal.status).toBe("awaiting_approval");
      await user.api("POST", `${s}/proposals/${proposal.id}/approve`, { reason: "ok" });
      const mission = (await user.api("GET", s)).body.mission;
      expect(mission.config.assets.at(-1).generator).toBe("asset.text_to_3d@1.0.0 (llm_shape_program)");
      expect(mission.config.scene.nodes.at(-1)).toMatchObject({ name: "Sample canister", position: [1.9, 0.9, 0.6] });
    } finally {
      await s2.close();
    }
  }, 30000);

  it("overlays a GMAT report and a J2 propagation on the scene, and removes them", async () => {
    const created = await lead.api("POST", "/api/sessions", { scenarioId: "leo-cubesat", name: "Overlay", seed: 3, difficulty: "cadet" });
    const s = `/api/sessions/${created.body.session.id}`;
    const config = (await lead.api("GET", s)).body.mission.config;
    // Stand-in for a file GMAT would write: our own propagation in ReportFile layout.
    const truth = propagateJ2({ body: config.centralBody, ...config.orbit }, 6000, 20, 300);
    const report = ["Sat.ElapsedSecs   Sat.EarthMJ2000Eq.X   Sat.EarthMJ2000Eq.Y   Sat.EarthMJ2000Eq.Z   Sat.EarthMJ2000Eq.VX   Sat.EarthMJ2000Eq.VY   Sat.EarthMJ2000Eq.VZ",
      ...truth.samples.map((p) => [p.tS, ...p.positionKm, ...p.velocityKmS].map((v) => v.toFixed(6)).join("   "))].join("\n");
    const gmat = await lead.api("POST", `${s}/trajectories`, { kind: "gmat", report, name: "GMAT run 12", wait: true });
    expect(gmat.status).toBe(202);
    const j2 = await lead.api("POST", `${s}/trajectories`, { kind: "j2", days: 2, wait: true });
    expect(j2.body.status).toBe("published");
    const mission = (await lead.api("GET", s)).body.mission;
    const [a, b] = mission.config.scene.trajectories;
    expect(a).toMatchObject({ name: "GMAT run 12", source: "gmat_report", verification: "external_data" });
    expect(a.pointsKm).toHaveLength(truth.samples.length);
    expect(a.pointsKm[10][0]).toBeCloseTo(truth.samples[10]!.positionKm[0], 3);
    expect(b).toMatchObject({ source: "j2_propagation", verification: "deterministic_calculation", durationS: 172800 });
    expect(b.note).toMatch(/node drift/);
    expect((await lead.api("POST", `${s}/trajectories`, { kind: "gmat", report: "this is not a report" })).status).toBe(400);
    const removed = await lead.api("DELETE", `${s}/trajectories/${a.id}`);
    expect(removed.status).toBe(202);
    await platform.sessions.get(created.body.session.id)!.requests.wait(removed.body.id);
    expect((await lead.api("GET", s)).body.mission.config.scene.trajectories.map((t: { id: string }) => t.id)).toEqual([b.id]);
  }, 30000);

  for (const scenarioId of ["leo-cubesat", "mars-weather-relay"] as const) {
    it(`plays ${scenarioId} from briefing to a scored submission`, async () => {
      const scenario = SCENARIOS.find((x) => x.id === scenarioId)!;
      const created = await lead.api("POST", "/api/sessions", { scenarioId, name: `Run ${scenarioId}`, seed: 21, difficulty: "cadet" });
      expect(created.status).toBe(201);
      const s = `/api/sessions/${created.body.session.id}`;
      // Fit one of every instrument kind in the catalogue (the baseline carries none).
      const fitted = new Set<string>();
      for (const item of scenario.catalog) {
        const kind = (item.component as { kind?: string }).kind;
        if (item.component.type === "instrument" && kind && !fitted.has(kind)) {
          expect((await lead.api("POST", `${s}/catalog`, { itemId: item.id, wait: true })).status).toBe(202);
          fitted.add(kind);
        }
      }
      const before = (await lead.api("GET", s)).body;
      expect(before.mission.config.centralBody).toBe(scenario.destination);
      const sma = before.mission.config.orbit.semiMajorAxisKm as number;
      const inc = before.mission.config.orbit.inclinationDeg as number;
      const science = (before.scenario.objectives as { id: string; category: string }[]).find((o) => o.category === "science")!;
      expect((await lead.api("POST", `${s}/define`, { statement: `Fly ${scenario.title} and return its science data.`, primary: science.id })).status).toBe(200);
      // A mission with no way to space cannot be submitted; this crew flies the largest vehicle.
      expect((await lead.api("POST", `${s}/edit`, { baseVersion: before.mission.version, patches: [{ op: "set", path: "meta.launchVehicleId", value: "heavy" }] })).status).toBe(200);
      await lead.api("POST", `${s}/phase`);
      await lead.api("POST", `${s}/trade`, { path: "orbit.semiMajorAxisKm", values: [0.99, 1, 1.03].map((f) => sma * f), metrics: [{ node: "orbit.eclipse", field: "eclipseFraction" }, { node: "power.budget", field: "marginFraction" }] });
      await lead.api("POST", `${s}/trade`, { path: "orbit.inclinationDeg", values: [inc - 2, inc, inc + 1], metrics: [{ node: "science.return", field: "maxCoverageLatitudeDeg" }] });
      await lead.api("POST", `${s}/phase`);
      const sim = await lead.api("POST", `${s}/simulate`);
      expect(sim.status).toBe(200);
      expect(sim.body.days).toBeGreaterThan(30);
      for (const risk of ["Launch slip shifts the eclipse season", "Radiation upsets in the payload computer", "Downlink station outage"]) await lead.api("POST", `${s}/notes`, { kind: "mission_problem", summary: risk, mitigation: "Margin and operational workaround" });
      expect((await lead.api("POST", `${s}/review`)).status).toBe(200);
      await lead.api("POST", `${s}/phase`);
      const state = (await lead.api("GET", s)).body;
      const submitted = await lead.api("POST", `${s}/submit`);
      expect(submitted.status, JSON.stringify({ phase: state.game?.phase, error: submitted.body?.error })).toBe(200);
      expect(submitted.body.evaluation.simulated).toBe(true);
      expect(submitted.body.evaluation.score).toBeGreaterThan(20);
      expect(submitted.body.evaluation.score).toBeLessThanOrEqual(100);
      expect(submitted.body.submission.scenarioId).toBe(scenarioId);
      const board = (await (await fetch(`${site.base}/api/leaderboard?scenario=${scenarioId}`)).json()) as { sessionName: string }[];
      expect(board.map((b) => b.sessionName)).toContain(`Run ${scenarioId}`);
    }, 60000);
  }
});

describe("HTTPS serving", () => {
  it("serves the API over TLS with secure cookies", async (ctx) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tls-test-"));
    try {
      try {
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
      } catch {
        return ctx.skip(); // no openssl on this machine: nothing to verify
      }
      const cert = readFileSync(path.join(dir, "cert.pem"));
      const platform = createPlatform({ llm: noLlm });
      const server = createPlatformServer(platform, { webDir: path.join(os.tmpdir(), "no-web-build-here"), tls: { cert, key: readFileSync(path.join(dir, "key.pem")) } });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as AddressInfo).port;
      const request = (method: string, route: string, body?: string): Promise<{ status: number; headers: Record<string, unknown>; text: string }> =>
        new Promise((resolve, reject) => {
          const req = https.request({ host: "127.0.0.1", port, path: route, method, ca: cert, servername: "localhost", headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
            let text = "";
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
          });
          req.on("error", reject);
          req.end(body);
        });
      try {
        const health = await request("GET", "/api/health");
        expect(JSON.parse(health.text)).toEqual({ ok: true, service: "mission-platform", secure: true });
        const registered = await request("POST", "/api/auth/register", JSON.stringify({ username: "tls-user", password: "integration-test-password-1" }));
        expect(registered.status).toBe(201);
        expect(String(registered.headers["set-cookie"])).toMatch(/HttpOnly; SameSite=Lax; Max-Age=\d+; Secure/);
      } finally {
        (server as unknown as { collab: { close(): void } }).collab.close();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await platform.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
