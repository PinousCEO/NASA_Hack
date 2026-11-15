// Builds the final report: fills the generated sections of reports/report-body.md from the state
// files, writes the Markdown, renders it to PDF with headless Edge, and checks the PDF that came out
// (page count, Korean text present, no secret-looking strings).
// Usage: node reports/tools/build-report.mjs
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.resolve("package.json"));
const { chromium } = require("playwright-core");
const ROOT = process.cwd();
const NAME = "Pinous_Final_Development_Report_2026-11-15";
const read = (f, d = "") => { try { return fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { return d; } };
const ko = JSON.parse(read("reports/tools/req-ko.json", "{}"));
// The table is shown in Korean where a translation exists; the English originals stay in requirements.json.
const reqs = JSON.parse(read("requirements.json", '{"requirements":[]}')).requirements.map((r) => ({ ...r, requirement: ko[r.id]?.[0] || r.requirement, actual: ko[r.id]?.[1] || r.actual }));
const state = JSON.parse(read("WORK_STATE.json", "{}"));
const log = read("WORK_LOG.jsonl").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const kstNow = new Date(Date.now() + 9 * 3600000).toISOString().replace("T", " ").slice(0, 16) + " KST";
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const STATUS_KO = { PASS: "PASS", FAIL: "FAIL", NOT_STARTED: "미구현", IN_PROGRESS: "작업 중", IMPLEMENTED_NOT_VERIFIED: "구현·미검증", BLOCKED_EXTERNAL: "외부 차단" };

const counts = {};
for (const r of reqs) counts[r.status] = (counts[r.status] ?? 0) + 1;
const summary = Object.entries(counts).map(([k, v]) => `${STATUS_KO[k] ?? k} ${v}`).join(" · ");
const table = (rows) => ["| ID | 요구사항 | 구현 위치 | 사용자 조작 경로 | 검증 방법 | 실제 결과 | 증거 | 상태 |", "|---|---|---|---|---|---|---|---|", ...rows.map((r) => `| ${r.id} | ${esc(r.requirement)} | ${esc(r.where)} | ${esc(r.userPath)} | ${esc(r.verify)} | ${esc(r.actual)} | ${esc(r.evidence)} | **${STATUS_KO[r.status] ?? r.status}** |`)].join("\n");
const open = reqs.filter((r) => r.status !== "PASS");
const hookLines = log.filter((l) => l.source === "stop-hook");
const tokens = {
  GENERATED_AT: kstNow,
  STARTED_AT: state.startedAt ?? "",
  ENDS_AT: state.endsAt ?? "",
  BASE_COMMIT: state.baseCommit ?? "",
  HEAD: (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim(); } catch { return "?"; } })(),
  DIRTY: (() => { try { return String(execFileSync("git", ["status", "--short"], { cwd: ROOT }).toString().split("\n").filter(Boolean).length); } catch { return "?"; } })(),
  VERIFICATION_SUMMARY: (() => {
    let sum; try { sum = JSON.parse(read("reports/evidence/summary.json")); } catch { return "(전체 재실행 요약이 아직 없다: `node reports/tools/run-all-evidence.mjs`)"; }
    const kind = (k) => k.replace("code level; language model is a test double", "코드 수준, 언어 모델은 테스트 더블").replace("real browser, own fresh server, no language model, XR in the IWER emulator", "실제 브라우저, 자체 새 서버, 언어 모델 없음, XR은 IWER 에뮬레이터").replace("two real browsers, LIVE language model", "실제 브라우저 2개, **실제 언어 모델**").replace("real browser, LIVE language model", "실제 브라우저, **실제 언어 모델**").replace("real browser + WebXR emulator (IWER)", "실제 브라우저 + **WebXR 에뮬레이터**").replace("four real HTTP+WebSocket clients", "실제 HTTP·WebSocket 클라이언트 4개").replace("server API, no language model", "서버 API, 언어 모델 없음").replace("two real browsers, built-in analyser (no language model)", "실제 브라우저 2개, 내장 분석기(언어 모델 없음)").replace("real browser, built-in analyser (no language model)", "실제 브라우저, 내장 분석기(언어 모델 없음)").replace("real browser, two roles", "실제 브라우저, 역할 2종").replace("real browser", "실제 브라우저");
    return [`실행: ${sum.started} – ${sum.finished} · 합계 **${sum.total}개 검사 통과, ${sum.failed}개 실패** (${sum.rows.length}개 실행)`, "", "| 검증 | 종류 | 통과 | 실패 | 결과 | 소요 |", "|---|---|---|---|---|---|", ...sum.rows.map((r) => `| ${r.label} | ${kind(r.kind)} | ${r.passed} | ${r.failed} | **${r.ok ? "PASS" : "FAIL"}** | ${r.seconds}초 |`)].join("\n");
  })(),
  SUMMARY_COUNTS: `${reqs.length}개 항목: ${summary}`,
  REQUIREMENTS_TABLE: table(reqs.filter((r) => !/^E\d+$/.test(r.id))),
  SCENARIO_TABLE: table(reqs.filter((r) => /^E\d+$/.test(r.id))),
  OPEN_ITEMS: open.length ? open.map((r) => `- **${r.id}** (${STATUS_KO[r.status] ?? r.status}) ${r.requirement} — ${r.actual || "아직 결과 없음"}`).join("\n") : "없음",
  HOOK_LOG: hookLines.length ? hookLines.map((l) => `- ${l.at} · ${l.event}${l.minutesLeft !== undefined ? ` · 남은 시간 ${l.minutesLeft}분` : ""}${l.why ? ` · ${l.why}` : ""}`).join("\n") : "- (기록 없음)",
  WORK_LOG: log.filter((l) => l.source === "worker" && l.event !== "requirement").map((l) => `- ${l.kst ?? l.at} · ${l.event}${l.current ? ` · ${l.current}` : ""}${l.note ? ` · ${l.note}` : ""}`).join("\n"),
};
let md = read("reports/report-body.md");
if (!md) { console.error("reports/report-body.md is missing"); process.exit(1); }
md = md.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in tokens ? tokens[k] : m));
fs.writeFileSync(path.join(ROOT, "reports", `${NAME}.md`), md);

