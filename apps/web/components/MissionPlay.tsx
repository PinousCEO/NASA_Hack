"use client";
/**
 * Two ways to build, and neither has a set order or a right answer.
 *
 * SayBar sits under the world: the player says what they want in their own words ("add a camera that can see ten
 * metres", "make the battery bigger", "fly the mission") and their AI does it, answers there, and asks for a yes
 * when a change needs one. This is the way in.
 *
 * PlayPanel is the shelf, for those who would rather pick by hand: every part this crew can take, what is on board
 * but not connected, the launch vehicles, and the flight. It lists what things cost and do; it does not say which
 * to take. What the mission has to reach is in "What this mission needs" on the left.
 */
import { useState } from "react";
import { api, fmt } from "@/lib/api";
import { commit, type Ctx } from "./MissionPanels";

const locked = (c: Ctx): boolean => c.role === "viewer" || Boolean(c.snap.game.submitted);
const WORKING = ["queued", "analyzing", "planning", "executing"];

export function SayBar({ c, onOpen }: { c: Ctx; onOpen(): void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // The player's own latest exchange with their AI (not button presses), in whatever thread it was.
  const mine = c.requests.find((r) => r.user?.id === c.accountId && !r.action);
  const proposal = mine?.proposalId ? c.proposals.find((p) => p.id === mine.proposalId) : null;
  const waiting = proposal?.status === "awaiting_approval";
  const breaks = mine?.answer?.verdict === "built_breaks_limit";
  const canDecide = c.role === "lead" || (c.role === "engineer" && proposal?.requiredRole === "engineer");
  const working = mine && WORKING.includes(mine.status);
  const send = async (): Promise<void> => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try { await api("POST", `/api/sessions/${c.sid}/requests`, { text: t }); setText(""); c.reloadLists(); } catch (err) { c.toast((err as Error).message, "bad"); }
    setBusy(false);
  };
  const decide = async (action: "approve" | "reject"): Promise<void> => {
    if (!proposal) return;
    try { await api("POST", `/api/sessions/${c.sid}/proposals/${proposal.id}/${action}`, { reason: action === "approve" ? (breaks ? "Accepted from the stage with a limit still to fix" : "Approved from the stage") : "Rejected from the stage", acceptViolations: breaks }); c.reloadLists(); } catch (err) { c.toast((err as Error).message, "warn"); }
  };
  return (
    <div className="saybar">
      {mine && (
        <div className={`reply ${working ? "working" : ""}`}>
          <div className="q"><b>You</b> {String(mine.text).slice(0, 140)}</div>
          {working ? <div className="a"><span className="spinner" /> Your AI is working on it: {String(mine.status).replace(/_/g, " ")}…</div>
            : <button className="a" title="Open the whole conversation" onClick={onOpen}><b>Your AI</b> {String(mine.answer?.text ?? mine.error ?? "").slice(0, 420) || String(mine.status).replace(/_/g, " ")}</button>}
          {waiting && (canDecide
            ? <div className="row" style={{ gap: 6 }}><button className="btn sm primary" onClick={() => void decide("approve")}>{breaks ? "Add it anyway" : "Yes, put it on the spacecraft"}</button><button className="btn sm ghost" onClick={() => void decide("reject")}>No</button></div>
            : <div className="faint" style={{ fontSize: 11 }}>Waiting for the mission lead to say yes.</div>)}
        </div>
      )}
      <form className="glass" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={text} maxLength={600} disabled={locked(c)} placeholder={locked(c) ? "This mission is closed to changes." : "Tell your AI what to build or change, in your own words…"} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Tell your AI what to build or change" />
        <button className="btn primary" disabled={!text.trim() || busy || locked(c)} title={text.trim() ? "Send this to your AI" : "Type what you want first"}>{busy ? <span className="spinner" /> : "Tell my AI"}</button>
      </form>
    </div>
  );
}

