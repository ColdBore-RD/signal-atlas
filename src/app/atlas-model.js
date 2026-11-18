// Everything the page knows about signal strength, in one object: the floor plan,
// the access points, the samples, the calibrated propagation model, the signal
// grid for the current view, and the numbers for the metrics panel.
// No DOM and no Three.js here.

import { buildModelContext, traceApField, evaluateApField, rasterizeRooms, priorParams, absoluteZ, predictRssi, BANDS } from '../core/propagation.js';
import { errorStats, surveySource, distanceToSamples } from '../core/survey.js';
import { calibrate, residualWeight, residualFromSums, predictTraced, traceObservations } from '../core/calibrate.js';
import { levelStats, houseStats, channelReport, ssidTopology, bandOf } from '../core/metrics.js';
import { bssidIndex, bandList } from '../core/config.js';
import { roomAt, makeGrid, interiorPoint } from '../core/geometry.js';
import { waveArea, GRID_SNAP_M } from '../sim/rasterize.js';

/** The coverage table lists "best" and at most this many networks, so it stays small with many networks. */
const MATRIX_NETWORKS = 4;

export class AtlasModel {
  constructor({ plan, materials, grades, config, nodes, store }) {
    this.plan = plan; this.materials = materials; this.grades = grades; this.config = config; this.store = store;
    this.nodes = nodes;
    // the bands are a setting (config.bands); the built-in list is only the fallback
    this.bands = bandList(config, materials).map((b) => b.id);
    if (!this.bands.length) this.bands = [...BANDS];
    this.nodeById = new Map(nodes.map((n) => [n.id, n]));
    this.ctx = buildModelContext(plan, materials);
    this.levels = this.ctx.levels;
    // the signal grid covers exactly the area of the wave grid, so both textures line up on screen
    this.grid = makeGrid(waveArea(plan), GRID_SNAP_M / 4);
    this.cells = this.grid.nx * this.grid.ny;
    this.rooms = rasterizeRooms(this.ctx, this.grid);
    // an access point that is not placed yet (position null) or stands on a level this plan lacks is left out
    this.aps = config.aps.filter((ap) => ap.position && this.ctx.byId.has(ap.position.level));
    this.bssids = bssidIndex(this.aps);
    this.staleMs = (config.live?.staleAfterSeconds ?? 900) * 1000;
    this.fields = new Map();
    this.cellZ = this.levels.map((l) => l.z0 + this.ctx.deviceHeight);
    for (const ap of this.aps) this.fields.set(ap.id, traceApField(this.ctx, ap, this.grid));
    this.calibration = null;
    this.calibrate();
    this._events = null;
  }

  apsFor(network) {
    return this.aps.filter((ap) => network === 'best' || ap.network === network);
  }

  /** One observation per fixed sensor and BSSID (median of the record) plus every walk-test point. */
  observations() {
    const obs = [];
    for (const m of this.store.medians()) {
      const hit = this.bssids.get(m.bssid), node = this.nodeById.get(m.node);
      if (!hit || !node?.position || node.type === 'client' || !this.ctx.byId.has(node.position.level)) continue;
      obs.push({ nodeId: m.node, apId: hit.apId, band: hit.band, rssi: m.rssi, position: node.position });
    }
    for (const s of this.store.survey) {
      const hit = this.bssids.get(s.bssid);
      if (!hit || !this.ctx.byId.has(s.level)) continue;
      obs.push({ nodeId: `${s.node}@${s.level}:${s.x},${s.y}`, apId: hit.apId, band: hit.band, rssi: s.rssi, position: { level: s.level, x: s.x, y: s.y }, survey: true });
    }
    return obs;
  }

  /** Fit the model to the samples. With too few samples the assumptions of materials.json stay in use. */
  calibrate() {
    const obs = this.observations();
    const enough = new Set(obs.map((o) => o.nodeId)).size >= 3 && obs.length >= 8;
    if (enough) {
      this.calibration = { ...calibrate(this.ctx, this.aps, obs, this.bands), calibrated: true, observations: obs.length };
    } else {
      this.calibration = {
        calibrated: false, observations: obs.length, sensors: new Set(obs.map((o) => o.nodeId)).size,
        params: Object.fromEntries(this.bands.map((b) => [b, priorParams(this.ctx, b)])),
        heldOut: null, traced: traceObservations(this.ctx, this.aps, obs),
      };
    }
    // walk-test residuals never change with the time cursor: keep them per access point and band
    this.surveyResiduals = new Map();
    for (const o of this.calibration.traced) {
      if (!o.survey) continue;
      const key = `${o.apId}|${o.band}`;
      if (!this.surveyResiduals.has(key)) this.surveyResiduals.set(key, []);
      this.surveyResiduals.get(key).push({ abs: o.abs, nodeId: o.nodeId, value: o.rssi - predictTraced(this.calibration.params[o.band], o) });
    }
    this.fixedTraced = this.calibration.traced.filter((o) => !o.survey);
    this._cache = new Map();
    this._surveySums = new Map();
  }

