// Does the emulated headset session actually draw frames, and what is in them?
// Enters an immersive session in the IWER emulator, counts render calls over two seconds and saves the
// frame the renderer drew for the session. No language model is involved.
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
const limited = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const page = await (await browser.newContext({ viewport: { width: 1680, height: 980 } })).newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text().slice(0, 300)); });
await page.goto(`${BASE}/api/health`);
const post = (route, body) => page.evaluate(([r, b]) => fetch(r, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [route, body]);
const creds = { username: "xrframe", password: "xr-frame-check-password-1", displayName: "Headset player" };
if ((await post("/api/auth/register", creds)).status >= 300) await post("/api/auth/login", creds);
await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
const sid = (await post("/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 21, name: "Headset frame" })).body.session.id;
say(`# Headset frame (IWER emulator) — ${new Date().toISOString()} — session ${sid}`);
await page.goto(`${BASE}/mission?s=${sid}&intro=0&iwer=1`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await wait(5000);
const support = await page.evaluate(() => window.__workspace.support);
for (const mode of [support.immersiveAr ? "ar" : null, support.immersiveVr ? "vr" : null].filter(Boolean)) {
  await page.evaluate((m) => window.__workspace.enterXr(m), mode);
  const entered = await page.waitForFunction(() => window.__workspace.inXr === true, null, { timeout: 30000 }).then(() => true, () => false);
  check(`an immersive-${mode} session starts`, entered);
  await wait(2500);
  const hud = await page.evaluate(() => ({ status: window.__workspace.debug.status(), quick: window.__workspace.debug.quick() }));
  check(`immersive-${mode}: a solo player who has changed nothing still gets a filled status panel and four labelled quick commands`, hud.status.length >= 4 && hud.quick.length === 4 && hud.quick.every((q) => q.length > 2), `${hud.status.map((l) => `${l.k}: ${l.v}`).slice(0, 4).join(" | ")} · quick: ${hud.quick.join(" | ")}`);
  const frames = await limited(page.evaluate(() => window.__workspace.debug.frames(2000)), 10000);
  check(`immersive-${mode}: the renderer keeps drawing frames for the session`, frames !== null && frames.renders >= 20, JSON.stringify(frames));
  const url = await limited(page.evaluate(() => window.__workspace.debug.capture()), 10000);
  if (url) fs.writeFileSync(path.join(out, `22-mr-headset-frame-${mode}.jpg`), Buffer.from(url.split(",")[1], "base64"));
  const lit = url ? await page.evaluate(async (u) => {
    const img = new Image(); img.src = u; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const x = c.getContext("2d"); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 60) n++;
    return { width: img.width, height: img.height, litShare: n / (d.length / 16) };
  }, url) : null;
  check(`immersive-${mode}: the session's frame has the workspace in it (not an empty frame)`, lit !== null && lit.litShare > 0.01, JSON.stringify(lit));
  if (mode === "vr") {
    // The systems (wiring) view on the table, with a part that is not connected yet.
    await post(`/api/sessions/${sid}/catalog`, { itemId: "ns", wait: true });
    await page.waitForFunction(() => window.__workspace.scene.mission.config.spacecraft.components.some((c) => c.type === "instrument"), null, { timeout: 60000 }).catch(() => null);
    const afterAdd = await limited(page.evaluate(() => window.__workspace.debug.frames(1500)), 10000);
    check("immersive-vr: frames keep coming after a part is added during the session", afterAdd !== null && afterAdd.renders >= 20, JSON.stringify(afterAdd));
    await page.evaluate(() => window.__workspace.setMode("systems"));
    await wait(2500);
    const sysFrames = await limited(page.evaluate(() => window.__workspace.debug.frames(2000)), 10000);
    check("immersive-vr: frames keep coming in the systems view", sysFrames !== null && sysFrames.renders >= 20, JSON.stringify(sysFrames));
    const sysUrl = await limited(page.evaluate(() => window.__workspace.debug.capture()), 15000);
    if (sysUrl) fs.writeFileSync(path.join(out, "22-mr-headset-frame-systems.jpg"), Buffer.from(sysUrl.split(",")[1], "base64"));
    const sys = await page.evaluate(() => ({ lines: window.__workspace.scene.lineCount, wiring: window.__workspace.debug.status().find((l) => l.k === "Wiring")?.v, quick: window.__workspace.debug.quick()[0] }));
    check("immersive-vr: the systems view draws the real lines, and the panel names the part that is not connected", Boolean(sysUrl) && sys.lines > 0 && /not connected/.test(sys.wiring ?? "") && /^Connect /.test(sys.quick ?? ""), JSON.stringify(sys));
    // Pick a part up with the controller: the panel says what that part is missing, then Connect fits its lines.
    const grab = await limited(page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const ws = window.__workspace;
      const inst = ws.scene.mission.config.spacecraft.components.find((c) => c.type === "instrument");
      const at = ws.debug.component(inst.id);
      const right = window.__xrDevice.controllers.right;
      right.quaternion.set(0, 0, 0, 1);
      right.position.set(at[0], at[1], at[2]);
      await sleep(500);
      right.updateButtonValue("squeeze", 1);
      await sleep(600);
      const held = ws.debug.grabbing();
      right.position.set(at[0] + 0.05, at[1] + 0.03, at[2]);
      await sleep(400);
      right.updateButtonValue("squeeze", 0);
      await sleep(1200);
      right.position.set(0.25, 1.0, -0.2);
      return { name: inst.name, id: inst.id, held, activity: ws.debug.activity(), frames: await ws.debug.frames(800) };
    }), 20000);
    check("immersive-vr: picking a part up selects it — the panel says what it is missing, and the session keeps drawing", grab !== null && grab.held > 0 && grab.activity.startsWith(grab.name) && /No power line/.test(grab.activity) && grab.frames.renders >= 10, JSON.stringify(grab).slice(0, 300));
    const connectIndex = (await page.evaluate(() => window.__workspace.debug.quick())).findIndex((q) => /^Connect /.test(q));
    await page.evaluate((i) => window.__workspace.debug.pressQuick(i), connectIndex);
    await page.waitForFunction((id) => window.__workspace.scene.mission.config.systems.links.filter((l) => l.from.node === id || l.to.node === id).length === 3, grab?.id, { timeout: 30000 }).catch(() => null);
    await wait(1200);
    const wired = await page.evaluate(() => ({ activity: window.__workspace.debug.activity(), wiring: window.__workspace.debug.status().find((l) => l.k === "Wiring")?.v, lines: window.__workspace.scene.lineCount }));
    check("immersive-vr: Connect from the headset fits the three lines; the panel then reports the part as fully connected", connectIndex >= 0 && /fully connected/.test(wired.activity) && /all connected/.test(wired.wiring ?? "") && wired.lines === sys.lines + 3, JSON.stringify(wired).slice(0, 300));
    // The player's own AI in the headset: a quick command asks it, and its reply is readable on its panel.
    const before = await page.evaluate(() => window.__workspace.debug.ai());
    const askIndex = (await page.evaluate(() => window.__workspace.debug.quick())).findIndex((q) => /What holds us back/.test(q));
    await page.evaluate((i) => window.__workspace.debug.pressQuick(i), askIndex);
    await page.waitForFunction(() => window.__workspace.debug.ai().visible && window.__workspace.debug.ai().lines.length >= 2, null, { timeout: 60000 }).catch(() => null);
    await wait(800);
    const ai = await page.evaluate(() => window.__workspace.debug.ai());
    const aiUrl = await limited(page.evaluate(() => window.__workspace.debug.capture()), 15000);
    if (aiUrl) fs.writeFileSync(path.join(out, "22-mr-headset-frame-ai.jpg"), Buffer.from(aiUrl.split(",")[1], "base64"));
    check("immersive-vr: a question asked from the headset is answered on the player's AI panel (no panel before the first question)", before.visible === false && askIndex >= 0 && ai.visible && ai.lines.length >= 2, `${ai.lines.length} line(s): ${ai.lines.slice(0, 2).join(" / ")}`);
    // Free text from the headset: typed on the spatial keyboard, sent to the player's own AI, answered on its panel.
    const sentence = "compute the link budget";
    const keys = [...sentence].map((ch) => (ch === " " ? "␣" : ch));
    await page.evaluate(() => window.__workspace.debug.pressKeys(["Keyboard"])); // bring the keyboard up, as a player would
    const pressed = await page.evaluate((k) => window.__workspace.debug.pressKeys(k), keys);
    const typedText = await page.evaluate(() => window.__workspace.debug.typed());
    await wait(400);
    const typingUrl = await limited(page.evaluate(() => window.__workspace.debug.capture()), 15000);
    if (typingUrl) fs.writeFileSync(path.join(out, "22-mr-headset-frame-keyboard.jpg"), Buffer.from(typingUrl.split(",")[1], "base64"));
    await page.evaluate(() => window.__workspace.debug.pressKeys(["Send"]));
    await page.waitForFunction(() => /link|budget|margin/i.test(window.__workspace.debug.ai().lines.join(" ")) && !/holding this mission back/.test(window.__workspace.debug.ai().lines.join(" ")), null, { timeout: 60000 }).catch(() => null);
    const typedAnswer = await page.evaluate(() => window.__workspace.debug.ai());
    const kbUrl = await limited(page.evaluate(() => window.__workspace.debug.capture()), 15000);
    if (kbUrl) fs.writeFileSync(path.join(out, "22-mr-headset-frame-typed.jpg"), Buffer.from(kbUrl.split(",")[1], "base64"));
    check("immersive-vr: a sentence typed on the spatial keyboard reaches the player's AI and its answer comes up on the panel", pressed === keys.length && typedText === sentence && /margin/i.test(typedAnswer.lines.join(" ")), `typed "${typedText}" · ${typedAnswer.lines.slice(0, 2).join(" / ")}`);
    // The AI as a character: the probe is in the session, its bubble carries the answer, a sentence that was
    // "heard" (the step after speech-to-text) is answered the same way, and it goes to a part that is being built.
    const buddy0 = await page.evaluate(() => window.__workspace.debug.companion());
    check("immersive-vr: the AI's probe is in the session and its bubble carries the answer just given", buddy0.visible && /margin/i.test(buddy0.bubble.join(" ")), `${buddy0.state} · ${buddy0.bubble.slice(0, 2).join(" / ")}`);
    await page.evaluate(() => window.__workspace.debug.say("compute the power budget"));
    await page.waitForFunction(() => /d/.test(window.__workspace.debug.companion().bubble.join(" ")) && /power|load|generation|watt/i.test(window.__workspace.debug.companion().bubble.join(" ")), null, { timeout: 60000 }).catch(() => null);
    const buddy1 = await page.evaluate(() => window.__workspace.debug.companion());
    check("immersive-vr: a spoken sentence (after speech-to-text) is answered in the probe's bubble", /d/.test(buddy1.bubble.join(" ")) && /power|load|generation|watt/i.test(buddy1.bubble.join(" ")), buddy1.bubble.slice(0, 3).join(" / "));
    const builtId = await page.evaluate(() => [...window.__workspace.scene.componentObjects.keys()].at(-1));
    await page.evaluate((id) => window.__workspace.debug.built([id]), builtId);
    await page.waitForTimeout(2600);
    const buddy2 = await page.evaluate((id) => ({ ...window.__workspace.debug.companion(), part: window.__workspace.debug.component(id), mode: window.__workspace.scene.mode }), builtId);
    const gap = buddy2.part ? Math.hypot(buddy2.position[0] - buddy2.part[0], buddy2.position[1] - buddy2.part[1], buddy2.position[2] - buddy2.part[2]) : 9;
    const buddyUrl = await limited(page.evaluate(() => window.__workspace.debug.capture()), 15000);
    if (buddyUrl) fs.writeFileSync(path.join(out, "23-mr-companion-building.jpg"), Buffer.from(buddyUrl.split(",")[1], "base64"));
    check("immersive-vr: when a part is built the probe flies to it in the hardware view and says what it is building", buddy2.state === "building" && buddy2.mode === "systems" && gap < 0.5 && /building|assembling/i.test(buddy2.bubble.join(" ")), `${buddy2.state} · ${buddy2.mode} · ${gap.toFixed(2)} m from the part · ${buddy2.bubble[0] ?? ""}`);
    // Sweep both controllers' rays over everything in front of the player, in both views: whatever a ray
    // lands on (parts, labels, lines, panels, the planet, the ring), the session must keep drawing.
    const sweep = async () => page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const aim = (c, from, to) => {
        const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        const n = Math.hypot(d[0], d[1], d[2]); d[0] /= n; d[1] /= n; d[2] /= n;
        // rotation taking -Z (a controller's pointing direction) onto d
        const a = [0, 0, -1];
        const cross = [a[1] * d[2] - a[2] * d[1], a[2] * d[0] - a[0] * d[2], a[0] * d[1] - a[1] * d[0]];
        const w = 1 + (a[0] * d[0] + a[1] * d[1] + a[2] * d[2]);
        const m = Math.hypot(cross[0], cross[1], cross[2], w) || 1;
        c.position.set(from[0], from[1], from[2]);
        c.quaternion.set(cross[0] / m, cross[1] / m, cross[2] / m, w / m);
      };
      const { left, right } = window.__xrDevice.controllers;
      let aimed = 0;
      for (let iy = 0; iy < 6; iy++) for (let ix = 0; ix < 11; ix++) {
        const target = [-0.95 + ix * 0.19, 0.85 + iy * 0.15, -0.8];
        aim(right, [0.2, 1.3, -0.15], target);
        aim(left, [-0.2, 1.3, -0.15], [-target[0], target[1], target[2]]);
        aimed++;
        await sleep(45);
      }
      return aimed;
    });
    const sweptSystems = await limited(sweep(), 30000);
    await page.evaluate(() => window.__workspace.setMode("orbit"));
    await wait(1200);
    const sweptOrbit = await limited(sweep(), 30000);
    const afterSweep = await limited(page.evaluate(() => window.__workspace.debug.frames(1500)), 10000);
    check("immersive-vr: controller rays swept over the whole workspace in both views never stop the session", sweptSystems > 0 && sweptOrbit > 0 && afterSweep !== null && afterSweep.renders >= 20 && problems.length === 0, `${sweptSystems} + ${sweptOrbit} aim points · ${JSON.stringify(afterSweep)} · errors: ${problems.length}`);
  }
  await page.evaluate(() => window.__workspace.exitXr?.());
  await page.waitForFunction(() => window.__workspace.inXr === false, null, { timeout: 15000 }).catch(() => null);
  await wait(1000);
}
say(`page errors: ${problems.length ? problems.join(" || ") : "none"}`);
say("verification level: WebXR emulator (IWER) in desktop Edge. Not verified: a physical headset.");
fs.writeFileSync(path.resolve("reports/evidence/xr-frame.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
