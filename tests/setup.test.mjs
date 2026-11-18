// The user's networks and devices (Setup panel): the rules, the live model update and the server address.
// Every name and address here is made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { materials, grades, boxHouse, readJson } from './helpers.mjs';
import { setupFromConfig, applySetup, validateSetup, cleanSetup, newDevice, nextId, normalizeMac, mountHeight, mountOf, networkColors, radiosFromScans, scanCandidates, NETWORK_COLORS, LIMITS } from '../src/core/setup.js';
import { SampleStore } from '../src/core/samples.js';
import { AtlasModel } from '../src/app/atlas-model.js';
import { startServer } from '../tools/serve.mjs';

const BANDS = ['2.4', '5'];
const sample = () => ({
  schemaVersion: 1, floorplan: 'plan.json',
  networks: [{ id: 'home', label: 'Home', ssid: 'Example-Home', color: '#ff9d6e', upstream: null }, { id: 'guest', label: 'Guest', ssid: 'Example-Guest', upstream: 'home' }],
  devices: [
    { id: 'ap-1', type: 'ap', label: 'Router', network: 'home', model: 'Made-up 100', tx_dbm: { 2.4: 20, 5: 23 }, channel: { 2.4: 6, 5: 36 }, bssid: { 2.4: '02:00:00:00:0a:01', 5: '02:00:00:00:0a:02' }, position: { level: 'G', x: 2, y: 3, z: 0.9, heightSource: 'assumed' }, mount: 'shelf' },
    { id: 'ap-2', type: 'mesh', label: 'Mesh upstairs', network: 'guest', tx_dbm: { 2.4: 18 }, channel: {}, bssid: {}, position: null },
    { id: 'sensor-1', type: 'esp32', label: 'Hall sensor', mac: '02:00:00:00:0b:01', position: { level: 'U', x: 8, y: 3 } },
    { id: 'client-1', type: 'client', label: 'A phone', position: null },
  ],
});

test('a free mount text of the config becomes a mount of the setup, so the setup made from it is valid', () => {
  assert.deepEqual(['inside a cabinet', 'on a table against the wall', 'on a console (mounting not confirmed)', 'mounted on the wall', 'on the ceiling', 'on the floor', 'wall', '', undefined].map(mountOf),
    ['shelf', 'shelf', 'shelf', 'wall', 'ceiling', 'floor', 'wall', null, null]);
  const config = readJson('data/config.default.json');
  const aps = config.aps.map((ap, i) => ({ ...ap, position: { ...ap.position, mount: ['inside a cabinet', 'on a table against the wall', 'on the ceiling'][i % 3] } }));
  assert.deepEqual(validateSetup(setupFromConfig({ ...config, aps }, [])), []);
});

test('a setup made from the public config gives the same networks, access points and nodes back', () => {
  const config = readJson('data/config.default.json'), nodes = readJson('data/synthetic/nodes.json').nodes;
  const levelIds = readJson(config.paths.floorplan).levels.map((l) => l.id);
  const setup = setupFromConfig(config, nodes);
  assert.deepEqual(validateSetup(setup), []);
  assert.equal(setup.floorplan, config.paths.floorplan);
  const back = applySetup(config, nodes, setup, { levelIds, bandIds: BANDS });
  assert.deepEqual(Object.keys(back.config.networks), Object.keys(config.networks));
  for (const ap of config.aps) {
    const now = back.config.aps.find((a) => a.id === ap.id);
    assert.deepEqual([now.label, now.network, now.tx_dbm, now.channel, now.bssid], [ap.label, ap.network, ap.tx_dbm, ap.channel, ap.bssid]);
    assert.deepEqual([now.position.level, now.position.x, now.position.y, now.position.source], [ap.position.level, ap.position.x, ap.position.y, ap.position.source]);
  }
  assert.deepEqual(back.nodes.map((n) => n.id).sort(), nodes.map((n) => n.id).sort());
  const walker = nodes.find((n) => n.type === 'survey');
  assert.ok(walker && back.nodes.includes(walker), 'the walk-test phone is no device of the setup and is passed through');
  // the first two networks keep the colours the page always had
  assert.deepEqual(Object.values(networkColors(config.networks)), NETWORK_COLORS.slice(0, 2));
  // what the page shows again (the private placeholders) must not grow into the setup
  assert.ok(!JSON.stringify(setup).includes('houseName'));
});

