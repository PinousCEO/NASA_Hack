/**
 * Flight-hardware models, built procedurally at true scale (1 unit = 1 m) from the mission's
 * own numbers: array area, dish diameter, aperture, battery capacity, bus mass, wheel radius.
 *
 * Surfaces use physically based materials — crinkled multilayer insulation, cover-glassed
 * solar cells, machined aluminium, white thermal paint, optical glass — lit by the scene's
 * Sun and its image-based environment. Materials and their textures are created once and
 * shared (`userData.shared`), so rebuilding a spacecraft allocates only geometry.
 */
import * as THREE from "three";

// ---------- procedural textures ----------
function lattice(ix: number, iy: number, period: number, seed: number): number {
  const x = ((ix % period) + period) % period;
  const y = ((iy % period) + period) % period;
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = ((h ^ (h >>> 13)) * 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** Tileable value noise. */
function tileNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = lattice(ix, iy, period, seed), b = lattice(ix + 1, iy, period, seed), c = lattice(ix, iy + 1, period, seed), d = lattice(ix + 1, iy + 1, period, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Normal map of hand-wrapped foil: sharp creases at several scales. */
function foilNormalMap(): THREE.DataTexture {
  const size = 256;
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let h = 0;
      let amplitude = 1;
      for (const [frequency, seed] of [[5, 1], [11, 2], [23, 3], [47, 4]] as const) {
        // |noise − ½| folds the field into ridges: creases rather than bumps.
        h += amplitude * Math.abs(tileNoise((x / size) * frequency, (y / size) * frequency, frequency, seed) - 0.5) * 2;
        amplitude *= 0.55;
      }
      height[y * size + x] = h;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number): number => height[((y + size) % size) * size + ((x + size) % size)]!;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 3.2;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 3.2;
      const inv = 1 / Math.hypot(dx, dy, 1);
      data.set([(-dx * inv * 0.5 + 0.5) * 255, (-dy * inv * 0.5 + 0.5) * 255, (inv * 0.5 + 0.5) * 255, 255], (y * size + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void, srgb = true): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  draw(canvas.getContext("2d")!, size);
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** One tile = 4 × 2 triple-junction cells with cropped corners, grid fingers and bus bars. */
const solarCellMap = (): THREE.CanvasTexture => canvasTexture(512, (ctx, s) => {
  ctx.fillStyle = "#c9ccd2"; // substrate showing between cells
  ctx.fillRect(0, 0, s, s);
  const cols = 4, rows = 2, gap = 5;
  const w = s / cols, h = s / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * w + gap / 2, y = r * h + gap / 2, cw = w - gap, ch = h - gap, crop = 16;
      const g = ctx.createLinearGradient(x, y, x + cw, y + ch);
      g.addColorStop(0, "#0b1238"); g.addColorStop(0.5, "#121c52"); g.addColorStop(1, "#090f2e");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x + crop, y); ctx.lineTo(x + cw - crop, y); ctx.lineTo(x + cw, y + crop); ctx.lineTo(x + cw, y + ch - crop);
      ctx.lineTo(x + cw - crop, y + ch); ctx.lineTo(x + crop, y + ch); ctx.lineTo(x, y + ch - crop); ctx.lineTo(x, y + crop);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(160, 175, 215, 0.2)";
      ctx.lineWidth = 1;
      for (let k = 1; k < 16; k++) { ctx.beginPath(); ctx.moveTo(x + 2, y + (ch * k) / 16); ctx.lineTo(x + cw - 2, y + (ch * k) / 16); ctx.stroke(); }
      ctx.strokeStyle = "rgba(205, 212, 228, 0.6)";
      ctx.lineWidth = 2;
      for (const f of [0.3, 0.7]) { ctx.beginPath(); ctx.moveTo(x + cw * f, y + 3); ctx.lineTo(x + cw * f, y + ch - 3); ctx.stroke(); }
    }
  }
});

/** Thermal louvers / optical solar reflector tiles. */
const radiatorMap = (): THREE.CanvasTexture => canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = "#e9edf2";
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 8; i++) {
    const g = ctx.createLinearGradient(0, (i * s) / 8, 0, ((i + 1) * s) / 8);
    g.addColorStop(0, "#f8fafc"); g.addColorStop(0.8, "#c3cad6"); g.addColorStop(1, "#6f7887");
    ctx.fillStyle = g;
    ctx.fillRect(3, (i * s) / 8 + 1, s - 6, s / 8 - 2);
  }
});

/** Honeycomb-panel deck: fastener grid and panel seams over off-white paint. */
const deckMap = (): THREE.CanvasTexture => canvasTexture(256, (ctx, s) => {
  ctx.fillStyle = "#bdbbb5";
  ctx.fillRect(0, 0, s, s);
  ctx.strokeStyle = "rgba(60, 60, 64, 0.5)";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, s - 2, s - 2);
  ctx.fillStyle = "rgba(70, 72, 78, 0.85)";
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { ctx.beginPath(); ctx.arc(32 + x * 64, 32 + y * 64, 3.2, 0, Math.PI * 2); ctx.fill(); }
});

