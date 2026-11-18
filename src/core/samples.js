// Sample store: parses NDJSON rows (see docs/data-contract.md) and answers
// "what did this node last report at time T". Pure functions: browser and Node.

export function parseNdjson(text) {
  const rows = [];
  const problems = [];
  let lineNo = 0;
  for (const line of text.split('\n')) {
    lineNo++;
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch (e) { if (problems.length < 5) problems.push(`line ${lineNo}: not valid JSON`); }
  }
  // A file whose first line says "synthetic" is synthetic as a whole: every row carries the mark,
  // so that generated walk-test points are never taken for measurements.
  if (rows.some((r) => r && r.kind === 'meta' && r.synthetic)) for (const r of rows) if (r && r.kind !== 'meta') r.synthetic = true;
  return { rows, problems };
}

/** Index of the last element of sorted array t that is <= value, or -1. */
export function lastAtOrBefore(t, value) {
  let lo = 0, hi = t.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= value) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function median(values) {
  if (!values.length) return NaN;
  const s = Float64Array.from(values).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class SampleStore {
  constructor() {
    this.series = new Map();   // "node|bssid" -> { node, bssid, t[], rssi[], noise[], assoc[] }
    this.byNode = new Map();   // node -> Map(bssid -> series)
    this.probes = new Map();   // "node|target" -> { node, target, t[], latency[], jitter[], loss[], throughput[], bssid[] }
    this.status = new Map();   // node -> { t[], online[] }
    this.bssids = new Map();   // bssid -> { ssid, band, channel, count, lastT }
    this.survey = [];          // walk-test rows: { t, node, bssid, rssi, level, x, y }
    this.meta = [];
    this.synthetic = false;
    this._tMin = Infinity;        // time span of the sensor rows
    this._tMax = -Infinity;
    this._surveyMin = Infinity;   // time span of the walk-test rows
    this._surveyMax = -Infinity;
    this.count = 0;
    this.rejected = 0;
  }

  /**
   * Oldest and newest time of the record. Walk-test rows are places, not a time series: they
   * do not move the time window of the page, unless the record holds nothing else.
   */
  get tMin() { return Number.isFinite(this._tMin) ? this._tMin : this._surveyMin; }
  get tMax() { return Number.isFinite(this._tMax) ? this._tMax : this._surveyMax; }

  /** Add one row. Rows may arrive slightly out of order; they are inserted in time order. */
  add(row) {
    if (!row || typeof row !== 'object') { this.rejected++; return false; }
    if (row.kind === 'meta') { this.meta.push(row); if (row.synthetic) this.synthetic = true; return true; }
    const t = Date.parse(row.time);
    if (!Number.isFinite(t) || !row.node_id) { this.rejected++; return false; }
    if (row.synthetic) this.synthetic = true;
    const kind = row.kind || 'scan';
    if (kind === 'scan') {
      if (!row.bssid || !Number.isFinite(row.rssi_dbm)) { this.rejected++; return false; }
      const bssid = row.bssid.toLowerCase();
      if (Number.isFinite(row.pos_x) && Number.isFinite(row.pos_y) && row.pos_level != null) {
        // a walk-test row carries its own position and does not join a fixed node's time series
        this.survey.push({ t, node: row.node_id, bssid, rssi: row.rssi_dbm, level: String(row.pos_level), x: row.pos_x, y: row.pos_y, ...(row.synthetic ? { synthetic: true } : {}) });
        this._noteBssid(bssid, row, t);
        if (t < this._surveyMin) this._surveyMin = t;
        if (t > this._surveyMax) this._surveyMax = t;
        this.count++;
        return true;
      }
      const key = `${row.node_id}|${bssid}`;
      let s = this.series.get(key);
      if (!s) {
        s = { node: row.node_id, bssid, t: [], rssi: [], noise: [], assoc: [] };
        this.series.set(key, s);
        if (!this.byNode.has(row.node_id)) this.byNode.set(row.node_id, new Map());
        this.byNode.get(row.node_id).set(bssid, s);
      }
      const at = insertIndex(s.t, t);
      s.t.splice(at, 0, t);
      s.rssi.splice(at, 0, row.rssi_dbm);
      s.noise.splice(at, 0, Number.isFinite(row.noise_dbm) ? row.noise_dbm : NaN);
      s.assoc.splice(at, 0, row.associated ? 1 : 0);
      this._noteBssid(bssid, row, t);
    } else if (kind === 'probe') {
      const key = `${row.node_id}|${row.target}`;
      let p = this.probes.get(key);
      if (!p) { p = { node: row.node_id, target: row.target, t: [], latency: [], jitter: [], loss: [], throughput: [] }; this.probes.set(key, p); }
      const at = insertIndex(p.t, t);
      p.t.splice(at, 0, t);
      p.latency.splice(at, 0, row.latency_ms ?? NaN);
      p.jitter.splice(at, 0, row.jitter_ms ?? NaN);
      p.loss.splice(at, 0, row.loss_pct ?? NaN);
      p.throughput.splice(at, 0, row.throughput_mbps ?? NaN);
    } else if (kind === 'status') {
      let st = this.status.get(row.node_id);
      if (!st) { st = { t: [], online: [] }; this.status.set(row.node_id, st); }
      const at = insertIndex(st.t, t);
      st.t.splice(at, 0, t);
      st.online.splice(at, 0, row.online ? 1 : 0);
    } else { this.rejected++; return false; }
    this._span(t);
    return true;
  }

  _span(t) {
    if (t < this._tMin) this._tMin = t;
    if (t > this._tMax) this._tMax = t;
    this.count++;
  }

  _noteBssid(bssid, row, t) {
    const info = this.bssids.get(bssid) || { bssid, ssid: '', band: String(row.band), channel: row.channel, count: 0, lastT: 0, maxRssi: -200, hearers: new Set() };
    if (row.ssid) info.ssid = row.ssid;
    if (row.band) info.band = String(row.band);
    if (row.channel) info.channel = row.channel;
    info.count++;
    info.lastT = Math.max(info.lastT, t);
    info.maxRssi = Math.max(info.maxRssi, row.rssi_dbm);
    info.hearers.add(row.node_id);
    this.bssids.set(bssid, info);
  }

  addAll(rows) { for (const r of rows) this.add(r); return this; }

  nodeIds() {
    return [...new Set([...this.byNode.keys(), ...this.status.keys(), ...[...this.probes.values()].map((p) => p.node)])];
  }

  /** Latest reading of one node for one BSSID at time t, or null when older than maxAgeMs. */
  latest(node, bssid, t, maxAgeMs = Infinity) {
    const s = this.byNode.get(node)?.get(bssid);
    if (!s) return null;
    const i = lastAtOrBefore(s.t, t);
    if (i < 0 || t - s.t[i] > maxAgeMs) return null;
    return { t: s.t[i], rssi: s.rssi[i], noise: s.noise[i], assoc: !!s.assoc[i], bssid };
  }

  /** The BSSID the node is attached to at time t, with that reading. Null when unknown or stale. */
  attachment(node, t, maxAgeMs = Infinity) {
    const map = this.byNode.get(node);
    if (!map) return null;
    let best = null;
    for (const s of map.values()) {
      const i = lastAtOrBefore(s.t, t);
      if (i < 0 || t - s.t[i] > maxAgeMs || !s.assoc[i]) continue;
      if (!best || s.t[i] > best.t) best = { t: s.t[i], rssi: s.rssi[i], noise: s.noise[i], assoc: true, bssid: s.bssid };
    }
    return best;
  }

  /** Time of the newest row of any kind from this node at or before t. */
  lastHeard(node, t) {
    let last = -Infinity;
    const map = this.byNode.get(node);
    if (map) for (const s of map.values()) { const i = lastAtOrBefore(s.t, t); if (i >= 0 && s.t[i] > last) last = s.t[i]; }
    for (const p of this.probes.values()) if (p.node === node) { const i = lastAtOrBefore(p.t, t); if (i >= 0 && p.t[i] > last) last = p.t[i]; }
    return last;
  }

  /** Explicit status at time t: true, false, or null when the node never sent a status row. */
  onlineFlag(node, t) {
    const st = this.status.get(node);
    if (!st) return null;
    const i = lastAtOrBefore(st.t, t);
    return i < 0 ? null : !!st.online[i];
  }

  /** Median RSSI over the whole record, per node and BSSID. Used for calibration. */
  medians(from = -Infinity, to = Infinity) {
    const out = [];
    for (const s of this.series.values()) {
      const vals = [];
      for (let i = 0; i < s.t.length; i++) if (s.t[i] >= from && s.t[i] <= to) vals.push(s.rssi[i]);
      if (vals.length) out.push({ node: s.node, bssid: s.bssid, rssi: median(vals), count: vals.length });
    }
    return out;
  }

  latestProbe(node, target, t, maxAgeMs = Infinity) {
    const p = this.probes.get(`${node}|${target}`);
    if (!p) return null;
    const i = lastAtOrBefore(p.t, t);
    if (i < 0 || t - p.t[i] > maxAgeMs) return null;
    return { t: p.t[i], latency: p.latency[i], jitter: p.jitter[i], loss: p.loss[i], throughput: p.throughput[i] };
  }
}

function insertIndex(t, value) {
  const n = t.length;
  if (n === 0 || t[n - 1] <= value) return n;
  return lastAtOrBefore(t, value) + 1;
}