test('what the user removed stays removed, and an access point of a removed network belongs to none', () => {
  const setup = sample();
  setup.networks.pop();                                         // the guest network goes
  setup.devices = setup.devices.filter((d) => d.id !== 'sensor-1');
  const base = { paths: {}, networks: { old: { label: 'Old', ssid: 'x' } }, aps: [{ id: 'old-ap', position: { level: 'G', x: 1, y: 1 } }] };
  const { config, nodes } = applySetup(base, [{ id: 'sensor-1', type: 'esp32' }, { id: 'walker', type: 'survey', position: null }], setup, { levelIds: ['G', 'U'], bandIds: BANDS });
  assert.deepEqual(Object.keys(config.networks), ['home']);
  assert.deepEqual(config.aps.map((a) => [a.id, a.network]), [['ap-1', 'home'], ['ap-2', '']]);
  assert.deepEqual(nodes.map((n) => n.id), ['client-1', 'walker']);
  assert.deepEqual(config.paths, {}, 'the rest of the config is kept');
});

test('a device that is not placed, or stands on a level this plan lacks, has no position', () => {
  const setup = sample();
  const at = (levelIds) => applySetup({ networks: {}, aps: [] }, [], setup, { levelIds, bandIds: BANDS });
  const here = at(['G', 'U']);
  assert.deepEqual(here.config.aps.map((a) => a.position?.level ?? null), ['G', null]);
  assert.equal(here.nodes.find((n) => n.id === 'sensor-1').position.level, 'U');
  const other = at(['1', '2']);                                  // the same setup on another plan
  assert.deepEqual(other.config.aps.map((a) => a.position), [null, null]);
  assert.equal(other.nodes.find((n) => n.id === 'sensor-1').position, null);
  assert.equal(setup.devices[0].position.level, 'G', 'the setup itself keeps the place');
});

test('transmit power: every band gets a value, and cabinet loss is taken off once', () => {
  const setup = sample();
  setup.devices[0].enclosureLossDb = 3;
  const { config } = applySetup({ networks: {}, aps: [] }, [], setup, { levelIds: ['G'], bandIds: BANDS });
  const [router, mesh] = config.aps;
  assert.deepEqual(router.tx_dbm, { 2.4: 17, 5: 20 });
  assert.deepEqual(router.tx_dbm_nominal, { 2.4: 20, 5: 23 });
  assert.deepEqual(router.enclosure, { lossDb: 3, source: 'assumed' });
  assert.deepEqual(mesh.tx_dbm, { 2.4: 18, 5: 20 }, 'a band without a value gets the usual 20 dBm');
  assert.equal(mesh.kind, 'mesh');
  // and back: the setup holds the nominal power, so the loss is not taken off twice
  const again = setupFromConfig(config, []);
  assert.deepEqual(again.devices[0].tx_dbm, { 2.4: 20, 5: 23 });
  assert.equal(again.devices[0].enclosureLossDb, 3);
  assert.equal(again.devices[1].type, 'mesh');
});