// ---------- material library ----------
type Mat = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
const library = new Map<string, Mat>();
function shared<T extends Mat>(key: string, make: () => T): T {
  let m = library.get(key) as T | undefined;
  if (!m) {
    m = make();
    m.userData.shared = true;
    library.set(key, m);
  }
  return m;
}
let foil: THREE.DataTexture | null = null;
const foilMap = (): THREE.DataTexture => (foil ??= foilNormalMap());
const std = (p: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial(p);

export const M = {
  goldFoil: () => shared("goldFoil", () => std({ color: 0xe0a236, metalness: 1, roughness: 0.27, normalMap: foilMap(), normalScale: new THREE.Vector2(1.1, 1.1), envMapIntensity: 1.35 })),
  silverFoil: () => shared("silverFoil", () => std({ color: 0xd6dae2, metalness: 1, roughness: 0.2, normalMap: foilMap(), normalScale: new THREE.Vector2(0.9, 0.9), envMapIntensity: 1.3 })),
  blackFoil: () => shared("blackFoil", () => std({ color: 0x141416, metalness: 0.85, roughness: 0.34, normalMap: foilMap(), normalScale: new THREE.Vector2(0.8, 0.8) })),
  cells: () => shared("cells", () => std({ map: solarCellMap(), metalness: 0.55, roughness: 0.16, emissive: 0x0a1238, emissiveIntensity: 0.35, envMapIntensity: 1.5 })),
  carbon: () => shared("carbon", () => std({ color: 0x17171a, metalness: 0.25, roughness: 0.5 })),
  aluminum: () => shared("aluminum", () => std({ color: 0xc8ccd2, metalness: 1, roughness: 0.4 })),
  darkMetal: () => shared("darkMetal", () => std({ color: 0x35373c, metalness: 1, roughness: 0.48 })),
  white: () => shared("white", () => std({ color: 0xcfcdc7, metalness: 0.02, roughness: 0.62 })),
  deck: () => shared("deck", () => std({ map: deckMap(), metalness: 0.1, roughness: 0.6 })),
  radiator: () => shared("radiator", () => std({ map: radiatorMap(), metalness: 0.85, roughness: 0.2, envMapIntensity: 1.2 })),
  lens: () => shared("lens", () => std({ color: 0x03050b, metalness: 1, roughness: 0.03, envMapIntensity: 2.4 })),
  copper: () => shared("copper", () => std({ color: 0xc27a3a, metalness: 1, roughness: 0.32 })),
  rubber: () => shared("rubber", () => std({ color: 0x0b0b0c, metalness: 0, roughness: 0.95 })),
  ledGreen: () => shared("ledGreen", () => new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 3.2, 1.2) })),
  ledAmber: () => shared("ledAmber", () => new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.6, 0.2) })),
  ledWhite: () => shared("ledWhite", () => new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 5, 5.5) })),
};

// ---------- geometry helpers ----------
const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material, position?: [number, number, number], rotation?: [number, number, number]): THREE.Mesh => {
  const m = new THREE.Mesh(geometry, material);
  if (position) m.position.set(...position);
  if (rotation) m.rotation.set(...rotation);
  return m;
};
const box = (w: number, h: number, d: number): THREE.BoxGeometry => new THREE.BoxGeometry(w, h, d);
const cyl = (rTop: number, rBottom: number, h: number, segments = 24, open = false): THREE.CylinderGeometry => new THREE.CylinderGeometry(rTop, rBottom, h, segments, 1, open);
const HALF = Math.PI / 2;

/** Repeat a texture across a face by scaling its UVs (keeps the material shared). */
function tile(geometry: THREE.BufferGeometry, u: number, v: number): THREE.BufferGeometry {
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * u, uv.getY(i) * v);
  return geometry;
}

