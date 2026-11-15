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
  await lead.waitForSelector(".brief-card");
  check("landing page renders with missions from the API", (await lead.locator(".brief-card").count()) >= 3);
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
  check("destinations are shown with portraits rendered from NASA imagery", await lead.evaluate(() => [...document.querySelectorAll(".scenario-card .orb")].every((o) => /planets\/(moon|earth|mars)\.webp/.test(getComputedStyle(o).backgroundImage))));
  check("a mission can be started ranked or as a sandbox", (await lead.getByRole("button", { name: /Sandbox/ }).count()) === 1 && (await lead.getByRole("button", { name: /Ranked mission/ }).count()) === 1);
  await lead.screenshot({ path: path.join(shots, "02-lobby.png") });
  await lead.getByRole("button", { name: "Launch mission" }).click();
  await lead.waitForURL("**/mission?s=**");
  await ready(lead);
  const sessionUrl = lead.url();
  check("mission workspace opens with an IWSDK world", await lead.evaluate(() => Boolean(window.__workspace?.scene.mission?.config.centralBody)));
  check("desktop fallback: XR reported unavailable with a reason", await lead.evaluate(() => { const s = window.__workspace.support; return !s.immersiveAr && !s.immersiveVr && typeof s.reason === "string" && s.reason.length > 10; }), await lead.evaluate(() => window.__workspace.support.reason));
  // The problem panel invites the crew to say what it is going for; nothing is forced on the first look.
  await wait(7000); // arrival fly-in
  check("the mission opens on the problem, with nothing in the way", (await lead.locator(".modal-veil").count()) === 0 && (await lead.locator(".problem h2").count()) === 1);
  await lead.getByRole("button", { name: "Say what your crew is going for" }).click();
  const defineForm = await lead.waitForSelector(".modal.define", { timeout: 10000 }).then(() => true, () => false);
  check("the crew can define its mission from the problem panel", defineForm);
  if (defineForm) {
    await lead.screenshot({ path: path.join(shots, "03a-define-mission.png") });
    await lead.locator(".modal.define textarea").fill("Map hydrogen near the lunar south pole finely enough to choose a rover route.");
    await lead.locator(".modal.define .preset", { hasText: "Map hydrogen" }).click();
    await lead.locator(".modal.define .preset", { hasText: "Find the cold traps" }).click();
    await lead.locator(".modal.define").getByRole("button", { name: "Define the mission" }).click();
    await lead.waitForSelector(".modal.define", { state: "detached", timeout: 10000 });
    const shaped = await lead.waitForSelector(".left .chip:has-text('primary ×1.5')", { timeout: 10000 }).then(() => true, () => false);
    check("the mission definition reshapes the scored objectives (primary and stretch goal)", shaped && (await lead.locator(".left .objective", { hasText: "Find the cold traps" }).count()) === 1);
  }
  await wait(1500);
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
  // Turn the Moon: drag the planet on one screen, and the clock, the lighting and the other screen follow.
  {
    const reading = (p) => p.evaluate(() => { const s = window.__workspace.scene; return { ms: s.clockMs, rate: s.clockRate, spin: s.planet.globe.rotation.y, sun: s.sunDirection.toArray(), phase: s.telemetry()?.moonPhase?.illuminated ?? null }; });
    // The first-visit walkthrough sits over the middle of the stage: close it, as a player would.
    const skip = flight.getByRole("button", { name: "Skip" });
    if (await skip.count()) await skip.click();
    await wait(400);
    const box = await flight.locator(".stage canvas").boundingBox();
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    const start = await reading(flight);
    await flight.mouse.move(cx, cy);
    await flight.mouse.down();
    for (let i = 1; i <= 20; i++) { await flight.mouse.move(cx + i * 10, cy); await wait(30); }
    await flight.mouse.up();
    await wait(1500);
    const turned = await reading(flight);
    const followed = await reading(lead);
    const days = (turned.ms - start.ms) / 86400000;
    check("dragging the Moon turns it and moves the mission clock (a turn of the Moon is a month)", days > 0.5 && days < 27 && turned.rate === 0 && Math.abs(turned.spin - start.spin) > 0.05, `clock moved ${days.toFixed(2)} days`);
    check("the Sun's direction and the Moon's phase follow the clock", JSON.stringify(turned.sun) !== JSON.stringify(start.sun) && turned.phase !== start.phase, `lit fraction ${(start.phase * 100).toFixed(0)}% → ${(turned.phase * 100).toFixed(0)}%`);
    check("the other participant's scene shows the same moment", Math.abs(followed.ms - turned.ms) < 60000 && followed.rate === 0, `${Math.round(Math.abs(followed.ms - turned.ms) / 1000)} s apart`);
    check("the clock deck shows what is true at that moment and what the models say", (await flight.locator(".clockdeck .state").count()) >= 3 && (await flight.locator(".clockdeck .moment").count()) === 1);
    await flight.screenshot({ path: path.join(shots, "03b-turn-the-moon.png") });
    await flight.getByRole("button", { name: "Mission date", exact: true }).click();
    await wait(600);
  }
  // The mission arrives with its problem set up: what has to be got right, the controls that matter, the parts on offer.
  check("the problem arrives with its kit: the crux, its controls and its parts", (await flight.locator(".problem .crux").count()) === 1 && (await flight.locator(".problem .lever").count()) >= 3 && /Parts · [0-9]/i.test(await flight.locator(".problem .kit-tabs").innerText()), `${await flight.locator(".problem .lever").count()} controls`);
  const before = await lead.evaluate(() => window.__workspace.scene.mission.version);
  // Grace drags the altitude slider to 60 km.
  await flight.evaluate(() => {
    const input = document.querySelector('.hud .left .lever input[type="range"]'); // the problem's own altitude control
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
  await lead.getByRole("button", { name: "design", exact: true }).click();
  await lead.locator(".right .objective", { hasText: "Neutron spectrometer" }).getByRole("button", { name: "Add" }).click();
  await lead.waitForFunction(() => window.__workspace.scene.mission.config.spacecraft.components.some((c) => c.kind === "neutron_spectrometer"), null, { timeout: 20000 });
  await flight.waitForFunction(() => window.__workspace.scene.mission.config.assets.length === 1, null, { timeout: 20000 });
  check("a catalogue component is built by the pipeline and deployed to both participants", true);
  // It arrives on board unconnected: the wiring check says so, and Connect fits its lines for everyone.
  const looseId = await lead.evaluate(() => window.__workspace.scene.mission.derived["systems.wiring"].value.unconnected[0] ?? null);
  check("a part added from the catalogue arrives unconnected and is flagged", Boolean(looseId) && (await lead.evaluate(() => window.__workspace.scene.lineCount)) === (await lead.evaluate(() => window.__workspace.scene.mission.config.systems.links.length)));
  await lead.getByRole("button", { name: "systems", exact: true }).click();
  await lead.locator(".attention .tool").first().getByRole("button", { name: "Connect" }).click();
  const wiredForBoth = await Promise.all([lead, flight].map((p) => p.waitForFunction((id) => window.__workspace.scene.mission.config.systems.links.filter((l) => l.from.node === id || l.to.node === id).length === 3, looseId, { timeout: 30000 }).then(() => true, () => false)));
  check("Connect fits its power, data and control lines for both participants", wiredForBoth.every(Boolean));
  check("the 3D systems view draws exactly the lines the design has", (await flight.evaluate(() => window.__workspace.scene.lineCount)) === (await flight.evaluate(() => window.__workspace.scene.mission.config.systems.links.length)));
  await lead.getByRole("button", { name: "design", exact: true }).click();
  await lead.getByRole("button", { name: "Systems", exact: true }).click();
  await wait(2500);
  const modelMeshes = await lead.evaluate(() => { let meshes = 0; window.__workspace.scene.componentObjects.get("inst1")?.traverse((o) => { if (o.isMesh) meshes++; }); return meshes; });
  check("the new component appears in the systems view as a flight-hardware model", modelMeshes >= 5, `${modelMeshes} meshes in the instrument model`);

  // ---- Text-to-3D: described object → shape program → validated GLB → approval → loaded into the scene ----
  await lead.getByRole("button", { name: /^AI/ }).click();
  await lead.locator("textarea").fill("Create a 3D model of a star tracker telescope with a radiator");
  await lead.getByRole("button", { name: "Send", exact: true }).click();
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
  await lead.getByRole("button", { name: "Send", exact: true }).click();
  const planned = await lead.waitForSelector(".plan-step.succeeded:has-text(\"science.comms.link_budget\")", { timeout: 20000 }).then(() => true, () => false);
  check("a natural-language request runs through the pipeline and shows its plan", planned);
  const replied = await lead.waitForFunction(() => [...document.querySelectorAll(".chat .turn .ai p")].some((p) => (p.textContent ?? "").length > 20), null, { timeout: 15000 }).then(() => true, () => false);
  check("the player's AI answers in words, with what was measured behind it", replied && (await lead.locator(".chat .turn .ai details").count()) > 0);
  await lead.getByRole("button", { name: "analysis", exact: true }).click();
  await lead.getByRole("button", { name: "Propagate" }).click();
  await lead.waitForFunction(() => window.__workspace.scene.mission.config.scene.trajectories.length === 1, null, { timeout: 20000 }).then(() => check("a J2-propagated trajectory overlay is published to the scene", true), () => check("a J2-propagated trajectory overlay is published to the scene", false));
  await lead.getByRole("button", { name: "Run mission simulation" }).click();
  await lead.waitForSelector("text=Data returned", { timeout: 20000 });
  check("the mission simulation runs and reports KPIs", true);
  const flightEventCards = await lead.locator(".event-card").count();
  check("the flight meets in-flight events and reports what each one cost", flightEventCards === 2 && (await lead.locator(".event-card", { hasText: /science data/ }).count()) === 2, `${flightEventCards} event(s) at Engineer difficulty`);
  check("development time is tracked as a resource", (await lead.locator(".metric", { hasText: "Schedule margin" }).count()) === 1);
  await lead.screenshot({ path: path.join(shots, "05-analysis.png") });
  // Save a design and compare it with the starting point.
  await lead.getByRole("button", { name: "designs", exact: true }).click();
  await lead.getByPlaceholder(/Name this design/).fill("First pass");
  await lead.getByRole("button", { name: "Save", exact: true }).click();
  await lead.waitForSelector(".right .objective:has-text('First pass')", { timeout: 10000 });
  await lead.getByRole("button", { name: "Share with other crews" }).click();
  const sharedListed = await lead.waitForSelector(".right .objective:has-text('Load into our mission')", { timeout: 10000 }).then(() => true, () => false);
  check("a design can be saved and shared with other crews", sharedListed);
  await lead.locator(".right").getByRole("button", { name: "Compare", exact: true }).first().click();
  const comparedRows = await lead.waitForSelector("table.compare tbody tr", { timeout: 10000 }).then(() => lead.locator("table.compare tbody tr").count(), () => 0);
  check("two designs are compared side by side", comparedRows >= 10 && (await lead.locator("table.compare td.win").count()) > 0, `${comparedRows} rows`);
  await lead.screenshot({ path: path.join(shots, "05b-designs.png") });
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
      // Turn the world in the headset: grab the handle on the planet's ring and carry it around the equator.
      const clockBefore = await lead.evaluate(() => window.__workspace.scene.clockMs);
      const ring = await xr.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const right = window.__xrDevice.controllers.right;
        const ws = window.__workspace;
        const at = ws.debug.timeRing();
        if (!at) return { held: 0, days: 0 };
        const [hx, hy, hz, cx, cy, cz] = at;
        const before = ws.scene.clockMs;
        right.position.set(hx, hy, hz);
        await sleep(400);
        right.updateButtonValue("squeeze", 1);
        await sleep(500);
        const held = ws.debug.grabbing();
        const [rx, rz] = [hx - cx, hz - cz];
        for (let i = 1; i <= 12; i++) { const a = 0.05 * i; right.position.set(cx + rx * Math.cos(a) + rz * Math.sin(a), hy, cz - rx * Math.sin(a) + rz * Math.cos(a)); await sleep(60); }
        await sleep(300);
        right.updateButtonValue("squeeze", 0);
        await sleep(700);
        return { held, days: (ws.scene.clockMs - before) / 86400000 };
      });
      check("in the headset, carrying the ring's handle around the planet turns time", ring.held > 0 && Math.abs(ring.days) > 0.2, `${ring.held} object(s) held, clock moved ${ring.days.toFixed(2)} days`);
      const clockFollowed = await lead.waitForFunction((b) => Math.abs(window.__workspace.scene.clockMs - b) > 3600000, clockBefore, { timeout: 8000 }).then(() => true, () => false);
      check("time turned in the headset shows on the desktop participants' screens", clockFollowed);
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
  if (browser) await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]); // closing a headless browser can hang while another Edge is open
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
process.exit(0);
