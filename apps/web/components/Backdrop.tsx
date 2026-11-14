"use client";
/** Animated space backdrop: starfield, a lit procedural planet and an orbiting spacecraft. Pure three.js. */
import { useEffect, useRef } from "react";
import type { BodyId } from "@/lib/scene/space";

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
      const { createPlanet, createStarfield, createFlowLine } = await import("@/lib/scene/space");
      const host = ref.current;
      if (stop || !host) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      } catch {
        return; // no WebGL: the CSS gradient backdrop remains
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      host.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
      const stars = createStarfield(variant === "hero" ? 7000 : 3500);
      scene.add(stars);
      const pivot = new THREE.Group();
      scene.add(pivot);
      const sun = new THREE.Vector3(-0.75, 0.35, 0.55).normalize();
      let planet = createPlanet(bodyRef.current);
      planet.setSun(sun);
      pivot.add(planet.group);
      swap.current = (b) => {
        pivot.remove(planet.group);
        planet.dispose();
        planet = createPlanet(b);
        planet.setSun(sun);
        pivot.add(planet.group);
      };
      // An inclined orbit with a spacecraft, purely illustrative on the landing pages.
      const ring = Array.from({ length: 181 }, (_, i) => {
        const a = (i / 180) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * 1.42, Math.sin(a) * 0.55, Math.sin(a) * 1.3);
      });
      const orbit = createFlowLine(ring, 0x4cc9f0, { dashes: 42, speed: 0.5, opacity: 0.85 });
      const craft = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), new THREE.MeshBasicMaterial({ color: 0x4cc9f0, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
      craft.add(glow);
      pivot.add(orbit, craft);
      pivot.position.set(variant === "hero" ? 1.55 : 2.4, variant === "hero" ? -0.1 : -0.9, 0);
      pivot.scale.setScalar(variant === "hero" ? 1.25 : 1.0);
      camera.position.set(0, 0, 6.2);

      const pointer = { x: 0, y: 0 };
      const onMove = (e: PointerEvent): void => {
        pointer.x = e.clientX / window.innerWidth - 0.5;
        pointer.y = e.clientY / window.innerHeight - 0.5;
      };
      const resize = (): void => {
        const { clientWidth: w, clientHeight: h } = host;
        renderer.setSize(w, h, false);
        camera.aspect = w / Math.max(1, h);
        // On narrow screens the planet moves behind the text instead of crowding it.
        pivot.position.x = (variant === "hero" ? 1.55 : 2.4) * Math.min(1, camera.aspect / 1.5) + (camera.aspect < 1 ? 0.6 : 0);
        camera.updateProjectionMatrix();
        (stars.material as any).uniforms.uPixelRatio.value = renderer.getPixelRatio();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("resize", resize);
      resize();
      const clock = new THREE.Clock();
      let t = 0;
      renderer.setAnimationLoop(() => {
        const dt = Math.min(0.05, clock.getDelta());
        t += dt;
        planet.group.rotation.y += dt * 0.035;
        orbit.material.uniforms.uTime!.value = t;
        craft.position.copy(ring[Math.floor(((t / 24) % 1) * 180)]!);
        (stars.material as any).uniforms.uTime.value = t;
        camera.position.x += (pointer.x * 0.5 - camera.position.x) * 0.03;
        camera.position.y += (-pointer.y * 0.35 - camera.position.y) * 0.03;
        camera.lookAt(0.4, 0, 0);
        stars.rotation.y = t * 0.004;
        renderer.render(scene, camera);
      });
      cleanup = () => {
        renderer.setAnimationLoop(null);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("resize", resize);
        planet.dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();
    return () => {
      stop = true;
      cleanup();
    };
  }, [variant]);

  return <div className="backdrop" ref={ref} aria-hidden />;
}