/** A round strut between two points. */
function strut(a: THREE.Vector3, b: THREE.Vector3, radius: number, material: THREE.Material): THREE.Mesh {
  const length = a.distanceTo(b);
  const m = new THREE.Mesh(cyl(radius, radius, length, 10), material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}

/** Parabolic reflector opening towards +Y with its vertex at the origin. */
function reflector(diameter: number, depth: number): THREE.LatheGeometry {
  const r = diameter / 2;
  const profile = Array.from({ length: 15 }, (_, i) => {
    const x = Math.max(1e-4, (i / 14) * r);
    return new THREE.Vector2(x, depth * (x / r) ** 2);
  });
  return new THREE.LatheGeometry(profile, 56);
}

/** Bell nozzle along −Y: throat at the origin, exit plane below. */
function bell(length: number, throat: number, exit: number): THREE.LatheGeometry {
  const profile = Array.from({ length: 12 }, (_, i) => {
    const t = i / 11;
    return new THREE.Vector2(throat + (exit - throat) * Math.pow(t, 0.62), -length * t);
  });
  return new THREE.LatheGeometry(profile, 32);
}

const tag = <T extends THREE.Object3D>(o: T, name: string): T => {
  o.name = name;
  return o;
};

// ---------- parts ----------
/**
 * One solar-array wing. Root hinge at the origin, deployed along +X, cells facing +Y.
 * `userData.panels` lists the hinged panel groups so a host can animate deployment.
 */
export function buildSolarWing(areaM2: number): THREE.Group {
  const wing = tag(new THREE.Group(), "solar-wing");
  const count = areaM2 < 0.5 ? 1 : areaM2 < 1.6 ? 2 : areaM2 < 4 ? 3 : 4;
  const w = Math.sqrt(areaM2 / count / 1.3); // along the wing
  const d = w * 1.3; // across
  const yoke = Math.max(0.08, w * 0.4);
  const al = M.aluminum(), carbon = M.carbon();
  wing.add(strut(new THREE.Vector3(0, 0, 0.03), new THREE.Vector3(yoke, 0, d * 0.32), Math.max(0.006, w * 0.016), al));
  wing.add(strut(new THREE.Vector3(0, 0, -0.03), new THREE.Vector3(yoke, 0, -d * 0.32), Math.max(0.006, w * 0.016), al));
  wing.add(mesh(cyl(w * 0.05, w * 0.05, 0.1, 16), M.darkMetal(), [0, 0, 0], [HALF, 0, 0]));
  const t = Math.max(0.008, w * 0.022);
  const panels: THREE.Group[] = [];
  for (let i = 0; i < count; i++) {
    const panel = new THREE.Group();
    panel.position.set(yoke + i * (w + 0.012) , 0, 0);
    panel.add(mesh(box(w, t, d), carbon, [w / 2, 0, 0]));
    // Cell face: UVs scaled so one texture tile (4 × 2 cells) spans about 0.32 × 0.32 m.
    const face = tile(new THREE.PlaneGeometry(w * 0.965, d * 0.965), Math.max(1, Math.round(w / 0.32)), Math.max(1, Math.round(d / 0.32)));
    panel.add(mesh(face, M.cells(), [w / 2, t / 2 + 0.0012, 0], [-HALF, 0, 0]));
    for (const z of [-d * 0.28, d * 0.28]) panel.add(mesh(box(w * 0.96, t * 0.9, t * 1.6), al, [w / 2, -t * 0.9, z]));
    for (const z of [-d * 0.36, 0, d * 0.36]) panel.add(mesh(cyl(t * 0.9, t * 0.9, d * 0.1, 10), al, [0, 0, z], [HALF, 0, 0]));
    wing.add(panel);
    panels.push(panel);
  }
  wing.userData.panels = panels;
  wing.userData.length = yoke + count * (w + 0.012);
  return wing;
}

/** High-gain antenna on a two-axis gimbal. Mount at the origin, boresight +Y. */
export function buildDish(diameterM: number): THREE.Group {
  const g = tag(new THREE.Group(), "dish");
  const r = diameterM / 2;
  const depth = diameterM * 0.16;
  const focal = (diameterM * diameterM) / (16 * depth);
  const base = diameterM * 0.14;
  const al = M.aluminum(), white = M.white();
  g.add(mesh(cyl(r * 0.13, r * 0.16, base, 20), M.darkMetal(), [0, base / 2, 0]));
  g.add(mesh(box(r * 0.36, r * 0.16, r * 0.22), M.goldFoil(), [0, base * 0.55, 0]));
  const head = new THREE.Group();
  head.position.y = base;
  const bowl = mesh(reflector(diameterM, depth), white);
  (bowl.material as THREE.Material).side = THREE.DoubleSide;
  head.add(bowl);
  head.add(mesh(new THREE.TorusGeometry(r, Math.max(0.004, r * 0.018), 8, 56), al, [0, depth, 0], [HALF, 0, 0]));
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    head.add(strut(new THREE.Vector3(Math.cos(a) * r * 0.16, -r * 0.02, Math.sin(a) * r * 0.16), new THREE.Vector3(Math.cos(a) * r * 0.9, depth * 0.78, Math.sin(a) * r * 0.9), Math.max(0.003, r * 0.012), al));
  }
  const sub = focal * 0.82;
  head.add(mesh(new THREE.SphereGeometry(r * 0.16, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2.6), al, [0, sub - r * 0.1, 0]));
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.5;
    head.add(strut(new THREE.Vector3(Math.cos(a) * r * 0.82, depth * 0.68, Math.sin(a) * r * 0.82), new THREE.Vector3(Math.cos(a) * r * 0.1, sub, Math.sin(a) * r * 0.1), Math.max(0.0025, r * 0.01), al));
  }
  head.add(mesh(cyl(r * 0.09, r * 0.05, r * 0.3, 16), M.copper(), [0, r * 0.15, 0]));
  g.add(head);
  g.userData.head = head;
  return g;
}

/** Low-gain patch / helix antenna for links without a dish. */
export function buildPatchAntenna(): THREE.Group {
  const g = tag(new THREE.Group(), "patch-antenna");
  g.add(mesh(box(0.16, 0.012, 0.16), M.aluminum(), [0, 0.006, 0]));
  g.add(mesh(box(0.11, 0.006, 0.11), M.copper(), [0, 0.015, 0]));
  const helix = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: 40 }, (_, i) => new THREE.Vector3(Math.cos(i * 0.8) * 0.028, 0.02 + i * 0.0045, Math.sin(i * 0.8) * 0.028))), 80, 0.0028, 6);
  g.add(mesh(helix, M.copper()));
  g.add(mesh(cyl(0.004, 0.004, 0.2, 8), M.white(), [0, 0.12, 0]));
  return g;
}

