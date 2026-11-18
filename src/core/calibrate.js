// Fit the propagation model to measured samples, and correct what is left over.
//
// Step 1, least squares. For each band the unknowns are: one offset per access
// point (dB), the path-loss exponent n, and one loss per wall, fixture and floor
// material (dB). Every observation (a sensor at a known position that hears one
// BSSID) gives one linear equation. The fit is pulled gently toward the values
// in materials.json (ridge regression), so a material that no link crosses keeps
// its assumed value, and losses cannot go below zero.
//
// Step 2, residual. The difference between each sensor's reading and the fitted
// model is spread over the map with inverse-distance weighting. Far from every
// sensor the correction fades to zero.
//
// Step 3, honesty. Leave-one-sensor-out: fit without one sensor, predict it, and
// keep the error. The median and 90th percentile of those errors go on screen.
//
// Pure functions: browser and Node.

import { traceLink, priorParams, linkRssi, absoluteZ } from './propagation.js';

export const DEFAULT_RIDGE = { offset: 0.35, n: 3.0, loss: 0.5 };
export const N_LIMITS = [1.6, 4.5];
const RESIDUAL_RANGE_M = 5;       // the correction falls to half strength this far from a lone sensor
const VERTICAL_STRETCH = 2;       // a metre of height counts double: sensors on other floors say less

/** Solve A x = b for a small dense system (Gaussian elimination with pivoting). */
export function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('calibration: the equations are singular');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/**
 * Trace every observation once. An observation is
 * { nodeId, apId, band, rssi, position: { level, x, y, z? } }.
 * Adds .d (metres), .counts (per feature) and .abs (x, y, z in metres).
 */
export function traceObservations(ctx, aps, observations) {
  const apById = new Map(aps.map((a) => [a.id, a]));
  const out = [];
  for (const o of observations) {
    const ap = apById.get(o.apId);
    if (!ap || !Number.isFinite(o.rssi)) continue;
    const counts = new Float32Array(ctx.featureCount);
    const d = traceLink(ctx, ap.position, o.position, counts);
    out.push({ ...o, ap, d, counts, abs: [o.position.x, o.position.y, absoluteZ(ctx, o.position)] });
  }
  return out;
}

/** Ridge least-squares fit for one band. traced = output of traceObservations for that band. */
export function fitBand(ctx, aps, band, traced, ridge = DEFAULT_RIDGE) {
  const prior = priorParams(ctx, band);
  const rows = traced.filter((o) => o.band === band);
  const apIds = aps.map((a) => a.id);
  const A = apIds.length, F = ctx.featureCount, U = A + 1 + F;
  const theta0 = [...apIds.map(() => 0), prior.n, ...prior.loss];
  const lambda = [...apIds.map(() => ridge.offset), ridge.n, ...Array.from(prior.loss, () => ridge.loss)];
  const used = new Float64Array(F);
  for (const o of rows) for (let f = 0; f < F; f++) used[f] += o.counts[f];

  // y = rssi - tx + pl0 = offset_ap - n * 10 log10(d) - sum(count_f * loss_f)
  const design = rows.map((o) => {
    const x = new Float64Array(U);
    x[apIds.indexOf(o.apId)] = 1;
    x[A] = -10 * Math.log10(o.d);
    for (let f = 0; f < F; f++) x[A + 1 + f] = -o.counts[f];
    return { x, y: o.rssi - o.ap.tx_dbm[band] + prior.pl0 };
  });

  const fixed = new Map(); // unknown index -> value pinned by a bound
  let theta = theta0.slice();
  for (let pass = 0; pass < U + 2; pass++) {
    const N = Array.from({ length: U }, () => new Float64Array(U));
    const rhs = new Float64Array(U);
    for (const { x, y } of design) {
      for (let i = 0; i < U; i++) {
        if (x[i] === 0) continue;
        rhs[i] += x[i] * y;
        for (let j = 0; j < U; j++) N[i][j] += x[i] * x[j];
      }
    }
    for (let i = 0; i < U; i++) {
      const pin = fixed.has(i);
      const w = pin ? 1e9 : lambda[i];
      N[i][i] += w;
      rhs[i] += w * (pin ? fixed.get(i) : theta0[i]);
    }
    theta = solveLinear(N.map((r) => Array.from(r)), Array.from(rhs));
    let changed = false;
    if (theta[A] < N_LIMITS[0] && !fixed.has(A)) { fixed.set(A, N_LIMITS[0]); changed = true; }
    if (theta[A] > N_LIMITS[1] && !fixed.has(A)) { fixed.set(A, N_LIMITS[1]); changed = true; }
    for (let f = 0; f < F; f++) {
      if (theta[A + 1 + f] < 0 && !fixed.has(A + 1 + f)) { fixed.set(A + 1 + f, 0); changed = true; }
    }
    if (!changed) break;
  }

  const params = {
    band, pl0: prior.pl0, n: theta[A],
    loss: Float64Array.from(theta.slice(A + 1), (v) => Math.max(0, v)),
    apOffset: Object.fromEntries(apIds.map((id, i) => [id, theta[i]])),
  };
  return { params, prior, observations: rows.length, crossings: used };
}

