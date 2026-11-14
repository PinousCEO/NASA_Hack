"use client";
/**
 * Title screen. A game front end: logo, "press any key", a main menu driven by keyboard or
 * pointer, mission (level) select, high scores. The live 3D scene behind it is the same
 * renderer the workspace uses.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Backdrop from "@/components/Backdrop";
import { useReveal } from "@/components/Motion";
import { go as navigate, type Account, api, currentAccount } from "@/lib/api";
import { IMAGERY_CREDITS } from "@/lib/scene/space";

const STAGES = [
  ["Stage 1", "Concept", "Read the science questions. Sketch the mission."],
  ["Stage 2", "Feasibility", "Does the orbit, power and link close?"],
  ["Stage 3", "Trade space", "Sweep altitude against resolution, eclipse and cost."],
  ["Stage 4", "Point design", "Commit with margins. Fly a simulated year."],
  ["Final", "Review & submit", "Hold the review, submit, take your rank."],
];

/** Tiny synthesised interface sounds (no audio files). Silent until the first user gesture. */
function useSfx(enabled: boolean): (kind: "move" | "select" | "start") => void {
  const audio = useRef<AudioContext | null>(null);
  return useCallback((kind) => {
    if (!enabled) return;
    try {
      const ctx = (audio.current ??= new AudioContext());
      const tones = kind === "move" ? [[620, 0, 0.05]] : kind === "select" ? [[520, 0, 0.07], [880, 0.07, 0.12]] : [[330, 0, 0.1], [495, 0.1, 0.1], [660, 0.2, 0.22]];
      for (const [frequency, at, length] of tones as [number, number, number][]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
        gain.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + at + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + length);
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + at);
        osc.stop(ctx.currentTime + at + length + 0.02);
      }
    } catch { /* audio is decoration */ }
  }, [enabled]);
}

