import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

const display = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap" });
const body = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Mission Forge — Collaborative Space Mission Design Lab",
  description: "Design space missions together in mixed reality: real engineering models, an AI runtime builder, and a shared research record.",
};
export const viewport: Viewport = { themeColor: "#000000", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`} style={{ background: "#000", colorScheme: "dark" }} suppressHydrationWarning>
      <body style={{ background: "#000" }}>
        {/* The opening shutter plays once per visit, not on every page change. Runs before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: "try{if(sessionStorage.getItem('mf.boot'))document.documentElement.setAttribute('data-booted','1');else sessionStorage.setItem('mf.boot','1')}catch(e){}(function(){function cover(){if(document.getElementById('mf-cover'))return;var c=document.createElement('div');c.id='mf-cover';c.style.cssText='position:fixed;inset:0;background:#000;z-index:2147483647';document.documentElement.appendChild(c)}window.__go=function(u){cover();requestAnimationFrame(function(){requestAnimationFrame(function(){location.assign(u)})})};addEventListener('beforeunload',cover);addEventListener('pageshow',function(e){if(e.persisted)location.reload()});document.addEventListener('click',function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a||a.target||a.hasAttribute('download'))return;var u=new URL(a.href,location.href);if(u.origin!==location.origin||(u.pathname===location.pathname&&u.search===location.search&&u.hash))return;e.preventDefault();window.__go(u.href)})})()" }} />
        <div className="boot" aria-hidden />
        {children}
      </body>
    </html>
  );
}
