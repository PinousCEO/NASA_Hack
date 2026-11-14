"use client";
/**
 * The mission clock: the moment the whole crew is looking at.
 *
 * Turning the planet — by dragging it on the desktop, or by twisting its ring in a headset —
 * moves this clock, and the clock moves everything that depends on when: where the Sun is,
 * which side of the world is lit, where the spacecraft is on its orbit, whether it can see
 * Earth, whether it is day at the landing site. The deck shows those as states, not numbers
 * to decode, and asks the engineering models what the design's power and radio link look
 * like at that moment. The clock is shared: what one crew member turns, everyone sees.
 */
import { useEffect, useRef, useState } from "react";
import { api, fmt } from "@/lib/api";
import type { Workspace } from "@/lib/xr/workspace";
import type { Ctx } from "./MissionPanels";

interface Reading {
  ms: number;
  rate: number;
  base: number;
  pace: number;
  sunlit: boolean | null;
  earthInView: boolean | null;
  earthDistanceKm: number;
  siteSunElevationDeg: number | null;
  moon: { illuminated: number; waxing: boolean; name: string } | null;
}
interface AtMoment { time: string; powerMarginW: number | null; eclipseFraction: number | null; betaDeg: number | null; linkMarginDb: number | null; failing: string[] }

const pad = (n: number): string => String(Math.floor(Math.abs(n))).padStart(2, "0");

