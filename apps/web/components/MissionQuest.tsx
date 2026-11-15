"use client";
/**
 * The game on top of the engineering: what the crew is playing for, in one strip over the stage.
 *
 * Stars for the score (one for a mission that flies, two for a strong one, three for an excellent one), the four
 * things that make a mission work as objectives that tick off, a moment of celebration when one is won, and
 * hints. A hint never picks the answer: it names what stands in the way and lays out the ways through it that
 * this mission's kit offers, each with why it matters. At Cadet level hints come by themselves; at Engineer level
 * they come when asked for; at Chief level there are none.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "@/lib/api";
import { castOn } from "@/lib/cast";

export const STAR_SCORES = [55, 75, 90] as const;
export const starsFor = (score: number): number => STAR_SCORES.filter((s) => score >= s).length;

const LEVER_NAME: Record<string, string> = {
  "orbit.altitude": "Orbit altitude", "orbit.inclination": "Orbit tilt", "orbit.node": "Orbit plane to the Sun", "mission.date": "Mission date",
  "launch.vehicle": "Launch vehicle", "solar.area": "Solar array area", "battery.capacity": "Battery size", "antenna.dataRate": "Radio data rate",
  "antenna.power": "Radio power", "antenna.dutyCycle": "Time spent transmitting", "instrument.dutyCycle": "Instrument on-time",
};

export interface Hint { about: string; ways: string[] }

/** What stands in the way right now, and the ways through it this mission offers. `turn` rotates which ways are shown. */
export function hintFor(snap: Snapshot, turn = 0): Hint | null {
  const s = snap as any;
  const kit = s.session.kit;
  const outcome = s.evaluation.outcome;
  const wiring = s.mission.derived["systems.wiring"]?.value;
  const loose = (wiring?.parts ?? []).filter((p: any) => p.notes.length > 0);
  if (loose[0]) return { about: `${loose[0].name} is on board but not connected, so it does nothing yet.`, ways: ["Open the Systems view, pick the part and press Connect.", `Or tell your AI: connect the ${String(loose[0].name).toLowerCase()}.`] };
  const broken = (s.checks as any[]).find((x) => x.status === "fail");
  const unmet = outcome?.conditions.find((k: any) => k.met === false);
  const open = outcome?.conditions.find((k: any) => k.met === null);
  let about: string;
  if (broken) about = `A limit is broken: ${broken.description}. ${broken.detail}`;
  else if (unmet) about = `Not there yet: ${unmet.title}. ${unmet.evidence}`;
  else if (open) return { about: "The design holds on paper. Now fly it: a simulated flight shows whether it gets through and brings the data home.", ways: ["Open the Analysis tab and press Fly the mission.", "In the headset, say: fly the mission."] };
  else return null;
  const ways: string[] = [];
  const levers: any[] = kit?.levers ?? [];
  for (let i = 0; i < Math.min(2, levers.length); i++) {
    const l = levers[(turn * 2 + i) % levers.length];
    ways.push(`${LEVER_NAME[l.key] ?? l.key}: ${l.why}`);
  }
  const tools: any[] = kit?.toolbox ?? [];
  if (tools.length) {
    const t = tools[turn % tools.length];
    const item = (s.scenario.catalog as any[]).find((i) => i.id === t.itemId);
    if (item) ways.push(`Add ${String(item.label).split(" · ")[0]}: ${t.why}`);
  }
  ways.push("Each way costs something. Ask your AI what it would cost before you choose.");
  return { about, ways };
}

/** A short chime made on the spot (no audio file). Silent if the browser will not play it. */
function chime(big: boolean): void {
  try {
    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    const ctx: AudioContext = new Ctx();
    const notes = big ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 880];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.11;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.5);
    });
    setTimeout(() => void ctx.close().catch(() => undefined), 1600);
  } catch { /* sound is decoration */ }
}

