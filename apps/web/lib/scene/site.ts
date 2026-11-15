/**
 * The place a mission is about, as a small model beside the world: a dune field, a shadowed crater with ice in it,
 * hills with fire fronts, a dust storm, a coast with a bloom, a snowfield, a volcano under cloud, a lander waiting
 * for its relay, a city by its heat. Every kind of mission gets its own ground to look at.
 *
 * The ground is an illustration of the kind of place (built from formulas, not from a survey of the real site) and
 * says so on its label. What is laid over it is real: a grid whose cells are the size of what the spacecraft's
 * best camera can tell apart there (from the engineering model), beside the size the problem needs; and a scan
 * line that crosses the patch while the spacecraft has the place in view.
 */
import * as THREE from "three";
import { createLabel } from "./space";

export type SiteKind = "dunes" | "crater" | "fire" | "storm" | "water" | "snow" | "volcano" | "lander" | "city" | "terrain";
export const SITE_KINDS: SiteKind[] = ["dunes", "crater", "fire", "storm", "water", "snow", "volcano", "lander", "city", "terrain"];

/** The kind of place a problem is about, from its own words (used when the brief does not name one). */
export function siteKindFor(text: string): SiteKind {
  const t = text.toLowerCase();
  if (/\bdune|sand sea|\berg\b|ripples?\b/.test(t)) return "dunes";
  if (/wildfire|fire front|burn scar|ignition|\bfires?\b/.test(t)) return "fire";
  if (/dust.?storm|storm|opacity/.test(t)) return "storm";
  if (/volcan|\bmons\b|caldera|lava/.test(t)) return "volcano";
  if (/relay|lander|rover|scout|surface asset|traverse/.test(t)) return "lander";
  if (/snow|glacier|ice sheet|snowpack/.test(t)) return "snow";
  if (/bloom|algal|coast|delta|river|lake|flood|reservoir|plume|ocean|sea\b/.test(t)) return "water";
  if (/city|urban|heat refuge|heat island|district/.test(t)) return "city";
  if (/crater|shadow|volatile|hydrogen|ice|frost|rim|ridge|polar|regolith/.test(t)) return "crater";
  return "terrain";
}

const CAPTION: Record<SiteKind, string> = {
  dunes: "dune field", crater: "shadowed crater", fire: "fire fronts", storm: "dust storm", water: "coast and water", snow: "snowfield",
  volcano: "volcano under cloud", lander: "surface asset", city: "city heat", terrain: "survey ground",
};
const GROUND: Record<string, [number, number, number]> = { moon: [0.42, 0.42, 0.44], mars: [0.62, 0.34, 0.2], earth: [0.2, 0.34, 0.16] };

// A repeatable, smooth pseudo-noise from sums of sines: enough for ground that reads as ground.
const wave = (x: number, z: number, s: number): number => Math.sin(x * 3.1 * s + 1.7) * Math.cos(z * 2.7 * s - 0.6) + 0.5 * Math.sin((x + z) * 6.3 * s + 2.1) + 0.25 * Math.sin(x * 12.7 * s - z * 9.1 * s);
const smooth = (a: number, b: number, v: number): number => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

const N = 56; // cells along a side
export class SiteModel {
  readonly group = new THREE.Group();
  readonly kind: SiteKind;
  private readonly ground: THREE.Mesh;
  private readonly grid: THREE.LineSegments;
  private readonly scan: THREE.Mesh;
  private readonly extras = new THREE.Group();
  private readonly spots: { mesh: THREE.Object3D; phase: number; base: THREE.Vector3 }[] = [];
  private tag: THREE.Sprite | null = null;
  private note: THREE.Sprite | null = null;
  private noteText = "";
  private observing = false;
  private t = 0;
  private gridStamp = "";

