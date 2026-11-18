"""Tests for tools/trace/import_polycam.py.

    .venv\\Scripts\\python.exe -m unittest tools\\trace\\test_import_polycam.py

Everything here is made up inside the test: a small two-level house as DXF, CSV
and GLB files in a temporary folder. The private Polycam exports are never read.
"""
import json
import math
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import ezdxf
import numpy as np
from shapely.geometry import Point, Polygon

sys.path.insert(0, str(Path(__file__).resolve().parent))
import import_polycam as ip  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SECRET_ADDRESS = "1 Secret Street, Hidden Town"
SECRET_LAT, SECRET_LON = "39.123456", "-77.654321"
STAIR_OFFSET_M = 0.06
LAYER = "Polycam-Floor_1-"


def hexagon(a, b, t=0.1):
    """A wall outline the way Polycam draws it: a hexagon whose two tips are the ends of the centre line."""
    h = t / 2
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
    nx, ny = -uy, ux
    pts = [a, (a[0] + ux * h + nx * h, a[1] + uy * h + ny * h), (b[0] - ux * h + nx * h, b[1] - uy * h + ny * h),
           b, (b[0] - ux * h - nx * h, b[1] - uy * h - ny * h), (a[0] + ux * h - nx * h, a[1] + uy * h - ny * h)]
    return pts + [pts[0]]


def rect_on(a, b, t=0.1):
    """A door or window: a rectangle inside the wall, from a to b along the centre line."""
    h = t / 2
    length = math.hypot(b[0] - a[0], b[1] - a[1])
    nx, ny = -(b[1] - a[1]) / length, (b[0] - a[0]) / length
    pts = [(a[0] + nx * h, a[1] + ny * h), (b[0] + nx * h, b[1] + ny * h), (b[0] - nx * h, b[1] - ny * h), (a[0] - nx * h, a[1] - ny * h)]
    return pts + [pts[0]]


def write_dxf(path, walls, rooms, doors=(), windows=(), openings=(), leaves=(), turn=None):
    """rooms: [(label, polygon)]. turn: a function applied to every point (to draw a level rotated)."""
    turn = turn or (lambda p: p)
    doc = ezdxf.new("R2004")
    msp = doc.modelspace()

    def add(points, layer):
        msp.add_lwpolyline([turn(p) for p in points], dxfattribs={"layer": layer})
        msp.add_lwpolyline([turn(p) for p in points], dxfattribs={"layer": layer})   # Polycam writes each outline twice

    for a, b in walls:
        add(hexagon(a, b), LAYER + "Walls")
    for label, poly in rooms:
        add(list(poly) + [poly[0]], LAYER + "Floors")
        cx, cy = sum(p[0] for p in poly) / len(poly), sum(p[1] for p in poly) / len(poly)
        msp.add_mtext("\\A1;" + label, dxfattribs={"layer": LAYER + "Labels-Rooms", "insert": turn((cx, cy))})
    for a, b in doors:
        add(rect_on(a, b), LAYER + "Openings-Doors")
    for a, b in leaves:
        add(rect_on(a, b, 0.035), LAYER + "Openings-Doors")
    for a, b in windows:
        add(rect_on(a, b), LAYER + "Openings-Windows")
    for a, b in openings:
        add(rect_on(a, b), LAYER + "Openings-Openings")
    msp.add_mtext(SECRET_ADDRESS, dxfattribs={"layer": "Polycam-Header", "insert": (0, 9)})
    msp.add_mtext("\\A1;8.00 m", dxfattribs={"layer": LAYER + "Dimensions-Exterior", "insert": (4, -0.5)})
    doc.saveas(path)


def write_csv(path, heading, rooms, exterior):
    rows = [("Room", "Description", "Value"), ("Entire Roomplan", "Address", SECRET_ADDRESS),
            ("Entire Roomplan", "Latitude [deg]", SECRET_LAT), ("Entire Roomplan", "Longitude [deg]", SECRET_LON),
            ("Entire Roomplan", "Compass direction [deg]", str(heading)), ("Entire Roomplan", "Compass direction uncertainty (1-sigma) [deg]", "2.5"),
            ("Entire Roomplan", "Total exterior floor area [m^2]", str(exterior))]
    for label, area, ceiling in rooms:
        rows.append((label, "Floor area [m^2]", str(area)))
        rows.append((label, "Ceiling height [m]", str(ceiling)))
    rows.append(("Settings", "Wall thickness [m] (total wall length: 1)", "0.100"))
    Path(path).write_text("\n".join(",".join(f'"{c}"' if "," in c else c for c in r) for r in rows) + "\n", encoding="utf-8")


