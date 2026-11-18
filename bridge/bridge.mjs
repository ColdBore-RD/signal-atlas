#!/usr/bin/env node
// Signal Atlas bridge: MQTT in, server-sent events and an NDJSON file out.
//
// It subscribes to   sensors/wifi-atlas/+/scan   and   sensors/wifi-atlas/+/status,
// checks every message (bridge/normalize.mjs), appends the clean row to a data file,
// and sends it to every browser that listens on GET /live.
//
// Read-only by design:
//   - this program never publishes: it has no publish call and no last-will message
//   - use a broker account that is only allowed to read (see README.md)
//   - the HTTP side has two GET endpoints (/live and /health) and nothing else
//
// Settings (environment variables):
//   ATLAS_MQTT_URL        for example mqtt://192.0.2.1:1883   (required)
//   ATLAS_MQTT_USER       read-only account
//   ATLAS_MQTT_PASSWORD   its password
//   ATLAS_DATA_FILE       default data/private/samples.live.ndjson ("-" for no file)
//   ATLAS_BRIDGE_PORT     default 8787
//   ATLAS_BRIDGE_BIND     default 127.0.0.1 (the dev server passes /live on from there)
//   ATLAS_ALLOW_ORIGIN    optional Access-Control-Allow-Origin value, when the page is served elsewhere
//
// Run:  cd bridge && npm install && node bridge.mjs
// Then: node tools/serve.mjs --live-upstream http://127.0.0.1:8787/live

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalize, SUBSCRIPTIONS } from './normalize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKLOG = 400;

/** The HTTP side: keeps the listening browsers and the recent rows, writes the file. */
export function createHub({ dataFile = null, allowOrigin = null } = {}) {
  const clients = new Set();
  const recent = [];
  const counters = { accepted: 0, rejected: 0, started: new Date().toISOString(), lastRow: null, lastError: null };
  let stream = null;
  if (dataFile) {
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    stream = fs.createWriteStream(dataFile, { flags: 'a' });
  }
  function accept(row) {
    counters.accepted++;
    counters.lastRow = row.time;
    const line = JSON.stringify(row);
    recent.push(line);
    if (recent.length > BACKLOG) recent.shift();
    if (stream) stream.write(line + '\n');
    for (const res of clients) res.write(`data: ${line}\n\n`);
  }
  function reject(reason) { counters.rejected++; counters.lastError = reason; }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cors = allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {};
    if (req.method !== 'GET') { res.writeHead(405, cors); res.end('read-only'); return; }
    if (url.pathname === '/live') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...cors });
      res.write(`event: hello\ndata: ${JSON.stringify({ source: 'bridge', backlog: recent.length })}\n\n`);
      for (const line of recent) res.write(`data: ${line}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors });
      res.end(JSON.stringify({ ok: true, listeners: clients.size, ...counters }));
      return;
    }
    res.writeHead(404, cors); res.end('not found');
  });
  const keepAlive = setInterval(() => { for (const res of clients) res.write(': keep-alive\n\n'); }, 20000);
  keepAlive.unref();
  return {
    server, accept, reject, counters,
    /** Handle one MQTT message. */
    onMessage(topic, payload) { const r = normalize(topic, payload); if (r.row) accept(r.row); else reject(r.error); return r; },
    close: () => new Promise((resolve) => { clearInterval(keepAlive); for (const res of clients) res.end(); if (stream) stream.end(); server.close(resolve); }),
  };
}

async function main() {
  const env = process.env;
  if (!env.ATLAS_MQTT_URL) { console.error('Set ATLAS_MQTT_URL, for example mqtt://192.0.2.1:1883'); process.exit(2); }
  let mqtt;
  try { mqtt = (await import('mqtt')).default; } catch { console.error('The "mqtt" package is missing. Run: cd bridge && npm install'); process.exit(2); }
  const fileSetting = env.ATLAS_DATA_FILE ?? 'data/private/samples.live.ndjson';
  const hub = createHub({ dataFile: fileSetting === '-' ? null : path.resolve(ROOT, fileSetting), allowOrigin: env.ATLAS_ALLOW_ORIGIN || null });
  const port = Number(env.ATLAS_BRIDGE_PORT || 8787), bind = env.ATLAS_BRIDGE_BIND || '127.0.0.1';
  hub.server.listen(port, bind, () => console.log(`bridge: http://${bind}:${port}/live (file: ${fileSetting})`));

  // clean session, no will, no publish anywhere in this file
  const client = mqtt.connect(env.ATLAS_MQTT_URL, { username: env.ATLAS_MQTT_USER, password: env.ATLAS_MQTT_PASSWORD, clientId: `wifi-atlas-bridge-${process.pid}`, clean: true, reconnectPeriod: 5000 });
  client.on('connect', () => client.subscribe(SUBSCRIPTIONS, { qos: 0 }, (err) => console.log(err ? `bridge: subscribe failed: ${err.message}` : 'bridge: subscribed, read-only')));
  client.on('message', (topic, payload) => hub.onMessage(topic, payload));
  client.on('error', (e) => console.error(`bridge: MQTT error: ${e.message}`));
  setInterval(() => console.log(`bridge: ${hub.counters.accepted} rows accepted, ${hub.counters.rejected} rejected${hub.counters.lastError ? ` (last reason: ${hub.counters.lastError})` : ''}`), 60000).unref();
  const stop = () => { client.end(true); hub.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
