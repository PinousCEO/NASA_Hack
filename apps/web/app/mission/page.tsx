"use client";
/**
 * The mission workspace. One page serves the desktop browser and the headset: the 3D
 * stage is an IWSDK world, the HUD is DOM on desktop and spatial panels in XR, and both
 * are driven by the same authoritative snapshot over the same WebSocket.
 */
import { PartCard, SystemsPanel } from "@/components/MissionSystems";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MissionClock } from "@/components/MissionClock";
import { AiQueue, Coach, EXPLAIN, Tutorial, Viewfinder } from "@/components/MissionExtras";
import { DefineMission, DesignsPanel } from "@/components/MissionGame";
import { hintFor, QuestBar } from "@/components/MissionQuest";
import { type CrewEvent, CrewFeed } from "@/components/MissionCrew";
import { AiPanel, AnalysisPanel, type Ctx, DesignPanel, EvaluationDashboard, LogPanel, ObjectivesPanel, ReviewPanel } from "@/components/MissionPanels";
import { go as navigate, type Account, api, currentAccount, type Evaluation, fmt, type Presence, type Snapshot } from "@/lib/api";
import { bus } from "@/lib/bus";
import { Collab } from "@/lib/collab";
import type { ViewMode } from "@/lib/scene/MissionScene";
import { type SiteKind, siteKindFor } from "@/lib/scene/site";
import type { SpatialStatus, Workspace, XrSupport } from "@/lib/xr/workspace";

const PHASES = ["concept", "trade", "design", "review", "submitted"];
type Toast = { id: number; message: string; tone: string; out?: boolean };
type Tab = "design" | "ai" | "analysis" | "designs" | "review" | "log" | "systems";

/** Headline metrics, each tied to the engineering model that produces it (so it can pulse when recalculated). */
/**
 * Put this mission's own place into the scene: its mark on the world, and beside the world a model of the kind of
 * ground it is (dunes, a shadowed crater, fire fronts…) with what the design's camera can tell apart there against
 * what the problem needs to see.
 */
function showPlace(ws: Workspace, snap: Snapshot): void {
  const brief = snap.session.brief;
  const world = snap.session.world;
  const target = world?.target;
  ws.scene.setPing("target", target ? [target.latDeg, target.lonDeg] : null, "#ffb020", target ? `Target · ${target.name}` : "", "this mission's place (approx.)");
  const words = brief ? `${brief.title} ${brief.problem}` : `${snap.scenario.title} ${snap.scenario.tagline}`;
  const sharp = ((snap.scenario as any).objectives ?? []).find((o: any) => o.category === "science" && o.metric?.field === "bestImagingResolutionM");
  const need = sharp ? (snap.evaluation.objectives as any[]).find((o) => o.id === sharp.id)?.target ?? null : null;
  const now = (snap.mission.derived["science.return"]?.value as any)?.bestImagingResolutionM ?? null;
  ws.scene.setSite({ kind: (world?.site as SiteKind | undefined) ?? siteKindFor(words), name: target?.name ?? brief?.title ?? snap.scenario.title, nowM: typeof now === "number" ? now : null, needM: typeof need === "number" ? need : null });
}

