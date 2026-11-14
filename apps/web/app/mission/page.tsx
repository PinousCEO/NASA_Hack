"use client";
/**
 * The mission workspace. One page serves the desktop browser and the headset: the 3D
 * stage is an IWSDK world, the HUD is DOM on desktop and spatial panels in XR, and both
 * are driven by the same authoritative snapshot over the same WebSocket.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiPanel, AnalysisPanel, type Ctx, DesignPanel, EvaluationDashboard, LogPanel, ObjectivesPanel, ReviewPanel } from "@/components/MissionPanels";
import { type Account, api, currentAccount, type Evaluation, fmt, type Presence, type Snapshot } from "@/lib/api";
import { Collab } from "@/lib/collab";
import type { ViewMode } from "@/lib/scene/MissionScene";
import type { SpatialStatus, Workspace, XrSupport } from "@/lib/xr/workspace";

const PHASES = ["concept", "trade", "design", "review", "submitted"];
type Toast = { id: number; message: string; tone: string; out?: boolean };
type Tab = "design" | "ai" | "analysis" | "review" | "log";

/** Headline metrics, each tied to the engineering model that produces it (so it can pulse when recalculated). */
function metrics(snap: Snapshot): { node: string; k: string; v: string; u: string; tone?: string }[] {
  const d = (id: string): any => snap.mission.derived[id]?.value ?? {};
  const bad = (cond: boolean): string | undefined => (cond ? "bad" : undefined);
  const [el, ecl, pw, link, data, mass, cost, rover] = ["orbit.elements", "orbit.eclipse", "power.budget", "comms.link", "data.budget", "mass.budget", "cost.budget", "rover.performance"].map(d);
  return [
    { node: "orbit.elements", k: "Altitude", v: fmt(el.periapsisAltitudeKm), u: "km" },
    { node: "orbit.elements", k: "Period", v: fmt(el.periodS / 60), u: "min" },
    { node: "orbit.eclipse", k: "Eclipse", v: fmt(ecl.eclipseFraction * 100), u: `% · β ${fmt(ecl.betaDeg)}°` },
    { node: "power.budget", k: "Power margin", v: fmt(pw.marginW), u: "W", tone: bad(pw.marginW < 0) },
    { node: "power.budget", k: "Battery DoD", v: pw.depthOfDischarge === null ? "–" : fmt(pw.depthOfDischarge * 100), u: "%", tone: bad(!pw.batteryAdequate) },
    { node: "comms.link", k: "Link margin", v: fmt(link.worstMarginDb), u: "dB", tone: bad(link.worstMarginDb !== null && link.worstMarginDb < 0) },
    { node: "data.budget", k: "Data return", v: fmt(data.returnedGbPerDay), u: "Gb/day" },
    { node: "mass.budget", k: "Mass margin", v: fmt(mass.marginKg), u: "kg", tone: bad(mass.marginKg !== null && mass.marginKg < 0) },
    { node: "cost.budget", k: "Cost margin", v: fmt(cost.marginMusd), u: "$M", tone: bad(cost.marginMusd !== null && cost.marginMusd < 0) },
    ...(snap.mission.config.rover ? [{ node: "rover.performance", k: "Rover slope margin", v: fmt(rover.slopeMarginDeg), u: "°", tone: bad(rover.slopeMarginDeg < 0) }] : []),
  ];
}

