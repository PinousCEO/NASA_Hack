# A mission brief written by the live model — 2026-11-14T15:40:25.401Z
PASS · the model writes a brief with its kit — ai · Watching Burn Scars Recover · template leo-cubesat · Measure repeated multispectral reflectance changes across large wildfire burn scars and adjacent unburned vegetation in western North America. Track the same landscape patches for roughly 18 months, distinguishing persistent changes from seasonal vegetation and illumination effects. Retain the 12 kg dispenser limit on 90% of the nominal bud
crux: Return consistent repeat imagery across growing seasons without exhausting power, battery life or the weakened downlink.
challenge: station
control: orbit.altitude — Ground detail and image coverage determine which burned patches can be compared repeatedly.
control: orbit.inclination — The orbit must reach the target latitudes often enough to offer useful opportunities despite clouds.
control: orbit.node — Observation lighting affects whether reflectance differences can be interpreted as surface change.
control: instrument.dutyCycle — More imaging opportunities help with cloud losses but consume power and generate more data.
control: antenna.dataRate — Image delivery must account for the weakened receiving station.
control: battery.capacity — Eclipses and transmission loads must remain sustainable through the longer campaign.
part: cs-cam — Spectral images enable repeated comparisons of burned and reference patches.
part: cs-adcs — Stable pointing supports measurements of the same landscape patches across many visits.
part: cs-obc — Compression can reduce the image return burden while consuming onboard resources.
part: cs-x — Link performance determines whether image sequences reach the degraded station.
part: cs-sa — Power generation must support imaging and transmission across changing seasons.
part: cs-bat — Stored energy bridges eclipses and peak loads throughout the extended campaign.
role: Observation planner — Balance target access, ground detail and lighting consistency for burned and reference patches.
role: Power and lifetime engineer — Check seasonal energy balance and battery cycling over the 18-month campaign.
role: Data and communications engineer — Match image production and compression to the weakened station's receiving capacity.
role: Systems lead — Keep the extended campaign within the unchanged mass limit and reduced budget.
PASS · the mission made from it is wired and computed from the first second — 7 lines · 9 checks · outcome: Not ready to fly: "it can do the science it is for" does not hold yet.
PASS · every part the kit names exists in this mission's catalogue
PASS · the kit names at least two controls and gives each a reason
