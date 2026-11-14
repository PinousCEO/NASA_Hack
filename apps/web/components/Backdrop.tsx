"use client";
/**
 * Cinematic space backdrop: a planet textured from NASA imagery, a flight-hardware spacecraft
 * on a glowing orbit, the Sun with bloom, and (from the Moon) Earth in the distance.
 * The camera drifts, follows the pointer and pulls back as the page scrolls.
 */
import { useEffect, useRef } from "react";
import type { BodyId } from "@/lib/scene/space";

const DEMO_CRAFT = {
  busDryMassKg: 180,
  components: [
    { type: "solar_panel", areaM2: 2.2 }, { type: "solar_panel", areaM2: 2.2 },
    { type: "antenna", diameterM: 0.9 },
    { type: "instrument", kind: "camera", apertureM: 0.2 }, { type: "instrument", kind: "neutron_spectrometer" },
  ],
};

export default function Backdrop({ body = "moon", variant = "ambient" }: { body?: BodyId; variant?: "hero" | "ambient" }) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef(body);
  const swap = useRef<((b: BodyId) => void) | null>(null);

  useEffect(() => {
    if (bodyRef.current !== body) {
      bodyRef.current = body;
      swap.current?.(body);
    }
  }, [body]);

  useEffect(() => {
    let stop = false;
    let cleanup = (): void => {};
    void (async () => {
      const THREE = await import("three");
      const { createPlanet, createSky, createFlowTube, createSun, createEnvironmentAsync, forceQuality } = await import("@/lib/scene/space");
      const { buildSpacecraft } = await import("@/lib/scene/models");
      const { compileAsyncOf, createFx, gradeRenderer, softwareGl } = await import("@/lib/scene/fx");
      const host = ref.current;
      if (stop || !host) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        // Keep the last picture in the canvas: if a frame is ever presented without a draw, the scene stays up instead of blinking to black.
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true });
      } catch {
        return; // no WebGL: the CSS backdrop remains
      }
      const hero = variant === "hero";
      const slow = softwareGl(renderer);
      if (slow) forceQuality("low");
      renderer.setPixelRatio(slow ? 0.5 : Math.min(window.devicePixelRatio, 1.5));
      renderer.shadowMap.enabled = !slow;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      gradeRenderer(renderer);
      host.appendChild(renderer.domElement);
      // A canvas whose context is going away (page change, context loss) can show as a blank rectangle for a frame: hide it instead.
      const hideCanvas = (): void => { renderer.domElement.style.visibility = "hidden"; };
      const showCanvas = (): void => { renderer.domElement.style.visibility = ""; };
      window.addEventListener("pagehide", hideCanvas);
      renderer.domElement.addEventListener("webglcontextlost", hideCanvas);
      renderer.domElement.addEventListener("webglcontextrestored", showCanvas);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x000000);
      const camera = new THREE.PerspectiveCamera(hero ? 34 : 40, 1, 0.05, 3000);
      const sky = createSky({ renderer });
      scene.add(sky.object);

      const sunDir = new THREE.Vector3(-0.72, 0.34, 0.6).normalize();
      const sun = createSun();
      sun.position.copy(sunDir).multiplyScalar(60);
      sun.scale.setScalar(hero ? 15 : 10);
      scene.add(sun);
      const key = new THREE.DirectionalLight(0xfff4e6, 3.6);
      key.castShadow = !slow;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.bias = -0.0004;
      key.shadow.normalBias = 0.002;
      Object.assign(key.shadow.camera, { left: -0.45, right: 0.45, top: 0.45, bottom: -0.45, near: 10, far: 30 });
      key.shadow.camera.updateProjectionMatrix();
      scene.add(key, key.target, new THREE.HemisphereLight(0x8fa6d6, 0x1a1410, 0.2));
      try {
        scene.environment = await createEnvironmentAsync(renderer);
        if (stop) return;
        scene.environmentIntensity = 0.9;
        scene.environmentRotation.setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(sunDir, new THREE.Vector3(1, 0, 0)));
      } catch { /* direct light only */ }

      const pivot = new THREE.Group();
      scene.add(pivot);
      let planet = createPlanet(bodyRef.current);
      planet.setSun(sunDir);
      pivot.add(planet.group);

      // Earth, far behind the Moon.
      let earth: ReturnType<typeof createPlanet> | null = null;
      const placeEarth = (b: BodyId): void => {
        if (b === "moon" && !earth) {
          earth = createPlanet("earth", { quality: "low", detail: 64 });
          earth.setSun(sunDir);
          earth.group.position.set(15.5, 8.4, -40);
          earth.group.scale.setScalar(1.9);
          earth.group.rotation.set(0.4, 2.4, 0.2);
          scene.add(earth.group);
        }
        if (earth) earth.group.visible = b === "moon";
      };
      placeEarth(bodyRef.current);
      swap.current = (b) => {
        pivot.remove(planet.group);
        planet.dispose();
        planet = createPlanet(b);
        planet.setSun(sunDir);
        pivot.add(planet.group);
        placeEarth(b);
      };

      // An inclined orbit that sweeps in front of the planet, with the spacecraft enlarged to be seen.
      const ring = Array.from({ length: 240 }, (_, i) => {
        const a = (i / 240) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * 1.5, Math.sin(a) * 0.5, Math.sin(a) * 1.42);
      });
      const orbit = createFlowTube(ring, 0x35e0d0, { closed: true, radius: 0.004, dashes: 44, speed: 0.45, opacity: 0.9, trail: true, shadow: true });
      orbit.material.uniforms.uSunLocal!.value.copy(sunDir);
      const craft = buildSpacecraft(DEMO_CRAFT);
      const holder = new THREE.Group();
      craft.group.scale.setScalar((hero ? 0.2 : 0.13) / craft.radius);
      holder.add(craft.group);
      pivot.add(orbit, holder);

      const base = { x: hero ? 1.45 : 2.3, y: hero ? -0.12 : -0.95, scale: hero ? 1.32 : 1.0 };
      pivot.scale.setScalar(base.scale);
      camera.position.set(0, 0.1, 6.4);

      let fx: ReturnType<typeof createFx> | null = null;
      if (!slow) {
        try {
          fx = createFx(renderer, scene, camera, { bloom: 0.7, threshold: 1.0, radius: 0.6 });
        } catch {
          fx = null;
        }
      }

      const pointer = { x: 0, y: 0 };
      let scroll = 0;
      const onMove = (e: PointerEvent): void => {
        pointer.x = e.clientX / window.innerWidth - 0.5;
        pointer.y = e.clientY / window.innerHeight - 0.5;
      };
      const onScroll = (): void => {
        scroll = Math.min(1.6, window.scrollY / Math.max(1, window.innerHeight));
      };
      const resize = (): void => {
        const { clientWidth: w, clientHeight: h } = host;
        renderer.setSize(w, h, false);
        fx?.setSize(w, h, renderer.getPixelRatio());
        camera.aspect = w / Math.max(1, h);
        // On narrow screens the planet moves behind the text instead of crowding it.
        pivot.position.x = base.x * Math.min(1, camera.aspect / 1.5) + (camera.aspect < 1 ? 0.5 : 0);
        camera.updateProjectionMatrix();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", resize);
      resize();
      onScroll();

      // Parallel shader compilation where the browser supports it: the page stays responsive while programs link.
      if (fx) await fx.warm();
      else await compileAsyncOf(renderer)?.(scene, camera)?.catch(() => undefined);
      if (stop) return;
      const clock = new THREE.Clock();
      const nadir = new THREE.Vector3(), velocity = new THREE.Vector3(), normal = new THREE.Vector3(), up = new THREE.Vector3(), sunBody = new THREE.Vector3();
      const basis = new THREE.Matrix4();
      const inverse = new THREE.Quaternion();
      let t = 0;
      let arrive = 0;
      let skip = 0;
      renderer.setAnimationLoop(() => {
        // On a CPU rasteriser draw every fourth frame so the page stays responsive.
        if (slow && skip++ % 4 !== 0) return;
        const dt = Math.min(slow ? 0.2 : 0.05, clock.getDelta());
        t += dt;
        arrive = Math.min(1, arrive + dt / 3.6);
        const settle = 1 - Math.pow(1 - arrive, 3);
        planet.update(dt);
        earth?.update(dt);
        planet.globe.rotation.y += dt * 0.022;
        sky.update(dt, renderer.getPixelRatio());
        sky.object.rotation.y = t * 0.0035;

        const phase = (t / 52 + 0.13) % 1;
        const f = phase * ring.length;
        const i = Math.floor(f) % ring.length;
        const p0 = ring[i]!, p1 = ring[(i + 1) % ring.length]!;
        holder.position.lerpVectors(p0, p1, f - Math.floor(f));
        orbit.material.uniforms.uTime!.value = t;
        orbit.material.uniforms.uHead!.value = phase;
        nadir.copy(holder.position).normalize().negate();
        velocity.subVectors(p1, p0).normalize();
        normal.crossVectors(sunDir, nadir);
        if (normal.lengthSq() < 1e-4) normal.crossVectors(velocity, nadir);
        normal.normalize();
        up.crossVectors(nadir, normal).normalize();
        craft.group.quaternion.setFromRotationMatrix(basis.makeBasis(normal, up, nadir));
        sunBody.copy(sunDir).applyQuaternion(inverse.copy(craft.group.quaternion).invert());
        const track = Math.atan2(sunBody.z, sunBody.y);
        for (const drive of craft.wings) {
          drive.rotation.x = track;
          drive.children[0]!.scale.x = 0.04 + 0.96 * settle;
        }
        holder.getWorldPosition(key.target.position);
        key.position.copy(key.target.position).addScaledVector(sunDir, 20);
        const blink = Math.sin(t * 4) > 0.2;
        for (const led of craft.leds) led.visible = blink;

        // Arrival push-in, pointer parallax, and a pull-back as the page scrolls.
        const distance = 6.4 + (1 - settle) * 5 + scroll * 1.6;
        const tx = pointer.x * 0.55 + Math.sin(t * 0.07) * 0.12;
        const ty = -pointer.y * 0.4 + 0.1 + scroll * 0.7;
        camera.position.x += (tx - camera.position.x) * 0.035;
        camera.position.y += (ty - camera.position.y) * 0.035;
        camera.position.z += (distance - camera.position.z) * 0.06;
        pivot.position.y = base.y + scroll * 0.45;
        camera.lookAt(0.45, scroll * 0.3, 0);
        if (fx) fx.render(dt);
        else renderer.render(scene, camera);
      });
      host.dataset.ready = "1";
      cleanup = () => {
        renderer.setAnimationLoop(null);
        window.removeEventListener("pagehide", hideCanvas);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", resize);
        planet.dispose();
        earth?.dispose();
        fx?.dispose();
        scene.environment?.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();
    return () => {
      stop = true;
      cleanup();
    };
  }, [variant]);

  return <div className={`backdrop is-${variant}`} ref={ref} aria-hidden />;
}