export default function MissionPage() {
  const [sid, setSid] = useState<string | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [presence, setPresence] = useState<Presence[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [proposals, setProposals] = useState<any[]>([]);
  const [link, setLink] = useState<{ status: string; detail?: string }>({ status: "connecting" });
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("design");
  const [mode, setMode] = useState<ViewMode>("orbit");
  const [selected, setSelected] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pulsed, setPulsed] = useState<{ nodes: string[]; key: number }>({ nodes: [], key: 0 });
  const [previewDay, setPreviewDayState] = useState<number | null>(null);
  const [xr, setXr] = useState<{ support: XrSupport | null; active: boolean; mode: "ar" | "vr" | null }>({ support: null, active: false, mode: null });
  const [dashboard, setDashboard] = useState<{ evaluation: Evaluation; submission?: any } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [you, setYou] = useState<any>(null);

  const stage = useRef<HTMLDivElement>(null);
  const collab = useRef<Collab | null>(null);
  const workspace = useRef<Workspace | null>(null);
  const snapRef = useRef<Snapshot | null>(null);
  const youRef = useRef<any>(null);
  const toastId = useRef(0);
  snapRef.current = snap;
  youRef.current = you;

  const toast = useCallback((message: string, tone = "info") => {
    const id = ++toastId.current;
    setToasts((t) => [...t.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.map((x) => (x.id === id ? { ...x, out: true } : x))), 4600);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);

  const reloadLists = useCallback(() => {
    const id = collab.current?.sessionId;
    if (!id) return;
    void api("GET", `/api/sessions/${id}/requests`).then((r) => setRequests(r.slice(0, 20))).catch(() => undefined);
    void api("GET", `/api/sessions/${id}/proposals`).then(setProposals).catch(() => undefined);
  }, []);

  const setPreviewDay = useCallback((day: number | null) => {
    setPreviewDayState(day);
    workspace.current?.scene.setPreviewDay(day);
  }, []);

  // ---------- boot: account, session membership, collaboration channel ----------
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("s");
    if (!id) { window.location.href = "/lobby"; return; }
    setSid(id);
    let cancelled = false;
    void (async () => {
      const acc = await currentAccount();
      if (cancelled) return;
      if (!acc) { window.location.href = `/auth?next=${encodeURIComponent(`/mission?s=${id}`)}`; return; }
      setAccount(acc);
      try {
        // Not a member yet? Public missions can be joined directly from their link.
        const listed = (await api<any[]>("GET", "/api/sessions")).find((s) => s.id === id);
        if (!listed) return setError("This mission does not exist, or it is invite-only. Ask its lead for the invite code and join from the mission list.");
        if (!listed.isMember) await api("POST", `/api/sessions/${id}/join`, {});
      } catch (err: any) {
        return setError(err.message);
      }
      const first = await api<Snapshot>("GET", `/api/sessions/${id}`);
      if (cancelled) return;
      setSnap(first);
      setYou(first.you);
      const channel = new Collab(id, {
        snapshot: (s) => {
          setSnap((prev) => ({ ...(prev ?? first), ...s, inviteCode: prev?.inviteCode ?? first.inviteCode }));
          setYou((prev: any) => ({ ...prev, ...s.you, role: s.you.role }));
          if (s.resumed && s.missed.length) toast(`Reconnected. While you were away: ${s.missed.map((m: any) => `${m.by} — ${m.note}`).slice(-3).join("; ")}`, "info");
        },
        version: (u) => {
          setSnap((prev) => prev && { ...prev, mission: u.mission, checks: u.checks, evaluation: u.evaluation, maturity: u.maturity, versions: [...prev.versions, { version: u.mission.version, note: u.mission.note, publishedBy: u.mission.publishedBy, publishedAt: u.mission.publishedAt, recalculated: u.mission.recalculated }].slice(-40) });
          setPulsed({ nodes: u.mission.recalculated, key: u.mission.version });
          workspace.current?.scene.pulse();
          const mine = u.cause.by === acc.id;
          toast(`${mine ? "You" : u.cause.displayName} · ${u.cause.summary} — ${u.mission.recalculated.length} model${u.mission.recalculated.length === 1 ? "" : "s"} recalculated`, mine ? "ok" : "info");
        },
        game: (u) => setSnap((prev) => prev && { ...prev, game: u.game, evaluation: u.evaluation, maturity: u.maturity }),
        members: (members) => {
          setSnap((prev) => prev && { ...prev, session: { ...prev.session, members } });
          const me = members.find((m: any) => m.accountId === acc.id);
          if (me) setYou((prev: any) => ({ ...prev, ...me }));
        },
        presence: setPresence,
        presenceUpdate: (p) => setPresence((list) => (list.some((x) => x.clientId === p.clientId) ? list.map((x) => (x.clientId === p.clientId ? { ...x, ...p } : x)) : [...list, p])),
        locks: (locks) => setSnap((prev) => prev && { ...prev, locks }),
        request: (r) => setRequests((list) => [r, ...list.filter((x) => x.id !== r.id)].slice(0, 20)),
        proposal: (p) => setProposals((list) => [p, ...list.filter((x) => x.id !== p.id)]),
        transform: (t) => workspace.current?.scene.previewTransform(t.nodeId, t.pose),
        status: (status, detail) => setLink({ status, detail }),
      });
      collab.current = channel;
      await channel.connect();
      reloadLists();
    })();
    return () => {
      cancelled = true;
      collab.current?.close();
    };
  }, [toast, reloadLists]);

  // ---------- 3D stage (IWSDK world) ----------
  useEffect(() => {
    if (!snap || workspace.current || !stage.current) return;
    let disposed = false;
    void (async () => {
      const { createWorkspace, installEmulator } = await import("@/lib/xr/workspace");
      // `?iwer=1` installs a software Quest 3 for development and automated checks.
      if (new URLSearchParams(window.location.search).get("iwer") === "1") await installEmulator();
      const ws = await createWorkspace(stage.current!, {
        collab: () => collab.current,
        canEdit: () => youRef.current?.role !== "viewer" && !snapRef.current?.game.submitted,
        onSelect: (id) => { setSelected(id); if (id) setTab("design"); },
        onXrChange: (active, m) => setXr((x) => ({ ...x, active, mode: m })),
        notify: toast,
        onAction: (a) => {
          const id = collab.current?.sessionId;
          if (!id) return;
          const run = (p: Promise<unknown>): void => void p.then(reloadLists).catch((e) => toast(e.message, "warn"));
          if (a.type === "simulate") run(api("POST", `/api/sessions/${id}/simulate`, {}));
          else if (a.type === "request") run(api("POST", `/api/sessions/${id}/requests`, { text: a.text }));
          else if (a.type === "catalog") run(api("POST", `/api/sessions/${id}/catalog`, { itemId: a.itemId }));
          else run(api("POST", `/api/sessions/${id}/proposals/${a.proposalId}/${a.approve ? "approve" : "reject"}`, { reason: a.approve ? "Approved in XR" : "Rejected in XR" }));
        },
      });
      if (disposed) return ws.dispose();
      workspace.current = ws;
      (window as any).__workspace = ws; // exposed for automated checks
      ws.scene.setMission(snapRef.current!.mission);
      ws.refresh();
      setXr((x) => ({ ...x, support: ws.support }));
    })().catch((err) => toast(`3D view could not start: ${err.message}`, "bad"));
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(snap)]);
  useEffect(() => () => { workspace.current?.dispose(); workspace.current = null; }, []);

  // Authoritative state → scene and spatial UI.
  useEffect(() => {
    const ws = workspace.current;
    if (!ws || !snap) return;
    ws.scene.setMission(snap.mission);
    ws.refresh();
  }, [snap?.mission.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { workspace.current?.scene.setPresence(presence, presence.find((p) => p.accountId === account?.id && p.mode === (xr.active ? "xr" : "desktop"))?.clientId ?? null); }, [presence, account, xr.active]);
  useEffect(() => { workspace.current?.setMode(mode); }, [mode]);

  const tiles = useMemo(() => (snap ? metrics(snap) : []), [snap]);
  useEffect(() => {
    const ws = workspace.current;
    if (!ws || !snap) return;
    const pending = proposals.find((p) => p.status === "awaiting_approval");
    const latest = requests[0];
    const status: SpatialStatus = {
      title: snap.mission.config.meta.name,
      lines: [
        { k: "Score", v: `${snap.evaluation.score.toFixed(1)} · ${snap.evaluation.grade}` },
        { k: "Maturity", v: `CML ${snap.maturity.level} · ${snap.game.phase}` },
        ...tiles.filter((t) => ["Power margin", "Link margin", "Data return", "Mass margin", "Cost margin"].includes(t.k)).map((t) => ({ k: t.k, v: `${t.v} ${t.u}`, tone: (t.tone ?? "ok") as "ok" | "bad" })),
      ],
      footer: `v${snap.mission.version} · ${presence.length} participant${presence.length === 1 ? "" : "s"} · ${snap.checks.filter((c) => c.status === "fail").length} constraint(s) violated`,
      quick: snap.scenario.catalog.filter((i: any) => i.discipline === "payload").slice(0, 3).map((i: any) => ({ label: `Add ${i.label.split(" · ")[0]}`, action: { type: "catalog" as const, itemId: i.id } })).concat([{ label: "Compute the link budget", action: { type: "request" as const, text: "Compute the link budget" } as any }]),
      pending: pending ? { proposalId: pending.id, summary: requests.find((r) => r.proposalId === pending.id)?.text ?? "change", canApprove: you?.role === "lead" || (you?.role === "engineer" && pending.requiredRole === "engineer") } : null,
      activity: latest ? `${latest.text} — ${String(latest.status).replace(/_/g, " ")}` : "Grab a slider or a component, or use a quick command.",
    };
    ws.setSpatialStatus(status);
  }, [snap, tiles, proposals, requests, presence, you]);

  if (error) return <div className="page center" style={{ minHeight: "100vh" }}><div className="glass card" style={{ maxWidth: 420 }}><h2>Cannot open this mission</h2><p className="dim" style={{ margin: "10px 0" }}>{error}</p><a className="btn" href="/lobby">Back to missions</a></div></div>;

  const ctx: Ctx | null = snap && collab.current && account && sid ? { sid, snap, collab: collab.current, role: you?.role ?? "viewer", accountId: account.id, presence, requests, proposals, selected, setSelected, toast, setPreviewDay, reloadLists } : null;
  const phaseIndex = snap ? PHASES.indexOf(snap.game.phase) : 0;
  const duration = snap?.mission.config.meta.missionDurationDays ?? 365;
  const support = xr.support;

  return (
    <div className="workspace">
      <div className="stage" ref={stage} />
      {!snap && <div className="center" style={{ position: "absolute", inset: 0 }}><div className="row"><span className="spinner" /><span className="dim">Establishing link to mission control…</span></div></div>}
      {snap && ctx && !xr.active && (
        <div className={`hud ${collapsed ? "collapsed-left" : ""}`}>
          <header className="glass top">
            <a className="brand" href="/lobby" title="Back to missions"><span className="brand-mark" /></a>
            <div className="grow">
              <div style={{ fontWeight: 600, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{snap.session.name}</div>
              <div className="dim" style={{ fontSize: 11 }}>{snap.scenario.title} · {snap.session.difficulty} · seed {snap.session.seed}</div>
            </div>
            <div className="phase">{PHASES.map((p, i) => <span key={p} className={`step ${i < phaseIndex ? "done" : i === phaseIndex ? "now" : ""}`}>{p}</span>)}</div>
            <button className="score-ring" style={{ ["--p" as any]: snap.evaluation.score, border: 0, cursor: "pointer" }} title="Open the evaluation dashboard" onClick={() => setDashboard({ evaluation: snap.evaluation })}><span>{snap.evaluation.score.toFixed(0)}</span></button>
            <span className="chip info" title={snap.maturity.basis}>CML {snap.maturity.level}</span>
            <span className="chip mono" key={snap.mission.version} style={{ animation: "recalc 1.2s" }}>v{snap.mission.version}</span>
            <div className="row" style={{ paddingLeft: 6 }}>{presence.map((p) => <span key={p.clientId} className="avatar" style={{ background: p.color }} title={`${p.displayName} · ${p.mode === "xr" ? "in headset" : "desktop"}${p.focus ? ` · editing ${p.focus}` : ""}`}>{p.mode === "xr" ? "◉" : p.displayName.slice(0, 2).toUpperCase()}</span>)}</div>
            <span className={`chip ${link.status === "live" ? "ok" : "warn"}`} title={link.detail}><span className={`dot ${link.status === "live" ? "live" : ""}`} />{link.status}{collab.current?.latencyMs ? ` · ${collab.current.latencyMs.toFixed(0)} ms` : ""}</span>
            <div className="tabs" style={{ width: 170 }}>
              <button className={`tab ${mode === "orbit" ? "active" : ""}`} onClick={() => setMode("orbit")}>Orbit</button>
              <button className={`tab ${mode === "systems" ? "active" : ""}`} onClick={() => setMode("systems")}>Systems</button>
            </div>
            {support?.immersiveAr && <button className="btn primary sm" onClick={() => workspace.current?.enterXr("ar")}>Enter MR</button>}
            {support?.immersiveVr && <button className={`btn sm ${support.immersiveAr ? "" : "primary"}`} onClick={() => workspace.current?.enterXr("vr")}>Enter VR</button>}
            {support && !support.immersiveAr && !support.immersiveVr && <span className="chip" title={support.reason ?? ""} style={{ cursor: "help" }}>Desktop mode · XR unavailable</span>}
          </header>

          <aside className="glass left"><ObjectivesPanel c={ctx} /></aside>
          <div className="mid">
            <button className="btn sm ghost" style={{ position: "absolute", left: 0, top: 0, pointerEvents: "auto" }} onClick={() => setCollapsed(!collapsed)}>{collapsed ? "▸ Objectives" : "◂"}</button>
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 8, pointerEvents: "auto" }}>
              {tiles.map((t) => (
                <div key={`${t.k}:${pulsed.nodes.includes(t.node) ? pulsed.key : 0}`} className={`metric glass ${pulsed.nodes.includes(t.node) ? "pulse" : ""}`} title={`From model: ${t.node}`}>
                  <div className="k">{t.k}</div><div className="v" style={{ color: t.tone === "bad" ? "var(--red)" : undefined }}>{t.v}<span className="u">{t.u}</span></div>
                </div>
              ))}
            </div>
          </div>
          <aside className="glass right">
            <div className="tabs">{(["design", "ai", "analysis", "review", "log"] as Tab[]).map((t) => <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t === "ai" ? `AI${proposals.some((p) => p.status === "awaiting_approval") ? " •" : ""}` : t}</button>)}</div>
            {tab === "design" && <DesignPanel c={ctx} />}
            {tab === "ai" && <AiPanel c={ctx} />}
            {tab === "analysis" && <AnalysisPanel c={ctx} previewDay={previewDay} />}
            {tab === "review" && <ReviewPanel c={ctx} onSubmitted={(evaluation, submission) => setDashboard({ evaluation, submission })} />}
            {tab === "log" && <LogPanel c={ctx} />}
          </aside>

          <footer className="glass bottom">
            <div className="row">
              <span className="eyebrow" style={{ whiteSpace: "nowrap" }}>Mission timeline</span>
              <input type="range" min={0} max={duration} step={1} value={previewDay ?? 0} onChange={(e) => setPreviewDay(Number(e.target.value) || null)} title="Preview Sun geometry on a later mission day" />
              <span className="mono" style={{ width: 210, textAlign: "right", fontSize: 12, whiteSpace: "nowrap" }}>{previewDay ? `day ${previewDay} · preview` : `day 0 · ${snap.mission.config.missionTime.slice(0, 10)}`}</span>
              {previewDay !== null && previewDay > 0 && <>
                <button className="btn sm" disabled={ctx.role === "viewer" || Boolean(snap.game.submitted)} onClick={() => { const date = new Date(Date.parse(snap.mission.config.missionTime) + previewDay * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z"); void collab.current!.edit([{ op: "set", path: "missionTime", value: date }], `Mission date → ${date.slice(0, 10)}`).then((r) => { if (!r.ok) toast(r.detail ?? "Not accepted", "warn"); setPreviewDay(null); }); }}>Set as mission date</button>
                <button className="btn sm ghost" onClick={() => setPreviewDay(null)}>Reset</button>
              </>}
            </div>
            {previewDay ? <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>Preview rotates the Sun about the ecliptic pole to show the eclipse arc on that day. Numbers update when the date is set — or run the mission simulation for the whole year.</div> : null}
          </footer>
        </div>
      )}
      {xr.active && <div style={{ position: "absolute", left: 16, bottom: 16, zIndex: 6 }} className="glass card"><b>{xr.mode === "ar" ? "Mixed reality" : "VR"} session active</b><div className="dim">The workspace is on your headset. <button className="btn sm" onClick={() => workspace.current?.exitXr()}>Exit XR</button></div></div>}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`glass toast ${t.out ? "out" : ""}`}><span className={`chip ${t.tone === "info" ? "info" : t.tone}`}><span className="dot" /></span><span>{t.message}</span></div>)}</div>
      {dashboard && snap && <EvaluationDashboard evaluation={dashboard.evaluation} submission={dashboard.submission} title={snap.session.name} onClose={() => setDashboard(null)} />}
    </div>
  );
}
