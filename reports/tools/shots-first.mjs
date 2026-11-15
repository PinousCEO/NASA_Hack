// Screenshots of what a new player meets first: the walkthrough steps on a fresh mission, then the
// workspace right after it, and the Parts and Crew tabs of the left column. No language model is involved.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("playwright-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const out = path.resolve("reports/evidence/ui");
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const [vw, vh] = (process.env.VIEW ?? "1920x1080").split("x").map(Number);
const suffix = process.env.VIEW ? `-${process.env.VIEW}` : "";
const page = await (await browser.newContext({ viewport: { width: vw, height: vh } })).newPage();
await page.goto(`${BASE}/api/health`);
const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
const creds = { username: "firstpilot" + suffix.replace(/[^a-z0-9]/gi, ""), password: "first-shots-password-1", displayName: "First Pilot" };
if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
const sid = (await call("POST", "/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 21, name: "First look" })).body.session.id;
await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await page.waitForTimeout(5000);
let step = 0;
for (; step < 9; step++) {
  if (!(await page.locator(".tutorial").count())) break;
  await page.screenshot({ path: path.join(out, `80-first-step-${step + 1}${suffix}.png`) });
  const next = page.locator(".tutorial button", { hasText: /next|start|got it|begin|done|finish/i }).last();
  if (!(await next.count())) break;
  await next.click();
  await page.waitForTimeout(700);
}
await page.screenshot({ path: path.join(out, `81-after-walkthrough${suffix}.png`) });
for (const t of ["Parts", "Crew"]) {
  const tab = page.locator(".left button", { hasText: new RegExp("^" + t, "i") }).first();
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, `82-left-${t.toLowerCase()}${suffix}.png`) }); }
}
console.log(`saved first-look screenshots (${step} walkthrough steps)`);
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(0);
