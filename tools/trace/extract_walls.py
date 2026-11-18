#!/usr/bin/env python3
"""Find thick black wall strokes in a cropped floor-plan screenshot.

Usage: python3 tools/trace/extract_walls.py <crop.png> <out-dir>

The scan app draws walls as thick, pure-black strokes and furniture as thin
outlines. This tool keeps only strokes that are thick in both directions, then
reports axis-aligned wall rectangles (in crop pixels) as JSON. Diagonal walls
are reported as leftover blobs for a person to trace by hand.

Output goes to <out-dir> (keep that inside data/private/: it is derived from a
private image). Needs Pillow and numpy only.
"""
import json
import sys
from collections import deque

import numpy as np
from PIL import Image

DARK_MAX = 45      # max RGB channel value that still counts as wall ink
MIN_THICK = 7      # px: strokes thinner than this are furniture or text
MIN_RUN = 22       # px: shortest run that counts as a wall piece


def erode(mask, k):
    """Binary erosion with a k x k square (separable, numpy only)."""
    out = mask.copy()
    r = k // 2
    for axis in (0, 1):
        acc = np.ones_like(out)
        for d in range(-r, r + 1):
            acc &= np.roll(out, d, axis=axis)
        out = acc
    return out


def dilate(mask, k):
    out = mask.copy()
    r = k // 2
    for axis in (0, 1):
        acc = np.zeros_like(out)
        for d in range(-r, r + 1):
            acc |= np.roll(out, d, axis=axis)
        out = acc
    return out


def run_lengths(mask, axis):
    """For each True pixel, the length of the True run it sits in along axis."""
    m = mask if axis == 1 else mask.T
    out = np.zeros(m.shape, dtype=np.int32)
    for i, row in enumerate(m):
        padded = np.concatenate(([0], row.astype(np.int8), [0]))
        d = np.diff(padded)
        starts = np.where(d == 1)[0]
        ends = np.where(d == -1)[0]
        for s, e in zip(starts, ends):
            out[i, s:e] = e - s
    return out if axis == 1 else out.T


def components(mask):
    """4-connected components. Returns list of (x0, y0, x1, y1, area)."""
    h, w = mask.shape
    seen = np.zeros_like(mask)
    boxes = []
    ys, xs = np.where(mask)
    for y, x in zip(ys, xs):
        if seen[y, x]:
            continue
        q = deque([(y, x)])
        seen[y, x] = True
        x0 = x1 = x
        y0 = y1 = y
        area = 0
        while q:
            cy, cx = q.popleft()
            area += 1
            x0, x1 = min(x0, cx), max(x1, cx)
            y0, y1 = min(y0, cy), max(y1, cy)
            for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        boxes.append((int(x0), int(y0), int(x1) + 1, int(y1) + 1, int(area)))
    return boxes


def main():
    src, out_dir = sys.argv[1], sys.argv[2]
    rgb = np.asarray(Image.open(src).convert("RGB")).astype(np.int16)
    dark = rgb.max(axis=2) < DARK_MAX
    thick = dilate(erode(dark, MIN_THICK), MIN_THICK) & dark

    hrun = run_lengths(thick, 1)
    vrun = run_lengths(thick, 0)
    horizontal = thick & (hrun >= MIN_RUN) & (hrun >= vrun)
    vertical = thick & (vrun >= MIN_RUN) & (vrun > hrun)
    leftover = thick & ~dilate(horizontal | vertical, 5)

    result = {"image": src, "horizontal": [], "vertical": [], "leftover": []}
    for name, mask in (("horizontal", horizontal), ("vertical", vertical), ("leftover", leftover)):
        for x0, y0, x1, y1, area in components(mask):
            if area < 40:
                continue
            result[name].append({"x0": x0, "y0": y0, "x1": x1, "y1": y1, "area": area})
        result[name].sort(key=lambda b: (b["y0"], b["x0"]))

    with open(f"{out_dir}/walls-auto.json", "w") as fh:
        json.dump(result, fh, indent=1)

    debug = np.full(rgb.shape, 255, dtype=np.uint8)
    debug[dark] = (200, 200, 200)
    debug[horizontal] = (220, 40, 40)
    debug[vertical] = (40, 80, 220)
    debug[leftover] = (20, 160, 60)
    Image.fromarray(debug).save(f"{out_dir}/walls-auto.png")
    print(f"horizontal {len(result['horizontal'])}, vertical {len(result['vertical'])}, "
          f"leftover {len(result['leftover'])} -> {out_dir}/walls-auto.json")


if __name__ == "__main__":
    main()
