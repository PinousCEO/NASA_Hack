# Headset frame (IWER emulator) — 2026-11-15T07:27:21.137Z — session ms_12c291b14401
PASS · an immersive-ar session starts
PASS · immersive-ar: a solo player who has changed nothing still gets a filled status panel and four labelled quick commands — Mission: not ready to fly | Open: It can do the science it is for | Wiring: 9 lines · all connected | Control: no control logic yet · quick: Add Neutron spectrometer | What holds us back? | Add power-saving logic | Fly the mission
PASS · immersive-ar: the renderer keeps drawing frames for the session — {"renders":121,"updates":121,"presenting":true,"visibility":"visible"}
PASS · immersive-ar: the session's frame has the workspace in it (not an empty frame) — {"width":1680,"height":980,"litShare":0.11459183673469388}
PASS · an immersive-vr session starts
PASS · immersive-vr: a solo player who has changed nothing still gets a filled status panel and four labelled quick commands — Mission: not ready to fly | Open: It can do the science it is for | Wiring: 9 lines · all connected | Control: no control logic yet · quick: Add Neutron spectrometer | What holds us back? | Add power-saving logic | Fly the mission
PASS · immersive-vr: the renderer keeps drawing frames for the session — {"renders":120,"updates":120,"presenting":true,"visibility":"visible"}
PASS · immersive-vr: the session's frame has the workspace in it (not an empty frame) — {"width":1680,"height":980,"litShare":0.11438289601554907}
PASS · immersive-vr: frames keep coming after a part is added during the session — {"renders":89,"updates":89,"presenting":true,"visibility":"visible"}
PASS · immersive-vr: frames keep coming in the systems view — {"renders":121,"updates":121,"presenting":true,"visibility":"visible"}
PASS · immersive-vr: the systems view draws the real lines, and the panel names the part that is not connected — {"lines":9,"wiring":"9 lines · 1 part not connected","quick":"Connect Neutron spectrometer"}
PASS · immersive-vr: picking a part up selects it — the panel says what it is missing, and the session keeps drawing — {"name":"Neutron spectrometer","id":"inst1","held":1,"activity":"Neutron spectrometer: No power line from the bus: it is switched off. No data line to storage: its measurements are not recorded. · no lines","frames":{"renders":48,"updates":48,"presenting":true,"visibility":"visible"}}
PASS · immersive-vr: Connect from the headset fits the three lines; the panel then reports the part as fully connected — {"activity":"Neutron spectrometer: fully connected, commandable by control logic · power 15 W, data 10000 bit/s, control","wiring":"12 lines · all connected","lines":12}
PASS · immersive-vr: a question asked from the headset is answered on the player's AI panel (no panel before the first question) — 6 line(s): I could not interpret "What is holding this mission back right now? Give the / numbers, and the ways to deal with it with what each costs." with the
PASS · immersive-vr: a sentence typed on the spatial keyboard reaches the player's AI and its answer comes up on the panel — typed "compute the link budget" · Compute the downlink budget. Eb/N0: 35.205 dB; Margin: 30.705 dB; / Closes: yes; Max data rate bit/s at 3 dB margin: 1178900000.
PASS · immersive-vr: the AI's probe is in the session and its bubble carries the answer just given — speaking · Compute the downlink budget. Eb/N0: 35.205 dB; / Margin: 30.705 dB; Closes: yes; Max data rate bit/s at 3
PASS · immersive-vr: a spoken sentence (after speech-to-text) is answered in the probe's bubble — compute the power budget
PASS · immersive-vr: when a part is built the probe flies to it in the hardware view and says what it is building — building · systems · 0.29 m from the part · Neutron spectrometer: assembling it on the spacecraft
PASS · immersive-vr: controller rays swept over the whole workspace in both views never stop the session — 66 + 66 aim points · {"renders":90,"updates":90,"presenting":true,"visibility":"visible"} · errors: 0
page errors: none
verification level: WebXR emulator (IWER) in desktop Edge. Not verified: a physical headset.
