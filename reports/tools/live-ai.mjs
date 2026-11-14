// Talks to a running server as a player would, through the HTTP API, and writes the transcript as evidence.
// Usage: node reports/tools/live-ai.mjs <evidence-name> [--scenario id] [--approve] -- "question 1" "question 2" ...
// With --approve, every proposal the AI's work produces is approved, and the mission is flown before and after.
import fs from "node:fs";
import path from "node:path";
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const args = process.argv.slice(2);
const split = args.indexOf("--");
const flags = split >= 0 ? args.slice(0, split) : args.slice(0, 1);
const questions = split >= 0 ? args.slice(split + 1) : args.slice(1);
const name = flags[0] ?? "live-ai";
const scenario = flags.includes("--scenario") ? flags[flags.indexOf("--scenario") + 1] : "lunar-volatiles";
const approve = flags.includes("--approve");
const out = [];
const say = (line = "") => { console.log(line); out.push(line); };

let cookie = "";
async function call(method, route, body) {
  const res = await fetch(BASE + route, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}
const creds = { username: "evidencepilot", password: "evidence-check-password-1", displayName: "Evidence Pilot" };
if ((await call("POST", "/api/auth/login", creds)).status !== 200) await call("POST", "/api/auth/register", creds);
const health = await call("GET", "/api/health");
say(`# Live dialogue with the mission AI — ${new Date().toISOString()}`);
say(`server: ${BASE} · language model: ${JSON.stringify(health.body?.llm ?? health.body?.model ?? health.body)}`.slice(0, 400));
// --brief "<title>" plays a mission from the board (the brief decides the template and what is wrong at the start).
const briefTitle = flags.includes("--brief") ? flags[flags.indexOf("--brief") + 1] : null;
const board = briefTitle ? (await call("GET", "/api/briefs")).body : null;
const boardBrief = briefTitle ? (board?.briefs ?? board ?? []).find((b) => b.title === briefTitle) : null;
if (briefTitle && !boardBrief) { say(`brief "${briefTitle}" is not on the board`); process.exit(1); }
if (boardBrief) say(`brief: ${boardBrief.title} · starts with: ${boardBrief.kit?.challenge} · ${boardBrief.kit?.crux}`);
const created = await call("POST", "/api/sessions", boardBrief ? { scenarioId: boardBrief.template, briefId: boardBrief.id, difficulty: "engineer", name: `Evidence ${name}` } : { scenarioId: scenario, difficulty: "engineer", seed: 21, name: `Evidence ${name}` });
if (created.status >= 300) { say(`could not create a session: ${JSON.stringify(created.body)}`); process.exit(1); }
const sid = created.body.session.id;
say(`session: ${sid} · scenario: ${scenario}`);
const kpi = (s) => `returned ${s.kpis.totalDataReturnedGb.toFixed(1)} Gb, lost ${s.kpis.totalDataLostGb.toFixed(1)} Gb, negative-power days ${s.kpis.daysPowerNegative}, instruments-off days ${s.kpis.daysInstrumentsOff}, control-active days ${s.kpis.daysControlActive}, delivered ${(s.kpis.scienceDeliveredFraction * 100).toFixed(0)}%`;
const state = async () => (await call("GET", `/api/sessions/${sid}`)).body;
const brief = (snap) => `v${snap.mission.version} · parts ${snap.mission.config.spacecraft.components.length} · lines ${snap.mission.config.systems.links.length} · controllers ${snap.mission.config.systems.controllers.length} · score ${snap.evaluation.score.toFixed(1)}`;
say(`start: ${brief(await state())}`);

for (const [i, text] of questions.entries()) {
  const before = await state();
  let flownShown = false;
  const t0 = Date.now();
  const r = (await call("POST", `/api/sessions/${sid}/requests`, { text, wait: true })).body;
  say(`\n## Q${i + 1}. ${text}`);
  say(`status: ${r.status} · verdict: ${r.answer?.verdict} · wording: ${r.answer?.wording}${r.answer?.modelId ? ` (${r.answer.modelId})` : ""} · analysis: ${r.requirement?.analysis?.method}${r.requirement?.analysis?.repairs ? ` (repaired ${r.requirement.analysis.repairs}x after validation)` : ""} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  say(`operations: ${(r.requirement?.operations ?? []).map((o) => `${o.intent}: ${o.description}`).join(" | ") || "(none)"}`);
  say(`tasks: ${(r.plan?.tasks ?? []).map((t) => `${t.executedBy ?? t.capabilityId}:${t.status}`).join(", ") || "(none)"}`);
  say(`answer: ${r.answer?.text ?? r.error ?? "(no reply)"}`);
  if ((r.plan?.tasks ?? []).some((t) => t.status === "failed") || r.status === "failed") {
    const full = (await call("GET", `/api/sessions/${sid}/requests/${r.id}`)).body;
    for (const e of (full.trace ?? []).filter((e) => /fail|error|reject/i.test(e.message)).slice(0, 6)) say(`  trace · ${e.stage}: ${e.message}${e.data ? ` · ${JSON.stringify(e.data).slice(0, 900)}` : ""}`);
  }
  if (r.proposalId) {
    const p = (await call("GET", `/api/sessions/${sid}/proposals/${r.proposalId}`)).body;
    say(`proposal ${p.id}: ${p.status} · tests: ${p.tests.map((t) => `${t.id}=${t.status}`).join(", ")}`);
    for (const line of p.preview.explanation) say(`  · ${line}`);
    const created = p.preview.configDiff.filter((d) => d.before === undefined).map((d) => d.path);
    if (created.length) say(`  created: ${created.join(", ")}`);
    if (approve && (p.status === "pending" || p.status === "awaiting_approval")) {
      const flownBefore = (await call("POST", `/api/sessions/${sid}/simulate`)).body;
      p.flownBefore = flownBefore;
      const a = await call("POST", `/api/sessions/${sid}/proposals/${p.id}/approve`, { reason: "evidence run", acceptViolations: true });
      say(`  approve → ${a.status} ${a.body?.status ?? JSON.stringify(a.body).slice(0, 200)}`);
      if (a.status < 300) {
        const flownAfter = (await call("POST", `/api/sessions/${sid}/simulate`)).body;
        say(`  flight before: ${kpi(flownBefore)}`);
        say(`  flight after:  ${kpi(flownAfter)}`);
        flownShown = true;
        for (const e of (flownAfter.controlLog ?? []).slice(0, 5)) say(`  control log · day ${e.day}: ${e.note ? `${e.note} — ` : ""}${e.effect}`);
      }
    }
  }
  if (approve && r.proposalId && before.mission.version !== (await state()).mission.version && !flownShown) {
    const flown = (await call("POST", `/api/sessions/${sid}/simulate`)).body;
    say(`  flight now: ${kpi(flown)}`);
    for (const e of (flown.controlLog ?? []).slice(0, 6)) say(`  control log · day ${e.day}: ${e.note ? `${e.note} — ` : ""}${e.effect}`);
  }
  const after = await state();
  say(`world: ${brief(before)} → ${brief(after)}${before.mission.version === after.mission.version ? " (shared world unchanged)" : ""}`);
}
const file = path.join("reports", "evidence", `${name}.md`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, out.join("\n") + "\n");
console.log(`\nwritten: ${file}`);
