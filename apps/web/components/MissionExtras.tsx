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
        <button className="btn sm" disabled={busy || locked || report.trim().length < 10} title={locked ? "The design cannot be changed right now" : report.trim().length < 10 ? "Paste the text of a GMAT ReportFile first" : "Add this trajectory to the orbit view"} onClick={() => act(() => api("POST", `/api/sessions/${c.sid}/trajectories`, { kind: "gmat", report, name, wait: true }).then(() => setReport("")), "GMAT trajectory added to the orbit view")}>Import</button>
      </div>
      {overlays.map((t) => (
        <div key={t.id} className="metric">
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
export function Transport({ day, duration, start, onDay, onFrame, children }: { day: number | null; duration: number; start: string; onDay(day: number | null): void; onFrame?(day: number): void; children?: React.ReactNode }) {
  const [playing, setPlaying] = useState(false);
  const current = useRef(day ?? 0);
  current.current = day ?? 0;
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    let value = current.current >= duration ? 0 : current.current;
    let published = 0;
    const step = (now: number): void => {
      // The whole mission plays in about 24 seconds.
      value += ((now - last) / 1000) * (duration / 24);
      last = now;
      if (value >= duration) {
        onDay(duration);
        setPlaying(false);
        return;
      }
      // The scene follows every frame; the (much heavier) interface re-renders eight times a second.
      onFrame?.(value);
      if (now - published > 125) {
        published = now;
        onDay(Math.max(1, Math.round(value)));
      }
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
      <div className="tag rec" style={{ left: 52, top: 122 }}>Live · authoritative state v{snap.mission.version}</div>
      <div className="tag" style={{ left: 52, top: 62 }}>
        <div>View <b>{mode === "orbit" ? `${body} orbit` : mode === "site" ? "the target, close up" : "spacecraft systems"}</b></div>
        <div>Alt <b>{fmt(el.periapsisAltitudeKm)} km</b> · Inc <b>{fmt(snap.mission.config.orbit.inclinationDeg)}°</b></div>
        <div>Period <b>{fmt(el.periodS / 60)} min</b></div>
      </div>
    </div>
  );
}

export const assetUrl = (uri: string): string => `${CORE_ORIGIN}${uri}`;

const ACTIVE_STATES = ["queued", "analyzing", "planning", "executing", "awaiting_clarification", "awaiting_approval"];
const STATE_LABEL: Record<string, string> = { queued: "in queue", analyzing: "analysing", planning: "planning", executing: "building", awaiting_clarification: "needs an answer", awaiting_approval: "needs approval", published: "deployed", completed: "answered", failed: "failed", infeasible: "not feasible", rejected: "rejected", cancelled: "cancelled" };

/**
 * The crew's shared AI queue: who asked for what, where it is in line and what became of it.
 * Requests run one at a time per mission, so this is the same list, in the same order, for everyone.
 */
export function AiQueue({ requests, members, onOpen }: { requests: any[]; members: any[]; onOpen(): void }) {
  const active = requests.filter((r) => ACTIVE_STATES.includes(r.status)).slice(0, 5).reverse();
  const recent = requests.filter((r) => !ACTIVE_STATES.includes(r.status)).slice(0, 2);
  if (active.length === 0 && recent.length === 0) return null;
  const name = (r: any): string => members.find((m: any) => m.accountId === r.user?.id)?.displayName ?? "Crew";
  const row = (r: any, done: boolean) => (
    <div key={r.id} className={`item ${done ? "done" : ""}`} title={r.text}>
      <span className="who">{name(r).slice(0, 2).toUpperCase()}</span>
      <div className="txt"><b>{name(r)}</b><span>{r.private ? (r.summary ? `proposed: ${r.summary}` : "talking with their AI (private)") : r.text}</span>{done && r.answer && <em>{r.answer.text}</em>}</div>
      <span className={`chip ${r.status === "failed" || r.status === "infeasible" || r.status === "rejected" ? "bad" : r.status.startsWith("awaiting") ? "warn" : done ? "ok" : "info"}`}>
        {!done && r.status !== "queued" && !r.status.startsWith("awaiting") && <span className="spinner" style={{ width: 9, height: 9 }} />}
        {r.status === "queued" && r.queuePosition ? `#${r.queuePosition} ` : ""}{STATE_LABEL[r.status] ?? r.status}
      </span>
    </div>
  );
  return (
    <div className="glass ai-queue" onClick={onOpen} style={{ cursor: "pointer" }}>
      <div className="head"><span>AI queue · whole crew</span><span>{active.length} active</span></div>
      {active.map((r) => row(r, false))}
      {recent.map((r) => row(r, true))}
    </div>
  );
}

// ---------- learning aids: plain-language explanations, orbit presets, launch choice, tutorial, debrief ----------
/** What each headline number means, in one sentence a newcomer can use. */
export const EXPLAIN: Record<string, string> = {
  Altitude: "Height above the surface. Lower sees finer detail but spends longer in shadow and flies past the ground station faster.",
  Period: "Time for one lap around the planet. Lower orbits lap faster.",
  Eclipse: "Share of each orbit spent in the planet's shadow, where solar panels make no power and the battery takes over.",
  "Power margin": "Power generated minus power used, averaged over an orbit. Below zero the spacecraft slowly runs out of energy.",
  "Battery DoD": "How far the battery is drained in each eclipse. Deep drains wear a battery out; above its limit the design fails.",
  "Link margin": "How much stronger the radio signal is than the minimum needed. Under 3 dB the link is fragile; under 0 it does not work.",
  "Data return": "Science data that reaches Earth each day. It is limited by what instruments produce and by what the antenna can send.",
  "Mass margin": "Launch mass allocation minus the spacecraft's mass. Every added part eats into it.",
  "Cost margin": "Budget minus total cost. Parts, the spacecraft bus and the launch all count.",
  "Schedule margin": "Months left before the launch window once the spacecraft is built. Every part adds build and test time; the slowest part sets the pace.",
  "Rover slope margin": "How much steeper a slope the rover could still climb at its site.",
};

/** Why the numbers just moved, from what was changed. */
export function whyItChanged(changedPaths: string[] | undefined): string | null {
  const p = (changedPaths ?? []).join(" ");
  if (!p) return null;
  if (p.includes("meta.budgetMusd") || p.includes("meta.massLimitKg") || p.includes("meta.scheduleMonths") || p.includes("meta.missionDurationDays")) return "A sandbox limit changed. The design is the same; what it is measured against moved.";
  if (p.includes("launchVehicleId")) return "Launch vehicle changed. A bigger vehicle lifts more mass but takes more of the budget; a polar orbit costs every vehicle some capacity.";
  if (p.includes("semiMajorAxisKm")) return "Altitude changed. Lower orbits give sharper measurements but longer eclipses and shorter radio contacts; higher orbits trade detail for power and link time.";
  if (p.includes("inclinationDeg")) return "Inclination changed. It sets which latitudes you fly over: near 90° reaches the poles, but launch vehicles lift less into polar orbits and the lighting changes.";
  if (p.includes("raanDeg") || p.includes("missionTime")) return "The orbit's angle to the Sun changed. That moves how much of each orbit is in shadow, so power and battery numbers move with it.";
  // Wiring and control logic come before the parts list: connecting a part also touches the part it is connected to.
  if (p.includes("systems.controllers")) return "The control logic on board changed. It runs every day of the flight and commands the parts; nothing moves here until you fly the mission — the flight shows what it did.";
  if (p.includes("systems.links")) return "The wiring changed. A part works only through its lines: a connected instrument now draws its power and its data counts, and the lines add a little mass. A line that is too small holds its part back.";
  if (p.includes("spacecraft.components") || p.includes("scene.nodes")) return "The parts list changed. Every part adds mass, cost and build time; instruments also draw power and create data that the antenna has to send home. Attitude control sharpens images; a computer compresses and stores data.";
  if (p.includes("rover")) return "The rover changed. Its mass rides on the same launch, and its wheels and power decide which slopes it can climb.";
  return null;
}

/** One line under the 3D view that explains the latest change in plain words. */
export function Coach({ snap }: { snap: Snapshot }) {
  const text = whyItChanged((snap.mission as any).changedPaths);
  if (!text) return null;
  return <div className="glass coach" key={snap.mission.version}><b>Why the numbers moved</b>{text}</div>;
}

const ORBIT_PRESETS: Record<string, { name: string; altKm: number; incDeg: number; why: string }[]> = {
  earth: [
    { name: "Sun-synchronous", altKm: 600, incDeg: 97.8, why: "The orbit turns with the Sun, so the ground is lit the same way on every pass. The usual choice for imaging." },
    { name: "Low polar", altKm: 500, incDeg: 90, why: "Passes over every latitude, poles included. Lighting drifts through the year." },
    { name: "Low inclined", altKm: 450, incDeg: 51, why: "Never sees high latitudes, but launch vehicles lift the most mass here." },
  ],
  moon: [
    { name: "Low polar", altKm: 100, incDeg: 90, why: "Sees the whole Moon, poles included, as it turns underneath. Good for mapping." },
    { name: "Very low polar", altKm: 40, incDeg: 90, why: "Sharpest measurements, but deeper eclipses and less time in view of a surface rover." },
    { name: "High polar", altKm: 400, incDeg: 90, why: "Long contacts and short eclipses, at the price of coarse measurements." },
  ],
  mars: [
    { name: "Sun-synchronous", altKm: 400, incDeg: 93, why: "Same local time on every pass: steady lighting and weather seen at a fixed hour." },
    { name: "Low polar", altKm: 300, incDeg: 90, why: "Whole-planet coverage with sharper views and more atmospheric drag risk." },
    { name: "High relay", altKm: 1500, incDeg: 75, why: "Long contacts with surface assets; coarse imaging." },
  ],
};

/** Named starting orbits with a one-line reason for each. */
export function OrbitPresets({ c, radiusKm }: { c: Ctx; radiusKm: number }) {
  const body = String(c.snap.mission.config.centralBody);
  const locked = c.role === "viewer" || Boolean(c.snap.game.submitted);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="faint" style={{ fontSize: 11 }}>Start from a common orbit, then fine-tune with the sliders.</div>
      {(ORBIT_PRESETS[body] ?? []).map((p) => (
        <button key={p.name} className="preset" disabled={locked} onClick={() => void c.collab.edit([{ op: "set", path: "orbit.semiMajorAxisKm", value: radiusKm + p.altKm }, { op: "set", path: "orbit.inclinationDeg", value: p.incDeg }], `Orbit → ${p.name} (${p.altKm} km, ${p.incDeg}°)`).then((r) => { if (!r.ok) c.toast(r.detail ?? "Not accepted", "warn"); })}>
          <b>{p.name} · {p.altKm} km · {p.incDeg}°</b><span>{p.why}</span>
        </button>
      ))}
    </div>
  );
}

/** Launch vehicle choice with live capacity and price for this orbit. */
export function LaunchPicker({ c }: { c: Ctx }) {
  const launch = c.snap.mission.derived["launch.vehicle"]?.value;
  if (!launch || !launch.options?.length) return null;
  const locked = c.role === "viewer" || Boolean(c.snap.game.submitted);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <h3 className="eyebrow">Launch vehicle</h3>
      <div className="faint" style={{ fontSize: 11 }}>The rocket must be able to lift everything ({fmt(launch.launchMassKg)} kg) to your orbit. Bigger costs more. {launch.selectedId ? "" : "Until you choose, launch is priced per kilogram as a placeholder."}</div>
      {launch.options.map((o: any) => {
        const fits = o.capacityKg >= launch.launchMassKg;
        return (
          <button key={o.id} className={`preset ${launch.selectedId === o.id ? "on" : ""}`} disabled={locked} onClick={() => void c.collab.edit([{ op: "set", path: "meta.launchVehicleId", value: o.id }], `Launch vehicle → ${o.name}`).then((r) => { if (!r.ok) c.toast(r.detail ?? "Not accepted", "warn"); })}>
            <b style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}><span>{o.name} · lifts {fmt(o.capacityKg)} kg · ${fmt(o.costMusd)}M</span><span className={`chip ${fits ? "ok" : "bad"}`} style={{ flex: "none" }}>{fits ? "fits" : "too heavy"}</span></b>
            <span>{o.summary}</span>
          </button>
        );
      })}
      <div className="faint" style={{ fontSize: 10.5 }}>Generic vehicle classes in the game model, not data for real rockets.</div>
    </div>
  );
}

