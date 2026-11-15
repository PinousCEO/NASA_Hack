"use client";
import { useEffect, useState } from "react";
import Backdrop from "@/components/Backdrop";
import Nav from "@/components/Nav";
import { api, dayText } from "@/lib/api";

export default function Leaderboard() {
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [filter, setFilter] = useState({ scenario: "", difficulty: "", brief: "" });
  const [briefs, setBriefs] = useState<any[]>([]);
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    void api("GET", "/api/scenarios").then(setScenarios).catch(() => undefined);
    void api("GET", "/api/briefs").then((feed) => setBriefs(feed.briefs)).catch(() => undefined);
    const brief = new URLSearchParams(window.location.search).get("brief");
    if (brief) setFilter((f) => ({ ...f, brief }));
  }, []);
  useEffect(() => {
    const q = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
    void api("GET", `/api/leaderboard?${q}`).then(setRows).catch(() => setRows([]));
  }, [filter]);
  const top = rows?.slice(0, 3) ?? [];

  return (
    <div className="page">
      <Backdrop variant="ambient" body={(scenarios.find((s) => s.id === filter.scenario)?.destination as any) ?? "mars"} />
      <div className="content">
        <Nav />
        <main className="container" style={{ paddingBottom: 80 }}>
          <div className="eyebrow fade-in">Submitted missions</div>
          <h1 className="fade-in delay-1" style={{ fontSize: 40, margin: "10px 0 20px" }}>Leaderboard</h1>
          <div className="row wrap fade-in delay-2" style={{ marginBottom: 18 }}>
            <select className="input" style={{ width: 300 }} value={filter.scenario} onChange={(e) => setFilter({ ...filter, scenario: e.target.value })}>
              <option value="">All missions</option>
              {scenarios.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
            <select className="input" style={{ width: 300 }} value={filter.brief} onChange={(e) => setFilter({ ...filter, brief: e.target.value })}>
              <option value="">All briefs</option>
              {briefs.map((b) => <option key={b.id} value={b.id}>{b.title}{b.crews ? ` · ${b.crews} crew${b.crews === 1 ? "" : "s"}` : ""}</option>)}
            </select>
            <select className="input" style={{ width: 200 }} value={filter.difficulty} onChange={(e) => setFilter({ ...filter, difficulty: e.target.value })}>
              <option value="">All difficulties</option><option value="cadet">Cadet</option><option value="engineer">Engineer</option><option value="chief">Chief Engineer</option>
            </select>
          </div>
          {top.length > 0 && (
            <div className="grid cols-3" style={{ marginBottom: 18 }}>
              {top.map((r, i) => (
                <div key={r.id} className="glass card fade-in" style={{ animationDelay: `${i * 0.1}s`, borderColor: i === 0 ? "rgba(255,209,102,0.55)" : undefined }}>
                  <div className="row between"><span className="eyebrow" style={{ color: i === 0 ? "var(--amber)" : undefined }}>Rank {r.rank}</span><span className="chip info">CML {r.cml}</span></div>
                  <div className="grade" style={{ fontSize: 56, margin: "8px 0" }}>{r.score.toFixed(1)}</div>
                  <b>{r.sessionName}</b>
                  <div className="dim">{r.briefTitle ?? r.scenarioTitle} · {r.difficulty}</div>
                  <div className="row wrap" style={{ marginTop: 10 }}>{r.team.map((m: any) => <span key={m.displayName} className="chip">{m.displayName}{m.discipline ? ` · ${m.discipline.replace(/_/g, " ")}` : ""}</span>)}</div>
                </div>
              ))}
            </div>
          )}
          <div className="glass card">
            {rows === null ? <div className="spinner" /> : rows.length === 0 ? <p className="dim">No submissions yet. Complete a mission to appear here.</p> : (
              <table className="data">
                <thead><tr><th>#</th><th>Team</th><th>Mission</th><th>Score</th><th>Grade</th><th>Science</th><th>Engineering</th><th>Programme</th><th>CML</th><th>Submitted</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.rank}</td>
                      <td><b>{r.sessionName}</b><div className="dim">{r.team.length} member{r.team.length === 1 ? "" : "s"}</div></td>
                      <td>{r.briefTitle ?? r.scenarioTitle}<div className="dim">{r.briefTitle ? `${r.scenarioTitle} · ` : ""}{r.difficulty} · seed {r.seed}</div></td>
                      <td className="mono" style={{ fontSize: 15 }}>{r.score.toFixed(1)}</td>
                      <td><span className="chip info">{r.grade}</span></td>
                      {["science", "engineering", "programmatic"].map((c) => <td key={c} className="mono">{r.categories[c].earned.toFixed(0)}/{r.categories[c].possible}</td>)}
                      <td className="mono">{r.cml}</td>
                      <td className="dim">{dayText(r.submittedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {filter.brief && <p className="dim" style={{ marginTop: 12, fontSize: 13 }}>Every crew on this board flew the same brief: same problem, same limits, same in-flight events.</p>}
          <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>Scores are computed deterministically from the engineering models, the mission simulation and the recorded design process. Each entry stores a hash of the submitted configuration.</p>
        </main>
      </div>
    </div>
  );
}
