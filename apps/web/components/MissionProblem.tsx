"use client";
/**
 * The problem, and the kit that was built with it.
 *
 * A mission arrives with its problem already set up: the controls that matter for it are in the
 * crew's hands from the first second, the parts worth reaching for are laid out, and what is
 * open — goals not yet met, limits broken — is listed in plain words. The kit never says which
 * setting or part is right; it says why each one matters here. Everything else is done by
 * talking to your AI.
 */
import { useState } from "react";
import { api, fmt } from "@/lib/api";
import { bus } from "@/lib/bus";
import { BODY_RADIUS_KM } from "@/lib/scene/MissionScene";
import { commit, type Ctx, ParamSlider } from "./MissionPanels";

const locked = (c: Ctx): boolean => c.role === "viewer" || Boolean(c.snap.game.submitted);

function Lever({ c, lever }: { c: Ctx; lever: { key: string; why: string } }) {
  const cfg = c.snap.mission.config;
  const comps: any[] = cfg.spacecraft.components;
  const R = BODY_RADIUS_KM[cfg.centralBody as keyof typeof BODY_RADIUS_KM];
  const first = (type: string): any => comps.find((x) => x.type === type);
  const why = <div className="why">{lever.why}</div>;
  const part = (comp: any, field: string, label: string, min: number, max: number, step: number, unit: string) =>
    comp ? <div className="lever"><ParamSlider c={c} label={`${label} · ${comp.name}`} path={`spacecraft.components.${comp.id}.${field}`} value={comp[field]} min={min} max={max} step={step} unit={unit} toPatches={(v) => [{ op: "set", path: `spacecraft.components.${comp.id}.${field}`, value: v }]} />{why}</div> : null;
  switch (lever.key) {
    case "orbit.altitude":
      return <div className="lever"><ParamSlider c={c} label="Orbit altitude" path="orbit.semiMajorAxisKm" value={Math.round(cfg.orbit.semiMajorAxisKm - R)} min={cfg.centralBody === "earth" ? 200 : 20} max={cfg.centralBody === "earth" ? 2000 : 1000} step={5} unit="km" toPatches={(v) => [{ op: "set", path: "orbit.semiMajorAxisKm", value: R + v }]} />{why}</div>;
    case "orbit.inclination":
      return <div className="lever"><ParamSlider c={c} label="Orbit tilt (inclination)" path="orbit.inclinationDeg" value={cfg.orbit.inclinationDeg} min={0} max={180} step={1} unit="°" toPatches={(v) => [{ op: "set", path: "orbit.inclinationDeg", value: v }]} />{why}</div>;
    case "orbit.node":
      return <div className="lever"><ParamSlider c={c} label="Orbit plane to the Sun (node)" path="orbit.raanDeg" value={cfg.orbit.raanDeg} min={0} max={359} step={1} unit="°" toPatches={(v) => [{ op: "set", path: "orbit.raanDeg", value: v }]} />{why}</div>;
    case "mission.date":
      return <div className="lever"><div className="name">Mission date · {String(cfg.missionTime).slice(0, 10)}</div>{why}<div className="faint" style={{ fontSize: 11 }}>Turn the planet to another moment, then press “Start the mission here” on the clock.</div></div>;
    case "launch.vehicle": {
      const launch = c.snap.mission.derived["launch.vehicle"]?.value;
      if (!launch?.options?.length) return null;
      return (
        <div className="lever">
          <div className="name">Launch vehicle</div>
          <div className="choices">{launch.options.map((o: any) => <button key={o.id} className={launch.selectedId === o.id ? "on" : ""} disabled={locked(c)} title={o.summary} onClick={() => void commit(c, [{ op: "set", path: "meta.launchVehicleId", value: o.id }], `Launch vehicle → ${o.name}`)}>{o.name.replace(/ (slot|launcher)$/i, "").replace("Dedicated small", "Dedicated")}<small>{fmt(o.capacityKg)} kg · ${fmt(o.costMusd)}M</small></button>)}</div>
          {why}
        </div>
      );
    }
    case "solar.area": { const p = first("solar_panel"); return part(p, "areaM2", "Array area", 0.02, Math.max(1, (p?.areaM2 ?? 1) * 4), p?.areaM2 < 0.5 ? 0.01 : 0.1, "m²"); }
    case "battery.capacity": { const b = first("battery"); return part(b, "capacityWh", "Battery", 10, Math.max(100, (b?.capacityWh ?? 100) * 4), b?.capacityWh < 100 ? 5 : 50, "Wh"); }
    case "antenna.power": { const a = first("antenna"); return part(a, "txPowerW", "Radio power", 0.5, Math.max(10, (a?.txPowerW ?? 10) * 4), 0.5, "W"); }
    case "antenna.dutyCycle": { const a = first("antenna"); return part(a, "dutyCycle", "Time spent transmitting", 0.02, 0.9, 0.01, "of each orbit"); }
    case "antenna.dataRate": {
      const a = first("antenna");
      if (!a) return null;
      return (
        <div className="lever">
          <div className="name">Data rate · {a.name} · {fmt(a.dataRateBps)} bit/s</div>
          <div className="choices">{[["÷4", 0.25], ["÷2", 0.5], ["×2", 2], ["×4", 4]].map(([label, f]) => <button key={label as string} disabled={locked(c)} onClick={() => void commit(c, [{ op: "set", path: `spacecraft.components.${a.id}.dataRateBps`, value: a.dataRateBps * (f as number) }], `${a.name}: data rate ${label}`)}>{label}</button>)}</div>
          {why}
        </div>
      );
    }
    case "instrument.dutyCycle": {
      const list = comps.filter((x) => x.type === "instrument");
      if (!list.length) return <div className="lever"><div className="name">Instrument on-time</div>{why}<div className="faint" style={{ fontSize: 11 }}>No instrument on board yet.</div></div>;
      return <>{list.map((i) => <div key={i.id} className="lever"><ParamSlider c={c} label={`On-time · ${i.name}`} path={`spacecraft.components.${i.id}.dutyCycle`} value={i.dutyCycle} min={0} max={1} step={0.05} unit="of each orbit" toPatches={(v) => [{ op: "set", path: `spacecraft.components.${i.id}.dutyCycle`, value: v }]} /></div>)}<div className="lever">{why}</div></>;
    }
    default:
      return null;
  }
}

