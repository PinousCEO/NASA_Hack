// Re-runs every verification against the code as it now stands and writes one summary.
// Each browser/API script gets its own freshly started server with an empty data folder, so the runs
// are independent of one another and of anything done earlier. Scripts marked "live model" call the
// configured language model (a few requests each).
// Usage: node reports/tools/run-all-evidence.mjs [--live]   (without --live no language-model request is made)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Live-model runs cost money: they are skipped unless asked for with --live.
const noLive = !process.argv.includes("--live");
const PORT = 8795;
const BASE = `http://127.0.0.1:${PORT}`;
const rows = [];
const kst = () => new Date(Date.now() + 9 * 3600000).toISOString().replace("T", " ").slice(0, 19) + " KST";
const head = spawnSync("git", ["rev-parse", "--short", "HEAD"]).stdout.toString().trim();
const count = (text) => ({ pass: (text.match(/^PASS/gm) ?? []).length, fail: (text.match(/^FAIL/gm) ?? []).length });

// A verification server never writes missions by itself, and has no language-model key unless the script it serves is a
// live-model one. Running the checks must not run up a bill.
const quiet = { BRIEF_AUTOGEN: "off", OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", LLM_PROVIDER: "" };
const liveEnv = { BRIEF_AUTOGEN: "off" };
async function withServer(fn, live = false) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-evidence-"));
  const server = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], { env: { ...process.env, PORT: String(PORT), MISSION_DATA_DIR: dataDir, ...(live ? liveEnv : quiet) }, stdio: "ignore" });
  try {
    let up = false;
    for (let i = 0; i < 160 && !up; i++) { up = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false); if (!up) await new Promise((r) => setTimeout(r, 500)); }
    if (!up) throw new Error("server did not start");
    return await fn();
  } finally {
    server.kill();
    await new Promise((r) => setTimeout(r, 1200));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
function run(label, kind, cmd, args, env = {}) {
  const t0 = Date.now();
  const res = spawnSync(cmd, args, { env: { ...process.env, ...env }, maxBuffer: 64e6, shell: cmd === "npx" });
  const text = String(res.stdout ?? "") + String(res.stderr ?? "");
  const c = count(text);
  const tests = /Tests\s+(?:(\d+) failed \| )?(\d+) passed/.exec(text);
  const e2e = /(\d+)\/(\d+) checks passed/.exec(text);
  const passed = tests ? Number(tests[2]) : e2e ? Number(e2e[1]) : c.pass;
  const failed = tests ? Number(tests[1] ?? 0) : e2e ? Number(e2e[2]) - Number(e2e[1]) : c.fail;
  const ok = res.status === 0 && failed === 0 && passed > 0;
  rows.push({ label, kind, passed, failed, ok, seconds: Math.round((Date.now() - t0) / 1000) });
  console.log(`${ok ? "PASS" : "FAIL"} · ${label}: ${passed} passed, ${failed} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
  if (!ok) console.log(text.split("\n").filter((l) => /^FAIL|Error|✗|×/.test(l)).slice(0, 8).join("\n"));
  return text;
}
const node = process.execPath;
const started = kst();
fs.mkdirSync("reports/evidence/logs", { recursive: true });
fs.writeFileSync("reports/evidence/logs/vitest.txt", run("Unit and integration tests", "code level; language model is a test double", "npx", ["vitest", "run"]));
fs.writeFileSync("reports/evidence/logs/e2e-browser.txt", run("Browser end-to-end suite", "real browser, own fresh server, no language model, XR in the IWER emulator", node, ["tests/e2e/platform.e2e.mjs"]));
const scripted = [
  ["Wiring loop in the UI", "real browser", "reports/tools/ui-systems.mjs", []],
  ["Power-short mission: flight with control logic in the UI", "real browser", "reports/tools/ui-flight.mjs", []],
  ["Soak: four clients, 600 edits", "four real HTTP+WebSocket clients", "reports/tools/soak.mjs", ["600"]],
  ["Controls scan (labels, reasons for disabled)", "real browser, two roles", "reports/tools/ui-buttons.mjs", []],
  ["Four clients: sync, latency, conflicts, reconnect", "four real HTTP+WebSocket clients", "reports/tools/fourclients.mjs", []],
  ["Conversation: grows downward, a thread per part, nothing over the stage", "real browser, built-in analyser (no language model)", "reports/tools/ui-chat.mjs", ["--no-model"]],
  ["One player, first screen to debrief, by clicking", "real browser, built-in analyser (no language model)", "reports/tools/ui-fullflow.mjs", ["--no-model"]],
  ["Two players: private conversations, sharing, personal view", "two real browsers, built-in analyser (no language model)", "reports/tools/ui-private.mjs", []],
  ["Layout at four window sizes (stage stays visible)", "real browser", "reports/tools/ui-layout.mjs", []],
  ["Two players: pointing at a place, crew feed, game strip", "real browser", "reports/tools/ui-point.mjs", []],
  ["One person and three AI crewmates, to a flown mission", "real browser, no language model", "reports/tools/ui-crewmates.mjs", []],
  ["Web ↔ MR loop", "real browser + WebXR emulator (IWER)", "reports/tools/xr-loop.mjs", []],
  ["MR headset frame (what the session draws)", "real browser + WebXR emulator (IWER)", "reports/tools/xr-frame.mjs", []],
  ["Play-through: CubeSat", "server API, no language model", "reports/tools/play-mission.mjs", ["leo-cubesat", "9"]],
  ["Play-through: Mars orbiter", "server API, no language model", "reports/tools/play-mission.mjs", ["mars-weather-relay", "9"]],
  ["Play-through: lunar prospector", "server API, no language model", "reports/tools/play-mission.mjs", ["lunar-volatiles", "3"]],
];
const live = [
  ["Two players, their own AIs", "two real browsers, LIVE language model", "reports/tools/ui-crew.mjs", []],
  ["One mission from first screen to debrief", "real browser, LIVE language model", "reports/tools/ui-fullflow.mjs", []],
  ["Conversation threads per part, downward chat, one overlay at a time", "real browser, LIVE language model", "reports/tools/ui-chat.mjs", []],
];
for (const [label, kind, script, args] of scripted) await withServer(async () => run(label, kind, node, [script, ...args], { BASE }));
for (const [label, kind, script, args] of noLive ? [] : live) await withServer(async () => run(label, kind, node, [script, ...args], { BASE }), true);
const total = rows.reduce((s, r) => s + r.passed, 0);
const failed = rows.reduce((s, r) => s + r.failed, 0);
const md = [
  `# Verification summary — all runs against the final code`,
  ``,
  `Started ${started}, finished ${kst()}. Code: commit ${head} plus the uncommitted working tree. Each script below the first two ran against its own freshly started server with an empty data folder.`,
  ``,
  `| Verification | Kind | Passed | Failed | Result | Time |`,
  `|---|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.label} | ${r.kind} | ${r.passed} | ${r.failed} | ${r.ok ? "PASS" : "FAIL"} | ${r.seconds} s |`),
  ``,
  `Total: ${total} checks passed, ${failed} failed, across ${rows.length} runs.${noLive ? " Live-model runs were skipped in this pass." : ""}`,
  ``,
];
fs.writeFileSync("reports/evidence/summary.md", md.join("\n"));
fs.writeFileSync("reports/evidence/summary.json", JSON.stringify({ started, finished: kst(), head, rows, total, failed }, null, 2));
console.log(`\n${total} passed, ${failed} failed across ${rows.length} runs → reports/evidence/summary.md`);
process.exit(failed || rows.some((r) => !r.ok) ? 1 : 0);
