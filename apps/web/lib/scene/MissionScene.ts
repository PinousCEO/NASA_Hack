/**
 * The mission as a 3D scene, built entirely from authoritative mission state
 * (configuration + derived results). Used unchanged by the desktop view and the WebXR
 * workspace: the host decides where `root` sits and how it is scaled.
 *
 *  orbit view    planet (1 unit = body radius), orbit with eclipsed arc, spacecraft, Sun
 *  systems view  the spacecraft's components (1 unit = 1 m) with animated power/data flows
 *
 * Everything in `root` is expressed in the mission frame, so participant poses and object
 * transforms can be shared between people whose rooms have different origins.
 */
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { MissionVersion, Presence } from "../api";
import { CORE_ORIGIN } from "../api";
import { type BodyId, createFlowLine, createLabel, createPlanet, disposeObject, type Planet, toView } from "./space";

export type ViewMode = "orbit" | "systems";
export const BODY_RADIUS_KM: Record<BodyId, number> = { earth: 6378.137, moon: 1737.4, mars: 3396.19 };
const TYPE_COLOR: Record<string, number> = { solar_panel: 0x3b82f6, battery: 0x3ddc97, antenna: 0xdfe7f5, load: 0x8a97b4, instrument: 0xffd166 };
const OBLIQUITY = (23.43928 * Math.PI) / 180;
const ECLIPTIC_POLE = new THREE.Vector3(0, Math.cos(OBLIQUITY), Math.sin(OBLIQUITY));

type FlowLine = ReturnType<typeof createFlowLine>;
interface Connector { line: FlowLine; from: THREE.Object3D; to: THREE.Object3D; lift: number }

export class MissionScene {
  readonly root = new THREE.Group();
  readonly orbitView = new THREE.Group();
  readonly systemsView = new THREE.Group();
  /** Component id → its object in the systems view (pickable / grabbable). */
  readonly componentObjects = new Map<string, THREE.Object3D>();
  readonly sunLight = new THREE.DirectionalLight(0xffffff, 2.6);
  mode: ViewMode = "orbit";
  mission: MissionVersion | null = null;
  /** Called when the set of component objects is rebuilt (hosts re-attach interactions). */
  onRebuild: (() => void) | null = null;

  private planet: Planet | null = null;
  private body: BodyId | null = null;
  private orbitLine: FlowLine | null = null;
  private orbitPath: THREE.Vector3[] = [];
  private craft = new THREE.Group();
  private craftPhase = 0;
  private sunBase = new THREE.Vector3(1, 0, 0);
  private sunLocal = new THREE.Vector3(1, 0, 0);
  private sunGlyph = new THREE.Group();
  private bus = new THREE.Group();
  private connectors: Connector[] = [];
  private avatars = new Map<string, THREE.Group>();
  private rings = new Map<string, THREE.Mesh>();
  private held = new Set<string>();
  private loader = new GLTFLoader();
  private cache = new Map<string, Promise<THREE.Object3D>>();
  private flash = 0;
  private time = 0;
  private signature = "";

