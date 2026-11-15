/**
 * The game's sounds, made on the spot with the Web Audio API (there are no audio files). Every sound stands for
 * something that happened: a control was pressed, a part came on board, a line was connected, the design changed,
 * a crewmate spoke, someone pointed at a place, the mission flew, it succeeded or it did not.
 *
 * Browsers allow sound only after the player has clicked or pressed something; until then every call is silent.
 * `setMuted` turns it all off, and the choice is remembered.
 */
export type Sound = "tick" | "add" | "connect" | "change" | "talk" | "point" | "ask" | "launch" | "success" | "partial" | "fail" | "open";

let ctx: AudioContext | null = null;
let muted: boolean | null = null;
let last = 0;

export function isMuted(): boolean {
  if (muted === null) {
    try { muted = localStorage.getItem("mf.muted") === "1"; } catch { muted = false; }
  }
  return muted;
}
export function setMuted(on: boolean): void {
  muted = on;
  try { localStorage.setItem("mf.muted", on ? "1" : "0"); } catch { /* not remembered */ }
}

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx ??= new Ctor();
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

let out: AudioNode | null = null;
/** Where every sound goes: a low-pass that takes the edge off, and a quiet echo that gives it some room. */
function bus(a: AudioContext): AudioNode {
  if (out) return out;
  const input = a.createGain();
  const soften = a.createBiquadFilter();
  soften.type = "lowpass";
  soften.frequency.value = 5200;
  const delay = a.createDelay(0.5);
  delay.delayTime.value = 0.16;
  const feedback = a.createGain();
  feedback.gain.value = 0.26;
  const wet = a.createGain();
  wet.gain.value = 0.22;
  input.connect(soften).connect(a.destination);
  soften.connect(delay).connect(feedback).connect(delay);
  delay.connect(wet).connect(a.destination);
  out = input;
  return input;
}

/** One note: a frequency (or a glide between two), a wave shape, when it starts, how long and how loud. */
function note(a: AudioContext, f0: number, f1: number, type: OscillatorType, at: number, dur: number, gain: number): void {
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  const t = a.currentTime + at;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.015, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(bus(a));
  o.start(t);
  o.stop(t + dur + 0.03);
}
/** A bell: the note with a quiet octave above it, ringing out. */
function bell(a: AudioContext, f: number, at: number, dur: number, gain: number): void {
  note(a, f, f, "sine", at, dur, gain);
  note(a, f * 2, f * 2, "sine", at, dur * 0.6, gain * 0.35);
  note(a, f * 3, f * 3, "sine", at, dur * 0.3, gain * 0.12);
}

/** A burst of filtered noise whose pitch sweeps: engines, air, a whoosh. */
function rush(a: AudioContext, from: number, to: number, at: number, dur: number, gain: number): void {
  const frames = Math.floor(a.sampleRate * dur);
  const buffer = a.createBuffer(1, frames, a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buffer;
  const filter = a.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 0.9;
  const g = a.createGain();
  const t = a.currentTime + at;
  filter.frequency.setValueAtTime(from, t);
  filter.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(bus(a));
  src.start(t);
  src.stop(t + dur + 0.05);
}

export function sfx(kind: Sound): void {
  if (isMuted()) return;
  const a = audio();
  if (!a || a.state !== "running") return;
  // Ticks are rationed so a burst of clicks does not buzz.
  const now = performance.now();
  if (kind === "tick") { if (now - last < 45) return; last = now; }
  switch (kind) {
    case "tick": note(a, 740, 587, "sine", 0, 0.05, 0.03); break;
    case "open": bell(a, 440, 0, 0.35, 0.05); bell(a, 587.33, 0.09, 0.45, 0.05); break;
    case "add": rush(a, 400, 2600, 0, 0.32, 0.025); bell(a, 293.66, 0.02, 0.4, 0.06); bell(a, 440, 0.12, 0.45, 0.06); bell(a, 587.33, 0.22, 0.7, 0.07); break;
    case "connect": note(a, 220, 440, "sine", 0, 0.14, 0.05); bell(a, 880, 0.13, 0.5, 0.05); break;
    case "change": bell(a, 493.88, 0, 0.3, 0.04); bell(a, 587.33, 0.08, 0.4, 0.035); break;
    case "talk": note(a, 587.33, 659.25, "sine", 0, 0.09, 0.04); note(a, 739.99, 880, "sine", 0.1, 0.12, 0.04); break;
    case "point": bell(a, 1174.66, 0, 0.25, 0.035); break;
    case "ask": bell(a, 440, 0, 0.3, 0.05); bell(a, 659.25, 0.12, 0.3, 0.05); bell(a, 587.33, 0.24, 0.5, 0.05); break;
    case "launch": rush(a, 80, 1400, 0, 1.7, 0.11); note(a, 55, 165, "triangle", 0, 1.6, 0.06); note(a, 110, 330, "sine", 0.2, 1.4, 0.03); break;
    case "success": [293.66, 369.99, 440, 587.33, 739.99, 880, 1174.66].forEach((f, i) => bell(a, f, i * 0.1, 0.9, 0.07)); rush(a, 2000, 6000, 0.6, 0.9, 0.02); break;
    case "partial": [293.66, 369.99, 440, 587.33].forEach((f, i) => bell(a, f, i * 0.12, 0.7, 0.06)); break;
    case "fail": note(a, 293.66, 220, "triangle", 0, 0.5, 0.06); note(a, 220, 146.83, "triangle", 0.35, 0.8, 0.06); break;
  }
}
