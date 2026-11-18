#!/usr/bin/env node
// Checks that privacy mode keeps private strings off the screen.
//
//   node tools/verify/privacy-check.mjs
//
// Private strings are collected from:
//   - data/private/config.local.json: every text value of 6 or more characters
//     (address, house name, network names, BSSIDs, file paths ...), except the
//     two free-text notes "about" and "northSource"
//   - the node file named in the config: every device name, node id and MAC address
//   - the sample files named in the config: every SSID and BSSID in them
//   - data/private/ and data/user/network-setup.json (the Setup panel), when present: every network name, SSID,
//     device name, model, BSSID, MAC address and sensor id
// Without a private config, the public synthetic names are used instead, which
// tests the same code.
//
// The page is opened in privacy mode in several states (3D, plan, each layer, a
// selected node of each kind, marker placing on, the Setup panel with every device
// opened in turn). In each state the tool reads (1) the whole page source as the
// browser holds it, (2) every text drawn into a canvas (fillText and strokeText are
// recorded), (3) the page title, and (4) what every input and list holds. A
// screenshot can only show text that is in one of those three places. Any private
// string found fails the check. A control run in normal mode must find them, which
// proves the detector works. The strings themselves are never printed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.mjs';
import { mergeConfig } from '../../src/core/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const base = read('data/config.default.json');
const hasPrivate = fs.existsSync(path.join(ROOT, 'data/private/config.local.json'));
const local = hasPrivate ? read('data/private/config.local.json') : {};
const config = mergeConfig(base, local);

const secrets = new Map(); // lower-case string -> category
const add = (value, category) => { const s = String(value || '').trim().toLowerCase(); if (s.length >= 4 && !secrets.has(s)) secrets.set(s, category); };
(function walk(node, key) {
  if (typeof node === 'string') { if (node.length >= 6 && key !== 'about' && key !== 'northSource') add(node, 'config text'); return; }
  if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k);
})(hasPrivate ? local : { networks: base.networks, aps: base.aps.map((a) => a.bssid), private: base.private });
for (const net of Object.values(config.networks)) add(net.ssid, 'own SSID');
for (const ap of config.aps) for (const b of Object.values(ap.bssid || {})) { add(b, 'own BSSID'); add(b.replace(/:/g, ''), 'own BSSID'); add(b.replace(/:/g, '-'), 'own BSSID'); }
add(config.private?.address, 'address'); add(config.private?.houseName, 'house name');
const nodesFile = path.join(ROOT, config.paths.nodes);
if (fs.existsSync(nodesFile)) for (const n of JSON.parse(fs.readFileSync(nodesFile, 'utf8')).nodes) { add(n.name, 'device name'); add(n.id, 'node id'); add(n.mac, 'MAC address'); }
for (const rel of config.paths.samples || []) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"bssid"')) continue;
    try { const r = JSON.parse(line); add(r.bssid, 'BSSID in samples'); add(r.ssid, 'SSID in samples'); } catch { /* skip */ }
  }
}
// the user's own setup replaces the networks and devices of the config in the page
// a label the user left at the public default ("Home router", also shown in the demo house) identifies nothing
const publicNetNames = new Set(Object.entries(base.networks).flatMap(([id, n]) => [id, n.label]).filter(Boolean).map((s) => String(s).toLowerCase()));
for (const setupFile of ['data/private/network-setup.json', 'data/user/network-setup.json'].map((rel) => path.join(ROOT, rel))) {
  if (!fs.existsSync(setupFile)) continue;
  try {
    const setup = JSON.parse(fs.readFileSync(setupFile, 'utf8'));
    for (const n of setup.networks || []) { if (!publicNetNames.has(String(n.label || '').trim().toLowerCase())) add(n.label, 'network name'); add(n.ssid, 'own SSID'); }
    for (const d of setup.devices || []) {
      add(d.label, 'device name'); add(d.model, 'device model'); add(d.mac, 'MAC address');
      if (d.type !== 'ap' && d.type !== 'mesh') add(d.id, 'node id');
      for (const b of Object.values(d.bssid || {})) { add(b, 'own BSSID'); add(b.replace(/:/g, ''), 'own BSSID'); add(b.replace(/:/g, '-'), 'own BSSID'); }
    }
  } catch { /* not JSON: the page does not use it either */ }
}
// words that are part of the interface itself and identify nothing
for (const generic of ['guess', 'placed', 'unknown', 'home', 'printer', 'webcam', 'laptop', 'inferred', 'chosen', 'assumed', 'measured']) secrets.delete(generic);

const states = [
  { name: '3D, fused', query: 'orbit=0' },
  { name: 'plan, one floor, waves', query: 'view=plan&level=1&layer=waves' },
  { name: 'plan, all floors, contours, 5 GHz', query: 'view=plan&layer=contours&band=5' },
  { name: '3D, envelope, other network', query: 'orbit=0&layer=envelope&network=home' },
  { name: 'plan, survey mode, heat theme, flow arrows', query: 'view=plan&level=1&survey=1&theme=heat&waves=flow' },
  { name: '3D, every node selected in turn, marker placing on', query: 'orbit=0', walkNodes: true },
  { name: 'plan, Setup panel, every device opened in turn', query: 'view=plan&level=1&setup=1', walkSetup: true },
];

