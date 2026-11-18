// Turns a floor plan into the "medium" grid that the wave solver reads.
// One tile per level, all tiles the same size, stacked along y in one atlas
// (lowest level first).
//
// For every cell the medium holds four numbers:
//   [0] Courant number squared, (wave speed * dt / dx)^2. Air has COURANT^2.
//       A wall has a lower wave speed, which makes it reflect.
//   [1] damping per time step. Walls absorb. A sponge layer at the tile edge
//       absorbs everything that leaves the house. Air has a very small value.
//   [2] coupling to the same cell on the level above (1 inside a stair opening).
//   [3] coupling to the same cell on the level below.
//
// How a material becomes a wave medium:
//   reflection r (0..1, from materials.json) sets the wave speed in the wall:
//       speed ratio = (1 - r) / (1 + r)
//   which gives an amplitude reflection of r at a thick wall (tested).
//   loss_db L for the band sets the damping so that one pass through the wall
//   leaves about 10^(-L/20) of the amplitude:
//       exp(-alpha * thickness) = 10^(-L/20) / (1 - r^2)
//
// Pure functions: browser and Node.

import { buildObstacles, sortedLevels, planBounds, pointInPolygon, polygonArea, bounds } from '../core/geometry.js';

/** Courant number in air. The 2D scheme is stable up to 1/sqrt(2) = 0.707. */
export const COURANT = 0.5;
/** Vertical coupling strength in stair openings (a Courant number squared). */
export const STAIR_COUPLING = 0.15;
export const SPONGE_CELLS = 14;
const SPONGE_MAX = 0.3;
/**
 * Loss in open air for the flat wave, dB per metre, worked out from the path-loss model.
 *
 * A wave on a flat grid loses 10 * log10(r) dB with distance r, because it can only
 * spread sideways. The propagation model says that the signal in this house loses
 * 10 * n * log10(r) dB (n is the path-loss exponent; calibration fits it to the
 * samples). The flat wave is therefore short of (10 n - 10) * log10(r) dB. That
 * missing loss is spread evenly over the distance from 1 m to `reach` metres:
 *
 *     loss per metre = (10 n - 10) * log10(reach) / (reach - 1)
 *
 * With n = 2.2 and a reach of 12 m this is 1.18 dB per metre. So the number is not
 * a free constant: it follows n, and n follows the measurements.
 */
export function spreadingLossDbPerM(n, reach = 12) {
  const r = Math.max(2, reach);
  return Math.max(0, ((10 * n - 10) * Math.log10(r)) / (r - 1));
}
/** The loss per metre as damping per time step, for a grid with cell size dx. */
export function airDamping(dx, lossDbPerM = spreadingLossDbPerM(2.2, 12)) {
  return (lossDbPerM / 8.686) * COURANT * dx;
}

export const QUALITY = {
  low: { dx: 0.1, label: 'Low' },
  medium: { dx: 0.075, label: 'Medium' },
  high: { dx: 0.06, label: 'High' },
  ultra: { dx: 0.045, label: 'Ultra' },
};
export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

/**
 * Every quality level divides this length without a remainder, so the simulated
 * area is exactly the same at every quality and the picture does not shift.
 */
export const GRID_SNAP_M = 0.9;

/** The simulated area: the house plus an outdoor margin, snapped to GRID_SNAP_M. */
export function waveArea(plan, margin = 1.6) {
  const a = planBounds(plan, margin);
  const width = Math.ceil((a.maxX - a.minX) / GRID_SNAP_M - 1e-9) * GRID_SNAP_M;
  const height = Math.ceil((a.maxY - a.minY) / GRID_SNAP_M - 1e-9) * GRID_SNAP_M;
  const minX = a.minX - (width - (a.maxX - a.minX)) / 2, minY = a.minY - (height - (a.maxY - a.minY)) / 2;
  return { minX, minY, maxX: minX + width, maxY: minY + height, width, height };
}

/** Grid layout for a plan at cell size dx (metres). Every level uses the same tile. */
export function waveGridSpec(plan, dx, margin = 1.6) {
  const area = waveArea(plan, margin);
  const nx = Math.round(area.width / dx);
  const ny = Math.round(area.height / dx);
  const levels = sortedLevels(plan);
  return { minX: area.minX, minY: area.minY, dx, nx, ny, levels: levels.length, levelIds: levels.map((l) => l.id), width: area.width, height: area.height };
}

/** Wave-medium numbers for a slab of one material, `cells` cells thick. */
export function slabMedium(material, band, cells) {
  const r = Math.min(0.95, Math.max(0, material.reflection ?? 0));
  const ratio = (1 - r) / (1 + r);
  const lossDb = material.loss_db?.[band] ?? 0;
  const through = 10 ** (-lossDb / 20);
  const alphaTotal = Math.max(0, Math.log((1 - r * r) / through)); // total exponent across the slab
  return { c2: COURANT * COURANT * ratio * ratio, damping: (alphaTotal / Math.max(1, cells)) * COURANT * ratio, ratio, lossDb };
}

