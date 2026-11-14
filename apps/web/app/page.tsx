"use client";
import { useEffect, useState } from "react";
import Backdrop from "@/components/Backdrop";
import { CountUp, Glyph, Ticker, useReveal } from "@/components/Motion";
import Nav from "@/components/Nav";
import { type Account, api } from "@/lib/api";
import { IMAGERY_CREDITS } from "@/lib/scene/space";

const FEATURES = [
  { num: "01", glyph: "orbit" as const, tag: "Mixed reality", title: "A mission table in your room", text: "Enter passthrough MR in the Meta Quest Browser. Grab the orbit, place components by hand, and see teammates' hands move the same spacecraft. No headset? The same workspace runs in any desktop browser." },
  { num: "02", glyph: "wave" as const, tag: "Engineering", title: "Numbers that answer back", text: "Every change re-runs the models it touches — eclipse geometry, power, link budget, data return, mass and cost — and all four seats see the result within a heartbeat." },
  { num: "03", glyph: "plan" as const, tag: "AI runtime builder", title: "Say it. Preview it. Deploy it.", text: "Ask for a new instrument, a script, a 3D model or a different orbit in plain language. The system plans it from live capabilities, tests it in isolation, shows you the consequences, and deploys on approval." },
  { num: "04", glyph: "record" as const, tag: "Research record", title: "Nothing learned is lost", text: "Problems, hypotheses, trade studies, simulations and outcomes are recorded with their provenance and evidence level, and stay searchable for the next team." },
];
const STEPS = [
  ["CML 1", "Cocktail Napkin", "Read the science questions. Sketch the concept."],
  ["CML 2", "Initial Feasibility", "First-order numbers: does the orbit, power and link close?"],
  ["CML 3", "Trade Space", "Sweep altitude against resolution, eclipse and cost. Find the partials."],
  ["CML 4", "Point Design", "Commit to a design with margins. Fly it through a simulated year."],
  ["Review", "Submit", "Hold a concept review, submit, and see where you rank."],
];
const TELEMETRY: [string, string][] = [
  ["ORB", "100 KM POLAR · 117.8 MIN"], ["PWR", "MARGIN +18.4%"], ["COM", "X-BAND 8.4 GHZ · LINK CLOSED"], ["DEM", "LOLA LDEM · MOLA MEGDR"],
  ["EPH", "JPL HORIZONS LIVE"], ["SIM", "365 D · DAY BY DAY"], ["CML", "1 → 5"], ["XR", "IMMERSIVE-AR · HAND TRACKING"], ["J2", "RK4 PROPAGATOR"],
];

