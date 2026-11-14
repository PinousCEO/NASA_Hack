// A mission brief written by the live language model: it must arrive as a playable, wired mission
// with a kit whose controls and parts exist in this game.
import fs from "node:fs";
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const out = [];
const say = (s) => { console.log(s); out.push(s); };
const check = (name, ok, detail = "") => say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 400)}` : ""}`);
let cookie = "";
const api = async (method, route, body) => {
  const res = await fetch(BASE + route, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const creds = { username: "briefpilot", password: "live-brief-check-password-1", displayName: "Brief Pilot" };
if ((await api("POST", "/api/auth/register", creds)).status >= 300) await api("POST", "/api/auth/login", creds);
say(`# A mission brief written by the live model — ${new Date().toISOString()}`);
const made = await api("POST", "/api/briefs/generate", { count: 1 });
const brief = made.body?.briefs?.[0];
check("the model writes a brief with its kit", made.status < 300 && Boolean(brief?.kit), `${brief?.origin} · ${brief?.title} · template ${brief?.template} · ${brief?.problem}`);
if (brief) {
  say(`crux: ${brief.kit.crux}`);
  say(`challenge: ${brief.kit.challenge}`);
  for (const l of brief.kit.levers) say(`control: ${l.key} — ${l.why}`);
  for (const t of brief.kit.toolbox) say(`part: ${t.itemId} — ${t.why}`);
  for (const r of brief.kit.roles) say(`role: ${r.seat} — ${r.task}`);
  const s = (await api("POST", "/api/sessions", { scenarioId: brief.template, briefId: brief.id, difficulty: "engineer" })).body;
  const snap = (await api("GET", `/api/sessions/${s.session.id}`)).body;
  const w = snap.mission.derived["systems.wiring"].value;
  const ids = new Set(snap.scenario.catalog.map((c) => c.id));
  check("the mission made from it is wired and computed from the first second", w.wired && w.unconnected.length === 0 && snap.checks.length > 5, `${w.links.length} lines · ${snap.checks.length} checks · outcome: ${snap.evaluation.outcome.headline}`);
  check("every part the kit names exists in this mission's catalogue", brief.kit.toolbox.every((t) => ids.has(t.itemId)));
  check("the kit names at least two controls and gives each a reason", brief.kit.levers.length >= 2 && brief.kit.levers.every((l) => l.why.length > 10));
}
fs.writeFileSync("reports/evidence/live-brief.md", out.join("\n") + "\n");
process.exitCode = out.some((l) => l.startsWith("FAIL")) ? 1 : 0;
