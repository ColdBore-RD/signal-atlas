// Headless tests of the GPU wave solver. They run in a browser page
// (tests/solver/index.html) because the solver needs WebGL2.
// Run them with:  node tools/verify/solver-tests.mjs

import { WaveSolver } from '../../src/sim/wave-solver.js';
import { COURANT, SPONGE_CELLS, airDamping, slabMedium, beaconSchedule } from '../../src/sim/rasterize.js';

const AIR_DAMPING = airDamping(0.06);

const AIR = COURANT * COURANT;

function makeGl() {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) throw new Error('no WebGL2 context');
  return gl;
}

/** Medium: air everywhere. Options add a sponge at the edge and the small air damping. */
function airMedium(nx, ny, levels = 1, { sponge = false, airDamping = 0 } = {}) {
  const m = new Float32Array(nx * ny * levels * 4);
  for (let l = 0; l < levels; l++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = ((l * ny + j) * nx + i) * 4;
        const edge = Math.min(i, j, nx - 1 - i, ny - 1 - j);
        m[k] = AIR;
        m[k + 1] = airDamping + (sponge && edge < SPONGE_CELLS ? 0.3 * ((SPONGE_CELLS - edge) / SPONGE_CELLS) ** 2 : 0);
      }
    }
  }
  return m;
}

function gaussian(nx, ny, levels, cx, cy, sigma, level = 0) {
  const u = new Float32Array(nx * ny * levels);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    u[(level * ny + j) * nx + i] = Math.exp(-((i - cx) ** 2 + (j - cy) ** 2) / (2 * sigma * sigma));
  }
  return u;
}

const maxAbs = (a) => { let m = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (!(v <= m)) m = v; } return m; };
const allFinite = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

// ---- 1. stability ---------------------------------------------------------------
function testStability(gl) {
  const nx = 192, ny = 160;
  const solver = new WaveSolver(gl, { nx, ny, levels: 1 });
  const m = airMedium(nx, ny, 1, { sponge: true, airDamping: AIR_DAMPING });
  // a concrete box with a drywall partition and a doorway, driven by a continuous source inside
  const concrete = slabMedium({ reflection: 0.65, loss_db: { 2.4: 15 } }, '2.4', 3);
  const drywall = slabMedium({ reflection: 0.2, loss_db: { 2.4: 3 } }, '2.4', 2);
  const put = (i, j, mat) => { const k = (j * nx + i) * 4; m[k] = mat.c2; m[k + 1] += mat.damping; };
  for (let i = 30; i < 160; i++) for (let t = 0; t < 3; t++) { put(i, 30 + t, concrete); put(i, 127 + t, concrete); }
  for (let j = 30; j < 130; j++) for (let t = 0; t < 3; t++) { put(30 + t, j, concrete); put(157 + t, j, concrete); }
  for (let j = 33; j < 127; j++) if (j < 70 || j > 84) { put(95, j, drywall); put(96, j, drywall); }
  solver.setMedium(m);
  solver.setParams({ omegaDt: 2 * Math.PI * COURANT / 20, coupling: 0.15, envelopeRate: 0.01, sourceGain: 0.25 });
  solver.setSources([{ x: 60, y: 80, level: 0, amp: 1, phase: 0, sigma: 1.6 }]);
  const peaks = [];
  for (let block = 0; block < 10; block++) {
    let peak = 0;
    for (let s = 0; s < 10; s++) { solver.step(100); peak = Math.max(peak, maxAbs(solver.readState().u)); }
    peaks.push(peak);
  }
  const state = solver.readState();
  const finite = allFinite(state.u) && allFinite(state.env);
  const settled = peaks[9] <= peaks[4] * 1.05; // no slow growth between step 5000 and step 10000
  solver.dispose();
  return {
    name: 'stays stable for 10 000 steps (driven room with concrete and drywall)',
    pass: finite && settled && peaks[9] < 50,
    detail: `steps ${solver.stepCount}, all values finite: ${finite}, peak |u| per 1000 steps: ${peaks.map((p) => p.toFixed(3)).join(' ')}`,
  };
}