/**
 * Build the medium atlas. Returns { data: Float32Array(nx * ny * levels * 4), solid: Uint8Array }.
 * solid marks wall and fixture cells (1) for display.
 */
export function rasterizeMedium(plan, materialsFile, spec, band, { airLossDbPerM } = {}) {
  const { nx, ny, dx } = spec;
  const levels = sortedLevels(plan);
  const cells = nx * ny;
  const data = new Float32Array(cells * levels.length * 4);
  const solid = new Uint8Array(cells * levels.length);
  const air = COURANT * COURANT;
  // without a calibrated exponent, use the exponent that materials.json assumes for this band
  const reach = Math.hypot(spec.width, spec.height) / 2;
  const AIR_DAMPING = airDamping(dx, airLossDbPerM ?? spreadingLossDbPerM(materialsFile.pathLoss?.[band]?.n ?? 2.2, reach));

  for (let li = 0; li < levels.length; li++) {
    const base = li * cells;
    const loss = new Float32Array(cells); // loss of the material already written, to keep the stronger one
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const edge = Math.min(i, j, nx - 1 - i, ny - 1 - j);
        const s = edge < SPONGE_CELLS ? SPONGE_MAX * ((SPONGE_CELLS - edge) / SPONGE_CELLS) ** 2 : 0;
        const k = (base + j * nx + i) * 4;
        data[k] = air;
        data[k + 1] = AIR_DAMPING + s;
      }
    }
    const put = (i, j, m, weightLoss) => {
      if (i < 0 || j < 0 || i >= nx || j >= ny) return;
      const c = j * nx + i;
      if (weightLoss < loss[c]) return;
      loss[c] = weightLoss;
      const k = (base + c) * 4;
      const edge = Math.min(i, j, nx - 1 - i, ny - 1 - j);
      const s = edge < SPONGE_CELLS ? SPONGE_MAX * ((SPONGE_CELLS - edge) / SPONGE_CELLS) ** 2 : 0;
      data[k] = m.c2;
      data[k + 1] = AIR_DAMPING + s + m.damping;
      solid[base + c] = 1;
    };

    // fixtures first (filled polygons), then walls on top
    for (const fx of levels[li].fixtures || []) {
      const mat = materialsFile.materials[fx.material];
      if (!mat) continue;
      const b = bounds(fx.polygon);
      const across = Math.sqrt(polygonArea(fx.polygon));
      const m = slabMedium(mat, band, across / dx);
      const i0 = Math.floor((b.minX - spec.minX) / dx), i1 = Math.ceil((b.maxX - spec.minX) / dx);
      const j0 = Math.floor((b.minY - spec.minY) / dx), j1 = Math.ceil((b.maxY - spec.minY) / dx);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (pointInPolygon(spec.minX + (i + 0.5) * dx, spec.minY + (j + 0.5) * dx, fx.polygon)) put(i, j, m, 0.001 + m.lossDb * 0.01);
        }
      }
    }
    for (const o of buildObstacles(levels[li], materialsFile.materials)) {
      if (o.kind === 'fixture' || o.material === 'open') continue;
      const mat = materialsFile.materials[o.material];
      if (!mat) continue;
      const half = Math.max(o.thickness / 2, 0.8 * dx);
      const m = slabMedium(mat, band, (2 * half) / dx);
      const i0 = Math.floor((Math.min(o.ax, o.bx) - half - spec.minX) / dx), i1 = Math.ceil((Math.max(o.ax, o.bx) + half - spec.minX) / dx);
      const j0 = Math.floor((Math.min(o.ay, o.by) - half - spec.minY) / dx), j1 = Math.ceil((Math.max(o.ay, o.by) + half - spec.minY) / dx);
      const ex = o.bx - o.ax, ey = o.by - o.ay;
      const len2 = ex * ex + ey * ey;
      for (let j = j0; j <= j1; j++) {
        const py = spec.minY + (j + 0.5) * dx;
        for (let i = i0; i <= i1; i++) {
          const px = spec.minX + (i + 0.5) * dx;
          let t = len2 > 0 ? ((px - o.ax) * ex + (py - o.ay) * ey) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          if (Math.hypot(px - (o.ax + t * ex), py - (o.ay + t * ey)) <= half) put(i, j, m, 1 + m.lossDb);
        }
      }
    }
  }

  // stair openings couple a level to the next one up
  for (let li = 0; li + 1 < levels.length; li++) {
    const lower = levels[li], upper = levels[li + 1];
    const polys = [
      ...(lower.stairs || []).filter((s) => s.connects.includes(upper.id)).map((s) => s.polygon),
      ...(upper.stairs || []).filter((s) => s.connects.includes(lower.id)).map((s) => s.polygon),
    ];
    for (const poly of polys) {
      const b = bounds(poly);
      const i0 = Math.max(1, Math.floor((b.minX - spec.minX) / dx)), i1 = Math.min(nx - 2, Math.ceil((b.maxX - spec.minX) / dx));
      const j0 = Math.max(1, Math.floor((b.minY - spec.minY) / dx)), j1 = Math.min(ny - 2, Math.ceil((b.maxY - spec.minY) / dx));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (!pointInPolygon(spec.minX + (i + 0.5) * dx, spec.minY + (j + 0.5) * dx, poly)) continue;
          const c = j * nx + i;
          if (solid[li * cells + c] || solid[(li + 1) * cells + c]) continue;
          data[(li * cells + c) * 4 + 2] = 1;
          data[((li + 1) * cells + c) * 4 + 3] = 1;
        }
      }
    }
  }
  return { data, solid };
}

