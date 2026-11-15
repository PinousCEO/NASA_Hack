"use client"; // Error boundaries must be Client Components
/**
 * What a player sees if a page fails: what went wrong, in the page's own words, and a way back in — not a black
 * screen. A page that was open while the game was updated asks for files that no longer exist; that case reloads
 * by itself, once.
 */
import { useEffect } from "react";

export default function Error({ error }: { error: Error & { digest?: string } }) {
  const stale = /ChunkLoadError|Loading chunk|dynamically imported module|Failed to fetch/i.test(`${error?.name} ${error?.message}`);
  useEffect(() => {
    if (!stale) return;
    try {
      if (sessionStorage.getItem("mf.reloaded") === location.href) return;
      sessionStorage.setItem("mf.reloaded", location.href);
    } catch { /* no storage: reload anyway */ }
    location.reload();
  }, [stale]);
  return (
    <div className="page center" style={{ minHeight: "100vh" }}>
      <div className="glass card" style={{ maxWidth: 520 }}>
        <div className="eyebrow">{stale ? "The game was updated" : "Something went wrong on this page"}</div>
        <h2 style={{ margin: "8px 0" }}>{stale ? "Reloading to the new version…" : "This view stopped working"}</h2>
        <p className="dim" style={{ fontSize: 13 }}>{stale ? "This page was open while a new version was installed." : "Your mission is safe on the server: nothing you did is lost. Reload to carry on."}</p>
        {!stale && <pre className="code" style={{ marginTop: 10, whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 160, overflow: "auto" }}>{String(error?.message ?? error).slice(0, 600)}</pre>}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
          <a className="btn ghost" href="/lobby">Back to missions</a>
        </div>
      </div>
    </div>
  );
}