/** Battery pack: cell stack in a machined tray with a bus bar and a status light. */
export function buildBattery(capacityWh: number): THREE.Group {
  const g = tag(new THREE.Group(), "battery");
  const volume = Math.max(2e-4, capacityWh / 180 / 1400); // ≈180 Wh/kg, 1400 kg/m³ packed
  const w = Math.cbrt(volume * 2.6), h = w * 0.42, d = w * 0.62;
  g.add(mesh(box(w, h * 0.16, d), M.aluminum(), [0, -h * 0.42, 0]));
  const rows = 3, cols = 6;
  const cr = Math.min(w / cols, d / rows) * 0.44;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = (c - (cols - 1) / 2) * (w / cols), z = (r - (rows - 1) / 2) * (d / rows);
    g.add(mesh(cyl(cr, cr, h * 0.72, 14), (r + c) % 2 ? M.darkMetal() : M.silverFoil(), [x, 0, z]));
    g.add(mesh(cyl(cr * 0.45, cr * 0.45, h * 0.04, 10), M.copper(), [x, h * 0.38, z]));
  }
  for (const z of [-d / 3, 0, d / 3]) g.add(mesh(box(w * 0.92, h * 0.03, cr * 0.5), M.copper(), [0, h * 0.41, z]));
  for (const x of [-w / 2, w / 2]) g.add(mesh(box(w * 0.03, h * 0.9, d), M.aluminum(), [x, 0, 0]));
  g.add(tag(mesh(new THREE.SphereGeometry(w * 0.025, 10, 8), M.ledGreen(), [w * 0.42, h * 0.48, d * 0.42]), "led"));
  return g;
}

/** Science instrument, shaped by kind. Mount face at −Y, aperture looking along +Z. */
export function buildInstrument(kind: string, apertureM?: number | null): THREE.Group {
  const g = tag(new THREE.Group(), `instrument-${kind}`);
  const gold = M.goldFoil(), al = M.aluminum(), dark = M.darkMetal(), black = M.blackFoil();
  switch (kind) {
    case "camera":
    case "thermal_imager":
    case "lidar": {
      const a = Math.max(0.05, apertureM ?? 0.12);
      const length = a * 2.6;
      g.add(mesh(box(a * 1.6, a * 1.25, a * 1.5), gold, [0, 0, -length * 0.32]));
      g.add(mesh(cyl(a * 0.62, a * 0.62, length, 32), kind === "thermal_imager" ? M.silverFoil() : M.white(), [0, 0, 0.02], [HALF, 0, 0]));
      const baffle = mesh(cyl(a * 0.74, a * 0.62, a * 0.9, 32, true), black, [0, 0, length / 2 + a * 0.45], [HALF, 0, 0]);
      (baffle.material as THREE.Material).side = THREE.DoubleSide;
      g.add(baffle);
      g.add(mesh(new THREE.CircleGeometry(a * 0.5, 32), M.lens(), [0, 0, length / 2 + 0.004]));
      for (const z of [-0.2, 0.15, 0.45]) g.add(mesh(new THREE.TorusGeometry(a * 0.63, a * 0.025, 8, 32), al, [0, 0, length * z]));
      // Sunshade lid, hinged open.
      g.add(mesh(cyl(a * 0.76, a * 0.76, a * 0.04, 32), black, [0, a * 1.05, length / 2 + a * 0.98], [HALF * 0.35, 0, 0]));
      g.add(mesh(tile(new THREE.PlaneGeometry(a * 1.5, a * 1.3), 1, 1), M.radiator(), [a * 0.81, 0, -length * 0.32], [0, HALF, 0]));
      if (kind === "lidar") g.add(mesh(cyl(a * 0.2, a * 0.2, a * 1.4, 16), dark, [a * 0.95, 0, length * 0.2], [HALF, 0, 0]));
      break;
    }
    case "neutron_spectrometer": {
      g.add(mesh(box(0.3, 0.16, 0.24), gold));
      for (const x of [-0.09, 0, 0.09]) {
        g.add(mesh(cyl(0.032, 0.032, 0.34, 20), M.silverFoil(), [x, 0.03, 0.2], [HALF, 0, 0]));
        g.add(mesh(cyl(0.036, 0.036, 0.03, 20), dark, [x, 0.03, 0.38], [HALF, 0, 0]));
      }
      g.add(mesh(box(0.3, 0.012, 0.36), al, [0, -0.086, 0.14]));
      break;
    }
    case "spectrometer": {
      g.add(mesh(box(0.28, 0.2, 0.34), gold));
      const slit = mesh(cyl(0.07, 0.055, 0.14, 4, true), black, [0, 0.02, 0.24], [HALF, Math.PI / 4, 0]);
      (slit.material as THREE.Material).side = THREE.DoubleSide;
      g.add(slit);
      g.add(mesh(new THREE.PlaneGeometry(0.07, 0.07), M.lens(), [0, 0.02, 0.172]));
      g.add(mesh(tile(new THREE.PlaneGeometry(0.3, 0.2), 1, 1), M.radiator(), [0, 0.102, -0.03], [-HALF, 0, 0]));
      break;
    }
    case "radar": {
      g.add(mesh(box(0.22, 0.14, 0.18), gold, [0, 0, -0.1]));
      g.add(mesh(box(0.72, 0.42, 0.02), M.white(), [0, 0, 0.03]));
      for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) g.add(mesh(box(0.085, 0.085, 0.006), M.copper(), [(c - 2.5) * 0.11, (r - 1) * 0.12, 0.044]));
      g.add(mesh(box(0.74, 0.02, 0.03), al, [0, 0.215, 0.03]));
      g.add(mesh(box(0.74, 0.02, 0.03), al, [0, -0.215, 0.03]));
      break;
    }
    case "magnetometer": {
      g.add(mesh(box(0.12, 0.1, 0.12), gold));
      g.add(strut(new THREE.Vector3(0, 0, 0.06), new THREE.Vector3(0, 0, 0.95), 0.012, M.carbon()));
      g.add(mesh(cyl(0.03, 0.03, 0.09, 16), M.white(), [0, 0, 0.99], [HALF, 0, 0]));
      for (const z of [0.35, 0.65]) g.add(mesh(cyl(0.02, 0.02, 0.03, 12), al, [0, 0, z], [HALF, 0, 0]));
      break;
    }
    default: {
      g.add(mesh(box(0.26, 0.2, 0.3), gold));
      g.add(mesh(new THREE.CircleGeometry(0.06, 24), M.lens(), [0, 0, 0.152]));
    }
  }
  return g;
}

