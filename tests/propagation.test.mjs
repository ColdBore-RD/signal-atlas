import test from 'node:test';
import assert from 'node:assert/strict';
import { materials, boxHouse, testAp } from './helpers.mjs';
import { buildModelContext, traceLink, priorParams, predictRssi, makeModelGrid, traceApField, evaluateApField, rasterizeRooms } from '../src/core/propagation.js';
import { buildObstacles, segmentsCross, pointInPolygon, polygonArea, interiorPoint } from '../src/core/geometry.js';
import { calibrate, fitBand, traceObservations, solveLinear, residualAt, errorStats } from '../src/core/calibrate.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);

test('geometry: segments cross, polygons, interior point', () => {
  assert.equal(segmentsCross(0, 0, 2, 2, 0, 2, 2, 0), true);
  assert.equal(segmentsCross(0, 0, 1, 0, 0, 1, 1, 1), false, 'parallel lines do not cross');
  assert.equal(segmentsCross(0, 0, 1, 1, 2, 2, 3, 0), false);
  assert.equal(pointInPolygon(1, 1, [[0, 0], [2, 0], [2, 2], [0, 2]]), true);
  assert.equal(polygonArea([[0, 0], [4, 0], [4, 3], [0, 3]]), 12);
  const L = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
  const p = interiorPoint(L);
  assert.ok(pointInPolygon(p[0], p[1], L), 'interior point of an L-shaped room is inside it');
});

test('obstacles: an open doorway leaves a gap, a closed door and a window keep their own material', () => {
  const plan = boxHouse();
  const level = plan.levels[0];
  level.openings.push({ type: 'window', a: [2, 0], b: [3, 0], material: 'glass-lowe' });
  level.openings.push({ type: 'door', a: [7, 6], b: [8, 6], material: 'door-exterior', state: 'closed' });
  const obs = buildObstacles(level, materials.materials);
  const partition = obs.filter((o) => o.wallIndex === 4);
  assert.deepEqual(partition.map((o) => o.kind), ['wall', 'gap', 'wall']);
  assert.equal(partition[1].material, 'open');
  close(partition[0].by, 2.5, 1e-9);
  assert.ok(obs.some((o) => o.kind === 'window' && o.material === 'glass-lowe'));
  assert.ok(obs.some((o) => o.kind === 'door' && o.material === 'door-exterior'));
});

test('free space: with no wall on the path the model is the log-distance law', () => {
  const ctx = buildModelContext(boxHouse(), materials);
  const ap = testAp();
  for (const band of ['2.4', '5']) {
    const params = priorParams(ctx, band);
    const at4 = predictRssi(ctx, params, ap, { level: 'G', x: 2, y: 5 });   // 2 m away
    const at2 = predictRssi(ctx, params, ap, { level: 'G', x: 2, y: 4 });   // 1 m away
    close(at2, 20 - materials.pathLoss[band].pl0_db, 1e-6, `${band} GHz at 1 m`);
    close(at2 - at4, 10 * materials.pathLoss[band].n * Math.log10(2), 1e-6, `${band} GHz doubling distance`);
  }
});

test('walls: one drywall crossing costs exactly the table loss; the open doorway costs nothing', () => {
  const ctx = buildModelContext(boxHouse(), materials);
  const ap = testAp();
  const counts = new Float32Array(ctx.featureCount);
  const drywall = ctx.featureNames.indexOf('int-drywall');
  traceLink(ctx, ap.position, { level: 'G', x: 8, y: 5.5 }, counts);   // misses the doorway
  assert.equal(counts[drywall], 1);
  counts.fill(0);
  traceLink(ctx, ap.position, { level: 'G', x: 8, y: 3 }, counts);     // straight through the doorway
  assert.equal(counts.reduce((s, v) => s + v, 0), 0);
  const p24 = priorParams(ctx, '2.4'), p5 = priorParams(ctx, '5');
  const blocked = predictRssi(ctx, p24, ap, { level: 'G', x: 8, y: 5.5 });
  const sameDistanceOpen = 20 - p24.pl0 - 10 * p24.n * Math.log10(Math.hypot(6, 2.5));
  close(sameDistanceOpen - blocked, materials.materials['int-drywall'].loss_db['2.4'], 1e-6);
  // 5 GHz loses more than 2.4 GHz on the same blocked path
  const blocked5 = predictRssi(ctx, p5, ap, { level: 'G', x: 8, y: 5.5 });
  assert.ok(blocked5 < blocked - 6, '5 GHz must be weaker through a wall at the same place');
});

