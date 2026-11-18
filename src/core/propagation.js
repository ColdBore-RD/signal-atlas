// Multi-wall radio propagation model.
//
//   RSSI = tx power + AP offset
//          - pl0(band) - 10 * n(band) * log10(distance)
//          - sum over wall and fixture crossings of loss(material, band)
//          - sum over floors crossed of loss(floor material, band)
//
// The straight line from the access point to the receiver is followed in 3D.
// For each level the line passes through, the walls of that level are counted
// along the matching part of the line.
//
// This module only does geometry and arithmetic. Fitting the losses to
// measurements is in calibrate.js. Pure functions: browser and Node.

import { buildObstacles, sortedLevels, segmentsCross, makeGrid, planBounds, pointInPolygon } from './geometry.js';

export const BANDS = ['2.4', '5'];
const MIN_DISTANCE_M = 0.5;

/**
 * Prepare a floor plan for fast link tracing.
 * features = every wall or fixture material in use, then every floor material in use.
 */
export function buildModelContext(plan, materialsFile) {
  const materials = materialsFile.materials;
  const floors = materialsFile.floors;
  const defaultFloor = materialsFile.defaults?.floor_material || Object.keys(floors)[0];
  const deviceHeight = materialsFile.defaults?.device_height_m ?? 1.0;
  const levels = sortedLevels(plan);
  const featureNames = [];
  const featureKind = [];
  const index = new Map();
  const featureOf = (name, kind) => {
    const key = `${kind}:${name}`;
    if (!index.has(key)) { index.set(key, featureNames.length); featureNames.push(name); featureKind.push(kind); }
    return index.get(key);
  };

  const prepared = levels.map((level, li) => {
    const obstacles = buildObstacles(level, materials).filter((o) => o.material !== 'open');
    const n = obstacles.length;
    const seg = new Float64Array(n * 4);
    const feat = new Int16Array(n);
    const weight = new Float32Array(n);
    obstacles.forEach((o, i) => {
      seg[i * 4] = o.ax; seg[i * 4 + 1] = o.ay; seg[i * 4 + 2] = o.bx; seg[i * 4 + 3] = o.by;
      feat[i] = featureOf(o.material, 'wall');
      weight[i] = o.weight;
    });
    return {
      id: level.id, name: level.name, index: li, level,
      z0: level.elevation,
      zTop: li + 1 < levels.length ? levels[li + 1].elevation : Infinity,
      zBottom: li === 0 ? -Infinity : level.elevation,
      n, seg, feat, weight,
      floorFeature: -1,
    };
  });
  // The floor structure under level i (i >= 1) is crossed when a link goes between level i-1 and level i.
  for (let i = 1; i < prepared.length; i++) {
    prepared[i].floorFeature = featureOf(prepared[i].level.floorMaterial || defaultFloor, 'floor');
  }

  const byId = new Map(prepared.map((l) => [l.id, l]));
  const priorLoss = (band) => Float64Array.from(featureNames, (name, i) => {
    const table = featureKind[i] === 'floor' ? floors : materials;
    return table[name]?.loss_db?.[band] ?? 0;
  });
  return {
    levels: prepared, byId, featureNames, featureKind, featureCount: featureNames.length,
    deviceHeight, pathLoss: materialsFile.pathLoss, priorLoss,
  };
}

/** Height above the main floor of a position { level, x, y, z? } (z = metres above its own floor). */
export function absoluteZ(ctx, pos) {
  const level = ctx.byId.get(pos.level);
  if (!level) throw new Error(`position refers to unknown level "${pos.level}"`);
  return level.z0 + (pos.z ?? ctx.deviceHeight);
}

function countCrossings(level, x1, y1, x2, y2, counts) {
  const { seg, feat, weight, n } = level;
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    if (segmentsCross(x1, y1, x2, y2, seg[k], seg[k + 1], seg[k + 2], seg[k + 3])) counts[feat[i]] += weight[i];
  }
}

/**
 * Follow the straight line from tx to rx. Adds the crossings to counts (one slot per
 * feature; the caller clears it) and returns the 3D distance in metres.
 */