async function scan(browser, url, privacy, state) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.addInitScript(() => {
    window.__drawnText = [];
    for (const fn of ['fillText', 'strokeText']) {
      const original = CanvasRenderingContext2D.prototype[fn];
      CanvasRenderingContext2D.prototype[fn] = function (text, ...rest) { window.__drawnText.push(String(text)); return original.call(this, text, ...rest); };
    }
  });
  await page.goto(`${url}/?nolive=1&quality=low&${privacy ? 'privacy=1&' : ''}${state.query}`);
  await page.waitForFunction(() => window.__atlas && window.__atlas.ready, null, { timeout: 120_000 });
  // an unknown network id falls back to 'best' without a word, so check the switch took
  const wantNet = new URLSearchParams(state.query).get('network');
  if (wantNet) { const got = await page.evaluate(() => window.__atlas.state.network); if (got !== wantNet) throw new Error(`${state.name}: network=${wantNet} was not applied (page shows ${got})`); }
  await page.waitForTimeout(2500);
  const grab = () => page.evaluate(() => [document.documentElement.outerHTML, document.title, location.href, ...[...document.querySelectorAll('input, select, textarea')].map((e) => e.value), ...window.__drawnText, ...[...document.querySelectorAll('*')].map((e) => getComputedStyle(e, '::before').content + getComputedStyle(e, '::after').content).filter((c) => c !== 'nonenone' && c !== 'normalnormal')].join('\n'));
  let text = await grab();
  if (state.walkNodes) {
    const count = await page.evaluate(() => window.__atlas.model.nodes.length);
    await page.evaluate(() => window.__atlas.apply('placing', true));
    for (let i = 0; i < count; i++) {
      await page.evaluate((k) => window.__atlas.selectNode(window.__atlas.model.nodes[k].id), i);
      await page.waitForTimeout(450);
      text += '\n' + await grab();
    }
    for (const t of [0.52, 0.3, 0.8]) {    // other times of the day: an offline node, a burst
      await page.evaluate((f) => { const a = window.__atlas; a.setCursor(a.store.tMin + f * (a.store.tMax - a.store.tMin), 'recorded'); }, t);
      await page.waitForTimeout(700);
      text += '\n' + await grab();
    }
  }
  if (state.walkSetup) {
    const count = await page.evaluate(() => document.querySelectorAll('#setup .dev-head').length);
    for (let i = 0; i < count; i++) {
      await page.evaluate((k) => document.querySelectorAll('#setup .dev-head')[k].click(), i);
      await page.waitForTimeout(200);
      text += '\n' + await grab();
    }
  }
  await page.close();
  const lower = text.toLowerCase();
  const found = new Map();
  for (const [secret, category] of secrets) if (lower.includes(secret)) found.set(secret, category);
  return found;
}

const { srv, browser, close } = await openBrowser();
let failed = false;
try {
  const categories = {};
  for (const c of secrets.values()) categories[c] = (categories[c] || 0) + 1;
  console.log(`Private strings to look for: ${secrets.size} (${Object.entries(categories).map(([k, v]) => `${v} ${k}`).join(', ')}). Source: ${hasPrivate ? 'data/private/' : 'public synthetic set'}.`);
  const control = new Map();
  for (const state of [states[0], states[4], states[6]]) for (const [k, v] of await scan(browser, srv.url, false, state)) control.set(k, v);
  const controlCats = {};
  for (const c of control.values()) controlCats[c] = (controlCats[c] || 0) + 1;
  console.log(`Control, normal mode: ${control.size} of them are on the page (${Object.entries(controlCats).map(([k, v]) => `${v} ${k}`).join(', ')}). The detector works.`);
  if (control.size < 10) { console.log('FAIL  the control run found too few private strings: the detector cannot be trusted'); failed = true; }
  for (const state of states) {
    const found = await scan(browser, srv.url, true, state);
    if (found.size) {
      failed = true;
      const cats = {};
      for (const c of found.values()) cats[c] = (cats[c] || 0) + 1;
      console.log(`FAIL  privacy mode, ${state.name}: ${found.size} private strings on the page (${Object.entries(cats).map(([k, v]) => `${v} ${k}`).join(', ')})`);
      if (process.argv.includes('--show')) console.log('      ' + [...found.keys()].join(' | '));
    } else console.log(`PASS  privacy mode, ${state.name}: none of the ${secrets.size} private strings is in the page source, in canvas text or in the title`);
  }
} finally {
  await close();
}
console.log(failed ? 'privacy check FAILED (run again with --show to list the strings; the list is private)' : 'privacy check passed');
process.exit(failed ? 1 : 0);
