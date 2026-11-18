// The part of the local server that keeps the user's network setup (see docs/network-setup.md).
//
//   GET    /api/setup         { setup: <the saved setup or null>, file, scan: <true when a scan log exists> }
//   PUT    /api/setup         checks the body with src/core/setup.js and writes network-setup.json in its folder
//                             (tools/serve.mjs picks it: data/private/ with ?ws=private, else data/user/)
//   DELETE /api/setup         removes that file: the page is back to its defaults
//   GET    /api/scan-radios   the radios in the last laptop scan log, for filling in BSSIDs. Read only.
//
// tools/serve.mjs has already checked Host, Origin and the JSON content type when this runs.
// Nothing here opens a connection or changes a network setting.

import fs from 'node:fs';
import path from 'node:path';
import { validateSetup, cleanSetup, radiosFromScans } from '../src/core/setup.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const SETUP_NAME = 'network-setup.json';
const SCAN_NAME = 'scans-laptop.ndjson';
const MAX_BODY = 512 * 1024;
const SCAN_TAIL = 2 * 1024 * 1024;   // a scan log grows all day: the newest part is enough

/** The rows at the end of an NDJSON file, at most `bytes` of it. A first line that was cut is dropped. */
function tailRows(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').replace(/^﻿/, '').split('\n');
    if (start > 0) lines.shift();
    const rows = [];
    for (const line of lines) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { /* skip bad line */ } }
    return rows;
  } catch { return []; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/**
 * Answer a request under /api/setup or /api/scan-radios. Returns false when the address is not one of them.
 * userDir holds the setup; scanDirs are the folders where a scan log may be.
 */
export function handleSetupApi(req, res, url, { userDir, scanDirs = [], label = 'data/user' }) {
  if (url.pathname !== '/api/setup' && url.pathname !== '/api/scan-radios') return false;
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : JSON_TYPE, 'Cache-Control': 'no-store' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const file = path.join(userDir, SETUP_NAME);
  const shown = `${label}/${SETUP_NAME}`;
  const scanFile = [userDir, ...scanDirs].map((d) => path.join(d, SCAN_NAME)).find((f) => fs.existsSync(f));

  if (url.pathname === '/api/scan-radios') {
    if (req.method !== 'GET') { send(405, 'use GET'); return true; }
    send(200, { radios: scanFile ? radiosFromScans(tailRows(scanFile, SCAN_TAIL)) : [] });
    return true;
  }
  if (req.method === 'GET') {
    let setup = null;
    try { setup = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no file yet, or not JSON */ }
    if (setup && validateSetup(setup).length) setup = null;   // a file that was edited by hand into a bad shape is not used
    send(200, { setup, file: shown, scan: !!scanFile });
    return true;
  }
  if (req.method === 'DELETE') {
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') { send(500, 'the file could not be removed'); return true; } }
    send(200, { ok: true, file: shown });
    return true;
  }
  if (req.method !== 'PUT') { send(405, 'use GET, PUT or DELETE'); return true; }
  let raw = '', tooBig = false;
  req.setEncoding('utf8');   // a character that is split over two chunks stays whole
  req.on('data', (c) => { raw += c; if (raw.length > MAX_BODY) { tooBig = true; req.destroy(); } });
  req.on('end', () => {
    if (tooBig) return;
    let body;
    try { body = JSON.parse(raw); } catch { return send(400, 'not JSON'); }
    const problems = validateSetup(body);
    if (problems.length) return send(400, problems.slice(0, 8).join('\n'));
    try {
      const clean = cleanSetup(body);
      fs.mkdirSync(userDir, { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n');
      fs.renameSync(tmp, file);   // the old file stays whole until the new one is complete
      send(200, { ok: true, file: shown, saved: clean.saved });
    } catch { send(500, 'the file could not be written'); }
  });
  return true;
}
