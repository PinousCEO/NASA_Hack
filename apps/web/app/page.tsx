"use client";
import { useEffect, useState } from "react";
import Backdrop from "@/components/Backdrop";
import Nav from "@/components/Nav";
import { type Account, api } from "@/lib/api";

const FEATURES = [
  { tag: "01 · Mixed reality", title: "A mission table in your room", text: "Enter passthrough MR in the Meta Quest Browser. Grab the orbit, place components by hand, and see teammates' hands move the same spacecraft. No headset? The same workspace runs in any desktop browser." },
  { tag: "02 · Engineering", title: "Numbers that answer back", text: "Every change re-runs the models it touches — eclipse geometry, power, link budget, data return, mass and cost — and all four seats see the result within a heartbeat." },
  { tag: "03 · AI runtime builder", title: "Say it. Preview it. Deploy it.", text: "Ask for a new instrument, a script or a different orbit in plain language. The system plans it from live capabilities, tests it in isolation, shows you the consequences, and deploys on approval." },
  { tag: "04 · Research record", title: "Nothing learned is lost", text: "Problems, hypotheses, trade studies, simulations and outcomes are recorded with their provenance and evidence level, and stay searchable for the next team." },
];
const STEPS = [
  ["CML 1", "Cocktail Napkin", "Read the science questions. Sketch the concept."],
  ["CML 2", "Initial Feasibility", "First-order numbers: does the orbit, power and link close?"],
  ["CML 3", "Trade Space", "Sweep altitude against resolution, eclipse and cost. Find the partials."],
  ["CML 4", "Point Design", "Commit to a design with margins. Fly it through a simulated year."],
  ["Review", "Submit", "Hold a concept review, submit, and see where you rank."],
];

export default function Landing() {
  const [account, setAccount] = useState<Account | null>(null);
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [body, setBody] = useState<"moon" | "earth" | "mars">("moon");
  const [board, setBoard] = useState<any[]>([]);
  useEffect(() => {
    void api("GET", "/api/scenarios").then(setScenarios).catch(() => undefined);
    void api("GET", "/api/leaderboard").then((b) => setBoard(b.slice(0, 3))).catch(() => undefined);
  }, []);
  const start = account ? "/lobby" : "/auth?next=/lobby";

  return (
    <div className="page">
      <Backdrop variant="hero" body={body} />
      <div className="content">
        <Nav onAccount={setAccount} />
        <header className="hero container">
          <div className="eyebrow fade-in">NASA Space Apps 2026 · Space Mission Design Game</div>
          <h1 className="fade-in delay-1" style={{ marginTop: 18 }}>
            Design the mission. <em>Together.</em>
          </h1>
          <p className="lede fade-in delay-2">
            A collaborative mixed-reality lab where four engineers shape one spacecraft — orbit, power, communications and science — against real engineering models, with an AI that builds what you ask for and shows its work.
          </p>
          <div className="row wrap fade-in delay-3" style={{ marginTop: 34, gap: 14 }}>
            <a className="btn primary lg" href={start}>Enter the lab</a>
            <a className="btn lg ghost" href="#missions">Browse missions</a>
          </div>
          <div className="row wrap fade-in delay-4" style={{ marginTop: 56, gap: 44 }}>
            <div><div className="stat">4+</div><div className="dim">engineers per mission, live</div></div>
            <div><div className="stat">12</div><div className="dim">engineering models, recalculated on every change</div></div>
            <div><div className="stat">CML 1→5</div><div className="dim">concept maturity, assessed as you go</div></div>
          </div>
        </header>

        <section className="container" style={{ paddingBottom: 90 }}>
          <div className="grid cols-2">
            {FEATURES.map((f) => (
              <article key={f.tag} className="glass feature">
                <div className="eyebrow">{f.tag}</div>
                <h4>{f.title}</h4>
                <p className="dim">{f.text}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="missions" className="container" style={{ paddingBottom: 90 }}>
          <div className="eyebrow">Missions</div>
          <h2 style={{ fontSize: 34, margin: "10px 0 22px" }}>Pick a destination</h2>
          <div className="grid cols-3">
            {scenarios.map((s) => (
              <a key={s.id} className={`glass scenario-card ${body === s.destination ? "selected" : ""}`} href={account ? `/lobby?scenario=${s.id}` : `/auth?next=/lobby?scenario=${s.id}`} onMouseEnter={() => setBody(s.destination)} style={{ color: "inherit", textDecoration: "none" }}>
                <div className={`orb ${s.destination}`} />
                <div className="eyebrow">{s.destination}</div>
                <h3 style={{ fontSize: 20, margin: "10px 0 8px", maxWidth: "14ch" }}>{s.title}</h3>
                <p className="dim" style={{ minHeight: 44 }}>{s.tagline}</p>
                <div className="row wrap" style={{ marginTop: 14 }}>
                  <span className="chip">{s.objectives.length} objectives</span>
                  <span className="chip">{s.disciplines.length} seats</span>
                  <span className="chip">{s.catalogSize} components</span>
                </div>
              </a>
            ))}
            {scenarios.length === 0 && <div className="glass card dim">Missions load from the platform server. Start it with <span className="mono">npm run dev</span>.</div>}
          </div>
        </section>

        <section className="container" style={{ paddingBottom: 90 }}>
          <div className="eyebrow">How a concept matures</div>
          <h2 style={{ fontSize: 34, margin: "10px 0 22px" }}>The way mission architects actually work</h2>
          <div className="glass card" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 18 }}>
            {STEPS.map(([k, name, text], i) => (
              <div key={k} className="fade-in" style={{ animationDelay: `${i * 0.07}s` }}>
                <div className="mono" style={{ color: "var(--amber)", fontSize: 12, letterSpacing: "0.14em" }}>{k}</div>
                <div style={{ fontSize: 16, fontWeight: 600, margin: "4px 0" }}>{name}</div>
                <div className="dim" style={{ fontSize: 13 }}>{text}</div>
              </div>
            ))}
          </div>
          <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>
            Concept Maturity Levels after Wessen et al. (JPL); life-cycle phases after the NASA Systems Engineering Handbook. The in-game assessment is a teaching aid, not a formal review.
          </p>
        </section>

        {board.length > 0 && (
          <section className="container" style={{ paddingBottom: 90 }}>
            <div className="eyebrow">Leaderboard</div>
            <div className="glass card" style={{ marginTop: 14 }}>
              <table className="data">
                <tbody>
                  {board.map((b) => (
                    <tr key={b.id}>
                      <td className="mono" style={{ width: 40, color: "var(--amber)" }}>#{b.rank}</td>
                      <td>{b.sessionName}<div className="dim">{b.scenarioTitle}</div></td>
                      <td className="mono">{b.score.toFixed(1)}</td>
                      <td><span className="chip info">{b.grade}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <a className="btn ghost sm" style={{ marginTop: 12 }} href="/leaderboard">Full leaderboard</a>
            </div>
          </section>
        )}

        <footer className="container faint" style={{ padding: "30px 24px 50px", fontSize: 12, borderTop: "1px solid var(--line)" }}>
          Built for the NASA International Space Apps Challenge 2026. An independent project — not affiliated with or endorsed by NASA. Engineering models are first-order approximations with stated assumptions; cost figures use a game cost model.
        </footer>
      </div>
    </div>
  );
}
