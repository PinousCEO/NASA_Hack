/**
 * Procedural mesh construction and binary glTF 2.0 (GLB) encoding/decoding.
 * Units are metres, +Y up (glTF convention). No external dependencies.
 */
export interface MeshPart {
  name: string;
  positions: number[];
  normals: number[];
  indices: number[];
  color: [number, number, number];
  metallic?: number;
  roughness?: number;
  doubleSided?: boolean;
}

type Geometry = Pick<MeshPart, "positions" | "normals" | "indices">;
type V3 = [number, number, number];

export function box(w: number, h: number, d: number): Geometry {
  const [x, y, z] = [w / 2, h / 2, d / 2];
  // Each face: normal + 4 corners, counter-clockwise when viewed from outside.
  const faces: [V3, V3[]][] = [
    [[1, 0, 0], [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]]],
    [[-1, 0, 0], [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]]],
    [[0, 1, 0], [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]]],
    [[0, -1, 0], [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]]],
    [[0, 0, 1], [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]]],
    [[0, 0, -1], [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]]],
  ];
  const g: Geometry = { positions: [], normals: [], indices: [] };
  for (const [n, corners] of faces) {
    const base = g.positions.length / 3;
    for (const c of corners) {
      g.positions.push(...c);
      g.normals.push(...n);
    }
    g.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return g;
}

/** Closed cylinder along +Y, centred at the origin. */
export function cylinder(radius: number, height: number, segments = 32): Geometry {
  const g: Geometry = { positions: [], normals: [], indices: [] };
  const h = height / 2;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * 2 * Math.PI;
    const [c, s] = [Math.cos(a), Math.sin(a)];
    g.positions.push(radius * c, -h, radius * s, radius * c, h, radius * s);
    g.normals.push(c, 0, s, c, 0, s);
  }
  for (let i = 0; i < segments; i++) {
    const b = i * 2;
    g.indices.push(b, b + 1, b + 3, b, b + 3, b + 2);
  }
  for (const sign of [1, -1]) {
    const centre = g.positions.length / 3;
    g.positions.push(0, sign * h, 0);
    g.normals.push(0, sign, 0);
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * 2 * Math.PI;
      g.positions.push(radius * Math.cos(a), sign * h, radius * Math.sin(a));
      g.normals.push(0, sign, 0);
    }
    for (let i = 0; i < segments; i++) {
      if (sign > 0) g.indices.push(centre, centre + i + 2, centre + i + 1);
      else g.indices.push(centre, centre + i + 1, centre + i + 2);
    }
  }
  return g;
}

export function sphere(radius: number, segments = 32, rings = 16): Geometry {
  const g: Geometry = { positions: [], normals: [], indices: [] };
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * 2 * Math.PI;
      const n: V3 = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      g.positions.push(n[0] * radius, n[1] * radius, n[2] * radius);
      g.normals.push(...n);
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * row + s;
      g.indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  return g;
}

/** Parabolic reflector opening toward +Y with its vertex at the origin: y = r² / (4f). */
export function paraboloid(diameter: number, depth: number, segments = 48, rings = 12): Geometry {
  const g: Geometry = { positions: [], normals: [], indices: [] };
  const R = diameter / 2;
  const focal = (R * R) / (4 * depth);
  for (let r = 0; r <= rings; r++) {
    const rad = (r / rings) * R;
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * 2 * Math.PI;
      const [c, sn] = [Math.cos(a), Math.sin(a)];
      g.positions.push(rad * c, (rad * rad) / (4 * focal), rad * sn);
      const slope = rad / (2 * focal);
      const len = Math.hypot(slope, 1);
      g.normals.push((-slope * c) / len, 1 / len, (-slope * sn) / len);
    }
  }
  const row = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * row + s;
      g.indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  return g;
}

export function translate(g: Geometry, t: V3): Geometry {
  return { ...g, positions: g.positions.map((v, i) => v + t[i % 3]!) };
}

/** Rotate so the geometry's +Y axis points along +X (for wheels on an X axle). */
export function yToX(g: Geometry): Geometry {
  const swap = (arr: number[]): number[] => {
    const out = new Array<number>(arr.length);
    for (let i = 0; i < arr.length; i += 3) {
      out[i] = arr[i + 1]!;
      out[i + 1] = -arr[i]!;
      out[i + 2] = arr[i + 2]!;
    }
    return out;
  };
  return { positions: swap(g.positions), normals: swap(g.normals), indices: g.indices };
}

const pad4 = (n: number): number => (4 - (n % 4)) % 4;

export interface GlbStats {
  meshes: number;
  triangles: number;
  vertices: number;
  boundingBox: { min: V3; max: V3 };
}

