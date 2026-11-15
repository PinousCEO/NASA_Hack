/**
 * Mission briefs: the stream of new mission problems players choose from.
 *
 * A brief is a design problem — title, problem statement, science questions, programme
 * constraints — posed on top of one of the engineering templates (scenarios), which supply
 * the validated spacecraft baseline, component catalogue and scoring. With a language model
 * configured, briefs are written by the model, several a day, and every one is added to the
 * research record so the body of problems keeps growing. Without one, briefs come from a
 * built-in pool of problem variants. A model-written brief is model judgment: it frames the
 * problem; the numbers a team is scored on always come from the engineering models.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { LlmService } from "../llm/llm.js";
import type { ResearchMemory } from "../memory/memory.js";
import { SCENARIOS } from "./scenarios.js";

export interface MissionBrief {
  id: string;
  createdAt: string;
  /** UTC calendar day the brief was issued. */
  day: string;
  origin: "ai" | "built_in";
  modelId?: string;
  /** Engineering template (scenario id) the mission is played on. */
  template: string;
  destination: string;
  title: string;
  problem: string;
  whyItMatters: string;
  scienceQuestions: string[];
  /**
   * The kit built with the problem: which controls matter for it, which parts are worth reaching for, and what is
   * wrong at the start. Chosen from fixed lists (so every entry is something the engineering models understand);
   * with a language model the choice and the reasons are written for this problem.
   */
  kit?: ProblemKit;
  /** Programme constraints relative to the template's nominal values. */
  constraints: { budgetFactor: number; massFactor: number; durationFactor: number };
  seed: number;
  /** What makes this mission its own place: the spacecraft's name, the place it is about, and the goals in its own words. */
  world?: MissionWorld;
}

/**
 * The part of a mission a player sees as "where am I and what is this one about": the name of the spacecraft, a real
 * named place on the world that the problem concerns (marked on the globe; coordinates are approximate), and the
 * template's scored goals re-titled in this problem's terms (the measurement behind each goal is unchanged).
 */
export interface MissionWorld {
  craftName?: string;
  target?: { name: string; latDeg: number; lonDeg: number };
  goals?: Record<string, string>;
  /**
   * What this problem asks of the design, in numbers the engineering models compute: how fine a detail the imagery
   * must show at the place (metres), and how much data must come home each day relative to the template's nominal.
   * Together with the place's latitude (the orbit has to pass over it) these make two problems on the same world
   * different problems: they are solved by different orbits, instruments and links.
   */
  needs?: { detailM?: number; dataFactor?: number };
  /** The kind of place the problem is about: decides the model of the site shown beside the world. */
  site?: (typeof SITES)[number];
}
/** Kinds of place a mission can be about (each has its own model in the scene). */
export const SITES = ["dunes", "crater", "fire", "storm", "water", "snow", "volcano", "lander", "city", "terrain"] as const;

/** How fine a detail a template's instruments can be asked to show (metres): the range a problem may choose from. */
export const DETAIL_RANGE: Record<string, [number, number]> = { "lunar-volatiles": [1, 20], "leo-cubesat": [4.5, 40], "mars-weather-relay": [3, 60] };

/**
 * A template's scored goals, turned into this mission's: titles in its own words, and thresholds from its own place
 * and needs. What each goal measures is unchanged; how far the design has to go to meet it is the mission's.
 */
export function missionObjectives<T extends { id: string; title: string; description: string; category: string; weight: number; metric: { type: string; node?: string; field?: string; kind?: string }; zeroAt: number; fullAt: number; unit: string }>(template: string, objectives: T[], world: MissionWorld | undefined): T[] {
  if (!world) return objectives;
  const place = world.target;
  const range = DETAIL_RANGE[template] ?? [1, 60];
  const detail = typeof world.needs?.detailM === "number" ? Math.min(range[1], Math.max(range[0], world.needs.detailM)) : null;
  const dataFactor = typeof world.needs?.dataFactor === "number" ? Math.min(1.5, Math.max(0.5, world.needs.dataFactor)) : null;
  const out = objectives.map((o) => {
    let next = world.goals?.[o.id] ? { ...o, title: world.goals[o.id]! } : o;
    const field = o.metric.field;
    if (o.category === "science" && field === "maxCoverageLatitudeDeg" && place) {
      // The orbit must pass over the place: its tilt has to reach the place's latitude.
      const need = Math.min(88, Math.max(5, Math.round(Math.abs(place.latDeg))));
      next = { ...next, title: world.goals?.[o.id] ?? `Pass over ${place.name}`, description: `The orbit must pass over ${place.name} at ${Math.abs(place.latDeg).toFixed(1)}°${place.latDeg >= 0 ? "N" : "S"}: it has to reach at least ${need}° of latitude.`, fullAt: need, zeroAt: Math.max(0, need - 20) };
    }
    if (o.category === "science" && field === "bestImagingResolutionM" && detail !== null) {
      next = { ...next, description: `Show detail ${detail} m across${place ? ` at ${place.name}` : ""}: that is what this problem needs to see.`, fullAt: detail, zeroAt: Math.max(detail * 4, detail + 10) };
    }
    if (o.category === "science" && field === "totalReturnedGbPerDay" && dataFactor !== null) {
      const need = Math.round(o.fullAt * dataFactor * 100) / 100;
      next = { ...next, description: `Return at least ${need} Gb per day: what this problem's observations add up to.`, fullAt: need, zeroAt: Math.round(o.zeroAt * dataFactor * 100) / 100 };
    }
    return next;
  });
  // A problem that needs to see detail, on a template that has no imaging goal of its own, gets one.
  if (detail !== null && !out.some((o) => o.category === "science" && o.metric.field === "bestImagingResolutionM")) {
    const like = out.find((o) => o.category === "science" && o.metric.type === "derived");
    if (like) out.push({ ...like, id: "detail", title: world.goals?.detail ?? `See detail ${detail} m across`, description: `Show detail ${detail} m across${place ? ` at ${place.name}` : ""}: that is what this problem needs to see.`, weight: 12, metric: { type: "derived", node: "science.return", field: "bestImagingResolutionM" }, zeroAt: Math.max(detail * 4, detail + 10), fullAt: detail, unit: "m" });
  }
  return out;
}

