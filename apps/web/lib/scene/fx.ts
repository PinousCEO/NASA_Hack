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
  // Reading shader logs forces every program to finish linking on the main thread; keep that for development builds.
  renderer.debug.checkShaderErrors = process.env.NODE_ENV !== "production";
}

type CompileAsync = (object: THREE.Object3D, camera: THREE.Camera, target?: THREE.Scene | null) => Promise<unknown>;
/** `renderer.compileAsync`, when this three.js build has it: links programs off the main thread where the browser allows. */
export const compileAsyncOf = (renderer: THREE.WebGLRenderer): CompileAsync | null => {
  const fn = (renderer as unknown as { compileAsync?: CompileAsync }).compileAsync;
  return typeof fn === "function" ? fn.bind(renderer) : null;
};

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

/**
 * Makes the HDR frame safe to blur. One pixel that is not a number (a glint that overflowed,
 * a normal of zero length) is enough for the bloom's wide blur to smear "not a number" over
 * the whole picture, which shows as a single black frame. This pass replaces such pixels with
 * black and caps the rest, before anything is blurred.
 */
const SanitizeShader = {
  uniforms: { tDiffuse: { value: null as THREE.Texture | null } },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `precision highp float; varying vec2 vUv; uniform sampler2D tDiffuse;
    // Comparisons with "not a number" are false, so anything that fails both tests is replaced by zero.
    float safe(float v){ return (v >= 0.0 && v <= 64.0) ? v : (v > 64.0 ? 64.0 : 0.0); }
    void main(){ vec4 c = texture2D(tDiffuse, vUv); gl_FragColor = vec4(safe(c.r), safe(c.g), safe(c.b), 1.0); }`,
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
  /**
   * Compile every program the scene and this chain will use, without blocking the page.
   * A program's variant depends on where it is drawn: inside the chain the scene renders into
   * a linear HDR target, so that is the variant compiled here — compiling against the screen
   * would build programs that are never used and leave the real ones to stall the first frame.
   */
  warm(): Promise<void>;
  dispose(): void;
}

export function createFx(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, options: { bloom?: number; threshold?: number; radius?: number } = {}): Fx {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  // Multisampled HDR target: geometry edges stay clean and highlights keep their energy for the bloom.
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const sanitize = new ShaderPass(SanitizeShader);
  composer.addPass(sanitize);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), options.bloom ?? 0.55, options.radius ?? 0.55, options.threshold ?? 1.35);
  composer.addPass(bloom);
  const output = new OutputPass();
  composer.addPass(output);
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
    async warm() {
      const compile = compileAsyncOf(renderer);
      if (!compile) return;
      const previous = renderer.getRenderTarget();
      // The same full-screen triangle the passes draw with (position + uv), so the program keys match.
      const triangle = new THREE.BufferGeometry();
      triangle.setAttribute("position", new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
      triangle.setAttribute("uv", new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
      const quads = (materials: (THREE.Material | undefined)[]): THREE.Scene => {
        const holder = new THREE.Scene();
        for (const m of materials) if (m) holder.add(new THREE.Mesh(triangle, m));
        return holder;
      };
      try {
        // The output pass picks its tone-mapping defines on first render; set them now so they compile here.
        const out = output as unknown as { material: THREE.RawShaderMaterial; _outputColorSpace: unknown; _toneMapping: unknown };
        if (out._toneMapping !== renderer.toneMapping || out._outputColorSpace !== renderer.outputColorSpace) {
          const tone: Record<number, string> = { [THREE.LinearToneMapping]: "LINEAR_TONE_MAPPING", [THREE.ReinhardToneMapping]: "REINHARD_TONE_MAPPING", [THREE.CineonToneMapping]: "CINEON_TONE_MAPPING", [THREE.ACESFilmicToneMapping]: "ACES_FILMIC_TONE_MAPPING", [THREE.AgXToneMapping]: "AGX_TONE_MAPPING", [THREE.NeutralToneMapping]: "NEUTRAL_TONE_MAPPING", [THREE.CustomToneMapping]: "CUSTOM_TONE_MAPPING" };
          out.material.defines = {};
          if (THREE.ColorManagement.getTransfer(renderer.outputColorSpace) === THREE.SRGBTransfer) out.material.defines.SRGB_TRANSFER = "";
          const define = tone[renderer.toneMapping];
          if (define) out.material.defines[define] = "";
          out.material.needsUpdate = true;
          out._outputColorSpace = renderer.outputColorSpace;
          out._toneMapping = renderer.toneMapping;
        }
        const b = bloom as unknown as { materialHighPassFilter?: THREE.Material; separableBlurMaterials?: THREE.Material[]; compositeMaterial?: THREE.Material; blendMaterial?: THREE.Material };
        renderer.setRenderTarget(target);
        await Promise.all([
          compile(scene, camera),
          compile(quads([(sanitize as unknown as { material: THREE.Material }).material, b.materialHighPassFilter, ...(b.separableBlurMaterials ?? []), b.compositeMaterial, b.blendMaterial, out.material]), camera),
        ]);
        // The last pass draws to the screen.
        renderer.setRenderTarget(null);
        await compile(quads([(grade as unknown as { material: THREE.Material }).material]), camera);
      } catch {
        /* warming is an optimisation: anything left over compiles on first use */
      } finally {
        renderer.setRenderTarget(previous);
        triangle.dispose();
      }
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
export function interceptRender(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, enabled: () => boolean): { fx: Fx; hold(on: boolean): void; restore(): void } | null {
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
  let held = false;
  renderer.render = (s: THREE.Object3D, c: THREE.Camera): void => {
    // While programs are still linking, drawing the scene would force each one to finish on the main thread.
    if (held && s === scene && !renderer.xr.isPresenting) return;
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
    hold(on) {
      held = on;
    },
    restore() {
      renderer.render = direct;
      fx.dispose();
    },
  };
}