// ---- 2. circular wavefront ------------------------------------------------------
function testCircular(gl) {
  const n = 320, steps = 200;
  const solver = new WaveSolver(gl, { nx: n, ny: n, levels: 1 });
  solver.setMedium(airMedium(n, n, 1, { sponge: true }));
  solver.setSources([]);
  const u0 = gaussian(n, n, 1, n / 2 - 0.5, n / 2 - 0.5, 4);
  solver.setState(u0, u0);
  solver.step(steps);
  const { u } = solver.readState();
  const expected = COURANT * steps;
  const radii = [];
  for (let a = 0; a < 32; a++) {
    const ang = (a / 32) * Math.PI * 2;
    let best = 0, bestR = 0;
    for (let r = expected - 20; r <= expected + 20; r += 0.25) {
      const x = n / 2 - 0.5 + r * Math.cos(ang), y = n / 2 - 0.5 + r * Math.sin(ang);
      const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
      const v = u[j * n + i] * (1 - fx) * (1 - fy) + u[j * n + i + 1] * fx * (1 - fy) + u[(j + 1) * n + i] * (1 - fx) * fy + u[(j + 1) * n + i + 1] * fx * fy;
      if (v > best) { best = v; bestR = r; }
    }
    radii.push(bestR);
  }
  const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
  const spread = Math.max(...radii) - Math.min(...radii);
  solver.dispose();
  return {
    name: 'a point source in an empty room gives a circular wavefront',
    pass: Math.abs(mean - expected) < 3 && spread < 0.025 * expected,
    detail: `after ${steps} steps the crest is at radius ${mean.toFixed(2)} cells (expected ${expected} = Courant ${COURANT} x steps); `
      + `difference between the 32 directions: ${spread.toFixed(2)} cells (${((100 * spread) / expected).toFixed(1)} %)`,
  };
}

// ---- 3. reflection coefficient --------------------------------------------------
function planePulse(nx, ny, x0, sigma) {
  const u = new Float32Array(nx * ny), uPrev = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    u[j * nx + i] = Math.exp(-((i - x0) ** 2) / (2 * sigma * sigma));
    uPrev[j * nx + i] = Math.exp(-((i - (x0 - COURANT)) ** 2) / (2 * sigma * sigma)); // one step earlier, moving toward +x
  }
  return { u, uPrev };
}

function reflectionRun(gl, reflection, sigma) {
  const nx = 420, ny = 640, wallX = 230, probeX = 170, x0 = 110;
  const solver = new WaveSolver(gl, { nx, ny, levels: 1 });
  const m = airMedium(nx, ny, 1, { sponge: true });
  const wall = slabMedium({ reflection, loss_db: { 2.4: 0 } }, '2.4', 1);
  for (let j = 0; j < ny; j++) for (let i = wallX; i < nx; i++) m[(j * nx + i) * 4] = wall.c2;
  solver.setMedium(m);
  solver.setSources([]);
  const p = planePulse(nx, ny, x0, sigma);
  solver.setState(p.u, p.uPrev);
  let incident = 0, reflected = 0;
  const turn = (wallX - x0) / COURANT; // step at which the pulse centre reaches the wall
  for (let s = 0; s < turn * 2 + 40; s++) {
    solver.step(1);
    const v = solver.readCell(probeX, ny / 2);
    if (s < turn) { if (Math.abs(v) > Math.abs(incident)) incident = v; }
    else if (Math.abs(v) > Math.abs(reflected)) reflected = v;
  }
  solver.dispose();
  return reflected / incident;
}

function testReflection(gl) {
  const cases = [[0.2, 12], [0.35, 12], [0.5, 14], [0.65, 18]];
  const rows = cases.map(([r, sigma]) => ({ set: r, measured: reflectionRun(gl, r, sigma) }));
  const worst = Math.max(...rows.map((x) => Math.abs(Math.abs(x.measured) - x.set)));
  return {
    name: 'a thick wall reflects with the coefficient that was set',
    pass: worst < 0.03 && rows.every((x) => x.measured < 0),
    detail: rows.map((x) => `set ${x.set.toFixed(2)} -> measured ${Math.abs(x.measured).toFixed(3)}`).join('; ')
      + `; worst error ${worst.toFixed(3)}. The reflected pulse is inverted, as expected for a slower medium.`,
  };
}

