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
import { buildBus, buildComponent, buildRover, buildSpacecraft, type SpacecraftModel } from "./models";
import { type BodyId, createFlowLine, createFlowTube, createLabel, createPlanet, createSun, disposeObject, onGlobe, type Planet, toView } from "./space";

export type ViewMode = "orbit" | "systems";
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

  private planet: Planet | null = null;
  private body: BodyId | null = null;
  private orbitTube: FlowTube | null = null;
  private overlays: FlowTube[] = [];
  private orbitPath: THREE.Vector3[] = [];
  private craft = new THREE.Group();
  private craftModel: SpacecraftModel | null = null;
  private craftSignature = "";
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

  constructor() {
    this.root.name = "mission-root";
    // The environment map carries most of the fill; this keeps night-side hardware legible.
    this.root.add(this.orbitView, this.systemsView, this.sunLight, new THREE.HemisphereLight(0x9fb2dc, 0x2a2018, 0.5));
    this.systemsView.visible = false;
    this.orbitView.add(this.craft, this.sun);
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
      this.siteMarker = null;
    }
    const lighting = mission.derived["scene.lighting"]?.value;
    if (lighting?.sunDirection) this.sunBase.copy(toView(lighting.sunDirection)).normalize();
    this.sunLocal.copy(this.sunBase);
    // A change of orbit size is shown as a burn.
    const sma = config.orbit.semiMajorAxisKm as number;
    if (this.lastSma !== null && Math.abs(sma - this.lastSma) > 1e-6) this.burn = 1;
    this.lastSma = sma;
    this.rebuildOrbit();
    this.rebuildCraft();
    this.rebuildSite();
    // The systems view is rebuilt only when components or their placement change.
    const signature = JSON.stringify([config.spacecraft.busDryMassKg, config.spacecraft.components.map((c: any) => [c.id, c.type, c.areaM2, c.diameterM, c.capacityWh, c.apertureM, c.kind, c.name]), config.scene.nodes, config.assets.map((a: any) => a.id)]);
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
    for (const o of [this.orbitTube, ...this.overlays, ...this.orbitView.children.filter((c) => c.userData.transient)]) {
      if (!o) continue;
      this.orbitView.remove(o);
      disposeObject(o);
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
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: new THREE.Color(1.4, 2.6, 2.6), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
    halo.scale.setScalar(0.5);
    this.craftBeacon = halo;
    const name = createLabel(spacecraft.name.toUpperCase(), { height: 0.13, color: "#f2efe8", sub: "enlarged · not to scale" });
    name.position.y = 0.3;
    this.craft.add(model.group, halo, name);
  }

  /** Landing-site marker riding on the globe at the rover's true coordinates. */
  private rebuildSite(): void {
    const rover = this.mission!.config.rover;
    if (this.siteMarker) {
      this.siteMarker.parent?.remove(this.siteMarker);
      disposeObject(this.siteMarker);
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

  private metric(c: any): string {
    switch (c.type) {
      case "solar_panel": return `${c.areaM2} m² · ${(c.efficiency * 100).toFixed(0)}%`;
      case "battery": return `${c.capacityWh} Wh`;
      case "antenna": return `${c.frequencyGHz} GHz · ${c.dataRateBps >= 1e6 ? `${c.dataRateBps / 1e6} Mbps` : `${c.dataRateBps / 1e3} kbps`}`;
      case "instrument": return `${c.kind.replace(/_/g, " ")} · ${c.powerW} W`;
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
    const busHeight = fit(busModel.group, 1.0);
    this.bus.add(busModel.group);
    const busLabel = createLabel(config.spacecraft.name.toUpperCase(), { height: 0.2, color: "#f2efe8", sub: `bus ${config.spacecraft.busDryMassKg} kg` });
    busLabel.position.y = busHeight / 2 + 0.3;
    busLabel.name = "bus-label";
    this.bus.add(busLabel);
    this.systemsView.add(this.bus);

    comps.forEach((c, i) => {
      const node = config.scene.nodes.find((n: any) => n.componentId === c.id);
      const holder = new THREE.Group();
      holder.name = `component:${c.id}`;
      holder.userData = { componentId: c.id, path: `spacecraft.components.${c.id}`, nodeId: node?.id ?? null, label: c.name };
      const placed = node && node.position.some((v: number) => v !== 0);
      if (placed) {
        holder.position.fromArray(node.position);
      } else {
        const angle = (i / comps.length) * Math.PI * 2 + Math.PI / 6;
        const tier = { solar_panel: 0.0, battery: -0.3, antenna: 0.3, instrument: 0.12, load: -0.2 }[c.type as string] ?? 0;
        holder.position.set(Math.cos(angle) * 1.25, tier, Math.sin(angle) * 1.25);
      }
      const part = buildComponent(c);
      const height = fit(part, c.type === "solar_panel" ? 0.74 : 0.5);
      part.position.y = -0.2;
      if (c.type === "solar_panel") part.rotation.z = 0.5; // tilt the wing so the cell face catches the light
      holder.add(part);
      const label = createLabel(c.name, { height: 0.18, sub: this.metric(c) });
      label.position.y = Math.max(0.4, height + 0.12);
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
      if (node.componentId || !node.assetId) continue;
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
        holder.add(model);
        this.loadedAssets++;
      }).catch(() => undefined);
    }

    // Engineering connections: power flows array → bus → consumers, data flows instruments → antennas.
    const link = (from: THREE.Object3D, to: THREE.Object3D, color: number, speed: number, lift: number): void => {
      const line = createFlowLine(Array.from({ length: 24 }, () => new THREE.Vector3()), color, { dashes: 7, speed, opacity: 0.95 });
      this.systemsView.add(line);
      this.connectors.push({ line, from, to, lift });
    };
    const antennas = comps.filter((c) => c.type === "antenna");
    for (const c of comps) {
      const obj = this.componentObjects.get(c.id)!;
      if (c.type === "solar_panel") link(obj, this.bus, COLOR.power, 1.6, 0.25);
      else if (c.type === "battery") link(this.bus, obj, COLOR.charge, 0.8, 0.2);
      else link(this.bus, obj, COLOR.load, 0.5 + Math.min(1.5, (c.powerW ?? c.dcPowerW ?? 10) / 60), 0.2);
      if (c.type === "instrument") for (const a of antennas) link(obj, this.componentObjects.get(a.id)!, COLOR.data, 0.8 + Math.min(2, Math.log10(1 + c.dataRateBps) / 4), 0.6);
    }
    this.systemsView.traverse((o) => {
      if (o.name === "led") this.leds.push(o as THREE.Mesh);
    });
    this.onRebuild?.();
  }

  private refreshLabels(): void {
    for (const c of this.mission!.config.spacecraft.components as any[]) {
      const holder = this.componentObjects.get(c.id);
      const old = holder?.getObjectByName("label");
      if (!holder || !old) continue;
      const label = createLabel(c.name, { height: 0.18, sub: this.metric(c) });
      label.position.copy(old.position);
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
  }

  /** Extent of the active view in its own units, so hosts can frame or scale it. */
  get extent(): number {
    if (this.mode === "systems") return 1.9;
    return Math.max(1.4, ...this.orbitPath.map((p) => p.length())) * 1.15;
  }

  /** Preview Sun geometry `days` after the mission time (rotates the Sun about the ecliptic pole). */
  setPreviewDay(days: number | null): void {
    this.sunLocal.copy(this.sunBase);
    if (days) this.sunLocal.applyAxisAngle(ECLIPTIC_POLE, (days / 365.25) * Math.PI * 2);
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
  setPresence(roster: Presence[], selfClientId: string | null): void {
    const seen = new Set<string>();
    const focus = new Map<string, string>();
    for (const p of roster) {
      const component = p.focus?.match(/components\.([\w-]+)/)?.[1];
      if (component) focus.set(component, p.color);
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

  update(dt: number): void {
    this.time += dt;
    const { a, b, c, q, m } = this.scratch;
    const worldQuat = this.root.getWorldQuaternion(q);
    const sunWorld = a.copy(this.sunLocal).applyQuaternion(worldQuat);
    this.planet?.setSun(sunWorld);
    this.planet?.update(dt);
    if (this.planet) this.planet.globe.rotation.y += dt * 0.006;
    this.sunLight.position.copy(this.sunLocal).multiplyScalar(20);
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
    }

    if (this.orbitPath.length > 1 && this.craftModel) {
      // One orbit every 40 seconds of wall-clock time, regardless of the true period.
      this.craftPhase = (this.craftPhase + dt / 40) % 1;
      const f = this.craftPhase * this.orbitPath.length;
      const i = Math.floor(f) % this.orbitPath.length;
      const p0 = this.orbitPath[i]!;
      const p1 = this.orbitPath[(i + 1) % this.orbitPath.length]!;
      this.craft.position.lerpVectors(p0, p1, f - Math.floor(f));
      this.orbitTube!.material.uniforms.uHead!.value = this.craftPhase;
      // Nadir-pointing attitude: instruments (+Z) at the planet, array axis (X) along the orbit normal.
      const nadir = a.copy(this.craft.position).normalize().negate();
      const velocity = b.subVectors(p1, p0).normalize();
      const normal = c.crossVectors(velocity, nadir).normalize();
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
      if (this.craftBeacon) (this.craftBeacon.material as THREE.SpriteMaterial).opacity = (eclipsed ? 0.2 : 0.5) + 0.12 * Math.sin(this.time * 3);
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
    const ring = this.siteMarker?.getObjectByName("site-ring");
    if (ring) {
      const k = (this.time * 0.6) % 1;
      ring.scale.setScalar(0.6 + k * 1.8);
      ((ring as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 1 - k;
    }

    if (this.systemsView.visible) {
      this.bus.children[0]!.rotation.y += dt * 0.12;
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
