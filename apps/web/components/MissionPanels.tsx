"use client";
/** HUD panels of the mission workspace. All state comes from the authoritative snapshot; every action goes to the server. */
import { useEffect, useRef, useState } from "react";
import { api, type Evaluation, fmt, type Presence, type Snapshot } from "@/lib/api";
import type { Collab, Patch } from "@/lib/collab";
import { BODY_RADIUS_KM } from "@/lib/scene/MissionScene";

export interface Ctx {
  sid: string;
  snap: Snapshot;
  collab: Collab;
  role: "lead" | "engineer" | "viewer";
  accountId: string;
  presence: Presence[];
  requests: any[];
  proposals: any[];
  selected: string | null;
  setSelected(id: string | null): void;
  toast(message: string, tone?: "info" | "warn" | "bad" | "ok"): void;
  setPreviewDay(day: number | null): void;
  reloadLists(): void;
}

const canEdit = (c: Ctx): boolean => c.role !== "viewer" && !c.snap.game.submitted;
const memberName = (c: Ctx, id: string): string => c.snap.session.members.find((m: any) => m.accountId === id)?.displayName ?? id;
const tone = (s: string): string => ({ pass: "ok", warn: "warn", fail: "bad", succeeded: "ok", completed: "ok", published: "ok", failed: "bad", infeasible: "bad", rejected: "bad", awaiting_approval: "warn", awaiting_clarification: "warn", feasible: "ok", feasible_with_modifications: "warn", scientifically_unverified: "warn" })[s] ?? "info";

/** Send an edit and explain the outcome, including conflicts with a teammate. */
export async function commit(c: Ctx, patches: Patch[], summary: string): Promise<boolean> {
  const r = await c.collab.edit(patches, summary);
  if (r.ok) return true;
  if (r.reason === "conflict" && r.conflict) {
    const current = Object.entries(r.conflict.current).map(([p, v]) => `${p} = ${fmt(v)}`).join(", ");
    c.toast(`${r.conflict.changedBy.join(", ")} changed this first (${current}). Your view is updated — adjust again if you still want to.`, "warn");
  } else c.toast(r.detail ?? "The change was not accepted.", r.reason === "locked" ? "warn" : "bad");
  return false;
}

// ---------- small building blocks ----------
export function Spark({ series, height = 90, zero = false, marker }: { series: { values: (number | null)[]; color: string; label: string }[]; height?: number; zero?: boolean; marker?: number | null }) {
  const W = 360;
  const n = Math.max(...series.map((s) => s.values.length), 2);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" height={height} preserveAspectRatio="none" style={{ display: "block" }}>
        {series.map((s) => {
          const v = s.values.filter((x): x is number => x !== null);
          const lo = Math.min(...v, zero ? 0 : Infinity), hi = Math.max(...v, zero ? 0 : -Infinity);
          const y = (x: number): number => height - 6 - ((x - lo) / (hi - lo || 1)) * (height - 12);
          const d = s.values.map((x, i) => (x === null ? "" : `${i === 0 ? "M" : "L"}${((i / (n - 1)) * W).toFixed(1)},${y(x).toFixed(1)}`)).join(" ");
          return (
            <g key={s.label}>
              {zero && lo < 0 && hi > 0 && <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="rgba(255,93,115,0.5)" strokeDasharray="4 4" />}
              <path d={d} fill="none" stroke={s.color} strokeWidth={1.8} vectorEffect="non-scaling-stroke" style={{ filter: `drop-shadow(0 0 4px ${s.color})` }} />
            </g>
          );
        })}
        {marker !== null && marker !== undefined && <line x1={marker * W} x2={marker * W} y1={0} y2={height} stroke="#ffd166" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="row wrap" style={{ gap: 10, marginTop: 4 }}>{series.map((s) => <span key={s.label} className="mono" style={{ fontSize: 10, color: s.color }}>● {s.label}</span>)}</div>
    </div>
  );
}

function ParamSlider({ c, label, path, value, min, max, step, unit, toPatches }: { c: Ctx; label: string; path: string; value: number; min: number; max: number; step: number; unit: string; toPatches(v: number): Patch[] }) {
  const [draft, setDraft] = useState<number | null>(null);
  const lockedBy = Object.entries(c.snap.locks).find(([p, owner]) => owner !== c.accountId && (p === path || p.startsWith(`${path}.`) || path.startsWith(`${p}.`)))?.[1];
  const shown = draft ?? value;
  const release = async (): Promise<void> => {
    if (draft === null) return;
    const v = draft;
    void c.collab.lock(path, false);
    c.collab.presence({ focus: null }, true);
    if (v !== value) await commit(c, toPatches(v), `${label} → ${fmt(v)} ${unit}`);
    setDraft(null);
  };
  return (
    <label className="field" title={lockedBy ? `${memberName(c, lockedBy)} is adjusting this` : undefined}>
      <span className="row between"><span>{label}{lockedBy && <span className="chip warn" style={{ marginLeft: 8 }}>{memberName(c, lockedBy)} editing</span>}</span><b className="mono" style={{ color: draft !== null ? "var(--amber)" : "var(--text)" }}>{fmt(shown)} {unit}</b></span>
      <input type="range" min={min} max={max} step={step} value={shown} disabled={!canEdit(c) || Boolean(lockedBy)}
        onPointerDown={() => { void c.collab.lock(path, true); c.collab.presence({ focus: path }, true); }}
        onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={release} onKeyUp={release} onBlur={release} />
    </label>
  );
}