// ---- Markdown → HTML (the subset the report uses) ----
const inline = (s) => s
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => `<img alt="${alt}" src="${src}">`)
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  .replace(/`([^`]+)`/g, "<code>$1</code>")
  .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
  .replace(/\\\|/g, "|");
function toHtml(src) {
  const out = [];
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  const cells = (l) => l.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre>${buf.join("\n").replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\|/.test(l) && /^\|[\s:|-]+\|?$/.test(lines[i + 1] ?? "")) {
      const head = cells(l); i += 2; const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table class="c${head.length}"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) { const items = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, "")); out.push(`<ul>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`); continue; }
    if (/^\s*\d+\.\s+/.test(l)) { const items = []; while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, "")); out.push(`<ol>${items.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`); continue; }
    if (/^---+$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\||```|\s*[-*]\s|\s*\d+\.\s|---+$)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}
const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${NAME}</title><style>
@page { size: A4; margin: 16mm 14mm 16mm 14mm; }
* { box-sizing: border-box; }
body { font-family: "Malgun Gothic", "맑은 고딕", "Noto Sans KR", "Segoe UI", sans-serif; font-size: 10pt; line-height: 1.55; color: #16181d; word-break: keep-all; overflow-wrap: anywhere; }
h1 { font-size: 21pt; margin: 0 0 4pt; border-bottom: 2.5pt solid #ff5a1f; padding-bottom: 6pt; }
h2 { font-size: 14.5pt; margin: 20pt 0 6pt; border-bottom: 0.8pt solid #c9ccd3; padding-bottom: 3pt; break-after: avoid; }
h3 { font-size: 11.5pt; margin: 13pt 0 4pt; break-after: avoid; }
h4 { font-size: 10.5pt; margin: 10pt 0 3pt; break-after: avoid; }
p { margin: 4pt 0 6pt; } ul, ol { margin: 3pt 0 7pt; padding-left: 16pt; } li { margin: 1.5pt 0; }
code { font-family: Consolas, "Cascadia Code", monospace; font-size: 8.6pt; background: #f1f2f5; padding: 0.5pt 3pt; border-radius: 2pt; overflow-wrap: anywhere; }
pre { font-family: Consolas, monospace; font-size: 8.2pt; background: #f4f5f7; border: 0.6pt solid #d8dbe1; padding: 6pt 8pt; white-space: pre-wrap; overflow-wrap: anywhere; break-inside: avoid; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; table-layout: fixed; font-size: 8pt; line-height: 1.38; }
th, td { border: 0.6pt solid #b9bdc7; padding: 3pt 4pt; vertical-align: top; text-align: left; overflow-wrap: anywhere; word-break: break-word; }
th { background: #eceef2; font-weight: 700; } tr { break-inside: avoid; } thead { display: table-header-group; }
table.c8 { font-size: 6.9pt; } table.c8 th:nth-child(1), table.c8 td:nth-child(1) { width: 6.5%; } table.c8 th:nth-child(2) { width: 17%; } table.c8 th:nth-child(3) { width: 13%; } table.c8 th:nth-child(4) { width: 10%; } table.c8 th:nth-child(5) { width: 11%; } table.c8 th:nth-child(6) { width: 22%; } table.c8 th:nth-child(7) { width: 13.5%; } table.c8 th:nth-child(8) { width: 7%; }
table.c8 code, table code { font-size: 6.6pt; background: none; padding: 0; }
img { max-width: 100%; border: 0.6pt solid #b9bdc7; margin: 4pt 0 2pt; break-inside: avoid; }
hr { border: 0; border-top: 0.6pt solid #c9ccd3; margin: 12pt 0; }
a { color: #0b57d0; text-decoration: none; }
</style></head><body>${toHtml(md)}</body></html>`;
const htmlFile = path.join(ROOT, "reports", `${NAME}.html`);
let printable = html;
const jpgDir = path.join(ROOT, "reports", "evidence", "ui", "_pdf");
fs.mkdirSync(jpgDir, { recursive: true });
for (const m of html.matchAll(/<img alt="[^"]*" src="([^"]+[.]png)">/g)) {
  const src = path.join(ROOT, "reports", m[1]);
  const dst = path.join(jpgDir, path.basename(m[1], ".png") + ".jpg");
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", src, "-vf", "scale=1500:-2", "-q:v", "4", dst]);
    printable = printable.split(`src="${m[1]}"`).join(`src="evidence/ui/_pdf/${path.basename(dst)}"`);
  } catch { /* keep the PNG */ }
}
fs.writeFileSync(htmlFile, printable);
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage();
await page.goto("file:///" + htmlFile.replace(/\\/g, "/"), { waitUntil: "load" });
const broken = await page.evaluate(() => [...document.images].filter((im) => !im.complete || im.naturalWidth === 0).map((im) => im.getAttribute("src")));
const overflow = await page.evaluate(() => [...document.querySelectorAll("table, pre, img")].filter((e) => e.scrollWidth > e.clientWidth + 2).length);
const pdfFile = path.join(ROOT, "reports", `${NAME}.pdf`);
await page.pdf({ path: pdfFile, format: "A4", printBackground: true, displayHeaderFooter: true, headerTemplate: "<span></span>", footerTemplate: `<div style="font-size:7pt;width:100%;text-align:center;color:#777;font-family:'Malgun Gothic',sans-serif">Pinous · Mission Forge 최종 개발 보고서 · <span class="pageNumber"></span> / <span class="totalPages"></span></div>`, margin: { top: "16mm", bottom: "16mm", left: "14mm", right: "14mm" } });
// What the pages look like: the same engine, in print layout, cut into A4-sized pictures for a visual check.
const pagesDir = path.join(ROOT, "reports", "evidence", "report-pages");
fs.rmSync(pagesDir, { recursive: true, force: true });
fs.mkdirSync(pagesDir, { recursive: true });
const view = await browser.newPage({ viewport: { width: 688, height: 973 }, deviceScaleFactor: 1.6 });
await view.emulateMedia({ media: "print" });
await view.goto("file:///" + htmlFile.split("\\").join("/"), { waitUntil: "load" });
const total = await view.evaluate(() => document.documentElement.scrollHeight);
const shots = Math.min(40, Math.ceil(total / 973));
for (let n = 0; n < shots; n++) await view.screenshot({ path: path.join(pagesDir, `view-${String(n + 1).padStart(2, "0")}.png`), clip: { x: 0, y: n * 973, width: 688, height: Math.min(973, total - n * 973) }, fullPage: true });
await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]); // closing a headless browser can hang while another Edge is open

// ---- Check what came out ----
const bytes = fs.statSync(pdfFile).size;
let text = "", pages = "?";
const pdftotext = (/^PDFTOTEXT_BIN=(.*)$/m.exec(read(".env"))?.[1] ?? "pdftotext").trim();
try { text = execFileSync(pdftotext, ["-enc", "UTF-8", "-layout", pdfFile, "-"], { maxBuffer: 64e6 }).toString("utf8"); pages = String(text.split("\f").length - 1); } catch (e) { text = ""; console.log("pdftotext unavailable: " + e.message); }
const korean = (text.match(/[가-힣]/g) ?? []).length;
const secrets = /(sk-(proj|ant)-[A-Za-z0-9_-]{16,}|OPENAI_API_KEY=\S{12,})/.test(md + text);
const unresolved = (md.match(/\{\{[A-Z_]+\}\}/g) ?? []);
const emptyPages = text ? text.split("\f").slice(0, -1).filter((p) => p.trim().length < 20).length : 0;
const result = { pdf: path.relative(ROOT, pdfFile), bytes, pages, koreanCharacters: korean, brokenImages: broken, overflowingElements: overflow, emptyPages, unresolvedTokens: unresolved, secretsFound: secrets };
console.log(JSON.stringify(result, null, 1));
fs.writeFileSync(path.join(ROOT, "reports", "evidence", "report-check.json"), JSON.stringify({ at: kstNow, ...result }, null, 2));
process.exit(broken.length || unresolved.length || secrets || bytes < 20000 || (text && korean < 500) ? 1 : 0);
