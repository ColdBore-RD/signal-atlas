// North from the front door.
//
// The rule from the owner: "standing outside and facing the front door, north is to
// your left". On the plan x runs right and y runs down the page.
// northDeg is the direction of north, in degrees clockwise from "up the page".
// 0 = north is up, 90 = north is to the right, 180 = down, 270 = left.

import { pointInPolygon } from './geometry.js';

/** outward = unit vector that points from the door away from the house, in plan coordinates. */
export function northFromOutwardNormal(outward) {
  const facing = [-outward[0], -outward[1]];      // the person looks at the door
  const left = [facing[1], -facing[0]];           // left of the facing direction, on a y-down page
  const deg = (Math.atan2(left[0], -left[1]) * 180) / Math.PI;
  return ((Math.round(deg * 10) / 10) % 360 + 360) % 360;
}

/** Outward unit normal of an opening on the outline of its level, or null when both sides are inside or both outside. */
export function outwardNormal(opening, outline) {
  const mx = (opening.a[0] + opening.b[0]) / 2, my = (opening.a[1] + opening.b[1]) / 2;
  const dx = opening.b[0] - opening.a[0], dy = opening.b[1] - opening.a[1];
  const len = Math.hypot(dx, dy);
  const n = [-dy / len, dx / len];
  const step = 0.4;
  const inA = pointInPolygon(mx + n[0] * step, my + n[1] * step, outline);
  const inB = pointInPolygon(mx - n[0] * step, my - n[1] * step, outline);
  if (inA === inB) return null;
  return inA ? [-n[0], -n[1]] : n;
}

export function compassWord(deg) {
  const words = ['up the page', 'to the upper right', 'to the right', 'to the lower right', 'down the page', 'to the lower left', 'to the left', 'to the upper left'];
  return words[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
