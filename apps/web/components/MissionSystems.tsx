"use client";
/**
 * The spacecraft as a system: every part's ports, the lines between them and what each carries,
 * and the control logic running on board.
 *
 * Everything shown here is read from the shared mission and the engineering models' "systems.wiring"
 * result — which part is powered, how much of its data is recorded, what each line carries against
 * its rating. A line or a controller added here goes through the same validation as any other
 * change: an incompatible connection is refused with the reason.
 */
import { useState } from "react";
import { api, fmt } from "@/lib/api";
import { bus } from "@/lib/bus";
import { commit, type Ctx } from "./MissionPanels";

const KIND_UNIT: Record<string, string> = { power: "W", data: "bit/s", control: "" };
const rate = (v: number | null | undefined, unit: string): string => (v === null || v === undefined ? "–" : unit === "bit/s" ? `${fmt(v)} bit/s` : `${fmt(v)} ${unit}`);
const locked = (c: Ctx): boolean => c.role === "viewer" || Boolean(c.snap.game.submitted);

interface Wiring { wired: boolean; parts: any[]; links: any[]; harnessMassKg: number; unconnected: string[]; limited: string[] }
const wiringOf = (c: Ctx): Wiring | null => (c.snap.mission.derived["systems.wiring"]?.value as unknown as Wiring | null) ?? null;
const nodeName = (c: Ctx, node: string): string => (node === "bus" ? "Bus" : (c.snap.mission.config.spacecraft.components.find((x: any) => x.id === node)?.name ?? node));
const endName = (c: Ctx, end: string): string => { const [node, port] = end.split("."); return `${nodeName(c, node!)} · ${String(port).replace(/_/g, " ")}`; };

async function connect(c: Ctx, componentId: string): Promise<void> {
  try {
    await api("POST", `/api/sessions/${c.sid}/connect`, { componentId });
    c.reloadLists();
    c.toast("Lines are being fitted and tested…", "info");
  } catch (err) { c.toast((err as Error).message, "warn"); }
}

