"use client";
/**
 * The crew, where it can be seen: who is here, what each one just did, what is waiting for someone, and a line to
 * say something to the others. Everything in it happened in this mission: design changes with the name of whoever
 * made them, questions put to an AI, places pointed at, messages. It sits at the side of the stage, not in a tab.
 */
import { useEffect, useRef, useState } from "react";
import type { Presence } from "@/lib/api";

export interface CrewEvent { id: string; at: number; who: string; color: string; kind: "did" | "asked" | "said" | "points" | "joined" | "won"; text: string }

const ago = (at: number, now: number): string => { const s = Math.max(0, Math.round((now - at) / 1000)); return s < 8 ? "now" : s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`; };
const VERB: Record<CrewEvent["kind"], string> = { did: "", asked: "asked their AI:", said: "", points: "", joined: "", won: "" };

/**
 * What the crew is doing, the way a game shows it: each thing that happens comes up as a line at the bottom left of
 * the stage, stays a few seconds and fades. Who asked for what, what was done, who is pointing where, what was said.
 * No boxes: the world stays in view. (The whole history is one click away, on the crew panel.)
 */
export function GameChat({ events, seats = {} }: { events: CrewEvent[]; /** The role each crew member holds, by the name the line carries: said beside the name, so it is plain who does what. */ seats?: Record<string, string> }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const live = events.filter((e) => now - e.at < 11000).slice(-5);
  return (
    <div className="gamechat" aria-live="polite">
      {live.map((e) => (
        <div key={e.id} className={`gline ${e.kind}`}>
          <b style={{ color: e.color }}>{e.who}</b>{seats[e.who] ? <i className="seat">{seats[e.who]}</i> : null}
          <span>{e.kind === "said" ? e.text : e.kind === "asked" ? `asked their AI: ${e.text}` : e.text}</span>
        </div>
      ))}
    </div>
  );
}

export function CrewFeed({ events, presence, seats, roles, selfId, waiting, onSay, onOpenWaiting, watches = [], names = {}, canTake = false, onTake, ai, cast = false }: { /** Recording mode: the crew's names are drawn without their suffix (see lib/cast). */ cast?: boolean; events: CrewEvent[]; presence: Presence[]; seats: number; roles: Record<string, string>; selfId: string; waiting: { summary: string; by: string } | null; onSay(text: string): void; onOpenWaiting(): void; watches?: { seat: string; holder: string | null; label: string; ok: boolean; detail: string }[]; names?: Record<string, string>; canTake?: boolean; onTake?(seat: string | null): void; /** The lead may bring AI crewmates into the free seats. */ ai?: { canAsk: boolean; here: boolean; busy: boolean; onBring(): void; onDismiss(): void } }) {
  const [showRoles, setShowRoles] = useState(false);
  const mineSeat = watches.find((w) => w.holder === selfId)?.seat ?? null;
  const [text, setText] = useState("");
  const [now, setNow] = useState(Date.now());
  const list = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState(false);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [events.length]);
  const send = (): void => { const t = text.trim(); if (!t) return; onSay(t); setText(""); };
  // One chip per person (a player in a headset and at a desk at once is one person).
  const people = [...new Map(presence.map((p) => [p.accountId, p])).values()];
  return (
    <div className="glass crewfeed">
      <div className="crew-head">
        <span className="eyebrow">Crew · {people.length}/{seats}</span>
        <span className="crew-people">{people.map((p) => <span key={p.accountId} className="who" style={{ borderColor: p.color, color: p.color }} title={`${cast ? p.displayName.replace(/ · AI$/, "") : p.displayName}${roles[p.accountId] ? ` · ${roles[p.accountId]}` : ""} · ${presence.some((x) => x.accountId === p.accountId && x.mode === "xr") ? "in a headset" : "at a desk"}`}>{presence.some((x) => x.accountId === p.accountId && x.mode === "xr") ? "◉ " : ""}{p.accountId === selfId ? "You" : / · AI$/.test(p.displayName) ? `${p.displayName.replace(/ · AI$/, "").split(" ")[0]}${cast ? "" : " · AI"}` : p.displayName.split(" ")[0]}{roles[p.accountId] ? <small> {roles[p.accountId]}</small> : null}</span>)}</span>
      </div>
      {ai?.canAsk && (
        <button className="btn sm crew-ai" disabled={ai.busy} title={ai.here ? "The AI crewmates stop working and stay listed as members" : "AI crewmates take the free seats and roles and work on the mission with you: they connect parts, look after their role's priority, point things out and answer when you talk to the crew. They are software, labelled AI."} onClick={() => (ai.here ? ai.onDismiss() : ai.onBring())}>{ai.busy ? <span className="spinner" /> : ai.here ? (cast ? "Send crewmates home" : "Send the AI crewmates home") : cast ? "＋ Bring crewmates" : "＋ Bring AI crewmates"}</button>
      )}
      {watches.length > 0 && (
        <div className="crew-roles">
          <button className="crew-roles-head" onClick={() => setShowRoles(!showRoles)} title="Each role answers for one thing on the mission. With two or more roles taken, the crew earns a point for every one that holds at the end.">Roles · {watches.filter((w) => w.holder).length}/{watches.length} taken {showRoles ? "▾" : "▸"}</button>
          {showRoles && watches.map((w) => (
            <div key={w.seat} className={`crew-role ${w.holder ? (w.ok ? "ok" : "bad") : "free"}`} title={`${w.seat} answers for: ${w.label}. Now: ${w.detail}`}>
              <span className="mark">{w.ok ? "✓" : "✗"}</span>
              <span className="what"><b>{w.seat}</b> {w.label}<small>{w.detail}</small></span>
              {w.holder ? <span className="holder">{w.holder === selfId ? "you" : / · AI$/.test(names[w.holder] ?? "") ? `${(names[w.holder] ?? "").replace(/ · AI$/, "").split(" ")[0]}${cast ? "" : " · AI"}` : (names[w.holder] ?? "taken").split(" ")[0]}</span> : canTake && !mineSeat ? <button className="btn sm" onClick={() => onTake?.(w.seat)}>Take</button> : <span className="holder free">open</span>}
            </div>
          ))}
          {showRoles && mineSeat && canTake && <button className="btn sm ghost" style={{ alignSelf: "flex-start" }} onClick={() => onTake?.(null)}>Leave my role</button>}
        </div>
      )}
      {waiting && <button className="crew-wait" onClick={onOpenWaiting} title="Open the AI tab to look at it and decide">⏳ Waiting for approval · {waiting.by}: {waiting.summary}</button>}
      <button className="crew-roles-head" onClick={() => setHistory(!history)} title="Everything that has happened in this mission. New lines also come up at the bottom left of the stage.">Log · {events.length} {history ? "▾" : "▸"}</button>
      {history && <div className="crew-list" ref={list}>
        {events.length === 0 && <div className="faint">Nothing yet. What each of you does shows up here. Double-click a place on the world to point it out to the others.</div>}
        {events.slice(-60).map((e) => (
          <div key={e.id} className={`crew-line ${e.kind}`}>
            <b style={{ color: e.color }}>{e.who}</b> {VERB[e.kind]} <span>{e.kind === "said" ? `“${e.text}”` : e.text}</span> <i>{ago(e.at, now)}</i>
          </div>
        ))}
      </div>}
      <div className="crew-say">
        <input value={text} maxLength={240} placeholder="Say something to your crew…" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send(); } e.stopPropagation(); }} />
        <button className="btn sm" disabled={!text.trim()} title={text.trim() ? "Send this to everyone in the mission" : "Type a message for your crew first"} onClick={send}>Say</button>
      </div>
    </div>
  );
}
