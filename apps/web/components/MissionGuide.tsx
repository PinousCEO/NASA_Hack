"use client";
/**
 * The mission guide: where the crew is in the process, and what stands in the way.
 *
 * It follows the six steps NASA teaches for designing a science mission ("Design and Develop
 * Science Missions", NASA Access to Space for All systems-engineering webinar, March 2025):
 * identify need and goals → define the concept → define requirements → design → build and
 * verify → implement.
 *
 * It never chooses for the player. A mission has no single right design: a lean spacecraft on
 * a cheap launch and a rich one on a bigger launch can both be good answers, and which is
 * better depends on what the crew decided the mission is for. So the guide explains the step,
 * states what is violated in plain words, and lays out the kinds of ways out with what each
 * costs. Its buttons only move the process along (define, fly, review, submit) or open a tab.
 */
import { useState } from "react";
import { api, fmt } from "@/lib/api";
import { bus } from "@/lib/bus";
import type { Ctx } from "./MissionPanels";

export const NASA_STEPS = [
  { id: "need", name: "Need & goals", long: "Identify the need and goals" },
  { id: "concept", name: "Concept", long: "Define the concept of operations" },
  { id: "requirements", name: "Requirements", long: "Define requirements" },
  { id: "design", name: "Design", long: "Design" },
  { id: "verify", name: "Build & verify", long: "Build and verify" },
  { id: "implement", name: "Implement", long: "Implement" },
] as const;
type StepId = (typeof NASA_STEPS)[number]["id"];

interface Guidance {
  step: StepId;
  title: string;
  why: string;
  /** Things to weigh. Never a recommendation: every entry says what it costs. */
  options?: { heading: string; items: string[] };
  /** Moves the process along or opens a tab; never a design decision. */
  action?: { label: string; run(): Promise<void> };
}

/** For each limit: what breaking it means, and the kinds of ways out with what each one costs. */
const WAYS_OUT: Record<string, { means: string; ways: string[] }> = {
  "power.margin": { means: "Averaged over an orbit the spacecraft uses more power than it makes, so the battery drains a little more every orbit.", ways: ["More solar array — adds mass, cost and build time", "Fewer or less power-hungry parts — gives up what they earned", "Lower duty cycles on instruments or the transmitter — less data", "An orbit with shorter eclipses — coarser measurements"] },
  "power.battery": { means: "In the planet's shadow the battery carries the whole load, and it is being drained deeper than it should be.", ways: ["More battery capacity — adds mass and cost", "Less load during eclipse — less science in the dark", "An orbit with shorter eclipses — changes what the instruments see"] },
  "comms.margin": { means: "The radio signal reaching Earth is too weak for the data rate being sent.", ways: ["A lower data rate — the link closes, less data per pass", "A larger or more powerful antenna — adds mass and power", "Tighter pointing from an attitude-control unit — adds mass, power and cost", "More transmit time per orbit does not help a link that does not close"] },
  "launch.vehicle": { means: "The spacecraft is heavier than the chosen launch vehicle can lift to this orbit.", ways: ["A lighter spacecraft — something has to come off", "A bigger launch vehicle — takes more of the budget and a longer campaign", "Around Earth, a less inclined orbit lifts more — and sees less of the planet"] },
  "mass.limit": { means: "The spacecraft is heavier than the mission's launch mass allocation.", ways: ["A lighter spacecraft — something has to come off", "A launch vehicle with more lift — takes more of the budget"] },
  "cost.limit": { means: "Parts, spacecraft bus and launch together cost more than the programme has.", ways: ["A smaller launch vehicle — less lift, so a lighter spacecraft", "Fewer or cheaper parts — gives up what they earned", "A cheaper instrument that does part of the job — partial credit instead of full"] },
  "schedule.window": { means: "The spacecraft would not be finished before the launch window.", ways: ["Fewer long-lead parts — the slowest part sets the pace", "A launch with a shorter campaign — usually a smaller vehicle", "Fewer parts overall — each one adds integration and test time"] },
  "orbit.periapsis": { means: "The orbit comes too close to the surface to be flown safely.", ways: ["A higher orbit — coarser measurements, shorter eclipses"] },
  "rover.slope": { means: "The rover cannot climb the slope at its site.", ways: ["More wheel torque or lower mass on the rover", "The site is set by the mission; the rover is yours to change"] },
};