export function PlayPanel({ c, onOpen }: { c: Ctx; onOpen(tab: string): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const cfg = c.snap.mission.config;
  const catalog: any[] = c.snap.scenario.catalog;
  const why = new Map<string, string>((c.snap.session.kit?.toolbox ?? []).map((t: any) => [t.itemId, t.why]));
  const comps: any[] = cfg.spacecraft.components;
  const wiring = c.snap.mission.derived["systems.wiring"]?.value as any;
  const loose: any[] = (wiring?.parts ?? []).filter((p: any) => p.notes.length > 0);
  const launch = c.snap.mission.derived["launch.vehicle"]?.value as any;
  const mass: number = (c.snap.mission.derived["mass.budget"]?.value as any)?.totalMassKg ?? 0;
  const outcome = c.snap.evaluation.outcome;
  const flown = Boolean(c.snap.game.simulation) && c.snap.game.simulationVersion === c.snap.mission.version;
  const run = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key);
    try { await fn(); c.reloadLists(); } catch (err) { c.toast((err as Error).message, "bad"); }
    setBusy(null);
  };
  const kinds: [string, string][] = [["instrument", "Instruments"], ["solar_panel", "Power"], ["battery", "Power"], ["antenna", "Radio"], ["adcs", "Pointing"], ["computer", "Computer and storage"]];
  const groups = [...new Set(kinds.map((k) => k[1]))];
  return (
    <div className="play">
      <p className="faint" style={{ fontSize: 11, margin: "0 0 4px" }}>There is no set order and no right part. Say what you want to your AI in the bar under the world, or take things from the shelf here. What the mission has to reach is in <b>What this mission needs</b> on the left.</p>

      <div className="step">
        <div className="head"><span>The shelf</span><i>{comps.length} parts on board</i></div>
        {groups.map((g) => {
          const items = catalog.filter((i) => kinds.some(([type, name]) => name === g && i.component.type === type));
          if (!items.length) return null;
          return (
            <details key={g} open={g === "Instruments"}>
              <summary>{g} · {items.length}</summary>
              {items.map((i) => {
                const have = comps.filter((x) => x.name === i.component.name).length;
                return (
                  <div key={i.id} className="tool">
                    <div><b>{String(i.label).split(" · ")[0]}</b>{i.tier === "advanced" && <span className="chip warn" style={{ marginLeft: 6, fontSize: 9 }}>advanced</span>}{have > 0 && <span className="chip ok" style={{ marginLeft: 6 }}>on board{have > 1 ? ` ×${have}` : ""}</span>}<div className="meta">{fmt(i.component.massKg)} kg · ${fmt(i.component.costMusd)}M{i.component.powerW ? ` · ${i.component.powerW} W` : ""}</div><div className="why">{why.get(i.id) ?? i.description}</div></div>
                    <button className="btn sm" disabled={locked(c) || busy !== null} onClick={() => void run(`add:${i.id}`, () => api("POST", `/api/sessions/${c.sid}/catalog`, { itemId: i.id }))}>{busy === `add:${i.id}` ? <span className="spinner" /> : "Add"}</button>
                  </div>
                );
              })}
            </details>
          );
        })}
        <div className="faint" style={{ fontSize: 11 }}>Not on the shelf? Describe it to your AI and it builds it: a part, with its lines and a 3D model.</div>
      </div>

      <div className={`step ${loose.length ? "now" : ""}`}>
        <div className="head"><span>Not connected</span><i>{loose.length ? `${loose.length} waiting` : "nothing waiting"}</i></div>
        {loose.map((p) => (
          <div key={p.id} className="tool">
            <div><b>{p.name}</b><div className="why">{p.notes.join(" ")}</div></div>
            <button className="btn sm" disabled={locked(c) || busy !== null} onClick={() => void run(`con:${p.id}`, () => api("POST", `/api/sessions/${c.sid}/connect`, { componentId: p.id }))}>{busy === `con:${p.id}` ? <span className="spinner" /> : "Connect"}</button>
          </div>
        ))}
        {!loose.length && <div className="faint" style={{ fontSize: 11 }}>A part works only through its lines: power, data, control.</div>}
      </div>

      {launch?.options?.length > 0 && (
        <div className="step">
          <div className="head"><span>Launch vehicle</span><i>spacecraft {mass.toFixed(1)} kg</i></div>
          <div className="choices">{launch.options.map((o: any) => <button key={o.id} className={launch.selectedId === o.id ? "on" : ""} disabled={locked(c) || busy !== null} title={o.summary} onClick={() => void run(`lv:${o.id}`, () => commit(c, [{ op: "set", path: "meta.launchVehicleId", value: o.id }], `Launch vehicle → ${o.name}`))}>{o.name.replace(/ (slot|launcher)$/i, "").replace("Dedicated small", "Dedicated")}<small>{fmt(o.capacityKg)} kg · ${fmt(o.costMusd)}M{o.capacityKg < mass ? " · too small" : ""}</small></button>)}</div>
        </div>
      )}

      <div className="step">
        <div className="head"><span>Orbit, power, radio, control logic</span><i>by hand</i></div>
        <div className="row wrap" style={{ gap: 6 }}><button className="btn sm ghost" onClick={() => onOpen("design")}>Design tab</button><button className="btn sm ghost" onClick={() => onOpen("systems")}>Systems tab</button></div>
      </div>

      <div className={`step ${flown ? "done" : ""}`}>
        <div className="head"><span>Fly the mission</span><i>{flown ? "flown" : outcome?.verdict === "ready_to_fly" ? "ready" : "any time"}</i></div>
        <button className="btn primary" disabled={locked(c) || busy !== null} onClick={() => void run("fly", () => api("POST", `/api/sessions/${c.sid}/simulate`, {}))}>{busy === "fly" ? <span className="spinner" /> : flown ? "Fly it again" : "Fly the mission"}</button>
        {outcome && <div className={`result ${outcome.verdict}`}>{outcome.headline}</div>}
      </div>
    </div>
  );
}
