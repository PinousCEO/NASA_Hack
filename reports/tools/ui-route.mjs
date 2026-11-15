// A new player's route from the New Mission page to a flown mission, the two ways the game offers: taking a part
// from the shelf (the Play tab on the right) and connecting it by hand, then saying the rest in plain words in the
// bar under the world ("pick the cheapest launch vehicle…", "fly the mission"). Those two sentences are carried out
// by the platform itself, so this run needs no language model. The script writes down what was done and what the
// screen said afterwards.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("playwright-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const out = path.resolve("reports/evidence/ui");
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const page = await (await browser.newContext({ viewport: { width: 1536, height: 864 } })).newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
await page.goto(`${BASE}/api/health`);
const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
const creds = { username: "routepilot", password: "route-check-password-1", displayName: "Route Pilot" };
if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
const title = process.argv[2] ?? "Harmful algal blooms";
say(`# A player's route by clicking, to a flown mission — ${new Date().toISOString()} — ${title}`);
await page.goto(`${BASE}/lobby`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".brief-card .level", { timeout: 60000 });
const card = page.locator(".brief-card", { hasText: new RegExp(title, "i") }).first();
check("the New Mission page lists the board's missions; the mission is there", (await card.count()) === 1, `${await page.locator(".brief-card").count()} missions listed`);
await card.locator(".level", { hasText: "Cadet" }).click();
await page.waitForURL(/\/mission\?s=/, { timeout: 30000 });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
const sid = new URL(page.url()).searchParams.get("s");
const snap = async () => (await call("GET", `/api/sessions/${sid}`)).body;
const asked = await page.waitForSelector(".modal.define", { timeout: 12000 }).then(() => true, () => false);
if (asked) await page.locator(".modal.define button", { hasText: "Later" }).click();
await page.waitForTimeout(1200);
await page.locator(".quest-hint button", { hasText: "Got it" }).click({ timeout: 2000 }).catch(() => undefined);
const steps = await page.locator(".play .step .head span").allInnerTexts();
const bar = await page.locator(".saybar input").count();
check("★ Cadet opens the mission with the bar to talk to your AI under the world and the shelf on the right", asked && bar === 1 && steps.length === 5 && /shelf/i.test(steps[0]) && /Fly/i.test(steps[4]), `bar: ${await page.locator(".saybar input").getAttribute("placeholder")} · shelf sections: ${steps.join(" · ")}`);
// The AI crewmates come aboard by themselves on a new mission, and ask before they change anything.
await page.waitForFunction(() => document.querySelectorAll(".crew-people .who").length >= 4, null, { timeout: 30000 }).catch(() => null);
const crew = await page.locator(".crew-people .who").allInnerTexts();
check("the AI crewmates are already aboard a mission just started", crew.filter((p) => /AI/i.test(p)).length === 3, crew.join(" | "));
const tell = async (sentence) => { await page.locator(".saybar input").fill(sentence); await page.locator(".saybar form button").click(); await page.waitForFunction((t) => (document.querySelector(".saybar .reply .q")?.textContent ?? "").includes(t.slice(0, 20)) && !document.querySelector(".saybar .reply.working"), sentence, { timeout: 60000 }).catch(() => null); await page.waitForTimeout(1500); return (await page.locator(".saybar .reply .a").innerText().catch(() => "")).replace(/\s+/g, " "); };
// Step 1: Add, on the first instrument of the list.
const first = page.locator(".play .step").nth(0).locator(".tool").first();
const what = (await first.locator("b").first().innerText()).trim();
await first.locator(".btn", { hasText: "Add" }).click();
await page.waitForFunction(() => document.querySelectorAll(".play .step:nth-child(3) .tool").length > 0 || /waiting/.test(document.querySelector(".play")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(1500);
let s = await snap();
check("from the shelf: Add puts the instrument on board", s.mission.config.spacecraft.components.some((c) => c.type === "instrument"), `clicked Add on “${what}” · parts ${s.mission.config.spacecraft.components.length}`);
// Step 2: Connect.
const con = page.locator(".play .step").nth(1).locator(".btn", { hasText: "Connect" });
const waiting = await con.count();
for (let k = 0; k < 4 && (await con.count()); k++) { await con.first().click(); await page.waitForTimeout(2800); }
s = await snap();
const loose = (s.mission.derived["systems.wiring"]?.value?.parts ?? []).filter((p) => p.notes.length).length;
check("Connect wires it (power, data, control)", waiting >= 1 && loose === 0, `${waiting} part(s) were waiting · not connected now: ${loose} · lines ${s.mission.config.systems.links.length}`);
// Step 3: launch vehicle.
const mass = s.mission.derived["mass.budget"]?.value?.totalMassKg ?? 0;
const fit = [...(s.mission.derived["launch.vehicle"]?.value?.options ?? [])].sort((a, b) => a.costMusd - b.costMusd).find((o) => o.capacityKg >= mass);
const said1 = await tell("Pick the cheapest launch vehicle that can lift us.");
await page.waitForTimeout(1500);
s = await snap();
check("said in the bar: “Pick the cheapest launch vehicle that can lift us.” — it is chosen", s.mission.derived["launch.vehicle"]?.value?.selectedId === fit?.id, `${mass.toFixed(1)} kg → ${s.mission.derived["launch.vehicle"]?.value?.name} · reply: ${said1.slice(0, 160)}`);
// Step 5: fly.
const said2 = await tell("Fly the mission.");
await page.waitForFunction(() => /success|Partial|failed|Flown/i.test(document.querySelector(".play .result")?.textContent ?? ""), null, { timeout: 60000 }).catch(() => null);
await page.waitForTimeout(1500);
s = await snap();
const o = s.evaluation.outcome;
const stars = await page.locator(".quest-stars i.on").count();
const needs = await page.locator(".needs .need").evaluateAll((rows) => rows.map((r) => `${r.querySelector(".t")?.textContent?.trim()} [${r.querySelector(".s")?.textContent?.trim()}]`));
check("said in the bar: “Fly the mission.” — it flies, the AI says how it went, and the stars are lit", ["success", "partial"].includes(o.verdict) && stars >= 1 && /flew the mission/i.test(said2), `${o.headline} · ${s.evaluation.score.toFixed(0)} points · ${"★".repeat(stars)} · reply: ${said2.slice(0, 200)}`);
say(`   what the mission needs at the end: ${needs.join(" · ")}`);
await page.screenshot({ path: path.join(out, "100-route-flown.png") });
say(`page errors: ${problems.length ? problems.join(" | ") : "none"}`);
fs.writeFileSync(path.resolve("reports/evidence/ui-route.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
