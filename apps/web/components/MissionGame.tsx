"use client";
/**
 * Game-loop panels of the mission workspace: the team's mission definition, saved and shared
 * designs with side-by-side comparison, sandbox limits, and the in-flight events a simulation
 * met. All numbers come from the server; nothing here computes a score.
 */
import { useCallback, useEffect, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Ctx } from "./MissionPanels";
import { Modal } from "./Modal";

const locked = (c: Ctx): boolean => c.role === "viewer" || Boolean(c.snap.game.submitted);

// ---------- mission definition ----------
/**
 * Step zero of every mission: the crew says what the mission is for, names the science
 * objective it treats as primary, and may commit to stretch goals. Opens by itself until
 * the mission is defined.
 */
export function DefineMission({ c, onClose }: { c: Ctx; onClose(): void }) {
  const charter = c.snap.game.charter;
  const brief = c.snap.session.brief;
  const science = ((c.snap.scenario as any).objectives ?? []).filter((o: any) => o.category === "science");
  const goals: any[] = (c.snap.scenario as any).stretchGoals ?? [];
  const [statement, setStatement] = useState<string>(charter?.statement ?? "");
  const [primary, setPrimary] = useState<string>(charter?.primary ?? "");
  const [stretch, setStretch] = useState<string[]>(charter?.stretch ?? []);
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await api("POST", `/api/sessions/${c.sid}/define`, { statement, primary, stretch });
      c.toast("Mission defined. The objectives on the left now reflect your choices.", "ok");
      onClose();
    } catch (err) { c.toast((err as Error).message, "warn"); }
    setBusy(false);
  };
  return (
    <Modal onClose={onClose} className="define" dismissable={Boolean(charter)}>
        <div className="row between">
          <div><div className="eyebrow">Step 1 · define the mission</div><h2 style={{ fontSize: 26, marginTop: 6 }}>What is this mission for?</h2></div>
          <button className="btn ghost sm" onClick={onClose}>{charter ? "Close" : "Later"}</button>
        </div>
        <p className="dim" style={{ fontSize: 13, marginTop: 8 }}>Every real mission starts here. Your answers shape the score: the primary objective counts one and a half times, and each stretch goal is a promise — bonus points if you deliver it, a penalty if you do not.</p>
        {brief && <div className="metric" style={{ marginTop: 12 }}><div className="k">The problem you were handed</div><p style={{ fontSize: 13, marginTop: 6 }}>{brief.problem}</p></div>}

        <h3 className="eyebrow" style={{ margin: "18px 0 6px" }}>1 · In your own words</h3>
        <textarea className="input" style={{ minHeight: 70 }} maxLength={400} placeholder="We will … so that …  (what the spacecraft must find out or deliver, and for whom)" value={statement} onChange={(e) => setStatement(e.target.value)} />
        <div className="faint mono" style={{ fontSize: 10.5, textAlign: "right" }}>{statement.trim().length} / 400 · at least 20</div>

        <h3 className="eyebrow" style={{ margin: "14px 0 6px" }}>2 · Primary science objective · counts ×1.5</h3>
        <div className="grid cols-2" style={{ gap: 6 }}>
          {science.map((o: any) => (
            <button key={o.id} className={`preset ${primary === o.id ? "on" : ""}`} onClick={() => setPrimary(o.id)}>
              <b>{o.title} · {o.weight} pts</b><span>{o.description}</span>
            </button>
          ))}
        </div>

        <h3 className="eyebrow" style={{ margin: "14px 0 6px" }}>3 · Stretch goals · optional, up to two</h3>
        <div className="grid cols-2" style={{ gap: 6 }}>
          {goals.map((o: any) => {
            const on = stretch.includes(o.id);
            return (
              <button key={o.id} className={`preset ${on ? "on" : ""}`} disabled={!on && stretch.length >= 2} onClick={() => setStretch(on ? stretch.filter((s) => s !== o.id) : [...stretch, o.id])}>
                <b>{o.title} · +{o.weight} pts</b><span>{o.description}</span>
              </button>
            );
          })}
        </div>
        <div className="row between" style={{ marginTop: 18 }}>
          <span className="faint" style={{ fontSize: 11 }}>Engineers can change this during the concept phase; after that it is the lead's call.</span>
          <button className="btn primary" disabled={busy || locked(c) || statement.trim().length < 20 || !primary} onClick={save}>{busy ? <span className="spinner" /> : charter ? "Update mission definition" : "Define the mission"}</button>
        </div>
    </Modal>
  );
}