/** Avionics / payload electronics box with a connector panel and a heat-sink face. */
export function buildAvionics(powerW: number): THREE.Group {
  const g = tag(new THREE.Group(), "avionics");
  const s = 0.16 + Math.min(0.2, Math.sqrt(Math.max(1, powerW)) * 0.016);
  g.add(mesh(box(s * 1.5, s * 0.8, s * 1.1), M.darkMetal()));
  for (let i = 0; i < 7; i++) g.add(mesh(box(s * 1.42, s * 0.012, s * 0.2), M.aluminum(), [0, s * (0.41 + i * 0.03), 0], [0, 0, 0]));
  for (let i = 0; i < 4; i++) {
    g.add(mesh(cyl(s * 0.07, s * 0.07, s * 0.08, 14), M.aluminum(), [(i - 1.5) * s * 0.3, 0, s * 0.59], [HALF, 0, 0]));
    g.add(mesh(cyl(s * 0.045, s * 0.045, s * 0.1, 10), M.copper(), [(i - 1.5) * s * 0.3, 0, s * 0.6], [HALF, 0, 0]));
  }
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) g.add(mesh(box(s * 0.16, s * 0.05, s * 0.16), M.aluminum(), [x * s * 0.78, -s * 0.375, z * s * 0.5]));
  g.add(tag(mesh(new THREE.SphereGeometry(s * 0.03, 10, 8), M.ledAmber(), [s * 0.66, s * 0.2, s * 0.56]), "led"));
  return g;
}

export interface BusModel {
  group: THREE.Group;
  size: THREE.Vector3;
  /** Engine exhaust glow, hidden unless a burn is being shown. */
  plume: THREE.Mesh | null;
  cubesat: boolean;
}

/**
 * Spacecraft bus sized from its dry mass. Axes: +Y zenith (antenna deck), −Y engine,
 * +Z nadir (instrument deck), ±X solar-array drives.
 */
