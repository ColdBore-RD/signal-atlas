// Tests for the /api/layout endpoints (tools/layout-api.mjs) and the --public mode of
// tools/serve.mjs. Each test server gets its own empty user workspace in the temp folder,
// so neither data/user/ nor data/private/ of this checkout is read or changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readJson, materials, schema } from './helpers.mjs';
import { startServer } from '../tools/serve.mjs';
import { validateFloorplan } from '../src/core/validate.js';
import { newDraft, draftToFloorplan } from '../src/core/layout.js';

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
function sample() {
  const draft = newDraft('Made-up house');
  draft.levels[0].rooms.push({ id: '1-r1', name: 'Room one', polygon: rect(0, 0, 5, 4) }, { id: '1-r2', name: 'Room two', polygon: rect(5, 0, 9, 4) });
  return { draft, plan: draftToFloorplan(draft, materials).plan };
}
async function withServer(options, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-layout-'));
  const srv = await startServer({ port: 0, quiet: true, userDir: dir, python: false, ...options });
  const call = async (method, route, body, headers = {}) => {
    const raw = body instanceof Uint8Array;
    const res = await fetch(srv.url + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }), ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, data, text };
  };
  try { await fn({ srv, dir, call }); } finally { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('a valid plan is saved to the user workspace and read back; a broken one is refused', async () => {
  await withServer({}, async ({ dir, call }) => {
    const empty = await call('GET', '/api/layout');
    assert.equal(empty.status, 200);
    assert.deepEqual([empty.data.plan, empty.data.draft, empty.data.workspace], [null, null, 'data/user']);
    assert.equal((await call('GET', '/data/user/floorplan.json')).text, 'null', 'a missing plan answers null, not 404');

    const { draft, plan } = sample();
    const broken = JSON.parse(JSON.stringify(plan));
    broken.levels[0].walls[0].material = 'cheese';
    const bad = await call('PUT', '/api/layout', { plan: broken, draft });
    assert.equal(bad.status, 400);
    assert.match(bad.data.errors.join('\n'), /cheese/);
    assert.equal(fs.existsSync(path.join(dir, 'floorplan.json')), false, 'nothing is written for a broken plan');
    assert.equal((await call('PUT', '/api/layout', { draft: { version: 7 } })).status, 400);
    assert.equal((await call('PUT', '/api/layout', {})).status, 400);

    fs.writeFileSync(path.join(dir, 'config.user.json'), JSON.stringify({ networks: { home: { label: 'kept' } }, private: { other: 1 } }));
    const ok = await call('PUT', '/api/layout', { plan, draft, site: { northDeg: 12, northSource: 'compass' } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.data.files, ['data/user/floorplan.json', 'data/user/config.user.json', 'data/user/layout-draft.json']);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'floorplan.json'), 'utf8'));
    assert.deepEqual(validateFloorplan(stored, schema, materials).errors, []);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.user.json'), 'utf8'));
    assert.deepEqual([config.private.houseName, config.private.other, config.networks.home.label, config.site.northDeg], ['Made-up house', 1, 'kept', 12]);

    const back = await call('GET', '/api/layout');
    assert.deepEqual(back.data.plan, plan);
    assert.deepEqual(back.data.draft, draft);
    assert.deepEqual((await call('GET', '/data/user/floorplan.json')).data, plan, 'the page reads the plan as a file of the workspace');

    // a draft alone is a save without applying
    const later = { ...draft, name: 'Second name' };
    assert.equal((await call('PUT', '/api/layout', { draft: later })).status, 200);
    assert.equal((await call('GET', '/api/layout')).data.plan.name, 'Made-up house');
    assert.equal((await call('GET', '/api/layout')).data.draft.name, 'Second name');
  });
});

test('the picture under a floor is stored, listed and removed', async () => {
  await withServer({}, async ({ dir, call }) => {
    assert.equal((await call('PUT', '/api/layout/underlay?level=1', { dataUrl: 'data:text/html;base64,PGI+' })).status, 400);
    assert.equal((await call('PUT', '/api/layout/underlay?level=../x', { dataUrl: PNG })).status, 400);
    const put = await call('PUT', '/api/layout/underlay?level=1', { dataUrl: PNG });
    assert.deepEqual([put.status, put.data.file], [200, 'data/user/underlay-1.png']);
    assert.ok(fs.statSync(path.join(dir, 'underlay-1.png')).size > 50);
    assert.deepEqual((await call('GET', '/api/layout')).data.underlays, { 1: 'data/user/underlay-1.png' });
    assert.equal((await call('GET', '/data/user/underlay-1.png')).status, 200, 'the page loads the picture as a file of the workspace');
    assert.equal((await call('DELETE', '/api/layout/underlay?level=1')).status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'underlay-1.png')), false);
  });
});

