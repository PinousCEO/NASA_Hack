/**
 * Space-scene building blocks.
 *
 * Planets are textured with NASA imagery (LROC WAC, Viking MDIM 2.1, Blue Marble, VIIRS night
 * lights) and relief-shaded from NASA laser-altimeter elevation models (LOLA, MOLA), fetched
 * through the platform's cached proxy. A procedural surface is shown first and cross-fades to
 * the real data when it arrives, so nothing depends on the network being reachable.
 *
 * Every custom shader writes linear colour and ends with the tone-mapping and colour-space
 * chunks, so the same materials look identical on the bloom path (desktop) and the direct
 * path (XR).
 */
import * as THREE from "three";
import { CORE_ORIGIN } from "../api";

const NOISE = /* glsl */ `
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x), mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x), f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x), mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x), f.y), f.z); }
float fbm(vec3 p){ float a = 0.5, s = 0.0; for(int i=0;i<5;i++){ s += a*noise(p); p = p*2.03 + 11.7; a *= 0.5; } return s; }
`;
const OUTPUT = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>`;

export type BodyId = "earth" | "moon" | "mars";
export type Quality = "high" | "low";

let forced: Quality | null = null;
/** Pin the quality tier (used when the GPU turns out to be a software rasteriser). */
export function forceQuality(quality: Quality): void {
  forced = quality;
}

/** Headsets and phones get lighter textures and fewer stars. */
export function deviceQuality(): Quality {
  if (forced) return forced;
  if (typeof navigator === "undefined") return "high";
  return /OculusBrowser|Quest|Android|iPhone|iPad/i.test(navigator.userAgent) ? "low" : "high";
}

export const IMAGERY_CREDITS: Record<BodyId, string> = {
  moon: "Imagery: NASA/GSFC/Arizona State University (LROC WAC) · Relief: NASA/GSFC/MIT (LOLA)",
  mars: "Imagery: NASA/JPL/USGS (Viking MDIM 2.1) · Relief: NASA/GSFC (MOLA)",
  earth: "Imagery: NASA Blue Marble and VIIRS night lights (GIBS)",
};

// ---------- NASA imagery and terrain loading ----------
interface ImageryLayer { id: string; tileSize: number; levels: { z: number; cols: number; rows: number; degPerTile: number }[] }
let manifest: Promise<ImageryLayer[]> | null = null;
const imageryManifest = (): Promise<ImageryLayer[]> => (manifest ??= fetch(`${CORE_ORIGIN}/api/imagery`, { credentials: "include" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`imagery manifest ${r.status}`)))));

/** Assemble a whole-globe equirectangular texture (longitude −180…180, north up) from map tiles. */
async function loadGlobeTexture(layerId: string, z: number, maxSize: number): Promise<THREE.CanvasTexture> {
  const layer = (await imageryManifest()).find((l) => l.id === layerId);
  const level = layer?.levels.find((l) => l.z === z);
  if (!layer || !level) throw new Error(`no imagery level ${layerId}/${z}`);
  const pxPerDeg = layer.tileSize / level.degPerTile;
  const scale = Math.min(1, maxSize / (360 * pxPerDeg));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(360 * pxPerDeg * scale);
  canvas.height = Math.round(180 * pxPerDeg * scale);
  const ctx = canvas.getContext("2d")!;
  const size = layer.tileSize * scale;
  const jobs: Promise<void>[] = [];
  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      jobs.push((async () => {
        const res = await fetch(`${CORE_ORIGIN}/api/imagery/${layerId}/${z}/${row}/${col}.jpg`, { credentials: "include" });
        if (!res.ok) throw new Error(`tile ${layerId}/${z}/${row}/${col}: ${res.status}`);
        const bitmap = await createImageBitmap(await res.blob());
        // Tiles on the last row/column of some pyramids overhang the globe; the canvas clips them.
        ctx.drawImage(bitmap, Math.floor(col * size), Math.floor(row * size), Math.ceil(size), Math.ceil(size));
        bitmap.close();
      })());
    }
  }
  await Promise.all(jobs); // a missing tile would leave a hole: all or nothing
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}

/** Tangent-space normal map (east, north, up) from the body's elevation model, vertically exaggerated. */
async function loadReliefTexture(body: "moon" | "mars", radiusKm: number, exaggeration: number): Promise<THREE.DataTexture> {
  const res = await fetch(`${CORE_ORIGIN}/api/terrain/${body}/raster?width=1440`, { credentials: "include" });
  if (!res.ok) throw new Error(`terrain raster ${res.status}`);
  const heights = new Int16Array(await res.arrayBuffer());
  const w = Math.round(Math.sqrt(heights.length * 2));
  const h = w / 2;
  const data = new Uint8Array(w * h * 4);
  const north = (Math.PI * radiusKm * 1000) / h;
  const at = (x: number, y: number): number => heights[Math.max(0, Math.min(h - 1, y)) * w + ((x + w) % w)]!;
  const slice = slicer();
  for (let y = 0; y < h; y++) {
    await slice();
    const lat = Math.PI / 2 - ((y + 0.5) / h) * Math.PI;
    const east = Math.max(north * 0.08, north * Math.cos(lat));
    for (let x = 0; x < w; x++) {
      // The raster runs 0…360°E; the texture runs −180…180.
      const sx = (x + w / 2) % w;
      const dx = ((at(sx + 1, y) - at(sx - 1, y)) / (2 * east)) * exaggeration;
      const dy = ((at(sx, y - 1) - at(sx, y + 1)) / (2 * north)) * exaggeration;
      const inv = 1 / Math.hypot(dx, dy, 1);
      const o = ((h - 1 - y) * w + x) * 4; // DataTexture rows start at the bottom (v = 0)
      data[o] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

// ---------- CPU noise, evaluated in time slices (no shader compile, no frame ever blocked) ----------
/** Returns a function to await inside long loops: it yields to the browser every few milliseconds. */
function slicer(budgetMs = 5): () => Promise<void> {
  let started = performance.now();
  return async () => {
    if (performance.now() - started < budgetMs) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    started = performance.now();
  };
}
function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  return mix(
    mix(mix(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx), mix(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx), fy),
    mix(mix(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx), mix(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx), fy),
    fz,
  );
}
function fbm3(x: number, y: number, z: number, octaves = 4): number {
  let amplitude = 0.5, sum = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * noise3(x, y, z);
    x = x * 2.03 + 11.7; y = y * 2.03 + 11.7; z = z * 2.03 + 11.7;
    amplitude *= 0.5;
  }
  return sum;
}
/** Direction SphereGeometry gives a texel of an equirectangular map (row 0 at v = 0, the south pole). */
function texelDirection(x: number, y: number, w: number, h: number): [number, number, number] {
  const phi = ((x + 0.5) / w) * Math.PI * 2;
  const theta = (1 - (y + 0.5) / h) * Math.PI;
  return [-Math.cos(phi) * Math.sin(theta), Math.cos(theta), Math.sin(phi) * Math.sin(theta)];
}

/** Earth's cloud cover as a tileable-in-longitude noise map. */
async function bakeClouds(): Promise<THREE.DataTexture> {
  const w = 512, h = 256;
  const data = new Uint8Array(w * h * 4);
  const slice = slicer();
  for (let y = 0; y < h; y++) {
    await slice();
    for (let x = 0; x < w; x++) {
      const [dx, dy, dz] = texelDirection(x, y, w, h);
      const warp = noise3(dx * 7, dy * 7, dz * 7) * 0.9;
      const v = fbm3(dx * 3.6 + warp, dy * 3.6 + warp, dz * 3.6 + warp, 5);
      data.set([v * 255, v * 255, v * 255, 255], (y * w + x) * 4);
    }
  }
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// ---------- planets ----------
const PALETTE: Record<BodyId, { a: number; b: number; c: number; radiusKm: number; atmosphere: [number, number] | null }> = {
  moon: { a: 0x2b2d33, b: 0x8f9199, c: 0xd9dbe0, radiusKm: 1737.4, atmosphere: null },
  earth: { a: 0x1f5a2e, b: 0x7a6a43, c: 0xf2f5f7, radiusKm: 6378.137, atmosphere: [0x4d9bff, 0xff7a3c] },
  mars: { a: 0x5a2415, b: 0xb8552f, c: 0xe3a377, radiusKm: 3396.19, atmosphere: [0xd9a078, 0x6f8fd0] },
};

export interface Planet {
  group: THREE.Group;
  /** The rotating globe; children ride with the surface (site markers). */
  globe: THREE.Mesh;
  /** Set the Sun direction in world space. */
  setSun(direction: THREE.Vector3): void;
  /** How bright the unlit side is, as a share of the surface colour (a small table-top model needs more than a full-screen view). */
  setNightFloor(share: number): void;
  update(dt: number): void;
  /** Resolves true once NASA imagery is on screen, false if only the procedural surface is available. */
  ready: Promise<boolean>;
  dispose(): void;
}

/** A unit-radius planet lit by a single Sun direction. */
export function createPlanet(body: BodyId, options: { quality?: Quality; detail?: number } = {}): Planet {
  const p = PALETTE[body];
  const quality = options.quality ?? deviceQuality();
  const detail = options.detail ?? (quality === "high" ? 160 : 96);
  const blank = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, THREE.RGBAFormat);
  blank.needsUpdate = true;
  const uniforms = {
    uSun: { value: new THREE.Vector3(1, 0.3, 0.4).normalize() },
    uA: { value: new THREE.Color(p.b).multiplyScalar(0.55) },
    uAlbedo: { value: blank as THREE.Texture }, uRelief: { value: blank as THREE.Texture }, uNight: { value: blank as THREE.Texture },
    uTex: { value: 0 }, uReliefOn: { value: 0 }, uNightOn: { value: 0 },
    uEarth: { value: body === "earth" ? 1 : 0 }, uMars: { value: body === "mars" ? 1 : 0 }, uAirless: { value: body === "moon" ? 1 : 0 },
    uTime: { value: 0 }, uClouds: { value: blank as THREE.Texture }, uCloudOn: { value: 0 },
    uFloor: { value: 0.006 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `varying vec3 vObj; varying vec3 vN; varying vec3 vW; varying vec3 vAxis; varying vec2 vUv;
      void main(){ vObj = position; vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vAxis = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
        vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `precision highp float;
      varying vec3 vObj; varying vec3 vN; varying vec3 vW; varying vec3 vAxis; varying vec2 vUv;
      uniform vec3 uSun, uA; uniform sampler2D uAlbedo, uRelief, uNight;
      uniform sampler2D uClouds; uniform float uTex, uReliefOn, uNightOn, uEarth, uMars, uAirless, uTime, uCloudOn, uFloor;
      void main(){
        vec3 p = normalize(vObj);
        vec3 N = normalize(vN);
        vec3 V = normalize(cameraPosition - vW);
        vec3 S = normalize(uSun);
        vec3 tex = texture2D(uAlbedo, vUv).rgb;
        float texSea = uEarth * smoothstep(1.15, 1.6, tex.b / max(tex.r, 0.004)) * smoothstep(0.0, 0.03, tex.b);
        // Until imagery arrives the body is a plain tinted sphere; the texture then fades in.
        vec3 albedo = mix(uA, tex, uTex);
        float sea = texSea * uTex;
        // Relief from the elevation model, in the east / north / up frame of the surface point.
        vec3 T = normalize(cross(vAxis, N) + vec3(1e-5));
        vec3 B = cross(N, T);
        vec3 m = texture2D(uRelief, vUv).xyz * 2.0 - 1.0;
        vec3 Nr = normalize(mix(N, normalize(T * m.x + B * m.y + N * m.z), uReliefOn * (1.0 - sea)));
        float mu0 = dot(Nr, S);
        float mu = max(dot(N, V), 0.0);
        float lambert = max(mu0, 0.0);
        // Airless regolith scatters back towards the Sun: flatter than Lambert, with no limb darkening.
        float seeliger = 2.0 * lambert / (lambert + mu + 0.08);
        float diffuse = mix(lambert, seeliger * 0.62, uAirless * 0.75);
        float terminator = smoothstep(-0.02, 0.1, dot(N, S));
        vec3 lit = albedo * diffuse * terminator * 2.9;
        // Earth: clouds, sun glint on water, city lights, air.
        float cover = uCloudOn * smoothstep(0.42, 0.78, texture2D(uClouds, vUv + vec2(uTime * 0.0005, 0.0)).r);
        lit = mix(lit, vec3(2.6) * max(dot(N, S), 0.0) * terminator, cover * 0.86);
        vec3 R = reflect(-S, N);
        float glint = pow(max(dot(R, V), 0.0), 160.0) * 5.0 + pow(max(dot(R, V), 0.0), 18.0) * 0.22;
        lit += sea * (1.0 - cover) * glint * terminator * vec3(1.0, 0.95, 0.85);
        float nightSide = 1.0 - smoothstep(-0.18, 0.05, dot(N, S));
        lit += uNightOn * texture2D(uNight, vUv).rgb * vec3(1.0, 0.78, 0.5) * nightSide * (1.0 - cover * 0.7) * 2.4;
        float rim = pow(1.0 - mu, 3.2);
        float dayAir = smoothstep(-0.15, 0.4, dot(N, S));
        lit += uEarth * vec3(0.22, 0.45, 1.0) * rim * dayAir * 1.5;
        lit = mix(lit, lit * vec3(0.72, 0.84, 1.08) + vec3(0.02, 0.05, 0.11) * dayAir, uEarth * 0.35 * (1.0 - cover));
        lit += uMars * vec3(0.85, 0.5, 0.3) * rim * dayAir * 0.55;
        // A faint floor so the night side reads as a body, not a hole (earthshine / starlight).
        lit += albedo * uFloor;
        gl_FragColor = vec4(lit, 1.0);
        ${OUTPUT}
      }`,
  });
  const group = new THREE.Group();
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1, detail, detail / 2), material);
  globe.name = "planet";
  group.add(globe);
  let halo: THREE.ShaderMaterial | null = null;
  if (p.atmosphere) {
    const shellScale = body === "earth" ? 1.075 : 1.05;
    halo = new THREE.ShaderMaterial({
      uniforms: { uDay: { value: new THREE.Color(p.atmosphere[0]) }, uDusk: { value: new THREE.Color(p.atmosphere[1]) }, uSun: uniforms.uSun, uLimb: { value: Math.sqrt(1 - 1 / (shellScale * shellScale)) }, uStrength: { value: body === "earth" ? 1.5 : 0.5 } },
      vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV;
        void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `precision highp float; varying vec3 vN; varying vec3 vV; uniform vec3 uDay, uDusk, uSun; uniform float uLimb, uStrength;
        void main(){
          // Brightest where the line of sight grazes the surface, fading out into space.
          float g = pow(clamp(abs(dot(normalize(vN), normalize(vV))) / uLimb, 0.0, 1.0), 2.4);
          float s = dot(normalize(vN), normalize(uSun));
          vec3 c = mix(uDusk, uDay, smoothstep(-0.12, 0.38, s));
          float lit = smoothstep(-0.32, 0.18, s);
          gl_FragColor = vec4(c * g * lit * uStrength, g * lit);
          ${OUTPUT}
        }`,
      side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(shellScale, 96, 48), halo);
    shell.name = "atmosphere";
    group.add(shell);
  }

  let disposed = false;
  let fade = 0;
  let fading = false;
  const loaded: THREE.Texture[] = [blank];
  const maxSize = quality === "high" ? 8192 : 2048;
  const ready = (async (): Promise<boolean> => {
    try {
      const albedo = await loadGlobeTexture(body, 2, maxSize);
      if (disposed) {
        albedo.dispose();
        return false;
      }
      loaded.push(albedo);
      uniforms.uAlbedo.value = albedo;
      fading = true;
    } catch {
      return false; // offline or the platform server is not running: the procedural surface stays
    }
    // Everything below sharpens the picture; failures are harmless.
    const extras: Promise<void>[] = [];
    if (body !== "earth") {
      extras.push(loadReliefTexture(body, p.radiusKm, body === "moon" ? 7 : 12).then((t) => {
        if (disposed) return t.dispose();
        loaded.push(t);
        uniforms.uRelief.value = t;
        uniforms.uReliefOn.value = 1;
      }));
    } else {
      extras.push(loadGlobeTexture("earth-night", 2, maxSize).then((t) => {
        if (disposed) return t.dispose();
        loaded.push(t);
        uniforms.uNight.value = t;
        uniforms.uNightOn.value = 1;
      }));
    }
    if (body === "earth") {
      extras.push(bakeClouds().then((t) => {
        if (disposed) return t.dispose();
        loaded.push(t);
        uniforms.uClouds.value = t;
        uniforms.uCloudOn.value = 1;
      }));
    }
    await Promise.allSettled(extras);
    return true;
  })();

  return {
    group,
    globe,
    setSun: (direction) => uniforms.uSun.value.copy(direction).normalize(),
    setNightFloor: (share) => { uniforms.uFloor.value = share; },
    update(dt) {
      uniforms.uTime.value += dt;
      if (fading && fade < 1) {
        fade = Math.min(1, fade + dt / 1.4);
        uniforms.uTex.value = fade * fade * (3 - 2 * fade);
      }
    },
    ready,
    dispose() {
      disposed = true;
      globe.geometry.dispose();
      material.dispose();
      halo?.dispose();
      for (const t of loaded) t.dispose();
    },
  };
}