export default function TitleScreen() {
  const [account, setAccount] = useState<Account | null>(null);
  const [feed, setFeed] = useState<{ status: any; briefs: any[] } | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [board, setBoard] = useState<any[]>([]);
  const [resume, setResume] = useState<{ id: string; name: string } | null>(null);
  const body = "moon" as const;
  const [started, setStarted] = useState(false);
  const [selected, setSelected] = useState(0);
  const [sound, setSound] = useState(true);
  const [clock, setClock] = useState("");
  const sfx = useSfx(sound);

  useEffect(() => {
    // The first briefs of the day may still be being written when the page opens: keep asking until some arrive.
    let tries = 0;
    const loadBriefs = (): void => void api("GET", "/api/briefs").then((f) => { setFeed(f); if (f.briefs.length === 0 && tries++ < 20) setTimeout(loadBriefs, 4000); }).catch(() => undefined);
    loadBriefs();
    void api("GET", "/api/leaderboard").then(setBoard).catch(() => undefined);
    void currentAccount().then((a) => {
      setAccount(a);
      if (a) void api<any[]>("GET", "/api/sessions").then((list) => {
        const mine = list.filter((s) => s.isMember && !s.submitted);
        if (mine[0]) setResume({ id: mine[0].id, name: mine[0].name });
      }).catch(() => undefined);
    });
    const tick = (): void => setClock(new Date().toISOString().slice(11, 19));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  useReveal([feed?.briefs.length, board.length, started]);
  const issue = async (): Promise<void> => {
    setIssuing(true);
    try {
      await api("POST", "/api/briefs/generate", { count: 3 });
      setFeed(await api("GET", "/api/briefs"));
      sfx("select");
    } catch { /* the board keeps what it has */ }
    setIssuing(false);
  };
  /** 1–3: how hard the brief squeezes budget and mass. */
  const pressure = (b: any): number => (b.constraints.budgetFactor * b.constraints.massFactor < 0.8 ? 3 : b.constraints.budgetFactor * b.constraints.massFactor < 0.98 ? 2 : 1);

  const go = (href: string): void => { navigate(href); };
  const menu = useMemo(() => [
    { label: "New mission", hint: "Pick a destination and assemble a crew", run: () => go(account ? "/lobby" : "/auth?next=/lobby") },
    ...(resume ? [{ label: "Continue", hint: resume.name, run: () => go(`/mission?s=${resume.id}`) }] : []),
    { label: "Mission board", hint: "New problems issued every day", run: () => document.querySelector("#missions")?.scrollIntoView({ behavior: "smooth" }) },
    { label: "High scores", hint: "Ranked concepts from every crew", run: () => go("/leaderboard") },
    { label: "Research archive", hint: "What every team has learned", run: () => go("/research") },
    account
      ? { label: "Sign out", hint: `Signed in as ${account.displayName}`, run: () => void api("POST", "/api/auth/logout", {}).then(() => go("/")) }
      : { label: "Sign in", hint: "Create a pilot profile or log in", run: () => go("/auth") },
  ], [account, resume]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (!started) {
        setStarted(true);
        sfx("start");
        return;
      }
      if (window.scrollY > window.innerHeight * 0.5) return; // the menu only owns the keys while it is on screen
      if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") { e.preventDefault(); setSelected((i) => (i + 1) % menu.length); sfx("move"); }
      else if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") { e.preventDefault(); setSelected((i) => (i - 1 + menu.length) % menu.length); sfx("move"); }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sfx("select"); menu[selected]?.run(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, menu, selected, sfx]);


  return (
    <div className="page">
      <Backdrop variant="hero" body={body} />
      <div className="content">
        <section className="title" onClick={() => { if (!started) { setStarted(true); sfx("start"); } }}>
          <div className="title-top">
            <div className="eyebrow">NASA Space Apps 2026 · Challenge 13</div>
            <div className="pilot">
              <span>UTC <b>{clock}</b></span>
              <span>Pilot <b>{account ? account.displayName : "Guest"}</b></span>
              <button className="btn sm ghost" onClick={(e) => { e.stopPropagation(); setSound(!sound); }} aria-pressed={sound}>SFX {sound ? "on" : "off"}</button>
            </div>
          </div>

          <div className="title-main">
            <h1 className="logo" aria-label="Mission Forge">
              <span className="split"><span style={{ ["--d" as string]: "0.9s" }}>Mission</span></span>
              <span className="split"><span style={{ ["--d" as string]: "1.02s" }}><em>Forge</em></span></span>
            </h1>
            <div className="logo-sub fade-in" style={{ animationDelay: "1.4s" }}>Space mission design game · 1–4 players · Desktop and mixed reality</div>

            {!started ? (
              <button className="press-start fade-in" style={{ animationDelay: "1.9s" }} onClick={() => { setStarted(true); sfx("start"); }}>Press any key to start</button>
            ) : (
              <nav className="menu" aria-label="Main menu">
                {menu.map((item, i) => (
                  <button key={item.label} className={`menu-item ${i === selected ? "sel" : ""}`} style={{ ["--d" as string]: `${i * 0.06}s` }} onMouseEnter={() => { if (i !== selected) { setSelected(i); sfx("move"); } }} onClick={(e) => { e.stopPropagation(); sfx("select"); item.run(); }}>
                    <span className="idx">{String(i + 1).padStart(2, "0")}</span>
                    <span className="lbl">{item.label}</span>
                    <span className="hint">{item.hint}</span>
                  </button>
                ))}
              </nav>
            )}
          </div>

          <div className="title-bottom">
            <span>{started ? "↑ ↓ select · Enter confirm" : "Keyboard · mouse · Quest controllers"}</span>
            <span>{IMAGERY_CREDITS[body]}</span>
          </div>
        </section>

        <section id="missions" className="container section">
          <div className="reveal row between wrap" style={{ alignItems: "flex-end" }}>
            <div><div className="eyebrow">Mission board</div><h2 style={{ marginBottom: 12 }}>New problems, every day</h2></div>
            <div className="row wrap" style={{ marginBottom: 14 }}>
              {feed && <span className="chip">{feed.status.total} issued · {feed.status.today} today</span>}
              {feed && <span className={`chip ${feed.status.source === "ai" ? "info" : ""}`}>{feed.status.source === "ai" ? `Written by ${feed.status.modelId}` : "Built-in problem set (no language model configured)"}</span>}
              <button className="btn sm" disabled={!account || issuing} title={account ? "Ask the mission office for three more briefs" : "Sign in to request new missions"} onClick={() => void issue()}>{issuing ? <><span className="spinner" /> Writing briefs…</> : "Generate new missions"}</button>
            </div>
          </div>
          <p className="dim reveal" style={{ maxWidth: "78ch", marginBottom: 22 }}>
            Each brief is a fresh design problem posed on a validated engineering baseline. Briefs are written continuously and every one — with what crews learn solving it — is added to the research archive. A brief frames the problem; your score always comes from the engineering models.
          </p>
          <div className="grid cols-3">
            {(feed?.briefs ?? []).slice(0, 9).map((b: any, i: number) => (
              <a key={b.id} className="glass brief-card reveal" href={account ? `/lobby?brief=${b.id}` : `/auth?next=${encodeURIComponent(`/lobby?brief=${b.id}`)}`} style={{ ["--d" as string]: `${(i % 3) * 0.08}s` }}>
                <div className="row between">
                  <span className={`dest ${b.destination}`}>{b.destination}</span>
                  <span className={`chip ${b.origin === "ai" ? "info" : ""}`}>{b.origin === "ai" ? "AI-written" : "Built-in"} · {b.day}</span>
                </div>
                <h3>{b.title}</h3>
                <p className="dim">{b.problem}</p>
                <p className="why">{b.whyItMatters}</p>
                <div className="row wrap" style={{ marginTop: "auto", paddingTop: 14 }}>
                  <span className="threat" title="Programme pressure from the brief's budget and mass limits">Pressure {[1, 2, 3].map((n) => <i key={n} className={n <= pressure(b) ? "on" : ""} />)}</span>
                  <span className="chip">Budget ×{b.constraints.budgetFactor.toFixed(2)}</span>
                  <span className="chip">Mass ×{b.constraints.massFactor.toFixed(2)}</span>
                  <span className="chip">Duration ×{b.constraints.durationFactor.toFixed(2)}</span>
                </div>
                <div className="flown">{b.crews > 0 ? <>Flown by <b>{b.crews}</b> crew{b.crews === 1 ? "" : "s"} · score to beat <b>{Number(b.best).toFixed(1)}</b></> : "Not flown yet — be the first crew"}</div>
              </a>
            ))}
            {!feed && <div className="glass card dim">Mission briefs load from the platform server. Start it with <span className="mono">npm run dev</span>.</div>}
          </div>
        </section>

        <section className="container section">
          <div className="reveal"><div className="eyebrow">How to play</div><h2>Five stages to a flight-ready concept</h2></div>
          <div className="glass reveal">
            <div className="cml">
              {STAGES.map(([k, name, text], i) => (
                <div key={k} style={{ ["--d" as string]: `${i * 0.14}s` }}>
                  <div className="step-k">{k}</div>
                  <div className="step-n">{name}</div>
                  <div className="dim" style={{ fontSize: 13 }}>{text}</div>
                </div>
              ))}
            </div>
          </div>
          <p className="faint" style={{ marginTop: 14, fontSize: 12 }}>
            Every change re-runs real engineering models and reaches all seats at once. Ask the AI builder for instruments, scripts or 3D models in plain language; it previews before it deploys. Stages follow JPL's Concept Maturity Levels (Wessen et al.) — a teaching aid, not a formal review.
          </p>
        </section>

        {board.length > 0 && (
          <section className="container section">
            <div className="reveal"><div className="eyebrow">High scores</div><h2>Top concepts</h2></div>
            <div className="glass card reveal">
              <table className="data">
                <tbody>
                  {board.slice(0, 5).map((b) => (
                    <tr key={b.id}>
                      <td className="mono" style={{ width: 54, color: "var(--signal)", fontSize: 20 }}>{String(b.rank).padStart(2, "0")}</td>
                      <td>{b.sessionName}<div className="dim">{b.briefTitle ?? b.scenarioTitle}</div></td>
                      <td className="mono" style={{ fontSize: 20 }}>{b.score.toFixed(1)}</td>
                      <td><span className="chip info">{b.grade}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <a className="btn ghost sm" style={{ marginTop: 14 }} href="/leaderboard">All scores</a>
            </div>
          </section>
        )}

        <footer className="container faint" style={{ margin: "110px auto 0", padding: "30px 28px 60px", fontSize: 12, borderTop: "1px solid var(--line)", lineHeight: 1.8 }}>
          Built for the NASA International Space Apps Challenge 2026. An independent project — not affiliated with or endorsed by NASA. Engineering models are first-order approximations with stated assumptions; cost figures use a game cost model.
          <br />Planet imagery and terrain: NASA/GSFC/Arizona State University (LROC), NASA/GSFC/MIT (LOLA), NASA/JPL/USGS (Viking), NASA/GSFC (MOLA), NASA Earth Observatory (Blue Marble, VIIRS). Ephemerides: NASA/JPL Horizons.
        </footer>
      </div>
    </div>
  );
}
