// Walk survey: join scans to the places where a person stood, and compare what
// was measured with what the model predicts.
//
// A waypoint is a place and a moment: { id, t (ms), level, x, y }.
// A scan is one reading of one radio: { t (ms), bssid, ssid, band, channel, rssi_dbm, approx? }.
// The join gives one row per waypoint and BSSID in the sample format of
// docs/data-contract.md, so the calibration code reads it like any walk-test row.
//
// Pure functions: the page and the Node tools use the same code.

export const DEFAULT_WINDOW_S = 8;

const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
const round1 = (v) => Math.round(v * 10) / 10;

/** Rows of an NDJSON log as waypoints. Rows of another kind are ignored. */
export function waypointsFromRows(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || r.kind !== 'waypoint') continue;
    const t = Date.parse(r.time);
    if (!Number.isFinite(t) || !Number.isFinite(r.x) || !Number.isFinite(r.y) || r.level == null) continue;
    out.push({ id: String(r.id || `wp-${out.length + 1}`), t, level: String(r.level), x: r.x, y: r.y, ...(r.note ? { note: String(r.note) } : {}) });
  }
  return out.sort((a, b) => a.t - b.t).map((w, i) => ({ ...w, seq: i + 1 }));
}

/** Rows of an NDJSON log as scans. Rows that are not complete scan rows are ignored. */
export function scansFromRows(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || (r.kind && r.kind !== 'scan')) continue;
    const t = Date.parse(r.time);
    const bssid = String(r.bssid || '').toLowerCase();
    if (!Number.isFinite(t) || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(bssid) || !Number.isFinite(r.rssi_dbm) || !r.band) continue;
    out.push({ t, bssid, ssid: r.ssid || '', band: String(r.band), channel: r.channel, rssi_dbm: r.rssi_dbm, approx: !!(r.approx || r.rssi_approx) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Marks of a scanner without a map ("I stand on the next spot now"): { t, seq }. */
export function marksFromRows(rows) {
  const out = [];
  for (const r of rows) {
    if (!r || r.kind !== 'mark') continue;
    const t = Date.parse(r.time);
    if (Number.isFinite(t)) out.push({ t, seq: Number.isFinite(r.seq) ? r.seq : out.length + 1 });
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * Join scans to waypoints by time.
 *
 * A scan belongs to a waypoint when it was taken at most windowS seconds before
 * or after the moment of the waypoint. When two waypoints are that close in
 * time, a scan goes to the nearer one. All readings of one BSSID at one waypoint
 * are averaged (in dB).
 *
 * Returns { rows, report }. rows are sample rows (kind "scan" with pos_level,
 * pos_x, pos_y). report says what was used and what was not.
 */
export function joinByTime(waypoints, scans, { windowS = DEFAULT_WINDOW_S, node = 'survey-laptop' } = {}) {
  const windowMs = windowS * 1000;
  const sorted = [...waypoints].sort((a, b) => a.t - b.t);
  const buckets = sorted.map(() => new Map());
  let used = 0, unused = 0;
  let from = 0;
  for (const s of scans) {
    while (from < sorted.length && sorted[from].t < s.t - windowMs) from++;
    let best = -1, bestGap = Infinity;
    for (let i = from; i < sorted.length && sorted[i].t <= s.t + windowMs; i++) {
      const gap = Math.abs(sorted[i].t - s.t);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    if (best < 0) { unused++; continue; }
    used++;
    let g = buckets[best].get(s.bssid);
    if (!g) buckets[best].set(s.bssid, g = { bssid: s.bssid, ssid: s.ssid, band: s.band, channel: s.channel, sum: 0, n: 0, min: Infinity, max: -Infinity, approx: false });
    g.sum += s.rssi_dbm; g.n++;
    g.min = Math.min(g.min, s.rssi_dbm); g.max = Math.max(g.max, s.rssi_dbm);
    if (s.ssid) g.ssid = s.ssid;
    if (s.approx) g.approx = true;
  }
  const rows = [];
  const withoutScans = [];
  sorted.forEach((w, i) => {
    if (!buckets[i].size) { withoutScans.push(w.id); return; }
    for (const g of [...buckets[i].values()].sort((a, b) => b.sum / b.n - a.sum / a.n)) {
      rows.push({
        time: iso(w.t), node_id: node, kind: 'scan', bssid: g.bssid, ssid: g.ssid, band: g.band,
        ...(Number.isFinite(g.channel) ? { channel: g.channel } : {}),
        rssi_dbm: round1(g.sum / g.n), pos_level: w.level, pos_x: w.x, pos_y: w.y,
        waypoint: w.id, readings: g.n, ...(g.n > 1 ? { rssi_min_dbm: g.min, rssi_max_dbm: g.max } : {}),
        ...(g.approx ? { rssi_approx: true } : {}),
      });
    }
  });
  return { rows, report: { node, windowS, waypoints: sorted.length, waypointsWithScans: sorted.length - withoutScans.length, waypointsWithoutScans: withoutScans, scansUsed: used, scansUnused: unused } };
}

/**
 * Join for a scanner that does not know the map (the Pi): the person presses
 * "mark" at each spot, in the order of the waypoints. Mark number k is waypoint
 * number k. The marks carry the clock of the scanner, so its clock does not
 * have to agree with the clock of the laptop.
 */
export function joinByMarks(waypoints, marks, scans, { windowS = DEFAULT_WINDOW_S, node = 'survey-pi' } = {}) {
  const bySeq = new Map([...waypoints].sort((a, b) => a.t - b.t).map((w, i) => [w.seq ?? i + 1, w]));
  const lost = [];
  // a number that was marked twice (a mark taken back and made again): the last mark counts
  const last = new Map();
  for (const m of marks) last.set(m.seq, m);
  const placed = [];
  for (const m of last.values()) {
    const w = bySeq.get(m.seq);
    if (w) placed.push({ ...w, t: m.t }); else lost.push(m.seq);
  }
  const out = joinByTime(placed, scans, { windowS, node });
  out.report.marks = marks.length;
  out.report.marksWithoutWaypoint = lost;
  // the row keeps the time of the waypoint on the map clock, so that all rows of one place agree
  const mapTime = new Map(waypoints.map((w) => [w.id, w.t]));
  for (const r of out.rows) r.time = iso(mapTime.get(r.waypoint) ?? Date.parse(r.time));
  return out;
}

/** Median, 90th percentile and mean of a list of signed errors in dB. */
export function errorStats(errors) {
  if (!errors.length) return { count: 0, medianAbs: null, p90Abs: null, bias: null };
  const abs = errors.map(Math.abs).sort((a, b) => a - b);
  const at = (p) => abs[Math.min(abs.length - 1, Math.floor(p * abs.length))];
  return { count: errors.length, medianAbs: abs.length % 2 ? abs[abs.length >> 1] : (abs[abs.length / 2 - 1] + abs[abs.length / 2]) / 2, p90Abs: at(0.9), bias: errors.reduce((s, v) => s + v, 0) / errors.length };
}

/** "laptop", "Pi" or null for another device, from the node id of a survey row. */
export function surveySource(nodeId) {
  if (/laptop/i.test(nodeId)) return 'laptop';
  if (/(^|[-_])pi([-_]|$)/i.test(nodeId)) return 'Pi';
  return null;
}

/**
 * For every cell of a grid: metres to the nearest measured place. A place on
 * another level counts as farther away by floorPenaltyM per floor between.
 * points: [{ levelIndex, x, y }]. Returns Float32Array(levels * nx * ny); a grid
 * with no point at all is filled with `none`.
 */
export function distanceToSamples(grid, levelCount, points, { floorPenaltyM = 6, none = 99 } = {}) {
  const cells = grid.nx * grid.ny;
  const out = new Float32Array(levelCount * cells).fill(none);
  if (!points.length) return out;
  for (let li = 0; li < levelCount; li++) {
    for (let j = 0; j < grid.ny; j++) {
      const y = grid.minY + (j + 0.5) * grid.cell;
      for (let i = 0; i < grid.nx; i++) {
        const x = grid.minX + (i + 0.5) * grid.cell;
        let best = Infinity;
        for (const p of points) {
          const d = Math.hypot(p.x - x, p.y - y) + Math.abs(p.levelIndex - li) * floorPenaltyM;
          if (d < best) best = d;
        }
        out[li * cells + j * grid.nx + i] = Math.min(none, best);
      }
    }
  }
  return out;
}