  constructor(kind: SiteKind, private readonly body: string, private readonly name: string) {
    this.kind = kind;
    const geometry = new THREE.PlaneGeometry(1, 1, N, N).rotateX(-Math.PI / 2);
    geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array((N + 1) * (N + 1) * 3), 3));
    this.ground = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, emissive: 0x151515 }));
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.07, 1.04), new THREE.MeshStandardMaterial({ color: 0x0c1220, roughness: 0.6, metalness: 0.4, emissive: 0x05070c }));
    plinth.position.y = -0.045;
    const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1.04, 0.07, 1.04)), new THREE.LineBasicMaterial({ color: 0xffb020 }));
    frame.position.y = -0.045;
    this.grid = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.85, depthWrite: false }));
    this.scan = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.035).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.2, 2.6), transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    this.scan.position.y = 0.27;
    this.scan.visible = false;
    for (const o of [this.ground, plinth, frame, this.grid, this.scan]) o.raycast = () => undefined;
    this.group.add(plinth, frame, this.ground, this.grid, this.scan, this.extras);
    this.shape(0);
    this.dress();
    this.tag = createLabel(name.toUpperCase(), { height: 0.11, color: "#ffb020", sub: `${CAPTION[kind]} · illustration of the site` });
    this.tag.position.set(0, 0.56, -0.52);
    this.group.add(this.tag);
  }

  /** Height (0…~0.25) and colour of the ground at a point of the patch (x, z in -0.5…0.5). */
  private at(x: number, z: number, t: number): [number, number, number, number] {
    const base = GROUND[this.body] ?? GROUND.moon!;
    const r = Math.hypot(x, z);
    const rough = 0.012 * wave(x, z, 3.2);
    const tone = (k: number): [number, number, number] => [base[0]! * k, base[1]! * k, base[2]! * k];
    switch (this.kind) {
      case "dunes": {
        // Crests march slowly downwind: the thing this kind of mission is trying to catch.
        const crest = Math.abs(Math.sin(x * 11 + Math.sin(z * 3.2) * 1.3 - t * 0.35));
        const h = 0.02 + 0.075 * Math.pow(crest, 1.6) + rough * 0.4;
        const k = 0.7 + 0.5 * crest;
        return [h, ...((this.body === "earth" ? [0.78 * k, 0.66 * k, 0.42 * k] : tone(k * 1.25)) as [number, number, number])];
      }
      case "crater": {
        const rim = 0.085 * Math.exp(-Math.pow((r - 0.3) / 0.055, 2));
        const bowl = -0.11 * (1 - smooth(0, 0.3, r));
        const inside = 1 - smooth(0.2, 0.3, r);
        const k = 0.95 - 0.8 * inside; // the floor never sees the Sun
        return [0.13 + rim + bowl + rough, ...tone(k)];
      }
      case "fire": {
        const h = 0.05 + 0.05 * wave(x, z, 1.1) + rough;
        const burnt = smooth(0.1, 0.5, wave(x + 0.4, z - 0.2, 0.9));
        return [Math.max(0.01, h), 0.1 + 0.05 * burnt, 0.26 - 0.18 * burnt, 0.1];
      }
      case "storm": return [0.03 + 0.02 * wave(x, z, 1.4) + rough, ...tone(0.9 + 0.2 * wave(x, z, 2))];
      case "water": {
        const land = wave(x * 0.9 + 0.3, z * 0.9, 0.75) + x * 1.4;
        if (land > 0.15) { const hgt = 0.03 + 0.05 * smooth(0.15, 1.2, land) + rough; return [hgt, 0.2, 0.36 - 0.1 * smooth(0.2, 1, land), 0.16]; }
        // Open water, with the plume or bloom the mission is after drifting through it.
        const swirl = smooth(0.35, 0.9, Math.sin(x * 7 + Math.sin(z * 6 + t * 0.5) * 1.5) * Math.cos(z * 5 - t * 0.3));
        return [0.012 + 0.003 * Math.sin(x * 40 + t * 2), 0.04 + 0.18 * swirl, 0.2 + 0.32 * swirl, 0.42 - 0.2 * swirl];
      }
      case "snow": {
        const h = 0.04 + 0.11 * Math.max(0, wave(x, z, 1.25)) + rough;
        const snow = smooth(0.07, 0.11, h);
        return [h, 0.3 + 0.62 * snow, 0.32 + 0.62 * snow, 0.34 + 0.64 * snow];
      }
      case "volcano": {
        const cone = Math.max(0, 0.24 - r * 0.62);
        const caldera = r < 0.07 ? -0.05 * (1 - r / 0.07) : 0;
        return [0.02 + cone + caldera + rough * 0.6, ...tone(0.75 + 0.9 * cone)];
      }
      case "city": return [0.02 + rough * 0.3, 0.16, 0.18, 0.2];
      case "lander": return [0.03 + 0.012 * wave(x, z, 2.2) + rough, ...tone(0.95 + 0.15 * wave(x, z, 3))];
      default: return [0.04 + 0.05 * wave(x, z, 1.3) + rough, ...tone(0.9 + 0.25 * wave(x, z, 1.8))];
    }
  }

  private shape(t: number): void {
    const pos = this.ground.geometry.getAttribute("position") as THREE.BufferAttribute;
    const col = this.ground.geometry.getAttribute("color") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const [h, r, g, b] = this.at(pos.getX(i), pos.getZ(i), t);
      pos.setY(i, h);
      col.setXYZ(i, r, g, b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.ground.geometry.computeVertexNormals();
  }

  /** The things that stand on the ground: what makes this place this kind of place. */
  private dress(): void {
    const add = (mesh: THREE.Object3D, x: number, z: number, lift = 0): void => {
      mesh.position.set(x, this.at(x, z, 0)[0] + lift, z);
      mesh.raycast = () => undefined;
      this.extras.add(mesh);
      this.spots.push({ mesh, phase: Math.random() * 6.28, base: mesh.position.clone() });
    };
    const glow = (color: THREE.Color, size: number): THREE.Mesh => new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    const rnd = (i: number, k: number): number => ((Math.sin(i * 127.1 + k * 311.7) * 43758.5453) % 1 + 1) % 1 - 0.5;
    if (this.kind === "fire") for (let i = 0; i < 26; i++) { const a = i * 0.24; add(glow(new THREE.Color(3.2, 0.9 + 0.5 * Math.abs(rnd(i, 3)), 0.1), 0.012 + 0.008 * Math.abs(rnd(i, 1))), -0.3 + 0.03 * i * Math.cos(a * 0.4) + rnd(i, 2) * 0.06, -0.32 + i * 0.024 + rnd(i, 4) * 0.05, 0.012); }
    if (this.kind === "crater") for (let i = 0; i < 34; i++) { const a = i * 2.4, r = 0.03 + 0.15 * Math.abs(rnd(i, 5)); add(glow(new THREE.Color(0.5, 1.6, 2.6), 0.006), Math.cos(a) * r, Math.sin(a) * r, 0.006); }
    if (this.kind === "storm") for (let i = 0; i < 5; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1 + i * 0.045, 0.02 + i * 0.008, 8, 40).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.9, 0.55, 0.3), transparent: true, opacity: 0.4 - i * 0.05, depthWrite: false }));
      add(ring, 0.05, -0.02, 0.05 + i * 0.035);
    }
    if (this.kind === "volcano") for (let i = 0; i < 9; i++) { const a = i * 0.7; const puff = new THREE.Mesh(new THREE.SphereGeometry(0.05 + 0.03 * Math.abs(rnd(i, 6)), 10, 8), new THREE.MeshBasicMaterial({ color: 0xdfe6f2, transparent: true, opacity: 0.55, depthWrite: false })); puff.scale.y = 0.45; add(puff, Math.cos(a) * 0.22, Math.sin(a) * 0.22, 0.2 + 0.03 * rnd(i, 7)); }
    if (this.kind === "city") for (let i = 0; i < 81; i++) {
      const gx = (i % 9) - 4, gz = Math.floor(i / 9) - 4;
      const heat = Math.max(0, 1 - Math.hypot(gx, gz) / 5.2) + 0.25 * rnd(i, 8);
      const height = 0.02 + 0.07 * Math.abs(rnd(i, 9)) + 0.05 * heat;
      const block = new THREE.Mesh(new THREE.BoxGeometry(0.07, height, 0.07), new THREE.MeshStandardMaterial({ color: new THREE.Color(0.25 + heat * 0.7, 0.28 - heat * 0.1, 0.36 - heat * 0.25), emissive: new THREE.Color(heat * 0.7, heat * 0.18, 0), roughness: 0.7 }));
      add(block, gx * 0.1, gz * 0.1, height / 2);
    }
    if (this.kind === "lander") {
      const lander = new THREE.Group();
      const gold = new THREE.MeshStandardMaterial({ color: 0xc9a23a, metalness: 0.8, roughness: 0.35, emissive: 0x2a1c00 });
      lander.add(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.045, 8), gold));
      for (let i = 0; i < 4; i++) { const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 6), new THREE.MeshStandardMaterial({ color: 0xbfc7d6, metalness: 0.7, roughness: 0.4 })); leg.position.set(Math.cos(i * 1.57 + 0.78) * 0.055, -0.03, Math.sin(i * 1.57 + 0.78) * 0.055); leg.rotation.z = Math.cos(i * 1.57 + 0.78) * 0.5; leg.rotation.x = -Math.sin(i * 1.57 + 0.78) * 0.5; lander.add(leg); }
      const dish = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.02, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0xe8eefb, side: THREE.DoubleSide, metalness: 0.5, roughness: 0.4 }));
      dish.position.y = 0.045; dish.rotation.x = Math.PI;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.02, 0.5, 10, 1, true), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 2.2, 1.2), transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
      beam.position.y = 0.3; beam.name = "uplink";
      lander.add(dish, beam);
      add(lander, 0.02, 0.04, 0.06);
    }
  }

  /**
   * What the spacecraft's best camera can tell apart here (metres) against what the problem needs. With no need the
   * grid is hidden; with a need but no camera on board the note says so.
   */
  setDetail(nowM: number | null, needM: number | null): void {
    const stamp = `${nowM === null ? "x" : nowM.toPrecision(3)}|${needM ?? "x"}`;
    if (stamp === this.gridStamp) return;
    this.gridStamp = stamp;
    this.grid.visible = needM !== null && nowM !== null;
    if (needM !== null && nowM !== null) {
      // The cells grow as the camera gets coarser: at "just enough" there are twelve across.
      const cells = Math.min(44, Math.max(2, Math.round(12 * (needM / nowM))));
      const pts: number[] = [];
      for (let i = 0; i <= cells; i++) {
        const v = -0.5 + i / cells;
        for (let k = 0; k < 28; k++) {
          const a = -0.5 + k / 28, b = -0.5 + (k + 1) / 28;
          pts.push(v, this.at(v, a, 0)[0] + 0.006, a, v, this.at(v, b, 0)[0] + 0.006, b);
          pts.push(a, this.at(a, v, 0)[0] + 0.006, v, b, this.at(b, v, 0)[0] + 0.006, v);
        }
      }
      this.grid.geometry.dispose();
      this.grid.geometry = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
      (this.grid.material as THREE.LineBasicMaterial).color.set(nowM <= needM ? 0x3ddc97 : 0xff5d73);
    }
    const show = (m: number): string => (m >= 10 ? m.toFixed(0) : m.toFixed(1));
    const text = needM === null ? "" : nowM === null ? `NO CAMERA ON BOARD|needs to see ${show(needM)} m` : `${nowM <= needM ? "SHARP ENOUGH" : "TOO COARSE"}|your camera sees ${show(nowM)} m here · needs ${show(needM)} m`;
    if (text !== this.noteText) {
      this.noteText = text;
      if (this.note) { this.group.remove(this.note); (this.note.material as THREE.SpriteMaterial).map?.dispose(); this.note.material.dispose(); this.note = null; }
      if (text) {
        const [head, sub] = text.split("|");
        this.note = createLabel(head!, { height: 0.085, color: nowM !== null && needM !== null && nowM <= needM ? "#3ddc97" : "#ff8a9a", sub: sub! });
        this.note.position.set(0, 0.36, 0.56);
        this.group.add(this.note);
      }
    }
  }

  /** The spacecraft has this place in view right now: the scan line runs. */
  setObserving(on: boolean): void { this.observing = on; }

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    if ((this.kind === "dunes" || this.kind === "water") && Math.floor(t * 12) !== Math.floor((t - dt) * 12)) this.shape(t);
    for (const s of this.spots) {
      const k = 0.5 + 0.5 * Math.sin(t * 5 + s.phase);
      if (this.kind === "fire") { s.mesh.scale.setScalar(0.7 + 0.9 * k); ((s.mesh as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.5 * k; }
      else if (this.kind === "crater") ((s.mesh as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.75 * Math.pow(k, 3);
      else if (this.kind === "storm") { s.mesh.rotation.y = t * (0.8 + s.phase * 0.2); s.mesh.position.x = s.base.x + 0.12 * Math.sin(t * 0.3); s.mesh.position.z = s.base.z + 0.1 * Math.cos(t * 0.23); }
      else if (this.kind === "volcano") { const a = t * 0.12 + s.phase; s.mesh.position.x = Math.cos(a) * 0.22; s.mesh.position.z = Math.sin(a) * 0.22; }
      else if (this.kind === "city") ((s.mesh as THREE.Mesh).material as THREE.MeshStandardMaterial).emissiveIntensity = 0.7 + 0.5 * k;
      else if (this.kind === "lander") { const beam = s.mesh.getObjectByName("uplink") as THREE.Mesh | undefined; if (beam) (beam.material as THREE.MeshBasicMaterial).opacity = this.observing ? 0.35 + 0.45 * k : 0.06; }
    }
    this.scan.visible = this.observing;
    if (this.observing) this.scan.position.z = -0.5 + ((t * 0.55) % 1);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => { (x as THREE.SpriteMaterial).map?.dispose?.(); x.dispose(); });
      else if (mat) { (mat as THREE.SpriteMaterial).map?.dispose?.(); mat.dispose(); }
    });
  }
}
