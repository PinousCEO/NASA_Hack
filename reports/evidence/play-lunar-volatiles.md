# Play-through: lunar-volatiles (seed 3) — 2026-11-14T16:15:46.264Z
world: moon · Prospector Orbiter · bus 95 kg · limit 173 kg · budget $128M · 456 days · rover: yes · ground station 68.2 dBi
problem: Lunar South Pole Volatiles Prospector — Find the water. An orbiter and a rover, one launch, one budget.
kit: 4 controls (orbit.altitude, launch.vehicle, solar.area, antenna.dataRate), 6 parts, 4 roles
PASS · the mission arrives built: parts wired, checks computed, goals set, a kit of controls and parts — 9 lines, 10 checks, 14 goals, outcome: Not ready to fly: "it can do the science it is for" does not hold yet.
PASS · the crew defines its mission
PASS · parts added from the catalogue are on board but not connected — ns, adcs-rw, obc-comp · not connected: 3
PASS · connecting them changes mass, power, data and cost together — mass 125.21→144.04 kg · load 113.5→163.5 W · data 0.00→0.17 Gb/day · cost $93.2→$117.1M · schedule 22.8→30.0 months
PASS · control logic is installed in the shared design — {"ok":true,"version":8}
PASS · control logic that reads a signal the model does not have is refused — controller "Power and storage manager", rule 1: "fuel.level" is not a signal it can read (signals: day, battery.soc, power.marginW, power.generationW, eclipse.fraction, sun.distanceAu, link.marginDb, link.up, storage.fill, storage.gb, data.generatedGbPerDay, data.downlinkGbPerDay, array.health, battery.health, station.down, mem.saving)
PASS · a launch vehicle is chosen from the options this mission offers — Rideshare slot: 147 kg for $39.4M (options: Rideshare slot, Dedicated small launcher, Heavy launcher)
PASS · the flight runs with this mission's own in-flight events — 456 days · events: Antenna feed degradation (day 38), Ground station outage (day 315)
flight before control logic: returned 78.8 Gb, lost 0.0 Gb, negative-power days 0, control-active days 0
flight with control logic:   returned 78.8 Gb, lost 0.0 Gb, negative-power days 0, control-active days 0
  Neutron spectrometer: returned 78.8 Gb, lost 0.0 Gb
outcome: Flown in simulation, but not a mission that could launch as designed: "it can do the science it is for" does not hold.
  ✗ It can do the science it is for: 2 of 5 science goals met in full, 58% of the science credit. Still open: Resolve hydrogen deposits, Image the traverse, Return the data
  ✓ No engineering limit is broken: all 10 checks hold
  ✓ A launch vehicle is chosen and can lift it: Rideshare slot: 3.0 kg to spare
  ✓ It gets through the flight and brings the data home: flown 456 days: 100% of the science an untroubled flight would return, 79 Gb home, instruments forced off on 0 day(s), 2 in-flight event(s)
PASS · the mission is submitted and evaluated — score 70.7 (B) · outcome: not_ready · rank 1/1
  ✗ It can do the science it is for: 2 of 5 science goals met in full, 58% of the science credit. Still open: Resolve hydrogen deposits, Image the traverse, Return the data
  ✓ No engineering limit is broken: all 10 checks hold
  ✓ A launch vehicle is chosen and can lift it: Rideshare slot: 3.0 kg to spare
  ✓ It gets through the flight and brings the data home: flown 456 days: 100% of the science an untroubled flight would return, 79 Gb home, instruments forced off on 0 day(s), 2 in-flight event(s)
