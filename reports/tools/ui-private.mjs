// Two players in the real UI, without a language model: each one's conversation with their AI is
// theirs until they share it, the 3D view is personal, and design changes reach both.
// The questions are answered by the built-in analyser, so this run makes no model request; what the
// replies say is not the point here — who can read them is.
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
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const problems = [];

async function player(name, display) {
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${name}: ${String(e).slice(0, 200)}`));
  await page.goto(`${BASE}/api/health`);
  const post = (route, body) => page.evaluate(([r, b]) => fetch(r, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [route, body]);
  const get = (route) => page.evaluate((r) => fetch(r, { credentials: "include" }).then((x) => x.json()), route);
  const creds = { username: name, password: "private-ui-check-password-1", displayName: display };
  if ((await post("/api/auth/register", creds)).status >= 300) await post("/api/auth/login", creds);
  await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
  return { name, page, post, get };
}
const open = async (p, sid) => {
  await p.page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
  await p.page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
  await p.page.waitForTimeout(4000);
};
const ask = async (p, sid, text) => {
  await p.page.locator(".right .tabs .tab", { hasText: /^AI/ }).click();
  await p.page.locator(".chat .composer textarea").fill(text);
  await p.page.getByRole("button", { name: "Send", exact: true }).click();
  const deadline = Date.now() + 60000;
  let r = null;
  while (Date.now() < deadline) {
    await p.page.waitForTimeout(1000);
    r = (await p.get(`/api/sessions/${sid}/requests`)).find((x) => x.text === text);
    if (r && !["queued", "analyzing", "planning", "executing"].includes(r.status)) break;
  }
  return r;
};

const ana = await player("privana", "Ana");
const ben = await player("privben", "Ben");
const sid = (await ana.post("/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 21, name: "Evidence private AI", visibility: "public" })).body.session.id;
await ben.post(`/api/sessions/${sid}/join`, {});
say(`# UI run: two players, private conversations (no language model) — ${new Date().toISOString()} — session ${sid}`);
await open(ana, sid);
await open(ben, sid);

// Ana asks her AI. Ben sees that she did, not what was said.
const q1 = "compute the link budget";
const r1 = await ask(ana, sid, q1);
const answer = String(r1?.answer?.text ?? "");
check("Ana's question is answered in her own panel", answer.length > 20 && (await ana.page.locator(".chat").innerText()).includes(answer.slice(0, 24)), answer);
await ben.page.locator(".right .tabs .tab", { hasText: /^AI/ }).click();
check("Ben's own conversation is empty: Ana's question is not in it", !(await ben.page.locator(".chat").innerText()).includes(q1));
await ben.page.locator(".chat .seg button", { hasText: "Whole crew" }).click();
await ben.page.waitForTimeout(1200);
const benView = await ben.page.locator(".chat").innerText();
check("in the whole-crew view Ben sees that Ana talked to her AI, but neither the question nor the answer", /Ana & their AI/i.test(benView) && /private conversation/i.test(benView) && !benView.includes(q1) && !benView.includes(answer.slice(0, 24)), benView);
const benApi = (await ben.get(`/api/sessions/${sid}/requests`)).find((x) => x.id === r1?.id);
check("the server does not send Ben the text either (not just hidden on screen)", Boolean(benApi) && !JSON.stringify(benApi).includes(q1) && !JSON.stringify(benApi).includes(answer.slice(0, 24)), JSON.stringify(benApi).slice(0, 200));
await ben.page.screenshot({ path: path.join(out, "15-private-conversation-no-model.png") });

// Ana shares it: now Ben can read both.
await ana.page.locator(".chat .turn .foot button", { hasText: "Share with crew" }).first().click();
await ben.page.waitForFunction((t) => document.querySelector(".chat")?.textContent?.includes(t), q1, { timeout: 15000 }).catch(() => null);
const benView2 = await ben.page.locator(".chat").innerText();
check("after Ana shares it, Ben can read the question and the answer", benView2.includes(q1) && benView2.includes(answer.slice(0, 24)));

// Ben's own question stays out of Ana's panel; a design change from it reaches both.
const q2 = "set orbit altitude to 150 km";
const r2 = await ask(ben, sid, q2);
await ana.page.waitForFunction(() => Math.round(window.__workspace.scene.mission.config.orbit.semiMajorAxisKm) === 1887, null, { timeout: 20000 }).catch(() => null);
const alt = await Promise.all([ana, ben].map((p) => p.page.evaluate(() => Math.round(window.__workspace.scene.mission.config.orbit.semiMajorAxisKm - 1737.4))));
check("a change Ben's AI makes to the design reaches both players", alt[0] === 150 && alt[1] === 150, `altitude ${alt.join(" / ")} km · request ${r2?.status}`);
await ana.page.locator(".chat .seg button", { hasText: "Mine" }).click().catch(() => undefined);
await ana.page.waitForTimeout(600);
check("Ben's question is not in Ana's own conversation", !(await ana.page.locator(".chat .stream").innerText()).includes(q2));

// Looking around is personal.
const cam = (p) => p.page.evaluate(() => window.__workspace.debug.camera());
const [a0, b0] = [await cam(ana), await cam(ben)];
const box = await ana.page.locator("canvas").first().boundingBox();
await ana.page.mouse.move(box.x + box.width * 0.5, box.y + 196);
await ana.page.mouse.down();
await ana.page.mouse.move(box.x + box.width * 0.5 + 160, box.y + 236, { steps: 8 });
await ana.page.mouse.up();
await ana.page.waitForTimeout(800);
const [a1, b1] = [await cam(ana), await cam(ben)];
const moved = (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
check("looking around is personal: Ana's view moves, Ben's does not", moved(a0, a1) > 0.01 && moved(b0, b1) < 1e-6, `Ana moved ${moved(a0, a1).toFixed(3)}, Ben ${moved(b0, b1).toExponential(1)}`);
check("no page errors", problems.length === 0, problems.join(" || "));
fs.writeFileSync(path.resolve("reports/evidence/ui-private.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