test('the checks say in words what is wrong', () => {
  assert.deepEqual(validateSetup(sample()), []);
  const broken = (change) => { const s = sample(); change(s); return validateSetup(s).join(' | '); };
  assert.match(broken((s) => { s.devices[1].id = 'ap-1'; }), /device "ap-1" is listed twice/);
  assert.match(broken((s) => { s.devices[0].bssid['5'] = 'not-a-mac'; }), /band 5: a BSSID must look like/);
  assert.match(broken((s) => { s.devices[0].type = 'toaster'; }), /type must be one of ap, mesh, esp32, pi, client, wired/);
  assert.match(broken((s) => { s.devices[0].tx_dbm['2.4'] = 90; }), /transmit power must be -20 to 36 dBm/);
  assert.match(broken((s) => { s.devices[0].channel['2.4'] = 6.5; }), /a channel is a whole number/);
  assert.match(broken((s) => { s.devices[0].network = 'nowhere'; }), /its network is not in the list/);
  // values of the wrong kind that a pattern alone would let through
  assert.match(broken((s) => { s.devices[2].mac = ['02:00:00:00:0b:01']; }), /the MAC address must look like/);
  assert.match(broken((s) => { s.devices[0].bssid['5'] = ['02:00:00:00:0a:02']; }), /a BSSID must look like/);
  assert.match(broken((s) => { s.devices[0].id = 5; }), /a device has no usable id/);
  assert.match(broken((s) => { s.networks[0].id = ['home']; }), /a network has no usable id/);
  assert.match(broken((s) => { s.networks[1].id = 'best'; }), /a network has no usable id/);
  assert.match(broken((s) => { s.networks[1].id = '__proto__'; }), /a network has no usable id/);
  assert.match(broken((s) => { s.devices[0].network = ['home']; }), /its network is not in the list/);
  assert.equal(broken((s) => { s.devices[0].bssid['5'] = '02:00:00:00:0A:02'; }), '', 'upper case in a BSSID is fine; it is saved in lower case');
  assert.match(broken((s) => { s.devices[0].position = { level: 'G', x: 9999, y: 0 }; }), /a position needs a level id and x and y in metres/);
  assert.match(broken((s) => { s.devices[0].position.z = 40; }), /the height must be 0 to 20 m/);
  assert.match(broken((s) => { s.devices[0].id = '../x'; }), /a device has no usable id/);
  assert.match(broken((s) => { s.networks[0].ssid = 'x'.repeat(33); }), /an SSID has at most 32 characters/);
  assert.match(broken((s) => { s.networks[0].color = 'red'; }), /the colour must look like/);
  assert.match(broken((s) => { s.devices = Array.from({ length: LIMITS.devices + 1 }, (_, i) => ({ id: `d${i}`, type: 'client' })); }), /at most 200 devices/);
  assert.deepEqual(validateSetup(null), ['the setup must be an object']);
  assert.deepEqual(validateSetup({ networks: {} }), ['the setup needs a "networks" list and a "devices" list']);
});

test('only known fields are saved, with BSSIDs in lower case', () => {
  const setup = sample();
  setup.extra = 'x';
  setup.devices[0].secretNote = 'x';
  setup.devices[0].bssid['2.4'] = '02:00:00:00:0A:01';
  setup.devices[2].tx_dbm = { 2.4: 20 };                         // a sensor has no transmit power in the file
  const clean = cleanSetup(setup, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(clean), ['schemaVersion', 'saved', 'floorplan', 'networks', 'devices']);
  assert.equal(clean.devices[0].secretNote, undefined);
  assert.equal(clean.devices[0].bssid['2.4'], '02:00:00:00:0a:01');
  assert.deepEqual(Object.keys(clean.devices[2]), ['id', 'type', 'label', 'mac', 'position']);
  assert.deepEqual(clean.devices[1].position, null);
  assert.deepEqual(validateSetup(clean), []);
});

test('small helpers: ids, MAC addresses, mount heights, a new device', () => {
  assert.equal(nextId('ap', ['ap-1', 'ap-2', 'ap-4']), 'ap-3');
  assert.equal(normalizeMac('02-00-00-AA-BB-CC'), '02:00:00:aa:bb:cc');
  assert.equal(normalizeMac('020000aabbcc'), '02:00:00:aa:bb:cc');
  assert.equal(normalizeMac('02:00:00:aa:bb'), null);
  assert.equal(mountHeight('ceiling', 2.6), 2.5);
  assert.equal(mountHeight('floor'), 0.1);
  assert.equal(mountHeight(undefined), null);
  const setup = sample();
  const ap = newDevice('ap', setup, BANDS);
  assert.deepEqual([ap.id, ap.label, ap.network, ap.position, ap.tx_dbm], ['ap-3', 'Access point 2', 'home', null, { 2.4: 20, 5: 20 }]);
  const pi = newDevice('pi', setup, BANDS);
  assert.deepEqual([pi.id, pi.type, pi.label, pi.tx_dbm], ['sensor-2', 'pi', 'Pi sensor 1', undefined]);
  setup.devices.push(ap, pi);
  assert.deepEqual(validateSetup(setup), []);
});

