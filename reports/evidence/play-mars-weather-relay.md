# Play-through: mars-weather-relay (seed 9) — 2026-11-15T09:14:26.991Z
world: mars · Weather Relay Orbiter · bus 320 kg · limit 493 kg · budget $466M · 687 days · rover: no · ground station 68.2 dBi
problem: Mars Weather and Relay Orbiter — Forecast the dust. Keep the surface connected. 400 million kilometres from help.
kit: 4 controls (antenna.dataRate, mission.date, solar.area, launch.vehicle), 6 parts, 4 roles
PASS · the mission arrives built: parts wired, checks computed, goals set, a kit of controls and parts — 7 lines, 9 checks, 12 goals, outcome: Not ready to fly: "it can do the science it is for" does not hold yet.
PASS · the crew defines its mission
PASS · parts added from the catalogue are on board but not connected — nac, tir, adcs-rw, obc-comp · not connected: 4
PASS · connecting them changes mass, power, data and cost together — mass 391.16→423.16 kg · load 218.0→266.5 W · data 0.00→69.12 Gb/day · cost $346.5→$395.0M · schedule 23.6→32.6 months
PASS · control logic is installed in the shared design — {"ok":true,"version":10}
PASS · control logic that reads a signal the model does not have is refused — controller "Power and storage manager", rule 1: "fuel.level" is not a signal it can read (signals: day, battery.soc, power.marginW, power.generationW, eclipse.fraction, sun.distanceAu, link.marginDb, link.up, storage.fill, storage.gb, data.generatedGbPerDay, data.downlinkGbPerDay, array.health, battery.health, station.down, mem.saving)
PASS · a launch vehicle is chosen from the options this mission offers — Dedicated small launcher: 493 kg for $295.8M (options: Rideshare slot, Dedicated small launcher, Heavy launcher)
PASS · the flight runs with this mission's own in-flight events — 687 days · events: Solar array string failure (day 109), Antenna feed degradation (day 442)
flight before control logic: returned 1424.6 Gb, lost 38100.6 Gb, negative-power days 134, control-active days 0
flight with control logic:   returned 1966.8 Gb, lost 35945.1 Gb, negative-power days 141, control-active days 684
  control log · day 3: storage filling: transmit longer — X-band HGA 1.5 m: 30% → 45% on-time
  control log · day 495: storage filling: transmit longer — X-band HGA 1.5 m: 30% → 45% on-time
  control log · day 502: instruments at 30% — Narrow-angle camera: 15% → 5% on-time; Thermal imager: 40% → 12% on-time
  control log · day 503: instruments at 30% — Narrow-angle camera: 15% → 5% on-time; Thermal imager: 40% → 12% on-time
  Narrow-angle camera: returned 1966.8 Gb, lost 26410.0 Gb
  Thermal imager: returned 0.0 Gb, lost 9535.1 Gb
outcome: Partial success: the mission flew and returned science, short of everything it set out to do.
  ✓ It can do the science it is for: 4 of 4 science goals met in full, 100% of the science credit
  ✓ No engineering limit is broken: all 9 checks hold
  ✓ A launch vehicle is chosen and can lift it: Dedicated small launcher: 69.8 kg to spare
  ✓ It gets through the flight and brings the data home: flown 687 days: 94% of the science an untroubled flight would return, 1967 Gb home, instruments forced off on 75 day(s), 2 in-flight event(s)
PASS · the mission is submitted and evaluated — score 82.3 (A) · outcome: partial · rank 1/1
  ✓ It can do the science it is for: 4 of 4 science goals met in full, 100% of the science credit
  ✓ No engineering limit is broken: all 9 checks hold
  ✓ A launch vehicle is chosen and can lift it: Dedicated small launcher: 69.8 kg to spare
  ✓ It gets through the flight and brings the data home: flown 687 days: 94% of the science an untroubled flight would return, 1967 Gb home, instruments forced off on 75 day(s), 2 in-flight event(s)