/** The mission definition as it stands, at the top of the objectives column. */
export function CharterCard({ c, onEdit }: { c: Ctx; onEdit(): void }) {
  const charter = c.snap.game.charter;
  if (c.snap.session.mode === "sandbox") {
    return <div><h3 className="eyebrow" style={{ marginBottom: 8 }}>Sandbox</h3><p className="dim" style={{ fontSize: 12 }}>Free build: every part is available and the budget, mass, duration and schedule limits are yours to move. Nothing here is ranked.</p></div>;
  }
  const title = (id: string): string => ((c.snap.scenario as any).objectives ?? []).find((o: any) => o.id === id)?.title ?? id;
  return (
    <div>
      <div className="row between" style={{ marginBottom: 8 }}><h3 className="eyebrow">Our mission</h3>{!locked(c) && <button className="btn sm ghost" onClick={onEdit}>{charter ? "Edit" : "Define"}</button>}</div>
      {charter ? (
        <>
          <p style={{ fontSize: 13 }}>{charter.statement}</p>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <span className="chip info">Primary · {title(charter.primary)}</span>
            {charter.stretch.map((s: string) => <span key={s} className="chip">Stretch · {((c.snap.scenario as any).stretchGoals ?? []).find((o: any) => o.id === s)?.title ?? s}</span>)}
          </div>
        </>
      ) : (
        <div className="chip warn" style={{ whiteSpace: "normal" }}>Not defined yet. The mission cannot advance or be submitted until the crew says what it is for.</div>
      )}
    </div>
  );
}

// ---------- sandbox limits ----------
export function SandboxLimits({ c }: { c: Ctx }) {
  const meta = c.snap.mission.config.meta;
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (c.snap.session.mode !== "sandbox") return null;
  const fields: [string, string, string][] = [["budgetMusd", "Budget", "$M"], ["massLimitKg", "Launch mass", "kg"], ["missionDurationDays", "Duration", "days"], ["scheduleMonths", "Schedule", "months"]];
  const commit = (key: string, label: string, unit: string): void => {
    const v = Number(draft[key]);
    setDraft(({ [key]: _gone, ...rest }) => rest);
    if (!Number.isFinite(v) || v <= 0 || v === meta[key]) return;
    void c.collab.edit([{ op: "set", path: `meta.${key}`, value: v }], `Sandbox: ${label.toLowerCase()} → ${fmt(v)} ${unit}`).then((r) => { if (!r.ok) c.toast(r.detail ?? "Not accepted", "warn"); });
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <h3 className="eyebrow">Sandbox limits</h3>
      <div className="faint" style={{ fontSize: 11 }}>In a ranked mission these are fixed by the brief. Here you can move them and watch what gives.</div>
      <div className="row wrap">
        {fields.map(([key, label, unit]) => (
          <label key={key} className="field" style={{ flex: 1, minWidth: 90 }}>{label} ({unit})
            <input className="input mono" inputMode="decimal" disabled={c.role === "viewer"} value={draft[key] ?? String(meta[key] ?? "")} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} onBlur={() => draft[key] !== undefined && commit(key, label, unit)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          </label>
        ))}
      </div>
    </div>
  );
}