test('floors: a link to the level above crosses one floor and counts walls on both levels', () => {
  const ctx = buildModelContext(boxHouse({ door: false }), materials);
  const counts = new Float32Array(ctx.featureCount);
  const floor = ctx.featureNames.indexOf('floor-wood');
  const drywall = ctx.featureNames.indexOf('int-drywall');
  const d = traceLink(ctx, testAp().position, { level: 'U', x: 2, y: 3 }, counts);   // straight up
  close(d, 3, 1e-9);
  assert.equal(counts[floor], 1);
  assert.equal(counts[drywall], 0);
  counts.fill(0);
  traceLink(ctx, testAp().position, { level: 'U', x: 8, y: 3 }, counts);             // up and across the partition
  assert.equal(counts[floor], 1);
  assert.equal(counts[drywall], 1, 'the partition is crossed once, on whichever level the line meets it');
});

test('fixtures: a path through an appliance pays its loss once', () => {
  const plan = boxHouse();
  plan.levels[0].fixtures.push({ type: 'appliance', material: 'appliance-metal', polygon: [[3, 2.5], [4, 2.5], [4, 3.5], [3, 3.5]] });
  const ctx = buildModelContext(plan, materials);
  const counts = new Float32Array(ctx.featureCount);
  traceLink(ctx, testAp().position, { level: 'G', x: 4.8, y: 3 }, counts);
  assert.equal(counts[ctx.featureNames.indexOf('appliance-metal')], 1);
});

test('grid field: every cell equals the single-point prediction', () => {
  const plan = boxHouse();
  const ctx = buildModelContext(plan, materials);
  const grid = makeModelGrid(plan, 0.5, 1);
  const ap = testAp();
  const field = traceApField(ctx, ap, grid);
  const params = priorParams(ctx, '5');
  const out = evaluateApField(field, params, ap, new Float32Array(field.dist.length));
  const cells = grid.nx * grid.ny;
  for (const [li, i, j] of [[0, 3, 4], [1, 10, 6], [0, 17, 2]]) {
    const x = grid.minX + (i + 0.5) * grid.cell, y = grid.minY + (j + 0.5) * grid.cell;
    close(out[li * cells + j * grid.nx + i], predictRssi(ctx, params, ap, { level: ctx.levels[li].id, x, y }), 1e-3);
  }
  const rooms = rasterizeRooms(ctx, grid);
  const inside = rooms[0].filter((r) => r >= 0).length * grid.cell * grid.cell;
  close(inside, 60, 1.5, 'room cells cover the 60 m2 floor');
});

test('solveLinear solves a small system', () => {
  const x = solveLinear([[2, 1, 0], [1, 3, 1], [0, 1, 4]], [3, 5, 9]);
  close(2 * x[0] + x[1], 3, 1e-9); close(x[0] + 3 * x[1] + x[2], 5, 1e-9); close(x[1] + 4 * x[2], 9, 1e-9);
});

