# Signal Atlas data contract

Two parts. Part 1 defines the sample row that sensors send, that files store, and that the page reads
(machine-readable form: `data/schema/sample.schema.json`). Part 2 defines the floor-plan geometry, the
positions of emitters and receivers, and the band list (machine-readable form: `data/schema/floorplan.schema.json`).

# Part 1: sample rows

## Where rows travel

| Place | Form |
|---|---|
| Files under `data/` | NDJSON: one JSON object per line, UTF-8, oldest first is best |
| MQTT `sensors/wifi-atlas/<node-id>/scan` | one flat JSON object per message, not retained |
| MQTT `sensors/wifi-atlas/<node-id>/status` | one flat JSON object, retained; the broker's last-will sets `online` to false |
| `GET /live` | server-sent events; each `data:` line is one row |

The page never writes rows. It reads the files named in `paths.samples` of the config, then follows `/live` when that exists.

## Fields

Every row has `time`, `node_id` and `kind`. No nested objects.

| Field | Type | Kinds | Meaning |
|---|---|---|---|
| `time` | string | all | ISO 8601 with time zone, UTC preferred: `2026-11-14T17:10:05Z` |
| `node_id` | string | all | Stable id of the sensor or device. Must match an id in the node file to get a place on the map |
| `kind` | string | all | `scan`, `probe` or `status` |
| `bssid` | string | scan (required), probe | Lower case, colons: `aa:bb:cc:dd:ee:ff` |
| `ssid` | string | scan | Network name; empty for a hidden network |
| `band` | string | scan (required), probe | `"2.4"` or `"5"`. There is no 6 GHz in this house |
| `channel` | integer | scan | Wi-Fi channel number |
| `rssi_dbm` | number | scan (required) | Received signal strength, dBm |
| `noise_dbm` | number | scan | Noise floor in dBm, only if the radio reports it. SNR = `rssi_dbm - noise_dbm` |
| `associated` | boolean | scan | `true` on the row of the BSSID the node is connected to. This is how the page knows which network a device uses |
| `pos_level`, `pos_x`, `pos_y` | string, number, number | scan | Only for walk-test rows: where the sample was taken (level id, metres). Such rows calibrate the model and are drawn as small circles |
| `target` | string | probe (required) | Name of the wired reference that was probed (`home-server`, `nas`) |
| `latency_ms` | number | probe, scan | Average round-trip time |
| `jitter_ms` | number | probe | Mean deviation of the round-trip time |
| `loss_pct` | number | probe, scan | Lost packets, percent |
| `throughput_mbps` | number | probe, scan | iperf3 result, Mbit/s |
| `online` | boolean | status (required) | `true` when the node connects, `false` from the last-will or a clean shutdown |
| `synthetic` | boolean | all | `true` marks generated data |

A file may start with one line `{"kind":"meta", ...}`. `"synthetic": true` there puts the SYNTHETIC DATA badge on screen. Unknown fields are ignored. A row that breaks the rules is skipped and counted; the page says how many.

## Examples

```json
{"time":"2026-11-14T17:10:05Z","node_id":"esp32-a1b2c3","kind":"scan","bssid":"02:5a:02:00:02:24","ssid":"example","band":"2.4","channel":6,"rssi_dbm":-58,"associated":true}
{"time":"2026-11-14T17:10:07Z","node_id":"pi-500","kind":"probe","target":"home-server","bssid":"02:5a:02:00:02:50","band":"5","latency_ms":2.4,"jitter_ms":0.3,"loss_pct":0,"throughput_mbps":188.2}
{"time":"2026-11-14T19:07:00Z","node_id":"esp32-a1b2c3","kind":"status","online":false}
{"time":"2026-11-15T01:12:30Z","node_id":"survey-phone","kind":"scan","bssid":"02:5a:02:00:03:50","ssid":"example","band":"5","channel":149,"rssi_dbm":-63,"pos_level":"2","pos_x":6.4,"pos_y":9.1}
```

