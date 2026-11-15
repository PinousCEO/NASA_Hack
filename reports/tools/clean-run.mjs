// Starts the final build the way the README says, on a spare port with an empty data folder, and
// reproduces the core play against it: a mission played to submission through the API, and the wiring
// loop in a real browser. Nothing from earlier runs (accounts, sessions, caches of state) is reused.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-clean-"));
const out = [];
const say = (s) => { console.log(s); out.push(s); };
say(`# Clean run of the final build — ${new Date().toISOString()}`);
say(`data folder: new and empty (${path.basename(dataDir)}) · port ${PORT} · web client: apps/web/out built ${fs.statSync("apps/web/out/index.html").mtime.toISOString()}`);
const server = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], { env: { ...process.env, PORT: String(PORT), MISSION_DATA_DIR: dataDir, BRIEF_AUTOGEN: "off", ...(process.argv.includes("--live") ? {} : { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", LLM_PROVIDER: "" }) }, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
let up = false;
for (let i = 0; i < 120 && !up; i++) { up = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false); if (!up) await new Promise((r) => setTimeout(r, 500)); }
say(`${up ? "PASS" : "FAIL"} · the server starts and answers /api/health`);
const page = up ? await fetch(BASE).then((r) => r.text(), () => "") : "";
say(`${/<html/i.test(page) ? "PASS" : "FAIL"} · it serves the built web client at /`);
say("server start-up lines: " + log.split("\n").filter((l) => /Knowledge base|Capabilities|Language model|No accounts|Mission platform/.test(l)).map((l) => l.trim().replace(/\s+/g, " ")).join(" | ").slice(0, 600));
const run = (label, script, args = []) => {
  try {
    const res = execFileSync(process.execPath, [script, ...args], { env: { ...process.env, BASE }, maxBuffer: 32e6 }).toString();
    const pass = (res.match(/^PASS/gm) ?? []).length, fail = (res.match(/^FAIL/gm) ?? []).length;
    say(`${fail === 0 && pass > 0 ? "PASS" : "FAIL"} · ${label} — ${pass} checks passed, ${fail} failed`);
  } catch (e) {
    const res = String(e.stdout ?? "");
    say(`FAIL · ${label} — ${(res.match(/^PASS/gm) ?? []).length} passed, ${(res.match(/^FAIL/gm) ?? []).length} failed · ${res.split("\n").filter((l) => l.startsWith("FAIL")).join(" || ").slice(0, 400)}${String(e.stderr ?? "").slice(0, 300)}`);
  }
};
if (up) {
  run("a mission is played from a fresh start to submission (lunar)", "reports/tools/play-mission.mjs", ["lunar-volatiles", "3"]);
  run("the wiring loop works in a real browser against this server", "reports/tools/ui-systems.mjs");
}
server.kill();
await new Promise((r) => setTimeout(r, 800));
fs.rmSync(dataDir, { recursive: true, force: true });
fs.writeFileSync("reports/evidence/clean-run.md", out.join("\n") + "\n");
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
