/** Reusable space-scene building blocks: procedural planets, atmosphere, starfield, flowing lines, text sprites. */
import * as THREE from "three";

const NOISE = /* glsl */ `
float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x), mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x), f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x), mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x), f.y), f.z); }
float fbm(vec3 p){ float a = 0.5, s = 0.0; for(int i=0;i<5;i++){ s += a*noise(p); p = p*2.03 + 11.7; a *= 0.5; } return s; }
`;

export type BodyId = "earth" | "moon" | "mars";
const PALETTE: Record<BodyId, { a: number; b: number; c: number; ocean: number; atmosphere: number | null }> = {
  moon: { a: 0x2b2d33, b: 0x8f9199, c: 0xd9dbe0, ocean: 0, atmosphere: null },
  earth: { a: 0x1f5a2e, b: 0x7a6a43, c: 0xf2f5f7, ocean: 1, atmosphere: 0x5aa9ff },
  mars: { a: 0x5a2415, b: 0xb8552f, c: 0xe3a377, ocean: 0, atmosphere: 0xff9a6b },
};

export interface Planet {
  group: THREE.Group;
  /** Set the Sun direction in world space. */
  setSun(direction: THREE.Vector3): void;
  dispose(): void;
}

/** A unit-radius procedural planet lit by a single Sun direction, with a soft terminator. */
export function createPlanet(body: BodyId, detail = 96): Planet {
  const p = PALETTE[body];
  const uniforms = {
    uSun: { value: new THREE.Vector3(1, 0.3, 0.4).normalize() },
    uA: { value: new THREE.Color(p.a) }, uB: { value: new THREE.Color(p.b) }, uC: { value: new THREE.Color(p.c) },
    uOcean: { value: p.ocean }, uCrater: { value: body === "moon" ? 1 : 0.25 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `varying vec3 vP; varying vec3 vN;
      void main(){ vP = position; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `precision highp float; varying vec3 vP; varying vec3 vN;
      uniform vec3 uSun, uA, uB, uC; uniform float uOcean, uCrater; ${NOISE}
      void main(){
        vec3 p = normalize(vP);
        float n = fbm(p * 2.6);
        float d = fbm(p * 9.0 + n * 2.0);
        float rim = smoothstep(0.52, 0.56, fbm(p * 5.5 + 3.1)) - smoothstep(0.58, 0.66, fbm(p * 5.5 + 3.1));
        vec3 col = mix(uA, uB, smoothstep(0.34, 0.68, n));
        col = mix(col, uC, smoothstep(0.56, 0.86, d) * 0.55);
        col += rim * uCrater * 0.12;
        float sea = uOcean * (1.0 - smoothstep(0.47, 0.5, n));
        col = mix(col, vec3(0.015, 0.09, 0.26), sea);
        float clouds = uOcean * smoothstep(0.58, 0.78, fbm(p * 4.2 + 20.0)) * 0.75;
        col = mix(col, vec3(1.0), clouds);
        float nl = dot(normalize(vN), normalize(uSun));
        float day = smoothstep(-0.08, 0.22, nl);
        vec3 lit = col * (0.02 + 1.25 * max(nl, 0.0));
        lit += sea * pow(max(dot(reflect(-normalize(uSun), normalize(vN)), normalize(cameraPosition - vP)), 0.0), 40.0) * 0.5;
        gl_FragColor = vec4(mix(col * 0.018, lit, day), 1.0);
      }`,
  });
  const group = new THREE.Group();
  const globe = new THREE.Mesh(new THREE.SphereGeometry(1, detail, detail / 2), material);
  globe.name = "planet";
  group.add(globe);
  let halo: THREE.ShaderMaterial | null = null;
  if (p.atmosphere !== null) {
    halo = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(p.atmosphere) }, uSun: uniforms.uSun },
      vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vV;
        void main(){ vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vV = normalize(cameraPosition - w.xyz); gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `precision highp float; varying vec3 vN; varying vec3 vV; uniform vec3 uColor, uSun;
        void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.6); float lit = smoothstep(-0.35, 0.5, dot(vN, normalize(uSun))); gl_FragColor = vec4(uColor, f * (0.25 + 0.9 * lit)); }`,
      side: THREE.BackSide, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(1.045, 64, 32), halo);
    shell.name = "atmosphere";
    group.add(shell);
  }
  return {
    group,
    setSun: (direction) => uniforms.uSun.value.copy(direction).normalize(),
    dispose: () => { globe.geometry.dispose(); material.dispose(); halo?.dispose(); },
  };
}

/** Star field on a distant shell, with per-star size and colour temperature. */
export function createStarfield(count = 5000, radius = 600): THREE.Points {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  let seed = 1337;
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < count; i++) {
    const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    positions.set([radius * s * Math.cos(t), radius * u, radius * s * Math.sin(t)], i * 3);
    const warm = rnd();
    colors.set([0.75 + 0.25 * warm, 0.8 + 0.15 * rnd(), 1.0 - 0.3 * warm], i * 3);
    sizes[i] = 0.6 + Math.pow(rnd(), 6) * 3.4;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 } },
    vertexShader: /* glsl */ `attribute float aSize; attribute vec3 color; varying vec3 vC; varying float vS; uniform float uTime, uPixelRatio;
      void main(){ vC = color; vS = aSize; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPixelRatio * (0.85 + 0.15 * sin(uTime * 1.3 + position.x * 0.31)); }`,
    fragmentShader: /* glsl */ `precision highp float; varying vec3 vC; varying float vS;
      void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC, a * a * (0.55 + 0.45 * min(vS / 2.0, 1.0))); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.name = "stars";
  points.frustumCulled = false;
  return points;
}

