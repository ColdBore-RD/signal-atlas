// The /api/layout endpoints of the local dev server (tools/serve.mjs).
//
// They are the only way the Layout setup panel saves anything, and they read and
// write one folder: the user workspace, data/user/. Nothing here opens data/private/.
//
//   GET    /api/layout                  the saved plan, draft, config and image names
//   PUT    /api/layout                  { plan?, draft?, site? }: the plan is checked, then saved
//   DELETE /api/layout                  removes the plan, the draft, the images, the marker positions and the
//                                       scan uploads, and takes the house name and north out of the config
//   DELETE /api/layout/scan             removes the uploaded scan files (before a new import)
//   PUT    /api/layout/underlay?level=  { dataUrl }: the picture under one floor
//   DELETE /api/layout/underlay?level=
//   GET    /api/layout/scan-status      whether Python with the importer's packages is there
//   PUT    /api/layout/scan-file?level=<key>&name=floorplan.dxf   raw bytes of one export file
//   POST   /api/layout/import-scan      { levels: [{ key, id, name, construction, anchor }] }:
//                                       runs tools/trace/import_polycam.py on the uploaded files
//
// See docs/custom-layout.md.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { validateFloorplan, formatIssues } from '../src/core/validate.js';
import { isDraft } from '../src/core/layout.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const LEVEL_ID = /^[\w-]{1,12}$/;
const SCAN_KEY = /^[a-z0-9-]{1,24}$/;
const SCAN_FILES = ['floorplan.dxf', 'floorplan.csv', 'model.glb', 'floorplan.png'];
const CONSTRUCTION = ['basement', 'main', 'upper'];
const IMAGE = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
const IMAGE_EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' };
const MB = 1024 * 1024;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n');
  fs.renameSync(tmp, file);          // a half-written plan never replaces a good one
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function run(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve) => {
    let out = '', done = false;
    let child;
    try { child = spawn(command, args, { cwd, windowsHide: true }); } catch (e) { return resolve({ code: -1, out: String(e.message) }); }
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } out += '\nstopped: it took too long'; finish(-2); }, timeoutMs);
    const keep = (d) => { out = (out + d).slice(-8000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => { out += String(e.message); finish(-1); });
    child.on('close', finish);
  });
}

/**
 * root: the project folder (materials, schema, importer). userDir: the user workspace.
 * python: a command to use, false to switch scan import off, or undefined to look for one.
 * Returns handle(req, res, url): it answers every /api/layout request.
 */