/** Describe the crew's position from the authoritative snapshot. */
export function guidance(c: Ctx, ui: { define(): void; openTab(tab: string): void }): { guide: Guidance; done: Record<StepId, boolean> } {
  const { snap } = c;
  const d = (id: string): any => snap.mission.derived[id]?.value ?? {};
  const g = snap.game;
  const sandbox = snap.session.mode === "sandbox";
  const launch = d("launch.vehicle");
  const failing = snap.checks.filter((x) => x.status === "fail");
  const lead = c.role === "lead";
  const viewer = c.role === "viewer";
  const open = (tab: string, label: string) => ({ label, run: async () => ui.openTab(tab) });
  const call = (route: string, after?: (out: any) => void) => async (): Promise<void> => { try { const out = await api("POST", `/api/sessions/${c.sid}/${route}`, {}); after?.(out); } catch (err) { c.toast((err as Error).message, "warn"); } };

  const hasVehicle = Boolean(launch.selectedId) || !(launch.options ?? []).length;
  const simulated = Boolean(g.simulation) && g.simulationVersion === snap.mission.version;
  const studied = new Set(g.tradeStudies.map((t: any) => t.path)).size;
  const done: Record<StepId, boolean> = {
    need: sandbox || Boolean(g.charter),
    concept: hasVehicle,
    requirements: studied >= 2,
    // The crew decides when a design is ready; the step closes when they fly a design that respects every limit.
    design: failing.length === 0 && simulated,
    verify: simulated && g.risks >= 3 && g.reviews > 0,
    implement: Boolean(g.submitted),
  };
  const stepNow: StepId = !done.need ? "need" : !done.concept ? "concept" : !done.requirements ? "requirements" : !done.design ? "design" : !done.verify ? "verify" : "implement";

  if (g.submitted) return { done, guide: { step: "implement", title: "Mission submitted", why: `Final score ${g.submitted.score} (${g.submitted.grade}). Open the score ring at the top for the debrief, or the leaderboard to see how other crews answered the same problem.` } };

  // A change of the crew's own is waiting on a person, or still being built.
  const waiting = c.proposals.find((p) => p.status === "awaiting_approval");
  if (waiting) {
    const failed: any[] = (waiting.tests ?? []).filter((t: any) => t.status === "fail");
    const limits = failed.filter((t) => String(t.id).startsWith("engineering."));
    const hard = failed.filter((t) => !String(t.id).startsWith("engineering."));
    const may = lead || (c.role === "engineer" && waiting.requiredRole === "engineer");
    const what = String(c.requests.find((r) => r.proposalId === waiting.id)?.text ?? "A change").slice(0, 100);
    const decide = (action: "approve" | "reject", acceptViolations = false) => async (): Promise<void> => { try { await api("POST", `/api/sessions/${c.sid}/proposals/${waiting.id}/${action}`, { reason: action === "approve" ? (acceptViolations ? "Accepted from the mission guide with engineering limits still to fix" : "Approved from the mission guide") : "Rejected from the mission guide", acceptViolations }); c.reloadLists(); } catch (err) { c.toast((err as Error).message, "warn"); } };
    if (hard.length) return { done, guide: { step: stepNow, title: "A change failed its checks", why: `"${what}" cannot join the design: ${hard.map((t) => t.description).join("; ")}.`, action: may ? { label: "Reject the change", run: decide("reject") } : open("ai", "Open the AI tab") } };
    if (limits.length) return { done, guide: { step: stepNow, title: "Your change is waiting: it breaks a limit", why: `"${what}" was built and tested. It would leave the design outside a limit: ${limits.map((t) => `${t.description} (${t.detail})`).join("; ")}. Designs often pass through a broken state on the way to closing. It is your call: accept it and deal with the limit afterwards, or reject it from the AI tab and make room first.`, action: may ? { label: "Accept the change", run: decide("approve", true) } : open("ai", "Open the AI tab") } };
    return { done, guide: { step: stepNow, title: "Your change is waiting for a decision", why: `"${what}" passed its tests. ${["model_judgment", "unverified"].includes(waiting.evidence) ? "It contains AI-generated content, which a person always reviews before it joins the design." : "It needs a person's approval under this mission's change policy."}`, action: may ? { label: "Approve and deploy", run: decide("approve") } : open("ai", "Open the AI tab") } };
  }
  const working = c.requests.find((r) => ["queued", "analyzing", "planning", "executing"].includes(r.status));
  if (working) return { done, guide: { step: stepNow, title: "Building and testing your change…", why: `"${String(working.text).slice(0, 120)}" is being checked in an isolated copy of the mission before it joins the shared design. This takes a few seconds.` } };

  // 1 · Need and goals
  if (!done.need) return { done, guide: { step: "need", title: "Say what this mission is for", why: "Every mission starts from a need and a few goals. This is your decision, not the game's: you write the purpose, you name the objective that matters most, and you choose whether to promise anything extra. The scoring follows what you decide.", action: viewer ? undefined : { label: "Define the mission", run: async () => ui.define() } } };

  // 2 · Concept: the launch, space, ground and user segments
  if (!done.concept) {
    return { done, guide: {
      step: "concept", title: "Decide how the mission gets to space",
      why: `A mission concept covers four segments: launch, space, ground and user. The destination, ground station and science users come with the brief; the orbit and the launch are yours. The spacecraft weighs ${fmt(launch.launchMassKg)} kg now and will grow as you add to it — so this choice also sets how much you can carry.`,
      options: { heading: "The launch vehicles for this orbit", items: (launch.options ?? []).map((o: any) => `${o.name} — lifts ${fmt(o.capacityKg)} kg for $${fmt(o.costMusd)}M. ${o.summary}`) },
      action: open("design", "Open Design to choose"),
    } };
  }

  // 3 · Requirements
  if (!done.requirements) return { done, guide: {
    step: "requirements", title: `Find out what your requirements cost (${studied} of 2 studies)`,
    why: "Each objective below is a measurable requirement, and the engineering models are how it gets verified. Before committing to a design, sweep a parameter and watch what moves: a study changes nothing, it shows you the trade. Which parameters to study is up to you; the maturity review asks for two different ones.",
    options: { heading: "Parameters worth sweeping", items: ["Orbit altitude — measurement sharpness against time in shadow", "Inclination — which latitudes are covered, and how the orbit is lit", "Any part you select — for example array area against power margin and cost"] },
    action: open("analysis", "Open trade studies"),
  } };

  // 4 · Design: the crew's own, for as long as they like
  if (!done.design) {
    if (failing.length) {
      const first = failing[0]!;
      const out = WAYS_OUT[first.id];
      return { done, guide: {
        step: "design", title: failing.length === 1 ? "One limit is violated" : `${failing.length} limits are violated`,
        why: `${failing.map((x) => `${x.description}: ${x.detail}.`).join(" ")}${out ? ` ${out.means}` : ""} A design that breaks a limit cannot fly — but there is more than one way back inside it, and each gives up something different.`,
        ...(out ? { options: { heading: "Ways out, and what each costs", items: out.ways } } : {}),
        action: open("design", "Open Design"),
      } };
    }
    const openCredit = (snap.evaluation.objectives as any[]).filter((o) => o.achieved < 1 && !/simulation/i.test(o.feedback));
    return { done, guide: {
      step: "design", title: "Shape the design your way",
      why: `Every limit is respected, so this design could fly. What it should carry is your decision. ${openCredit.length ? `${openCredit.length} objective${openCredit.length === 1 ? " still has" : "s still have"} credit open — the list below shows which, and how far each is from its target.` : "Every objective that can be judged before flight is met."} There is no single right spacecraft: a lean one on a cheap launch and a richer one on a bigger launch can both be good answers. Ask the AI, try a part, undo it, compare versions in the Designs tab. When you want to know how the design really holds up, fly it.`,
      action: viewer ? undefined : { label: "Fly this design in simulation", run: call("simulate", () => ui.openTab("analysis")) },
    } };
  }

  // 5 · Build and verify
  const events: any[] = g.simulation.flightEvents ?? [];
  const hurt = events.filter((e) => e.dataLostGb > 0.005);
  const flightLine = `The flight returned ${fmt(g.simulation.kpis.totalDataReturnedGb)} Gb of science and met ${events.length} in-flight event${events.length === 1 ? "" : "s"}${hurt.length ? `; ${hurt.map((e) => e.title.toLowerCase()).join(" and ")} cost data` : events.length ? ", and rode them out" : ""}.`;
  if (g.risks < 3) return { done, guide: { step: "verify", title: `Write down what could go wrong (${g.risks} of 3 risks)`, why: `${flightLine} Verification is not only passing: a review board wants to know what could still go wrong and what you would do about it. Record three risks with their mitigations in the Review tab — in your own words. If the flight showed you a weakness, you can also go back, change the design and fly it again.`, action: open("review", "Open Review") } };
  if (g.reviews === 0) return { done, guide: { step: "verify", title: lead ? "Hold the concept review" : "Ask the lead to hold the concept review", why: `${flightLine} The review records the evidence that the design meets its requirements. With an AI model connected, a reviewer also critiques the weakest margins — a critique, not a score.`, action: lead ? { label: "Hold the concept review", run: call("review", (out) => c.toast(`Concept review recorded: score ${out.evaluation.score}, CML ${out.maturity.level}.`, "ok")) } : open("review", "Open Review") } };

  // 6 · Implement
  if (sandbox) return { done, guide: { step: "implement", title: "Keep experimenting", why: "This is a sandbox: nothing is ranked. Move a limit, break something, and see what gives." } };
  if (!lead) return { done, guide: { step: "implement", title: "Ready when the lead is", why: `The design respects its limits, it has been flown, and it has been reviewed. Current score ${snap.evaluation.score.toFixed(1)}. The lead decides when to submit — or whether to keep improving it first.` } };
  const order = ["concept", "trade", "design", "review"];
  const at = order.indexOf(g.phase);
  if (at >= 0 && at < order.length - 1) return { done, guide: { step: "implement", title: `Pass the gate into the ${order[at + 1]} phase`, why: `A mission moves through gated phases, and each gate asks for evidence. The mission is at concept maturity CML ${snap.maturity.level}.${snap.maturity.nextSteps?.length ? ` Still open: ${snap.maturity.nextSteps.slice(0, 2).join("; ")}.` : ""} You can keep changing the design between gates.`, action: { label: `Advance to ${order[at + 1]}`, run: call("phase") } } };
  return { done, guide: { step: "implement", title: "Submit when you are satisfied", why: `Current score ${snap.evaluation.score.toFixed(1)}. Submitting freezes the design, scores it, and ranks it beside the other crews that took on the same problem — whose designs will not look like yours. There is no hurry: you can keep improving it first.`, action: { label: "Submit the mission", run: async () => { if (window.confirm("Submit this mission? The design is frozen and scored.")) await call("submit", (out) => bus.send("submitted", { evaluation: out.evaluation, submission: { ...out.submission, standing: out.standing } }))(); } } } };
}

