// Two players in the real UI, without a language model: one points at a place on the world and the
// other sees the mark, with the first player's name, on their own globe — and is told who is pointing.
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
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const problems = [];
async function player(name, display) {
  const ctx = await browser.newContext({ viewport: { width: 1536, height: 864 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${name}: ${String(e).slice(0, 200)}`));
  await page.goto(`${BASE}/api/health`);
  const post = (route, body) => page.evaluate(([r, b]) => fetch(r, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [route, body]);
  const creds = { username: name, password: "point-ui-check-password-1", displayName: display };
  if ((await post("/api/auth/register", creds)).status >= 300) await post("/api/auth/login", creds);
  await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
  return { name, page, post };
}
const open = async (p, sid) => {
  await p.page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
  await p.page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
  await p.page.waitForTimeout(4000);
};
const ana = await player("pointana", "Ana");
const ben = await player("pointben", "Ben");
const sid = (await ana.post("/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "cadet", seed: 21, name: "Evidence pointing", visibility: "public" })).body.session.id;
await ben.post(`/api/sessions/${sid}/join`, {});
say(`# UI run: pointing a place out to the crew (no language model) — ${new Date().toISOString()} — session ${sid}`);
await open(ana, sid);
await open(ben, sid);
const pings = (p) => p.page.evaluate(() => window.__workspace.scene.pingsShown());
check("nobody is pointing at the start", (await pings(ana)).length === 0 && (await pings(ben)).length === 0);
// Ana double-clicks the middle of the world on her stage.
const box = await ana.page.locator(".stage canvas").boundingBox();
await ana.page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
await ben.page.waitForFunction(() => window.__workspace.scene.pingsShown().length > 0, null, { timeout: 15000 }).catch(() => null);
const mine = await pings(ana);
const theirs = await pings(ben);
check("the player who points sees their own mark on the world", mine.length === 1 && mine[0].startsWith("self:") && /Ana/.test(mine[0]), mine.join(" | "));
check("the other player sees the mark at the same place, with the first player's name", theirs.length === 1 && /Ana/.test(theirs[0]) && theirs[0].split(": ")[1].split(",").slice(0, 2).join(",") === mine[0].split(": ")[1].split(",").slice(0, 2).join(","), theirs.join(" | "));
const told = await ben.page.locator(".toast", { hasText: /Ana is pointing/ }).count();
check("the other player is told who is pointing", told >= 1);
await ben.page.waitForTimeout(600);
await ben.page.screenshot({ path: path.join(out, "92-crewmate-points-at-a-place.png") });
// The crew beside the stage: a message from one reaches the other, and a change one makes is listed with their name.
for (const p of [ana, ben]) await p.page.locator(".crew-roles-head", { hasText: /^Log/ }).click();
await ben.page.locator(".crew-say input").fill("Look at the mark, is that where the rover goes?");
await ben.page.locator(".crew-say button").click();
await ana.page.waitForFunction(() => /Look at the mark/.test(document.querySelector(".crew-list")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => null);
const heard = await ana.page.locator(".crew-list").innerText();
check("a message one player sends is in the other's crew feed, with their name", /Ben/.test(heard) && /Look at the mark/.test(heard), heard);
const item = (await ana.page.evaluate((s) => fetch(`/api/sessions/${s}`, { credentials: "include" }).then((r) => r.json()), sid)).scenario.catalog.find((i) => i.discipline === "payload");
await ana.post(`/api/sessions/${sid}/catalog`, { itemId: item.id });
await ben.page.waitForFunction(() => /Ana/.test(document.querySelector(".crew-list")?.textContent ?? "") && /add/i.test(document.querySelector(".crew-list")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => null);
const seen = await ben.page.locator(".crew-list").innerText();
check("a change one player makes is listed in the other's crew feed with who made it", /Ana/.test(seen) && /add/i.test(seen), seen);
const people = await ben.page.locator(".crew-people .who").allInnerTexts();
check("both players are shown as the crew", people.length === 2 && people.some((p) => /You/.test(p)) && people.some((p) => /Ana/.test(p)), people.join(" | "));
await ben.page.waitForTimeout(500);
await ben.page.screenshot({ path: path.join(out, "93-crew-feed.png") });
// Roles: each answers for one thing; with two taken, the crew is scored on each one holding.
await ana.post(`/api/sessions/${sid}/role`, { seat: "Payload" });
await ben.post(`/api/sessions/${sid}/role`, { seat: "Power" });
await ben.page.locator(".crew-roles-head", { hasText: /^Roles/ }).click();
await ben.page.waitForFunction(() => document.querySelectorAll(".crew-role .holder:not(.free)").length === 2, null, { timeout: 15000 }).catch(() => null);
const roleRows = await ben.page.locator(".crew-role").evaluateAll((rows) => rows.map((r) => `${r.innerText.replace(/\s+/g, " ")} [${r.getAttribute("title")}]`));
check("the crew feed lists the mission's roles, what each answers for, and who took which", roleRows.length === 4 && roleRows.some((r) => /Power/.test(r) && /you/i.test(r) && /W margin/.test(r)) && roleRows.some((r) => /Payload/.test(r) && /ana/i.test(r) && /science/i.test(r)), roleRows.join(" | "));
const evaluation = (await ana.page.evaluate((s) => fetch(`/api/sessions/${s}`, { credentials: "include" }).then((r) => r.json()), sid)).evaluation;
const kept = evaluation.rigor.find((r) => /Crew priorities/.test(r.item));
check("with two roles taken the team's score counts each role's priority holding", Boolean(kept) && kept.possible === 2 && /Power/.test(kept.detail) && /Payload/.test(kept.detail), kept ? `${kept.earned}/${kept.possible} · ${kept.detail}` : "no such item");
// Levels: a Cadet crew is offered the simple parts (and its kit's); an Engineer crew also the advanced ones.
const cadetParts = (await ana.page.evaluate((s) => fetch(`/api/sessions/${s}`, { credentials: "include" }).then((r) => r.json()), sid)).scenario.catalog;
const engSid = (await ana.post("/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 21, name: "Evidence levels" })).body.session.id;
const engParts = (await ana.page.evaluate((s) => fetch(`/api/sessions/${s}`, { credentials: "include" }).then((r) => r.json()), engSid)).scenario.catalog;
const kitIds = new Set((await ana.page.evaluate((s) => fetch(`/api/sessions/${s}`, { credentials: "include" }).then((r) => r.json()), sid)).session.kit.toolbox.map((t) => t.itemId));
check("Cadet level offers the simple parts and the kit's; Engineer level adds the advanced ones", cadetParts.every((i) => i.tier === "simple" || kitIds.has(i.id)) && engParts.some((i) => i.tier === "advanced") && engParts.length > cadetParts.length, `cadet ${cadetParts.length} parts (${cadetParts.filter((i) => i.tier === "advanced").length} advanced, all from the kit) · engineer ${engParts.length} parts (${engParts.filter((i) => i.tier === "advanced").length} advanced)`);
// A mission just started opens on its goal; choosing it ticks the first objective of the strip.
await ana.page.goto(`${BASE}/mission?s=${engSid}&intro=0&new=1`, { waitUntil: "domcontentloaded" });
await ana.page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
const asked = await ana.page.waitForSelector(".modal.define", { timeout: 15000 }).then(() => true, () => false);
const goalText = () => ana.page.locator(".quest-item.goal").evaluate((e) => `${e.textContent} [${e.className}]`).catch(() => "");
const firstBefore = await goalText();
await ana.page.screenshot({ path: path.join(out, "94-goal-first.png") });
if (asked) {
  await ana.page.locator(".modal.define textarea").fill("We will map hydrogen at the south pole so that a later crew knows where to land.");
  await ana.page.locator(".modal.define .preset").first().click();
  await ana.page.locator(".modal.define button", { hasText: /save|set|define|commit|confirm|start/i }).last().click();
  await ana.page.waitForFunction(() => /Goal chosen/.test(document.querySelector(".quest-item.goal")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => null);
}
const firstAfter = await goalText();
check("a mission just started opens on its goal, and choosing it ticks the first objective", asked && /Choose your goal/.test(firstBefore) && /Goal chosen/.test(firstAfter), `dialog: ${asked} · before: ${firstBefore.replace(/\s+/g, " ")} · after: ${firstAfter.replace(/\s+/g, " ")}`);
await ben.page.screenshot({ path: path.join(out, "95-crew-roles.png") });
// The level this mission is played at, and its hint, are on the stage for both.
const bar = await ben.page.evaluate(() => ({ level: document.querySelector(".quest-level")?.textContent ?? "", items: document.querySelectorAll(".quest-item").length, stars: document.querySelectorAll(".quest-stars i").length }));
check("the game strip (stars, objectives, level) is on the stage", bar.items >= 3 && bar.stars === 3 && /cadet/i.test(bar.level), JSON.stringify(bar));
say(`page errors: ${problems.length ? problems.join(" | ") : "none"}`);
fs.writeFileSync(path.resolve("reports/evidence/ui-point.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
