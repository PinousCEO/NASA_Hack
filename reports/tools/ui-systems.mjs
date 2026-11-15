// Drives the real UI through the wiring loop and saves screenshots as evidence:
// a part is added from the kit (arrives unconnected) → the part card shows its open ports →
// "Connect it" → the lines appear in the Systems tab and in the 3D systems view.
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
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${detail}` : ""}`);

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(String(e).slice(0, 300)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|ERR_|404/.test(m.text())) problems.push(m.text().slice(0, 300)); });
await page.goto(`${BASE}/api/health`);
const post = (route, body) => page.evaluate(([r, b]) => fetch(r, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [route, body]);
const get = (route) => page.evaluate((r) => fetch(r, { credentials: "include" }).then((x) => x.json()), route);
const creds = { username: "evidencepilot", password: "evidence-check-password-1", displayName: "Evidence Pilot" };
if ((await post("/api/auth/login", creds)).status !== 200) await post("/api/auth/register", creds);
await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
const sid = (await post("/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 21, name: "Evidence UI systems" })).body.session.id;
say(`# UI run: wiring and control logic — ${new Date().toISOString()} — session ${sid}`);
await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: path.join(out, "01-mission-start.png") });
check("the mission opens on the problem with its kit", (await page.locator(".problem h2").count()) === 1 && (await page.locator(".problem .kit-tabs button").count()) === 3);

// Add a part from the kit: it arrives on board, unconnected.
await page.locator(".kit-tabs button", { hasText: "Parts" }).click();
await page.locator(".toolbox .tool", { hasText: "Neutron spectrometer" }).getByRole("button", { name: "Add" }).click();
await page.waitForFunction(() => window.__workspace?.scene.mission?.config.spacecraft.components.some((c) => c.type === "instrument"), null, { timeout: 60000 });
await page.waitForTimeout(1500);
const snap1 = await get(`/api/sessions/${sid}`);
const inst = snap1.mission.config.spacecraft.components.find((c) => c.type === "instrument");
check("a part added from the kit is on board but not connected", snap1.mission.derived["systems.wiring"].value.unconnected.includes(inst.id), snap1.checks.find((c) => c.id === "systems.wiring")?.detail);
check("an unconnected instrument earns nothing", snap1.evaluation.objectives.find((o) => o.id === "hydrogen").achieved === 0);

// The 3D systems view and the part card.
await page.getByRole("button", { name: "Systems", exact: true }).first().click();
await page.waitForTimeout(2500);
await page.evaluate((id) => window.__select?.(id), inst.id).catch(() => null);
  await page.waitForTimeout(400);
if (!(await page.locator(".part-card").count())) {
  // select through the right-hand Systems tab, which lists parts needing a connection
  await page.locator(".right .tabs .tab", { hasText: /^systems$/i }).click();
  await page.locator(".attention .tool b").first().click();
}
await page.waitForSelector(".part-card", { timeout: 10000 });
await page.screenshot({ path: path.join(out, "02-part-unconnected.png") });
const cardText = await page.locator(".part-card").innerText();
check("the part card lists the part's ports and says which are open", /Ports & lines/i.test(cardText) && /nothing connected/i.test(cardText) && /No power line/i.test(cardText), cardText.replace(/\s+/g, " ").slice(0, 220));

await page.locator(".right .tabs .tab", { hasText: /^systems$/i }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, "03-systems-tab-needs-connection.png") });
check("the Systems tab lists every line with what it carries", (await page.locator(".systems .lines .wline").count()) === snap1.mission.config.systems.links.length);

// Connect it.
await page.locator(".part-card").getByRole("button", { name: "Connect it" }).click();
await page.waitForFunction((id) => window.__workspace?.scene.mission?.config.systems.links.some((l) => l.from.node === id || l.to.node === id), inst.id, { timeout: 60000 });
await page.waitForTimeout(2500);
const snap2 = await get(`/api/sessions/${sid}`);
const mine = snap2.mission.config.systems.links.filter((l) => l.from.node === inst.id || l.to.node === inst.id);
check("Connect it fits power, data and control lines", mine.map((l) => l.kind).sort().join(",") === "control,data,power", mine.map((l) => `${l.kind} ${l.rating ?? ""}`).join(" | "));
check("the connected instrument now counts and its load and data appear", snap2.evaluation.objectives.find((o) => o.id === "hydrogen").achieved === 1 && snap2.mission.derived["data.budget"].value.generatedGbPerDay > 0, `data ${snap2.mission.derived["data.budget"].value.generatedGbPerDay.toFixed(2)} Gb/day, load ${snap1.mission.derived["power.budget"].value.averageLoadW.toFixed(1)} → ${snap2.mission.derived["power.budget"].value.averageLoadW.toFixed(1)} W, harness ${snap1.mission.derived["mass.budget"].value.harnessMassKg.toFixed(3)} → ${snap2.mission.derived["mass.budget"].value.harnessMassKg.toFixed(3)} kg`);
await page.screenshot({ path: path.join(out, "04-part-connected.png") });
const card2 = await page.locator(".part-card").innerText();
check("the part card now shows each port's line and its flow", /Fully connected/i.test(card2) && /of .*W/.test(card2), card2.replace(/\s+/g, " ").slice(0, 260));

// An incompatible line, by hand: refused with the reason.
await page.getByRole("button", { name: "+ Add a line by hand" }).click();
const refused = await page.evaluate(async (id) => {
  const r = await window.__collabEdit?.([{ op: "append", path: "systems.links", value: { id: "bad-line", kind: "power", from: { node: "bus", port: "power" }, to: { node: id, port: "data_out" }, rating: 10, lengthM: 1 } }], "bad line");
  return r ?? null;
}, inst.id);
if (refused) check("an incompatible line is refused with the reason", refused.ok === false && /cannot plug into/.test(refused.detail ?? ""), refused.detail);
await page.screenshot({ path: path.join(out, "05-systems-tab-connected.png") });

say(`console/page errors: ${problems.length ? problems.join(" || ") : "none"}`);
fs.writeFileSync(path.resolve("reports/evidence/ui-systems.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]); // closing a headless browser can hang while another Edge is open
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