function NumberField({ c, label, value, unit, onCommit }: { c: Ctx; label: string; value: number; unit: string; onCommit(v: number): void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const done = (): void => {
    const v = Number(text);
    if (Number.isFinite(v) && v !== value) onCommit(v);
    else setText(String(value));
  };
  return (
    <label className="field" style={{ flex: 1, minWidth: 90 }}>{label} ({unit})
      <input className="input mono" value={text} disabled={!canEdit(c)} onChange={(e) => setText(e.target.value)} onBlur={done} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} inputMode="decimal" />
    </label>
  );
}

// ---------- Objectives (left column) ----------
export function ObjectivesPanel({ c }: { c: Ctx }) {
  const ev = c.snap.evaluation;
  const fails = c.snap.checks.filter((x) => x.status !== "pass");
  return (
    <>
      <div>
        <h3 className="eyebrow" style={{ marginBottom: 8 }}>Mission objectives</h3>
        {(["science", "engineering", "programmatic"] as const).map((cat) => (
          <div key={cat} style={{ marginBottom: 10 }}>
            <div className="row between mono dim" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" }}><span>{cat}</span><span>{ev.categories[cat]!.earned.toFixed(0)} / {ev.categories[cat]!.possible}</span></div>
            {ev.objectives.filter((o) => o.category === cat).map((o) => (
              <div key={o.id} className="objective" title={o.description}>
                <div className="row between"><span style={{ fontSize: 13 }}>{o.title}</span><span className="mono dim" style={{ fontSize: 11 }}>{o.value === null ? "–" : `${fmt(o.value)}${o.unit ? ` ${o.unit}` : ""}`}</span></div>
                <div className={`bar ${o.achieved >= 1 ? "ok" : o.achieved > 0 ? "warn" : "bad"}`} style={{ margin: "5px 0 3px" }}><i style={{ width: `${Math.max(3, o.achieved * 100)}%` }} /></div>
                <div className="faint" style={{ fontSize: 11 }}>{o.feedback}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div>
        <h3 className="eyebrow" style={{ marginBottom: 8 }}>Engineering constraints</h3>
        {fails.length === 0 ? <span className="chip ok"><span className="dot" />all {c.snap.checks.length} constraints satisfied</span> : fails.map((x) => (
          <div key={x.id} className="objective"><span className={`chip ${tone(x.status)}`}>{x.status}</span> <span style={{ fontSize: 13 }}>{x.description}</span><div className="faint" style={{ fontSize: 11 }}>{x.detail}</div></div>
        ))}
      </div>
    </>
  );
}

// ---------- Design ----------
export function DesignPanel({ c }: { c: Ctx }) {
  const cfg = c.snap.mission.config;
  const R = BODY_RADIUS_KM[cfg.centralBody as keyof typeof BODY_RADIUS_KM];
  const comps: any[] = cfg.spacecraft.components;
  const [adding, setAdding] = useState<string | null>(null);
  const editable: Record<string, [string, string, string][]> = {
    solar_panel: [["areaM2", "Area", "m²"]], battery: [["capacityWh", "Capacity", "Wh"]], antenna: [["dataRateBps", "Data rate", "bit/s"], ["txPowerW", "RF power", "W"], ["dutyCycle", "Duty", "0–1"]],
    instrument: [["dutyCycle", "Duty", "0–1"]], load: [["dutyCycle", "Duty", "0–1"]],
  };
  const add = async (itemId: string): Promise<void> => {
    setAdding(itemId);
    try {
      await api("POST", `/api/sessions/${c.sid}/catalog`, { itemId });
      c.toast("Component requested: generating its 3D asset and running the tests…", "info");
      c.reloadLists();
    } catch (err) { c.toast((err as Error).message, "bad"); }
    setAdding(null);
  };
  const remove = (comp: any): void => {
    const node = cfg.scene.nodes.find((n: any) => n.componentId === comp.id);
    void commit(c, [...(node ? [{ op: "remove" as const, path: `scene.nodes.${node.id}` }] : []), { op: "remove", path: `spacecraft.components.${comp.id}` }], `Removed ${comp.name}`);
  };
  return (
    <div className="stack">
      <div className="stack">
        <h3 className="eyebrow">Orbit · flight dynamics</h3>
        <ParamSlider c={c} label="Altitude" path="orbit.semiMajorAxisKm" value={Math.round(cfg.orbit.semiMajorAxisKm - R)} min={cfg.centralBody === "earth" ? 200 : 20} max={cfg.centralBody === "earth" ? 2000 : 1000} step={5} unit="km" toPatches={(v) => [{ op: "set", path: "orbit.semiMajorAxisKm", value: R + v }]} />
        <ParamSlider c={c} label="Inclination" path="orbit.inclinationDeg" value={cfg.orbit.inclinationDeg} min={0} max={180} step={1} unit="°" toPatches={(v) => [{ op: "set", path: "orbit.inclinationDeg", value: v }]} />
        <ParamSlider c={c} label="Ascending node" path="orbit.raanDeg" value={cfg.orbit.raanDeg} min={0} max={359} step={1} unit="°" toPatches={(v) => [{ op: "set", path: "orbit.raanDeg", value: v }]} />
        <label className="field">Mission date
          <input className="input mono" type="date" value={cfg.missionTime.slice(0, 10)} disabled={!canEdit(c)} onChange={(e) => e.target.value && void commit(c, [{ op: "set", path: "missionTime", value: `${e.target.value}T00:00:00Z` }], `Mission date → ${e.target.value}`)} />
        </label>
      </div>
      <hr className="hairline" />
      <h3 className="eyebrow">Spacecraft · {comps.length} components</h3>
      {comps.map((comp) => {
        const focus = c.presence.find((p) => p.accountId !== c.accountId && p.focus === `spacecraft.components.${comp.id}`);
        return (
          <div key={comp.id} className="metric" style={{ borderColor: c.selected === comp.id ? "var(--cyan)" : focus ? focus.color : undefined, cursor: "pointer" }} onClick={() => c.setSelected(comp.id)}>
            <div className="row between">
              <span><span className="chip info">{(comp.kind ?? comp.type).replace(/_/g, " ")}</span> <b style={{ fontSize: 13 }}>{comp.name}</b></span>
              {canEdit(c) && <button className="btn sm danger" onClick={(e) => { e.stopPropagation(); remove(comp); }} title="Remove component">✕</button>}
            </div>
            <div className="mono dim" style={{ fontSize: 11, marginTop: 4 }}>{fmt(comp.massKg)} kg · ${fmt(comp.costMusd)}M{comp.powerW !== undefined ? ` · ${comp.powerW} W` : ""}{focus ? ` · ${focus.displayName} is looking` : ""}</div>
            {c.selected === comp.id && (
              <div className="row wrap" style={{ marginTop: 8 }} onClick={(e) => e.stopPropagation()}>
                {(editable[comp.type] ?? []).map(([key, label, unit]) => (
                  <NumberField key={key} c={c} label={label} unit={unit} value={comp[key]} onCommit={(v) => void commit(c, [{ op: "set", path: `spacecraft.components.${comp.id}.${key}`, value: v }], `${comp.name}: ${label.toLowerCase()} → ${fmt(v)} ${unit}`)} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      <hr className="hairline" />
      <h3 className="eyebrow">Component catalogue</h3>
      {c.snap.scenario.disciplines.map((d) => {
        const items = c.snap.scenario.catalog.filter((i: any) => i.discipline === d.id);
        if (!items.length) return null;
        return (
          <div key={d.id}>
            <div className="mono dim" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", margin: "6px 0" }}>{d.name}</div>
            {items.map((i: any) => (
              <div key={i.id} className="row between objective" title={i.description}>
                <span style={{ fontSize: 13 }}>{i.label}<div className="faint mono" style={{ fontSize: 11 }}>{fmt(i.component.massKg)} kg · ${fmt(i.component.costMusd)}M{i.component.powerW ? ` · ${i.component.powerW} W` : ""}</div></span>
                <button className="btn sm" disabled={!canEdit(c) || adding !== null} onClick={() => add(i.id)}>{adding === i.id ? <span className="spinner" /> : "Add"}</button>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---------- AI runtime builder ----------
export function AiPanel({ c }: { c: Ctx }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const send = async (t: string): Promise<void> => {
    if (!t.trim()) return;
    setBusy(true);
    try {
      await api("POST", `/api/sessions/${c.sid}/requests`, { text: t });
      setText("");
      c.reloadLists();
    } catch (err) { c.toast((err as Error).message, "bad"); }
    setBusy(false);
  };
  const decide = async (id: string, action: "approve" | "reject"): Promise<void> => {
    const reason = action === "reject" ? (window.prompt("Reason for rejecting:") ?? "") : "Approved in workspace";
    try { await api("POST", `/api/sessions/${c.sid}/proposals/${id}/${action}`, { reason }); c.reloadLists(); } catch (err) { c.toast((err as Error).message, "warn"); }
  };
  const examples = ["Set orbit altitude to 50 km", "Add a 1.5 m2 solar panel", "Compute the link budget", "Simulate the battery over 10 orbits", "Can the rover climb a 20 deg slope?", "Where is Mars?"];
  const pending = c.proposals.filter((p) => p.status === "awaiting_approval");
  return (
    <div className="stack">
      <h3 className="eyebrow">Ask the runtime builder</h3>
      <textarea className="input" placeholder="Describe a change or a question in plain language…" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && void send(text)} />
      <div className="row between"><span className="faint" style={{ fontSize: 11 }}>Ctrl+Enter to send. Changes are tested in isolation and previewed before they deploy.</span><button className="btn primary sm" disabled={busy || !text.trim()} onClick={() => send(text)}>{busy ? <span className="spinner" /> : "Send"}</button></div>
      <div className="row wrap">{examples.map((e) => <button key={e} className="btn sm ghost" onClick={() => setText(e)}>{e}</button>)}</div>

      {pending.map((p) => (
        <div key={p.id} className="metric" style={{ borderColor: "var(--amber)" }}>
          <div className="row between"><b>Preview · awaiting approval</b><span className="chip warn">{p.significance} · {p.requiredRole}</span></div>
          <div className="stack" style={{ gap: 2, margin: "8px 0", fontSize: 12 }}>{p.preview.explanation.slice(0, 9).map((l: string) => <div key={l} className="mono dim">{l}</div>)}</div>
          <div className="dim" style={{ fontSize: 12 }}>Affects: {p.preview.affectedComponents.join(", ")}</div>
          <div className="row wrap" style={{ margin: "8px 0" }}>{p.tests.map((t: any) => <span key={t.id} className={`chip ${tone(t.status)}`} title={`${t.description}: ${t.detail}`}>{t.id.replace(/^engineering\./, "")}</span>)}</div>
          {["model_judgment", "unverified"].includes(p.evidence) && <div className="chip warn" style={{ whiteSpace: "normal", borderRadius: 8 }}>Contains model-generated content. Tests cover safety and structure, not scientific correctness.</div>}
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn sm primary" disabled={c.role === "viewer"} onClick={() => decide(p.id, "approve")}>Approve &amp; deploy</button>
            <button className="btn sm danger" disabled={c.role === "viewer"} onClick={() => decide(p.id, "reject")}>Reject</button>
          </div>
        </div>
      ))}

      <h3 className="eyebrow">Requests</h3>
      {c.requests.length === 0 && <p className="dim">Nothing yet. Requests from every teammate appear here as they run.</p>}
      {c.requests.map((r) => (
        <div key={r.id} className="metric">
          <div className="row between"><span style={{ fontSize: 13 }}>{r.text}</span><span className={`chip ${tone(r.status)}`}>{r.status.replace(/_/g, " ")}</span></div>
          <div className="row wrap" style={{ margin: "6px 0" }}>
            <span className="chip">{memberName(c, r.user.id)}</span>
            {(r.feasibility?.classification ?? r.feasibility) && <span className={`chip ${tone(r.feasibility?.classification ?? r.feasibility)}`}>{String(r.feasibility?.classification ?? r.feasibility).replace(/_/g, " ")}</span>}
          </div>
          {(r.tasks ?? r.plan?.tasks ?? []).map((t: any) => (
            <div key={t.id} className={`plan-step ${t.status}`}><span className="node" /><span className="mono" style={{ fontSize: 11 }}>{t.executedBy ?? t.capabilityId}<span className="dim"> · {t.status}</span></span></div>
          ))}
          {r.error && <div className="chip bad" style={{ whiteSpace: "normal", borderRadius: 8 }}>{r.error}</div>}
          {r.status === "awaiting_clarification" && (
            <div className="row" style={{ marginTop: 6 }}>
              <input className="input" placeholder="Answer the question…" value={answers[r.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [r.id]: e.target.value })} />
              <button className="btn sm" onClick={() => void api("POST", `/api/sessions/${c.sid}/requests/${r.id}/clarify`, { answer: answers[r.id] }).then(c.reloadLists).catch((e) => c.toast(e.message, "warn"))}>Answer</button>
            </div>
          )}
          <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => void api("GET", `/api/sessions/${c.sid}/requests/${r.id}`).then(setOpen)}>Analysis, feasibility &amp; trace</button>
        </div>
      ))}
      {open && (
        <div className="modal-veil" onClick={() => setOpen(null)}>
          <div className="glass modal" onClick={(e) => e.stopPropagation()}>
            <div className="row between"><h2 style={{ fontSize: 20 }}>{open.text}</h2><button className="btn sm ghost" onClick={() => setOpen(null)}>Close</button></div>
            {open.requirement && (<>
              <h3 className="eyebrow" style={{ margin: "16px 0 6px" }}>Requirement analysis · {open.requirement.analysis.method === "llm" ? `language model (${open.requirement.analysis.modelId}) — model judgement` : "rule-based analyser — heuristic"}</h3>
              {open.requirement.operations.map((o: any) => <div key={o.id} className="objective"><span className="chip info">{o.category.replace(/_/g, " ")}</span> {o.description}{o.assumptions.length > 0 && <div className="chip warn" style={{ whiteSpace: "normal", borderRadius: 8, marginTop: 4 }}>Assumed: {o.assumptions.join("; ")}</div>}</div>)}
              {open.requirement.missingInformation.map((m: any) => <div key={m.question} className="chip warn" style={{ whiteSpace: "normal", borderRadius: 8 }}>{m.question}</div>)}
            </>)}
            {open.feasibility && (<>
              <h3 className="eyebrow" style={{ margin: "16px 0 6px" }}>Feasibility · <span className={`chip ${tone(open.feasibility.classification)}`}>{open.feasibility.classification.replace(/_/g, " ")}</span></h3>
              <p style={{ fontSize: 13 }}>{open.feasibility.summary}</p>
              <table className="data"><tbody>{open.feasibility.factors.map((f: any, i: number) => <tr key={i}><td><span className={`chip ${f.status === "ok" ? "ok" : f.status === "concern" ? "warn" : "bad"}`}>{f.status}</span></td><td className="mono">{f.factor}</td><td>{f.detail}<div className="faint">basis: {f.basis.replace(/_/g, " ")}</div></td></tr>)}</tbody></table>
            </>)}
            <h3 className="eyebrow" style={{ margin: "16px 0 6px" }}>Trace · {open.trace.length} events</h3>
            <table className="data"><tbody>{open.trace.map((e: any) => <tr key={e.seq}><td><span className="chip">{e.stage}</span></td><td>{e.message}{e.data !== undefined && <details><summary className="faint">data</summary><pre className="code">{JSON.stringify(e.data, null, 2)}</pre></details>}</td></tr>)}</tbody></table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Analysis: trade studies and mission simulation ----------
const TRADE_PARAMS = [
  { id: "altitude", label: "Orbit altitude (km)", unit: "km" },
  { id: "orbit.inclinationDeg", label: "Inclination (°)", unit: "°" },
  { id: "component", label: "Selected component parameter", unit: "" },
];
const TRADE_METRICS = [
  ["power.budget", "marginW", "Power margin W"], ["orbit.eclipse", "eclipseFraction", "Eclipse fraction"], ["science.return", "neutronFootprintKm", "Neutron footprint km"], ["science.return", "bestImagingResolutionM", "Imaging resolution m"],
  ["science.return", "totalReturnedGbPerDay", "Data Gb/day"], ["comms.link", "worstMarginDb", "Link margin dB"], ["cost.budget", "marginMusd", "Cost margin $M"], ["mass.budget", "marginKg", "Mass margin kg"],
];

export function AnalysisPanel({ c, previewDay }: { c: Ctx; previewDay: number | null }) {
  const cfg = c.snap.mission.config;
  const R = BODY_RADIUS_KM[cfg.centralBody as keyof typeof BODY_RADIUS_KM];
  const [param, setParam] = useState("altitude");
  const [range, setRange] = useState({ from: 30, to: 300, steps: 7 });
  const [metrics, setMetrics] = useState<string[]>(["power.budget.marginW", "orbit.eclipse.eclipseFraction", "science.return.neutronFootprintKm"]);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const sim = c.snap.game.simulation;
  const stale = sim && c.snap.game.simulationVersion !== c.snap.mission.version;
  const selected = cfg.spacecraft.components.find((x: any) => x.id === c.selected);
  const compKey = selected ? ({ solar_panel: "areaM2", battery: "capacityWh", antenna: "dataRateBps", instrument: "dutyCycle", load: "dutyCycle" } as Record<string, string>)[selected.type] : null;

  const run = async (): Promise<void> => {
    const values = Array.from({ length: range.steps }, (_, i) => range.from + ((range.to - range.from) * i) / Math.max(1, range.steps - 1));
    const path = param === "altitude" ? "orbit.semiMajorAxisKm" : param === "component" ? `spacecraft.components.${selected?.id}.${compKey}` : param;
    if (param === "component" && !selected) return c.toast("Select a component in the Design tab first.", "warn");
    setBusy("trade");
    try {
      const out = await api("POST", `/api/sessions/${c.sid}/trade`, { path, values: values.map((v) => (param === "altitude" ? R + v : Number(v.toPrecision(6)))), metrics: metrics.map((m) => ({ node: m.slice(0, m.lastIndexOf(".")), field: m.slice(m.lastIndexOf(".") + 1) })) });
      setResult({ ...out, shown: values, param });
    } catch (err) { c.toast((err as Error).message, "bad"); }
    setBusy(null);
  };
  const simulate = async (): Promise<void> => {
    setBusy("sim");
    try { await api("POST", `/api/sessions/${c.sid}/simulate`, {}); } catch (err) { c.toast((err as Error).message, "bad"); }
    setBusy(null);
  };

  return (
    <div className="stack">
      <h3 className="eyebrow">Trade study</h3>
      <p className="faint" style={{ fontSize: 12 }}>Sweep one parameter and see how science, power, cost and risk respond. Nothing is changed. Two studies on different parameters reach CML 3.</p>
      <select className="input" value={param} onChange={(e) => setParam(e.target.value)}>{TRADE_PARAMS.map((p) => <option key={p.id} value={p.id}>{p.id === "component" && selected ? `${selected.name}: ${compKey}` : p.label}</option>)}</select>
      <div className="row">
        {(["from", "to", "steps"] as const).map((k) => <label key={k} className="field grow">{k}<input className="input mono" type="number" value={range[k]} onChange={(e) => setRange({ ...range, [k]: Number(e.target.value) })} /></label>)}
      </div>
      <div className="row wrap">{TRADE_METRICS.map(([node, field, label]) => {
        const id = `${node}.${field}`;
        return <button key={id} className={`chip ${metrics.includes(id) ? "info" : ""}`} style={{ cursor: "pointer", background: "none" }} onClick={() => setMetrics(metrics.includes(id) ? metrics.filter((m) => m !== id) : [...metrics, id].slice(-6))}>{label}</button>;
      })}</div>
      <button className="btn" disabled={busy !== null || c.role === "viewer" || metrics.length === 0} onClick={run}>{busy === "trade" ? <span className="spinner" /> : "Run trade study"}</button>
      {result && (
        <div className="metric">
          <Spark series={Object.keys(result.rows[0]?.metrics ?? {}).map((k, i) => ({ label: k.split(".").pop()!, color: ["#4cc9f0", "#ffd166", "#3ddc97", "#b388ff", "#ff8c42", "#f72585"][i % 6]!, values: result.rows.map((r: any) => (typeof r.metrics[k] === "number" ? r.metrics[k] : null)) }))} />
          <table className="data" style={{ marginTop: 8 }}>
            <thead><tr><th>{result.param === "altitude" ? "altitude km" : "value"}</th>{Object.keys(result.rows[0]?.metrics ?? {}).map((k) => <th key={k}>{k.split(".").pop()}</th>)}<th>constraints</th></tr></thead>
            <tbody>{result.rows.map((r: any, i: number) => (
              <tr key={i}><td className="mono">{fmt(result.shown[i])}</td>{Object.values(r.metrics).map((v, j) => <td key={j} className="mono">{fmt(v)}</td>)}
                <td>{!r.valid ? <span className="chip bad">invalid</span> : r.failingChecks.length ? <span className="chip bad" title={r.failingChecks.join(", ")}>{r.failingChecks.length} violated</span> : <span className="chip ok">ok</span>}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <div className="dim mono" style={{ fontSize: 11 }}>{c.snap.game.tradeStudies.length} trade stud{c.snap.game.tradeStudies.length === 1 ? "y" : "ies"} recorded</div>

      <hr className="hairline" />
      <h3 className="eyebrow">Mission simulation</h3>
      <p className="faint" style={{ fontSize: 12 }}>Flies the design day by day through the mission: eclipse season, array degradation, battery reserve, Earth range, data stored and returned.</p>
      <button className="btn" disabled={busy !== null || c.role === "viewer"} onClick={simulate}>{busy === "sim" ? <span className="spinner" /> : sim ? "Re-run simulation" : "Run mission simulation"}</button>
      {sim && (
        <div className="metric" style={{ opacity: stale ? 0.6 : 1 }}>
          {stale && <div className="chip warn" style={{ marginBottom: 6 }}>The design changed since this run (v{c.snap.game.simulationVersion}). Re-run to score it.</div>}
          <div className="row wrap" style={{ gap: 14, marginBottom: 8 }}>
            {[["Data returned", `${fmt(sim.kpis.totalDataReturnedGb)} Gb`], ["Data lost", `${fmt(sim.kpis.totalDataLostGb)} Gb`], ["Negative-power days", String(sim.kpis.daysPowerNegative)], ["Worst margin", `${fmt(sim.kpis.minPowerMarginW)} W`], ["Max DoD", `${(sim.kpis.maxDepthOfDischarge * 100).toFixed(0)}%`], ["Min link", sim.kpis.minLinkMarginDb === null ? "–" : `${fmt(sim.kpis.minLinkMarginDb)} dB`]].map(([k, v]) => <div key={k}><div className="k mono faint" style={{ fontSize: 10 }}>{k}</div><b className="mono">{v}</b></div>)}
          </div>
          <Spark zero marker={previewDay !== null ? previewDay / sim.days : null} series={[{ label: "power margin W", color: "#ffd166", values: sim.timeline.map((t: any) => t.marginW) }, { label: "beta °", color: "#4cc9f0", values: sim.timeline.map((t: any) => t.betaDeg) }, { label: "stored Gb", color: "#b388ff", values: sim.timeline.map((t: any) => t.storageGb) }]} />
          <div className="stack" style={{ gap: 4, marginTop: 8 }}>{sim.events.slice(0, 8).map((e: any, i: number) => (
            <div key={i} className="row" style={{ alignItems: "flex-start", cursor: "pointer" }} onClick={() => c.setPreviewDay(e.day)}><span className={`chip ${e.severity === "critical" ? "bad" : e.severity === "warn" ? "warn" : "info"}`}>day {e.day}</span><span style={{ fontSize: 12 }}>{e.message}</span></div>
          ))}</div>
        </div>
      )}
    </div>
  );
}

// ---------- Review: maturity, research notes, phase, submission ----------
export function ReviewPanel({ c, onSubmitted }: { c: Ctx; onSubmitted(e: Evaluation, extra?: any): void }) {
  const m = c.snap.maturity;
  const [note, setNote] = useState({ kind: "mission_problem", summary: "", mitigation: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [aiReview, setAiReview] = useState<string | null>(null);
  const act = async (name: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(name);
    try { await fn(); } catch (err) { c.toast((err as Error).message, "warn"); }
    setBusy(null);
  };
  const lead = c.role === "lead";
  return (
    <div className="stack">
      <h3 className="eyebrow">Concept maturity · CML {m.level} {m.levelName}</h3>
      {[1, 2, 3, 4, 5].map((level) => (
        <div key={level} className="metric" style={{ borderColor: m.level >= level ? "rgba(61,220,151,0.45)" : undefined }}>
          <div className="row between"><b className="mono" style={{ color: m.level >= level ? "var(--green)" : "var(--dim)" }}>CML {level}</b><span className={`chip ${m.level >= level ? "ok" : ""}`}>{m.level >= level ? "reached" : "open"}</span></div>
          {m.criteria.filter((x) => x.level === level).map((x) => <div key={x.id} style={{ fontSize: 12, marginTop: 4 }}><span style={{ color: x.met ? "var(--green)" : "var(--red)" }}>{x.met ? "✓" : "○"}</span> {x.description}<div className="faint" style={{ fontSize: 11, marginLeft: 16 }}>{x.evidence}</div></div>)}
        </div>
      ))}
      <p className="faint" style={{ fontSize: 11 }}>{m.basis}</p>
      <hr className="hairline" />
      <h3 className="eyebrow">Research record</h3>
      <select className="input" value={note.kind} onChange={(e) => setNote({ ...note, kind: e.target.value })}>
        <option value="mission_problem">Risk / mission problem (with mitigation)</option><option value="hypothesis">Hypothesis</option><option value="scientific_evidence">Evidence / reference</option><option value="improvement">Improvement idea</option>
      </select>
      <input className="input" placeholder="Summary" value={note.summary} onChange={(e) => setNote({ ...note, summary: e.target.value })} />
      {note.kind === "mission_problem" && <input className="input" placeholder="Mitigation" value={note.mitigation} onChange={(e) => setNote({ ...note, mitigation: e.target.value })} />}
      <button className="btn sm" disabled={!note.summary.trim() || c.role === "viewer"} onClick={() => act("note", async () => { await api("POST", `/api/sessions/${c.sid}/notes`, note); setNote({ ...note, summary: "", mitigation: "" }); c.toast("Recorded in the research record.", "ok"); })}>Record</button>
      <div className="dim mono" style={{ fontSize: 11 }}>{c.snap.game.risks} risk(s) with mitigation · {c.snap.game.reviews} review(s) held</div>
      <hr className="hairline" />
      <h3 className="eyebrow">Mission lead</h3>
      {!lead && <p className="dim" style={{ fontSize: 12 }}>Reviews, phase gates and submission belong to the mission lead.</p>}
      <div className="row wrap">
        <button className="btn sm" disabled={!lead || busy !== null} onClick={() => act("review", async () => { const r = await api("POST", `/api/sessions/${c.sid}/review`, {}); setAiReview(r.aiReview); c.toast(`Concept review recorded: score ${r.evaluation.score}, CML ${r.maturity.level}.`, "ok"); })}>Hold concept review</button>
        <button className="btn sm" disabled={!lead || busy !== null || Boolean(c.snap.game.submitted)} onClick={() => act("phase", async () => { await api("POST", `/api/sessions/${c.sid}/phase`, {}); })}>Advance phase</button>
        <button className="btn sm primary" disabled={!lead || busy !== null || Boolean(c.snap.game.submitted)} onClick={() => window.confirm("Submit this mission? The design is frozen and scored.") && act("submit", async () => { const r = await api("POST", `/api/sessions/${c.sid}/submit`, {}); onSubmitted(r.evaluation, r.submission); })}>Submit mission</button>
      </div>
      {aiReview && <div className="metric"><span className="chip warn">AI review-board critique · model judgement, not scored</span><p style={{ fontSize: 13, marginTop: 6 }}>{aiReview}</p></div>}
    </div>
  );
}

// ---------- Log: crew, versions, audit ----------
export function LogPanel({ c }: { c: Ctx }) {
  const [audit, setAudit] = useState<any[] | null>(null);
  const lead = c.role === "lead";
  useEffect(() => { if (lead) void api("GET", `/api/audit?session=${c.sid}&limit=40`).then(setAudit).catch(() => undefined); }, [lead, c.sid, c.snap.mission.version]);
  return (
    <div className="stack">
      <h3 className="eyebrow">Crew</h3>
      {c.snap.session.members.map((m: any) => {
        const online = c.presence.filter((p) => p.accountId === m.accountId);
        return (
          <div key={m.accountId} className="row between objective">
            <span><span className="dot" style={{ display: "inline-block", marginRight: 8, color: online[0]?.color ?? "var(--faint)" }} /><b>{m.displayName}</b>{m.accountId === c.accountId ? " (you)" : ""}<div className="faint" style={{ fontSize: 11, marginLeft: 16 }}>{m.discipline?.replace(/_/g, " ") ?? "no seat"}{online.length ? ` · ${online.map((p) => (p.mode === "xr" ? "in headset" : "desktop")).join(", ")}` : " · offline"}</div></span>
            {lead && m.accountId !== c.accountId ? (
              <select className="input" style={{ width: 110 }} value={m.role} onChange={(e) => void api("POST", `/api/sessions/${c.sid}/members/${m.accountId}`, { role: e.target.value }).catch((err) => c.toast(err.message, "warn"))}><option value="viewer">viewer</option><option value="engineer">engineer</option><option value="lead">lead</option></select>
            ) : <span className="chip">{m.role}</span>}
          </div>
        );
      })}
      {c.snap.inviteCode && <div className="metric"><div className="k">Invite code</div><div className="v">{c.snap.inviteCode}</div></div>}
      <div className="dim" style={{ fontSize: 12 }}>Change policy: <b>{c.snap.session.policy === "open" ? "open design" : "lead review"}</b> · {c.snap.session.complication.title}: {c.snap.session.complication.description}</div>
      <hr className="hairline" />
      <h3 className="eyebrow">Versions</h3>
      {[...c.snap.versions].reverse().slice(0, 25).map((v: any) => (
        <div key={v.version} className="row between objective">
          <span><b className="mono">v{v.version}</b> <span style={{ fontSize: 12 }}>{v.note}</span><div className="faint" style={{ fontSize: 11 }}>{memberName(c, v.publishedBy)} · {new Date(v.publishedAt).toLocaleTimeString()} · recalculated {v.recalculated.length}</div></span>
          {lead && v.version !== c.snap.mission.version && !c.snap.game.submitted && <button className="btn sm ghost" onClick={() => { const reason = window.prompt(`Roll back to v${v.version}? Reason:`); if (reason !== null) void api("POST", `/api/sessions/${c.sid}/rollback`, { version: v.version, reason }).catch((e) => c.toast(e.message, "warn")); }}>Restore</button>}
        </div>
      ))}
      {lead && audit && (<>
        <hr className="hairline" />
        <h3 className="eyebrow">Audit trail</h3>
        {audit.map((e) => <div key={e.seq} className="mono faint" style={{ fontSize: 11 }}><span style={{ color: e.outcome === "ok" ? "var(--dim)" : "var(--red)" }}>#{e.seq} {e.action}</span> · {memberName(c, e.actor)} · {new Date(e.at).toLocaleTimeString()}</div>)}
      </>)}
    </div>
  );
}

// ---------- Mission evaluation dashboard ----------
export function EvaluationDashboard({ evaluation, title, submission, onClose }: { evaluation: Evaluation; title: string; submission?: any; onClose(): void }) {
  const ringRef = useRef<SVGCircleElement>(null);
  useEffect(() => { requestAnimationFrame(() => ringRef.current?.setAttribute("stroke-dashoffset", String(377 * (1 - evaluation.score / 100)))); }, [evaluation.score]);
  return (
    <div className="modal-veil" onClick={onClose}>
      <div className="glass modal" onClick={(e) => e.stopPropagation()}>
        <div className="row between"><div><div className="eyebrow">{submission ? "Mission submitted" : "Mission evaluation"}</div><h2 style={{ fontSize: 26, marginTop: 6 }}>{title}</h2></div><button className="btn ghost sm" onClick={onClose}>Close</button></div>
        <div className="grid" style={{ gridTemplateColumns: "220px 1fr", gap: 24, marginTop: 20, alignItems: "center" }}>
          <div className="center" style={{ position: "relative" }}>
            <svg width="190" height="190" viewBox="0 0 140 140">
              <circle cx="70" cy="70" r="60" fill="none" stroke="rgba(120,160,220,0.15)" strokeWidth="9" />
              <circle ref={ringRef} cx="70" cy="70" r="60" fill="none" stroke="url(#g)" strokeWidth="9" strokeLinecap="round" strokeDasharray="377" strokeDashoffset="377" transform="rotate(-90 70 70)" style={{ transition: "stroke-dashoffset 1.6s cubic-bezier(0.22,1,0.36,1)" }} />
              <defs><linearGradient id="g"><stop offset="0" stopColor="#4c7dff" /><stop offset="1" stopColor="#4cc9f0" /></linearGradient></defs>
            </svg>
            <div style={{ position: "absolute", textAlign: "center" }}><div className="mono" style={{ fontSize: 34, fontWeight: 700 }}>{evaluation.score.toFixed(1)}</div><div className="dim mono" style={{ fontSize: 11 }}>of 100</div></div>
          </div>
          <div>
            <div className="row" style={{ alignItems: "baseline", gap: 18 }}><span className="grade">{evaluation.grade}</span><div className="dim">Objectives {evaluation.objectivesScore.toFixed(1)} / 85 · Process {evaluation.rigorScore} / 15{evaluation.penalties.length ? ` · Penalties −${evaluation.penalties.reduce((s, p) => s + p.points, 0)}` : ""}</div></div>
            {Object.entries(evaluation.categories).map(([k, v]) => (
              <div key={k} style={{ marginTop: 10 }}><div className="row between mono dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em" }}><span>{k}</span><span>{v.earned.toFixed(1)} / {v.possible}</span></div><div className="bar"><i style={{ width: `${(v.earned / v.possible) * 100}%` }} /></div></div>
            ))}
            {evaluation.rigor.map((r) => <div key={r.item} className="dim" style={{ fontSize: 12, marginTop: 8 }}><b>{r.item}</b> {r.earned}/{r.possible} — {r.detail}</div>)}
            {evaluation.penalties.map((p) => <div key={p.reason} className="chip bad" style={{ whiteSpace: "normal", borderRadius: 8, marginTop: 8 }}>−{p.points}: {p.reason}</div>)}
          </div>
        </div>
        <div className="grid cols-2" style={{ marginTop: 20 }}>
          <div className="metric"><div className="k">What worked</div>{evaluation.strengths.length ? evaluation.strengths.map((s) => <p key={s} style={{ fontSize: 13, marginTop: 6 }}>✓ {s}</p>) : <p className="dim" style={{ marginTop: 6 }}>No objective fully met yet.</p>}</div>
          <div className="metric"><div className="k">Where the points are</div>{evaluation.improvements.map((s) => <p key={s} style={{ fontSize: 13, marginTop: 6 }}>→ {s}</p>)}</div>
        </div>
        <table className="data" style={{ marginTop: 16 }}>
          <thead><tr><th>Objective</th><th>Result</th><th>Target</th><th>Credit</th><th>Points</th></tr></thead>
          <tbody>{evaluation.objectives.map((o) => <tr key={o.id}><td><b>{o.title}</b><div className="faint">{o.feedback}</div></td><td className="mono">{o.value === null ? "–" : fmt(o.value)} {o.unit}</td><td className="mono">{fmt(o.target)} {o.unit}</td><td style={{ width: 120 }}><div className={`bar ${o.achieved >= 1 ? "ok" : o.achieved > 0 ? "warn" : "bad"}`}><i style={{ width: `${o.achieved * 100}%` }} /></div></td><td className="mono">{o.points.toFixed(1)} / {o.weight}</td></tr>)}</tbody>
        </table>
        <p className="faint" style={{ fontSize: 11, marginTop: 12 }}>{evaluation.basis}</p>
        {submission && <div className="row" style={{ marginTop: 16 }}><a className="btn primary" href="/leaderboard">View leaderboard</a><span className="faint mono" style={{ fontSize: 11 }}>config {submission.configHash.slice(0, 16)}… · v{submission.missionVersion}</span></div>}
      </div>
    </div>
  );
}
