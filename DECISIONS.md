# DECISIONS

## 2026-11-15: wave simulation as the hero view
Options: static coverage heatmap; ray-traced model only; live FDTD wave field. Chose FDTD (GPU, 2D slice per floor coupled at stairs) over a calibrated dBm envelope, because the goal is a look like pressure waves in a confined space. Wavelength is scaled x10 and labelled; numbers come from the calibrated model.

## 2026-11-15: 2D slice per floor, not full 3D
Full 3D FDTD is too costly for a laptop GPU for little visual gain.

## 2026-11-15: display only, privacy mode from the start
No router control, no login. Privacy mode replaces SSIDs, BSSIDs, MACs, device names, address and compass so screenshots are safe to post.

## 2026-11-15: no 6 GHz
The home router and the mesh are both Wi-Fi 5, so the band switch is 2.4 and 5 GHz only.

## 2026-11-16: repo layout
Lives in `software\` (laptop-run web app; the ESP32 sketch is a small collector). Code and synthetic data only; `data/private/` is gitignored. Hand-off from a cloud session as a git bundle because the session could not create the GitHub repo.

## 2026-11-17: the floor plan comes from Polycam LiDAR exports, drawn north up
Options: keep tracing by hand; import in the first-floor plan frame and only store a north angle; import and turn every level north up. Chose the importer with a north-up frame (`tools/trace/import_polycam.py`), because the owner asked for true north and each Polycam plan has its own plan-up. The DXF gives walls, openings and rooms; the CSV gives areas, ceiling heights and the compass heading; the GLB only names stairs, fireplace and appliances. Cost: walls run at about 35 degrees to the grid.

## 2026-11-17: rotation from the compass, then walls made parallel; stacking from stairs, then outer walls
Each compass heading has 2.5 degrees of uncertainty and the two differ by 5 degrees after allowing for the 180 degree turn. Walls of one house are parallel, so north is the mean of the headings and each level is turned to make its walls parallel to the others. The stairs give the first shift (the owner confirmed one stair run joins the levels); the outer walls may move it by at most 0.6 m. Footprints are not forced to match.

## 2026-11-17: the frame is fixed at the first import
Marker positions, waypoints and samples are stored in plan coordinates. A later level must not move them, so rotation and origin are kept in `data/private/levels/frame.json`. `--refit-frame` sets them again on purpose.

## 2026-11-17: Polycam wall thickness is not used; gaps in the outer wall are closed
Polycam draws every wall at its 0.10 m setting, so thickness comes from the material in `data/materials.json`. Where the scan left a stretch of the outer edge without a wall, the importer adds an exterior wall and marks it (`origin: gap-closure`), because a house has no hole in its outer wall. Walls that the owner asked for are marked `owner-fix`.

## 2026-11-17: bands are a setting; the geometry has no radio field
`config.bands` lists the bands; a band works when `materials.json` has its path-loss numbers. Positions take `z`. This keeps the plan reusable for the contrail and SDR work (bands below 1.1 GHz) without building anything for it now.

## 2026-11-17: waves are beacon pulses, with brightness from the calibrated level
the owner said the waves looked made up. Diagnosis: every source was an endless tone; an automatic gain made every room equally bright; air loss was a fixed constant; sources had arbitrary clocks, strengths and slightly different frequencies; the wavelength ratio between bands was wrong on coarse grids; nothing was tied to a measured level. Three options were built behind a switch (key W): (1) beacon pulses, (2) beacon pulses with energy-flow arrows, (3) the old continuous tone. Chose (1) as the default: each front is one beacon, radios on one channel take turns (they do in reality), strength follows transmit power, the path follows the scanned walls, and brightness is the calibrated signal level, so every visible feature has a cause. (2) adds real information (where energy travels, through doorways and into the garage) but covers the fronts, so it is one key press away instead of the default. (3) stays only for comparison and says on screen that it is illustrative.

## 2026-11-17: air loss follows the path-loss exponent
The fixed 0.9 dB per metre is gone. A flat wave loses 10 log r; the model says 10 n log r; the difference, spread over the size of the house, is the loss per metre (`spreadingLossDbPerM`). It uses the calibrated n of the band, so it moves with the measurements.

## 2026-11-17: a pulse is a whole number of wave periods, cosine around its middle
A pulse of 1.5 periods left the whole floor tinted, because it pushed the field more one way than the other. The pulse now has zero sum and zero first moment; a solver test checks it.

## 2026-11-17: colour themes are data, and one readability check serves presets and custom palettes
Options: CSS-only recolouring; a fixed list of lookup images; themes as data in `src/core/colormaps.js` with one active theme. Chose themes as data, because every layer, the legend and the panels already read two ramps from that file. Presets: Mission control (unchanged, checked sample by sample against the old ramps), Aurora, Heat, Mono, Colour-blind safe. The checks moved to `src/core/colorcheck.js` so the page can warn about a custom palette with the same code that `tools/verify/check-colormap.mjs` runs for the presets. A custom palette that fails is still applied; the panel says what is wrong. The privacy badge and the SYNTHETIC labels keep their colours in every theme.

## 2026-11-17: survey mode joins by time on the laptop and by marks on the Pi
The laptop runs the page and the scanner, so the click time is the time of standing there: scans within 8 seconds of the click belong to the waypoint. The Pi has no map and its clock may be wrong on a power bank, so the Pi records marks ("I stand on the next spot") on its own clock and mark k is waypoint k. `survey.ndjson` is rebuilt from the raw logs on every import, so an import can be repeated.

## 2026-11-17: synthetic walk-test points never count as measured
The page marks every row of a file whose meta line says synthetic. Such points are shown as synthetic in Survey mode and are left out of "far from any sample" and "where to measure next". Walk-test rows also do not move the time window of the page.

## 2026-11-17: the laptop scanner asks Windows for a fresh scan
`netsh wlan show networks` returns the last scan Windows made, up to a minute old. `tools\walk-sample.ps1` calls `WlanScan` (the same request the Wi-Fi list of the taskbar makes) before each read. It changes no setting. Signal is a percentage on Windows; the rows are marked approximate.

## 2026-11-17: the Pi scanner is a script the owner starts by hand
Nothing is installed and nothing starts at boot on the survey Pi. The script writes two files in one folder and listens on one port while it runs. Known side effect, stated in `collectors/pi/SURVEY.md`: each scan takes the Wi-Fi radio off its channel for 2 to 4 seconds.

## 2026-11-17: networks and devices are one setup document, edited in the page (issue #2)
Options: keep editing `config.local.json`, the node file and `ap-positions.json` by hand; a form that writes those three files; one new document that the page edits. Chose one document, `data/user/network-setup.json`, with a Setup panel (key D). A device is one row with a type; access points and mesh points become `config.aps`, sensors and clients become the node list, so the model, the waves and the samples need no new concept. BSSIDs sit on the radio of a device, not on the network, because one SSID runs on many mesh points. It lives in `data/user/`, apart from `data/private/`, so a public user's data can be removed alone. Without a server that can save, the same document goes to `localStorage`, which is what a hosted public page would use. Design: `docs/network-setup.md`.

## 2026-11-17: a setup replaces networks, access points and nodes as a whole
A merge by id (as `config.local.json` does) cannot remove anything. So when a setup exists it is the whole truth for these three lists, and a dragged access point is saved to the setup instead of `ap-positions.json`. Until the first change nothing is written and the old files work as before. A device on a level that the plan does not have becomes "not placed", so a setup survives a new plan.

the owner confirmed it the same day: on his own house the setup made in the page is the source of truth, not `config.local.json`; the public release starts with the simulated house (`data/config.default.json`, which holds nothing of his). He also accepted the key D, the panel on the right, and the limits (16 networks, 200 devices, 4 networks in the coverage table, 16 wave sources).

## 2026-11-17: an access point of the config can say `"kind": "mesh"`
The Setup panel starts from the config, which had no way to tell a mesh point from a router, so all four showed as "Access point". The three mesh points of the default config now carry `"kind": "mesh"`. The private config merges by id and uses the same ids, so it gets the flag without a change to the private file.

## 2026-11-17: networks are a list, not a fixed pair
The network switch, the coverage table, the colours, the chain in the Networks section and the key N now read `config.networks`. The first two colours are the old ones, so the house looks the same. Two sentences in the Networks section lost their router-and-mesh wording, because the page cannot know which network is a mesh. The coverage table lists at most four networks.

## 2026-11-17: the Setup panel hides private fields in privacy mode instead of masking them
Names, SSIDs, BSSIDs, MAC addresses, models and sensor ids are left out of the page; elements carry list positions, not ids. Place, height, power and channel stay editable, so a setup can be shown on a stream. The generic names ("Access point 2") now count every access point of the config, also one that is not placed, so the panel and the map agree. `privacy-check.mjs` opens every device of the panel and now also reads what inputs hold.

## 2026-11-17: the local server answers only as itself
Two reviews (an automated security review and one independent reviewer) found that a web page of another site could write waypoints through `/api/` and, through a foreign host name pointed at 127.0.0.1, read private files. The server now checks the Host header on every request, refuses a changing request from another origin, and takes only JSON bodies. It also tests its block list (`.env`, `secrets.h`, `.git`) on the path as the file system sees it, because on Windows a backslash in the address is a folder separator. The Pi phone page needs a short code that the script prints at start.

## 2026-11-17: a user's layout lives in data/user/, apart from data/private/ (issue #1)
The public version must not carry the owner's house. Options: reuse `data/private/` for everyone; browser storage only; a second gitignored folder. Chose `data/user/` with its own `config.user.json`, written only through `/api/layout`, and browser storage as the fallback on a static host. The page picks one workspace at start: `?demo=1` (neither folder), `?layout=user`, else the private config when it exists. `tools/serve.mjs --public` does not serve `data/private/` at all, so a public build is that flag plus deleting the folder; no code path has to be cut.

## 2026-11-17: all three ways in end in one editor and one draft (issue #1)
A scan export, a plan image and a hand-drawn plan each become a "draft" in the Layout setup panel, and `src/core/layout.js` turns the draft into a `floorplan.json` of the existing contract. On a drawn floor the user draws rooms; walls and outline are worked out from the rooms (one side in a room = exterior, both sides = interior). An imported floor keeps its walls. Materials come from the `construction` table by kind of floor, so they stay assumptions. Two new `source` values, `drawn` and `image-trace`, say on screen how a floor was made.

## 2026-11-17: scan import reuses the Python importer through the local server (issue #1)
Options: a DXF reader in the browser; the existing `tools/trace/import_polycam.py` behind a server endpoint. Chose the endpoint: the importer already handles Polycam's wall outlines, openings, room merges, gap closure, compass and stacking, and is tested on real exports; a second reader in JavaScript would have to repeat all of it and would drift. Cost: scan import needs the local server and a Python environment (the panel says which command sets it up); the image and drawing ways need neither. Other scan formats get their own readers later. Uploads are raw bytes, so the server now also accepts `application/octet-stream`, which a foreign page cannot send without the browser asking first, as with JSON.

## 2026-11-17: a plan image is hidden in privacy mode and stored as a redrawn copy (issue #1)
A floor-plan picture can show an address in its title block and can carry a GPS position in its file data. The browser draws the picture again and only that copy (JPEG) is stored; privacy mode does not draw it in the panel, and hides the house name there.

## 2026-11-17: the network setup lives with the house it describes (merge of issues #1 and #2)
Options: one `data/user/network-setup.json` for every house; the owner's setup in `data/private/` and a user layout's in `data/user/`. Chose the split: real SSIDs and BSSIDs stay with the other private data, so deleting `data/private/` still removes all of the owner's data (issue #1). `/api/setup?ws=private` selects it; `--public` refuses it and does not read the laptop scan log. Once a setup exists it is the one source of device positions; `ap-positions.json` only seeds it. A free mount text of the config ("inside a cabinet") maps to a setup mount, so a setup started from the real config is valid.

## 2026-11-17: scan import stays Python only; no browser DXF reader (issue #1)
Options put to the owner: keep the Python importer behind the local server; add a light DXF reader in the browser as the default and keep Python as the precise import; port the importer to JavaScript. the owner chose Python only. Why: it is built and matches Polycam's own areas, it stacks floors and reads ceiling heights and stairs, and one importer cannot drift from a second one. Python with ezdxf, numpy, pillow and shapely is a stated dependency of scan upload only; the image and drawing ways need neither Python nor the server. Known cost: a version hosted as a static page has no scan import.

## 2026-11-17: `--public` becomes the default once data/private/ is cut (issue #1)
the owner's decision. Until then it stays a flag of `tools/serve.mjs`, because the owner's house is still served from `data/private/` on this laptop.

## 2026-11-17: a level is stacked on the flight of the anchor level that its outer walls agree with
The first floor shows two flights: the one down to the basement (large) and the foot of the one up (small, beside it). Options: always seed on the largest flight; try every flight and keep the one that puts most outer wall on outer wall. Chose the second, with the largest flight first so that it wins a tie. Why: seeded on the large flight, the real second floor sat 0.86 m off and hung 8.4 m2 over the first floor; on the small flight it sits 15 cm from it and 0.7 m2 over. The 0.6 m limit on what the walls may move stays.

## 2026-11-17: one stairwell is drawn the same on every level that saw it
the owner confirmed the stairs: one stairwell from the basement to the second floor, each storey with a landing half-way and a turn back, so two runs lie side by side. Each scan sees only a part (the run up from its floor, or the top of the run that arrives). Options: keep the part each scan saw; give every level the whole stairwell. Chose the whole stairwell: flights of different levels that touch are one stairwell, cut into one rectangle for each run (2 runs, 1.81 m long, 2.08 m wide here), with the same polygons on each level, so the stairs lie on each other and couple the floors over the full opening. The landing is not in it: no scan shows it as stairs. Stairs that only one level saw stay as scanned.

## 2026-11-17: the public repo is a fresh squashed export, MIT, with a generic demo house
Options: make this repo public with its history; filter its history; export the current tree as one new commit in a new repo (the gps-mgrs-toolkit precedent). Chose the export: `tools/release/public-cut.mjs` builds the tree through a temporary index and `git archive` (never ignored files), drops the owner's notes and the release tools, and screens every file for names, home hosts, LAN ranges, mail domains and every SSID, BSSID, MAC and scan address read from the private folders. Exit 1 on any hit. Licence MIT, Cold Bore R&D. The only commit identity is the Cold Bore R&D address, with no co-author trailer. The demo house got generic networks (Atlas-Home, Atlas-Mesh) and everyday devices; the old network ids stayed for the moment (renamed the same day, see the next entry). Launch content lives in `docs/launch/` of the private repo and is screened with `--screen docs/launch` before each post.

## 2026-11-17: the network ids are `home` and `mesh`, and the demo BSSIDs are neutral
The old ids and the demo BSSID prefixes named the owner's internet provider and mesh brand, which the public code would have shown. Options: keep them (no migration), rename to other brand names, rename to generic ids. Chose generic ids (`home`, `mesh`, AP `home-router`): a made-up brand raises its own questions. The owner's private files were rewritten by structure (network keys and id fields only, never measured SSIDs), with a backup in `data/private/backup-before-id-rename/`; the merged config and the rebuilt survey match the old ones with the ids mapped. The demo router's noise changed, because the generator seeds shadowing from the AP id. Brand names are now in the cut's screen.
