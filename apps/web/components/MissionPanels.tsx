"use client";
/** HUD panels of the mission workspace. All state comes from the authoritative snapshot; every action goes to the server. */
import { useEffect, useRef, useState } from "react";
import { api, type Evaluation, fmt, type Presence, type Snapshot } from "@/lib/api";
import { bus } from "@/lib/bus";
import type { Collab, Patch } from "@/lib/collab";
import { BODY_RADIUS_KM } from "@/lib/scene/MissionScene";
import { Debrief, LaunchPicker, OrbitPresets, SiteSurvey, TrajectoryPanel } from "./MissionExtras";
import { CharterCard, FlightEvents, SandboxLimits } from "./MissionGame";
import { MissionGuide } from "./MissionGuide";
import { Modal } from "./Modal";
import { ProblemPanel } from "./MissionProblem";

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

export function ParamSlider({ c, label, path, value, min, max, step, unit, toPatches }: { c: Ctx; label: string; path: string; value: number; min: number; max: number; step: number; unit: string; toPatches(v: number): Patch[] }) {
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
      <input type="range" aria-label={label} title={lockedBy ? `${memberName(c, lockedBy)} is adjusting this right now` : !canEdit(c) ? (c.snap.game.submitted ? "The mission has been submitted; the design is frozen" : "Viewers can look but not change the design") : `${label} (${unit})`} min={min} max={max} step={step} value={shown} disabled={!canEdit(c) || Boolean(lockedBy)}
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
export function ObjectivesPanel({ c, onDefine, openTab }: { c: Ctx; onDefine(): void; openTab(tab: string): void }) {
  const ev = c.snap.evaluation;
  const fails = c.snap.checks.filter((x) => x.status !== "pass");
  return (
    <>
      <ProblemPanel c={c} onDefine={onDefine} />
      {c.snap.game.charter && <CharterCard c={c} onEdit={onDefine} />}
      <details className="fold" open>
        <summary>Goals · {ev.objectives.filter((o) => o.achieved >= 1).length} of {ev.objectives.length} met</summary>
        {(["science", "engineering", "programmatic"] as const).map((cat) => (
          <div key={cat} style={{ marginBottom: 8 }}>
            <div className="row between mono dim" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" }}><span>{cat}</span><span>{ev.categories[cat]!.earned.toFixed(0)} / {+ev.categories[cat]!.possible.toFixed(1)}</span></div>
            {ev.objectives.filter((o) => o.category === cat).map((o) => (
              <div key={o.id} className="objective" title={o.description} tabIndex={0}>
                <div className="row between"><span style={{ fontSize: 13 }}>{o.title}{(o as any).primary && <span className="chip info" style={{ marginLeft: 6 }}>primary ×1.5</span>}{(o as any).stretch && <span className="chip" style={{ marginLeft: 6 }}>stretch</span>}</span><span className="mono dim" style={{ fontSize: 11 }}>{o.value === null ? "–" : `${fmt(o.value)}${o.unit ? ` ${o.unit}` : ""}`}</span></div>
                <div className={`bar ${o.achieved >= 1 ? "ok" : o.achieved > 0 ? "warn" : "bad"}`} style={{ margin: "5px 0 3px" }}><i style={{ width: `${Math.max(3, o.achieved * 100)}%` }} /></div>
                <div className="faint" style={{ fontSize: 11 }}>{o.description} {o.feedback}</div>
              </div>
            ))}
          </div>
        ))}
      </details>
      {fails.length > 0 && (
        <details className="fold" open>
          <summary>Limits · {fails.filter((x) => x.status === "fail").length} broken</summary>
          {fails.map((x) => <div key={x.id} className="objective"><span className={`chip ${tone(x.status)}`}>{x.status}</span> <span style={{ fontSize: 13 }}>{x.description}</span><div className="faint" style={{ fontSize: 11, display: "block" }}>{x.detail}</div></div>)}
        </details>
      )}
      <details className="fold">
        <summary>Mission process · NASA design steps</summary>
        <MissionGuide c={c} onDefine={onDefine} openTab={openTab} />
      </details>
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
      <SandboxLimits c={c} />
      {c.snap.session.mode === "sandbox" && <hr className="hairline" />}
      <div className="stack">
        <h3 className="eyebrow">Orbit · flight dynamics</h3>
        <OrbitPresets c={c} radiusKm={R} />
        <ParamSlider c={c} label="Altitude" path="orbit.semiMajorAxisKm" value={Math.round(cfg.orbit.semiMajorAxisKm - R)} min={cfg.centralBody === "earth" ? 200 : 20} max={cfg.centralBody === "earth" ? 2000 : 1000} step={5} unit="km" toPatches={(v) => [{ op: "set", path: "orbit.semiMajorAxisKm", value: R + v }]} />
        <ParamSlider c={c} label="Inclination" path="orbit.inclinationDeg" value={cfg.orbit.inclinationDeg} min={0} max={180} step={1} unit="°" toPatches={(v) => [{ op: "set", path: "orbit.inclinationDeg", value: v }]} />
        <ParamSlider c={c} label="Ascending node" path="orbit.raanDeg" value={cfg.orbit.raanDeg} min={0} max={359} step={1} unit="°" toPatches={(v) => [{ op: "set", path: "orbit.raanDeg", value: v }]} />
        <label className="field">Mission date
          <input className="input mono" type="date" value={cfg.missionTime.slice(0, 10)} disabled={!canEdit(c)} onChange={(e) => e.target.value && void commit(c, [{ op: "set", path: "missionTime", value: `${e.target.value}T00:00:00Z` }], `Mission date → ${e.target.value}`)} />
        </label>
      </div>
      <hr className="hairline" />
      <LaunchPicker c={c} />
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
            <div className="mono dim" style={{ fontSize: 11, marginTop: 4 }}>{fmt(comp.massKg)} kg · ${fmt(comp.costMusd)}M{comp.powerW !== undefined ? ` · ${comp.powerW} W` : ""}{comp.type === "adcs" ? ` · holds ${comp.stabilityArcsec}″` : ""}{comp.type === "computer" ? ` · ${comp.compressionRatio}:1 · +${comp.storageGb} Gb` : ""}{focus ? ` · ${focus.displayName} is looking` : ""}</div>
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

/** What the AI found, in words, with the results it rests on. */
export function AnswerBlock({ answer }: { answer: any }) {
  const sources = [...new Set((answer.facts as any[]).map((f) => f.source))];
  return (
    <div className="answer">
      <div className="k">Answer</div>
      <p>{answer.text}</p>
      {answer.facts.length > 0 && (
        <details>
          <summary>The numbers behind it · {answer.facts.length}</summary>
          <table className="data"><tbody>{answer.facts.map((f: any, i: number) => <tr key={i}><td>{f.label}</td><td className="mono">{f.value}</td></tr>)}</tbody></table>
        </details>
      )}
      <div className="faint" style={{ fontSize: 10.5, marginTop: 6 }}>{sources.length > 0 ? `Numbers from ${sources.join(", ")}. ` : ""}{answer.wording === "language_model" ? `Worded by ${answer.modelId} — check the numbers, not the phrasing.` : "Assembled from the results."}</div>
    </div>
  );
}

// ---------- My AI: a conversation ----------
const VERDICT: Record<string, [string, string]> = {
  answer: ["Answer", "info"], explained: ["Explained", "info"], conditional: ["Could work, if…", "warn"], refuted: ["Does not hold", "bad"], outside_model: ["Outside what the models cover", "warn"], built: ["Built · tested", "ok"], built_breaks_limit: ["Built · breaks a limit", "warn"], cannot: ["Not possible", "bad"], needs_input: ["Needs your answer", "warn"],
};
const WORKING = ["queued", "analyzing", "planning", "executing"];

/**
 * Each crew member talks to their own AI. Ask it how something works, or think aloud — "if we
 * had X, couldn't we solve Y?". When the idea holds up it builds the thing in a test copy,
 * measures what changes and says so; when it does not, it says why.
 */
export function AiPanel({ c }: { c: Ctx }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [whose, setWhose] = useState<"mine" | "crew">("mine");
  const [view, setView] = useState<"all" | "built" | "failed">("all");
  const input = useRef<HTMLTextAreaElement>(null);
  // Another panel can hand a question over (a broken limit, a part that was clicked).
  useEffect(() => bus.listen("ask", (t) => { setText(String(t)); setWhose("mine"); setTimeout(() => input.current?.focus(), 60); }), []);
  const send = async (t: string): Promise<void> => {
    if (!t.trim()) return;
    setBusy(true);
    try {
      await api("POST", `/api/sessions/${c.sid}/requests`, { text: t });
      setText("");
      setWhose("mine");
      c.reloadLists();
    } catch (err) { c.toast((err as Error).message, "bad"); }
    setBusy(false);
  };
  const decide = async (id: string, action: "approve" | "reject", acceptViolations = false): Promise<void> => {
    const reason = action === "reject" ? (window.prompt("Reason for rejecting:") ?? "") : acceptViolations ? "Accepted in workspace with engineering limits still to fix" : "Approved in workspace";
    try { await api("POST", `/api/sessions/${c.sid}/proposals/${id}/${action}`, { reason, acceptViolations }); c.reloadLists(); } catch (err) { c.toast((err as Error).message, "warn"); }
  };
  const broken = c.snap.checks.find((x) => x.status === "fail");
  const starters = [
    ...(broken ? [`Why is "${broken.description}" failing, and what could fix it?`] : []),
    "If we had a bigger antenna, could we send more data home?",
    "What lines does a camera need before it can work?",
    "Make a controller: when the battery runs low, run the instruments a fifth of the time until power is back",
    "Build a radiator panel to keep the battery cool",
    "Would flying lower give sharper measurements? What would it cost?",
    "How much power do we have to spare?",
  ];
  const didNotHold = (r: any): boolean => ["refuted", "outside_model", "cannot"].includes(r.answer?.verdict) || ["infeasible", "rejected"].includes(r.status);
  const list = c.requests.filter((r) => (whose === "crew" || r.user?.id === c.accountId) && (view === "all" || (view === "failed" ? didNotHold(r) : ["built", "built_breaks_limit"].includes(r.answer?.verdict))));
  const failedCount = c.requests.filter((r) => !r.private && didNotHold(r)).length;
  return (
    <div className="chat">
      <div className="row between">
        <h3 className="eyebrow">My AI</h3>
        <div className="seg"><button className={whose === "mine" ? "on" : ""} onClick={() => setWhose("mine")}>Mine</button><button className={whose === "crew" ? "on" : ""} onClick={() => setWhose("crew")}>Whole crew</button></div>
      </div>
      <div className="seg thin" title="Ideas that did not hold are kept with their reasons, so the crew does not try the same thing twice. Others see yours once you share them."><button className={view === "all" ? "on" : ""} onClick={() => setView("all")}>Everything</button><button className={view === "built" ? "on" : ""} onClick={() => setView("built")}>Built</button><button className={view === "failed" ? "on" : ""} onClick={() => setView("failed")}>Did not hold · {failedCount}</button></div>
      <textarea ref={input} className="input" placeholder="Ask how something works, or try an idea: “If we had …, could we …?”" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && void send(text)} />
      <div className="row between"><span className="faint" style={{ fontSize: 11 }}>Ctrl+Enter to send. This conversation is yours; the crew sees only what you share and what reaches the design.</span><button className="btn primary sm" disabled={busy || !text.trim()} title={busy ? "Sending…" : !text.trim() ? "Type a question or an idea first" : "Send to your AI (Ctrl+Enter)"} onClick={() => send(text)}>{busy ? <span className="spinner" /> : "Send"}</button></div>
      {list.length === 0 && view !== "all" && <div className="faint" style={{ fontSize: 12 }}>{view === "failed" ? "No idea has been turned down yet. When your AI says an idea does not hold, it stays here with the reason; share it so the crew can build on it." : "Nothing built by an AI yet."}</div>}
      {list.length === 0 && view === "all" && (
        <div className="starters">
          <div className="faint" style={{ fontSize: 11 }}>Things to try</div>
          {starters.map((e) => <button key={e} onClick={() => setText(e)}>{e}</button>)}
        </div>
      )}

      {list.map((r) => {
        const proposal = c.proposals.find((p) => p.id === r.proposalId);
        const pending = proposal?.status === "awaiting_approval";
        const working = WORKING.includes(r.status);
        const [label, kind] = r.answer ? (VERDICT[r.answer.verdict] ?? ["Answer", "info"]) : working ? ["Working…", "info"] : [String(r.status).replace(/_/g, " "), tone(r.status)];
        const failed: any[] = proposal ? proposal.tests.filter((t: any) => t.status === "fail") : [];
        const hard = failed.filter((t) => !String(t.id).startsWith("engineering."));
        const deployed = r.status === "published";
        // Someone else's conversation with their AI: only what reached the shared design is shown.
        if (r.private) {
          return (
            <div key={r.id} className="turn private">
              <div className="ai info">
                <div className="row between"><span className="who">{memberName(c, r.user.id)} &amp; their AI</span><span className={`chip ${tone(r.status)}`}>{working ? "working…" : String(r.status).replace(/_/g, " ")}</span></div>
                <p className="dim">{r.proposalId ? `Proposed a change to the shared design: ${r.summary ?? "see the proposal"}` : "A private conversation. It appears here if they share it."}</p>
                {pending && proposal && (
                  <div className="row wrap" style={{ marginTop: 8 }}>
                    <button className="btn sm primary" disabled={c.role === "viewer"} onClick={() => decide(proposal.id, "approve", failed.length > 0 && hard.length === 0)}>{failed.length ? `Add it anyway · ${failed.length} limit${failed.length === 1 ? "" : "s"} to fix` : "Approve & deploy"}</button>
                    <button className="btn sm danger" disabled={c.role === "viewer"} onClick={() => decide(proposal.id, "reject")}>Reject</button>
                  </div>
                )}
              </div>
            </div>
          );
        }
        const mine = r.user?.id === c.accountId;
        return (
          <div key={r.id} className="turn">
            <div className="me"><span className="who">{whose === "crew" ? memberName(c, r.user.id) : "You"}</span><p>{r.text}</p></div>
            <div className={`ai ${kind}`}>
              <div className="row between"><span className="who">AI</span><span className={`chip ${kind}`}>{working && <span className="spinner" style={{ width: 9, height: 9 }} />}{deployed ? "In the design" : r.status === "rejected" ? "Rejected" : label}</span></div>
              {r.answer ? <p>{r.answer.text}</p> : working ? <p className="dim">Looking at the mission, then building and testing in a copy…</p> : r.error ? <p>{r.error}</p> : null}
              {r.answer?.facts?.length > 0 && (
                <details>
                  <summary>What was measured · {r.answer.facts.length}</summary>
                  <table className="data"><tbody>{r.answer.facts.map((f: any, i: number) => <tr key={i}><td>{f.label}</td><td className="mono">{f.value}</td></tr>)}</tbody></table>
                </details>
              )}
              {(r.tasks ?? r.plan?.tasks ?? []).map((t: any) => (
                <div key={t.id} className={`plan-step ${t.status}`}><span className="node" /><span className="mono" style={{ fontSize: 11 }}>{t.executedBy ?? t.capabilityId}<span className="dim"> · {t.status}</span></span></div>
              ))}
              {pending && (
                <div className="row wrap" style={{ marginTop: 8 }}>
                  {hard.length ? <span className="chip bad" style={{ whiteSpace: "normal" }}>Cannot be added: {hard.map((t) => t.description).join("; ")}</span>
                    : failed.length ? <button className="btn sm primary" disabled={c.role === "viewer"} title={`Adds it to the shared design and leaves ${failed.length} engineering limit(s) violated for the crew to fix`} onClick={() => decide(proposal.id, "approve", true)}>Add it anyway · {failed.length} limit{failed.length === 1 ? "" : "s"} to fix</button>
                    : <button className="btn sm primary" disabled={c.role === "viewer"} onClick={() => decide(proposal.id, "approve")}>Approve &amp; deploy</button>}
                  <button className="btn sm danger" disabled={c.role === "viewer"} onClick={() => decide(proposal.id, "reject")}>Reject</button>
                </div>
              )}
              {r.status === "awaiting_clarification" && (
                <div className="row" style={{ marginTop: 6 }}>
                  <input className="input" placeholder="Your answer…" value={answers[r.id] ?? ""} onChange={(e) => setAnswers({ ...answers, [r.id]: e.target.value })} />
                  <button className="btn sm" onClick={() => void api("POST", `/api/sessions/${c.sid}/requests/${r.id}/clarify`, { answer: answers[r.id] }).then(c.reloadLists).catch((e) => c.toast(e.message, "warn"))}>Answer</button>
                </div>
              )}
              <div className="foot">
                <span>{r.answer?.wording === "language_model" ? `Worded by ${r.answer.modelId}; the numbers come from the engineering models.` : r.answer ? "Assembled from the engineering models' results." : ""}</span>
                {mine && !r.shared && didNotHold(r) && <span className="hint">Share it so nobody tries this twice →</span>}
                {mine && <button title={r.shared ? "The crew can read this conversation. Click to make it private again." : "Only you can read this conversation. Click to let the crew read it."} onClick={() => void api("POST", `/api/sessions/${c.sid}/requests/${r.id}/share`, { shared: !r.shared }).then(c.reloadLists).catch((e) => c.toast(e.message, "warn"))}>{r.shared ? "Shared with crew ✓" : "Share with crew"}</button>}
                <button onClick={() => void api("GET", `/api/sessions/${c.sid}/requests/${r.id}`).then(setOpen).catch((e) => c.toast(e.message, "warn"))}>How this was worked out</button>
              </div>
            </div>
          </div>
        );
      })}
      {open && (
        <Modal onClose={() => setOpen(null)}>
            <div className="row between"><h2 style={{ fontSize: 20, textTransform: "none" }}>{open.text}</h2><button className="btn sm ghost" onClick={() => setOpen(null)}>Close</button></div>
            {open.answer && <AnswerBlock answer={open.answer} />}
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
        </Modal>
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
  ["science.return", "totalReturnedGbPerDay", "Data Gb/day"], ["comms.link", "worstMarginDb", "Link margin dB"], ["cost.budget", "marginMusd", "Cost margin $M"], ["mass.budget", "marginKg", "Mass margin kg"], ["schedule.budget", "marginMonths", "Schedule margin mo"],
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
          <Spark series={Object.keys(result.rows[0]?.metrics ?? {}).map((k, i) => ({ label: k.split(".").pop()!, color: ["#35e0d0", "#ffb020", "#4be38a", "#c58bff", "#ff5a1f", "#ff4b8b"][i % 6]!, values: result.rows.map((r: any) => (typeof r.metrics[k] === "number" ? r.metrics[k] : null)) }))} />
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
      <p className="faint" style={{ fontSize: 12 }}>Flies the design day by day through the mission: eclipse season, array degradation, battery reserve, Earth range, data stored and returned — and the in-flight events this mission will meet. You find out what they are by flying.</p>
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
          <FlightEvents sim={sim} onDay={c.setPreviewDay} />
          {sim.returnedByInstrument?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="eyebrow" title="What each instrument's data did over the flight: sent home, or made but lost on board when storage overflowed. Control logic can set whose data goes down first.">Science data by instrument</div>
              <table className="data"><thead><tr><th>Instrument</th><th>Sent home</th><th>Lost on board</th></tr></thead><tbody>
                {sim.returnedByInstrument.map((r: any) => <tr key={r.instrumentId}><td>{r.name}</td><td className="mono">{fmt(r.returnedGb)} Gb</td><td className="mono" style={{ color: r.lostGb > 0.01 ? "var(--amber)" : undefined }}>{fmt(r.lostGb)} Gb</td></tr>)}
              </tbody></table>
            </div>
          )}
          {(sim.controlLog?.length > 0 || sim.kpis.daysControlActive > 0) && (
            <div style={{ marginTop: 10 }}>
              <div className="eyebrow">Onboard control logic · acted on {sim.kpis.daysControlActive} of {sim.days} days</div>
              {sim.controlLog.slice(0, 8).map((e: any, i: number) => <div key={i} className="mono" style={{ fontSize: 11, cursor: "pointer" }} title="Show this day in the scene" onClick={() => c.setPreviewDay(e.day)}><span className="dim">day {e.day}</span> {e.note ? `${e.note} — ` : ""}{e.effect}</div>)}
            </div>
          )}
        </div>
      )}
      <hr className="hairline" />
      <TrajectoryPanel c={c} />
      <SiteSurvey c={c} />
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
  const sandbox = c.snap.session.mode === "sandbox";
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
      <button className="btn sm" disabled={!note.summary.trim() || c.role === "viewer"} title={c.role === "viewer" ? "Viewers cannot add to the research record" : !note.summary.trim() ? "Write a summary first" : "Add this to the mission's research record"} onClick={() => act("note", async () => { await api("POST", `/api/sessions/${c.sid}/notes`, note); setNote({ ...note, summary: "", mitigation: "" }); c.toast("Recorded in the research record.", "ok"); })}>Record</button>
      <div className="dim mono" style={{ fontSize: 11 }}>{c.snap.game.risks} risk(s) with mitigation · {c.snap.game.reviews} review(s) held</div>
      <hr className="hairline" />
      <h3 className="eyebrow">Mission lead</h3>
      {!lead && <p className="dim" style={{ fontSize: 12 }}>Reviews, phase gates and submission belong to the mission lead.</p>}
      <div className="row wrap">
        <button className="btn sm" disabled={!lead || busy !== null} title={!lead ? "Only the mission lead holds reviews" : "Hold a review of the design as it stands"} onClick={() => act("review", async () => { const r = await api("POST", `/api/sessions/${c.sid}/review`, {}); setAiReview(r.aiReview); c.toast(`Concept review recorded: score ${r.evaluation.score}, CML ${r.maturity.level}.`, "ok"); })}>Hold concept review</button>
        <button className="btn sm" disabled={!lead || busy !== null || Boolean(c.snap.game.submitted)} title={!lead ? "Only the mission lead moves the mission to its next phase" : c.snap.game.submitted ? "The mission has been submitted" : "Move to the next phase once its gate is met"} onClick={() => act("phase", async () => { await api("POST", `/api/sessions/${c.sid}/phase`, {}); })}>Advance phase</button>
        {sandbox ? <span className="chip" title="Sandbox missions are for experimenting. Start one from the mission board to submit a score.">Sandbox · not ranked</span> : <button className="btn sm primary" disabled={!lead || busy !== null || Boolean(c.snap.game.submitted)} title={!lead ? "Only the mission lead submits the mission" : c.snap.game.submitted ? "Already submitted" : c.snap.game.charter ? "Freeze the design and have it evaluated" : "Define the mission first"} onClick={() => window.confirm("Submit this mission? The design is frozen and scored.") && act("submit", async () => { const r = await api("POST", `/api/sessions/${c.sid}/submit`, {}); onSubmitted(r.evaluation, { ...r.submission, standing: r.standing }); })}>Submit mission</button>}
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
export function EvaluationDashboard({ evaluation, title, submission, checks, onClose }: { evaluation: Evaluation; title: string; submission?: any; checks?: any[]; onClose(): void }) {
  const ringRef = useRef<SVGCircleElement>(null);
  useEffect(() => { requestAnimationFrame(() => ringRef.current?.setAttribute("stroke-dashoffset", String(377 * (1 - evaluation.score / 100)))); }, [evaluation.score]);
  return (
    <Modal onClose={onClose}>
        <div className="row between"><div><div className="eyebrow">{submission ? "Mission submitted" : "Mission evaluation"}</div><h2 style={{ fontSize: 26, marginTop: 6 }}>{title}</h2></div><button className="btn ghost sm" onClick={onClose}>Close</button></div>
        {submission?.standing && <div className="standing"><b>#{submission.standing.rank}</b><span>of {submission.standing.of} crew{submission.standing.of === 1 ? "" : "s"} that flew {submission.standing.scope === "brief" ? "this brief" : "this mission template"}<br /><span className="faint">{submission.standing.title}</span></span></div>}
        {evaluation.outcome && (
          <div className={`outcome ${evaluation.outcome.verdict}`} style={{ marginTop: 14 }}>
            <div className="eyebrow">Does the mission work?</div>
            <div className="headline" style={{ fontSize: 17 }}>{evaluation.outcome.headline}</div>
            {evaluation.outcome.conditions.map((k) => <div key={k.id} className={`cond ${k.met === null ? "open" : k.met ? "met" : "unmet"}`} style={{ cursor: "default" }}><span className="mark">{k.met === null ? "–" : k.met ? "✓" : "✗"}</span><span className="t">{k.title}</span><span className="e">{k.evidence}</span></div>)}
            <div className="faint" style={{ fontSize: 10.5, marginTop: 4 }}>{evaluation.outcome.rule} The score below is secondary.</div>
          </div>
        )}
        <Debrief evaluation={evaluation} checks={checks ?? []} />
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
              <div key={k} style={{ marginTop: 10 }}><div className="row between mono dim" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em" }}><span>{k}</span><span>{v.earned.toFixed(1)} / {+v.possible.toFixed(1)}</span></div><div className="bar"><i style={{ width: `${Math.min(100, (v.earned / v.possible) * 100)}%` }} /></div></div>
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
          <tbody>{evaluation.objectives.map((o) => <tr key={o.id}><td><b>{o.title}</b>{(o as any).primary && <span className="chip info" style={{ marginLeft: 6 }}>primary</span>}{(o as any).stretch && <span className="chip" style={{ marginLeft: 6 }}>stretch</span>}<div className="faint">{o.feedback}</div></td><td className="mono">{o.value === null ? "–" : fmt(o.value)} {o.unit}</td><td className="mono">{fmt(o.target)} {o.unit}</td><td style={{ width: 120 }}><div className={`bar ${o.achieved >= 1 ? "ok" : o.achieved > 0 ? "warn" : "bad"}`}><i style={{ width: `${o.achieved * 100}%` }} /></div></td><td className="mono">{o.points.toFixed(1)} / {+o.weight.toFixed(1)}</td></tr>)}</tbody>
        </table>
        <p className="faint" style={{ fontSize: 11, marginTop: 12 }}>{evaluation.basis}</p>
        {submission && <div className="row" style={{ marginTop: 16 }}><a className="btn primary" href={submission.briefId ? `/leaderboard?brief=${submission.briefId}` : "/leaderboard"}>View leaderboard</a><span className="faint mono" style={{ fontSize: 11 }}>config {submission.configHash.slice(0, 16)}… · v{submission.missionVersion}</span></div>}
    </Modal>
  );
}