// ---------- sky ----------
export interface Sky {
  object: THREE.Group;
  update(dt: number, pixelRatio: number): void;
}

/** Stars with realistic brightness and colour statistics, over a faint procedural Milky Way. */
export function createSky(options: { count?: number; radius?: number; renderer?: THREE.WebGLRenderer } = {}): Sky {
  const count = options.count ?? (deviceQuality() === "high" ? 11000 : 4500);
  const radius = options.radius ?? 900;
  const galacticPole = new THREE.Vector3(0.42, 0.74, 0.52).normalize();
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  let seed = 1337;
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const dir = new THREE.Vector3();
  // Blackbody-ish tints from hot blue-white to cool orange.
  const tints = [[0.62, 0.74, 1.0], [0.8, 0.87, 1.0], [1.0, 1.0, 1.0], [1.0, 0.95, 0.82], [1.0, 0.84, 0.62], [1.0, 0.7, 0.48]];
  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      dir.set(s * Math.cos(t), u, s * Math.sin(t));
      // A third of the stars crowd the galactic plane.
      if (i % 3 !== 0 || Math.abs(dir.dot(galacticPole)) < 0.28 * rnd()) break;
    }
    positions.set([dir.x * radius, dir.y * radius, dir.z * radius], i * 3);
    const tint = tints[Math.min(tints.length - 1, Math.floor(Math.pow(rnd(), 0.7) * tints.length))]!;
    const magnitude = Math.pow(rnd(), 9); // few bright stars, many faint ones
    const brightness = 0.35 + magnitude * 3.2;
    colors.set([tint[0]! * brightness, tint[1]! * brightness, tint[2]! * brightness], i * 3);
    sizes[i] = 0.9 + magnitude * 5.5;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  const starMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 } },
    vertexShader: /* glsl */ `attribute float aSize; attribute vec3 color; varying vec3 vC; varying float vS; uniform float uTime, uPixelRatio;
      void main(){ vC = color; vS = aSize; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * (0.88 + 0.12 * sin(uTime * 1.7 + position.x * 0.31 + position.y * 0.17)); }`,
    fragmentShader: /* glsl */ `precision highp float; varying vec3 vC; varying float vS;
      void main(){ vec2 q = gl_PointCoord - 0.5; float d = length(q);
        float core = exp(-d * d * 42.0);
        float spikes = vS > 3.4 ? (exp(-abs(q.x) * 46.0) + exp(-abs(q.y) * 46.0)) * exp(-d * 5.0) * 0.55 : 0.0;
        float a = core + spikes;
        gl_FragColor = vec4(vC * a, a);
        ${OUTPUT}
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const stars = new THREE.Points(geometry, starMaterial);
  stars.frustumCulled = false;

  const galaxyDisplay = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.BackSide, depthWrite: false });
  void (async () => {
    // The Milky Way is soft: a 512 × 256 map, computed in slices on the CPU and stored as half floats.
    const w = 512, h = 256;
    const data = new Uint16Array(w * h * 4);
    const core = new THREE.Vector3(-0.78, 0.1, 0.49).normalize();
    const slice = slicer();
    for (let y = 0; y < h; y++) {
      await slice();
      for (let x = 0; x < w; x++) {
        const [dx, dy, dz] = texelDirection(x, y, w, h);
        const lat = dx * galacticPole.x + dy * galacticPole.y + dz * galacticPole.z;
        const toCore = Math.acos(Math.max(-1, Math.min(1, dx * core.x + dy * core.y + dz * core.z)));
        const c = Math.exp(-((toCore / 0.75) ** 2));
        const band = Math.exp(-((lat / (0.13 + 0.16 * c)) ** 2));
        let glow = 0;
        if (band > 0.004) {
          const cloud = fbm3(dx * 5, dy * 5, dz * 5) * 0.75 + fbm3(dx * 17, dy * 17, dz * 17, 3) * 0.25;
          const lane = fbm3(dx * 8.5 + 4, dy * 8.5 + 4, dz * 8.5 + 4);
          const dust = Math.min(1, Math.max(0, (lane - 0.42) / 0.28)) * Math.exp(-((lat / 0.07) ** 2));
          glow = band * (0.35 + 0.65 * cloud) * (0.35 + 1.3 * c) * (1 - 0.8 * dust);
        }
        const o = (y * w + x) * 4;
        data[o] = THREE.DataUtils.toHalfFloat((0.42 + 0.58 * c) * glow * 0.085 + 0.0016);
        data[o + 1] = THREE.DataUtils.toHalfFloat((0.5 + 0.32 * c) * glow * 0.085 + 0.0019);
        data[o + 2] = THREE.DataUtils.toHalfFloat((0.78 - 0.18 * c) * glow * 0.085 + 0.003);
        data[o + 3] = THREE.DataUtils.toHalfFloat(1);
      }
    }
    const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
    texture.wrapS = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    galaxyDisplay.map = texture;
    galaxyDisplay.color.set(0xffffff);
    galaxyDisplay.needsUpdate = true;
  })();
  const galaxy = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.05, 48, 24), galaxyDisplay);
  galaxy.frustumCulled = false;
  galaxy.renderOrder = -10;
  const object = new THREE.Group();
  object.name = "sky";
  object.add(galaxy, stars);
  return {
    object,
    update(dt, pixelRatio) {
      starMaterial.uniforms.uTime!.value += dt;
      starMaterial.uniforms.uPixelRatio!.value = pixelRatio;
    },
  };
}

let glareTexture: THREE.CanvasTexture | null = null;
function sunGlare(): THREE.CanvasTexture {
  if (glareTexture) return glareTexture;
  const size = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const c = size / 2;
  const radial = ctx.createRadialGradient(c, c, 0, c, c, c);
  radial.addColorStop(0, "rgba(255,255,255,1)");
  radial.addColorStop(0.04, "rgba(255,250,235,0.95)");
  radial.addColorStop(0.12, "rgba(255,225,170,0.32)");
  radial.addColorStop(0.35, "rgba(255,190,120,0.07)");
  radial.addColorStop(1, "rgba(255,160,90,0)");
  ctx.fillStyle = radial;
  ctx.fillRect(0, 0, size, size);
  ctx.globalCompositeOperation = "lighter";
  // Diffraction streaks.
  for (let k = 0; k < 6; k++) {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((k / 6) * Math.PI + 0.26);
    const streak = ctx.createLinearGradient(-c, 0, c, 0);
    streak.addColorStop(0, "rgba(255,220,170,0)");
    streak.addColorStop(0.5, k % 3 === 0 ? "rgba(255,240,215,0.5)" : "rgba(255,235,200,0.2)");
    streak.addColorStop(1, "rgba(255,220,170,0)");
    ctx.fillStyle = streak;
    ctx.fillRect(-c, -1.6, size, 3.2);
    ctx.restore();
  }
  glareTexture = new THREE.CanvasTexture(canvas);
  glareTexture.colorSpace = THREE.SRGBColorSpace;
  return glareTexture;
}

/** The Sun as a camera-facing glare, bright enough to bloom. Unit size; scale the group. */
export function createSun(): THREE.Group {
  const group = new THREE.Group();
  group.name = "sun";
  const glare = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunGlare(), color: new THREE.Color(3.2, 3.0, 2.7), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  glare.raycast = () => undefined; // decoration: never a pointer target
  glare.material.userData.shared = true; // the glare texture is reused by every Sun
  glare.scale.setScalar(2.4);
  const disc = new THREE.Mesh(new THREE.SphereGeometry(0.07, 24, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(14, 13, 11) }));
  group.add(disc, glare);
  return group;
}

/**
 * Image-based lighting for metallic spacecraft surfaces: black sky, one hard Sun, a broad
 * dim fill from the planet. `scene.environmentRotation` turns the Sun to the right place.
 */
function environmentSource(): { env: THREE.Scene; sky: THREE.Mesh } {
  const env = new THREE.Scene();
  const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: /* glsl */ `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `precision highp float; varying vec3 vD;
      void main(){ vec3 d = normalize(vD);
        float sun = smoothstep(0.985, 0.999, d.x) * 60.0 + pow(max(d.x, 0.0), 24.0) * 1.6;
        float planet = smoothstep(0.15, -0.75, d.y) * 0.5;            // light bounced up from below
        float horizon = exp(-pow((d.y + 0.1) / 0.12, 2.0)) * 0.22;     // thin bright limb line
        vec3 c = vec3(1.0, 0.96, 0.9) * sun + vec3(0.55, 0.6, 0.7) * planet + vec3(0.5, 0.65, 1.0) * horizon + vec3(0.012, 0.014, 0.02);
        gl_FragColor = vec4(c, 1.0); }`,
  }));
  env.add(sky);
  return { env, sky };
}

