"use client";
/** Motion primitives: scroll reveals, counting numbers, drawn sparklines and a telemetry ticker. */
import { useEffect, useRef, useState } from "react";

/** Adds `.in` to every `.reveal` element as it scrolls into view. Call once per page. */
export function useReveal(deps: unknown[] = []): void {
  useEffect(() => {
    const targets = [...document.querySelectorAll<HTMLElement>(".reveal:not(.in)")];
    if (!("IntersectionObserver" in window)) {
      targets.forEach((t) => t.classList.add("in"));
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      }
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    targets.forEach((t) => observer.observe(t));
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** A number that rolls from its previous value to the new one whenever it changes. */
export function Rolling({ value, digits = 0, duration = 900 }: { value: number; digits?: number; duration?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (!Number.isFinite(value)) return setShown(value);
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      const current = origin + (value - origin) * eased;
      from.current = current;
      setShown(current);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  if (!Number.isFinite(shown)) return <>—</>;
  return <>{shown.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}</>;
}

/** Counts up from zero the first time it is scrolled into view. */
export function CountUp({ to, digits = 0, suffix = "" }: { to: number; digits?: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [value, setValue] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) {
        setValue(to);
        observer.disconnect();
      }
    }, { threshold: 0.4 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [to]);
  return <span ref={ref}><Rolling value={value} digits={digits} duration={1800} />{suffix}</span>;
}

/** Endless strip of labelled read-outs. */
export function Ticker({ items }: { items: [string, string][] }) {
  const strip = [...items, ...items];
  return (
    <div className="ticker" aria-hidden>
      <div>{strip.map(([k, v], i) => <span key={i}><b>{k}</b>{v}</span>)}</div>
    </div>
  );
}

/** Small animated diagrams for the feature cards: each draws itself and keeps moving. */
export function Glyph({ kind }: { kind: "orbit" | "wave" | "plan" | "record" }) {
  const stroke = { fill: "none", stroke: "var(--signal)", strokeWidth: 1.4 } as const;
  const faint = { fill: "none", stroke: "var(--line-strong)", strokeWidth: 1 } as const;
  return (
    <svg className="viz" viewBox="0 0 240 64" preserveAspectRatio="xMinYMid meet" aria-hidden>
      {kind === "orbit" && (
        <>
          <circle cx="32" cy="32" r="13" {...faint} />
          <ellipse cx="32" cy="32" rx="28" ry="11" {...stroke} strokeDasharray="4 5"><animate attributeName="stroke-dashoffset" from="0" to="-90" dur="5s" repeatCount="indefinite" /></ellipse>
          <circle r="3" fill="var(--text)"><animateMotion dur="5s" repeatCount="indefinite" path="M4,32 a28,11 0 1,0 56,0 a28,11 0 1,0 -56,0" /></circle>
          <path d="M84 32 H236" {...faint} strokeDasharray="2 6" />
          {[0, 1, 2].map((i) => <rect key={i} x={96 + i * 46} y="22" width="30" height="20" {...faint}><animate attributeName="stroke" values="var(--line-strong);var(--signal);var(--line-strong)" dur="3s" begin={`${i * 0.5}s`} repeatCount="indefinite" /></rect>)}
        </>
      )}
      {kind === "wave" && (
        <>
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((i) => (
            <rect key={i} x={2 + i * 12} y="10" width="6" height="44" fill="var(--signal)" opacity={0.25 + (i % 5) * 0.15} transform-origin={`${5 + i * 12} 54`}>
              <animateTransform attributeName="transform" type="scale" values={`1 ${0.2 + ((i * 7) % 10) / 12};1 ${0.9 - ((i * 3) % 10) / 16};1 ${0.2 + ((i * 7) % 10) / 12}`} dur={`${1.4 + (i % 4) * 0.35}s`} repeatCount="indefinite" />
            </rect>
          ))}
        </>
      )}
      {kind === "plan" && (
        <>
          <path d="M14 32 H70 M70 32 L104 14 M70 32 L104 50 M104 14 H160 M104 50 H160 M160 14 L194 32 M160 50 L194 32 M194 32 H228" {...stroke} strokeDasharray="300" strokeDashoffset="300"><animate attributeName="stroke-dashoffset" values="300;0;0;300" keyTimes="0;0.45;0.85;1" dur="5s" repeatCount="indefinite" /></path>
          {[[14, 32], [70, 32], [104, 14], [104, 50], [160, 14], [160, 50], [194, 32], [228, 32]].map(([x, y], i) => (
            <rect key={i} x={x! - 4} y={y! - 4} width="8" height="8" fill="#000" stroke="var(--text)" strokeWidth="1.2" transform={`rotate(45 ${x} ${y})`}><animate attributeName="fill" values="#000;var(--signal);#000" dur="5s" begin={`${i * 0.28}s`} repeatCount="indefinite" /></rect>
          ))}
        </>
      )}
      {kind === "record" && (
        <>
          {[0, 1, 2, 3].map((i) => (
            <g key={i}>
              <rect x="2" y={6 + i * 14} width="8" height="8" fill="var(--signal)"><animate attributeName="opacity" values="0.2;1;0.2" dur="2.4s" begin={`${i * 0.4}s`} repeatCount="indefinite" /></rect>
              <rect x="18" y={8 + i * 14} height="4" fill="var(--line-strong)"><animate attributeName="width" values={`0;${120 + ((i * 53) % 90)};${120 + ((i * 53) % 90)}`} keyTimes="0;0.5;1" dur="4s" begin={`${i * 0.4}s`} repeatCount="indefinite" /></rect>
            </g>
          ))}
        </>
      )}
    </svg>
  );
}
