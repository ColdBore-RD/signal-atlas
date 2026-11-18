#!/usr/bin/env python3
"""Fit the image scale (pixels per metre) from labelled dimensions.

Usage: python3 tools/trace/fit_scale.py <measurements.json> [<out.json>]

Each measurement gives a label in metres, whether the label measures between
the outer or the inner faces of two walls, and the pixel distance between the
two wall centrelines. The scan app draws walls thicker than they are, so the
centreline is the only reliable pixel reference. The model is

    centreline_px = scale * (label_m - wall_m)   for an outer dimension
    centreline_px = scale * (label_m + wall_m)   for an inner dimension

with two unknowns: scale (px per metre) and wall_m (true wall thickness).
Solved by linear least squares. Prints each residual in centimetres.
"""
import json
import sys

import numpy as np


def main():
    meas = json.load(open(sys.argv[1]))["measurements"]
    # centreline_px = scale*label + k*sign, with k = scale*wall and sign -1 outer, +1 inner
    a = np.array([[m["label_m"], -1.0 if m["faces"] == "outer" else 1.0] for m in meas])
    b = np.array([m["centreline_px"] for m in meas], dtype=float)
    (scale, k), *_ = np.linalg.lstsq(a, b, rcond=None)
    wall = k / scale
    print(f"scale = {scale:.3f} px per metre, fitted wall thickness = {wall * 100:.1f} cm")
    worst = 0.0
    rows = []
    for m, row, px in zip(meas, a, b):
        implied_m = (px - k * row[1]) / scale
        res_cm = (implied_m - m["label_m"]) * 100
        worst = max(worst, abs(res_cm))
        naive = px / m["label_m"]
        rows.append({"label_m": m["label_m"], "faces": m["faces"], "residual_cm": round(res_cm, 2)})
        print(f"  {m['label_m']:6.2f} m ({m['faces']:5s}): implied {implied_m:6.3f} m, residual {res_cm:+5.1f} cm"
              f"   (centreline px / label = {naive:.2f})")
    rms = float(np.sqrt(np.mean([r["residual_cm"] ** 2 for r in rows])))
    print(f"RMS residual {rms:.1f} cm, worst {worst:.1f} cm")
    if len(sys.argv) > 2:
        json.dump({"px_per_m": round(float(scale), 4), "wall_m": round(float(wall), 4),
                   "rms_residual_cm": round(rms, 2), "worst_residual_cm": round(worst, 2), "rows": rows},
                  open(sys.argv[2], "w"), indent=1)


if __name__ == "__main__":
    main()
