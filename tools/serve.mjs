#!/usr/bin/env node
// Local dev server for Signal Atlas. It listens on 127.0.0.1 only.
//
//   node tools/serve.mjs [--port 8137] [--public] [--live-sim] [--live-speed 60] [--live-upstream http://127.0.0.1:8787/live]
//
// What it does:
//   - serves the project folder as static files (nothing is cached)
//   - PUT /api/ap-positions saves the access-point markers that you drag in the
//     page to data/private/ap-positions.json.
//   - Survey mode: POST /api/waypoints appends the place you clicked to
//     data/private/waypoints.ndjson, DELETE /api/waypoints/last takes the last one
//     back, GET /api/survey returns the waypoints and the rows of
//     data/private/survey.ndjson.
//   - /api/setup keeps the networks and devices of the Setup panel
//     (tools/setup-api.mjs): /api/setup?ws=private in data/private/network-setup.json
//     for the owner's house, /api/setup in data/user/network-setup.json for a
//     user layout. These four files are the only things it writes under data/private/.
//   - /api/layout is the Layout setup panel (tools/layout-api.mjs). It reads and
//     writes only the user workspace data/user/. See docs/custom-layout.md.
//   - --public: data/private/ is not served or read at all, and marker positions,
//     waypoints and the network setup are saved to data/user/ instead.
//   - GET /live is a read-only server-sent-events feed, when you ask for one:
//       --live-sim        replays the recorded sample file as if it were live
//       --live-upstream   passes on the feed of the bridge service
//     Without either flag /live answers 404 and the page stays in recorded mode.
//
// It opens no connection to any device. It never reads .env files or secrets.h.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLayoutApi } from './layout-api.mjs';
import { handleSetupApi } from './setup-api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ndjson': 'application/x-ndjson; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const BLOCKED = /(^|\/)(\.env[^/]*|secrets\.h|\.git|node_modules)(\/|$)/i;
const OPTIONAL = ['/data/private/config.local.json', '/data/private/ap-positions.json', '/data/synthetic/ap-positions.json',
  '/data/user/floorplan.json', '/data/user/config.user.json', '/data/user/ap-positions.json', '/data/user/nodes.json'];
const AP_FILE = path.join(ROOT, 'data', 'private', 'ap-positions.json');
const WAYPOINT_FILE = path.join(ROOT, 'data', 'private', 'waypoints.ndjson');
const SURVEY_FILE = path.join(ROOT, 'data', 'private', 'survey.ndjson');

/** Rows of an NDJSON file, or [] when it does not exist. Bad lines are skipped. */
function readNdjson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch { return []; }
  const rows = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { /* skip bad line */ } }
  return rows;
}

function validWaypoint(body) {
  if (!body || typeof body !== 'object') return 'the body must be an object';
  if (typeof body.level !== 'string' || !/^[\w.-]{1,12}$/.test(body.level)) return 'a waypoint needs a level id';
  if (!Number.isFinite(body.x) || !Number.isFinite(body.y) || Math.abs(body.x) > 500 || Math.abs(body.y) > 500) return 'a waypoint needs x and y in metres';
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 80)) return 'the note must be a short text';
  return null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** The sample files of the active configuration (private when present, else the synthetic demo). */
function activeSampleFiles() {
  const base = readJson(path.join(ROOT, 'data', 'config.default.json')) || {};
  const local = readJson(path.join(ROOT, 'data', 'private', 'config.local.json')) || {};
  const list = local.paths?.samples || base.paths?.samples || [];
  return list.map((p) => path.join(ROOT, p)).filter((p) => fs.existsSync(p));
}