/** A polyline whose brightness flows along its length. `shadow` (0..1 per vertex) dims eclipsed stretches. */
export function createFlowLine(points: THREE.Vector3[], color: number, options: { closed?: boolean; shadow?: number[]; dashes?: number; speed?: number; opacity?: number } = {}): THREE.Line & { material: THREE.ShaderMaterial } {
  const n = points.length;
  const positions = new Float32Array(n * 3);
  const t = new Float32Array(n);
  const shadow = new Float32Array(n);
  points.forEach((p, i) => {
    positions.set([p.x, p.y, p.z], i * 3);
    t[i] = i / Math.max(1, n - 1);
    shadow[i] = options.shadow?.[i] ?? 0;
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aT", new THREE.BufferAttribute(t, 1));
  geometry.setAttribute("aShadow", new THREE.BufferAttribute(shadow, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uDashes: { value: options.dashes ?? 28 }, uSpeed: { value: options.speed ?? 0.25 }, uOpacity: { value: options.opacity ?? 1 }, uFlash: { value: 0 } },
    vertexShader: /* glsl */ `attribute float aT; attribute float aShadow; varying float vT; varying float vShadow;
      void main(){ vT = aT; vShadow = aShadow; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `precision highp float; varying float vT; varying float vShadow; uniform float uTime, uDashes, uSpeed, uOpacity, uFlash; uniform vec3 uColor;
      void main(){ float f = fract(vT * uDashes - uTime * uSpeed); float pulse = smoothstep(0.0, 0.25, f) * (1.0 - smoothstep(0.55, 1.0, f));
        vec3 c = mix(uColor, vec3(0.35, 0.4, 0.55), vShadow * 0.75) + uFlash;
        gl_FragColor = vec4(c, uOpacity * (0.3 + 0.7 * pulse) * (1.0 - 0.45 * vShadow) + uFlash); }`,
    transparent: true, depthWrite: false,
  });
  const line = (options.closed ? new THREE.LineLoop(geometry, material) : new THREE.Line(geometry, material)) as THREE.Line & { material: THREE.ShaderMaterial };
  line.frustumCulled = false;
  return line;
}

/** Billboard text label. `height` is the world-space height of the text block. */
export function createLabel(text: string, options: { color?: string; height?: number; background?: string | null; sub?: string } = {}): THREE.Sprite {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  const font = "600 44px ui-monospace, Consolas, monospace";
  ctx.font = font;
  const subFont = "400 30px ui-monospace, Consolas, monospace";
  const w = Math.ceil(Math.max(ctx.measureText(text).width, options.sub ? (ctx.font = subFont, ctx.measureText(options.sub).width) : 0)) + 48;
  const h = options.sub ? 124 : 80;
  canvas.width = w;
  canvas.height = h;
  if (options.background !== null) {
    ctx.fillStyle = options.background ?? "rgba(6, 12, 26, 0.78)";
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(120, 180, 255, 0.4)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.textBaseline = "middle";
  ctx.fillStyle = options.color ?? "#e8eefb";
  ctx.font = font;
  ctx.fillText(text, 24, options.sub ? 42 : h / 2);
  if (options.sub) {
    ctx.font = subFont;
    ctx.fillStyle = "#8a97b4";
    ctx.fillText(options.sub, 24, 90);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false }));
  const height = options.height ?? 0.12;
  sprite.scale.set((height * w) / h, height, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** Inertial equatorial frame (z = north) → three.js (y up). */
export const toView = (v: number[]): THREE.Vector3 => new THREE.Vector3(v[0], v[2], -v[1]!);

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
    for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
      (mat as THREE.SpriteMaterial).map?.dispose?.();
      mat.dispose();
    }
  });
}
