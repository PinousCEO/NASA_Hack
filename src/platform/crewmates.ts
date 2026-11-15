/**
 * AI crewmates: software players that join a mission and work on it alongside the people in it.
 *
 * A crewmate is a real member of the mission. It signs in with an account of its own (named "… · AI" so nobody
 * takes it for a person), takes one of the mission's roles, and from then on does what a player in that role
 * does — through the same HTTP API and the same live channel a browser uses, so every rule that applies to a
 * player applies to it: its changes are validated, need approval where a player's would, are listed in the crew
 * feed under its name, and move the score.
 *
 * What it decides is driven by the mission's own state, read each turn from the engineering models: it looks
 * after its role's priority (the same "watch" the crew is scored on), connects parts that are not connected,
 * points at the place the mission is about, answers when spoken to, says so when someone else's change breaks
 * what it answers for, and says when the mission is ready (it flies it when told to). It does not call a language model: its choices
 * are rules over real numbers, and its sentences are built from those numbers.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AuthService } from "./auth.js";
import type { MissionSession } from "./sessions.js";

const NAMES = ["Hana", "Leo", "Jun"] as const;
/** A label inside a sentence: first letter lowered, the rest (units, names) left as written. */
const inline = (label: string): string => label.charAt(0).toLowerCase() + label.slice(1);

interface Crewmate { name: string; username: string; accountId: string; cookie: string; ws: WebSocket | null; seat: string | null; said: Set<string>; tries: Map<string, number>; lastChat: number; quietUntil: number; introduced: boolean; /** Put before whatever it says next (why this crewmate is the one acting). */ opening: string }
interface Team { sessionId: string; base: string; mates: Crewmate[]; timer: NodeJS.Timeout; turn: number; actions: number; pointed: boolean; flown: boolean; heard: number; busy: boolean; stopped: boolean; /** Do the crewmates change the design on their own, or ask first? They ask, unless the player hands the mission over. */ auto: boolean; /** What a crewmate has offered and is waiting to be told to do. */ offer: { mate: string; seat: string; key: string } | null }

export class CrewmateService {
  private readonly teams = new Map<string, Team>();
  private readonly secrets: Record<string, string> = {};
  private readonly file: string | null;

  /** The session each crewmate signed in with, by username (kept in memory only). */
  private readonly signedIn = new Map<string, string>();

  constructor(private readonly auth: AuthService, dataDir: string | null, /** The name of the server's session cookie. */ private readonly cookieName = "ms_session") {
    this.file = dataDir ? path.join(dataDir, "auth", "crewmates.json") : null;
    if (this.file && existsSync(this.file)) {
      try { Object.assign(this.secrets, JSON.parse(readFileSync(this.file, "utf8"))); } catch { /* start with new passwords */ }
    }
  }

  active(sessionId: string): string[] {
    return (this.teams.get(sessionId)?.mates ?? []).map((m) => `${m.name} · AI`);
  }

  /** Bring up to `count` AI crewmates into a mission (as many as there are free seats). `base` is this server's own address. */
  async start(session: MissionSession, base: string, count: number): Promise<string[]> {
    this.stop(session.meta.id);
    const free = Math.max(0, 4 - session.meta.members.filter((m) => !/· AI$/.test(m.displayName)).length);
    const n = Math.max(0, Math.min(3, Math.round(count), free));
    const mates: Crewmate[] = [];
    for (const name of NAMES.slice(0, n)) {
      const username = `ai-${name.toLowerCase()}`;
      const password = (this.secrets[username] ??= randomBytes(18).toString("base64url"));
      this.persist();
      // A crewmate signs in once while the server runs and keeps that session for every mission it joins. Signing in
      // again for each mission used up the sign-in allowance that everyone on this address shares: after a few
      // missions in a row the crewmates (and the people at this address) were turned away for ten minutes.
      let token = this.signedIn.get(username);
      let account = token ? this.auth.authenticate(token) : undefined;
      if (!token || !account) {
        try { await this.auth.register({ username, password, displayName: `${name} · AI` }, `crewmate:${username}`); } catch { /* the account is already there */ }
        const fresh = await this.auth.login(username, password, `crewmate:${username}`);
        token = fresh.token;
        account = fresh.account;
        this.signedIn.set(username, token);
      }
      // The crewmate joins as any player does; the invite code of an invite-only mission is supplied by the lead who asked for it.
      session.join(account, session.meta.inviteCode);
      const cookie = `${this.cookieName}=${token}`;
      mates.push({ name, username, accountId: account.id, cookie, ws: null, seat: null, said: new Set(), tries: new Map(), lastChat: 0, quietUntil: 0, introduced: false, opening: "" });
    }
    if (!mates.length) return [];
    const team: Team = { sessionId: session.meta.id, base, mates, turn: 0, actions: 0, pointed: false, flown: false, heard: Date.now(), busy: false, stopped: false, auto: false, offer: null, timer: setInterval(() => void this.tick(team), 5200) };
    team.timer.unref();
    this.teams.set(session.meta.id, team);
    for (const mate of mates) await this.connect(team, mate).catch(() => undefined);
    return mates.map((m) => `${m.name} · AI`);
  }