// ---------- in-flight events ----------
export function FlightEvents({ sim, onDay }: { sim: any; onDay(day: number): void }) {
  const events: any[] = sim.flightEvents ?? [];
  if (!events.length) return null;
  return (
    <div className="stack" style={{ gap: 6, marginTop: 10 }}>
      <div className="k mono faint" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase" }}>In-flight events · {fmt((sim.kpis.scienceDeliveredFraction ?? 0) * 100)}% of planned science delivered</div>
      {events.map((e) => (
        <div key={`${e.id}:${e.day}`} className="event-card" onClick={() => onDay(e.day)} title="Jump the 3D view to this day">
          <div className="row between"><b>{e.title}</b><span className={`chip ${e.dataLostGb > 0.005 ? "bad" : "ok"}`}>day {e.day}{e.durationDays ? ` · ${e.durationDays} d` : ""}</span></div>
          <p>{e.description}</p>
          <p><span style={{ color: e.dataLostGb > 0.005 ? "var(--red)" : "var(--green)" }}>{e.outcome}</span> <span className="faint">What protects against it: {e.mitigation}</span></p>
        </div>
      ))}
      <div className="faint" style={{ fontSize: 10.5 }}>Events are drawn from the mission seed, so every crew flying this problem meets the same ones. Their dates and sizes are a game model, not failure statistics.</div>
    </div>
  );
}

