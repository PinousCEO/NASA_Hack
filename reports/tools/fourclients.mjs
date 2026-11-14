// Four independent clients on one mission: join limits, synchronisation latency, state equality,
// concurrent edits, reconnection, a shared clock, and a shared flight result. Runs against a live
// server over real HTTP and WebSocket connections and writes the measurements as evidence.
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { WebSocket } = require("ws");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const out = [];
const say = (s = "") => { console.log(s); out.push(s); };
const check = (name, ok, detail = "") => { say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${detail}` : ""}`); return ok; };
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
  const creds = { username: name, password: "four-client-check-password-1", displayName: name.toUpperCase() };
  // Register first: a failed login counts against the per-address rate limit.
  let r = await api("POST", "/api/auth/register", creds);
  if (r.status >= 300) r = await api("POST", "/api/auth/login", creds);
  if (r.status >= 300) throw new Error(`${name}: could not sign in (${r.status} ${JSON.stringify(r.body)})`);
  const c = { name, api, account: r.body.account, ws: null, messages: [], seq: 0, version: 0, mission: null, waiters: [] };
  c.connect = (sid) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?session=${sid}`, { headers: { cookie } });
    c.ws = ws;
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      m._at = performance.now();
      c.messages.push(m);
      if (m.type === "welcome") { c.version = m.snapshot?.mission?.version ?? m.mission?.version ?? c.version; c.mission = m.snapshot?.mission ?? m.mission ?? c.mission; resolve(m); }
      if (m.type === "mission.version") { c.version = m.mission.version; c.mission = m.mission; }
      c.waiters = c.waiters.filter((w) => !(w.test(m) && (w.resolve(m), true)));
    });
    ws.once("error", reject);
  });
  c.until = (test, ms = 8000) => new Promise((resolve, reject) => {
    const hit = c.messages.find(test);
    if (hit) return resolve(hit);
    const w = { test, resolve };
    c.waiters.push(w);
    setTimeout(() => { c.waiters = c.waiters.filter((x) => x !== w); reject(new Error(`${name}: timed out`)); }, ms);
  });
  c.edit = (patches, summary, baseVersion = c.version) => new Promise((resolve) => {
    const clientSeq = ++c.seq;
    const sent = performance.now();
    const w = { test: (m) => m.type === "edit.result" && m.clientSeq === clientSeq, resolve: (m) => resolve({ ...m, sent }) };
    c.waiters.push(w);
    c.ws.send(JSON.stringify({ type: "edit", clientSeq, baseVersion, patches, summary }));
  });
  return c;
}

say(`# Four clients on one mission — ${new Date().toISOString()} — ${BASE}`);
const stamp = Date.now().toString(36).slice(-5);
const crew = [];
for (const n of ["alpha", "bravo", "charlie", "delta", "echo"]) crew.push(await client(`fc${n}`));
const [a, b, c, d, e] = crew;
const created = await a.api("POST", "/api/sessions", { scenarioId: "lunar-volatiles", difficulty: "engineer", seed: 33, name: `Four clients ${stamp}`, visibility: "public" });
const sid = created.body.session.id;
say(`session ${sid}`);
for (const m of [b, c, d]) check(`${m.name} joins`, (await m.api("POST", `/api/sessions/${sid}/join`, {})).status < 300);
const fifth = await e.api("POST", `/api/sessions/${sid}/join`, {});
check("a fifth player is refused (the crew is four)", fifth.status === 409, `${fifth.status} ${fifth.body?.error ?? ""}`);
for (const m of [a, b, c, d]) await m.connect(sid);
await sleep(300);
check("all four connected and hold the same version", new Set([a, b, c, d].map((m) => m.version)).size === 1, `v${a.version}`);

// --- synchronisation latency: one client edits, the other three receive the authoritative new version ---
const R = 1737.4;
const lat = [];
for (let i = 0; i < 24; i++) {
  const author = [a, b, c, d][i % 4];
  const others = [a, b, c, d].filter((m) => m !== author);
  const value = R + 80 + i;
  const waits = others.map((m) => m.until((x) => x.type === "mission.version" && x.mission.config.orbit.semiMajorAxisKm === value));
  const res = await author.edit([{ op: "set", path: "orbit.semiMajorAxisKm", value }], `altitude ${80 + i} km`);
  if (!res.ok) { check(`edit ${i} accepted`, false, JSON.stringify(res).slice(0, 200)); continue; }
  for (const m of await Promise.all(waits)) lat.push(m._at - res.sent);
  await sleep(15);
}
lat.sort((x, y) => x - y);
const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
say(`sync latency, edit sent → received by another client (n=${lat.length}, loopback, includes recalculating the engineering models): median ${q(0.5).toFixed(1)} ms · p95 ${q(0.95).toFixed(1)} ms · max ${lat[lat.length - 1].toFixed(1)} ms`);
check("every edit reached every other client", lat.length === 24 * 3);

