// Screenshots of the workspace for every mission template (orbit view and systems view), for a visual review.
// No language model is involved.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("playwright-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const out = path.resolve("reports/evidence/ui");
fs.mkdirSync(out, { recursive: true });
const [vw, vh] = (process.env.VIEW ?? "1920x1080").split("x").map(Number);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const page = await (await browser.newContext({ viewport: { width: vw, height: vh } })).newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
await page.goto(`${BASE}/api/health`);
const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
const creds = { username: "missionshots", password: "mission-shots-password-1", displayName: "Mission Shots" };
if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
const scenarios = (await call("GET", "/api/scenarios")).body;
for (const s of scenarios) {
  const sid = (await call("POST", "/api/sessions", { scenarioId: s.id, difficulty: "engineer", seed: 7, name: `Look at ${s.id}` })).body.session.id;
  await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
  await page.waitForTimeout(16000); // imagery in, the "why it moved" note gone
  await page.screenshot({ path: path.join(out, `85-${s.id}-orbit.png`) });
  await page.getByRole("button", { name: "Systems", exact: true }).first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `85-${s.id}-systems.png`) });
  console.log("saved", s.id);
}
console.log(`page errors: ${problems.length ? problems.join(" || ") : "none"}`);
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(0);