/** Model prediction for one traced observation. */
export function predictTraced(params, o) {
  return linkRssi(params, o.ap.tx_dbm[params.band], o.apId, o.d, o.counts);
}

/** Weight of one residual point as seen from (x, y, z). */
export function residualWeight(x, y, z, p) {
  const dz = (z - p.abs[2]) * VERTICAL_STRETCH;
  return 1 / ((x - p.abs[0]) ** 2 + (y - p.abs[1]) ** 2 + dz * dz + 0.25);
}

/** Turn the sum of weights and the sum of weight * value into a correction in dB. */
export function residualFromSums(sumW, sumWV) {
  return sumWV / (sumW + 1 / (RESIDUAL_RANGE_M * RESIDUAL_RANGE_M));
}

/**
 * Inverse-distance weighted residual at a point.
 * points = [{ abs: [x, y, z], value }]. Returns dB to add to the model.
 */
export function residualAt(x, y, z, points, skipNodeId = null) {
  let sw = 0, swv = 0;
  for (const p of points) {
    if (skipNodeId !== null && p.nodeId === skipNodeId) continue;
    const w = residualWeight(x, y, z, p);
    sw += w; swv += w * p.value;
  }
  return residualFromSums(sw, swv);
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function errorStats(errors) {
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  return { count: abs.length, median: quantile(abs, 0.5), p90: quantile(abs, 0.9), max: abs.length ? abs[abs.length - 1] : NaN };
}

/**
 * Full calibration for both bands, with the held-out error.
 * observations: [{ nodeId, apId, band, rssi, position }], one per sensor and BSSID
 * (use a robust average over time, for example the median of the day).
 * Returns { params: { '2.4', '5' }, fit: {...}, heldOut: { withResidual, modelOnly, prior }, traced }.
 */
export function calibrate(ctx, aps, observations, bands = ['2.4', '5'], ridge = DEFAULT_RIDGE) {
  const traced = traceObservations(ctx, aps, observations);
  const nodeIds = [...new Set(traced.map((o) => o.nodeId))];
  const params = {}, fit = {};
  const errResidual = [], errModel = [], errPrior = [];
  for (const band of bands) {
    const rows = traced.filter((o) => o.band === band);
    const full = fitBand(ctx, aps, band, rows, ridge);
    params[band] = full.params;
    fit[band] = { observations: full.observations, crossings: full.crossings, prior: full.prior };
    if (nodeIds.length < 3) continue;
    for (const held of nodeIds) {
      const train = rows.filter((o) => o.nodeId !== held);
      const test = rows.filter((o) => o.nodeId === held);
      if (!test.length || train.length < 4) continue;
      const part = fitBand(ctx, aps, band, train, ridge).params;
      for (const t of test) {
        const base = predictTraced(part, t);
        const pts = train.filter((o) => o.apId === t.apId).map((o) => ({ abs: o.abs, nodeId: o.nodeId, value: o.rssi - predictTraced(part, o) }));
        errModel.push(base - t.rssi);
        errResidual.push(base + residualAt(t.abs[0], t.abs[1], t.abs[2], pts) - t.rssi);
        errPrior.push(predictTraced(full.prior, t) - t.rssi);
      }
    }
  }
  return {
    params, fit, traced,
    heldOut: { withResidual: errorStats(errResidual), modelOnly: errorStats(errModel), prior: errorStats(errPrior) },
    sensors: nodeIds.length,
  };
}
