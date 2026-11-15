# Four clients on one mission — 2026-11-15T09:05:25.188Z — http://127.0.0.1:8795
session ms_869d644bc4db
PASS · fcbravo joins
PASS · fccharlie joins
PASS · fcdelta joins
PASS · a fifth player is refused (the crew is four) — 409 This mission is full (4 participants).
PASS · all four connected and hold the same version — v1
sync latency, edit sent → received by another client (n=72, loopback, includes recalculating the engineering models): median 4.5 ms · p95 8.0 ms · max 8.9 ms
PASS · every edit reached every other client
PASS · the four sockets hold identical mission state (config and derived results) — d11654185033666a d11654185033666a d11654185033666a d11654185033666a
PASS · the four clients read identical state, checks, outcome and score over HTTP — 9d511068057130dd 9d511068057130dd 9d511068057130dd 9d511068057130dd
PASS · two simultaneous edits of the same value: exactly one is applied, the other gets a conflict — loser: conflict {"paths":["orbit.inclinationDeg"],"current":{"orbit.inclinationDeg":88},"changedBy":["FCALPHA"]}
PASS · two simultaneous edits of different values both apply — v27, v28
PASS · an invalid line is refused and no client's version moves — line "bad": a data line cannot plug into the bus's power port, which carries power (W)
PASS · a reconnecting client is restored to the current version — v30
PASS · the mission clock one player sets reaches the other three
PASS · a part added by one player and connected by another has its three lines on all four clients — 3,3,3,3
PASS · the flight one player runs is the same result for all four — returned 63.1 Gb · 6585625ed54e4cde 6585625ed54e4cde 6585625ed54e4cde 6585625ed54e4cde
PASS · flying the same design again gives the same numbers
PASS · final state identical on all four — v32 48d12a5625d71ddf