// ---- 4. energy ------------------------------------------------------------------
function testEnergyConserved(gl) {
  const n = 160;
  const solver = new WaveSolver(gl, { nx: n, ny: n, levels: 1 });
  solver.setMedium(airMedium(n, n, 1));
  solver.setSources([]);
  const u0 = gaussian(n, n, 1, 70, 90, 5);
  solver.setState(u0, u0);
  solver.step(1);
  const e0 = solver.energy();
  let lo = e0, hi = e0;
  for (let k = 0; k < 20; k++) { solver.step(150); const e = solver.energy(); lo = Math.min(lo, e); hi = Math.max(hi, e); }
  solver.dispose();
  const drift = Math.max(hi - e0, e0 - lo) / e0;
  return {
    name: 'energy is conserved in a closed room without loss',
    pass: drift < 0.005,
    detail: `energy over 3000 steps stays within ${(drift * 100).toFixed(3)} % of its start value (${e0.toFixed(3)})`,
  };
}

function testEnergyDecays(gl) {
  const nx = 192, ny = 160;
  const solver = new WaveSolver(gl, { nx, ny, levels: 1 });
  const m = airMedium(nx, ny, 1, { sponge: true, airDamping: AIR_DAMPING });
  const brick = slabMedium({ reflection: 0.5, loss_db: { 2.4: 10 } }, '2.4', 4);
  for (let j = 40; j < 120; j++) for (let t = 0; t < 4; t++) { const k = (j * nx + 110 + t) * 4; m[k] = brick.c2; m[k + 1] += brick.damping; }
  solver.setMedium(m);
  solver.setParams({ omegaDt: 2 * Math.PI * COURANT / 16, sourceGain: 0.25 });
  solver.setSources([{ x: 70, y: 80, level: 0, amp: 1, phase: 0, sigma: 1.6 }]);
  solver.step(600);               // drive
  solver.setSources([]);          // then switch the source off
  solver.step(2);
  const energies = [solver.energy()];
  for (let k = 0; k < 30; k++) { solver.step(50); energies.push(solver.energy()); }
  solver.dispose();
  let worstRise = 0;
  for (let i = 1; i < energies.length; i++) worstRise = Math.max(worstRise, (energies[i] - energies[i - 1]) / energies[0]);
  return {
    name: 'total energy does not grow once the source is off (walls, sponge and air loss on)',
    pass: worstRise <= 1e-4 && energies[energies.length - 1] < energies[0] * 0.5,
    detail: `energy fell from ${energies[0].toFixed(2)} to ${energies[energies.length - 1].toFixed(4)} in 1500 steps; largest rise between two checks: ${(worstRise * 100).toFixed(4)} % of the start value`,
  };
}

// ---- 5. walls: transmission ordering ---------------------------------------------
function transmissionRun(gl, material, band, cells) {
  const nx = 420, ny = 640, wallX = 230, probeX = 290, x0 = 110, sigma = 12;
  const solver = new WaveSolver(gl, { nx, ny, levels: 1 });
  const m = airMedium(nx, ny, 1, { sponge: true });
  const wall = slabMedium(material, band, cells);
  for (let j = 0; j < ny; j++) for (let i = wallX; i < wallX + cells; i++) { const k = (j * nx + i) * 4; m[k] = wall.c2; m[k + 1] += wall.damping; }
  solver.setMedium(m);
  solver.setSources([]);
  const p = planePulse(nx, ny, x0, sigma);
  solver.setState(p.u, p.uPrev);
  let peak = 0;
  for (let s = 0; s < 480; s++) { solver.step(1); peak = Math.max(peak, Math.abs(solver.readCell(probeX, ny / 2))); }
  solver.dispose();
  return -20 * Math.log10(peak);
}

function testTransmission(gl) {
  const drywall = { reflection: 0.2, loss_db: { 2.4: 3, 5: 4 } };
  const concrete = { reflection: 0.65, loss_db: { 2.4: 15, 5: 23 } };
  const brick = { reflection: 0.5, loss_db: { 2.4: 10, 5: 15 } };
  const rows = [
    ['drywall 2.4', drywall, '2.4', 2], ['drywall 5', drywall, '5', 2],
    ['brick 2.4', brick, '2.4', 4], ['brick 5', brick, '5', 4],
    ['concrete 2.4', concrete, '2.4', 3], ['concrete 5', concrete, '5', 3],
  ].map(([label, mat, band, cells]) => ({ label, target: mat.loss_db[band], measured: transmissionRun(gl, mat, band, cells) }));
  const by = Object.fromEntries(rows.map((r) => [r.label, r.measured]));
  const ordered = by['drywall 5'] > by['drywall 2.4'] && by['brick 5'] > by['brick 2.4'] && by['concrete 5'] > by['concrete 2.4']
    && by['concrete 2.4'] > by['brick 2.4'] && by['brick 2.4'] > by['drywall 2.4'];
  const worst = Math.max(...rows.map((r) => Math.abs(r.measured - r.target)));
  return {
    name: 'walls pass less at 5 GHz than at 2.4 GHz, and concrete passes less than brick and drywall',
    pass: ordered && worst < 6,
    detail: rows.map((r) => `${r.label}: table ${r.target} dB, wave ${r.measured.toFixed(1)} dB`).join('; ') + `; largest gap ${worst.toFixed(1)} dB`,
  };
}

