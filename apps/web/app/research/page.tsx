"use client";
import { useEffect, useState } from "react";
import Backdrop from "@/components/Backdrop";
import Nav from "@/components/Nav";
import { type Account, api } from "@/lib/api";

const KINDS = ["mission_problem", "hypothesis", "user_contribution", "design_change", "trade_study", "simulation_result", "tool_execution", "scientific_evidence", "validation_report", "ai_evaluation", "failure", "mission_outcome"];
const tone = (v: string): string => (v === "model_judgment" || v === "unverified" ? "warn" : v === "heuristic" ? "" : "ok");

export default function Research() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [tab, setTab] = useState<"records" | "knowledge">("records");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [records, setRecords] = useState<{ total: number; records: any[] } | null>(null);
  const [hits, setHits] = useState<any[]>([]);
  const [context, setContext] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const [open, setOpen] = useState<any>(null);

  useEffect(() => {
    if (account === null) window.location.href = "/auth?next=/research";
    if (account) void api("GET", "/api/knowledge/status").then(setStatus).catch(() => undefined);
  }, [account]);
  useEffect(() => {
    if (!account) return;
    const timer = setTimeout(() => {
      if (tab === "records") void api("GET", `/api/research?${new URLSearchParams({ ...(q ? { q } : {}), ...(kind ? { kind } : {}) })}`).then(setRecords).catch(() => undefined);
      else if (q.trim()) {
        void api("GET", `/api/knowledge/search?${new URLSearchParams({ q, k: "10" })}`).then(setHits).catch(() => undefined);
        void api("POST", "/api/knowledge/context", { query: q, k: 4 }).then(setContext).catch(() => undefined);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [account, tab, q, kind]);

  return (
    <div className="page">
      <Backdrop variant="ambient" body="earth" />
      <div className="content">
        <Nav onAccount={setAccount} />
        <main className="container" style={{ paddingBottom: 80 }}>
          <div className="eyebrow fade-in">Research knowledge platform</div>
          <h1 className="fade-in delay-1" style={{ fontSize: 40, margin: "10px 0 8px" }}>What every team has learned</h1>
          <p className="dim fade-in delay-2" style={{ maxWidth: "70ch" }}>
            Every problem, hypothesis, design change, tool run, simulation and outcome is recorded with its source and evidence level. The same index answers retrieval queries for AI assistance (RAG) through <span className="mono">/api/knowledge/context</span>.
          </p>
          <div className="row wrap fade-in delay-3" style={{ margin: "20px 0 14px" }}>
            <div className="tabs" style={{ width: 320 }}>
              <button className={`tab ${tab === "records" ? "active" : ""}`} onClick={() => setTab("records")}>Research records</button>
              <button className={`tab ${tab === "knowledge" ? "active" : ""}`} onClick={() => setTab("knowledge")}>Knowledge search</button>
            </div>
            <input className="input grow" placeholder={tab === "records" ? "Search records…  e.g. eclipse power margin" : "Ask the knowledge base…  e.g. what is a point design?"} value={q} onChange={(e) => setQ(e.target.value)} />
            {tab === "records" && (
              <select className="input" style={{ width: 220 }} value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">All record kinds</option>
                {KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
              </select>
            )}
          </div>

          {tab === "records" ? (
            <div className="glass card">
              <div className="row between" style={{ marginBottom: 8 }}><h3 style={{ margin: 0 }}>Records</h3><span className="dim mono">{records?.total ?? 0} total</span></div>
              <table className="data">
                <thead><tr><th>Kind</th><th>Summary</th><th>Evidence</th><th>Mission</th><th>When</th></tr></thead>
                <tbody>
                  {(records?.records ?? []).map((r) => (
                    <tr key={r.id} style={{ cursor: "pointer" }} onClick={() => void api("GET", `/api/research/${r.id}`).then(setOpen)}>
                      <td><span className="chip info">{r.kind.replace(/_/g, " ")}</span></td>
                      <td>{r.summary}</td>
                      <td><span className={`chip ${tone(r.verification)}`}>{r.verification.replace(/_/g, " ")}</span></td>
                      <td className="dim">{r.missionName} v{r.missionVersion}</td>
                      <td className="dim mono">{new Date(r.createdAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {records?.records.length === 0 && <p className="dim" style={{ marginTop: 10 }}>No records match. Play a mission to generate research records.</p>}
            </div>
          ) : (
            <div className="grid cols-2" style={{ alignItems: "start" }}>
              <div className="glass card">
                <h3>Passages</h3>
                {hits.length === 0 && <p className="dim">Type a question to retrieve passages from NASA references, ingested documents and research records.</p>}
                <div className="stack">
                  {hits.map((h) => (
                    <div key={h.passage.id} className="metric">
                      <div className="row between"><span className="chip info">{h.passage.kind}</span><span className="mono dim">score {h.score.toFixed(2)}</span></div>
                      <p style={{ margin: "8px 0", fontSize: 13 }}>{h.passage.text.slice(0, 420)}{h.passage.text.length > 420 ? "…" : ""}</p>
                      <div className="row between"><span className="dim" style={{ fontSize: 12 }}>{h.passage.source.title}{h.passage.source.locator ? `, ${h.passage.source.locator}` : ""}</span><span className={`chip ${tone(h.passage.verification)}`}>{h.passage.verification.replace(/_/g, " ")}</span></div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="stack">
                <div className="glass card">
                  <h3>RAG context block</h3>
                  <p className="dim" style={{ fontSize: 12 }}>What a model receives for this query: numbered passages with citations and evidence levels.</p>
                  <pre className="code" style={{ maxHeight: 360 }}>{context?.context || "—"}</pre>
                </div>
                <div className="glass card">
                  <h3>Index</h3>
                  <div className="row wrap">
                    <span className="chip">{status?.references ?? 0} built-in references</span>
                    <span className="chip">{status?.records ?? 0} research records</span>
                    {(status?.documents ?? []).map((d: any) => <span key={d.file} className="chip ok">{d.file} · {d.passages}</span>)}
                    {(status?.skipped ?? []).map((d: any) => <span key={d.file} className="chip warn" title={d.reason}>{d.file} not indexed</span>)}
                  </div>
                  <p className="faint" style={{ fontSize: 12, marginTop: 10 }}>Retrieval is lexical (BM25): deterministic and inspectable. Documents come from the server's Data directory.</p>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
      {open && (
        <div className="modal-veil" onClick={() => setOpen(null)}>
          <div className="glass modal" onClick={(e) => e.stopPropagation()}>
            <div className="row between"><span className="chip info">{open.kind.replace(/_/g, " ")}</span><button className="btn sm ghost" onClick={() => setOpen(null)}>Close</button></div>
            <h2 style={{ margin: "12px 0", fontSize: 20 }}>{open.summary}</h2>
            <div className="row wrap">
              <span className={`chip ${tone(open.verification)}`}>evidence: {open.verification.replace(/_/g, " ")}</span>
              <span className="chip">source: {open.provenance.source}</span>
              {open.provenance.capabilityId && <span className="chip">{open.provenance.capabilityId}@{open.provenance.capabilityVersion}</span>}
              {open.provenance.modelId && <span className="chip warn">model: {open.provenance.modelId}</span>}
              <span className="chip">{open.training.consent ? "training consent given" : "no training consent"}</span>
            </div>
            {open.assumptions.length > 0 && <p className="dim" style={{ marginTop: 10 }}>Assumptions: {open.assumptions.join("; ")}</p>}
            <pre className="code" style={{ maxHeight: 420 }}>{JSON.stringify(open.data, null, 2)}</pre>
          </div>
        </div>
      )}
    </div>
  );
}
