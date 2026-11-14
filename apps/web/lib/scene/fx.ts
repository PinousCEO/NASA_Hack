/**
 * Cinematic finishing for the desktop view: HDR bloom, filmic tone mapping and a light film
 * grade. Headsets render straight to the display (post-processing costs too much there and
 * would break passthrough), so everything bright is also authored to read without bloom.
 */
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

/** Filmic defaults shared by every renderer in the app. */
export function gradeRenderer(renderer: THREE.WebGLRenderer): void {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

/** Vignette, a touch of chromatic fringing at the edges, and animated grain. Runs after tone mapping. */
const GradeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null }, uTime: { value: 0 }, uStrength: { value: 1 } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `precision highp float; varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uTime, uStrength;
    float rnd(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 shift = c * r2 * 0.012 * uStrength;
      vec3 col = vec3(texture2D(tDiffuse, vUv + shift).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - shift).b);
      col *= 1.0 - smoothstep(0.18, 0.95, r2 * 1.9) * 0.55 * uStrength;
      col += (rnd(vUv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5) * 0.028 * uStrength;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/** True when WebGL is running on a CPU rasteriser (SwiftShader, llvmpipe): effects are skipped there. */
export function softwareGl(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext();
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    return /swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch {
    return false;
  }
}

export interface Fx {
  /** Render one frame through the effect chain. */
  render(dt: number): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  dispose(): void;
}

export function createFx(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, options: { bloom?: number; threshold?: number; radius?: number } = {}): Fx {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // Multisampled HDR target: geometry edges stay clean and highlights keep their energy for the bloom.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), options.bloom ?? 0.55, options.radius ?? 0.55, options.threshold ?? 1.35);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  return {
    render(dt) {
      grade.uniforms.uTime!.value += dt;
      composer.render(dt);
    },
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
    },
    dispose() {
      composer.dispose();
      target.dispose();
    },
  };
}

/**
 * Route a renderer's ordinary `render(scene, camera)` calls for one scene through the effect
 * chain. Used where a framework owns the render loop (IWSDK): the effect is skipped whenever
 * `enabled()` is false — in XR — and for every render the chain itself issues.
 */
export function interceptRender(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, enabled: () => boolean): { fx: Fx; restore(): void } | null {
  let fx: Fx;
  try {
    fx = createFx(renderer, scene, camera);
  } catch {
    return null; // no float render targets: plain rendering still works
  }
  const direct = renderer.render.bind(renderer);
  let inside = false;
  let last = performance.now();
  let width = 0, height = 0, ratio = 0;
  renderer.render = (s: THREE.Object3D, c: THREE.Camera): void => {
    if (inside || s !== scene || !enabled() || renderer.xr.isPresenting) return direct(s, c);
    const el = renderer.domElement;
    const r = renderer.getPixelRatio();
    if (el.clientWidth !== width || el.clientHeight !== height || r !== ratio) {
      width = el.clientWidth; height = el.clientHeight; ratio = r;
      fx.setSize(Math.max(1, width), Math.max(1, height), r);
    }
    const now = performance.now();
    inside = true;
    try {
      fx.render(Math.min(0.1, (now - last) / 1000));
    } finally {
      inside = false;
      last = now;
    }
  };
  return {
    fx,
    restore() {
      renderer.render = direct;
      fx.dispose();
    },
  };
}