test('calibration recovers wall, floor and distance parameters from noise-free samples', () => {
  const plan = boxHouse({ door: false });
  const ctx = buildModelContext(plan, materials);
  const aps = [testAp(), testAp({ id: 'ap2', position: { level: 'U', x: 8.5, y: 1.5 } })];
  const truth = priorParams(ctx, '2.4');
  truth.n = 2.9;
  truth.loss[ctx.featureNames.indexOf('int-drywall')] = 6.5;   // assumption says 3
  truth.loss[ctx.featureNames.indexOf('floor-wood')] = 14;     // assumption says 9
  truth.apOffset = { ap1: 2, ap2: -3 };
  const observations = [];
  let k = 0;
  for (const level of ['G', 'U']) for (let x = 0.7; x < 10; x += 1.3) for (let y = 0.8; y < 6; y += 1.7) {
    const position = { level, x, y };
    for (const ap of aps) observations.push({ nodeId: `n${k}`, apId: ap.id, band: '2.4', rssi: predictRssi(ctx, truth, ap, position), position });
    k++;
  }
  const fit = fitBand(ctx, aps, '2.4', traceObservations(ctx, aps, observations), { offset: 1e-6, n: 1e-6, loss: 1e-6 }).params;
  close(fit.n, 2.9, 0.02, 'path-loss exponent');
  close(fit.loss[ctx.featureNames.indexOf('int-drywall')], 6.5, 0.05, 'drywall loss');
  close(fit.loss[ctx.featureNames.indexOf('floor-wood')], 14, 0.05, 'floor loss');
  close(fit.apOffset.ap1, 2, 0.05); close(fit.apOffset.ap2, -3, 0.05);
});

test('calibration with noise: held-out error is reported and beats the uncalibrated model', () => {
  const plan = boxHouse({ door: false });
  const ctx = buildModelContext(plan, materials);
  const aps = [testAp(), testAp({ id: 'ap2', position: { level: 'U', x: 8.5, y: 1.5 } })];
  const truth = priorParams(ctx, '2.4');
  truth.n = 2.8; truth.loss[ctx.featureNames.indexOf('int-drywall')] = 7; truth.loss[ctx.featureNames.indexOf('floor-wood')] = 15;
  let seed = 7;
  const noise = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return (seed / 2147483648 - 0.5) * 4; };
  const observations = [];
  let k = 0;
  for (const level of ['G', 'U']) for (let x = 0.7; x < 10; x += 1.9) for (let y = 0.8; y < 6; y += 2.1) {
    const position = { level, x, y };
    for (const ap of aps) observations.push({ nodeId: `n${k}`, apId: ap.id, band: '2.4', rssi: predictRssi(ctx, truth, ap, position) + noise(), position });
    k++;
  }
  const result = calibrate(ctx, aps, observations, ['2.4']);
  assert.ok(result.heldOut.modelOnly.count === observations.length);
  assert.ok(result.heldOut.modelOnly.median < result.heldOut.prior.median, `calibrated ${result.heldOut.modelOnly.median} dB must beat assumptions ${result.heldOut.prior.median} dB`);
  assert.ok(result.heldOut.modelOnly.median < 2.5, `median held-out error ${result.heldOut.modelOnly.median}`);
  assert.ok(result.heldOut.withResidual.p90 >= result.heldOut.withResidual.median);
});

test('calibration keeps the assumed loss for a material that no link crosses, and never goes negative', () => {
  const plan = boxHouse({ door: false });
  const ctx = buildModelContext(plan, materials);
  const aps = [testAp()];
  const obs = [1, 2, 3, 4].map((y, i) => ({ nodeId: `n${i}`, apId: 'ap1', band: '5', rssi: -40 - y, position: { level: 'G', x: 3 + i * 0.3, y } }));
  const fit = fitBand(ctx, aps, '5', traceObservations(ctx, aps, obs)).params;
  const concrete = ctx.featureNames.indexOf('concrete');
  close(fit.loss[concrete], materials.materials.concrete.loss_db['5'], 1e-6, 'concrete was never crossed');
  assert.ok(fit.loss.every((v) => v >= 0));
});

test('residual correction: equals the sensor error at the sensor and fades with distance', () => {
  const pts = [{ abs: [2, 2, 1], value: 6, nodeId: 'a' }];
  assert.ok(residualAt(2, 2, 1, pts) > 5.9);
  assert.ok(residualAt(4, 2, 1, pts) < residualAt(3, 2, 1, pts));
  assert.ok(Math.abs(residualAt(40, 2, 1, pts)) < 0.2);
  assert.equal(residualAt(2, 2, 1, pts, 'a'), 0, 'a held-out sensor is ignored');
  const stats = errorStats([1, -2, 3, -4, 10]);
  assert.equal(stats.median, 3); assert.equal(stats.max, 10);
});
