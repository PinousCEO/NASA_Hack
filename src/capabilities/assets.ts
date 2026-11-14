/**
 * 3D asset capabilities. Generation is procedural (parametric geometry → GLB); there is
 * no generative text-to-3D model behind this, and the registry says so explicitly.
 */
import { z } from "zod";
import { box, buildGlb, cylinder, gltfJsonToGlb, type MeshPart, paraboloid, sphere, translate, yToX } from "../assets/glb.js";
import { type Capability, defineCapability } from "../registry/capability.js";
import type { Component } from "../state/schema.js";

const dim = z.number().positive().max(1000);
const color = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional();

export const AssetSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("box"), widthM: dim, heightM: dim, depthM: dim, color }),
  z.object({ kind: z.literal("cylinder"), radiusM: dim, heightM: dim, color }),
  z.object({ kind: z.literal("sphere"), radiusM: dim, color }),
  z.object({ kind: z.literal("solar_panel"), widthM: dim, heightM: dim, thicknessM: dim.default(0.02), color }),
  z.object({ kind: z.literal("dish_antenna"), diameterM: dim, depthRatio: z.number().gt(0).max(0.5).default(0.15), color }),
  z.object({ kind: z.literal("wheel"), radiusM: dim, widthM: dim, color }),
  z.object({
    kind: z.literal("rover_chassis"),
    lengthM: dim,
    widthM: dim,
    heightM: dim,
    wheelRadiusM: dim,
    wheelWidthM: dim.optional(),
    wheelCount: z.union([z.literal(4), z.literal(6), z.literal(8)]).default(4),
    color,
  }),
]);
export type AssetSpec = z.infer<typeof AssetSpecSchema>;

export function buildParts(spec: AssetSpec): MeshPart[] {
  const c = spec.color;
  switch (spec.kind) {
    case "box":
      return [{ name: "box", ...box(spec.widthM, spec.heightM, spec.depthM), color: c ?? [0.7, 0.7, 0.72] }];
    case "cylinder":
      return [{ name: "cylinder", ...cylinder(spec.radiusM, spec.heightM), color: c ?? [0.7, 0.7, 0.72] }];
    case "sphere":
      return [{ name: "sphere", ...sphere(spec.radiusM), color: c ?? [0.7, 0.7, 0.72] }];
    case "solar_panel":
      return [
        { name: "cells", ...translate(box(spec.widthM, spec.thicknessM / 2, spec.heightM), [0, spec.thicknessM / 4, 0]), color: c ?? [0.05, 0.09, 0.3], metallic: 0.6, roughness: 0.3 },
        { name: "substrate", ...translate(box(spec.widthM, spec.thicknessM / 2, spec.heightM), [0, -spec.thicknessM / 4, 0]), color: [0.75, 0.75, 0.78], metallic: 0.8, roughness: 0.4 },
      ];
    case "dish_antenna": {
      const depth = spec.diameterM * spec.depthRatio;
      const focal = spec.diameterM ** 2 / (16 * depth);
      const strut = Math.max(spec.diameterM * 0.01, 0.002);
      return [
        { name: "reflector", ...paraboloid(spec.diameterM, depth), color: c ?? [0.92, 0.92, 0.94], metallic: 0.5, roughness: 0.35, doubleSided: true },
        { name: "feed-support", ...translate(cylinder(strut, focal), [0, focal / 2, 0]), color: [0.4, 0.4, 0.42] },
        { name: "feed", ...translate(sphere(strut * 3, 16, 8), [0, focal, 0]), color: [0.85, 0.65, 0.2], metallic: 0.8 },
      ];
    }
    case "wheel":
      return [{ name: "wheel", ...yToX(cylinder(spec.radiusM, spec.widthM)), color: c ?? [0.2, 0.2, 0.22], roughness: 0.9 }];
    case "rover_chassis": {
      const wheelWidth = spec.wheelWidthM ?? spec.wheelRadiusM * 0.6;
      const parts: MeshPart[] = [
        { name: "chassis", ...translate(box(spec.widthM, spec.heightM, spec.lengthM), [0, spec.wheelRadiusM + spec.heightM / 2, 0]), color: c ?? [0.8, 0.78, 0.7] },
      ];
      const perSide = spec.wheelCount / 2;
      for (let i = 0; i < perSide; i++) {
        const z = perSide === 1 ? 0 : -spec.lengthM / 2 + (i / (perSide - 1)) * spec.lengthM;
        for (const side of [-1, 1]) {
          parts.push({
            name: `wheel-${side < 0 ? "L" : "R"}${i + 1}`,
            ...translate(yToX(cylinder(spec.wheelRadiusM, wheelWidth)), [side * (spec.widthM / 2 + wheelWidth / 2), spec.wheelRadiusM, z]),
            color: [0.2, 0.2, 0.22],
            roughness: 0.9,
          });
        }
      }
      return parts;
    }
  }
}