export function createEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const { env, sky } = environmentSource();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(env, 0.01).texture;
  pmrem.dispose();
  sky.geometry.dispose();
  (sky.material as THREE.Material).dispose();
  return texture;
}

/**
 * The same environment, with its shaders linked off the main thread first. Prefiltering an
 * environment compiles several heavy programs; done synchronously that freezes the page for
 * a noticeable moment. This reaches into the prefilter's internals to compile them ahead of
 * time, and falls back to the plain path if this build of three.js is shaped differently.
 */
export async function createEnvironmentAsync(renderer: THREE.WebGLRenderer): Promise<THREE.Texture> {
  const compile = (renderer as unknown as { compileAsync?(o: THREE.Object3D, c: THREE.Camera): Promise<unknown> }).compileAsync?.bind(renderer);
  const { env, sky } = environmentSource();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const internals = pmrem as unknown as { _setSize?(size: number): void; _allocateTargets?(): THREE.WebGLRenderTarget; _blurMaterial?: THREE.Material | null; _ggxMaterial?: THREE.Material | null; _lodMeshes?: THREE.Mesh[] };
  let scratch: THREE.WebGLRenderTarget | null = null;
  // The prefilter clears each cube face with a plain box; an identical material here lets that program be reused.
  const box = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({ side: THREE.BackSide, depthWrite: false, depthTest: false }));
  const previous = renderer.getRenderTarget();
  const tone = renderer.toneMapping;
  try {
    if (compile) {
      // Same cube size `fromScene` uses by default, so the materials built here are the ones it keeps.
      internals._setSize?.(256);
      scratch = internals._setSize ? (internals._allocateTargets?.() ?? null) : null;
      const geometry = internals._lodMeshes?.[0]?.geometry;
      if (scratch && geometry) {
        const holder = new THREE.Scene();
        for (const m of [internals._blurMaterial, internals._ggxMaterial]) if (m) holder.add(new THREE.Mesh(geometry, m));
        holder.add(box, new THREE.Mesh(sky.geometry, sky.material));
        renderer.setRenderTarget(scratch);
        renderer.toneMapping = THREE.NoToneMapping;
        await compile(holder, new THREE.OrthographicCamera());
      }
    }
  } catch {
    /* fall through: prefiltering below still works, it just compiles as it goes */
  } finally {
    renderer.toneMapping = tone;
    renderer.setRenderTarget(previous);
  }
  try {
    return pmrem.fromScene(env, 0.01).texture;
  } finally {
    scratch?.dispose();
    pmrem.dispose();
    box.geometry.dispose();
    (box.material as THREE.Material).dispose();
    sky.geometry.dispose();
    (sky.material as THREE.Material).dispose();
  }
}

