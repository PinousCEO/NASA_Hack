# A mission brief written by the live model — 2026-11-14T19:38:42.347Z
PASS · the model writes a brief with its kit — ai · Mineral Signals Under a Low Sun · template lunar-volatiles · Test whether infrared spectral contrasts between rock and regolith on a lunar south-polar ridge persist as lighting and temperature change. Pair repeated orbital spectra, thermal maps and images with rover observations for local context. Solar cells start with two years of aging, limiting power for observations and downlink. A 10% t
crux: Collect comparable spectra, temperatures and image context without exhausting the aged power system or losing the data needed to interpret them together.
challenge: aged-cells
control: orbit.inclination — The ridge must be accessible to repeated orbital observations near the south pole.
control: orbit.altitude — Spectral footprints must be interpretable against patches of rock, regolith and shadow.
control: orbit.node — Orbit-plane geometry affects both observing illumination and eclipse exposure.
control: solar.area — Aged cells leave less power for simultaneous measurements, but additional array area competes with the tighter mass allowance.
control: battery.capacity — Stored energy must cover eclipse operations and clustered observation demands.
control: instrument.dutyCycle — Repeated measurements are valuable only if their observing cadence remains sustainable.
part: irs — Measures the spectral contrasts whose persistence the mission must test.
part: tir — Provides surface-temperature context for interpreting infrared differences.
part: nac — Shows rock exposures, regolith patches and shadows within the observed terrain.
part: adcs-fine — Repeat pointing helps compare the same terrain rather than different mixtures of surfaces.
part: sa-2 — Offers an array-area trade to investigate when aging reduces available generation.
part: bat-1000 — Offers storage capacity to weigh against mass when measurements cluster around limited opportunities.
part: hga-x — Provides a communications option for returning spectra and their supporting images.
role: Science lead — Define repeated observation sets and decide what temperature and image context is needed to compare spectra fairly.
role: Orbit and traverse lead — Arrange polar access and repeat viewing opportunities while checking that the rover can reach useful comparison terrain.
role: Power lead — Test aged-cell generation, eclipse storage and observation scheduling across the mission.
role: Systems and data lead — Balance pointing and downlink against the tighter mass limit and expanded budget.
PASS · the mission made from it is wired and computed from the first second — 9 lines · 10 checks · outcome: Not ready to fly: "it can do the science it is for" does not hold yet.
PASS · every part the kit names exists in this mission's catalogue
PASS · the kit names at least two controls and gives each a reason
