# Soak: four clients, 600 edits — 2026-11-15T07:20:05.294Z
600 edits applied, 0 conflicts, 0 refused, 6 flights, in 2.8 s (212 edits/s)
sync latency median: first 100 edits 4.0 ms → last 100 edits 3.6 ms · overall p95 5.2 ms · max 10.4 ms
PASS · nearly every edit was applied (a refused edit is one the validator rightly rejects) — 600/600
PASS · synchronisation did not slow down over the session
PASS · all four sockets end on the same version and configuration — v602 c2fb8810c5020174
PASS · all four read the same state, outcome and score over HTTP
PASS · every client received every version — 601,601,601,601
PASS · the history is intact and ordered — 40 most recent versions listed