// ---------- lines, ribbons ----------
type Flow<T> = T & { material: THREE.ShaderMaterial };
const FLOW_FRAGMENT = /* glsl */ `precision highp float; varying float vT; varying vec3 vLocal;
  uniform float uTime, uDashes, uSpeed, uOpacity, uFlash, uHead, uTrail, uShadowOn, uGap; uniform vec3 uColor, uSunLocal;
  void main(){
    float f = fract(vT * uDashes - uTime * uSpeed);
    float pulse = smoothstep(0.0, 0.2, f) * (1.0 - smoothstep(0.5, 1.0, f));
    // Inside the planet's shadow cylinder (unit radius, anti-sunward).
    float along = dot(vLocal, uSunLocal);
    float shadow = uShadowOn * step(along, 0.0) * step(length(vLocal - uSunLocal * along), 1.0);
    // In close-ups the ribbon parts around the spacecraft instead of running through it.
    float gap = mix(1.0, smoothstep(0.006, 0.05, min(fract(uHead - vT), fract(vT - uHead))), uGap);
    float trail = uTrail * (1.0 - uGap) * exp(-fract(uHead - vT) * 9.0) * 2.4;
    vec3 c = mix(uColor, vec3(0.16, 0.2, 0.34), shadow * 0.85) * (0.45 + 0.9 * pulse + trail) + uFlash * vec3(1.6, 1.5, 1.3);
    float a = uOpacity * (0.32 + 0.68 * pulse + trail * 0.4) * (1.0 - 0.4 * shadow) + uFlash;
    gl_FragColor = vec4(c * gap, clamp(a, 0.0, 1.0) * gap);
    ${OUTPUT}
  }`;
