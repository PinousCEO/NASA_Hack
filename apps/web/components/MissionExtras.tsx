"use client";
/** Workspace pieces added with the NASA data and trajectory features: overlays, site survey, timeline transport, viewfinder. */
import { useEffect, useRef, useState } from "react";
import { api, CORE_ORIGIN, fmt, type Snapshot } from "@/lib/api";
import { IMAGERY_CREDITS } from "@/lib/scene/space";
import type { Ctx } from "./MissionPanels";

/** Trajectory overlays: propagate the orbit with J2, or bring in a GMAT ReportFile. */
export function TrajectoryPanel({ c }: { c: Ctx }) {
  const overlays: any[] = c.snap.mission.config.scene.trajectories ?? [];
  const [days, setDays] = useState(2);
  const [report, setReport] = useState("");
  const [name, setName] = useState("GMAT run");
  const [busy, setBusy] = useState(false);
  const locked = c.role === "viewer" || Boolean(c.snap.game.submitted);
  const act = async (run: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true);
    try {
      await run();
      c.toast(done, "ok");
      c.reloadLists();
    } catch (err) {
      c.toast((err as Error).message, "bad");
    }
    setBusy(false);
  };
  const readFile = (file: File | undefined): void => {
    if (!file) return;
    if (file.size > 20_000_000) return c.toast("That file is larger than 20 MB.", "warn");
    void file.text().then((text) => { setReport(text); setName(file.name.replace(/\.[^.]+$/, "").slice(0, 60)); });
  };
  return (
    <div className="stack">
      <h3 className="eyebrow">Trajectory overlays</h3>
      <p className="faint" style={{ fontSize: 12 }}>Draw a propagated or imported trajectory over the orbit view. Overlays go through the same preview-and-publish pipeline as any design change.</p>
      <div className="row">
        <label className="field grow">J2 propagation, days<input className="input mono" type="number" min={0.1} max={60} step={0.5} value={days} onChange={(e) => setDays(Number(e.target.value))} /></label>
        <button className="btn" style={{ alignSelf: "flex-end" }} disabled={busy || locked} onClick={() => act(() => api("POST", `/api/sessions/${c.sid}/trajectories`, { kind: "j2", days, wait: true }), `J2 propagation over ${days} d added to the orbit view`)}>{busy ? <span className="spinner" /> : "Propagate"}</button>
      </div>
      <label className="field">GMAT ReportFile (ElapsedSecs, X, Y, Z, VX, VY, VZ)
        <textarea className="input" style={{ minHeight: 54, fontSize: 11 }} placeholder="Paste the report text, or choose a file…" value={report.length > 4000 ? `${report.slice(0, 4000)}\n… (${report.length.toLocaleString()} characters)` : report} onChange={(e) => setReport(e.target.value)} />
      </label>
      <div className="row">
        <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} aria-label="Overlay name" />
        <label className="btn sm ghost" style={{ cursor: "pointer" }}>File<input type="file" accept=".txt,.report,.csv,text/plain" style={{ display: "none" }} onChange={(e) => readFile(e.target.files?.[0])} /></label>
        <button className="btn sm" disabled={busy || locked || report.trim().length < 10} onClick={() => act(() => api("POST", `/api/sessions/${c.sid}/trajectories`, { kind: "gmat", report, name, wait: true }).then(() => setReport("")), "GMAT trajectory added to the orbit view")}>Import</button>
      </div>
      {overlays.map((t) => (
        <div key={t.id} className="metric" style={{ borderLeftColor: t.source === "gmat_report" ? "#ffc24a" : "#c58bff" }}>
          <div className="row between"><b style={{ fontSize: 12 }}>{t.name}</b><button className="btn sm ghost" disabled={busy || locked} onClick={() => act(() => api("DELETE", `/api/sessions/${c.sid}/trajectories/${t.id}`), "Overlay removed")}>Remove</button></div>
          <div className="row wrap" style={{ marginTop: 6 }}>
            <span className={`chip ${t.source === "gmat_report" ? "warn" : "info"}`}>{t.source === "gmat_report" ? "imported · external data" : "computed · deterministic"}</span>
            <span className="chip">{t.pointsKm.length} pts · {fmt(t.durationS / 86400)} d</span>
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>{t.note}</div>
        </div>
      ))}
    </div>
  );
}