test('removing the layout clears everything this panel made and keeps other settings', async () => {
  await withServer({}, async ({ dir, call }) => {
    const { draft, plan } = sample();
    fs.writeFileSync(path.join(dir, 'config.user.json'), JSON.stringify({ networks: { home: { label: 'kept' } } }));
    await call('PUT', '/api/layout', { plan, draft, site: { northDeg: 5 } });
    await call('PUT', '/api/ap-positions', { floorplan: 'data/user/floorplan.json', positions: { 'mesh-a': { level: '1', x: 3, y: 3 } } });
    assert.ok(fs.existsSync(path.join(dir, 'ap-positions.json')));
    await call('PUT', '/api/layout/underlay?level=1', { dataUrl: PNG });
    await call('PUT', '/api/layout/scan-file?level=floor-1&name=floorplan.csv', new TextEncoder().encode('a,b,c\n'));
    assert.ok(fs.existsSync(path.join(dir, 'scan', 'floor-1', 'floorplan.csv')));
    // a new import starts from an empty upload folder
    assert.equal((await call('DELETE', '/api/layout/scan')).status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'scan')), false);
    await call('PUT', '/api/layout/scan-file?level=floor-1&name=floorplan.csv', new TextEncoder().encode('a,b,c\n'));
    assert.equal((await call('DELETE', '/api/layout')).status, 200);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['config.user.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.user.json'), 'utf8')), { networks: { home: { label: 'kept' } } }, 'the house name and north are gone; settings of other panels stay');
  });
});

test('another site cannot write a layout, and odd upload names are refused', async () => {
  await withServer({}, async ({ dir, call }) => {
    const { plan } = sample();
    assert.equal((await call('PUT', '/api/layout', { plan }, { Origin: 'http://evil.example' })).status, 403);
    for (const q of ['level=floor-1&name=..%2Fx.dxf', 'level=..&name=floorplan.dxf', 'level=floor-1&name=evil.exe', 'level=FLOOR&name=floorplan.dxf']) {
      assert.equal((await call('PUT', `/api/layout/scan-file?${q}`, new Uint8Array([1, 2, 3]))).status, 400, q);
    }
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal((await call('POST', '/api/layout/import-scan', { levels: [{ key: 'floor-1', id: '1', name: 'First', construction: 'main' }] })).status, 400, 'no DXF was sent');
    assert.equal((await call('POST', '/api/layout/import-scan', { levels: [{ key: 'floor-1', id: '1', name: 'First', construction: 'castle' }] })).status, 400);
    await call('PUT', '/api/layout/scan-file?level=floor-1&name=floorplan.dxf', new TextEncoder().encode('0\nEOF\n'));
    const off = await call('POST', '/api/layout/import-scan', { levels: [{ key: 'floor-1', id: '1', name: 'First', construction: 'main' }] });
    assert.equal(off.status, 501, 'without Python the answer says what to set up');
    assert.match(off.data.setup, /ezdxf/);
    assert.equal((await call('GET', '/api/layout/scan-status')).data.available, false);
    assert.equal((await call('GET', '/api/layout/nothing')).status, 404);
  });
});

test('text/plain bodies are refused, so a form on another site cannot post', async () => {
  await withServer({}, async ({ srv }) => {
    const res = await fetch(`${srv.url}/api/layout`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(res.status, 415);
  });
});

test('a public server serves nothing from data/private and saves positions to the user workspace', async () => {
  // a made-up file in its own folder under data/private/, removed again below; nothing that exists there is read or changed
  const probeDir = path.join(ROOT, 'data', 'private', `layout-api-test-${process.pid}`);
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, 'probe.json'), '{"made":"up"}');
  const rel = `/data/private/${path.basename(probeDir)}/probe.json`;
  const positions = { floorplan: 'data/synthetic/floorplan.json', positions: { 'mesh-a': { level: '1', x: 3, y: 3 } } };
  try {
    await withServer({}, async ({ dir, call }) => {
      assert.equal((await call('GET', rel)).status, 200, 'a normal server serves the private folder to this machine');
      const put = await call('PUT', '/api/ap-positions', { ...positions, floorplan: 'data/user/floorplan.json' });
      assert.equal(put.data.file, 'data/user/ap-positions.json', 'markers of a user layout go to the user workspace');
      assert.ok(fs.existsSync(path.join(dir, 'ap-positions.json')));
    });
    await withServer({ publicMode: true }, async ({ dir, call }) => {
      for (const p of [rel, rel.replace('/data/private/', '/DATA/Private/'), rel.replace('/private/', '/PRIVAT~1/'), '/data/private/floorplan.json']) assert.equal((await call('GET', p)).status, 404, p);
      assert.equal((await call('GET', '/data/private/config.local.json')).text, 'null');
      assert.equal((await call('GET', '/data/config.default.json')).status, 200);
      const put = await call('PUT', '/api/ap-positions', positions);
      assert.equal(put.data.file, 'data/user/ap-positions.json');
      assert.ok(fs.existsSync(path.join(dir, 'ap-positions.json')));
      const wp = await call('POST', '/api/waypoints', { level: '1', x: 2, y: 2 });
      assert.equal(wp.status, 200);
      assert.ok(fs.existsSync(path.join(dir, 'waypoints.ndjson')), 'waypoints of a public server stay in the user workspace');
    });
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
    try { fs.rmdirSync(path.dirname(probeDir)); } catch { /* the folder holds real data, or was there before: it stays */ }
  }
});