  constructor() {
    this.root.name = "mission-root";
    this.root.add(this.orbitView, this.systemsView, this.sunLight, new THREE.AmbientLight(0x8fa8d8, 0.55));
    this.systemsView.visible = false;
    this.orbitView.add(this.craft, this.sunGlyph);
    if (CORE_ORIGIN) this.loader.setWithCredentials(true);
    // Sun marker: a small bright disc far along the Sun direction with an arrow at the planet.
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 12), new THREE.MeshBasicMaterial({ color: 0xfff1c4 }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 12), new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false }));
    const label = createLabel("SUN", { height: 0.09, color: "#ffd166", background: null });
    label.position.y = 0.3;
    this.sunGlyph.add(glow, halo, label);
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
    }
    const lighting = mission.derived["scene.lighting"]?.value;
    if (lighting?.sunDirection) this.sunBase.copy(toView(lighting.sunDirection)).normalize();
    this.sunLocal.copy(this.sunBase);
    this.rebuildOrbit();
    this.rebuildCraft();
    // The systems view is rebuilt only when components or their placement change.
    const signature = JSON.stringify([config.spacecraft.components.map((c: any) => [c.id, c.type, c.areaM2, c.diameterM, c.capacityWh, c.name]), config.scene.nodes, config.assets.map((a: any) => a.id)]);
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
    if (this.orbitLine) {
      this.orbitView.remove(this.orbitLine);
      disposeObject(this.orbitLine);
      this.orbitLine = null;
    }
    for (const o of this.orbitView.children.filter((c) => c.userData.transient)) {
      this.orbitView.remove(o);
      disposeObject(o);
    }
    if (!traj?.pathKm) return;
    this.orbitPath = (traj.pathKm as number[][]).map((p) => toView(p.map((v) => v / R)));
    // Mark the stretch of orbit inside the planet's shadow cylinder (what the eclipse model computes).
    const s = this.sunLocal;
    const shadow = this.orbitPath.map((p) => {
      const along = p.dot(s);
      return along < 0 && p.clone().addScaledVector(s, -along).length() < 1 ? 1 : 0;
    });
    this.orbitLine = createFlowLine(this.orbitPath, 0x4cc9f0, { shadow, dashes: 36, speed: 0.6 });
    this.orbitView.add(this.orbitLine);
    const current = toView((traj.currentPositionKm as number[]).map((v) => v / R));
    this.craftPhase = this.orbitPath.reduce((best, p, i) => (p.distanceToSquared(current) < this.orbitPath[best]!.distanceToSquared(current) ? i : best), 0) / this.orbitPath.length;

    const el = mission.derived["orbit.elements"]?.value;
    const ecl = mission.derived["orbit.eclipse"]?.value;
    if (el) {
      const tag = createLabel(`${el.periapsisAltitudeKm.toFixed(0)} km · ${(el.periodS / 60).toFixed(0)} min`, { height: 0.085, sub: ecl ? `β ${ecl.betaDeg.toFixed(0)}° · eclipse ${(ecl.eclipseFraction * 100).toFixed(0)}%` : undefined });
      tag.position.copy(this.orbitPath[Math.floor(this.orbitPath.length * 0.12)]!).multiplyScalar(1.22);
      tag.userData.transient = true;
      this.orbitView.add(tag);
    }
    const rover = mission.config.rover;
    if (rover) {
      const marker = new THREE.Group();
      marker.userData.transient = true;
      const pin = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.07, 12), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
      pin.rotation.x = Math.PI;
      pin.position.y = -1.04;
      const tag = createLabel(rover.name.toUpperCase(), { height: 0.075, color: "#ffd166", sub: `${rover.site.name} · ${rover.site.slopeDeg}° slope` });
      tag.position.set(0.32, -1.16, 0);
      marker.add(pin, tag);
      this.orbitView.add(marker);
    }
  }

  /** A stylised spacecraft whose proportions follow the design: array area, dish size, instruments. */
  private rebuildCraft(): void {
    disposeObject(this.craft);
    this.craft.clear();
    const comps: any[] = this.mission!.config.spacecraft.components;
    const model = new THREE.Group();
    const busMat = new THREE.MeshStandardMaterial({ color: 0xc9a227, metalness: 0.7, roughness: 0.35, emissive: 0x3a2c05 });
    model.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.7), busMat));
    const area = comps.filter((c) => c.type === "solar_panel").reduce((s, c) => s + c.areaM2, 0);
    const span = Math.min(2.4, 0.5 + Math.sqrt(area) * 0.55);
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.BoxGeometry(span, 0.02, 0.5), new THREE.MeshStandardMaterial({ color: 0x1b3a8a, metalness: 0.5, roughness: 0.3, emissive: 0x0a1a45 }));
      wing.position.x = side * (0.25 + span / 2 + 0.05);
      model.add(wing);
    }
    const dish = comps.find((c) => c.type === "antenna" && c.diameterM);
    if (dish) {
      const d = new THREE.Mesh(new THREE.SphereGeometry(Math.min(0.6, 0.18 + dish.diameterM * 0.3), 24, 10, 0, Math.PI * 2, 0, Math.PI / 3), new THREE.MeshStandardMaterial({ color: 0xe8eefb, metalness: 0.4, roughness: 0.4, side: THREE.DoubleSide }));
      d.position.y = 0.55;
      d.rotation.x = Math.PI;
      model.add(d);
    }
    comps.filter((c) => c.type === "instrument").forEach((_, i) => {
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.3, 14), new THREE.MeshStandardMaterial({ color: 0xffd166, metalness: 0.6, roughness: 0.3, emissive: 0x4a3606 }));
      scope.rotation.x = Math.PI / 2;
      scope.position.set(-0.16 + (i % 3) * 0.16, -0.12 + Math.floor(i / 3) * 0.2, 0.45);
      model.add(scope);
    });
    model.scale.setScalar(0.075);
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    const name = createLabel(this.mission!.config.spacecraft.name.toUpperCase(), { height: 0.07, color: "#4cc9f0" });
    name.position.y = 0.14;
    this.craft.add(model, beacon, name);
  }

  private primitive(c: any): THREE.Object3D {
    const mat = new THREE.MeshStandardMaterial({ color: TYPE_COLOR[c.type] ?? 0xffffff, metalness: 0.55, roughness: 0.38, emissive: new THREE.Color(TYPE_COLOR[c.type] ?? 0xffffff).multiplyScalar(0.12) });
    switch (c.type) {
      case "solar_panel": return new THREE.Mesh(new THREE.BoxGeometry(Math.sqrt(c.areaM2 * 2), 0.03, Math.sqrt(c.areaM2 / 2)), mat);
      case "battery": { const s = Math.cbrt(c.capacityWh / 250 / 1000) * 2.2; return new THREE.Mesh(new THREE.BoxGeometry(s * 1.5, s * 0.7, s), mat); }
      case "antenna": {
        const r = (c.diameterM ?? 0.25) / 2;
        const dish = new THREE.Mesh(new THREE.SphereGeometry(r * 1.6, 28, 10, 0, Math.PI * 2, 0, Math.PI / 4.2), mat);
        mat.side = THREE.DoubleSide;
        dish.rotation.x = Math.PI;
        dish.position.y = r * 1.6;
        const g = new THREE.Group();
        g.add(dish);
        return g;
      }
      case "instrument": return c.apertureM ? new THREE.Mesh(new THREE.CylinderGeometry(c.apertureM / 2 + 0.03, c.apertureM / 2 + 0.05, 0.45, 20), mat) : new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.22, 0.32), mat);
      default: return new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.22), mat);
    }
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
      disposeObject(o);
    }
    this.componentObjects.clear();
    this.rings.clear();
    this.connectors = [];
    const config = this.mission!.config;
    const comps: any[] = config.spacecraft.components;

    this.bus = new THREE.Group();
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.6), new THREE.MeshStandardMaterial({ color: 0x1a2440, metalness: 0.8, roughness: 0.3, emissive: 0x0a1228 }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(core.geometry), new THREE.LineBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.8 }));
    const busLabel = createLabel(config.spacecraft.name.toUpperCase(), { height: 0.16, color: "#4cc9f0", sub: `bus ${config.spacecraft.busDryMassKg} kg` });
    busLabel.position.y = 0.62;
    this.bus.add(core, edges, busLabel);
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
        const tier = { solar_panel: 0.0, battery: -0.35, antenna: 0.45, instrument: 0.2, load: -0.2 }[c.type as string] ?? 0;
        holder.position.set(Math.cos(angle) * 1.25, tier, Math.sin(angle) * 1.25);
      }
      const body = this.primitive(c);
      holder.add(body);
      const assetRecord = node?.assetId ? config.assets.find((a: any) => a.id === node.assetId) : null;
      if (assetRecord) {
        // Versioned, content-addressed GLB generated by the runtime builder replaces the stand-in.
        void this.asset(assetRecord.uri).then((model) => {
          holder.remove(body);
          disposeObject(body);
          holder.add(model);
        }).catch(() => undefined);
      }
      const tag = createLabel(c.name, { height: 0.15, sub: this.metric(c) });
      tag.position.y = 0.5;
      tag.name = "label";
      holder.add(tag);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.008, 8, 48), new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0 }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = -0.2;
      holder.add(ring);
      this.rings.set(c.id, ring);
      this.systemsView.add(holder);
      this.componentObjects.set(c.id, holder);
    });

    // Engineering connections: power flows array → bus → consumers, data flows instruments → antennas.
    const link = (from: THREE.Object3D, to: THREE.Object3D, color: number, speed: number, lift: number): void => {
      const line = createFlowLine(Array.from({ length: 24 }, () => new THREE.Vector3()), color, { dashes: 7, speed, opacity: 0.9 });
      this.systemsView.add(line);
      this.connectors.push({ line, from, to, lift });
    };
    const antennas = comps.filter((c) => c.type === "antenna");
    for (const c of comps) {
      const obj = this.componentObjects.get(c.id)!;
      if (c.type === "solar_panel") link(obj, this.bus, 0xffd166, 1.6, 0.25);
      else if (c.type === "battery") link(this.bus, obj, 0x3ddc97, 0.8, 0.2);
      else link(this.bus, obj, 0xffa94d, 0.5 + Math.min(1.5, (c.powerW ?? c.dcPowerW ?? 10) / 60), 0.2);
      if (c.type === "instrument") for (const a of antennas) link(obj, this.componentObjects.get(a.id)!, 0x4cc9f0, 0.8 + Math.min(2, Math.log10(1 + c.dataRateBps) / 4), 0.6);
    }
    this.onRebuild?.();
  }

  private refreshLabels(): void {
    for (const c of this.mission!.config.spacecraft.components as any[]) {
      const holder = this.componentObjects.get(c.id);
      const old = holder?.getObjectByName("label");
      if (!holder || !old) continue;
      const tag = createLabel(c.name, { height: 0.15, sub: this.metric(c) });
      tag.position.copy(old.position);
      tag.name = "label";
      holder.remove(old);
      disposeObject(old);
      holder.add(tag);
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
    if (this.mission && this.orbitLine) this.rebuildOrbit();
  }

  /** Flash the systems that were just recalculated (visible confirmation of a synchronised change). */
  pulse(): void {
    this.flash = 1;
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
        const visor = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.09, 0.1), new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 0.6, roughness: 0.3 }));
        visor.name = "head";
        const tag = createLabel(p.displayName, { height: 0.06, color: p.color });
        tag.position.y = 0.14;
        visor.add(tag);
        const hand = (): THREE.Mesh => new THREE.Mesh(new THREE.SphereGeometry(0.035, 14, 10), new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 0.8 }));
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

  // ---------- per-frame ----------
  update(dt: number): void {
    this.time += dt;
    const worldQuat = this.root.getWorldQuaternion(new THREE.Quaternion());
    const sunWorld = this.sunLocal.clone().applyQuaternion(worldQuat);
    this.planet?.setSun(sunWorld);
    this.sunLight.position.copy(this.sunLocal).multiplyScalar(20);
    this.sunGlyph.position.copy(this.sunLocal).multiplyScalar(this.extent * 1.35);
    this.flash = Math.max(0, this.flash - dt * 1.4);
    if (this.orbitLine) {
      this.orbitLine.material.uniforms.uTime!.value = this.time;
      this.orbitLine.material.uniforms.uFlash!.value = this.flash * 0.6;
    }
    if (this.orbitPath.length > 1) {
      // One orbit every 30 seconds of wall-clock time, regardless of the true period.
      this.craftPhase = (this.craftPhase + dt / 30) % 1;
      const f = this.craftPhase * this.orbitPath.length;
      const i = Math.floor(f) % this.orbitPath.length;
      const a = this.orbitPath[i]!;
      const b = this.orbitPath[(i + 1) % this.orbitPath.length]!;
      this.craft.position.lerpVectors(a, b, f - Math.floor(f));
      this.craft.children[0]!.lookAt(this.craft.position.clone().add(b.clone().sub(a)));
      const s = this.sunLocal;
      const along = this.craft.position.dot(s);
      const eclipsed = along < 0 && this.craft.position.clone().addScaledVector(s, -along).length() < 1;
      ((this.craft.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(eclipsed ? 0x5b6b8c : 0xffffff);
    }
    if (this.systemsView.visible) {
      this.bus.rotation.y += dt * 0.05;
      const a = new THREE.Vector3(), b = new THREE.Vector3(), mid = new THREE.Vector3();
      for (const c of this.connectors) {
        a.copy(c.from.position);
        b.copy(c.to.position);
        mid.addVectors(a, b).multiplyScalar(0.5);
        mid.y += c.lift;
        const pos = c.line.geometry.getAttribute("position") as THREE.BufferAttribute;
        for (let k = 0; k < pos.count; k++) {
          const t = k / (pos.count - 1);
          const u = 1 - t;
          pos.setXYZ(k, u * u * a.x + 2 * u * t * mid.x + t * t * b.x, u * u * a.y + 2 * u * t * mid.y + t * t * b.y, u * u * a.z + 2 * u * t * mid.z + t * t * b.z);
        }
        pos.needsUpdate = true;
        c.line.material.uniforms.uTime!.value = this.time;
        c.line.material.uniforms.uFlash!.value = this.flash * 0.5;
      }
    }
  }

  dispose(): void {
    disposeObject(this.root);
    this.planet?.dispose();
  }
}