function metrics(snap: Snapshot): { node: string; k: string; v: string; u: string; tone?: string }[] {
  const d = (id: string): any => snap.mission.derived[id]?.value ?? {};
  const bad = (cond: boolean): string | undefined => (cond ? "bad" : undefined);
  const [el, ecl, pw, link, data, mass, cost, rover, schedule, launch] = ["orbit.elements", "orbit.eclipse", "power.budget", "comms.link", "data.budget", "mass.budget", "cost.budget", "rover.performance", "schedule.budget", "launch.vehicle"].map(d);
  // Once a launch vehicle is chosen, its capacity is the mass limit that binds.
  const massMargin = launch.selectedId ? launch.marginKg : mass.marginKg;
  return [
    { node: "orbit.elements", k: "Altitude", v: fmt(el.periapsisAltitudeKm), u: "km" },
    { node: "orbit.elements", k: "Period", v: fmt(el.periodS / 60), u: "min" },
    { node: "orbit.eclipse", k: "Eclipse", v: fmt(ecl.eclipseFraction * 100), u: "%" },
    { node: "power.budget", k: "Power margin", v: fmt(pw.marginW), u: "W", tone: bad(pw.marginW < 0) },
    { node: "power.budget", k: "Battery DoD", v: pw.depthOfDischarge === null ? "–" : fmt(pw.depthOfDischarge * 100), u: "%", tone: bad(!pw.batteryAdequate) },
    { node: "comms.link", k: "Link margin", v: fmt(link.worstMarginDb), u: "dB", tone: bad(link.worstMarginDb !== null && link.worstMarginDb < 0) },
    { node: "data.budget", k: "Data return", v: fmt(data.returnedGbPerDay), u: "Gb/day" },
    { node: launch.selectedId ? "launch.vehicle" : "mass.budget", k: "Mass margin", v: fmt(massMargin), u: "kg", tone: bad(massMargin !== null && massMargin < 0) },
    { node: "cost.budget", k: "Cost margin", v: fmt(cost.marginMusd), u: "$M", tone: bad(cost.marginMusd !== null && cost.marginMusd < 0) },
    ...(schedule.marginMonths !== null && schedule.marginMonths !== undefined ? [{ node: "schedule.budget", k: "Schedule margin", v: fmt(schedule.marginMonths), u: "months", tone: bad(schedule.marginMonths < 0) }] : []),
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
  const [tab, setTab] = useState<Tab>("ai");
  const [mode, setMode] = useState<ViewMode>("orbit");
  const [selected, setSelected] = useState<string | null>(null);
  // The headset callbacks are created once; they read the current selection through this.
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pulsed, setPulsed] = useState<{ nodes: string[]; key: number }>({ nodes: [], key: 0 });
  const [previewDay, setPreviewDayState] = useState<number | null>(null);
  const [xr, setXr] = useState<{ support: XrSupport | null; active: boolean; mode: "ar" | "vr" | null }>({ support: null, active: false, mode: null });
  const [dashboard, setDashboard] = useState<{ evaluation: Evaluation; submission?: any } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [you, setYou] = useState<any>(null);
  const [arriving, setArriving] = useState<false | "hold" | "fly">(false);
  const seenRequests = useRef(new Set<string>());
  const [chase, setChase] = useState(false);
  const [earthView, setEarthView] = useState(false);
  const [defining, setDefining] = useState(false);

  const stage = useRef<HTMLDivElement>(null);
  const collab = useRef<Collab | null>(null);
  const workspace = useRef<Workspace | null>(null);
  const snapRef = useRef<Snapshot | null>(null);
  const youRef = useRef<any>(null);
  const lastSaid = useRef<{ who: string; text: string; at: number } | null>(null);
  const [saidTick, setSaidTick] = useState(0);
  const pointing = useRef(new Set<string>());
  // AI crewmates in this mission (software players the lead brought in).
  const [aiCrew, setAiCrew] = useState<{ here: boolean; busy: boolean }>({ here: false, busy: false });
  // What the crew has been doing, newest last: shown beside the stage and (the latest message) in the headset.
  const [feed, setFeed] = useState<CrewEvent[]>([]);
  const note = useCallback((e: Omit<CrewEvent, "id" | "at"> & { id?: string; at?: number }): void => setFeed((list) => (e.id && list.some((x) => x.id === e.id) ? list : [...list, { id: e.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: e.at ?? Date.now(), ...e }].sort((a, b) => a.at - b.at).slice(-60))), []);
  const colorOf = (accountId: string | undefined): string => presenceRef.current.find((p) => p.accountId === accountId)?.color ?? "#9fb0d0";
  const presenceRef = useRef<Presence[]>([]);
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
    void api("GET", `/api/sessions/${id}/requests`).then((r) => setRequests(r.slice(0, 80))).catch(() => undefined);
    void api("GET", `/api/sessions/${id}/proposals`).then(setProposals).catch(() => undefined);
  }, []);

  const setPreviewDay = useCallback((day: number | null) => {
    setPreviewDayState(day);
    const scene = workspace.current?.scene;
    if (!scene) return;
    scene.setClock(scene.missionDateMs + (day ?? 0) * 86400000, 0);
    collab.current?.clock(scene.clockMs, scene.clockRate);
  }, []);
  // The crew's shared clock: who last turned it, and the moment to adopt on arrival.
  const [remoteClock, setRemoteClock] = useState<{ by: string; at: number } | null>(null);
  const arrivalClock = useRef<{ timeMs: number; rate: number; at: number } | null>(null);

  // ---------- boot: account, session membership, collaboration channel ----------
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("s");
    if (!id) { navigate("/lobby"); return; }
    setSid(id);
    let cancelled = false;
    void (async () => {
      const acc = await currentAccount();
      if (cancelled) return;
      if (!acc) { navigate(`/auth?next=${encodeURIComponent(`/mission?s=${id}`)}`); return; }
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
          const shared = (s as any).clock as { timeMs: number; rate: number; at: number } | null;
          if (shared) {
            // Join the crew at the moment they are looking at (carried forward by the time since it was set).
            const now = shared.timeMs + ((Date.now() - shared.at) / 1000) * shared.rate * 1000;
            arrivalClock.current = { ...shared, timeMs: now };
            workspace.current?.scene.setClock(now, shared.rate);
          }
          setSnap((prev) => ({ ...(prev ?? first), ...s, inviteCode: prev?.inviteCode ?? first.inviteCode }));
          setYou((prev: any) => ({ ...prev, ...s.you, role: s.you.role }));
          if (s.resumed && s.missed.length) toast(`Reconnected. While you were away: ${s.missed.map((m: any) => `${m.by} — ${m.note}`).slice(-3).join("; ")}`, "info");
        },
        version: (u) => {
          // A change that breaks the priority of a role someone holds is said out loud: that is where a crew has to talk.
          for (const w of u.roles ?? []) {
            const was = snapRef.current?.roles?.find((x) => x.seat === w.seat);
            if (w.holder && was?.ok && !w.ok) note({ who: w.seat, color: "#ffd166", kind: "did", text: `priority no longer holds: ${w.label} (${w.detail}) after ${u.cause.by === acc.id ? "your" : `${u.cause.displayName}'s`} change: ${u.cause.summary}` });
          }
          setSnap((prev) => prev && { ...prev, mission: u.mission, checks: u.checks, evaluation: u.evaluation, maturity: u.maturity, roles: u.roles ?? prev.roles, versions: [...prev.versions, { version: u.mission.version, note: u.mission.note, publishedBy: u.mission.publishedBy, publishedAt: u.mission.publishedAt, recalculated: u.mission.recalculated }].slice(-40) });
          setPulsed({ nodes: u.mission.recalculated, key: u.mission.version });
          workspace.current?.scene.pulse();
          const mine = u.cause.by === acc.id;
          note({ id: `v${u.mission.version}`, who: mine ? "You" : u.cause.displayName, color: colorOf(u.cause.by), kind: "did", text: u.cause.summary });
          toast(`${mine ? "You" : u.cause.displayName} · ${u.cause.summary} — ${u.mission.recalculated.length} model${u.mission.recalculated.length === 1 ? "" : "s"} recalculated`, mine ? "ok" : "info");
        },
        game: (u) => setSnap((prev) => prev && { ...prev, game: u.game, evaluation: u.evaluation, maturity: u.maturity, roles: u.roles ?? prev.roles }),
        members: (members) => {
          setSnap((prev) => prev && { ...prev, session: { ...prev.session, members } });
          const me = members.find((m: any) => m.accountId === acc.id);
          if (me) setYou((prev: any) => ({ ...prev, ...me }));
        },
        presence: setPresence,
        presenceUpdate: (p) => {
          // A crewmate started pointing at a place: say so once, the mark itself is on the world.
          if (p.point && !pointing.current.has(p.clientId)) { pointing.current.add(p.clientId); note({ who: p.displayName, color: p.color, kind: "points", text: `is pointing at ${Math.abs(p.point[0]!).toFixed(1)}°${p.point[0]! >= 0 ? "N" : "S"} ${Math.abs(p.point[1]!).toFixed(1)}°${p.point[1]! >= 0 ? "E" : "W"}` }); toast(`${p.displayName} is pointing at a place on the ${snapRef.current?.mission.config.centralBody ?? "world"}: look for their mark in the Orbit view.`, "info"); }
          if (p.point === null) pointing.current.delete(p.clientId);
          setPresence((list) => (list.some((x) => x.clientId === p.clientId) ? list.map((x) => (x.clientId === p.clientId ? { ...x, ...p } : x)) : [...list, p]));
        },
        say: (m) => {
          const mine = m.accountId === acc.id;
          note({ id: `m${m.id}`, at: m.at, who: mine ? "You" : m.displayName, color: m.color, kind: "said", text: m.text });
          if (!mine && Date.now() - m.at < 15000) { toast(`${m.displayName}: ${m.text}`, "info"); lastSaid.current = { who: m.displayName, text: m.text, at: m.at }; setSaidTick((n) => n + 1); }
        },
        locks: (locks) => setSnap((prev) => prev && { ...prev, locks }),
        request: (r) => {
          setRequests((list) => [r, ...list.filter((x) => x.id !== r.id)].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))).slice(0, 80));
          // Everyone sees when a teammate puts something to the AI.
          if (!seenRequests.current.has(r.id)) {
            seenRequests.current.add(r.id);
            if (!r.action) note({ id: `r${r.id}`, who: r.user?.id === acc.id ? "You" : (first.session.members.find((m: any) => m.accountId === r.user?.id)?.displayName ?? "A teammate"), color: colorOf(r.user?.id), kind: "asked", text: r.private && r.user?.id !== acc.id ? "(a private question)" : String(r.text ?? "").slice(0, 110) });
            if (r.user?.id !== acc.id) toast(`${first.session.members.find((m: any) => m.accountId === r.user?.id)?.displayName ?? "A teammate"} asked the AI: ${String(r.text).slice(0, 90)}`, "info");
          }
        },
        proposal: (p) => setProposals((list) => [p, ...list.filter((x) => x.id !== p.id)]),
        transform: (t) => workspace.current?.scene.previewTransform(t.nodeId, t.pose),
        clock: (k) => {
          // A crewmate turned the world: this scene follows.
          workspace.current?.scene.setClock(k.timeMs, k.rate);
          setRemoteClock({ by: k.by, at: Date.now() });
        },
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
        onSelect: (id) => setSelected(id),
        onXrChange: (active, m) => setXr((x) => ({ ...x, active, mode: m })),
        notify: toast,
        onClock: (k) => collab.current?.clock(k.timeMs, k.rate),
        me: () => ({ name: account?.displayName ?? "You", color: youRef.current?.color ?? "#4cc9f0" }),
        // What the player said into the headset's microphone, as text (the server asks the speech model).
        transcribe: async (audio: Blob) => {
          const bytes = new Uint8Array(await audio.arrayBuffer());
          let binary = "";
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          const r = await api<{ text: string }>("POST", "/api/transcribe", { audio: btoa(binary), mime: audio.type || "audio/webm" });
          return r.text;
        },
        onAction: (a) => {
          const id = collab.current?.sessionId;
          if (!id) return;
          const run = (p: Promise<unknown>): void => void p.then(reloadLists).catch((e) => toast(e.message, "warn"));
          if (a.type === "simulate") run(api("POST", `/api/sessions/${id}/simulate`, {}));
          else if (a.type === "say") collab.current?.say(a.text);
          else if (a.type === "request") run(api("POST", `/api/sessions/${id}/requests`, { text: a.text, ...(selectedRef.current ? { topic: selectedRef.current } : {}) })); // a question asked in the headset goes to the thread of the part that is selected
          else if (a.type === "catalog") run(api("POST", `/api/sessions/${id}/catalog`, { itemId: a.itemId }));
          else if (a.type === "connect") run(api("POST", `/api/sessions/${id}/connect`, { componentId: a.componentId }));
          else run(api("POST", `/api/sessions/${id}/proposals/${a.proposalId}/${a.approve ? "approve" : "reject"}`, { reason: a.approve ? "Approved in XR" : "Rejected in XR" }));
        },
      });
      if (disposed) return ws.dispose();
      workspace.current = ws;
      (window as any).__workspace = ws; // exposed for automated checks
      (window as any).__collabEdit = (patches: any[], summary: string) => collab.current?.edit(patches, summary);
      (window as any).__select = (id: string | null) => setSelected(id);
      ws.scene.setMission(snapRef.current!.mission);
      showPlace(ws, snapRef.current!);
      if (arrivalClock.current) ws.scene.setClock(arrivalClock.current.timeMs, arrivalClock.current.rate);
      ws.refresh();
      setXr((x) => ({ ...x, support: ws.support }));
      // Arrival sequence: title card over a camera fly-in from deep space. `?intro=0` skips it.
      const cinematic = new URLSearchParams(window.location.search).get("intro") !== "0" && new URLSearchParams(window.location.search).get("iwer") !== "1";
      if (cinematic) {
        // Hold the title card on black until imagery and shaders are ready, so the fly-in plays without a hitch.
        setArriving("hold");
        ws.intro(false);
        await ws.ready();
        if (disposed) return;
        ws.intro(true);
        setArriving("fly");
        setTimeout(() => setArriving(false), 4600);
      } else {
        ws.intro(false);
        void ws.ready();
      }
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
    showPlace(ws, snap);
    ws.refresh();
  }, [snap?.mission.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { workspace.current?.scene.setPresence(presence, presence.find((p) => p.accountId === account?.id && p.mode === (xr.active ? "xr" : "desktop"))?.clientId ?? null); }, [presence, account, xr.active]);
  useEffect(() => { workspace.current?.setMode(mode); }, [mode]);


  useEffect(() => bus.listen("ask", () => setTab("ai")), []);
  // A submission made from the mission guide opens the debrief here.
  useEffect(() => bus.listen("submitted", (r) => setDashboard(r as { evaluation: Evaluation; submission?: any })), []);

  const tiles = useMemo(() => (snap ? metrics(snap) : []), [snap]);
  useEffect(() => {
    const ws = workspace.current;
    if (!ws || !snap) return;
    const pending = proposals.find((p) => p.status === "awaiting_approval");
    // The latest reply of your own AI, from the thread of the part you have selected (or the mission thread).
    const mine = requests.find((r) => !r.private && !r.action && r.user?.id === account?.id && (r.topic ?? null) === selected) ?? requests.find((r) => !r.private && !r.action && r.user?.id === account?.id);
    // The headset shows the same things as the desktop, in the same order: does the mission work, what is not connected,
    // what the control logic is, then the numbers. Its quick commands follow the state of the design.
    const wiring = snap.mission.derived["systems.wiring"]?.value as any;
    const loose: any[] = (wiring?.parts ?? []).filter((p: any) => p.notes.length > 0);
    const controllers: any[] = snap.mission.config.systems?.controllers ?? [];
    const outcome = snap.evaluation.outcome;
    const part = selected ? snap.mission.config.spacecraft.components.find((x: any) => x.id === selected) : null;
    const partStatus = part ? (wiring?.parts ?? []).find((p: any) => p.id === part.id) : null;
    const aboard = new Set(snap.mission.config.spacecraft.components.map((x: any) => x.name));
    const payload = snap.scenario.catalog.filter((i: any) => i.discipline === "payload" && !aboard.has(i.component.name));
    const quick: SpatialStatus["quick"] = [
      loose[0] ? { label: `Connect ${String(loose[0].name).slice(0, 22)}`, action: { type: "connect" as const, componentId: loose[0].id } } : { label: `Add ${payload[0]?.label.split(" · ")[0] ?? "an instrument"}`, action: payload[0] ? { type: "catalog" as const, itemId: payload[0].id } : { type: "request" as const, text: "What instrument should we add first, and what does each option cost?" } },
      { label: "What holds us back?", action: { type: "request" as const, text: "What is holding this mission back right now? Give the numbers, and the ways to deal with it with what each costs." } },
      controllers.length ? { label: "Fly the mission", action: { type: "simulate" as const } } : { label: "Add power-saving logic", action: { type: "request" as const, text: "Make a controller: when power runs short, run the instruments a quarter of the time, and go back to normal once the battery is nearly full." } },
      controllers.length ? { label: "Send hydrogen data first", action: { type: "request" as const, text: "Change the control logic so the most important instrument's data is always sent down first." } } : { label: "Fly the mission", action: { type: "simulate" as const } },
    ];
    const status: SpatialStatus = {
      title: snap.mission.config.meta.name,
      lines: [
        { k: "Mission", v: outcome ? ({ not_ready: "not ready to fly", ready_to_fly: "ready to fly", success: "SUCCESS", partial: "partial success", failed: "FAILED in flight" } as Record<string, string>)[outcome.verdict]! : "–", tone: (outcome && ["not_ready", "failed"].includes(outcome.verdict) ? "bad" : "ok") as "ok" | "bad" },
        { k: "Open", v: outcome?.conditions.find((k) => k.met === false)?.title ?? outcome?.conditions.find((k) => k.met === null)?.evidence ?? "nothing" },
        { k: "Wiring", v: wiring?.wired ? `${wiring.links.length} lines · ${loose.length ? `${loose.length} part${loose.length === 1 ? "" : "s"} not connected` : "all connected"}` : "–", tone: (loose.length ? "bad" : "ok") as "ok" | "bad" },
        { k: "Control", v: controllers.length ? controllers.map((k) => `${k.name}${k.enabled ? "" : " (off)"}`).join(", ").slice(0, 60) : "no control logic yet" },
        ...tiles.filter((t) => ["Power margin", "Link margin", "Data return"].includes(t.k)).map((t) => ({ k: t.k, v: `${t.v} ${t.u}`, tone: (t.tone ?? "ok") as "ok" | "bad" })),
      ],
      // At Cadet level the probe offers the hint itself, in the headset as on the screen.
      crew: lastSaid.current,
      target: snap.session.world?.target?.name ?? "",
      hint: snap.session.difficulty === "cadet" ? ((h) => (h ? `${h.about} ${h.ways[0] ?? ""}` : ""))(hintFor(snap)) : "",
      footer: `${snap.evaluation.score.toFixed(0)} pts · v${snap.mission.version} · ${presence.length} participant${presence.length === 1 ? "" : "s"} · ${snap.checks.filter((c) => c.status === "fail").length} constraint(s) violated`,
      quick,
      ai: mine ? { thread: part && (mine.topic ?? null) === selected ? part.name : "the mission", question: String(mine.text ?? ""), answer: String(mine.answer?.text ?? ""), state: String(mine.status ?? "working").replace(/_/g, " ") } : null,
      pending: pending ? { proposalId: pending.id, summary: requests.find((r) => r.proposalId === pending.id)?.summary ?? requests.find((r) => r.proposalId === pending.id)?.text ?? "change", canApprove: you?.role === "lead" || (you?.role === "engineer" && pending.requiredRole === "engineer") } : null,
      // A selected part speaks first: what it is and what its lines deliver. Otherwise the player's own AI's latest reply.
      activity: part
        ? `${part.name}: ${partStatus?.notes.length ? partStatus.notes.join(" ") : `fully connected${partStatus?.commandable ? ", commandable by control logic" : ""}`} · ${(snap.mission.config.systems?.links ?? []).filter((l: any) => l.from.node === part.id || l.to.node === part.id).map((l: any) => `${l.kind}${l.rating ? ` ${l.rating}${l.kind === "power" ? " W" : " bit/s"}` : ""}`).join(", ") || "no lines"}`
        : mine ? (mine.answer?.text ? "Your AI's reply is on the panel above the table. Carry the ring's handle to turn time, or grab a slider or a part." : `${mine.text} — ${String(mine.status).replace(/_/g, " ")}`) : "Carry the ring's handle to turn time, grab a slider or a part, or ask the AI with a quick command.",
    };
    ws.setSpatialStatus(status);
    // `xr` is a dependency so this runs once the 3D workspace exists (it is created after the first snapshot
    // arrives) and again when a session starts: a solo player who changes nothing still gets filled panels.
  }, [snap, tiles, proposals, requests, presence, you, previewDay, selected, account, xr, saidTick]);

  if (error) return <div className="page center" style={{ minHeight: "100vh" }}><div className="glass card" style={{ maxWidth: 420 }}><h2>Cannot open this mission</h2><p className="dim" style={{ margin: "10px 0" }}>{error}</p><a className="btn" href="/lobby">Back to missions</a></div></div>;

  presenceRef.current = presence;
  // A mission just started from the board or the lobby begins with its goal: what is this crew going for? (After the
  // first-visit walkthrough, if that is showing. It can be closed and set later from the strip above the stage.)
  const askedGoal = useRef(false);
  useEffect(() => {
    if (askedGoal.current || !snap || !you || typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("new") !== "1") return;
    if (snap.game.charter || snap.session.mode === "sandbox" || snap.game.submitted || you.role !== "lead") return;
    const timer = setInterval(() => {
      if (document.querySelector(".tutorial")) return;
      clearInterval(timer);
      if (!askedGoal.current) { askedGoal.current = true; setDefining(true); }
    }, 600);
    return () => clearInterval(timer);
  }, [snap, you]);
  const ctx: Ctx | null = snap && collab.current && account && sid ? { sid, snap, collab: collab.current, role: you?.role ?? "viewer", accountId: account.id, presence, requests, proposals, selected, setSelected, toast, setPreviewDay, reloadLists } : null;
  const phaseIndex = snap ? PHASES.indexOf(snap.game.phase) : 0;
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
              <div style={{ font: "800 16px var(--font-display)", fontStretch: "118%", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{snap.session.name}</div>
              <div className="dim" style={{ fontSize: 11 }}>{snap.session.mode === "sandbox" ? "Sandbox · unranked · " : ""}{snap.scenario.title} · {snap.session.difficulty} · seed {snap.session.seed}</div>
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

          <aside className="glass left"><ObjectivesPanel c={ctx} onDefine={() => setDefining(true)} openTab={(t) => setTab(t as Tab)} /></aside>
          <div className="mid">
            <Viewfinder snap={snap} mode={mode} />
            {/* One overlay at a time on the stage: a selected part's card takes the place of the crew queue and the coach strip. */}
            <Tutorial />
            {/* The game over the engineering: stars, the objectives that tick off, hints at the easier levels. */}
            <CrewFeed events={feed} presence={presence} seats={4} selfId={account?.id ?? ""} roles={Object.fromEntries(Object.entries((snap.game.roleClaims ?? {}) as Record<string, string>).map(([seat, id]) => [id, seat]))}
              watches={snap.roles ?? []} names={Object.fromEntries(snap.session.members.map((m: any) => [m.accountId, m.displayName]))} canTake={you?.role !== "viewer" && !snap.game.submitted}
              ai={{ canAsk: you?.role === "lead" && !snap.game.submitted, here: aiCrew.here, busy: aiCrew.busy,
                onBring: () => { setAiCrew({ here: false, busy: true }); void api<{ crewmates: string[] }>("POST", `/api/sessions/${sid}/crewmates`, { count: 3 }).then((r) => { setAiCrew({ here: r.crewmates.length > 0, busy: false }); toast(r.crewmates.length ? `${r.crewmates.join(", ")} joined your crew.` : "There is no free seat for an AI crewmate.", "info"); }).catch((err) => { setAiCrew({ here: false, busy: false }); toast((err as Error).message, "warn"); }); },
                onDismiss: () => { setAiCrew({ here: true, busy: true }); void api("DELETE", `/api/sessions/${sid}/crewmates`).then(() => setAiCrew({ here: false, busy: false })).catch(() => setAiCrew({ here: true, busy: false })); } }}
              onTake={(seat) => void api("POST", `/api/sessions/${sid}/role`, { seat }).catch((err) => toast((err as Error).message, "warn"))}
              waiting={(() => { const p = proposals.find((x) => x.status === "awaiting_approval"); if (!p) return null; const r = requests.find((x) => x.proposalId === p.id); return { summary: String(r?.summary ?? r?.text ?? "a change").slice(0, 90), by: snap.session.members.find((m: any) => m.accountId === r?.user?.id)?.displayName ?? "a crew member" }; })()}
              onSay={(t) => collab.current?.say(t)} onOpenWaiting={() => setTab("ai")} />
            <QuestBar goal={snap.session.mode === "sandbox" ? "none" : snap.game.charter ? "set" : "open"} onDefine={() => setDefining(true)} snap={snap} onAsk={(text) => { setSelected(null); setTab("ai"); setTimeout(() => bus.send("ask", text), 0); }} />
            <button className="btn sm ghost" style={{ position: "absolute", left: 8, top: 8, pointerEvents: "auto" }} onClick={() => setCollapsed(!collapsed)}>{collapsed ? "▸ Objectives" : "◂"}</button>
            {mode === "orbit" && <button className={`btn sm ${chase ? "primary" : ""}`} style={{ position: "absolute", right: 8, top: 40, pointerEvents: "auto" }} title="Fly the camera alongside the spacecraft" onClick={() => { const next = !chase; setChase(next); if (next) setEarthView(false); workspace.current?.follow(next); }}>{chase ? "◉ Craft cam" : "Craft cam"}</button>}
            {mode === "orbit" && snap.mission.config.centralBody !== "earth" && <button className={`btn sm ${earthView ? "primary" : ""}`} style={{ position: "absolute", right: 8, top: 74, pointerEvents: "auto" }} title="Look back from Earth: see the phase this world shows from home, and watch it change as you turn time" onClick={() => { const next = !earthView; setEarthView(next); if (next) setChase(false); workspace.current?.viewFromEarth(next); }}>{earthView ? "◉ From Earth" : "From Earth"}</button>}
            <div className="stage-bottom"><Coach snap={snap} /><div className="tiles">
              {tiles.map((t) => (
                <div key={`${t.k}:${pulsed.nodes.includes(t.node) ? pulsed.key : 0}`} className={`metric glass ${pulsed.nodes.includes(t.node) ? "pulse" : ""}`} title={`${EXPLAIN[t.k] ?? ""} (model: ${t.node})`}>
                  <div className="k">{t.k}</div><div className="v" style={{ color: t.tone === "bad" ? "var(--red)" : undefined }}>{t.v}<span className="u">{t.u}</span></div>
                </div>
              ))}
            </div></div>
          </div>
          <aside className="glass right">
            {selected && (() => {
              const part = snap.mission.config.spacecraft.components.find((x: any) => x.id === selected);
              if (!part) return null;
              return <PartCard c={ctx} part={part} onClose={() => setSelected(null)} onAdjust={() => setTab("design")} />;
            })()}
            {/* What the crew's AIs are doing, inside the side panel: nothing floats over the 3D stage. */}
            {tab !== "ai" && !selected && <AiQueue requests={requests.filter((r) => ["queued", "analyzing", "planning", "executing", "awaiting_approval", "awaiting_clarification"].includes(r.status))} members={snap.session.members} onOpen={() => setTab("ai")} />}
            <div className="tabs">{(["ai", "design", "systems", "analysis", "designs", "review", "log"] as Tab[]).map((t) => <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>{t === "ai" ? `AI${proposals.some((p) => p.status === "awaiting_approval") ? " •" : ""}` : t}</button>)}</div>
            {tab === "design" && <DesignPanel c={ctx} />}
            {tab === "ai" && <AiPanel c={ctx} />}
            {tab === "systems" && <SystemsPanel c={ctx} />}
            {tab === "analysis" && <AnalysisPanel c={ctx} previewDay={previewDay} />}
            {tab === "designs" && <DesignsPanel c={ctx} />}
            {tab === "review" && <ReviewPanel c={ctx} onSubmitted={(evaluation, submission) => setDashboard({ evaluation, submission })} />}
            {tab === "log" && <LogPanel c={ctx} />}
          </aside>

          <footer className="glass bottom">
            <MissionClock c={ctx} workspace={() => workspace.current} onDay={setPreviewDayState} remote={remoteClock} />
          </footer>
        </div>
      )}
      {xr.active && <div style={{ position: "absolute", left: 16, bottom: 16, zIndex: 6 }} className="glass card"><b>{xr.mode === "ar" ? "Mixed reality" : "VR"} session active</b><div className="dim">The workspace is on your headset. <button className="btn sm" onClick={() => workspace.current?.exitXr()}>Exit XR</button></div></div>}
      {arriving && snap && <div key={arriving} className={`launch-veil ${arriving === "hold" ? "hold" : ""}`} aria-hidden><div className="count"><span><small>Mission control · link established</small>{snap.mission.config.spacecraft.name}</span></div></div>}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={`glass toast ${t.out ? "out" : ""}`}><span className={`chip ${t.tone === "info" ? "info" : t.tone}`}><span className="dot" /></span><span>{t.message}</span></div>)}</div>
      {defining && ctx && <DefineMission c={ctx} onClose={() => setDefining(false)} />}
      {dashboard && snap && <EvaluationDashboard checks={snap.checks} evaluation={dashboard.evaluation} submission={dashboard.submission} title={snap.session.name} onClose={() => setDashboard(null)} />}
    </div>
  );
}
