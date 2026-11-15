// Web ↔ MR on one mission, for the build-and-connect loop. The headset is the Immersive Web Emulation
// Runtime (IWER) in a desktop browser — an emulator, not a physical device. It runs the same page and
// the same WebXR code path a headset browser would; what it cannot show is real tracking, passthrough
// or comfort on hardware.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("playwright-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const out = path.resolve("reports/evidence/ui");
fs.mkdirSync(out, { recursive: true });
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 320)}` : ""}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const problems = [];
async function player(name, display) {
  const ctx = await browser.newContext({ viewport: { width: 1680, height: 980 } });
  const page = await ctx.newPage();
  page.setDefaultTimeout(90000);
  page.on("pageerror", (e) => problems.push(`${name}: ${String(e).slice(0, 200)}`));
  await page.goto(`${BASE}/api/health`);
  const post = (route, body) => page.evaluate(([r, b]) => fetch(r, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [route, body]);
  const get = (route) => page.evaluate((r) => fetch(r, { credentials: "include" }).then((x) => x.json()), route);
  const creds = { username: name, password: "xr-loop-check-password-1", displayName: display };
  if ((await post("/api/auth/register", creds)).status >= 300) await post("/api/auth/login", creds);
  await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
  return { name, page, post, get };
}
const web = await player("xrweb", "Web player");
const mr = await player("xrheadset", "Headset player");
const sid = (await web.post("/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 21, name: "Evidence Web and MR", visibility: "public" })).body.session.id;
await mr.post(`/api/sessions/${sid}/join`, {});
say(`# Web ↔ MR (IWER emulator) — ${new Date().toISOString()} — session ${sid}`);
await web.page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
await web.page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await mr.page.goto(`${BASE}/mission?s=${sid}&intro=0&iwer=1`, { waitUntil: "domcontentloaded" });
await mr.page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await wait(5000);
const support = await mr.page.evaluate(() => window.__workspace.support);
check("the emulated headset is detected", support.webxr && (support.immersiveAr || support.immersiveVr), JSON.stringify(support));
await mr.page.evaluate((m) => window.__workspace.enterXr(m), support.immersiveAr ? "ar" : "vr");
const entered = await mr.page.waitForFunction(() => window.__workspace.inXr === true, null, { timeout: 30000 }).then(() => true, () => false);
check(`an immersive-${support.immersiveAr ? "ar" : "vr"} session starts`, entered);
await wait(1500);

// Web → MR: a part added on the web appears in the headset's scene, flagged as not connected.
const linesBefore = await mr.page.evaluate(() => window.__workspace.scene.lineCount);
await web.post(`/api/sessions/${sid}/catalog`, { itemId: "ns", wait: true });
await mr.page.waitForFunction(() => window.__workspace.scene.mission.config.spacecraft.components.some((c) => c.type === "instrument"), null, { timeout: 60000 });
await wait(1500);
const instId = await mr.page.evaluate(() => window.__workspace.scene.mission.config.spacecraft.components.find((c) => c.type === "instrument").id);
const hud1 = await mr.page.evaluate(() => ({ status: window.__workspace.debug.status(), quick: window.__workspace.debug.quick(), lines: window.__workspace.scene.lineCount, hasObject: window.__workspace.scene.componentObjects.has(window.__workspace.scene.mission.config.spacecraft.components.find((c) => c.type === "instrument").id) }));
check("Web → MR: the part added on the web is an object in the headset's scene", hud1.hasObject);
check("the headset's status panel says a part is not connected, and offers to connect it", /not connected/.test(hud1.status.find((l) => l.k === "Wiring")?.v ?? "") && /^Connect /.test(hud1.quick[0] ?? ""), `${JSON.stringify(hud1.status.slice(0, 4))} · quick: ${hud1.quick.join(" | ")}`);
check("no line is drawn to the unconnected part (drawn lines = real lines)", hud1.lines === linesBefore, `${linesBefore} → ${hud1.lines}`);

// MR → Web: the headset's quick command connects it; the web sees the three lines and the goal turn on.
const pressed = await mr.page.evaluate(() => window.__workspace.debug.pressQuick(0));
await web.page.waitForFunction((id) => window.__workspace.scene.mission.config.systems.links.some((l) => l.from.node === id || l.to.node === id), instId, { timeout: 60000 }).catch(() => null);
await wait(1500);
const webSnap = await web.get(`/api/sessions/${sid}`);
const mine = webSnap.mission.config.systems.links.filter((l) => l.from.node === instId || l.to.node === instId);
check("MR → Web: Connect pressed in the headset fits the lines, and the web shows them", pressed && mine.length === 3 && webSnap.evaluation.objectives.find((o) => o.id === "hydrogen").achieved === 1, mine.map((l) => l.kind).join(", "));
const hud2 = await mr.page.evaluate(() => ({ status: window.__workspace.debug.status(), lines: window.__workspace.scene.lineCount }));
check("the headset draws the three new lines and reports the wiring as complete", hud2.lines === linesBefore + 3 && /all connected/.test(hud2.status.find((l) => l.k === "Wiring")?.v ?? ""), `${linesBefore} → ${hud2.lines} lines · ${hud2.status.find((l) => l.k === "Wiring")?.v}`);
check("web and headset draw the same number of lines", (await web.page.evaluate(() => window.__workspace.scene.lineCount)) === hud2.lines);