export function buildBus(dryMassKg: number): BusModel {
  const group = tag(new THREE.Group(), "bus");
  if (dryMassKg < 16) {
    // CubeSat: 6U (≈ 0.24 × 0.11 × 0.37 m) or 3U below 6 kg, with rails and body panels.
    const size = dryMassKg < 6 ? new THREE.Vector3(0.11, 0.11, 0.34) : new THREE.Vector3(0.24, 0.11, 0.366);
    group.add(mesh(box(size.x * 0.97, size.y * 0.97, size.z * 0.97), M.darkMetal()));
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) group.add(mesh(box(0.0085, 0.0085, size.z), M.aluminum(), [(sx * (size.x - 0.0085)) / 2, (sy * (size.y - 0.0085)) / 2, 0]));
    for (const sy of [-1, 1]) group.add(mesh(tile(new THREE.PlaneGeometry(size.x * 0.9, size.z * 0.94), 1, 1), M.cells(), [0, sy * (size.y / 2 + 0.0006), 0], [-sy * HALF, 0, 0]));
    for (const sx of [-1, 1]) group.add(mesh(new THREE.PlaneGeometry(size.z * 0.94, size.y * 0.86), M.goldFoil(), [sx * (size.x / 2 + 0.0006), 0, 0], [0, sx * HALF, 0]));
    group.add(mesh(new THREE.PlaneGeometry(size.x * 0.86, size.y * 0.8), M.deck(), [0, 0, size.z / 2 + 0.0006]));
    group.add(mesh(new THREE.CircleGeometry(size.y * 0.24, 24), M.lens(), [size.x * 0.18, 0, size.z / 2 + 0.0012]));
    for (const sx of [-1, 1]) group.add(strut(new THREE.Vector3(sx * size.x * 0.4, size.y / 2, -size.z / 2), new THREE.Vector3(sx * size.x * 0.55, size.y * 1.6, -size.z * 0.62), 0.0018, M.aluminum()));
    group.add(tag(mesh(new THREE.SphereGeometry(0.006, 8, 6), M.ledGreen(), [-size.x * 0.3, size.y * 0.2, size.z / 2 + 0.002]), "led"));
    return { group, size, plume: null, cubesat: true };
  }
  const side = Math.min(2.2, Math.max(0.55, Math.cbrt(dryMassKg / 160)));
  const size = new THREE.Vector3(side, side * 1.18, side);
  const hx = size.x / 2, hy = size.y / 2, hz = size.z / 2;
  const al = M.aluminum(), gold = M.goldFoil();
  group.add(mesh(box(size.x * 0.985, size.y * 0.985, size.z * 0.985), M.darkMetal()));
  // Thermal blankets on the side walls: one quilted sheet per face, foil creases scaled to the wall.
  const blanket = (w: number, h: number): THREE.BufferGeometry => tile(new THREE.PlaneGeometry(w, h, 6, 6), w / 0.5, h / 0.5);
  for (const sx of [-1, 1]) group.add(mesh(blanket(size.z * 0.94, size.y * 0.94), gold, [sx * (hx + 0.002), 0, 0], [0, sx * HALF, 0]));
  group.add(mesh(blanket(size.x * 0.94, size.y * 0.94), gold, [0, 0, -(hz + 0.002)], [0, Math.PI, 0]));
  // Nadir (instrument) deck and zenith deck are bare honeycomb panels.
  group.add(mesh(tile(new THREE.PlaneGeometry(size.x * 0.96, size.y * 0.96), Math.round(size.x / 0.3), Math.round(size.y / 0.3)), M.deck(), [0, 0, hz + 0.002]));
  group.add(mesh(blanket(size.x * 0.94, size.z * 0.94), gold, [0, hy + 0.002, 0], [-HALF, 0, 0]));
  group.add(mesh(tile(new THREE.PlaneGeometry(size.x * 0.5, size.z * 0.34), 1, 2), M.radiator(), [0, hy + 0.006, hz * 0.3], [-HALF, 0, 0]));
  // Edge longerons.
  const e = side * 0.022;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) group.add(mesh(box(e, size.y, e), al, [sx * hx, 0, sz * hz]));
  for (const sy of [-1, 1]) {
    for (const sz of [-1, 1]) group.add(mesh(box(size.x, e, e), al, [0, sy * hy, sz * hz]));
    for (const sx of [-1, 1]) group.add(mesh(box(e, e, size.z), al, [sx * hx, sy * hy, 0]));
  }
  // Radiator with louvers on the −Z wall, star trackers, sun sensors.
  group.add(mesh(tile(new THREE.PlaneGeometry(size.x * 0.5, size.y * 0.42), 1, 2), M.radiator(), [0, hy * 0.2, -(hz + 0.006)], [0, Math.PI, 0]));
  for (const sx of [-1, 1]) {
    const tracker = new THREE.Group();
    tracker.add(mesh(box(side * 0.1, side * 0.1, side * 0.1), M.blackFoil()));
    const hood = mesh(cyl(side * 0.06, side * 0.042, side * 0.14, 20, true), M.blackFoil(), [0, side * 0.11, 0]);
    (hood.material as THREE.Material).side = THREE.DoubleSide;
    tracker.add(hood, mesh(new THREE.CircleGeometry(side * 0.04, 20), M.lens(), [0, side * 0.052, 0], [-HALF, 0, 0]));
    tracker.position.set(sx * hx * 0.62, hy + side * 0.05, -hz * 0.6);
    tracker.rotation.set(-0.5, 0, sx * 0.45);
    group.add(tracker);
  }
  for (const [x, z] of [[-1, 1], [1, 1], [1, -1], [-1, -1]] as const) group.add(mesh(box(side * 0.045, side * 0.03, side * 0.045), M.silverFoil(), [x * hx * 0.86, hy + side * 0.016, z * hz * 0.86]));
  // Launch-adapter ring, main engine and attitude thrusters.
  group.add(mesh(cyl(side * 0.36, side * 0.38, side * 0.07, 48, true), al, [0, -hy - side * 0.035, 0]));
  group.add(mesh(new THREE.TorusGeometry(side * 0.38, side * 0.014, 8, 48), al, [0, -hy - side * 0.07, 0], [HALF, 0, 0]));
  group.add(mesh(cyl(side * 0.09, side * 0.07, side * 0.12, 20), M.darkMetal(), [0, -hy - side * 0.06, 0]));
  const nozzle = mesh(bell(side * 0.3, side * 0.035, side * 0.16), M.darkMetal(), [0, -hy - side * 0.12, 0]);
  (nozzle.material as THREE.Material).side = THREE.DoubleSide;
  group.add(nozzle);
  const plume = mesh(new THREE.ConeGeometry(side * 0.15, side * 1.5, 24, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 3.4, 7), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }), [0, -hy - side * 1.15, 0]);
  group.add(plume);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const pod = new THREE.Group();
    pod.position.set(sx * (hx + side * 0.03), -hy * 0.82, sz * (hz + side * 0.03));
    pod.add(mesh(box(side * 0.07, side * 0.07, side * 0.07), M.silverFoil()));
    for (const [dx, dy, dz] of [[sx, 0, 0], [0, 0, sz], [0, -1, 0]] as const) {
      const thruster = mesh(cyl(side * 0.012, side * 0.028, side * 0.06, 12, true), M.darkMetal(), [dx * side * 0.06, dy * side * 0.06, dz * side * 0.06]);
      thruster.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), new THREE.Vector3(dx, dy, dz));
      (thruster.material as THREE.Material).side = THREE.DoubleSide;
      pod.add(thruster);
    }
    group.add(pod);
  }
  // Low-gain antennas and navigation lights.
  for (const sx of [-1, 1]) group.add(mesh(cyl(side * 0.012, side * 0.03, side * 0.1, 12), M.white(), [sx * hx * 0.3, hy + side * 0.05, hz * 0.7]));
  group.add(tag(mesh(new THREE.SphereGeometry(side * 0.012, 8, 6), M.ledWhite(), [0, hy + side * 0.02, hz * 0.95]), "led"));
  group.add(tag(mesh(new THREE.SphereGeometry(side * 0.012, 8, 6), M.ledGreen(), [hx * 0.9, -hy * 0.5, hz + side * 0.01]), "led"));
  return { group, size, plume, cubesat: false };
}