// ---------- designs: save, share, compare, load ----------
export function DesignsPanel({ c }: { c: Ctx }) {
  const [lists, setLists] = useState<{ saved: any[]; shared: any[] }>({ saved: [], shared: [] });
  const [name, setName] = useState("");
  const [a, setA] = useState("head");
  const [b, setB] = useState("1");
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const base = `/api/sessions/${c.sid}`;
  const reload = useCallback(() => { void api("GET", `${base}/designs`).then(setLists).catch(() => undefined); }, [base]);
  useEffect(reload, [reload, c.snap.game.savedDesigns?.length]);
  const act = async (id: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(id);
    try { await fn(); } catch (err) { c.toast((err as Error).message, "warn"); }
    setBusy(null);
  };
  const compare = (): Promise<void> => act("compare", async () => setResult(await api("GET", `${base}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)));
  const download = (): Promise<void> => act("export", async () => {
    const v = await api("GET", `${base}/versions/${c.snap.mission.version}`);
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "mission-forge-design", exportedAt: new Date().toISOString(), mission: c.snap.session.name, version: v.version, config: v.config, results: v.derived }, null, 2)], { type: "application/json" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: `${String(c.snap.session.name).replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-v${v.version}.json` });
    link.click();
    URL.revokeObjectURL(url);
  });
  const mine = c.snap.session.id;
  const options = [
    { value: "head", label: `Current design · v${c.snap.mission.version}` },
    { value: "1", label: "Starting design · v1" },
    ...lists.saved.map((d) => ({ value: String(d.version), label: `Saved · ${d.name} · v${d.version}` })),
    ...lists.shared.map((d) => ({ value: `shared:${d.id}`, label: `Shared · ${d.name} · ${d.by}${d.sessionId === mine ? " (this crew)" : ""}` })),
  ];
  const show = (v: unknown, unit: string): string => (v === null || v === undefined ? "–" : typeof v === "number" ? `${fmt(unit === "" && v <= 1 && !Number.isInteger(v) ? v * 100 : v)}${unit === "" && v <= 1 && !Number.isInteger(v) ? "%" : unit ? ` ${unit}` : ""}` : String(v));
  return (
    <div className="stack">
      <h3 className="eyebrow">Save and share</h3>
      <p className="faint" style={{ fontSize: 12 }}>Save a design to come back to it. Share one and every crew on this mission template can study it, compare against it and load it.</p>
      <input className="input" placeholder={`Name this design (v${c.snap.mission.version})`} maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
      <div className="row wrap">
        <button className="btn sm" disabled={busy !== null || c.role === "viewer"} onClick={() => act("save", async () => { await api("POST", `${base}/designs`, { name }); setName(""); reload(); c.toast("Design saved.", "ok"); })}>Save</button>
        <button className="btn sm" disabled={busy !== null || c.role === "viewer"} onClick={() => act("share", async () => { await api("POST", `${base}/designs/share`, { name }); setName(""); reload(); c.toast("Design shared with other crews.", "ok"); })}>Share with other crews</button>
        <button className="btn sm ghost" disabled={busy !== null} onClick={download}>Download .json</button>
      </div>

      <hr className="hairline" />
      <h3 className="eyebrow">Compare two designs</h3>
      <div className="row">
        <select className="input" value={a} onChange={(e) => setA(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
        <span className="mono faint">vs</span>
        <select className="input" value={b} onChange={(e) => setB(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      </div>
      <button className="btn" disabled={busy !== null || a === b} onClick={compare}>{busy === "compare" ? <span className="spinner" /> : "Compare"}</button>
      {result && (
        <div className="metric">
          <table className="data compare">
            <thead><tr><th /><th>{result.a.label}</th><th>{result.b.label}</th></tr></thead>
            <tbody>{result.rows.map((r: any) => (
              <tr key={r.key}><td>{r.label}</td><td className={`mono ${r.better === "a" ? "win" : ""}`}>{show(r.a, r.unit)}</td><td className={`mono ${r.better === "b" ? "win" : ""}`}>{show(r.b, r.unit)}</td></tr>
            ))}</tbody>
          </table>
          {(result.parts.onlyA.length > 0 || result.parts.onlyB.length > 0) && (
            <div style={{ fontSize: 12, marginTop: 8 }}>
              {result.parts.onlyA.length > 0 && <div><b>Only in {result.a.label}:</b> <span className="dim">{result.parts.onlyA.join(", ")}</span></div>}
              {result.parts.onlyB.length > 0 && <div style={{ marginTop: 4 }}><b>Only in {result.b.label}:</b> <span className="dim">{result.parts.onlyB.join(", ")}</span></div>}
            </div>
          )}
          <div className="faint" style={{ fontSize: 10.5, marginTop: 8 }}>Highlighted cells are the better value. Scores here leave out the flight simulation, which is run on submission.</div>
        </div>
      )}

      <hr className="hairline" />
      <h3 className="eyebrow">Saved in this mission · {lists.saved.length}</h3>
      {lists.saved.length === 0 && <p className="dim" style={{ fontSize: 12 }}>Nothing saved yet.</p>}
      {lists.saved.map((d) => (
        <div key={d.id} className="row between objective">
          <span style={{ fontSize: 13 }}><b>{d.name}</b><div className="faint mono" style={{ fontSize: 11 }}>v{d.version} · {new Date(d.at).toLocaleTimeString()}</div></span>
          <button className="btn sm ghost" onClick={() => { setA("head"); setB(String(d.version)); }}>Compare</button>
        </div>
      ))}
      <h3 className="eyebrow">Shared by crews · {lists.shared.length}</h3>
      {lists.shared.length === 0 && <p className="dim" style={{ fontSize: 12 }}>No crew has shared a design for this mission template yet.</p>}
      {lists.shared.map((d) => (
        <div key={d.id} className="objective">
          <div className="row between"><span style={{ fontSize: 13 }}><b>{d.name}</b> <span className="dim">· {d.by}</span></span><span className="chip info">{fmt(d.metrics.score)} pts</span></div>
          <div className="faint mono" style={{ fontSize: 11, margin: "3px 0 6px" }}>{d.briefTitle ?? d.sessionName} · {fmt(d.metrics.totalMassKg)} kg · ${fmt(d.metrics.totalCostMusd)}M · {d.metrics.components} parts</div>
          <div className="row">
            <button className="btn sm ghost" onClick={() => { setA("head"); setB(`shared:${d.id}`); }}>Compare</button>
            <button className="btn sm ghost" disabled={busy !== null || locked(c)} onClick={() => window.confirm(`Load "${d.name}" into this mission? Your orbit, parts and launch vehicle are replaced. The change is a new version and can be rolled back.`) && act("load", async () => { await api("POST", `${base}/designs/import`, { designId: d.id }); c.toast(`Loaded "${d.name}".`, "ok"); })}>Load into our mission</button>
          </div>
        </div>
      ))}
    </div>
  );
}
