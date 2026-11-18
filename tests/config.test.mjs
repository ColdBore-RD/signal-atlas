import test from 'node:test';
import assert from 'node:assert/strict';
import { materials, schema, boxHouse, testAp } from './helpers.mjs';
import { applyApPositions, bandList } from '../src/core/config.js';
import { validateFloorplan, formatIssues } from '../src/core/validate.js';
import { buildModelContext, absoluteZ } from '../src/core/propagation.js';

test('a saved position carries height and cabinet loss to the emitter', () => {
  const saved = { positions: { ap1: { level: 'U', x: 4, y: 2, z: 0.75, heightSource: 'assumed', enclosureLossDb: 3, enclosureSource: 'assumed', source: 'placed from the owner\'s marks' } } };
  const [ap] = applyApPositions([testAp()], saved, ['G', 'U']);
  assert.deepEqual({ level: ap.position.level, x: ap.position.x, y: ap.position.y, z: ap.position.z }, { level: 'U', x: 4, y: 2, z: 0.75 });
  assert.equal(ap.position.source, 'placed from the owner\'s marks');
  assert.deepEqual(ap.tx_dbm, { 2.4: 17, 5: 17 });           // 3 dB of cabinet loss taken off
  assert.deepEqual(ap.tx_dbm_nominal, { 2.4: 20, 5: 20 });
  // applying a second saved set does not take the loss off twice
  const [again] = applyApPositions([ap], saved, ['G', 'U']);
  assert.deepEqual(again.tx_dbm, { 2.4: 17, 5: 17 });
});

test('the height of an emitter is used by the model', () => {
  const ctx = buildModelContext(boxHouse(), materials);
  assert.equal(absoluteZ(ctx, { level: 'U', x: 1, y: 1, z: 0.75 }), 3.75);
  assert.equal(absoluteZ(ctx, { level: 'U', x: 1, y: 1 }), 3 + materials.defaults.device_height_m);
});

test('a position on an unknown level is ignored', () => {
  const [ap] = applyApPositions([testAp()], { positions: { ap1: { level: 'X', x: 9, y: 9 } } }, ['G', 'U']);
  assert.equal(ap.position.level, 'G');
});

test('the band list is a setting', () => {
  assert.deepEqual(bandList({ bands: [{ id: '2.4', label: '2.4 GHz' }, { id: '5', label: '5 GHz' }] }, materials).map((b) => b.id), ['2.4', '5']);
  // a band with no path-loss numbers in materials.json cannot be used and is left out
  assert.deepEqual(bandList({ bands: [{ id: '5' }, { id: '0.915', label: '915 MHz' }] }, materials).map((b) => b.id), ['5']);
  // other radio work: add the numbers and the band appears, with its own label and frequency
  const sdr = { ...materials, pathLoss: { ...materials.pathLoss, '0.915': { pl0_db: 31.7, n: 2.1, freq_mhz: 915 } } };
  assert.deepEqual(bandList({ bands: [{ id: '0.915', label: '915 MHz' }] }, sdr), [{ id: '0.915', label: '915 MHz', freq_mhz: 915 }]);
  // no setting: fall back to the bands of materials.json
  assert.deepEqual(bandList({}, materials).map((b) => b.id), materials.bands);
});

test('the floor-plan schema accepts what the LiDAR importer writes', () => {
  const plan = boxHouse();
  plan.levels[0].source = 'lidar-scan';
  Object.assign(plan.levels[0].rooms[0], { sourceLabel: 'Living Room 1', ceilingHeight: 5.1, ceilingHeightMax: 5.4, ceilingSource: 'lidar-approx' });
  Object.assign(plan.levels[0].walls[0], { origin: 'gap-closure', note: 'added by the importer' });
  assert.deepEqual(formatIssues(validateFloorplan(plan, schema, materials).errors), []);
  plan.levels[0].walls[0].origin = 'guessed';
  assert.match(formatIssues(validateFloorplan(plan, schema, materials).errors)[0], /origin must be one of "scan", "owner-fix", "gap-closure"/);
});

test('the geometry schema has no radio-specific field', () => {
  assert.doesNotMatch(JSON.stringify(schema).replace(/"description":\s*"[^"]*"/g, ''), /wifi|wi-fi|ssid|bssid|rssi|dbm|channel|2\.4|ghz/i);
});