/** Controls a problem can put in the crew's hands. Each maps to real parameters of the mission. */
export const LEVERS = ["orbit.altitude", "orbit.inclination", "orbit.node", "mission.date", "launch.vehicle", "solar.area", "battery.capacity", "antenna.dataRate", "antenna.power", "antenna.dutyCycle", "instrument.dutyCycle"] as const;
/** What can be wrong at the start: each is a deterministic change to the starting mission. */
export const CHALLENGES = ["nominal", "station", "aged-cells", "extended", "steep-site", "lean-array"] as const;

export interface ProblemKit {
  /** One sentence: the thing the crew has to get right. */
  crux: string;
  levers: { key: (typeof LEVERS)[number]; why: string }[];
  toolbox: { itemId: string; why: string }[];
  challenge: (typeof CHALLENGES)[number];
  /** Suggested split of the work between crew seats (up to four). */
  roles: { seat: string; task: string }[];
}

const factor = (min: number, max: number) => z.number().min(min).max(max);
const LlmKit = z.object({
  crux: z.string().min(10).max(200).describe("One sentence: what the crew has to get right to solve this problem"),
  levers: z.array(z.object({ key: z.enum(LEVERS), why: z.string().min(8).max(160) })).min(3).max(6).describe("The controls that matter for THIS problem, each with why it matters here"),
  toolbox: z.array(z.object({ itemId: z.string(), why: z.string().min(8).max(160) })).min(2).max(7).describe("Catalogue parts (by id, from the template's catalogue) worth reaching for in this problem, each with why"),
  challenge: z.enum(CHALLENGES).describe("What is wrong at the start. station: ground station loses 6 dB; aged-cells: solar cells two years old; extended: 25% longer mission; steep-site: steeper rover route (lunar template only); lean-array: the solar array is much smaller than planned (sized so that, with instruments on, power runs short in the worst season of this mission's year), so power runs short in the long-shadow season once instruments are on (a good problem for onboard control logic, a bigger array with a bigger line, or a different orbit plane); nominal: nothing"),
  roles: z.array(z.object({ seat: z.string().max(40), task: z.string().min(8).max(160) })).min(2).max(4).describe("How up to four crew members could split this problem between them"),
});
const templateIds = SCENARIOS.map((s) => s.id) as [string, ...string[]];
const LlmBriefs = z.object({
  briefs: z.array(z.object({
    template: z.enum(templateIds),
    title: z.string().min(8).max(70),
    problem: z.string().min(60).max(520).describe("The mission problem the team must solve, 2-4 sentences, concrete"),
    whyItMatters: z.string().min(30).max(260).describe("Why this is a real open question or need for space science or exploration"),
    scienceQuestions: z.array(z.string().min(15).max(180)).min(2).max(4),
    budgetFactor: factor(0.7, 1.3),
    massFactor: factor(0.75, 1.25),
    durationFactor: factor(0.5, 1.5),
    kit: LlmKit.optional(),
    world: z.object({
      craftName: z.string().describe("A short name (at most 24 characters) for this mission's spacecraft, fitting the problem"),
      target: z.object({ name: z.string(), latDeg: z.number(), lonDeg: z.number() }).describe("One real, named place on that world which this problem is about (a crater, basin, region, lake, mountain range, station): its name and approximate latitude and EAST longitude in degrees. Only a place you are confident exists there."),
      site: z.enum(SITES).describe("The kind of place this problem is about, for the 3D model of the site: dunes; crater (shadowed crater, ice, polar rim); fire; storm (dust storm); water (coast, lake, river, bloom, flood); snow; volcano; lander (a surface asset waiting for relay); city (urban heat); terrain (anything else)"),
      detailM: z.number().nullable().describe("How fine a detail (metres across) the imagery must show at the place for THIS problem to be answered, or null if imaging detail is not what the problem turns on. Allowed range by template: lunar-volatiles 1-20, leo-cubesat 4.5-40, mars-weather-relay 3-60. Choose a value the problem text justifies."),
      dataFactor: z.number().nullable().describe("How much data per day this problem needs relative to the template's nominal (0.5 to 1.5), or null for nominal."),
      goals: z.array(z.object({ id: z.string(), title: z.string() })).describe("For the template's science objectives (by id), a title of at most 40 characters in THIS problem's words that asks for the same measurement, e.g. 'Resolve coastal features' -> 'Resolve fire fronts'"),
    }).optional(),
  })).min(1).max(6),
});