function validPositions(body) {
  if (!body || typeof body !== 'object' || typeof body.positions !== 'object' || body.positions === null) return 'the body needs a "positions" object';
  for (const [id, p] of Object.entries(body.positions)) {
    if (!/^[\w.-]{1,40}$/.test(id)) return `bad access-point id "${id}"`;
    if (!p || typeof p.level !== 'string' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return `position of "${id}" needs level, x and y`;
    if (Math.abs(p.x) > 500 || Math.abs(p.y) > 500) return `position of "${id}" is out of range`;
  }
  return null;
}

function liveSim(req, res, speed) {
  const rows = [];
  for (const file of activeSampleFiles()) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (r.kind !== 'meta' && r.time) rows.push({ t: Date.parse(r.time), r }); } catch { /* skip bad line */ }
    }
  }
  rows.sort((a, b) => a.t - b.t);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(`event: hello\ndata: ${JSON.stringify({ source: 'live-sim', speed, rows: rows.length })}\n\n`);
  if (!rows.length) return;
  const span = rows[rows.length - 1].t - rows[0].t + 60_000;
  const started = Date.now();
  let cursor = rows[0].t + span * 0.5; // start in the middle of the day
  let index = rows.findIndex((x) => x.t > cursor);
  const timer = setInterval(() => {
    const target = rows[0].t + ((cursor - rows[0].t + 1000 * speed) % span);
    const wrapped = target < cursor;
    const batch = [];
    const take = (limit) => { while (index < rows.length && rows[index].t <= limit) batch.push(rows[index++]); };
    if (wrapped) { take(Infinity); index = 0; }
    take(target);
    cursor = target;
    const now = new Date().toISOString();
    for (const { r } of batch) res.write(`data: ${JSON.stringify({ ...r, time: now, synthetic: true })}\n\n`);
    if (!batch.length && Date.now() - started > 0) res.write(': keep-alive\n\n');
  }, 1000);
  req.on('close', () => clearInterval(timer));
}