// Web → MR: control logic installed on the web shows on the headset's status panel.
const ctl = { id: "ctl-xr", name: "Power saver", description: "Runs the instruments a quarter of the time when power is short.", hostId: "bus", memory: { saving: 0 }, rules: [{ when: "power.marginW < 0 or battery.soc < 0.6", do: [{ target: "mem:saving", value: "1" }] }, { when: "battery.soc > 0.9 and power.marginW >= 0", do: [{ target: "mem:saving", value: "0" }] }, { when: "mem.saving == 1", do: [{ target: "instruments", value: "nominal * 0.25" }], note: "saving power" }], origin: { kind: "user_authored" } };
const installed = await web.page.evaluate((c) => window.__collabEdit([{ op: "append", path: "systems.controllers", value: c }], "Install Power saver"), ctl);
await mr.page.waitForFunction(() => window.__workspace.scene.mission.config.systems.controllers.length === 1, null, { timeout: 20000 }).catch(() => null);
await wait(800);
const hud3 = await mr.page.evaluate(() => ({ status: window.__workspace.debug.status(), quick: window.__workspace.debug.quick() }));
check("Web → MR: control logic installed on the web is named on the headset's status panel", installed?.ok === true && /Power saver/.test(hud3.status.find((l) => l.k === "Control")?.v ?? ""), `${hud3.status.find((l) => l.k === "Control")?.v} · quick: ${hud3.quick.join(" | ")}`);

// MR → Web: the headset flies the mission; the web shows the flown outcome.
const flyIndex = hud3.quick.findIndex((q) => /Fly the mission/.test(q));
await mr.page.evaluate((i) => window.__workspace.debug.pressQuick(i), flyIndex);
await web.page.waitForFunction(() => /flown \d+ days/.test(document.querySelector(".outcome")?.textContent ?? ""), null, { timeout: 60000 }).catch(() => null);
const outcome = await web.page.locator(".outcome").innerText();
check("MR → Web: Fly pressed in the headset; the web shows the flown outcome", flyIndex >= 0 && /flown \d+ days/.test(outcome), outcome);
const hud4 = await mr.page.evaluate(() => window.__workspace.debug.status());
check("the headset's Mission line follows the same outcome", Boolean(hud4.find((l) => l.k === "Mission")?.v), JSON.stringify(hud4.slice(0, 2)));

// MR → Web: time turned in the headset moves the web player's clock (shared), while cameras stay personal.
const camWeb0 = await web.page.evaluate(() => window.__workspace.debug.camera());
await mr.page.evaluate(() => window.__workspace.debug.turn(0.6));
await wait(1500);
const clocks = [await web.page.evaluate(() => window.__workspace.scene.clockMs), await mr.page.evaluate(() => window.__workspace.scene.clockMs)];
const camWeb1 = await web.page.evaluate(() => window.__workspace.debug.camera());
check("MR → Web: time turned in the headset is the same moment on the web", Math.abs(clocks[0] - clocks[1]) < 5000 && clocks[0] !== Date.parse(webSnap.mission.config.missionTime), `${new Date(clocks[0]).toISOString()} vs ${new Date(clocks[1]).toISOString()}`);
check("the web player's own view did not move when the headset player acted", Math.hypot(camWeb0[0] - camWeb1[0], camWeb0[1] - camWeb1[1], camWeb0[2] - camWeb1[2]) < 1e-6);
await web.page.screenshot({ path: path.join(out, "20-web-after-mr-actions.png") });
await mr.page.screenshot({ path: path.join(out, "21-mr-emulator-view.png") });
// The page itself shows only the "session active" card; this is the frame drawn for the (emulated) headset.
const frameUrl = await Promise.race([mr.page.evaluate(() => window.__workspace.debug.capture()).catch(() => null), new Promise((r) => setTimeout(() => r(null), 8000))]);
if (frameUrl) fs.writeFileSync(path.join(out, "22-mr-headset-frame.jpg"), Buffer.from(frameUrl.split(",")[1], "base64"));
say(`page errors: ${problems.length ? problems.join(" || ") : "none"}`);
say("verification level: WebXR emulator (IWER) in desktop Edge. Not verified: a physical headset (tracking, passthrough, hand input, performance, comfort).");
fs.writeFileSync(path.resolve("reports/evidence/xr-loop.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]); // closing a headless browser can hang while another Edge is open
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