const TUTORIAL = [
  ["The problem", "On the left: the problem your crew was handed, whether the mission works yet — and exactly what is missing — and the kit that came with it: the controls that matter here and the parts worth reaching for."],
  ["Your AI", "On the right is your own AI. Ask how something works, or try an idea: “if we had …, could we …?” If the idea holds it builds it in a test copy and measures what changes. If it does not, it tells you why. Your conversation is yours until you share it."],
  ["Parts need lines", "A part you add arrives unconnected and does nothing. Select it and press Connect it, or ask your AI what lines it needs. Power lines carry watts, data lines carry bits, control lines carry commands; a line that is too small holds the part back."],
  ["Give it behaviour", "Describe what the spacecraft should do by itself — “when power runs short, run the instruments less until the battery recovers” — and your AI writes the control logic, flies the mission with and without it, and shows the difference."],
  ["Turn time", "Drag the planet to turn it. The clock moves with it, and so do the sunlight, the shadow and the line to Earth. Everyone in the crew sees the same moment. In a headset, carry the handle on the planet's ring around it."],
  ["Work as a crew", "Up to four people share this mission, on the web or in a headset. Take a role under Crew. The design and the clock are shared; your view and your AI conversation are your own."],
  ["Fly it and submit", "When the design looks right, fly it — things go wrong in flight, and your control logic runs every day of it. The mission is judged on whether it worked, with the evidence; the score comes second."],
];

