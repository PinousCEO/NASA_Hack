// Screenshots of every right-hand tab of the mission workspace, in both views, for a visual review.
// No language model is involved.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("playwright-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const out = path.resolve("reports/evidence/ui");
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
// VIEW=1366x768 takes the same pictures at another window size (file names get the size as a suffix).
const [vw, vh] = (process.env.VIEW ?? "1920x1080").split("x").map(Number);
const suffix = process.env.VIEW ? `-${process.env.VIEW}` : "";
const page = await (await browser.newContext({ viewport: { width: vw, height: vh } })).newPage();
await page.goto(`${BASE}/api/health`);
const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
const creds = { username: "tabpilot" + suffix.replace(/\W/g, ""), password: "tab-shots-password-1", displayName: "Tab Pilot" };
if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
const sid = (await call("POST", "/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 21, name: "Tab review" })).body.session.id;
for (const itemId of ["ns", "wac"]) await call("POST", `/api/sessions/${sid}/catalog`, { itemId, wait: true });
await call("POST", `/api/sessions/${sid}/simulate`);
// a short conversation, answered by the built-in analyser (this server has no language model)
for (const text of ["set orbit altitude to 150 km", "connect the neutron spectrometer", "compute the link budget"]) await call("POST", `/api/sessions/${sid}/requests`, { text, wait: true });
await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await page.waitForTimeout(5000);
for (const t of ["AI", "design", "systems", "analysis", "designs", "review", "log"]) {
  await page.locator(".right .tabs .tab", { hasText: new RegExp("^" + t + "( •)?$", "i") }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, `70-tab-${t.toLowerCase()}${suffix}.png`) });
}
await page.getByRole("button", { name: "Systems", exact: true }).first().click();
await page.waitForTimeout(2000);
const inst = await page.evaluate(() => window.__workspace.scene.mission.config.spacecraft.components.find((c) => c.type === "instrument").id);
await page.evaluate((id) => window.__select(id), inst);
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(out, `71-systems-view-part-selected${suffix}.png`) });
// the two full-screen sheets: the evaluation dashboard and the crew's goal
await page.evaluate(() => window.__select(null));
await page.locator(".score-ring").first().click();
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(out, `72-dashboard${suffix}.png`) });
await page.keyboard.press("Escape");
const close = page.getByRole("button", { name: /^close$/i }).first();
if (await close.count()) await close.click().catch(() => undefined);
await page.waitForTimeout(500);
const goal = page.getByRole("button", { name: /say what your crew is going for/i }).first();
if (await goal.count()) { await goal.click(); await page.waitForTimeout(900); await page.screenshot({ path: path.join(out, `73-crew-goal${suffix}.png`) }); }
console.log("saved tab screenshots");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(0);
