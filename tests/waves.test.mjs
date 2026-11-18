import test from 'node:test';
import assert from 'node:assert/strict';
import { materials, boxHouse, testAp } from './helpers.mjs';
import { spreadingLossDbPerM, airDamping, COURANT, beaconSchedule, sourceAmplitudes, buildSources, waveGridSpec, rasterizeMedium } from '../src/sim/rasterize.js';

test('loss in open air follows the path-loss exponent', () => {
  // a flat wave already loses 10 log r, so an exponent of 1 needs no extra loss
  assert.equal(spreadingLossDbPerM(1, 12), 0);
  // exponent 2.2 over 12 m: (22 - 10) * log10(12) / 11 dB per metre
  assert.ok(Math.abs(spreadingLossDbPerM(2.2, 12) - (12 * Math.log10(12)) / 11) < 1e-12);
  // a larger exponent (more loss measured) gives more loss per metre
  assert.ok(spreadingLossDbPerM(2.8, 12) > spreadingLossDbPerM(2.2, 12));
  // over the whole distance the extra loss equals the missing spreading loss
  const n = 2.5, reach = 10;
  assert.ok(Math.abs(spreadingLossDbPerM(n, reach) * (reach - 1) - (10 * n - 10) * Math.log10(reach)) < 1e-9);
  assert.ok(Math.abs(airDamping(0.06, 1.0) - (1.0 / 8.686) * COURANT * 0.06) < 1e-12);
});

test('the wave medium uses the loss that it is given, else the exponent of materials.json', () => {
  const plan = boxHouse();
  const spec = waveGridSpec(plan, 0.1);
  const airCell = (m) => m.data[((Math.floor(spec.ny / 2)) * spec.nx + 40) * 4 + 1];
  const none = rasterizeMedium(plan, materials, spec, '2.4', { airLossDbPerM: 0 });
  const some = rasterizeMedium(plan, materials, spec, '2.4', { airLossDbPerM: 2 });
  const auto = rasterizeMedium(plan, materials, spec, '2.4');
  assert.equal(airCell(none), 0);
  assert.ok(Math.abs(airCell(some) - airDamping(0.1, 2)) < 1e-7);
  assert.ok(airCell(auto) > 0 && airCell(auto) < airCell(some));
});

test('beacon schedule: radios on one channel take turns, other channels are independent', () => {
  const aps = [
    { id: 'mesh-a', channel: { 2.4: 6 } }, { id: 'mesh-b', channel: { 2.4: 6 } }, { id: 'mesh-c', channel: { 2.4: 6 } }, { id: 'router', channel: { 2.4: 1 } },
  ];
  const period = 240, length = 60;
  const s = beaconSchedule(aps, '2.4', period, length);
  const sending = (id, step) => { const p = s.get(id); return ((((step - p.offset) % p.period) + p.period) % p.period) < p.length; };
  for (let step = 0; step < period; step++) {
    const n = ['mesh-a', 'mesh-b', 'mesh-c'].filter((id) => sending(id, step)).length;
    assert.ok(n <= 1, `two radios of channel 6 send at step ${step}`);
  }
  for (const id of ['mesh-a', 'mesh-b', 'mesh-c', 'router']) assert.equal(s.get(id).period, period);     // every radio beacons at the same rate
  // a pulse that would not fit into its turn is shortened
  assert.ok(beaconSchedule(aps, '2.4', 120, 60).get('mesh-a').length <= 40);
  // the same input gives the same schedule
  assert.deepEqual([...beaconSchedule(aps, '2.4', period, length)], [...s]);
});

test('source strength follows the transmit power, cabinet loss included', () => {
  const open = testAp({ id: 'open', tx_dbm: { 2.4: 20, 5: 20 } });
  const boxed = testAp({ id: 'boxed', tx_dbm: { 2.4: 17, 5: 14 } });
  const a = sourceAmplitudes([open, boxed], '2.4');
  assert.equal(a.get('open'), 1);
  assert.ok(Math.abs(a.get('boxed') - 10 ** (-3 / 20)) < 1e-12);
  assert.ok(Math.abs(sourceAmplitudes([open, boxed], '5').get('boxed') - 0.5012) < 1e-3);    // 6 dB less is half the amplitude
});

test('a pulsed source keeps its schedule on every level it reaches, and gets no detuned frequency', () => {
  const spec = waveGridSpec(boxHouse(), 0.1);
  const pulse = { period: 200, offset: 30, length: 40 };
  const src = buildSources(spec, [{ id: 'a', position: { level: 'G', x: 2, y: 3 }, amplitude: 0.7, pulse }, { id: 'b', position: { level: 'G', x: 8, y: 3 }, pulse: { ...pulse, offset: 130 } }], 9);
  assert.ok(src.length >= 3);
  assert.ok(src.filter((s) => s.apId === 'a').every((s) => s.pulse === pulse && s.freq === 1 && s.phase === 0));
  const own = src.find((s) => s.apId === 'a' && s.floors === 0), through = src.find((s) => s.apId === 'a' && s.floors === 1);
  assert.equal(own.amp, 0.7);
  assert.ok(through.amp < own.amp);
});