function proxyLive(req, res, upstream) {
  const up = http.get(upstream, { headers: { Accept: 'text/event-stream' } }, (r) => {
    res.writeHead(r.statusCode || 502, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('close', () => up.destroy());
}

export function startServer({ port = 8137, host = '127.0.0.1', liveSimulation = false, liveSpeed = 60, liveUpstream = null, quiet = false, surveyDir = null, userDir = null, publicMode = false, python = undefined } = {}) {
  // surveyDir lets a test keep its waypoints (and its private setup) away from the real ones; userDir does the same for the user workspace
  const userRoot = userDir || path.join(ROOT, 'data', 'user');
  const privateRoot = surveyDir || path.join(ROOT, 'data', 'private');
  const ownDir = surveyDir || (publicMode ? userRoot : null);
  const waypointFile = ownDir ? path.join(ownDir, 'waypoints.ndjson') : WAYPOINT_FILE;
  const surveyFile = ownDir ? path.join(ownDir, 'survey.ndjson') : SURVEY_FILE;
  const layoutApi = createLayoutApi({ root: ROOT, userDir: userRoot, python });
  /** Where the Setup panel keeps its file: the owner's house in data/private/, a user layout in data/user/. */
  const setupPlace = (url) => {
    if (url.searchParams.get('ws') === 'private') return publicMode ? null : { userDir: privateRoot, scanDirs: [], label: 'data/private' };
    // the laptop scan log lives in data/private/; a public server never reads it
    return { userDir: userRoot, scanDirs: publicMode ? [] : [privateRoot], label: 'data/user' };
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };

    // Only this machine, asked by name as this machine. A web page on another site that the
    // browser has open must not be able to read the private files or to write through /api/:
    //  - the Host header must name this server (stops a foreign name that was pointed at 127.0.0.1),
    //  - a request that changes something must come from a page of this server (Origin) and,
    //    when it has a body, must be JSON (a foreign page cannot send JSON without asking first).
    const self = [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`, `[::1]:${server.address().port}`];
    if (!self.includes(String(req.headers.host || '').toLowerCase())) return send(403, 'this server answers only as 127.0.0.1 or localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && !self.some((h) => origin === `http://${h}`)) return send(403, 'requests from another site are refused');
      // raw bytes (a scan export) need the same permission from the browser as JSON does, so they are let in too
      if ((req.method === 'POST' || req.method === 'PUT') && !/^application\/(json|octet-stream)\b/i.test(String(req.headers['content-type'] || ''))) return send(415, 'send JSON (Content-Type: application/json)');
    }

    if (url.pathname === '/live') {
      if (req.method !== 'GET') return send(405, 'read-only');
      if (liveUpstream) return proxyLive(req, res, liveUpstream);
      if (liveSimulation) return liveSim(req, res, liveSpeed);
      return send(404, 'no live feed is configured');
    }
    if (url.pathname.startsWith('/api/layout')) return void layoutApi(req, res, url);
    if (url.pathname === '/api/setup' || url.pathname === '/api/scan-radios') {
      const place = setupPlace(url);
      if (!place) return send(404, 'a public server keeps no private setup');
      if (handleSetupApi(req, res, url, place)) return;
    }
    if (url.pathname === '/api/ap-positions') {
      if (req.method !== 'PUT') return send(405, 'use PUT');
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
      req.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, 'not JSON'); }
        const problem = validPositions(body);
        if (problem) return send(400, problem);
        const clean = { schemaVersion: 1, floorplan: String(body.floorplan || ''), saved: new Date().toISOString(), positions: {} };
        for (const [id, p] of Object.entries(body.positions)) {
          const source = typeof p.source === 'string' && p.source.length < 80 ? p.source : 'placed';
          clean.positions[id] = { level: p.level, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, source };
          // height and cabinet loss travel with the marker, so dragging a marker does not lose them
          if (Number.isFinite(p.z) && p.z >= 0 && p.z < 20) { clean.positions[id].z = p.z; clean.positions[id].heightSource = p.heightSource === 'measured' ? 'measured' : 'assumed'; }
          if (Number.isFinite(p.enclosureLossDb) && p.enclosureLossDb >= 0 && p.enclosureLossDb < 60) { clean.positions[id].enclosureLossDb = p.enclosureLossDb; clean.positions[id].enclosureSource = p.enclosureSource === 'measured' ? 'measured' : 'assumed'; }
        }
        // markers of a user layout belong to the user workspace, never to data/private/
        const own = publicMode || clean.floorplan.startsWith('data/user/');
        const apFile = own ? path.join(userRoot, 'ap-positions.json') : AP_FILE;
        fs.mkdirSync(path.dirname(apFile), { recursive: true });
        fs.writeFileSync(apFile, JSON.stringify(clean, null, 2) + '\n');
        send(200, JSON.stringify({ ok: true, file: own ? 'data/user/ap-positions.json' : 'data/private/ap-positions.json' }), TYPES['.json']);
      });
      return;
    }
    if (url.pathname === '/api/survey') {
      if (req.method !== 'GET') return send(405, 'use GET');
      const body = { waypoints: readNdjson(waypointFile).filter((r) => r.kind === 'waypoint'), rows: readNdjson(surveyFile).filter((r) => r.kind !== 'meta'), files: { waypoints: 'data/private/waypoints.ndjson', survey: 'data/private/survey.ndjson' } };
      return send(200, JSON.stringify(body), TYPES['.json']);
    }
    if (url.pathname === '/api/waypoints' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
      req.on('end', () => {
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, 'not JSON'); }
        const problem = validWaypoint(body);
        if (problem) return send(400, problem);
        const have = readNdjson(waypointFile).filter((r) => r.kind === 'waypoint');
        const next = have.reduce((m, r) => Math.max(m, Number(/^wp-(\d+)$/.exec(r.id || '')?.[1]) || 0), 0) + 1;
        const row = { time: new Date().toISOString(), kind: 'waypoint', id: `wp-${String(next).padStart(4, '0')}`, level: body.level, x: Math.round(body.x * 100) / 100, y: Math.round(body.y * 100) / 100, source: 'app', ...(body.note ? { note: body.note } : {}) };
        fs.mkdirSync(path.dirname(waypointFile), { recursive: true });
        fs.appendFileSync(waypointFile, JSON.stringify(row) + '\n');
        send(200, JSON.stringify({ ok: true, waypoint: row, count: have.length + 1 }), TYPES['.json']);
      });
      return;
    }
    if (url.pathname === '/api/waypoints/last' && req.method === 'DELETE') {
      const rows = readNdjson(waypointFile);
      let last = -1;
      rows.forEach((r, i) => { if (r.kind === 'waypoint') last = i; });
      if (last < 0) return send(200, JSON.stringify({ ok: true, removed: null, count: 0 }), TYPES['.json']);
      const [removed] = rows.splice(last, 1);
      fs.writeFileSync(waypointFile, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
      return send(200, JSON.stringify({ ok: true, removed, count: rows.filter((r) => r.kind === 'waypoint').length }), TYPES['.json']);
    }
    if (url.pathname.startsWith('/api/waypoints')) return send(405, 'use POST /api/waypoints or DELETE /api/waypoints/last');
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'read-only');
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }   // browsers ask for it; there is none

    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(400, 'bad address'); }   // a broken %-code must not stop the server
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.normalize(path.join(ROOT, rel));
    // The block list is tested on the path as the file system sees it. On Windows a backslash in
    // the address is a folder separator too, so the address text alone would let "/\.env" through.
    const seen = '/' + path.relative(ROOT, file).split(path.sep).join('/');
    if (!file.startsWith(ROOT + path.sep) || rel.includes('\\') || BLOCKED.test(seen)) return send(403, 'not served');
    if (userDir && /^\/data\/user\//i.test(seen)) file = path.join(userRoot, seen.slice('/data/user/'.length));
    // A public server has no private folder. The real path is tested too, because Windows also
    // answers to a short name (PRIVAT~1) and to any mix of upper and lower case.
    if (publicMode) {
      let real = file;
      try { real = fs.realpathSync.native(file); } catch { /* no such file: the name test is enough */ }
      const hidden = [path.join(ROOT, 'data', 'private')];
      try { hidden.push(fs.realpathSync.native(hidden[0])); } catch { /* there is no private folder */ }
      if ([file, real].some((f) => hidden.some((h) => (f.toLowerCase() + path.sep).startsWith(h.toLowerCase() + path.sep)))) return OPTIONAL.includes(rel) ? send(200, 'null', TYPES['.json']) : send(404, 'not found');
    }
    fs.stat(file, (err, st) => {
      // optional files answer "null" instead of 404, so the browser console stays clean
      if ((err || !st.isFile()) && OPTIONAL.includes(rel)) return send(200, 'null', TYPES['.json']);
      if (err || !st.isFile()) return send(404, 'not found');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const actual = server.address().port;
      if (!quiet) {
        console.log(`Signal Atlas: http://${host}:${actual}/`);
        console.log(`  privacy mode: http://${host}:${actual}/?privacy=1`);
        if (publicMode) console.log('  public mode: data/private/ is not served; positions and waypoints go to data/user/');
        console.log(liveUpstream ? `  /live passes on ${liveUpstream}` : liveSimulation ? `  /live replays the recorded samples at ${liveSpeed}x` : '  /live is off (recorded mode). Add --live-sim to try live mode.');
      }
      resolve({ server, port: actual, url: `http://${host}:${actual}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  startServer({
    port: Number(value('--port', process.env.PORT || 8137)),
    liveSimulation: args.includes('--live-sim'),
    liveSpeed: Number(value('--live-speed', 60)),
    liveUpstream: value('--live-upstream', null),
    publicMode: args.includes('--public'),
  }).catch((e) => { console.error(`could not start: ${e.message}`); process.exit(1); });
}
