// Numbers for the metrics panel, computed from a signal grid in dBm.
// Pure functions: browser and Node.

import { quantile } from './calibrate.js';

/** The signal band ({ id, label, min_dbm }) that a level in dBm falls in. */
export function bandOf(dbm, grades) {
  for (const band of grades.bands) if (dbm > band.min_dbm) return band;
  return grades.bands[grades.bands.length - 1];
}

export function letterOf(dbm, grades) {
  for (const g of grades.room_grade.letters) if (dbm >= g.min_dbm) return g.letter;
  return grades.room_grade.letters[grades.room_grade.letters.length - 1].letter;
}

/**
 * Statistics for one level.
 * dbm: Float32Array of the level's cells. roomIndex: Int16Array, -1 outside rooms.
 * Only cells inside a room count as floor area.
 */
export function levelStats(dbm, roomIndex, rooms, cellArea, grades) {
  const threshold = grades.coverage_threshold_dbm;
  const dead = grades.dead_zone_below_dbm;
  const perRoom = rooms.map(() => []);
  let covered = 0, total = 0, deadCells = 0;
  const bandCells = Object.fromEntries(grades.bands.map((b) => [b.id, 0]));
  for (let k = 0; k < dbm.length; k++) {
    const r = roomIndex[k];
    if (r < 0) continue;
    const v = dbm[k];
    total++;
    if (v > threshold) covered++;
    if (v < dead) deadCells++;
    bandCells[bandOf(v, grades).id]++;
    perRoom[r].push(v);
  }
  const q = grades.room_grade.statistic === 'median' ? 0.5 : 0.1;
  const roomStats = rooms.map((room, r) => {
    const vals = perRoom[r].sort((a, b) => a - b);
    if (!vals.length) return { id: room.id, name: room.name, area: 0, cells: 0 };
    const deadIn = vals.filter((v) => v < dead).length;
    const p10 = quantile(vals, q);
    return {
      id: room.id, name: room.name, nameSource: room.nameSource,
      area: vals.length * cellArea, cells: vals.length,
      p10, median: quantile(vals, 0.5), min: vals[0], max: vals[vals.length - 1],
      coveragePct: (100 * vals.filter((v) => v > threshold).length) / vals.length,
      deadArea: deadIn * cellArea,
      grade: letterOf(p10, grades),
    };
  }).filter((r) => r.cells > 0);
  return {
    area: total * cellArea,
    coveragePct: total ? (100 * covered) / total : 0,
    deadArea: deadCells * cellArea,
    bandArea: Object.fromEntries(Object.entries(bandCells).map(([id, n]) => [id, n * cellArea])),
    rooms: roomStats,
  };
}

/** Combine per-level statistics into house-wide numbers. */
export function houseStats(levelResults) {
  let area = 0, covered = 0, deadArea = 0;
  const rooms = [];
  const deadRooms = [];
  for (const { level, stats } of levelResults) {
    area += stats.area;
    covered += (stats.coveragePct / 100) * stats.area;
    deadArea += stats.deadArea;
    for (const r of stats.rooms) {
      rooms.push({ ...r, levelId: level.id, levelName: level.name });
      if (r.deadArea > 0.5) deadRooms.push({ id: r.id, name: r.name, levelId: level.id, levelName: level.name, area: r.deadArea, share: r.deadArea / r.area });
    }
  }
  const ranked = rooms.filter((r) => r.area >= 3).sort((a, b) => a.median - b.median);
  return {
    area, coveragePct: area ? (100 * covered) / area : 0, deadArea,
    deadRooms: deadRooms.sort((a, b) => b.area - a.area),
    weakest: ranked[0] || null,
    strongest: ranked[ranked.length - 1] || null,
    rooms,
  };
}

// ---- channels -----------------------------------------------------------------

const BLOCKS_80MHZ = [[36, 48], [52, 64], [100, 112], [116, 128], [132, 144], [149, 161]];

/** The 80 MHz block [first channel, last channel] that holds a 5 GHz channel, or null. */
export function blockOf(channel) {
  return BLOCKS_80MHZ.find(([lo, hi]) => channel >= lo && channel <= hi) || null;
}

/** Centre frequency in MHz of a Wi-Fi channel. */
export function channelFreq(band, channel) {
  if (String(band) === '2.4') return channel === 14 ? 2484 : 2407 + 5 * channel;
  return 5000 + 5 * channel;
}

/** True when two radios on these channels disturb each other. */
export function channelsOverlap(band, a, b) {
  if (String(band) === '2.4') return Math.abs(a - b) < 5; // 20 MHz wide, 5 MHz apart
  const block = (c) => BLOCKS_80MHZ.findIndex(([lo, hi]) => c >= lo && c <= hi);
  const ba = block(a), bb = block(b);
  return ba >= 0 ? ba === bb : a === b; // own radios are assumed 80 MHz wide
}

/**
 * Channel report.
 * radios: [{ bssid, ssid, band, channel, rssi, own: bool, apId?, network? }]
 * Returns { byBand: { '2.4': { channels: [{ channel, own: [...], neighbours: [...] }] }, ... },
 *           conflicts: [{ band, a, b, kind }] } where kind is "same network" (mesh points
 *           sharing a channel on purpose), "own networks" or "neighbour".
 */
export function channelReport(radios) {
  const byBand = {};
  for (const r of radios) {
    const band = String(r.band);
    byBand[band] ||= { channels: new Map() };
    const slot = byBand[band].channels.get(r.channel) || { channel: r.channel, own: [], neighbours: [] };
    (r.own ? slot.own : slot.neighbours).push(r);
    byBand[band].channels.set(r.channel, slot);
  }
  const conflicts = [];
  const own = radios.filter((r) => r.own);
  for (let i = 0; i < own.length; i++) {
    for (let j = i + 1; j < own.length; j++) {
      const a = own[i], b = own[j];
      if (String(a.band) !== String(b.band) || !channelsOverlap(a.band, a.channel, b.channel)) continue;
      conflicts.push({ band: String(a.band), a, b, kind: a.network === b.network ? 'same network' : 'own networks' });
    }
    for (const nb of radios) {
      if (nb.own || String(nb.band) !== String(own[i].band)) continue;
      if (channelsOverlap(nb.band, own[i].channel, nb.channel)) conflicts.push({ band: String(nb.band), a: own[i], b: nb, kind: 'neighbour' });
    }
  }
  for (const band of Object.keys(byBand)) byBand[band].channels = [...byBand[band].channels.values()].sort((p, q) => p.channel - q.channel);
  return { byBand, conflicts };
}

/**
 * Which access points advertise each SSID, worked out from BSSIDs in the data.
 * apOfBssid: Map(bssid -> { apId, network }). seen: iterable of { bssid, ssid }.
 * Returns [{ ssid, bssids, networks: [...ids], unknownBssids: [...] }].
 */
export function ssidTopology(seen, apOfBssid) {
  const bySsid = new Map();
  for (const { bssid, ssid } of seen) {
    if (!ssid) continue;
    const e = bySsid.get(ssid) || { ssid, bssids: [], networks: new Set(), aps: new Set(), unknownBssids: [] };
    e.bssids.push(bssid);
    const ap = apOfBssid.get(bssid);
    if (ap) { e.networks.add(ap.network); e.aps.add(ap.apId); } else e.unknownBssids.push(bssid);
    bySsid.set(ssid, e);
  }
  return [...bySsid.values()].map((e) => ({ ...e, networks: [...e.networks], aps: [...e.aps] }));
}
