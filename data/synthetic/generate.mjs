#!/usr/bin/env node
// Synthetic data generator for Signal Atlas.
//
//   node data/synthetic/generate.mjs             writes the public demo set in data/synthetic/
//                                                (floorplan.json, nodes.json, samples.ndjson)
//   node data/synthetic/generate.mjs --private   reads data/private/floorplan.json and
//                                                data/private/config.local.json and writes
//                                                data/private/nodes.json and
//                                                data/private/samples.synthetic.ndjson
//
// The samples cover 24 hours and contain, on purpose: a dead zone (it follows from
// the geometry), two microwave-oven interference bursts on 2.4 GHz, one sensor
// that goes offline for part of the afternoon, evening congestion on the probes,
// phones that roam between mesh points, and a walk test with a phone.
//
// The hidden "real world" is data/synthetic/truth.json. It is not the same as the
// assumptions in data/materials.json, so the page has to calibrate.
// Nothing here touches a network. With --private nothing private is printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyntheticHouse } from './house.mjs';
import { mergeConfig, applyApPositions } from '../../src/core/config.js';
import { validateFloorplan, formatIssues } from '../../src/core/validate.js';
import { buildModelContext, traceLink, priorParams, linkRssi } from '../../src/core/propagation.js';
import { sortedLevels, polygonArea, interiorPoint, pointInPolygon, bounds } from '../../src/core/geometry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const PRIVATE = process.argv.includes('--private');

// ---- deterministic random numbers -------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function gaussian(rand) { let u = 0, v = 0; while (u === 0) u = rand(); while (v === 0) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

// ---- inputs ------------------------------------------------------------------------
const truth = readJson('data/synthetic/truth.json');
const materials = readJson('data/materials.json');
const schema = readJson('data/schema/floorplan.schema.json');
let config = readJson('data/config.default.json');
let plan, outDir, sampleFile;

if (PRIVATE) {
  if (!exists('data/private/floorplan.json')) { console.error('data/private/floorplan.json is missing. Nothing to do.'); process.exit(1); }
  if (exists('data/private/config.local.json')) config = mergeConfig(config, readJson('data/private/config.local.json'));
  plan = readJson('data/private/floorplan.json');
  // the saved marker positions win over the positions in the config, as they do in the page
  const apFile = config.paths?.apPositions;
  if (apFile && exists(apFile)) config = { ...config, aps: applyApPositions(config.aps, readJson(apFile), plan.levels.map((l) => l.id)) };
  outDir = 'data/private';
  sampleFile = 'samples.synthetic.ndjson';
} else {
  plan = buildSyntheticHouse(readJson('data/synthetic/house-rules.json'));
  outDir = 'data/synthetic';
  sampleFile = 'samples.ndjson';
}
const check = validateFloorplan(plan, schema, materials);
if (check.errors.length) { console.error('The floor plan is not valid:\n  ' + formatIssues(check.errors).join('\n  ')); process.exit(1); }
if (!PRIVATE) fs.writeFileSync(path.join(ROOT, outDir, 'floorplan.json'), JSON.stringify(plan, null, 1).replace(/\[\s+(-?[\d.]+),\s+(-?[\d.]+)\s+\]/g, '[$1, $2]') + '\n');

const rand = mulberry32(truth.seed);
const levels = sortedLevels(plan);
const levelIds = levels.map((l) => l.id);
const mainLevel = levels.reduce((best, l) => (Math.abs(l.elevation) < Math.abs(best.elevation) ? l : best), levels[0]);
const ctx = buildModelContext(plan, materials);
const aps = config.aps.filter((ap) => levelIds.includes(ap.position.level));
if (aps.length !== config.aps.length) console.warn('Some access points sit on a level that the floor plan does not have. They were skipped.');

// ---- nodes ---------------------------------------------------------------------------
const roomsOf = (level) => (level.rooms || []).map((room) => ({ room, level, area: polygonArea(room.polygon), point: interiorPoint(room.polygon, 0.3) }))
  .sort((a, b) => b.area - a.area);