export function traceLink(ctx, tx, rx, counts) {
  const zt = absoluteZ(ctx, tx), zr = absoluteZ(ctx, rx);
  const a = ctx.byId.get(tx.level), b = ctx.byId.get(rx.level);
  const dx = rx.x - tx.x, dy = rx.y - tx.y, dz = zr - zt;
  const d = Math.max(MIN_DISTANCE_M, Math.hypot(dx, dy, dz));
  if (a.index === b.index || Math.abs(dz) < 1e-6) {
    countCrossings(a, tx.x, tx.y, rx.x, rx.y, counts);
    return d;
  }
  const lo = Math.min(a.index, b.index), hi = Math.max(a.index, b.index);
  for (let i = lo; i <= hi; i++) {
    const level = ctx.levels[i];
    // part of the line (t from 0 at tx to 1 at rx) that lies in this level's height range
    let t0 = (Math.max(level.zBottom, Math.min(zt, zr)) - zt) / dz;
    let t1 = (Math.min(level.zTop, Math.max(zt, zr)) - zt) / dz;
    if (t0 > t1) { const s = t0; t0 = t1; t1 = s; }
    t0 = Math.max(0, t0); t1 = Math.min(1, t1);
    if (t1 > t0) countCrossings(level, tx.x + dx * t0, tx.y + dy * t0, tx.x + dx * t1, tx.y + dy * t1, counts);
    if (i > lo && level.floorFeature >= 0) counts[level.floorFeature] += 1;
  }
  return d;
}

/** Model parameters for one band, starting from the assumptions in materials.json. */
export function priorParams(ctx, band) {
  const pl = ctx.pathLoss[band];
  return { band, pl0: pl.pl0_db, n: pl.n, loss: ctx.priorLoss(band), apOffset: {} };
}

/** RSSI in dBm for one traced link. */
export function linkRssi(params, txDbm, apId, d, counts, offset = 0) {
  let loss = 0;
  for (let f = 0; f < params.loss.length; f++) loss += counts[offset + f] * params.loss[f];
  return txDbm + (params.apOffset[apId] || 0) - params.pl0 - 10 * params.n * Math.log10(d) - loss;
}

/** Convenience for single points: trace and evaluate. */
export function predictRssi(ctx, params, ap, rx) {
  const counts = new Float32Array(ctx.featureCount);
  const d = traceLink(ctx, ap.position, rx, counts);
  return linkRssi(params, ap.tx_dbm[params.band], ap.id, d, counts);
}

/** The model grid: the same x-y grid for every level, covering the house plus a margin. */
export function makeModelGrid(plan, cell = 0.25, margin = 1.5) {
  return makeGrid(planBounds(plan, margin), cell);
}

/**
 * Trace one access point to every cell of every level.
 * Returns { dist, counts } where dist[level * cells + cell] is metres and
 * counts[(level * cells + cell) * F + f] is the crossing count of feature f.
 * The result does not depend on the band, so it is reused for both bands
 * and for calibration.
 */
export function traceApField(ctx, ap, grid) {
  const cells = grid.nx * grid.ny;
  const F = ctx.featureCount;
  const distOut = new Float32Array(ctx.levels.length * cells);
  const counts = new Float32Array(ctx.levels.length * cells * F);
  const tmp = new Float32Array(F);
  const rx = { level: '', x: 0, y: 0 };
  for (const level of ctx.levels) {
    rx.level = level.id;
    for (let j = 0; j < grid.ny; j++) {
      rx.y = grid.minY + (j + 0.5) * grid.cell;
      for (let i = 0; i < grid.nx; i++) {
        rx.x = grid.minX + (i + 0.5) * grid.cell;
        tmp.fill(0);
        const k = level.index * cells + j * grid.nx + i;
        distOut[k] = traceLink(ctx, ap.position, rx, tmp);
        counts.set(tmp, k * F);
      }
    }
  }
  return { dist: distOut, counts };
}

/** Fill out[] with the RSSI of one access point for every cell of every level. */
export function evaluateApField(field, params, ap, out) {
  const F = params.loss.length;
  const tx = ap.tx_dbm[params.band];
  for (let k = 0; k < field.dist.length; k++) out[k] = linkRssi(params, tx, ap.id, field.dist[k], field.counts, k * F);
  return out;
}

/** For each level, the room index of every grid cell (-1 = not in a room). */
export function rasterizeRooms(ctx, grid) {
  const cells = grid.nx * grid.ny;
  return ctx.levels.map((level) => {
    const rooms = level.level.rooms || [];
    const out = new Int16Array(cells).fill(-1);
    for (let j = 0; j < grid.ny; j++) {
      const y = grid.minY + (j + 0.5) * grid.cell;
      for (let i = 0; i < grid.nx; i++) {
        const x = grid.minX + (i + 0.5) * grid.cell;
        for (let r = 0; r < rooms.length; r++) {
          if (pointInPolygon(x, y, rooms[r].polygon)) { out[j * grid.nx + i] = r; break; }
        }
      }
    }
    return out;
  });
}
