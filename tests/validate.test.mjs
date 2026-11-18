import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, materials, schema, boxHouse } from './helpers.mjs';
import { validateFloorplan, checkSchema, formatIssues, nearest } from '../src/core/validate.js';

const errorsOf = (plan) => formatIssues(validateFloorplan(plan, schema, materials).errors);

test('a correct plan passes', () => {
  const r = validateFloorplan(boxHouse(), schema, materials);
  assert.deepEqual(r.errors, []);
});

test('the generated synthetic house passes', () => {
  const r = validateFloorplan(readJson('data/synthetic/floorplan.json'), schema, materials);
  assert.deepEqual(formatIssues(r.errors), []);
});

test('the private traced plan passes, when it exists', (t) => {
  const file = path.join(ROOT, 'data/private/floorplan.json');
  if (!fs.existsSync(file)) return t.skip('no private floor plan');
  const r = validateFloorplan(JSON.parse(fs.readFileSync(file, 'utf8')), schema, materials);
  assert.equal(r.errors.length, 0, 'the private plan has validation errors (run node tools/validate-floorplan.mjs to see them)');
});

test('missing field: says which field and where', () => {
  const plan = boxHouse();
  delete plan.levels[1].elevation;
  const e = errorsOf(plan);
  assert.equal(e.length, 1);
  assert.match(e[0], /levels\[1\].*missing the required field "elevation"/);
});

test('wrong type: says what it is and what it must be', () => {
  const plan = boxHouse();
  plan.levels[0].walls[2].a = [1, 'two'];
  assert.match(errorsOf(plan)[0], /levels\[0\]\.walls\[2\]\.a\[1\] must be a number, but it is a string \("two"\)/);
});

test('unknown field: suggests the right spelling', () => {
  const plan = boxHouse();
  plan.levels[0].walls[0].materal = 'concrete';
  assert.match(errorsOf(plan).join('\n'), /unknown field "materal"\. Did you mean "material"\?/);
});

test('unknown material: names the wall and suggests the nearest material', () => {
  const plan = boxHouse();
  plan.levels[0].walls[4].material = 'int-drywal';
  const e = errorsOf(plan);
  assert.match(e[0], /wall 4 of level "G" \(Ground\) uses the material "int-drywal", which is not in materials\.json\. Did you mean "int-drywall"\?/);
});

test('door that is not on a wall: says how far the nearest wall is', () => {
  const plan = boxHouse();
  plan.levels[0].openings[0].a = [6.2, 2.5];
  plan.levels[0].openings[0].b = [6.2, 3.5];
  assert.match(errorsOf(plan)[0], /door "G-door" of level "G" \(Ground\).*does not lie on any wall.*nearest wall is 1\.20 m away/);
});

test('duplicate ids, bad stair target, tiny room, bad enum', () => {
  const plan = boxHouse();
  plan.levels[1].id = 'G';
  plan.levels[0].stairs.push({ id: 's', polygon: [[1, 1], [2, 1], [2, 2]], connects: ['X'] });
  plan.levels[0].rooms[0].polygon = [[0, 0], [0.1, 0], [0.1, 0.1]];
  const all = errorsOf(plan).join('\n');
  assert.match(all, /two levels have the id "G"/);
  assert.match(all, /stairs "s" .* lead to level "X", which does not exist/);
  assert.match(all, /room "West room" .* encloses less than 0\.2 square metres/);
  const plan2 = boxHouse();
  plan2.levels[0].source = 'guess';
  assert.match(errorsOf(plan2)[0], /levels\[0\]\.source must be one of "lidar-scan", "lidar-trace", "measured", "image-trace", "drawn", "synthetic", but it is "guess"/);
});

test('warnings: a door without a state, overlapping levels', () => {
  const plan = boxHouse();
  delete plan.levels[0].openings[0].state;
  plan.levels[1].elevation = 2;
  const w = formatIssues(validateFloorplan(plan, schema, materials).warnings).join('\n');
  assert.match(w, /has no "state"/);
  assert.match(w, /reaches above the floor of level "U"/);
});

test('sample rows: the sample schema accepts good rows and explains bad ones', () => {
  const s = readJson('data/schema/sample.schema.json');
  const good = { time: '2026-11-14T05:00:00Z', node_id: 'esp32-01', kind: 'scan', bssid: '02:5a:01:00:00:24', ssid: 'x', band: '2.4', channel: 6, rssi_dbm: -61.5, noise_dbm: -95 };
  assert.deepEqual(checkSchema(good, s), []);
  const bad = { ...good, bssid: '02-F1-05-00-00-24', band: '6', rssi_dbm: 12 };
  const e = formatIssues(checkSchema(bad, s)).join('\n');
  assert.match(e, /bssid has the wrong format/);
  assert.match(e, /band must be one of "2\.4", "5", but it is "6"/);
  assert.match(e, /rssi_dbm must be at most 0, but it is 12/);
  const lines = fs.readFileSync(path.join(ROOT, 'data/synthetic/samples.ndjson'), 'utf8').split('\n').filter(Boolean).slice(1, 400);
  for (const line of lines) assert.deepEqual(checkSchema(JSON.parse(line), s), [], line);
});

test('nearest: only suggests close names', () => {
  assert.equal(nearest('concret', ['concrete', 'glass-lowe']), 'concrete');
  assert.equal(nearest('zzzzzz', ['concrete', 'glass-lowe']), null);
});