const pos = (entry, dx = 0, dy = 0) => {
  let x = entry.point[0] + dx, y = entry.point[1] + dy;
  if (!pointInPolygon(x, y, entry.room.polygon)) { x = entry.point[0]; y = entry.point[1]; }
  return { level: entry.level.id, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
};
const fakeMac = (tag) => { const h = hashString(`${truth.seed}:${tag}`); return ['02', 'a7', (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255].map((b) => (typeof b === 'string' ? b : b.toString(16).padStart(2, '0'))).join(':'); };

const nodes = [];
let espCount = 0;
const named = (entry, re) => re.test(entry.room.name);
const mainRooms = roomsOf(mainLevel);
const garage = mainRooms.find((e) => named(e, /garage/i));
const kitchen = mainRooms.find((e) => named(e, /kitchen/i)) || mainRooms[1] || mainRooms[0];
for (const level of levels) {
  const rooms = roomsOf(level).filter((e) => e.area >= 5);
  const picks = rooms.filter((e) => e !== kitchen || level !== mainLevel).slice(0, level === mainLevel ? 4 : 3);
  for (const entry of picks) {
    espCount++;
    const id = `esp32-${String(espCount).padStart(2, '0')}`;
    nodes.push({ id, name: `ESP32 ${entry.room.name}`, type: 'esp32', mac: fakeMac(id), bands: ['2.4'], position: pos(entry, 0.4, -0.3), positionSource: 'synthetic', room: entry.room.id });
  }
}
nodes.push({ id: 'pi-500', name: `Pi sensor ${kitchen.room.name}`, type: 'pi', mac: fakeMac('pi-500'), bands: ['2.4', '5'], position: pos(kitchen, -0.5, 0.4), positionSource: 'synthetic', room: kitchen.room.id });
const offlineNode = nodes.find((n) => garage && n.room === garage.room.id) || nodes.find((n) => n.type === 'esp32' && n.position.level === mainLevel.id);

const lowest = roomsOf(levels[0]);
const utility = lowest.filter((e) => e.area >= 4).slice(-1)[0] || lowest[0];
const WIRED_NAMES = { 'home-server': 'Home server', nas: 'NAS' };
(config.wiredReferences || ['home-server', 'nas']).forEach((id, i) => {
  nodes.push({ id, name: WIRED_NAMES[id] || id[0].toUpperCase() + id.slice(1), type: 'wired', position: pos(utility, 0.5 * i - 0.25, 0.3), positionSource: 'guess', room: utility.room.id });
});
const second = mainRooms.filter((e) => e !== garage)[0] || mainRooms[0];
const homeAp = aps.find((a) => a.network === 'home') || aps[0];
const nearHome = mainRooms.slice().sort((a, b) => Math.hypot(a.point[0] - homeAp.position.x, a.point[1] - homeAp.position.y) - Math.hypot(b.point[0] - homeAp.position.x, b.point[1] - homeAp.position.y))[0];
const clients = [
  { id: 'tv-main', name: 'Living room TV', type: 'client', bands: ['2.4', '5'], position: pos(second, 1.2, 0.9), positionSource: 'guess', prefer: 'mesh' },
  { id: 'printer', name: 'Printer', type: 'client', bands: ['2.4'], position: pos(nearHome, -0.6, 0.8), positionSource: 'guess', prefer: 'home' },
  { id: 'webcam', name: 'Webcam', type: 'client', bands: ['2.4'], position: pos(garage || mainRooms[mainRooms.length - 1], -0.8, 0.6), positionSource: 'guess', prefer: 'mesh' },
  { id: 'speaker-kitchen', name: 'Kitchen smart speaker', type: 'client', bands: ['2.4', '5'], position: pos(kitchen, 0.6, -0.5), positionSource: 'guess', prefer: 'mesh' },
  { id: 'thermostat', name: 'Thermostat', type: 'client', bands: ['2.4'], position: pos(second, -1.0, -0.4), positionSource: 'guess', prefer: 'home' },
  { id: 'console', name: 'Game console', type: 'client', bands: ['2.4', '5'], position: pos(second, 1.6, 0.6), positionSource: 'guess', prefer: 'mesh' },
  { id: 'phone-1', name: 'Phone 1', type: 'client', bands: ['2.4', '5'], position: null, positionSource: 'unknown', prefer: 'mesh', roams: true },
  { id: 'phone-2', name: 'Phone 2', type: 'client', bands: ['2.4', '5'], position: null, positionSource: 'unknown', prefer: 'mesh', roams: true },
  { id: 'tablet-1', name: 'Tablet', type: 'client', bands: ['2.4', '5'], position: null, positionSource: 'unknown', prefer: 'mesh', roams: true },
  { id: 'laptop-1', name: 'Laptop', type: 'client', bands: ['2.4', '5'], position: null, positionSource: 'unknown', prefer: 'home', roams: true },
];
for (const c of clients) nodes.push({ id: c.id, name: c.name, type: 'client', mac: fakeMac(c.id), bands: c.bands, position: c.position, positionSource: c.positionSource, ...(c.position ? {} : { note: 'position unknown: shown in the roaming tray' }) });
nodes.push({ id: 'survey-phone', name: 'Walk-test phone', type: 'survey', mac: fakeMac('survey-phone'), bands: ['2.4', '5'], position: null, positionSource: 'per-sample' });

// ---- the hidden real world ---------------------------------------------------------------
const trueParams = {};
for (const band of ['2.4', '5']) {
  const p = priorParams(ctx, band);
  p.n = truth.n[band];
  p.loss = p.loss.map((v, f) => v * (truth.lossFactor[ctx.featureNames[f]] ?? 1));
  p.apOffset = truth.apOffsetDb;
  trueParams[band] = p;
}
const shadowCache = new Map();
/** Static shadowing: the same place and BSSID always gets the same offset. */
function shadow(tag) {
  if (!shadowCache.has(tag)) shadowCache.set(tag, gaussian(mulberry32(hashString(`${truth.seed}|${tag}`))) * truth.shadowSigmaDb);
  return shadowCache.get(tag);
}
const counts = new Float32Array(ctx.featureCount);
function trueRssi(ap, band, at, tag) {
  counts.fill(0);
  const d = traceLink(ctx, ap.position, at, counts);
  return linkRssi(trueParams[band], ap.tx_dbm[band], ap.id, d, counts) + shadow(`${tag}|${ap.id}|${band}`);
}

// ---- time ------------------------------------------------------------------------------
const t0 = Date.parse(truth.start);
const steps = Math.round((truth.hours * 3600) / truth.stepSeconds);
const localMinutes = (t) => (((t - t0) / 60000 + ((Date.parse(truth.start) / 3600000 + truth.localOffsetHours) % 24) * 60) % 1440 + 1440) % 1440;
const hm = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
const within = (t, from, to) => { const m = localMinutes(t); return m >= hm(from) && m < hm(to); };
const iso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');
const microwaveAt = { level: kitchen.level.id, x: kitchen.point[0], y: kitchen.point[1] };
function microwaveRise(t, at) {
  if (!truth.microwave.bursts.some(([a, b]) => within(t, a, b))) return 0;
  const sameFloor = at.level === microwaveAt.level;
  const d = Math.hypot(at.x - microwaveAt.x, at.y - microwaveAt.y);
  return Math.max(0, truth.microwave.peakRiseDb - truth.microwave.fallDbPerMetre * d - (sameFloor ? 0 : truth.microwave.otherFloorDb)) * (0.8 + 0.4 * rand());
}

const rows = [];
const ssidOf = (ap) => config.networks[ap.network].ssid;
const scanRow = (t, node, ap, band, rssi, noise, associated) => ({
  time: iso(t), node_id: node, kind: 'scan', bssid: ap.bssid[band].toLowerCase(), ssid: ssidOf(ap), band, channel: ap.channel[band],
  rssi_dbm: Math.round(rssi * 10) / 10, noise_dbm: Math.round(noise * 10) / 10, ...(associated ? { associated: true } : {}),
});

// roaming clients follow a daily routine through rooms; the page never learns these positions
const allRooms = levels.flatMap((l) => roomsOf(l)).filter((e) => e.area >= 5);
function routinePosition(clientIndex, t) {
  const slot = Math.floor(localMinutes(t) / 90);
  const r = mulberry32(hashString(`${truth.seed}|routine|${clientIndex}|${slot}`));
  const entry = allRooms[Math.floor(r() * allRooms.length)];
  return { level: entry.level.id, x: entry.point[0] + (r() - 0.5), y: entry.point[1] + (r() - 0.5) };
}

const attached = new Map(); // node -> { ap, band }
function chooseAttachment(nodeId, bands, at, tag, prefer) {
  const options = [];
  for (const ap of aps) {
    if (prefer && ap.network !== prefer) continue;
    for (const band of bands) options.push({ ap, band, rssi: trueRssi(ap, band, at, tag) });
  }
  const score = (o) => o.rssi + (o.band === '5' && o.rssi > -70 ? 12 : 0);
  options.sort((a, b) => score(b) - score(a));
  const current = attached.get(nodeId);
  const cur = current && options.find((o) => o.ap.id === current.ap.id && o.band === current.band);
  const pick = cur && score(cur) > score(options[0]) - 8 && cur.rssi > -80 ? cur : options[0];
  attached.set(nodeId, pick);
  return pick;
}

let offlineWritten = false, onlineWritten = false;
for (let s = 0; s < steps; s++) {
  const t = t0 + s * truth.stepSeconds * 1000;
  const busy = localMinutes(t) > 7 * 60 && localMinutes(t) < 23 * 60 ? 1.25 : 0.8; // people move around in the day
  for (const node of nodes) {
    if (node.type === 'wired' || node.type === 'survey') continue;
    const jitterT = t + Math.floor(rand() * 20000);
    if (node === offlineNode && within(t, truth.offline.from, truth.offline.to)) {
      if (!offlineWritten) { rows.push({ time: iso(t + 120000), node_id: node.id, kind: 'status', online: false }); offlineWritten = true; }
      continue;
    }
    if (node === offlineNode && offlineWritten && !onlineWritten) { rows.push({ time: iso(t - 5000), node_id: node.id, kind: 'status', online: true }); onlineWritten = true; }
    const isClient = node.type === 'client';
    const client = isClient ? clients.find((c) => c.id === node.id) : null;
    const at = node.position || routinePosition(clients.indexOf(client), t);
    const tag = node.position ? node.id : `${node.id}|${Math.floor(localMinutes(t) / 90)}`;
    const rise = microwaveRise(t, at);
    const pick = chooseAttachment(node.id, node.bands, at, tag, isClient ? client.prefer : 'mesh');
    for (const ap of aps) {
      for (const band of node.bands) {
        const isPick = pick.ap.id === ap.id && pick.band === band;
        if (isClient && !isPick) continue; // a client only knows the link it uses
        const noise = truth.noiseFloorDbm[band] + (band === '2.4' ? rise : 0) + gaussian(rand) * 0.8;
        const rssi = trueRssi(ap, band, at, tag) + gaussian(rand) * truth.timeNoiseSigmaDb * busy + (band === '2.4' && rise > 6 ? gaussian(rand) * 2.5 : 0);
        if (rssi < truth.visibleAboveDbm && !isPick) continue;
        rows.push(scanRow(jitterT, node.id, ap, band, rssi, noise, isPick));
      }
    }
    if (node.type === 'pi') {
      const link = pick;
      const snr = trueRssi(link.ap, link.band, at, tag) - (truth.noiseFloorDbm[link.band] + (link.band === '2.4' ? rise : 0));
      const evening = within(t, truth.eveningCongestion.from, truth.eveningCongestion.to);
      (config.wiredReferences || []).forEach((target, i) => {
        const cap = link.band === '5' ? 260 : 72;
        const quality = Math.min(1, Math.max(0.03, (snr - 8) / 30));
        const interference = rise > 6 ? 0.35 + 0.3 * rand() : 1;
        const thr = cap * quality * (evening ? truth.eveningCongestion.throughputFactor : 1) * (link.band === '2.4' ? interference : 0.92 + 0.08 * interference) * (0.9 + 0.2 * rand());
        const lat = 2.2 + i * 0.4 + Math.abs(gaussian(rand)) * 0.6 + (evening ? truth.eveningCongestion.extraLatencyMs * (0.6 + 0.8 * rand()) : 0) + (rise > 6 ? 6 + 18 * rand() : 0);
        const jit = 0.3 + Math.abs(gaussian(rand)) * 0.4 + (evening ? 1.2 * rand() : 0) + (rise > 6 ? 4 + 8 * rand() : 0);
        const loss = rise > 6 ? 1.5 + 6 * rand() : rand() < 0.04 ? 0.5 + rand() : 0;
        rows.push({ time: iso(jitterT + 3000 + i * 4000), node_id: node.id, kind: 'probe', target, bssid: link.ap.bssid[link.band].toLowerCase(), band: link.band,
          latency_ms: Math.round(lat * 100) / 100, jitter_ms: Math.round(jit * 100) / 100, loss_pct: Math.round(loss * 10) / 10, throughput_mbps: Math.round(thr * 10) / 10 });
      });
    }
  }
}

// neighbours: weak networks on assorted channels, heard by a few sensors, every 30 minutes
const neighbourChannels = { '2.4': [1, 6, 11, 3, 9, 11, 1], 5: [36, 44, 149, 157, 100] };
const sensorNodes = nodes.filter((n) => n.type === 'esp32' || n.type === 'pi');
for (let k = 0; k < truth.neighbours; k++) {
  const band = k % 3 === 2 ? '5' : '2.4';
  const channel = neighbourChannels[band][k % neighbourChannels[band].length];
  const bssid = fakeMac(`neighbour-${k}`).replace(/^02:a7/, '06:b3');
  const ssid = ['Neighbour-Net', 'CasaWiFi', 'HomeNet', 'Linkhouse', 'Maple-Guest', 'TP-Net', 'OakStreet', 'NG-Home', 'SkyLAN'][k % 9] + `-${(hashString('n' + k) % 90) + 10}`;
  const hearers = sensorNodes.filter((n) => n.bands.includes(band) && mulberry32(hashString(`${k}|${n.id}`))() < 0.45);
  for (let s = 0; s < steps; s += Math.round(1800 / truth.stepSeconds)) {
    const t = t0 + s * truth.stepSeconds * 1000;
    for (const n of hearers) {
      if (n === offlineNode && within(t, truth.offline.from, truth.offline.to)) continue;
      const base = -80 - 10 * mulberry32(hashString(`lvl|${k}|${n.id}`))();
      rows.push({ time: iso(t + 9000), node_id: n.id, kind: 'scan', bssid, ssid, band, channel, rssi_dbm: Math.round((base + gaussian(rand) * 1.5) * 10) / 10, noise_dbm: truth.noiseFloorDbm[band] });
    }
  }
}

// walk test: a phone visits every room and records every BSSID with its position
{
  let t = t0 + (((hm(truth.survey.at) - localMinutes(t0)) + 1440) % 1440) * 60000;
  for (const entry of allRooms) {
    const b = bounds(entry.room.polygon);
    let made = 0, tries = 0;
    const r = mulberry32(hashString(`${truth.seed}|survey|${entry.room.id}`));
    while (made < truth.survey.pointsPerRoom && tries++ < 200) {
      const x = b.minX + r() * (b.maxX - b.minX), y = b.minY + r() * (b.maxY - b.minY);
      if (!pointInPolygon(x, y, entry.room.polygon)) continue;
      const at = { level: entry.level.id, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
      for (const ap of aps) for (const band of ['2.4', '5']) {
        const rssi = trueRssi(ap, band, at, `survey|${entry.room.id}|${made}`) + gaussian(rand) * truth.timeNoiseSigmaDb;
        if (rssi < truth.visibleAboveDbm) continue;
        rows.push({ ...scanRow(t, 'survey-phone', ap, band, rssi, truth.noiseFloorDbm[band] + gaussian(rand) * 0.8, false), pos_level: at.level, pos_x: at.x, pos_y: at.y });
      }
      t += truth.survey.secondsPerPoint * 1000;
      made++;
    }
  }
}

rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
const meta = {
  kind: 'meta', synthetic: true, generator: 'data/synthetic/generate.mjs', seed: truth.seed,
  start: iso(t0), end: iso(t0 + truth.hours * 3600000), step_seconds: truth.stepSeconds, rows: rows.length,
  note: 'SYNTHETIC DATA. Fixed sensors report every 5 minutes here to keep the file small; real ESP32 nodes report about every 5 seconds.',
  events: [
    ...truth.microwave.bursts.map(([a, b]) => ({ type: 'microwave-oven', band: '2.4', local_from: a, local_to: b })),
    { type: 'node-offline', node_id: offlineNode.id, local_from: truth.offline.from, local_to: truth.offline.to },
  ],
};
fs.writeFileSync(path.join(ROOT, outDir, sampleFile), [meta, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(ROOT, outDir, 'nodes.json'), JSON.stringify({
  schemaVersion: 1, synthetic: true,
  about: 'Where each sensor and device is. position null means unknown: the device is listed in the roaming tray. Type survey means every sample carries its own position.',
  nodes: nodes.map(({ room, ...n }) => n),
}, null, 1) + '\n');

const sizeMb = fs.statSync(path.join(ROOT, outDir, sampleFile)).size / 1e6;
console.log(`${PRIVATE ? 'private' : 'public'} synthetic set written to ${outDir}/: ${nodes.length} nodes, ${rows.length} sample rows (${sizeMb.toFixed(1)} MB), ${levels.length} levels, ${aps.length} access points`);
if (check.warnings.length && !PRIVATE) console.log('floor plan warnings:\n  ' + formatIssues(check.warnings).join('\n  '));
