import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, materials, grades, boxHouse } from './helpers.mjs';
import { SampleStore, parseNdjson, lastAtOrBefore } from '../src/core/samples.js';
import { bandOf, letterOf, levelStats, houseStats, channelsOverlap, channelReport, ssidTopology } from '../src/core/metrics.js';
import { createRedactor, shortHash } from '../src/core/privacy.js';
import { northFromOutwardNormal, outwardNormal } from '../src/core/orientation.js';
import { mergeConfig, applyApPositions, bssidIndex } from '../src/core/config.js';
import { signalRamp, waveRamp, bandColors } from '../src/core/colormaps.js';
import { rasterizeMedium, waveGridSpec, buildSources, COURANT } from '../src/sim/rasterize.js';

test('signal bands and room letters follow data/grades.json', () => {
  assert.equal(bandOf(-45, grades).id, 'excellent');
  assert.equal(bandOf(-50, grades).id, 'good');
  assert.equal(bandOf(-55, grades).id, 'good');
  assert.equal(bandOf(-63, grades).id, 'fair');
  assert.equal(bandOf(-70, grades).id, 'weak');
  assert.equal(bandOf(-80, grades).id, 'poor');
  assert.equal(letterOf(-50, grades), 'A');
  assert.equal(letterOf(-66, grades), 'C');
  assert.equal(letterOf(-90, grades), 'F');
});

test('coverage, dead zones and room grades from a grid', () => {
  // 4 x 2 cells of 1 m2: room 0 has 4 strong cells, room 1 has 2 weak and 2 dead cells
  const dbm = Float32Array.from([-40, -45, -70, -80, -50, -55, -72, -85]);
  const roomIndex = Int16Array.from([0, 0, 1, 1, 0, 0, 1, 1]);
  const rooms = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
  const s = levelStats(dbm, roomIndex, rooms, 1, grades);
  assert.equal(s.area, 8);
  assert.equal(s.coveragePct, 50);
  assert.equal(s.deadArea, 2);
  assert.equal(s.rooms[0].grade, 'A');
  assert.equal(s.rooms[1].grade, 'F');
  const house = houseStats([{ level: { id: '1', name: 'Main' }, stats: s }]);
  assert.equal(house.weakest.id, 'b');
  assert.equal(house.strongest.id, 'a');
  assert.deepEqual(house.deadRooms.map((r) => r.id), ['b']);
});

test('channels: overlap rules and the conflict report', () => {
  assert.equal(channelsOverlap('2.4', 1, 6), false);
  assert.equal(channelsOverlap('2.4', 1, 4), true);
  assert.equal(channelsOverlap('5', 36, 44), true, 'same 80 MHz block');
  assert.equal(channelsOverlap('5', 44, 149), false);
  const report = channelReport([
    { bssid: 'a', band: '2.4', channel: 6, own: true, network: 'mesh' },
    { bssid: 'b', band: '2.4', channel: 6, own: true, network: 'mesh' },
    { bssid: 'c', band: '2.4', channel: 1, own: true, network: 'home' },
    { bssid: 'n', band: '2.4', channel: 3, own: false },
  ]);
  assert.equal(report.conflicts.filter((c) => c.kind === 'same network').length, 1);
  assert.equal(report.conflicts.filter((c) => c.kind === 'neighbour').length, 3, 'channel 3 disturbs channels 1 and 6');
});

