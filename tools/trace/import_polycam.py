#!/usr/bin/env python3
"""Turn Polycam floor-plan exports into Signal Atlas floor-plan data.

    .venv\\Scripts\\python.exe tools\\trace\\import_polycam.py --level second-floor
    .venv\\Scripts\\python.exe tools\\trace\\import_polycam.py --all
    .venv\\Scripts\\python.exe tools\\trace\\import_polycam.py --assemble-only

Step 1, per level (only the levels you name): read floorplan.dxf (walls, doors,
windows, openings, one polygon per room), floorplan.csv (areas, ceiling heights,
compass heading) and model.glb (names and footprints of stairs, fireplace and
appliances). Write <out>/levels/<key>.json in the frame of that Polycam plan and
an overlay picture <out>/trace-check-<key>.png.

Step 2, always, for every level: turn each level so that north is up, make the
walls of all levels parallel, stack the levels on their outer walls and stairs,
and write <out>/floorplan.json, <out>/import-report.json,
<out>/trace-check-stack.png and, when <out>/ap-marks.json exists,
<out>/ap-positions.json.

The geometry it writes has no radio-specific field. Materials are names from
data/materials.json; which name a wall gets is decided by the "construction"
table in that file. Everything this tool reads or writes below <out> is private.
It reads only the listed CSV rows, so the address and the GPS position in the
exports never reach its output.

Plan coordinates: metres, x to the right, y down the page.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import re
import shutil
import struct
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]
PX_PER_M = 100.0          # Polycam draws its PNG at 100 pixels per metre
HOST_TOL = 0.08           # the same tolerance as findHostWall in src/core/geometry.js
LEAF_MAX_WIDTH = 0.06     # a door leaf is drawn thinner than a wall
SIDE_PROBE = 0.2          # how far beside a wall the importer looks to see what is there


# ----------------------------------------------------------------------------
# small geometry helpers
# ----------------------------------------------------------------------------

def dist(a, b):
    return math.hypot(b[0] - a[0], b[1] - a[1])


def mid(a, b):
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def clean_ring(points, tol=1e-4, drop_straight=True):
    """Drop repeated points and, unless told not to, points on a straight line between their neighbours."""
    pts = [tuple(p) for p in points]
    if len(pts) > 1 and dist(pts[0], pts[-1]) < tol:
        pts = pts[:-1]
    out = []
    for p in pts:
        if not out or dist(out[-1], p) > tol:
            out.append(p)
    changed = drop_straight
    while changed and len(out) > 3:
        changed = False
        for i in range(len(out)):
            a, b, c = out[i - 1], out[i], out[(i + 1) % len(out)]
            span = dist(a, c)
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            between = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) >= 0
            if span > tol and abs(cross) / span < tol and between:
                del out[i]
                changed = True
                break
    return out


def rect_axis(points):
    """Centre line, width and length of a long thin polygon: (a, b, width, length)."""
    rect = Polygon(points).minimum_rotated_rectangle
    c = list(rect.exterior.coords)[:4]
    e1, e2 = dist(c[0], c[1]), dist(c[1], c[2])
    if e1 >= e2:
        return mid(c[3], c[0]), mid(c[1], c[2]), e2, e1
    return mid(c[0], c[1]), mid(c[2], c[3]), e1, e2


def point_line_offset(p, a, b):
    """(t, off): position of p along a-b (0 at a, 1 at b) and distance from the line."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    if length < 1e-9:
        return 0.0, dist(p, a)
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (length * length)
    off = abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length
    return t, off


def project(p, a, b):
    t, _ = point_line_offset(p, a, b)
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def direction_deg(a, b):
    """Direction of a-b in degrees, clockwise on the page, folded to 0..180."""
    return math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) % 180.0


def parallel(a1, b1, a2, b2, tol_deg=1.5):
    d = abs(direction_deg(a1, b1) - direction_deg(a2, b2)) % 180.0
    return min(d, 180.0 - d) <= tol_deg


def host_wall(a, b, walls, tol=HOST_TOL):
    """Index of the wall that the segment a-b lies on, or -1. Mirrors findHostWall."""
    best, best_off = -1, float("inf")
    for i, w in enumerate(walls):
        length = dist(w["a"], w["b"])
        if length < 1e-9:
            continue
        ta, oa = point_line_offset(a, w["a"], w["b"])
        tb, ob = point_line_offset(b, w["a"], w["b"])
        slack = tol / length
        if oa > tol or ob > tol:
            continue
        if min(ta, tb) < -slack or max(ta, tb) > 1 + slack:
            continue
        if oa + ob < best_off:
            best, best_off = i, oa + ob
    return best


def ring(poly):
    return clean_ring(list(poly.exterior.coords))


def largest(geom):
    if isinstance(geom, MultiPolygon):
        return max(geom.geoms, key=lambda g: g.area)
    return geom


def r3(v):
    return round(float(v), 3)


def rpt(p):
    return [r3(p[0]), r3(p[1])]