## How the page uses rows

- **Latest value**: the newest row at or before the time cursor. A node is offline when its status says so, or when it sent nothing for 15 minutes (`live.staleAfterSeconds`).
- **Calibration**: for each fixed sensor and own BSSID, the median `rssi_dbm` of the record; plus every walk-test row. Clients are not used, because their positions are rough.
- **Own or neighbour**: a BSSID listed under `aps[].bssid` in the config is one of ours. Every other BSSID is a neighbour and appears only in the channel map.
- **Topology check**: for each own SSID, the page lists which access points advertise it and flags a mismatch.

## Node file

`paths.nodes` points to a JSON file: `{ "nodes": [ { "id", "name", "type", "mac", "position" } ] }`.
`type` is `esp32`, `pi`, `wired`, `client` or `survey`. `position` is `{ "level", "x", "y" }` in floor-plan metres, or `null` for unknown: the device then appears in the roaming tray, not on the map.

# Part 2: geometry, positions and bands

The geometry holds no radio-specific field. A wall has a material name; what that material does to a
radio band is in `data/materials.json`. So the same `floorplan.json` serves Wi-Fi now and other bands
later (for example 433, 868, 915 and 1090 MHz) without a change.

## Frame

- Units are metres. A point is `[x, y]`. x runs right, y runs down the page.
- All levels share one frame: the same x and y on two levels is one point above the other.
- A plan made by `tools/trace/import_polycam.py` is drawn north up (x east, y south). `site.northDeg`
  in the config is the direction of north in degrees clockwise from up the page, so it is 0 for such a plan.
- The frame is fixed at the first import (`data/private/levels/frame.json`) and kept when a level is added,
  because marker positions, survey waypoints and samples are stored in plan coordinates.

## floorplan.json

`{ schemaVersion: 1, name, units: "m", note, levels: [...] }`. Each level:

| Field | Meaning |
|---|---|
| `id`, `name` | Short id (`B`, `1`, `2`) and display name |
| `elevation`, `height` | Floor surface above the main floor, and the usual floor-to-ceiling height, metres |
| `source` | `lidar-scan` (imported), `lidar-trace` (traced by hand), `measured`, `image-trace` (traced over a plan image in the Layout setup panel), `drawn` (drawn in the panel), or `synthetic` (labelled on screen) |
| `floorMaterial` | The floor structure under this level: a key of `floors` in materials.json |
| `outline` | Polygon along the centre line of the outer walls |
| `rooms[]` | `id`, `name`, `nameSource` (`confirmed`, `inferred`, `synthetic`), `polygon`; optional `ceilingHeight`, `ceilingHeightMax`, `ceilingSource`, `sourceLabel` (the scanner's label, never shown) |
| `walls[]` | Centre line `a` to `b`, `material`; optional `thickness` (else from the material), `origin` (`owner-fix` or `gap-closure` for a wall that is not in the scan), `note` |
| `openings[]` | `type` (`door`, `window`, `opening`), `a`, `b` on a wall line, `material`, `state` for doors, optional `id` |
| `stairs[]` | `id`, `polygon`, `connects` (ids of the levels this flight leads to) |
| `fixtures[]` | Large fixed items: `type` (`fireplace`, `appliance`, `counter`, `other`), `name`, `material`, `polygon` |

A room whose `ceilingHeight` is much more than the `height` of its level is open to the level above (a
double-height hall). The plan records it; the model adds no extra coupling between the floors for it yet.

Check a file with `node tools/validate-floorplan.mjs`. Names of rooms live in
`data/private/room-names.json`, not in code; the importer applies them.

## Emitters and receivers

Anything that sends or listens is a named thing with a position: `{ level, x, y, z? }`.
`z` is the height above the floor of its level in metres; without it `defaults.device_height_m` of
materials.json is used.

- Emitters are `aps[]` in the config: `id`, `label`, `network`, `kind` (`mesh` for a mesh point, else an access point or router), `tx_dbm` per band, `channel`, `bssid`, `position`.
  `data/private/ap-positions.json` overrides positions: `{ positions: { <id>: { level, x, y, z, heightSource,
  enclosureLossDb, enclosureSource, source } } }`. `enclosureLossDb` is taken off the transmit power (a device
  inside a cabinet). `heightSource` and `enclosureSource` say `assumed` or `measured`.
- Receivers are the nodes of the node file (below) and the positions in walk-test rows.

## Bands

`bands` in the config lists the bands the page shows: `[{ "id": "2.4", "label": "2.4 GHz" }, ...]`.
A band is usable when materials.json has `pathLoss[<id>]` (`pl0_db`, `n`, `freq_mhz`) and a `loss_db[<id>]`
for the materials in use. A band without those numbers is left out. Wi-Fi sample rows (Part 1) carry
`"2.4"` or `"5"`; rows for another band need that list in `sample.schema.json` extended first.

## The user's setup

`network-setup.json` is written by the Setup panel of the page (key D) through the local server: in
`data/private/` for the owner's house, in `data/user/` for a user layout (and always under `--public`).
When it exists, its networks and devices replace `networks`, `aps`, the saved marker positions and the node
file as a whole.
`{ schemaVersion: 1, saved, floorplan, networks: [{ id, label, ssid, color, upstream }], devices: [...] }`.
A device has `id`, `type` (`ap`, `mesh`: emitters; `esp32`, `pi`, `client`, `wired`: receivers), `label`,
`position` (`{ level, x, y, z?, heightSource? }` or `null` for "not placed") and `mount`. Emitters add
`network`, `model`, `tx_dbm`, `channel`, `bssid` (each one value per band) and `enclosureLossDb`; receivers
add `mac`, and their `id` is the `node_id` of their samples. Rules and limits: `src/core/setup.js`;
design: `docs/network-setup.md`.

# Part 3: walk survey files

All of them are NDJSON in `data/private/`. The first three are logs; `survey.ndjson` is rebuilt from them.

| File | Written by | Rows |
|---|---|---|
| `waypoints.ndjson` | the page in Survey mode (key S), through the local server | `{ "time", "kind": "waypoint", "id": "wp-0003", "level", "x", "y", "source": "app" }`: where you stood and when you clicked |
| `scans-laptop.ndjson` | `tools\walk-sample.ps1` | scan rows of Part 1 without a position, plus `signal_pct` and `"approx": true` (Windows gives a percentage; dBm = percent / 2 - 100) |
| `scans-pi.ndjson` | `collectors/pi/survey.py` | scan rows of Part 1 without a position, real dBm |
| `marks-pi.ndjson` | the phone page or a key press of `survey.py` | `{ "time", "kind": "mark", "seq": 3 }`: "I stand on waypoint 3 now", on the clock of the Pi |
| `survey.ndjson` | `node tools/survey-import.mjs` | walk-test rows of Part 1 (`pos_level`, `pos_x`, `pos_y`), one per waypoint, source and BSSID, plus `waypoint`, `readings`, `rssi_min_dbm`, `rssi_max_dbm`, `rssi_approx` and `ap_id` when the config knows the BSSID |

Join rules: a laptop scan belongs to a waypoint when it was taken at most 8 seconds before or after the click (`--window`); readings of one BSSID are averaged. A Pi scan belongs to mark k in the same way, and mark k is waypoint k. `node_id` is `survey-laptop` or `survey-pi`; the page shows it as the source.
The page loads `survey.ndjson` by itself (`GET /api/survey`); it does not have to be listed in `paths.samples`. A file whose first line is `{"kind":"meta","synthetic":true}` is synthetic as a whole: its walk-test points are shown as synthetic and never count as measured places.