test('sample store: latest reading, staleness, attachment, medians, walk-test rows', () => {
  const store = new SampleStore();
  const row = (min, rssi, extra = {}) => ({ time: new Date(Date.UTC(2026, 0, 1, 0, min)).toISOString(), node_id: 'n1', kind: 'scan', bssid: 'AA:00:00:00:00:01', ssid: 's', band: '2.4', channel: 1, rssi_dbm: rssi, ...extra });
  store.addAll([row(0, -60), row(10, -62, { associated: true }), row(5, -70), { kind: 'meta', synthetic: true }]);
  store.add({ ...row(7, -55), pos_level: '1', pos_x: 2, pos_y: 3, node_id: 'walker' });
  store.add({ time: 'not a time', node_id: 'x', kind: 'scan' });
  const t = (min) => Date.UTC(2026, 0, 1, 0, min);
  assert.equal(store.synthetic, true);
  assert.equal(store.rejected, 1);
  assert.equal(store.latest('n1', 'aa:00:00:00:00:01', t(6)).rssi, -70, 'rows are kept in time order');
  assert.equal(store.latest('n1', 'aa:00:00:00:00:01', t(30), 5 * 60000), null, 'stale readings are not returned');
  assert.equal(store.attachment('n1', t(12)).rssi, -62);
  assert.equal(store.attachment('n1', t(6)), null);
  assert.equal(store.medians()[0].rssi, -62);
  assert.equal(store.survey.length, 1);
  assert.equal(lastAtOrBefore([1, 3, 5], 4), 1);
  assert.equal(parseNdjson('{"a":1}\nnot json\n\n{"b":2}\n').rows.length, 2);
});

test('the synthetic day contains the promised events', () => {
  const { rows } = parseNdjson(fs.readFileSync(path.join(ROOT, 'data/synthetic/samples.ndjson'), 'utf8'));
  const meta = rows[0];
  assert.equal(meta.kind, 'meta'); assert.equal(meta.synthetic, true);
  const store = new SampleStore().addAll(rows);
  assert.ok((store.tMax - store.tMin) / 3600000 > 23.5, '24 hours of samples');
  // microwave burst: 2.4 GHz noise floor rises by more than 10 dB at some sensor
  let maxNoise = -200;
  for (const s of store.series.values()) for (const v of s.noise) if (v > maxNoise) maxNoise = v;
  assert.ok(maxNoise > -85, `noise floor peak ${maxNoise} dBm`);
  // a node goes offline and returns
  const offline = meta.events.find((e) => e.type === 'node-offline').node_id;
  const st = store.status.get(offline);
  assert.deepEqual(st.online, [0, 1]);
  const gapMs = st.t[1] - st.t[0];
  assert.ok(gapMs > 2 * 3600000, 'offline for more than two hours');
  assert.equal(store.latest(offline, [...store.byNode.get(offline).keys()][0], st.t[0] + gapMs / 2, 15 * 60000), null);
  assert.ok(store.survey.length > 100, 'walk test present');
  assert.ok(store.probes.size >= 2, 'probes to both wired references');
});

test('the synthetic house has a dead zone on 5 GHz under the assumed model (the generator keeps its promise)', async () => {
  const { buildModelContext, makeModelGrid, traceApField, evaluateApField, priorParams, rasterizeRooms } = await import('../src/core/propagation.js');
  const plan = readJson('data/synthetic/floorplan.json');
  const config = readJson('data/config.default.json');
  const ctx = buildModelContext(plan, materials);
  const grid = makeModelGrid(plan, 0.5, 1);
  const cells = grid.nx * grid.ny;
  const best = new Float32Array(ctx.levels.length * cells).fill(-200);
  const params = priorParams(ctx, '5');
  for (const ap of config.aps) {
    const out = evaluateApField(traceApField(ctx, ap, grid), params, ap, new Float32Array(best.length));
    for (let k = 0; k < best.length; k++) best[k] = Math.max(best[k], out[k]);
  }
  const rooms = rasterizeRooms(ctx, grid);
  let dead = 0;
  ctx.levels.forEach((level, li) => { dead += levelStats(best.subarray(li * cells, (li + 1) * cells), rooms[li], level.level.rooms, grid.cell ** 2, grades).deadArea; });
  assert.ok(dead > 4, `dead area ${dead} m2`);
});

