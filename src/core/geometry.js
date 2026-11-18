// Plane geometry helpers shared by the propagation model, the wave-grid
// rasteriser, the 3D scene and the tests. Pure functions, no DOM, so the same
// file runs in the browser and in Node.
//
// Floor-plan coordinates are metres: x runs right and y runs down the page.

export const EPS = 1e-9;

export function dist(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Signed area of a polygon (positive when the points run clockwise on a y-down page). */
export function signedArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

export function polygonArea(poly) {
  return Math.abs(signedArea(poly));
}

export function polygonCentroid(poly) {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    const f = x1 * y2 - x2 * y1;
    cx += (x1 + x2) * f;
    cy += (y1 + y2) * f;
    a += f;
  }
  if (Math.abs(a) < EPS) return [poly[0][0], poly[0][1]];
  return [cx / (3 * a), cy / (3 * a)];
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from point (px, py) to the segment a-b. */
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * A point that is inside the polygon and far from its edges (a coarse "pole of
 * inaccessibility"). Used to place labels and synthetic sensors in L-shaped rooms,
 * where the centroid can fall outside the room.
 */
export function interiorPoint(poly, step = 0.25) {
  const b = bounds(poly);
  let best = polygonCentroid(poly), bestD = -1;
  for (let y = b.minY + step / 2; y < b.maxY; y += step) {
    for (let x = b.minX + step / 2; x < b.maxX; x += step) {
      if (!pointInPolygon(x, y, poly)) continue;
      let d = Infinity;
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        d = Math.min(d, pointSegmentDistance(x, y, p[0], p[1], q[0], q[1]));
      }
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best;
}

export function bounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** True when the open segments p1-p2 and p3-p4 cross. Flat number arguments keep this fast. */
export function segmentsCross(x1, y1, x2, y2, x3, y3, x4, y4) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (d > -EPS && d < EPS) return false; // parallel: a ray that runs along a wall does not cross it
  const t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  return t > 0 && t < 1 && u >= 0 && u <= 1;
}

/**
 * Position of point p along the wall a-b (0 at a, 1 at b) and its distance from the
 * wall line, both needed to decide whether an opening sits on a wall.
 */
export function projectOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < EPS) return { t: 0, off: dist(p, a), len: 0 };
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len);
  const off = Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
  return { t, off, len };
}

export const OPENING_TOLERANCE_M = 0.08;

/** Index of the wall that an opening sits on, or -1. */
export function findHostWall(opening, walls, tol = OPENING_TOLERANCE_M) {
  let best = -1, bestOff = Infinity;
  for (let i = 0; i < walls.length; i++) {
    const w = walls[i];
    const pa = projectOnSegment(opening.a, w.a, w.b);
    const pb = projectOnSegment(opening.b, w.a, w.b);
    if (pa.len < EPS) continue;
    const slack = tol / pa.len;
    if (pa.off > tol || pb.off > tol) continue;
    if (Math.min(pa.t, pb.t) < -slack || Math.max(pa.t, pb.t) > 1 + slack) continue;
    const off = pa.off + pb.off;
    if (off < bestOff) { bestOff = off; best = i; }
  }
  return best;
}

/**
 * Turn one level into a flat list of obstacle segments.
 *
 * Each wall is cut at its openings. A wall piece keeps the wall material. A window
 * or a closed door becomes a piece with its own material. An open door or a plain
 * opening leaves a gap (kind "gap", material "open") that blocks nothing.
 * Each edge of a fixture (fireplace, appliance) becomes a piece with weight 0.5,
 * because a path through the fixture crosses two edges.
 *
 * Returns [{ ax, ay, bx, by, material, kind, thickness, weight, wallIndex }].
 */
export function buildObstacles(level, materials) {
  const out = [];
  const walls = level.walls || [];
  const byWall = walls.map(() => []);
  for (const op of level.openings || []) {
    const host = findHostWall(op, walls);
    if (host >= 0) byWall[host].push(op);
  }
  const thick = (name, own) => own ?? materials?.[name]?.thickness ?? 0.12;

  walls.forEach((w, wi) => {
    const dx = w.b[0] - w.a[0], dy = w.b[1] - w.a[1];
    const at = (t) => [w.a[0] + dx * t, w.a[1] + dy * t];
    const cuts = byWall[wi]
      .map((op) => {
        const ta = projectOnSegment(op.a, w.a, w.b).t;
        const tb = projectOnSegment(op.b, w.a, w.b).t;
        return { t0: Math.max(0, Math.min(ta, tb)), t1: Math.min(1, Math.max(ta, tb)), op };
      })
      .sort((p, q) => p.t0 - q.t0);
    let cursor = 0;
    const push = (t0, t1, material, kind, thickness, extra) => {
      if (t1 - t0 < 1e-6) return;
      const a = at(t0), b = at(t1);
      out.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], material, kind, thickness, weight: 1, wallIndex: wi, ...extra });
    };
    for (const c of cuts) {
      if (c.t0 > cursor) push(cursor, c.t0, w.material, 'wall', thick(w.material, w.thickness));
      const op = c.op;
      const passable = op.type === 'opening' || (op.type === 'door' && op.state === 'open') || op.material === 'open';
      if (passable) push(Math.max(cursor, c.t0), c.t1, 'open', 'gap', 0, { openingType: op.type, openingId: op.id });
      else push(Math.max(cursor, c.t0), c.t1, op.material, op.type, thick(op.material, op.thickness), { openingId: op.id });
      cursor = Math.max(cursor, c.t1);
    }
    if (cursor < 1) push(cursor, 1, w.material, 'wall', thick(w.material, w.thickness));
  });

  for (const fx of level.fixtures || []) {
    const p = fx.polygon;
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length];
      out.push({ ax: a[0], ay: a[1], bx: b[0], by: b[1], material: fx.material, kind: 'fixture', thickness: 0, weight: 0.5, wallIndex: -1 });
    }
  }
  return out;
}

/** Levels sorted from the lowest to the highest. */
export function sortedLevels(plan) {
  return [...plan.levels].sort((a, b) => a.elevation - b.elevation);
}

/** Bounding box of every outline in the plan, grown by a margin (metres). */
export function planBounds(plan, margin = 0) {
  const pts = [];
  for (const level of plan.levels) {
    for (const p of level.outline || []) pts.push(p);
    for (const w of level.walls || []) pts.push(w.a, w.b);
  }
  const b = bounds(pts);
  return { minX: b.minX - margin, minY: b.minY - margin, maxX: b.maxX + margin, maxY: b.maxY + margin };
}

/** Which room of a level holds the point, or null. */
export function roomAt(level, x, y) {
  for (const room of level.rooms || []) if (pointInPolygon(x, y, room.polygon)) return room;
  return null;
}

/**
 * A regular grid over an area. Cell (i, j) has its centre at
 * (minX + (i + 0.5) * cell, minY + (j + 0.5) * cell).
 */
export function makeGrid(area, cell) {
  const nx = Math.ceil((area.maxX - area.minX) / cell);
  const ny = Math.ceil((area.maxY - area.minY) / cell);
  return { minX: area.minX, minY: area.minY, cell, nx, ny, maxX: area.minX + nx * cell, maxY: area.minY + ny * cell };
}