test('the scan helper lists each radio once and offers only radios of the same SSID and band that are still free', () => {
  const rows = [
    { kind: 'meta' },
    { kind: 'scan', bssid: '02:00:00:00:0A:01', ssid: 'Example-Home', band: '2.4', channel: 6, rssi_dbm: -40 },
    { kind: 'scan', bssid: '02:00:00:00:0a:01', ssid: 'Example-Home', band: '2.4', channel: 6, rssi_dbm: -44 },
    { kind: 'scan', bssid: '02:00:00:00:0a:09', ssid: 'Example-Home', band: '2.4', channel: 11, rssi_dbm: -61 },
    { kind: 'scan', bssid: '02:00:00:00:0a:0a', ssid: 'Example-Home', band: '5', channel: 149, rssi_dbm: -55 },
    { kind: 'scan', bssid: '02:00:00:00:ff:01', ssid: 'Someone-Else', band: '2.4', channel: 1, rssi_dbm: -30 },
    { kind: 'scan', bssid: 'broken', ssid: 'Example-Home', band: '2.4', rssi_dbm: -20 },
  ];
  const radios = radiosFromScans(rows);
  assert.deepEqual(radios.map((r) => [r.bssid, r.count, r.rssi_dbm]), [['02:00:00:00:ff:01', 1, -30], ['02:00:00:00:0a:01', 2, -40], ['02:00:00:00:0a:0a', 1, -55], ['02:00:00:00:0a:09', 1, -61]]);
  const setup = sample();
  setup.devices[1].network = 'home';
  // ap-1 already has ...0a:01 on 2.4 GHz, so the second access point is offered only the other radio
  assert.deepEqual(scanCandidates(radios, setup, setup.devices[1], '2.4').map((r) => r.bssid), ['02:00:00:00:0a:09']);
  assert.deepEqual(scanCandidates(radios, setup, setup.devices[0], '2.4').map((r) => r.bssid), ['02:00:00:00:0a:01', '02:00:00:00:0a:09']);
  assert.deepEqual(scanCandidates(radios, setup, setup.devices[1], '5').map((r) => r.channel), [149]);
  setup.devices[1].network = '';
  assert.deepEqual(scanCandidates(radios, setup, setup.devices[1], '2.4'), []);
});

test('the model follows a changed setup without being built again', () => {
  const plan = boxHouse();
  const base = { bands: [{ id: '2.4' }, { id: '5' }], networks: {}, aps: [] };
  const make = (setup) => applySetup(base, [], setup, { levelIds: ['G', 'U'], bandIds: BANDS });
  const setup = sample();
  const first = make(setup);
  const model = new AtlasModel({ plan, materials, grades, config: first.config, nodes: first.nodes, store: new SampleStore() });
  assert.deepEqual(model.aps.map((a) => a.id), ['ap-1'], 'the access point without a place is left out');
  const cellAt = (level, x, y) => model.levels.findIndex((l) => l.id === level) * model.cells + Math.floor((y - model.grid.minY) / model.grid.cell) * model.grid.nx + Math.floor((x - model.grid.minX) / model.grid.cell);
  const far = cellAt('U', 9, 3);
  const before = model.envelope('2.4', 'best', 0).dbm[far];
  const kept = model.fields.get('ap-1');

  setup.devices[1].position = { level: 'U', x: 9, y: 3 };       // place the mesh point upstairs
  const second = make(setup);
  model.setDevices(second.config, second.nodes);
  assert.deepEqual(model.aps.map((a) => a.id), ['ap-1', 'ap-2']);
  assert.equal(model.fields.get('ap-1'), kept, 'an access point that did not move is not traced again');
  const after = model.envelope('2.4', 'best', 0).dbm[far];
  assert.ok(after > before + 15, `the signal next to the new mesh point rose (${before.toFixed(0)} -> ${after.toFixed(0)} dBm)`);
  assert.equal(model.envelope('2.4', 'guest', 0).dbm[far], after, 'the new access point is the one of the guest network');
  assert.deepEqual(model.coverageMatrix(0).map((r) => r.network).filter((n, i, a) => a.indexOf(n) === i), ['best', 'home', 'guest']);
  assert.ok(model.nodeById.has('sensor-1') && model.nodeStates(0).length === 2);

  setup.devices = setup.devices.filter((d) => d.type !== 'ap' && d.type !== 'mesh');   // remove every sender
  const third = make(setup);
  model.setDevices(third.config, third.nodes);
  assert.equal(model.aps.length, 0);
  assert.equal(model.envelope('2.4', 'best', 0).dbm[far], -140);
  assert.equal(model.metrics('2.4', 'best', 0).house.coveragePct, 0);
});

