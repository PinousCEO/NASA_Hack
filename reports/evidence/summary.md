# Verification summary — all runs against the final code

Started 2026-11-15 00:51:32 KST, finished 2026-11-15 01:01:47 KST. Code: commit d759b5b plus the uncommitted working tree. Each script below the first two ran against its own freshly started server with an empty data folder.

| Verification | Kind | Passed | Failed | Result | Time |
|---|---|---|---|---|---|
| Unit and integration tests | code level; language model is a test double | 153 | 0 | PASS | 9 s |
| Browser end-to-end suite | real browser, own fresh server, no language model, XR in the IWER emulator | 51 | 0 | PASS | 199 s |
| Wiring loop in the UI | real browser | 9 | 0 | PASS | 29 s |
| Controls scan (labels, reasons for disabled) | real browser, two roles | 18 | 0 | PASS | 36 s |
| Four clients: sync, latency, conflicts, reconnect | four real HTTP+WebSocket clients | 17 | 0 | PASS | 12 s |
| Web ↔ MR loop | real browser + WebXR emulator (IWER) | 13 | 0 | PASS | 25 s |
| Play-through: CubeSat | server API, no language model | 9 | 0 | PASS | 27 s |
| Play-through: Mars orbiter | server API, no language model | 9 | 0 | PASS | 41 s |
| Play-through: lunar prospector | server API, no language model | 9 | 0 | PASS | 27 s |
| Two players, their own AIs | two real browsers, LIVE language model | 12 | 0 | PASS | 72 s |
| One mission from first screen to debrief | real browser, LIVE language model | 16 | 0 | PASS | 98 s |

Total: 316 checks passed, 0 failed, across 11 runs.