/** Cell coordinates (fractional, within one tile) of a floor-plan point. */
export function toCell(spec, x, y) {
  return [(x - spec.minX) / spec.dx, (y - spec.minY) / spec.dx];
}

/**
 * Wave sources for a set of access points. Each access point radiates on its own
 * level at full strength and, weaker, on the other levels: the direct path through
 * the floor. floorLossDb is the loss of one floor for the current band.
 * aps: [{ id, position: { level, x, y }, amplitude?, phase? }]
 */
export function buildSources(spec, aps, floorLossDb, maxSources = 16) {
  const out = [];
  aps.forEach((ap, n) => {
    const own = spec.levelIds.indexOf(ap.position.level);
    if (own < 0) return;
    const [cx, cy] = toCell(spec, ap.position.x, ap.position.y);
    const amp = ap.amplitude ?? 1;
    const pulsed = !!ap.pulse;
    const phase = ap.phase ?? (pulsed ? 0 : n * 2.1);
    // continuous tone only: independent transmitters get slightly different frequencies, so that
    // their patterns do not freeze. A pulsed source needs no such trick.
    const freq = ap.freq ?? (pulsed ? 1 : 1 + 0.055 * (n - (aps.length - 1) / 2));
    spec.levelIds.forEach((id, li) => {
      const floors = Math.abs(li - own);
      const through = amp * 10 ** ((-floorLossDb * floors) / 20);
      if (through < 0.02) return;
      // a through-floor source is wider (the floor blurs it); its strength is scaled so that it radiates the same total
      const sigma = floors === 0 ? 1.6 : 1.6 + 2.2 * floors;
      out.push({ x: cx, y: cy, level: li, amp: through * (1.6 / sigma) ** 2, phase, freq, sigma, apId: ap.id, floors, ...(pulsed ? { pulse: ap.pulse } : {}) });
    });
  });
  // keep the strongest when there are too many
  return out.sort((p, q) => q.amp - p.amp).slice(0, maxSources);
}

/**
 * Wave amplitude of each emitter from its transmit power: the strongest gets 1 and
 * 6 dB less power halves the amplitude. A device inside a cabinet has its cabinet
 * loss already taken off tx_dbm (see applyApPositions), so it radiates weaker here too.
 */
export function sourceAmplitudes(aps, band) {
  const tx = aps.map((ap) => ap.tx_dbm?.[band]).filter(Number.isFinite);
  const top = tx.length ? Math.max(...tx) : 0;
  return new Map(aps.map((ap) => [ap.id, Number.isFinite(ap.tx_dbm?.[band]) ? 10 ** ((ap.tx_dbm[band] - top) / 20) : 1]));
}

/**
 * When each radio sends its beacon, in time steps.
 *
 * What is real: every access point sends a beacon at the same interval (102.4 ms), and
 * radios that share a channel never send at the same moment, because each one listens
 * first. So radios on one channel take turns, evenly spread over the interval, and
 * radios on different channels run on clocks that have nothing to do with each other.
 * What is not real is the time scale; the caller says how many steps one interval takes.
 *
 * Returns Map(apId -> { period, offset, length }).
 */
export function beaconSchedule(aps, band, periodSteps, pulseSteps) {
  const groups = new Map();
  for (const ap of aps) {
    const channel = ap.channel?.[band] ?? `none-${ap.id}`;
    if (!groups.has(channel)) groups.set(channel, []);
    groups.get(channel).push(ap);
  }
  const out = new Map();
  for (const [channel, members] of groups) {
    members.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    // each channel starts at its own fixed place in the interval
    let h = 2166136261;
    for (const ch of String(channel)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const base = ((h >>> 0) % 1000) / 1000;
    const slot = periodSteps / members.length;
    members.forEach((ap, i) => out.set(ap.id, { period: periodSteps, offset: Math.round((base + i / members.length) * periodSteps) % periodSteps, length: Math.max(4, Math.min(Math.round(pulseSteps), Math.floor(slot))) }));
  }
  return out;
}
