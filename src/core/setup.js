// The user's own networks and devices: the document that the Setup panel edits.
// See docs/network-setup.md.
//
//   setup = { schemaVersion, saved, floorplan, networks: [...], devices: [...] }
//   network = { id, label, ssid, color, upstream }
//   device  = { id, type, label, position, mount,
//               network, model, tx_dbm, channel, bssid, enclosureLossDb   (emitters)
//               mac }                                                     (receivers)
//   position = { level, x, y, z?, heightSource?, source? } or null (not placed yet)
//
// Pure functions: browser and Node. The local server uses the same checks before it writes.

export const SETUP_VERSION = 1;
export const LIMITS = { networks: 16, devices: 200 };

/** role: an emitter sends (it becomes an access point of the model), a receiver listens (a node). */
export const DEVICE_TYPES = [
  { id: 'ap', role: 'emitter', label: 'Access point or router', word: 'Access point' },
  { id: 'mesh', role: 'emitter', label: 'Mesh point', word: 'Mesh point' },
  { id: 'esp32', role: 'receiver', label: 'ESP32 sensor', word: 'ESP32 sensor' },
  { id: 'pi', role: 'receiver', label: 'Raspberry Pi sensor', word: 'Pi sensor' },
  { id: 'client', role: 'receiver', label: 'Client (phone, laptop, TV)', word: 'Client' },
  { id: 'wired', role: 'receiver', label: 'Wired reference', word: 'Wired reference' },
];
const TYPE = new Map(DEVICE_TYPES.map((t) => [t.id, t]));
export const roleOf = (type) => TYPE.get(type)?.role || null;
export const isEmitter = (device) => roleOf(device?.type) === 'emitter';

/** Where a device sits. z is the usual height above the floor in metres; null means "just under the ceiling". */
export const MOUNTS = [
  { id: 'shelf', label: 'Table or shelf', z: 0.9 },
  { id: 'floor', label: 'On the floor', z: 0.1 },
  { id: 'wall', label: 'On the wall', z: 1.6 },
  { id: 'ceiling', label: 'On the ceiling', z: null },
];
export function mountHeight(mount, levelHeight = 2.5) {
  const m = MOUNTS.find((x) => x.id === mount);
  if (!m) return null;
  return m.z === null ? Math.max(0.5, Math.round((levelHeight - 0.1) * 100) / 100) : m.z;
}

/** Colours for networks, in order. The first two are the colours the page always used. */
export const NETWORK_COLORS = ['#ff9d6e', '#7cc7ff', '#b79cff', '#7fe0b0', '#ffd166', '#ff8fb8', '#9ad0c2', '#c9d6ea'];
/** { networkId: colour } for a config: the colour of the network when it has one, else by its place in the list. */
export function networkColors(networks) {
  return Object.fromEntries(Object.entries(networks || {}).map(([id, n], i) => [id, isColor(n?.color) ? n.color : NETWORK_COLORS[i % NETWORK_COLORS.length]]));
}

