/**
 * Recording mode ("cast"): how the crew's names are drawn on this browser.
 *
 * An AI crewmate's account is always named "… · AI", and everything that decides what a crewmate may do reads that
 * name. In recording mode this browser draws the names without the suffix, so a demo video shows the crew by name
 * only. Nothing else changes: the accounts, the rules and the record of who did what stay as they are.
 *
 * It is switched on per browser by opening any page with `?cast=1` (and off with `?cast=0`); the choice is kept in
 * local storage. A video recorded this way should say that the other seats are played by the game's AI crewmates.
 */
export const AI_NAME = / · AI$/;

export function castOn(): boolean {
  if (typeof window === "undefined") return false;
  try { return window.localStorage.getItem("mf.cast") === "1"; } catch { return false; }
}

/** A crew member's name as this browser draws it. */
export const shown = (name: string): string => (castOn() ? String(name ?? "").replace(AI_NAME, "") : name);

/** A sentence that may carry crew names, as this browser draws it. */
export const shownText = (text: string): string => (castOn() ? String(text ?? "").replace(/ · AI\b/g, "") : text);
