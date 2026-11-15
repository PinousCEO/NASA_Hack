/**
 * The 3D workspace host, built on the Meta Immersive Web SDK (IWSDK).
 *
 * One IWSDK World renders the mission on every device:
 *  - desktop / mobile browser: orbit camera, click to select
 *  - WebXR (Quest browser): the same scene on a "mission table" in front of the user, in
 *    passthrough MR when `immersive-ar` is available or VR otherwise, with hand / controller
 *    grabbing, spatial sliders for orbit parameters, and spatial panels for status and commands
 *
 * Nothing is assumed about the device: every XR feature is detected first, and hand
 * tracking is requested as optional.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Collab } from "../collab";
import { BODY_RADIUS_KM, MissionScene, type ViewMode } from "../scene/MissionScene";
import { Companion, type CompanionState } from "../scene/companion";
import { compileAsyncOf, gradeRenderer, interceptRender, softwareGl } from "../scene/fx";
import { createEnvironmentAsync, createLabel, createSky, deviceQuality, forceQuality } from "../scene/space";

export interface XrSupport {
  webxr: boolean;
  secureContext: boolean;
  immersiveAr: boolean;
  immersiveVr: boolean;
  emulated: boolean;
  /** Why XR is unavailable, in words a user can act on. */
  reason: string | null;
}

/** Detect what this browser can actually do. Never throws. */
export async function detectXr(): Promise<XrSupport> {
  const out: XrSupport = { webxr: false, secureContext: typeof window !== "undefined" && window.isSecureContext, immersiveAr: false, immersiveVr: false, emulated: Boolean((window as any).__xrDevice), reason: null };
  const xr = (navigator as any).xr as { isSessionSupported?(mode: string): Promise<boolean> } | undefined;
  if (!out.secureContext) out.reason = "WebXR needs a secure context: open this page over HTTPS (or on localhost).";
  else if (!xr?.isSessionSupported) out.reason = "This browser has no WebXR support. Open the mission in the Meta Quest Browser to enter mixed reality.";
  else {
    out.webxr = true;
    const supported = (mode: string): Promise<boolean> => xr.isSessionSupported!(mode).catch(() => false);
    [out.immersiveAr, out.immersiveVr] = await Promise.all([supported("immersive-ar"), supported("immersive-vr")]);
    if (!out.immersiveAr && !out.immersiveVr) out.reason = "WebXR is present but no headset is available. Connect a headset or open the mission in the Meta Quest Browser.";
  }
  return out;
}

/** Install the Immersive Web Emulation Runtime (a software Quest 3) — for development and automated checks only. */
export async function installEmulator(): Promise<void> {
  if ((window as any).__xrDevice) return;
  const { XRDevice, metaQuest3 } = await import("iwer");
  const device = new XRDevice(metaQuest3);
  // Explicit opt-in (?iwer=1): replace the browser's own WebXR runtime with the emulated headset.
  device.installRuntime({ forceInstall: true });
  (window as any).__xrDevice = device;
}

export interface WorkspaceCallbacks {
  collab(): Collab | null;
  canEdit(): boolean;
  onSelect(componentId: string | null): void;
  onXrChange(active: boolean, mode: "ar" | "vr" | null): void;
  /** High-level actions raised from spatial UI. */
  onAction(action: { type: "simulate" } | { type: "say"; text: string } | { type: "request"; text: string } | { type: "catalog"; itemId: string } | { type: "connect"; componentId: string } | { type: "decide"; proposalId: string; approve: boolean }): void;
  notify(message: string, tone?: "info" | "warn" | "bad"): void;
  /** The local player's name and colour, for the marker of a place they point at. */
  me?(): { name: string; color: string };
  /** Speech to text for the headset's Speak button: a recording in, the sentence out. */
  transcribe?(audio: Blob): Promise<string>;
  /** The crew member turned the world or let go of it: share the moment with the rest of the crew. */
  onClock?(clock: { timeMs: number; rate: number; turning: boolean }): void;
}

export interface SpatialStatus {
  title: string;
  lines: { k: string; v: string; tone?: "ok" | "warn" | "bad" }[];
  footer: string;
  quick: { label: string; action: Parameters<WorkspaceCallbacks["onAction"]>[0] }[];
  pending: { proposalId: string; summary: string; canApprove: boolean } | null;
  activity: string;
  /** The latest message a crewmate sent to the crew (the probe reads it out), or null. */
  crew?: { who: string; text: string; at: number } | null;
  /** The named place this mission is about (marked on the world), or "". */
  target?: string;
  /** Cadet level: what stands in the way and one way through it, for the probe to offer unasked ("" when there is none). */
  hint?: string;
  /** The player's own AI: their latest question in the current thread and its reply (null before the first question). */
  ai?: { thread: string; question: string; answer: string; state: string } | null;
}

export interface Workspace {
  scene: MissionScene;
  support: XrSupport;
  inXr: boolean;
  setMode(mode: ViewMode): void;
  enterXr(mode: "ar" | "vr"): void;
  exitXr(): void;
  setSpatialStatus(status: SpatialStatus): void;
  /** Re-sync interactive objects after mission state changed. */
  refresh(): void;
  /** Resolves when the planet imagery is on screen and shaders are compiled (or after `timeoutMs`). */
  ready(timeoutMs?: number): Promise<void>;
  /** Stand on the line to Earth and look back: the world shows the phase it has from home (desktop only). */
  viewFromEarth(on: boolean): void;
  /** Chase camera: keep the spacecraft centred and close (desktop only). */
  follow(on: boolean): void;
  /** Frame the sunlit side; with `animate`, fly the camera in from deep space first (desktop only). */
  intro(animate?: boolean): void;
  /** World-space positions of interactive objects, for automated checks with the XR emulator. */
  debug: { knob(id: string): number[] | null; component(id: string): number[] | null; grabbing(): number; uiVisible(): boolean; timeRing(): number[] | null; turn(angleRad: number): void; capture(): Promise<string>; pressKeys(captions: string[]): number; typed(): string; ai(): { visible: boolean; lines: string[] }; frames(ms: number): Promise<{ renders: number; updates: number; presenting: boolean; visibility: string }>; camera(): number[]; quick(): string[]; pressQuick(i: number): boolean; status(): { k: string; v: string }[]; activity(): string; inputs(): { hand: string; kind: string; present: boolean; pinch: boolean; palmUp: number; open: boolean; fist: boolean; gap: number; ray: boolean; point: number[] }[]; table(): { position: number[]; quaternion: number[]; size: number; onPalm: boolean; gesture: string; shown: boolean; palmMode: boolean }; resetView(): void; summon(on: boolean): void; companion(): { visible: boolean; state: string; position: number[]; bubble: string[]; tools: boolean }; built(ids: string[]): void; voice(): { state: string; label: string }; say(text: string): void };
  dispose(): void;
}

// ---------- Spatial UI: canvas-textured panels with individually interactive buttons ----------
const PX = 900; // texture pixels per metre
class Panel {
  readonly group = new THREE.Group();
  private readonly canvas = document.createElement("canvas");
  private readonly texture: THREE.CanvasTexture;
  readonly buttons: { mesh: THREE.Mesh; onClick(): void }[] = [];

