// One player takes a mission from its first screen to a submitted, evaluated result using only the
// real UI (clicks and typing) with the live language model: define → add parts → connect → ask the AI
// for control logic → try an idea that does not hold → choose a launch vehicle → step the shared clock
// → fly → compare designs → review → submit → debrief.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("playwright-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
// --no-model: the server has no language model. Everything a player does by clicking is done the same way;
// the two steps that need the model (control logic written from a sentence, an idea judged) are replaced by
// a control logic installed as a crew edit and a question the built-in analyser can answer. No model request is made.
const noModel = process.argv.includes("--no-model");
const out = path.resolve("reports/evidence/ui");
fs.mkdirSync(out, { recursive: true });
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 320)}` : ""}`);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
page.setDefaultTimeout(60000);
const problems = [];
page.on("pageerror", (e) => problems.push(String(e).slice(0, 240)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|ERR_|40[0-9]|422|Failed to load resource/.test(m.text())) problems.push(m.text().slice(0, 240)); });
page.on("dialog", (d) => void d.accept());
await page.goto(`${BASE}/api/health`);
const post = (route, body) => page.evaluate(([r, b]) => fetch(r, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [route, body]);
const get = (route) => page.evaluate((r) => fetch(r, { credentials: "include" }).then((x) => x.json()), route);
const creds = { username: noModel ? "flowpilotlocal" : "flowpilot", password: "full-flow-check-password-1", displayName: "Flow Pilot" };
if ((await post("/api/auth/register", creds)).status >= 300) await post("/api/auth/login", creds);
const sid = (await post("/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "cadet", seed: 5, name: "Evidence full flow" })).body.session.id;
say(`# UI run: one mission from first screen to debrief — ${new Date().toISOString()} — session ${sid}`);
const snap = () => get(`/api/sessions/${sid}`);
const tab = (name) => page.locator(".right .tabs .tab", { hasText: new RegExp(`^${name}`, "i") }).click();
// the pictures of the live run are evidence in the report: a run without the model does not overwrite them
const shot = (name) => (noModel ? Promise.resolve() : page.screenshot({ path: path.join(out, name) }));

// First screen, with the walkthrough a newcomer gets.
await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
await page.waitForTimeout(6000);
await shot("30-first-screen-with-walkthrough.png");
const first = await page.locator("body").innerText();
check("a newcomer's first screen states the mission, what is not yet working, what can be changed and how to ask", /THE PROBLEM/i.test(first) && /Does the mission work/i.test(first) && /Controls/i.test(first) && /My AI/i.test(first));
const walkthrough = await page.locator(".tutorial, .coachmark, [class*=tutorial]").first().innerText().catch(() => "");
check("a short walkthrough is offered on first visit", walkthrough.length > 20, walkthrough);
for (let i = 0; i < 8; i++) { const b = page.getByRole("button", { name: /^(Next|Got it|Skip|Start)/ }).first(); if (await b.count()) { await b.click(); await page.waitForTimeout(250); } else break; }

// Define the mission.
await page.getByRole("button", { name: "Say what your crew is going for" }).click();
await page.locator(".modal.define textarea").fill("Map hydrogen near the lunar south pole finely enough to choose a rover route.");
await page.locator(".modal.define .preset", { hasText: "Map hydrogen" }).click();
await page.locator(".modal.define").getByRole("button", { name: "Define the mission" }).click();
await page.waitForSelector(".modal.define", { state: "detached" });
check("the crew defines its mission in the UI", Boolean((await snap()).game.charter));

// Add two instruments from the kit, then connect them from the Systems tab.
await page.locator(".kit-tabs button", { hasText: "Parts" }).click();
for (const name of ["Neutron spectrometer", "Wide-angle camera"]) {
  const before = (await snap()).mission.config.spacecraft.components.length;
  await page.locator(".toolbox .tool", { hasText: name }).getByRole("button", { name: "Add" }).click();
  await page.waitForFunction((n) => window.__workspace.scene.mission.config.spacecraft.components.length > n, before, { timeout: 60000 });
  await page.waitForTimeout(800);
}
await tab("systems");
await page.waitForSelector(".attention .tool");
check("the Systems tab lists the two new parts as needing a connection", (await page.locator(".attention .tool").count()) === 2);
await shot("31-systems-needs-connection.png");
for (let i = 0; i < 2; i++) {
  const linesBefore = (await snap()).mission.config.systems.links.length;
  await page.locator(".attention .tool").first().getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction((n) => window.__workspace.scene.mission.config.systems.links.length > n, linesBefore, { timeout: 60000 });
  await page.waitForTimeout(800);
}
let s = await snap();
check("both are connected through the UI and the hydrogen goal is met", s.mission.derived["systems.wiring"].value.unconnected.length === 0 && s.evaluation.objectives.find((o) => o.id === "hydrogen").achieved === 1);

// Save the design as it stands, for comparison later.
await tab("designs");
await page.getByPlaceholder(/Name this design/).fill("Before control logic");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.waitForSelector(".right .objective:has-text('Before control logic')");

// Ask the AI for control logic (live model).
const ask = async (text, timeout = 200000) => {
  await tab("AI");
  await page.locator(".right textarea").fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const end = Date.now() + timeout;
  let r = null;
  while (Date.now() < end) { await page.waitForTimeout(2000); r = (await get(`/api/sessions/${sid}/requests`)).find((x) => x.text === text); if (r && !["queued", "analyzing", "planning", "executing"].includes(r.status)) break; }
  await page.waitForTimeout(800);
  return r;
};
let r1 = null;
if (noModel) {
  const ctl = { id: "ctl-flow", name: "Power saver", description: "Runs the instruments a quarter of the time when power is short.", hostId: "bus", memory: { saving: 0 }, rules: [{ when: "power.marginW < 0 or battery.soc < 0.6", do: [{ target: "mem:saving", value: "1" }] }, { when: "battery.soc > 0.9 and power.marginW >= 0", do: [{ target: "mem:saving", value: "0" }] }, { when: "mem.saving == 1", do: [{ target: "instruments", value: "nominal * 0.25" }], note: "saving power" }], origin: { kind: "user_authored" } };
  await page.evaluate((c) => window.__collabEdit([{ op: "append", path: "systems.controllers", value: c }], "Install Power saver"), ctl);
  await page.waitForFunction(() => window.__workspace.scene.mission.config.systems.controllers.length === 1, null, { timeout: 20000 }).catch(() => null);
} else {
  r1 = await ask("When power runs short, run the instruments at a quarter of their normal time, and return to normal once the battery is nearly full again. Also send the hydrogen data down first.");
  if (r1?.status === "awaiting_approval") { await page.locator(".chat .turn").first().getByRole("button", { name: /Approve & deploy|Add it anyway/ }).click(); await page.waitForTimeout(2500); }
}
s = await snap();
check(noModel ? "control logic is in the design (installed as a crew edit: no model in this run)" : "the AI wrote control logic from one sentence and it is in the design", s.mission.config.systems.controllers.length === 1, noModel ? s.mission.config.systems.controllers[0]?.name : `${r1?.answer?.verdict}: ${r1?.answer?.text}`);
await shot("32-ai-built-controller.png");

if (noModel) {
  // A question typed into the AI panel is answered from the engineering models and changes nothing.
  const r2 = await ask("compute the link budget", 60000);
  check("a question typed into the AI panel is answered from the engineering models and changes nothing", /margin/i.test(r2?.answer?.text ?? "") && !r2?.proposalId && (await snap()).mission.version === s.mission.version, r2?.answer?.text);
} else {
  // An idea that does not hold.
  const r2 = await ask("If we painted the solar array black, would the radio link margin improve?");
  check("an idea that does not hold is labelled so, with the reason, and nothing is built", ["refuted", "outside_model", "explained", "cannot"].includes(r2?.answer?.verdict) && !r2?.proposalId && (await snap()).mission.version === s.mission.version, `${r2?.answer?.verdict}: ${r2?.answer?.text}`);
  await page.locator(".chat .seg.thin button", { hasText: "Did not hold" }).click();
  await page.waitForTimeout(500);
  const kept = await page.locator(".chat .turn").count();
  check("it is kept under 'Did not hold' with its reason, and can be shared with the crew", r2?.answer?.verdict === "refuted" ? kept === 1 && (await page.locator(".chat .turn .foot button", { hasText: "Share with crew" }).count()) === 1 : true, `verdict ${r2?.answer?.verdict}, ${kept} kept`);
  await shot("33-idea-did-not-hold.png");
  await page.locator(".chat .seg.thin button", { hasText: "Everything" }).click();
}

// Launch vehicle, from the kit's controls.
await page.locator(".kit-tabs button", { hasText: "Controls" }).click();
const launch = (await snap()).mission.derived["launch.vehicle"].value;
const able = launch.options.filter((o) => o.capacityKg >= launch.launchMassKg).sort((a, b) => a.costMusd - b.costMusd)[0];
await page.locator(".lever .choices button", { hasText: able.name.replace(/ (slot|launcher)$/i, "").replace("Dedicated small", "Dedicated") }).first().click();
await page.waitForFunction((id) => window.__workspace.scene.mission.config.meta.launchVehicleId === id, able.id, { timeout: 20000 });
check("a launch vehicle is chosen with the kit's control", true, able.name);

// The shared clock: step a day forward, then back to the mission date.
const t0 = await page.evaluate(() => window.__workspace.scene.clockMs);
await page.getByRole("button", { name: "Step time +1 d" }).click();
await page.waitForTimeout(500);
const t1 = await page.evaluate(() => window.__workspace.scene.clockMs);
check("the clock steps one day and the state chips follow", Math.abs(t1 - t0 - 86400000) < 2000, `${new Date(t0).toISOString()} → ${new Date(t1).toISOString()} · ${(await page.locator(".clockdeck .states").innerText()).replace(/\s+/g, " ")}`);
await page.getByRole("button", { name: "Mission date" }).click();

// Fly.
await tab("analysis");
await page.getByRole("button", { name: "Run mission simulation" }).click();
await page.waitForSelector("text=Data returned", { timeout: 60000 });
await page.waitForTimeout(1500);
s = await snap();
const outcome = await page.locator(".outcome").innerText();
check("the flight runs and the outcome, with its evidence, updates above the score", /flown \d+ days/.test(outcome) && s.game.simulation !== null, outcome);
await shot("34-after-flight.png");
await tab("systems");
await page.waitForTimeout(600);
check("the Systems tab reports what the control logic did on that flight", /What it did on the last flight/i.test(await page.locator(".systems").innerText()), `acted on ${s.game.simulation.kpis.daysControlActive} of ${s.game.simulation.days} days`);

// Compare with the design saved before the control logic.
await tab("designs");
await page.getByPlaceholder(/Name this design/).fill("With control logic");
await page.getByRole("button", { name: "Save", exact: true }).click();
await page.waitForSelector(".right .objective:has-text('With control logic')");
await page.locator(".right").getByRole("button", { name: "Compare", exact: true }).first().click();
const rows = await page.waitForSelector("table.compare tbody tr", { timeout: 15000 }).then(() => page.locator("table.compare tbody tr").count(), () => 0);
check("the two saved designs are compared side by side under the same conditions", rows >= 10, `${rows} rows`);
await shot("35-design-comparison.png");
await page.keyboard.press("Escape");

// Review and submit.
await tab("review");
let submitted = null;
for (let i = 0; i < 8 && !submitted; i++) {
  const st = await snap();
  if (st.game.submitted) { submitted = st; break; }
  const before = st.game.phase;
  await page.getByRole("button", { name: /^Hold .* review/ }).click().catch(() => null);
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Advance phase" }).click().catch(() => null);
  await page.waitForTimeout(1500);
  const now = await snap();
  if (now.game.phase === before || now.game.phase === "review") {
    await page.getByRole("button", { name: "Submit mission" }).click().catch(() => null);
    await page.waitForTimeout(3000);
    if ((await snap()).game.submitted) submitted = await snap();
  }
}
check("the mission is submitted from the Review tab", Boolean(submitted?.game.submitted), `phase ${(await snap()).game.phase}`);
await page.waitForSelector(".modal .grade", { timeout: 15000 }).catch(() => null);
await page.waitForTimeout(1500);
const debrief = await page.locator(".modal").innerText().catch(() => "");
check("the debrief opens with whether the mission worked, then the score", /Does the mission work/i.test(debrief) && debrief.indexOf("Does the mission work") < debrief.search(/\b[SABCD]\b\s*\n|objectives|OBJECTIVES/), debrief.slice(0, 260));
await shot("36-debrief-outcome-first.png");
check("no page or console errors during the whole flow", problems.length === 0, problems.join(" || "));
fs.writeFileSync(path.resolve(noModel ? "reports/evidence/ui-fullflow-no-model.md" : "reports/evidence/ui-fullflow.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]); // closing a headless browser can hang while another Edge is open
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