def slug(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "room"


# ----------------------------------------------------------------------------
# readers
# ----------------------------------------------------------------------------

LAYER = re.compile(r"^Polycam-Floor_\d+-(.+)$")


def read_dxf(path):
    """Read the layers the importer needs. Everything comes back y-down."""
    import ezdxf

    doc = ezdxf.readfile(str(path))
    out = {"walls": [], "openings": [], "leaves": 0, "rooms": [], "labels": [], "dimensions": [], "warnings": []}
    seen = set()
    for e in doc.modelspace():
        m = LAYER.match(e.dxf.layer)
        if not m:
            continue  # the header (address), compass, logo and scale bar are never read
        kind = m.group(1)
        etype = e.dxftype()
        if etype == "LWPOLYLINE":
            raw = [(float(p[0]), -float(p[1])) for p in e.get_points("xy")]
            closed = bool(e.closed) or (len(raw) > 2 and dist(raw[0], raw[-1]) < 1e-6)
            # a wall keeps its straight-line points: the tips of its outline mark the centre line
            pts = clean_ring(raw, drop_straight=kind != "Walls") if closed else raw
            key = (kind, tuple(sorted((round(x, 4), round(y, 4)) for x, y in pts)))
            if key in seen:
                continue
            seen.add(key)
            if kind == "Walls" and closed and len(pts) >= 3:
                out["walls"].append(pts)
            elif kind in ("Openings-Doors", "Openings-Windows", "Openings-Openings") and closed and len(pts) == 4:
                a, b, width, length = rect_axis(pts)
                if width < LEAF_MAX_WIDTH:
                    out["leaves"] += 1 if kind == "Openings-Doors" else 0
                    continue
                otype = {"Openings-Doors": "door", "Openings-Windows": "window", "Openings-Openings": "opening"}[kind]
                out["openings"].append({"type": otype, "a": a, "b": b, "width": length, "depth": width})
            elif kind == "Floors" and closed and len(pts) >= 3:
                out["rooms"].append(pts)
        elif etype == "MTEXT" and kind == "Labels-Rooms":
            out["labels"].append((e.plain_text().strip(), (float(e.dxf.insert.x), -float(e.dxf.insert.y))))
        elif etype == "MTEXT" and kind == "Dimensions-Exterior":
            m2 = re.search(r"(\d+(?:\.\d+)?)\s*m", e.plain_text())
            if m2:
                out["dimensions"].append(float(m2.group(1)))
    return out


CSV_GLOBAL = {
    "Compass direction [deg]": "headingDeg",
    "Compass direction uncertainty (1-sigma) [deg]": "headingSigmaDeg",
    "Total exterior floor area [m^2]": "exteriorAreaM2",
    "Total livable floor area [m^2]": "livableAreaM2",
    "Total window area [m^2]": "windowAreaM2",
}


def read_csv(path):
    """Read only the rows the importer needs. The address and GPS rows are skipped by design."""
    info = {"rooms": {}, "doors": [], "windows": []}
    if not Path(path).exists():
        return info
    with open(path, newline="", encoding="utf-8-sig") as f:
        for row in csv.reader(f):
            if len(row) < 3:
                continue
            room, desc, value = row[0].strip(), row[1].strip(), row[2].strip()
            if room == "Entire Roomplan":
                if desc in CSV_GLOBAL:
                    try:
                        info[CSV_GLOBAL[desc]] = float(value)
                    except ValueError:
                        pass
                continue
            if room == "Settings":
                if desc.startswith("Wall thickness"):
                    try:
                        info["drawnWallThicknessM"] = float(value)
                    except ValueError:
                        pass
                continue
            if room == "Key":
                continue
            entry = info["rooms"].setdefault(room, {})
            if desc == "Floor area [m^2]":
                try:
                    entry["areaM2"] = float(value)
                except ValueError:
                    pass          # an empty or odd value: the area check for this room is skipped
            elif desc.startswith("Ceiling height [m]"):
                nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", value)]
                if nums:
                    entry["ceilingHeight"] = min(nums)
                    if max(nums) > min(nums):
                        entry["ceilingHeightMax"] = max(nums)
                    entry["ceilingApprox"] = "approx" in desc
            elif desc in ("Window dimensions [m]", "Door dimensions [m]"):
                nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", value)]
                if len(nums) == 2:
                    info["windows" if desc.startswith("Window") else "doors"].append({"room": room, "width": nums[0], "height": nums[1]})
    return info


def read_glb_objects(path):
    """Named objects of the Polycam GLB with their footprint on the plan (y-down).

    The GLB uses x to the right, y up and z toward the viewer, so plan (x, y-down) = (x, z).
    Returns [{ name, stem, footprint: [[x, y] * 4], zMin, zMax }].
    """
    path = Path(path)
    if not path.exists():
        return []
    with open(path, "rb") as f:
        magic, _version, _length = struct.unpack("<4sII", f.read(12))
        if magic != b"glTF":
            return []
        jlen, _ = struct.unpack("<II", f.read(8))
        gltf = json.loads(f.read(jlen))
        blen, _ = struct.unpack("<II", f.read(8))
        blob = f.read(blen)
    nodes = gltf.get("nodes", [])
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get("children", []):
            parent[c] = i

    def local(n):
        if "matrix" in n:
            return np.array(n["matrix"], dtype=float).reshape(4, 4).T
        m = np.eye(4)
        if "scale" in n:
            m = np.diag(list(n["scale"]) + [1.0]) @ m
        if "rotation" in n:
            x, y, z, w = n["rotation"]
            m = np.array([
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
                [0, 0, 0, 1]]) @ m
        if "translation" in n:
            t = np.eye(4)
            t[:3, 3] = n["translation"]
            m = t @ m
        return m

    def world(i):
        m = local(nodes[i])
        while i in parent:
            i = parent[i]
            m = local(nodes[i]) @ m
        return m

    def positions(mesh_index):
        chunks = []
        for prim in gltf["meshes"][mesh_index].get("primitives", []):
            acc = gltf["accessors"][prim["attributes"]["POSITION"]]
            view = gltf["bufferViews"][acc["bufferView"]]
            off = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
            stride = view.get("byteStride", 12) or 12
            count = acc["count"]
            if stride == 12:
                pts = np.frombuffer(blob, dtype="<f4", count=count * 3, offset=off).reshape(count, 3)
            else:
                pts = np.stack([np.frombuffer(blob, dtype="<f4", count=3, offset=off + k * stride) for k in range(count)])
            chunks.append(pts.astype(float))
        return np.concatenate(chunks) if chunks else np.zeros((0, 3))

    out = []
    for i, n in enumerate(nodes):
        if "mesh" not in n or not n.get("name"):
            continue
        p = positions(n["mesh"])
        if len(p) < 3:
            continue
        w = (world(i) @ np.c_[p, np.ones(len(p))].T).T[:, :3]
        flat = [(float(x), float(z)) for x, _y, z in w]
        hull = Polygon(flat).convex_hull if len(set(flat)) >= 3 else None
        if hull is None or hull.geom_type != "Polygon" or hull.area < 1e-6:
            hull = LineString(flat).buffer(0.005).envelope
        rect = hull.minimum_rotated_rectangle
        foot = clean_ring(list(rect.exterior.coords)) if rect.geom_type == "Polygon" else []
        name = n["name"]
        out.append({
            "name": name, "stem": re.sub(r"[\d_]+$", "", name).lower(),
            "footprint": foot, "zMin": float(w[:, 1].min()), "zMax": float(w[:, 1].max()),
        })
    return out


def read_spatial_report(path):
    """Door and window widths listed in the spatial report (pdftotext -layout), for a cross-check."""
    path = Path(path)
    exe = shutil.which("pdftotext")
    if not path.exists() or not exe:
        return None
    try:
        text = subprocess.run([exe, "-layout", str(path), "-"], capture_output=True, timeout=120).stdout.decode("utf-8", "replace")
    except (OSError, subprocess.SubprocessError):
        return None
    found = {"door": 0, "window": 0}
    for kind, count in re.findall(r"\b(Door|Window) x (\d+)", text):
        found[kind.lower()] += int(count)
    return found


# ----------------------------------------------------------------------------
# step 1: one level
# ----------------------------------------------------------------------------

def wall_centre_line(pts):
    """Centre line and drawn thickness of one Polycam wall polygon."""
    a, b, width, length = rect_axis(pts)
    if len(pts) == 6:
        # Polycam draws a wall as a hexagon whose two tips are the ends of the centre line.
        v0, v3 = pts[0], pts[3]
        _, o0 = point_line_offset(v0, a, b)
        _, o3 = point_line_offset(v3, a, b)
        if o0 < 0.01 and o3 < 0.01 and length - 1.5 * width <= dist(v0, v3) <= length + 1e-6:
            return v0, v3, width
    return a, b, width


def edge_gaps(p, q, walls, tol=HOST_TOL, min_gap=0.1):
    """Parts of the polygon edge p-q that no wall runs along: [(t0, t1)] with t in 0..1."""
    length = dist(p, q)
    if length < min_gap:
        return []
    covered = []
    for w in walls:
        if not parallel(p, q, w["a"], w["b"], 3.0):
            continue
        ta, oa = point_line_offset(w["a"], p, q)
        tb, ob = point_line_offset(w["b"], p, q)
        if oa > tol or ob > tol:
            continue
        lo, hi = max(0.0, min(ta, tb)), min(1.0, max(ta, tb))
        if hi > lo:
            covered.append((lo, hi))
    covered.sort()
    gaps, cursor = [], 0.0
    for lo, hi in covered:
        if lo - cursor > min_gap / length:
            gaps.append((cursor, lo))
        cursor = max(cursor, hi)
    if 1.0 - cursor > min_gap / length:
        gaps.append((cursor, 1.0))
    return gaps


def classify_and_split(walls, rooms, outline, rules, garage_ids):
    """Give every wall a material. A wall is cut where what lies beside it changes."""
    room_polys = [(r["id"], Polygon(r["polygon"])) for r in rooms]

    def side(p):
        pt = Point(p)
        if not outline.contains(pt):
            return "outside"
        for rid, poly in room_polys:
            if poly.contains(pt):
                return rid
        return "inside"

    def material_for(sa, sb, solid):
        if solid:
            return rules["solidMass"]
        if sa == "outside" or sb == "outside":
            return rules["exteriorWall"]
        if sa in garage_ids or sb in garage_ids:
            return rules["garageWall"]
        return rules["interiorWall"]

    out = []
    for w in walls:
        a, b = w["a"], w["b"]
        length = dist(a, b)
        if length < 0.02:
            continue
        nx, ny = -(b[1] - a[1]) / length, (b[0] - a[0]) / length
        probe = max(SIDE_PROBE, w.get("drawn", 0.1) / 2 + 0.1) if not w.get("solid") else w["thickness"] / 2 + 0.1
        n = max(1, int(round(length / 0.05)))
        labels = []
        for k in range(n):
            t = (k + 0.5) / n
            px, py = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
            sa, sb = side((px + nx * probe, py + ny * probe)), side((px - nx * probe, py - ny * probe))
            mat = material_for(sa, sb, w.get("solid"))
            labels.append((mat, mat == rules["exteriorWall"] and not w.get("solid")))
        runs = []
        for k, lab in enumerate(labels):
            if runs and runs[-1][0] == lab:
                runs[-1][2] = k + 1
            else:
                runs.append([lab, k, k + 1])
        # a run shorter than 0.2 m joins its longer neighbour: it is a corner, not a change of wall
        while len(runs) > 1:
            short = min(range(len(runs)), key=lambda i: runs[i][2] - runs[i][1])
            if (runs[short][2] - runs[short][1]) * length / n >= 0.2:
                break
            left = runs[short - 1] if short > 0 else None
            right = runs[short + 1] if short + 1 < len(runs) else None
            if left and (not right or left[2] - left[1] >= right[2] - right[1]):
                left[2] = runs[short][2]
            else:
                right[1] = runs[short][1]
            del runs[short]
        merged = []
        for run in runs:
            if merged and merged[-1][0] == run[0]:
                merged[-1][2] = run[2]
            else:
                merged.append(run)
        for (mat, exterior), k0, k1 in merged:
            t0, t1 = k0 / n, k1 / n
            piece = dict(w)
            piece.update(a=(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0),
                         b=(a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1),
                         material=mat, exterior=exterior)
            out.append(piece)
    return out


def merge_collinear(walls):
    """Join walls that continue each other in a straight line and are the same kind of wall."""
    def same(u, v):
        return (u["material"] == v["material"] and u.get("exterior") == v.get("exterior") and u.get("origin") == v.get("origin")
                and bool(u.get("solid")) == bool(v.get("solid")) and abs(u.get("thickness", 0) - v.get("thickness", 0)) < 1e-6)

    walls = [dict(w) for w in walls]
    changed = True
    while changed:
        changed = False
        for i in range(len(walls)):
            for j in range(i + 1, len(walls)):
                u, v = walls[i], walls[j]
                if not same(u, v) or not parallel(u["a"], u["b"], v["a"], v["b"], 0.5):
                    continue
                joined = None
                for pu, qu in ((u["a"], u["b"]), (u["b"], u["a"])):
                    for pv, qv in ((v["a"], v["b"]), (v["b"], v["a"])):
                        if dist(qu, pv) < 0.02 and dist(pu, qv) > max(dist(pu, qu), dist(pv, qv)) - 0.02:
                            _, off = point_line_offset(qv, pu, qu)
                            if off < 0.02:
                                joined = (pu, qv)
                if joined:
                    u["a"], u["b"] = joined
                    del walls[j]
                    changed = True
                    break
            if changed:
                break
    return walls


def detect_png_offset(png_path, walls):
    """Where the plan sits in the Polycam PNG: (ox, oy) so that pixel = (plan - o) * 100.

    The dark wall pixels of the picture are matched against the imported walls,
    first along x and then along y.
    """
    from PIL import Image

    img = np.asarray(Image.open(png_path).convert("RGB")).astype(np.int16)
    h, w = img.shape[:2]
    xs = [p[0] for wl in walls for p in (wl["a"], wl["b"])]
    ys = [p[1] for wl in walls for p in (wl["a"], wl["b"])]
    # first guess: the plan is centred across the picture
    ox0 = (min(xs) + max(xs)) / 2 - w / (2 * PX_PER_M)
    oy0 = (min(ys) + max(ys)) / 2 - h / (2 * PX_PER_M)
    dark = (img.sum(axis=2) < 360) & (img.max(axis=2) - img.min(axis=2) < 70)
    col_img, row_img = dark.sum(axis=0).astype(float), dark.sum(axis=1).astype(float)
    col_me, row_me = np.zeros(w), np.zeros(h)
    for wl in walls:
        (x0, y0), (x1, y1) = wl["a"], wl["b"]
        n = max(2, int(dist(wl["a"], wl["b"]) * PX_PER_M))
        for k in range(n + 1):
            t = k / n
            px = int(round((x0 + (x1 - x0) * t - ox0) * PX_PER_M))
            py = int(round((y0 + (y1 - y0) * t - oy0) * PX_PER_M))
            if 0 <= px < w:
                col_me[px] += 1
            if 0 <= py < h:
                row_me[py] += 1

    # Polycam draws a wall about 10 pixels thick. Giving the imported centre lines the same
    # thickness makes the match peak in the middle of the wall instead of anywhere inside it.
    band = np.ones(int(round(0.1 * PX_PER_M)) + 1)
    col_me, row_me = np.convolve(col_me, band, "same"), np.convolve(row_me, band, "same")

    def best_shift(a, b, reach=260):
        best, best_score = 0, -1.0
        for s in range(-reach, reach + 1):
            if s >= 0:
                score = float(np.dot(a[s:], b[:len(b) - s]))
            else:
                score = float(np.dot(a[:len(a) + s], b[-s:]))
            if score > best_score:
                best, best_score = s, score
        return best

    sx, sy = best_shift(col_img, col_me), best_shift(row_img, row_me)
    return ox0 - sx / PX_PER_M, oy0 - sy / PX_PER_M


def import_level(spec, src_dir, out_dir, materials, room_names):
    key = spec["key"]
    folder = Path(src_dir) / key
    dxf_path = folder / "floorplan.dxf"
    if not dxf_path.exists():
        raise FileNotFoundError(f"{dxf_path} is missing")
    construction = materials["construction"]
    rules = construction["levels"][spec["construction"]]
    dxf = read_dxf(dxf_path)
    info = read_csv(folder / "floorplan.csv")
    objects = read_glb_objects(folder / "model.glb")
    warnings = list(dxf["warnings"])
    names = (room_names or {}).get(key, {})
    by_label = {v.get("polycam"): dict(v, number=k) for k, v in (names.get("rooms") or {}).items()}

    # ---- rooms -------------------------------------------------------------
    scanned = []
    for pts in dxf["rooms"]:
        poly = Polygon(pts)
        label = next((text for text, p in dxf["labels"] if poly.contains(Point(p))), None)
        if label is None and dxf["labels"]:
            c = poly.centroid
            label = min(dxf["labels"], key=lambda lp: dist(lp[1], (c.x, c.y)))[0]
            warnings.append(f'no room label lies inside one room polygon; used the nearest label "{label}"')
        scanned.append({"label": label or "Room", "poly": poly, "pts": pts})

    groups, solids = {}, []
    for room in scanned:
        entry = by_label.get(room["label"])
        if entry and entry.get("is_wall"):
            solids.append(room)
            continue
        if entry:
            name, source, reason = entry["name"], "confirmed", "named by the owner in room-names.json"
        else:
            name, source = room["label"], "inferred"
            reason = "Polycam label; add this level to room-names.json to rename it"
        groups.setdefault(name, {"name": name, "nameSource": source, "nameReason": reason, "parts": [], "fix": None})
        groups[name]["parts"].append(room)
        if entry and entry.get("fix"):
            groups[name]["fix"] = entry["fix"]

    rooms, used_ids, area_rows = [], set(), []
    for g in groups.values():
        polys = [p["poly"] for p in g["parts"]]
        merged = unary_union(polys)
        grow = 0.0
        while isinstance(merged, MultiPolygon) and grow < 0.35:
            grow += 0.05
            merged = unary_union([p.buffer(grow, join_style=2) for p in polys]).buffer(-grow, join_style=2)
        if isinstance(merged, MultiPolygon):
            warnings.append(f'the parts of room "{g["name"]}" do not touch; kept the largest part')
            merged = largest(merged)
        rid = f'{spec["id"]}-{slug(g["name"])}'
        while rid in used_ids:
            rid += "-2"
        used_ids.add(rid)
        labels = [p["label"] for p in g["parts"]]
        csv_rows = [info["rooms"].get(lab, {}) for lab in labels]
        csv_area = sum(r.get("areaM2", 0.0) for r in csv_rows) if all("areaM2" in r for r in csv_rows) else None
        heights = [r["ceilingHeight"] for r in csv_rows if "ceilingHeight" in r]
        room = {
            "id": rid, "name": g["name"], "nameSource": g["nameSource"], "nameReason": g["nameReason"],
            "sourceLabel": " + ".join(labels), "polygon": ring(merged),
        }
        if heights:
            room["ceilingHeight"] = min(heights)
            top = max([r.get("ceilingHeightMax", r["ceilingHeight"]) for r in csv_rows if "ceilingHeight" in r])
            if top > min(heights):
                room["ceilingHeightMax"] = top
            room["ceilingSource"] = "lidar-approx" if any(r.get("ceilingApprox") for r in csv_rows) else "lidar"
        room["_fix"] = g["fix"]
        room["_area"] = merged.area
        rooms.append(room)
        # Polycam's CSV area stops at the wall face; the imported polygon runs to the wall centre
        # line. Taking half the drawn wall thickness off around each scanned part makes them comparable.
        half = info.get("drawnWallThicknessM", 0.1) / 2
        net = sum(p.area - p.exterior.length * half for p in polys)
        area_rows.append({"room": g["name"], "sourceLabel": room["sourceLabel"], "toWallCentreM2": round(merged.area, 2),
                          "toWallFaceM2": round(net, 2),
                          "csvM2": None if csv_area is None else round(csv_area, 2),
                          "diffM2": None if csv_area is None else round(net - csv_area, 2)})

    # ---- walls -------------------------------------------------------------
    walls, drawn = [], []
    for pts in dxf["walls"]:
        if Polygon(pts).area < 1e-4:
            continue
        a, b, width = wall_centre_line(pts)
        if dist(a, b) < 0.02:
            continue
        walls.append({"a": a, "b": b, "drawn": width, "thickness": 0})
        drawn.append(width)
    # Polycam fills some wall junctions with a tiny extra wall. It adds nothing: drop it.
    def is_filler(w):
        if dist(w["a"], w["b"]) >= 0.35:
            return False
        others = [LineString([o["a"], o["b"]]) for o in walls if o is not w and dist(o["a"], o["b"]) >= 0.35]
        return all(min((line.distance(Point(p)) for line in others), default=1.0) < HOST_TOL for p in (w["a"], w["b"]))
    walls = [w for w in walls if not is_filler(w)]
    for s in solids:
        a, b, width, _length = rect_axis(s["pts"])
        walls.append({"a": a, "b": b, "thickness": round(width, 3), "solid": True,
                      "note": f'Polycam drew this as the room "{s["label"]}"; the owner says it is solid wall'})

    openings = [dict(o) for o in dxf["openings"]]
    added = []
    for room in rooms:
        if room["_fix"] != "close_open_edges_with_walls":
            continue
        pts = room["polygon"]
        poly = Polygon(pts)
        # an opening (not a door) on the boundary of this room is filled in
        kept = []
        for o in openings:
            on_edge = o["type"] == "opening" and poly.exterior.distance(Point(mid(o["a"], o["b"]))) < HOST_TOL
            if on_edge:
                added.append({"room": room["name"], "kind": "opening filled with wall", "a": rpt(o["a"]), "b": rpt(o["b"]), "lengthM": round(dist(o["a"], o["b"]), 2)})
            else:
                kept.append(o)
        openings = kept
        for i in range(len(pts)):
            p, q = pts[i], pts[(i + 1) % len(pts)]
            for t0, t1 in edge_gaps(p, q, walls):
                a = (p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0)
                b = (p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1)
                walls.append({"a": a, "b": b, "thickness": 0, "origin": "owner-fix",
                              "note": f'added by hand: Polycam left this edge of the {room["name"]} open (room-names.json)'})
                added.append({"room": room["name"], "kind": "wall added on an open edge", "a": rpt(a), "b": rpt(b), "lengthM": round(dist(a, b), 2)})

    # A house has no hole in its outer wall. Where the scan left a stretch of the outer edge
    # without a wall, close it. The piece is marked, listed in the report and drawn in its own colour.
    if construction.get("closeOuterWallGaps", True):
        exact = largest(unary_union([Polygon(r["polygon"]) for r in rooms] + [s["poly"] for s in solids]))
        edge = ring(Polygon(exact.exterior))
        for p, q in zip(edge, edge[1:] + edge[:1]):
            for t0, t1 in edge_gaps(p, q, walls, tol=0.15, min_gap=0.15):
                a = (p[0] + (q[0] - p[0]) * t0, p[1] + (q[1] - p[1]) * t0)
                b = (p[0] + (q[0] - p[0]) * t1, p[1] + (q[1] - p[1]) * t1)
                walls.append({"a": a, "b": b, "thickness": 0, "origin": "gap-closure",
                              "note": "added by the importer: the scan left this stretch of the outer wall open"})
                added.append({"room": "(outer wall)", "kind": "gap in the outer wall closed", "a": rpt(a), "b": rpt(b), "lengthM": round(dist(a, b), 2)})

    wall_shapes = [LineString([w["a"], w["b"]]).buffer(max(w.get("drawn", 0.1), w.get("thickness") or 0.1) / 2, cap_style=3) for w in walls]
    footprint = unary_union([Polygon(r["polygon"]) for r in rooms] + [s["poly"] for s in solids] + wall_shapes)
    footprint = largest(footprint.buffer(0.03, join_style=2).buffer(-0.03, join_style=2))
    outer_face = Polygon(footprint.exterior)                      # outside face of the outer walls
    centre = largest(unary_union([Polygon(r["polygon"]) for r in rooms] + [s["poly"] for s in solids]).buffer(0.12, join_style=2).buffer(-0.12, join_style=2))
    outline = Polygon(centre.exterior).simplify(0.01)              # centre line of the outer walls

    garage = re.compile(construction.get("garageRoomPattern", "garage"), re.I)
    garage_ids = {r["id"] for r in rooms if garage.search(r["name"]) or garage.search(r["sourceLabel"])}
    walls = classify_and_split(walls, rooms, outline.buffer(0.02), rules, garage_ids)
    walls = merge_collinear(walls)

    # ---- openings ----------------------------------------------------------
    final_openings, counter = [], {"door": 0, "window": 0, "opening": 0}
    # An opening may span two wall pieces of different kinds (the wall was cut where the room
    # beside it changes). Such an opening is cut at the same place, so each part sits on one
    # piece and every piece keeps its own material.
    parts = []
    for o in openings:
        if host_wall(o["a"], o["b"], walls) >= 0:
            parts.append(o)
            continue
        length = dist(o["a"], o["b"])
        cut = []
        for w in walls:
            if not parallel(o["a"], o["b"], w["a"], w["b"], 2.0) or point_line_offset(o["a"], w["a"], w["b"])[1] > HOST_TOL or point_line_offset(o["b"], w["a"], w["b"])[1] > HOST_TOL:
                continue
            ta, tb = point_line_offset(w["a"], o["a"], o["b"])[0], point_line_offset(w["b"], o["a"], o["b"])[0]
            lo, hi = max(0.0, min(ta, tb)), min(1.0, max(ta, tb))
            if (hi - lo) * length > 0.05:
                at = lambda t: (o["a"][0] + (o["b"][0] - o["a"][0]) * t, o["a"][1] + (o["b"][1] - o["a"][1]) * t)   # noqa: E731
                cut.append(dict(o, a=at(lo), b=at(hi)))
        parts.extend(cut if cut else [o])
    for o in parts:
        idx = host_wall(o["a"], o["b"], walls)
        if idx < 0:
            warnings.append(f'a {o["type"]} {o["width"]:.2f} m wide lies on no wall and was left out')
            continue
        host = walls[idx]
        a, b = project(o["a"], host["a"], host["b"]), project(o["b"], host["a"], host["b"])
        counter[o["type"]] += 1
        op = {"id": f'{spec["id"]}-{o["type"]}-{counter[o["type"]]}', "type": o["type"], "a": a, "b": b, "width": round(dist(a, b), 3),
              "exterior": bool(host.get("exterior"))}
        if o["type"] == "window":
            op["material"] = rules["window"]
        elif o["type"] == "opening":
            op["material"] = "open"
        else:
            m = mid(a, b)
            length = dist(a, b)
            nx, ny = -(b[1] - a[1]) / length, (b[0] - a[0]) / length
            beside = [r["id"] for r in rooms for s in (1, -1) if Polygon(r["polygon"]).contains(Point(m[0] + s * nx * 0.3, m[1] + s * ny * 0.3))]
            if host.get("exterior") and op["width"] >= construction["garageDoorMinWidth_m"] and any(r in garage_ids for r in beside):
                op["material"], op["state"] = rules["doorGarage"], construction["exteriorDoorState"]
            elif host.get("exterior") and op["width"] >= construction["patioDoorMinWidth_m"]:
                op["material"], op["state"] = rules["doorPatio"], construction["exteriorDoorState"]
            elif host.get("exterior") or host["material"] == rules["garageWall"]:
                op["material"], op["state"] = rules["doorExterior"], construction["exteriorDoorState"]
            else:
                op["material"], op["state"] = rules["doorInterior"], construction["interiorDoorState"]
        final_openings.append(op)

    # ---- stairs and fixtures from the named objects of the GLB ---------------
    stairs, fixtures, skipped = [], [], []
    flights = [o for o in objects if o["stem"].startswith("stairs") and len(o["footprint"]) >= 3]
    clusters = []
    for fl in flights:
        poly = Polygon(fl["footprint"])
        hit = next((c for c in clusters if any(Polygon(m["footprint"]).distance(poly) < 0.15 for m in c)), None)
        (hit.append(fl) if hit else clusters.append([fl]))
    for n, cluster in enumerate(clusters, 1):
        shape = unary_union([Polygon(m["footprint"]).buffer(0.02, join_style=2) for m in cluster]).buffer(-0.02, join_style=2)
        shape = largest(shape) if not shape.is_empty else Polygon(cluster[0]["footprint"])
        main = max(cluster, key=lambda m: m["zMax"] - m["zMin"])
        stairs.append({
            "id": f'{spec["id"]}-stairs-{n}', "polygon": ring(shape.simplify(0.01)),
            "mainFlight": [list(p) for p in main["footprint"]],
            "flights": [{"name": m["name"], "riseM": round(m["zMax"] - m["zMin"], 2), "footprint": [rpt(p) for p in m["footprint"]]} for m in cluster],
        })
    fixture_rules = construction.get("fixtures", {})
    min_side = construction.get("fixtureMinSide_m", 0.25)
    for o in objects:
        rule = fixture_rules.get(o["stem"])
        if not rule or len(o["footprint"]) < 4:
            continue
        sides = sorted([dist(o["footprint"][0], o["footprint"][1]), dist(o["footprint"][1], o["footprint"][2])])
        if sides[0] < min_side:
            skipped.append({"name": o["name"], "why": f"the scan saw only a flat face ({sides[1]:.2f} x {sides[0]:.2f} m), so its depth is unknown"})
            continue
        fixtures.append({"type": rule["type"], "name": o["stem"].replace("_", " "), "material": rule["material"], "polygon": o["footprint"]})

    # ---- checks ------------------------------------------------------------
    glb_walls = [o for o in objects if o["stem"] == "wall" and len(o["footprint"]) >= 3]
    glb_worst = None
    if glb_walls and walls:
        lines = [LineString([w["a"], w["b"]]) for w in walls]
        glb_worst = round(100 * max(min(line.distance(Polygon(g["footprint"]).centroid) for line in lines) for g in glb_walls), 1)
    b = outer_face.bounds
    face = ring(outer_face.simplify(0.02))
    edges = [dist(p, q) for p, q in zip(face, face[1:] + face[:1])]
    dims = []
    for printed in sorted(set(dxf["dimensions"]), reverse=True):
        nearest = min(edges, key=lambda e: abs(e - printed)) if edges else None
        dims.append({"printedM": printed, "importedM": None if nearest is None else round(nearest, 2), "diffM": None if nearest is None else round(nearest - printed, 2)})
    heights = {}
    for r in rooms:
        if "ceilingHeight" in r:
            heights[round(r["ceilingHeight"], 1)] = heights.get(round(r["ceilingHeight"], 1), 0) + r["_area"]
    level_height = max(heights, key=heights.get) if heights else materials["defaults"]["ceiling_height_m"].get("main", 2.7)
    report_counts = read_spatial_report(folder / "spatial-report.pdf")
    checks = {
        "rooms": area_rows,
        "exteriorAreaM2": {"imported": round(outer_face.area, 1), "csv": info.get("exteriorAreaM2")},
        "overallM": {"width": round(b[2] - b[0], 2), "height": round(b[3] - b[1], 2)},
        "printedDimensions": dims,
        "drawnWallThicknessM": {"min": round(min(drawn), 3) if drawn else None, "max": round(max(drawn), 3) if drawn else None, "csvSetting": info.get("drawnWallThicknessM"),
                                "note": "Polycam draws every wall at its wall-thickness setting. It is not a measurement, so wall thickness comes from materials.json"},
        "counts": {"walls": len(walls), "doors": counter["door"], "windows": counter["window"], "openings": counter["opening"], "doorLeavesIgnored": dxf["leaves"],
                   "csvDoors": len(info["doors"]), "csvWindows": len(info["windows"]), "spatialReportListings": report_counts},
        "glbWallCrossCheckCm": glb_worst,
        "wallsAdded": added,
        "fixturesSkipped": skipped,
        "warnings": warnings,
    }

    level = {
        "key": key, "id": spec["id"], "name": spec["name"], "construction": spec["construction"],
        "frame": "Polycam plan frame: metres, x right, y down, origin at the DXF origin",
        "imported": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "heading": {"deg": info.get("headingDeg"), "sigmaDeg": info.get("headingSigmaDeg"),
                    "northClockwiseFromUpDeg": None if info.get("headingDeg") is None else round((-info["headingDeg"]) % 360.0, 2)},
        "height": level_height,
        "floorMaterial": rules["floorUnder"],
        "outline": [rpt(p) for p in ring(outline)],
        "outerFace": [rpt(p) for p in ring(outer_face.simplify(0.01))],
        "rooms": [{k: ([rpt(p) for p in v] if k == "polygon" else v) for k, v in r.items() if not k.startswith("_")} for r in rooms],
        "walls": [{"a": rpt(w["a"]), "b": rpt(w["b"]), "material": w["material"], "exterior": bool(w.get("exterior")),
                   **({"thickness": w["thickness"]} if w.get("thickness") else {}),
                   **({"origin": w["origin"]} if w.get("origin") else {}), **({"note": w["note"]} if w.get("note") else {})} for w in walls],
        "openings": [{**o, "a": rpt(o["a"]), "b": rpt(o["b"])} for o in final_openings],
        "stairs": [{**s, "polygon": [rpt(p) for p in s["polygon"]], "mainFlight": [rpt(p) for p in s["mainFlight"]]} for s in stairs],
        "fixtures": [{**f, "polygon": [rpt(p) for p in f["polygon"]]} for f in fixtures],
        "checks": checks,
    }
    png = folder / "floorplan.png"
    if png.exists():
        ox, oy = detect_png_offset(png, walls)
        level["png"] = {"offsetX": round(ox, 4), "offsetY": round(oy, 4), "pxPerM": PX_PER_M}
    out_levels = Path(out_dir) / "levels"
    out_levels.mkdir(parents=True, exist_ok=True)
    (out_levels / f"{key}.json").write_text(json.dumps(level, indent=1) + "\n", encoding="utf-8")
    if png.exists():
        draw_level_overlay(level, png, Path(out_dir) / f"trace-check-{key}.png", None, rules)
    return level


# ----------------------------------------------------------------------------
# pictures
# ----------------------------------------------------------------------------

MATERIAL_COLOURS = {"exterior": (230, 40, 40), "garage": (240, 140, 0), "interior": (30, 110, 255), "solid": (120, 60, 20), "added": (255, 0, 255)}
OPENING_COLOURS = {"door": (0, 170, 60), "window": (0, 200, 220), "opening": (245, 200, 0)}
LEVEL_COLOURS = [(60, 110, 220), (220, 70, 50), (40, 160, 90), (150, 80, 200)]


def wall_colour(w, rules):
    if w.get("origin"):
        return MATERIAL_COLOURS["added"]
    if w.get("thickness"):
        return MATERIAL_COLOURS["solid"]
    if w.get("exterior"):
        return MATERIAL_COLOURS["exterior"]
    if rules and w["material"] == rules.get("garageWall"):
        return MATERIAL_COLOURS["garage"]
    return MATERIAL_COLOURS["interior"]


def font(size):
    from PIL import ImageFont
    try:
        return ImageFont.truetype("arial.ttf", size)
    except OSError:
        return ImageFont.load_default()


def draw_level_overlay(level, png_path, out_path, marks=None, rules=None):
    """The imported level drawn over the Polycam picture, so a person can check it by eye."""
    from PIL import Image, ImageDraw

    base = Image.open(png_path).convert("RGBA")
    # the heading band of the picture holds the address: blank it in the derived image
    ImageDraw.Draw(base).rectangle([0, 0, base.width - 150, 125], fill=(255, 255, 255, 255))
    over = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    ox, oy, s = level["png"]["offsetX"], level["png"]["offsetY"], level["png"]["pxPerM"]

    def px(p):
        return ((p[0] - ox) * s, (p[1] - oy) * s)

    f_small, f_big = font(15), font(20)
    for r in level["rooms"]:
        d.line([px(p) for p in r["polygon"]] + [px(r["polygon"][0])], fill=(0, 0, 0, 90), width=1)
    for f in level["fixtures"]:
        d.polygon([px(p) for p in f["polygon"]], fill=(150, 90, 30, 90), outline=(120, 60, 10, 255))
    for st in level["stairs"]:
        d.polygon([px(p) for p in st["polygon"]], fill=(150, 60, 220, 70), outline=(130, 30, 200, 255))
    for w in level["walls"]:
        width = max(3, int(round((w.get("thickness") or 0.03) * s)))
        d.line([px(w["a"]), px(w["b"])], fill=wall_colour(w, rules) + (235,), width=width if w.get("thickness") else 3)
    for o in level["openings"]:
        d.line([px(o["a"]), px(o["b"])], fill=OPENING_COLOURS[o["type"]] + (255,), width=7)
    d.line([px(p) for p in level["outline"]] + [px(level["outline"][0])], fill=(0, 0, 0, 255), width=1)
    for r in level["rooms"]:
        c = Polygon(r["polygon"]).representative_point()
        label = r["name"] + (f' ({r["ceilingHeight"]:.1f} m)' if "ceilingHeight" in r else "")
        x, y = px((c.x, c.y))
        d.text((x - d.textlength(label, font=f_small) / 2, y + 26), label, fill=(160, 0, 90, 255), font=f_small)
    for m in marks or []:
        x, y = m["px"]
        d.ellipse([x - 9, y - 9, x + 9, y + 9], outline=(255, 0, 0, 255), width=3)
        d.line([x - 16, y, x + 16, y], fill=(255, 0, 0, 255), width=2)
        d.line([x, y - 16, x, y + 16], fill=(255, 0, 0, 255), width=2)
        d.text((x + 14, y - 26), m["label"], fill=(200, 0, 0, 255), font=f_small)
    legend = [("exterior wall", MATERIAL_COLOURS["exterior"]), ("garage-to-house wall", MATERIAL_COLOURS["garage"]), ("interior wall", MATERIAL_COLOURS["interior"]),
              ("wall added (not in the scan)", MATERIAL_COLOURS["added"]), ("solid mass", MATERIAL_COLOURS["solid"]), ("door", OPENING_COLOURS["door"]),
              ("window", OPENING_COLOURS["window"]), ("opening", OPENING_COLOURS["opening"]), ("stairs", (130, 30, 200)), ("fixture", (120, 60, 10))]
    d.text((20, 20), f'Import check: {level["name"]}. Coloured lines are the imported plan.', fill=(0, 0, 0, 255), font=f_big)
    x = 20
    for text, colour in legend:
        d.rectangle([x, 60, x + 22, 74], fill=colour + (255,))
        d.text((x + 28, 58), text, fill=(0, 0, 0, 255), font=f_small)
        x += 40 + int(d.textlength(text, font=f_small))
        if x > base.width - 260:
            break
    Image.alpha_composite(base, over).convert("RGB").save(out_path)


def draw_stack(plan_levels, out_path, report, positions=None):
    """All levels in the final north-up frame, one colour per level."""
    from PIL import Image, ImageDraw

    pts = [p for lv in plan_levels for p in lv["outline"]]
    minx, miny = min(p[0] for p in pts) - 1.5, min(p[1] for p in pts) - 2.6
    maxx, maxy = max(p[0] for p in pts) + 1.5, max(p[1] for p in pts) + 1.5
    s = 60.0
    img = Image.new("RGBA", (int((maxx - minx) * s), int((maxy - miny) * s)), (255, 255, 255, 255))

    def px(p):
        return ((p[0] - minx) * s, (p[1] - miny) * s)

    f_small, f_big = font(15), font(20)
    for n, lv in enumerate(plan_levels):
        colour = LEVEL_COLOURS[n % len(LEVEL_COLOURS)]
        over = Image.new("RGBA", img.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(over)
        d.polygon([px(p) for p in lv["outline"]], fill=colour + (28,))
        for w in lv["walls"]:
            d.line([px(w["a"]), px(w["b"])], fill=colour + (230,), width=3 if lv["source"] != "synthetic" else 1)
        for st in lv.get("stairs", []):
            d.polygon([px(p) for p in st["polygon"]], fill=colour + (70,), outline=colour + (255,))
            d.line([px(p) for p in st["polygon"]] + [px(st["polygon"][0])], fill=colour + (255,), width=4)
        img = Image.alpha_composite(img, over)
    d = ImageDraw.Draw(img)
    d.text((20, 14), "Stacked levels, north is up. Thick outlines are the stairs.", fill=(0, 0, 0, 255), font=f_big)
    x = 20
    for n, lv in enumerate(plan_levels):
        colour = LEVEL_COLOURS[n % len(LEVEL_COLOURS)]
        text = f'{lv["name"]}' + (" (SYNTHETIC)" if lv["source"] == "synthetic" else "")
        d.rectangle([x, 50, x + 22, 64], fill=colour + (255,))
        d.text((x + 28, 48), text, fill=(0, 0, 0, 255), font=f_small)
        x += 44 + int(d.textlength(text, font=f_small))
    line = report.get("summaryLine")
    if line:
        d.text((20, 78), line, fill=(0, 0, 0, 255), font=f_small)
    for pid, p in (positions or {}).items():
        x, y = px((p["x"], p["y"]))
        d.ellipse([x - 7, y - 7, x + 7, y + 7], outline=(0, 0, 0, 255), width=3)
        d.text((x + 10, y - 8), f'{pid} ({p["level"]})', fill=(0, 0, 0, 255), font=f_small)
    ax, ay = img.width - 60, 110
    d.line([ax, ay, ax, ay - 70], fill=(0, 0, 0, 255), width=3)
    d.polygon([(ax, ay - 84), (ax - 9, ay - 62), (ax + 9, ay - 62)], fill=(0, 0, 0, 255))
    d.text((ax - 6, ay - 108), "N", fill=(0, 0, 0, 255), font=f_big)
    d.line([20, img.height - 30, 20 + s, img.height - 30], fill=(0, 0, 0, 255), width=4)
    d.text((24 + s, img.height - 40), "1 m", fill=(0, 0, 0, 255), font=f_small)
    img.convert("RGB").save(out_path)


# ----------------------------------------------------------------------------
# step 2: turn north up, stack, write the plan
# ----------------------------------------------------------------------------

def circular_mean_mod(values_deg, period):
    k = 2 * math.pi / period
    s = sum(math.sin(v * k) for v in values_deg)
    c = sum(math.cos(v * k) for v in values_deg)
    return (math.atan2(s, c) / k) % period


def signed_diff(a, b, period=360.0):
    return (a - b + period / 2) % period - period / 2


def dominant_axis_deg(walls):
    """The direction most walls run in, folded to 0..90 degrees (clockwise on the page)."""
    k = 2 * math.pi / 90.0
    s = c = 0.0
    for w in walls:
        length = dist(w["a"], w["b"])
        ang = math.degrees(math.atan2(w["b"][1] - w["a"][1], w["b"][0] - w["a"][0]))
        s += length * math.sin(ang * k)
        c += length * math.cos(ang * k)
    return (math.atan2(s, c) / k) % 90.0


def make_transform(theta_deg, tx=0.0, ty=0.0):
    """Turn the page counter-clockwise by theta, then shift. Coordinates are y-down."""
    c, s = math.cos(math.radians(theta_deg)), math.sin(math.radians(theta_deg))

    def apply(p):
        return (p[0] * c + p[1] * s + tx, -p[0] * s + p[1] * c + ty)
    return apply


def segments_array(walls):
    return np.array([[w["a"][0], w["a"][1], w["b"][0], w["b"][1]] for w in walls], dtype=float).reshape(-1, 4)


def wall_overlap_shift(moving, fixed, seed, reach=2.0, kernel=0.25):
    """The shift of `moving` (exterior walls) that puts most of its length on the `fixed` exterior walls.

    Returns ((dx, dy), matched share 0..1). Only parallel walls count. The score
    falls off linearly to zero at `kernel` metres, so walls that sit a few
    centimetres inside each other (a thicker foundation wall) still pull evenly.
    """
    if not len(moving) or not len(fixed):
        return seed, 0.0
    pts, dirs = [], []
    for x0, y0, x1, y1 in moving:
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / 0.1))
        ang = math.atan2(y1 - y0, x1 - x0)
        for k in range(n):
            t = (k + 0.5) / n
            pts.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t))
            dirs.append(ang)
    pts, dirs = np.array(pts), np.array(dirs)
    fa, fb = fixed[:, :2], fixed[:, 2:]
    fd = fb - fa
    flen2 = np.maximum((fd ** 2).sum(axis=1), 1e-12)
    fang = np.arctan2(fd[:, 1], fd[:, 0])
    par = np.abs(np.sin(dirs[:, None] - fang[None, :])) < math.sin(math.radians(4.0))    # points x fixed

    def score(shifts):
        out = np.zeros(len(shifts))
        for n, (dx, dy) in enumerate(shifts):
            p = pts + (dx, dy)
            rel = p[:, None, :] - fa[None, :, :]
            t = np.clip((rel * fd[None, :, :]).sum(axis=2) / flen2[None, :], 0.0, 1.0)
            near = fa[None, :, :] + t[:, :, None] * fd[None, :, :]
            dd = np.hypot(p[:, None, 0] - near[:, :, 0], p[:, None, 1] - near[:, :, 1])
            dd = np.where(par, dd, 1e9)
            out[n] = np.maximum(0.0, 1.0 - dd.min(axis=1) / kernel).sum()
        return out

    coarse = [(seed[0] + i * 0.05, seed[1] + j * 0.05) for i in range(int(-reach / 0.05), int(reach / 0.05) + 1) for j in range(int(-reach / 0.05), int(reach / 0.05) + 1)]
    sc = score(coarse)
    best = coarse[int(sc.argmax())]
    fine = [(best[0] + i * 0.01, best[1] + j * 0.01) for i in range(-6, 7) for j in range(-6, 7)]
    sf = score(fine)
    best = fine[int(sf.argmax())]
    return best, float(sf.max() / len(pts))


