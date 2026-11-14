# Web ↔ MR (IWER emulator) — 2026-11-14T16:13:55.521Z — session ms_e978db7e17ed
PASS · the emulated headset is detected — {"webxr":true,"secureContext":true,"immersiveAr":true,"immersiveVr":true,"emulated":true,"reason":null}
PASS · an immersive-ar session starts
PASS · Web → MR: the part added on the web is an object in the headset's scene
PASS · the headset's status panel says a part is not connected, and offers to connect it — [{"k":"Mission","v":"not ready to fly"},{"k":"Open","v":"It can do the science it is for"},{"k":"Wiring","v":"9 lines · 1 part(s) not fully connected"},{"k":"Control","v":"no control logic yet"}] · quick: Connect Neutron spectrometer | What holds us back? | Add power-saving logic | Fly the mission
PASS · no line is drawn to the unconnected part (drawn lines = real lines) — 9 → 9
PASS · MR → Web: Connect pressed in the headset fits the lines, and the web shows them — power, data, control
PASS · the headset draws the three new lines and reports the wiring as complete — 9 → 12 lines · 12 lines · all connected
PASS · web and headset draw the same number of lines
PASS · Web → MR: control logic installed on the web is named on the headset's status panel — Power saver · quick: Add Narrow-angle camera | What holds us back? | Fly the mission | Send hydrogen data first
PASS · MR → Web: Fly pressed in the headset; the web shows the flown outcome — DOES THE MISSION WORK? Flown in simulation, but not a mission that could launch as designed: "it can do the science it is for" does not hold. ✗ It can do the science it is for 2 of 5 science goals met in full, 52% of the science credit. Still open: Resolve hydrogen deposits, Image the traverse, Return the data ✓ No eng
PASS · the headset's Mission line follows the same outcome — [{"k":"Mission","v":"not ready to fly"},{"k":"Open","v":"It can do the science it is for"}]
PASS · MR → Web: time turned in the headset is the same moment on the web — 2027-06-14T14:36:59.884Z vs 2027-06-14T14:36:59.884Z
PASS · the web player's own view did not move when the headset player acted
page errors: none
verification level: WebXR emulator (IWER) in desktop Edge. Not verified: a physical headset (tracking, passthrough, hand input, performance, comfort).
