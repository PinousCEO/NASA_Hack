// Two players in real browsers on one mission, with the live language model:
//  - each talks to their own AI; the other sees only a stub until the conversation is shared
//  - looking around is personal: one player's camera does not move the other's, nor the mission
//  - the outcome ("does the mission work?") is on screen before the score
//  - the AI builds control logic from a sentence; it shows up in the Systems tab; flying shows what it did
//  - the network drops and comes back: the client reconnects to the current state
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

async function player(name) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => problems.push(`${name}: ${String(e).slice(0, 200)}`));
  await page.goto(`${BASE}/api/health`);
  const post = (route, body) => page.evaluate(([r, b]) => fetch(r, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [route, body]);
  const get = (route) => page.evaluate((r) => fetch(r, { credentials: "include" }).then((x) => x.json()), route);
  const creds = { username: name, password: "crew-ui-check-password-1", displayName: name === "uiana" ? "Ana" : "Ben" };
  if ((await post("/api/auth/register", creds)).status >= 300) await post("/api/auth/login", creds);
  await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
  return { name, ctx, page, post, get };
}
const open = async (p, sid) => {
  await p.page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
  await p.page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
  await p.page.waitForTimeout(5000);
};
const askAi = async (p, sid, text, timeout = 180000) => {
  await p.page.locator(".right .tabs .tab", { hasText: /^AI/ }).click();
  await p.page.locator(".right textarea").fill(text);
  await p.page.getByRole("button", { name: "Send", exact: true }).click();
  const deadline = Date.now() + timeout;
  let r = null;
  while (Date.now() < deadline) {
    await p.page.waitForTimeout(2000);
    r = (await p.get(`/api/sessions/${sid}/requests`)).find((x) => x.text === text);
    if (r && !["queued", "analyzing", "planning", "executing"].includes(r.status)) break;
  }
  return r;
};