const SYSTEM = `You write mission briefs for a space-mission design game used to teach how NASA formulates missions. Each brief poses a NEW, realistic problem: something space agencies genuinely still need to measure, demonstrate or operate. Players then design the spacecraft with real engineering models.

Rules:
- Each brief is played on one engineering template. Choose the template whose destination and spacecraft class fit the problem, and stay within what that template's component catalogue can measure — do not require instruments it does not list.
- Be specific: name the measurement, the region or regime, and what makes it hard (lighting, link distance, power, mass, cost, lifetime).
- Do not reuse the template's own default story, and do not repeat any title in the "already issued" list. Vary the problems across science, exploration support and technology demonstration.
- budgetFactor, massFactor and durationFactor scale the template's nominal budget, mass limit and mission duration; use them to make the problem tighter or looser in a way the text explains.
- Do not invent facts about real missions, dates or discoveries. Describe needs, not history.
- Make the problem decide the numbers: say how fine a detail the imagery must show for this problem (detailM) and how much data it needs (dataFactor), so that two problems on the same world call for different orbits, instruments and links. The place's latitude already decides how far the orbit must tilt.
- Give each mission its own world: name its spacecraft, name the real place on that world the problem is about (with approximate coordinates), and re-title the template's science objectives in the problem's own words without changing what is measured.
- Build the kit with the problem: the crew should open the mission and find, already in place, the controls that matter for it, the parts worth reaching for, what is wrong at the start, and a way to split the work between up to four people. Choose levers and the challenge only from the allowed values, and toolbox parts only from that template's catalogue ids. The reasons must be about this problem, in plain words. Never say which value or part is the answer.`;

