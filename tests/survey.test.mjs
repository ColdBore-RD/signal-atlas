import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waypointsFromRows, scansFromRows, marksFromRows, joinByTime, joinByMarks, errorStats, surveySource, distanceToSamples } from '../src/core/survey.js';
import { buildSurvey } from '../tools/survey-import.mjs';
import { SampleStore } from '../src/core/samples.js';
import { makeGrid } from '../src/core/geometry.js';

// A made-up walk: three stops, 30 s apart. Nothing here comes from a real network.
const T0 = Date.parse('2026-11-20T19:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const AP1 = '02:00:00:00:00:01', AP2 = '02:00:00:00:00:02', NEIGHBOUR = '06:00:00:00:00:09';
const waypointRows = [
  { time: at(0), kind: 'waypoint', id: 'wp-0001', level: '1', x: 2, y: 3 },
  { time: at(30), kind: 'waypoint', id: 'wp-0002', level: '1', x: 6, y: 3 },
  { time: at(60), kind: 'waypoint', id: 'wp-0003', level: 'B', x: 6, y: 5 },
];
const scan = (s, bssid, rssi, extra = {}) => ({ time: at(s), node_id: 'survey-laptop', kind: 'scan', bssid, ssid: 'made-up', band: '2.4', channel: 6, rssi_dbm: rssi, ...extra });

test('scans within the window are joined to the waypoint and averaged per BSSID', () => {
  const scans = scansFromRows([
    scan(-4, AP1, -50), scan(0, AP1, -52), scan(4, AP1, -54),       // three readings around the first stop
    scan(0, AP2, -70),
    scan(15, AP1, -40),                                             // between two stops, outside both windows: not used
    scan(28, AP1, -61), scan(33, AP1, -63),
    scan(58, NEIGHBOUR, -80, { approx: true }),
  ]);
  const { rows, report } = joinByTime(waypointsFromRows(waypointRows), scans, { windowS: 8 });
  assert.equal(report.scansUsed, 7);
  assert.equal(report.scansUnused, 1);
  assert.deepEqual(report.waypointsWithoutScans, []);
  const first = rows.filter((r) => r.waypoint === 'wp-0001');
  assert.deepEqual(first.map((r) => [r.bssid, r.rssi_dbm, r.readings]), [[AP1, -52, 3], [AP2, -70, 1]]);     // strongest first
  assert.deepEqual([first[0].rssi_min_dbm, first[0].rssi_max_dbm], [-54, -50]);
  const second = rows.find((r) => r.waypoint === 'wp-0002');
  assert.deepEqual([second.rssi_dbm, second.pos_level, second.pos_x, second.pos_y, second.time], [-62, '1', 6, 3, '2026-11-20T19:00:30Z']);
  const third = rows.find((r) => r.waypoint === 'wp-0003');
  assert.equal(third.rssi_approx, true);
  assert.equal(third.pos_level, 'B');
});

test('a scan between two close waypoints goes to the nearer one', () => {
  const wps = waypointsFromRows([{ time: at(0), kind: 'waypoint', id: 'a', level: '1', x: 1, y: 1 }, { time: at(10), kind: 'waypoint', id: 'b', level: '1', x: 5, y: 1 }]);
  const { rows } = joinByTime(wps, scansFromRows([scan(4, AP1, -50), scan(6, AP1, -60)]), { windowS: 8 });
  assert.deepEqual(rows.map((r) => [r.waypoint, r.rssi_dbm]), [['a', -50], ['b', -60]]);
});

test('a waypoint with no scan near it is reported, not invented', () => {
  const { rows, report } = joinByTime(waypointsFromRows(waypointRows), scansFromRows([scan(1, AP1, -50)]), { windowS: 5 });
  assert.equal(rows.length, 1);
  assert.deepEqual(report.waypointsWithoutScans, ['wp-0002', 'wp-0003']);
});

test('the rows are valid walk-test samples for the sample store', () => {
  const { rows } = joinByTime(waypointsFromRows(waypointRows), scansFromRows([scan(0, AP1, -52), scan(30, AP1, -62)]));
  const store = new SampleStore().addAll(rows);
  assert.equal(store.rejected, 0);
  assert.equal(store.survey.length, 2);
  assert.deepEqual({ ...store.survey[0], t: 0 }, { t: 0, node: 'survey-laptop', bssid: AP1, rssi: -52, level: '1', x: 2, y: 3 });
});

test('Pi scans are joined by marks, on the clock of the Pi', () => {
  // the clock of the Pi is 3 hours and 7 seconds off; mark k is waypoint k
  const off = 3 * 3600 + 7;
  const marks = marksFromRows([{ time: at(off + 2), kind: 'mark', seq: 1 }, { time: at(off + 33), kind: 'mark', seq: 2 }, { time: at(off + 90), kind: 'mark', seq: 9 }]);
  const scans = scansFromRows([
    { ...scan(off + 1, AP1, -48.5), node_id: 'survey-pi' }, { ...scan(off + 5, AP1, -49.5), node_id: 'survey-pi' },
    { ...scan(off + 34, AP1, -66), node_id: 'survey-pi' },
  ]);
  const { rows, report } = joinByMarks(waypointsFromRows(waypointRows), marks, scans, { windowS: 8 });
  assert.deepEqual(rows.map((r) => [r.waypoint, r.rssi_dbm, r.node_id, r.time]), [['wp-0001', -49, 'survey-pi', at(0).replace('.000Z', 'Z')], ['wp-0002', -66, 'survey-pi', at(30).replace('.000Z', 'Z')]]);
  assert.deepEqual(report.marksWithoutWaypoint, [9]);
  assert.equal(report.marks, 3);
});

test('rows that are not complete are ignored', () => {
  assert.equal(scansFromRows([{ kind: 'meta' }, { time: 'yesterday', bssid: AP1, band: '5', rssi_dbm: -50 }, { time: at(0), bssid: 'nonsense', band: '5', rssi_dbm: -50 }, { time: at(0), bssid: AP1, rssi_dbm: -50 }]).length, 0);
  assert.equal(waypointsFromRows([{ kind: 'waypoint', time: at(0), level: '1', x: 1 }, { kind: 'scan', time: at(0) }]).length, 0);
  assert.deepEqual(waypointsFromRows(waypointRows).map((w) => w.seq), [1, 2, 3]);
});

test('error numbers', () => {
  const s = errorStats([-4, 2, -1, 6, 3]);
  assert.deepEqual([s.count, s.medianAbs, s.p90Abs], [5, 3, 6]);
  assert.ok(Math.abs(s.bias - 1.2) < 1e-12);
  assert.deepEqual(errorStats([]), { count: 0, medianAbs: null, p90Abs: null, bias: null });
});

test('the source of a survey row is read from its node id', () => {
  assert.equal(surveySource('survey-laptop'), 'laptop');
  assert.equal(surveySource('survey-pi'), 'Pi');
  assert.equal(surveySource('survey-phone'), null);
  assert.equal(surveySource('spider'), null);
});

test('distance to the nearest measured place, with a penalty per floor', () => {
  const grid = makeGrid({ minX: 0, minY: 0, maxX: 10, maxY: 4 }, 1);
  const d = distanceToSamples(grid, 2, [{ levelIndex: 0, x: 0.5, y: 0.5 }], { floorPenaltyM: 6 });
  const cells = grid.nx * grid.ny;
  assert.equal(d[0], 0);
  assert.ok(Math.abs(d[9] - 9) < 1e-6);                 // same row, 9 cells away
  assert.ok(Math.abs(d[cells] - 6) < 1e-6);             // directly above, one floor up
  assert.equal(distanceToSamples(grid, 1, [])[5], 99);  // no measured place at all
});

test('the importer builds survey rows from the log files, marks own access points, and is repeatable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-survey-'));
  try {
    const write = (name, rows) => fs.writeFileSync(path.join(dir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    write('waypoints.ndjson', waypointRows);
    write('scans-laptop.ndjson', [{ kind: 'meta', source: 'laptop' }, scan(0, AP1, -52, { approx: true }), scan(1, NEIGHBOUR, -81, { approx: true }), scan(31, AP1, -62, { approx: true })]);
    write('scans-pi.ndjson', [{ ...scan(1000, AP1, -55.5), node_id: 'survey-pi' }]);
    write('marks-pi.ndjson', [{ time: at(1001), kind: 'mark', seq: 1 }]);
    const own = new Map([[AP1, { apId: 'mesh-a' }]]);
    const a = buildSurvey(dir, { windowS: 8, own });
    assert.deepEqual(a.rows.map((r) => [r.node_id, r.waypoint, r.bssid, r.rssi_dbm, r.ap_id || '']), [
      ['survey-laptop', 'wp-0001', AP1, -52, 'mesh-a'], ['survey-laptop', 'wp-0001', NEIGHBOUR, -81, ''], ['survey-pi', 'wp-0001', AP1, -55.5, 'mesh-a'], ['survey-laptop', 'wp-0002', AP1, -62, 'mesh-a'],
    ]);
    assert.ok(a.rows.filter((r) => r.node_id === 'survey-laptop').every((r) => r.rssi_approx));
    assert.ok(a.rows.filter((r) => r.node_id === 'survey-pi').every((r) => !r.rssi_approx));
    assert.deepEqual(buildSurvey(dir, { windowS: 8, own }).rows, a.rows);
    // without the marks the Pi scans cannot be placed
    fs.rmSync(path.join(dir, 'marks-pi.ndjson'));
    const b = buildSurvey(dir, { windowS: 8, own });
    assert.ok(b.rows.every((r) => r.node_id === 'survey-laptop'));
    assert.match(b.notes.join(' '), /marks-pi\.ndjson is not/);
    assert.match(buildSurvey(path.join(dir, 'nowhere')).notes[0], /waypoints\.ndjson is missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('walk-test rows do not move the time window of the record, unless there is nothing else', () => {
  const sensor = { time: '2026-11-14T10:00:00Z', node_id: 'esp32-01', kind: 'scan', bssid: AP1, band: '2.4', rssi_dbm: -50 };
  const walk = { time: '2026-11-20T19:00:00Z', node_id: 'survey-laptop', kind: 'scan', bssid: AP1, band: '2.4', rssi_dbm: -60, pos_level: '1', pos_x: 1, pos_y: 1 };
  const both = new SampleStore().addAll([sensor, walk]);
  assert.equal(both.tMax, Date.parse(sensor.time));
  assert.equal(both.count, 2);
  const only = new SampleStore().addAll([walk]);
  assert.equal(only.tMin, Date.parse(walk.time));
  assert.equal(only.tMax, Date.parse(walk.time));
  assert.equal(new SampleStore().tMax, -Infinity);
});

test('rows of a file that says "synthetic" carry that mark, so they are never taken for measurements', async () => {
  const { parseNdjson } = await import('../src/core/samples.js');
  const text = [{ kind: 'meta', synthetic: true }, { time: at(0), node_id: 'survey-phone', kind: 'scan', bssid: AP1, band: '5', rssi_dbm: -60, pos_level: '1', pos_x: 1, pos_y: 1 }].map((r) => JSON.stringify(r)).join('\n');
  const store = new SampleStore().addAll(parseNdjson(text).rows);
  assert.equal(store.survey[0].synthetic, true);
  const real = new SampleStore().addAll(parseNdjson(text.replace('"synthetic":true', '"synthetic":false')).rows);
  assert.equal(real.survey[0].synthetic, undefined);
});

test('a mark number that was made twice counts once: the last mark wins', () => {
  const marks = marksFromRows([{ time: at(500), kind: 'mark', seq: 1 }, { time: at(600), kind: 'mark', seq: 1 }]);
  const scans = scansFromRows([{ ...scan(501, AP1, -40), node_id: 'survey-pi' }, { ...scan(601, AP1, -70), node_id: 'survey-pi' }]);
  const { rows } = joinByMarks(waypointsFromRows(waypointRows), marks, scans, { windowS: 8 });
  assert.deepEqual(rows.map((r) => [r.waypoint, r.rssi_dbm]), [['wp-0001', -70]]);
});