// ---- 6. doorway -----------------------------------------------------------------
function testDoorway(gl) {
  const nx = 240, ny = 200;
  const run = (withDoor) => {
    const solver = new WaveSolver(gl, { nx, ny, levels: 1 });
    const m = airMedium(nx, ny, 1, { sponge: true, airDamping: AIR_DAMPING });
    const wall = slabMedium({ reflection: 0.65, loss_db: { 2.4: 15 } }, '2.4', 3);
    for (let j = 0; j < ny; j++) {
      if (withDoor && j >= 92 && j < 108) continue;
      for (let t = 0; t < 3; t++) { const k = (j * nx + 120 + t) * 4; m[k] = wall.c2; m[k + 1] += wall.damping; }
    }
    solver.setMedium(m);
    solver.setParams({ omegaDt: 2 * Math.PI * COURANT / 20, envelopeRate: 0.02, sourceGain: 0.25 });
    solver.setSources([{ x: 70, y: 100, level: 0, amp: 1, phase: 0, sigma: 1.6 }]);
    solver.step(900);
    const { env } = solver.readState();
    let sum = 0;
    for (let j = 90; j < 110; j++) for (let i = 150; i < 170; i++) sum += env[j * nx + i];
    solver.dispose();
    return sum;
  };
  const open = run(true), closed = run(false);
  const gain = 10 * Math.log10(open / closed);
  return {
    name: 'a doorway lets a beam through a concrete wall',
    pass: gain > 6,
    detail: `average wave power behind the doorway is ${gain.toFixed(1)} dB above the same spot behind a solid wall`,
  };
}

// ---- 7. stair coupling ----------------------------------------------------------
function testStairs(gl) {
  const nx = 160, ny = 120;
  const run = (withStairs) => {
    const solver = new WaveSolver(gl, { nx, ny, levels: 2 });
    const m = airMedium(nx, ny, 2, { sponge: true });
    if (withStairs) for (let j = 50; j < 70; j++) for (let i = 100; i < 120; i++) { m[(j * nx + i) * 4 + 2] = 1; m[((ny + j) * nx + i) * 4 + 3] = 1; }
    solver.setMedium(m);
    solver.setParams({ omegaDt: 2 * Math.PI * COURANT / 20, coupling: 0.15, envelopeRate: 0.02, sourceGain: 0.25 });
    solver.setSources([{ x: 50, y: 60, level: 0, amp: 1, phase: 0, sigma: 1.6 }]);
    solver.step(700);
    const { env } = solver.readState();
    let lower = 0, upper = 0, upperAtStairs = 0, upperFar = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      lower += env[j * nx + i];
      const v = env[(ny + j) * nx + i];
      upper += v;
      if (i >= 100 && i < 120 && j >= 50 && j < 70) upperAtStairs += v / 400;
      if (i >= 30 && i < 50 && j >= 20 && j < 40) upperFar += v / 400;
    }
    solver.dispose();
    return { lower, upper, upperAtStairs, upperFar };
  };
  const a = run(true), b = run(false);
  return {
    name: 'a stair opening couples one level to the next, and nothing else does',
    pass: b.upper === 0 && a.upper > 0 && a.upperAtStairs > 4 * a.upperFar,
    detail: `without stairs the upper level stays at exactly ${b.upper}; with stairs it holds ${((100 * a.upper) / a.lower).toFixed(1)} % of the lower level's wave power, strongest at the opening`,
  };
}

