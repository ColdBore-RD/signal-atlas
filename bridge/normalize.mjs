// Turns one MQTT message into one clean sample row, or says why it is rejected.
// Pure functions, so they are tested without a broker (tests/bridge.test.mjs).

export const TOPIC_ROOT = 'sensors/wifi-atlas';
export const SUBSCRIPTIONS = [`${TOPIC_ROOT}/+/scan`, `${TOPIC_ROOT}/+/status`];
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const BSSID = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);

/** { nodeId, channel: 'scan' | 'status' } for a topic of this project, else null. */
export function parseTopic(topic) {
  const parts = String(topic).split('/');
  if (parts.length !== 4 || `${parts[0]}/${parts[1]}` !== TOPIC_ROOT) return null;
  if (!NODE_ID.test(parts[2]) || (parts[3] !== 'scan' && parts[3] !== 'status')) return null;
  return { nodeId: parts[2], channel: parts[3] };
}

/**
 * Returns { row } or { error }.
 * The node id always comes from the topic, because the broker's access rules bind a
 * topic to an account; a payload cannot claim to be another node.
 * A row without a time gets the arrival time (ESP32 nodes before their clock is set).
 */
export function normalize(topic, payload, nowMs = Date.now()) {
  const where = parseTopic(topic);
  if (!where) return { error: 'topic is not sensors/wifi-atlas/<node-id>/scan or /status' };
  let data;
  try { data = JSON.parse(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8')); } catch { return { error: 'payload is not JSON' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'payload is not a JSON object' };
  const t = typeof data.time === 'string' ? Date.parse(data.time) : NaN;
  // a clock that is more than a day off is treated as not set
  const time = new Date(Number.isFinite(t) && Math.abs(t - nowMs) < 24 * 3600e3 ? t : nowMs).toISOString().replace('.000Z', 'Z');
  const row = { time, node_id: where.nodeId };

  if (where.channel === 'status') {
    if (typeof data.online !== 'boolean') return { error: 'status needs "online": true or false' };
    return { row: { ...row, kind: 'status', online: data.online } };
  }
  const kind = data.kind === 'probe' ? 'probe' : 'scan';
  row.kind = kind;
  if (kind === 'scan') {
    const bssid = String(data.bssid || '').toLowerCase();
    if (!BSSID.test(bssid)) return { error: 'scan row needs a bssid like aa:bb:cc:dd:ee:ff' };
    const rssi = num(data.rssi_dbm, -120, 0);
    if (rssi === undefined) return { error: 'scan row needs rssi_dbm between -120 and 0' };
    const band = String(data.band);
    if (band !== '2.4' && band !== '5') return { error: 'band must be "2.4" or "5"' };
    Object.assign(row, { bssid, ssid: typeof data.ssid === 'string' ? data.ssid.slice(0, 64) : '', band, rssi_dbm: rssi });
    const channel = num(data.channel, 1, 177);
    if (channel !== undefined) row.channel = Math.round(channel);
    const noise = num(data.noise_dbm, -120, 0);
    if (noise !== undefined) row.noise_dbm = noise;
    if (data.associated === true) row.associated = true;
    for (const key of ['pos_x', 'pos_y']) { const v = num(data[key], -1000, 1000); if (v !== undefined) row[key] = v; }
    if (typeof data.pos_level === 'string' && data.pos_level.length <= 8) row.pos_level = data.pos_level;
  } else {
    if (typeof data.target !== 'string' || !NODE_ID.test(data.target)) return { error: 'probe row needs a target name' };
    row.target = data.target;
    if (typeof data.bssid === 'string' && BSSID.test(data.bssid.toLowerCase())) row.bssid = data.bssid.toLowerCase();
    if (data.band === '2.4' || data.band === '5') row.band = data.band;
  }
  const extras = { latency_ms: [0, 60000], jitter_ms: [0, 60000], loss_pct: [0, 100], throughput_mbps: [0, 100000] };
  for (const [key, [lo, hi]] of Object.entries(extras)) { const v = num(data[key], lo, hi); if (v !== undefined) row[key] = v; }
  return { row };
}