  /** Add live rows. */
  addRows(rows) { this.store.addAll(rows); this._cache = new Map(); }

  /** Move an access point (while dragging). Re-traces that access point only. */
  moveAp(apId, position) {
    const ap = this.aps.find((a) => a.id === apId);
    if (!ap) return;
    ap.position = { ...ap.position, ...position };
    this.fields.set(ap.id, traceApField(this.ctx, ap, this.grid));
    this._cache = new Map();
  }

  /**
   * Take a new list of networks, access points and nodes (the Setup panel). An access point
   * that did not move keeps its traced field; then the model is calibrated again.
   */
  setDevices(config, nodes) {
    const old = new Map(this.aps.map((ap) => [ap.id, ap.position]));
    const same = (a, b) => a && b && a.level === b.level && a.x === b.x && a.y === b.y && a.z === b.z;
    this.config = config;
    this.nodes = nodes;
    this.nodeById = new Map(nodes.map((n) => [n.id, n]));
    this.aps = config.aps.filter((ap) => ap.position && this.ctx.byId.has(ap.position.level));
    this.bssids = bssidIndex(this.aps);
    const fields = new Map();
    for (const ap of this.aps) fields.set(ap.id, same(old.get(ap.id), ap.position) && this.fields.has(ap.id) ? this.fields.get(ap.id) : traceApField(this.ctx, ap, this.grid));
    this.fields = fields;
    this._events = null;
    this.calibrate();
  }

  /** Residual points of the fixed sensors (reading minus model) for one access point and band at a time. */
  sensorResiduals(ap, band, timeMs) {
    const params = this.calibration.params[band];
    const pts = [];
    const bssid = String(ap.bssid?.[band] || '').toLowerCase();
    for (const o of this.fixedTraced) {
      if (o.apId !== ap.id || o.band !== band) continue;
      const reading = this.store.latest(o.nodeId, bssid, timeMs, this.staleMs);
      if (reading) pts.push({ abs: o.abs, nodeId: o.nodeId, value: reading.rssi - predictTraced(params, o) });
    }
    return pts;
  }

  /** Walk-test residuals do not change with time: their weighted sums per cell are computed once. */
  surveySums(ap, band) {
    const key = `${ap.id}|${band}`;
    if (this._surveySums.has(key)) return this._surveySums.get(key);
    const n = this.levels.length * this.cells;
    const sums = { w: new Float32Array(n), wv: new Float32Array(n) };
    const pts = this.surveyResiduals.get(key) || [];
    const { nx, ny, minX, minY, cell } = this.grid;
    if (pts.length) {
      for (let li = 0; li < this.levels.length; li++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const k = li * this.cells + j * nx + i;
        const x = minX + (i + 0.5) * cell, y = minY + (j + 0.5) * cell, z = this.cellZ[li];
        let sw = 0, swv = 0;
        for (const p of pts) { const w = residualWeight(x, y, z, p); sw += w; swv += w * p.value; }
        sums.w[k] = sw; sums.wv[k] = swv;
      }
    }
    this._surveySums.set(key, sums);
    return sums;
  }

