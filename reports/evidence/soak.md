# Soak: four clients, 600 edits — 2026-11-15T09:04:22.787Z
600 edits applied, 0 conflicts, 0 refused, 6 flights, in 2.6 s (232 edits/s)
sync latency median: first 100 edits 4.1 ms → last 100 edits 3.1 ms · overall p95 4.9 ms · max 9.5 ms
PASS · nearly every edit was applied (a refused edit is one the validator rightly rejects) — 600/600
PASS · synchronisation did not slow down over the session
PASS · all four sockets end on the same version and configuration — v602 c2fb8810c5020174
PASS · all four read the same state, outcome and score over HTTP
PASS · every client received every version — 601,601,601,601
PASS · the history is intact and ordered — 40 most recent versions listed