/** The card for the part that is selected: what it is, its ports, what is plugged into each, and what is wrong. */
export function PartCard({ c, part, onClose, onAdjust }: { c: Ctx; part: any; onClose(): void; onAdjust(): void }) {
  const wiring = wiringOf(c);
  const status = wiring?.parts.find((p) => p.id === part.id);
  const ports = c.snap.systemsGuide?.ports[part.type] ?? [];
  const links: any[] = c.snap.mission.config.systems?.links ?? [];
  const flows = new Map((wiring?.links ?? []).map((l) => [l.id, l]));
  const facts: [string, string][] = [["Mass", `${fmt(part.massKg)} kg`], ["Cost", `$${fmt(part.costMusd)}M`], ...(part.powerW !== undefined ? [["Draws", `${part.powerW} W`] as [string, string]] : []), ...(part.dcPowerW !== undefined ? [["Draws", `${part.dcPowerW} W`] as [string, string]] : []), ...(part.areaM2 ? [["Area", `${part.areaM2} m²`] as [string, string]] : []), ...(part.capacityWh ? [["Stores", `${part.capacityWh} Wh`] as [string, string]] : []), ...(part.dataRateBps ? [["Data", `${fmt(part.dataRateBps)} bit/s`] as [string, string]] : []), ...(part.dutyCycle !== undefined ? [["On", `${Math.round(part.dutyCycle * 100)}% of the time`] as [string, string]] : [])];
  const trouble: string[] = status?.notes ?? [];
  const commandedBy = (c.snap.mission.config.systems?.controllers ?? []).filter((k: any) => k.enabled && k.rules.some((r: any) => r.do.some((a: any) => a.target === `${part.type}:${part.id}` || a.target === `${part.type}s` || a.target === `kind:${part.kind}`)));
  return (
    <div className="glass part-card">
      <div className="row between"><span className="chip info">{String(part.kind ?? part.type).replace(/_/g, " ")}</span><button className="btn sm ghost" onClick={onClose} aria-label="Close">✕</button></div>
      <b>{part.name}</b>
      <div className="facts">{facts.map(([k, v], i) => <span key={`${k}${i}`}><i>{k}</i>{v}</span>)}</div>
      {wiring?.wired && (
        <div className="ports">
          <div className="k">Ports &amp; lines</div>
          {ports.map((p) => {
            const mine = links.filter((l) => (l.from.node === part.id && l.from.port === p.name) || (l.to.node === part.id && l.to.port === p.name));
            return (
              <div key={p.name} className={`port ${p.kind} ${mine.length ? "" : "open"}`} title={`${p.label}: a ${p.kind} ${p.dir === "in" ? "input" : p.dir === "out" ? "output" : "port"}${p.unit !== "command" ? `, measured in ${p.unit}` : ""}`}>
                <span className="dot" /><span className="name">{p.label}</span>
                {mine.length === 0 ? <span className="none">nothing connected</span> : mine.map((l) => {
                  const f = flows.get(l.id);
                  const other = l.from.node === part.id ? l.to.node : l.from.node;
                  return <span key={l.id} className="line">→ {nodeName(c, other)}{l.rating ? ` · ${rate(f?.flow ?? null, KIND_UNIT[l.kind]!)} of ${rate(l.rating, KIND_UNIT[l.kind]!)}` : ""}</span>;
                })}
              </div>
            );
          })}
          {trouble.map((t) => <div key={t} className="chip bad" style={{ whiteSpace: "normal", borderRadius: 4 }}>{t}</div>)}
          {status && trouble.length === 0 && <div className="faint" style={{ fontSize: 11 }}>Fully connected{status.commandable ? " · can be commanded by control logic" : status.commandable === false ? " · no control line: control logic cannot command it" : ""}.</div>}
          {commandedBy.length > 0 && <div className="faint" style={{ fontSize: 11 }}>Commanded in flight by: {commandedBy.map((k: any) => k.name).join(", ")}.</div>}
        </div>
      )}
      <div className="row wrap">
        {trouble.length > 0 && <button className="btn sm primary" disabled={locked(c)} title="Fit this part's standard lines to the bus, sized 25% above what it needs" onClick={() => void connect(c, part.id)}>Connect it</button>}
        <button className={`btn sm ${trouble.length ? "" : "primary"}`} onClick={() => bus.send("ask", trouble.length ? `What lines does the ${part.name} need to work, what rating should each have, and what would they add to the mass?` : `What does the ${part.name} do, what is it connected to, and what would change if we made it bigger or removed it?`)}>{trouble.length ? "Ask my AI what it needs" : "Ask my AI about it"}</button>
        <button className="btn sm" onClick={onAdjust}>Adjust it</button>
      </div>
    </div>
  );
}

/** Add a line by hand: pick the two ports. The server refuses a connection that cannot exist and says why. */
function AddLine({ c }: { c: Ctx }) {
  const comps: any[] = c.snap.mission.config.spacecraft.components;
  const guide = c.snap.systemsGuide;
  const nodes = [{ id: "bus", name: "Bus", type: "bus" }, ...comps.map((x) => ({ id: x.id, name: x.name, type: x.type }))];
  const [kind, setKind] = useState("power");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [rating, setRating] = useState("");
  if (!guide) return null;
  const ends = (dir: "out" | "in"): { value: string; label: string }[] => nodes.flatMap((n) => (guide.ports[n.type] ?? []).filter((p) => p.kind === kind && (p.dir === dir || p.dir === "both")).map((p) => ({ value: `${n.id}.${p.name}`, label: `${n.name} · ${p.label}` })));
  const add = async (): Promise<void> => {
    const [fn, fp] = from.split(".");
    const [tn, tp] = to.split(".");
    if (!fn || !tn) { c.toast("Pick both ends of the line.", "warn"); return; }
    const used = new Set((c.snap.mission.config.systems?.links ?? []).map((l: any) => l.id));
    let id = `ln-${fn}-${tn}-${kind}`.slice(0, 56);
    for (let i = 2; used.has(id); i++) id = `ln-${fn}-${tn}-${kind}${i}`.slice(0, 60);
    const value: any = { id, kind, from: { node: fn, port: fp }, to: { node: tn, port: tp }, lengthM: 1 };
    if (kind !== "control") value.rating = Number(rating);
    if (await commit(c, [{ op: "append", path: "systems.links", value }], `New ${kind} line: ${nodeName(c, fn)} → ${nodeName(c, tn)}`)) { setFrom(""); setTo(""); setRating(""); }
  };
  return (
    <div className="addline">
      <div className="seg">{["power", "data", "control"].map((k) => <button key={k} className={kind === k ? "on" : ""} onClick={() => { setKind(k); setFrom(""); setTo(""); }}>{k}</button>)}</div>
      <select className="input" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Line starts at"><option value="">From (an output)…</option>{ends("out").map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}</select>
      <select className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Line ends at"><option value="">To (an input)…</option>{ends("in").map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}</select>
      {kind !== "control" && <input className="input" type="number" min={0} placeholder={kind === "power" ? "Rating, W" : "Rating, bit/s"} value={rating} onChange={(e) => setRating(e.target.value)} aria-label="Line rating" />}
      <button className="btn sm" disabled={locked(c) || !from || !to || (kind !== "control" && !(Number(rating) > 0))} onClick={() => void add()}>Add line</button>
    </div>
  );
}

