// The AI conversation in the real UI: it grows downward with the composer at the bottom, each part
// has its own thread, a part's thread does not show the mission thread's messages, and selecting
// things in the systems view leaves one overlay on the stage, not several on top of each other.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("playwright-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
// --no-model: the server has no language model, so questions are answered by the built-in analyser. Everything
// about how the conversation is laid out and kept apart is checked the same way; only what the replies say is not.
const noModel = process.argv.includes("--no-model");
const out = path.resolve("reports/evidence/ui");
fs.mkdirSync(out, { recursive: true });
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 340)}` : ""}`);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
page.setDefaultTimeout(60000);
const problems = [];
page.on("pageerror", (e) => problems.push(String(e).slice(0, 240)));
await page.goto(`${BASE}/api/health`);
const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
const creds = { username: noModel ? "chatpilotlocal" : "chatpilot", password: "ui-chat-check-password-1", displayName: "Chat Pilot" };
if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
const sid = (await call("POST", "/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 21, name: "Evidence chat" })).body.session.id;
say(`# UI run: conversation threads and stage overlays — ${new Date().toISOString()} — session ${sid}`);
await call("POST", `/api/sessions/${sid}/catalog`, { itemId: "ns", wait: true });
await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await page.waitForTimeout(5000);
const requests = () => call("GET", `/api/sessions/${sid}/requests`).then((r) => r.body);
const ask = async (text) => {
  await page.locator(".right .tabs .tab", { hasText: /^AI/ }).click();
  await page.locator(".chat .composer textarea").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const end = Date.now() + 200000;
  while (Date.now() < end) { await page.waitForTimeout(1500); const r = (await requests()).find((x) => x.text === text); if (r && !["queued", "analyzing", "planning", "executing"].includes(r.status)) return r; }
  return null;
};
const tops = () => page.evaluate(() => { const s = document.querySelector(".chat .stream"); const c = document.querySelector(".chat .composer"); return { turns: [...document.querySelectorAll(".chat .stream .turn .me p")].map((p) => ({ text: p.textContent, y: p.getBoundingClientRect().top })), composerY: c.getBoundingClientRect().top, streamBottom: s.getBoundingClientRect().bottom, atBottom: s.scrollHeight - s.scrollTop - s.clientHeight < 4 }; });

// Mission thread: two questions; the second must be below the first, and the composer below both.
const q1 = noModel ? "compute the link budget" : "How much power do we have to spare?";
const q2 = noModel ? "simulate battery over 10 orbits" : "And how much mass?";
await ask(q1);
await ask(q2);
let t = await tops();
check("the conversation grows downward: the newer question is below the older one", t.turns.length === 2 && t.turns[0].text === q1 && t.turns[1].text === q2 && t.turns[1].y > t.turns[0].y, t.turns.map((x) => `${x.text} @${Math.round(x.y)}`).join(" | "));
check("the composer is at the bottom, under the conversation, and the view follows the newest message", t.composerY >= t.streamBottom - 2 && t.atBottom, `composer @${Math.round(t.composerY)}, stream ends @${Math.round(t.streamBottom)}`);
await page.screenshot({ path: path.join(out, "50-chat-mission-thread.png") });

// A part's own thread.
const parts = (await call("GET", `/api/sessions/${sid}`)).body.mission.config.spacecraft.components;
const battery = parts.find((p) => p.type === "battery");
const inst = parts.find((p) => p.type === "instrument");
await page.evaluate((id) => window.__select(id), battery.id);
await page.waitForTimeout(600);
t = await tops();
const threadsNow = await page.locator(".chat .threads").innerText();
check("selecting the battery opens the battery's own, empty thread", t.turns.length === 0 && new RegExp(battery.name, "i").test(threadsNow) && new RegExp(battery.name, "i").test(await page.locator(".chat .composer .to").innerText()), threadsNow);
const q3 = "What is it connected to?";
const r3 = await ask(q3);
check(noModel ? "a question asked there is filed under the battery's thread" : "a question asked there is about the battery (the AI is told which part the thread is on)", r3?.topic === battery.id && (noModel || new RegExp("battery|" + battery.name, "i").test(r3?.answer?.text ?? "")), noModel ? `topic ${r3?.topic}` : r3?.answer?.text);
await page.evaluate((id) => window.__select(id), inst.id);
await page.waitForTimeout(600);
t = await tops();
check("the instrument's thread does not show the battery's conversation", t.turns.length === 0);
const r4 = await ask(q3);
check(noModel ? "the same words asked in the instrument's thread are a separate question, filed under the instrument" : "the same words asked in the instrument's thread are answered about the instrument", r4?.topic === inst.id && r4.id !== r3.id && (noModel || new RegExp("spectrometer|" + inst.name, "i").test(r4?.answer?.text ?? "")), noModel ? `topic ${r4?.topic}` : r4?.answer?.text);
await page.screenshot({ path: path.join(out, "51-chat-part-thread.png") });
await page.locator(".chat .threads button", { hasText: "The mission" }).click();
await page.waitForTimeout(500);
t = await tops();
check("back in the mission thread, only the mission's two questions are there", t.turns.length === 2 && t.turns.every((x) => x.text !== q3));
check("no AI reply box carries a one-sided colour band", await page.evaluate(() => [...document.querySelectorAll(".turn .ai")].every((e) => { const s = getComputedStyle(e); return !/inset/.test(s.boxShadow) && s.borderLeftWidth === s.borderRightWidth; })));

// Stage overlays in the systems view: selecting parts one after another never stacks panels.
await page.getByRole("button", { name: "Systems", exact: true }).first().click();
await page.locator(".right .tabs .tab", { hasText: /^systems$/i }).click();
let worst = 0;
for (const p of parts) {
  await page.evaluate((id) => window.__select(id), p.id);
  await page.waitForTimeout(250);
  const overlap = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll(".part-card, .mid .ai-queue, .mid .tutorial, .mid .coach, .mid .metric, .right .tabs")].filter((e) => e.getBoundingClientRect().width > 0).map((e) => ({ c: e.className.split(" ").pop(), r: e.getBoundingClientRect() }));
    let n = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i].r, b = boxes[j].r; if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) n++; }
    return { n, cards: document.querySelectorAll(".part-card").length + document.querySelectorAll(".mid .part-card").length * 10 };
  });
  worst = Math.max(worst, overlap.n + Math.max(0, overlap.cards - 1));
}
check("clicking through every part in the systems view never puts one panel over another, and nothing is drawn over the 3D stage for it", worst === 0, `${parts.length} parts selected in turn, overlapping pairs: ${worst}`);
await page.screenshot({ path: path.join(out, "52-systems-one-overlay.png") });
check("no page errors", problems.length === 0, problems.join(" || "));
fs.writeFileSync(path.resolve(noModel ? "reports/evidence/ui-chat-no-model.md" : "reports/evidence/ui-chat.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]); // closing a headless browser can hang while another Edge is open
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
