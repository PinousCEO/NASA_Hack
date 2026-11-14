/**
 * End-to-end browser test of the built platform (`npm run e2e`).
 *
 * Starts the real server on a temporary data directory, drives real browser pages with
 * Playwright (using the installed Microsoft Edge or Chrome — no browser download), and
 * checks the user-visible behaviour: sign-up, mission creation, the IWSDK 3D workspace,
 * two participants synchronising a change, a catalogue component deployed with its GLB,
 * and a WebXR session in the Immersive Web Emulation Runtime (a software Quest 3).
 *
 * The XR part verifies the session and interaction code paths in an emulator. It is not
 * a substitute for testing on a physical headset.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const shots = process.env.E2E_SHOTS ?? path.join(os.tmpdir(), "mission-e2e-shots");
mkdirSync(shots, { recursive: true });
if (!existsSync(path.join(ROOT, "apps", "web", "out", "index.html"))) {
  console.error("The web client is not built. Run `npm run build:web` first.");
  process.exit(2);
}

const dataDir = mkdtempSync(path.join(os.tmpdir(), "mission-e2e-"));
const server = spawn(process.execPath, ["--import", "tsx", path.join(ROOT, "src", "server", "main.ts")], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), MISSION_DATA_DIR: dataDir, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", LLM_PROVIDER: "" }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false)) break;
    await wait(250);
  }
  const channel = process.env.E2E_BROWSER ?? "msedge";
  browser = await chromium.launch({ channel, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

  const errors = [];
  const open = async (name) => {
    const context = await browser.newContext({ viewport: { width: 1680, height: 980 } });
    const page = await context.newPage();
    page.setDefaultTimeout(90000); // three software-rendered 3D pages share one CPU
    page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && !/favicon|GPU stall|WebGL|swiftshader/i.test(m.text()) && errors.push(`${name}: ${m.text()}`));
    return page;
  };
  const signUp = async (page, username) => {
    await page.goto(`${BASE}/auth`);
    await page.getByRole("button", { name: "Create account" }).first().click();
    await page.getByLabel("Username").fill(username);
    await page.getByLabel("Display name").fill(username[0].toUpperCase() + username.slice(1));
    await page.getByLabel("Password").fill("e2e-browser-password-1");
    await page.locator("form button.primary").click();
    await page.waitForURL("**/lobby**");
  };
  const ready = async (page) => {
    await page.waitForSelector(".hud .top", { timeout: 30000 });
    await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 30000 });
  };

  // ---- Landing ----
  const lead = await open("lead");
  await lead.goto(BASE);
  await lead.waitForSelector(".scenario-card");
  check("landing page renders with missions from the API", (await lead.locator(".scenario-card").count()) === 3);
  check("landing page has a WebGL backdrop", (await lead.locator(".backdrop canvas").count()) === 1);
  await wait(1200);
  await lead.screenshot({ path: path.join(shots, "01-landing.png") });

  // ---- Auth guard, sign-up, lobby, mission creation ----
  await lead.goto(`${BASE}/lobby`);
  await lead.waitForURL("**/auth**");
  check("unauthenticated visitors are sent to sign-in", true);
  await signUp(lead, "ada");
  await lead.waitForSelector(".scenario-card");
  await wait(600);
  await lead.screenshot({ path: path.join(shots, "02-lobby.png") });
  await lead.getByRole("button", { name: "Launch mission" }).click();
  await lead.waitForURL("**/mission?s=**");
  await ready(lead);
  const sessionUrl = lead.url();
  check("mission workspace opens with an IWSDK world", await lead.evaluate(() => Boolean(window.__workspace?.scene.mission?.config.centralBody)));
  check("desktop fallback: XR reported unavailable with a reason", await lead.evaluate(() => { const s = window.__workspace.support; return !s.immersiveAr && !s.immersiveVr && typeof s.reason === "string" && s.reason.length > 10; }), await lead.evaluate(() => window.__workspace.support.reason));
  await wait(7000); // arrival fly-in and title card
  await lead.screenshot({ path: path.join(shots, "03-workspace-orbit.png") });
  check("the planet is textured from NASA imagery (not the procedural fallback)", await lead.evaluate(() => window.__workspace.scene.planetReady), "LROC WAC tiles through the platform proxy");
  // Decode a screenshot of the middle of the stage in the page and count non-dark pixels.
  const shot = (await lead.screenshot({ clip: { x: 640, y: 290, width: 400, height: 400 } })).toString("base64");
  const pixel = await lead.evaluate(async (b64) => { const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob()); const c = new OffscreenCanvas(100, 100); const x = c.getContext("2d"); x.drawImage(bmp, 0, 0, 100, 100); const d = x.getImageData(0, 0, 100, 100).data; let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 90) lit++; return lit; }, shot);
  check("the 3D stage is actually drawing (lit pixels in a screenshot of the canvas)", pixel > 300, `${pixel} of 10000 sampled pixels lit`);
  check("spatial XR panels stay hidden on the desktop", await lead.evaluate(() => !window.__workspace.debug.uiVisible()));

  // ---- Second participant joins; a change by one appears for the other ----
  const flight = await open("flight");
  await signUp(flight, "grace");
  await flight.goto(sessionUrl);
  await ready(flight);
  await lead.waitForFunction(() => document.querySelectorAll(".hud .top .avatar").length === 2, null, { timeout: 15000 });
  check("both participants see each other in the crew bar", true);
  const before = await lead.evaluate(() => window.__workspace.scene.mission.version);
  // Grace drags the altitude slider to 60 km.
  await flight.evaluate(() => {
    const input = document.querySelector('.hud .right input[type="range"]');
    input.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "60");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await lead.waitForFunction((v) => window.__workspace.scene.mission.version > v, before, { timeout: 15000 });
  const synced = await lead.evaluate(() => { const m = window.__workspace.scene.mission; return { alt: m.derived["orbit.elements"].value.periapsisAltitudeKm, recalculated: m.recalculated.length, by: m.publishedBy }; });
  check("a parameter change by one participant reaches the other as authoritative state", Math.abs(synced.alt - 60) < 1e-6 && synced.recalculated >= 5, `altitude ${synced.alt} km, ${synced.recalculated} models recalculated`);
  check("the other participant is told who changed what", (await lead.locator(".toast").filter({ hasText: "Grace" }).count()) > 0);
  check("recalculated metric tiles animate", (await lead.locator(".metric.pulse").count()) > 0);

  // ---- Catalogue component: asset generated, staged, tested, deployed, rendered ----
  await lead.locator(".objective", { hasText: "Neutron spectrometer" }).getByRole("button", { name: "Add" }).click();
  await lead.waitForFunction(() => window.__workspace.scene.mission.config.spacecraft.components.some((c) => c.kind === "neutron_spectrometer"), null, { timeout: 20000 });
  await flight.waitForFunction(() => window.__workspace.scene.mission.config.assets.length === 1, null, { timeout: 20000 });
  check("a catalogue component is built by the pipeline and deployed to both participants", true);
  await lead.getByRole("button", { name: "Systems" }).click();
  await wait(2500);
  const modelMeshes = await lead.evaluate(() => { let meshes = 0; window.__workspace.scene.componentObjects.get("inst1")?.traverse((o) => { if (o.isMesh) meshes++; }); return meshes; });
  check("the new component appears in the systems view as a flight-hardware model", modelMeshes >= 5, `${modelMeshes} meshes in the instrument model`);

  // ---- Text-to-3D: described object → shape program → validated GLB → approval → loaded into the scene ----
  await lead.getByRole("button", { name: /^AI/ }).click();
  await lead.locator("textarea").fill("Create a 3D model of a star tracker telescope with a radiator");
  await lead.getByRole("button", { name: "Send" }).click();
  const approve = lead.getByRole("button", { name: "Approve & deploy" }).first();
  const previewed = await approve.waitFor({ timeout: 20000 }).then(() => true, () => false);
  check("a text-to-3D request is previewed and waits for approval (model-judgment evidence is never auto-published)", previewed);
  if (previewed) await approve.click();
  const glbShown = await lead.waitForFunction(() => window.__workspace.scene.loadedAssets > 0 && window.__workspace.scene.freeObjects.size > 0, null, { timeout: 20000 }).then(() => true, () => false);
  const glbMeshes = await lead.evaluate(() => { let meshes = 0; for (const o of window.__workspace.scene.freeObjects.values()) o.getObjectByName("glb")?.traverse((m) => { if (m.isMesh) meshes++; }); return meshes; });
  check("the generated, versioned GLB is loaded into the systems view", glbShown && glbMeshes > 0, `${glbMeshes} mesh(es) from the GLB`);
  await flight.waitForFunction(() => window.__workspace.scene.mission.config.scene.nodes.some((n) => !n.componentId && n.assetId), null, { timeout: 15000 }).then(() => check("the generated asset is synchronised to the other participant", true), () => check("the generated asset is synchronised to the other participant", false));
  await wait(1500);
  await lead.screenshot({ path: path.join(shots, "04-workspace-systems.png") });

  // ---- AI runtime builder, analysis and evaluation dashboard ----
  await lead.locator("textarea").fill("Compute the link budget");
  await lead.getByRole("button", { name: "Send" }).click();
  const planned = await lead.waitForSelector(".plan-step.succeeded:has-text(\"science.comms.link_budget\")", { timeout: 20000 }).then(() => true, () => false);
  check("a natural-language request runs through the pipeline and shows its plan", planned);
  await lead.getByRole("button", { name: "analysis", exact: true }).click();
  await lead.getByRole("button", { name: "Propagate" }).click();
  await lead.waitForFunction(() => window.__workspace.scene.mission.config.scene.trajectories.length === 1, null, { timeout: 20000 }).then(() => check("a J2-propagated trajectory overlay is published to the scene", true), () => check("a J2-propagated trajectory overlay is published to the scene", false));
  await lead.getByRole("button", { name: "Run mission simulation" }).click();
  await lead.waitForSelector("text=Data returned", { timeout: 20000 });
  check("the mission simulation runs and reports KPIs", true);
  await lead.screenshot({ path: path.join(shots, "05-analysis.png") });
  await lead.locator(".score-ring").click();
  await lead.waitForSelector(".modal .grade");
  await wait(1800);
  await lead.screenshot({ path: path.join(shots, "06-evaluation.png") });
  check("the evaluation dashboard opens", true);

  // ---- WebXR in the Immersive Web Emulation Runtime ----
  const xr = await open("xr");
  await signUp(xr, "katherine");
  await xr.goto(`${sessionUrl}&iwer=1`);
  await ready(xr);
  const support = await xr.evaluate(() => window.__workspace.support);
  const raw = await xr.evaluate(async () => ({ device: typeof window.__xrDevice, ctor: navigator.xr?.constructor?.name, vr: await navigator.xr.isSessionSupported("immersive-vr").catch((e) => `error: ${e.message}`), ar: await navigator.xr.isSessionSupported("immersive-ar").catch((e) => `error: ${e.message}`) }));
  check("XR capability detection finds the (emulated) headset", support.webxr && (support.immersiveVr || support.immersiveAr), JSON.stringify({ detected: { ar: support.immersiveAr, vr: support.immersiveVr, reason: support.reason }, raw }));
  const xrMode = support.immersiveAr ? "ar" : "vr";
  await xr.evaluate((m) => window.__workspace.enterXr(m), xrMode);
  const entered = await xr.waitForFunction(() => window.__workspace.inXr === true, null, { timeout: 20000 }).then(() => true, () => false);
  check(`an immersive-${xrMode} session starts through IWSDK`, entered);
  if (entered) {
    await wait(1500);
    await lead.waitForFunction(() => [...document.querySelectorAll(".hud .top .avatar")].some((a) => a.textContent === "◉"), null, { timeout: 10000 }).then(() => check("other participants see the headset user as present in XR", true), () => check("other participants see the headset user as present in XR", false));
    // Grab the altitude slider knob with the emulated right controller, drag it, release.
    const versionBefore = await xr.evaluate(() => window.__workspace.scene.mission.version);
    const grabbed = await xr.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const device = window.__xrDevice;
      const right = device.controllers.right;
      const knob = window.__workspace.debug.knob("altitude");
      right.position.set(knob[0], knob[1], knob[2]);
      await sleep(400);
      right.updateButtonValue("squeeze", 1);
      await sleep(500);
      const during = window.__workspace.debug.grabbing();
      for (let i = 1; i <= 10; i++) { right.position.set(knob[0] + 0.012 * i, knob[1], knob[2]); await sleep(60); }
      await sleep(300);
      right.updateButtonValue("squeeze", 0);
      await sleep(800);
      return during;
    });
    check("the emulated controller grabs a spatial slider (IWSDK grab system)", grabbed > 0, `${grabbed} object(s) held`);
    const committed = await xr.waitForFunction((v) => window.__workspace.scene.mission.version > v, versionBefore, { timeout: 8000 }).then(() => true, () => false);
    check("releasing the slider commits an edit that becomes a new mission version", committed);
    if (committed) {
      const note = await lead.evaluate(() => window.__workspace.scene.mission.note);
      check("the XR edit is synchronised to the desktop participants", /XR/.test(note), note);
      check("spatial panels and sliders are shown in XR", await xr.evaluate(() => window.__workspace.debug.uiVisible()));
    }
    await xr.screenshot({ path: path.join(shots, "07-xr-emulated.png") });
    await xr.evaluate(() => window.__workspace.exitXr());
    check("the XR session ends cleanly and the desktop HUD returns", await xr.waitForSelector(".hud .top", { timeout: 10000 }).then(() => true, () => false));
  }

  // ---- Research page ----
  await lead.goto(`${BASE}/research`);
  await lead.waitForSelector("table.data tbody tr", { timeout: 60000 });
  check("research records from this session are listed", (await lead.locator("table.data tbody tr").count()) > 3);
  await lead.screenshot({ path: path.join(shots, "08-research.png") });

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 4).join(" | "));
} catch (err) {
  check("e2e run completed", false, err.message.split("\n")[0]);
} finally {
  await browser?.close();
  server.kill();
  await wait(300);
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${shots}`);
if (failed.length) {
  console.log(serverLog.split("\n").slice(-12).join("\n"));
  process.exit(1);
}