const flowUniforms = (color: number, o: { dashes?: number; speed?: number; opacity?: number; trail?: boolean; shadow?: boolean }): Record<string, THREE.IUniform> => ({
  uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uDashes: { value: o.dashes ?? 28 }, uSpeed: { value: o.speed ?? 0.25 }, uOpacity: { value: o.opacity ?? 1 },
  uFlash: { value: 0 }, uGap: { value: 0 }, uHead: { value: 0 }, uTrail: { value: o.trail ? 1 : 0 }, uShadowOn: { value: o.shadow ? 1 : 0 }, uSunLocal: { value: new THREE.Vector3(1, 0, 0) },
});

/** A polyline whose brightness flows along its length (cheap; vertices can be rewritten every frame). */
export function createFlowLine(points: THREE.Vector3[], color: number, options: { dashes?: number; speed?: number; opacity?: number } = {}): Flow<THREE.Line> {
  const n = points.length;
  const positions = new Float32Array(n * 3);
  const t = new Float32Array(n);
  points.forEach((p, i) => {
    positions.set([p.x, p.y, p.z], i * 3);
    t[i] = i / Math.max(1, n - 1);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aT", new THREE.BufferAttribute(t, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: flowUniforms(color, options),
    vertexShader: /* glsl */ `attribute float aT; varying float vT; varying vec3 vLocal;
      void main(){ vT = aT; vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: FLOW_FRAGMENT,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const line = new THREE.Line(geometry, material) as Flow<THREE.Line>;
  line.frustumCulled = false;
  return line;
}

/**
 * A glowing ribbon along a path, thick enough to read at a glance: a bright core inside a
 * soft halo. `trail` adds a comet tail behind `uHead` (0…1 along the path); `shadow` dims
 * the stretch inside the planet's shadow, evaluated per pixel from `uSunLocal`.
 */
export function createFlowTube(points: THREE.Vector3[], color: number, options: { closed?: boolean; radius?: number; dashes?: number; speed?: number; opacity?: number; trail?: boolean; shadow?: boolean; halo?: boolean } = {}): Flow<THREE.Mesh> {
  const curve = new THREE.CatmullRomCurve3(points, options.closed ?? false, "centripetal");
  const segments = Math.min(720, Math.max(64, points.length * 2));
  const radius = options.radius ?? 0.006;
  const geometry = new THREE.TubeGeometry(curve, segments, radius, 6, options.closed ?? false);
  const haloGeometry = new THREE.TubeGeometry(curve, segments, radius * 4.5, 6, options.closed ?? false);
  const uniforms = flowUniforms(color, options);
  const vertexShader = /* glsl */ `varying float vT; varying vec3 vLocal;
    void main(){ vT = uv.x; vLocal = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader: FLOW_FRAGMENT, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const haloMaterial = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: FLOW_FRAGMENT.replace("gl_FragColor = vec4(c * gap, clamp(a, 0.0, 1.0) * gap);", "gl_FragColor = vec4(c * gap * 0.16, clamp(a, 0.0, 1.0) * gap * 0.16);"),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const tube = new THREE.Mesh(geometry, material) as Flow<THREE.Mesh>;
  // Many overlapping revolutions would stack their halos into a fog: overlays draw the core only.
  if (options.halo !== false) tube.add(new THREE.Mesh(haloGeometry, haloMaterial));
  else {
    haloGeometry.dispose();
    haloMaterial.dispose();
    material.blending = THREE.NormalBlending;
  }
  tube.frustumCulled = false;
  return tube;
}

// ---------- labels ----------
function monoFont(): string {
  if (typeof document === "undefined") return "ui-monospace, Consolas, monospace";
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-plex-mono").trim();
  return `${family ? `${family}, ` : ""}ui-monospace, Consolas, monospace`;
}

/** Billboard callout: a hard-edged, cut-corner tag. `height` is the world-space height. */
export function createLabel(text: string, options: { color?: string; height?: number; background?: string | null; sub?: string } = {}): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const family = monoFont();
  const font = `600 44px ${family}`;
  const subFont = `400 29px ${family}`;
  ctx.font = font;
  const main = ctx.measureText(text).width;
  ctx.font = subFont;
  const sub = options.sub ? ctx.measureText(options.sub).width : 0;
  const w = Math.ceil(Math.max(main, sub)) + 62;
  const h = options.sub ? 124 : 80;
  canvas.width = w;
  canvas.height = h;
  const accent = options.color ?? "#f2efe8";
  if (options.background !== null) {
    ctx.fillStyle = options.background ?? "rgba(8, 8, 9, 0.82)";
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(w - 16, 0); ctx.lineTo(w, 16); ctx.lineTo(w, h); ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(242, 239, 232, 0.22)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.textBaseline = "middle";
  ctx.fillStyle = accent;
  ctx.font = font;
  ctx.fillText(text, 26, options.sub ? 42 : h / 2 + 2);
  if (options.sub) {
    ctx.font = subFont;
    ctx.fillStyle = "rgba(242, 239, 232, 0.62)";
    ctx.fillText(options.sub, 26, 92);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false, toneMapped: false }));
  const height = options.height ?? 0.12;
  sprite.scale.set((height * w) / h, height, 1);
  sprite.userData.labelBase = [(height * w) / h, height];
  // A sprite can only be hit-tested by a ray that knows its camera. A headset's controller ray has none, and
  // three.js then throws inside the frame loop, which stops the session's rendering for good. Such rays pass through.
  sprite.raycast = function (raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    if (!raycaster.camera) return;
    THREE.Sprite.prototype.raycast.call(this, raycaster, intersects);
  };
  sprite.renderOrder = 10;
  return sprite;
}

/** Inertial equatorial frame (z = north) → three.js (y up). */
export const toView = (v: number[]): THREE.Vector3 => new THREE.Vector3(v[0], v[2], -v[1]!);

/** Body-fixed latitude / east longitude → a point on the unit globe (matches the texture mapping). */
export function onGlobe(latDeg: number, lonDeg: number, radius = 1): THREE.Vector3 {
  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(lat) * Math.cos(lon) * radius, Math.sin(lat) * radius, -Math.cos(lat) * Math.sin(lon) * radius);
}

/**
 * Free an object's GPU resources. With `deferMaterials`, materials are released a moment
 * later: when an object is being replaced by one that uses the same shader, disposing first
 * would drop the compiled program and force the replacement to compile it again mid-frame.
 */
export function disposeObject(root: THREE.Object3D, deferMaterials = false): void {
  const late: THREE.Material[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      if (mat.userData.shared) continue; // library materials are reused across rebuilds
      if (deferMaterials) {
        late.push(mat);
        continue;
      }
      (mat as THREE.SpriteMaterial).map?.dispose?.();
      mat.dispose();
    }
  });
  if (late.length) setTimeout(() => { for (const mat of late) { (mat as THREE.SpriteMaterial).map?.dispose?.(); mat.dispose(); } }, 2500);
}
