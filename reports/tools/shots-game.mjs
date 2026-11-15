// Screenshots of the game layer: the mission board as a level select, then a mission started from a card at
// Cadet level (stars, objectives, a hint that opens by itself), and the moment an objective is won.
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
const [vw, vh] = (process.env.VIEW ?? "1536x864").split("x").map(Number);
const suffix = process.env.VIEW ? `-${process.env.VIEW}` : "";
const page = await (await browser.newContext({ viewport: { width: vw, height: vh } })).newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
await page.goto(`${BASE}/api/health`);
const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
const creds = { username: "gamepilot" + suffix.replace(/[^a-z0-9]/gi, ""), password: "game-shots-password-1", displayName: "Game Pilot" };
if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".brief-card .levels", { timeout: 60000 });
await page.locator("#missions").scrollIntoViewIfNeeded();
await page.evaluate(() => document.querySelector("#missions")?.scrollIntoView());
await page.waitForTimeout(1800);
await page.screenshot({ path: path.join(out, `90-board-level-select${suffix}.png`) });
const cards = await page.locator(".brief-card").count();
const levels = await page.locator(".brief-card .level").count();
// One click on a card's Cadet button goes straight into the mission.
await page.locator(".brief-card .level", { hasText: "Cadet" }).first().click();
await page.waitForURL(/\/mission\?s=/, { timeout: 30000 });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await page.waitForTimeout(5000);
for (let i = 0; i < 9 && (await page.locator(".tutorial").count()); i++) {
  const next = page.locator(".tutorial button", { hasText: /next|start|got it|begin|done|finish|skip/i }).last();
  if (!(await next.count())) break;
  await next.click();
  await page.waitForTimeout(500);
}
await page.waitForTimeout(800);
await page.screenshot({ path: path.join(out, `91-cadet-mission-quest-bar${suffix}.png`) });
const bar = await page.evaluate(() => ({ stars: document.querySelectorAll(".quest-stars i").length, items: document.querySelectorAll(".quest-item").length, level: document.querySelector(".quest-level")?.textContent ?? "", hint: document.querySelector(".quest-hint p")?.textContent ?? "", ways: document.querySelectorAll(".quest-hint li").length }));
console.log(JSON.stringify({ cards, levels, url: page.url().replace(BASE, ""), bar, problems }));
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(0);