/** A reasonable placeholder geometry for a mission component, sized from its parameters. */
export function assetSpecForComponent(component: Component): AssetSpec {
  switch (component.type) {
    case "solar_panel":
      return { kind: "solar_panel", widthM: Math.sqrt(component.areaM2 * 2), heightM: Math.sqrt(component.areaM2 / 2), thicknessM: 0.02 };
    case "antenna":
      return component.diameterM !== undefined
        ? { kind: "dish_antenna", diameterM: component.diameterM, depthRatio: 0.15 }
        : { kind: "cylinder", radiusM: 0.01, heightM: 0.15 };
    case "battery": {
      // ~250 Wh/L pack-level energy density sets the volume; proportions are illustrative.
      const side = Math.cbrt(component.capacityWh / 250 / 1000);
      return { kind: "box", widthM: side * 1.5, heightM: side * 0.67, depthM: side };
    }
    case "load":
      return { kind: "box", widthM: 0.2, heightM: 0.1, depthM: 0.15 };
    case "instrument":
      return component.apertureM !== undefined
        ? { kind: "cylinder", radiusM: component.apertureM / 2, heightM: component.apertureM * 2.5 }
        : { kind: "box", widthM: 0.18, heightM: 0.18, depthM: 0.25 };
  }
}

export function assetCapabilities(): Capability[] {
  return [
    defineCapability({
      id: "asset.generate_parametric",
      name: "Parametric 3D asset generator",
      description: "Procedurally generate a GLB mesh from dimensions: box, cylinder, sphere, solar panel, dish antenna, wheel or rover chassis with wheels. Output is staged in the draft workspace.",
      category: "asset_generation",
      provides: ["asset.glb"],
      input: z.object({ spec: AssetSpecSchema, description: z.string().max(200).default("") }),
      output: z.object({ assetId: z.string(), uri: z.string(), triangles: z.number(), bytes: z.number(), sha256: z.string(), kind: z.string() }),
      requiredPermissions: ["asset:write"],
      resources: { cpu: "low", typicalDurationMs: 20 },
      constraints: { effect: "draft_write", idempotent: true },
      verification: { status: "self_tested", method: "GLB round-trip and winding tests (tests/assets.test.ts)" },
      outputVerification: "deterministic_calculation",
      run: (input, ctx) => {
        const glb = buildGlb(buildParts(input.spec), { name: input.spec.kind, generator: "mission-ai-core/asset.generate_parametric@1.0.0" });
        const staged = ctx.draft.stageGlb(glb, {
          generator: "asset.generate_parametric@1.0.0",
          description: input.description || `Parametric ${input.spec.kind}`,
        });
        return {
          output: { ...staged, kind: input.spec.kind },
          assumptions: ["Geometry is a dimensionally-correct placeholder, not an engineering CAD model"],
        };
      },
      defaultInput: ({ params }) => ({ spec: params.assetSpec, description: typeof params.description === "string" ? params.description : "" }),
    }),
    defineCapability({
      id: "asset.gltf_to_glb",
      name: "glTF → GLB converter",
      description: "Pack a self-contained glTF 2.0 JSON document (buffers embedded as base64 data URIs) into a validated binary GLB and stage it.",
      category: "asset_generation",
      provides: ["asset.convert.glb"],
      input: z.object({ gltfJson: z.string().min(2).max(20_000_000), description: z.string().max(200).default("Converted glTF") }),
      output: z.object({ assetId: z.string(), uri: z.string(), triangles: z.number(), bytes: z.number(), sha256: z.string() }),
      requiredPermissions: ["asset:write"],
      constraints: { effect: "draft_write", idempotent: true },
      verification: { status: "self_tested", method: "Round-trip test (tests/assets.test.ts)" },
      outputVerification: "deterministic_calculation",
      run: (input, ctx) => ({
        output: ctx.draft.stageGlb(gltfJsonToGlb(input.gltfJson), { generator: "asset.gltf_to_glb@1.0.0", description: input.description }),
        assumptions: ["Textures and external resources are not supported"],
      }),
    }),
    defineCapability({
      id: "asset.text_to_3d",
      name: "Generative text-to-3D",
      description: "Generate a free-form 3D model from a text description using a generative model. NOT IMPLEMENTED: no generative 3D service is integrated.",
      category: "asset_generation",
      provides: ["asset.generative"],
      input: z.object({ prompt: z.string() }),
      output: z.object({ assetId: z.string() }),
      requiredPermissions: ["asset:write", "network:external"],
      verification: { status: "unverified", method: "No implementation" },
      developmentStatus: "planned",
      unavailableReason: "Planned: requires integrating an external generative 3D service",
      outputVerification: "model_judgment",
    }),
  ];
}