export function ProblemPanel({ c, onDefine }: { c: Ctx; onDefine(): void }) {
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState<"controls" | "parts" | "crew">("controls");
  const session = c.snap.session;
  const kit = session.kit;
  const brief = session.brief;
  const ev = c.snap.evaluation;
  const broken = c.snap.checks.filter((x) => x.status === "fail");
  const unmet = (ev.objectives as any[]).filter((o) => o.achieved < 1 && !/simulation/i.test(o.feedback));
  const catalog: any[] = c.snap.scenario.catalog;
  const add = async (itemId: string): Promise<void> => {
    setAdding(itemId);
    try { await api("POST", `/api/sessions/${c.sid}/catalog`, { itemId }); c.reloadLists(); } catch (err) { c.toast((err as Error).message, "bad"); }
    setAdding(null);
  };
  const ask = (text: string): void => bus.send("ask", text);
  if (!kit) return null;
  return (
    <div className="problem">
      <div className="eyebrow">The problem</div>
      <h2>{brief?.title ?? c.snap.scenario.title}</h2>
      <p className="statement">{brief?.problem ?? c.snap.scenario.briefing[1] ?? c.snap.scenario.tagline}</p>
      <div className="crux">{kit.crux}</div>
      {!c.snap.game.charter && session.mode !== "sandbox" && !locked(c) && <button className="btn sm" onClick={onDefine}>Say what your crew is going for</button>}

      {ev.outcome && (
        <div className={`outcome ${ev.outcome.verdict}`} title={ev.outcome.rule}>
          <div className="eyebrow">Does the mission work?</div>
          <div className="headline">{ev.outcome.headline}</div>
          {ev.outcome.conditions.map((k: any) => (
            <button key={k.id} className={`cond ${k.met === null ? "open" : k.met ? "met" : "unmet"}`} title="Ask your AI about this" onClick={() => ask(k.met ? `How much room do we have on this: "${k.title}"? (${k.evidence})` : `"${k.title}" is not met yet (${k.evidence}). What ways are there to get there, and what does each cost?`)}>
              <span className="mark">{k.met === null ? "–" : k.met ? "✓" : "✗"}</span><span className="t">{k.title}</span><span className="e">{k.evidence}</span>
            </button>
          ))}
          <div className="ends">The mission is over when the lead submits it (Review). It counts as a success when all of these hold after the flight (Analysis → fly). Click a line to ask your AI about it.</div>
        </div>
      )}

      <div className="open-items">
        <button className={broken.length ? "bad" : "ok"} title={broken.map((b) => `${b.description}: ${b.detail}`).join("\n") || "Every engineering limit is respected"} onClick={() => broken.length && ask(`Why is this limit broken and what are the ways to deal with it? ${broken[0]!.description} (${broken[0]!.detail})`)}><b>{broken.length}</b> limit{broken.length === 1 ? "" : "s"} broken</button>
        <button className={unmet.length ? "warn" : "ok"} title={unmet.map((o) => `${o.title}: ${o.feedback}`).join("\n") || "Every goal that can be judged before flight is met"} onClick={() => unmet.length && ask(`What does the goal "${unmet[0]!.title}" need, and what ways are there to get it?`)}><b>{unmet.length}</b> goal{unmet.length === 1 ? "" : "s"} open</button>
        <span className="score" title="The score is secondary: it adds up how well each goal is met and how carefully the crew worked. Whether the mission works is above."><b>{ev.score.toFixed(0)}</b> pts</span>
      </div>

      <div className="kit-tabs">
        {(["controls", "parts", "crew"] as const).map((t) => <button key={t} className={open === t ? "on" : ""} onClick={() => setOpen(t)}>{t === "controls" ? `Controls · ${kit.levers.length}` : t === "parts" ? `Parts · ${kit.toolbox.length}` : `Crew · ${session.members.length}/4`}</button>)}
      </div>
      {open === "controls" && <div className="levers">{kit.levers.map((l: any) => <Lever key={l.key} c={c} lever={l} />)}</div>}
      {open === "parts" && (
        <div className="toolbox">
          {kit.toolbox.map((t: any) => {
            const item = catalog.find((i) => i.id === t.itemId);
            if (!item) return null;
            const have = c.snap.mission.config.spacecraft.components.filter((x: any) => x.name === item.component.name).length;
            return (
              <div key={t.itemId} className="tool">
                <div><b>{item.label.split(" · ")[0]}</b>{have > 0 && <span className="chip ok" style={{ marginLeft: 6 }}>on board{have > 1 ? ` ×${have}` : ""}</span>}<div className="meta">{fmt(item.component.massKg)} kg · ${fmt(item.component.costMusd)}M{item.component.powerW ? ` · ${item.component.powerW} W` : ""}</div><div className="why">{t.why}</div></div>
                <button className="btn sm" disabled={locked(c) || adding !== null} onClick={() => add(item.id)}>{adding === item.id ? <span className="spinner" /> : "Add"}</button>
              </div>
            );
          })}
          <div className="faint" style={{ fontSize: 11 }}>Need something that is not here? Ask your AI to build it.</div>
        </div>
      )}
      {open === "crew" && (
        <div className="toolbox">
          {kit.roles.map((r: any) => {
            const holder = c.snap.game.roleClaims?.[r.seat];
            const mine = holder === c.accountId;
            const name = holder ? (session.members.find((m: any) => m.accountId === holder)?.displayName ?? "a crewmate") : null;
            const claim = (seat: string | null): void => void api("POST", `/api/sessions/${c.sid}/role`, { seat }).catch((err) => c.toast((err as Error).message, "warn"));
            return (
              <div key={r.seat} className="tool">
                <div><b>{r.seat}</b>{name && <span className={`chip ${mine ? "ok" : "info"}`} style={{ marginLeft: 6 }}>{mine ? "you" : name}</span>}<div className="why">{r.task}</div></div>
                {mine ? <button className="btn sm ghost" onClick={() => claim(null)}>Leave</button> : !holder ? <button className="btn sm" onClick={() => claim(r.seat)}>Take it</button> : null}
              </div>
            );
          })}
          <div className="faint" style={{ fontSize: 11 }}>Up to four players. Each talks to their own AI; the design and the clock are shared.</div>
        </div>
      )}
    </div>
  );
}