export interface SpacecraftModel {
  group: THREE.Group;
  /** Solar-array drive groups: rotate about X to track the Sun. */
  wings: THREE.Group[];
  /** Hinged panels, innermost first, for the deployment animation. */
  panels: THREE.Group[];
  /** Steerable antenna head (points +Y), if the design has a dish. */
  dish: THREE.Group | null;
  plume: THREE.Mesh | null;
  leds: THREE.Mesh[];
  /** Radius of a sphere that contains the model, metres. */
  radius: number;
}

/** The whole spacecraft, assembled from the mission's component list. */
export function buildSpacecraft(spacecraft: { busDryMassKg: number; components: any[] }): SpacecraftModel {
  const group = tag(new THREE.Group(), "spacecraft");
  const bus = buildBus(spacecraft.busDryMassKg);
  group.add(bus.group);
  const { size } = bus;
  const comps = spacecraft.components;
  const wings: THREE.Group[] = [];
  const panels: THREE.Group[] = [];
  let radius = size.length() / 2;

  const area = comps.filter((c) => c.type === "solar_panel").reduce((s: number, c: any) => s + c.areaM2, 0);
  if (area > 0) {
    for (const side of [-1, 1]) {
      const drive = new THREE.Group();
      drive.position.set(side * (size.x / 2 + (bus.cubesat ? 0.004 : size.x * 0.04)), bus.cubesat ? 0 : size.y * 0.12, 0);
      const wing = buildSolarWing(area / 2);
      if (side < 0) wing.rotation.y = Math.PI;
      drive.add(wing);
      group.add(drive);
      wings.push(drive);
      panels.push(...(wing.userData.panels as THREE.Group[]));
      radius = Math.max(radius, size.x / 2 + (wing.userData.length as number) * 1.05);
    }
  }

  let dish: THREE.Group | null = null;
  const antennas = comps.filter((c) => c.type === "antenna");
  antennas.forEach((a: any, i: number) => {
    if (a.diameterM && !dish) {
      const d = Math.min(a.diameterM, bus.cubesat ? 0.5 : 4);
      const model = buildDish(d);
      model.position.set(0, size.y / 2, -size.z * 0.12);
      group.add(model);
      dish = model.userData.head as THREE.Group;
      radius = Math.max(radius, size.y / 2 + d * 0.75);
    } else {
      const patch = buildPatchAntenna();
      patch.scale.setScalar(bus.cubesat ? 0.35 : Math.max(0.6, size.x * 0.7));
      patch.position.set((i % 2 ? -1 : 1) * size.x * 0.28, size.y / 2, size.z * 0.22);
      group.add(patch);
    }
  });

  // Instruments share the nadir deck, laid out on a grid and looking along +Z.
  const instruments = comps.filter((c) => c.type === "instrument");
  const cols = Math.min(3, Math.max(1, instruments.length));
  instruments.forEach((inst: any, i: number) => {
    const model = buildInstrument(inst.kind, inst.apertureM);
    const reach = new THREE.Box3().setFromObject(model);
    const span = Math.max(reach.max.x - reach.min.x, reach.max.y - reach.min.y, 0.05);
    const cell = (size.x * 0.9) / cols;
    model.scale.setScalar(Math.min(1.6, (cell * 0.86) / span));
    const row = Math.floor(i / cols);
    model.position.set((i % cols - (cols - 1) / 2) * cell, size.y * (0.2 - row * 0.42), size.z / 2 - reach.min.z * model.scale.z);
    group.add(model);
    radius = Math.max(radius, size.z / 2 + (reach.max.z - reach.min.z) * model.scale.z);
  });

  const leds: THREE.Mesh[] = [];
  group.traverse((o) => {
    if (o.name === "led") leds.push(o as THREE.Mesh);
  });
  return { group, wings, panels, dish, plume: bus.plume, leds, radius };
}

