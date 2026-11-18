#!/usr/bin/env node
// Turn a walk test into calibration samples.
//
//   node tools/walk-import.mjs <scans.csv> <waypoints.csv> [--out data/private/samples.walk.ndjson] [--node survey-phone]
//
// scans.csv: the export of a Wi-Fi analyser app on a phone or laptop. It needs a header
// line. Columns are found by name, in any order and any letter case:
//     time (or timestamp, date)      when the reading was taken
//     bssid (or mac)                 the access point radio
//     rssi (or level, signal, dbm)   signal in dBm, for example -58
//     ssid                           optional
//     frequency (or freq) in MHz, or channel
// waypoints.csv: where you stood and when you got there, one line per stop:
//     time,level,x,y
//     2026-11-20T19:02:10,1,6.4,9.1
// Every reading is given the place of the last stop before it, if that stop is at most
// --max-age seconds old (default 120). Readings before the first stop are dropped.
// Get x and y from the page: 2D plan view, hold Alt and click the spot.
//
// The output rows follow docs/data-contract.md (kind "scan" with pos_level, pos_x, pos_y).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const delim = [',', ';', '\t'].sort((a, b) => lines[0].split(b).length - lines[0].split(a).length)[0];
  const split = (line) => {
    const out = []; let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
      else if (c === delim && !quoted) { out.push(cur); cur = ''; } else cur += c;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };
  const header = split(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((l) => Object.fromEntries(split(l).map((v, i) => [header[i] ?? `col${i}`, v])));
}

const pick = (row, names) => { for (const n of names) for (const k of Object.keys(row)) if (k === n || k.startsWith(n)) return row[k]; return undefined; };

export function convert(scans, waypoints, { node = 'survey-phone', maxAgeS = 120 } = {}) {
  const stops = waypoints.map((w) => ({ t: Date.parse(pick(w, ['time'])), level: String(pick(w, ['level'])), x: Number(pick(w, ['x'])), y: Number(pick(w, ['y'])) }))
    .filter((w) => Number.isFinite(w.t) && Number.isFinite(w.x) && Number.isFinite(w.y)).sort((a, b) => a.t - b.t);
  const rows = [];
  const skipped = { noPlace: 0, bad: 0 };
  for (const s of scans) {
    const t = Date.parse(pick(s, ['time', 'timestamp', 'date']));
    const bssid = String(pick(s, ['bssid', 'mac']) || '').toLowerCase().replace(/-/g, ':');
    const rssi = Number(pick(s, ['rssi', 'level', 'signal', 'dbm']));
    const freq = Number(pick(s, ['frequency', 'freq']));
    let channel = Number(pick(s, ['channel']));
    if (!Number.isFinite(t) || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(bssid) || !(rssi < 0 && rssi >= -120)) { skipped.bad++; continue; }
    let band = Number.isFinite(freq) && freq > 0 ? (freq < 3000 ? '2.4' : freq < 5900 ? '5' : null) : Number.isFinite(channel) ? (channel <= 14 ? '2.4' : '5') : null;
    if (!band) { skipped.bad++; continue; }
    if (!Number.isFinite(channel) && Number.isFinite(freq)) channel = freq === 2484 ? 14 : freq < 3000 ? Math.round((freq - 2407) / 5) : Math.round((freq - 5000) / 5);
    let stop = null;
    for (const w of stops) { if (w.t <= t) stop = w; else break; }
    if (!stop || t - stop.t > maxAgeS * 1000) { skipped.noPlace++; continue; }
    rows.push({ time: new Date(t).toISOString().replace('.000Z', 'Z'), node_id: node, kind: 'scan', bssid, ssid: pick(s, ['ssid']) || '', band, ...(Number.isFinite(channel) ? { channel } : {}), rssi_dbm: rssi, pos_level: stop.level, pos_x: stop.x, pos_y: stop.y });
  }
  return { rows, skipped, stops: stops.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (files.length < 2) { console.error('usage: node tools/walk-import.mjs <scans.csv> <waypoints.csv> [--out file] [--node id] [--max-age seconds]'); process.exit(2); }
  const out = value('--out', 'data/private/samples.walk.ndjson');
  const { rows, skipped, stops } = convert(parseCsv(fs.readFileSync(files[0], 'utf8')), parseCsv(fs.readFileSync(files[1], 'utf8')), { node: value('--node', 'survey-phone'), maxAgeS: Number(value('--max-age', 120)) });
  fs.appendFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  console.log(`${rows.length} readings at ${stops} stops added to ${out}. Skipped: ${skipped.bad} unreadable, ${skipped.noPlace} with no stop near in time.`);
  console.log('Add that file to paths.samples in data/private/config.local.json, and a node {"id": "survey-phone", "type": "survey", "position": null} to the node file.');
}
