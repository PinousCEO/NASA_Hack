# Play-through: leo-cubesat (seed 9) — 2026-11-15T09:14:22.095Z
world: earth · Coastal Watch · bus 4.2 kg · limit 12.3 kg · budget $3.1M · 365 days · rover: no · ground station 35.5 dBi
problem: Coastal Watch 6U CubeSat — A shoebox-sized satellite, a university budget, a real science product.
kit: 4 controls (orbit.altitude, antenna.dutyCycle, battery.capacity, launch.vehicle), 5 parts, 4 roles
PASS · the mission arrives built: parts wired, checks computed, goals set, a kit of controls and parts — 7 lines, 9 checks, 12 goals, outcome: Not ready to fly: "it can do the science it is for" does not hold yet.
PASS · the crew defines its mission
PASS · parts added from the catalogue are on board but not connected — cs-cam, cs-adcs, cs-obc · not connected: 3
PASS · connecting them changes mass, power, data and cost together — mass 6.29→9.09 kg · load 6.8→12.3 W · data 0.00→77.76 Gb/day · cost $1.6→$3.0M · schedule 10.6→14.2 months
PASS · control logic is installed in the shared design — {"ok":true,"version":8}
PASS · control logic that reads a signal the model does not have is refused — controller "Power and storage manager", rule 1: "fuel.level" is not a signal it can read (signals: day, battery.soc, power.marginW, power.generationW, eclipse.fraction, sun.distanceAu, link.marginDb, link.up, storage.fill, storage.gb, data.generatedGbPerDay, data.downlinkGbPerDay, array.health, battery.health, station.down, mem.saving)
PASS · a launch vehicle is chosen from the options this mission offers — Dedicated small launcher: 11 kg for $0.3M (options: Rideshare slot, Dedicated small launcher, Heavy launcher)
PASS · the flight runs with this mission's own in-flight events — 365 days · events: Solar array string failure (day 58), Antenna feed degradation (day 235)
flight before control logic: returned 7568.6 Gb, lost 20621.8 Gb, negative-power days 0, control-active days 0
flight with control logic:   returned 11290.8 Gb, lost 16681.9 Gb, negative-power days 22, control-active days 363
  control log · day 2: storage filling: transmit longer — S-band patch transceiver: 8% → 12% on-time
  control log · day 344: storage filling: transmit longer — S-band patch transceiver: 8% → 12% on-time
  control log · day 349: instruments at 30% — Multispectral imager 9 cm: 15% → 5% on-time
  control log · day 350: storage filling: transmit longer — S-band patch transceiver: 8% → 12% on-time
  Multispectral imager 9 cm: returned 11290.8 Gb, lost 16681.9 Gb
outcome: Flown in simulation, but not a mission that could launch as designed: "no engineering limit is broken" does not hold.
  ✓ It can do the science it is for: 4 of 4 science goals met in full, 100% of the science credit
  ✗ No engineering limit is broken: Programme cost within the budget cap (game cost model) (total $3.1M, margin $-0.0M)
  ✓ A launch vehicle is chosen and can lift it: Dedicated small launcher: 2.2 kg to spare
  ✓ It gets through the flight and brings the data home: flown 365 days: 100% of the science an untroubled flight would return, 11291 Gb home, instruments forced off on 0 day(s), 2 in-flight event(s)
PASS · the mission is submitted and evaluated — score 74.5 (B) · outcome: not_ready · rank 1/1
  ✓ It can do the science it is for: 4 of 4 science goals met in full, 100% of the science credit
  ✗ No engineering limit is broken: Programme cost within the budget cap (game cost model) (total $3.1M, margin $-0.0M)
  ✓ A launch vehicle is chosen and can lift it: Dedicated small launcher: 2.2 kg to spare
  ✓ It gets through the flight and brings the data home: flown 365 days: 100% of the science an untroubled flight would return, 11291 Gb home, instruments forced off on 0 day(s), 2 in-flight event(s)
