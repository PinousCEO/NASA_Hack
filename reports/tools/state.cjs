// Small helper for the overnight run's state files. Usage:
//   node reports/tools/state.cjs log <event> <json>
//   node reports/tools/state.cjs req <ID> <STATUS> [actual result] [evidence path]
//   node reports/tools/state.cjs work <current> | <next>
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const [cmd, ...args] = process.argv.slice(2);
const now = new Date().toISOString();
const kst = new Date(Date.now() + 9 * 3600000).toISOString().replace("T", " ").slice(0, 19) + " KST";
const STATUSES = ["NOT_STARTED", "IN_PROGRESS", "IMPLEMENTED_NOT_VERIFIED", "FAIL", "BLOCKED_EXTERNAL", "PASS"];
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch { return d; } };
const write = (f, v) => fs.writeFileSync(path.join(ROOT, f), JSON.stringify(v, null, 2) + "\n");
const log = (event, extra) => fs.appendFileSync(path.join(ROOT, "WORK_LOG.jsonl"), JSON.stringify({ at: now, kst, source: "worker", event, ...extra }) + "\n");

if (cmd === "log") {
  log(args[0], args[1] ? JSON.parse(args[1]) : {});
} else if (cmd === "req") {
  const [id, status, actual, evidence] = args;
  if (!STATUSES.includes(status)) throw new Error("status must be one of " + STATUSES.join(", "));
  const reqs = read("requirements.json", { requirements: [] });
  const r = reqs.requirements.find((x) => x.id === id);
  if (!r) throw new Error("no requirement " + id);
  r.status = status;
  if (actual) r.actual = actual;
  if (evidence) r.evidence = evidence;
  r.updatedAt = kst;
  reqs.updatedAt = kst;
  write("requirements.json", reqs);
  log("requirement", { id, status });
} else if (cmd === "work") {
  const [current, next] = args.join(" ").split("|").map((s) => s.trim());
  const w = read("WORK_STATE.json", {});
  w.current = current;
  if (next) w.next = next;
  w.updatedAt = kst;
  write("WORK_STATE.json", w);
  log("work", { current, next });
} else if (cmd === "summary") {
  const reqs = read("requirements.json", { requirements: [] }).requirements;
  const by = {};
  for (const r of reqs) by[r.status] = (by[r.status] || 0) + 1;
  console.log(JSON.stringify(by), reqs.filter((r) => r.status !== "PASS").map((r) => r.id + ":" + r.status).join(" "));
} else {
  console.error("unknown command");
  process.exit(1);
}
