# UI run: wiring and control logic — 2026-11-15T09:03:35.412Z — session ms_beba6901e72f
PASS · the mission opens on the problem with its kit
PASS · a part added from the kit is on board but not connected — Neutron spectrometer: No power line from the bus: it is switched off.
PASS · an unconnected instrument earns nothing
PASS · the part card lists the part's ports and says which are open — NEUTRON SPECTROMETER ✕ NEUTRON SPECTROMETER MASS9 kg COST$9M DRAWS12 W DATA2000 bit/s ON100% of the time PORTS & LINES Supply nothing connected Measurements nothing connected Commands nothing connected NO POWER LINE FROM
PASS · the Systems tab lists every line with what it carries
PASS · Connect it fits power, data and control lines — power 15 | data 10000 | control 
PASS · the connected instrument now counts and its load and data appear — data 0.17 Gb/day, load 113.5 → 125.5 W, harness 0.411 → 0.459 kg
PASS · the part card now shows each port's line and its flow — NEUTRON SPECTROMETER ✕ NEUTRON SPECTROMETER MASS9 kg COST$9M DRAWS12 W DATA2000 bit/s ON100% of the time PORTS & LINES Supply → Bus · 12.0 W of 15.0 W Measurements → Bus · 2000 bit/s of 10.0k bit/s Commands → Bus Fully connected · can be commanded by control l
PASS · an incompatible line is refused with the reason — line "bad-line": a power line cannot plug into Neutron spectrometer's data_out port, which carries data (bit/s)
console/page errors: Failed to load resource: the server responded with a status of 401 (Unauthorized)