/** Problem variants used when no language model is configured: four per template. */
const BUILT_IN: Omit<MissionBrief, "id" | "createdAt" | "day" | "origin" | "seed" | "destination">[] = [
  { template: "lunar-volatiles", title: "Short on power in the long shadow", problem: "The orbiter's solar array came out much smaller than planned. Fit the hydrogen instrument and a camera, then get the spacecraft through the long-shadow season: with the instruments running, it does not make enough power for part of the year. A bigger array, a battery, a different orbit plane, or onboard logic that sheds load when power is short are all ways through.", whyItMatters: "Real spacecraft fly with less power than first planned; what they do about it decides how much science comes home.", scienceQuestions: ["How much hydrogen and imaging data can a power-limited orbiter still return?", "Which measurements must run all year, and which can pause in the dark season?"], constraints: { budgetFactor: 1, massFactor: 1, durationFactor: 1 } },
  { template: "lunar-volatiles", title: "Ice at the Shackleton rim", problem: "Map hydrogen in the top metre of regolith around the south-pole ridge at a footprint small enough to tell a rover where to drive, and relay the rover's data home. Low altitude sharpens the map but deepens eclipses and shortens contacts.", whyItMatters: "Future crews need to know where water ice is before committing a landing site.", scienceQuestions: ["How concentrated is hydrogen within the top metre of polar regolith?", "At what scale does the abundance change between sunlit ridges and shadowed floors?"], constraints: { budgetFactor: 1, massFactor: 1, durationFactor: 1 } },
  { template: "lunar-volatiles", title: "Far-side relay on a shoestring", problem: "A surface scout will work out of sight of Earth for a year. Provide a relay orbiter that keeps it connected for most of each day on a budget cut by a quarter, without giving up the mapping instrument.", whyItMatters: "Far-side and polar surface assets cannot talk to Earth directly; relay coverage sets what they can do.", scienceQuestions: ["How much of each day can a single low orbiter keep a polar site in contact?", "What data volume can the relay return alongside its own science?"], constraints: { budgetFactor: 0.75, massFactor: 0.95, durationFactor: 1 } },
  { template: "lunar-volatiles", title: "Two lunar winters", problem: "Extend the prospecting mission to two years so seasonal changes in surface temperature and frost can be followed. The design must survive the deepest eclipse seasons and array degradation with positive margins throughout.", whyItMatters: "Whether surface frost migrates with the seasons decides how stable polar volatiles are.", scienceQuestions: ["Does the surface signature of volatiles change through the lunar year?", "How cold do the permanently shadowed floors stay through eclipse season?"], constraints: { budgetFactor: 1.1, massFactor: 1, durationFactor: 1.5 } },
  { template: "lunar-volatiles", title: "Rideshare slot, 15 percent lighter", problem: "The launch is now a shared ride and the mass allocation has dropped. Deliver the hydrogen map and the rover relay with a lighter spacecraft: every kilogram of array, battery and antenna has to earn its place.", whyItMatters: "Rideshare launches make lunar science affordable but impose hard mass limits.", scienceQuestions: ["Which measurement requirements survive a tighter mass allocation?", "Where is the knee in the curve between mass and returned data?"], constraints: { budgetFactor: 0.95, massFactor: 0.8, durationFactor: 1 } },
  { template: "leo-cubesat", title: "Harmful algal blooms from 6U", problem: "Detect and track coastal algal blooms with a 6U CubeSat: revisit often enough to follow a bloom, downlink the imagery within a day, and stay inside a university budget.", whyItMatters: "Bloom forecasts protect fisheries and drinking water, and depend on frequent coastal imaging.", scienceQuestions: ["How often must a coastline be imaged to follow a bloom's growth?", "What ground resolution separates a bloom from sediment plumes?"], constraints: { budgetFactor: 1, massFactor: 1, durationFactor: 1 } },
  { template: "leo-cubesat", title: "Wildfire night watch", problem: "Fly a thermal imager in a 6U to spot new fire fronts at night. The orbit must pass at useful local times, the payload must run in eclipse, and the battery must carry it.", whyItMatters: "Early detection of ignitions at night is a gap in current fire monitoring.", scienceQuestions: ["How small a hot spot can a CubeSat-class thermal imager resolve?", "How quickly can a detection reach the ground?"], constraints: { budgetFactor: 1.05, massFactor: 1, durationFactor: 0.8 } },
  { template: "leo-cubesat", title: "One ground station, all the data", problem: "The project has a single ground station and half the nominal budget for operations. Size the downlink, storage and duty cycle so nothing recorded is lost.", whyItMatters: "Small missions are usually limited by downlink, not by what the instrument can collect.", scienceQuestions: ["How much imagery can one station return per day from this orbit?", "What duty cycle keeps the recorder from overflowing?"], constraints: { budgetFactor: 0.8, massFactor: 1, durationFactor: 1 } },
  { template: "leo-cubesat", title: "Three years in a decaying orbit", problem: "Keep the CubeSat useful for three years. Choose an altitude that outlasts drag without pushing resolution and link margins out of reach, and carry the degradation margins to match.", whyItMatters: "Long, consistent records are what make small-satellite data scientifically useful.", scienceQuestions: ["Which altitude balances lifetime against resolution?", "How much margin does three years of degradation consume?"], constraints: { budgetFactor: 1.1, massFactor: 1, durationFactor: 1.5 } },
  { template: "mars-weather-relay", title: "Dust-storm early warning", problem: "Watch Mars for the onset of regional dust storms and warn surface assets in time. The orbiter must image the whole planet daily and keep its link through conjunction-limited geometry.", whyItMatters: "Dust storms end surface missions; warning time is the difference between shelter and loss.", scienceQuestions: ["How often must the globe be imaged to catch a storm's first days?", "How does opacity evolve from local to regional scale?"], constraints: { budgetFactor: 1, massFactor: 1, durationFactor: 1 } },
  { template: "mars-weather-relay", title: "Relay for a polar lander", problem: "A lander near the north polar layered deposits needs a daily relay. Choose an orbit that sees the pole, size the link for 400 million kilometres, and keep power positive at aphelion.", whyItMatters: "Polar landers see the climate record in the ice but have the worst direct links to Earth.", scienceQuestions: ["What contact time per sol can a single orbiter give a polar site?", "How much lander data can be returned at maximum Earth range?"], constraints: { budgetFactor: 1.05, massFactor: 1, durationFactor: 1 } },
  { template: "mars-weather-relay", title: "A full Mars year of temperature", problem: "Map atmospheric temperature through one complete Mars year so the seasonal cycle is captured once. The mission must last 687 days with margins that survive aphelion and solar conjunction.", whyItMatters: "Entry, descent and landing of future missions depend on a measured seasonal climatology.", scienceQuestions: ["How does the temperature structure change between perihelion and aphelion?", "Where and when do the strongest thermal tides occur?"], constraints: { budgetFactor: 1.1, massFactor: 1.05, durationFactor: 1.1 } },
  { template: "mars-weather-relay", title: "Discovery-class budget cut", problem: "The programme has lost a fifth of its budget. Decide which of the weather and relay objectives to keep whole, which to descope, and defend the choice with margins.", whyItMatters: "Most real missions are shaped by descope decisions made under cost pressure.", scienceQuestions: ["Which objective returns the most science per dollar?", "What is the smallest spacecraft that still closes the relay link?"], constraints: { budgetFactor: 0.8, massFactor: 0.95, durationFactor: 1 } },
];

const DEFAULT_LEVERS: Record<string, ProblemKit["levers"]> = {
  "lunar-volatiles": [{ key: "orbit.altitude", why: "Lower orbits resolve smaller deposits and spend longer in shadow." }, { key: "launch.vehicle", why: "Sets how much the spacecraft may weigh, and how much budget is left." }, { key: "solar.area", why: "Power for the instruments through the eclipse seasons." }, { key: "antenna.dataRate", why: "How much science reaches Earth, against how strong the link stays." }],
  "leo-cubesat": [{ key: "orbit.altitude", why: "Lower is sharper imagery; higher is longer life and longer passes." }, { key: "antenna.dutyCycle", why: "Time spent downlinking each orbit decides how much imagery gets home." }, { key: "battery.capacity", why: "The payload and radio run in eclipse on the battery alone." }, { key: "launch.vehicle", why: "A 6U has to fit what its ride can lift." }],
  "mars-weather-relay": [{ key: "antenna.dataRate", why: "The Earth range changes sixfold: a rate that closes today may not close later." }, { key: "mission.date", why: "The date sets the Earth–Mars distance and the sunlight available." }, { key: "solar.area", why: "Sunlight at Mars is less than half as strong as at Earth." }, { key: "launch.vehicle", why: "Sets how much the orbiter may weigh, and how much budget is left." }],
};

