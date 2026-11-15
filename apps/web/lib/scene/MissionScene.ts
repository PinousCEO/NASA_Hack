/**
 * The mission as a 3D scene, built entirely from authoritative mission state
 * (configuration + derived results). Used unchanged by the desktop view and the WebXR
 * workspace: the host decides where `root` sits and how it is scaled.
 *
 *  orbit view    planet (1 unit = body radius) textured from NASA data, the orbit as a glowing
 *                ribbon with its eclipsed stretch, the planet's shadow, trajectory overlays,
 *                the spacecraft (enlarged — a real one would be sub-pixel), the Sun
 *  systems view  the bus and every component as flight-hardware models (1 unit = 1 m, parts
 *                normalised to a readable size) with animated power and data flows
 *
 * Everything in `root` is expressed in the mission frame, so participant poses and object
 * transforms can be shared between people whose rooms have different origins.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { MissionVersion, Presence } from "../api";
import { CORE_ORIGIN } from "../api";
import { bake, buildBus, buildComponent, buildRover, buildSpacecraft, type SpacecraftModel } from "./models";
import { SiteModel, type SiteKind } from "./site";
import { Companion } from "./companion";
import { type BodyId, createFlowLine, createFlowTube, createLabel, createPlanet, createSun, disposeObject, onGlobe, type Planet, toView } from "./space";
import { type Sky, skyAt, SPIN_PERIOD_S } from "./ephemeris";

export type ViewMode = "orbit" | "systems" | "site";
export const BODY_RADIUS_KM: Record<BodyId, number> = { earth: 6378.137, moon: 1737.4, mars: 3396.19 };
const OBLIQUITY = (23.43928 * Math.PI) / 180;
const ECLIPTIC_POLE = new THREE.Vector3(0, Math.cos(OBLIQUITY), Math.sin(OBLIQUITY));
const COLOR = { orbit: 0x35e0d0, power: 0xffb020, charge: 0x4be38a, load: 0xff6a2a, data: 0x35e0d0, gmat: 0xffc24a, j2: 0xc58bff };
const X_AXIS = new THREE.Vector3(1, 0, 0);

type FlowLine = ReturnType<typeof createFlowLine>;
type FlowTube = ReturnType<typeof createFlowTube>;
interface Connector { line: FlowLine; from: THREE.Object3D; to: THREE.Object3D; lift: number }
const ease = (t: number): number => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

export class MissionScene {
  readonly root = new THREE.Group();
  readonly orbitView = new THREE.Group();
  readonly systemsView = new THREE.Group();
  /** The place the mission looks at, on its own: the ground under the spacecraft's instruments (see site.ts). */
  readonly siteView = new THREE.Group();
  /** Component id → its object in the systems view (pickable / grabbable). */
  readonly componentObjects = new Map<string, THREE.Object3D>();
  /** Scene-node id → generated asset placed in the systems view (text-to-3D results). */
  readonly freeObjects = new Map<string, THREE.Object3D>();
  readonly sunLight = new THREE.DirectionalLight(0xfff4e6, 2.5);
  mode: ViewMode = "orbit";
  mission: MissionVersion | null = null;
  /** Called when the set of component objects is rebuilt (hosts re-attach interactions). */
  onRebuild: (() => void) | null = null;
  /** GLB assets fetched and shown so far. */
  loadedAssets = 0;
  /** Called with the ids of parts (or generated objects) that were not in the design a moment ago: they are being built. */
  onBuilt: ((ids: string[]) => void) | null = null;
  /** Places crew members are pointing at, by who points ("self" is the local player). They sit on the globe and turn with it. */
  private pings = new Map<string, THREE.Group>();
  /** The place this mission is about, as a model beside the world (see site.ts), and the lines that tie it to the world and the spacecraft. */
  private site: SiteModel | null = null;
  private siteStamp = "";
  private readonly sight = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: new THREE.Color(0.5, 2.4, 2.8), transparent: true, opacity: 0.9, depthWrite: false }));
  private readonly leader = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 8 }, () => new THREE.Vector3())), new THREE.LineBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.6, depthWrite: false }));
  private viewer: THREE.Camera | null = null;
  /** Is the place in the spacecraft's line of sight right now (as drawn)? */
  observing = false;
  /** The AI crewmates, as probes in the scene: each flies to what it is working on, with its name over it. */
  private crew = new Map<string, { probe: Companion; holder: THREE.Group; tag: THREE.Sprite; focus: string | null; point: number[] | null; spoke: number; slot: number }>();
  private known: Set<string> | null = null;
  private born = new Map<string, number>();

  private planet: Planet | null = null;
  private body: BodyId | null = null;
  private orbitTube: FlowTube | null = null;
  private overlays: FlowTube[] = [];
  private orbitPath: THREE.Vector3[] = [];
  private craft = new THREE.Group();
  private craftModel: SpacecraftModel | null = null;
  private craftSignature = "";
  /** The instant the scene shows (ms since the Unix epoch) and how fast it runs (simulated seconds per second). */
  clockMs = 0;
  clockRate = 0;
  /** One orbit in forty seconds: the pace at which the spacecraft is easy to follow. */
  orbitPace = 150;
  private clockStarted = false;
  private baseMs = 0;
  private periodS = 7000;
  private phase0 = 0;
  private sky: Sky | null = null;
  private earthMarker: THREE.Group | null = null;
  private orbitSignature = "";
  private siteSignature = "";
  private craftBeacon: THREE.Sprite | null = null;
  private craftPhase = 0;
  private deploy = 0;
  private burn = 0;
  private lastSma: number | null = null;
  private shock: THREE.Mesh;
  private shockAge = 9;
  private umbra: THREE.Mesh;
  private sunBase = new THREE.Vector3(1, 0, 0);
  private sunLocal = new THREE.Vector3(1, 0, 0);
  private sun = createSun();
  private siteMarker: THREE.Group | null = null;
  private bus = new THREE.Group();
  private stage = new THREE.Group();
  private connectors: Connector[] = [];
  /** How many lines are drawn in the systems view (one per real line in the design). */
  get lineCount(): number { return this.connectors.length; }
  private leds: THREE.Mesh[] = [];
  private avatars = new Map<string, THREE.Group>();
  private rings = new Map<string, THREE.Mesh>();
  private held = new Set<string>();
  private loader = new GLTFLoader();
  private cache = new Map<string, Promise<THREE.Object3D>>();
  private host: THREE.Scene | null = null;
  private flash = 0;
  private time = 0;
  private signature = "";
  private closeUp = false;

  constructor() {
    this.root.name = "mission-root";
    // The environment map carries most of the fill; this keeps night-side hardware legible.
    this.root.add(this.orbitView, this.systemsView, this.sunLight, new THREE.HemisphereLight(0x9fb2dc, 0x2a2018, 0.5));
    this.systemsView.visible = false;
    this.orbitView.add(this.craft, this.sun);
    this.root.add(this.sunLight.target);
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.bias = -0.0004;
    if (CORE_ORIGIN) this.loader.setWithCredentials(true);

    // Recalculation shockwave: a ring that expands from the spacecraft when new results land.
    this.shock = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 3.2, 3), transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.shock.visible = false;
    this.orbitView.add(this.shock);

    // The planet's shadow, drawn as a faint cylinder so eclipses are visible as geometry.
    const umbraMaterial = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(0x4f6f9c) } },
      vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV; varying float vAlong;
        void main(){ vAlong = uv.y; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */ `precision highp float; varying vec3 vN; varying vec3 vV; varying float vAlong; uniform vec3 uColor;
        void main(){ float edge = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2); float fade = smoothstep(0.0, 0.06, vAlong) * (1.0 - smoothstep(0.25, 1.0, vAlong));
          gl_FragColor = vec4(uColor * edge * fade * 0.16, edge * fade * 0.16);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    this.umbra = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 5, 64, 1, true), umbraMaterial);
    this.umbra.name = "umbra";
    this.orbitView.add(this.umbra);

    // Systems-view turntable: concentric rings and radial ticks.
    const ringPoints: number[] = [];
    for (const [radius, segments] of [[0.55, 96], [1.25, 128], [1.8, 160]] as const) {
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2, b = ((i + 1) / segments) * Math.PI * 2;
        ringPoints.push(Math.cos(a) * radius, 0, Math.sin(a) * radius, Math.cos(b) * radius, 0, Math.sin(b) * radius);
      }
    }
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2, inner = i % 6 === 0 ? 1.66 : 1.74;
      ringPoints.push(Math.cos(a) * inner, 0, Math.sin(a) * inner, Math.cos(a) * 1.8, 0, Math.sin(a) * 1.8);
    }
    const ringGeometry = new THREE.BufferGeometry();
    ringGeometry.setAttribute("position", new THREE.Float32BufferAttribute(ringPoints, 3));
    this.stage.add(new THREE.LineSegments(ringGeometry, new THREE.LineBasicMaterial({ color: 0xece7dd, transparent: true, opacity: 0.2 })));
    this.stage.add(new THREE.Mesh(new THREE.CircleGeometry(1.8, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0c0c0e, transparent: true, opacity: 0.42, depthWrite: false })));
    this.stage.position.y = -0.62;
  }

  /** Give the scene its host so image-based lighting can follow the Sun. */
  attach(host: THREE.Scene, environment: THREE.Texture | null): void {
    this.host = host;
    if (environment) {
      host.environment = environment;
      host.environmentIntensity = 1.25;
    }
  }

  /** Sun shadows on the hardware (off in XR, where the scene is scaled to a table). */
  setShadows(on: boolean): void {
    this.sunLight.castShadow = on;
  }

  /** Resolves when NASA imagery for the current body is on screen (false: procedural fallback). */
  get planetReady(): Promise<boolean> {
    return this.planet?.ready ?? Promise.resolve(false);
  }

  // ---------- mission state ----------
  setMission(mission: MissionVersion): void {
    this.mission = mission;
    const config = mission.config;
    const body = config.centralBody as BodyId;
    if (body !== this.body) {
      if (this.planet) {
        this.orbitView.remove(this.planet.group);
        this.planet.dispose();
      }
      this.planet = createPlanet(body);
      this.orbitView.add(this.planet.group);
      this.body = body;
      if (this.earthMarker) { this.orbitView.remove(this.earthMarker); disposeObject(this.earthMarker); this.earthMarker = null; }
      if (body !== "earth") {
        // Where home is: the direction to Earth at the moment shown.
        const marker = new THREE.Group();
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 20, 14), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.9, 2.2) }));
        const tag = createLabel("EARTH", { height: 0.12, color: "#6fb6ff", sub: "direction home" });
        tag.position.y = 0.16;
        marker.add(dot, tag);
        this.earthMarker = marker;
        this.orbitView.add(marker);
      }
      this.siteMarker = null;
      this.siteSignature = "";
      this.orbitSignature = "";
    }
    const lighting = mission.derived["scene.lighting"]?.value;
    if (lighting?.sunDirection) this.sunBase.copy(toView(lighting.sunDirection)).normalize();
    this.sunLocal.copy(this.sunBase);
    // A change of orbit size is shown as a burn.
    const sma = config.orbit.semiMajorAxisKm as number;
    if (this.lastSma !== null && Math.abs(sma - this.lastSma) > 1e-6) this.burn = 1;
    this.lastSma = sma;
    // The clock starts at the mission date and runs at orbit pace; after that it is the crew's to turn.
    this.baseMs = Date.parse(config.missionTime);
    const period = Number(mission.derived["orbit.elements"]?.value?.periodS);
    if (Number.isFinite(period) && period > 0) this.periodS = period;
    this.orbitPace = this.periodS / 40;
    if (!this.clockStarted) {
      this.clockStarted = true;
      this.clockMs = this.baseMs;
      this.clockRate = 0;
    }
    this.rebuildOrbit();
    this.rebuildCraft();
    this.rebuildSite();
    // The systems view is rebuilt only when components or their placement change.
    const signature = JSON.stringify([config.spacecraft.busDryMassKg, config.spacecraft.components.map((c: any) => [c.id, c.type, c.areaM2, c.diameterM, c.capacityWh, c.apertureM, c.kind, c.name]), config.scene.nodes, config.assets.map((a: any) => a.id), (config.systems?.links ?? []).map((l: any) => [l.id, l.kind, l.from.node, l.to.node])]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.rebuildSystems();
    } else {
      this.refreshLabels();
    }
  }

  private rebuildOrbit(): void {
    const mission = this.mission!;
    const R = BODY_RADIUS_KM[this.body!];
    const traj = mission.derived["orbit.trajectory"]?.value;
    // Rebuilt only when something drawn here changed: the orbit, the date, the overlays or the numbers on the tag.
    const elements = mission.derived["orbit.elements"]?.value;
    const eclipse = mission.derived["orbit.eclipse"]?.value;
    const signature = JSON.stringify([this.body, mission.config.orbit, mission.config.missionTime, (mission.config.scene.trajectories ?? []).map((t: any) => t.id), elements?.periapsisAltitudeKm, elements?.periodS, eclipse?.betaDeg, eclipse?.eclipseFraction, Boolean(traj?.pathKm)]);
    if (signature === this.orbitSignature) return;
    this.orbitSignature = signature;
    for (const o of [this.orbitTube, ...this.overlays, ...this.orbitView.children.filter((c) => c.userData.transient)]) {
      if (!o) continue;
      this.orbitView.remove(o);
      disposeObject(o, true);
    }
    this.orbitTube = null;
    this.overlays = [];
    if (!traj?.pathKm) return;
    this.orbitPath = (traj.pathKm as number[][]).map((p) => toView(p.map((v) => v / R)));
    const closed = this.orbitPath[0]!.distanceTo(this.orbitPath[this.orbitPath.length - 1]!) < 0.05;
    this.orbitTube = createFlowTube(closed ? this.orbitPath.slice(0, -1) : this.orbitPath, COLOR.orbit, { closed, radius: 0.0055, dashes: 30, speed: 0.5, trail: true, shadow: true });
    this.orbitTube.material.uniforms.uSunLocal!.value.copy(this.sunLocal);
    this.orbitView.add(this.orbitTube);
    const current = toView((traj.currentPositionKm as number[]).map((v) => v / R));
    this.craftPhase = this.orbitPath.reduce((best, p, i) => (p.distanceToSquared(current) < this.orbitPath[best]!.distanceToSquared(current) ? i : best), 0) / this.orbitPath.length;
    this.phase0 = this.craftPhase; // where the spacecraft is at the mission date

    // Trajectory overlays: imported from GMAT or propagated with J2.
    for (const overlay of (mission.config.scene.trajectories ?? []) as { name: string; source: string; pointsKm: number[][] }[]) {
      const points = overlay.pointsKm.map((p) => toView(p.map((v) => v / R)));
      const tube = createFlowTube(points, overlay.source === "gmat_report" ? COLOR.gmat : COLOR.j2, { radius: 0.0026, dashes: Math.max(20, points.length / 6), speed: 0.9, opacity: 0.7, halo: false });
      this.orbitView.add(tube);
      this.overlays.push(tube);
      const tag = createLabel(overlay.name.toUpperCase(), { height: 0.11, color: overlay.source === "gmat_report" ? "#ffc24a" : "#c58bff", sub: overlay.source === "gmat_report" ? "imported · GMAT report" : "computed · J2 propagation" });
      tag.position.copy(points[Math.floor(points.length * 0.33)]!).multiplyScalar(1.12);
      tag.userData.transient = true;
      this.orbitView.add(tag);
    }

    const el = mission.derived["orbit.elements"]?.value;
    const ecl = mission.derived["orbit.eclipse"]?.value;
    if (el) {
      const tag = createLabel(`${el.periapsisAltitudeKm.toFixed(0)} KM · ${(el.periodS / 60).toFixed(0)} MIN`, { height: 0.15, color: "#35e0d0", sub: ecl ? `β ${ecl.betaDeg.toFixed(0)}° · eclipse ${(ecl.eclipseFraction * 100).toFixed(0)}%` : undefined });
      tag.position.copy(this.orbitPath[Math.floor(this.orbitPath.length * 0.12)]!).multiplyScalar(1.3);
      tag.userData.transient = true;
      this.orbitView.add(tag);
    }
  }

  /** The spacecraft in orbit: the real design, enlarged so it can be seen at planetary scale. */
  private rebuildCraft(): void {
    const spacecraft = this.mission!.config.spacecraft;
    const signature = JSON.stringify([spacecraft.name, spacecraft.busDryMassKg, spacecraft.components.map((c: any) => [c.type, c.areaM2, c.diameterM, c.apertureM, c.kind])]);
    if (signature === this.craftSignature) return;
    this.craftSignature = signature;
    disposeObject(this.craft);
    this.craft.clear();
    const model = buildSpacecraft(spacecraft);
    model.group.scale.setScalar(0.15 / model.radius);
    this.craftModel = model;
    this.deploy = 0;
    const name = createLabel(spacecraft.name.toUpperCase(), { height: 0.13, color: "#f2efe8", sub: "enlarged · 1 lap shown in 40 s" });
    name.position.y = 0.3;
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(1.6, 1.9, 2.0), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.raycast = () => undefined; // decoration: never a pointer target (and a sprite cannot be hit by a headset's ray)
    halo.scale.setScalar(0.36);
    halo.name = "beacon";
    name.name = "craft-label";
    this.craftBeacon = halo;
    this.craft.add(model.group, halo, name);
    this.applyCloseUp();
  }

  /** Landing-site marker riding on the globe at the rover's true coordinates. */
  private rebuildSite(): void {
    const rover = this.mission!.config.rover;
    const signature = JSON.stringify([this.body, rover ? [rover.name, rover.site, rover.wheelCount, rover.wheelRadiusM, rover.supportHalfSpanM] : null, Boolean(this.planet)]);
    if (signature === this.siteSignature && (this.siteMarker || !rover)) return;
    this.siteSignature = signature;
    if (this.siteMarker) {
      this.siteMarker.parent?.remove(this.siteMarker);
      disposeObject(this.siteMarker, true);
      this.siteMarker = null;
    }
    if (!rover || !this.planet) return;
    const marker = new THREE.Group();
    const up = typeof rover.site.latDeg === "number" && typeof rover.site.lonDeg === "number" ? onGlobe(rover.site.latDeg, rover.site.lonDeg) : new THREE.Vector3(0, -1, 0);
    marker.position.copy(up);
    marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    const model = buildRover(rover);
    model.scale.setScalar(0.03 / Math.max(0.2, rover.supportHalfSpanM * 2.3));
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.3, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.6, 0.3), transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    beam.position.y = 0.15;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.036, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.6, 0.3), transparent: true, opacity: 0.9, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.name = "site-ring";
    ring.position.y = 0.004;
    const tag = createLabel(rover.name.toUpperCase(), { height: 0.12, color: "#ffb020", sub: `${rover.site.name} · ${rover.site.slopeDeg}° slope` });
    tag.position.y = 0.4;
    marker.add(model, beam, ring, tag);
    this.planet.globe.add(marker);
    this.siteMarker = marker;
  }

  private asset(uri: string): Promise<THREE.Object3D> {
    let pending = this.cache.get(uri);
    if (!pending) {
      pending = this.loader.loadAsync(`${CORE_ORIGIN}${uri}`).then((gltf) => gltf.scene);
      this.cache.set(uri, pending);
    }
    return pending.then((scene) => scene.clone(true));
  }

  /** A part's label says first whether its lines let it work: red when a line is missing, amber when one is too small. */
  private partLabel(c: any): { color?: string; sub: string } {
    const status = (this.mission?.derived["systems.wiring"]?.value as any)?.parts?.find((p: any) => p.id === c.id);
    if (status && (status.power === 0 || status.data === 0)) return { color: "#ff4b4b", sub: `NOT CONNECTED · ${status.power === 0 ? "no power line" : "no data line"}` };
    if (status && status.notes.length > 0) return { color: "#ffb020", sub: `LINE TOO SMALL · ${Math.round(Math.min(status.power, status.data ?? 1) * 100)}% gets through` };
    return { sub: this.metric(c) };
  }

  private metric(c: any): string {
    switch (c.type) {
      case "solar_panel": return `${c.areaM2} m² · ${(c.efficiency * 100).toFixed(0)}%`;
      case "battery": return `${c.capacityWh} Wh`;
      case "antenna": return `${c.frequencyGHz} GHz · ${c.dataRateBps >= 1e6 ? `${c.dataRateBps / 1e6} Mbps` : `${c.dataRateBps / 1e3} kbps`}`;
      case "instrument": return `${c.kind.replace(/_/g, " ")} · ${c.powerW} W`;
      case "adcs": return `holds ${c.stabilityArcsec}″ · ${c.powerW} W`;
      case "computer": return `${c.compressionRatio}:1 · +${c.storageGb} Gb`;
      default: return `${c.powerW} W`;
    }
  }

  private rebuildSystems(): void {
    for (const o of [...this.systemsView.children]) {
      this.systemsView.remove(o);
      if (o !== this.stage) disposeObject(o);
    }
    this.componentObjects.clear();
    this.freeObjects.clear();
    this.rings.clear();
    this.connectors = [];
    this.leds = [];
    const config = this.mission!.config;
    const comps: any[] = config.spacecraft.components;
    this.systemsView.add(this.stage);

    // Parts are shown at a readable size rather than their true relative scale; labels carry the numbers.
    const fit = (object: THREE.Object3D, target: number): number => {
      const box = new THREE.Box3().setFromObject(object);
      const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-3);
      const scale = target / span;
      object.scale.multiplyScalar(scale);
      return (box.max.y - box.min.y) * scale;
    };

    this.bus = new THREE.Group();
    const busModel = buildBus(config.spacecraft.busDryMassKg);
    bake(busModel.group);
    const busHeight = fit(busModel.group, 1.0);
    this.bus.add(busModel.group);
    const busLabel = createLabel(config.spacecraft.name.toUpperCase(), { height: 0.2, color: "#f2efe8", sub: `bus ${config.spacecraft.busDryMassKg} kg` });
    busLabel.position.y = busHeight / 2 + 0.3;
    busLabel.name = "bus-label";
    this.bus.add(busLabel);
    this.systemsView.add(this.bus);

    // A model the AI generated for a part it added in the same request is that part's body, not a second object
    // beside it: the two are matched by the words their names share.
    const words = (s: unknown): Set<string> => new Set(String(s ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? []);
    const modelFor = new Map<string, any>();
    const usedNodes = new Set<string>();
    for (const node of config.scene.nodes as any[]) {
      if (node.componentId || !node.assetId) continue;
      const record = config.assets.find((a: any) => a.id === node.assetId);
      if (!record) continue;
      const w = words(`${node.name} ${record.description ?? ""}`);
      let best: any = null;
      let bestScore = 1;
      for (const c of comps) {
        if (modelFor.has(c.id)) continue;
        let score = 0;
        for (const x of words(c.name)) if (w.has(x)) score++;
        if (score > bestScore) { best = c; bestScore = score; }
      }
      if (best) { modelFor.set(best.id, record); usedNodes.add(node.id); }
    }
    const present = [...comps.map((c) => c.id as string), ...(config.scene.nodes as any[]).filter((n) => !n.componentId && n.assetId && !usedNodes.has(n.id)).map((n) => n.id as string)];
    const fresh = this.known ? present.filter((id) => !this.known!.has(id)) : [];
    this.known = new Set(present);
    for (const id of fresh) this.born.set(id, this.time);

    comps.forEach((c, i) => {
      const node = config.scene.nodes.find((n: any) => n.componentId === c.id);
      const holder = new THREE.Group();
      holder.name = `component:${c.id}`;
      holder.userData = { componentId: c.id, path: `spacecraft.components.${c.id}`, nodeId: node?.id ?? null, label: c.name, kind: c.type, phase: i * 1.7 };
      const placed = node && node.position.some((v: number) => v !== 0);
      if (placed) {
        holder.position.fromArray(node.position);
      } else {
        const angle = (i / comps.length) * Math.PI * 2 + Math.PI / 6;
        const tier = { solar_panel: 0.0, battery: -0.3, antenna: 0.3, instrument: 0.12, load: -0.2 }[c.type as string] ?? 0;
        // The ring widens as parts are added, so neighbours and their labels keep apart.
        const ring = 1.25 + Math.max(0, comps.length - 5) * 0.09;
        holder.position.set(Math.cos(angle) * ring, tier, Math.sin(angle) * ring);
      }
      const part = buildComponent(c);
      const height = fit(part, c.type === "solar_panel" ? 0.74 : 0.5);
      part.position.y = -0.2;
      if (c.type === "solar_panel") part.rotation.z = 0.5; // tilt the wing so the cell face catches the light
      part.name = "part";
      holder.add(part);
      const generated = modelFor.get(c.id);
      if (generated) {
        void this.asset(generated.uri).then((model) => {
          if (this.componentObjects.get(c.id) !== holder) return; // rebuilt meanwhile
          fit(model, 0.56);
          const box = new THREE.Box3().setFromObject(model);
          model.position.y -= box.min.y + 0.2;
          model.position.x -= (box.min.x + box.max.x) / 2;
          model.position.z -= (box.min.z + box.max.z) / 2;
          const body = new THREE.Group();
          body.name = "part";
          body.add(model);
          holder.remove(part);
          disposeObject(part);
          holder.add(body);
          this.loadedAssets++;
        }).catch(() => undefined);
      }
      const label = createLabel(c.name, { height: 0.18, ...this.partLabel(c) });
      // Neighbouring labels sit at alternating heights so they do not cover one another.
      label.position.y = Math.max(0.4, height + 0.12) + (i % 2) * 0.2;
      label.name = "label";
      holder.add(label);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.009, 8, 64), new THREE.MeshBasicMaterial({ color: 0x35e0d0, transparent: true, opacity: 0 }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -0.2;
      holder.add(ring);
      this.rings.set(c.id, ring);
      this.systemsView.add(holder);
      this.componentObjects.set(c.id, holder);
    });

    // Generated assets that are not tied to a component (text-to-3D results): versioned GLBs.
    for (const node of config.scene.nodes as any[]) {
      if (node.componentId || !node.assetId || usedNodes.has(node.id)) continue;
      const record = config.assets.find((a: any) => a.id === node.assetId);
      if (!record) continue;
      const holder = new THREE.Group();
      holder.name = `asset:${node.id}`;
      holder.position.fromArray(node.position);
      holder.userData = { nodeId: node.id, assetId: record.id };
      const label = createLabel(String(node.name).toUpperCase(), { height: 0.16, color: "#c58bff", sub: `generated · ${record.triangles} triangles` });
      label.position.y = 0.5;
      holder.add(label);
      this.systemsView.add(holder);
      this.freeObjects.set(node.id, holder);
      void this.asset(record.uri).then((model) => {
        if (this.freeObjects.get(node.id) !== holder) return; // rebuilt meanwhile
        fit(model, 0.62);
        const box = new THREE.Box3().setFromObject(model);
        model.position.y -= box.min.y + 0.2;
        model.name = "glb";
        const body = new THREE.Group();
        body.name = "part";
        body.add(model);
        holder.add(body);
        this.loadedAssets++;
      }).catch(() => undefined);
    }

    // Engineering connections: power flows array → bus → consumers, data flows instruments → antennas.
    const link = (from: THREE.Object3D, to: THREE.Object3D, color: number, speed: number, lift: number): void => {
      const line = createFlowLine(Array.from({ length: 24 }, () => new THREE.Vector3()), color, { dashes: 7, speed, opacity: 0.95 });
      this.systemsView.add(line);
      this.connectors.push({ line, from, to, lift });
    };
    // One drawn line per real line in the design: amber carries power, cyan data, violet commands. A part with no
    // line drawn to it is not connected — that is the state of the design, not decoration.
    const at = (node: string): THREE.Object3D | undefined => (node === "bus" ? this.bus : this.componentObjects.get(node));
    for (const l of (config.systems?.links ?? []) as any[]) {
      const from = at(l.from.node);
      const to = at(l.to.node);
      if (!from || !to) continue;
      if (l.kind === "power") link(from, to, COLOR.power, 1.3, 0.12);
      else if (l.kind === "data") link(from, to, COLOR.data, 1.9, 0.34);
      else link(from, to, 0xc58bff, 0.6, 0.56);
    }
    this.systemsView.traverse((o) => {
      if (o.name === "led") this.leds.push(o as THREE.Mesh);
    });
    this.onRebuild?.();
    if (fresh.length) this.onBuilt?.(fresh);
  }

  private refreshLabels(): void {
    for (const c of this.mission!.config.spacecraft.components as any[]) {
      const holder = this.componentObjects.get(c.id);
      const old = holder?.getObjectByName("label");
      if (!holder || !old) continue;
      const label = createLabel(c.name, { height: 0.18, ...this.partLabel(c) });
      label.position.copy(old.position);
      if (old.userData.baseY !== undefined) label.position.y = old.userData.baseY as number; // not the height it was lifted to
      label.name = "label";
      holder.remove(old);
      disposeObject(old);
      holder.add(label);
    }
  }

  // ---------- view state ----------
  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.orbitView.visible = mode === "orbit";
    this.systemsView.visible = mode === "systems";
    this.siteView.visible = mode === "site";
    if (!this.siteView.parent) this.root.add(this.siteView);
  }

  /** Extent of the active view in its own units, so hosts can frame or scale it. */
  get extent(): number {
    if (this.mode === "systems") return 1.9;
    if (this.mode === "site") return 1.15;
    return Math.max(1.4, ...this.orbitPath.map((p) => p.length())) * 1.15;
  }

  /** Preview Sun geometry `days` after the mission time (rotates the Sun about the ecliptic pole). */
  /** The mission date, as the clock's reference. */
  get missionDateMs(): number {
    return this.baseMs;
  }

  /** Move the clock to an instant, and optionally change how fast it runs. */
  setClock(ms: number, rate?: number): void {
    if (Number.isFinite(ms)) this.clockMs = ms;
    if (rate !== undefined && Number.isFinite(rate)) this.clockRate = rate;
  }

  /**
   * Turn the world by hand. Turning it by an angle moves the clock by the time the body takes to
   * rotate that far: a full turn of the Moon is a month, a full turn of the Earth is a day.
   */
  turnBy(angleRad: number): void {
    if (!this.body) return;
    this.clockMs += (angleRad / (Math.PI * 2)) * SPIN_PERIOD_S[this.body] * 1000;
  }

  /** The marker that points home is hidden while the camera is standing at home. */
  showEarthMarker(on: boolean): void {
    if (this.earthMarker) this.earthMarker.visible = on;
  }

  /** Direction from the planet to Earth at the moment shown, in world space (null when the planet is the Earth). */
  earthDirection(target: THREE.Vector3): THREE.Vector3 | null {
    if (!this.sky?.earth) return null;
    return target.copy(toView(this.sky.earth)).normalize().applyQuaternion(this.root.getWorldQuaternion(new THREE.Quaternion()));
  }

  /** Is this ray on the planet? (Dragging the planet turns time; dragging empty space moves the camera.) */
  planetHit(raycaster: THREE.Raycaster): boolean {
    return this.mode === "orbit" && Boolean(this.planet) && raycaster.intersectObject(this.planet!.globe, false).length > 0;
  }

  /** What is true at the moment shown: is the spacecraft in sunlight, can it see Earth, is it day at the site. */
  telemetry(): { sunlit: boolean; earthInView: boolean | null; earthDistanceKm: number; sunDistanceAu: number; siteSunElevationDeg: number | null; moonPhase: Sky["moonPhase"] } | null {
    if (!this.sky || !this.body) return null;
    const p = this.craft.position;
    const sun = this.sunLocal;
    const along = p.dot(sun);
    const sunlit = !(along < 0 && p.clone().addScaledVector(sun, -along).length() < 1);
    let earthInView: boolean | null = null;
    if (this.sky.earth) {
      const e = toView(this.sky.earth).normalize();
      const t = -p.dot(e); // closest approach of the line of sight to the planet's centre
      earthInView = !(t > 0 && p.clone().addScaledVector(e, t).length() < 1);
    }
    let siteSunElevationDeg: number | null = null;
    if (this.siteMarker && this.planet) {
      const up = this.siteMarker.position.clone().normalize().applyQuaternion(this.planet.globe.quaternion);
      siteSunElevationDeg = (Math.asin(Math.max(-1, Math.min(1, up.dot(sun)))) * 180) / Math.PI;
    }
    return { sunlit, earthInView, earthDistanceKm: this.sky.earthDistanceKm, sunDistanceAu: this.sky.sunDistanceAu, siteSunElevationDeg, moonPhase: this.sky.moonPhase };
  }

  /** Show the mission on a given day after the mission date (the timeline and the flight-event list use this). */
  setPreviewDay(days: number | null): void {
    this.setClock(this.baseMs + (days ?? 0) * 86400000);
    this.sunLocal.copy(this.sunBase);
    if (days) this.sunLocal.applyAxisAngle(ECLIPTIC_POLE, (days / 365.25) * Math.PI * 2);
  }

  private primed: THREE.Object3D[] = [];
  /**
   * Show every hidden object for one off-screen draw, then hide them again. A graphics driver
   * finishes building a program the first time it is drawn with; doing that once up front keeps
   * the first burn, shockwave or view switch from stalling a frame.
   */
  prime(on: boolean): void {
    if (on) {
      this.root.traverse((o) => {
        if (!o.visible && !(o as THREE.Light).isLight) {
          o.visible = true;
          this.primed.push(o);
        }
      });
    } else {
      for (const o of this.primed) o.visible = false;
      this.primed = [];
    }
  }

  /** Flash the systems that were just recalculated (visible confirmation of a synchronised change). */
  pulse(): void {
    this.flash = 1;
    this.shockAge = 0;
  }

  /** Mark an object as held locally so incoming state does not fight the user's hand. */
  setHeld(componentId: string, held: boolean): void {
    if (held) this.held.add(componentId);
    else this.held.delete(componentId);
  }

  /** Show who is focused on / holding which component. */
  setFocus(focusByComponent: Map<string, string>): void {
    for (const [id, ring] of this.rings) {
      const color = focusByComponent.get(id);
      const mat = ring.material as THREE.MeshBasicMaterial;
      mat.opacity = color ? 0.95 : 0;
      if (color) mat.color.set(color);
    }
  }

  /** Another participant is moving an object: follow it until the change is committed. */
  previewTransform(nodeOrComponentId: string, pose: number[]): void {
    const id = nodeOrComponentId.replace(/^node_/, "");
    const obj = this.componentObjects.get(id);
    if (!obj || this.held.has(id)) return;
    obj.position.set(pose[0]!, pose[1]!, pose[2]!);
    obj.quaternion.set(pose[3]!, pose[4]!, pose[5]!, pose[6]!);
  }

  /** Remote participants, drawn in the mission frame: headsets as visors with hands, desktops as name tags. */
  /**
   * The AI crewmates in this mission and what each is doing right now: the part it is working on (or "bus"), a place
   * it points at, and whether it has just said something. Each is drawn as a probe that goes there.
   */
  setCrewProbes(list: { id: string; name: string; color: string; focus: string | null; point: number[] | null; speaking: boolean }[]): void {
    for (const [id, c] of this.crew) {
      if (list.some((x) => x.id === id)) continue;
      this.root.remove(c.holder);
      c.probe.dispose();
      disposeObject(c.tag);
      this.crew.delete(id);
    }
    list.forEach((x, i) => {
      let c = this.crew.get(x.id);
      if (!c) {
        const probe = new Companion();
        const holder = new THREE.Group();
        probe.group.scale.setScalar(5.2);
        const tag = createLabel(x.name.toUpperCase(), { height: 0.13, color: x.color, sub: "AI crewmate" });
        tag.position.y = 0.62;
        holder.add(probe.group, tag);
        holder.traverse((o) => { o.raycast = () => undefined; });
        holder.position.set(Math.cos(i * 2.1) * 2.2, 1.4, Math.sin(i * 2.1) * 2.2);
        this.root.add(holder);
        c = { probe, holder, tag, focus: null, point: null, spoke: 0, slot: i };
        this.crew.set(x.id, c);
        this.labelsChecked = -1;
      }
      c.focus = x.focus;
      c.point = x.point;
      if (x.speaking) c.spoke = this.time;
      c.slot = i;
    });
  }

  /** Where each AI crewmate's probe is and what it is doing (for checks). */
  crewProbes(): { id: string; state: string; at: number[]; focus: string | null }[] {
    return [...this.crew].map(([id, c]) => ({ id, state: c.probe.state, at: c.holder.position.toArray().map((v) => Math.round(v * 100) / 100), focus: c.focus }));
  }

  /** Mark (or, with null, unmark) the place someone points at: a ring, a beam and their name, in their colour. */
  setPing(key: string, point: number[] | null | undefined, color: string, name: string, note = "points here"): void {
    const old = this.pings.get(key);
    // A mark is built once for whoever it belongs to; after that only where it is going changes, and it glides there.
    const stamp = `${color},${name},${note}`;
    if (!point || !this.planet) {
      if (old) { old.parent?.remove(old); disposeObject(old); this.pings.delete(key); }
      return;
    }
    const to = onGlobe(point[0]!, point[1]!);
    if (old && old.userData.stamp === stamp && old.parent === this.planet.globe) {
      (old.userData.to as THREE.Vector3).copy(to);
      old.userData.point = [point[0], point[1]];
      return;
    }
    if (old) { old.parent?.remove(old); disposeObject(old); this.pings.delete(key); }
    const g = new THREE.Group();
    g.userData.stamp = stamp;
    g.userData.to = to.clone();
    g.userData.point = [point[0], point[1]];
    g.userData.born = this.time;
    g.position.copy(to);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to);
    const tint = new THREE.Color(color);
    const glow = (k: number): THREE.MeshBasicMaterial => new THREE.MeshBasicMaterial({ color: tint.clone().multiplyScalar(k), transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending });
    // On the ground: a bright core, a ring, and a ripple that keeps leaving it.
    const core = new THREE.Mesh(new THREE.CircleGeometry(0.018, 24).rotateX(-Math.PI / 2), glow(3));
    core.position.y = 0.008;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.046, 0.058, 56).rotateX(-Math.PI / 2), glow(2.4));
    ring.name = "ping-ring";
    ring.position.y = 0.007;
    const ripple = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.056, 56).rotateX(-Math.PI / 2), glow(2));
    ripple.name = "ping-ripple";
    ripple.position.y = 0.006;
    // Above it: a shaft of light that narrows upward, and a crystal turning at its head.
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0015, 0.012, 0.36, 12, 1, true), glow(1.6));
    shaft.position.y = 0.18;
    (shaft.material as THREE.MeshBasicMaterial).opacity = 0.55;
    const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.028, 0), new THREE.MeshBasicMaterial({ color: tint.clone().multiplyScalar(2.6) }));
    gem.name = "ping-gem";
    gem.position.y = 0.4;
    gem.scale.set(1, 1.5, 1);
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.0028, 8, 40), glow(2));
    halo.name = "ping-halo";
    halo.position.y = 0.4;
    const tag = createLabel(name.toUpperCase(), { height: key === "target" ? 0.11 : 0.1, color, sub: note });
    tag.position.y = 0.56;
    for (const o of [core, ring, ripple, shaft, gem, halo]) o.raycast = () => undefined;
    g.add(core, ring, ripple, shaft, gem, halo, tag);
    this.planet.globe.add(g);
    this.pings.set(key, g);
    this.labelsChecked = -1;
  }

  /** Who is pointing where right now (for checks): "key: lat,lon,colour,name". */
  pingsShown(): string[] { return [...this.pings].map(([k, g]) => `${k}: ${(g.userData.point as number[]).map((v) => v.toFixed(1)).join(",")},${String(g.userData.stamp)}`); }

  /**
   * Show the place this mission is about as a model beside the world, with what the spacecraft's camera can tell
   * apart there against what the problem needs. Null takes it away.
   */
  setSite(spec: { kind: SiteKind; name: string; world?: string; nowM: number | null; needM: number | null } | null): void {
    const stamp = spec ? `${spec.kind}|${spec.name}|${this.body}` : "";
    if (stamp !== this.siteStamp) {
      this.siteStamp = stamp;
      if (this.site) { this.siteView.remove(this.site.group); this.site.dispose(); this.site = null; }
      if (spec) {
        this.site = new SiteModel(spec.kind, this.body ?? "moon", spec.name, spec.world ?? "the world");
        this.site.group.scale.setScalar(1.25);
        this.site.group.position.set(0, -0.2, 0);
        if (!this.siteView.parent) { this.siteView.visible = this.mode === "site"; this.root.add(this.siteView); }
        this.siteView.add(this.site.group);
        if (!this.sight.parent) { this.sight.raycast = () => undefined; this.sight.frustumCulled = false; this.orbitView.add(this.sight); }
        this.labelsChecked = -1;
      }
    }
    this.site?.setDetail(spec?.nowM ?? null, spec?.needM ?? null);
    this.sight.visible = Boolean(spec);
    if (!spec && this.mode === "site") this.setMode("orbit");
  }

  /** What the site model shows (for checks). */
  siteShown(): { kind: string; observing: boolean; onStage: boolean } | null { return this.site ? { kind: this.site.kind, observing: this.observing, onStage: this.siteView.visible } : null; }

  /** Where on the world a ray lands: [latitude, east longitude] in degrees, or null if it misses. */
  globePointFromRay(raycaster: THREE.Raycaster): number[] | null {
    if (this.mode !== "orbit" || !this.planet) return null;
    const hit = raycaster.intersectObject(this.planet.globe, false)[0];
    return hit ? this.latLon(hit.point) : null;
  }

  /** The place under a point held at the world's surface (a fingertip): null if the point is not close to the surface. */
  globePointNear(world: THREE.Vector3): number[] | null {
    if (this.mode !== "orbit" || !this.planet || !this.orbitView.visible) return null;
    const local = this.planet.globe.worldToLocal(world.clone());
    const r = local.length();
    return r > 0.72 && r < 1.4 ? this.latLon(world) : null;
  }

  private latLon(world: THREE.Vector3): number[] {
    const p = this.planet!.globe.worldToLocal(world.clone()).normalize();
    return [Math.round((Math.asin(Math.max(-1, Math.min(1, p.y))) * 180 / Math.PI) * 10) / 10, Math.round((Math.atan2(-p.z, p.x) * 180 / Math.PI) * 10) / 10];
  }

  setPresence(roster: Presence[], selfClientId: string | null): void {
    const seen = new Set<string>();
    const focus = new Map<string, string>();
    const who = new Map<string, string>();
    for (const key of [...this.pings.keys()]) if (key !== "self" && key !== "target" && !roster.some((p) => p.clientId === key && p.clientId !== selfClientId)) this.setPing(key, null, "", "");
    for (const p of roster) {
      if (p.clientId !== selfClientId) this.setPing(p.clientId, p.point ?? null, p.color, p.displayName);
      const component = p.focus === "spacecraft.bus" ? "bus" : p.focus?.match(/components\.([\w-]+)/)?.[1];
      if (component) { focus.set(component, p.color); if (p.clientId !== selfClientId) who.set(component, p.displayName); }
      if (p.clientId === selfClientId) continue;
      seen.add(p.clientId);
      let avatar = this.avatars.get(p.clientId);
      if (!avatar) {
        avatar = new THREE.Group();
        const visor = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.09, 6, 14).rotateZ(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0b0b0d, metalness: 1, roughness: 0.12, emissive: p.color, emissiveIntensity: 0.9 }));
        visor.name = "head";
        const tag = createLabel(p.displayName, { height: 0.06, color: p.color });
        tag.position.y = 0.14;
        visor.add(tag);
        const hand = (): THREE.Mesh => new THREE.Mesh(new THREE.SphereGeometry(0.03, 14, 10), new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 1.6, roughness: 0.4 }));
        const left = hand(); left.name = "left";
        const right = hand(); right.name = "right";
        avatar.add(visor, left, right);
        this.root.add(avatar);
        this.avatars.set(p.clientId, avatar);
      }
      this.applyPose(avatar, p);
    }
    for (const [id, avatar] of this.avatars) {
      if (!seen.has(id)) {
        this.root.remove(avatar);
        disposeObject(avatar);
        this.avatars.delete(id);
      }
    }
    this.setFocus(focus);
    this.setPointerTags(focus, who);
  }

  /** The parts that carry someone's name right now (for checks): "part: NAME|colour". */
  pointerTagsShown(): string[] { return [...this.pointerTags].map(([id, t]) => `${id}: ${t.stamp}`); }

  /** Over each part someone else is pointing at (or working on): their name, in their colour. */
  private pointerTags = new Map<string, { tag: THREE.Sprite; stamp: string }>();
  private setPointerTags(colors: Map<string, string>, names: Map<string, string>): void {
    for (const [id, t] of this.pointerTags) {
      const stamp = names.has(id) ? `${names.get(id)}|${colors.get(id)}` : "";
      if (t.stamp === stamp && t.tag.parent) continue;
      t.tag.parent?.remove(t.tag);
      disposeObject(t.tag);
      this.pointerTags.delete(id);
    }
    for (const [id, name] of names) {
      if (this.pointerTags.has(id)) continue;
      const holder = id === "bus" ? this.bus : this.componentObjects.get(id);
      if (!holder) continue;
      const tag = createLabel(`▼ ${name.toUpperCase()}`, { height: 0.12, color: colors.get(id) ?? "#4cc9f0" });
      tag.position.y = id === "bus" ? 1.25 : 1.0;
      tag.name = "pointer-tag";
      holder.add(tag);
      this.pointerTags.set(id, { tag, stamp: `${name}|${colors.get(id)}` });
    }
  }

  private applyPose(avatar: THREE.Group, p: Presence): void {
    const place = (name: string, pose: number[] | null | undefined): void => {
      const o = avatar.getObjectByName(name)!;
      o.visible = Boolean(pose);
      if (pose) {
        o.position.set(pose[0]!, pose[1]!, pose[2]!);
        o.quaternion.set(pose[3]!, pose[4]!, pose[5]!, pose[6]!);
      }
    };
    place("head", p.mode === "xr" ? p.head : null);
    place("left", p.hands?.left);
    place("right", p.hands?.right);
  }

  /** First component under a ray, for desktop selection. */
  pick(raycaster: THREE.Raycaster): { componentId: string; object: THREE.Object3D } | null {
    if (this.mode !== "systems") return null;
    const hit = raycaster.intersectObjects([...this.componentObjects.values()], true).find((h) => !(h.object as THREE.Sprite).isSprite);
    let o: THREE.Object3D | null = hit?.object ?? null;
    while (o && !o.userData.componentId) o = o.parent;
    return o ? { componentId: o.userData.componentId as string, object: o } : null;
  }

  /** Close-up mode: drop the beacon glow and name tag and part the ribbon around the spacecraft. */
  setCloseUp(on: boolean): void {
    this.closeUp = on;
    this.applyCloseUp();
  }

  private applyCloseUp(): void {
    for (const name of ["beacon", "craft-label"]) {
      const o = this.craft.getObjectByName(name);
      if (o) o.visible = !this.closeUp;
    }
  }

  /** Sun direction in the mission frame. */
  get sunDirection(): THREE.Vector3 {
    return this.sunLocal.clone();
  }

  /** Where the spacecraft is, in the root's frame (for camera work). */
  craftPosition(target = new THREE.Vector3()): THREE.Vector3 {
    return target.copy(this.craft.position);
  }

  // ---------- per-frame ----------
  private scratch = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), q: new THREE.Quaternion(), m: new THREE.Matrix4() };

  /**
   * Keep the part labels of the systems view from covering one another as the camera moves: labels that would
   * overlap on screen are lifted one above the other. Called by the desktop frame loop with its camera.
   */
  declutterLabels(camera: THREE.Camera): void {
    this.viewer = camera;
    if (!this.systemsView.visible) return;
    const items: { label: THREE.Object3D; base: number; x: number; y: number; w: number; h: number }[] = [];
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    const worldScale = new THREE.Vector3();
    // every name tag in the systems view takes part: the parts' own and the spacecraft's
    const labels: THREE.Object3D[] = [];
    this.systemsView.traverse((o) => { if (o.userData.labelBase && o.visible) labels.push(o); });
    for (const label of labels) {
      if (label.userData.baseY === undefined) label.userData.baseY = label.position.y;
      label.position.y = label.userData.baseY as number;
      label.getWorldPosition(p).project(camera);
      // size on screen: project a point one label-height above, and use the sprite's own aspect
      q.setFromMatrixPosition(label.matrixWorld);
      q.y += label.getWorldScale(worldScale).y; // the tag's real height: the whole scene is scaled down on the headset's table
      q.project(camera);
      const h = Math.abs(q.y - p.y);
      const w = h * (label.scale.x / Math.max(1e-6, label.scale.y));
      if (p.z < 1) items.push({ label, base: label.userData.baseY as number, x: p.x, y: p.y, w, h });
    }
    items.sort((a, b) => a.y - b.y);
    for (let i = 1; i < items.length; i++) {
      const b = items[i]!;
      for (let k = 0; k < i; k++) {
        const a = items[k]!;
        const overlapX = Math.abs(a.x - b.x) < (a.w + b.w) / 2;
        const gap = b.y - b.h / 2 - (a.y + a.h / 2);
        if (overlapX && gap < 0.01) {
          const lift = 0.01 - gap; // in normalised screen units
          b.y += lift;
          b.label.position.y += (lift / Math.max(1e-6, b.h)) * b.label.scale.y;
        }
      }
    }
  }

  /** Presentation for a small table-top model (the headset): larger labels and a readable unlit side. 1 and 0.006 on a screen. */
  private labelScale = 1;
  private nightFloor = 0.006;
  private labelsChecked = 0;
  setTableTop(on: boolean): void {
    this.labelScale = on ? 2.2 : 1;
    this.nightFloor = on ? 0.045 : 0.006;
    this.labelsChecked = -1;
  }
  /** The Sun's direction in the scene's own frame, for turning the table so its lit side faces the player. */
  sunHeading(): number {
    return Math.atan2(this.sunLocal.x, this.sunLocal.z);
  }
  private sizeLabels(): void {
    // The systems view packs many labelled parts close together, so its labels grow less than the orbit view's.
    const size = (group: THREE.Object3D, k: number): void => group.traverse((o) => {
      const base = o.userData.labelBase as [number, number] | undefined;
      if (base && o.userData.labelK !== k) { o.scale.set(base[0] * k, base[1] * k, 1); o.userData.labelK = k; }
    });
    size(this.orbitView, this.labelScale);
    size(this.systemsView, Math.min(this.labelScale, 1.6));
  }

  update(dt: number): void {
    this.time += dt;
    // Labels are rebuilt in many places; a cheap pass a few times a second keeps their size right for the view.
    if (this.labelsChecked < 0 || this.time - this.labelsChecked > 0.4) { this.labelsChecked = this.time; if (this.labelScale !== 1 || this.root.userData.labelsScaled) { this.sizeLabels(); this.root.userData.labelsScaled = this.labelScale !== 1; } }
    this.planet?.setNightFloor(this.nightFloor);
    const { a, b, c, q, m } = this.scratch;
    // The clock drives everything that depends on when: the Sun's direction, how the world is turned, where home is.
    if (this.body && this.clockStarted) {
      this.clockMs += dt * 1000 * this.clockRate;
      const sky = (this.sky = skyAt(this.body, this.clockMs));
      this.sunLocal.copy(toView(sky.sun)).normalize();
      if (this.planet) {
        const target = toView(sky.primeMeridian);
        const zero = onGlobe(0, 0);
        this.planet.globe.rotation.y = Math.atan2(-target.z, target.x) - Math.atan2(-zero.z, zero.x);
      }
      if (this.earthMarker && sky.earth) this.earthMarker.position.copy(toView(sky.earth)).normalize().multiplyScalar(Math.max(2.2, this.extent * 1.5));
    }
    const worldQuat = this.root.getWorldQuaternion(q);
    const sunWorld = a.copy(this.sunLocal).applyQuaternion(worldQuat);
    this.planet?.setSun(sunWorld);
    this.planet?.update(dt);
    // The shadow frustum hugs whatever hardware is on screen, so a small map stays sharp.
    const orbiting = this.mode === "orbit";
    const focus = orbiting ? this.craft.position : b.set(0, 0, 0);
    const half = orbiting ? 0.26 : 2.4;
    this.sunLight.target.position.copy(focus);
    this.sunLight.position.copy(focus).addScaledVector(this.sunLocal, 20);
    const shadowCamera = this.sunLight.shadow.camera;
    if (shadowCamera.right !== half) {
      shadowCamera.left = -half; shadowCamera.right = half; shadowCamera.top = half; shadowCamera.bottom = -half;
      shadowCamera.near = 10; shadowCamera.far = 30;
      shadowCamera.updateProjectionMatrix();
      this.sunLight.shadow.normalBias = orbiting ? 0.0015 : 0.012;
    }
    this.sun.position.copy(this.sunLocal).multiplyScalar(this.extent * 2.6);
    this.sun.scale.setScalar(this.extent * 0.55);
    if (this.host) {
      // The environment's Sun sits on +X: turn the lookup so it matches the mission's Sun.
      this.host.environmentRotation.setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(sunWorld.clone().normalize(), X_AXIS));
    }
    this.umbra.quaternion.setFromUnitVectors(b.set(0, 1, 0), c.copy(this.sunLocal).negate());
    this.umbra.position.copy(this.sunLocal).multiplyScalar(-2.5);
    this.flash = Math.max(0, this.flash - dt * 1.4);
    this.burn = Math.max(0, this.burn - dt * 0.55);
    this.deploy = Math.min(1, this.deploy + dt / 2.6);

    for (const tube of [this.orbitTube, ...this.overlays]) {
      if (!tube) continue;
      tube.material.uniforms.uTime!.value = this.time;
      tube.material.uniforms.uFlash!.value = this.flash * 0.6 + (tube === this.orbitTube ? this.burn * 0.5 : 0);
      tube.material.uniforms.uSunLocal!.value.copy(this.sunLocal);
      tube.material.uniforms.uGap!.value = tube === this.orbitTube && this.closeUp ? 1 : 0;
    }

    if (this.orbitPath.length > 1 && this.craftModel) {
      // The spacecraft keeps an easy-to-follow pace (one orbit in forty seconds) whatever the clock is doing:
      // at a day per second its true motion would be a blur.
      this.craftPhase = (this.craftPhase + dt / 40) % 1;
      const f = this.craftPhase * this.orbitPath.length;
      const i = Math.floor(f) % this.orbitPath.length;
      const p0 = this.orbitPath[i]!;
      const p1 = this.orbitPath[(i + 1) % this.orbitPath.length]!;
      this.craft.position.lerpVectors(p0, p1, f - Math.floor(f));
      this.orbitTube!.material.uniforms.uHead!.value = this.craftPhase;
      // Nadir-pointing with yaw steering: instruments (+Z) at the planet, and the array axis (X) kept
      // perpendicular to the Sun line so the single-axis array drives can face the cells at the Sun.
      const nadir = a.copy(this.craft.position).normalize().negate();
      const velocity = b.subVectors(p1, p0).normalize();
      const normal = c.crossVectors(this.sunLocal, nadir);
      if (normal.lengthSq() < 1e-4) normal.crossVectors(velocity, nadir); // Sun on the nadir line: any yaw will do
      normal.normalize();
      const up = velocity.crossVectors(nadir, normal).normalize();
      const model = this.craftModel;
      model.group.quaternion.setFromRotationMatrix(m.makeBasis(normal, up, nadir));
      // Arrays turn about their drive axis to face the Sun.
      const sunBody = a.copy(this.sunLocal).applyQuaternion(q.copy(model.group.quaternion).invert());
      const track = Math.atan2(sunBody.z, sunBody.y);
      const open = ease(this.deploy);
      model.wings.forEach((drive) => {
        drive.rotation.x = track;
        drive.children[0]!.scale.x = 0.04 + 0.96 * open;
      });
      const along = this.craft.position.dot(this.sunLocal);
      const eclipsed = along < 0 && b.copy(this.craft.position).addScaledVector(this.sunLocal, -along).length() < 1;
      if (this.craftBeacon) (this.craftBeacon.material as THREE.SpriteMaterial).opacity = (eclipsed ? 0.15 : 0.38) + 0.1 * Math.sin(this.time * 3);
      if (model.plume) {
        const mat = model.plume.material as THREE.MeshBasicMaterial;
        mat.opacity = this.burn * (0.75 + 0.25 * Math.sin(this.time * 60));
        model.plume.visible = this.burn > 0.01;
      }
      const blink = Math.sin(this.time * 4) > 0.2;
      for (const led of model.leds) led.visible = blink;
    }

    // Recalculation shockwave.
    this.shockAge += dt;
    const shockT = this.shockAge / 1.3;
    this.shock.visible = shockT < 1 && this.orbitView.visible;
    if (this.shock.visible) {
      this.shock.position.copy(this.craft.position);
      this.shock.lookAt(a.copy(this.craft.position).multiplyScalar(2));
      this.shock.scale.setScalar(0.05 + ease(shockT) * 0.9);
      (this.shock.material as THREE.MeshBasicMaterial).opacity = (1 - shockT) * 0.9;
    }
    if (this.site) {
      // Is the place in the spacecraft's line of sight (as drawn)? Then the line to it shows in the orbit view and the
      // scan line runs across the close-up.
      const mark = this.pings.get("target");
      let seen = false;
      if (mark) {
        const place = this.orbitView.worldToLocal(mark.getWorldPosition(a));
        const up = b.copy(place).normalize();
        seen = this.orbitPath.length > 1 && c.subVectors(this.craft.position, place).normalize().dot(up) > 0.08;
        const sp = this.sight.geometry.getAttribute("position") as THREE.BufferAttribute;
        sp.setXYZ(0, this.craft.position.x, this.craft.position.y, this.craft.position.z);
        sp.setXYZ(1, place.x, place.y, place.z);
        sp.needsUpdate = true;
        (this.sight.material as THREE.LineBasicMaterial).opacity = 0.55 + 0.4 * Math.sin(this.time * 14);
      }
      this.sight.visible = seen;
      this.observing = seen;
      this.site.setObserving(seen);
      if (this.siteView.visible) { this.site.group.rotation.y += dt * 0.12; this.site.update(dt); }
    }
    // The AI crewmates' probes: at the part being worked on (with a beam on it), over the place being pointed at,
    // or waiting in a slow circle around the spacecraft.
    if (this.crew.size) {
      const face = this.viewer ? this.viewer.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3(0, 2, 6);
      for (const c of this.crew.values()) {
        const target = new THREE.Vector3();
        let beamTo: THREE.Vector3 | null = null;
        const part = c.focus ? (c.focus === "bus" ? this.bus : this.componentObjects.get(c.focus)) : null;
        const mark = c.point && this.planet ? this.planet.globe.localToWorld(onGlobe(c.point[0]!, c.point[1]!, 1.02)) : null;
        if (this.mode === "systems") {
          if (part) { target.copy(part.position).add(new THREE.Vector3(0.28, 0.85, 0.28)); beamTo = this.systemsView.localToWorld(part.position.clone()); }
          else { const a2 = this.time * 0.25 + c.slot * 2.1; target.set(Math.cos(a2) * 2.3, 1.25 + 0.15 * Math.sin(this.time + c.slot), Math.sin(a2) * 2.3); }
        } else if (mark) {
          const local = this.root.worldToLocal(mark.clone());
          target.copy(local).multiplyScalar(1.38);
          beamTo = mark;
        } else {
          const a2 = this.time * 0.2 + c.slot * 2.1;
          target.copy(this.craft.position).add(new THREE.Vector3(Math.cos(a2) * 0.55, 0.3 + 0.1 * c.slot, Math.sin(a2) * 0.55));
        }
        c.holder.position.lerp(target, 1 - Math.exp(-dt * 2.6));
        c.holder.scale.setScalar(this.mode === "systems" ? 1 : 0.55);
        const working = beamTo !== null;
        const speaking = this.time - c.spoke < 4;
        const state = working ? "building" : speaking ? "speaking" : "idle";
        if (c.probe.state !== state) c.probe.setState(state);
        c.probe.aim(beamTo);
        c.probe.update(dt, face);
      }
    }
    for (const ping of this.pings.values()) {
      // Glide to where it is going (along the surface), then keep it alive: the ripple leaves, the crystal turns.
      const to = ping.userData.to as THREE.Vector3;
      if (ping.position.distanceToSquared(to) > 1e-9) {
        ping.position.lerp(to, 1 - Math.exp(-dt * 18)).normalize();
        ping.quaternion.setFromUnitVectors(b.set(0, 1, 0), ping.position);
      }
      const k = (this.time * 0.8 + (ping.userData.born as number)) % 1;
      const ripple = ping.getObjectByName("ping-ripple") as THREE.Mesh | undefined;
      if (ripple) { ripple.scale.setScalar(1 + k * 2.4); (ripple.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k); }
      const pr = ping.getObjectByName("ping-ring") as THREE.Mesh | undefined;
      if (pr) pr.scale.setScalar(1 + 0.08 * Math.sin(this.time * 5));
      const gem = ping.getObjectByName("ping-gem");
      if (gem) { gem.rotation.y = this.time * 2.2; gem.position.y = 0.4 + 0.02 * Math.sin(this.time * 3); }
      const halo = ping.getObjectByName("ping-halo");
      if (halo) { halo.rotation.x = Math.PI / 2 + 0.5 * Math.sin(this.time * 1.7); halo.rotation.z = this.time * 1.3; }
    }
    const ring = this.siteMarker?.getObjectByName("site-ring");
    if (ring) {
      const k = (this.time * 0.6) % 1;
      ring.scale.setScalar(0.6 + k * 1.8);
      ((ring as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - k;
    }

    if (this.systemsView.visible) {
      // Hardware is not a still picture: arrays lean after the Sun, dishes slew, instruments scan, and a part that
      // has just been added assembles itself where it stands.
      const move = (holder: THREE.Object3D, id: string, kind: string): void => {
        const part = holder.getObjectByName("part");
        const phase = (holder.userData.phase as number | undefined) ?? 0;
        const t = this.time + phase;
        const bornAt = this.born.get(id);
        const age = bornAt === undefined ? 9 : this.time - bornAt;
        if (age < 1.6) {
          const k = Math.max(0, age / 1.6);
          const out = 1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2); // overshoots a little, then settles
          holder.scale.setScalar(Math.max(0.02, out));
          holder.rotation.y = (1 - k) * (1 - k) * 7;
        } else if (bornAt !== undefined) {
          holder.scale.setScalar(1);
          holder.rotation.y = 0;
          this.born.delete(id);
        }
        if (!part || this.held.has(id)) return;
        if (kind === "solar_panel") part.rotation.z = 0.5 + 0.16 * Math.sin(t * 0.45);
        else if (kind === "antenna") { part.rotation.y = 0.55 * Math.sin(t * 0.38); part.rotation.x = 0.1 * Math.sin(t * 0.61); }
        else if (kind === "instrument") part.rotation.y = 0.38 * Math.sin(t * 0.7);
        else if (kind === "generated") part.rotation.y += dt * 0.4;
        else part.position.y = -0.2 + 0.012 * Math.sin(t * 1.5);
      };
      for (const [id, holder] of this.componentObjects) move(holder, id, String(holder.userData.kind ?? "load"));
      for (const [id, holder] of this.freeObjects) move(holder, id, "generated");
      const blink = Math.sin(this.time * 4) > 0.2;
      for (const led of this.leds) led.visible = blink;
      const from = a, to = b, mid = c;
      for (const connector of this.connectors) {
        from.copy(connector.from.position);
        to.copy(connector.to.position);
        mid.addVectors(from, to).multiplyScalar(0.5);
        mid.y += connector.lift;
        const pos = connector.line.geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let k = 0; k < pos.count; k++) {
          const t = k / (pos.count - 1);
          const u = 1 - t;
          pos.setXYZ(k, u * u * from.x + 2 * u * t * mid.x + t * t * to.x, u * u * from.y + 2 * u * t * mid.y + t * t * to.y, u * u * from.z + 2 * u * t * mid.z + t * t * to.z);
        }
        pos.needsUpdate = true;
        connector.line.material.uniforms.uTime!.value = this.time;
        connector.line.material.uniforms.uFlash!.value = this.flash * 0.5;
      }
    }
  }

  dispose(): void {
    disposeObject(this.root);
    this.planet?.dispose();
  }
}

let glow: THREE.CanvasTexture | null = null;
/** Soft round glow, shared by every beacon. */
function glowTexture(): THREE.CanvasTexture {
  if (glow) return glow;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.45)");
  g.addColorStop(0.5, "rgba(255,255,255,0.1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glow = new THREE.CanvasTexture(canvas);
  return glow;
}