export function buildGlb(parts: MeshPart[], meta: { name: string; generator: string }): Uint8Array {
  if (parts.length === 0) throw new Error("GLB needs at least one mesh part");
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const pushView = (data: Uint8Array, target: number): number => {
    chunks.push(data);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target });
    offset += data.byteLength;
    const padding = pad4(offset);
    if (padding) {
      chunks.push(new Uint8Array(padding));
      offset += padding;
    }
    return bufferViews.length - 1;
  };
  const bytesOf = (arr: Float32Array | Uint32Array): Uint8Array => new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);

  const meshes = parts.map((part, i) => {
    const vertexCount = part.positions.length / 3;
    if (!Number.isInteger(vertexCount) || part.normals.length !== part.positions.length) {
      throw new Error(`Part "${part.name}": positions/normals length mismatch`);
    }
    if (part.indices.length % 3 !== 0 || part.indices.some((ix) => ix < 0 || ix >= vertexCount)) {
      throw new Error(`Part "${part.name}": invalid indices`);
    }
    if ([...part.positions, ...part.normals].some((v) => !Number.isFinite(v))) {
      throw new Error(`Part "${part.name}": non-finite vertex data`);
    }
    const min: V3 = [Infinity, Infinity, Infinity];
    const max: V3 = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < part.positions.length; k++) {
      const v = Math.fround(part.positions[k]!);
      min[k % 3] = Math.min(min[k % 3]!, v);
      max[k % 3] = Math.max(max[k % 3]!, v);
    }
    const posView = pushView(bytesOf(new Float32Array(part.positions)), 34962);
    accessors.push({ bufferView: posView, componentType: 5126, count: vertexCount, type: "VEC3", min, max });
    const normView = pushView(bytesOf(new Float32Array(part.normals)), 34962);
    accessors.push({ bufferView: normView, componentType: 5126, count: vertexCount, type: "VEC3" });
    const idxView = pushView(bytesOf(new Uint32Array(part.indices)), 34963);
    accessors.push({ bufferView: idxView, componentType: 5125, count: part.indices.length, type: "SCALAR" });
    const a = accessors.length;
    return {
      name: part.name,
      primitives: [{ attributes: { POSITION: a - 3, NORMAL: a - 2 }, indices: a - 1, material: i, mode: 4 }],
    };
  });

  const gltf = {
    asset: { version: "2.0", generator: meta.generator },
    scene: 0,
    scenes: [{ name: meta.name, nodes: parts.map((_, i) => i) }],
    nodes: parts.map((p, i) => ({ name: p.name, mesh: i })),
    meshes,
    materials: parts.map((p) => ({
      name: `${p.name}-material`,
      pbrMetallicRoughness: {
        baseColorFactor: [...p.color, 1],
        metallicFactor: p.metallic ?? 0.2,
        roughnessFactor: p.roughness ?? 0.7,
      },
      doubleSided: p.doubleSided ?? false,
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = pad4(jsonBytes.byteLength);
  const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonBytes.byteLength + jsonPad);
  const binStart = 20 + jsonBytes.byteLength + jsonPad;
  view.setUint32(binStart, offset, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // "BIN\0"
  let cursor = binStart + 8;
  for (const c of chunks) {
    out.set(c, cursor);
    cursor += c.byteLength;
  }
  return out;
}

export interface ParsedGlb {
  json: Record<string, unknown>;
  bin: Uint8Array;
}

export function parseGlb(bytes: Uint8Array): ParsedGlb {
  if (bytes.byteLength < 20) throw new Error("GLB too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("Not a GLB file (bad magic)");
  if (view.getUint32(4, true) !== 2) throw new Error("Unsupported GLB version");
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error("GLB length header does not match file size");
  const jsonLen = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error("First GLB chunk must be JSON");
  if (20 + jsonLen > bytes.byteLength) throw new Error("JSON chunk exceeds file size");
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLen))) as Record<string, unknown>;
  let bin: Uint8Array = new Uint8Array(0);
  const binStart = 20 + jsonLen;
  if (binStart < bytes.byteLength) {
    const binLen = view.getUint32(binStart, true);
    if (view.getUint32(binStart + 4, true) !== 0x004e4942) throw new Error("Second GLB chunk must be BIN");
    if (binStart + 8 + binLen > bytes.byteLength) throw new Error("BIN chunk exceeds file size");
    bin = bytes.subarray(binStart + 8, binStart + 8 + binLen);
  }
  return { json, bin };
}

/** Structural validation of a GLB: every accessor must fit its buffer view and indices must be in range. */
export function validateGlb(bytes: Uint8Array): GlbStats {
  const { json, bin } = parseGlb(bytes);
  const asset = json.asset as { version?: string } | undefined;
  if (asset?.version !== "2.0") throw new Error("glTF asset.version must be 2.0");
  const accessors = (json.accessors ?? []) as { bufferView: number; componentType: number; count: number; type: string }[];
  const views = (json.bufferViews ?? []) as { byteOffset?: number; byteLength: number }[];
  const meshes = (json.meshes ?? []) as { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  const sizes: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const widths: Record<number, number> = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 };
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const read = (index: number): { values: number[]; count: number } => {
    const acc = accessors[index];
    const bv = acc ? views[acc.bufferView] : undefined;
    if (!acc || !bv) throw new Error(`Accessor ${index} is missing or has no buffer view`);
    const width = widths[acc.componentType];
    const size = sizes[acc.type];
    if (!width || !size) throw new Error(`Accessor ${index} has an unsupported type`);
    const start = bv.byteOffset ?? 0;
    if (acc.count * size * width > bv.byteLength || start + bv.byteLength > bin.byteLength) {
      throw new Error(`Accessor ${index} exceeds its buffer`);
    }
    const values: number[] = [];
    for (let k = 0; k < acc.count * size; k++) {
      const at = start + k * width;
      values.push(
        acc.componentType === 5126 ? dv.getFloat32(at, true)
        : acc.componentType === 5125 ? dv.getUint32(at, true)
        : acc.componentType === 5123 ? dv.getUint16(at, true)
        : dv.getUint8(at),
      );
    }
    return { values, count: acc.count };
  };
  if (meshes.length === 0) throw new Error("GLB contains no meshes");
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  let triangles = 0;
  let vertices = 0;
  for (const mesh of meshes) {
    for (const prim of mesh.primitives) {
      if (prim.attributes.POSITION === undefined) throw new Error("Primitive without POSITION");
      const pos = read(prim.attributes.POSITION);
      if (pos.values.some((v) => !Number.isFinite(v))) throw new Error("Non-finite vertex position");
      pos.values.forEach((v, k) => {
        min[k % 3] = Math.min(min[k % 3]!, v);
        max[k % 3] = Math.max(max[k % 3]!, v);
      });
      vertices += pos.count;
      if (prim.indices === undefined) {
        triangles += pos.count / 3;
      } else {
        const idx = read(prim.indices);
        if (idx.values.some((i) => i >= pos.count)) throw new Error("Index out of range");
        triangles += idx.count / 3;
      }
    }
  }
  return { meshes: meshes.length, triangles, vertices, boundingBox: { min, max } };
}

/**
 * Convert a self-contained glTF 2.0 JSON document (buffers embedded as base64 data URIs)
 * into a single GLB. External file references are rejected.
 */
export function gltfJsonToGlb(gltfText: string): Uint8Array {
  const gltf = JSON.parse(gltfText) as { buffers?: { uri?: string; byteLength: number }[]; bufferViews?: { buffer: number; byteOffset?: number }[] } & Record<string, unknown>;
  const buffers = gltf.buffers ?? [];
  const decoded = buffers.map((b, i) => {
    const match = /^data:[^;,]*;base64,(.*)$/s.exec(b.uri ?? "");
    if (!match) throw new Error(`Buffer ${i} is not an embedded base64 data URI; external references are not supported`);
    const data = new Uint8Array(Buffer.from(match[1]!, "base64"));
    if (data.byteLength < b.byteLength) throw new Error(`Buffer ${i} is shorter than its declared byteLength`);
    return data.subarray(0, b.byteLength);
  });
  const starts: number[] = [];
  let total = 0;
  for (const d of decoded) {
    starts.push(total);
    total += d.byteLength + pad4(d.byteLength);
  }
  const bin = new Uint8Array(total);
  decoded.forEach((d, i) => bin.set(d, starts[i]!));
  for (const view of gltf.bufferViews ?? []) {
    const start = starts[view.buffer];
    if (start === undefined) throw new Error(`bufferView references missing buffer ${view.buffer}`);
    view.byteOffset = (view.byteOffset ?? 0) + start;
    view.buffer = 0;
  }
  gltf.buffers = total > 0 ? [{ byteLength: total }] : [];
  const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPad = pad4(jsonBytes.byteLength);
  const size = 12 + 8 + jsonBytes.byteLength + jsonPad + (total > 0 ? 8 + total : 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, size, true);
  view.setUint32(12, jsonBytes.byteLength + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonBytes.byteLength + jsonPad);
  if (total > 0) {
    const binStart = 20 + jsonBytes.byteLength + jsonPad;
    view.setUint32(binStart, total, true);
    view.setUint32(binStart + 4, 0x004e4942, true);
    out.set(bin, binStart + 8);
  }
  return out;
}