export function createLayoutApi({ root, userDir, python, importTimeoutMs = 240_000 }) {
  const files = {
    plan: path.join(userDir, 'floorplan.json'), draft: path.join(userDir, 'layout-draft.json'), config: path.join(userDir, 'config.user.json'),
    scan: path.join(userDir, 'scan'),
  };
  const importer = path.join(root, 'tools', 'trace', 'import_polycam.py');
  const setup = process.platform === 'win32'
    ? 'python -m venv .venv; .\\.venv\\Scripts\\python.exe -m pip install ezdxf numpy pillow shapely'
    : 'python3 -m venv .venv && .venv/bin/python -m pip install ezdxf numpy pillow shapely';
  let pythonFound = null, importing = false;

  /** The first Python that has the importer's packages. Looked up once. */
  function findPython() {
    if (pythonFound) return pythonFound;
    pythonFound = (async () => {
      if (python === false) return { available: false, why: 'Scan import is switched off on this server.', setup };
      const candidates = python ? [python] : [path.join(root, '.venv', 'Scripts', 'python.exe'), path.join(root, '.venv', 'bin', 'python'), 'python', 'python3'];
      for (const c of candidates) {
        if (path.isAbsolute(c) && !fs.existsSync(c)) continue;
        const r = await run(c, ['-c', 'import ezdxf, shapely, numpy, PIL'], { cwd: root, timeoutMs: 30_000 });
        if (r.code === 0) return { available: true, command: c };
      }
      return { available: false, why: 'Scan import needs Python with the packages ezdxf, numpy, pillow and shapely. Set it up once in the project folder, then try again.', setup };
    })();
    return pythonFound;
  }

  const underlays = () => {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(userDir); } catch { /* no workspace yet */ }
    for (const n of names) { const m = /^underlay-([\w-]{1,12})\.(png|jpg|webp)$/.exec(n); if (m) out[m[1]] = `data/user/${n}`; }
    return out;
  };
  const removeUnderlay = (level) => { for (const ext of Object.values(IMAGE_EXT)) fs.rmSync(path.join(userDir, `underlay-${level}.${ext}`), { force: true }); };

  function savePlan(body) {
    const out = { ok: true, files: [], warnings: [] };
    if (body.plan !== undefined) {
      const schema = readJson(path.join(root, 'data', 'schema', 'floorplan.schema.json'));
      const materials = readJson(path.join(root, 'data', 'materials.json'));
      const issues = validateFloorplan(body.plan, schema, materials);
      if (issues.errors.length) return { ok: false, error: 'The plan has errors and was not saved.', errors: formatIssues(issues.errors).slice(0, 20) };
      out.warnings = formatIssues(issues.warnings);
    }
    if (body.draft !== undefined && !isDraft(body.draft)) return { ok: false, error: 'The draft is not in a form this version can read.' };
    if (body.plan !== undefined) {
      writeJson(files.plan, body.plan);
      out.files.push('data/user/floorplan.json');
      // The house name and north go into the user's own config. Whatever else is in that file stays.
      const config = readJson(files.config) || { schemaVersion: 1, about: 'Settings of your own house for Signal Atlas. Made by the setup panels; data/config.default.json is the base.' };
      config.private = { ...(config.private || {}), houseName: String(body.plan.name || 'My house').slice(0, 80) };
      const site = body.site;
      if (site && typeof site === 'object' && Number.isFinite(site.northDeg) && Math.abs(site.northDeg) <= 360) {
        config.site = { ...(config.site || {}), northDeg: site.northDeg, northSource: typeof site.northSource === 'string' ? site.northSource.slice(0, 160) : 'set in the Layout setup panel' };
      }
      writeJson(files.config, config);
      out.files.push('data/user/config.user.json');
    }
    if (body.draft !== undefined) { writeJson(files.draft, body.draft); out.files.push('data/user/layout-draft.json'); }
    return out;
  }

  async function importScan(body) {
    const levels = body?.levels;
    if (!Array.isArray(levels) || levels.length < 1 || levels.length > 6) return [400, { ok: false, error: 'Name one to six floors to import.' }];
    const seen = new Set(), ids = new Set();
    for (const l of levels) {
      if (!l || !SCAN_KEY.test(l.key || '') || !LEVEL_ID.test(l.id || '') || typeof l.name !== 'string' || !l.name.trim() || l.name.length > 40 || !CONSTRUCTION.includes(l.construction)) return [400, { ok: false, error: 'Each floor needs a key, an id, a name and a kind (basement, main or upper).' }];
      if (seen.has(l.key) || ids.has(l.id)) return [400, { ok: false, error: 'Two floors have the same key or id.' }];
      seen.add(l.key); ids.add(l.id);
      if (!fs.existsSync(path.join(files.scan, l.key, 'floorplan.dxf'))) return [400, { ok: false, error: `The floor "${l.name}" has no floorplan.dxf. That file is the one the importer needs.` }];
    }
    const py = await findPython();
    if (!py.available) return [501, { ok: false, error: py.why, setup: py.setup }];
    if (importing) return [409, { ok: false, error: 'An import is already running.' }];
    importing = true;
    try {
      const specs = levels.map((l, i) => ({ key: l.key, id: l.id, name: l.name.trim(), construction: l.construction, ...(l.anchor || (!levels.some((x) => x.anchor) && i === 0) ? { anchor: true } : {}) }));
      const levelsFile = path.join(files.scan, 'levels.json'), outDir = path.join(files.scan, 'out');
      fs.rmSync(outDir, { recursive: true, force: true });
      fs.mkdirSync(outDir, { recursive: true });
      writeJson(levelsFile, { levels: specs });
      const r = await run(py.command, [importer, '--all', '--source-dir', files.scan, '--out-dir', outDir, '--levels-file', levelsFile, '--materials', path.join(root, 'data', 'materials.json'), '--quiet'], { cwd: root, timeoutMs: importTimeoutMs });
      const plan = r.code === 0 ? readJson(path.join(outDir, 'floorplan.json')) : null;
      if (!plan) {
        const tail = r.out.trim().split(/\r?\n/).filter(Boolean).slice(-4).join('\n');
        return [422, { ok: false, error: 'The importer could not read these files. It expects the DXF that Polycam exports for a floor plan.', detail: tail }];
      }
      plan.name = 'My house';
      plan.note = 'Imported from scan exports by tools/trace/import_polycam.py. Materials are assumptions from data/materials.json.';
      const report = readJson(path.join(outDir, 'import-report.json')) || {};
      const schema = readJson(path.join(root, 'data', 'schema', 'floorplan.schema.json'));
      const materials = readJson(path.join(root, 'data', 'materials.json'));
      const issues = validateFloorplan(plan, schema, materials);
      if (issues.errors.length) return [422, { ok: false, error: 'The import gave a plan with errors.', errors: formatIssues(issues.errors).slice(0, 20) }];
      const warnings = [...formatIssues(issues.warnings)];
      for (const [key, checks] of Object.entries(report.levels || {})) for (const w of checks?.warnings || []) warnings.push(`${specs.find((s) => s.key === key)?.name || key}: ${w}`);
      const site = report.north ? { northDeg: 0, northSource: 'measured: compass heading of the scan. The plan is drawn north up.' } : null;
      return [200, { ok: true, plan, summary: typeof report.summaryLine === 'string' ? report.summaryLine : '', warnings: warnings.slice(0, 30), site }];
    } finally { importing = false; }
  }

  return async function handle(req, res, url) {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const route = url.pathname.replace(/\/$/, '');
    const jsonBody = async (limit) => {
      let raw;
      try { raw = await readBody(req, limit); } catch { send(413, { ok: false, error: 'That is too large.' }); return undefined; }
      try { const v = JSON.parse(raw); if (v && typeof v === 'object') return v; } catch { /* fall through */ }
      send(400, { ok: false, error: 'not JSON' });
      return undefined;
    };
    try {
      if (route === '/api/layout') {
        if (req.method === 'GET') return send(200, { ok: true, workspace: 'data/user', plan: readJson(files.plan), draft: readJson(files.draft), config: readJson(files.config), underlays: underlays() });
        if (req.method === 'PUT') {
          const body = await jsonBody(8 * MB);
          if (!body) return;
          if (body.plan === undefined && body.draft === undefined) return send(400, { ok: false, error: 'send a plan, a draft or both' });
          const result = savePlan(body);
          return send(result.ok ? 200 : 400, result);
        }
        if (req.method === 'DELETE') {
          fs.rmSync(files.plan, { force: true });
          fs.rmSync(files.draft, { force: true });
          for (const level of Object.keys(underlays())) removeUnderlay(level);
          fs.rmSync(files.scan, { recursive: true, force: true });
          fs.rmSync(path.join(userDir, 'ap-positions.json'), { force: true });   // places on a plan that is gone
          // The config also holds what other setup panels wrote (networks, devices). Only what this
          // panel put there is taken out.
          const config = readJson(files.config);
          if (config) {
            if (config.private) { delete config.private.houseName; if (!Object.keys(config.private).length) delete config.private; }
            delete config.site;
            writeJson(files.config, config);
          }
          return send(200, { ok: true, kept: config ? ['data/user/config.user.json'] : [] });
        }
        return send(405, { ok: false, error: 'use GET, PUT or DELETE' });
      }
      if (route === '/api/layout/underlay') {
        const level = url.searchParams.get('level') || '';
        if (!LEVEL_ID.test(level)) return send(400, { ok: false, error: 'name the floor: ?level=<id>' });
        if (req.method === 'DELETE') { removeUnderlay(level); return send(200, { ok: true }); }
        if (req.method !== 'PUT') return send(405, { ok: false, error: 'use PUT or DELETE' });
        const body = await jsonBody(16 * MB);
        if (!body) return;
        const m = IMAGE.exec(typeof body.dataUrl === 'string' ? body.dataUrl : '');
        if (!m) return send(400, { ok: false, error: 'send { dataUrl } with a PNG, JPEG or WebP picture' });
        removeUnderlay(level);
        fs.mkdirSync(userDir, { recursive: true });
        const name = `underlay-${level}.${IMAGE_EXT[m[1]]}`;
        fs.writeFileSync(path.join(userDir, name), Buffer.from(m[2], 'base64'));
        return send(200, { ok: true, file: `data/user/${name}` });
      }
      if (route === '/api/layout/scan-status') {
        if (req.method !== 'GET') return send(405, { ok: false, error: 'use GET' });
        const py = await findPython();
        return send(200, { ok: true, available: py.available, why: py.why || '', setup: py.setup || '' });
      }
      if (route === '/api/layout/scan') {
        if (req.method !== 'DELETE') return send(405, { ok: false, error: 'use DELETE' });
        if (importing) return send(409, { ok: false, error: 'An import is running.' });
        fs.rmSync(files.scan, { recursive: true, force: true });
        return send(200, { ok: true });
      }
      if (route === '/api/layout/scan-file') {
        if (req.method !== 'PUT') return send(405, { ok: false, error: 'use PUT' });
        const key = url.searchParams.get('level') || '', name = url.searchParams.get('name') || '';
        if (!SCAN_KEY.test(key) || !SCAN_FILES.includes(name)) return send(400, { ok: false, error: `name the floor and the file: ?level=<key>&name=${SCAN_FILES.join('|')}` });
        const dir = path.join(files.scan, key), file = path.join(dir, name);
        fs.mkdirSync(dir, { recursive: true });
        const limit = 300 * MB;
        let size = 0, failed = false;
        const out = fs.createWriteStream(`${file}.part`);
        const fail = (code, error) => { if (failed) return; failed = true; out.destroy(); fs.rmSync(`${file}.part`, { force: true }); if (!res.headersSent) send(code, { ok: false, error }); req.destroy(); };
        req.on('data', (c) => { size += c.length; if (size > limit) fail(413, 'That file is larger than 300 MB.'); });
        req.on('error', () => fail(400, 'the upload stopped'));
        req.on('close', () => { if (!req.complete) fail(400, 'the upload stopped'); });   // no half file is left behind
        out.on('error', () => fail(500, 'the file could not be written'));
        out.on('finish', () => { if (failed) return; fs.renameSync(`${file}.part`, file); send(200, { ok: true, bytes: size }); });
        req.pipe(out);
        return;
      }
      if (route === '/api/layout/import-scan') {
        if (req.method !== 'POST') return send(405, { ok: false, error: 'use POST' });
        const body = await jsonBody(64 * 1024);
        if (!body) return;
        const [code, result] = await importScan(body);
        return send(code, result);
      }
      return send(404, { ok: false, error: 'no such layout endpoint' });
    } catch (e) {
      if (!res.headersSent) send(500, { ok: false, error: `the server could not do that: ${e.message}` });
    }
  };
}
