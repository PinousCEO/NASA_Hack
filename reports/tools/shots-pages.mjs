// Screenshots of the pages outside the mission workspace, for a visual review (no language model involved).
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
const post = (route, body) => page.evaluate(([r, b]) => fetch(r, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then((x) => x.status), [route, body]);
const creds = { username: "shotpilot", password: "page-shots-password-1", displayName: "Shot Pilot" };
if ((await post("/api/auth/register", creds)) >= 300) await post("/api/auth/login", creds);
// one mission of our own, so the lobby has something to list
await page.evaluate(() => fetch("/api/sessions", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenarioId: "leo-cubesat", difficulty: "cadet", name: "Coastal crew", visibility: "public" }) }));
for (const [name, url, scroll] of [["60-title.png", "/", 0], ["61-title-briefs.png", "/", 1100], ["62-title-lower.png", "/", 2300], ["63-lobby.png", "/lobby", 0], ["63-lobby-lower.png", "/lobby", 1200], ["64-leaderboard.png", "/leaderboard", 0], ["65-research.png", "/research", 0]]) {
  await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  if (scroll) { await page.mouse.wheel(0, scroll); await page.waitForTimeout(1500); }
  await page.screenshot({ path: path.join(out, name.replace(".png", suffix + ".png")) });
  console.log("saved", name);
}
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(0);
