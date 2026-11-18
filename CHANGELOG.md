# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-11-17

First public release.

### Added
- 3D cutaway and 2D plan of every floor, with a WebGL2 FDTD wave solver (beacon, flow and tone models).
- Multi-wall propagation model per band, calibrated by ridge least squares, with held-out error in the page.
- Metrics panel: coverage, dead zones, room grades, wired reference health, channel map; 24 h replay.
- Layout editor: Polycam scan import, plan-image tracing and grid drawing, saved to `data/user/`.
- Setup panel for networks, access points and devices.
- Walk survey with a laptop or a Raspberry Pi 4: measured against predicted and where to measure next.
- Colour themes with readability checks; privacy mode.
- Demo house with generic networks (Atlas-Home, Atlas-Mesh) and everyday devices.
- `tools/verify/layout-rattle.mjs`: the layout editor under abuse.
- ESP32 sketch and MQTT-to-SSE bridge (not yet run on hardware).

### Known issues
- The layout editor accepts rooms that overlap or are only centimetres wide.
- On windows narrower than about 480 px the Layout button is off screen (key `L` still works).
- A rare drawing can derive a wall of zero length; Apply is then blocked with a message.
