/**
 * Text-to-3D. A description becomes a *shape program* — a bounded list of primitives with
 * sizes, poses and materials — which is compiled deterministically into a validated GLB.
 *
 *   with a language model     the model writes the shape program (schema-constrained)
 *   without one               a keyword composer assembles known spacecraft parts
 *
 * This is program synthesis over primitives, not a neural mesh generator: results are
 * recognisable engineering mock-ups, not sculpted or scanned geometry. Whatever the model
 * writes is only ever data for this compiler; no model output is executed.
 */
import { z } from "zod";
import { box, buildGlb, cylinder, type MeshPart, paraboloid, sphere } from "../assets/glb.js";
import { CapabilityError } from "../core/types.js";
import type { LlmService } from "../llm/llm.js";
import { type Capability, defineCapability } from "../registry/capability.js";
import type { MissionConfig } from "../state/schema.js";

type Geometry = Pick<MeshPart, "positions" | "normals" | "indices">;
type V3 = [number, number, number];

const MATERIALS = {
  aluminum: { color: [0.78, 0.79, 0.81], metallic: 0.9, roughness: 0.38 },
  gold_foil: { color: [0.83, 0.61, 0.18], metallic: 1, roughness: 0.3 },
  silver_foil: { color: [0.86, 0.87, 0.9], metallic: 1, roughness: 0.22 },
  black_kapton: { color: [0.05, 0.05, 0.06], metallic: 0.5, roughness: 0.45 },
  solar_cell: { color: [0.03, 0.06, 0.22], metallic: 0.65, roughness: 0.25 },
  white_paint: { color: [0.93, 0.93, 0.91], metallic: 0.05, roughness: 0.6 },
  carbon: { color: [0.09, 0.09, 0.1], metallic: 0.3, roughness: 0.5 },
  glass: { color: [0.08, 0.12, 0.2], metallic: 0.9, roughness: 0.06 },
  copper: { color: [0.72, 0.42, 0.2], metallic: 1, roughness: 0.35 },
  rubber: { color: [0.06, 0.06, 0.06], metallic: 0, roughness: 0.95 },
} as const satisfies Record<string, { color: V3; metallic: number; roughness: number }>;
const materialName = z.enum(Object.keys(MATERIALS) as [keyof typeof MATERIALS, ...(keyof typeof MATERIALS)[]]);

const size = z.number().min(0.001).max(50);
const coord = z.number().min(-50).max(50);
const ShapePart = z.object({
  name: z.string().min(1).max(48),
  shape: z.enum(["box", "cylinder", "cone", "sphere", "dish"]).describe("box: sizeM = [x, y, z] extents. cylinder: [diameter, length along local +Y, unused]. cone: [base diameter, length along +Y, tip diameter]. sphere: [diameter, unused, unused]. dish: [diameter, depth, unused], opening towards local +Y"),
  sizeM: z.tuple([size, size, size]),
  positionM: z.tuple([coord, coord, coord]).describe("Centre of the part in metres; +Y is up"),
  rotationDeg: z.tuple([z.number().min(-360).max(360), z.number().min(-360).max(360), z.number().min(-360).max(360)]).describe("Euler angles about X, then Y, then Z"),
  material: materialName,
});
export const ShapeProgramSchema = z.object({
  title: z.string().min(1).max(80),
  parts: z.array(ShapePart).min(1).max(64),
  notes: z.string().max(400).describe("What was assumed about size or layout"),
});
export type ShapeProgram = z.infer<typeof ShapeProgramSchema>;

/** Truncated cone along +Y, centred on the origin, with end caps. */
function frustum(baseRadius: number, tipRadius: number, height: number, segments = 32): Geometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const slope = (baseRadius - tipRadius) / height;
  const inv = 1 / Math.hypot(1, slope);
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    positions.push(c * baseRadius, -height / 2, s * baseRadius, c * tipRadius, height / 2, s * tipRadius);
    normals.push(c * inv, slope * inv, s * inv, c * inv, slope * inv, s * inv);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  for (const [y, radius, ny] of [[-height / 2, baseRadius, -1], [height / 2, tipRadius, 1]] as const) {
    if (radius <= 1e-6) continue;
    const centre = positions.length / 3;
    positions.push(0, y, 0);
    normals.push(0, ny, 0);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
      normals.push(0, ny, 0);
    }
    for (let i = 0; i < segments; i++) indices.push(...(ny > 0 ? [centre, centre + i + 2, centre + i + 1] : [centre, centre + i + 1, centre + i + 2]));
  }
  return { positions, normals, indices };
}

