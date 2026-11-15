// Runs one verification script against its own freshly started server with an empty data folder.
// Usage: node reports/tools/run-one.mjs reports/tools/<script>.mjs [args…]
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const PORT = 8796;
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-one-"));
const server = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], { env: { ...process.env, PORT: String(PORT), MISSION_DATA_DIR: dataDir, BRIEF_AUTOGEN: "off", ...(process.argv.includes("--live") ? {} : { OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", LLM_PROVIDER: "" }) }, stdio: "ignore" });
let code = 1;
try {
  let up = false;
  for (let i = 0; i < 160 && !up; i++) { up = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false); if (!up) await new Promise((r) => setTimeout(r, 500)); }
  const res = spawnSync(process.execPath, process.argv.slice(2), { env: { ...process.env, BASE }, stdio: "inherit" });
  code = res.status ?? 1;
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 1000));
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.exitCode = code;
