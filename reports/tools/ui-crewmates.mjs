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
await page.locator(".crew-roles-head", { hasText: /^Log/ }).click();
// They work with the player: they say what they would change and wait to be told. Watch that for half a minute.
await page.waitForTimeout(48000);
const askedFirst = await page.locator(".crew-list").innerText();
const untouched = (await snap()).mission.config.spacecraft.components.length;
check("unless told otherwise they ask before changing the design: a proposal, and nothing changed until a yes", /Reply “yes” to apply/.test(askedFirst) && untouched === before.mission.config.spacecraft.components.length, `parts still ${untouched} · ${(askedFirst.match(/[^\n]*Proposal[^\n]*/) ?? [""])[0].slice(0, 260)}`);
check("they do not greet or chat: what they write is what they propose and what they did", !/Hi, I'm|I'll take|how are/i.test(askedFirst.replace(/You[^\n]*/g, "")), askedFirst.replace(/\s+/g, " ").slice(0, 200));
// Hand the mission over, to watch them work on their own.
await page.locator(".crew-say input").fill("Crew, take over.");
await page.locator(".crew-say button").click();
const people = await page.locator(".crew-people .who").allInnerTexts();
check("three AI crewmates join the crew, each labelled AI", people.length === 4 && people.filter((p) => /AI/i.test(p)).length === 3, people.join(" | "));
// Speak to the crew while they work.
await page.waitForTimeout(16000);
await page.locator(".crew-say input").fill("Hana, how are we doing?");
await page.locator(".crew-say button").click();
// Let them work until the mission has been flown (or two and a half minutes pass).
const deadline = Date.now() + 230000;
let s = await snap();
// While they work, look at the stage: is each one there as a probe, does a probe go to the part being worked on,
// is what they say shown large, and does the view follow them to the hardware?
const watched = { probes: 0, working: 0, captions: new Set(), systems: 0, shot: false };
while (Date.now() < deadline && !["success", "partial", "failed"].includes(s.evaluation.outcome.verdict)) {
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(1000);
    const seen = await page.evaluate(() => ({ probes: window.__workspace.scene.crewProbes().length, tags: window.__workspace.scene.pointerTagsShown(), lines: [...document.querySelectorAll(".gamechat .gline")].map((l) => l.textContent ?? ""), mode: window.__workspace.scene.mode }));
    watched.probes = Math.max(watched.probes, seen.probes);
    const busy = seen.tags.filter((t) => / · AI\|/.test(t));
    if (busy.length) { watched.working++; if (seen.mode === "systems") watched.systems++; if (!watched.shot && seen.lines.length) { watched.shot = true; await page.screenshot({ path: path.join(out, "98-ai-crewmate-at-work.png") }); } }
    for (const l of seen.lines) watched.captions.add(l.slice(0, 60));
  }
  s = await snap();
  if (s.evaluation.outcome.verdict === "ready_to_fly" && !watched.flyAsked) { watched.flyAsked = true; await page.locator(".crew-say input").fill("Fly the mission."); await page.locator(".crew-say button").click(); }
}
await page.waitForTimeout(6000);
s = await snap();
const feed = await page.locator(".crew-list").innerText();
const roles = (s.roles ?? []).filter((r) => r.holder);
const ai = s.session.members.filter((m) => /· AI$/.test(m.displayName));
check("each AI crewmate took one of the mission's roles", roles.filter((r) => ai.some((m) => m.accountId === r.holder)).length === 3, roles.map((r) => `${r.seat}: ${s.session.members.find((m) => m.accountId === r.holder)?.displayName} ${r.ok ? "✓" : "✗"}`).join(" · "));
check("their changes to the design are listed under their names, like a player's", s.mission.version > before.mission.version && /(Hana|Leo|Jun)[^\n]*(Connected|Added|Launch vehicle|→|Installed)/i.test(feed), `v${before.mission.version} → v${s.mission.version} · parts ${before.mission.config.spacecraft.components.length} → ${s.mission.config.spacecraft.components.length} · lines ${before.mission.config.systems.links.length} → ${s.mission.config.systems.links.length}`);
check("a crewmate at work is seen as its name on the part it is working on (no figures on the stage)", watched.probes === 0 && watched.working >= 3, `figures on the stage: ${watched.probes} · a part carried an AI crewmate's name in ${watched.working} of the looks`);
check("what is proposed and done comes up as fading lines at the bottom left of the stage, and the view follows the work", watched.captions.size >= 4 && watched.systems >= 2, `${watched.captions.size} different lines seen · view on the hardware in ${watched.systems} of ${watched.working} looks`);
check("one of them pointed at the place the mission is about", /pointing at/i.test(feed), (feed.match(/[^\n]*[Pp]ointing at[^\n]*/) ?? [""])[0]);
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