const ID = /^[\w.-]{1,40}$/;
// an id is a text; "__proto__" cannot be a key of the network list, and "best" is the choice "best of all networks"
const validId = (v, reserved = []) => typeof v === 'string' && ID.test(v) && v !== '__proto__' && !reserved.includes(v);
const MAC = /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i;
const isMac = (v) => typeof v === 'string' && MAC.test(v);
const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const text = (v, max) => typeof v === 'string' && v.length <= max;
const round = (v, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

/** "AA-BB-CC-00-11-22", "aabbcc001122" or "aa:bb:cc:00:11:22" to the lower-case colon form; null when it is no MAC address. */
export function normalizeMac(value) {
  const hex = String(value ?? '').trim().toLowerCase().replace(/[:\-.\s]/g, '');
  return /^[0-9a-f]{12}$/.test(hex) ? hex.match(/../g).join(':') : null;
}

/** A free id like "ap-3": the prefix and the first number that no other id uses. */
export function nextId(prefix, taken) {
  const used = new Set(taken);
  for (let n = 1; ; n++) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

function cleanPosition(p) {
  if (!p) return null;
  const out = { level: p.level, x: round(p.x), y: round(p.y) };
  if (Number.isFinite(p.z)) { out.z = round(p.z); out.heightSource = p.heightSource === 'measured' ? 'measured' : 'assumed'; }
  if (text(p.source, 80) && p.source) out.source = p.source;
  return out;
}

/**
 * A mount of the setup for the mount text of a config ("inside a cabinet", "on a table against the wall").
 * The config text is free, the setup knows only MOUNTS; a cabinet, table, console or shelf is "shelf".
 */
export function mountOf(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim().toLowerCase();
  if (MOUNTS.some((m) => m.id === v)) return v;
  if (/ceiling/.test(v)) return 'ceiling';
  if (/\bon the floor\b|^floor\b/.test(v)) return 'floor';
  if (/\b(on|mounted on) the wall\b|wall[- ]mounted/.test(v)) return 'wall';
  return 'shelf';
}

/** Start a setup from what the page shows now: the networks and access points of the config and the node list. */
export function setupFromConfig(config, nodes, floorplan = config?.paths?.floorplan || '') {
  const colors = networkColors(config.networks);
  const networks = Object.entries(config.networks || {}).map(([id, n]) => ({ id, label: n.label || id, ssid: n.ssid || '', color: colors[id], upstream: n.upstream || null }));
  const devices = [];
  for (const ap of config.aps || []) {
    const d = {
      id: ap.id, type: ap.kind === 'mesh' ? 'mesh' : 'ap', label: ap.label || ap.id, network: ap.network || '', model: ap.model || '',
      tx_dbm: { ...(ap.tx_dbm_nominal || ap.tx_dbm || {}) }, channel: { ...(ap.channel || {}) }, bssid: { ...(ap.bssid || {}) },
      position: cleanPosition(ap.position),
    };
    const mount = mountOf(ap.position?.mount);
    if (mount) d.mount = mount;
    if (ap.enclosure?.lossDb > 0) { d.enclosureLossDb = ap.enclosure.lossDb; d.enclosureSource = ap.enclosure.source === 'measured' ? 'measured' : 'assumed'; }
    devices.push(d);
  }
  for (const node of nodes || []) {
    if (roleOf(node.type) !== 'receiver') continue;      // a walk-test phone ("survey") is no device of the setup
    const position = cleanPosition(node.position);
    if (position && node.positionSource && !position.source) position.source = node.positionSource;
    devices.push({ id: node.id, type: node.type, label: node.name || node.id, mac: node.mac || '', position });
  }
  return { schemaVersion: SETUP_VERSION, floorplan, networks, devices };
}

/**
 * Put a setup into the configuration. Networks, access points and nodes are replaced as a
 * whole, so what the user removed stays removed. An emitter that is not placed, or that
 * stands on a level this plan does not have, keeps position null: the model leaves it out.
 * Returns { config, nodes }.
 */
export function applySetup(config, nodes, setup, { levelIds = [], bandIds = [], defaultTxDbm = 20 } = {}) {
  const onPlan = (p) => (p && levelIds.includes(p.level) ? p : null);
  const networks = {};
  const hasNetwork = (id) => typeof id === 'string' && Object.hasOwn(networks, id);
  for (const n of setup.networks || []) networks[n.id] = { label: n.label || n.id, ssid: n.ssid || '', upstream: n.upstream && n.upstream !== n.id ? n.upstream : null, color: n.color };
  const aps = [], out = [];
  for (const d of setup.devices || []) {
    const p = onPlan(d.position);
    if (isEmitter(d)) {
      const nominal = Object.fromEntries(bandIds.map((b) => [b, Number.isFinite(d.tx_dbm?.[b]) ? d.tx_dbm[b] : defaultTxDbm]));
      const loss = Number.isFinite(d.enclosureLossDb) && d.enclosureLossDb > 0 ? d.enclosureLossDb : 0;
      const ap = {
        id: d.id, kind: d.type, label: d.label || d.id, network: hasNetwork(d.network) ? d.network : '', model: d.model || '',
        tx_dbm: loss ? Object.fromEntries(Object.entries(nominal).map(([b, v]) => [b, v - loss])) : nominal,
        channel: { ...(d.channel || {}) },
        bssid: Object.fromEntries(Object.entries(d.bssid || {}).filter(([, v]) => v)),
        position: p ? { ...p, source: p.source || 'placed', ...(d.mount ? { mount: d.mount } : {}) } : null,
      };
      if (loss) { ap.tx_dbm_nominal = nominal; ap.enclosure = { lossDb: loss, source: d.enclosureSource === 'measured' ? 'measured' : 'assumed' }; }
      aps.push(ap);
    } else if (roleOf(d.type) === 'receiver') {
      out.push({ id: d.id, name: d.label || d.id, type: d.type, ...(d.mac ? { mac: d.mac } : {}), position: p ? { level: p.level, x: p.x, y: p.y, ...(Number.isFinite(p.z) ? { z: p.z } : {}) } : null, ...(p?.source ? { positionSource: p.source } : {}) });
    }
  }
  const taken = new Set(out.map((n) => n.id));
  for (const node of nodes || []) if (roleOf(node.type) !== 'receiver' && !taken.has(node.id)) out.push(node);
  return { config: { ...config, networks, aps }, nodes: out };
}

/** What is wrong with a setup, as sentences. An empty list means it can be used and saved. */
export function validateSetup(setup) {
  const bad = [];
  if (!setup || typeof setup !== 'object' || Array.isArray(setup)) return ['the setup must be an object'];
  if (!Array.isArray(setup.networks) || !Array.isArray(setup.devices)) return ['the setup needs a "networks" list and a "devices" list'];
  if (setup.networks.length > LIMITS.networks) bad.push(`at most ${LIMITS.networks} networks`);
  if (setup.devices.length > LIMITS.devices) bad.push(`at most ${LIMITS.devices} devices`);
  if (setup.floorplan !== undefined && !text(setup.floorplan, 200)) bad.push('floorplan must be a short text');
  const netIds = new Set();
  for (const n of setup.networks) {
    if (!n || typeof n !== 'object' || !validId(n.id, ['best'])) { bad.push('a network has no usable id (letters, digits, dot, dash, underscore; at most 40; not "best")'); continue; }
    const where = `network "${n.id}"`;
    if (netIds.has(n.id)) bad.push(`${where} is listed twice`);
    netIds.add(n.id);
    if (!text(n.label ?? '', 60)) bad.push(`${where}: the name must be a text of at most 60 characters`);
    if (!text(n.ssid ?? '', 32)) bad.push(`${where}: an SSID has at most 32 characters`);
    if (n.color !== undefined && !isColor(n.color)) bad.push(`${where}: the colour must look like #7cc7ff`);
    if (n.upstream != null && !validId(n.upstream)) bad.push(`${where}: upstream must be the id of a network`);
  }
  const devIds = new Set();
  for (const d of setup.devices) {
    if (!d || typeof d !== 'object' || !validId(d.id)) { bad.push('a device has no usable id (letters, digits, dot, dash, underscore; at most 40)'); continue; }
    const where = `device "${d.id}"`;
    if (devIds.has(d.id)) bad.push(`${where} is listed twice`);
    devIds.add(d.id);
    if (!TYPE.has(d.type)) { bad.push(`${where}: type must be one of ${DEVICE_TYPES.map((t) => t.id).join(', ')}`); continue; }
    if (!text(d.label ?? '', 60)) bad.push(`${where}: the name must be a text of at most 60 characters`);
    if (!text(d.model ?? '', 60)) bad.push(`${where}: the model must be a text of at most 60 characters`);
    if (d.network !== undefined && d.network !== '' && !netIds.has(d.network)) bad.push(`${where}: its network is not in the list`);
    if (d.mount !== undefined && !MOUNTS.some((m) => m.id === d.mount)) bad.push(`${where}: mount must be one of ${MOUNTS.map((m) => m.id).join(', ')}`);
    if (d.mac !== undefined && d.mac !== '' && !isMac(d.mac)) bad.push(`${where}: the MAC address must look like aa:bb:cc:dd:ee:ff`);
    if (d.enclosureLossDb !== undefined && !(Number.isFinite(d.enclosureLossDb) && d.enclosureLossDb >= 0 && d.enclosureLossDb < 60)) bad.push(`${where}: cabinet loss must be 0 to 60 dB`);
    for (const [key, ok, what] of [
      ['tx_dbm', (v) => Number.isFinite(v) && v >= -20 && v <= 36, 'transmit power must be -20 to 36 dBm'],
      ['channel', (v) => Number.isInteger(v) && v >= 1 && v <= 233, 'a channel is a whole number from 1 to 233'],
      ['bssid', (v) => v === '' || isMac(v), 'a BSSID must look like aa:bb:cc:dd:ee:ff'],
    ]) {
      const map = d[key];
      if (map === undefined) continue;
      if (!map || typeof map !== 'object' || Array.isArray(map)) { bad.push(`${where}: ${key} must be an object with one value per band`); continue; }
      for (const [band, v] of Object.entries(map)) if (!/^[\d.]{1,6}$/.test(band) || !ok(v)) bad.push(`${where}, band ${band}: ${what}`);
    }
    const p = d.position;
    if (p != null) {
      if (typeof p !== 'object' || typeof p.level !== 'string' || !/^[\w.-]{1,12}$/.test(p.level) || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 500 || Math.abs(p.y) > 500) bad.push(`${where}: a position needs a level id and x and y in metres`);
      else if (p.z !== undefined && !(Number.isFinite(p.z) && p.z >= 0 && p.z < 20)) bad.push(`${where}: the height must be 0 to 20 m`);
    }
  }
  return bad;
}

/** A copy of a valid setup with only the known fields, numbers rounded and BSSIDs in lower case. This is what gets saved. */
export function cleanSetup(setup, saved = new Date().toISOString()) {
  const perBand = (map, fn) => Object.fromEntries(Object.entries(map || {}).filter(([, v]) => v !== '' && v != null).map(([b, v]) => [b, fn(v)]));
  return {
    schemaVersion: SETUP_VERSION, saved, floorplan: String(setup.floorplan || ''),
    networks: setup.networks.map((n) => ({ id: n.id, label: n.label || '', ssid: n.ssid || '', ...(isColor(n.color) ? { color: n.color.toLowerCase() } : {}), upstream: n.upstream || null })),
    devices: setup.devices.map((d) => {
      const out = { id: d.id, type: d.type, label: d.label || '' };
      if (isEmitter(d)) {
        Object.assign(out, { network: d.network || '', model: d.model || '', tx_dbm: perBand(d.tx_dbm, Number), channel: perBand(d.channel, Number), bssid: perBand(d.bssid, (v) => String(v).toLowerCase()) });
        if (d.enclosureLossDb > 0) { out.enclosureLossDb = d.enclosureLossDb; out.enclosureSource = d.enclosureSource === 'measured' ? 'measured' : 'assumed'; }
      } else if (d.mac) out.mac = d.mac.toLowerCase();
      if (d.mount) out.mount = d.mount;
      out.position = cleanPosition(d.position);
      return out;
    }),
  };
}

/** A new device of a type with usual values: a name like "Access point 3", 20 dBm, the common channels. */
export function newDevice(type, setup, bandIds = []) {
  const info = TYPE.get(type) || TYPE.get('ap');
  const ids = setup.devices.map((d) => d.id);
  const count = setup.devices.filter((d) => d.type === info.id).length + 1;
  const names = new Set(setup.devices.map((d) => d.label));
  let n = count, label = `${info.word} ${n}`;
  while (names.has(label)) label = `${info.word} ${++n}`;
  const d = { id: nextId(info.role === 'emitter' ? 'ap' : info.id === 'wired' ? 'wired' : info.id === 'client' ? 'client' : 'sensor', ids), type: info.id, label, position: null };
  if (info.role === 'emitter') {
    const emitters = setup.devices.filter(isEmitter).length;
    Object.assign(d, {
      network: setup.networks[0]?.id || '', model: '', mount: 'shelf', bssid: {},
      tx_dbm: Object.fromEntries(bandIds.map((b) => [b, 20])),
      // 1, 6 and 11 do not overlap on 2.4 GHz; other bands get no channel until the user says one
      channel: Object.fromEntries(bandIds.filter((b) => b === '2.4' || b === '5').map((b) => [b, b === '2.4' ? [1, 6, 11][emitters % 3] : 36])),
    });
  } else d.mac = '';
  return d;
}

/**
 * The radios in scan rows (the log of tools\walk-sample.ps1 or of a sensor): one entry per
 * BSSID with its name, band, channel, strongest level and how often it was seen, strongest first.
 */
export function radiosFromScans(rows, limit = 400) {
  const seen = new Map();
  for (const r of rows || []) {
    const bssid = normalizeMac(r?.bssid);
    if (!bssid || r.kind === 'meta') continue;
    let e = seen.get(bssid);
    if (!e) seen.set(bssid, e = { bssid, ssid: '', band: '', channel: null, rssi_dbm: -200, count: 0 });
    e.count++;
    if (typeof r.ssid === 'string' && r.ssid) e.ssid = r.ssid.slice(0, 32);
    if (r.band != null) e.band = String(r.band);
    if (Number.isInteger(r.channel)) e.channel = r.channel;
    if (Number.isFinite(r.rssi_dbm) && r.rssi_dbm > e.rssi_dbm) e.rssi_dbm = r.rssi_dbm;
  }
  return [...seen.values()].sort((a, b) => b.rssi_dbm - a.rssi_dbm).slice(0, limit);
}

/** The scanned radios that can be the radio of a device: same SSID, same band, and no other device has that BSSID. */
export function scanCandidates(radios, setup, device, band) {
  const ssid = setup.networks.find((n) => n.id === device.network)?.ssid;
  if (!ssid) return [];
  const used = new Set();
  for (const d of setup.devices) for (const [b, v] of Object.entries(d.bssid || {})) if (v && !(d.id === device.id && b === band)) used.add(String(v).toLowerCase());
  return (radios || []).filter((r) => r.ssid === ssid && r.band === band && !used.has(r.bssid));
}
