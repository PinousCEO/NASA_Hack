# Verification summary — all runs against the final code

Started 2026-11-15 16:15:50 KST, finished 2026-11-15 16:28:30 KST. Code: commit e8b1298 plus the uncommitted working tree. Each script below the first two ran against its own freshly started server with an empty data folder.

| Verification | Kind | Passed | Failed | Result | Time |
|---|---|---|---|---|---|
| Unit and integration tests | code level; language model is a test double | 159 | 0 | PASS | 10 s |
| Browser end-to-end suite | real browser, own fresh server, no language model, XR in the IWER emulator | 51 | 0 | PASS | 192 s |
| Wiring loop in the UI | real browser | 9 | 0 | PASS | 28 s |
| Power-short mission: flight with control logic in the UI | real browser | 8 | 0 | PASS | 12 s |
| Soak: four clients, 600 edits | four real HTTP+WebSocket clients | 6 | 0 | PASS | 14 s |
| Controls scan (labels, reasons for disabled) | real browser, two roles | 18 | 0 | PASS | 40 s |
| Four clients: sync, latency, conflicts, reconnect | four real HTTP+WebSocket clients | 17 | 0 | PASS | 3 s |
| Conversation: grows downward, a thread per part, nothing over the stage | real browser, built-in analyser (no language model) | 10 | 0 | PASS | 28 s |
| One player, first screen to debrief, by clicking | real browser, built-in analyser (no language model) | 15 | 0 | PASS | 42 s |
| Two players: private conversations, sharing, personal view | two real browsers, built-in analyser (no language model) | 9 | 0 | PASS | 26 s |
| Layout at four window sizes (stage stays visible) | real browser | 24 | 0 | PASS | 100 s |
| Two players: pointing at a place, crew feed, game strip | real browser | 12 | 0 | PASS | 25 s |
| One person and three AI crewmates, to a flown mission | real browser, no language model | 9 | 0 | PASS | 84 s |
| Web ↔ MR loop | real browser + WebXR emulator (IWER) | 13 | 0 | PASS | 28 s |
| MR headset frame (what the session draws) | real browser + WebXR emulator (IWER) | 19 | 0 | PASS | 53 s |
| Play-through: CubeSat | server API, no language model | 9 | 0 | PASS | 1 s |
| Play-through: Mars orbiter | server API, no language model | 9 | 0 | PASS | 1 s |
| Play-through: lunar prospector | server API, no language model | 9 | 0 | PASS | 1 s |

Total: 406 checks passed, 0 failed, across 18 runs. Live-model runs were skipped in this pass.