/** What NASA's laser-altimeter elevation model says about the rover's landing site. */
export function SiteSurvey({ c }: { c: Ctx }) {
  const site = c.snap.mission.config.rover?.site;
  const [survey, setSurvey] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!site || typeof site.latDeg !== "number" || typeof site.lonDeg !== "number" || site.body === "earth") return null;
  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setSurvey(await api("GET", `/api/terrain/${site.body}/survey?lat=${site.latDeg}&lon=${site.lonDeg}&radiusKm=20`));
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };
  return (
    <div className="stack">
      <hr className="hairline" />
      <h3 className="eyebrow">Landing-site survey · NASA DEM</h3>
      <p className="faint" style={{ fontSize: 12 }}>{site.name} at {site.latDeg}°, {site.lonDeg}°E. Reads the {site.body === "moon" ? "LRO LOLA" : "MGS MOLA"} elevation model from the Planetary Data System.</p>
      <button className="btn" disabled={busy} onClick={run}>{busy ? <span className="spinner" /> : survey ? "Survey again" : "Survey the site"}</button>
      {error && <div className="chip bad" style={{ whiteSpace: "normal" }}>{error}</div>}
      {survey && (
        <div className="metric">
          <div className="row wrap" style={{ gap: 16 }}>
            {[["Elevation", `${fmt(survey.elevationM)} m`], ["Regional slope", `${fmt(survey.regionalSlopeDeg)}°`], ["Relief", `${fmt(survey.reliefM)} m`], ["Roughness", `${fmt(survey.roughnessRmsM)} m rms`]].map(([k, v]) => <div key={k}><div className="k">{k}</div><div className="mono" style={{ fontSize: 15 }}>{v}</div></div>)}
          </div>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <span className="chip info">external data · {survey.product}</span>
            <span className="chip">{fmt(survey.resolutionKmPerPixel)} km / px</span>
            <span className={`chip ${survey.regionalSlopeDeg > site.slopeDeg ? "warn" : "ok"}`}>design case {site.slopeDeg}°</span>
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>{survey.caveats[0]}. The rover model keeps using the scenario's design-case slope. {survey.credit}.</div>
        </div>
      )}
    </div>
  );
}

/** Mission-timeline transport: play the Sun geometry forward through the mission. */
export function Transport({ day, duration, start, onDay, children }: { day: number | null; duration: number; start: string; onDay(day: number | null): void; children?: React.ReactNode }) {
  const [playing, setPlaying] = useState(false);
  const current = useRef(day ?? 0);
  current.current = day ?? 0;
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    let value = current.current >= duration ? 0 : current.current;
    const step = (now: number): void => {
      // The whole mission plays in about 24 seconds.
      value += ((now - last) / 1000) * (duration / 24);
      last = now;
      if (value >= duration) {
        onDay(duration);
        setPlaying(false);
        return;
      }
      onDay(Math.max(1, Math.round(value)));
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration]);
  const date = new Date(Date.parse(start) + (day ?? 0) * 86400000).toISOString().slice(0, 10);
  return (
    <div className="transport">
      <button className="play" onClick={() => setPlaying(!playing)} title={playing ? "Pause" : "Play the mission timeline"} aria-label={playing ? "Pause timeline" : "Play timeline"}>{playing ? "❚❚" : "▶"}</button>
      <div>
        <div className="clock">T+{String(day ?? 0).padStart(3, "0")} <span className="faint" style={{ fontSize: 10, letterSpacing: "0.14em" }}>D</span></div>
        <div className="faint mono" style={{ fontSize: 10, letterSpacing: "0.1em" }}>{date}{day ? " · PREVIEW" : ""}</div>
      </div>
      <div className="track">
        <input type="range" min={0} max={duration} step={1} value={day ?? 0} onChange={(e) => { setPlaying(false); onDay(Number(e.target.value) || null); }} title="Preview Sun geometry on a later mission day" aria-label="Mission day" />
      </div>
      {children}
    </div>
  );
}

/** Camera-style overlay on the 3D stage. */
export function Viewfinder({ snap, mode }: { snap: Snapshot; mode: string }) {
  const el = snap.mission.derived["orbit.elements"]?.value ?? {};
  const body = String(snap.mission.config.centralBody);
  return (
    <div className="viewfinder" aria-hidden>
      <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
      <div className="tag rec" style={{ right: 52, top: 14 }}>Live · authoritative state v{snap.mission.version}</div>
      <div className="tag" style={{ left: 52, top: 44 }}>
        <div>View <b>{mode === "orbit" ? `${body} orbit` : "spacecraft systems"}</b></div>
        <div>Alt <b>{fmt(el.periapsisAltitudeKm)} km</b> · Inc <b>{fmt(snap.mission.config.orbit.inclinationDeg)}°</b></div>
        <div>Period <b>{fmt(el.periodS / 60)} min</b></div>
        {mode === "orbit" && <div style={{ marginTop: 6, maxWidth: 300, opacity: 0.75 }}>{IMAGERY_CREDITS[body as keyof typeof IMAGERY_CREDITS] ?? ""}</div>}
      </div>
    </div>
  );
}

export const assetUrl = (uri: string): string => `${CORE_ORIGIN}${uri}`;
