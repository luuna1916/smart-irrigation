# Smart Irrigation & Water Saver

A lightweight green-and-white, seven-page browser demo for boundary sprinkler monitoring. The Python standard-library server hosts the app; no packages or internet connection are required.

## Run

1. Open a terminal in this folder.
2. Run `python app.py` (or `py app.py` on Windows).
3. Open `http://localhost:8000` in a browser.

To open it from another device on the same Wi-Fi, use `http://<laptop-ip>:8000`.

## Pages

Dashboard; Weather & Simulation; Irrigation Monitoring; Demo Scenarios; Decision & Recommendation; Reports & History.


## Existing demo behavior retained

- Simulated weather, soil drying/rain, Tray A and B monitoring, sensor faults, and manual/automatic sprinkler controls.
- Six demo scenarios, decision explanations, safety stops, comparison reports, charts, and recent irrigation events.
- Estimates and control rules are still the original browser-side demo logic in `script.js`. `app.py` is a minimal Python static server; browsers require JavaScript for the live interactive UI.

All readings and water quantities are simulated estimates, not calibrated hardware measurements. The ESP32 adapter plan and decision assumptions are documented in the source.
this is my practice branch
