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
import { gradeRenderer, interceptRender, softwareGl } from "../scene/fx";
import { createEnvironment, createLabel, createSky, forceQuality } from "../scene/space";

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
  onAction(action: { type: "simulate" } | { type: "request"; text: string } | { type: "catalog"; itemId: string } | { type: "decide"; proposalId: string; approve: boolean }): void;
  notify(message: string, tone?: "info" | "warn" | "bad"): void;
}

export interface SpatialStatus {
  title: string;
  lines: { k: string; v: string; tone?: "ok" | "warn" | "bad" }[];
  footer: string;
  quick: { label: string; action: Parameters<WorkspaceCallbacks["onAction"]>[0] }[];
  pending: { proposalId: string; summary: string; canApprove: boolean } | null;
  activity: string;
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
  /** Frame the sunlit side; with `animate`, fly the camera in from deep space first (desktop only). */
  intro(animate?: boolean): void;
  /** World-space positions of interactive objects, for automated checks with the XR emulator. */
  debug: { knob(id: string): number[] | null; component(id: string): number[] | null; grabbing(): number; uiVisible(): boolean };
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
      ctx.fillText(label, canvas.width / 2, canvas.height / 2, canvas.width - 20);
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
    this.group.add(mesh);
    this.buttons.push({ mesh, onClick });
    return mesh;
  }
}

