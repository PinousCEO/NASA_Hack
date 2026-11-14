/**
 * External data providers: JPL Horizons ephemerides and NASA PDS planetary terrain (DEM).
 */
import { z } from "zod";
import { CapabilityError } from "../core/types.js";
import type { TerrainService } from "../nasa/terrain.js";
import { type Capability, defineCapability } from "../registry/capability.js";

const HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api";
const HORIZONS_IDS: Record<string, string> = { sun: "10", earth: "399", moon: "301", mars: "499", "earth-moon-barycenter": "3" };
const bodyName = z.enum(["sun", "earth", "moon", "mars", "earth-moon-barycenter"]);

export interface HorizonsVector {
  julianDateTdb: number;
  calendarDate: string;
  positionAu: [number, number, number];
  velocityAuPerDay: [number, number, number];
}

/** Parse the CSV vector table between $$SOE and $$EOE in a Horizons text result. */
export function parseHorizonsVectors(resultText: string): HorizonsVector[] {
  const start = resultText.indexOf("$$SOE");
  const end = resultText.indexOf("$$EOE");
  if (start < 0 || end < 0) {
    const reason = resultText.split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" ");
    throw new CapabilityError(`Horizons returned no ephemeris table: ${reason.slice(0, 300)}`, { code: "horizons_no_data" });
  }
  return resultText
    .slice(start + 5, end)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const cells = line.split(",").map((c) => c.trim());
      const n = cells.slice(2, 8).map(Number);
      if (n.length < 6 || n.some((v) => !Number.isFinite(v))) throw new CapabilityError("Unexpected Horizons vector row format", { code: "horizons_parse" });
      return {
        julianDateTdb: Number(cells[0]),
        calendarDate: cells[1] ?? "",
        positionAu: [n[0]!, n[1]!, n[2]!],
        velocityAuPerDay: [n[3]!, n[4]!, n[5]!],
      };
    });
}

