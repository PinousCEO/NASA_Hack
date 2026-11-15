# Play-throughs with other seeds (no language model) — 2026-11-14T22:31:16Z
- leo-cubesat seed 11: 9 passed, 0 failed — PASS · the mission is submitted and evaluated — score 88.6 (A) · outcome: success · rank 1/1
- leo-cubesat seed 23: 9 passed, 0 failed — PASS · the mission is submitted and evaluated — score 80.4 (A) · outcome: not_ready · rank 1/1
- leo-cubesat seed 42: 9 passed, 0 failed — PASS · the mission is submitted and evaluated — score 89.6 (A) · outcome: success · rank 1/1
- mars-weather-relay seed 11: 9 passed, 0 failed — PASS · the mission is submitted and evaluated — score 88.4 (A) · outcome: success · rank 1/1
- mars-weather-relay seed 23: 9 passed, 0 failed — PASS · the mission is submitted and evaluated — score 87.8 (A) · outcome: success · rank 1/1
- mars-weather-relay seed 42: 9 passed, 0 failed — PASS · the mission is submitted and evaluated — score 87.8 (A) · outcome: partial · rank 1/1
- lunar-volatiles seed 11: 9 passed, 0 failed — PASS · the mission is submitted and evaluated — score 71.4 (B) · outcome: not_ready · rank 1/1
- lunar-volatiles seed 23: 9 passed, 0 failed — PASS · the mission is submitted and evaluated — score 71.0 (B) · outcome: not_ready · rank 1/1
- lunar-volatiles seed 42: 9 passed, 0 failed — PASS · the mission is submitted and evaluated — score 72.5 (B) · outcome: not_ready · rank 1/1

Reading these: the script plays one fixed, minimal line of moves (add the first payload, attitude control and a computer, connect, install control logic, choose the cheapest vehicle that lifts it, fly, submit). It is not a solver.
Every run reached a submitted, evaluated mission (9 of 9 checks each). Where the outcome is "not_ready", the fixed build stops short of the 60 % science credit that "ready to fly" needs
(e.g. lunar seed 11: 58 %, with "Resolve hydrogen deposits", "Image the traverse" and "Return the data" still open — goals that need a camera, a lower orbit or a faster link, which this script does not attempt).
What can be reached is fixed separately by tests/playability.test.ts: at every difficulty of every template a design that respects its limits, survives its events and scores well, and for every template at least one combination that ends in the outcome "success".