/** Built-in briefs whose problem needs its own kit (what is wrong at the start, and the controls and roles that go with it). */
const BUILT_IN_KITS: Record<string, Partial<ProblemKit>> = {
  "Short on power in the long shadow": {
    challenge: "lean-array",
    crux: "The array is much smaller than planned: once the instruments are on, power runs short for part of the year.",
    levers: [
      { key: "solar.area", why: "A bigger array makes more power — and needs a bigger power line, and mass and money." },
      { key: "battery.capacity", why: "A battery carries the spacecraft through each shadow, not through a season of deficit." },
      { key: "orbit.node", why: "Turning the orbit plane to the Sun changes how long each shadow lasts." },
      { key: "instrument.dutyCycle", why: "Running instruments less saves power all year; control logic can do it only when power is short." },
      { key: "launch.vehicle", why: "Sets how much the spacecraft may weigh, and how much budget is left." },
    ],
    roles: [
      { seat: "Power", task: "Find when in the year generation falls below load, and by how much." },
      { seat: "Payload", task: "Decide which instrument must keep running and which can wait." },
      { seat: "Flight software", task: "Ask your AI for control logic that sheds load only when power is short, and fly it." },
      { seat: "Systems lead", task: "Weigh a bigger array and line against control logic and a different orbit, and choose." },
    ],
  },
};

/** The worlds of the built-in problems: a spacecraft name, the place each is about (approximate coordinates), goals in its words. */
const BUILT_IN_WORLDS: Record<string, MissionWorld> = {
  "Short on power in the long shadow": { craftName: "Longshadow", needs: { detailM: 8 }, target: { name: "Malapert Massif", latDeg: -86.0, lonDeg: 2.9 }, goals: { survive: "Get through the long shadow", power: "Power margin with a small array" } },
  "Ice at the Shackleton rim": { craftName: "Rimwalker", needs: { detailM: 1 }, target: { name: "Shackleton crater rim", latDeg: -89.7, lonDeg: 129.8 }, goals: { hydrogen: "Map hydrogen at the rim", footprint: "Resolve rover-scale deposits", rover: "Rover reaches the rim" } },
  "Far-side relay on a shoestring": { craftName: "Echo Relay", needs: { detailM: 15, dataFactor: 0.7 }, target: { name: "Schrödinger basin", latDeg: -75.0, lonDeg: 132.4 }, goals: { data: "Relay the scout's data home", link: "Keep the relay link closed" } },
  "Two lunar winters": { craftName: "Solstice", needs: { detailM: 6 }, target: { name: "Cabeus crater", latDeg: -85.3, lonDeg: -42.1 }, goals: { survive: "Survive two eclipse seasons", hydrogen: "Follow frost through the year" } },
  "Rideshare slot, 15 percent lighter": { craftName: "Featherweight", needs: { detailM: 10, dataFactor: 0.8 }, target: { name: "Shoemaker crater", latDeg: -88.1, lonDeg: 44.9 }, goals: { mass: "Fit the rideshare slot" } },
  "Harmful algal blooms from 6U": { craftName: "Bloomwatch", needs: { detailM: 12 }, target: { name: "Lake Erie, western basin", latDeg: 41.7, lonDeg: -83.2 }, goals: { imaging: "Tell a bloom from sediment", coverage: "Revisit the coast often", data: "Imagery home within a day" } },
  "Wildfire night watch": { craftName: "Night Watch", needs: { detailM: 30, dataFactor: 0.6 }, target: { name: "Sierra Nevada, California", latDeg: 38.5, lonDeg: -120.0 }, goals: { imager: "Carry a fire-watching imager", imaging: "Resolve new fire fronts", data: "Get detections to the ground", survive: "Run the payload in eclipse" } },
  "One ground station, all the data": { craftName: "Downlink One", needs: { detailM: 8, dataFactor: 1.4 }, target: { name: "Svalbard ground station", latDeg: 78.2, lonDeg: 15.4 }, goals: { data: "Lose nothing that was recorded", link: "Close the link to one station" } },
  "Three years in a decaying orbit": { craftName: "Longhaul", needs: { detailM: 6 }, target: { name: "Amazon basin", latDeg: -3.5, lonDeg: -62.0 }, goals: { survive: "Stay useful for three years", imaging: "Keep the resolution as it sinks" } },
  "Dust-storm early warning": { craftName: "Stormglass", needs: { detailM: 50, dataFactor: 1.2 }, target: { name: "Hellas basin", latDeg: -42.4, lonDeg: 70.5 }, goals: { weather: "Catch a storm's first days", data: "Warn in time" } },
  "Relay for a polar lander": { craftName: "Polaris Link", needs: { dataFactor: 1.3 }, target: { name: "Planum Boreum", latDeg: 85.0, lonDeg: 0.0 }, goals: { polar: "See the polar lander daily", data: "Return the lander's data", link: "Close the link at maximum range" } },
  "A full Mars year of temperature": { craftName: "Seasons", needs: { detailM: 40 }, target: { name: "Gale crater", latDeg: -5.4, lonDeg: 137.8 }, goals: { thermal: "Map temperature for a Mars year", survive: "Last through aphelion and conjunction" } },
  "Discovery-class budget cut": { craftName: "Lean Relay", target: { name: "Jezero crater", latDeg: 18.4, lonDeg: 77.5 }, goals: { cost: "Fit the cut budget" } },
};

