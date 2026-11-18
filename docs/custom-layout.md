# Custom layout: make the atlas look like your house

Issue #1. Anyone can give the atlas their own house in one of three ways. All three end in the same
file, a `floorplan.json` that follows `docs/data-contract.md` Part 2 and passes
`node tools/validate-floorplan.mjs`. Nothing downstream (scene, model, wave solver) knows which way was used.

Open the panel with the **Layout** button in the top bar or the key `L`.

## The three ways in

| Way | You give | What happens | `source` of a level |
|---|---|---|---|
| 1. Scan export | Polycam `floorplan.dxf` per floor; `floorplan.csv` and `model.glb` if you have them | The local server runs `tools/trace/import_polycam.py` on the files and hands the plan to the editor | `lidar-scan` |
| 1b. Plan file | A `floorplan.json` made elsewhere | Checked, then loaded into the editor | as in the file |
| 2. Plan image | A picture or rendering of a floor (PNG, JPEG, WebP) | Shown under the grid. Two clicks on a known length set the scale. You trace rooms over it | `image-trace` |
| 3. Build it | Nothing | Draw rooms on a grid (rectangle or corner by corner), add walls, doors, windows, openings, stairs | `drawn` |

The editor is the same for all of them, so a scan can be corrected and an image trace can be extended.
Floors: add one above or below, copy a floor, set name and ceiling height. Undo with Ctrl+Z.

**Drawn floors.** You draw rooms; the walls and the outline are worked out from them. An edge with a room on
one side is an exterior wall, an edge between two rooms is an interior wall. A door or window is put on a
wall by a click. Materials come from the `construction` table of `data/materials.json` (basement, main,
upper), so every material is an assumption that the calibration can correct later.

**Imported floors** keep their walls and outline as imported. Rooms can be renamed, and walls, doors,
windows and stairs can be added.

**Apply** checks the plan with the same code as `tools/validate-floorplan.mjs`, saves it and reloads the page
on it. A plan with errors is not saved; the panel lists what is wrong.

## Where a user's data lives

| Workspace | Folder | Holds | Read when |
|---|---|---|---|
| Demo | `data/synthetic/` (in git) | the made-up house | `?demo=1`, or nothing else exists |
| User | `data/user/` (gitignored) | `floorplan.json`, `layout-draft.json` (the editor's own state), `underlay-<floor>.jpg`, `config.user.json`, `scan/` (uploaded exports and importer output) | `?layout=user`, or by default when there is no private config |
| Owner | `data/private/` (gitignored) | the owner's house, address, network names | by default when its config exists |

- The panel reads and writes `data/user/` only, through `/api/layout`. It never touches `data/private/`.
- `?demo=1` shows the demo house and reads neither `data/private/` nor `data/user/` at start. Opening the
  panel is the one thing that reads `data/user/` there.
- "Remove my layout" deletes the plan, the draft, the images, the marker positions and the scan uploads, and
  takes the house name and north out of `config.user.json`. Other settings in that file stay.
- Marker positions of a user layout go to `data/user/ap-positions.json`. The walk survey of the private
  house is not loaded on a user layout.
- `node tools/serve.mjs --public` does not serve `data/private/` at all and saves marker positions and
  waypoints to `data/user/`. A public build is this flag plus deleting `data/private/`; no code holds a
  personal value.
- Without the local server (a static host) the plan and the draft are kept in the browser's storage. Scan
  import needs the local server and Python; the other ways do not.
- An image is drawn again by the browser before it is stored, which drops camera data such as a GPS position.
  A plan image can still show an address in its title block: privacy mode hides the image and the house name
  in the panel. The scan importer reads only the listed CSV rows and never the address or position.

## In the first version

Scan import through the local server; plan-file import; image underlay with a two-click scale, move and
opacity; the editor (rooms, walls, doors, windows, openings, stairs, floors, heights, undo, snap, lengths
typed as metres or feet); live check; save and load of the draft; default places for the access points
inside a new plan.

## Later

- Other scan formats (Apple RoomPlan USDZ, magicplan, generic DXF or SVG): each needs its own reader that
  writes the same draft. Scan import stays on the Python importer; a DXF reader in the browser is not
  planned (DECISIONS.md). Python is a dependency of scan upload only.
- `--public` becomes the default of the server once `data/private/` is cut.
- Finding walls in an image automatically; turning an image; an underlay in the 3D view.
- North and front door for a drawn plan (today north is up the page).
- A courtyard inside a ring of rooms counts as inside the house (the outline is the outer edge only).
- Curved walls, sloped ceilings, per-wall material choice in the panel (the file format already has it).
- The walk survey in the user workspace (the server side is ready under `--public`; the page does not load it yet).
- Fixtures (fireplace, appliances) in the editor; imported ones are kept.
