# Network setup: your own networks and devices

Issue #2. A user says which Wi-Fi networks are theirs, which devices they want on the map, and where
each device is. No file is edited by hand and no network setting is ever changed.

## Data model

One document, the **setup**: `{ schemaVersion, saved, floorplan, networks[], devices[] }`.

| Thing | Fields |
|---|---|
| network | `id`, `label`, `ssid`, `color`, `upstream` (the network it sits behind, or null) |
| device | `id`, `type`, `label`, `position`, `mount`; emitters add `network`, `model`, `tx_dbm`, `channel` and `bssid` per band, `enclosureLossDb`; receivers add `mac` |
| position | `{ level, x, y, z, heightSource }` in plan metres, or `null` = not placed yet |

`type` is `ap` or `mesh` (emitters: they become `config.aps` and wave sources) or `esp32`, `pi`, `client`,
`wired` (receivers: they become the node list). A receiver `id` is the `node_id` its samples carry. BSSIDs
belong to the radio of a device, one per band; the network only carries the name. That is how one SSID
on many mesh points works.

`src/core/setup.js` holds the rules as pure functions: `setupFromConfig` (start from what is on screen),
`applySetup` (setup to `networks`, `aps` and nodes), `validateSetup` and `cleanSetup` (used by the server
before it writes), `radiosFromScans` (the BSSID helper).

## Where it is stored

- With the local server: `network-setup.json` (gitignored), through `GET`, `PUT` and `DELETE /api/setup`.
  The owner's house keeps it in `data/private/` (`/api/setup?ws=private`), so real network names stay with
  the other private data; a user layout keeps it in `data/user/`. `--public` refuses `ws=private` and does
  not read the laptop scan log in `data/private/`.
  The server keeps its Host, Origin and JSON checks, validates the body and writes only known fields.
- One source of positions: once a setup exists it holds every device and its place. The marker files
  (`ap-positions.json` in `data/private/` or `data/user/`) only seed a new setup and are no longer written.
- Without a server that can save (a static host): the same document in `localStorage` of the browser.
- Export and Import move a setup between the two as a JSON file.
- Delete the setup file (or press Reset) and the page is back to its defaults.
- Order at start: `config.default.json`, then `data/private/config.local.json`, then saved marker positions,
  then the setup. A setup replaces `networks`, `aps` and the nodes as a whole, so a removed device stays
  removed. `?demo=1` ignores the setup and saves nothing.
- Until the first change nothing is written: the panel shows what the config holds. From then on a dragged
  access point goes to the setup, not to `ap-positions.json`.
- `tools/survey-import.mjs` and `tools/verify/privacy-check.mjs` read the setup file too.

## Any plan, many devices

- Positions are plan metres on a level id. A device whose level is not in the current plan becomes
  "not placed" instead of an error, so a setup survives a new or changed plan (issue #1).
- The panel shows one line per device and opens one editor at a time; a filter box appears above 8 devices.
  Limits: 16 networks, 200 devices. The wave view draws the 16 strongest sources; the signal map uses all.
- A change updates the model without a reload: only moved emitters are traced again, then the model is
  calibrated again and the worker gets the same update.
- Network colours, the network switch, the coverage table and the key `N` follow the list of networks.

## Privacy

Labels, SSIDs, BSSIDs, MAC addresses, models and sensor ids are private. In privacy mode the panel shows
"Network A", "Access point 1", "Sensor 2" and leaves the private fields out of the page; position, height,
power and channel stay editable. The scan helper is not loaded in privacy mode.

## First version

Add, rename, recolour and remove networks. Add, edit and remove devices (undo for the last removal).
Place a device with "Place on plan" and a click (the view goes to the 2D plan of that level), drag an
access point, or type level, x, y and height. Mount sets a default height. BSSID and channel can be picked
from the last laptop scan (`scans-laptop.ndjson`, read only) when its SSID matches. Export, import, reset.

## Later

- Dragging sensors and clients (now: click to place); a marker shape per device type.
- "Add every radio of this SSID" from a scan, pairing the 2.4 and 5 GHz radios of one box.
- Upstream (which network sits behind which) in the panel; it is kept in the data already.
- Antenna pattern and direction; 6 GHz when a band is added to `data/materials.json`.
- A "measured" tick for a height or a cabinet loss (now every typed value stays "assumed").
- A hosted public page: it works from `localStorage` already, but nothing is deployed.
