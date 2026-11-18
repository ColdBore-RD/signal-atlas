#!/usr/bin/env node
// Turn a walk survey into calibration samples.
//
//   node tools/survey-import.mjs [--window 8] [--dir data/private] [--dry-run]
//
// It reads, from data/private/ (or --dir):
//   waypoints.ndjson      the places you clicked in Survey mode of the page (key S)
//   scans-laptop.ndjson   the log of tools\walk-sample.ps1 (optional)
//   scans-pi.ndjson       the log of collectors/pi/survey.py (optional)
//   marks-pi.ndjson       the "I stand on the next spot" marks of the Pi (with scans-pi)
// and writes survey.ndjson: one row per waypoint, source and BSSID, in the sample
// format of docs/data-contract.md. The page loads that file by itself.
//
// Laptop scans are joined by time: a scan belongs to a waypoint when it was taken
// at most --window seconds before or after the click. All readings of one BSSID
// at one waypoint are averaged.
// Pi scans are joined by marks: mark number k is waypoint number k, and the scans
// around the mark (on the clock of the Pi) belong to it. The clock of the Pi does
// not have to be right.
//
// survey.ndjson is rebuilt from the logs every time, so running this twice is safe.
// Nothing here touches a network. The output contains BSSIDs: it stays in data/private/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseNdjson } from '../src/core/samples.js';
import { mergeConfig, bssidIndex } from '../src/core/config.js';
import { waypointsFromRows, scansFromRows, marksFromRows, joinByTime, joinByMarks, DEFAULT_WINDOW_S } from '../src/core/survey.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readRows = (file) => (fs.existsSync(file) ? parseNdjson(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).rows : null);

/** Build the survey rows from the logs in `dir`. Returns { rows, reports, notes }. */
export function buildSurvey(dir, { windowS = DEFAULT_WINDOW_S, own = new Map() } = {}) {
  const notes = [];
  const waypointRows = readRows(path.join(dir, 'waypoints.ndjson'));
  if (!waypointRows) return { rows: [], reports: [], notes: ['waypoints.ndjson is missing. Open the page, press S and click where you stand.'] };
  const waypoints = waypointsFromRows(waypointRows);
  const reports = [];
  let rows = [];
  const laptop = readRows(path.join(dir, 'scans-laptop.ndjson'));
  if (laptop) {
    const out = joinByTime(waypoints, scansFromRows(laptop), { windowS, node: 'survey-laptop' });
    rows = rows.concat(out.rows);
    reports.push(out.report);
  }
  const pi = readRows(path.join(dir, 'scans-pi.ndjson'));
  if (pi) {
    const marks = readRows(path.join(dir, 'marks-pi.ndjson'));
    if (!marks) notes.push('scans-pi.ndjson is there but marks-pi.ndjson is not: the Pi scans cannot be placed and were left out.');
    else {
      const out = joinByMarks(waypoints, marksFromRows(marks), scansFromRows(pi), { windowS, node: 'survey-pi' });
      rows = rows.concat(out.rows);
      reports.push(out.report);
    }
  }
  if (!laptop && !pi) notes.push('No scan log found (scans-laptop.ndjson or scans-pi.ndjson). Nothing to join.');
  // say which access point a BSSID is, when the config knows it
  for (const r of rows) { const hit = own.get(r.bssid); if (hit) r.ap_id = hit.apId; }
  rows.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.node_id.localeCompare(b.node_id) || b.rssi_dbm - a.rssi_dbm));
  return { rows, reports, notes, waypoints: waypoints.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  const dir = path.resolve(ROOT, value('--dir', 'data/private'));
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/config.default.json'), 'utf8'));
  const localFile = path.join(dir, 'config.local.json');
  const config = fs.existsSync(localFile) ? mergeConfig(base, JSON.parse(fs.readFileSync(localFile, 'utf8'))) : base;
  // a setup made in the page (Setup panel) replaces the access points of the config, as it does in the page;
  // the walk survey belongs to the owner's house, whose setup lives next to its config
  let setup = null;
  try { setup = JSON.parse(fs.readFileSync(path.join(dir, 'network-setup.json'), 'utf8')); } catch { /* no setup file */ }
  const own = bssidIndex(Array.isArray(setup?.devices) ? setup.devices.filter((d) => d && d.bssid) : config.aps || []);
  const { rows, reports, notes, waypoints } = buildSurvey(dir, { windowS: Number(value('--window', DEFAULT_WINDOW_S)), own });
  for (const n of notes) console.log(n);
  for (const r of reports) {
    console.log(`${r.node}: ${r.waypointsWithScans} of ${r.waypoints} waypoints have scans (window +/- ${r.windowS} s). Scans used: ${r.scansUsed}, not near any waypoint: ${r.scansUnused}.`);
    if (r.waypointsWithoutScans.length) console.log(`  waypoints without a scan: ${r.waypointsWithoutScans.join(', ')}`);
    if (r.marksWithoutWaypoint?.length) console.log(`  marks with no waypoint of that number: ${r.marksWithoutWaypoint.join(', ')}`);
  }
  if (!rows.length) { console.log('No survey rows. survey.ndjson was not changed.'); process.exit(notes.length && !waypoints ? 1 : 0); }
  const ownRows = rows.filter((r) => r.ap_id).length;
  const approx = rows.some((r) => r.rssi_approx);
  const meta = {
    kind: 'meta', synthetic: false, generator: 'tools/survey-import.mjs', written: new Date().toISOString(), rows: rows.length,
    note: `Walk survey. ${approx ? 'Laptop readings are approximate: Windows reports a percentage, converted with dBm = percent / 2 - 100. ' : ''}One row per waypoint, source and BSSID; readings within the time window are averaged.`,
  };
  const out = path.join(dir, 'survey.ndjson');
  if (args.includes('--dry-run')) console.log(`dry run: would write ${rows.length} rows to ${path.relative(ROOT, out)}`);
  else {
    fs.writeFileSync(out, [meta, ...rows].map((r) => JSON.stringify(r)).join('\n') + '\n');
    console.log(`${rows.length} rows written to ${path.relative(ROOT, out)} (${ownRows} from your own access points, ${rows.length - ownRows} from other networks).`);
  }
  if (!ownRows) console.log('None of the BSSIDs is one of your access points in the config. Put the real BSSIDs into the Setup panel of the page (key D) or into data/private/config.local.json (tools\\probe-wifi.ps1 lists them); until then the survey cannot be compared with the model.');
  const synthetic = (config.paths?.samples || []).filter((p) => /synthetic/i.test(p));
  if (synthetic.length) console.log(`Note: the config still loads synthetic samples (${synthetic.join(', ')}). Remove them from paths.samples in config.local.json to calibrate on the real survey only.`);
  console.log('Reload the page and press S to see measured against predicted.');
}