export function QuestBar({ snap, onAsk, goal = "none", onDefine, solved = {} }: { /** Who met each condition (by condition id): the crew member whose change took it from open to met. */ solved?: Record<string, { who: string; color: string }>; snap: Snapshot; onAsk(text: string): void; /** Has the crew said what it is going for? "none" when that does not apply (sandbox). */ goal?: "open" | "set" | "none"; onDefine?(): void }) {
  const s = snap as any;
  const level: string = s.session.difficulty;
  const outcome = s.evaluation.outcome;
  const score: number = s.evaluation.score;
  const stars = starsFor(score);
  const next = STAR_SCORES[stars];
  const conditions: any[] = outcome?.conditions ?? [];
  const metKey = conditions.map((k) => (k.met ? "1" : "0")).join("");
  const [turn, setTurn] = useState(0);
  // A hint opens short (what stands in the way) and unfolds to the ways through it when asked: it must not cover the world.
  const [showHint, setShowHint] = useState(false);
  const [unfolded, setUnfolded] = useState(false);
  const [cheer, setCheer] = useState<{ id: number; big: boolean; head: string; text: string; /** The condition just met: its solver's name is shown as soon as it is known. */ cond?: string; /** Show who solved what, with the result. */ crew?: boolean } | null>(null);
  // Who solved what, counted per crew member: shown with the result, because a mission is won together.
  const credits = useMemo(() => {
    const tally = new Map<string, { who: string; color: string; n: number }>();
    for (const c of Object.values(solved)) tally.set(c.who, { who: c.who, color: c.color, n: (tally.get(c.who)?.n ?? 0) + 1 });
    return [...tally.values()];
  }, [solved]);
  // The objectives that have just been won: each plays its tick once.
  const [fresh, setFresh] = useState<string[]>([]);
  const before = useRef<{ sid: string; met: string; stars: number; verdict: string } | null>(null);
  const hint = useMemo(() => (level === "chief" ? null : hintFor(snap, turn)), [snap, turn, level]);

  // Something won since the last look: say so, loudly enough to notice.
  useEffect(() => {
    const prev = before.current;
    const verdict: string = outcome?.verdict ?? "";
    before.current = { sid: s.session.id, met: metKey, stars, verdict };
    if (!prev || prev.sid !== s.session.id) return;
    const justMet = conditions.filter((k, i) => metKey[i] === "1" && prev.met[i] === "0").map((k) => String(k.id));
    if (justMet.length) { setFresh(justMet); setTimeout(() => setFresh((f) => f.filter((x) => !justMet.includes(x))), 2800); }
    let won: { big: boolean; head: string; text: string; cond?: string; crew?: boolean } | null = null;
    if (verdict === "success" && prev.verdict !== "success") won = { big: true, head: "Mission success", text: `${"★".repeat(Math.max(1, stars))} · ${score.toFixed(0)} points`, crew: true };
    else if (stars > prev.stars) won = { big: stars === 3, head: `${"★".repeat(stars)} earned`, text: `${score.toFixed(0)} points` };
    else {
      const i = [...metKey].findIndex((m, k) => m === "1" && prev.met[k] === "0");
      if (i >= 0) won = { big: false, head: "Objective complete", text: conditions[i]!.title, cond: String(conditions[i]!.id) };
    }
    if (!won) return;
    const id = Date.now();
    setCheer({ id, ...won });
    chime(won.big);
    const timer = setTimeout(() => setCheer((c) => (c?.id === id ? null : c)), won.big ? 5200 : 3200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metKey, stars, outcome?.verdict, s.session.id]);

  // At Cadet level the hint for a new obstacle opens by itself, once, and folds away again so the world stays in view.
  const seen = useRef("");
  const unfoldedRef = useRef(false);
  unfoldedRef.current = unfolded;
  useEffect(() => {
    // (Not while recording: a hint then opens only when asked for, so nothing comes up over the stage by itself.)
    if (level !== "cadet" || !hint || seen.current === hint.about || castOn()) return;
    seen.current = hint.about;
    setShowHint(true);
    setUnfolded(false);
    const timer = setTimeout(() => setShowHint((open) => (unfoldedRef.current ? open : false)), 14000);
    return () => clearTimeout(timer);
  }, [level, hint]);

  return (
    <div className="quest">
      <div className="glass quest-bar">
        <span className="quest-stars" title={`Stars: ★ ${STAR_SCORES[0]} points · ★★ ${STAR_SCORES[1]} · ★★★ ${STAR_SCORES[2]}. The score adds up how well each goal is met.`}>
          {[1, 2, 3].map((n) => <i key={n} className={n <= stars ? "on" : ""}>★</i>)}
          <small>{score.toFixed(0)}{next ? ` / ${next}` : ""}</small>
        </span>
        <span className="quest-items">
          {goal !== "none" && (
            <button className={`quest-item goal ${goal === "set" ? "met" : "first"}`} title={goal === "set" ? "Your crew has said what it is going for. Click to look at it or change it." : "Start here: say what your crew is going for. It decides which goal counts most."} onClick={() => onDefine?.()}>
              <b>{goal === "set" ? "✓" : "①"}</b><span>{goal === "set" ? "Goal chosen" : "Choose your goal"}</span>
            </button>
          )}
          {conditions.map((k) => (
            <button key={k.id} className={`quest-item ${k.met === null ? "open" : k.met ? "met" : "unmet"}${fresh.includes(String(k.id)) ? " just" : ""}`} title={`${k.title} — ${k.evidence}.${k.met && solved[String(k.id)] ? ` Solved by ${solved[String(k.id)]!.who}.` : ""} Click to ask your AI about it.`} onClick={() => onAsk(k.met ? `How much room do we have on this: "${k.title}"? (${k.evidence})` : `"${k.title}" is not met yet (${k.evidence}). What ways are there to get there, and what does each cost?`)}>
              <b>{k.met === null ? "–" : k.met ? <svg className="tick" viewBox="0 0 16 16" aria-label="met"><path d="M2.5 8.6l3.4 3.4L13.5 4.2" /></svg> : "✗"}</b><span>{k.title}</span>{k.met && solved[String(k.id)] ? <em className="by" style={{ background: solved[String(k.id)]!.color }} aria-label={`solved by ${solved[String(k.id)]!.who}`} /> : null}
              {fresh.includes(String(k.id)) && <i className="won" aria-hidden>{Array.from({ length: 10 }, (_, n) => <u key={n} style={{ ["--a" as string]: `${n * 36}deg` }} />)}</i>}
            </button>
          ))}
        </span>
        <span className={`quest-level ${level}`} title={level === "cadet" ? "Cadet: roomy limits, and hints come by themselves" : level === "engineer" ? "Engineer: nominal limits, hints when you ask" : "Chief: tight limits, no hints"}>{level === "cadet" ? "★ Cadet" : level === "engineer" ? "★★ Engineer" : "★★★ Chief"}</span>
        {level !== "chief" && hint && <button className={`btn sm ${showHint ? "primary" : ""}`} onClick={() => { if (showHint && unfolded) setTurn((t) => t + 1); setShowHint(true); setUnfolded(true); }}>{showHint && unfolded ? "Another hint" : "Hint"}</button>}
      </div>
      {showHint && hint && level !== "chief" && (
        <div className="glass quest-hint" key={`${hint.about}:${turn}`}>
          <div className="row between"><span className="eyebrow">Hint from your AI</span><button className="btn sm ghost" onClick={() => { setShowHint(false); setUnfolded(false); }}>Got it</button></div>
          <p className={unfolded ? "" : "short"}>{hint.about}</p>
          {unfolded ? <ul>{hint.ways.map((w) => <li key={w}>{w}</li>)}</ul> : <button className="btn sm" onClick={() => setUnfolded(true)}>Show me the ways through</button>}
        </div>
      )}
      {cheer && (
        <div key={cheer.id} className={`quest-cheer ${cheer.big ? "big" : ""}`} aria-live="polite">
          <div className="burst" aria-hidden>{Array.from({ length: 14 }, (_, i) => <i key={i} style={{ ["--a" as string]: `${(i / 14) * 360}deg` }} />)}</div>
          <svg className="seal" viewBox="0 0 64 64" aria-hidden><circle cx="32" cy="32" r="27" /><circle className="halo" cx="32" cy="32" r="27" /><path d="M18.5 33.5l9 9 18.5-21" /></svg>
          <div className="head">{cheer.head}</div>
          <div className="text">{cheer.text}</div>
          {cheer.cond && solved[cheer.cond] && <div className="credits"><span style={{ color: solved[cheer.cond]!.color }}>solved by {solved[cheer.cond]!.who}</span></div>}
          {cheer.crew && credits.length > 1 && <div className="credits">{credits.map((c) => <span key={c.who} style={{ color: c.color }}>{c.who} {"✓".repeat(c.n)}</span>)}</div>}
        </div>
      )}
    </div>
  );
}