  constructor(readonly width: number, readonly height: number) {
    this.canvas.width = Math.round(width * PX);
    this.canvas.height = Math.round(height * PX);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: this.texture, transparent: true }));
    this.group.add(face);
  }

  draw(paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): void {
    const ctx = this.canvas.getContext("2d")!;
    const { width: w, height: h } = this.canvas;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(8, 14, 28, 0.9)";
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 28);
    ctx.fill();
    ctx.strokeStyle = "rgba(120, 180, 255, 0.45)";
    ctx.lineWidth = 3;
    ctx.stroke();
    paint(ctx, w, h);
    this.texture.needsUpdate = true;
  }

  /** Add a button at (x, y) metres from the panel's top-left corner. */
  button(label: string, x: number, y: number, w: number, h: number, onClick: () => void, color = "#16284d"): THREE.Mesh {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * PX);
    canvas.height = Math.round(h * PX);
    let text = label;
    const paint = (bg: string): void => {
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 14);
      ctx.fill();
      ctx.strokeStyle = "rgba(76, 201, 240, 0.8)";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = "#e8eefb";
      // Text sized for comfortable reading at arm's length (≥ 1.3° of visual angle at 0.7 m).
      ctx.font = `600 ${Math.min(34, canvas.height * 0.42)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 20);
    };
    paint(color);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
    mesh.position.set(-this.width / 2 + x + w / 2, this.height / 2 - y - h / 2, 0.004);
    mesh.userData.hover = (on: boolean): void => {
      paint(on ? "#2a4a8c" : color);
      texture.needsUpdate = true;
    };
    mesh.userData.setLabel = (next: string): void => {
      if (next === text) return;
      text = next;
      paint(color);
      texture.needsUpdate = true;
    };
    mesh.userData.caption = label;
    this.group.add(mesh);
    this.buttons.push({ mesh, onClick });
    return mesh;
  }
}

interface Slider { fill?: THREE.Mesh; ring?: THREE.Mesh; glow?: THREE.Sprite; tint?: THREE.Color; id: string; path: string; group: THREE.Group; knob: THREE.Mesh; length: number; min: number; max: number; read(config: any): number; patch(value: number, config: any): { path: string; value: unknown }[]; format(value: number): string; label: THREE.Sprite | null; title: string }

export async function createWorkspace(container: HTMLElement, callbacks: WorkspaceCallbacks): Promise<Workspace> {
  const IW = await import("@iwsdk/core");
  const support = await detectXr();

  const world = await IW.World.create(container, {
    xr: {
      sessionMode: support.immersiveAr ? IW.SessionMode.ImmersiveAR : IW.SessionMode.ImmersiveVR,
      referenceSpace: IW.ReferenceSpaceType.LocalFloor,
      // Hand tracking is optional: controllers work when it is unavailable or declined.
      features: { handTracking: true },
      offer: "none",
    },
    render: { near: 0.02, far: 3000, fov: 50, camera: { position: [3.2, 1.6, 4.2], lookAt: [0, 0, 0] } },
    features: { grabbing: true, locomotion: false, physics: false, sceneUnderstanding: false, spatialUI: false },
  } as any);

  // CPU rasterisers get the light tier: smaller textures, fewer stars, reduced resolution, no post-processing.
  const slowGpu = softwareGl(world.renderer as THREE.WebGLRenderer);
  if (slowGpu) {
    forceQuality("low");
    (world.renderer as THREE.WebGLRenderer).setPixelRatio(0.6);
  }
  else (world.renderer as THREE.WebGLRenderer).setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  const scene = new MissionScene();
  const sky = createSky({ renderer: world.renderer as THREE.WebGLRenderer });
  const backdrop = new THREE.Color(0x000000);
  world.scene.add(sky.object);
  world.scene.background = backdrop;
  const renderer = world.renderer as THREE.WebGLRenderer;
  gradeRenderer(renderer);
  // A canvas whose context is going away can show as a blank rectangle for a frame: hide it instead.
  const hideCanvas = (): void => { renderer.domElement.style.visibility = "hidden"; };
  window.addEventListener("pagehide", hideCanvas);
  renderer.domElement.addEventListener("webglcontextlost", hideCanvas);
  renderer.domElement.addEventListener("webglcontextrestored", () => { renderer.domElement.style.visibility = ""; });
  let environment: THREE.Texture | null = null;
  try {
    environment = await createEnvironmentAsync(renderer);
  } catch {
    environment = null; // image-based lighting is an enhancement; direct light still works
  }
  scene.attach(world.scene as THREE.Scene, environment);
  const shadows = !slowGpu && deviceQuality() === "high";
  renderer.shadowMap.enabled = shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  scene.setShadows(shadows);
  let fxOn = true;
  // Bloom and film grade on the desktop; `?fx=0` turns them off (slow or software GPUs).
  const fxOff = typeof location !== "undefined" && new URLSearchParams(location.search).get("fx") === "0";
  const post = fxOff || slowGpu ? null : interceptRender(renderer, world.scene as THREE.Scene, world.camera as THREE.Camera, () => !inXr && fxOn);
  // Nothing is drawn until `ready()` has linked the programs; the timer is a backstop if it is never called.
  post?.hold(true);
  setTimeout(() => post?.hold(false), 9000);
  const rootEntity = world.createTransformEntity(scene.root);
  const systemsEntity = world.createTransformEntity(scene.systemsView, { parent: rootEntity } as any);

  const controls = new OrbitControls(world.camera, world.renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.2;
  controls.maxDistance = 30;

  let inXr = false;
  let xrMode: "ar" | "vr" | null = null;
  let disposed = false;
  let status: SpatialStatus | null = null;
  let typed = "";
  const ui = new THREE.Group(); // spatial UI, only shown in XR
  ui.visible = false;
  // Spatial UI lives under one entity so a single flag shows or hides all of it.
  const uiEntity = world.createTransformEntity(ui);

  // ---------- interactive entities ----------
  const componentEntities = new Map<string, any>();
  const grabbing = new Map<any, { kind: "component"; id: string } | { kind: "slider"; slider: Slider }>();
  const uiEntities: any[] = [];

  const makeInteractive = (object: THREE.Object3D, parent: any, grab: boolean): any => {
    const entity = world.createTransformEntity(object, { parent } as any);
    entity.addComponent(IW.Interactable);
    if (grab) entity.addComponent(IW.OneHandGrabbable, { rotate: true, translate: true });
    return entity;
  };

  const syncComponentEntities = (): void => {
    for (const e of componentEntities.values()) {
      try { e.destroy(); } catch { /* the object was already removed with the scene rebuild */ }
    }
    componentEntities.clear();
    if (!inXr) return; // desktop selects by clicking; grabbing is an XR interaction
    for (const [id, object] of scene.componentObjects) componentEntities.set(id, makeInteractive(object, systemsEntity, callbacks.canEdit()));
  };
  scene.onRebuild = syncComponentEntities;

  // ---------- turning the world by hand ----------
  // In a headset the planet wears a ring at its equator. Grab it and twist: the world turns, and the
  // clock moves by the time that turn takes. On the desktop the same thing is done by dragging the planet.
  const timeRing = new THREE.Group();
  const ringMesh = new THREE.Mesh(new THREE.TorusGeometry(1.16, 0.012, 10, 96).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.3, 0.3), transparent: true, opacity: 0.85 }));
  const ringGrip = new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 14), new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0x8a4a00, roughness: 0.35 }));
  ringGrip.position.set(1.16, 0, 0);
  timeRing.add(ringMesh, ringGrip);
  timeRing.visible = false;
  scene.orbitView.add(timeRing);
  const orbitEntity = world.createTransformEntity(scene.orbitView, { parent: rootEntity } as any);
  const timeRingEntity = world.createTransformEntity(timeRing, { parent: orbitEntity } as any);
  timeRingEntity.addComponent(IW.Interactable);
  timeRingEntity.addComponent(IW.OneHandGrabbable, { rotate: true, translate: true });
  let ringHeld = false;
  let ringYaw = 0;
  /** Where the handle is around the equator, from wherever the hand has carried it. */
  const handleAngle = (): number => {
    const p = scene.orbitView.worldToLocal(ringGrip.getWorldPosition(new THREE.Vector3()));
    return Math.atan2(-p.z, p.x);
  };
  let lastClockSent = 0;
  const shareClock = (turning: boolean, force = false): void => {
    const now = performance.now();
    if (!force && now - lastClockSent < 90) return;
    lastClockSent = now;
    callbacks.onClock?.({ timeMs: scene.clockMs, rate: scene.clockRate, turning });
  };

  // ---------- spatial sliders (orbit altitude, inclination, mission day) ----------
  const sliders: Slider[] = [];
  const rack = new THREE.Group();
  rack.position.set(-0.3, 0.74, -0.36);
  rack.rotation.x = -Math.PI / 5;
  ui.add(rack);
  const rackEntity = world.createTransformEntity(rack, { parent: uiEntity } as any);
  const addSlider = (spec: Omit<Slider, "group" | "knob" | "label" | "length">, row: number): void => {
    const length = 0.6;
    const group = new THREE.Group();
    group.position.set(0, -row * 0.1, 0);
    // A rail of light: a dark channel, a bright fill up to the knob, ticks along it, and a crystal knob in a turning
    // ring with a glow around it. Each slider has its own colour.
    const tint = new THREE.Color([0x4cc9f0, 0xc58bff, 0xffb020][row % 3]!);
    const channel = new THREE.Mesh(new THREE.CapsuleGeometry(0.0075, length, 6, 12).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0b1326, roughness: 0.5, metalness: 0.6, emissive: 0x0a1630 }));
    channel.position.x = length / 2;
    const fill = new THREE.Mesh(new THREE.CylinderGeometry(0.0052, 0.0052, 1, 12).rotateZ(Math.PI / 2).translate(0.5, 0, 0), new THREE.MeshBasicMaterial({ color: tint.clone().multiplyScalar(1.9) }));
    fill.position.z = 0.0035;
    const track = new THREE.Group();
    track.add(channel, fill);
    for (let i = 0; i <= 10; i++) {
      const tick = new THREE.Mesh(new THREE.BoxGeometry(0.0016, i % 5 === 0 ? 0.02 : 0.011, 0.0016), new THREE.MeshBasicMaterial({ color: tint.clone().multiplyScalar(i % 5 === 0 ? 1.2 : 0.6) }));
      tick.position.set((i / 10) * length, -0.017, 0);
      track.add(tick);
    }
    const knob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.024, 0), new THREE.MeshStandardMaterial({ color: tint, emissive: tint.clone().multiplyScalar(0.9), roughness: 0.15, metalness: 0.3, flatShading: true }));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.036, 0.0022, 8, 40, Math.PI * 1.6), new THREE.MeshBasicMaterial({ color: tint.clone().multiplyScalar(1.8), transparent: true, opacity: 0.9 }));
    const haloCanvas = document.createElement("canvas");
    haloCanvas.width = haloCanvas.height = 96;
    const hctx = haloCanvas.getContext("2d")!;
    const grad = hctx.createRadialGradient(48, 48, 2, 48, 48, 48);
    grad.addColorStop(0, "rgba(255,255,255,0.95)");
    grad.addColorStop(0.4, "rgba(255,255,255,0.28)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    hctx.fillStyle = grad;
    hctx.fillRect(0, 0, 96, 96);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(haloCanvas), color: tint, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.scale.setScalar(0.12);
    for (const o of [channel, fill, ring, glow, ...track.children]) o.raycast = () => undefined;
    knob.add(ring, glow);
    group.add(track, knob);
    rack.add(group);
    const slider: Slider = { ...spec, group, knob, length, label: null, fill, ring, glow, tint };
    sliders.push(slider);
    const groupEntity = world.createTransformEntity(group, { parent: rackEntity } as any);
    const entity = world.createTransformEntity(knob, { parent: groupEntity } as any);
    entity.addComponent(IW.Interactable);
    entity.addComponent(IW.OneHandGrabbable, { rotate: false, translate: true });
    grabTargets.set(entity, { kind: "slider", slider });
  };
  const grabTargets = new Map<any, { kind: "slider"; slider: Slider }>();
  const day = (iso: string): number => Date.parse(iso) / 86400000;
  addSlider({ id: "altitude", title: "ALTITUDE", path: "orbit.semiMajorAxisKm", min: 20, max: 2000, read: (c) => c.orbit.semiMajorAxisKm * (1 - c.orbit.eccentricity) - BODY_RADIUS_KM[c.centralBody as keyof typeof BODY_RADIUS_KM], patch: (v, c) => [{ path: "orbit.semiMajorAxisKm", value: Math.round(BODY_RADIUS_KM[c.centralBody as keyof typeof BODY_RADIUS_KM] + v) }], format: (v) => `${v.toFixed(0)} km` }, 0);
  addSlider({ id: "inclination", title: "INCLINATION", path: "orbit.inclinationDeg", min: 0, max: 180, read: (c) => c.orbit.inclinationDeg, patch: (v) => [{ path: "orbit.inclinationDeg", value: Math.round(v) }], format: (v) => `${v.toFixed(0)}°` }, 1);
  addSlider({ id: "date", title: "MISSION DAY", path: "missionTime", min: 0, max: 365, read: (c) => day(c.missionTime) - day(c.orbit.epoch), patch: (v, c) => [{ path: "missionTime", value: new Date((day(c.orbit.epoch) + Math.round(v)) * 86400000).toISOString().replace(".000Z", "Z") }], format: (v) => `day ${v.toFixed(0)}` }, 2);

  const placeSliders = (): void => {
    const config = scene.mission?.config;
    if (!config) return;
    for (const s of sliders) {
      if ([...grabbing.values()].some((g) => g.kind === "slider" && g.slider === s)) continue;
      const value = Math.min(s.max, Math.max(s.min, s.read(config)));
      s.knob.position.set(((value - s.min) / (s.max - s.min)) * s.length, 0, 0);
      s.fill?.scale.set(Math.max(0.001, s.knob.position.x), 1, 1);
      labelSlider(s, value);
    }
  };
  const labelSlider = (s: Slider, value: number): void => {
    if (s.label) {
      s.group.remove(s.label);
      (s.label.material as THREE.SpriteMaterial).map?.dispose();
      s.label.material.dispose();
    }
    s.label = createLabel(s.title, { height: 0.03, color: `#${(s.tint ?? new THREE.Color(0x4cc9f0)).getHexString()}`, sub: s.format(value) });
    s.label.position.set(s.length / 2, 0.05, 0);
    s.group.add(s.label);
  };

  // ---------- spatial panels ----------
  const statusPanel = new Panel(0.62, 0.42);
  // Everything a hand has to touch is within arm's reach of where the player stands.
  statusPanel.group.position.set(-0.52, 1.28, -0.5);
  statusPanel.group.rotation.y = 0.75;
  const controlPanel = new Panel(0.62, 0.42);
  controlPanel.group.position.set(0.52, 1.28, -0.5);
  controlPanel.group.rotation.y = -0.75;
  const keyboard = new Panel(0.66, 0.26);
  keyboard.group.position.set(0, 0.86, -0.34);
  keyboard.group.rotation.x = -Math.PI / 4;
  keyboard.group.visible = false;
  // The player's own AI answers on a wide panel above the far side of the table, tilted down towards them.
  const aiPanel = new Panel(1.0, 0.56);
  aiPanel.group.position.set(0, 1.66, -0.98);
  aiPanel.group.rotation.x = 0.16;
  aiPanel.group.visible = false;
  let aiLines: string[] = [];
  // One wide button under the controls: speak to your AI. A headset has no keyboard worth typing a question on.
  const voicePanel = new Panel(0.62, 0.1);
  voicePanel.group.position.set(0.52, 1.0, -0.5);
  voicePanel.group.rotation.y = -0.75;
  voicePanel.draw(() => undefined);
  ui.add(statusPanel.group, controlPanel.group, keyboard.group, aiPanel.group, voicePanel.group);

  const registerButtons = (panel: Panel): void => {
    const panelEntity = world.createTransformEntity(panel.group, { parent: uiEntity } as any);
    for (const b of panel.buttons) {
      if (b.mesh.userData.entity) continue;
      const entity = world.createTransformEntity(b.mesh, { parent: panelEntity } as any);
      entity.addComponent(IW.Interactable);
      // With bare hands a button is pressed with a fingertip (hands cast no far ray: see readHands).
      entity.addComponent(IW.PokeInteractable);
      b.mesh.userData.entity = entity;
      uiEntities.push(entity);
      const target = b.mesh as unknown as { addEventListener(type: string, cb: () => void): void };
      target.addEventListener("click", () => b.onClick());
      target.addEventListener("pointerenter", () => b.mesh.userData.hover(true));
      target.addEventListener("pointerleave", () => b.mesh.userData.hover(false));
    }
  };

  const drawStatus = (): void => {
    if (!status) return;
    const s = status;
    statusPanel.draw((ctx, w) => {
      ctx.fillStyle = "#4cc9f0";
      ctx.font = "600 26px ui-monospace, Consolas, monospace";
      ctx.fillText(s.title.toUpperCase(), 30, 50, w - 60);
      s.lines.slice(0, 7).forEach((line, i) => {
        const y = 100 + i * 38;
        ctx.fillStyle = "#8a97b4";
        ctx.font = "500 24px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(line.k, 30, y);
        const keyWidth = ctx.measureText(line.k).width;
        ctx.fillStyle = line.tone === "bad" ? "#ff5d73" : line.tone === "warn" ? "#ffd166" : line.tone === "ok" ? "#3ddc97" : "#e8eefb";
        // A long value is set smaller, then cut with an ellipsis: it never runs over its own label.
        const room = w - 60 - keyWidth - 24;
        let value = line.v;
        ctx.font = "600 26px ui-monospace, Consolas, monospace";
        if (ctx.measureText(value).width > room) ctx.font = "600 20px ui-monospace, Consolas, monospace";
        while (value.length > 4 && ctx.measureText(value).width > room) value = value.slice(0, -2).trimEnd() + "…";
        ctx.textAlign = "right";
        ctx.fillText(value, w - 30, y);
        ctx.textAlign = "left";
      });
      ctx.fillStyle = "#8a97b4";
      ctx.font = "400 20px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(s.footer, 30, 362, w - 60);
    });
    if (s.ai) {
      if (s.ai.answer && s.ai.answer !== lastAnswer) {
        lastAnswer = s.ai.answer;
        answeredOnce = true;
        if (inXr && !building) { speak(s.pending ? "Done: waiting for your approval" : "Answer", s.ai.answer, 22, "#3ddc97"); speakingUntil = performance.now() + Math.min(12000, 2500 + s.ai.answer.length * 45); }
      } else if (!s.ai.answer && s.ai.question !== lastQuestion) {
        lastQuestion = s.ai.question;
        if (inXr) speak("Thinking", s.ai.question, 90, "#ffd166");
      }
    }
    if (s.crew && s.crew.at !== lastCrewAt) {
      lastCrewAt = s.crew.at;
      if (inXr && !building) speak(`${s.crew.who} says`, s.crew.text, 14, "#4cc9f0");
    }
    aiPanel.group.visible = Boolean(s.ai) && !palmMode;
    aiLines = [];
    if (s.ai) {
      const ai = s.ai;
      aiPanel.draw((ctx, w) => {
        const fit = (text: string, room: number): string => { let t = text; while (t.length > 4 && ctx.measureText(t).width > room) t = t.slice(0, -2).trimEnd() + "…"; return t; };
        ctx.fillStyle = "#4cc9f0";
        ctx.font = "600 22px ui-monospace, Consolas, monospace";
        ctx.fillText(fit(`YOUR AI · ${ai.thread.toUpperCase()}`, w - 60), 30, 42);
        ctx.fillStyle = "#8a97b4";
        ctx.font = "400 20px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(fit(`You: ${ai.question}`, w - 60), 30, 76);
        ctx.fillStyle = "#e8eefb";
        ctx.font = "400 24px ui-sans-serif, system-ui, sans-serif";
        const text = ai.answer || `… ${ai.state}`;
        const maxLines = 12;
        let current = "";
        for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
          const next = current ? `${current} ${word}` : word;
          if (ctx.measureText(next).width > w - 60 && current) { aiLines.push(current); current = word; } else current = next;
        }
        if (current) aiLines.push(current);
        if (aiLines.length > maxLines) { aiLines = aiLines.slice(0, maxLines); aiLines[maxLines - 1] = fit(`${aiLines[maxLines - 1]} … (the rest is on the web panel)`, w - 60); }
        aiLines.forEach((line, i) => ctx.fillText(line, 30, 116 + i * 29));
        // The last thing that happened to the shared design, so a change is seen where the answer is read.
        ctx.fillStyle = "#ffd166";
        ctx.font = "500 20px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(fit(s.pending ? `Awaiting approval: ${s.pending.summary}` : s.activity, w - 60), 30, 484);
      });
    }
    controlPanel.draw((ctx, w) => {
      ctx.fillStyle = "#4cc9f0";
      ctx.font = "600 24px ui-monospace, Consolas, monospace";
      ctx.fillText("MISSION CONTROL", 30, 44);
      ctx.fillStyle = "#e8eefb";
      ctx.font = "400 19px ui-sans-serif, system-ui, sans-serif";
      // The message is wrapped from its beginning over the lines there are (two when something awaits approval).
      const message = typed ? `> ${typed}▌` : s.activity;
      const maxLines = s.pending ? 2 : 3;
      const wrapped: string[] = [];
      let current = "";
      for (const word of message.split(/\s+/)) {
        const next = current ? `${current} ${word}` : word;
        if (ctx.measureText(next).width > w - 60 && current) { wrapped.push(current); current = word; } else current = next;
      }
      if (current) wrapped.push(current);
      const shown = typed ? wrapped.slice(-maxLines) : wrapped.slice(0, maxLines);
      if (!typed && wrapped.length > maxLines) shown[maxLines - 1] = shown[maxLines - 1]!.replace(/.{2}$/, "…");
      shown.forEach((line, i) => ctx.fillText(line, 30, 240 + i * 23, w - 60));
      if (s.pending) {
        ctx.fillStyle = "#ffd166";
        ctx.fillText(`Awaiting approval: ${s.pending.summary}`, 30, 292, w - 60);
      }
    });
  };

  const buildControlButtons = (): void => {
    controlPanel.button("Orbit view", 0.03, 0.065, 0.17, 0.05, () => setMode("orbit"));
    controlPanel.button("Systems view", 0.21, 0.065, 0.19, 0.05, () => setMode("systems"));
    controlPanel.button("Simulate", 0.41, 0.065, 0.18, 0.05, () => callbacks.onAction({ type: "simulate" }));
    // The typing board takes the place of the sliders while it is up.
    controlPanel.button("Keyboard", 0.03, 0.34, 0.125, 0.05, () => { keyboard.group.visible = !keyboard.group.visible; rack.visible = !keyboard.group.visible; });
    controlPanel.button("Reset view", 0.16, 0.34, 0.135, 0.05, () => resetView());
    controlPanel.button("Approve", 0.30, 0.34, 0.095, 0.05, () => status?.pending?.canApprove && callbacks.onAction({ type: "decide", proposalId: status.pending.proposalId, approve: true }), "#14532d");
    controlPanel.button("Reject", 0.40, 0.34, 0.09, 0.05, () => status?.pending && callbacks.onAction({ type: "decide", proposalId: status.pending.proposalId, approve: false }), "#5a1622");
    controlPanel.button("Exit XR", 0.495, 0.34, 0.095, 0.05, () => world.exitXR());
    // Four quick commands; their labels follow the mission's catalogue.
    for (let i = 0; i < 4; i++) {
      controlPanel.button("…", 0.03 + (i % 2) * 0.285, 0.125 + Math.floor(i / 2) * 0.055, 0.275, 0.048, () => {
        const q = status?.quick[i];
        if (q) callbacks.onAction(q.action);
      }).userData.quick = i;
    }
    const rows = ["1234567890", "qwertyuiop", "asdfghjkl.", "zxcvbnm -"];
    rows.forEach((row, r) => [...row].forEach((ch, c) => keyboard.button(ch === " " ? "␣" : ch, 0.015 + c * 0.052, 0.012 + r * 0.05, 0.048, 0.045, () => { typed += ch; drawStatus(); })));
    keyboard.button("⌫", 0.54, 0.012, 0.105, 0.045, () => { typed = typed.slice(0, -1); drawStatus(); });
    keyboard.button("Clear", 0.54, 0.062, 0.105, 0.045, () => { typed = ""; drawStatus(); });
    keyboard.button("Send", 0.54, 0.112, 0.105, 0.095, () => {
      if (typed.trim()) callbacks.onAction({ type: "request", text: typed.trim() });
      typed = "";
      drawStatus();
    }, "#1d4ed8");
    registerButtons(controlPanel);
    registerButtons(keyboard);
  };
  buildControlButtons();

  // ---------- the AI as a character ----------
  // In the headset the player's AI is a small probe that stays beside them: pinch or touch it and speak; it turns
  // to listen, thinks, answers in a bubble above its head, and flies to a part while it is being built.
  const buddy = new Companion();
  buddy.group.visible = false;
  const buddyEntity = world.createTransformEntity(buddy.group);
  const buddyHit = world.createTransformEntity(buddy.hit, { parent: buddyEntity } as any);
  // A controller's ray can click it; a bare hand pinches it (see handGestures). It is not a touch target: a touch
  // target takes a hand over from the grab, and the probe often hovers right beside a part the player wants to pick up.
  buddyHit.addComponent(IW.Interactable);
  let lastTalkToggle = 0;
  const toggleTalk = (): void => {
    const now = performance.now();
    if (now - lastTalkToggle < 700) return; // a touch and a pinch can land together
    lastTalkToggle = now;
    if (voiceState === "idle") void startVoice(); else if (voiceState === "listening") stopVoice();
  };
  (buddy.hit as unknown as { addEventListener(type: string, cb: () => void): void }).addEventListener("click", toggleTalk);
  const bubble = new Panel(0.84, 0.46);
  bubble.group.scale.setScalar(0.4);
  bubble.group.position.set(0, 0.17, 0);
  bubble.group.visible = false;
  bubble.group.traverse((o) => { o.raycast = () => undefined; });
  buddy.group.add(bubble.group);
  let bubbleLines: string[] = [];
  let bubbleUntil = 0;
  /** Put words above the probe for a while: a short heading in its state colour, then the text. */
  const speak = (heading: string, text: string, seconds: number, tone = "#4cc9f0"): void => {
    bubbleLines = [];
    bubble.draw((ctx, w) => {
      ctx.fillStyle = tone;
      ctx.font = "600 24px ui-monospace, Consolas, monospace";
      ctx.fillText(heading.toUpperCase(), 30, 46, w - 60);
      ctx.fillStyle = "#e8eefb";
      ctx.font = "400 27px ui-sans-serif, system-ui, sans-serif";
      let current = "";
      for (const word of text.replace(/\s+/g, " ").trim().split(" ")) {
        const next = current ? `${current} ${word}` : word;
        if (ctx.measureText(next).width > w - 60 && current) { bubbleLines.push(current); current = word; } else current = next;
      }
      if (current) bubbleLines.push(current);
      if (bubbleLines.length > 9) { bubbleLines = bubbleLines.slice(0, 9); bubbleLines[8] = `${bubbleLines[8]!.slice(0, -3)}…`; }
      bubbleLines.forEach((line, i) => ctx.fillText(line, 30, 92 + i * 36, w - 60));
    });
    bubble.group.visible = true;
    bubbleUntil = performance.now() + seconds * 1000;
  };
  let speakingUntil = 0;
  let building: { id: string; until: number } | null = null;
  let lastAnswer = "";
  let lastQuestion = "";
  let visiting: { id: string; until: number } | null = null; // a part the player picked: the probe goes over to it
  let guide = 0; // how far the probe has walked the player through what they can do here
  let guideAt = 0;
  let turnedOnce = false;
  let lastHint = "";
  let lastCrewAt = 0;
  let answeredOnce = false;
  let toolsOn = false; // bare hands: the flat panels are put away until the right palm asks for them
  let toolsHeld = 0;
  let toolsFist = 0;
  let toolsLatch = false;
  const buddyRest = new THREE.Vector3();
  let buddyPlaced = false;
  const bv = new THREE.Vector3(), bf = new THREE.Vector3(), br = new THREE.Vector3(), bt = new THREE.Vector3();
  const partPosition = (id: string, out: THREE.Vector3): boolean => {
    const o = scene.componentObjects.get(id) ?? scene.freeObjects.get(id);
    if (!o) return false;
    o.getWorldPosition(out);
    return true;
  };
  const onBuilt = (ids: string[]): void => {
    if (!inXr || !ids.length) return;
    // Show it being made: the hardware view, the probe at the new part, its beam on it.
    if (scene.mode !== "systems") setMode("systems");
    building = { id: ids[0]!, until: performance.now() + 6500 };
    const name = String(scene.componentObjects.get(ids[0]!)?.userData.label ?? "the new part");
    speak("Building", `${name}${ids.length > 1 ? ` and ${ids.length - 1} more` : ""}: assembling it on the spacecraft now.`, 7, "#c58bff");
  };
  scene.onBuilt = onBuilt;
  const updateBuddy = (dt: number): void => {
    const now = performance.now();
    const cam = world.camera as THREE.Camera;
    const head = cam.getWorldPosition(bv);
    cam.getWorldDirection(bf);
    bf.y = 0;
    if (bf.lengthSq() < 1e-4) bf.set(0, 0, -1);
    bf.normalize();
    br.crossVectors(bf, UP).normalize();
    if (building && now > building.until) building = null;
    if (visiting && now > visiting.until) visiting = null;
    let target: THREE.Vector3;
    if (!building && visiting && shown && partPosition(visiting.id, bt)) {
      buddy.aim(null);
      target = bt.clone().addScaledVector(UP, 0.12 + 0.08 * tableSize).addScaledVector(br, 0.1).addScaledVector(bf, -0.05);
    } else if (building && shown && partPosition(building.id, bt)) {
      buddy.aim(bt);
      // Beside and above the part, on the player's side of it.
      target = bt.clone().addScaledVector(UP, 0.17 + 0.1 * tableSize).addScaledVector(br, 0.13).addScaledVector(bf, -0.06);
    } else {
      buddy.aim(null);
      if (shown) target = bt.copy(tablePos).addScaledVector(br, 0.3 * tableSize + 0.11).addScaledVector(UP, 0.14 * tableSize + 0.03);
      else {
        // Nothing summoned: it waits low on the right, out of the way of the screen, and drifts along only when left behind.
        bt.copy(head).addScaledVector(bf, 0.5).addScaledVector(br, 0.3).addScaledVector(UP, -0.24);
        if (!buddyPlaced || buddyRest.distanceTo(bt) > 0.4) { buddyRest.copy(bt); buddyPlaced = true; }
        target = buddyRest;
      }
    }
    if (buddy.group.position.lengthSq() === 0) buddy.group.position.copy(target);
    buddy.group.position.lerp(target, 1 - Math.exp(-dt * 3.2));
    const state: CompanionState = voiceState === "listening" ? "listening"
      : building ? "building"
        : voiceState === "sending" || (status?.ai && !status.ai.answer && !/fail|infeasible|cannot|reject|done|complete/i.test(status.ai.state)) ? "thinking"
          : now < speakingUntil ? "speaking" : "idle";
    if (state !== buddy.state) {
      buddy.setState(state);
      if (state === "listening") speak("Listening", "Go on, I am listening. Stop talking and I will take it from there.", 30, "#ff4d6d");
      else if (state === "thinking" && voiceState === "sending") speak("One moment", "Writing down what you said…", 20, "#ffd166");
    }
    // With bare hands the probe walks the player through what can be done here, one step at a time, and only
    // speaks up when nothing else is being said.
    const quiet = voiceState === "idle" && !building && !visiting && now > speakingUntil && !(status?.ai && !status.ai.answer);
    if (palmMode && quiet) {
      if (guide === 0 && !shown) { guide = 1; speak("Hello", "Open your left hand, palm up, and I will bring the mission to it. Close it and everything goes away.", 900); }
      else if (guide <= 1 && shown) { guide = 2; guideAt = now; speak(status?.title ?? "Your mission", `The small craft circling is your spacecraft.${status?.target ? ` The orange mark is ${status.target}, the place this mission is about.` : ""} Pinch the air and drag to turn the world. Touch a place with a fingertip to point it out to your crew.`, 20); }
      else if (guide === 2 && (turnedOnce || now - guideAt > 18000)) { guide = 3; guideAt = now; speak("Ask me", "Pinch me and speak. Try: what is holding this mission back? Or say: systems, to see the hardware.", 22); }
      else if (guide >= 2 && shown && status?.hint && status.hint !== lastHint && now > bubbleUntil + 6000 && now - guideAt > 20000) { lastHint = status.hint; guideAt = now; speak("Hint", status.hint, 20, "#ffd166"); }
      else if (guide === 3 && answeredOnce && now > bubbleUntil) { guide = 4; guideAt = now; speak("Build with me", "Tell me a part to add and I will build it in front of you. In the hardware view, pinch a part to hear what it is connected to. Right palm up brings the controls.", 24); }
    }
    if (bubble.group.visible) {
      if (now > bubbleUntil) bubble.group.visible = false;
      else bubble.group.lookAt(head);
    }
    buddy.update(dt, head);
  };

  // ---------- speaking to the AI ----------
  const VOICE_IDLE = "Speak to your AI";
  let voiceState: "idle" | "listening" | "sending" = "idle";
  let voiceLabel = VOICE_IDLE;
  let recorder: MediaRecorder | null = null;
  let micStream: MediaStream | null = null;
  let micContext: AudioContext | null = null;
  let micWatch: ReturnType<typeof setInterval> | null = null;
  let voiceChunks: Blob[] = [];
  const voiceButton = voicePanel.button(VOICE_IDLE, 0.015, 0.012, 0.59, 0.076, () => { if (voiceState === "idle") void startVoice(); else if (voiceState === "listening") stopVoice(); }, "#1d4ed8");
  registerButtons(voicePanel);
  const setVoice = (state: typeof voiceState, label: string): void => {
    voiceState = state;
    voiceLabel = label;
    (voiceButton.userData.setLabel as (t: string) => void)(label);
  };
  /** The sentence that was heard goes to the player's AI exactly as a typed one does. */
  const ask = (text: string): void => {
    const sentence = text.trim();
    if (!sentence) { speak("Sorry", "I did not catch that. Pinch me and say it again.", 6, "#ff4d6d"); return setVoice("idle", "Nothing heard. Tap and speak"); }
    // "Tell the crew …" is a message to the other players, not a question for the AI.
    const toCrew = sentence.match(/^\W*(?:tell|message|say to)\s+(?:the\s+|my\s+)?(?:crew|team|others|everyone)\s*(?:that\s+|to\s+|[:,]\s*)?(.+)$/i) ?? sentence.match(/^\W*(?:크루|팀|모두)(?:에게|한테)\s*(.+)$/);
    if (toCrew?.[1]) {
      callbacks.onAction({ type: "say", text: toCrew[1].trim() });
      speak("Sent to your crew", toCrew[1].trim(), 8, "#3ddc97");
      return setVoice("idle", VOICE_IDLE);
    }
    // "Systems view" and "orbit view" are for the workspace itself: no question is sent.
    const view = /^\W*(show |open |go to |switch to )?(the )?(systems?|hardware|parts?|시스템|부품)( view| 뷰| 화면)?( 보여\s?줘| 열어\s?줘)?\W*$/i.test(sentence) ? "systems"
      : /^\W*(show |open |go to |switch to )?(the )?(orbit|궤도)( view| 뷰| 화면)?( 보여\s?줘| 열어\s?줘)?\W*$/i.test(sentence) ? "orbit" : null;
    if (view) {
      setMode(view);
      speak("Done", view === "systems" ? "Here is the hardware: every part and the lines between them." : "Here is the orbit: the spacecraft circling, the Sun and the way home.", 6, "#3ddc97");
      return setVoice("idle", VOICE_IDLE);
    }
    callbacks.onAction({ type: "request", text: sentence });
    speak("You said", sentence, 25, "#ffd166");
    setVoice("idle", VOICE_IDLE);
  };
  const releaseMic = (): void => {
    if (micWatch) clearInterval(micWatch);
    micWatch = null;
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    void micContext?.close().catch(() => undefined);
    micContext = null;
  };
  const stopVoice = (): void => {
    if (recorder && recorder.state !== "inactive") recorder.stop(); else { releaseMic(); setVoice("idle", VOICE_IDLE); }
  };
  const startVoice = async (): Promise<void> => {
    if (!callbacks.transcribe || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return setVoice("idle", "Speech is not available here");
    setVoice("sending", "Starting the microphone…");
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch {
      return setVoice("idle", "Microphone not allowed for this site");
    }
    const mime = ["audio/webm;codecs=opus", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t));
    recorder = new MediaRecorder(micStream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
    voiceChunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) voiceChunks.push(e.data); };
    const rec = recorder;
    recorder.onstop = () => {
      releaseMic();
      const audio = new Blob(voiceChunks, { type: rec.mimeType || mime || "audio/webm" });
      voiceChunks = [];
      if (audio.size < 1500) return setVoice("idle", "Nothing heard. Tap and speak");
      setVoice("sending", "Writing down what you said…");
      callbacks.transcribe!(audio).then(ask, (err) => setVoice("idle", String(err instanceof Error ? err.message : "Speech failed").slice(0, 46)));
    };
    recorder.start();
    setVoice("listening", "● Listening… tap to send");
    // It sends by itself once the player has spoken and then been quiet for a moment, or after half a minute.
    try {
      micContext = new AudioContext();
      const analyser = micContext.createAnalyser();
      analyser.fftSize = 1024;
      micContext.createMediaStreamSource(micStream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const began = performance.now();
      let spoke = false;
      let quietSince = 0;
      micWatch = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const v of samples) sum += v * v;
        const loud = Math.sqrt(sum / samples.length) > 0.018;
        const now = performance.now();
        if (loud) { spoke = true; quietSince = 0; } else if (spoke) { quietSince ||= now; if (now - quietSince > 1700) stopVoice(); }
        if (now - began > 30000) stopVoice();
      }, 100);
    } catch { /* without the level meter the player taps to send */ }
  };

  const relabelQuick = (): void => {
    for (const b of controlPanel.buttons) {
      const i = b.mesh.userData.quick as number | undefined;
      if (i === undefined) continue;
      const label = status?.quick[i]?.label ?? "";
      (b.mesh.userData.setLabel as (t: string) => void)(label || "–");
    }
  };

  // ---------- layout: desktop framing vs. the XR mission table ----------
  // The table is turned once, when the session starts, so the lit side of the world faces the player
  // (the Sun over their right shoulder). After that the player walks round it; it does not turn by itself.
  let tableYaw = 0;
  // Where the table is, how it is turned and how large it is. It starts in front of the player; after that
  // hands move it: a pinch and drag turns it any way, two pinches move and resize it, an open left palm carries it.
  const TABLE_HOME = new THREE.Vector3(0, 1.05, -0.55);
  const TABLE_SIZE = 0.85; // 1 = 60 cm across
  const PALM_SIZE = 0.36; // about 22 cm across, small enough to sit on a hand
  const tablePos = TABLE_HOME.clone();
  const tableQuat = new THREE.Quaternion();
  let tableSize = TABLE_SIZE;
  const UP = new THREE.Vector3(0, 1, 0);
  // With bare hands the mission is summoned: the room (and the computer screen in it) stays clear until the
  // player opens their left palm; the mission then rises above it and the room dims, and it goes away again
  // when the hand closes or is laid flat. With controllers everything is simply shown, as before.
  let palmMode = false;
  let shown = true;
  const veil = new THREE.Mesh(new THREE.SphereGeometry(6, 24, 16), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.62, side: THREE.BackSide, depthWrite: false }));
  veil.renderOrder = -50;
  veil.visible = false;
  veil.raycast = () => undefined;
  (world.scene as THREE.Scene).add(veil);
  const applyShown = (): void => {
    ui.visible = inXr && shown && (!palmMode || toolsOn);
    aiPanel.group.visible = Boolean(status?.ai) && !palmMode;
    buddy.group.visible = inXr;
    scene.root.visible = !inXr || shown;
    veil.visible = inXr && shown && palmMode && xrMode === "ar";
  };
  /** Stand the panels around the player as they are now (the table is placed separately). */
  const placeRig = (): number => {
    const head = (world.camera as THREE.Camera).getWorldPosition(new THREE.Vector3());
    const facing = (world.camera as THREE.Camera).getWorldDirection(new THREE.Vector3());
    const yaw = inXr && Math.hypot(facing.x, facing.z) > 0.2 ? Math.atan2(-facing.x, -facing.z) : 0;
    ui.scale.setScalar(1);
    ui.position.set(inXr ? head.x : 0, 0, inXr ? head.z : 0);
    ui.rotation.set(0, yaw, 0);
    ui.updateMatrixWorld(true);
    return yaw;
  };
  /** Bare hands: stand the panels around the hologram, a little beyond it as the player sees it, and smaller. */
  const placeTools = (): void => {
    const head = (world.camera as THREE.Camera).getWorldPosition(new THREE.Vector3());
    const to = new THREE.Vector3(tablePos.x - head.x, 0, tablePos.z - head.z);
    if (to.lengthSq() < 1e-4) (world.camera as THREE.Camera).getWorldDirection(to).setY(0);
    to.normalize();
    const k = 0.72;
    ui.scale.setScalar(k);
    ui.rotation.set(0, Math.atan2(-to.x, -to.z), 0);
    // In the rig the side panels stand at z = -0.5 and y = 1.28: put that 14 cm beyond the hologram and a hand above it.
    ui.position.set(tablePos.x + to.x * (0.14 - 0.5 * k), tablePos.y + 0.1 - 1.28 * k, tablePos.z + to.z * (0.14 - 0.5 * k));
    ui.updateMatrixWorld(true);
  };
  const setShown = (on: boolean): void => {
    if (on === shown) return;
    shown = on;
    if (on) {
      const yaw = placeRig();
      tableQuat.setFromAxisAngle(UP, yaw + tableYaw);
      layout();
    } else {
      onPalm = false;
      gesture = null;
      if (voiceState === "listening") stopVoice();
    }
    applyShown();
  };
  /** Put the panels and the table back in front of the player, wherever they stand and face now. */
  const resetView = (): void => {
    const yaw = placeRig();
    tablePos.copy(TABLE_HOME).applyMatrix4(ui.matrixWorld);
    tableQuat.setFromAxisAngle(UP, yaw + tableYaw);
    tableSize = TABLE_SIZE;
    onPalm = false;
    gesture = null;
    layout();
  };
  const layout = (): void => {
    if (inXr) {
      scene.root.scale.setScalar((0.3 / scene.extent) * tableSize);
      scene.root.position.copy(tablePos);
      scene.root.quaternion.copy(tableQuat);
    } else {
      scene.root.scale.setScalar(1);
      scene.root.position.set(0, 0, 0);
      scene.root.quaternion.identity();
      const d = scene.extent * 2.7;
      world.camera.position.setLength(d);
      controls.target.set(0, 0, 0);
      controls.minDistance = scene.extent * 0.8;
      controls.maxDistance = scene.extent * 12;
    }
  };
  const setMode = (mode: ViewMode): void => {
    scene.setMode(mode);
    layout();
  };

  // ---------- desktop selection ----------
  const raycaster = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  const canvas = world.renderer.domElement;
  let dragTurn: { x: number } | null = null;
  const aim = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), world.camera);
  };
  const onDown = (e: PointerEvent): void => {
    down = { x: e.clientX, y: e.clientY };
    if (inXr || e.button !== 0) return;
    aim(e);
    // On the planet: this drag turns the world (and the clock). Off it: the camera moves, as before.
    if (scene.planetHit(raycaster)) {
      dragTurn = { x: e.clientX };
      controls.enabled = false;
      scene.clockRate = 0;
      canvas.style.cursor = "grabbing";
      try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    }
  };
  // Where this player's mouse is: over a place on the world (everyone sees their mark follow it) or over a part
  // (everyone sees that part ringed in their colour). The mark goes two seconds after the mouse leaves.
  let hoverAt = 0;
  let hoverPart: string | null = null;
  let pinnedUntil = 0;
  const hover = (): void => {
    const now = performance.now();
    if (scene.mode === "orbit") {
      const place = now < pinnedUntil ? null : scene.globePointFromRay(raycaster);
      if (place) {
        // Here: at once, every move. To the crew: ten times a second.
        const who = callbacks.me?.() ?? { name: "You", color: "#4cc9f0" };
        scene.setPing("self", place, who.color, who.name);
        ownPoint = place;
        ownPointAt = now;
        if (pointClear) clearTimeout(pointClear);
        pointClear = setTimeout(() => pointAt(null), 2200);
        if (now - hoverAt > 95) { hoverAt = now; callbacks.collab()?.presence({ point: place }, true); }
      }
    } else if (scene.mode === "systems") {
      if (now - hoverAt < 110) return;
      hoverAt = now;
      const id = scene.pick(raycaster)?.componentId ?? null;
      if (id !== hoverPart) { hoverPart = id; callbacks.collab()?.presence({ focus: id ? `spacecraft.components.${id}` : null }, true); }
    }
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragTurn) {
      if (!inXr && e.buttons === 0) { aim(e); canvas.style.cursor = scene.planetHit(raycaster) ? "grab" : ""; hover(); }
      return;
    }
    // A drag across a third of the view is one radian of turn.
    scene.turnBy(((e.clientX - dragTurn.x) / Math.max(1, canvas.clientWidth)) * 3);
    dragTurn.x = e.clientX;
    shareClock(true);
  };
  const endTurn = (e: PointerEvent): void => {
    if (!dragTurn) return;
    dragTurn = null;
    controls.enabled = !inXr;
    canvas.style.cursor = "";
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    shareClock(false, true);
  };
  const onUp = (e: PointerEvent): void => {
    if (inXr || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), world.camera);
    const hit = scene.pick(raycaster);
    callbacks.onSelect(hit?.componentId ?? null);
    callbacks.collab()?.presence({ focus: hit ? `spacecraft.components.${hit.componentId}` : null }, true);
  };
  // ---------- pointing a place out to the crew ----------
  // A double-click on the world (desktop) or a fingertip held at its surface (headset) marks that place, with the
  // player's name, in every crew member's scene: "look here". The mark fades by itself.
  let ownPoint: number[] | null = null;
  let ownPointAt = 0;
  let pointClear: ReturnType<typeof setTimeout> | null = null;
  const pointAt = (point: number[] | null, holdMs = 0): void => {
    if (pointClear) { clearTimeout(pointClear); pointClear = null; }
    if (!point && !ownPoint) return;
    ownPoint = point;
    ownPointAt = performance.now();
    const who = callbacks.me?.() ?? { name: "You", color: "#4cc9f0" };
    scene.setPing("self", point, who.color, who.name);
    callbacks.collab()?.presence({ point }, true);
    if (point && holdMs) pointClear = setTimeout(() => pointAt(null), holdMs);
  };
  const onDouble = (e: MouseEvent): void => {
    if (inXr) return;
    aim(e as PointerEvent);
    const place = scene.globePointFromRay(raycaster);
    if (place) { pinnedUntil = performance.now() + 15000; pointAt(place, 15000); }
  };
  canvas.addEventListener("dblclick", onDouble);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", endTurn);
  canvas.addEventListener("pointercancel", endTurn);
  canvas.addEventListener("pointerup", onUp);

  // ---------- grab handling and per-frame work ----------
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const poseInMission = (object: THREE.Object3D | undefined): number[] | null => {
    if (!object) return null;
    object.getWorldPosition(tmpV);
    scene.root.worldToLocal(tmpV);
    object.getWorldQuaternion(tmpQ).premultiply(scene.root.getWorldQuaternion(new THREE.Quaternion()).invert());
    return [tmpV.x, tmpV.y, tmpV.z, tmpQ.x, tmpQ.y, tmpQ.z, tmpQ.w];
  };

  const onGrab = (entity: any): void => {
    if (entity === timeRingEntity) {
      ringHeld = true;
      ringYaw = handleAngle();
      scene.clockRate = 0;
      return;
    }
    const collab = callbacks.collab();
    const slider = grabTargets.get(entity);
    if (slider) {
      grabbing.set(entity, slider);
      void collab?.lock(slider.slider.path, true).then((granted) => {
        if (!granted) callbacks.notify("A teammate is adjusting this parameter.", "warn");
      });
      collab?.presence({ focus: slider.slider.path }, true);
      return;
    }
    const id = [...componentEntities].find(([, e]) => e === entity)?.[0];
    if (!id) return;
    grabbing.set(entity, { kind: "component", id });
    scene.setHeld(id, true);
    void collab?.lock(`scene.nodes.node_${id}`, true);
    collab?.presence({ focus: `spacecraft.components.${id}` }, true);
    callbacks.onSelect(id);
  };

  const onRelease = (entity: any): void => {
    if (entity === timeRingEntity) {
      ringHeld = false;
      timeRing.position.set(0, 0, 0);
      timeRing.scale.setScalar(1);
      shareClock(false, true);
      return;
    }
    const g = grabbing.get(entity);
    grabbing.delete(entity);
    const collab = callbacks.collab();
    const config = scene.mission?.config;
    if (!g || !collab || !config) return;
    collab.presence({ focus: null }, true);
    if (g.kind === "slider") {
      const s = g.slider;
      const value = s.min + (Math.min(s.length, Math.max(0, s.knob.position.x)) / s.length) * (s.max - s.min);
      void collab.lock(s.path, false);
      if (!callbacks.canEdit()) return placeSliders();
      void collab.edit(s.patch(value, config).map((p) => ({ op: "set" as const, ...p })), `${s.title.toLowerCase()} → ${s.format(value)} (XR)`).then((r) => {
        if (!r.ok) {
          callbacks.notify(r.detail ?? "The change was not accepted.", "warn");
          placeSliders();
        }
      });
      return;
    }
    // A component was placed: the new position becomes part of the shared configuration.
    const object = scene.componentObjects.get(g.id);
    scene.setHeld(g.id, false);
    void collab.lock(`scene.nodes.node_${g.id}`, false);
    if (!object || !callbacks.canEdit()) return;
    const p = object.position;
    const position = [p.x, p.y, p.z].map((v) => Math.round(v * 1000) / 1000);
    const node = config.scene.nodes.find((n: any) => n.componentId === g.id);
    const patches = node
      ? [{ op: "set" as const, path: `scene.nodes.${node.id}.position`, value: position }]
      : [{ op: "append" as const, path: "scene.nodes", value: { id: `node_${g.id}`, name: object.userData.label ?? g.id, componentId: g.id, position } }];
    void collab.edit(patches, `Placed ${object.userData.label ?? g.id} (XR)`).then((r) => {
      if (!r.ok) callbacks.notify(r.detail ?? "The placement was not accepted.", "warn");
    });
  };

  // ---------- bare hands ----------
  // The hands are read from the session each frame: where each is, whether it pinches, whether its palm is up.
  interface HandState { kind: "hand" | "controller" | "none"; present: boolean; pinch: boolean; palmUp: number; open: boolean; fist: boolean; gap: number; point: THREE.Vector3; palm: THREE.Vector3; tip: THREE.Vector3 }
  const SIDES = ["left", "right"] as const;
  const mkHand = (): HandState => ({ kind: "none", present: false, pinch: false, palmUp: -1, open: false, fist: false, gap: 1, point: new THREE.Vector3(), palm: new THREE.Vector3(), tip: new THREE.Vector3() });
  const hands: Record<"left" | "right", HandState> = { left: mkHand(), right: mkHand() };
  const rayOn: Record<"left" | "right", boolean> = { left: true, right: true };
  const ja = new THREE.Vector3(), jb = new THREE.Vector3(), jn = new THREE.Vector3();
  const readHands = (): void => {
    for (const side of SIDES) hands[side].present = false;
    const xr = renderer.xr as unknown as { getSession(): any; getFrame(): any; getReferenceSpace(): any };
    const session = xr.getSession(), xf = xr.getFrame(), ref = xr.getReferenceSpace();
    if (!session || !xf || !ref) return;
    const origin = ((world as any).player as THREE.Object3D | undefined)?.matrixWorld;
    for (const src of session.inputSources as Iterable<any>) {
      const side = src.handedness as "left" | "right";
      if (side !== "left" && side !== "right") continue;
      const h = hands[side];
      if (src.hand && typeof xf.getJointPose === "function") {
        h.kind = "hand";
        const joint = (name: string, out: THREE.Vector3): boolean => {
          const j = src.hand.get(name);
          const p = j ? xf.getJointPose(j, ref) : null;
          if (!p) return false;
          out.set(p.transform.position.x, p.transform.position.y, p.transform.position.z);
          if (origin) out.applyMatrix4(origin);
          return true;
        };
        const wrist = new THREE.Vector3(), thumb = new THREE.Vector3(), index = new THREE.Vector3(), indexBase = new THREE.Vector3(), pinkyBase = new THREE.Vector3(), middleBase = new THREE.Vector3(), middleTip = new THREE.Vector3();
        if (!joint("wrist", wrist) || !joint("thumb-tip", thumb) || !joint("index-finger-tip", index) || !joint("index-finger-phalanx-proximal", indexBase) || !joint("pinky-finger-phalanx-proximal", pinkyBase) || !joint("middle-finger-phalanx-proximal", middleBase)) { h.pinch = false; continue; }
        h.present = true;
        h.point.addVectors(thumb, index).multiplyScalar(0.5);
        h.tip.copy(index);
        const gap = thumb.distanceTo(index);
        // A pinch is fingertips together: it starts under 1.5 cm and ends as soon as they are 2.8 cm apart. (A relaxed
        // hand rests with the tips 3–4 cm apart; at a 4 cm release the pinch never ended and the world kept turning.)
        h.gap = gap;
        // The headset's own pinch (the one its menus use) decides, and the fingertips must really be together as well:
        // fingertip distance alone took a relaxed, moving hand for a pinch.
        let system: boolean | null = null;
        try { const st = (world as any).input.xr.getSelectState(side); if (st && typeof st.active === "boolean") system = st.active; } catch { /* not available */ }
        h.pinch = system !== null ? system && gap < 0.03 : (h.pinch ? gap < 0.028 : gap < 0.015);
        // The palm faces along the normal of the wrist–index–pinky triangle (mirrored between the two hands).
        ja.subVectors(indexBase, wrist);
        jb.subVectors(pinkyBase, wrist);
        if (side === "left") jn.crossVectors(jb, ja); else jn.crossVectors(ja, jb);
        h.palmUp = jn.lengthSq() > 1e-10 ? jn.normalize().y : -1;
        h.palm.addVectors(wrist, middleBase).multiplyScalar(0.5);
        // Open or closed, relative to this hand's own size: fingertip far beyond the knuckle, or curled back to the palm.
        const knuckle = middleBase.distanceTo(wrist);
        const reachOut = joint("middle-finger-tip", middleTip) && knuckle > 0.03 ? middleTip.distanceTo(wrist) / knuckle : 2;
        h.open = reachOut > 1.5;
        h.fist = reachOut < 1.22;
      } else {
        h.kind = "controller";
        const p = xf.getPose(src.gripSpace ?? src.targetRaySpace, ref);
        if (!p) { h.pinch = false; continue; }
        h.present = true;
        h.point.set(p.transform.position.x, p.transform.position.y, p.transform.position.z);
        if (origin) h.point.applyMatrix4(origin);
        h.pinch = Boolean(src.gamepad?.buttons?.[0]?.pressed);
        h.palmUp = -1;
        h.open = false;
        h.fist = false;
      }
    }
    // A bare hand casts no far ray. The ray follows the arm, so it swept over the panels and lit their buttons
    // whenever the player merely turned or rested their hands. A hand touches and pinches; a controller keeps its ray.
    for (const side of SIDES) {
      const want = hands[side].kind !== "hand";
      if (want === rayOn[side]) continue;
      rayOn[side] = want;
      try { (world as any).input.xr.multiPointers[side].toggleSubPointer("ray", want); } catch { /* the pointer is not there yet */ }
    }
  };
  /** Is this hand already doing something the interaction system owns (near a part, a knob, the ring or a button)? */
  const handBusy = (side: "left" | "right"): boolean => {
    try { return Boolean((world as any).input.xr.multiPointers[side].getActiveKind()); } catch { return false; }
  };
  /** The part whose body is nearest the point, if the point is on or right beside it. */
  const pv = new THREE.Vector3();
  const partNear = (point: THREE.Vector3): string | null => {
    const reach = Math.max(0.03, 0.42 * scene.root.scale.x);
    let best: string | null = null;
    let bestD = reach;
    for (const [id, object] of scene.componentObjects) {
      const d = object.getWorldPosition(pv).distanceTo(point);
      if (d < bestD) { best = id; bestD = d; }
    }
    return best;
  };
  let gesture: { kind: "turn"; side: "left" | "right"; last: THREE.Vector3 } | { kind: "both"; left: THREE.Vector3; right: THREE.Vector3 } | null = null;
  let onPalm = false;
  let palmHeld = 0;
  let palmLost = 0;
  let dismissHeld = 0;
  let pointHeld = 0;
  const wasPinching: Record<"left" | "right", boolean> = { left: false, right: false };
  const armed: Record<"left" | "right", boolean> = { left: false, right: false };
  const gv = new THREE.Vector3(), gd = new THREE.Vector3(), gaxis = new THREE.Vector3(), gq = new THREE.Quaternion();
  const g0 = new THREE.Vector3(), g1 = new THREE.Vector3(), gm0 = new THREE.Vector3(), gm1 = new THREE.Vector3();
  const handGestures = (dt: number): void => {
    readHands();
    const held = ringHeld || grabbing.size > 0;
    // Bare hands switch the session to "summoned" (hidden until asked for); controllers switch it back.
    const bare = hands.left.kind === "hand" || hands.right.kind === "hand";
    if (bare && !palmMode) { palmMode = true; shown = true; setShown(false); }
    if (!bare && palmMode && (hands.left.present || hands.right.present)) { palmMode = false; setShown(true); applyShown(); }
    veil.position.copy((world.camera as THREE.Camera).getWorldPosition(g0));
    // A pinch belongs to the table only if it began in empty air: not on a part, a knob, the ring or a button.
    for (const side of SIDES) {
      const h = hands[side];
      const pinching = h.present && h.pinch;
      if (pinching && !wasPinching[side]) {
        // A pinch on the probe is "talk to me", not a pinch on the table.
        if (h.point.distanceTo(buddy.group.position) < 0.1) { toggleTalk(); armed[side] = false; }
        else {
          const picked = shown && scene.mode === "systems" ? partNear(h.point) : null;
          if (picked) {
            // A pinch on a part picks it: its lines and what it lacks are said aloud, without opening any panel.
            armed[side] = false;
            callbacks.onSelect(picked);
            callbacks.collab()?.presence({ focus: `spacecraft.components.${picked}` }, true);
            visiting = { id: picked, until: performance.now() + 9000 };
            const name = String(scene.componentObjects.get(picked)?.userData.label ?? "This part");
            setTimeout(() => { if (inXr && visiting?.id === picked) speak(name, (status?.activity ?? "").replace(new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`), "") || "No details yet.", 12, "#4cc9f0"); }, 450);
          } else armed[side] = !held && !handBusy(side) && shown && h.point.distanceTo(tablePos) < 0.3 * tableSize + 0.16;
        }
      }
      if (!pinching) armed[side] = false;
      wasPinching[side] = pinching;
    }
    const L = armed.left, R = armed.right;
    if (held) gesture = null;
    else if (L && R) {
      if (gesture?.kind !== "both") gesture = { kind: "both", left: hands.left.point.clone(), right: hands.right.point.clone() };
      // Two pinches hold the table like an object: pull apart to enlarge, move together to carry, twist to turn.
      g0.subVectors(gesture.right, gesture.left);
      g1.subVectors(hands.right.point, hands.left.point);
      gm0.addVectors(gesture.left, gesture.right).multiplyScalar(0.5);
      gm1.addVectors(hands.left.point, hands.right.point).multiplyScalar(0.5);
      if (g0.length() > 0.03 && g1.length() > 0.03) {
        const ratio = g1.length() / g0.length();
        const next = Math.min(2.6, Math.max(0.25, tableSize * ratio));
        const applied = next / tableSize;
        tableSize = next;
        gq.setFromUnitVectors(g0.clone().normalize(), g1.clone().normalize());
        // Turn and resize about the point between the hands, then follow it.
        tablePos.sub(gm0).applyQuaternion(gq).multiplyScalar(applied).add(gm1);
        tableQuat.premultiply(gq);
      }
      gesture.left.copy(hands.left.point);
      gesture.right.copy(hands.right.point);
      onPalm = false;
      layout();
    } else if (L || R) {
      const side = L ? "left" : "right";
      if (gesture?.kind !== "turn" || gesture.side !== side) gesture = { kind: "turn", side, last: hands[side].point.clone() };
      // One pinch drags the near face of the world the way the hand moves: up, down, sideways, any way.
      gd.subVectors(hands[side].point, gesture.last);
      gv.subVectors(tablePos, (world.camera as THREE.Camera).getWorldPosition(g0));
      if (gd.lengthSq() > 1e-9 && gv.lengthSq() > 1e-6) {
        gv.normalize();
        gaxis.crossVectors(gd, gv);
        const reach = Math.max(0.16, 0.2 * tableSize); // 16 cm of hand travel is one radian, whatever the size
        if (gaxis.lengthSq() > 1e-12) {
          const angle = gaxis.length() / reach;
          tableQuat.premultiply(gq.setFromAxisAngle(gaxis.normalize(), angle));
          layout();
        }
      }
      gesture.last.copy(hands[side].point);
      turnedOnce = true;
    } else gesture = null;

    // An open left palm turned up carries the world: it settles above the hand, small, and stays where the hand leaves it.
    const lh = hands.left;
    const offering = lh.kind === "hand" && lh.present && !lh.pinch && lh.open && lh.palmUp > (onPalm ? 0.45 : 0.72) && !held && gesture?.kind !== "both";
    if (offering) { palmHeld += dt; palmLost = 0; } else { palmLost += dt; if (palmLost > 0.35) palmHeld = 0; }
    if (!onPalm && palmHeld > 0.45) {
      onPalm = true;
      if (palmMode && !shown) {
        // Summoned: it appears above the palm at once, at hand size.
        tableSize = PALM_SIZE;
        tablePos.copy(lh.palm).addScaledVector(UP, 0.07 + 0.3 * tableSize);
        setShown(true);
        if (toolsOn) placeTools();
      }
    }
    // A fingertip held at the world's surface points that place out to the crew; the mark follows the finger and
    // stays a few seconds after it leaves.
    let touching: number[] | null = null;
    if (shown && scene.mode === "orbit" && !held && gesture === null) {
      for (const side of SIDES) {
        const h = hands[side];
        if (h.kind !== "hand" || !h.present || h.pinch || h.fist) continue;
        touching = scene.globePointNear(h.tip);
        if (touching) break;
      }
    }
    pointHeld = touching ? pointHeld + dt : 0;
    const nowP = performance.now();
    if (touching && pointHeld > 0.25 && (!ownPoint || nowP - ownPointAt > 160) && (!ownPoint || Math.abs(ownPoint[0]! - touching[0]!) + Math.abs(ownPoint[1]! - touching[1]!) > 0.6)) pointAt(touching);
    else if (touching && ownPoint) ownPointAt = nowP;
    else if (!touching && ownPoint && !pointClear && inXr && nowP - ownPointAt > 5000) pointAt(null);
    // The flat panels (numbers, buttons, sliders) are tools: an open right palm turned up brings them out or puts them away.
    const rh = hands.right;
    const asking = palmMode && shown && rh.kind === "hand" && rh.present && !rh.pinch && rh.open && rh.palmUp > 0.72 && !held;
    toolsHeld = asking ? toolsHeld + dt : 0;
    if (!asking) toolsLatch = false;
    if (toolsHeld > 0.55 && !toolsLatch) { toolsLatch = true; toolsOn = !toolsOn; if (toolsOn) placeTools(); applyShown(); }
    const putAway = palmMode && toolsOn && rh.kind === "hand" && rh.present && !rh.pinch && rh.fist && !held;
    toolsFist = putAway ? toolsFist + dt : 0;
    if (toolsFist > 0.3) { toolsFist = 0; toolsOn = false; applyShown(); }
    // Sent away: the left hand closes over it (a fist, palm still up) or is laid flat, palm down, for a moment.
    const gone = lh.kind !== "hand" || !lh.present;
    const closing = palmMode && shown && !held && gesture?.kind !== "both" && (gone || (!lh.pinch && (lh.fist || (lh.open && lh.palmUp < -0.75))));
    dismissHeld = closing ? dismissHeld + dt : 0;
    if (dismissHeld > (gone ? 0.7 : 0.3)) { dismissHeld = 0; palmHeld = 0; setShown(false); }
    if (onPalm && palmLost > 0.35) onPalm = false;
    if (onPalm && offering) {
      const k = 1 - Math.exp(-dt * 10);
      tableSize += (PALM_SIZE - tableSize) * k;
      g1.copy(lh.palm).addScaledVector(UP, 0.07 + 0.3 * tableSize);
      tablePos.lerp(g1, k);
      layout();
    }
  };

  let sliderClock = 0;
  let presenceClock = 0;
  let introT = 1;
  let introFrom = 0;
  let introTo = 0;
  let introAngle = 0;
  let following = false;
  let fromEarth = false;
  const homeward = new THREE.Vector3();
  const craftNow = new THREE.Vector3();
  const craftDelta = new THREE.Vector3();
  // Frame-rate governor: if the desktop cannot hold ~40 fps, shed resolution, then effects, then shadows.
  let slowFrames = 0;
  let sampled = 0;
  let sampledTime = 0;
  let shedLevel = 0;
  const govern = (dt: number): void => {
    if (inXr || slowGpu || introT < 1) return;
    sampled++;
    sampledTime += dt;
    if (sampled < 90) return;
    slowFrames = sampledTime / sampled > 1 / 40 ? slowFrames + 1 : 0;
    sampled = 0;
    sampledTime = 0;
    if (slowFrames < 2 || shedLevel >= 3) return;
    slowFrames = 0;
    shedLevel++;
    if (shedLevel === 1) renderer.setPixelRatio(1);
    else if (shedLevel === 2) fxOn = false;
    else {
      renderer.shadowMap.enabled = false;
      scene.setShadows(false);
    }
  };
  let updateCount = 0;
  const frame = (dt: number): void => {
    if (disposed) return;
    updateCount++;
    scene.update(dt);
    // Name tags step out of one another's way on a screen and in the headset alike (there, as seen from the head).
    scene.declutterLabels(world.camera as THREE.Camera);
    sky.update(dt, renderer.getPixelRatio());
    if (!inXr) {
      if (introT < 1) {
        // Arc in from far behind and above, easing out; the user takes over when it lands.
        introT = Math.min(1, introT + dt / 4.2);
        const k = 1 - Math.pow(1 - introT, 4);
        const distance = introFrom + (introTo - introFrom) * k;
        const swing = (1 - k) * 1.9;
        world.camera.position.set(Math.sin(introAngle + swing) * distance * 0.86, distance * (0.3 + 0.35 * (1 - k)), Math.cos(introAngle + swing) * distance * 0.86);
        world.camera.lookAt(0, 0, 0);
        if (introT >= 1) controls.enabled = true;
        return;
      }
      if (fromEarth && scene.mode === "orbit" && scene.earthDirection(homeward)) {
        // Stand on the line to Earth: the planet shows the phase it has from home, and it changes as time is turned.
        const distance = Math.max(3.2, world.camera.position.distanceTo(controls.target));
        world.camera.position.copy(controls.target).addScaledVector(homeward, distance);
      }
      if (following && scene.mode === "orbit") {
        // Carry the camera along with the spacecraft so the user's own orbiting stays relative to it.
        scene.craftPosition(craftNow);
        craftDelta.subVectors(craftNow, controls.target);
        world.camera.position.add(craftDelta);
        controls.target.copy(craftNow);
      }
      controls.update();
      govern(dt);
      return;
    }
    handGestures(dt);
    updateBuddy(dt);
    // The sliders are alive: the ring turns, the glow breathes, and a knob in the hand grows and brightens.
    sliderClock += dt;
    for (const s of sliders) {
      const heldNow = [...grabbing.values()].some((g) => g.kind === "slider" && g.slider === s);
      if (s.ring) s.ring.rotation.z += dt * (heldNow ? 6 : 1.2);
      const want = heldNow ? 1.45 : 1;
      s.knob.scale.setScalar(s.knob.scale.x + (want - s.knob.scale.x) * (1 - Math.exp(-dt * 12)));
      if (s.glow) (s.glow.material as THREE.SpriteMaterial).opacity = heldNow ? 0.95 : 0.42 + 0.14 * Math.sin(sliderClock * 2.4 + s.group.position.y * 40);
    }
    if (ringHeld) {
      // The hand carries the handle; the ring stays on the equator and follows it around. That angle is the turn.
      const yaw = handleAngle();
      let delta = yaw - ringYaw;
      if (delta > Math.PI) delta -= Math.PI * 2;
      if (delta < -Math.PI) delta += Math.PI * 2;
      ringYaw = yaw;
      scene.turnBy(delta);
      timeRing.position.set(0, 0, 0);
      timeRing.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      timeRing.scale.setScalar(1);
      shareClock(true);
    }
    for (const g of grabbing.values()) {
      if (g.kind === "slider") {
        // Keep the knob on its track whatever the hand does, and show the value it would commit.
        const k = g.slider.knob.position;
        k.set(Math.min(g.slider.length, Math.max(0, k.x)), 0, 0);
        g.slider.knob.quaternion.identity();
        g.slider.fill?.scale.set(Math.max(0.001, k.x), 1, 1);
        labelSlider(g.slider, g.slider.min + (k.x / g.slider.length) * (g.slider.max - g.slider.min));
      } else {
        const object = scene.componentObjects.get(g.id);
        if (object) callbacks.collab()?.transform(`node_${g.id}`, [object.position.x, object.position.y, object.position.z, object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w]);
      }
    }
    presenceClock += dt;
    if (presenceClock > 0.1) {
      presenceClock = 0;
      const spaces = world.playerSpaceEntities;
      callbacks.collab()?.presence({ mode: "xr", head: poseInMission(world.camera), hands: { left: poseInMission(spaces?.gripSpaces.left.object3D), right: poseInMission(spaces?.gripSpaces.right.object3D) } });
    }
  };

  class WorkspaceSystem extends IW.createSystem({ grabbed: { required: [IW.Grabbed] } }) {
    override init(): void {
      this.queries.grabbed!.subscribe("qualify", onGrab);
      this.queries.grabbed!.subscribe("disqualify", onRelease);
    }
    override update(delta: number): void {
      frame(delta);
    }
  }
  world.registerSystem(WorkspaceSystem);

  // ---------- XR session lifecycle ----------
  const sessionChanged = (): void => {
    const active = Boolean(world.session);
    if (active === inXr) return;
    inXr = active;
    if (!active) xrMode = null;
    // In passthrough the real room is the backdrop: no starfield, transparent clear.
    sky.object.visible = !active || xrMode === "vr";
    // The table-top scene is scaled, which the shadow camera does not follow.
    scene.setShadows(!active && shadows && shedLevel < 3);
    if (active) {
      following = false;
      scene.setCloseUp(false);
      tableYaw = 0.75 - scene.sunHeading();
      ui.position.set(0, 0, 0);
      ui.rotation.set(0, 0, 0);
      ui.scale.setScalar(1);
      tablePos.copy(TABLE_HOME);
      tableQuat.setFromAxisAngle(UP, tableYaw);
      tableSize = TABLE_SIZE;
      onPalm = false;
      gesture = null;
      rack.visible = !keyboard.group.visible;
    }
    palmMode = false;
    shown = true;
    toolsOn = false;
    guide = 0;
    turnedOnce = false;
    visiting = null;
    buddyPlaced = false;
    buddy.group.position.set(0, 0, 0);
    bubble.group.visible = false;
    scene.setTableTop(active);
    world.scene.background = active && xrMode === "ar" ? null : backdrop;
    applyShown();
    timeRing.visible = active;
    controls.enabled = !active;
    layout();
    syncComponentEntities();
    placeSliders();
    drawStatus();
    callbacks.collab()?.presence({ mode: active ? "xr" : "desktop", head: null, hands: { left: null, right: null }, focus: null }, true);
    callbacks.onXrChange(active, xrMode);
  };
  const sessionWatch = setInterval(sessionChanged, 250);

  layout();
  return {
    scene,
    support,
    get inXr() { return inXr; },
    setMode,
    enterXr(mode) {
      if (mode === "ar" ? !support.immersiveAr : !support.immersiveVr) return callbacks.notify(support.reason ?? "This device cannot start that kind of XR session.", "warn");
      xrMode = mode;
      const launch = (): void => { world.launchXR({ sessionMode: mode === "ar" ? IW.SessionMode.ImmersiveAR : IW.SessionMode.ImmersiveVR }); };
      // The browser's microphone prompt cannot be answered inside a session, so it is asked for first (once, on a real headset).
      const permissions = (navigator as Navigator & { permissions?: { query(d: { name: string }): Promise<{ state: string }> } }).permissions;
      if (support.emulated || !callbacks.transcribe || !navigator.mediaDevices?.getUserMedia || !permissions) return launch();
      void permissions.query({ name: "microphone" }).then((p) => p.state, () => "granted").then(async (state) => {
        if (state !== "prompt") return launch();
        await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((t) => t.stop()), () => undefined);
        // Answering the prompt may have used up the click that a session needs.
        if ((navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === false) callbacks.notify("Press Enter MR once more to start.", "info");
        else launch();
      });
    },
    exitXr() { world.exitXR(); },
    setSpatialStatus(next) {
      status = next;
      relabelQuick();
      if (inXr) drawStatus();
    },
    refresh() {
      if (introT >= 1) layout();
      placeSliders();
    },
    async ready(timeoutMs = 7000) {
      // With post-processing the scene draws into an HDR target, so its programs are compiled for that; otherwise for the screen.
      post?.hold(true);
      const compile = post ? post.fx.warm() : (compileAsyncOf(renderer)?.(world.scene as THREE.Scene, world.camera as THREE.Camera) ?? Promise.resolve());
      await Promise.race([Promise.allSettled([scene.planetReady, compile]), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
      if (post && !inXr) {
        // One draw with everything visible, then a normal one in the same task: only the second reaches the screen.
        try {
          scene.prime(true);
          post.fx.render(0);
        } finally {
          scene.prime(false);
        }
        post.fx.render(0);
      }
      post?.hold(false);
    },
    viewFromEarth(on) {
      if (inXr) return;
      fromEarth = on;
      scene.showEarthMarker(!on);
      if (on) {
        following = false;
        scene.setCloseUp(false);
        controls.target.set(0, 0, 0);
      }
    },
    follow(on) {
      if (inXr) return;
      if (on) fromEarth = false;
      following = on;
      scene.setCloseUp(on);
      if (on) {
        scene.craftPosition(craftNow);
        const sun = scene.sunDirection;
        const out = craftNow.clone().normalize();
        // Sun over the shoulder, slightly outside the orbit, so the hardware is lit and the planet fills the background.
        const offset = sun.clone().multiplyScalar(0.4).addScaledVector(out, 0.24).add(new THREE.Vector3(0, 0.08, 0));
        world.camera.position.copy(craftNow).add(offset);
        controls.target.copy(craftNow);
        controls.minDistance = 0.12;
        controls.maxDistance = 6;
      } else {
        layout();
      }
    },
    intro(animate = true) {
      if (inXr) return;
      layout();
      introTo = world.camera.position.length();
      introFrom = introTo * 5.5;
      // Arrive on the day side: 35° off the Sun line, so the terminator and relief are in view.
      const sun = scene.sunDirection;
      introAngle = Math.atan2(sun.x, sun.z) + 0.6;
      if (!animate) {
        world.camera.position.set(Math.sin(introAngle) * introTo * 0.86, introTo * 0.3, Math.cos(introAngle) * introTo * 0.86);
        world.camera.lookAt(0, 0, 0);
        return;
      }
      introT = 0;
      controls.enabled = false;
    },
    debug: {
      camera: () => world.camera.position.toArray(),
      // How many frames were drawn (renderer.info) and how many workspace updates ran over a period: is the session alive?
      frames: (ms: number) => new Promise((resolve) => {
        const r0 = renderer.info.render.frame;
        const u0 = updateCount;
        setTimeout(() => resolve({ renders: renderer.info.render.frame - r0, updates: updateCount - u0, presenting: renderer.xr.isPresenting, visibility: String((world.session as unknown as { visibilityState?: string } | null)?.visibilityState ?? "no session") }), ms);
      }),
      // What the canvas holds right after a frame is drawn (in a session: the headset's view). For visual checks.
      capture: () => new Promise<string>((resolve) => {
        // (see frames() below for whether frames are drawn at all)
      // Read the framebuffer straight after the renderer draws into it (the session's layer while in XR).
        const current = renderer.render;
        let last: Uint8Array | null = null;
        let size = [0, 0];
        renderer.render = function (this: THREE.WebGLRenderer, ...args: Parameters<THREE.WebGLRenderer["render"]>) {
          current.apply(this, args);
          const gl = renderer.getContext();
          const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const first = last === null;
          last = px; size = [w, h];
          if (first) setTimeout(() => {
            renderer.render = current;
            const [cw, ch] = size as [number, number];
            const out = document.createElement("canvas");
            out.width = cw; out.height = ch;
            const ctx = out.getContext("2d")!;
            const img = ctx.createImageData(cw, ch);
            for (let y = 0; y < ch; y++) img.data.set(last!.subarray((ch - 1 - y) * cw * 4, (ch - y) * cw * 4), y * cw * 4);
            for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
            ctx.putImageData(img, 0, 0);
            resolve(out.toDataURL("image/jpeg", 0.9));
          }, 0);
        } as THREE.WebGLRenderer["render"];
      }),
      // The labels on the headset's four quick-command buttons, and a press of one (the same handler the controller ray calls).
      quick: () => (status?.quick ?? []).map((q) => q.label),
      status: () => (status?.lines ?? []).map((l) => ({ k: l.k, v: l.v })),
      activity: () => status?.activity ?? "",
      // Press buttons of the spatial keyboard by their caption (the same handlers a controller ray calls), and read what has been typed.
      pressKeys: (captions: string[]) => { let n = 0; for (const c of captions) { const b = [...keyboard.buttons, ...controlPanel.buttons].find((x) => x.mesh.userData.caption === c); if (b) { b.onClick(); n++; } } return n; },
      typed: () => typed,
      // What the AI panel shows: whether it is up, and the reply as wrapped on it.
      ai: () => ({ visible: aiPanel.group.visible && ui.visible, lines: [...aiLines] }),
      pressQuick: (i: number) => { const b = controlPanel.buttons.find((x) => x.mesh.userData.quick === i); if (!b) return false; b.onClick(); return true; },
      knob: (id) => { const k = sliders.find((x) => x.id === id)?.knob; return k ? k.getWorldPosition(new THREE.Vector3()).toArray() : null; },
      component: (id) => scene.componentObjects.get(id)?.getWorldPosition(new THREE.Vector3()).toArray() ?? null,
      grabbing: () => grabbing.size + (ringHeld ? 1 : 0),
      timeRing: () => (timeRing.visible ? [...ringGrip.getWorldPosition(new THREE.Vector3()).toArray(), ...scene.orbitView.getWorldPosition(new THREE.Vector3()).toArray()] : null),
      turn: (angle) => { scene.clockRate = 0; scene.turnBy(angle); shareClock(false, true); },
      uiVisible: () => ui.visible && ui.parent !== null,
      // What the session reports about each hand, and where the table is: for checks on a real headset.
      inputs: () => SIDES.map((side) => ({ hand: side, kind: hands[side].kind, present: hands[side].present, pinch: hands[side].pinch, palmUp: Math.round(hands[side].palmUp * 100) / 100, open: hands[side].open, fist: hands[side].fist, gap: Math.round(hands[side].gap * 1000) / 1000, ray: rayOn[side], point: hands[side].point.toArray().map((v) => Math.round(v * 1000) / 1000) })),
      table: () => ({ position: scene.root.position.toArray().map((v) => Math.round(v * 1000) / 1000), quaternion: scene.root.quaternion.toArray().map((v) => Math.round(v * 1000) / 1000), size: Math.round(tableSize * 1000) / 1000, onPalm, gesture: gesture?.kind ?? "none", shown, palmMode }),
      summon: (on: boolean) => { setShown(on); },
      // The probe: is it there, what is it doing, where is it, and what does its bubble say.
      companion: () => ({ visible: buddy.group.visible, state: buddy.state, position: buddy.group.position.toArray().map((v) => Math.round(v * 1000) / 1000), bubble: bubble.group.visible ? [...bubbleLines] : [], tools: toolsOn }),
      built: (ids: string[]) => onBuilt(ids),
      resetView: () => resetView(),
      // The Speak button's state, and a sentence as if it had just been heard (the step after speech-to-text).
      voice: () => ({ state: voiceState, label: voiceLabel }),
      say: (text: string) => ask(text),
    },
    dispose() {
      disposed = true;
      clearInterval(sessionWatch);
      canvas.removeEventListener("dblclick", onDouble);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", endTurn);
      canvas.removeEventListener("pointercancel", endTurn);
      canvas.removeEventListener("pointerup", onUp);
      controls.dispose();
      post?.restore();
      environment?.dispose();
      releaseMic();
      buddy.dispose();
      try { world.exitXR(); } catch { /* no session */ }
      scene.dispose();
      world.destroy();
    },
  };
}