/** A world that only names goals the template has, whatever the model wrote. Null when there is nothing usable. */
export function worldFor(template: string, proposed?: { craftName?: string; target?: { name: string; latDeg: number; lonDeg: number }; goals?: { id: string; title: string }[]; detailM?: number | null; dataFactor?: number | null; site?: (typeof SITES)[number] }): MissionWorld | null {
  if (!proposed) return null;
  const scenario = SCENARIOS.find((s) => s.id === template)!;
  const ids = new Set(scenario.objectives.map((o) => o.id));
  const goals: Record<string, string> = {};
  for (const g of proposed.goals ?? []) if (ids.has(g.id) && g.title.trim()) goals[g.id] = g.title.trim().slice(0, 44);
  const world: MissionWorld = {
    ...(proposed.craftName?.trim() ? { craftName: proposed.craftName.trim().slice(0, 26) } : {}),
    ...(proposed.target && proposed.target.name?.trim() && Number.isFinite(proposed.target.latDeg) && Number.isFinite(proposed.target.lonDeg) && Math.abs(proposed.target.latDeg) <= 90 && Math.abs(proposed.target.lonDeg) <= 360 ? { target: { name: proposed.target.name.trim().slice(0, 48), latDeg: Math.round(proposed.target.latDeg * 10) / 10, lonDeg: Math.round((((proposed.target.lonDeg + 540) % 360) - 180) * 10) / 10 } } : {}),
    ...(Object.keys(goals).length ? { goals } : {}),
    ...(proposed.site && SITES.includes(proposed.site) ? { site: proposed.site } : {}),
    ...((typeof proposed.detailM === "number" && Number.isFinite(proposed.detailM)) || (typeof proposed.dataFactor === "number" && Number.isFinite(proposed.dataFactor)) ? { needs: { ...(typeof proposed.detailM === "number" && Number.isFinite(proposed.detailM) ? { detailM: Math.min((DETAIL_RANGE[template] ?? [1, 60])[1], Math.max((DETAIL_RANGE[template] ?? [1, 60])[0], Math.round(proposed.detailM * 10) / 10)) } : {}), ...(typeof proposed.dataFactor === "number" && Number.isFinite(proposed.dataFactor) ? { dataFactor: Math.min(1.5, Math.max(0.5, Math.round(proposed.dataFactor * 100) / 100)) } : {}) } } : {}),
  };
  return Object.keys(world).length ? world : null;
}

/** A kit that only names things the engineering models understand, whatever the model wrote. */
export function kitFor(template: string, proposed?: z.infer<typeof LlmKit>): ProblemKit {
  const scenario = SCENARIOS.find((s) => s.id === template)!;
  const ids = new Set(scenario.catalog.map((c) => c.id));
  const toolbox = (proposed?.toolbox ?? []).filter((t) => ids.has(t.itemId));
  const challenge = proposed?.challenge === "steep-site" && template !== "lunar-volatiles" ? "nominal" : (proposed?.challenge ?? "nominal");
  return {
    crux: proposed?.crux ?? scenario.tagline,
    levers: proposed?.levers?.length ? proposed.levers : DEFAULT_LEVERS[template]!,
    toolbox: toolbox.length >= 2 ? toolbox : scenario.catalog.filter((c) => ["instrument", "adcs", "computer"].includes(c.component.type)).slice(0, 6).map((c) => ({ itemId: c.id, why: c.description })),
    challenge,
    roles: proposed?.roles?.length ? proposed.roles.slice(0, 4) : [{ seat: "Flight dynamics", task: "Choose the orbit and watch the eclipse and coverage it gives." }, { seat: "Power", task: "Keep generation above load through the worst season." }, { seat: "Communications", task: "Close the link and get the data home." }, { seat: "Payload", task: "Decide which instruments earn their mass and money." }],
  };
}

export class BriefService {
  private briefs: MissionBrief[] = [];
  private readonly file: string | null;
  private generating: Promise<MissionBrief[]> | null = null;

  constructor(dir: string | null, private readonly llm: LlmService, private readonly memory: ResearchMemory) {
    this.file = dir ? path.join(dir, "briefs.json") : null;
    if (this.file && existsSync(this.file)) {
      try {
        this.briefs = JSON.parse(readFileSync(this.file, "utf8")) as MissionBrief[];
      } catch {
        this.briefs = [];
      }
    }
  }

  /** Newest first. */
  list(limit = 30): MissionBrief[] {
    this.pinStandingBriefs(new Date().toISOString().slice(0, 10));
    return this.briefs.slice(-limit).reverse();
  }

  get(id: string): MissionBrief | undefined {
    return this.briefs.find((b) => b.id === id);
  }

  status(): { total: number; today: number; source: "ai" | "built_in"; modelId: string | null } {
    const today = new Date().toISOString().slice(0, 10);
    const ai = this.llm.status().available;
    return { total: this.briefs.length, today: this.briefs.filter((b) => b.day === today).length, source: ai ? "ai" : "built_in", modelId: ai ? this.llm.modelId : null };
  }