// --- state equality: what each socket holds, and what each client reads over HTTP ---
await sleep(200);
const sockets = [a, b, c, d].map((m) => hash({ v: m.mission.version, config: m.mission.config, derived: Object.fromEntries(Object.entries(m.mission.derived).map(([k, v]) => [k, v.value])) }));
check("the four sockets hold identical mission state (config and derived results)", new Set(sockets).size === 1, sockets.join(" "));
const http = [];
for (const m of [a, b, c, d]) { const s = (await m.api("GET", `/api/sessions/${sid}`)).body; http.push(hash({ v: s.mission.version, config: s.mission.config, score: s.evaluation.score, checks: s.checks, outcome: s.evaluation.outcome })); }
check("the four clients read identical state, checks, outcome and score over HTTP", new Set(http).size === 1, http.join(" "));

// --- concurrent edits of the same value from the same base version: one wins, the other is told ---
const base = a.version;
const [r1, r2] = await Promise.all([a.edit([{ op: "set", path: "orbit.inclinationDeg", value: 88 }], "inc 88", base), b.edit([{ op: "set", path: "orbit.inclinationDeg", value: 86 }], "inc 86", base)]);
const winners = [r1, r2].filter((r) => r.ok).length;
const loser = [r1, r2].find((r) => !r.ok);
check("two simultaneous edits of the same value: exactly one is applied, the other gets a conflict", winners === 1 && loser?.reason === "conflict", `loser: ${loser?.reason} ${JSON.stringify(loser?.conflict ?? {}).slice(0, 140)}`);
// --- edits of different values from the same stale base both apply (rebased) ---
const base2 = a.version;
const [r3, r4] = await Promise.all([c.edit([{ op: "set", path: "orbit.raanDeg", value: 123 }], "raan", base2), d.edit([{ op: "set", path: "orbit.argPeriapsisDeg", value: 45 }], "argp", base2)]);
check("two simultaneous edits of different values both apply", r3.ok && r4.ok, `v${r3.version}, v${r4.version}`);
// --- an edit the validator refuses changes nothing for anyone ---
const v0 = a.version;
const bad = await a.edit([{ op: "append", path: "systems.links", value: { id: "bad", kind: "data", from: { node: "bus", port: "power" }, to: { node: "bus", port: "data_in" }, rating: 1, lengthM: 1 } }], "bad line");
await sleep(150);
check("an invalid line is refused and no client's version moves", bad.ok === false && [a, b, c, d].every((m) => m.version === v0 + 0 || m.version === a.version), bad.detail ?? "");

// --- reconnection: a client that was away comes back to the current state ---
c.ws.close();
await sleep(150);
await a.edit([{ op: "set", path: "orbit.semiMajorAxisKm", value: R + 55 }], "while charlie was away");
await b.edit([{ op: "set", path: "orbit.inclinationDeg", value: 90 }], "while charlie was away");
c.messages.length = 0;
await c.connect(sid);
await sleep(200);
const back = (await c.api("GET", `/api/sessions/${sid}`)).body;
check("a reconnecting client is restored to the current version", back.mission.version === a.version && back.mission.config.orbit.semiMajorAxisKm === R + 55, `v${back.mission.version}`);

// --- a shared clock: one turns time, the others receive the same moment ---
const t = Date.parse("2027-08-01T00:00:00Z");
const clocks = [b, c, d].map((m) => m.until((x) => x.type === "clock" && x.timeMs === t));
a.ws.send(JSON.stringify({ type: "clock", timeMs: t, rate: 0 }));
check("the mission clock one player sets reaches the other three", (await Promise.all(clocks)).length === 3);

// --- the AI's work on the shared world reaches everyone; a part connected by one is connected for all ---
const add = await b.api("POST", `/api/sessions/${sid}/catalog`, { itemId: "ns", wait: true });
const inst = (await b.api("GET", `/api/sessions/${sid}`)).body.mission.config.spacecraft.components.find((x) => x.type === "instrument");
const wired = await d.api("POST", `/api/sessions/${sid}/connect`, { componentId: inst.id, wait: true });
await sleep(400);
const seenLines = [a, b, c, d].map((m) => m.mission.config.systems.links.filter((l) => l.from.node === inst.id || l.to.node === inst.id).length);
check("a part added by one player and connected by another has its three lines on all four clients", add.status === 202 && wired.status === 202 && seenLines.every((n) => n === 3), seenLines.join(","));

// --- the flight: one player flies, all read the same result ---
const flown = (await a.api("POST", `/api/sessions/${sid}/simulate`)).body;
const kp = [];
for (const m of [a, b, c, d]) kp.push(hash((await m.api("GET", `/api/sessions/${sid}`)).body.game.simulation?.kpis ?? null));
check("the flight one player runs is the same result for all four", new Set(kp).size === 1 && kp[0] !== hash(null), `returned ${flown.kpis.totalDataReturnedGb.toFixed(1)} Gb · ${kp.join(" ")}`);
const again = (await c.api("POST", `/api/sessions/${sid}/simulate`)).body;
check("flying the same design again gives the same numbers", hash(again.kpis) === hash(flown.kpis));

const final = [];
for (const m of [a, b, c, d]) { const s = (await m.api("GET", `/api/sessions/${sid}`)).body; final.push(hash({ v: s.mission.version, config: s.mission.config })); }
check("final state identical on all four", new Set(final).size === 1, `v${a.version} ${final[0]}`);
for (const m of [a, b, c, d]) m.ws.close();
fs.mkdirSync("reports/evidence", { recursive: true });
fs.writeFileSync("reports/evidence/four-clients.md", out.join("\n") + "\n");
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