interface Slider { id: string; path: string; group: THREE.Group; knob: THREE.Mesh; length: number; min: number; max: number; read(config: any): number; patch(value: number, config: any): { path: string; value: unknown }[]; format(value: number): string; label: THREE.Sprite | null; title: string }

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
  const scene = new MissionScene();
  const sky = createSky();
  const backdrop = new THREE.Color(0x000000);
  world.scene.add(sky.object);
  world.scene.background = backdrop;
  const renderer = world.renderer as THREE.WebGLRenderer;
  gradeRenderer(renderer);
  let environment: THREE.Texture | null = null;
  try {
    environment = createEnvironment(renderer);
  } catch {
    environment = null; // image-based lighting is an enhancement; direct light still works
  }
  scene.attach(world.scene as THREE.Scene, environment);
  // Bloom and film grade on the desktop; `?fx=0` turns them off (slow or software GPUs).
  const fxOff = typeof location !== "undefined" && new URLSearchParams(location.search).get("fx") === "0";
  const post = fxOff || slowGpu ? null : interceptRender(renderer, world.scene as THREE.Scene, world.camera as THREE.Camera, () => !inXr);
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

  // ---------- spatial sliders (orbit altitude, inclination, mission day) ----------
  const sliders: Slider[] = [];
  const rack = new THREE.Group();
  rack.position.set(-0.3, 0.78, -0.42);
  rack.rotation.x = -Math.PI / 5;
  ui.add(rack);
  const rackEntity = world.createTransformEntity(rack, { parent: uiEntity } as any);
  const addSlider = (spec: Omit<Slider, "group" | "knob" | "label" | "length">, row: number): void => {
    const length = 0.6;
    const group = new THREE.Group();
    group.position.set(0, -row * 0.085, 0);
    const track = new THREE.Mesh(new THREE.BoxGeometry(length, 0.008, 0.008), new THREE.MeshBasicMaterial({ color: 0x35507f }));
    track.position.x = length / 2;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.022, 20, 14), new THREE.MeshStandardMaterial({ color: 0x4cc9f0, emissive: 0x1b6f8a, roughness: 0.3 }));
    group.add(track, knob);
    rack.add(group);
    const slider: Slider = { ...spec, group, knob, length, label: null };
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
      labelSlider(s, value);
    }
  };
  const labelSlider = (s: Slider, value: number): void => {
    if (s.label) {
      s.group.remove(s.label);
      (s.label.material as THREE.SpriteMaterial).map?.dispose();
      s.label.material.dispose();
    }
    s.label = createLabel(`${s.title}  ${s.format(value)}`, { height: 0.032 });
    s.label.position.set(s.length / 2, 0.036, 0);
    s.group.add(s.label);
  };

  // ---------- spatial panels ----------
  const statusPanel = new Panel(0.62, 0.42);
  statusPanel.group.position.set(-0.62, 1.42, -0.95);
  statusPanel.group.rotation.y = Math.PI / 7;
  const controlPanel = new Panel(0.62, 0.42);
  controlPanel.group.position.set(0.62, 1.42, -0.95);
  controlPanel.group.rotation.y = -Math.PI / 7;
  const keyboard = new Panel(0.66, 0.26);
  keyboard.group.position.set(0.42, 0.86, -0.5);
  keyboard.group.rotation.x = -Math.PI / 4;
  keyboard.group.visible = false;
  ui.add(statusPanel.group, controlPanel.group, keyboard.group);

  const registerButtons = (panel: Panel): void => {
    const panelEntity = world.createTransformEntity(panel.group, { parent: uiEntity } as any);
    for (const b of panel.buttons) {
      if (b.mesh.userData.entity) continue;
      const entity = world.createTransformEntity(b.mesh, { parent: panelEntity } as any);
      entity.addComponent(IW.Interactable);
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
      ctx.fillText(s.title.toUpperCase().slice(0, 34), 30, 50);
      s.lines.slice(0, 7).forEach((line, i) => {
        const y = 100 + i * 38;
        ctx.fillStyle = "#8a97b4";
        ctx.font = "500 24px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(line.k, 30, y);
        ctx.fillStyle = line.tone === "bad" ? "#ff5d73" : line.tone === "warn" ? "#ffd166" : line.tone === "ok" ? "#3ddc97" : "#e8eefb";
        ctx.font = "600 26px ui-monospace, Consolas, monospace";
        ctx.textAlign = "right";
        ctx.fillText(line.v, w - 30, y);
        ctx.textAlign = "left";
      });
      ctx.fillStyle = "#8a97b4";
      ctx.font = "400 20px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText(s.footer.slice(0, 60), 30, 362);
    });
    controlPanel.draw((ctx, w) => {
      ctx.fillStyle = "#4cc9f0";
      ctx.font = "600 24px ui-monospace, Consolas, monospace";
      ctx.fillText("MISSION CONTROL", 30, 44);
      ctx.fillStyle = "#e8eefb";
      ctx.font = "400 21px ui-sans-serif, system-ui, sans-serif";
      ctx.fillText((typed ? `> ${typed}▌` : s.activity).slice(-54), 30, 252, w - 60);
      if (s.pending) {
        ctx.fillStyle = "#ffd166";
        ctx.fillText(`Awaiting approval: ${s.pending.summary}`.slice(0, 54), 30, 290, w - 60);
      }
    });
  };

  const buildControlButtons = (): void => {
    controlPanel.button("Orbit view", 0.03, 0.065, 0.17, 0.05, () => setMode("orbit"));
    controlPanel.button("Systems view", 0.21, 0.065, 0.19, 0.05, () => setMode("systems"));
    controlPanel.button("Simulate", 0.41, 0.065, 0.18, 0.05, () => callbacks.onAction({ type: "simulate" }));
    controlPanel.button("Keyboard", 0.03, 0.34, 0.17, 0.05, () => { keyboard.group.visible = !keyboard.group.visible; });
    controlPanel.button("Approve", 0.21, 0.34, 0.12, 0.05, () => status?.pending?.canApprove && callbacks.onAction({ type: "decide", proposalId: status.pending.proposalId, approve: true }), "#14532d");
    controlPanel.button("Reject", 0.34, 0.34, 0.12, 0.05, () => status?.pending && callbacks.onAction({ type: "decide", proposalId: status.pending.proposalId, approve: false }), "#5a1622");
    controlPanel.button("Exit XR", 0.47, 0.34, 0.12, 0.05, () => world.exitXR());
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

  const relabelQuick = (): void => {
    for (const b of controlPanel.buttons) {
      const i = b.mesh.userData.quick as number | undefined;
      if (i === undefined) continue;
      const label = status?.quick[i]?.label ?? "";
      if (b.mesh.userData.label === label) continue;
      b.mesh.userData.label = label;
      const material = b.mesh.material as THREE.MeshBasicMaterial;
      const canvas = material.map!.image as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#16284d";
      ctx.beginPath();
      ctx.roundRect(2, 2, canvas.width - 4, canvas.height - 4, 14);
      ctx.fill();
      ctx.strokeStyle = "rgba(76, 201, 240, 0.8)";
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = "#e8eefb";
      ctx.font = "600 19px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, canvas.width / 2, canvas.height / 2, canvas.width - 16);
      material.map!.needsUpdate = true;
    }
  };

  // ---------- layout: desktop framing vs. the XR mission table ----------
  const layout = (): void => {
    if (inXr) {
      // The whole view fits on a table about 60 cm across, at chest height, an arm's length away.
      const scale = 0.3 / scene.extent;
      scene.root.scale.setScalar(scale);
      scene.root.position.set(0, 1.12, -0.75);
    } else {
      scene.root.scale.setScalar(1);
      scene.root.position.set(0, 0, 0);
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
  const onDown = (e: PointerEvent): void => { down = { x: e.clientX, y: e.clientY }; };
  const onUp = (e: PointerEvent): void => {
    if (inXr || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), world.camera);
    const hit = scene.pick(raycaster);
    callbacks.onSelect(hit?.componentId ?? null);
    callbacks.collab()?.presence({ focus: hit ? `spacecraft.components.${hit.componentId}` : null }, true);
  };
  canvas.addEventListener("pointerdown", onDown);
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

  let presenceClock = 0;
  let introT = 1;
  let introFrom = 0;
  let introTo = 0;
  let introAngle = 0;
  const frame = (dt: number): void => {
    if (disposed) return;
    scene.update(dt);
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
      controls.update();
      return;
    }
    for (const g of grabbing.values()) {
      if (g.kind === "slider") {
        // Keep the knob on its track whatever the hand does, and show the value it would commit.
        const k = g.slider.knob.position;
        k.set(Math.min(g.slider.length, Math.max(0, k.x)), 0, 0);
        g.slider.knob.quaternion.identity();
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
    world.scene.background = active && xrMode === "ar" ? null : backdrop;
    ui.visible = active;
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
      world.launchXR({ sessionMode: mode === "ar" ? IW.SessionMode.ImmersiveAR : IW.SessionMode.ImmersiveVR });
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
      knob: (id) => { const k = sliders.find((x) => x.id === id)?.knob; return k ? k.getWorldPosition(new THREE.Vector3()).toArray() : null; },
      component: (id) => scene.componentObjects.get(id)?.getWorldPosition(new THREE.Vector3()).toArray() ?? null,
      grabbing: () => grabbing.size,
      uiVisible: () => ui.visible && ui.parent !== null,
    },
    dispose() {
      disposed = true;
      clearInterval(sessionWatch);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      controls.dispose();
      post?.restore();
      environment?.dispose();
      try { world.exitXR(); } catch { /* no session */ }
      scene.dispose();
      world.destroy();
    },
  };
}