export default function Landing() {
  const [account, setAccount] = useState<Account | null>(null);
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [body, setBody] = useState<"moon" | "earth" | "mars">("moon");
  const [board, setBoard] = useState<any[]>([]);
  const [clock, setClock] = useState("");
  useEffect(() => {
    void api("GET", "/api/scenarios").then(setScenarios).catch(() => undefined);
    void api("GET", "/api/leaderboard").then((b) => setBoard(b.slice(0, 3))).catch(() => undefined);
    const tick = (): void => setClock(new Date().toISOString().slice(11, 19));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);
  useReveal([scenarios.length, board.length]);
  const start = account ? "/lobby" : "/auth?next=/lobby";

  return (
    <div className="page">
      <Backdrop variant="hero" body={body} />
      <div className="content">
        <Nav onAccount={setAccount} />
        <header className="hero container">
          <div className="hud-frame" aria-hidden />
          <div className="readout" style={{ right: 44, top: 40, textAlign: "right" }} aria-hidden>
            <div>UTC <b>{clock}</b></div>
            <div>Target <b>{body.toUpperCase()}</b></div>
            <div className="hot">● Live render</div>
          </div>
          <div className="readout" style={{ right: 44, bottom: 44, textAlign: "right", maxWidth: 360 }} aria-hidden>
            <div>{IMAGERY_CREDITS[body]}</div>
          </div>
          <div className="eyebrow fade-in" style={{ animationDelay: "0.9s" }}>NASA Space Apps 2026 · Space Mission Design Game</div>
          <h1 style={{ marginTop: 22 }}>
            <span className="split"><span style={{ ["--d" as string]: "1.0s" }}>Design</span></span>
            <span className="split"><span style={{ ["--d" as string]: "1.12s" }}>the mission.</span></span>
            <span className="split"><span style={{ ["--d" as string]: "1.24s" }}><em>Together.</em></span></span>
          </h1>
          <p className="lede fade-in" style={{ animationDelay: "1.5s" }}>
            A collaborative mixed-reality lab where four engineers shape one spacecraft — orbit, power, communications and science — against real engineering models, with an AI that builds what you ask for and shows its work.
          </p>
          <div className="row wrap fade-in" style={{ marginTop: 36, gap: 14, animationDelay: "1.7s" }}>
            <a className="btn primary lg" href={start}>Enter the lab</a>
            <a className="btn lg" href="#missions">Browse missions</a>
          </div>
          <div className="row wrap fade-in" style={{ marginTop: 58, gap: 54, alignItems: "flex-start", animationDelay: "1.9s" }}>
            <div><div className="stat"><CountUp to={4} suffix="+" /></div><div className="stat-label">engineers per mission, live</div></div>
            <div><div className="stat"><CountUp to={12} /></div><div className="stat-label">engineering models, recalculated on every change</div></div>
            <div><div className="stat"><CountUp to={28} /></div><div className="stat-label">capabilities the AI can plan with</div></div>
            <div><div className="stat">1<span style={{ color: "var(--signal)" }}>→</span>5</div><div className="stat-label">concept maturity, assessed as you go</div></div>
          </div>
        </header>

        <Ticker items={TELEMETRY} />

        <section className="container section">
          <div className="reveal"><div className="eyebrow">What it is</div><h2>One spacecraft. Four seats. Real numbers.</h2></div>
          <div className="grid cols-2">
            {FEATURES.map((f, i) => (
              <article key={f.num} className="glass feature reveal" style={{ ["--d" as string]: `${(i % 2) * 0.12}s` }}>
                <div className="row between" style={{ alignItems: "flex-start" }}>
                  <div className="num">{f.num}</div>
                  <div className="chip">{f.tag}</div>
                </div>
                <Glyph kind={f.glyph} />
                <h4>{f.title}</h4>
                <p className="dim">{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="missions" className="container section">
          <div className="reveal"><div className="eyebrow">Missions</div><h2>Pick a destination</h2></div>
          <div className="grid cols-3">
            {scenarios.map((s, i) => (
              <a key={s.id} className={`glass scenario-card reveal ${body === s.destination ? "selected" : ""}`} href={account ? `/lobby?scenario=${s.id}` : `/auth?next=/lobby?scenario=${s.id}`} onMouseEnter={() => setBody(s.destination)} style={{ color: "inherit", textDecoration: "none", ["--d" as string]: `${i * 0.12}s` }}>
                <div className="ring" />
                <div className={`orb ${s.destination}`} />
                <div className="eyebrow">{s.destination}</div>
                <h3>{s.title}</h3>
                <p className="dim" style={{ minHeight: 44 }}>{s.tagline}</p>
                <div className="row wrap" style={{ marginTop: 16 }}>
                  <span className="chip">{s.objectives.length} objectives</span>
                  <span className="chip">{s.disciplines.length} seats</span>
                  <span className="chip">{s.catalogSize} components</span>
                </div>
              </a>
            ))}
            {scenarios.length === 0 && <div className="glass card dim">Missions load from the platform server. Start it with <span className="mono">npm run dev</span>.</div>}
          </div>
        </section>

        <section className="container section">
          <div className="reveal"><div className="eyebrow">How a concept matures</div><h2>The way mission architects actually work</h2></div>
          <div className="glass reveal">
            <div className="cml">
              {STEPS.map(([k, name, text], i) => (
                <div key={k} style={{ ["--d" as string]: `${i * 0.14}s` }}>
                  <div className="step-k">{k}</div>
                  <div className="step-n">{name}</div>
                  <div className="dim" style={{ fontSize: 13 }}>{text}</div>
                </div>
              ))}
            </div>
          </div>
          <p className="faint" style={{ marginTop: 14, fontSize: 12 }}>
            Concept Maturity Levels after Wessen et al. (JPL); life-cycle phases after the NASA Systems Engineering Handbook. The in-game assessment is a teaching aid, not a formal review.
          </p>
        </section>

        {board.length > 0 && (
          <section className="container section">
            <div className="reveal"><div className="eyebrow">Leaderboard</div><h2>Top concepts</h2></div>
            <div className="glass card reveal">
              <table className="data">
                <tbody>
                  {board.map((b) => (
                    <tr key={b.id}>
                      <td className="mono" style={{ width: 54, color: "var(--signal)", fontSize: 20 }}>{String(b.rank).padStart(2, "0")}</td>
                      <td>{b.sessionName}<div className="dim">{b.scenarioTitle}</div></td>
                      <td className="mono" style={{ fontSize: 20 }}>{b.score.toFixed(1)}</td>
                      <td><span className="chip info">{b.grade}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <a className="btn ghost sm" style={{ marginTop: 14 }} href="/leaderboard">Full leaderboard</a>
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