  stop(sessionId: string): void {
    const team = this.teams.get(sessionId);
    if (!team) return;
    team.stopped = true;
    clearInterval(team.timer);
    for (const m of team.mates) { try { m.ws?.close(); } catch { /* already closed */ } }
    this.teams.delete(sessionId);
  }

  stopAll(): void {
    for (const id of [...this.teams.keys()]) this.stop(id);
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.secrets), { mode: 0o600 });
  }

  // ---------- what a crewmate can do: exactly what a signed-in player can ----------
  private async call(team: Team, mate: Crewmate, method: string, route: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${team.base}/api/sessions/${team.sessionId}${route}`, { method, headers: { "content-type": "application/json", cookie: mate.cookie }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  private async connect(team: Team, mate: Crewmate): Promise<void> {
    const t = await fetch(`${team.base}/api/auth/ws-ticket`, { method: "POST", headers: { "content-type": "application/json", cookie: mate.cookie }, body: "{}" });
    const ticket = ((await t.json().catch(() => null)) as { ticket?: string } | null)?.ticket;
    if (!ticket) return;
    const ws = new WebSocket(`${team.base.replace(/^http/, "ws")}/ws?session=${encodeURIComponent(team.sessionId)}&ticket=${encodeURIComponent(ticket)}`);
    mate.ws = ws;
    ws.onmessage = (event) => {
      let m: any;
      try { m = JSON.parse(String(event.data)); } catch { return; }
      // What people say to the crew is heard by every crewmate; the next turn answers it.
      if (m.type === "crew.say" && m.message && !/· AI$/.test(String(m.message.displayName)) && m.message.at > team.heard - 1) {
        const box = (((team as any).inbox ?? []) as { who: string; text: string; at: number; id?: string }[]);
        const seen = (((team as any).heardIds ??= new Set<string>()) as Set<string>);
        if (!seen.has(String(m.message.id))) { seen.add(String(m.message.id)); (team as any).inbox = [...box, { who: m.message.displayName, text: String(m.message.text), at: m.message.at }].slice(-6); }
      }
    };
    ws.onclose = () => { if (!team.stopped) setTimeout(() => void this.connect(team, mate).catch(() => undefined), 3000).unref(); };
    ws.onerror = () => { try { ws.close(); } catch { /* closed */ } };
  }

  private send(mate: Crewmate, message: Record<string, unknown>): void {
    try { if (mate.ws?.readyState === 1) mate.ws.send(JSON.stringify(message)); } catch { /* the next turn tries again */ }
  }

  private say(team: Team, mate: Crewmate, text: string, key?: string): boolean {
    if (key && mate.said.has(key)) return false;
    if (key) mate.said.add(key);
    mate.lastChat = Date.now();
    this.send(mate, { type: "say", text: (mate.opening + text).slice(0, 236) });
    return true;
  }

  /** Something only one crewmate should say (the others would only repeat it). */
  private teamSay(team: Team, mate: Crewmate, text: string, key: string): boolean {
    const said = ((team as Team & { said?: Set<string> }).said ??= new Set<string>());
    if (said.has(key)) return false;
    said.add(key);
    return this.say(team, mate, text);
  }

  /** Go to a part (or "bus" for the spacecraft as a whole) and stay there for a while: seen as the crewmate's probe working on it. */
  private focus(mate: Crewmate, componentId: string | null): void {
    this.send(mate, { type: "presence", mode: "desktop", focus: componentId ? (componentId === "bus" ? "spacecraft.bus" : `spacecraft.components.${componentId}`) : null });
    if (componentId) setTimeout(() => this.send(mate, { type: "presence", focus: null }), 7000).unref();
  }

  private async edit(team: Team, mate: Crewmate, snap: any, patches: unknown[], summary: string): Promise<boolean> {
    const r = await this.call(team, mate, "POST", "/edit", { baseVersion: snap.mission.version, patches, summary });
    return r.status < 300 && r.body?.ok !== false;
  }

  // ---------- one turn: one crewmate does one thing ----------
  private async tick(team: Team): Promise<void> {
    if (team.busy || team.stopped) return;
    team.busy = true;
    try {
      const mate = team.mates[team.turn++ % team.mates.length]!;
      if (Date.now() < mate.quietUntil) return;
      const got = await this.call(team, mate, "GET", "");
      const snap = got.body;
      if (got.status === 403 || got.status === 404 || (snap?.session && !(snap.session.members as any[]).some((m) => m.accountId === mate.accountId))) {
        // A person took this crewmate's seat (or the mission is gone): it leaves.
        team.mates = team.mates.filter((m) => m !== mate);
        try { mate.ws?.close(); } catch { /* closed */ }
        if (!team.mates.length) this.stop(team.sessionId);
        return;
      }
      if (!snap?.mission) return;
      if (snap.game?.submitted) { this.teamSay(team, mate, "Mission submitted.", "submitted"); return; }
      await this.act(team, mate, snap);
    } catch {
      /* a failed turn is skipped; the next one reads the mission afresh */
    } finally {
      team.busy = false;
    }
  }

  private async act(team: Team, mate: Crewmate, snap: any): Promise<void> {
    const num = (v: unknown, digits = 1): string => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(Math.abs(v) >= 100 ? 0 : digits) : "–");
    const watches: { seat: string; holder: string | null; label: string; ok: boolean; detail: string }[] = snap.roles ?? [];
    const comps: any[] = snap.mission.config.spacecraft.components;
    const derived = (id: string): any => snap.mission.derived[id]?.value ?? {};
    const outcome = snap.evaluation?.outcome;
    const tried = (key: string, max: number): boolean => { const n = (mate.tries.get(key) ?? 0) + 1; mate.tries.set(key, n); return n <= max; };

    // 1. Take a role and say who you are.
    if (!mate.seat) {
      const mine = watches.find((w) => w.holder === mate.accountId);
      const open = mine ?? watches.find((w) => !w.holder);
      if (open && !mine) await this.call(team, mate, "POST", "/role", { seat: open.seat });
      mate.seat = open?.seat ?? "Crew";
    }
    const watch = watches.find((w) => w.seat === mate.seat);
    if (!mate.introduced) {
      mate.introduced = true;
    }

    // 2. Someone spoke: answer if it is for this crewmate (by name, or for everyone).
    const inbox: { who: string; text: string; at: number }[] = (team as any).inbox ?? [];
    // A message that names a crewmate is for that one; a message that names none is taken by whoever's turn it is
    // (it is removed once answered, so only one of them replies).
    const named = (text: string): string | null => NAMES.find((n) => new RegExp(`\\b${n}\\b`, "i").test(text)) ?? null;
    const msg = inbox.find((m) => m.at > team.heard - 1 && (named(m.text) === mate.name || (named(m.text) === null && (!team.offer || team.offer.mate === mate.name || !/^\W*(yes|ok|okay|sure|do it|go ahead|응|네|그래|좋아|해줘)/i.test(m.text)))));
    if (msg) {
      (team as any).inbox = inbox.filter((m) => m !== msg);
      if (/\b(stop|wait|hold|pause)\b|그만|멈춰|잠깐/i.test(msg.text)) { team.auto = false; team.offer = null; for (const m of team.mates) m.quietUntil = Date.now() + 30000; this.say(team, mate, `Holding. Nothing changes until you say so.`); return; }
      if (/\b(take over|take it from here|autopilot|solve it|finish it|do it all|your turn)\b|알아서|맡길게|다\s*해/i.test(msg.text)) { team.auto = true; team.offer = null; this.say(team, mate, `Taking our roles. Say “stop” to take it back.`); return; }
      if (team.offer && /^\W*(yes|yeah|yep|ok|okay|sure|do it|go ahead|go on|please do|agreed)\b|^\W*(응|네|예|그래|좋아|해줘|해 줘|부탁)/i.test(msg.text.replace(new RegExp(`\\b(${NAMES.join("|")})\\b[,:]?\\s*`, "ig"), ""))) {
        const offer = team.offer;
        team.offer = null;
        const who = team.mates.find((m) => m.name === offer.mate) ?? mate;
        const w = watches.find((x) => x.seat === offer.seat) ?? { label: offer.seat, detail: "" };
        const done = await this.tend(team, who, snap, offer.seat, w, () => true, num, "");
        if (!done) this.say(team, who, "Nothing left to change there.");
        else team.actions++;
        return;
      }
      if (/\b(fly|simulate|launch|run the flight)\b/i.test(msg.text)) { await this.fly(team, mate, snap, true); return; }
      if (/\b(point|where|show)\b/i.test(msg.text) && snap.session.world?.target) { this.point(team, mate, snap); return; }
      this.say(team, mate, watch ? `${msg.who.split(" ")[0]}: ${mate.seat} — ${inline(watch.label)} ${watch.ok ? "holds" : "does not hold"} (${watch.detail}). ${outcome?.headline ?? ""}` : `${msg.who.split(" ")[0]}: ${outcome?.headline ?? "working on it."}`);
      return;
    }
    if (team.actions >= 48) return;

    // 3. A part that is on board but not connected does nothing: connect it.
    const loose = (derived("systems.wiring").parts ?? []).find((p: any) => p.notes?.length);
    if (loose && tried(`connect:${loose.id}`, 2)) {
      this.focus(mate, loose.id);
      const r = await this.call(team, mate, "POST", "/connect", { componentId: loose.id, wait: true });
      team.actions++;
      this.say(team, mate, r.body?.status === "awaiting_approval" ? `Proposed: connect ${loose.name}. Waiting for the lead's yes.` : `Connected ${loose.name}.`);
      return;
    }

    // 4. Point out the place this mission is about, once.
    if (!team.pointed && snap.session.world?.target) { team.pointed = true; this.point(team, mate, snap); return; }

    // Working with the player, not instead of them: unless the mission was handed over, a crewmate says what it
    // would change and why, and changes it only when told to.
    if (!team.auto) {
      const own = watch && !watch.ok && this.plan(snap, mate.seat!) ? { seat: mate.seat!, watch } : null;
      const concern = own ?? (() => { const empty = watches.find((w) => !w.holder && !w.ok && this.plan(snap, w.seat)); return empty ? { seat: empty.seat, watch: empty } : null; })();
      const key = concern ? `${concern.seat}:${concern.watch.detail}` : "";
      if (concern && team.offer?.key !== key && !mate.said.has(`offer:${key}`)) {
        mate.said.add(`offer:${key}`);
        const plan = this.plan(snap, concern.seat);
        if (plan) {
          team.offer = { mate: mate.name, seat: concern.seat, key };
          this.say(team, mate, `Proposal · ${concern.seat} (${concern.watch.detail}): ${plan}`.slice(0, 200) + " Reply “yes” to apply.");
          return;
        }
      }
      const outcomeNow = outcome?.verdict;
      if (outcomeNow === "ready_to_fly" && this.teamSay(team, mate, "Ready to fly. Say “fly the mission”.", `ready:${snap.mission.version}`)) return;
      if (["success", "partial", "failed"].includes(outcomeNow) && this.teamSay(team, mate, `${outcome.headline} Score ${Number(snap.evaluation.score).toFixed(0)}.`, `flown:${snap.mission.version}`)) return;
      return;
    }

    // Once the mission has been flown the design is left as it flew: a change now would only undo the flight.
    if (team.flown || ["success", "partial", "failed"].includes(outcome?.verdict)) { if (["success", "partial", "failed"].includes(outcome?.verdict)) this.teamSay(team, mate, `${outcome.headline} Score ${Number(snap.evaluation.score).toFixed(0)}.`, `flown:${snap.mission.version}`); return; }

    // 5. Look after what this role answers for.
    if (watch && !watch.ok) {
      const done = await this.tend(team, mate, snap, mate.seat, watch, tried, num);
      if (done) { team.actions++; return; }
    }

    // 5b. A seat nobody has taken is still work to be done: cover it, and say that is what is happening.
    const people = (snap.session.members as any[]).filter((m) => !/· AI$/.test(m.displayName));
    const empty = watches.find((w) => !w.holder && !w.ok);
    if (empty) {
      const done = await this.tend(team, mate, snap, empty.seat, empty, tried, num, "");
      if (done) { team.actions++; return; }
    }
    // The launch vehicle belongs to whoever looks after mass and money; with no such seat taken, a crewmate chooses it.
    const launchOpen = outcome?.conditions?.find((k: any) => k.id === "launch" && k.met === false);
    const scienceMet = outcome?.conditions?.find((k: any) => k.id === "science")?.met;
    if (launchOpen && scienceMet && !watches.some((w) => w.holder && /system|lead|launch|mass|cost|budget/i.test(w.seat))) {
      const done = await this.tend(team, mate, snap, "Systems", { label: "Stay inside mass, cost and schedule", detail: launchOpen.evidence }, tried, num);
      if (done) { team.actions++; return; }
    }
    // A person holds a seat whose priority is open: suggest, do not do it for them.
    const theirs = watches.find((w) => !w.ok && people.some((p) => p.accountId === w.holder));
    if (theirs && /payload|science|instrument/i.test(theirs.seat)) {
      const aboard = new Set(comps.map((c) => c.name));
      const next = (snap.session.kit?.toolbox ?? []).map((t: any) => (snap.scenario.catalog as any[]).find((i) => i.id === t.itemId)).find((i: any) => i && !aboard.has(i.component.name));
      const who = String(people.find((p) => p.accountId === theirs.holder)?.displayName ?? "").split(" ")[0];
      if (next && this.teamSay(team, mate, `${who}, ${theirs.seat} is yours: the kit has the ${next.label.split(" · ")[0]} (${next.component.massKg} kg, $${next.component.costMusd}M). Adding it would move "${theirs.label}" (${theirs.detail}). Your call.`, `suggest:${next.id}`)) return;
    }

    // 6. Someone else's priority is broken: say so once (that is where a crew has to talk).

    // 7. Ready on paper: say so. The launch is the crew's to call ("fly the mission"), not something that just happens.
    if (outcome?.verdict === "ready_to_fly" && !team.flown) { this.teamSay(team, mate, "Ready to fly. Say “fly the mission”.", `ready:${snap.mission.version}`); return; }
    if (["success", "partial", "failed"].includes(outcome?.verdict)) { this.teamSay(team, mate, `${outcome.headline} Score ${Number(snap.evaluation.score).toFixed(0)}.`, `flown:${snap.mission.version}`); return; }

    // 8. Nothing to do for this role: say where it stands, now and then.
  }

  /** What a role would change about its priority, said before it is done. Null when it has nothing to propose. */
  private plan(snap: any, seatName: string): string | null {
    const seat = seatName.toLowerCase();
    const comps: any[] = snap.mission.config.spacecraft.components;
    const derived = (id: string): any => snap.mission.derived[id]?.value ?? {};
    if (/power|energy|electric|batter/.test(seat)) {
      const p = derived("power.budget");
      const array = comps.find((c) => c.type === "solar_panel");
      const battery = comps.find((c) => c.type === "battery");
      if (typeof p.marginW === "number" && p.marginW < 0 && array) return `I would grow the ${array.name} from ${array.areaM2} to ${Math.round(array.areaM2 * 1.3 * 100) / 100} m²: more power, more mass and money.`;
      if (p.batteryAdequate === false && battery) return `I would take the ${battery.name} from ${battery.capacityWh} to ${Math.round(battery.capacityWh * 1.4)} Wh to carry us through the shadow.`;
      return null;
    }
    if (/comm|link|radio|ground|downlink|telecom|relay/.test(seat)) {
      const antenna = comps.find((c) => c.type === "antenna");
      return antenna ? `I would halve the data rate of the ${antenna.name}: a stronger link, less data per pass.` : null;
    }
    if (/software|control|autonom|operation|logic/.test(seat)) return (snap.mission.config.systems?.controllers ?? []).length ? null : "I would put control logic on board that runs the instruments a quarter of the time when power is short.";
    if (/payload|science|instrument|imag|observ|data/.test(seat)) {
      const aboard = new Set(comps.map((c) => c.name));
      const next = (snap.session.kit?.toolbox ?? []).map((t: any) => (snap.scenario.catalog as any[]).find((i) => i.id === t.itemId)).find((i: any) => i && !aboard.has(i.component.name));
      return next ? `One way: add the ${next.label.split(" · ")[0]} (${next.component.massKg} kg, $${next.component.costMusd}M${next.component.powerW ? `, ${next.component.powerW} W` : ""}).` : null;
    }
    if (/orbit|dynamics|trajector|navigat|mission design|coverage/.test(seat)) {
      if (!comps.some((c) => c.type === "instrument")) return null;
      const open = (snap.evaluation.objectives as any[]).filter((o) => ["polar", "coverage", "footprint", "imaging", "detail"].includes(o.id) && o.achieved < 1);
      if (open.some((o) => o.id === "polar" || o.id === "coverage")) return "I would tilt the orbit so it passes over the place: a steeper launch lifts a little less.";
      if (open.length) return "I would lower the orbit by a fifth: sharper measurements, longer shadows.";
      return null;
    }
    const launch = derived("launch.vehicle");
    if (launch?.options?.length && (launch.selectedId === null || (launch.marginKg ?? 0) < 0)) return "I would choose the cheapest launch vehicle that can lift us.";
    return null;
  }

  private point(team: Team, mate: Crewmate, snap: any): void {
    const t = snap.session.world.target;
    // The pointer comes in the way a hand moves a mouse: from a little way off, in a few steps, and settles on the place.
    const from = [Math.max(-85, Math.min(85, t.latDeg + 8)), t.lonDeg - 13];
    for (let i = 0; i <= 4; i++) setTimeout(() => this.send(mate, { type: "presence", mode: "desktop", point: [from[0]! + ((t.latDeg - from[0]!) * i) / 4, from[1]! + ((t.lonDeg - from[1]!) * i) / 4] }), i * 380).unref();
    this.say(team, mate, `Pointing at ${t.name}: the place this mission is about.`);
    setTimeout(() => this.send(mate, { type: "presence", point: null }), 25000).unref();
  }

  private async fly(team: Team, mate: Crewmate, snap: any, asked: boolean): Promise<void> {
    if (snap.evaluation?.outcome?.verdict === "not_ready" && !asked) return;
    team.flown = true;
    this.focus(mate, "bus");
    this.say(team, mate, "Running the flight.");
    const sim = (await this.call(team, mate, "POST", "/simulate", {})).body;
    team.actions++;
    const after = (await this.call(team, mate, "GET", "")).body;
    const o = after?.evaluation?.outcome;
    if (o) this.say(team, mate, `${o.headline}${sim?.kpis ? ` ${Number(sim.kpis.totalDataReturnedGb).toFixed(0)} Gb came home.` : ""}`);
  }

  /** What a role does about its own priority. Returns true if it did or said something. */
  private async tend(team: Team, mate: Crewmate, snap: any, as: string | null, watch: { label: string; detail: string }, tried: (key: string, max: number) => boolean, num: (v: unknown, d?: number) => string, opening = ""): Promise<boolean> {
    const comps: any[] = snap.mission.config.spacecraft.components;
    const derived = (id: string): any => snap.mission.derived[id]?.value ?? {};
    const seat = (as ?? "").toLowerCase();
    // Whatever is said while tending starts with why this crewmate is the one doing it.
    mate.opening = opening;
    try {
      return await this.tendAs(team, mate, snap, seat, watch, tried, num, comps, derived);
    } finally {
      mate.opening = "";
    }
  }

  private async tendAs(team: Team, mate: Crewmate, snap: any, seat: string, watch: { label: string; detail: string }, tried: (key: string, max: number) => boolean, num: (v: unknown, d?: number) => string, comps: any[], derived: (id: string) => any): Promise<boolean> {
    const overBudget = (snap.checks as any[]).filter((c) => c.status === "fail" && /mass|cost|launch/.test(c.id));

    if (/power|energy|electric|batter/.test(seat)) {
      const p = derived("power.budget");
      const array = comps.find((c) => c.type === "solar_panel");
      const battery = comps.find((c) => c.type === "battery");
      if (typeof p.marginW === "number" && p.marginW < 0 && array && tried("array", 4)) {
        const next = Math.round(array.areaM2 * 1.3 * 100) / 100;
        this.focus(mate, array.id);
        const ok = await this.edit(team, mate, snap, [{ op: "set", path: `spacecraft.components.${array.id}.areaM2`, value: next }], `${array.name}: area ${array.areaM2} → ${next} m²`);
        this.say(team, mate, ok ? `${array.name}: ${array.areaM2} → ${next} m² (power was ${num(p.marginW)} W short).` : `Change refused: ${array.name} to ${next} m².`);
        return true;
      }
      if (p.batteryAdequate === false && battery && tried("battery", 3)) {
        const next = Math.round(battery.capacityWh * 1.4);
        this.focus(mate, battery.id);
        await this.edit(team, mate, snap, [{ op: "set", path: `spacecraft.components.${battery.id}.capacityWh`, value: next }], `${battery.name}: ${battery.capacityWh} → ${next} Wh`);
        this.say(team, mate, `${battery.name}: ${battery.capacityWh} → ${next} Wh (too small for the shadow).`);
        return true;
      }
      return false;
    }
    if (/comm|link|radio|ground|downlink|telecom|relay/.test(seat)) {
      const l = derived("comms.link");
      const antenna = comps.find((c) => c.type === "antenna");
      if (antenna && typeof l.worstMarginDb === "number" && l.worstMarginDb < 3 && tried("rate", 3)) {
        const next = antenna.dataRateBps / 2;
        this.focus(mate, antenna.id);
        await this.edit(team, mate, snap, [{ op: "set", path: `spacecraft.components.${antenna.id}.dataRateBps`, value: next }], `${antenna.name}: data rate halved`);
        this.say(team, mate, `${antenna.name}: data rate halved (link margin was ${num(l.worstMarginDb)} dB).`);
        return true;
      }
      return false;
    }
    if (/software|control|autonom|operation|logic/.test(seat)) {
      if ((snap.mission.config.systems?.controllers ?? []).length === 0 && tried("controller", 1)) {
        const controller = { id: `ctl-${mate.name.toLowerCase()}`, name: "Power saver", description: "Runs the instruments a quarter of the time when power is short.", hostId: "bus", memory: { saving: 0 }, rules: [{ when: "power.marginW < 0 or battery.soc < 0.6", do: [{ target: "mem:saving", value: "1" }] }, { when: "battery.soc > 0.9 and power.marginW >= 0", do: [{ target: "mem:saving", value: "0" }] }, { when: "mem.saving == 1", do: [{ target: "instruments", value: "nominal * 0.25" }], note: "saving power" }], origin: { kind: "user_authored" } };
        this.focus(mate, "bus");
        const ok = await this.edit(team, mate, snap, [{ op: "append", path: "systems.controllers", value: controller }], "Install Power saver control logic");
        this.say(team, mate, ok ? "Installed control logic: Power saver (instruments at a quarter when power is short)." : "Change refused: control logic.");
        return true;
      }
      return false;
    }
    if (/payload|science|instrument|imag|observ|data/.test(seat)) {
      const aboard = new Set(comps.map((c) => c.name));
      const next = (snap.session.kit?.toolbox ?? []).map((t: any) => (snap.scenario.catalog as any[]).find((i) => i.id === t.itemId)).find((i: any) => i && !aboard.has(i.component.name));
      if (!next) return false;
      if (overBudget.length) return this.say(team, mate, `Not adding ${next.label.split(" · ")[0]}: it would break ${overBudget[0].description}.`, `want:${next.id}:${overBudget[0].id}`);
      // A part is put forward once, by one crewmate: the others do not repeat it while it waits for the lead's yes.
      const offered = (((team as any).offered ??= new Set<string>()) as Set<string>);
      if (offered.has(next.id) || !tried(`add:${next.id}`, 1)) return false;
      offered.add(next.id);
      this.focus(mate, "bus");
      const r = await this.call(team, mate, "POST", "/catalog", { itemId: next.id, wait: true });
      const added = ((await this.call(team, mate, "GET", "")).body?.mission?.config?.spacecraft?.components ?? []).find((c: any) => c.name === next.component.name);
      if (added) this.focus(mate, added.id);
      this.say(team, mate, r.body?.status === "awaiting_approval" ? `Proposed: add ${next.label.split(" · ")[0]}. Waiting for the lead's yes.` : `Added ${next.label.split(" · ")[0]} (${next.component.massKg} kg, $${next.component.costMusd}M${next.component.powerW ? `, ${next.component.powerW} W` : ""}).`);
      return true;
    }
    if (/orbit|dynamics|trajector|navigat|mission design|coverage/.test(seat)) {
      const orbit = snap.mission.config.orbit;
      const body = snap.mission.config.centralBody as string;
      const open = (snap.evaluation.objectives as any[]).filter((o) => ["polar", "coverage", "footprint", "imaging"].includes(o.id) && o.achieved < 1);
      if (open.some((o) => o.id === "polar" || o.id === "coverage") && Math.abs(orbit.inclinationDeg - 90) > 5 && tried("inclination", 1)) {
        this.focus(mate, "bus");
        await this.edit(team, mate, snap, [{ op: "set", path: "orbit.inclinationDeg", value: body === "earth" ? 97 : 90 }], `Orbit tilt → ${body === "earth" ? 97 : 90}°`);
        this.say(team, mate, `Orbit tilt → ${body === "earth" ? 97 : 90}° (to pass over the place).`);
        return true;
      }
      const radius = ({ earth: 6378.137, moon: 1737.4, mars: 3396.19 } as Record<string, number>)[body] ?? 6378;
      const altitude = orbit.semiMajorAxisKm - radius;
      const floor = body === "earth" ? 420 : body === "moon" ? 50 : 250;
      const hasInstrument = comps.some((c) => c.type === "instrument");
      if (!hasInstrument && open.length) return false;
      if (open.some((o) => o.id === "footprint" || o.id === "imaging") && altitude > floor * 1.15 && tried("altitude", 3)) {
        const next = Math.max(floor, Math.round(altitude * 0.8));
        this.focus(mate, "bus");
        await this.edit(team, mate, snap, [{ op: "set", path: "orbit.semiMajorAxisKm", value: radius + next }], `Orbit altitude → ${next} km`);
        this.say(team, mate, `Orbit ${num(altitude, 0)} → ${next} km (sharper measurements, longer shadows).`);
        return true;
      }
      return false;
    }
    // Systems, lead, launch, mass, cost — and any role without a priority of its own.
    const launch = derived("launch.vehicle");
    const mass = derived("mass.budget").totalMassKg ?? 0;
    if (launch?.options?.length && (launch.selectedId === null || (launch.marginKg ?? 0) < 0) && tried("launch", 3)) {
      const fit = [...launch.options].sort((a: any, b: any) => a.costMusd - b.costMusd).find((o: any) => o.capacityKg >= mass);
      if (fit && fit.id !== launch.selectedId) {
        this.focus(mate, "bus");
        await this.edit(team, mate, snap, [{ op: "set", path: "meta.launchVehicleId", value: fit.id }], `Launch vehicle → ${fit.name}`);
        this.say(team, mate, `Launch vehicle → ${fit.name} (lifts ${num(fit.capacityKg)} kg, $${num(fit.costMusd)}M; we weigh ${num(mass)} kg).`);
        return true;
      }
    }
    if (overBudget.length) {
      const costly = [...comps].sort((a, b) => (b.costMusd ?? 0) - (a.costMusd ?? 0))[0];
      return this.say(team, mate, `Over a limit: ${overBudget[0].description} (${overBudget[0].detail}). Costliest part: ${costly?.name} ($${costly?.costMusd}M).`, `over:${overBudget[0].id}:${overBudget[0].detail}`);
    }
    return false;
  }
}