test('privacy: redacted names are stable, generic and contain no part of the original', () => {
  const known = {
    address: '1 Real Street', houseName: 'Casa Real',
    networks: [{ id: 'home', ssid: 'Home-REAL1', label: 'Homebox' }, { id: 'mesh', ssid: 'My Mesh', label: 'Mesh label' }],
    aps: [{ id: 'home-router', label: 'Homebox X1100', bssid: { 2.4: 'AA:BB:CC:00:00:01', 5: 'aa:bb:cc:00:00:02' } }],
    nodes: [{ id: 'esp32-kitchen', name: 'ESP32 Kitchen', type: 'esp32' }, { id: 'home-server', name: 'Home server', type: 'wired' }, { id: 'p', name: 'Dad phone', type: 'client' }],
  };
  const on = createRedactor(known, true), off = createRedactor(known, false);
  assert.equal(off.ssid('Home-REAL1'), 'Home-REAL1');
  assert.equal(on.ssid('Home-REAL1'), 'Network A');
  assert.equal(on.ssid('My Mesh'), 'Network B');
  assert.equal(on.ssid('TheNeighbours'), 'Neighbour 1');
  assert.equal(on.ssid('TheNeighbours'), 'Neighbour 1');
  assert.equal(on.bssid('aa:bb:cc:00:00:01'), 'AP1 radio 2.4 GHz');
  assert.match(on.bssid('11:22:33:44:55:66'), /^radio #[0-9a-f]{4}$/);
  assert.equal(on.node('esp32-kitchen', 'ESP32 Kitchen'), 'Sensor 1');
  assert.equal(on.node('home-server', 'Home server'), 'Wired reference 1');
  assert.equal(on.node('p', 'Dad phone'), 'Client 1');
  assert.equal(on.address(), '');
  assert.equal(on.house(), 'Home');
  assert.equal(shortHash('AA:BB'), shortHash('aa:bb'));
  const everything = [on.ssid('Home-REAL1'), on.bssid('aa:bb:cc:00:00:02'), on.mac('de:ad:be:ef:00:01'), on.node('p', 'Dad phone'), on.address(), on.house(), on.ap('home-router', 'Homebox X1100'), on.network('home', 'Homebox')].join(' ');
  for (const secret of ['Real', 'REAL', 'aa:bb', 'de:ad', 'Dad', 'Kitchen', 'X1100', 'Homebox']) assert.ok(!everything.includes(secret), `"${secret}" leaked into "${everything}"`);
});

test('north from the front door: the owner rule', () => {
  // door on the top edge of the plan (outside is up): the visitor faces down the page, left hand points right
  assert.equal(northFromOutwardNormal([0, -1]), 90);
  // door on the left edge: the visitor faces right, left hand points up the page
  assert.equal(northFromOutwardNormal([-1, 0]), 0);
  assert.equal(northFromOutwardNormal([0, 1]), 270);
  assert.equal(northFromOutwardNormal([1, 0]), 180);
  const outline = [[0, 0], [10, 0], [10, 6], [0, 6]];
  assert.deepEqual(outwardNormal({ a: [4, 0], b: [5, 0] }, outline).map((v) => Math.round(v) + 0), [0, -1]);
  assert.deepEqual(outwardNormal({ a: [10, 2], b: [10, 3] }, outline).map((v) => Math.round(v) + 0), [1, 0]);
  assert.equal(outwardNormal({ a: [5, 2], b: [5, 3] }, outline), null, 'an interior door has no outside');
});

test('config: deep merge by id, saved marker positions, BSSID index', () => {
  const base = { a: 1, aps: [{ id: 'x', bssid: { 5: 'AA' }, position: { level: '1', x: 1, y: 1 } }, { id: 'y', position: { level: '1', x: 2, y: 2 } }], list: [1, 2] };
  const merged = mergeConfig(base, { aps: [{ id: 'x', position: { x: 9 } }], list: [3], b: 2 });
  assert.equal(merged.aps[0].position.x, 9); assert.equal(merged.aps[0].position.y, 1); assert.equal(merged.aps.length, 2);
  assert.deepEqual(merged.list, [3]); assert.equal(merged.b, 2);
  const placed = applyApPositions(merged.aps, { positions: { y: { level: '2', x: 5, y: 6 }, x: { level: 'nope', x: 0, y: 0 } } }, ['1', '2']);
  assert.equal(placed[1].position.level, '2'); assert.equal(placed[1].position.source, 'placed');
  assert.equal(placed[0].position.x, 9, 'a position on an unknown level is ignored');
  assert.equal(bssidIndex(merged.aps).get('aa').apId, 'x');
});

test('colour scales: valid colours, dark at the weak end, bright at the strong end', () => {
  for (let i = 0; i <= 20; i++) for (const c of [signalRamp(i / 20), waveRamp(i / 10 - 1)]) for (const v of c) assert.ok(v >= 0 && v <= 1);
  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  assert.ok(lum(signalRamp(0)) < 0.1 && lum(signalRamp(1)) > 0.7);
  assert.ok(lum(waveRamp(0)) < 0.05, 'zero of the wave scale is near black');
  assert.equal(Object.keys(bandColors(grades)).length, 5);
});

test('wave medium: walls slow and damp the wave more at 5 GHz, stairs couple levels, sources leak through floors', () => {
  const plan = boxHouse({ door: true });
  plan.levels[0].stairs.push({ id: 's', polygon: [[7, 1], [9, 1], [9, 2], [7, 2]], connects: ['U'] });
  const spec = waveGridSpec(plan, 0.1);
  const m24 = rasterizeMedium(plan, materials, spec, '2.4'), m5 = rasterizeMedium(plan, materials, spec, '5');
  const cell = (x, y, level = 0) => ((level * spec.ny + Math.floor((y - spec.minY) / spec.dx)) * spec.nx + Math.floor((x - spec.minX) / spec.dx)) * 4;
  const air = cell(2, 2), wall = cell(5, 1), doorway = cell(5, 3), shell = cell(0, 3);
  assert.ok(Math.abs(m24.data[air] - COURANT * COURANT) < 1e-6);
  assert.ok(m24.data[wall] < m24.data[air], 'drywall is a slower medium');
  assert.ok(m24.data[shell] < m24.data[wall], 'concrete is slower than drywall');
  assert.ok(Math.abs(m24.data[doorway] - m24.data[air]) < 1e-6, 'the open doorway is air');
  assert.ok(m5.data[wall + 1] > m24.data[wall + 1], '5 GHz is damped more in the same wall');
  assert.equal(m24.data[cell(8, 1.5, 0) + 2], 1, 'stair cell couples upward');
  assert.equal(m24.data[cell(8, 1.5, 1) + 3], 1, 'and the cell above couples downward');
  assert.equal(m24.data[cell(2, 2, 0) + 2], 0);
  for (let i = 0; i < m24.data.length; i += 4) assert.ok(m24.data[i] <= COURANT * COURANT + 1e-6, 'no cell is faster than air (CFL)');
  const src = buildSources(spec, [{ id: 'a', position: { level: 'G', x: 2, y: 3 } }], 9);
  assert.equal(src.length, 2);
  assert.equal(src[0].level, 0);
  assert.ok(src[1].amp < src[0].amp && src[1].level === 1);
});

test('walk-test import: readings get the place of the last stop, bad lines are skipped', async () => {
  const { parseCsv, convert } = await import('../tools/walk-import.mjs');
  const scans = parseCsv('Timestamp;BSSID;SSID;Level (dBm);Frequency\n2026-11-20T19:02:20Z;AA-BB-CC-00-00-01;"Net; one";-58;2437\n2026-11-20T19:02:25Z;aa:bb:cc:00:00:02;Net;-66;5745\n2026-11-20T19:10:00Z;aa:bb:cc:00:00:02;Net;-70;5745\n2026-11-20T19:02:30Z;broken;Net;-60;2412\n2026-11-20T19:01:00Z;aa:bb:cc:00:00:01;Net;-60;2412\n');
  const stops = parseCsv('time,level,x,y\n2026-11-20T19:02:10Z,1,6.4,9.1\n');
  const { rows, skipped } = convert(scans, stops);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].bssid, rows[0].band, rows[0].channel, rows[0].ssid, rows[0].pos_x], ['aa:bb:cc:00:00:01', '2.4', 6, 'Net; one', 6.4]);
  assert.deepEqual([rows[1].band, rows[1].channel, rows[1].pos_level], ['5', 149, '1']);
  assert.deepEqual(skipped, { noPlace: 2, bad: 1 });
  const store = new SampleStore().addAll(rows);
  assert.equal(store.survey.length, 2);
});
