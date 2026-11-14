// A longer session: four clients make several hundred edits in turn (orbit, part sizes, lines on and
// off, control logic on and off), flying the mission now and then. At the end every client must hold
// the same state, and synchronisation must not have slowed down.
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { WebSocket } = require("ws");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const EDITS = Number(process.argv[2] ?? 600);
const out = [];
const say = (s = "") => { console.log(s); out.push(s); };
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${detail}` : ""}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
async function client(name) {
  let cookie = "";
  const api = async (method, route, body) => {
    const res = await fetch(BASE + route, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const creds = { username: name, password: "soak-check-password-1", displayName: name.toUpperCase() };
  let r = await api("POST", "/api/auth/register", creds);
  if (r.status >= 300) r = await api("POST", "/api/auth/login", creds);
  const c = { name, api, seq: 0, version: 0, mission: null, waiters: [], received: 0 };
  c.connect = (sid) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?session=${sid}`, { headers: { cookie } });
    c.ws = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      m._at = performance.now();
      if (m.type === "welcome") { c.version = m.snapshot?.mission?.version ?? m.mission?.version ?? 0; c.mission = m.snapshot?.mission ?? m.mission ?? null; resolve(m); }
      if (m.type === "mission.version") { c.version = m.mission.version; c.mission = m.mission; c.received++; }
      c.waiters = c.waiters.filter((w) => !(w.test(m) && (w.resolve(m), true)));
    });
    ws.once("error", reject);
  });
  c.wait = (test, ms = 10000) => new Promise((resolve, reject) => { const w = { test, resolve }; c.waiters.push(w); setTimeout(() => { c.waiters = c.waiters.filter((x) => x !== w); reject(new Error(`${name} timed out`)); }, ms); });
  c.edit = (patches, summary) => new Promise((resolve) => {
    const clientSeq = ++c.seq;
    const sent = performance.now();
    c.waiters.push({ test: (m) => m.type === "edit.result" && m.clientSeq === clientSeq, resolve: (m) => resolve({ ...m, sent }) });
    c.ws.send(JSON.stringify({ type: "edit", clientSeq, baseVersion: c.version, patches, summary }));
  });
  return c;
}
say(`# Soak: four clients, ${EDITS} edits — ${new Date().toISOString()}`);
const crew = [];
for (const n of ["soaka", "soakb", "soakc", "soakd"]) crew.push(await client(n));
const [a] = crew;
const sid = (await a.api("POST", "/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 44, name: "Soak", visibility: "public" })).body.session.id;
for (const m of crew.slice(1)) await m.api("POST", `/api/sessions/${sid}/join`, {});
for (const m of crew) await m.connect(sid);
await a.api("POST", `/api/sessions/${sid}/catalog`, { itemId: "ns", wait: true });
await sleep(400);
const inst = a.mission.config.spacecraft.components.find((c) => c.type === "instrument").id;
const panel = a.mission.config.spacecraft.components.find((c) => c.type === "solar_panel");
const ctl = { id: "ctl-soak", name: "Soak saver", hostId: "bus", memory: { s: 0 }, rules: [{ when: "battery.soc < 0.5", do: [{ target: "mem:s", value: "1" }] }, { when: "battery.soc > 0.9", do: [{ target: "mem:s", value: "0" }] }, { when: "mem.s == 1", do: [{ target: "instruments", value: "nominal * 0.3" }] }], origin: { kind: "user_authored" } };
const line = { id: "ln-soak", kind: "power", from: { node: "bus", port: "power" }, to: { node: inst, port: "power_in" }, rating: 20, lengthM: 1 };
const lat = [];
let ok = 0, refused = 0, conflicts = 0, sims = 0;
const t0 = Date.now();
for (let i = 0; i < EDITS; i++) {
  const author = crew[i % 4];
  const other = crew[(i + 1) % 4];
  const has = (kind) => (kind === "ctl" ? author.mission.config.systems.controllers.some((c) => c.id === ctl.id) : author.mission.config.systems.links.some((l) => l.id === line.id));
  let patches;
  switch (i % 6) {
    case 0: patches = [{ op: "set", path: "orbit.semiMajorAxisKm", value: 1737.4 + 60 + (i % 90) }]; break;
    case 1: patches = [{ op: "set", path: `spacecraft.components.${panel.id}.areaM2`, value: Number((0.8 + (i % 40) / 50).toFixed(2)) }]; break;
    case 2: patches = has("line") ? [{ op: "remove", path: `systems.links.${line.id}` }] : [{ op: "append", path: "systems.links", value: line }]; break;
    case 3: patches = [{ op: "set", path: "orbit.inclinationDeg", value: 80 + (i % 20) }]; break;
    case 4: patches = has("ctl") ? [{ op: "remove", path: `systems.controllers.${ctl.id}` }] : [{ op: "append", path: "systems.controllers", value: ctl }]; break;
    default: patches = [{ op: "set", path: `spacecraft.components.${inst}.dutyCycle`, value: Number((0.3 + (i % 7) / 10).toFixed(1)) }];
  }
  const before = author.version;
  const seen = other.wait((m) => m.type === "mission.version" && m.mission.version > before).catch(() => null);
  const res = await author.edit(patches, `soak ${i}`);
  if (res.ok) { ok++; const m = await seen; if (m) lat.push(m._at - res.sent); }
  else if (res.reason === "conflict") conflicts++;
  else refused++;
  if (i % 100 === 99) { const s = await a.api("POST", `/api/sessions/${sid}/simulate`); if (s.status === 200) sims++; }
}
const seconds = (Date.now() - t0) / 1000;
await sleep(500);
const q = (arr, p) => [...arr].sort((x, y) => x - y)[Math.min(arr.length - 1, Math.floor(p * arr.length))];
const first = lat.slice(0, 100), last = lat.slice(-100);
say(`${ok} edits applied, ${conflicts} conflicts, ${refused} refused, ${sims} flights, in ${seconds.toFixed(1)} s (${(ok / seconds).toFixed(0)} edits/s)`);
say(`sync latency median: first 100 edits ${q(first, 0.5).toFixed(1)} ms → last 100 edits ${q(last, 0.5).toFixed(1)} ms · overall p95 ${q(lat, 0.95).toFixed(1)} ms · max ${Math.max(...lat).toFixed(1)} ms`);
check("nearly every edit was applied (a refused edit is one the validator rightly rejects)", ok >= EDITS * 0.95, `${ok}/${EDITS}`);
check("synchronisation did not slow down over the session", q(last, 0.5) < Math.max(25, q(first, 0.5) * 3));
const sockets = crew.map((m) => hash({ v: m.mission.version, config: m.mission.config }));
check("all four sockets end on the same version and configuration", new Set(sockets).size === 1, `v${a.version} ${sockets[0]}`);
const http = [];
for (const m of crew) { const s = (await m.api("GET", `/api/sessions/${sid}`)).body; http.push(hash({ v: s.mission.version, config: s.mission.config, score: s.evaluation.score, outcome: s.evaluation.outcome })); }
check("all four read the same state, outcome and score over HTTP", new Set(http).size === 1);
check("every client received every version", crew.every((m) => m.version === a.version), crew.map((m) => m.received).join(","));
const versions = (await a.api("GET", `/api/sessions/${sid}`)).body.versions;
check("the history is intact and ordered", versions.every((v, i) => i === 0 || v.version === versions[i - 1].version + 1), `${versions.length} most recent versions listed`);
for (const m of crew) m.ws.close();
fs.writeFileSync("reports/evidence/soak.md", out.join("\n") + "\n");
process.exitCode = out.some((l) => l.startsWith("FAIL")) ? 1 : 0;