def write_glb(path, boxes):
    """boxes: [(name, x0, x1, plan_y0, plan_y1, height)] with plan y as in the DXF (up). GLB z = -DXF y."""
    blob, views, accessors, meshes, nodes = b"", [], [], [], []
    for name, x0, x1, y0, y1, h in boxes:
        corners = [(x, z, -y) for x in (x0, x1) for y in (y0, y1) for z in (0.0, h)]
        data = np.array(corners, dtype="<f4").tobytes()
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
        accessors.append({"bufferView": len(views) - 1, "componentType": 5126, "count": 8, "type": "VEC3"})
        meshes.append({"primitives": [{"attributes": {"POSITION": len(accessors) - 1}}]})
        nodes.append({"mesh": len(meshes) - 1, "name": name})
        blob += data
    gltf = json.dumps({"asset": {"version": "2.0"}, "buffers": [{"byteLength": len(blob)}], "bufferViews": views, "accessors": accessors, "meshes": meshes,
                       "nodes": nodes + [{"name": "Polycam", "children": list(range(len(nodes)))}], "scenes": [{"nodes": [len(nodes)]}], "scene": 0}).encode()
    gltf += b" " * (-len(gltf) % 4)
    blob += b"\0" * (-len(blob) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(gltf) + 8 + len(blob)))
        f.write(struct.pack("<II", len(gltf), 0x4E4F534A) + gltf)
        f.write(struct.pack("<II", len(blob), 0x004E4942) + blob)


class ImporterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="atlas-import-test-"))
        src, out = cls.tmp / "src", cls.tmp / "out"
        (src / "main").mkdir(parents=True)
        (src / "cellar").mkdir(parents=True)
        out.mkdir()
        # ---- main level: an 8 x 6 m house. Plan-up is 30 degrees west of north.
        walls = [((0, 0), (8, 0)), ((8, 0), (8, 6)), ((5, 6), (0, 6)),          # the top edge from x = 5 to 8 has no wall (gap)
                 ((0, 0), (0, 4)),                                             # the left wall stops at y = 4 (owner fix)
                 ((5, 0), (5, 6)), ((5, 3), (8, 3))]
        rooms = [("Living Room 1", [(0, 0), (5, 0), (5, 6), (0, 6)]), ("Closet 1", [(5, 0), (8, 0), (8, 3), (5, 3)]),
                 ("Other", [(5, 3), (8, 3), (8, 6), (5, 6)]), ("Other 3", [(0, 6), (1.2, 6), (1.2, 6.4), (0, 6.4)])]
        write_dxf(src / "main" / "floorplan.dxf", walls, rooms, doors=[((5, 1), (5, 1.9)), ((3, 0), (3.9, 0))], leaves=[((5, 1), (5.6, 1.6))],
                  windows=[((1, 0), (2.2, 0))], openings=[((5.5, 3), (7.5, 3))])
        write_csv(src / "main" / "floorplan.csv", -30.0, [("Living Room 1", 28.9, 3.0), ("Closet 1", 8.4, 5.1), ("Other", 8.4, 5.1)], 50.0)
        write_glb(src / "main" / "model.glb", [("stairs7_0", 1.0, 2.0, 0.5, 2.5, 1.7), ("fireplace_0", 2.0, 3.5, 5.4, 6.0, 1.7), ("refrigerator_0", 4.9, 4.93, 4.0, 5.0, 2.0), ("sofa_rect_0", 1, 3, 1, 2, 0.8)])
        # ---- cellar: the same outline, drawn turned by 180 degrees, compass off by 2 degrees, stairs 6 cm off
        turn = lambda p: (8 - p[0], 6 - p[1])
        outer = [((0, 0), (8, 0)), ((8, 0), (8, 6)), ((8, 6), (0, 6)), ((0, 6), (0, 0))]
        write_dxf(src / "cellar" / "floorplan.dxf", outer, [("Cellar", [(0, 0), (8, 0), (8, 6), (0, 6)])], turn=turn)
        write_csv(src / "cellar" / "floorplan.csv", 152.0, [("Cellar", 47.0, 2.4)], 48.9)
        write_glb(src / "cellar" / "model.glb", [("stairs7_0", 6.0 + STAIR_OFFSET_M, 7.0 + STAIR_OFFSET_M, 3.5, 5.5, 1.3)])
        (out / "room-names.json").write_text(json.dumps({"main": {"rooms": {
            "1": {"polycam": "Living Room 1", "name": "Hall", "fix": "close_open_edges_with_walls"},
            "2": {"polycam": "Closet 1", "name": "Den"}, "3": {"polycam": "Other", "name": "Den"},
            "4": {"polycam": "Other 3", "name": None, "is_wall": True}}}}), encoding="utf-8")
        cls.levels_file = cls.tmp / "levels.json"
        cls.levels_file.write_text(json.dumps({"levels": [
            {"key": "cellar", "id": "B", "name": "Cellar", "construction": "basement"},
            {"key": "main", "id": "1", "name": "Main", "construction": "main", "anchor": True},
            {"key": "upper", "id": "2", "name": "Upper", "construction": "upper", "synthesizeIfMissing": True}]}), encoding="utf-8")
        cls.src, cls.out = src, out
        cls.args = ["--source-dir", str(src), "--out-dir", str(out), "--levels-file", str(cls.levels_file), "--quiet"]
        ip.main(["--all"] + cls.args)
        cls.main = json.loads((out / "levels" / "main.json").read_text(encoding="utf-8"))
        cls.plan = json.loads((out / "floorplan.json").read_text(encoding="utf-8"))
        cls.report = json.loads((out / "import-report.json").read_text(encoding="utf-8"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_rooms_use_the_owner_names_and_merges(self):
        names = sorted(r["name"] for r in self.main["rooms"])
        self.assertEqual(names, ["Den", "Hall"])                      # two polygons merged, the "wall" room removed
        den = next(r for r in self.main["rooms"] if r["name"] == "Den")
        self.assertEqual(den["sourceLabel"], "Closet 1 + Other")
        self.assertEqual(den["nameSource"], "confirmed")
        hall = next(r for r in self.main["rooms"] if r["name"] == "Hall")
        self.assertAlmostEqual(hall["ceilingHeight"], 3.0)
        self.assertAlmostEqual(den["ceilingHeight"], 5.1)

    def test_walls_get_materials_from_what_lies_beside_them(self):
        by = {}
        for w in self.main["walls"]:
            by.setdefault(w["material"], 0.0)
            by[w["material"]] += math.dist(w["a"], w["b"])
        self.assertAlmostEqual(by["ext-siding"], 28.0, delta=0.9)      # the whole 8 x 6 outline, added pieces included
        self.assertGreater(by["int-drywall"], 8.5)                     # the two inner walls and the solid mass
        self.assertTrue(all(w["exterior"] == (w["material"] == "ext-siding") for w in self.main["walls"]))

    def test_missing_walls_are_added_and_marked(self):
        origins = sorted(w.get("origin", "scan") for w in self.main["walls"] if w.get("origin"))
        self.assertIn("owner-fix", origins)       # the left edge of the Hall above y = 4
        self.assertIn("gap-closure", origins)     # the top edge of the Den
        kinds = [a["kind"] for a in self.main["checks"]["wallsAdded"]]
        self.assertIn("wall added on an open edge", kinds)
        self.assertIn("gap in the outer wall closed", kinds)
        solid = [w for w in self.main["walls"] if w.get("thickness")]
        self.assertEqual(len(solid), 1)
        self.assertAlmostEqual(solid[0]["thickness"], 0.4, delta=0.01)

    def test_openings_sit_on_walls_and_door_leaves_are_ignored(self):
        types = sorted(o["type"] for o in self.main["openings"])
        self.assertEqual(types, ["door", "door", "opening", "window"])
        self.assertEqual(self.main["checks"]["counts"]["doorLeavesIgnored"], 1)
        for o in self.main["openings"]:
            self.assertGreaterEqual(ip.host_wall(o["a"], o["b"], self.main["walls"]), 0, o)
        inner = next(o for o in self.main["openings"] if o["type"] == "door" and not o["exterior"])
        outer = next(o for o in self.main["openings"] if o["type"] == "door" and o["exterior"])
        self.assertEqual((inner["material"], inner["state"]), ("door-hollow", "open"))
        self.assertEqual((outer["material"], outer["state"]), ("door-exterior", "closed"))

    def test_an_opening_over_two_kinds_of_wall_is_cut_and_the_walls_keep_their_material(self):
        # the window on the bottom wall of the Hall is moved so that it runs past x = 5, where the
        # room beside the wall changes; here both pieces are exterior, so make one piece a garage wall
        walls = [{"a": (0.0, 0.0), "b": (5.0, 0.0), "material": "ext-siding"}, {"a": (5.0, 0.0), "b": (8.0, 0.0), "material": "int-garage"}]
        self.assertEqual(ip.host_wall((4.5, 0.0), (5.6, 0.0), walls), -1)          # it lies on no single piece
        self.assertEqual(ip.host_wall((4.5, 0.0), (5.0, 0.0), walls), 0)
        self.assertEqual(ip.host_wall((5.0, 0.0), (5.6, 0.0), walls), 1)

    def test_stairs_and_fixtures_come_from_the_named_objects(self):
        self.assertEqual(len(self.main["stairs"]), 1)
        self.assertEqual([f["name"] for f in self.main["fixtures"]], ["fireplace"])           # furniture ignored
        self.assertEqual([s["name"] for s in self.main["checks"]["fixturesSkipped"]], ["refrigerator_0"])   # a flat face has no depth

    def test_areas_match_the_csv(self):
        self.assertAlmostEqual(self.main["checks"]["exteriorAreaM2"]["imported"], 50.0, delta=0.6)
        for row in self.main["checks"]["rooms"]:
            self.assertLess(abs(row["diffM2"]), 0.1, row)

    def test_levels_are_turned_north_up_and_made_parallel(self):
        rot = self.report["rotation"]
        self.assertAlmostEqual(rot["main"]["usedDeg"], 29.0, delta=0.05)       # mean of 30 and 28
        self.assertAlmostEqual(rot["cellar"]["usedDeg"], 209.0, delta=0.05)
        self.assertEqual(self.report["north"]["northDeg"], 0)

    def test_stair_alignment_residual(self):
        stack = self.report["stacking"]["cellar"]
        self.assertEqual(stack["method"], "stairs, then outer walls")
        self.assertGreater(stack["outerWallShareMatched"], 0.9)
        self.assertAlmostEqual(stack["stairResidualCm"]["total"], STAIR_OFFSET_M * 100, delta=1.5)
        # the outer walls of the two levels coincide after stacking
        cellar, main = (next(lv for lv in self.plan["levels"] if lv["id"] == i) for i in ("B", "1"))
        for p in cellar["outline"]:
            self.assertLess(Polygon(main["outline"]).exterior.distance(Point(p)), 0.03)

    def test_plan_passes_the_validator_and_has_a_synthetic_upper_level(self):
        result = subprocess.run(["node", str(ROOT / "tools/validate-floorplan.mjs"), str(self.out / "floorplan.json")], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        upper = next(lv for lv in self.plan["levels"] if lv["id"] == "2")
        self.assertEqual(upper["source"], "synthetic")
        main = next(lv for lv in self.plan["levels"] if lv["id"] == "1")
        self.assertEqual(upper["stairs"][0]["polygon"], main["stairs"][0]["polygon"])       # the real stair position
        self.assertEqual(main["stairs"][0]["connects"], ["2", "B"])                         # one stairwell, seen from both levels
        cellar = next(lv for lv in self.plan["levels"] if lv["id"] == "B")
        self.assertEqual(cellar["stairs"][0]["polygon"], main["stairs"][0]["polygon"])
        self.assertEqual(self.report["doubleHeight"][0]["room"], "Den")

    def test_address_and_gps_never_reach_the_output(self):
        for f in self.out.rglob("*"):
            if f.is_file() and f.suffix in (".json", ".md", ".txt"):
                text = f.read_text(encoding="utf-8")
                for secret in (SECRET_ADDRESS, "Secret Street", SECRET_LAT, SECRET_LON):
                    self.assertNotIn(secret, text, f.name)

    def test_importing_again_keeps_the_frame(self):
        before = json.loads((self.out / "floorplan.json").read_text(encoding="utf-8"))
        write_csv(self.src / "cellar" / "floorplan.csv", 158.0, [("Cellar", 47.0, 2.4)], 48.9)     # a different compass reading
        ip.main(["--level", "cellar"] + self.args)
        after = json.loads((self.out / "floorplan.json").read_text(encoding="utf-8"))
        self.assertEqual(before["levels"][1]["outline"], after["levels"][1]["outline"])
        report = json.loads((self.out / "import-report.json").read_text(encoding="utf-8"))
        self.assertTrue(report["frameLock"]["locked"])
        self.assertAlmostEqual(abs(report["frameLock"]["differenceDeg"]), 3.0, delta=0.1)

    def test_png_offset_is_found(self):
        from PIL import Image, ImageDraw
        walls = [{"a": (0.0, 0.0), "b": (8.0, 0.0)}, {"a": (8.0, 0.0), "b": (8.0, 6.0)}, {"a": (8.0, 6.0), "b": (0.0, 6.0)}, {"a": (0.0, 6.0), "b": (0.0, 0.0)}, {"a": (5.0, 0.0), "b": (5.0, 6.0)}]
        ox, oy = -2.37, -1.81
        img = Image.new("RGB", (1300, 1000), "white")
        d = ImageDraw.Draw(img)
        for w in walls:
            d.line([((w["a"][0] - ox) * 100, (w["a"][1] - oy) * 100), ((w["b"][0] - ox) * 100, (w["b"][1] - oy) * 100)], fill=(88, 90, 112), width=10)
        png = self.tmp / "plan.png"
        img.save(png)
        fx, fy = ip.detect_png_offset(png, walls)
        self.assertAlmostEqual(fx, ox, delta=0.015)
        self.assertAlmostEqual(fy, oy, delta=0.015)


class TwoFlightsTest(unittest.TestCase):
    """The anchor level shows the flight down (large) and the foot of the flight up (small, beside it)."""

    def test_a_scanned_upper_level_is_stacked_on_the_flight_it_joins(self):
        tmp = Path(tempfile.mkdtemp(prefix="atlas-import-test-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        src, out = tmp / "src", tmp / "out"
        outer = [((0, 0), (8, 0)), ((8, 0), (8, 6)), ((8, 6), (0, 6)), ((0, 6), (0, 0))]
        box = [(0, 0), (8, 0), (8, 6), (0, 6)]
        for key, heading, stairs in (("main", 0.0, [("stairs7_0", 1.0, 2.0, 0.5, 2.5, 1.7), ("stairs3_0", 2.0, 3.0, 1.5, 2.5, 0.15)]),
                                     ("upper", 0.0, [("stairs3_0", 2.0, 3.0, 1.2, 2.8, 0.05)])):
            (src / key).mkdir(parents=True)
            write_dxf(src / key / "floorplan.dxf", outer, [("Room", box)])
            write_csv(src / key / "floorplan.csv", heading, [("Room", 47.0, 2.4)], 48.9)
            write_glb(src / key / "model.glb", stairs)
        out.mkdir()
        levels = tmp / "levels.json"
        levels.write_text(json.dumps({"levels": [
            {"key": "main", "id": "1", "name": "Main", "construction": "main", "anchor": True},
            {"key": "upper", "id": "2", "name": "Upper", "construction": "upper", "synthesizeIfMissing": True}]}), encoding="utf-8")
        ip.main(["--all", "--source-dir", str(src), "--out-dir", str(out), "--levels-file", str(levels), "--quiet"])
        stack = json.loads((out / "import-report.json").read_text(encoding="utf-8"))["stacking"]["upper"]
        self.assertGreater(stack["outerWallShareMatched"], 0.9)
        self.assertGreater(stack["stairOverlapShare"], 0.9)          # on the small flight, not 1 m aside on the large one
        plan = json.loads((out / "floorplan.json").read_text(encoding="utf-8"))
        main, upper = (next(lv for lv in plan["levels"] if lv["id"] == i) for i in ("1", "2"))
        self.assertNotEqual(upper.get("source"), "synthetic")
        for p in upper["outline"]:
            self.assertLess(Polygon(main["outline"]).exterior.distance(Point(p)), 0.03)
        # the stairwell is two runs side by side, and both levels show the same two
        self.assertEqual(len(main["stairs"]), 2)
        self.assertEqual([s["polygon"] for s in main["stairs"]], [s["polygon"] for s in upper["stairs"]])
        self.assertEqual((main["stairs"][0]["connects"], upper["stairs"][0]["connects"]), (["2"], ["1"]))
        for s in main["stairs"]:
            x, y = zip(*s["polygon"])
            self.assertAlmostEqual(min(max(x) - min(x), max(y) - min(y)), 1.0, delta=0.05)     # one flight wide
            self.assertAlmostEqual(max(max(x) - min(x), max(y) - min(y)), 2.3, delta=0.05)     # as long as the stairwell


if __name__ == "__main__":
    unittest.main()