  /**
   * Signal grid in dBm for a band, a network choice and a time:
   * the calibrated model plus the residual correction, best access point per cell.
   * Returns { dbm: Float32Array(levels * cells), server: Int8Array (index of the best access point) }.
   */
  envelope(band, network, timeMs, withResidual = true) {
    const key = `${band}|${network}|${Math.round(timeMs / 60000)}|${withResidual}`;
    if (this._cache.has(key)) return this._cache.get(key);
    const n = this.levels.length * this.cells;
    const dbm = new Float32Array(n).fill(-140);
    const server = new Int8Array(n).fill(-1);
    const tmp = new Float32Array(n);
    const params = this.calibration.params[band];
    const { nx, ny, minX, minY, cell } = this.grid;
    const correct = withResidual && this.calibration.calibrated;
    this.aps.forEach((ap, ai) => {
      if (network !== 'best' && ap.network !== network) return;
      evaluateApField(this.fields.get(ap.id), params, ap, tmp);
      const pts = correct ? this.sensorResiduals(ap, band, timeMs) : [];
      const sums = correct ? this.surveySums(ap, band) : null;
      for (let li = 0; li < this.levels.length; li++) {
        const z = this.cellZ[li];
        for (let j = 0; j < ny; j++) {
          const y = minY + (j + 0.5) * cell;
          for (let i = 0; i < nx; i++) {
            const k = li * this.cells + j * nx + i;
            let v = tmp[k];
            if (correct) {
              let sw = sums.w[k], swv = sums.wv[k];
              const x = minX + (i + 0.5) * cell;
              for (let p = 0; p < pts.length; p++) { const w = residualWeight(x, y, z, pts[p]); sw += w; swv += w * pts[p].value; }
              v += residualFromSums(sw, swv);
            }
            if (v > dbm[k]) { dbm[k] = v; server[k] = ai; }
          }
        }
      }
    });
    const out = { dbm, server };
    if (this._cache.size > 24) this._cache.delete(this._cache.keys().next().value);
    this._cache.set(key, out);
    return out;
  }

  /** Panel numbers for one band and network at a time. */
  metrics(band, network, timeMs) {
    const { dbm } = this.envelope(band, network, timeMs);
    const perLevel = this.levels.map((level, li) => ({
      level: level.level,
      stats: levelStats(dbm.subarray(li * this.cells, (li + 1) * this.cells), this.rooms[li], level.level.rooms || [], this.grid.cell ** 2, this.grades),
    }));
    return { perLevel, house: houseStats(perLevel) };
  }

  /** Coverage percent for every level, band and network: the small table in the panel. */
  coverageMatrix(timeMs) {
    const rows = [];
    for (const network of ['best', ...Object.keys(this.config.networks || {}).slice(0, MATRIX_NETWORKS)]) for (const band of this.bands) {
      const m = this.metrics(band, network, timeMs);
      rows.push({ network, band, levels: m.perLevel.map((p) => ({ id: p.level.id, pct: p.stats.coveragePct })), house: m.house.coveragePct });
    }
    return rows;
  }

  /** What each node reports at a time. */
  nodeStates(timeMs) {
    return this.nodes.map((node) => {
      const flag = this.store.onlineFlag(node.id, timeMs);
      const heard = this.store.lastHeard(node.id, timeMs);
      const att = this.store.attachment(node.id, timeMs, this.staleMs);
      const fresh = timeMs - heard <= this.staleMs;
      let link = null;
      if (att) {
        const hit = this.bssids.get(att.bssid);
        const info = this.store.bssids.get(att.bssid);
        link = {
          bssid: att.bssid, rssi: att.rssi, noise: att.noise, snr: Number.isFinite(att.noise) ? att.rssi - att.noise : null,
          band: hit?.band || info?.band, channel: hit?.ap.channel?.[hit.band] ?? info?.channel, ssid: info?.ssid || '',
          apId: hit?.apId || null, network: hit?.network || null, t: att.t, quality: bandOf(att.rssi, this.grades),
        };
      }
      const wired = node.type === 'wired';
      const online = wired ? true : node.type === 'survey' ? null : flag === false ? false : fresh;
      return { node, online, lastHeard: heard, link, room: node.position ? roomAt(this.ctx.byId.get(node.position.level)?.level || {}, node.position.x, node.position.y) : null };
    });
  }

  /** Health of the link to each wired reference, as probed by the prober nodes. */
  wiredHealth(timeMs) {
    const out = [];
    for (const p of this.store.probes.values()) {
      const latest = this.store.latestProbe(p.node, p.target, timeMs, this.staleMs);
      out.push({ target: p.target, prober: p.node, latest, series: p });
    }
    return out.sort((a, b) => a.target.localeCompare(b.target));
  }

