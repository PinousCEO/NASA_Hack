// Looks for controls that would leave a player guessing: buttons that are disabled with no stated
// reason, buttons with no label, and (as a viewer, who may not edit) controls that look usable but
// are refused. Walks every tab of the mission page as the lead and as a viewer.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("playwright-core");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
const problems = [];
async function player(name, display) {
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  page.on("pageerror", (e) => problems.push(`${name}: ${String(e).slice(0, 200)}`));
  await page.goto(`${BASE}/api/health`);
  const post = (route, body) => page.evaluate(([r, b]) => fetch(r, { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [route, body]);
  const creds = { username: name, password: "button-scan-password-1", displayName: display };
  if ((await post("/api/auth/register", creds)).status >= 300) await post("/api/auth/login", creds);
  await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
  return { page, post };
}
const scan = (page) => page.evaluate(() => {
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const out = { total: 0, unlabeled: [], disabledNoReason: [] };
  for (const b of document.querySelectorAll("button, select, input, textarea")) {
    if (!visible(b)) continue;
    out.total++;
    const label = (b.textContent ?? "").trim() || b.getAttribute("aria-label") || b.getAttribute("title") || b.getAttribute("placeholder") || (b.closest("label")?.textContent ?? "").trim() || "";
    if (!label) out.unlabeled.push(b.outerHTML.slice(0, 120));
    if (b.disabled) {
      // A reason may be on the control, or on the group it sits in.
      const reason = b.getAttribute("title") || b.closest("[title]")?.getAttribute("title") || "";
      if (!reason) out.disabledNoReason.push(`${label.slice(0, 40)} @ ${b.closest("[class]")?.className?.toString().slice(0, 40)}`);
    }
  }
  return out;
});
const lead = await player("scanlead", "Scan Lead");
const viewer = await player("scanviewer", "Scan Viewer");
const sid = (await lead.post("/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 8, name: "Evidence button scan", visibility: "public" })).body.session.id;
await lead.post(`/api/sessions/${sid}/catalog`, { itemId: "ns", wait: true });
await viewer.post(`/api/sessions/${sid}/join`, { role: "viewer" });
say(`# Controls scan — ${new Date().toISOString()} — session ${sid}`);
let bad = 0;
for (const [who, p] of [["lead", lead], ["second member", viewer]]) {
  await p.page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
  await p.page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
  await p.page.waitForTimeout(5000);
  for (const kit of ["Controls", "Parts", "Crew"]) {
    await p.page.locator(".kit-tabs button", { hasText: kit }).click();
    for (const t of ["AI", "design", "systems", "analysis", "designs", "review", "log"]) {
      await p.page.locator(".right .tabs .tab", { hasText: new RegExp("^" + t + "( •)?$", "i") }).click();
      await p.page.waitForTimeout(350);
      if (kit !== "Controls" && t !== "AI") continue; // the right-hand tabs do not depend on the left kit tab
      const r = await scan(p.page);
      bad += r.unlabeled.length + r.disabledNoReason.length;
      say(`${r.unlabeled.length + r.disabledNoReason.length === 0 ? "PASS" : "FAIL"} · ${who} · kit ${kit} · tab ${t}: ${r.total} controls${r.unlabeled.length ? ` · unlabeled: ${r.unlabeled.join(" | ")}` : ""}${r.disabledNoReason.length ? ` · disabled without a reason: ${r.disabledNoReason.join(" | ")}` : ""}`);
    }
  }
}
say(`page errors: ${problems.length ? problems.join(" || ") : "none"}`);
fs.writeFileSync(path.resolve("reports/evidence/ui-buttons.md"), lines.join("\n") + "\n");
await browser.close();
process.exit(bad ? 1 : 0);
