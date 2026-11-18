#!/usr/bin/env python3
"""Draw a traced level on top of the cropped scan, to check the trace by eye.

Usage: python3 tools/trace/overlay.py <floorplan.json> <level-id> <georef.json> <out.png> [zoom]

georef.json gives the cropped image, the pixel that is (0, 0) metres and the
scale file. Walls are red, doors green, windows cyan, plain openings yellow,
stairs orange, fixtures purple, room outlines thin blue with their names.
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont


def main():
    plan = json.load(open(sys.argv[1]))
    level = next(l for l in plan["levels"] if l["id"] == sys.argv[2])
    geo = json.load(open(sys.argv[3]))
    out = sys.argv[4]
    zoom = float(sys.argv[5]) if len(sys.argv) > 5 else 2.0
    scale = json.load(open(geo["scale_file"]))["px_per_m"]
    ox, oy = geo["origin_px"]

    img = Image.open(geo["image"]).convert("RGB")
    img = img.resize((int(img.width * zoom), int(img.height * zoom)), Image.LANCZOS)
    draw = ImageDraw.Draw(img, "RGBA")
    try:
        font = ImageFont.truetype("DejaVuSans.ttf", int(9 * zoom))
    except OSError:
        font = ImageFont.load_default()

    def px(p):
        return ((p[0] * scale + ox) * zoom, (p[1] * scale + oy) * zoom)

    for room in level.get("rooms", []):
        pts = [px(p) for p in room["polygon"]]
        draw.line(pts + [pts[0]], fill=(40, 90, 255, 150), width=1)
        cx = sum(p[0] for p in pts) / len(pts)
        cy = sum(p[1] for p in pts) / len(pts)
        draw.text((cx, cy), room["name"], fill=(20, 60, 220, 255), font=font, anchor="mm")
    for st in level.get("stairs", []):
        pts = [px(p) for p in st["polygon"]]
        draw.polygon(pts, fill=(255, 150, 0, 50), outline=(255, 130, 0, 255))
    for fx in level.get("fixtures", []):
        pts = [px(p) for p in fx["polygon"]]
        draw.polygon(pts, fill=(160, 60, 220, 50), outline=(150, 40, 210, 255))
    for wall in level["walls"]:
        draw.line([px(wall["a"]), px(wall["b"])], fill=(255, 30, 30, 200), width=max(2, int(1.5 * zoom)))
    colours = {"door": (0, 200, 70, 255), "window": (0, 200, 235, 255), "opening": (245, 215, 0, 255)}
    for op in level.get("openings", []):
        draw.line([px(op["a"]), px(op["b"])], fill=colours[op["type"]], width=max(3, int(2.5 * zoom)))
    img.save(out)
    print("wrote", out, img.size)


if __name__ == "__main__":
    main()
