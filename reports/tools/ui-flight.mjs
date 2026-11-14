// The power-short mission from the board, in a real browser, without a language model: the problem
// is visible, control logic installed by hand acts in the flight, and the flight report shows what
// each instrument sent home and what the control logic did.
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
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 340)}` : ""}`);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
page.setDefaultTimeout(60000);
const problems = [];
page.on("pageerror", (e) => problems.push(String(e).slice(0, 240)));
await page.goto(`${BASE}/api/health`);
const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
const creds = { username: "flightpilot", password: "ui-flight-check-password-1", displayName: "Flight Pilot" };
if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
say(`# UI run: the power-short mission, flown with control logic — ${new Date().toISOString()}`);

// The mission board always carries this problem.
await call("GET", "/api/briefs");
const board = (await call("GET", "/api/briefs")).body;
const brief = (board.briefs ?? []).find((b) => b.title === "Short on power in the long shadow");
check("the mission board carries the power-short problem", Boolean(brief) && brief.kit.challenge === "lean-array", brief?.problem);
const sid = (await call("POST", "/api/sessions", { scenarioId: brief.template, briefId: brief.id, difficulty: "engineer" })).body.session.id;
const snap = async () => (await call("GET", `/api/sessions/${sid}`)).body;
for (const itemId of ["ns", "nac"]) {
  const r = (await call("POST", `/api/sessions/${sid}/catalog`, { itemId, wait: true })).body;
  if (r.status === "awaiting_approval") await call("POST", `/api/sessions/${sid}/proposals/${r.proposalId}/approve`, { reason: "evidence run", acceptViolations: true });
}
for (const p of (await snap()).mission.derived["systems.wiring"].value.parts.filter((x) => x.notes.length)) {
  const r = (await call("POST", `/api/sessions/${sid}/connect`, { componentId: p.id, wait: true })).body;
  if (r.status === "awaiting_approval") await call("POST", `/api/sessions/${sid}/proposals/${r.proposalId}/approve`, { reason: "evidence run", acceptViolations: true });
}
await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await page.waitForTimeout(5000);
const problem = await page.locator(".problem").innerText();
check("the problem panel says what is wrong and offers the controls that bear on it", /half the planned size/i.test(problem) && /Array area/i.test(problem), problem.slice(0, 300));
const tab = (name) => page.locator(".right .tabs .tab", { hasText: new RegExp("^" + name + "( •)?$", "i") }).click();

// Fly as it is: short of power.
await tab("analysis");
await page.getByRole("button", { name: "Run mission simulation" }).click();
await page.waitForSelector("text=Science data by instrument", { timeout: 60000 });
const before = (await snap()).game.simulation;
check("flown as it stands, the mission is short of power for part of the year", before.kpis.daysPowerNegative > 20, `negative-power days ${before.kpis.daysPowerNegative}, instruments forced off ${before.kpis.daysInstrumentsOff}`);
const rows = await page.locator("table.data", { hasText: "Sent home" }).locator("tbody tr").count();
check("the flight report lists what each instrument sent home and lost", rows === 2, await page.locator("table.data", { hasText: "Sent home" }).innerText());
await page.screenshot({ path: path.join(out, "40-power-short-flight.png") });

// Install control logic by hand (the same structure the AI writes), in the page's own session.
const ctl = { id: "ctl-dark", name: "Dark-season saver", description: "Runs the instruments a quarter of the time while power is short.", hostId: "bus", memory: { saving: 0 }, rules: [
  { when: "power.marginW < 0 or battery.soc < 0.5", do: [{ target: "mem:saving", value: "1" }], note: "power is short" },
  { when: "power.marginW > 5 and battery.soc > 0.9", do: [{ target: "mem:saving", value: "0" }], note: "power is back" },
  { when: "mem.saving == 1", do: [{ target: "instruments", value: "nominal * 0.25" }], note: "instruments at a quarter" },
], origin: { kind: "user_authored" } };
const installed = await page.evaluate((c) => window.__collabEdit([{ op: "append", path: "systems.controllers", value: c }], "Install Dark-season saver"), ctl);
check("control logic is installed from the page", installed?.ok === true);
await page.waitForTimeout(800);
await page.getByRole("button", { name: /Run mission simulation|Re-run simulation/ }).click();
await page.waitForSelector("text=Onboard control logic", { timeout: 60000 });
await page.waitForTimeout(800);
const after = (await snap()).game.simulation;
check("with the control logic the short days are gone, at the cost of some science", after.kpis.daysPowerNegative < before.kpis.daysPowerNegative / 2 && after.kpis.daysControlActive > 10 && after.kpis.totalDataReturnedGb < before.kpis.totalDataReturnedGb, `negative-power days ${before.kpis.daysPowerNegative} → ${after.kpis.daysPowerNegative}; instruments forced off ${before.kpis.daysInstrumentsOff} → ${after.kpis.daysInstrumentsOff}; data home ${before.kpis.totalDataReturnedGb.toFixed(0)} → ${after.kpis.totalDataReturnedGb.toFixed(0)} Gb; acted on ${after.kpis.daysControlActive} days`);
const report = await page.locator(".right").innerText();
check("the flight report shows what the control logic did, day by day", /Onboard control logic · acted on \d+ of \d+ days/i.test(report) && /instruments at a quarter/.test(report), report.slice(report.search(/Onboard control logic/i), report.search(/Onboard control logic/i) + 260));
await page.screenshot({ path: path.join(out, "41-flight-with-control-logic.png") });
check("no page errors", problems.length === 0, problems.join(" || "));
fs.writeFileSync(path.resolve("reports/evidence/ui-flight.md"), lines.join("\n") + "\n");
await browser.close();
process.exitCode = lines.some((l) => l.startsWith("FAIL")) ? 1 : 0;
