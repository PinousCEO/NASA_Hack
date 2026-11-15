/**
 * The player's AI as a character: a small survey probe that hovers beside the mission, turns to face the
 * player, and shows what it is doing with its body rather than with a line of text — it listens (ring
 * pulsing red), thinks (ring spinning, head tilting), speaks (eyes moving), and builds (a beam to the part
 * it is making). It is drawn from primitives; there is no model file.
 */
import * as THREE from "three";

export type CompanionState = "idle" | "listening" | "thinking" | "speaking" | "building";

const TINT: Record<CompanionState, number> = { idle: 0x4cc9f0, listening: 0xff4d6d, thinking: 0xffd166, speaking: 0x3ddc97, building: 0xc58bff };

const glowTexture = (): THREE.Texture => {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
};

export class Companion {
  /** Where it is in the world. Move this; the body inside bobs and turns by itself. */
  readonly group = new THREE.Group();
  /** A sphere a little larger than the body: the thing a fingertip or a pinch hits. */
  readonly hit: THREE.Mesh;
  state: CompanionState = "idle";
  private readonly body = new THREE.Group();
  private readonly eyes: THREE.Mesh[] = [];
  private readonly ring: THREE.Mesh;
  private readonly glow: THREE.Sprite;
  private readonly tip: THREE.Mesh;
  private readonly beam: THREE.Mesh;
  private readonly accents: THREE.MeshBasicMaterial[] = [];
  private readonly tint = new THREE.Color(TINT.idle);
  private readonly want = new THREE.Color(TINT.idle);
  private t = Math.random() * 10;
  private beamTo: THREE.Vector3 | null = null;
  private readonly tmp = new THREE.Vector3();

  constructor() {
    const accent = (): THREE.MeshBasicMaterial => { const m = new THREE.MeshBasicMaterial({ color: TINT.idle }); this.accents.push(m); return m; };
    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.045, 32, 24), new THREE.MeshStandardMaterial({ color: 0xeef2f8, roughness: 0.32, metalness: 0.25, emissive: 0x2a3a52, emissiveIntensity: 0.9 }));
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.037, 32, 20), new THREE.MeshBasicMaterial({ color: 0x070c18 }));
    visor.scale.set(1, 0.62, 0.55);
    visor.position.set(0, 0.002, 0.026);
    for (const x of [-0.014, 0.014]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.0072, 16, 12), accent());
      eye.scale.set(1, 1.5, 0.5);
      eye.position.set(x, 0.003, 0.0455);
      this.eyes.push(eye);
    }
    const pods = [-1, 1].map((side) => {
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.012, 20), new THREE.MeshStandardMaterial({ color: 0x9aa7bd, roughness: 0.4, metalness: 0.6, emissive: 0x1a2436 }));
      pod.rotation.z = Math.PI / 2;
      pod.position.set(side * 0.049, 0, 0);
      const light = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.002, 20), accent());
      light.rotation.z = Math.PI / 2;
      light.position.set(side * 0.056, 0, 0);
      return [pod, light];
    }).flat();
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.0013, 0.0013, 0.03, 8), new THREE.MeshStandardMaterial({ color: 0x9aa7bd, metalness: 0.7, roughness: 0.4 }));
    mast.position.set(0.012, 0.057, -0.004);
    this.tip = new THREE.Mesh(new THREE.SphereGeometry(0.0048, 12, 10), accent());
    this.tip.position.set(0.012, 0.074, -0.004);
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.068, 0.0022, 8, 72, Math.PI * 1.55), accent());
    this.ring.rotation.x = Math.PI / 2.4;
    (this.ring.material as THREE.MeshBasicMaterial).transparent = true;
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: TINT.idle, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.glow.scale.setScalar(0.11);
    this.glow.position.set(0, -0.055, 0);
    this.glow.raycast = () => undefined;
    this.body.add(shell, visor, ...this.eyes, ...pods, mast, this.tip, this.ring, this.glow);
    this.hit = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    const beamGeometry = new THREE.CylinderGeometry(0.014, 0.004, 1, 14, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    this.beam = new THREE.Mesh(beamGeometry, new THREE.MeshBasicMaterial({ color: TINT.building, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    this.beam.visible = false;
    this.beam.raycast = () => undefined;
    this.group.add(this.body, this.hit, this.beam);
  }

  setState(state: CompanionState): void {
    this.state = state;
    this.want.set(TINT[state]);
  }

  /** While building: the point (in world space) the beam reaches for; null puts the beam away. */
  aim(target: THREE.Vector3 | null): void {
    this.beamTo = target ? (this.beamTo ?? new THREE.Vector3()).copy(target) : null;
  }

  /** Advance the animation. `face` is where the player's head is (world space). */
  update(dt: number, face: THREE.Vector3): void {
    this.t += dt;
    const t = this.t;
    const s = this.state;
    this.tint.lerp(this.want, 1 - Math.exp(-dt * 8));
    for (const m of this.accents) m.color.copy(this.tint).multiplyScalar(1.6);
    (this.glow.material as THREE.SpriteMaterial).color.copy(this.tint);
    // Hover; turn to the player; tilt the head while thinking, nod while speaking.
    this.body.position.y = Math.sin(t * 1.8) * 0.007 + (s === "building" ? Math.sin(t * 9) * 0.003 : 0);
    this.body.lookAt(face);
    if (s === "thinking") this.body.rotateZ(Math.sin(t * 2.6) * 0.28);
    if (s === "speaking") this.body.rotateX(Math.sin(t * 5) * 0.07);
    if (s === "listening") this.body.rotateX(-0.12);
    this.ring.rotation.z += dt * (s === "thinking" ? 7 : s === "building" ? 10 : s === "listening" ? 2.4 : 0.8);
    this.ring.scale.setScalar(s === "listening" ? 1.08 + 0.14 * Math.sin(t * 9) : 1);
    // Eyes: a blink now and then; while speaking they move with the words.
    const blink = (t % 3.7) < 0.12 ? 0.12 : 1;
    const talk = s === "speaking" ? 0.55 + 0.7 * Math.abs(Math.sin(t * 13)) : s === "listening" ? 1.25 : 1;
    for (const eye of this.eyes) eye.scale.y = 1.5 * blink * talk;
    this.tip.scale.setScalar(s === "idle" ? 1 : 1 + 0.5 * Math.abs(Math.sin(t * 8)));
    (this.glow.material as THREE.SpriteMaterial).opacity = 0.42 + 0.16 * Math.sin(t * (s === "idle" ? 2 : 7));
    // The beam, from the probe to what it is making.
    this.beam.visible = s === "building" && this.beamTo !== null;
    if (this.beam.visible && this.beamTo) {
      this.group.updateMatrixWorld(true);
      const local = this.group.worldToLocal(this.tmp.copy(this.beamTo));
      this.beam.lookAt(this.group.localToWorld(local.clone()));
      this.beam.scale.set(1, 1, Math.max(0.01, local.length()));
      (this.beam.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.3 * Math.abs(Math.sin(t * 16));
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose()); else mat?.dispose?.();
    });
  }
}
