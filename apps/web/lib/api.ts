/** Client for the mission platform API. Identity is the HttpOnly session cookie; nothing sensitive is kept in JS. */
export const CORE_ORIGIN = process.env.NEXT_PUBLIC_CORE_ORIGIN ?? "";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: "GET" | "POST" | "DELETE", route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${CORE_ORIGIN}${route}`, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? data?.detail ?? res.statusText, res.status, data);
  return data as T;
}

export const wsUrl = (path: string): string => {
  const origin = CORE_ORIGIN || window.location.origin;
  return `${origin.replace(/^http/, "ws")}${path}`;
};

export interface Account { id: string; username: string; displayName: string; role: "admin" | "member" }
export interface Member { accountId: string; displayName: string; role: "lead" | "engineer" | "viewer"; discipline: string | null }
export interface Check { id: string; description: string; status: "pass" | "warn" | "fail"; detail: string }
export interface ObjectiveResult { id: string; title: string; description: string; category: string; weight: number; value: number | null; unit: string; target: number; achieved: number; points: number; feedback: string }
export interface MissionOutcome { verdict: "not_ready" | "ready_to_fly" | "success" | "partial" | "failed"; headline: string; conditions: { id: string; title: string; met: boolean | null; evidence: string }[]; rule: string }
export interface Evaluation {
  outcome?: MissionOutcome; score: number; grade: string; objectivesScore: number; rigorScore: number; penalties: { reason: string; points: number }[]; categories: Record<string, { earned: number; possible: number }>; objectives: ObjectiveResult[]; rigor: { item: string; earned: number; possible: number; detail: string }[]; strengths: string[]; improvements: string[]; simulated: boolean; basis: string }
export interface Maturity { level: number; levelName: string; criteria: { level: number; id: string; description: string; met: boolean; evidence: string }[]; nextSteps: string[]; basis: string }
export interface MissionVersion { version: number; config: any; derived: Record<string, { value: any; assumptions: string[]; verification: string; error?: string }>; recalculated: string[]; changedPaths?: string[]; publishedAt: string; publishedBy: string; note: string }
export interface Presence { clientId: string; accountId: string; displayName: string; color: string; mode: "desktop" | "xr"; role?: string; discipline?: string | null; head?: number[] | null; hands?: { left: number[] | null; right: number[] | null }; focus?: string | null; /** A place on the world they are pointing at: [latitude, east longitude] in degrees. */ point?: number[] | null }
export interface Snapshot {
  session: any; mission: MissionVersion; checks: Check[]; game: any; maturity: Maturity; evaluation: Evaluation; locks: Record<string, string>;
  scenario: { id: string; title: string; tagline: string; briefing: string[]; scienceQuestions: string[]; references: string[]; catalog: any[]; disciplines: { id: string; name: string; description: string }[] };
  versions: any[]; you?: any; inviteCode?: string;
  /** What crews before this one learned on the same kind of mission (the record the AI reads), and how many records there are in all. */
  knowledge?: { lessons: { kind: string; text: string; mission: string; at: string }[]; records: number };
  /** The roles this problem came with: what each answers for, whether that holds now, and who has taken it. */
  roles?: { seat: string; holder: string | null; label: string; ok: boolean; detail: string }[];
  systemsGuide?: { ports: Record<string, { name: string; kind: string; dir: string; unit: string; label: string }[]>; signals: { name: string; unit: string; meaning: string }[]; targets: string[] };
}

export async function currentAccount(): Promise<Account | null> {
  try {
    return (await api<{ account: Account | null }>("GET", "/api/auth/me")).account;
  } catch {
    return null;
  }
}

/** Short display formats for engineering numbers. */
export function fmt(v: unknown, digits = 3): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v !== "number") return String(v);
  if (!Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return Number(v.toPrecision(digits)).toString();
}

/**
 * Change page. The screen is covered in black for one painted frame before the browser leaves,
 * so a half-torn-down page (a 3D canvas that has already lost its picture) is never shown.
 */
export function go(url: string): void {
  const viaShell = (window as unknown as { __go?: (u: string) => void }).__go;
  if (viaShell) viaShell(url);
  else window.location.assign(url);
}

/** A moment as the product writes it everywhere: "15 Nov 2026, 05:30" in the viewer's time zone, in English whatever the browser's language. */
export const whenText = (at: string | number | Date): string => new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
/** A day: "15 Nov 2026". */
export const dayText = (at: string | number | Date): string => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
/** A time of day: "05:30:24". */
export const clockText = (at: string | number | Date): string => new Date(at).toLocaleTimeString("en-GB", { hour12: false });