/** A component on its own, for the exploded systems view. Sits on y = 0, centred in x/z. */
export function buildComponent(c: any): THREE.Group {
  let model: THREE.Group;
  switch (c.type) {
    case "solar_panel": {
      model = buildSolarWing(c.areaM2);
      model.position.x = -(model.userData.length as number) / 2;
      break;
    }
    case "battery": model = buildBattery(c.capacityWh); break;
    case "antenna": model = c.diameterM ? buildDish(c.diameterM) : buildPatchAntenna(); break;
    case "instrument": model = buildInstrument(c.kind, c.apertureM); break;
    default: model = buildAvionics(c.powerW ?? 10);
  }
  const holder = new THREE.Group();
  holder.add(model);
  // Rest the part on the holder's origin plane so labels and rings line up.
  const bounds = new THREE.Box3().setFromObject(holder);
  model.position.y -= bounds.min.y;
  model.position.z -= (bounds.min.z + bounds.max.z) / 2;
  if (c.type !== "solar_panel") model.position.x -= (bounds.min.x + bounds.max.x) / 2;
  holder.userData.height = bounds.max.y - bounds.min.y;
  holder.userData.radius = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 2;
  return holder;
}

/** Surface rover: rocker-bogie chassis, grousered wheels, deck array and a camera mast. */
export function buildRover(rover: { wheelCount: number; wheelRadiusM: number; supportHalfSpanM: number }): THREE.Group {
  const g = tag(new THREE.Group(), "rover");
  const r = rover.wheelRadiusM;
  const half = rover.supportHalfSpanM;
  const perSide = Math.max(2, Math.round(rover.wheelCount / 2));
  const length = half * 2.3;
  const deckY = r * 2.3;
  g.add(mesh(box(length * 0.78, r * 1.1, half * 1.25), M.goldFoil(), [0, deckY, 0]));
  g.add(mesh(tile(new THREE.PlaneGeometry(length * 0.86, half * 1.5), Math.max(1, Math.round(length / 0.32)), Math.max(1, Math.round(half * 1.5 / 0.32))), M.cells(), [0, deckY + r * 0.58, 0], [-HALF, 0, 0]));
  g.add(mesh(box(length * 0.88, r * 0.05, half * 1.54), M.carbon(), [0, deckY + r * 0.55, 0]));
  for (const side of [-1, 1]) {
    const z = side * half;
    const xs = Array.from({ length: perSide }, (_, i) => (perSide === 1 ? 0 : (i / (perSide - 1) - 0.5) * length));
    const pivot = new THREE.Vector3(0, deckY - r * 0.2, z * 0.92);
    for (const x of xs) {
      const wheel = new THREE.Group();
      wheel.position.set(x, r, z);
      wheel.add(mesh(cyl(r, r, r * 0.7, 28), M.darkMetal(), [0, 0, 0], [HALF, 0, 0]));
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2;
        wheel.add(mesh(box(r * 0.07, r * 0.09, r * 0.72), M.aluminum(), [Math.cos(a) * r, Math.sin(a) * r, 0], [0, 0, a + HALF]));
      }
      wheel.add(mesh(cyl(r * 0.32, r * 0.32, r * 0.76, 16), M.aluminum(), [0, 0, 0], [HALF, 0, 0]));
      g.add(wheel);
      g.add(strut(new THREE.Vector3(x, r, z * 0.92), pivot, r * 0.09, M.aluminum()));
    }
    g.add(mesh(cyl(r * 0.16, r * 0.16, half * 0.2, 14), M.darkMetal(), [pivot.x, pivot.y, pivot.z], [HALF, 0, 0]));
  }
  // Camera mast and a small high-gain dish.
  const mastTop = deckY + r * 4.2;
  g.add(strut(new THREE.Vector3(length * 0.3, deckY + r * 0.55, half * 0.4), new THREE.Vector3(length * 0.3, mastTop, half * 0.4), r * 0.07, M.white()));
  g.add(mesh(box(r * 0.9, r * 0.42, r * 0.5), M.white(), [length * 0.3, mastTop + r * 0.2, half * 0.4]));
  for (const dz of [-0.25, 0.25]) g.add(mesh(new THREE.CircleGeometry(r * 0.14, 16), M.lens(), [length * 0.3 + r * 0.452, mastTop + r * 0.2, half * 0.4 + dz * r], [0, HALF, 0]));
  const dish = buildDish(r * 2.2);
  dish.position.set(-length * 0.28, deckY + r * 0.58, -half * 0.3);
  g.add(dish);
  return g;
}