def stairwells(loaded, final):
    """The stairs of all levels in the common frame, grouped into stairwells.

    Each scan sees only a part of a staircase: the run that goes up from its floor, or the top of the
    run that arrives. Flights of different levels that touch or lie on each other are one stairwell.
    Returns [{"levels": {key}, "runs": [polygon], "flights": [(key, name, riseM)]}] for the stairwells
    that more than one level saw. A stairwell wider than one flight has runs side by side (a landing
    half-way and a turn back): it becomes one rectangle for each run, all as long as the stairwell.
    """
    items = []
    for key, lv in loaded.items():
        for st in lv.get("stairs", []):
            for f in st.get("flights") or [{"name": st["id"], "riseM": 0.0, "footprint": st["mainFlight"]}]:
                items.append((key, Polygon([final[key](p) for p in f["footprint"]]), f["name"], f.get("riseM", 0.0)))
    groups = []
    for it in items:
        hits = [g for g in groups if any(o[1].distance(it[1]) < 0.3 for o in g)]
        groups = [g for g in groups if not any(g is h for h in hits)] + [[it] + [o for h in hits for o in h]]
    wells = []
    for g in groups:
        if len({key for key, *_ in g}) < 2:
            continue
        # the run follows the long side of the flight that climbs most
        lead = max(g, key=lambda o: (o[3], o[1].area))[1].minimum_rotated_rectangle.exterior.coords
        sides = [(lead[i + 1][0] - lead[i][0], lead[i + 1][1] - lead[i][1]) for i in range(2)]
        run = max(sides, key=lambda d: math.hypot(*d))
        n = math.hypot(*run)
        u, v = (run[0] / n, run[1] / n), (-run[1] / n, run[0] / n)
        along = [p[0] * u[0] + p[1] * u[1] for _k, poly, *_ in g for p in poly.exterior.coords]
        side = [p[0] * v[0] + p[1] * v[1] for _k, poly, *_ in g for p in poly.exterior.coords]
        widths = sorted(max(q) - min(q) for q in ([p[0] * v[0] + p[1] * v[1] for p in poly.exterior.coords] for _k, poly, *_ in g))
        count = max(1, round((max(side) - min(side)) / max(0.6, widths[len(widths) // 2])))
        step = (max(side) - min(side)) / count
        s0, s1 = min(along), max(along)
        runs = []
        for k in range(count):
            t0, t1 = min(side) + k * step, min(side) + (k + 1) * step
            runs.append([rpt((s * u[0] + t * v[0], s * u[1] + t * v[1])) for s, t in ((s0, t0), (s1, t0), (s1, t1), (s0, t1))])
        wells.append({"levels": {key for key, *_ in g}, "runs": runs, "flights": [(key, name, rise) for key, _p, name, rise in g],
                      "sizeM": [round(s1 - s0, 2), round(max(side) - min(side), 2)]})
    return wells


def synthesize_level(spec, below, stairs_polygon, axis_deg, materials, elevation):
    """A labelled synthetic layout that sits inside the outline of the level below."""
    construction = materials["construction"]
    rules = construction["levels"][spec["construction"]]
    # walls run at axis_deg (clockwise on the page); turning the page counter-clockwise by that makes them level
    to_axis, from_axis = make_transform(axis_deg), make_transform(-axis_deg)
    base = Polygon([to_axis(p) for p in below["outline"]])
    for room in below.get("rooms", []):
        # a room that is two storeys high leaves a hole in the floor above it
        if room.get("ceilingHeight", 0) > below["height"] + 1.0:
            base = base.difference(Polygon([to_axis(p) for p in room["polygon"]]).buffer(0.05, join_style=2))
    base = largest(base.buffer(-0.02, join_style=2)).simplify(0.02)
    stair = Polygon([to_axis(p) for p in stairs_polygon]) if stairs_polygon else None
    minx, miny, maxx, maxy = base.bounds

    def cuts(lo, hi, parts, avoid):
        out = []
        for k in range(1, parts):
            v = lo + (hi - lo) * k / parts
            if avoid and avoid[0] - 0.4 < v < avoid[1] + 0.4:
                v = avoid[1] + 0.4 if v - avoid[0] > avoid[1] - v else avoid[0] - 0.4
            out.append(v)
        return out

    sb = stair.bounds if stair else None
    xs = [minx] + cuts(minx, maxx, 3, (sb[0], sb[2]) if sb else None) + [maxx]
    ys = [miny] + cuts(miny, maxy, 2, (sb[1], sb[3]) if sb else None) + [maxy]
    rooms, walls, openings = [], [], []
    outline_pts = ring(base)
    for p, q in zip(outline_pts, outline_pts[1:] + outline_pts[:1]):
        walls.append({"a": p, "b": q, "material": rules["exteriorWall"]})
    n = 0
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            cell = Polygon([(xs[i], ys[j]), (xs[i + 1], ys[j]), (xs[i + 1], ys[j + 1]), (xs[i], ys[j + 1])]).intersection(base)
            for part in (cell.geoms if isinstance(cell, MultiPolygon) else [cell]):
                if part.geom_type != "Polygon" or part.area < 2.0:
                    continue
                n += 1
                has_stairs = stair is not None and part.intersects(stair)
                rooms.append({"id": f'{spec["id"]}-synthetic-{n}', "name": "Stair hall (synthetic)" if has_stairs else f"Room {n} (synthetic)",
                              "nameSource": "synthetic", "polygon": ring(part.simplify(0.01))})
    door = 0
    lines = [LineString([(x, miny - 1), (x, maxy + 1)]) for x in xs[1:-1]] + [LineString([(minx - 1, y), (maxx + 1, y)]) for y in ys[1:-1]]
    for line in lines:
        inside = line.intersection(base)
        parts = inside.geoms if hasattr(inside, "geoms") else [inside]
        for part in parts:
            if part.geom_type != "LineString" or part.length < 0.3:
                continue
            a, b = part.coords[0], part.coords[-1]
            walls.append({"a": a, "b": b, "material": rules["interiorWall"]})
            if part.length > 1.8:
                door += 1
                m, u = mid(a, b), ((b[0] - a[0]) / part.length, (b[1] - a[1]) / part.length)
                openings.append({"id": f'{spec["id"]}-door-{door}', "type": "door", "material": rules["doorInterior"], "state": construction["interiorDoorState"],
                                 "a": (m[0] - u[0] * 0.4, m[1] - u[1] * 0.4), "b": (m[0] + u[0] * 0.4, m[1] + u[1] * 0.4)})

    def back(p):
        return rpt(from_axis(p))

    return {
        "id": spec["id"], "name": spec["name"], "elevation": elevation, "height": construction.get("upperCeiling_m", 2.44), "source": "synthetic",
        "floorMaterial": rules["floorUnder"],
        "note": f'SYNTHETIC LAYOUT. This level is not scanned yet. Its outline is the outline of the {below["name"].lower()} without the double-height rooms, its stair opening is the real one, and its rooms are made up.',
        "outline": [back(p) for p in outline_pts],
        "rooms": [{**r, "polygon": [back(p) for p in r["polygon"]]} for r in rooms],
        "walls": [{**w, "a": back(w["a"]), "b": back(w["b"])} for w in walls],
        "openings": [{**o, "a": back(o["a"]), "b": back(o["b"])} for o in openings],
        "stairs": ([{"id": f'{spec["id"]}-stairs-1', "polygon": [rpt(p) for p in stairs_polygon], "connects": [below["id"]],
                     "note": "The real stair position of the level below; the opening itself is not scanned yet."}] if stairs_polygon else []),
        "fixtures": [],
    }


def find_front_door(level):
    """The exterior door that fits the owner's rule best: outside, facing the door, north is to your left."""
    outline = Polygon(level["outline"])
    best = None
    for o in level.get("openings", []):
        if o["type"] != "door" or o["material"].endswith("garage") or o["material"].endswith("glass"):
            continue
        a, b = o["a"], o["b"]
        length = dist(a, b)
        n = (-(b[1] - a[1]) / length, (b[0] - a[0]) / length)
        m = mid(a, b)
        in_a = outline.contains(Point(m[0] + n[0] * 0.4, m[1] + n[1] * 0.4))
        in_b = outline.contains(Point(m[0] - n[0] * 0.4, m[1] - n[1] * 0.4))
        if in_a == in_b:
            continue
        out = (-n[0], -n[1]) if in_a else n
        # north is up; north is to the left of a person who faces east, so the door faces west
        fit = -out[0]
        if best is None or fit > best[0]:
            best = (fit, o, out)
    return best


def assemble(specs, out_dir, materials, src_dir=None, marks_file=None, config_file=None, quiet=False, refit_frame=False):
    out_dir = Path(out_dir)
    config_file = Path(config_file) if config_file else out_dir / "config.local.json"
    construction = materials["construction"]
    loaded = {}
    for spec in specs:
        f = out_dir / "levels" / f'{spec["key"]}.json'
        if f.exists():
            loaded[spec["key"]] = json.loads(f.read_text(encoding="utf-8"))
    if not loaded:
        raise SystemExit("No imported level found. Import a level first.")
    anchor_spec = next((s for s in specs if s.get("anchor") and s["key"] in loaded), None) or next(s for s in specs if s["key"] in loaded)
    anchor = loaded[anchor_spec["key"]]

    # ---- rotation: compass first, then make the walls of all levels parallel ----
    compass, axis_in_north = {}, []
    for key, lv in loaded.items():
        theta = lv["heading"]["northClockwiseFromUpDeg"]
        if theta is None:
            continue
        compass[key] = theta
        axis_in_north.append((dominant_axis_deg(lv["walls"]) - theta) % 90.0)
    north_known = bool(compass)
    fresh_axis = circular_mean_mod(axis_in_north, 90.0) if axis_in_north else dominant_axis_deg(anchor["walls"])
    # The frame (rotation and origin) is fixed the first time and then kept. Marker positions,
    # survey waypoints and samples are stored in plan coordinates, so a later import of one
    # more level must not move the plan under them. --refit-frame sets it again.
    frame_file = out_dir / "levels" / "frame.json"
    locked = None
    if frame_file.exists() and not refit_frame:
        locked = json.loads(frame_file.read_text(encoding="utf-8"))
        if locked.get("anchor") != anchor_spec["key"]:
            locked = None
    house_axis = locked["houseAxisDeg"] if locked else fresh_axis
    rotation, rot_report = {}, {}
    for key, lv in loaded.items():
        phi = dominant_axis_deg(lv["walls"])
        base = compass.get(key, 0.0)
        cands = [(phi - house_axis + 90.0 * k) % 360.0 for k in range(4)]
        theta = min(cands, key=lambda c: abs(signed_diff(c, base)))
        rotation[key] = theta
        rot_report[key] = {"compassNorthClockwiseFromUpDeg": compass.get(key), "usedDeg": round(theta, 2),
                           "changeFromCompassDeg": None if key not in compass else round(signed_diff(theta, base), 2),
                           "compassSigmaDeg": lv["heading"].get("sigmaDeg")}

    # ---- translation: outer walls, seeded and checked by the stairs ----------
    shift, align = {anchor_spec["key"]: (0.0, 0.0)}, {}
    t_anchor = make_transform(rotation[anchor_spec["key"]])
    anchor_ext = segments_array([{"a": t_anchor(w["a"]), "b": t_anchor(w["b"])} for w in anchor["walls"] if w.get("exterior")])
    # The anchor level can show two flights side by side (a staircase with a landing half-way that turns
    # back): the run up from this floor, and the top of the run that arrives from below. A level above
    # sees only the run that arrives. Each flight is a candidate; the largest comes first, so it wins
    # when the outer walls do not decide.
    anchor_flights = []
    for s in anchor.get("stairs", []):
        prints = [f["footprint"] for f in s.get("flights", []) if f.get("footprint")] or [s["mainFlight"]]
        anchor_flights += [Polygon([t_anchor(p) for p in fp]) for fp in prints]
    anchor_flights.sort(key=lambda p: -p.area)
    for key, lv in loaded.items():
        if key == anchor_spec["key"]:
            continue
        t0 = make_transform(rotation[key])
        ext = segments_array([{"a": t0(w["a"]), "b": t0(w["b"])} for w in lv["walls"] if w.get("exterior")])
        stair_shift, anchor_stair = None, None
        if anchor_flights and lv.get("stairs"):
            main = max(lv["stairs"], key=lambda s: Polygon(s["mainFlight"]).area)
            c = Polygon([t0(p) for p in main["mainFlight"]]).centroid
            # The owner confirmed that one stair run joins the levels, so the stairs give the first
            # estimate and the outer walls may move it by at most 0.6 m. The flight of the anchor
            # level that puts most outer wall on outer wall is the one this level joins.
            best = None
            for flight in anchor_flights:
                cand = (flight.centroid.x - c.x, flight.centroid.y - c.y)
                found, found_share = wall_overlap_shift(ext, anchor_ext, cand, reach=0.6)
                if best is None or found_share > best[3] + 0.02:
                    best = (flight, cand, found, found_share)
            anchor_stair, stair_shift, wall_shift, share = best
            seed = stair_shift
        else:
            # without stairs the search is wide
            ca, cl = Polygon([t_anchor(p) for p in anchor["outline"]]).centroid, Polygon([t0(p) for p in lv["outline"]]).centroid
            seed = (ca.x - cl.x, ca.y - cl.y)
            wall_shift, share = wall_overlap_shift(ext, anchor_ext, seed, reach=2.5)
        use_walls = share >= 0.2
        chosen = wall_shift if use_walls else seed
        shift[key] = chosen
        entry = {"method": ("stairs, then outer walls" if stair_shift else "outer walls") if use_walls else ("stairs" if stair_shift else "outline centres"),
                 "outerWallShareMatched": round(share, 2)}
        if stair_shift is not None:
            # residual: how far the stairs of this level sit from the stairs of the anchor level after stacking
            ax = math.radians(house_axis)
            ex, ey = chosen[0] - stair_shift[0], chosen[1] - stair_shift[1]
            entry["stairResidualCm"] = {"total": round(100 * math.hypot(ex, ey), 1),
                                        "alongHouseAxisCm": round(100 * (ex * math.cos(ax) + ey * math.sin(ax)), 1),
                                        "acrossHouseAxisCm": round(100 * (-ex * math.sin(ax) + ey * math.cos(ax)), 1)}
            moved = Polygon([make_transform(rotation[key], *chosen)(p) for p in main["mainFlight"]])
            entry["stairOverlapShare"] = round(moved.intersection(anchor_stair).area / min(moved.area, anchor_stair.area), 2)
        align[key] = entry

    # ---- one frame for everything: the lowest corner is (0, 0) ---------------
    if locked:
        gx, gy = locked["origin"]
    else:
        # the origin depends on the anchor level only, so that no other level can move it
        anchor_pts = [t_anchor(p) for p in anchor["outerFace"]]
        gx, gy = round(-min(p[0] for p in anchor_pts) + 0.5, 2), round(-min(p[1] for p in anchor_pts) + 0.5, 2)
        frame_file.write_text(json.dumps({
            "about": "The fixed frame of floorplan.json. Delete this file or run the importer with --refit-frame to set it again; that moves every stored position.",
            "anchor": anchor_spec["key"], "houseAxisDeg": round(house_axis, 4), "origin": [gx, gy],
            "set": datetime.now(timezone.utc).isoformat(timespec="seconds"), "levelsUsedForNorth": sorted(compass)}, indent=1) + "\n", encoding="utf-8")
    final = {k: make_transform(rotation[k], shift[k][0] + gx, shift[k][1] + gy) for k in loaded}

    # ---- elevations ----------------------------------------------------------
    structure = construction.get("floor_structure_m", 0.3)
    order = [s for s in specs if s["key"] in loaded or s.get("synthesizeIfMissing")]
    ai = next(i for i, s in enumerate(order) if s["key"] == anchor_spec["key"])
    heights = {s["key"]: (loaded[s["key"]]["height"] if s["key"] in loaded else construction.get("upperCeiling_m", 2.44)) for s in order}
    elevation = {anchor_spec["key"]: 0.0}
    for i in range(ai + 1, len(order)):
        elevation[order[i]["key"]] = round(elevation[order[i - 1]["key"]] + heights[order[i - 1]["key"]] + structure, 2)
    for i in range(ai - 1, -1, -1):
        elevation[order[i]["key"]] = round(elevation[order[i + 1]["key"]] - heights[order[i]["key"]] - structure, 2)

    # ---- levels of the plan --------------------------------------------------
    ids = {s["key"]: s["id"] for s in order}
    # a scanned staircase is the flight that goes up from this floor (down, on the top floor)
    leads = {}
    for i, spec in enumerate(order):
        other = order[i + 1]["key"] if i + 1 < len(order) else (order[i - 1]["key"] if i > 0 else None)
        leads[spec["key"]] = other
    wells = stairwells(loaded, final)
    plan_levels = []
    for i, spec in enumerate(order):
        key = spec["key"]
        if key not in loaded:
            continue
        lv, t = loaded[key], final[key]
        stairs = []
        for well in wells:
            if key not in well["levels"] or not leads[key]:
                continue
            # one stairwell seen from several levels: the same runs on each of them, so that they lie on each other
            connects = [ids[leads[key]]] + [ids[k] for k in sorted(well["levels"]) if k != key and leads[k] == key and k != leads[key]]
            seen = ", ".join(f'{ids[k]}: {name} rises {rise} m' for k, name, rise in well["flights"])
            for run in well["runs"]:
                stairs.append({"id": f'{lv["id"]}-stairs-{len(stairs) + 1}', "polygon": run, "connects": connects,
                               "note": (f'Run {len(stairs) + 1} of {len(well["runs"])} of one stairwell, side by side. ' if len(well["runs"]) > 1 else "One stairwell. ")
                                       + f"Footprint around the flights that the scans of all levels saw ({seen})."})
        in_well = any(key in well["levels"] for well in wells)
        for st in lv.get("stairs", []):
            if in_well or not leads[key]:
                continue
            stairs.append({"id": st["id"], "polygon": [rpt(t(p)) for p in st["polygon"]], "connects": [ids[leads[key]]],
                           "note": "Footprint of the flight seen by the scan (" + ", ".join(f'{f["name"]} rises {f["riseM"]} m' for f in st["flights"]) + ")."})
        level = {
            "id": lv["id"], "name": lv["name"], "elevation": elevation[key], "height": lv["height"], "source": "lidar-scan",
            "floorMaterial": lv["floorMaterial"],
            "note": "Imported from a Polycam LiDAR scan by tools/trace/import_polycam.py. Wall positions, openings, room shapes and ceiling heights are measured. Materials and wall thickness are assumed (data/materials.json).",
            "outline": [rpt(t(p)) for p in lv["outline"]],
            "rooms": [{**{k: v for k, v in r.items() if k != "polygon"}, "polygon": [rpt(t(p)) for p in r["polygon"]]} for r in lv["rooms"]],
            "walls": [{"a": rpt(t(w["a"])), "b": rpt(t(w["b"])), "material": w["material"],
                       **({"thickness": w["thickness"]} if w.get("thickness") else {}), **({"origin": w["origin"]} if w.get("origin") else {}),
                       **({"note": w["note"]} if w.get("note") else {})} for w in lv["walls"]],
            "openings": [{"id": o["id"], "type": o["type"], "a": rpt(t(o["a"])), "b": rpt(t(o["b"])), "material": o["material"],
                          **({"state": o["state"]} if "state" in o else {})} for o in lv["openings"]],
            "stairs": stairs,
            "fixtures": [{"type": f["type"], "name": f["name"], "material": f["material"], "polygon": [rpt(t(p)) for p in f["polygon"]]} for f in lv["fixtures"]],
        }
        plan_levels.append((i, level))

    by_key = {order[i]["key"]: level for i, level in plan_levels}
    for i, spec in enumerate(order):
        if spec["key"] in loaded or not spec.get("synthesizeIfMissing") or i == 0:
            continue
        below = by_key.get(order[i - 1]["key"])
        if not below:
            continue
        up = next((s["polygon"] for s in below.get("stairs", []) if spec["id"] in s["connects"]), None)
        synthetic = synthesize_level(spec, below, up, house_axis, materials, elevation[spec["key"]])
        plan_levels.append((i, synthetic))
        by_key[spec["key"]] = synthetic
    plan_levels = [level for _i, level in sorted(plan_levels, key=lambda x: x[0])]

    # ---- front door (inferred) ------------------------------------------------
    front = None
    main_level = by_key.get(anchor_spec["key"])
    hit = find_front_door(main_level) if north_known else None
    # a door the owner chose with tools/set-front-door.mjs stays the front door
    chosen = None
    if config_file.exists():
        chosen = (json.loads(config_file.read_text(encoding="utf-8")).get("site") or {}).get("frontDoor")
        chosen = chosen if chosen and chosen.get("source") == "chosen" and chosen.get("level") == main_level["id"] else None
    if chosen:
        doors = [o for o in main_level["openings"] if o["type"] == "door"]
        near = min(doors, key=lambda o: dist(mid(o["a"], o["b"]), (chosen["x"], chosen["y"])), default=None)
        if near is not None and dist(mid(near["a"], near["b"]), (chosen["x"], chosen["y"])) < 0.6:
            hit = (0.0, near, tuple(chosen.get("outward") or (0.0, 0.0)))
        else:
            chosen = None
    if hit:
        _fit, door, outward = hit
        for o in main_level["openings"]:
            if o is door:
                o["id"] = "front-door"
                o["note"] = "Front door chosen by the owner." if chosen else "Inferred front door: the exterior door that best fits the rule 'outside, facing the front door, north is to your left'."
        bearing = (math.degrees(math.atan2(outward[0], -outward[1]))) % 360.0
        front = {"level": main_level["id"], "openingId": "front-door", "x": r3(mid(door["a"], door["b"])[0]), "y": r3(mid(door["a"], door["b"])[1]),
                 "outward": [r3(outward[0]), r3(outward[1])], "facesBearingDeg": round(bearing, 1), "source": "chosen" if chosen else "inferred"}

    plan = {"schemaVersion": 1, "name": "House (LiDAR import)", "units": "m",
            "note": "North is up the page. Scanned levels come from Polycam LiDAR exports; a level marked synthetic is a stand-in. Private: do not copy this file out of data/private.",
            "levels": plan_levels}
    (out_dir / "floorplan.json").write_text(json.dumps(plan, indent=1) + "\n", encoding="utf-8")

    # ---- access-point marks -> positions --------------------------------------
    positions = None
    marks_file = Path(marks_file) if marks_file else out_dir / "ap-marks.json"
    if marks_file.exists():
        marks = json.loads(marks_file.read_text(encoding="utf-8"))
        positions = {}
        per_level = {}
        for m in marks.get("marks", []):
            lv = loaded.get(m["level"])
            if not lv or "png" not in lv:
                continue
            x = m["px"][0] / lv["png"]["pxPerM"] + lv["png"]["offsetX"] + m.get("offsetM", [0, 0])[0]
            y = m["px"][1] / lv["png"]["pxPerM"] + lv["png"]["offsetY"] + m.get("offsetM", [0, 0])[1]
            fx, fy = final[m["level"]]((x, y))
            entry = {"level": lv["id"], "x": round(fx, 2), "y": round(fy, 2), "source": "placed from the owner's marks"}
            for k in ("z", "heightSource", "enclosureLossDb", "enclosureSource", "mount"):
                if k in m:
                    entry[k] = m[k]
            positions[m["id"]] = entry
            # devices that share one mark get one label
            same = next((e for e in per_level.setdefault(m["level"], []) if e["px"] == m["px"]), None)
            if same:
                same["label"] += " + " + m.get("label", m["id"])
            else:
                per_level[m["level"]].append({"px": m["px"], "label": m.get("label", m["id"])})
        try:
            plan_ref = (out_dir / "floorplan.json").resolve().relative_to(ROOT).as_posix()
        except ValueError:
            plan_ref = ""
        (out_dir / "ap-positions.json").write_text(json.dumps({"schemaVersion": 1, "floorplan": plan_ref, "saved": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                                                "about": "Written by tools/trace/import_polycam.py from ap-marks.json. Heights and enclosure loss are assumed.",
                                                                "positions": positions}, indent=2) + "\n", encoding="utf-8")
        for key, lv in loaded.items():
            png = Path(src_dir) / key / "floorplan.png" if src_dir else None
            if png and png.exists() and "png" in lv:
                draw_level_overlay(lv, png, out_dir / f"trace-check-{key}.png", per_level.get(key), construction["levels"][lv["construction"]])

    # ---- report ---------------------------------------------------------------
    north = None
    if north_known:
        anchor_theta = rotation[anchor_spec["key"]]
        north = {"northDeg": 0, "anchorPlanNorthClockwiseFromUpDeg": round(anchor_theta, 2),
                 "uncertaintyDeg": round(max((lv["heading"].get("sigmaDeg") or 2.5) for lv in loaded.values()) / math.sqrt(len(compass)), 1),
                 "source": f"mean of {len(compass)} Polycam compass headings, with the walls of all levels made parallel"}
    summary_bits = []
    for key, a in align.items():
        if "stairResidualCm" in a:
            summary_bits.append(f'{loaded[key]["name"]}: placed by {a["method"]}; its stairs sit {a["stairResidualCm"]["total"]:.0f} cm from the {anchor["name"].lower()} stairs')
    report = {
        "written": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "frame": "north up; metres; x east, y south; the lowest corner of the anchor level is near (0.5, 0.5)",
        "frameLock": {"locked": bool(locked), "houseAxisDeg": round(house_axis, 2), "houseAxisFromAllLevelsDeg": round(fresh_axis, 2),
                      "differenceDeg": round(signed_diff(fresh_axis, house_axis, 90.0), 2),
                      "note": "The frame is kept from the first import so that stored positions stay valid. differenceDeg is how far the north estimate from all levels now is from the kept one."},
        "houseAxisDeg": round(house_axis, 2),
        "north": north,
        "rotation": rot_report,
        "stacking": align,
        "stairwells": [{"levels": [ids[k] for k in sorted(w["levels"])], "runs": len(w["runs"]), "sizeM": w["sizeM"]} for w in wells],
        "frontDoor": front,
        "doubleHeight": [{"level": lv["id"], "room": r["name"], "ceilingHeightM": r["ceilingHeight"],
                          "note": "Recorded in the plan. No floor-to-floor coupling is added for it until the level above is scanned."}
                         for lv in plan_levels for r in lv.get("rooms", []) if r.get("ceilingHeight", 0) > lv["height"] + 1.0],
        "syntheticLevels": [lv["id"] for lv in plan_levels if lv["source"] == "synthetic"],
        "levels": {key: lv["checks"] for key, lv in loaded.items()},
        "summaryLine": "; ".join(summary_bits),
    }
    (out_dir / "import-report.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    draw_stack(plan_levels, out_dir / "trace-check-stack.png", report, positions)

    # ---- site section of the private config ------------------------------------
    if north_known and config_file.exists():
        config = json.loads(config_file.read_text(encoding="utf-8"))
        site = dict(config.get("site") or {})
        site.update(northDeg=0, northMeasured=True, northUncertaintyDeg=north["uncertaintyDeg"],
                    northSource=f'measured: {north["source"]}. The plan is drawn north up.')
        if front:
            site["frontDoor"] = front
        config["site"] = site
        config_file.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    if not quiet:
        print_report(report, plan_levels)
    return plan, report


def print_report(report, plan_levels):
    print("Levels in data/private/floorplan.json:")
    for lv in plan_levels:
        print(f'  {lv["id"]:2s} {lv["name"]:13s} {lv["source"]:10s} floor at {lv["elevation"]:+.2f} m, ceiling {lv["height"]} m, {len(lv.get("rooms", []))} rooms, {len(lv["walls"])} walls, {len(lv.get("openings", []))} openings')
    if report["north"]:
        print(f'North: {report["north"]["anchorPlanNorthClockwiseFromUpDeg"]} deg clockwise from plan-up of the anchor level (+/- {report["north"]["uncertaintyDeg"]}). The plan is drawn north up.')
    lock = report["frameLock"]
    if lock["locked"]:
        print(f'  The frame is kept from the first import. North from all levels now differs from it by {lock["differenceDeg"]} deg (--refit-frame adopts it and moves stored positions).')
    for key, r in report["rotation"].items():
        print(f'  rotation {key}: compass {r["compassNorthClockwiseFromUpDeg"]}, used {r["usedDeg"]} (change {r["changeFromCompassDeg"]} deg)')
    for key, a in report["stacking"].items():
        line = f'  stacking {key}: by {a["method"]} ({a["outerWallShareMatched"]:.0%} of its outer walls lie on outer walls of the anchor level)'
        if "stairResidualCm" in a:
            s = a["stairResidualCm"]
            line += f'; stair residual {s["total"]} cm (along {s["alongHouseAxisCm"]}, across {s["acrossHouseAxisCm"]}), stair overlap {a["stairOverlapShare"]:.0%}'
        print(line)
    for w in report.get("stairwells", []):
        print(f'  stairwell on levels {", ".join(w["levels"])}: {w["runs"]} run(s) side by side, {w["sizeM"][0]} m long and {w["sizeM"][1]} m wide; drawn the same on each level')
    for key, checks in report["levels"].items():
        e = checks["exteriorAreaM2"]
        print(f'{key}: exterior area {e["imported"]} m2 (CSV {e["csv"]}), overall {checks["overallM"]["width"]} x {checks["overallM"]["height"]} m')
        worst = max((abs(r["diffM2"]) for r in checks["rooms"] if r["diffM2"] is not None), default=0)
        print(f'  rooms: {len(checks["rooms"])}, largest area difference to the CSV {worst:.2f} m2')
        dims = [d for d in checks["printedDimensions"] if d["diffM"] is not None]
        if dims:
            print(f'  printed outside dimensions: {len(dims)}, largest difference {max(abs(d["diffM"]) for d in dims):.2f} m')
        for a in checks["wallsAdded"]:
            print(f'  not in the scan: {a["kind"]}, {a["room"]}, {a["lengthM"]} m')
        for r in checks["rooms"]:
            print(f'    {r["room"]:15s} {r["toWallFaceM2"]:6.2f} m2, CSV {r["csvM2"]}, difference {r["diffM2"]}')
        print(f'  walls drawn {checks["drawnWallThicknessM"]["min"]} to {checks["drawnWallThicknessM"]["max"]} m thick (Polycam setting {checks["drawnWallThicknessM"]["csvSetting"]}); doors {checks["counts"]["doors"]} (CSV {checks["counts"]["csvDoors"]}), windows {checks["counts"]["windows"]} (CSV {checks["counts"]["csvWindows"]}), spatial report lists {checks["counts"]["spatialReportListings"]} (a door is listed once for each room it belongs to); walls against the 3D model: worst {checks["glbWallCrossCheckCm"]} cm')
        for s in checks["fixturesSkipped"]:
            print(f'  left out: {s["name"]}: {s["why"]}')
        for w in checks["warnings"]:
            print(f"  WARNING: {w}")
    if report["frontDoor"]:
        print(f'Front door (inferred): opening "front-door" on level {report["frontDoor"]["level"]}, faces bearing {report["frontDoor"]["facesBearingDeg"]} deg.')


def main(argv=None):
    ap = argparse.ArgumentParser(description="Import Polycam floor-plan exports and stack the levels north-up.")
    ap.add_argument("--level", action="append", default=[], help="level key to import again (folder name), for example second-floor. Repeat for more.")
    ap.add_argument("--all", action="store_true", help="import every level whose folder holds floorplan.dxf")
    ap.add_argument("--assemble-only", action="store_true", help="do not read any export; only stack the levels again")
    ap.add_argument("--refit-frame", action="store_true", help="set north and the origin again from all levels. This moves every stored position (markers, waypoints, samples)")
    ap.add_argument("--source-dir", default=str(ROOT / "data/private/photos/polycam"))
    ap.add_argument("--out-dir", default=str(ROOT / "data/private"))
    ap.add_argument("--levels-file", default=str(ROOT / "tools/trace/levels.json"))
    ap.add_argument("--materials", default=str(ROOT / "data/materials.json"))
    ap.add_argument("--room-names", default=None, help="default: <out-dir>/room-names.json")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    specs = json.loads(Path(args.levels_file).read_text(encoding="utf-8"))["levels"]
    materials = json.loads(Path(args.materials).read_text(encoding="utf-8"))
    names_file = Path(args.room_names) if args.room_names else Path(args.out_dir) / "room-names.json"
    room_names = json.loads(names_file.read_text(encoding="utf-8")) if names_file.exists() else {}
    keys = list(args.level)
    if args.all:
        keys = [s["key"] for s in specs if (Path(args.source_dir) / s["key"] / "floorplan.dxf").exists()]
    if not keys and not args.assemble_only:
        ap.error("name a level with --level, or use --all or --assemble-only")
    known = {s["key"]: s for s in specs}
    for key in keys:
        if key not in known:
            ap.error(f'unknown level "{key}". Known levels: {", ".join(known)}')
        import_level(known[key], args.source_dir, args.out_dir, materials, room_names)
        if not args.quiet:
            print(f"imported {key}")
    # assemble() draws the overlay pictures again so that they show the access-point marks
    assemble(specs, args.out_dir, materials, src_dir=args.source_dir, quiet=args.quiet, refit_frame=args.refit_frame)
    return 0


if __name__ == "__main__":
    sys.exit(main())