export function MissionClock({ c, workspace, onDay, remote }: { c: Ctx; workspace(): Workspace | null; onDay(day: number | null): void; remote: { by: string; at: number } | null }) {
  const [r, setR] = useState<Reading | null>(null);
  const [at, setAt] = useState<AtMoment | null>(null);
  const lastRate = useRef(0);
  const lastDay = useRef<number | null>(null);
  const asked = useRef({ ms: 0, when: 0 });
  const duration = Number(c.snap.mission.config.meta.missionDurationDays) || 365;
  const body = String(c.snap.mission.config.centralBody);
  const bodyName = body.charAt(0).toUpperCase() + body.slice(1);

  // The scene owns the clock and runs it every frame; the deck reads it a few times a second.
  useEffect(() => {
    const read = (): void => {
      const scene = workspace()?.scene;
      if (!scene || !scene.mission) return;
      const t = scene.telemetry();
      setR({ ms: scene.clockMs, rate: scene.clockRate, base: scene.missionDateMs, pace: scene.orbitPace, sunlit: t?.sunlit ?? null, earthInView: t?.earthInView ?? null, earthDistanceKm: t?.earthDistanceKm ?? 0, siteSunElevationDeg: t?.siteSunElevationDeg ?? null, moon: t?.moonPhase ?? null });
      const day = (scene.clockMs - scene.missionDateMs) / 86400000;
      const shown = Math.abs(day) >= 0.5 ? Math.round(day) : null;
      if (shown !== lastDay.current) { lastDay.current = shown; onDay(shown); }
    };
    read();
    const timer = setInterval(read, 125);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // What the engineering models say at the moment shown (asked once the clock settles, or about once a second while it runs).
  const offset = r ? r.ms - r.base : 0;
  useEffect(() => {
    if (!r) return;
    if (Math.abs(offset) < 30 * 60000) { setAt(null); return; }
    const now = performance.now();
    const wait = r.rate === 0 ? 300 : Math.max(0, 1200 - (now - asked.current.when));
    const timer = setTimeout(() => {
      const ms = workspace()?.scene.clockMs ?? r.ms;
      asked.current = { ms, when: performance.now() };
      void api<AtMoment>("GET", `/api/sessions/${c.sid}/at?time=${encodeURIComponent(new Date(ms).toISOString())}`).then(setAt).catch(() => undefined);
    }, wait);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.round(offset / (r?.rate === 0 ? 60000 : 3600000)), r?.rate === 0, c.snap.mission.version]);

  if (!r) return <div className="clockdeck"><span className="faint mono">Clock starting…</span></div>;

  const set = (ms: number, rate: number): void => {
    workspace()?.scene.setClock(ms, rate);
    c.collab.clock(ms, rate);
  };
  const date = new Date(r.ms);
  const iso = Number.isFinite(date.getTime()) ? date.toISOString() : "";
  const days = offset / 86400000;
  const elapsed = `T${days < 0 ? "−" : "+"}${Math.floor(Math.abs(days))}d ${pad((Math.abs(days) % 1) * 24)}h`;
  const speeds: [string, number][] = [["1 hour / s", 3600], ["1 day / s", 86400], ["1 week / s", 604800]];
  const moved = Math.abs(offset) >= 3600000;
  const canEdit = c.role !== "viewer" && !c.snap.game.submitted;
  const turning = remote && Date.now() - remote.at < 2500;

  return (
    <div className="clockdeck">
      <button className="play" onClick={() => { if (r.rate === 0) set(r.ms, lastRate.current || 3600); else { lastRate.current = r.rate; set(r.ms, 0); } }} title={r.rate === 0 ? "Let time run" : "Stop time"} aria-label={r.rate === 0 ? "Run time" : "Stop time"}>{r.rate === 0 ? "▶" : "❚❚"}</button>
      <div className="when">
        <div className="date">{iso.slice(0, 10)} <b>{iso.slice(11, 16)}</b> <span>UTC</span></div>
        <div className="sub">{elapsed}{turning ? ` · ${remote!.by} is turning time` : moved ? " · not the mission date" : " · mission date"}</div>
      </div>
      <div className="states">
        {r.sunlit !== null && <span className={`state ${r.sunlit ? "sun" : "dark"}`} title="Is the spacecraft in sunlight right now? In the planet's shadow its solar arrays make nothing.">{r.sunlit ? "☀ In sunlight" : "● In shadow"}</span>}
        {r.earthInView !== null && <span className={`state ${r.earthInView ? "ok" : "dark"}`} title="Can the spacecraft see Earth right now? When the planet is in the way, no radio link is possible.">{r.earthInView ? `◉ Earth in view · ${fmt(r.earthDistanceKm)} km` : "◌ Earth hidden"}</span>}
        {r.siteSunElevationDeg !== null && <span className={`state ${r.siteSunElevationDeg > 0 ? "sun" : "dark"}`} title="Is it day at the landing site? The rover's arrays need the Sun above the horizon.">{r.siteSunElevationDeg > 0 ? `▲ Site in daylight · Sun ${r.siteSunElevationDeg.toFixed(0)}° up` : "▽ Site in darkness"}</span>}
        {r.moon && <span className="state" title="The Moon as seen from Earth at this moment">{r.moon.name} · {Math.round(r.moon.illuminated * 100)}% lit</span>}
      </div>
      <div className="track">
        <input type="range" min={0} max={duration} step={0.02} value={Math.min(duration, Math.max(0, days))} onChange={(e) => set(r.base + Number(e.target.value) * 86400000, 0)} aria-label="Mission day" title="Drag to move through the mission" />
        <div className="hint">Drag the {bodyName} to turn time · drag space to look around</div>
      </div>
      <div className="speeds" title="Step the shared clock: everyone in the crew sees the same moment">
        {([["−1 d", -86400000], ["−1 h", -3600000], ["+1 h", 3600000], ["+1 d", 86400000]] as [string, number][]).map(([label, ms]) => <button key={label} onClick={() => set(r.ms + ms, 0)} aria-label={`Step time ${label}`}>{label}</button>)}
      </div>
      <div className="speeds">
        {speeds.map(([label, rate]) => <button key={label} className={Math.abs(r.rate - rate) < rate * 0.01 ? "on" : ""} onClick={() => set(r.ms, rate)}>{label}</button>)}
      </div>
      <div className="row" style={{ gap: 6 }}>
        {moved && <button className="btn sm ghost" onClick={() => set(r.base, 0)} title="Back to the mission date">Mission date</button>}
        {moved && canEdit && <button className="btn sm" title="Fly the mission from this moment instead: the engineering models are recalculated for it" onClick={() => { const value = new Date(r.ms).toISOString().replace(/\.\d{3}Z$/, "Z"); void c.collab.edit([{ op: "set", path: "missionTime", value }], `Mission date → ${value.slice(0, 16).replace("T", " ")}`).then((res) => { if (!res.ok) c.toast(res.detail ?? "Not accepted", "warn"); }); }}>Start the mission here</button>}
      </div>
      {at && moved && (
        <div className="moment" title="The engineering models, recalculated for the moment shown. The design itself is unchanged.">
          <span>At this moment</span>
          <b className={at.powerMarginW !== null && at.powerMarginW < 0 ? "bad" : ""}>Power {at.powerMarginW === null ? "–" : `${at.powerMarginW >= 0 ? "+" : ""}${fmt(at.powerMarginW)} W`}</b>
          <b>Shadow {at.eclipseFraction === null ? "–" : `${fmt(at.eclipseFraction * 100)}% of each orbit`}</b>
          <b className={at.linkMarginDb !== null && at.linkMarginDb < 0 ? "bad" : ""}>Radio link {at.linkMarginDb === null ? "–" : `${at.linkMarginDb >= 0 ? "+" : ""}${fmt(at.linkMarginDb)} dB`}</b>
          {at.failing.length > 0 && <b className="bad">{at.failing.length} limit{at.failing.length === 1 ? "" : "s"} broken</b>}
        </div>
      )}
    </div>
  );
}
