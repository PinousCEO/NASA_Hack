// A Cadet player's plain route through every mission on the board, by the server API (no language model):
// take the parts the mission's kit lays out, connect each, choose the smallest launch vehicle that lifts the
// spacecraft, fly. Reports where that route ends for each mission: the verdict, the stars and what is still open.
// It is the route the on-screen hints describe, done without judgement: it shows which missions a beginner
// finishes by following the hints alone, and which ask for more.
import fs from "node:fs";
import path from "node:path";
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
let cookie = "";
async function api(method, route, body) {
  const res = await fetch(BASE + route, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, body: await res.json().catch(() => null) };
}
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };
const creds = { username: "cadetpilot", password: "cadet-route-password-1", displayName: "Cadet Pilot" };
if ((await api("POST", "/api/auth/register", creds)).status >= 300) await api("POST", "/api/auth/login", creds);
const board = (await api("GET", "/api/briefs")).body.briefs;
say(`# A Cadet's plain route through each mission on the board — ${new Date().toISOString()}`);
const stars = (score) => (score >= 90 ? 3 : score >= 75 ? 2 : score >= 55 ? 1 : 0);
let won = 0;
for (const b of board) {
  const sid = (await api("POST", "/api/sessions", { scenarioId: b.template, briefId: b.id, difficulty: "cadet", name: `Cadet ${b.title}`.slice(0, 60) })).body.session.id;
  const snap = async () => (await api("GET", `/api/sessions/${sid}`)).body;
  let s = await snap();
  const approve = async (r) => { if (r.body?.status === "awaiting_approval") await api("POST", `/api/sessions/${sid}/proposals/${r.body.proposalId}/approve`, { reason: "cadet route", acceptViolations: true }); };
  // The parts the kit lays out, one of each, until the science goals are met in full.
  for (const t of s.session.kit.toolbox) {
    s = await snap();
    const science = s.evaluation.outcome.conditions.find((k) => k.id === "science");
    // Keep going while science goals are still open: "met" (60% of the credit) flies, but full success asks for 90%.
    if (science?.met && !/Still open/.test(science.evidence)) break;
    await approve(await api("POST", `/api/sessions/${sid}/catalog`, { itemId: t.itemId, wait: true }));
    s = await snap();
    for (const p of (s.mission.derived["systems.wiring"]?.value?.parts ?? []).filter((x) => x.notes.length)) await approve(await api("POST", `/api/sessions/${sid}/connect`, { componentId: p.id, wait: true }));
  }
  s = await snap();
  // The smallest launch vehicle that lifts it.
  const launch = s.mission.derived["launch.vehicle"]?.value;
  const mass = s.mission.derived["mass.budget"]?.value?.totalMassKg ?? 0;
  const fit = [...(launch?.options ?? [])].sort((x, y) => x.costMusd - y.costMusd).find((o) => o.capacityKg >= mass);
  if (fit) await api("POST", `/api/sessions/${sid}/edit`, { baseVersion: s.mission.version, patches: [{ op: "set", path: "meta.launchVehicleId", value: fit.id }], summary: `Launch vehicle → ${fit.name}` });
  await api("POST", `/api/sessions/${sid}/simulate`);
  s = await snap();
  const o = s.evaluation.outcome;
  if (o.verdict === "success") won++;
  say(`${o.verdict === "success" ? "WON " : "OPEN"} · ${b.title} (${b.destination}, ${b.origin}) — ${o.verdict} · ${"★".repeat(stars(s.evaluation.score)) || "no star"} · ${s.evaluation.score.toFixed(0)} pts · parts ${s.mission.config.spacecraft.components.length}${o.verdict === "success" ? "" : ` · open: ${o.conditions.filter((k) => !k.met).map((k) => `${k.title} (${String(k.evidence).slice(0, 90)})`).join("; ")}`}`);
}
say(`${won} of ${board.length} missions are won by the plain route; the others need a choice the hints lay out but do not make.`);
fs.writeFileSync(path.resolve("reports/evidence/play-cadet.md"), lines.join("\n") + "\n");
process.exit(0);