export function MissionGuide({ c, onDefine, openTab }: { c: Ctx; onDefine(): void; openTab(tab: string): void }) {
  const [busy, setBusy] = useState(false);
  const { guide, done } = guidance(c, { define: onDefine, openTab });
  const now = NASA_STEPS.findIndex((s) => s.id === guide.step);
  return (
    <div className="guide">
      <div className="row between"><h3 className="eyebrow">Mission guide</h3><span className="faint mono" style={{ fontSize: 10 }} title="The six steps NASA teaches for designing a science mission (Design and Develop Science Missions, NASA Access to Space for All, 2025)">NASA design steps</span></div>
      <ol className="guide-steps">
        {NASA_STEPS.map((s, i) => <li key={s.id} className={i === now ? "now" : done[s.id] ? "done" : ""} title={s.long}><i>{done[s.id] && i !== now ? "✓" : i + 1}</i><span>{s.name}</span></li>)}
      </ol>
      <div className="guide-next" key={guide.title}>
        <div className="k">Step {now + 1} of 6 · {NASA_STEPS[now]!.long}</div>
        <b>{guide.title}</b>
        <p>{guide.why}</p>
        {guide.options && (
          <div className="guide-options">
            <div className="k">{guide.options.heading}</div>
            <ul>{guide.options.items.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        )}
        {guide.action && <button className="btn" disabled={busy} onClick={() => { setBusy(true); void guide.action!.run().finally(() => setBusy(false)); }}>{busy ? <span className="spinner" /> : guide.action.label}</button>}
      </div>
    </div>
  );
}