  /** Radios for the channel map: own access points plus every other BSSID in the samples. */
  channelReport(timeMs) {
    const radios = [];
    for (const ap of this.aps) for (const band of this.bands) {
      if (!ap.bssid?.[band]) continue;
      radios.push({ bssid: ap.bssid[band].toLowerCase(), ssid: this.config.networks[ap.network]?.ssid, band, channel: ap.channel?.[band], own: true, apId: ap.id, network: ap.network, label: ap.label });
    }
    for (const info of this.store.bssids.values()) {
      if (this.bssids.has(info.bssid) || !info.channel) continue;
      if (timeMs - info.lastT > 6 * 3600000 && info.lastT < timeMs) continue;
      radios.push({ bssid: info.bssid, ssid: info.ssid, band: info.band, channel: info.channel, own: false, rssi: info.maxRssi });
    }
    return channelReport(radios);
  }

  /**
   * Which access points advertise each of the owner's SSIDs, from the BSSIDs in the samples.
   * This is the check of "the mesh network name belongs only to the mesh points".
   */
  topology() {
    const own = new Map(Object.entries(this.config.networks).map(([id, n]) => [n.ssid, id]));
    const seen = [...this.store.bssids.values()].filter((b) => own.has(b.ssid));
    return ssidTopology(seen, this.bssids).map((t) => {
      const expected = own.get(t.ssid);
      const foreign = t.networks.filter((n) => n !== expected);
      return { ...t, expectedNetwork: expected, consistent: foreign.length === 0 && t.unknownBssids.length === 0, foreign };
    });
  }

  /** Events found in the samples: 2.4 GHz noise bursts and sensors that went offline. */
  events() {
    if (this._events && this._events.count === this.store.count) return this._events.list;
    const list = [];
    // noise bursts: any sensor whose noise floor is 8 dB above its own median
    const marks = [];
    for (const s of this.store.series.values()) {
      const hit = this.bssids.get(s.bssid);
      const band = hit?.band || this.store.bssids.get(s.bssid)?.band;
      const vals = s.noise.filter(Number.isFinite);
      if (vals.length < 8) continue;
      const med = vals.slice().sort((a, b) => a - b)[vals.length >> 1];
      s.noise.forEach((v, i) => { if (v > med + 8) marks.push({ t: s.t[i], rise: v - med, node: s.node, band }); });
    }
    marks.sort((a, b) => a.t - b.t);
    let cur = null;
    for (const m of marks) {
      if (cur && m.t - cur.to < 12 * 60000) { cur.to = m.t; if (m.rise > cur.rise) { cur.rise = m.rise; cur.node = m.node; } }
      else { cur = { type: 'interference', from: m.t, to: m.t, rise: m.rise, node: m.node, band: m.band }; list.push(cur); }
    }
    for (const [node, st] of this.store.status) {
      for (let i = 0; i < st.t.length; i++) {
        if (st.online[i]) continue;
        const back = st.online.indexOf(1, i);
        list.push({ type: 'offline', node, from: st.t[i], to: back >= 0 ? st.t[back] : this.store.tMax });
      }
    }
    list.sort((a, b) => a.from - b.from);
    this._events = { count: this.store.count, list };
    return list;
  }

  /** History of the link a node uses, for the chart: [{ t, rssi, noise }] of the attached BSSID over time. */
  history(nodeId) {
    const map = this.store.byNode.get(nodeId);
    if (!map) return [];
    const rows = [];
    for (const s of map.values()) for (let i = 0; i < s.t.length; i++) if (s.assoc[i]) rows.push({ t: s.t[i], rssi: s.rssi[i], noise: s.noise[i], bssid: s.bssid });
    if (!rows.length) {
      // a pure scanner that is attached to nothing: show its strongest own BSSID
      let best = null;
      for (const s of map.values()) if (this.bssids.has(s.bssid) && (!best || avg(s.rssi) > avg(best.rssi))) best = s;
      if (best) best.t.forEach((t, i) => rows.push({ t, rssi: best.rssi[i], noise: best.noise[i], bssid: best.bssid }));
    }
    return rows.sort((a, b) => a.t - b.t);
  }

  absoluteZ(pos) { return absoluteZ(this.ctx, pos); }