const readable = (expr: string): string => expr.replace(/\band\b/g, "AND").replace(/\bor\b/g, "OR").replace(/\bnot\b/g, "NOT");

/** The Systems tab: lines and what they carry, parts that are held back, and the control logic on board. */
export function SystemsPanel({ c }: { c: Ctx }) {
  const wiring = wiringOf(c);
  const cfg = c.snap.mission.config;
  const controllers: any[] = cfg.systems?.controllers ?? [];
  const sim = c.snap.game.simulation;
  const [adding, setAdding] = useState(false);
  if (!wiring) return <div className="faint">The wiring could not be computed for this design.</div>;
  if (!wiring.wired) return <div className="faint">This mission is not wired: every part is treated as connected.</div>;
  const attention = wiring.parts.filter((p) => p.notes.length > 0);
  const remove = (path: string, what: string): void => void commit(c, [{ op: "remove", path }], `Removed ${what}`);
  return (
    <div className="systems">
      <h3 className="eyebrow">Systems</h3>
      <p className="faint" style={{ fontSize: 11.5, margin: "0 0 8px" }}>A part works only through its lines. Power lines carry watts, data lines carry bits per second, control lines carry commands. A line that is too small holds the part back.</p>

      {attention.length > 0 && (
        <div className="attention">
          <div className="k">Needs a connection · {attention.length}</div>
          {attention.map((p) => (
            <div key={p.id} className="tool">
              <div><b onClick={() => c.setSelected(p.id)} style={{ cursor: "pointer" }}>{p.name}</b><div className="why">{p.notes.join(" ")}</div></div>
              <button className="btn sm" disabled={locked(c)} onClick={() => void connect(c, p.id)}>Connect</button>
            </div>
          ))}
        </div>
      )}

      <details className="fold" open>
        <summary>Control logic on board · {controllers.length}</summary>
        {controllers.length === 0 && <div className="faint" style={{ fontSize: 12 }}>None yet. Control logic is behaviour you add: rules that run every day of the flight, read the spacecraft&apos;s state and command its parts. Describe what you want to your AI — for example “when the battery runs low, run the instruments a fifth of the time until power comes back”.</div>}
        {controllers.map((k) => (
          <div key={k.id} className={`controller ${k.enabled ? "" : "off"}`}>
            <div className="row between"><b>{k.name}</b><span className="row" style={{ gap: 6 }}>
              <button className={`btn sm ${k.enabled ? "primary" : ""}`} disabled={locked(c)} title="A controller that is switched off does nothing in flight" onClick={() => void commit(c, [{ op: "set", path: `systems.controllers.${k.id}.enabled`, value: !k.enabled }], `${k.name}: ${k.enabled ? "switched off" : "switched on"}`)}>{k.enabled ? "On" : "Off"}</button>
              <button className="btn sm ghost" disabled={locked(c)} title="Remove this controller" onClick={() => remove(`systems.controllers.${k.id}`, `the controller ${k.name}`)}>✕</button>
            </span></div>
            {k.description && <p>{k.description}</p>}
            <div className="faint" style={{ fontSize: 10.5 }}>Runs on {k.hostId === "bus" ? "the bus flight computer" : nodeName(c, k.hostId)} · {k.origin?.kind === "model_generated" ? `written by an AI${k.origin.modelId ? ` (${k.origin.modelId})` : ""}, checked by the validator, flown in simulation` : "written by the crew"}</div>
            <ol className="rules">
              {k.rules.map((r: any, i: number) => (
                <li key={i}><span className="when">WHEN {readable(r.when)}</span>{r.do.map((a: any, j: number) => <span key={j} className="then">→ set <i>{a.target}</i> to <i>{readable(a.value)}</i></span>)}{r.note && <span className="note">{r.note}</span>}</li>
              ))}
            </ol>
            {Object.keys(k.memory ?? {}).length > 0 && <div className="faint" style={{ fontSize: 10.5 }}>Remembers: {Object.entries(k.memory).map(([n, v]) => `${n} (starts at ${v})`).join(", ")}</div>}
            {k.downlinkPriority?.length > 0 && <div className="faint" style={{ fontSize: 10.5 }}>Data goes down in this order: {k.downlinkPriority.map((id: string) => nodeName(c, id)).join(" → ")}</div>}
            <button className="btn sm ghost" onClick={() => bus.send("ask", `Change the controller "${k.name}" so that `)}>Ask my AI to change it</button>
          </div>
        ))}
        {sim && (sim.controlLog?.length > 0 || controllers.length > 0) && (
          <div className="ctl-log">
            <div className="k">What it did on the last flight · acted on {sim.kpis.daysControlActive ?? 0} of {sim.days} days</div>
            {(sim.controlLog ?? []).slice(0, 12).map((e: any, i: number) => <div key={i} className="mono" style={{ fontSize: 11 }}><span className="dim">day {e.day}</span> {e.note ? `${e.note} — ` : ""}{e.effect}</div>)}
            {(sim.controlLog ?? []).length === 0 && <div className="faint" style={{ fontSize: 11.5 }}>Its conditions never held on that flight, so it changed nothing.</div>}
          </div>
        )}
        {controllers.length > 0 && !sim && <div className="faint" style={{ fontSize: 11.5 }}>Fly the mission (Analysis → Fly) to see what the control logic does.</div>}
      </details>

      <details className="fold" open>
        <summary>Lines · {wiring.links.length} · harness {fmt(wiring.harnessMassKg)} kg</summary>
        <div className="lines">
          {wiring.links.map((l) => {
            const full = l.utilisation !== null && l.utilisation >= 0.999 && l.kind !== "control";
            const [fromNode] = String(l.from).split(".");
            const [toNode] = String(l.to).split(".");
            return (
              <div key={l.id} className={`wline ${full ? "full" : ""}`} title={`${endName(c, l.from)} → ${endName(c, l.to)}`}>
                <span className={`wire ${l.kind}`}>{l.kind}</span>
                <span className="ends">{nodeName(c, fromNode!)}<span className="dim"> → </span>{nodeName(c, toNode!)}</span>
                <span className="carry mono">{l.kind === "control" ? "commands" : <>{fmt(l.flow)}<span className="dim"> / {rate(l.rating, KIND_UNIT[l.kind]!)}</span></>}<i>{fmt(l.massKg * 1000)} g{full ? " · full" : ""}</i></span>
                <button className="btn sm ghost" disabled={locked(c)} title="Remove this line" aria-label="Remove this line" onClick={() => remove(`systems.links.${l.id}`, `the ${l.kind} line ${endName(c, l.from)} → ${endName(c, l.to)}`)}>✕</button>
              </div>
            );
          })}
        </div>
        <div className="row" style={{ marginTop: 6 }}><button className="btn sm ghost" onClick={() => setAdding(!adding)}>{adding ? "Close" : "+ Add a line by hand"}</button><button className="btn sm ghost" onClick={() => bus.send("ask", "Which parts are not fully connected, and what lines would each need?")}>Ask my AI</button></div>
        {adding && <AddLine c={c} />}
      </details>

      <details className="fold">
        <summary>What control logic can read and command</summary>
        <table className="data"><tbody>{(c.snap.systemsGuide?.signals ?? []).map((s) => <tr key={s.name}><td className="mono">{s.name}</td><td className="mono dim">{s.unit}</td><td>{s.meaning}</td></tr>)}</tbody></table>
        <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>It can command: {(c.snap.systemsGuide?.targets ?? []).join(" · ")}. Rules run once per simulated day; this is a daily-average model, not a real-time flight computer.</div>
      </details>
    </div>
  );
}