  /** Make sure today has at least `min` briefs. Safe to call often; never throws. */
  async ensureDaily(min = 3): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    // The standing problems go up first, so the board is never empty while the model is still writing.
    this.pinStandingBriefs(today);
    const have = this.briefs.filter((b) => b.day === today).length;
    if (have < min) await this.generate(min - have).catch(() => undefined);
    this.pinStandingBriefs(today);
  }

  /**
   * Keep the board supplied without anyone asking: whenever fewer than `open` of today's model-written (or built-in)
   * missions are still unplayed, write more — one batch at a time (and up to a daily cap, if the operator set one).
   * Called at start-up, on a timer, and each time a crew takes a mission off the board.
   */
  async keepSupplied(played: (briefId: string) => boolean, options: { open?: number; dailyCap?: number } = {}): Promise<MissionBrief[]> {
    const open = options.open ?? 4;
    const dailyCap = options.dailyCap ?? Infinity;
    const today = new Date().toISOString().slice(0, 10);
    const todays = this.briefs.filter((b) => b.day === today);
    const unplayed = todays.filter((b) => !played(b.id)).length;
    const room = dailyCap - todays.length;
    if (unplayed >= open || room <= 0) { this.pinStandingBriefs(today); return []; }
    const made = await this.generate(Math.min(open - unplayed, room, 3)).catch(() => [] as MissionBrief[]);
    this.pinStandingBriefs(today);
    return made;
  }

  /**
   * Some problems are always on the board, whoever writes the rest: the power-short mission is the one
   * where wiring choices and onboard control logic are the way through, so a crew can always pick it.
   */
  private pinStandingBriefs(today: string): void {
    for (const b of this.briefs) if (b.origin === "built_in" && BUILT_IN_WORLDS[b.title] && JSON.stringify(b.world) !== JSON.stringify(BUILT_IN_WORLDS[b.title])) b.world = BUILT_IN_WORLDS[b.title]!;
    for (const b of BUILT_IN.filter((x) => BUILT_IN_KITS[x.title])) {
      const mine = this.briefs.find((x) => x.day === today && x.title === b.title);
      if (mine) {
        // Keep the wording of a standing problem current when the game is updated.
        if (mine.problem !== b.problem) Object.assign(mine, { problem: b.problem, kit: { ...kitFor(b.template), ...BUILT_IN_KITS[b.title] } });
        continue;
      }
      this.briefs.push({ id: `brief_${randomBytes(5).toString("hex")}`, createdAt: new Date().toISOString(), day: today, origin: "built_in", ...b, ...(BUILT_IN_WORLDS[b.title] ? { world: BUILT_IN_WORLDS[b.title]! } : {}), kit: { ...kitFor(b.template), ...BUILT_IN_KITS[b.title] }, destination: SCENARIOS.find((s) => s.id === b.template)!.destination, seed: randomBytes(4).readUInt32BE(0) });
      if (this.file) {
        mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(this.briefs, null, 1));
      }
    }
  }

  /**
   * Briefs written before missions had worlds of their own are given one: for each, the model names the spacecraft,
   * the real place the problem is about, the kind of place, and what the problem needs to see and return. One
   * request for all of them, made once (a brief that has a world is never asked about again). Never throws.
   */
  async backfillWorlds(): Promise<number> {
    const missing = this.briefs.filter((b) => b.origin === "ai" && !b.world).slice(-16);
    if (!missing.length || process.env.BRIEF_AUTOGEN === "off" || !this.llm.status().available) return 0;
    const World = z.object({ worlds: z.array(z.object({ id: z.string(), craftName: z.string(), target: z.object({ name: z.string(), latDeg: z.number(), lonDeg: z.number() }), site: z.enum(SITES), detailM: z.number().nullable(), dataFactor: z.number().nullable(), goals: z.array(z.object({ id: z.string(), title: z.string() })) })) });
    try {
      const out = await this.llm.structured({
        system: `You complete mission briefs for a space-mission design game. For each brief below give the mission its own world: a short spacecraft name (at most 24 characters); one real, named place on that world which the problem is about, with approximate latitude and EAST longitude in degrees (only a place you are confident exists there); the kind of place (site); how fine a detail in metres the imagery must show there for the problem to be answered (detailM; allowed range lunar-volatiles 1-20, leo-cubesat 4.5-40, mars-weather-relay 3-60; null if imaging detail is not what the problem turns on); how much data per day it needs relative to nominal (dataFactor 0.5-1.5, null for nominal); and, for the template's science objectives (by id), titles of at most 40 characters in the problem's own words that ask for the same measurement. Do not invent facts about real missions.`,
        schema: World,
        prompt: `Templates and their scored objectives (id: title):
${SCENARIOS.map((s) => `- ${s.id} (${s.destination}): ${s.objectives.filter((o) => o.category === "science").map((o) => `${o.id}: ${o.title}`).join("; ")}`).join("\n")}

Briefs:
${missing.map((b) => `- id ${b.id} · template ${b.template} · "${b.title}": ${b.problem}`).join("\n")}`,
      });
      let done = 0;
      for (const w of out.worlds) {
        const brief = missing.find((b) => b.id === w.id);
        const world = brief ? worldFor(brief.template, w) : null;
        if (brief && world) { brief.world = world; done++; }
      }
      if (done && this.file) { mkdirSync(path.dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(this.briefs, null, 1)); }
      return done;
    } catch (err) {
      console.warn(`Mission briefs: worlds for earlier briefs could not be written (${err instanceof Error ? err.message.slice(0, 200) : String(err)}).`);
      return 0;
    }
  }

  /** Issue `count` new briefs: model-written when a model is configured, otherwise from the built-in pool. */
  generate(count: number): Promise<MissionBrief[]> {
    // One generation at a time: concurrent callers share the result instead of duplicating briefs.
    this.generating ??= this.produce(Math.max(1, Math.min(6, Math.round(count)))).finally(() => {
      this.generating = null;
    });
    return this.generating;
  }

  private async produce(count: number): Promise<MissionBrief[]> {
    const now = new Date();
    const stamp = { createdAt: now.toISOString(), day: now.toISOString().slice(0, 10) };
    const made: MissionBrief[] = [];
    if (process.env.BRIEF_AUTOGEN !== "off" && this.llm.status().available) {
      try {
        const templates = SCENARIOS.map((s) => `- ${s.id}: destination ${s.destination}. Default story: ${s.title} — ${s.tagline} Nominal budget $${s.baseConfig.meta?.budgetMusd}M, mass limit ${s.baseConfig.meta?.massLimitKg} kg, duration ${s.baseConfig.meta?.missionDurationDays} days. Catalogue (id: part): ${s.catalog.map((c) => `${c.id}: ${c.label}`).join("; ")}. Scored objectives (id: title): ${s.objectives.map((o) => `${o.id}: ${o.title}`).join("; ")}.`).join("\n");
        const issued = this.briefs.slice(-40).map((b) => b.title).join("; ") || "(none)";
        const recent = this.briefs.slice(-12);
        // How often each value was used lately (templates that were not used at all are listed with zero).
        const tally = (items: string[]): string => { const n = new Map<string, number>(templateIds.filter((t) => items.some((i) => templateIds.includes(i))).map((t) => [t, 0])); for (const i of items) n.set(i, (n.get(i) ?? 0) + 1); return [...n].map(([k, v]) => k + " x" + v).join(", ") || "(none yet)"; };
        const out = await this.llm.structured({ system: SYSTEM, schema: LlmBriefs, prompt: `Engineering templates:\n${templates}\n\nAlready issued (do not repeat): ${issued}\n\nWrite ${count} new mission brief(s), spread across the templates.

Variety matters: crews should meet different worlds and different things going wrong. Recently used — templates: ${tally(recent.map((b) => b.template))}; starting faults: ${tally(recent.map((b) => b.kit?.challenge ?? "nominal"))}. Prefer the templates and starting faults used least, and give every brief in this batch a different starting fault. The problem text must describe the fault you choose.` });
        for (const b of out.briefs.slice(0, count)) {
          made.push({ id: `brief_${randomBytes(5).toString("hex")}`, ...stamp, origin: "ai", modelId: this.llm.modelId, template: b.template, destination: SCENARIOS.find((s) => s.id === b.template)!.destination, title: b.title, problem: b.problem, whyItMatters: b.whyItMatters, scienceQuestions: b.scienceQuestions, kit: kitFor(b.template, b.kit), constraints: { budgetFactor: b.budgetFactor, massFactor: b.massFactor, durationFactor: b.durationFactor }, seed: randomBytes(4).readUInt32BE(0), ...(worldFor(b.template, b.world) ? { world: worldFor(b.template, b.world)! } : {}) });
        }
      } catch (err) {
        // Model unavailable or returned nothing usable: fall through to the built-in pool, and say why in the server log.
        console.warn(`Mission briefs: the model's briefs could not be used (${err instanceof Error ? err.message.slice(0, 300) : String(err)}); issuing built-in problems instead.`);
      }
    }
    // Built-in variants fill whatever is still missing, least recently used first and spread over templates.
    const used = new Map<string, number>();
    this.briefs.forEach((b, i) => used.set(b.title, i));
    const pool = [...BUILT_IN].sort((a, b) => (used.get(a.title) ?? -1) - (used.get(b.title) ?? -1));
    const ordered = pool;
    const picked: typeof BUILT_IN = [];
    for (let round = 0; picked.length < count - made.length && round < 6; round++) {
      for (const template of templateIds) {
        const next = ordered.find((b) => b.template === template && !picked.includes(b));
        if (next && picked.length < count - made.length) picked.push(next);
      }
    }
    for (const b of picked) {
      made.push({ id: `brief_${randomBytes(5).toString("hex")}`, ...stamp, origin: "built_in", ...b, ...(BUILT_IN_WORLDS[b.title] ? { world: BUILT_IN_WORLDS[b.title]! } : {}), kit: { ...kitFor(b.template), ...(BUILT_IN_KITS[b.title] ?? {}) }, destination: SCENARIOS.find((s) => s.id === b.template)!.destination, seed: randomBytes(4).readUInt32BE(0) });
    }
    this.briefs.push(...made);
    this.briefs = this.briefs.slice(-300);
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.briefs, null, 1));
    }
    for (const b of made) {
      // Every problem posed becomes part of the searchable research record.
      this.memory.add({ kind: "mission_problem", summary: `Mission brief: ${b.title}. ${b.problem} ${b.scienceQuestions.join(" ")}`, content: { briefId: b.id, template: b.template, whyItMatters: b.whyItMatters, constraints: b.constraints }, provenance: { source: b.origin === "ai" ? "llm" : "system", ...(b.modelId ? { modelId: b.modelId } : {}) }, verification: b.origin === "ai" ? "model_judgment" : "unverified", tags: ["brief", b.template, b.destination] } as never);
    }
    return made;
  }
}
