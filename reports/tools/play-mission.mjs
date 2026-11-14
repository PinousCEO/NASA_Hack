// Plays a mission through the server's API from a fresh start to a submitted result, without a
// language model: the crew defines the mission, adds parts (which arrive unconnected), connects them,
// installs control logic, picks a launch vehicle, flies and submits. Used to show that missions with
// different conditions each generate, play and evaluate.
// Usage: node reports/tools/play-mission.mjs <scenario-id> [seed]
import fs from "node:fs";
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const scenario = process.argv[2] ?? "leo-cubesat";
const seed = Number(process.argv[3] ?? 9);
const out = [];
const say = (s = "") => { console.log(s); out.push(s); };
const check = (name, ok, detail = "") => { say(`${ok ? "PASS" : "FAIL"} · ${name}${detail ? ` — ${String(detail).replace(/\s+/g, " ").slice(0, 360)}` : ""}`); return ok; };
let cookie = "";
const api = async (method, route, body) => {
  const res = await fetch(BASE + route, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const creds = { username: "playpilot", password: "play-mission-check-password-1", displayName: "Play Pilot" };
if ((await api("POST", "/api/auth/register", creds)).status >= 300) await api("POST", "/api/auth/login", creds);
say(`# Play-through: ${scenario} (seed ${seed}) — ${new Date().toISOString()}`);
const created = await api("POST", "/api/sessions", { scenarioId: scenario, difficulty: "engineer", seed, name: `Play ${scenario}` });
const sid = created.body.session.id;
const snap = async () => (await api("GET", `/api/sessions/${sid}`)).body;
let s = await snap();
const cfg = s.mission.config;
say(`world: ${cfg.centralBody} · ${cfg.spacecraft.name} · bus ${cfg.spacecraft.busDryMassKg} kg · limit ${cfg.meta.massLimitKg} kg · budget $${cfg.meta.budgetMusd}M · ${cfg.meta.missionDurationDays} days · rover: ${cfg.rover ? "yes" : "no"} · ground station ${cfg.groundStation.antennaGainDbi} dBi`);
say(`problem: ${s.session.brief?.title ?? s.scenario.title} — ${s.session.kit?.crux ?? ""}`);
say(`kit: ${s.session.kit?.levers.length} controls (${s.session.kit?.levers.map((l) => l.key).join(", ")}), ${s.session.kit?.toolbox.length} parts, ${s.session.kit?.roles.length} roles`);
check("the mission arrives built: parts wired, checks computed, goals set, a kit of controls and parts", s.mission.derived["systems.wiring"].value.wired && s.mission.derived["systems.wiring"].value.unconnected.length === 0 && s.evaluation.objectives.length >= 8 && s.session.kit.levers.length >= 2, `${cfg.systems.links.length} lines, ${s.checks.length} checks, ${s.evaluation.objectives.length} goals, outcome: ${s.evaluation.outcome.headline}`);

// Define the mission.
const science = s.scenario.objectives.filter((o) => o.category === "science");
const defined = await api("POST", `/api/sessions/${sid}/define`, { statement: `Fly ${s.scenario.title} and return the science it is for, within the limits.`, primary: science[0].id, stretch: [] });
check("the crew defines its mission", defined.status === 200);

// Add every instrument kind the science goals ask for, plus an attitude unit and a computer if offered.
const wanted = s.scenario.objectives.filter((o) => o.metric.type === "instrument").map((o) => o.metric.kind);
const picks = [];
for (const kind of wanted) { const item = s.scenario.catalog.find((i) => i.component.type === "instrument" && i.component.kind === kind); if (item) picks.push(item); }
for (const type of ["adcs", "computer"]) { const item = s.scenario.catalog.find((i) => i.component.type === type); if (item) picks.push(item); }
const before = s;
for (const item of picks) {
  const r = await api("POST", `/api/sessions/${sid}/catalog`, { itemId: item.id, wait: true });
  if (r.body?.status === "awaiting_approval") await api("POST", `/api/sessions/${sid}/proposals/${r.body.proposalId}/approve`, { reason: "play-through", acceptViolations: true });
}
s = await snap();
const loose = s.mission.derived["systems.wiring"].value.unconnected;
check("parts added from the catalogue are on board but not connected", s.mission.config.spacecraft.components.length === before.mission.config.spacecraft.components.length + picks.length && loose.length >= wanted.length, `${picks.map((p) => p.id).join(", ")} · not connected: ${loose.length}`);
for (const p of s.mission.derived["systems.wiring"].value.parts.filter((x) => x.notes.length)) {
  const r = await api("POST", `/api/sessions/${sid}/connect`, { componentId: p.id, wait: true });
  if (r.body?.status === "awaiting_approval") await api("POST", `/api/sessions/${sid}/proposals/${r.body.proposalId}/approve`, { reason: "play-through", acceptViolations: true });
}
s = await snap();
const d = (x, node, field) => x.mission.derived[node].value[field];
check("connecting them changes mass, power, data and cost together", s.mission.derived["systems.wiring"].value.unconnected.length === 0 && d(s, "mass.budget", "totalMassKg") > d(before, "mass.budget", "totalMassKg") && d(s, "power.budget", "averageLoadW") > d(before, "power.budget", "averageLoadW") && d(s, "data.budget", "generatedGbPerDay") > d(before, "data.budget", "generatedGbPerDay") && d(s, "cost.budget", "totalCostMusd") > d(before, "cost.budget", "totalCostMusd"),
  `mass ${d(before, "mass.budget", "totalMassKg").toFixed(2)}→${d(s, "mass.budget", "totalMassKg").toFixed(2)} kg · load ${d(before, "power.budget", "averageLoadW").toFixed(1)}→${d(s, "power.budget", "averageLoadW").toFixed(1)} W · data ${d(before, "data.budget", "generatedGbPerDay").toFixed(2)}→${d(s, "data.budget", "generatedGbPerDay").toFixed(2)} Gb/day · cost $${d(before, "cost.budget", "totalCostMusd").toFixed(1)}→$${d(s, "cost.budget", "totalCostMusd").toFixed(1)}M · schedule ${d(before, "schedule.budget", "developmentMonths").toFixed(1)}→${d(s, "schedule.budget", "developmentMonths").toFixed(1)} months`);

// Control logic, written by hand here (the AI writes the same structure from a sentence).
const edit = (patches, summary) => api("POST", `/api/sessions/${sid}/edit`, { baseVersion: s.mission.version, patches, summary });
const ctl = { id: "ctl-save", name: "Power and storage manager", description: "Sheds instrument time when power is short; transmits longer when storage fills.", hostId: "bus", memory: { saving: 0 }, rules: [
  { when: "power.marginW < 0 or battery.soc < 0.5", do: [{ target: "mem:saving", value: "1" }], note: "power is short" },
  { when: "power.marginW >= 0 and battery.soc > 0.9", do: [{ target: "mem:saving", value: "0" }], note: "power is back" },
  { when: "mem.saving == 1", do: [{ target: "instruments", value: "nominal * 0.3" }], note: "instruments at 30%" },
  { when: "storage.fill > 0.5 and mem.saving == 0", do: [{ target: "antennas", value: "min(1, nominal * 1.5)" }], note: "storage filling: transmit longer" },
], downlinkPriority: s.mission.config.spacecraft.components.filter((c) => c.type === "instrument").map((c) => c.id).slice(0, 1), origin: { kind: "user_authored" } };
const flownBefore = (await api("POST", `/api/sessions/${sid}/simulate`)).body;
const installed = await edit([{ op: "append", path: "systems.controllers", value: ctl }], "Install control logic");
s = await snap();
check("control logic is installed in the shared design", installed.status === 200 && s.mission.config.systems.controllers.length === 1, JSON.stringify(installed.body).slice(0, 160));
const bad = await edit([{ op: "append", path: "systems.controllers", value: { ...ctl, id: "ctl-bad", rules: [{ when: "fuel.level < 1", do: [{ target: "instruments", value: "0" }] }] } }], "bad controller");
check("control logic that reads a signal the model does not have is refused", bad.status === 422 && /not a signal it can read/.test(JSON.stringify(bad.body)), bad.body?.detail);

// Launch vehicle: the cheapest that can lift it.
const launch = s.mission.derived["launch.vehicle"].value;
const able = launch.options.filter((o) => o.capacityKg >= launch.launchMassKg).sort((a, b) => a.costMusd - b.costMusd)[0] ?? launch.options[launch.options.length - 1];
await edit([{ op: "set", path: "meta.launchVehicleId", value: able.id }], `Launch vehicle → ${able.name}`);
s = await snap();
check("a launch vehicle is chosen from the options this mission offers", s.mission.derived["launch.vehicle"].value.selectedId === able.id, `${able.name}: ${able.capacityKg.toFixed(0)} kg for $${able.costMusd.toFixed(1)}M (options: ${launch.options.map((o) => o.name).join(", ")})`);

// Fly.
const flown = (await api("POST", `/api/sessions/${sid}/simulate`)).body;
const k = (f) => `returned ${f.kpis.totalDataReturnedGb.toFixed(1)} Gb, lost ${f.kpis.totalDataLostGb.toFixed(1)} Gb, negative-power days ${f.kpis.daysPowerNegative}, control-active days ${f.kpis.daysControlActive}`;
check("the flight runs with this mission's own in-flight events", flown.days > 0 && Array.isArray(flown.flightEvents), `${flown.days} days · events: ${flown.flightEvents.map((e) => `${e.title} (day ${e.day})`).join(", ") || "none"}`);
say(`flight before control logic: ${k(flownBefore)}`);
say(`flight with control logic:   ${k(flown)}`);
for (const e of flown.controlLog.slice(0, 4)) say(`  control log · day ${e.day}: ${e.note ? `${e.note} — ` : ""}${e.effect}`);
for (const r of flown.returnedByInstrument) say(`  ${r.name}: returned ${r.returnedGb.toFixed(1)} Gb, lost ${r.lostGb.toFixed(1)} Gb`);
s = await snap();
say(`outcome: ${s.evaluation.outcome.headline}`);
for (const c of s.evaluation.outcome.conditions) say(`  ${c.met === null ? "–" : c.met ? "✓" : "✗"} ${c.title}: ${c.evidence}`);

// Submit (walking the phases the game asks for).
let submitted = await api("POST", `/api/sessions/${sid}/submit`);
for (let i = 0; i < 6 && submitted.status !== 200; i++) {
  const reason = submitted.body?.error ?? "";
  say(`  submit not yet accepted: ${reason}`);
  if (/review/i.test(reason)) await api("POST", `/api/sessions/${sid}/review`);
  else if (/phase|maturity|CML|trade/i.test(reason)) { await api("POST", `/api/sessions/${sid}/phase`); await api("POST", `/api/sessions/${sid}/review`); }
  else break;
  submitted = await api("POST", `/api/sessions/${sid}/submit`);
}
if (check("the mission is submitted and evaluated", submitted.status === 200, submitted.status === 200 ? `score ${submitted.body.evaluation.score.toFixed(1)} (${submitted.body.evaluation.grade}) · outcome: ${submitted.body.evaluation.outcome.verdict} · rank ${submitted.body.standing?.rank}/${submitted.body.standing?.of}` : JSON.stringify(submitted.body).slice(0, 200))) {
  for (const c of submitted.body.evaluation.outcome.conditions) say(`  ${c.met === null ? "–" : c.met ? "✓" : "✗"} ${c.title}: ${c.evidence}`);
}
fs.mkdirSync("reports/evidence", { recursive: true });
fs.writeFileSync(`reports/evidence/play-${scenario}.md`, out.join("\n") + "\n");
process.exit(out.some((l) => l.startsWith("FAIL")) ? 1 : 0);
