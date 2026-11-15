"use client";
/**
 * Sound for every page: a soft tick for anything pressed (buttons, tabs, cards), a rising note when a dialog or a
 * mission opens. The sounds that mean something in the game (a part added, a crewmate speaking, the flight) are
 * played where those things happen; this component covers the controls, and shows the switch that turns sound off.
 */
import { useEffect, useState } from "react";
import { isMuted, setMuted, sfx } from "@/lib/sfx";

export function Sound() {
  const [off, setOff] = useState(false);
  useEffect(() => {
    setOff(isMuted());
    const onClick = (e: MouseEvent): void => {
      const el = (e.target as HTMLElement | null)?.closest?.("button, a, .tab, [role=button], input[type=range], select");
      if (!el || (el as HTMLButtonElement).disabled) return;
      sfx(el.matches(".level, .btn.primary, .brief-card a") ? "open" : "tick");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return (
    <button className="sound-toggle" title={off ? "Sound is off. Click to turn it on." : "Sound is on. Click to turn it off."} aria-label={off ? "Turn sound on" : "Turn sound off"} onClick={() => { setMuted(!off); setOff(!off); }}>{off ? "♪ off" : "♪ on"}</button>
  );
}