function testEnergyCoupled(gl) {
  const nx = 120, ny = 100;
  const solver = new WaveSolver(gl, { nx, ny, levels: 2 });
  const m = airMedium(nx, ny, 2);
  for (let j = 40; j < 60; j++) for (let i = 70; i < 90; i++) { m[(j * nx + i) * 4 + 2] = 1; m[((ny + j) * nx + i) * 4 + 3] = 1; }
  solver.setMedium(m);
  solver.setParams({ coupling: 0.15 });
  solver.setSources([]);
  const u0 = gaussian(nx, ny, 2, 60, 50, 5, 0);
  solver.setState(u0, u0);
  solver.step(1);
  const e0 = solver.energy();
  let worst = 0;
  for (let k = 0; k < 12; k++) { solver.step(200); worst = Math.max(worst, Math.abs(solver.energy() - e0) / e0); }
  solver.dispose();
  return {
    name: 'energy is conserved across two levels joined by a stair opening',
    pass: worst < 0.005,
    detail: `energy over 2400 steps stays within ${(worst * 100).toFixed(3)} % of its start value`,
  };
}

// ---- 8. beacon pulses -----------------------------------------------------------
function testBeaconPulse(gl) {
  const nx = 260, ny = 200;
  const solver = new WaveSolver(gl, { nx, ny, levels: 1 });
  solver.setMedium(airMedium(nx, ny, 1, { sponge: true, airDamping: AIR_DAMPING }));
  const perPeriod = 20;                                  // time steps of one wave period
  solver.setParams({ omegaDt: (2 * Math.PI) / perPeriod, envelopeRate: 0.01, sourceGain: 0.6 });
  // three radios on one channel and one on another, as beaconSchedule() lays them out
  const aps = [{ id: 'a', channel: { 2.4: 6 } }, { id: 'b', channel: { 2.4: 6 } }, { id: 'c', channel: { 2.4: 6 } }, { id: 'd', channel: { 2.4: 1 } }];
  const period = 240, length = 2 * perPeriod;
  const schedule = beaconSchedule(aps, '2.4', period, length);
  const spots = [[60, 60], [200, 60], [130, 150], [130, 100]];
  solver.setSources(aps.map((ap, i) => ({ x: spots[i][0], y: spots[i][1], level: 0, amp: 1, sigma: 1.6, pulse: schedule.get(ap.id) })));
  // (a) radios that share a channel never send at the same time; (b) each sends once per interval
  let overlap = 0;
  const sends = [0, 0, 0, 0], was = [false, false, false, false];
  let sumU = 0, peakU = 0;
  for (let step = 0; step < 3 * period; step++) {
    solver.step(1);
    const on = aps.map((_, i) => solver.srcData[i * 4 + 2] > 1e-6);
    if ((on[0] ? 1 : 0) + (on[1] ? 1 : 0) + (on[2] ? 1 : 0) > 1) overlap++;
    on.forEach((v, i) => { if (v && !was[i]) sends[i]++; was[i] = v; });
  }
  // (c) a pulse pushes the field up as much as it pulls it down: one source, one pulse, then look at the sum
  // (air without loss here: loss slows the field down and would hide what the pulse shape does)
  solver.setMedium(airMedium(nx, ny, 1, { sponge: true }));
  solver.reset();
  solver.setSources([{ x: 130, y: 100, level: 0, amp: 1, sigma: 1.6, pulse: { period: 100000, offset: 1, length } }]);
  // The sum of the field over the floor must stay small and must not keep growing after the pulse.
  // (A pulse with a half wave period too many makes this sum grow without end: the whole floor tints.)
  solver.step(length + 30);
  const first = solver.readState().u;
  let sumAbs = 0;
  for (let i = 0; i < first.length; i++) { sumU += first[i]; sumAbs += Math.abs(first[i]); peakU = Math.max(peakU, Math.abs(first[i])); }
  solver.step(40);
  const later = solver.readState().u;
  let sumLater = 0;
  for (let i = 0; i < later.length; i++) sumLater += later[i];
  const balance = Math.abs(sumU) / sumAbs, drift = Math.abs(sumLater - sumU) / sumAbs;
  solver.dispose();
  return {
    name: 'beacon pulses: one per interval, radios on one channel take turns, and a pulse leaves no growing offset behind',
    pass: overlap === 0 && sends.every((n) => n === 3) && balance < 0.02 && drift < 0.005 && peakU > 1e-3,
    detail: `steps with two same-channel radios sending: ${overlap}; pulses sent in 3 intervals: ${sends.join(', ')}; net offset of one pulse ${(balance * 100).toFixed(2)} % of its size, change over the next 40 steps ${(drift * 100).toFixed(3)} %`,
  };
}

