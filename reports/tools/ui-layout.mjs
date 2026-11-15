// Layout at four window sizes (1280×720, a 1366×768 laptop, a 1536×864 laptop at 125 % scaling, a 1920×1080 monitor):
// the 3D stage must stay visible under its overlays, the time bar must stay on one line, nothing may
// spill out of the window, and a selected part's card must leave room for the tabs. Measured from the
// real page in a real browser; no language model is involved.
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
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 320)}` : ""}`);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=d3d11"] });
say(`# Layout at four window sizes — ${new Date().toISOString()}`);
let sid = null;
for (const [w, h] of [[1280, 720], [1366, 768], [1536, 864], [1920, 1080]]) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
  await page.goto(`${BASE}/api/health`);
  const call = (method, route, body) => page.evaluate(([m, r, b]) => fetch(r, { method: m, credentials: "include", headers: { "content-type": "application/json" }, ...(b !== null ? { body: JSON.stringify(b) } : {}) }).then(async (x) => ({ status: x.status, body: await x.json().catch(() => null) })), [method, route, body ?? null]);
  const creds = { username: "layoutpilot", password: "layout-check-password-1", displayName: "Layout Pilot" };
  if ((await call("POST", "/api/auth/register", creds)).status >= 300) await call("POST", "/api/auth/login", creds);
  await page.evaluate(() => localStorage.setItem("mf.tutorial.done", "1"));
  if (!sid) {
    sid = (await call("POST", "/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 21, name: "Layout check" })).body.session.id;
    await call("POST", `/api/sessions/${sid}/catalog`, { itemId: "ns", wait: true });
    // connected, so the data tiles carry real (longer) numbers
    const part = (await call("GET", `/api/sessions/${sid}`)).body.mission.config.spacecraft.components.find((c) => c.type === "instrument");
    await call("POST", `/api/sessions/${sid}/connect`, { componentId: part.id });
  }
  await page.goto(`${BASE}/mission?s=${sid}&intro=0`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__workspace?.scene.mission), null, { timeout: 60000 });
  await page.waitForTimeout(3500);
  // right after a change, while the "why the numbers moved" note is up (the worst case for the stage)
  await page.evaluate((v) => window.__collabEdit([{ op: "set", path: "orbit.inclinationDeg", value: v }], "Layout check"), 80 + Math.round(w / 200));
  await page.waitForTimeout(1500);
  const measure = () => page.evaluate(() => {
    const box = (e) => e.getBoundingClientRect();
    const mid = box(document.querySelector(".hud .mid"));
    // share of the stage covered by anything laid over it, on a 40×40 grid of sample points
    const covers = [...document.querySelectorAll(".stage-bottom .metric, .stage-bottom .coach, .mid .tutorial, .mid .ai-queue, .mid .part-card")].map(box).filter((b) => b.width > 0 && b.height > 0);
    let hit = 0;
    for (let iy = 0; iy < 40; iy++) for (let ix = 0; ix < 40; ix++) {
      const x = mid.left + ((ix + 0.5) / 40) * mid.width, y = mid.top + ((iy + 0.5) / 40) * mid.height;
      if (covers.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)) hit++;
    }
    const bar = box(document.querySelector(".hud .bottom"));
    const tabs = document.querySelector(".right .tabs");
    const right = box(document.querySelector(".hud .right"));
    return {
      stage: [Math.round(mid.width), Math.round(mid.height)],
      covered: hit / 1600,
      note: Boolean(document.querySelector(".stage-bottom .coach")) && box(document.querySelector(".stage-bottom .coach")).height > 4,
      barHeight: Math.round(bar.height),
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
      overflowY: document.documentElement.scrollHeight - window.innerHeight,
      roomUnderTabs: tabs ? Math.round(right.bottom - box(tabs).bottom) : 0,
      clippedTiles: [...document.querySelectorAll(".stage-bottom .metric .v")].filter((e) => e.scrollWidth > e.clientWidth + 1).length,
    };
  });
  const fresh = await measure();
  check(`${w}×${h}: with the note up, overlays cover under 40 % of the 3D stage`, fresh.covered < 0.4, `stage ${fresh.stage.join("×")} px · covered ${(fresh.covered * 100).toFixed(0)} % · note shown: ${fresh.note}`);
  await page.waitForTimeout(13000);
  const settled = await measure();
  check(`${w}×${h}: the note leaves by itself, and the numbers then cover under 25 % of the stage`, settled.note === false && settled.covered < 0.25, `covered ${(settled.covered * 100).toFixed(0)} % · note shown: ${settled.note}`);
  check(`${w}×${h}: the time bar is one line, nothing spills out of the window, no number is cut off`, settled.barHeight <= 72 && settled.overflowX <= 0 && settled.overflowY <= 0 && settled.clippedTiles === 0, `bar ${settled.barHeight} px · overflow ${settled.overflowX}/${settled.overflowY} px · cut-off numbers ${settled.clippedTiles}`);
  // a selected part: its card sits in the side panel and leaves room for the tabs' content
  await page.getByRole("button", { name: "Systems", exact: true }).first().click();
  await page.waitForTimeout(1200);
  const inst = await page.evaluate(() => window.__workspace.scene.mission.config.spacecraft.components.find((c) => c.type === "instrument").id);
  await page.evaluate((id) => window.__select(id), inst);
  await page.waitForTimeout(700);
  const sel = await measure();
  const onStage = await page.locator(".mid .part-card").count();
  check(`${w}×${h}: a selected part's card is in the side panel, with at least 150 px left for the tab under it`, onStage === 0 && (await page.locator(".right > .part-card").count()) === 1 && sel.roomUnderTabs >= 150, `room under the tabs ${sel.roomUnderTabs} px · stage covered ${(sel.covered * 100).toFixed(0)} %`);
  // the card's own actions are in view without scrolling inside it
  const actions = await page.evaluate(() => { const card = document.querySelector(".hud .right > .part-card"); if (!card) return null; const c = card.getBoundingClientRect(); const bs = [...card.querySelectorAll(".row.wrap:last-child .btn")].map((b) => b.getBoundingClientRect()); return { buttons: bs.length, hidden: bs.filter((b) => b.bottom > c.bottom + 1 || b.top < c.top - 1 || b.bottom > window.innerHeight).length, card: Math.round(c.height) }; });
  check(`${w}×${h}: the selected part's action buttons are in view without scrolling inside its card`, actions !== null && actions.buttons >= 2 && actions.hidden === 0, JSON.stringify(actions));
  // with the card up, the AI tab still shows the whole composer (the box you type in and its Send button)
  await page.locator(".right .tabs .tab", { hasText: /^AI/i }).click();
  await page.waitForTimeout(600);
  const typing = await page.evaluate(() => { const r = document.querySelector(".hud .right").getBoundingClientRect(); const c = document.querySelector(".chat .composer"); if (!c) return null; const b = c.getBoundingClientRect(); const t = c.querySelector("textarea").getBoundingClientRect(); const st = document.querySelector(".chat .stream").getBoundingClientRect(); return { below: Math.round(b.bottom - r.bottom), textarea: Math.round(t.height), stream: Math.round(st.height) }; });
  check(`${w}×${h}: with a part selected, the AI tab still shows the whole box you type in, and some of the conversation`, typing !== null && typing.below <= 0 && typing.textarea >= 36 && typing.stream >= 50, JSON.stringify(typing));
  await page.screenshot({ path: path.join(out, `75-layout-${w}x${h}.png`) });
  await page.context().close();
}
fs.writeFileSync(path.resolve("reports/evidence/ui-layout.md"), lines.join("\n") + "\n");
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]);
process.exit(lines.some((l) => l.startsWith("FAIL")) ? 1 : 0);
