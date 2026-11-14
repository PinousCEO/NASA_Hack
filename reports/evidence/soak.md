# Soak: four clients, 600 edits — 2026-11-14T16:12:35.442Z
600 edits applied, 0 conflicts, 0 refused, 6 flights, in 2.7 s (224 edits/s)
sync latency median: first 100 edits 3.9 ms → last 100 edits 3.3 ms · overall p95 4.7 ms · max 7.5 ms
PASS · nearly every edit was applied (a refused edit is one the validator rightly rejects) — 600/600
PASS · synchronisation did not slow down over the session
PASS · all four sockets end on the same version and configuration — v602 c2fb8810c5020174
PASS · all four read the same state, outcome and score over HTTP
PASS · every client received every version — 601,601,601,601
PASS · the history is intact and ordered — 40 most recent versions listed