// ---- 9. energy flow -------------------------------------------------------------
function testEnergyFlow(gl) {
  const nx = 240, ny = 240;
  const solver = new WaveSolver(gl, { nx, ny, levels: 1 });
  solver.setMedium(airMedium(nx, ny, 1, { sponge: true }));
  solver.setParams({ omegaDt: (2 * Math.PI) / 20, envelopeRate: 0.02, sourceGain: 0.25, courant: COURANT });
  solver.setSources([{ x: 120, y: 120, level: 0, amp: 1, phase: 0, sigma: 1.6 }]);
  solver.step(600);
  for (let k = 0; k < 40; k++) { solver.step(7); solver.updateEnvelopeMap(0.15); }
  const map = solver.readEnvelopeMap();
  const w = solver.envWidth;
  let worstDot = 1, worstDirected = 1, n = 0;
  for (let a = 0; a < 12; a++) {
    const ang = (a / 12) * Math.PI * 2;
    const cx = 120 + 60 * Math.cos(ang), cy = 120 + 60 * Math.sin(ang);
    const k = (Math.floor(cy / 8) * w + Math.floor(cx / 8)) * 4;
    const fx = map[k + 1], fy = map[k + 2], limit = map[k + 3];
    const mag = Math.hypot(fx, fy);
    worstDot = Math.min(worstDot, (fx * Math.cos(ang) + fy * Math.sin(ang)) / mag);
    worstDirected = Math.min(worstDirected, mag / limit);
    n++;
  }
  solver.dispose();
  return {
    name: 'the energy flow points away from a source, and a travelling wave counts as fully directed',
    pass: worstDot > 0.95 && worstDirected > 0.8 && worstDirected < 1.2,
    detail: `at ${n} places around the source: the flow is within ${(Math.acos(Math.min(1, worstDot)) * 180 / Math.PI).toFixed(1)} degrees of straight outward; lowest share of one-way flow ${(worstDirected * 100).toFixed(0)} %`,
  };
}

// ---- 10. one-shot burst ---------------------------------------------------------
function testBurst(gl) {
  const nx = 160, ny = 120;
  const solver = new WaveSolver(gl, { nx, ny, levels: 1 });
  solver.setMedium(airMedium(nx, ny, 1, { sponge: true }));
  solver.setParams({ omegaDt: (2 * Math.PI) / 20, sourceGain: 0.6 });
  solver.setSources([]);
  solver.step(5);
  const quiet = maxAbs(solver.readState().u);
  const accepted = solver.addBurst({ x: 80, y: 60, level: 0, amp: 0.5, sigma: 1.5, length: 40 });
  solver.step(20);
  const during = solver.srcCount;
  solver.step(40);
  const after = solver.srcCount;
  const loud = maxAbs(solver.readState().u);
  solver.dispose();
  return {
    name: 'a one-shot burst sends one wave packet and then frees its source slot',
    pass: quiet === 0 && accepted && during === 1 && after === 0 && loud > 1e-4,
    detail: `sources before, during and after: 0, ${during}, ${after}; field peak after the burst ${loud.toExponential(2)}`,
  };
}

export async function runAll(log = () => {}) {
  const gl = makeGl();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const probe = new WaveSolver(gl, { nx: 8, ny: 8, levels: 1 });
  const env = {
    renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown',
    precision: probe.float32 ? '32-bit float textures' : '16-bit float textures',
    courant: COURANT,
  };
  probe.dispose();
  const tests = [];
  for (const fn of [testStability, testCircular, testReflection, testEnergyConserved, testEnergyDecays, testEnergyCoupled, testTransmission, testDoorway, testStairs, testBeaconPulse, testEnergyFlow, testBurst]) {
    const t0 = performance.now();
    let result;
    try { result = fn(gl); } catch (e) { result = { name: fn.name, pass: false, detail: `threw: ${e.message}` }; }
    result.ms = Math.round(performance.now() - t0);
    tests.push(result);
    log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}\n      ${result.detail}`);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { env, tests, passed: tests.filter((t) => t.pass).length, failed: tests.filter((t) => !t.pass).length };
}