// The scan import needs Python with the importer's packages. Without them this test is skipped.
const venv = [path.join(ROOT, '.venv', 'Scripts', 'python.exe'), path.join(ROOT, '.venv', 'bin', 'python')].find((p) => fs.existsSync(p));
const pythonOk = !!venv && spawnSync(venv, ['-c', 'import ezdxf, shapely, numpy, PIL']).status === 0;
test('a made-up scan export is imported through the server and gives a valid plan', { skip: pythonOk ? false : 'no .venv with ezdxf, numpy, pillow and shapely' }, async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-scan-'));
  // the DXF and CSV are written by the helpers of the importer's own test: a made-up 8 x 6 m floor with a secret address in it
  const script = [
    'import sys', `sys.path.insert(0, r"${path.join(ROOT, 'tools', 'trace')}")`, 'import test_import_polycam as t',
    'walls = [((0, 0), (8, 0)), ((8, 0), (8, 6)), ((8, 6), (0, 6)), ((0, 6), (0, 0)), ((5, 0), (5, 6))]',
    'rooms = [("Living Room 1", [(0, 0), (5, 0), (5, 6), (0, 6)]), ("Bedroom 1", [(5, 0), (8, 0), (8, 6), (5, 6)])]',
    `t.write_dxf(r"${path.join(src, 'floorplan.dxf')}", walls, rooms, doors=[((5, 1), (5, 1.9)), ((3, 0), (3.9, 0))], windows=[((1, 0), (2.2, 0))])`,
    `t.write_csv(r"${path.join(src, 'floorplan.csv')}", 0.0, [("Living Room 1", 28.9, 2.6), ("Bedroom 1", 17.0, 2.6)], 50.0)`,
    'print(t.SECRET_ADDRESS)',
  ].join('\n');
  const made = spawnSync(venv, ['-c', script], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const secret = made.stdout.trim();
  try {
    await withServer({ python: venv }, async ({ dir, call }) => {
      assert.equal((await call('GET', '/api/layout/scan-status')).data.available, true);
      for (const name of ['floorplan.dxf', 'floorplan.csv']) {
        const up = await call('PUT', `/api/layout/scan-file?level=floor-1&name=${name}`, new Uint8Array(fs.readFileSync(path.join(src, name))));
        assert.equal(up.status, 200, up.text);
      }
      const res = await call('POST', '/api/layout/import-scan', { levels: [{ key: 'floor-1', id: '1', name: 'Ground', construction: 'main', anchor: true }] });
      assert.equal(res.status, 200, res.text);
      const plan = res.data.plan;
      assert.deepEqual(validateFloorplan(plan, schema, materials).errors, []);
      assert.equal(plan.levels.length, 1);
      assert.deepEqual([plan.levels[0].id, plan.levels[0].name, plan.levels[0].source], ['1', 'Ground', 'lidar-scan']);
      assert.equal(plan.levels[0].rooms.length, 2);
      assert.deepEqual(plan.levels[0].openings.map((o) => o.type).sort(), ['door', 'door', 'window']);
      assert.ok(res.data.site && res.data.site.northDeg === 0, 'the compass row of the CSV makes north known');
      assert.ok(!res.text.includes(secret) && !res.text.toLowerCase().includes('secret street'), 'the address in the export is not in the answer');
      assert.ok(!res.text.includes('data/private') && !/private/i.test(plan.note), 'the answer does not speak of the private folder');
      // the import does not become the active plan by itself: the panel applies it
      assert.equal(fs.existsSync(path.join(dir, 'floorplan.json')), false);
      const broken = await call('PUT', '/api/layout/scan-file?level=floor-2&name=floorplan.dxf', new TextEncoder().encode('this is not a DXF'));
      assert.equal(broken.status, 200);
      const fail = await call('POST', '/api/layout/import-scan', { levels: [{ key: 'floor-2', id: '1', name: 'Bad', construction: 'main' }] });
      assert.equal(fail.status, 422);
      assert.match(fail.data.error, /could not read/);
    });
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('the demo configuration never names the user or the private folder', () => {
  const base = readJson('data/config.default.json');
  assert.ok(!/data\/(private|user)\//.test(JSON.stringify(base.paths)));
});