// ---------------------------------------------------------------------------------- the local server
function call(server, method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, method, path: pathname, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* plain text */ } resolve({ status: res.statusCode, text, json }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

test('the server keeps the setup in its own folder, checks it, and refuses other sites', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-setup-test-'));
  const scans = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-setup-scan-'));
  const server = await startServer({ port: 0, quiet: true, userDir: dir, surveyDir: scans });
  const file = path.join(dir, 'network-setup.json');
  const json = { 'Content-Type': 'application/json' };
  try {
    let r = await call(server, 'GET', '/api/setup');
    assert.deepEqual([r.status, r.json.setup, r.json.scan], [200, null, false]);

    // a page of another site, a foreign host name, and a body that is not JSON are refused
    r = await call(server, 'PUT', '/api/setup', { body: sample(), headers: { ...json, Origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    r = await call(server, 'PUT', '/api/setup', { body: sample(), headers: { ...json, Host: 'evil.example' } });
    assert.equal(r.status, 403);
    r = await call(server, 'PUT', '/api/setup', { body: sample(), headers: { 'Content-Type': 'text/plain' } });
    assert.equal(r.status, 415);
    r = await call(server, 'DELETE', '/api/setup', { headers: { Origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    r = await call(server, 'PUT', '/api/setup', { body: '{ not json', headers: json });
    assert.equal(r.status, 400);
    const bad = sample(); bad.devices[0].bssid['2.4'] = 'zz';
    r = await call(server, 'PUT', '/api/setup', { body: bad, headers: json });
    assert.equal(r.status, 400);
    assert.match(r.text, /a BSSID must look like/);
    assert.ok(!fs.existsSync(file), 'nothing was written by a refused request');

    // a good setup is saved without fields the server does not know
    const good = { ...sample(), injected: '<script>' };
    r = await call(server, 'PUT', '/api/setup', { body: good, headers: { ...json, Origin: `http://127.0.0.1:${server.port}` } });
    assert.equal(r.status, 200);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.injected, undefined);
    assert.deepEqual(saved.devices.map((d) => d.id), ['ap-1', 'ap-2', 'sensor-1', 'client-1']);
    assert.ok(Number.isFinite(Date.parse(saved.saved)));
    assert.deepEqual(fs.readdirSync(dir), ['network-setup.json'], 'no temporary file is left behind');
    r = await call(server, 'GET', '/api/setup');
    assert.deepEqual(r.json.setup, saved);

    // a refused request leaves the saved file whole, and a value of the wrong kind does not stop the server
    const odd = sample(); odd.devices[2].mac = ['02:00:00:00:0b:01'];
    r = await call(server, 'PUT', '/api/setup', { body: odd, headers: json });
    assert.equal(r.status, 400);
    r = await call(server, 'PUT', '/api/setup', { body: { networks: [], devices: [{ id: 5, type: 'ap' }] }, headers: json });
    assert.equal(r.status, 400);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), saved);
    // a name with characters of more than one byte comes through whole
    const named = sample(); named.networks[0].label = 'Zuhause Süd 家';
    r = await call(server, 'PUT', '/api/setup', { body: named, headers: json });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).networks[0].label, 'Zuhause Süd 家');
    r = await call(server, 'PUT', '/api/setup', { body: good, headers: json });
    assert.equal(r.status, 200);
    const savedAgain = JSON.parse(fs.readFileSync(file, 'utf8'));

    // a file that was edited into a bad shape is not handed to the page
    fs.writeFileSync(file, JSON.stringify({ ...savedAgain, devices: [{ id: 'x', type: 'toaster' }] }));
    r = await call(server, 'GET', '/api/setup');
    assert.equal(r.json.setup, null);

    // the scan helper reads the laptop scan log and writes nothing
    r = await call(server, 'GET', '/api/scan-radios');
    assert.deepEqual(r.json, { radios: [] });
    fs.writeFileSync(path.join(scans, 'scans-laptop.ndjson'), [
      { kind: 'meta' }, { time: '2026-01-01T00:00:00Z', node_id: 'survey-laptop', kind: 'scan', bssid: '02:00:00:00:0a:01', ssid: 'Example-Home', band: '2.4', channel: 6, rssi_dbm: -41 },
    ].map((x) => JSON.stringify(x)).join('\n') + '\nnot json\n');
    r = await call(server, 'GET', '/api/scan-radios');
    assert.deepEqual(r.json.radios, [{ bssid: '02:00:00:00:0a:01', ssid: 'Example-Home', band: '2.4', channel: 6, rssi_dbm: -41, count: 1 }]);
    assert.equal((await call(server, 'GET', '/api/setup')).json.scan, true);
    assert.equal((await call(server, 'POST', '/api/scan-radios', { body: {}, headers: json })).status, 405);

    r = await call(server, 'DELETE', '/api/setup');
    assert.equal(r.status, 200);
    assert.ok(!fs.existsSync(file));
    assert.equal((await call(server, 'DELETE', '/api/setup')).status, 200, 'removing a setup that is not there is fine');
    assert.equal((await call(server, 'POST', '/api/setup', { body: {}, headers: json })).status, 405);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(scans, { recursive: true, force: true });
  }
});

test('the owner\'s setup stays in the private folder, and a public server never reaches it', async () => {
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-setup-user-'));
  const priv = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-setup-private-'));
  const json = { 'Content-Type': 'application/json' };
  fs.writeFileSync(path.join(priv, 'scans-laptop.ndjson'), JSON.stringify({ time: '2026-01-01T00:00:00Z', node_id: 'survey-laptop', kind: 'scan', bssid: '02:00:00:00:0a:01', ssid: 'Example-Home', band: '2.4', channel: 6, rssi_dbm: -41 }) + '\n');
  let server = await startServer({ port: 0, quiet: true, userDir: user, surveyDir: priv });
  try {
    let r = await call(server, 'PUT', '/api/setup?ws=private', { body: sample(), headers: json });
    assert.equal(r.status, 200);
    assert.equal(r.json.file, 'data/private/network-setup.json');
    assert.ok(fs.existsSync(path.join(priv, 'network-setup.json')));
    assert.ok(!fs.existsSync(path.join(user, 'network-setup.json')), 'the owner\'s setup is not put in the user folder');
    assert.equal((await call(server, 'GET', '/api/setup')).json.setup, null, 'the user workspace has its own setup');
    assert.equal((await call(server, 'GET', '/api/scan-radios?ws=private')).json.radios.length, 1);
  } finally { await server.close(); }

  server = await startServer({ port: 0, quiet: true, userDir: user, surveyDir: priv, publicMode: true });
  try {
    assert.equal((await call(server, 'GET', '/api/setup?ws=private')).status, 404);
    assert.equal((await call(server, 'PUT', '/api/setup?ws=private', { body: sample(), headers: json })).status, 404);
    assert.equal((await call(server, 'GET', '/api/scan-radios?ws=private')).status, 404);
    // the user workspace works, but its scan helper does not read the private scan log
    const r = await call(server, 'GET', '/api/setup');
    assert.deepEqual([r.status, r.json.setup, r.json.scan], [200, null, false]);
    assert.deepEqual((await call(server, 'GET', '/api/scan-radios')).json, { radios: [] });
  } finally {
    await server.close();
    fs.rmSync(user, { recursive: true, force: true });
    fs.rmSync(priv, { recursive: true, force: true });
  }
});