async function horizonsFetch(params: Record<string, string>, signal: AbortSignal): Promise<string> {
  const url = `${HORIZONS_URL}?${new URLSearchParams({ format: "json", ...params })}`;
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { "User-Agent": "mission-ai-core" } });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new CapabilityError(`Could not reach JPL Horizons: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, code: "horizons_network" });
  }
  if (!response.ok) {
    throw new CapabilityError(`JPL Horizons responded with HTTP ${response.status}`, { retryable: response.status >= 500 || response.status === 429, code: "horizons_http" });
  }
  const body = (await response.json()) as { result?: string; error?: string };
  if (body.error || typeof body.result !== "string") throw new CapabilityError(`JPL Horizons error: ${body.error ?? "empty result"}`, { code: "horizons_error" });
  return body.result;
}

export function dataCapabilities(deps: { terrain: TerrainService }): Capability[] {
  return [
    defineCapability({
      id: "data.horizons.vectors",
      name: "JPL Horizons state vectors",
      description: "Retrieve a high-precision position/velocity vector of the Sun, Earth, Moon or Mars relative to another body from the NASA/JPL Horizons system (J2000 ecliptic frame, AU and AU/day).",
      category: "external_data",
      provides: ["data.ephemeris.precise"],
      input: z.object({ target: bodyName, center: bodyName.default("sun"), time: z.iso.datetime({ offset: true }) }),
      output: z.object({
        target: z.string(),
        center: z.string(),
        julianDateTdb: z.number(),
        calendarDate: z.string(),
        positionAu: z.tuple([z.number(), z.number(), z.number()]),
        velocityAuPerDay: z.tuple([z.number(), z.number(), z.number()]),
        distanceAu: z.number(),
        distanceKm: z.number(),
        source: z.string(),
      }),
      dependencies: ["https://ssd.jpl.nasa.gov/api/horizons.api"],
      requiredPermissions: ["network:external"],
      resources: { network: true, cpu: "low", typicalDurationMs: 1500 },
      constraints: { timeoutMs: 20000, maxRetries: 2, idempotent: true, effect: "external_read" },
      verification: { status: "self_tested", method: "Live integration test (tests/horizons.live.test.ts) and parser unit test" },
      outputVerification: "external_data",
      references: ["https://ssd-api.jpl.nasa.gov/doc/horizons.html"],
      healthCheck: async () => {
        try {
          const res = await fetch(`${HORIZONS_URL}?format=json&COMMAND=%27MB%27`, { signal: AbortSignal.timeout(8000) });
          return res.ok ? { status: "available" } : { status: "degraded", reason: `HTTP ${res.status}` };
        } catch (err) {
          return { status: "unavailable", reason: `JPL Horizons unreachable: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
      run: async (input, ctx) => {
        if (input.target === input.center) throw new CapabilityError("target and center must differ", { code: "bad_input" });
        const t0 = new Date(input.time);
        const fmt = (d: Date): string => `'${d.toISOString().slice(0, 16).replace("T", " ")}'`;
        const text = await horizonsFetch(
          {
            COMMAND: `'${HORIZONS_IDS[input.target]}'`,
            CENTER: `'500@${HORIZONS_IDS[input.center]}'`,
            EPHEM_TYPE: "'VECTORS'",
            START_TIME: fmt(t0),
            STOP_TIME: fmt(new Date(t0.getTime() + 60000)),
            STEP_SIZE: "'1'",
            VEC_TABLE: "'2'",
            REF_PLANE: "'ECLIPTIC'",
            REF_SYSTEM: "'ICRF'",
            OUT_UNITS: "'AU-D'",
            CSV_FORMAT: "'YES'",
            OBJ_DATA: "'NO'",
          },
          ctx.signal,
        );
        const first = parseHorizonsVectors(text)[0];
        if (!first) throw new CapabilityError("Horizons returned an empty vector table", { code: "horizons_no_data" });
        const distanceAu = Math.hypot(...first.positionAu);
        return {
          output: { target: input.target, center: input.center, ...first, distanceAu, distanceKm: distanceAu * 149597870.7, source: "NASA/JPL Horizons API" },
          assumptions: ["Geometric state (no light-time or aberration correction)", "Requested UTC instant is interpreted by Horizons as TDB (difference ≈ 69 s)"],
        };
      },
      defaultInput: ({ config, params }) => ({
        target: params.target ?? config.centralBody,
        center: params.center ?? "sun",
        time: typeof params.time === "string" ? params.time : config.missionTime,
      }),
    }),
    defineCapability({
      id: "data.terrain.dem",
      name: "Planetary terrain elevation (NASA PDS DEM)",
      description: "Elevation, regional slope and a height patch for a site on the Moon (LRO LOLA LDEM, 4 px/deg) or Mars (MGS MOLA MEGDR, 4 px/deg), read from NASA Planetary Data System products. Resolution is 7.6 km (Moon) / 14.8 km (Mars) per pixel: results describe the region, not lander-scale terrain.",
      category: "external_data",
      provides: ["data.terrain.dem"],
      input: z.object({
        body: z.enum(["moon", "mars"]),
        latDeg: z.number().min(-90).max(90),
        lonDeg: z.number().min(-360).max(360).describe("East longitude"),
        radiusKm: z.number().positive().max(2000).optional().describe("Radius of the neighbourhood surveyed; defaults to two grid cells"),
        patchSamples: z.number().int().min(3).max(33).default(9),
      }),
      output: z.object({
        body: z.string(), latDeg: z.number(), lonDeg: z.number(), elevationM: z.number(), regionalSlopeDeg: z.number(), downhillAzimuthDeg: z.number(), baselineKm: z.number(),
        minM: z.number(), maxM: z.number(), reliefM: z.number(), roughnessRmsM: z.number(), resolutionKmPerPixel: z.number(), product: z.string(), datum: z.string(), credit: z.string(), caveats: z.array(z.string()),
        heightsM: z.array(z.array(z.number())), cellSizeM: z.number(),
      }),
      requiredPermissions: ["network:external"],
      constraints: { timeoutMs: 90000, maxRetries: 1, idempotent: true, effect: "external_read" },
      resources: { network: true },
      dependencies: ["NASA PDS Geosciences Node (pds-geosciences.wustl.edu)"],
      verification: { status: "verified", method: "Live test against known topography: lunar and Martian global extremes, Olympus Mons, Hellas Planitia (tests/nasa.live.test.ts)" },
      outputVerification: "external_data",
      references: ["https://pds-geosciences.wustl.edu/missions/lro/lola.htm", "https://pds-geosciences.wustl.edu/missions/mgs/megdr.html"],
      run: async (input) => {
        const survey = await deps.terrain.survey(input.body, input.latDeg, input.lonDeg, input.radiusKm);
        const patch = await deps.terrain.patch(input.body, input.latDeg, input.lonDeg, survey.baselineKm, input.patchSamples);
        return { output: { ...survey, ...patch }, assumptions: survey.caveats };
      },
      defaultInput: ({ config, params }) => {
        const site = config.rover?.site;
        return {
          body: params.body ?? site?.body ?? config.centralBody,
          latDeg: typeof params.latDeg === "number" ? params.latDeg : site?.latDeg,
          lonDeg: typeof params.lonDeg === "number" ? params.lonDeg : site?.lonDeg,
          ...(typeof params.radiusKm === "number" ? { radiusKm: params.radiusKm } : {}),
        };
      },
    }),
  ];
}