/** First-visit walkthrough. It never blocks the interface and can be closed at any step. */
export function Tutorial() {
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    try { if (!localStorage.getItem("mf.tutorial.done")) setStep(0); } catch { /* storage unavailable: no tutorial */ }
  }, []);
  if (step === null) return null;
  const close = (): void => { try { localStorage.setItem("mf.tutorial.done", "1"); } catch { /* ignore */ } setStep(null); };
  const [title, text] = TUTORIAL[step]!;
  return (
    <div className="glass tutorial">
      <div className="head"><span>How to play · {step + 1} / {TUTORIAL.length}</span><button className="btn sm ghost" onClick={close}>Skip</button></div>
      <b>{title}</b>
      <p>{text}</p>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        {step > 0 && <button className="btn sm ghost" onClick={() => setStep(step - 1)}>Back</button>}
        <button className="btn sm primary" onClick={() => (step + 1 < TUTORIAL.length ? setStep(step + 1) : close())}>{step + 1 < TUTORIAL.length ? "Next" : "Start designing"}</button>
      </div>
    </div>
  );
}

/** Post-mission debrief: where the points were lost and why, in plain language. */
export function Debrief({ evaluation, checks }: { evaluation: any; checks: any[] }) {
  const lost = [...evaluation.objectives].map((o: any) => ({ ...o, lost: o.weight - o.points })).filter((o: any) => o.lost > 0.05).sort((a: any, b: any) => b.lost - a.lost).slice(0, 4);
  const won = [...evaluation.objectives].filter((o: any) => o.achieved >= 0.999).slice(0, 4);
  const broken = checks.filter((x) => x.status === "fail");
  return (
    <div className="debrief">
      <h3 className="eyebrow">Debrief · why this result</h3>
      {broken.length > 0 && <p><b>The design breaks {broken.length} hard limit{broken.length === 1 ? "" : "s"}.</b> {broken.map((b) => `${b.description ?? b.title ?? b.id} (${b.detail})`).join("; ")}. A real mission could not fly like this — fix these first.</p>}
      {lost.length > 0 ? <p><b>Most points were lost on:</b></p> : <p><b>Every scored objective was met in full.</b></p>}
      <ul>{lost.map((o: any) => <li key={o.id}><b>{o.title}</b> — {o.lost.toFixed(1)} of {o.weight} points lost. {o.feedback}</li>)}</ul>
      {won.length > 0 && <p><b>What worked:</b> {won.map((o: any) => o.title).join(", ")}.</p>}
      <p className="faint">Try one change, watch which tiles move, and run the simulation again: there is rarely a single perfect design.</p>
    </div>
  );
}