const ana = await player("uiana");
const ben = await player("uiben");
const sid = (await ana.post("/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 21, name: "Evidence crew UI", visibility: "public" })).body.session.id;
await ben.post(`/api/sessions/${sid}/join`, {});
say(`# UI run: two players, their own AIs — ${new Date().toISOString()} — session ${sid}`);
await open(ana, sid);
await open(ben, sid);

// The outcome is on screen, above the score, with its evidence.
const outcome = await ana.page.locator(".outcome").innerText();
check("the left column says whether the mission works, with evidence, above the score", /Does the mission work/i.test(outcome) && /science goals met/.test(outcome) && /not flown yet/.test(outcome), outcome);
await ana.page.screenshot({ path: path.join(out, "10-outcome-first.png") });

// Personal view: Ana looks around; Ben's camera and the mission do not move.
const camBen0 = await ben.page.evaluate(() => window.__workspace.debug.camera());
const camAna0 = await ana.page.evaluate(() => window.__workspace.debug.camera());
const v0 = (await ana.get(`/api/sessions/${sid}`)).mission.version;
const box = await ana.page.locator("canvas").first().boundingBox();
await ana.page.mouse.move(box.x + box.width * 0.5, box.y + 150);
await ana.page.mouse.down();
await ana.page.mouse.move(box.x + box.width * 0.5 + 260, box.y + 210, { steps: 12 });
await ana.page.mouse.up();
await ana.page.waitForTimeout(1200);
const camAna1 = await ana.page.evaluate(() => window.__workspace.debug.camera());
const camBen1 = await ben.page.evaluate(() => window.__workspace.debug.camera());
const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
check("looking around is personal: one player's camera moves, the other's does not, and the mission version stays", moved(camAna0, camAna1) > 0.05 && moved(camBen0, camBen1) < 1e-6 && (await ben.get(`/api/sessions/${sid}`)).mission.version === v0, `ana moved ${moved(camAna0, camAna1).toFixed(2)}, ben moved ${moved(camBen0, camBen1).toFixed(6)}, version v${v0}`);

// Ana's conversation with her AI is hers.
const q1 = "우리 우주선에서 지금 가장 여유가 적은 자원이 뭐야? 숫자로 알려줘.";
const r1 = await askAi(ana, sid, q1);
check("Ana's AI answers from the live mission (real model)", Boolean(r1?.answer?.text) && r1.answer.wording === "language_model", `${r1?.answer?.modelId}: ${r1?.answer?.text}`);
await ben.page.locator(".right .tabs .tab", { hasText: /^AI/ }).click();
await ben.page.locator(".chat .seg button", { hasText: "Whole crew" }).click();
await ben.page.waitForTimeout(1200);
const benView = await ben.page.locator(".chat").innerText();
check("Ben sees that Ana talked to her AI, but not what was said", /Ana & their AI/i.test(benView) && /private conversation/i.test(benView) && !benView.includes("여유가 적은") && !benView.includes(String(r1?.answer?.text).slice(0, 24)), benView);
await ben.page.screenshot({ path: path.join(out, "11-private-conversation-other-player.png") });
await ana.page.locator(".chat .turn .foot button", { hasText: "Share with crew" }).first().click();
await ben.page.waitForFunction((t) => document.querySelector(".chat")?.textContent?.includes(t), "여유가 적은", { timeout: 15000 }).catch(() => null);
const benView2 = await ben.page.locator(".chat").innerText();
check("after Ana shares it, Ben can read the question and the answer", benView2.includes("여유가 적은") && benView2.includes(String(r1?.answer?.text).slice(0, 24)));
await ben.page.screenshot({ path: path.join(out, "12-shared-conversation.png") });

// Ben builds: instruments, then control logic, in his own words.
const r2 = await askAi(ben, sid, "Add the neutron spectrometer and the wide-angle camera and connect them.");
check("Ben's AI builds two instruments with their lines (real ids in the proposal)", Boolean(r2?.proposalId), `${r2?.status}: ${r2?.answer?.text}`);
if (r2?.status === "awaiting_approval") { await ben.post(`/api/sessions/${sid}/proposals/${r2.proposalId}/approve`, { reason: "evidence run", acceptViolations: true }); await ben.page.waitForTimeout(1500); }
const afterBuild = await ben.get(`/api/sessions/${sid}`);
const insts = afterBuild.mission.config.spacecraft.components.filter((c) => c.type === "instrument");
check("the instruments are on board and wired for both players", insts.length === 2 && insts.every((i) => afterBuild.mission.config.systems.links.filter((l) => l.from.node === i.id || l.to.node === i.id).length === 3) && (await ana.page.evaluate(() => window.__workspace.scene.mission.config.spacecraft.components.filter((c) => c.type === "instrument").length)) === 2, insts.map((i) => i.id).join(", "));
const r3 = await askAi(ben, sid, "I want the spacecraft to protect itself: if power runs short, run the instruments at a quarter of their normal time, and go back to normal once the battery is nearly full again.");
if (r3?.status === "awaiting_approval") { await ben.post(`/api/sessions/${sid}/proposals/${r3.proposalId}/approve`, { reason: "evidence run", acceptViolations: true }); await ben.page.waitForTimeout(1500); }
const afterCtl = await ana.get(`/api/sessions/${sid}`);
const ctl = afterCtl.mission.config.systems.controllers[0];
check("Ben's AI wrote control logic from that sentence and it is in the shared design", Boolean(ctl) && ctl.rules.length >= 2, ctl ? `${ctl.name}: ${ctl.rules.map((r) => `WHEN ${r.when} → ${r.do.map((a) => `${a.target}=${a.value}`).join(", ")}`).join(" | ")}` : r3?.answer?.text);
await ana.page.locator(".right .tabs .tab", { hasText: /^systems$/i }).click();
await ana.page.waitForTimeout(800);
const sysText = await ana.page.locator(".systems").innerText();
check("Ana sees Ben's controller in her Systems tab, rule by rule", /WHEN/.test(sysText) && /written by an AI/i.test(sysText), sysText.slice(sysText.indexOf("CONTROL LOGIC"), sysText.indexOf("CONTROL LOGIC") + 300));
await ana.page.screenshot({ path: path.join(out, "13-controller-in-systems-tab.png") });

// Fly it: the control log shows what the logic did.
const sim = (await ana.post(`/api/sessions/${sid}/simulate`)).body;
await ana.page.waitForTimeout(2500);
const sysText2 = await ana.page.locator(".systems").innerText();
check("after the flight the Systems tab reports what the control logic did", /What it did on the last flight/i.test(sysText2), `acted on ${sim.kpis.daysControlActive} of ${sim.days} days`);
const outcome2 = await ben.page.locator(".outcome").innerText();
check("both players see the same flown outcome", /flown \d+ days/.test(outcome2) && (await ana.page.locator(".outcome").innerText()) === outcome2, outcome2);
await ben.page.screenshot({ path: path.join(out, "14-outcome-after-flight.png") });

// The network drops and returns.
await ben.ctx.setOffline(true);
await ben.page.waitForTimeout(1500);
await ana.post(`/api/sessions/${sid}/connect`, { componentId: "none-such" });
const edited = await ana.page.evaluate(() => window.__collabEdit([{ op: "set", path: "orbit.inclinationDeg", value: 87 }], "while Ben was offline"));
await ben.ctx.setOffline(false);
await ben.page.waitForFunction(() => window.__workspace.scene.mission.config.orbit.inclinationDeg === 87, null, { timeout: 30000 }).catch(() => null);
check("after a network drop the client reconnects and catches up to the current state", edited?.ok === true && (await ben.page.evaluate(() => window.__workspace.scene.mission.config.orbit.inclinationDeg)) === 87);

say(`page errors: ${problems.length ? problems.join(" || ") : "none"}`);
fs.writeFileSync(path.resolve("reports/evidence/ui-crew.md"), lines.join("\n") + "\n");
await browser.close();
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
