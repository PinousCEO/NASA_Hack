"use client";
import { useEffect, useState } from "react";
import Backdrop from "@/components/Backdrop";
import Nav from "@/components/Nav";
import { go as navigate, type Account, api } from "@/lib/api";

const DIFFICULTY = [
  { id: "cadet", name: "Cadet", text: "Generous budget and mass. No complications." },
  { id: "engineer", name: "Engineer", text: "Nominal allocations, one programme complication." },
  { id: "chief", name: "Chief Engineer", text: "Tight budget and mass. Something will go wrong." },
];

export default function Lobby() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [scenarios, setScenarios] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [selected, setSelected] = useState<string>("lunar-volatiles");
  const [form, setForm] = useState({ name: "", difficulty: "engineer", visibility: "public", policy: "open", discipline: "systems" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState<any>(null);

  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get("scenario");
    if (wanted) setSelected(wanted);
    const briefId = new URLSearchParams(window.location.search).get("brief");
    if (briefId) void api("GET", "/api/briefs").then((feed) => {
      const found = feed.briefs.find((b: any) => b.id === briefId);
      if (found) {
        setBrief(found);
        setSelected(found.template);
      }
    }).catch(() => undefined);
    void api("GET", "/api/scenarios").then(setScenarios).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (account === null) navigate("/auth?next=/lobby");
    if (!account) return;
    const load = (): void => void api("GET", "/api/sessions").then(setSessions).catch(() => undefined);
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [account]);

  const scenario = scenarios.find((s) => s.id === selected);
  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const created = await api("POST", "/api/sessions", { scenarioId: selected, ...form, ...(brief ? { briefId: brief.id } : {}) });
      navigate(`/mission?s=${created.session.id}&new=1`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the mission");
      setBusy(false);
    }
  };
  const join = async (s: any): Promise<void> => {
    try {
      if (!s.isMember) {
        const inviteCode = s.visibility === "invite" ? (window.prompt("Invite code for this mission:") ?? "") : undefined;
        await api("POST", `/api/sessions/${s.id}/join`, { inviteCode });
      }
      navigate(`/mission?s=${s.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join");
    }
  };

  return (
    <div className="page">
      <Backdrop variant="ambient" body={scenario?.destination ?? "moon"} />
      <div className="content">
        <Nav onAccount={setAccount} />
        <main className="container" style={{ paddingBottom: 80 }}>
          <div className="eyebrow fade-in">Mission selection</div>
          <h1 className="fade-in delay-1" style={{ fontSize: 40, margin: "10px 0 24px" }}>{brief ? "Mission brief" : "Choose your mission"}</h1>
          {brief && (
            <div className="glass card" style={{ marginBottom: 18 }}>
              <div className="row between wrap"><h2 style={{ fontSize: 24 }}>{brief.title}</h2><span className={`chip ${brief.origin === "ai" ? "info" : ""}`}>{brief.origin === "ai" ? `AI-written · ${brief.modelId}` : "Built-in"} · {brief.day}</span></div>
              <p style={{ margin: "12px 0 8px", maxWidth: "90ch" }}>{brief.problem}</p>
              <p className="dim" style={{ maxWidth: "90ch" }}>{brief.whyItMatters}</p>
              <ul className="dim" style={{ margin: "10px 0 0", paddingLeft: 18 }}>{brief.scienceQuestions.map((q: string) => <li key={q}>{q}</li>)}</ul>
              <div className="row wrap" style={{ marginTop: 12 }}><span className="chip">Budget ×{brief.constraints.budgetFactor.toFixed(2)}</span><span className="chip">Mass ×{brief.constraints.massFactor.toFixed(2)}</span><span className="chip">Duration ×{brief.constraints.durationFactor.toFixed(2)}</span><a className="btn sm ghost" href="/lobby">Choose a template instead</a></div>
              <p className="faint" style={{ fontSize: 11, marginTop: 10 }}>Played on the engineering baseline selected below. The brief frames the problem; scoring comes from the engineering models.</p>
            </div>
          )}
          <div className="grid cols-3">
            {scenarios.map((s, i) => (
              <button key={s.id} className={`glass scenario-card fade-in ${selected === s.id ? "selected" : ""}`} style={{ animationDelay: `${i * 0.08}s`, color: "inherit" }} onClick={() => setSelected(s.id)}>
                <div className={`orb ${s.destination}`} />
                <div className="eyebrow">{s.destination}</div>
                <h3>{s.title}</h3>
                <p className="dim">{s.tagline}</p>
              </button>
            ))}
          </div>

          {scenario && (
            <div className="grid cols-2 fade-in" style={{ marginTop: 18, alignItems: "start" }} key={scenario.id}>
              <section className="glass card">
                <h3>Mission briefing</h3>
                <div className="stack">{scenario.briefing.map((p: string) => <p key={p} style={{ color: "#c8d2e8" }}>{p}</p>)}</div>
                <hr className="hairline" />
                <h3>Science questions</h3>
                <ul style={{ margin: 0, paddingLeft: 18, color: "#c8d2e8" }}>{scenario.scienceQuestions.map((q: string) => <li key={q}>{q}</li>)}</ul>
                <hr className="hairline" />
                <h3>Objectives</h3>
                <div className="row wrap">{scenario.objectives.map((o: any) => <span key={o.id} className={`chip ${o.category === "science" ? "info" : o.category === "engineering" ? "ok" : "warn"}`} title={o.description}>{o.title} · {o.weight}</span>)}</div>
                <p className="faint" style={{ marginTop: 12, fontSize: 12 }}>References: {scenario.references.join(" · ")}</p>
              </section>
              <section className="glass card stack">
                <h3>Start a new mission</h3>
                <label className="field">Team / mission name<input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={`${scenario.title} — ${account?.displayName ?? ""}`} maxLength={60} /></label>
                <div className="field">Difficulty
                  <div className="grid" style={{ gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
                    {DIFFICULTY.map((d) => (
                      <button key={d.id} type="button" className={`btn ${form.difficulty === d.id ? "" : "ghost"}`} style={{ flexDirection: "column", alignItems: "flex-start", whiteSpace: "normal", textAlign: "left", height: "100%" }} onClick={() => setForm({ ...form, difficulty: d.id })}>
                        <b>{d.name}</b><span className="dim" style={{ fontSize: 11 }}>{d.text}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid cols-2">
                  <label className="field">Your seat
                    <select className="input" value={form.discipline} onChange={(e) => setForm({ ...form, discipline: e.target.value })}>
                      {scenario.disciplines.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </label>
                  <label className="field">Who can join
                    <select className="input" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
                      <option value="public">Anyone signed in</option>
                      <option value="invite">Invite code only</option>
                    </select>
                  </label>
                </div>
                <div className="field">Mode
                  <div className="grid cols-2" style={{ gap: 8 }}>
                    {[["campaign", "Ranked mission", "Fixed limits, phase gates, in-flight events. Submit for a score and a rank."], ["sandbox", "Sandbox", "Every part unlocked and every limit adjustable. For experimenting; not ranked."]].map(([id, name, text]) => (
                      <button key={id} type="button" className={`btn ${(form as any).mode === id || (!(form as any).mode && id === "campaign") ? "" : "ghost"}`} style={{ flexDirection: "column", alignItems: "flex-start", whiteSpace: "normal", textAlign: "left", height: "100%" }} onClick={() => setForm({ ...form, mode: id } as any)}>
                        <b>{name}</b><span className="dim" style={{ fontSize: 11 }}>{text}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <label className="field">Change policy
                  <select className="input" value={form.policy} onChange={(e) => setForm({ ...form, policy: e.target.value })}>
                    <option value="open">Open design — validated changes publish immediately</option>
                    <option value="review">Lead review — significant changes need the lead's approval</option>
                  </select>
                </label>
                <p className="faint" style={{ fontSize: 12 }}>You will be the mission lead. Play solo or bring up to three crewmates (four seats). AI-generated code always needs the lead's approval, whatever the policy.</p>
                {error && <div className="chip bad" style={{ whiteSpace: "normal", borderRadius: 10, padding: "8px 12px" }}>{error}</div>}
                <button className="btn primary lg" disabled={busy || !account} onClick={create}>{busy ? <span className="spinner" /> : "Launch mission"}</button>
              </section>
            </div>
          )}

          <section style={{ marginTop: 40 }}>
            <div className="eyebrow">Active missions</div>
            <div className="glass card" style={{ marginTop: 12 }}>
              {sessions.length === 0 ? <p className="dim">No missions yet. Launch the first one above.</p> : (
                <table className="data">
                  <thead><tr><th>Mission</th><th>Phase</th><th>Crew</th><th>Version</th><th /></tr></thead>
                  <tbody>
                    {sessions.map((s) => (
                      <tr key={s.id}>
                        <td><b>{s.name}</b>{s.mode === "sandbox" && <span className="chip" style={{ marginLeft: 8 }}>sandbox</span>}<div className="dim">{s.briefTitle ?? s.scenarioTitle} · {s.difficulty}</div></td>
                        <td><span className={`chip ${s.submitted ? "ok" : "info"}`}>{s.phase}</span></td>
                        <td className="mono">{s.members}/{s.maxMembers}</td>
                        <td className="mono">v{s.version}</td>
                        <td style={{ textAlign: "right" }}><button className="btn sm" onClick={() => join(s)} disabled={!s.isMember && s.members >= s.maxMembers}>{s.isMember ? "Resume" : s.visibility === "invite" ? "Join with code" : "Join"}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
