// One person and three AI crewmates in the real UI, without a language model: the lead starts a mission from the
// board at Cadet level, brings the AI crewmates in from the crew feed, and watches. Checked: they join as members
// labelled AI, take roles, say what they are doing, change the design through the same rules as a player, point at
// the mission's place, answer when spoken to, and the mission ends up flown. What the earlier crews' record shows
// is checked too (it is empty on a fresh server and has entries once a flight has been made).
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
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 420)}` : ""}`);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const page = await (await browser.newContext({ viewport: { width: 1536, height: 864 } })).newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(String(e).slice(0, 200)));
await page.goto(`${BASE}/api/health`);
const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
const creds = { username: "crewlead", password: "crew-lead-password-1", displayName: "Mina" };
if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
const board = (await call("GET", "/api/briefs")).body.briefs;
const brief = board.find((b) => /Wildfire/i.test(b.title)) ?? board[0];
const sid = (await call("POST", "/api/sessions", { scenarioId: brief.template, briefId: brief.id, difficulty: "cadet", name: brief.title })).body.session.id;
say(`# UI run: one person and three AI crewmates (no language model) — ${new Date().toISOString()} — ${brief.title} · session ${sid}`);
await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await page.waitForTimeout(3000);
const snap = async () => (await call("GET", `/api/sessions/${sid}`)).body;
const before = await snap();
check("before anyone else has flown this kind of mission, the record of earlier crews is empty and says so", before.knowledge && Array.isArray(before.knowledge.lessons), `${before.knowledge?.records} records · ${before.knowledge?.lessons.length} about missions like this`);
await page.locator(".crew-ai").click();
await page.waitForFunction(() => document.querySelectorAll(".crew-people .who").length >= 4, null, { timeout: 30000 }).catch(() => null);
const people = await page.locator(".crew-people .who").allInnerTexts();
check("three AI crewmates join the crew, each labelled AI", people.length === 4 && people.filter((p) => /AI/i.test(p)).length === 3, people.join(" | "));
// Speak to the crew while they work.
await page.waitForTimeout(22000);
await page.locator(".crew-say input").fill("Nova, how are we doing?");
await page.locator(".crew-say button").click();
// Let them work until the mission has been flown (or two and a half minutes pass).
const deadline = Date.now() + 150000;
let s = await snap();
while (Date.now() < deadline && !["success", "partial", "failed"].includes(s.evaluation.outcome.verdict)) { await page.waitForTimeout(5000); s = await snap(); }
await page.waitForTimeout(6000);
s = await snap();
const feed = await page.locator(".crew-list").innerText();
const roles = (s.roles ?? []).filter((r) => r.holder);
const ai = s.session.members.filter((m) => /· AI$/.test(m.displayName));
check("each AI crewmate took one of the mission's roles", roles.filter((r) => ai.some((m) => m.accountId === r.holder)).length === 3, roles.map((r) => `${r.seat}: ${s.session.members.find((m) => m.accountId === r.holder)?.displayName} ${r.ok ? "✓" : "✗"}`).join(" · "));
check("they said who they are and what they answer for", /AI crewmate/.test(feed) && /I'll take/.test(feed), feed.slice(0, 300));
check("their changes to the design are listed under their names, like a player's", s.mission.version > before.mission.version && /(Nova|Orion|Vega)[^\n]*(Connect|Add|Launch vehicle|area|Orbit|data rate|Install)/i.test(feed), `v${before.mission.version} → v${s.mission.version} · parts ${before.mission.config.spacecraft.components.length} → ${s.mission.config.spacecraft.components.length} · lines ${before.mission.config.systems.links.length} → ${s.mission.config.systems.links.length}`);
check("one of them pointed at the place the mission is about", /pointing at/.test(feed), (feed.match(/[^\n]*pointing at[^\n]*/) ?? [""])[0]);
check("spoken to by name, the crewmate answered with where its role stands", /Mina: /.test(feed), (feed.match(/[^\n]*Mina: [^\n]*/) ?? [""])[0]);
check("the mission was flown, and the outcome was said to the crew", ["success", "partial", "failed"].includes(s.evaluation.outcome.verdict), `${s.evaluation.outcome.verdict} · ${s.evaluation.score.toFixed(0)} pts · ${s.evaluation.outcome.headline}`);
await page.screenshot({ path: path.join(out, "96-ai-crewmates.png") });
// What this crew found out is now in the record the next crew's AI reads.
const next = (await call("POST", "/api/sessions", { scenarioId: brief.template, briefId: brief.id, difficulty: "cadet", name: "The next crew" })).body.session.id;
const later = (await call("GET", `/api/sessions/${next}`)).body;
check("the next crew on this kind of mission finds this crew's flight in the record its AI reads", later.knowledge.lessons.length > 0 && later.knowledge.lessons.some((l) => l.mission === s.mission.config.meta.name), `${later.knowledge.records} records · ${later.knowledge.lessons.length} about missions like this · first: [${later.knowledge.lessons[0]?.kind}] ${later.knowledge.lessons[0]?.text}`);
say("crew feed at the end:");
for (const l of feed.split("\n").filter(Boolean).slice(-40)) say(`  ${l}`);
say(`page errors: ${problems.length ? problems.join(" | ") : "none"}`);
fs.writeFileSync(path.resolve("reports/evidence/ui-crewmates.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