/** Rotate (Euler X, then Y, then Z) and translate a geometry. */
function place(g: Geometry, rotationDeg: V3, t: V3): Geometry {
  const [rx, ry, rz] = rotationDeg.map((d) => (d * Math.PI) / 180) as V3;
  const rot = (x: number, y: number, z: number): V3 => {
    let [a, b, c] = [x, y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
    [a, b, c] = [a * Math.cos(ry) + c * Math.sin(ry), b, -a * Math.sin(ry) + c * Math.cos(ry)];
    return [a * Math.cos(rz) - b * Math.sin(rz), a * Math.sin(rz) + b * Math.cos(rz), c];
  };
  const positions: number[] = [];
  const normals: number[] = [];
  for (let i = 0; i < g.positions.length; i += 3) {
    const p = rot(g.positions[i]!, g.positions[i + 1]!, g.positions[i + 2]!);
    positions.push(p[0] + t[0], p[1] + t[1], p[2] + t[2]);
    normals.push(...rot(g.normals[i]!, g.normals[i + 1]!, g.normals[i + 2]!));
  }
  return { positions, normals, indices: g.indices };
}

/** Compile a shape program into mesh parts. Pure and deterministic. */
export function compileShapeProgram(program: ShapeProgram): MeshPart[] {
  return program.parts.map((part, index) => {
    const [a, b, c] = part.sizeM;
    let geometry: Geometry;
    switch (part.shape) {
      case "box": geometry = box(a, b, c); break;
      case "cylinder": geometry = cylinder(a / 2, b, 28); break;
      case "cone": geometry = frustum(a / 2, Math.min(c, a) / 2, b, 28); break;
      case "sphere": geometry = sphere(a / 2, 24, 14); break;
      case "dish": geometry = paraboloid(a, Math.min(b, a * 0.5), 40, 10); break;
    }
    const material = MATERIALS[part.material];
    return {
      name: `${String(index + 1).padStart(2, "0")}-${part.name}`.slice(0, 60),
      ...place(geometry, part.rotationDeg as V3, part.positionM as V3),
      color: [...material.color] as V3,
      metallic: material.metallic,
      roughness: material.roughness,
      ...(part.shape === "dish" ? { doubleSided: true } : {}),
    };
  });
}

// ---------- keyword composer (no language model) ----------
type PartList = ShapeProgram["parts"];
const p = (name: string, shape: PartList[number]["shape"], sizeM: V3, positionM: V3, material: keyof typeof MATERIALS, rotationDeg: V3 = [0, 0, 0]): PartList[number] => ({ name, shape, sizeM, positionM, rotationDeg, material });

/** Each builder returns a part group about the origin and the X extent it occupies. */
const LIBRARY: { match: RegExp; label: string; build(scale: number): { parts: PartList; width: number } }[] = [
  { match: /\b(tank|propellant|fuel)\b/i, label: "propellant tank", build: (s) => ({ width: 0.5 * s, parts: [p("tank-shell", "sphere", [0.5 * s, 1, 1], [0, 0, 0], "silver_foil"), p("tank-band", "cylinder", [0.51 * s, 0.03 * s, 1], [0, 0, 0], "aluminum"), p("feed-line", "cylinder", [0.02 * s, 0.3 * s, 1], [0, -0.35 * s, 0], "copper")] }) },
  { match: /\b(thruster|engine|nozzle|rocket)\b/i, label: "engine", build: (s) => ({ width: 0.36 * s, parts: [p("chamber", "cylinder", [0.12 * s, 0.14 * s, 1], [0, 0.16 * s, 0], "aluminum"), p("throat", "cone", [0.1 * s, 0.08 * s, 0.06 * s], [0, 0.05 * s, 0], "copper", [180, 0, 0]), p("nozzle-bell", "cone", [0.34 * s, 0.3 * s, 0.07 * s], [0, -0.14 * s, 0], "black_kapton")] }) },
  { match: /\b(boom|mast|magnetometer|arm)\b/i, label: "deployable boom", build: (s) => ({ width: 1.3 * s, parts: [p("boom-root", "box", [0.1 * s, 0.1 * s, 0.1 * s], [-0.6 * s, 0, 0], "aluminum"), p("boom", "cylinder", [0.03 * s, 1.2 * s, 1], [0, 0, 0], "carbon", [0, 0, 90]), p("tip-sensor", "box", [0.09 * s, 0.07 * s, 0.07 * s], [0.62 * s, 0, 0], "gold_foil")] }) },
  { match: /\b(telescope|camera|imager|optic|lens)\b/i, label: "telescope", build: (s) => ({ width: 0.4 * s, parts: [p("tube", "cylinder", [0.26 * s, 0.6 * s, 1], [0, 0, 0], "white_paint", [90, 0, 0]), p("baffle", "cone", [0.34 * s, 0.22 * s, 0.26 * s], [0, 0, 0.4 * s], "black_kapton", [-90, 0, 0]), p("lens", "cylinder", [0.22 * s, 0.01 * s, 1], [0, 0, 0.3 * s], "glass", [90, 0, 0]), p("electronics", "box", [0.3 * s, 0.18 * s, 0.2 * s], [0, -0.2 * s, -0.18 * s], "gold_foil")] }) },
  { match: /\b(dish|antenna|reflector)\b/i, label: "dish antenna", build: (s) => ({ width: 0.9 * s, parts: [p("reflector", "dish", [0.8 * s, 0.13 * s, 1], [0, 0.22 * s, 0], "white_paint"), p("feed", "cone", [0.07 * s, 0.1 * s, 0.03 * s], [0, 0.58 * s, 0], "copper", [180, 0, 0]), p("feed-strut", "cylinder", [0.015 * s, 0.36 * s, 1], [0, 0.4 * s, 0], "aluminum"), p("gimbal", "cylinder", [0.09 * s, 0.2 * s, 1], [0, 0.1 * s, 0], "aluminum")] }) },
  { match: /\b(solar|panel|array|wing)\b/i, label: "solar array", build: (s) => ({ width: 1.7 * s, parts: [p("yoke", "cylinder", [0.03 * s, 0.25 * s, 1], [-0.72 * s, 0, 0], "aluminum", [0, 0, 90]), p("panel-1", "box", [0.68 * s, 0.02 * s, 0.6 * s], [-0.25 * s, 0, 0], "solar_cell"), p("panel-2", "box", [0.68 * s, 0.02 * s, 0.6 * s], [0.46 * s, 0, 0], "solar_cell"), p("frame", "box", [1.42 * s, 0.012 * s, 0.63 * s], [0.105 * s, -0.012 * s, 0], "carbon")] }) },
  { match: /\b(radiator|louver|cooler)\b/i, label: "radiator", build: (s) => ({ width: 0.7 * s, parts: [p("radiator-panel", "box", [0.6 * s, 0.5 * s, 0.02 * s], [0, 0, 0], "white_paint"), p("heat-pipe-1", "cylinder", [0.02 * s, 0.5 * s, 1], [-0.15 * s, 0, 0.02 * s], "aluminum"), p("heat-pipe-2", "cylinder", [0.02 * s, 0.5 * s, 1], [0.15 * s, 0, 0.02 * s], "aluminum")] }) },
  { match: /\b(wheel|tire|tyre)\b/i, label: "wheel", build: (s) => ({ width: 0.4 * s, parts: [p("tyre", "cylinder", [0.32 * s, 0.14 * s, 1], [0, 0, 0], "rubber", [0, 0, 90]), p("hub", "cylinder", [0.12 * s, 0.16 * s, 1], [0, 0, 0], "aluminum", [0, 0, 90])] }) },
  { match: /\b(leg|lander|landing|footpad)\b/i, label: "landing leg", build: (s) => ({ width: 0.6 * s, parts: [p("strut", "cylinder", [0.04 * s, 0.7 * s, 1], [0, 0, 0], "aluminum", [0, 0, 25]), p("brace", "cylinder", [0.025 * s, 0.5 * s, 1], [-0.08 * s, 0.05 * s, 0], "aluminum", [0, 0, 55]), p("footpad", "dish", [0.24 * s, 0.04 * s, 1], [0.15 * s, -0.34 * s, 0], "gold_foil")] }) },
  { match: /\b(box|avionics|electronics|computer|battery|bus|module)\b/i, label: "equipment box", build: (s) => ({ width: 0.5 * s, parts: [p("housing", "box", [0.4 * s, 0.3 * s, 0.3 * s], [0, 0, 0], "gold_foil"), p("connector-1", "cylinder", [0.03 * s, 0.03 * s, 1], [-0.1 * s, 0.165 * s, 0], "aluminum"), p("connector-2", "cylinder", [0.03 * s, 0.03 * s, 1], [0.1 * s, 0.165 * s, 0], "aluminum"), p("mount-plate", "box", [0.46 * s, 0.02 * s, 0.36 * s], [0, -0.16 * s, 0], "aluminum")] }) },
];

/** Assemble a shape program from the nouns in a description. Returns null when nothing is recognised. */
export function composeFromKeywords(prompt: string): ShapeProgram | null {
  const metres = /(\d+(?:\.\d+)?)\s*(?:m|meters?|metres?)\b/i.exec(prompt);
  const centimetres = /(\d+(?:\.\d+)?)\s*(?:cm|centimeters?|centimetres?)\b/i.exec(prompt);
  const stated = metres ? Number(metres[1]) : centimetres ? Number(centimetres[1]) / 100 : null;
  const groups = LIBRARY.filter((entry) => entry.match.test(prompt));
  if (groups.length === 0) return null;
  // The stated dimension is taken as the size of the largest feature of the first recognised part.
  const reference = groups[0]!.build(1).width;
  const scale = stated ? Math.min(40, Math.max(0.02, stated / reference)) : 1;
  const parts: PartList = [];
  let cursor = 0;
  for (const group of groups) {
    const built = group.build(scale);
    const centre = cursor + built.width / 2;
    for (const part of built.parts) parts.push({ ...part, positionM: [part.positionM[0] + centre, part.positionM[1], part.positionM[2]] });
    cursor += built.width + 0.08 * scale;
  }
  const shift = cursor / 2;
  for (const part of parts) part.positionM = [part.positionM[0] - shift, part.positionM[1], part.positionM[2]];
  return {
    title: groups.map((g) => g.label).join(" + ").slice(0, 80),
    parts,
    notes: `Composed from recognised parts (${groups.map((g) => g.label).join(", ")})${stated ? `, scaled so the first is about ${stated} m across` : " at default size"}. Parts are laid out side by side; no language model was used.`,
  };
}

const SYSTEM = `You design simple 3D mock-ups of spacecraft hardware as a list of primitive parts. You output data only; nothing you write is executed.

Coordinate frame: metres, +Y up, right-handed. Each part is centred at positionM and rotated by rotationDeg (Euler X, then Y, then Z).
Shapes and sizeM:
- box: [x, y, z] extents.
- cylinder: [diameter, length, 0.001]; its axis is local +Y.
- cone: [base diameter, length, tip diameter]; axis local +Y, base at -Y. Use a tip diameter of 0.001 for a sharp cone.
- sphere: [diameter, 0.001, 0.001].
- dish: [diameter, depth, 0.001]; a parabolic reflector whose opening faces local +Y.
Unused size entries must still be at least 0.001.

Guidance:
- Build the object from 6 to 40 parts so its function is recognisable: structure, deployables, apertures, mounts, fasteners where they read at this scale.
- Parts must touch or overlap their neighbours; nothing floats.
- Use real proportions. If the request gives dimensions, honour them; otherwise choose plausible ones and say so in notes.
- Centre the whole object on the origin.
- Choose materials that match real hardware (gold_foil or silver_foil for thermal blankets, solar_cell for cell faces, white_paint for radiators and reflectors, carbon for booms and substrates, glass for optics).`;

export function text3dCapabilities(deps: { llm: LlmService }): Capability[] {
  return [
    defineCapability({
      id: "asset.text_to_3d",
      name: "Text-to-3D (shape-program synthesis)",
      description: "Turn a text description into a 3D model: a language model (or, without one, a keyword composer limited to common spacecraft parts) writes a bounded program of primitives, which is compiled to a validated GLB, staged, and placed in the scene. Produces engineering mock-ups, not sculpted meshes.",
      category: "asset_generation",
      provides: ["asset.generative"],
      input: z.object({ prompt: z.string().min(3).max(1200), placeInScene: z.boolean().default(true) }),
      output: z.object({ assetId: z.string(), uri: z.string(), triangles: z.number(), bytes: z.number(), sha256: z.string(), title: z.string(), partCount: z.number(), method: z.enum(["llm_shape_program", "keyword_composition"]), notes: z.string(), sceneNodeId: z.string().nullable() }),
      requiredPermissions: ["asset:write"],
      constraints: { effect: "draft_write", idempotent: false, timeoutMs: 180000, maxRetries: 1 },
      resources: { network: true },
      dependencies: ["Language-model API (optional; keyword composer otherwise)"],
      verification: { status: "self_tested", method: "Compiler and keyword composer are unit-tested and every GLB is structurally validated (tests/features.test.ts); model-written programs are schema-checked, not reviewed for fidelity" },
      outputVerification: "model_judgment",
      run: async (input, ctx) => {
        let program: ShapeProgram;
        let method: "llm_shape_program" | "keyword_composition";
        if (deps.llm.status().available) {
          program = await deps.llm.structured({ system: SYSTEM, schema: ShapeProgramSchema, prompt: `Design this object:\n${input.prompt}`, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          method = "llm_shape_program";
        } else {
          const composed = composeFromKeywords(input.prompt);
          if (!composed) {
            throw new CapabilityError("Without a language model, text-to-3D only recognises common spacecraft parts (tank, engine, boom, telescope, dish antenna, solar array, radiator, wheel, landing leg, equipment box). Configure OPENAI_API_KEY for free-form descriptions.", { code: "text_to_3d_unrecognised" });
          }
          program = composed;
          method = "keyword_composition";
        }
        const glb = buildGlb(compileShapeProgram(program), { name: program.title, generator: "mission-ai-core/asset.text_to_3d@1.0.0" });
        const staged = ctx.draft.stageGlb(glb, { generator: `asset.text_to_3d@1.0.0 (${method})`, description: input.prompt.slice(0, 200) });
        let sceneNodeId: string | null = null;
        if (input.placeInScene) {
          const nodes = (ctx.draft.workingConfig() as MissionConfig).scene.nodes;
          sceneNodeId = `node_${staged.assetId}`;
          if (!nodes.some((n) => n.id === sceneNodeId)) {
            const free = nodes.filter((n) => !n.componentId).length;
            ctx.draft.propose({ op: "append", path: "scene.nodes", value: { id: sceneNodeId, name: program.title, assetId: staged.assetId, position: [1.9, 0.9 - free * 0.7, 0.6], rotationEulerDeg: [0, 0, 0], scale: [1, 1, 1] } });
          }
        }
        return {
          output: { ...staged, title: program.title, partCount: program.parts.length, method, notes: program.notes, sceneNodeId },
          assumptions: [
            method === "llm_shape_program" ? "Geometry was authored by a language model: proportions and layout are its judgment and have not been checked against any real design" : "Geometry was composed from a fixed parts library by keyword; only the listed part families are recognised",
            "The model is a visual mock-up with no mass, thermal or structural meaning",
          ],
        };
      },
      defaultInput: ({ params }) => ({ prompt: typeof params.prompt === "string" ? params.prompt : typeof params.description === "string" ? params.description : "" }),
    }),
  ];
}
