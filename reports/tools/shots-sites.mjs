// One screenshot per mission on the board, right after it opens: is each mission's own place on screen (the model
// of the site beside the world, its mark on the globe, what the mission needs in its own numbers)?
// Also checks that different missions get different kinds of site and different numbers to reach. No language model.
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
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 600)}` : ""}`);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const page = await (await browser.newContext({ viewport: { width: 1536, height: 864 } })).newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
await page.goto(`${BASE}/api/health`);
const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
const creds = { username: "sitepilot", password: "site-shots-password-1", displayName: "Site Pilot" };
if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
const board = (await call("GET", "/api/briefs")).body.briefs;
say(`# Each mission's own place on screen — ${new Date().toISOString()} — ${board.length} missions on the board`);
const seen = [];
for (const [i, b] of board.entries()) {
  const sid = (await call("POST", "/api/sessions", { scenarioId: b.template, briefId: b.id, difficulty: "cadet", name: b.title.slice(0, 60) })).body.session.id;
  await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission) && Boolean(window.__workspace.scene.siteShown()), null, { timeout: 60000 }).catch(() => null);
  await page.waitForTimeout(4500);
  await page.locator(".quest-hint button", { hasText: "Got it" }).click({ timeout: 1500 }).catch(() => undefined);
  await page.waitForTimeout(400);
  const site = await page.evaluate(() => window.__workspace.scene.siteShown());
  const needs = await page.locator(".needs .need").evaluateAll((rows) => rows.map((r) => `${r.querySelector(".t")?.textContent?.trim()} [${r.querySelector(".s")?.textContent?.trim()}]`));
  const s = (await call("GET", `/api/sessions/${sid}`)).body;
  seen.push({ title: b.title, world: b.destination, site: site?.kind ?? "none", craft: s.mission.config.spacecraft.name, place: s.session.world?.target?.name ?? "", needs });
  say(`- ${b.title} (${b.destination}) · site: ${site?.kind} · spacecraft: ${s.mission.config.spacecraft.name} · place: ${s.session.world?.target?.name ?? "–"}`);
  for (const n of needs) say(`    ${n}`);
  await page.screenshot({ path: path.join(out, `97-site-${String(i + 1).padStart(2, "0")}-${site?.kind ?? "none"}.png`) });
}
check("every mission shows a model of its own place", seen.every((m) => m.site !== "none"), seen.map((m) => m.site).join(", "));
check("the board's missions are not all the same kind of place", new Set(seen.map((m) => m.site)).size >= Math.min(4, seen.length), [...new Set(seen.map((m) => m.site))].join(", "));
const sameWorld = (w) => seen.filter((m) => m.world === w);
const differ = ["moon", "earth", "mars"].filter((w) => sameWorld(w).length >= 2).every((w) => new Set(sameWorld(w).map((m) => m.needs.join("|"))).size === sameWorld(w).length);
check("two missions on the same world do not ask for the same numbers", differ, ["moon", "earth", "mars"].map((w) => `${w}: ${sameWorld(w).length} mission(s), ${new Set(sameWorld(w).map((m) => m.needs.join("|"))).size} different sets of needs`).join(" · "));
check("every mission has its own spacecraft name and place", new Set(seen.map((m) => m.craft)).size === seen.length && seen.every((m) => m.place), seen.map((m) => `${m.craft} @ ${m.place}`).join(" · "));
say(`page errors: ${problems.length ? problems.join(" | ") : "none"}`);
fs.writeFileSync(path.resolve("reports/evidence/ui-sites.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
