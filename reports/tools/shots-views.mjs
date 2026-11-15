// Screenshots of one mission's three views (Orbit, Target, Systems) at 1536x864, for a look at overlaps. No model.
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("playwright-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const out = path.resolve("reports/evidence/ui");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const page = await (await browser.newContext({ viewport: { width: 1536, height: 864 } })).newPage();
await page.goto(`${BASE}/api/health`);
const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
const creds = { username: "viewpilot", password: "view-shots-password-1", displayName: "View Pilot" };
if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
const board = (await call("GET", "/api/briefs")).body.briefs;
const brief = board.find((b) => /Dust-storm|Dune/i.test(b.title)) ?? board[0];
const sid = (await call("POST", "/api/sessions", { scenarioId: brief.template, briefId: brief.id, difficulty: "engineer", name: brief.title.slice(0, 60) })).body.session.id;
await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await page.waitForTimeout(5000);
for (const [tab, name] of [["Orbit", "orbit"], ["Target", "target"], ["Systems", "systems"]]) {
  await page.locator("header .tabs .tab", { hasText: new RegExp(`^${tab}$`) }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, `99-view-${name}.png`) });
}
console.log(brief.title, JSON.stringify(await page.evaluate(() => window.__workspace.scene.siteShown())));
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(0);