  // ------------------------------------------------------------------ walk survey
  /**
   * Every measured place of the walk survey, with what the model says for that place.
   * For each own radio heard there: measured, predicted by the calibrated model (without
   * the correction that pulls the map toward the samples, which would hide the error),
   * and predicted by the assumptions of materials.json alone ("prior").
   * error = measured - predicted, in dB. Returns { points, stats, prior, bySource }.
   * synthetic picks the generated walk-test points instead of the measured ones.
   */
  surveyComparison(band, network, synthetic = false) {
    const calibrated = this.calibration.params[band], prior = priorParams(this.ctx, band);
    const groups = new Map();
    for (const s of this.store.survey) {
      if (!!s.synthetic !== synthetic) continue;
      const hit = this.bssids.get(s.bssid);
      if (!hit || hit.band !== band || !this.ctx.byId.has(s.level)) continue;
      if (network !== 'best' && hit.network !== network) continue;
      const key = `${s.node}|${s.level}|${s.x}|${s.y}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { node: s.node, source: surveySource(s.node), level: s.level, x: s.x, y: s.y, t: s.t, readings: [] });
      const rx = { level: s.level, x: s.x, y: s.y };
      g.readings.push({ apId: hit.apId, measured: s.rssi, predicted: predictRssi(this.ctx, calibrated, hit.ap, rx), prior: predictRssi(this.ctx, prior, hit.ap, rx) });
    }
    const points = [], errors = [], priorErrors = [], perSource = new Map();
    for (const g of groups.values()) {
      g.readings.sort((a, b) => b.measured - a.measured);
      const best = g.readings[0];
      const level = this.ctx.byId.get(g.level).level;
      points.push({ ...g, best, error: best.measured - best.predicted, room: roomAt(level, g.x, g.y)?.name || null, levelName: level.name });
      for (const r of g.readings) {
        errors.push(r.measured - r.predicted);
        priorErrors.push(r.measured - r.prior);
        const k = g.source || 'other';
        if (!perSource.has(k)) perSource.set(k, []);
        perSource.get(k).push(r.measured - r.predicted);
      }
    }
    return { points, stats: errorStats(errors), prior: errorStats(priorErrors), bySource: [...perSource].map(([source, e]) => ({ source, ...errorStats(e) })) };
  }

  /** The places where something was really measured (no synthetic points): [{ levelIndex, x, y }], each place once. */
  measuredPlaces() {
    const seen = new Map();
    for (const s of this.store.survey) {
      if (s.synthetic) continue;
      const level = this.ctx.byId.get(s.level);
      if (level) seen.set(`${s.level}|${s.x}|${s.y}`, { levelIndex: level.index, level: s.level, x: s.x, y: s.y });
    }
    return [...seen.values()];
  }

  /** For every cell of the signal grid: metres to the nearest measured place (99 when there is none). */
  sampleDistance() {
    if (this._sampleDistance?.count === this.store.survey.length) return this._sampleDistance.grid;
    const grid = distanceToSamples(this.grid, this.levels.length, this.measuredPlaces());
    this._sampleDistance = { count: this.store.survey.length, grid };
    return grid;
  }

  /**
   * Where a new measurement tells the most: the rooms that are, on average, farthest from
   * any measured place. Returns up to `limit` of [{ level, levelName, room, x, y, meanM, synthetic }],
   * farthest first. A room closer than minM on average is left out.
   */
  measureNext(limit = 5, minM = 2.5) {
    const dist = this.sampleDistance();
    const out = [];
    this.levels.forEach((level, li) => {
      const rooms = level.level.rooms || [];
      const sum = new Float64Array(rooms.length), n = new Uint32Array(rooms.length);
      const index = this.rooms[li];
      for (let c = 0; c < this.cells; c++) { const r = index[c]; if (r >= 0) { sum[r] += dist[li * this.cells + c]; n[r]++; } }
      rooms.forEach((room, r) => {
        if (n[r] * this.grid.cell ** 2 < 2) return;
        const [x, y] = interiorPoint(room.polygon, 0.3);
        out.push({ level: level.id, levelName: level.name, room: room.name, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, meanM: sum[r] / n[r], areaM2: n[r] * this.grid.cell ** 2, synthetic: level.level.source === 'synthetic' });
      });
    });
    // farthest first; with nothing measured yet every room is equally far, so scanned floors and large rooms come first
    return out.filter((p) => p.meanM >= minM).sort((a, b) => b.meanM - a.meanM || Number(a.synthetic) - Number(b.synthetic) || b.areaM2 - a.areaM2).slice(0, limit);
  }
}

function avg(a) { let s = 0; for (const v of a) s += v; return a.length ? s / a.length : -200; }
