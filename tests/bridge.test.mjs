import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { normalize, parseTopic, SUBSCRIPTIONS } from '../bridge/normalize.mjs';
import { createHub } from '../bridge/bridge.mjs';
import { checkSchema } from '../src/core/validate.js';
import { readJson } from './helpers.mjs';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const scan = { time: '2026-11-16T11:59:58Z', node_id: 'whatever', kind: 'scan', bssid: 'AA:BB:CC:00:11:22', ssid: 'Net', band: '2.4', channel: 6, rssi_dbm: -61, seq: 9 };

test('bridge: topics', () => {
  assert.deepEqual(parseTopic('sensors/wifi-atlas/esp32-a1b2c3/scan'), { nodeId: 'esp32-a1b2c3', channel: 'scan' });
  assert.equal(parseTopic('sensors/wifi-atlas/esp32/scan/extra'), null);
  assert.equal(parseTopic('sensors/other/esp32/scan'), null);
  assert.equal(parseTopic('sensors/wifi-atlas/bad id/scan'), null);
  assert.equal(parseTopic('sensors/wifi-atlas/esp32/command'), null);
  assert.deepEqual(SUBSCRIPTIONS, ['sensors/wifi-atlas/+/scan', 'sensors/wifi-atlas/+/status']);
});

test('bridge: a scan message becomes a row that follows the data contract', () => {
  const { row } = normalize('sensors/wifi-atlas/esp32-a1b2c3/scan', JSON.stringify(scan), NOW);
  assert.equal(row.node_id, 'esp32-a1b2c3', 'the node id comes from the topic, not from the payload');
  assert.equal(row.bssid, 'aa:bb:cc:00:11:22');
  assert.equal(row.time, '2026-11-16T11:59:58Z');
  assert.equal(row.seq, undefined, 'unknown fields are dropped');
  assert.deepEqual(checkSchema(row, readJson('data/schema/sample.schema.json')), []);
});

test('bridge: a missing or wrong clock gets the arrival time', () => {
  const noTime = { ...scan }; delete noTime.time;
  assert.equal(normalize('sensors/wifi-atlas/n1/scan', JSON.stringify(noTime), NOW).row.time, '2026-11-16T12:00:00Z');
  assert.equal(normalize('sensors/wifi-atlas/n1/scan', JSON.stringify({ ...scan, time: '1970-01-01T00:00:10Z' }), NOW).row.time, '2026-11-16T12:00:00Z');
});

test('bridge: bad messages are rejected with a reason', () => {
  const bad = (payload, topic = 'sensors/wifi-atlas/n1/scan') => normalize(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), NOW).error;
  assert.match(bad('not json'), /not JSON/);
  assert.match(bad([1, 2]), /not a JSON object/);
  assert.match(bad({ ...scan, bssid: 'nope' }), /bssid/);
  assert.match(bad({ ...scan, rssi_dbm: 20 }), /rssi_dbm/);
  assert.match(bad({ ...scan, band: '6' }), /band/);
  assert.match(bad({ online: 'yes' }, 'sensors/wifi-atlas/n1/status'), /online/);
  assert.match(bad(scan, 'homeassistant/switch/x/set'), /topic/);
});

test('bridge: status and probe rows', () => {
  assert.deepEqual(normalize('sensors/wifi-atlas/n1/status', '{"online":false}', NOW).row, { time: '2026-11-16T12:00:00Z', node_id: 'n1', kind: 'status', online: false });
  const probe = normalize('sensors/wifi-atlas/pi-500/scan', JSON.stringify({ kind: 'probe', target: 'home-server', latency_ms: 2.5, jitter_ms: 0.4, loss_pct: 0, throughput_mbps: 180.2, bssid: 'AA:BB:CC:00:11:22' }), NOW).row;
  assert.equal(probe.kind, 'probe'); assert.equal(probe.target, 'home-server'); assert.equal(probe.throughput_mbps, 180.2); assert.equal(probe.bssid, 'aa:bb:cc:00:11:22');
});

test('bridge: /live sends rows to a listener, /health counts, and nothing but GET is allowed', async () => {
  const hub = createHub();
  await new Promise((r) => hub.server.listen(0, '127.0.0.1', r));
  const { port } = hub.server.address();
  hub.onMessage('sensors/wifi-atlas/n1/scan', JSON.stringify(scan));        // before anyone listens: goes to the backlog
  const received = [];
  await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/live' }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      res.setEncoding('utf8');
      let sent = false;
      res.on('data', (chunk) => {
        for (const line of chunk.split('\n')) if (line.startsWith('data: {"time"')) received.push(JSON.parse(line.slice(6)));
        if (!sent) { sent = true; hub.onMessage('sensors/wifi-atlas/n2/status', '{"online":true}'); hub.onMessage('sensors/wifi-atlas/n2/scan', 'garbage'); }
        if (received.length >= 2) { req.destroy(); resolve(); }
      });
    });
    req.on('error', (e) => { if (received.length < 2) reject(e); });
  });
  assert.equal(received[0].node_id, 'n1');
  assert.equal(received[1].kind, 'status');
  const health = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b))); }));
  assert.equal(health.accepted, 2); assert.equal(health.rejected, 1); assert.match(health.lastError, /not JSON/);
  const post = await new Promise((resolve) => { const r = http.request({ host: '127.0.0.1', port, path: '/live', method: 'POST' }, (res) => resolve(res.statusCode)); r.end(); });
  assert.equal(post, 405);
  await hub.close();
});
