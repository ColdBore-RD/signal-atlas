#!/usr/bin/env node
// End-to-end checks of the page in headless Chromium. Run: node tools/verify/smoke.mjs
//
// It checks: the page starts without errors (with the private data and with the
// public demo house), nothing is requested from another host, replay moves the
// time cursor, a broken floor plan falls back to the demo house with readable
// errors, dragging an access point moves the wave source at once and saves the
// position, the live feed adds samples, automatic quality steps down when frames
// are slow, and the reduced-motion and pause controls work.
// The drag test writes data/private/ap-positions.json (or network-setup.json, when the owner saved a
// setup) and then puts back what was there.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AP_FILE = path.join(ROOT, 'data/private/ap-positions.json');
const SETUP_FILE = path.join(ROOT, 'data/private/network-setup.json');
const results = [];
const check = (ok, name, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`); };

async function open(browser, url, query, hooks = {}) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [], foreign = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith(url) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url()); });
  if (hooks.route) await hooks.route(page);
  await page.goto(`${url}/?quality=low&${query}`);
  await page.waitForFunction(() => window.__atlas, null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  return { page, errors, foreign };
}

const { srv, browser, close } = await openBrowser({ server: { liveSimulation: false } });
const live = await (await import('../serve.mjs')).startServer({ port: 0, quiet: true, liveSimulation: true, liveSpeed: 600 });
const hadPrivate = fs.existsSync(path.join(ROOT, 'data/private/floorplan.json'));
try {
  { // 1. default data
    const { page, errors, foreign } = await open(browser, srv.url, 'nolive=1&orbit=0');
    const info = await page.evaluate(() => ({ ready: window.__atlas.ready, levels: window.__atlas.model?.levels.length, waves: !!window.__atlas.solver, badges: document.getElementById('badges').textContent, calibrated: window.__atlas.model?.calibration.calibrated }));
    check(info.ready && errors.length === 0, 'the page starts with the active data set and logs no error', errors.join(' | ') || `${info.levels} levels, waves ${info.waves ? 'on' : 'off'}, calibrated ${info.calibrated}`);
    check(foreign.length === 0, 'the page requests nothing from another host', foreign.join(' | '));
    check(/Synthetic data/i.test(info.badges), 'the SYNTHETIC DATA badge is shown');
    if (hadPrivate) {
      // which levels are synthetic depends on which floors are scanned so far: read it from the plan
      const want = await page.evaluate(() => { const l = window.__atlas.model.levels.map((x) => x.level); return { synthetic: l.filter((x) => x.source === 'synthetic').map((x) => x.name), real: l.filter((x) => x.source !== 'synthetic').map((x) => x.name) }; });
      const badge = (/Synthetic layout · ([^]*?)(?:Access-point|$)/i.exec(info.badges) || [])[1] || '';
      check(want.synthetic.every((n) => badge.includes(n)) && want.real.every((n) => !badge.includes(n)), 'every synthetic level is labelled SYNTHETIC LAYOUT and no scanned level is', `${want.synthetic.length} synthetic, ${want.real.length} scanned`);
    }
    // replay
    const before = await page.evaluate(() => { window.__atlas.setCursor(window.__atlas.store.tMin + 3600e3, 'replay'); return window.__atlas.state.cursor; });
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => ({ cursor: window.__atlas.state.cursor, mode: window.__atlas.state.mode, clock: document.getElementById('clock-mode').textContent }));
    check(after.cursor - before > 10 * 60000 && /REPLAY/.test(after.clock), 'replay moves the time cursor and the clock says REPLAY', `${((after.cursor - before) / 60000).toFixed(0)} minutes of samples in 2.5 s`);
    // pause and step
    const steps = await page.evaluate(async () => {
      const a = window.__atlas; a.apply('paused', true);
      await new Promise((r) => setTimeout(r, 600));
      const s0 = a.solver.stepCount; await new Promise((r) => setTimeout(r, 800)); const s1 = a.solver.stepCount;
      a.apply('paused', false); await new Promise((r) => setTimeout(r, 1200));
      return { paused: s1 - s0, running: a.solver.stepCount - s1 };
    });
    check(steps.paused === 0 && steps.running > 0, 'pause stops the wave simulation and resume restarts it', `steps while paused ${steps.paused}, after resume ${steps.running}`);
    // virtual source and band switch
    const src = await page.evaluate(async () => {
      // damping above that of plain air: the air term follows the calibrated exponent of the band, the walls do not
      const wallDamping = () => { const d = Array.from(a.solver.mediumData).filter((v, i) => i % 4 === 1); const air = d.reduce((m, v) => Math.min(m, v), Infinity); return d.reduce((s, v) => s + v - air, 0); };
      const a = window.__atlas; const n0 = a.solver.baseCount; const w24 = a.wave.lambda, g24 = wallDamping();
      a.apply('probe', true); await new Promise((r) => setTimeout(r, 300)); const n1 = a.solver.baseCount;
      a.apply('probe', false); a.apply('band', '5'); await new Promise((r) => setTimeout(r, 300));
      const g5 = wallDamping();
      const out = { n0, n1, w24, w5: a.wave.lambda, g24, g5, note: document.getElementById('legend').textContent };
      a.apply('band', '2.4'); return out;
    });
    check(src.n1 > src.n0, 'the virtual source adds a wave source', `${src.n0} sources, then ${src.n1}`);
    check(src.w5 < src.w24 && src.g5 > src.g24, 'the 5 GHz band has a shorter wave and more wall damping than 2.4 GHz', `wavelength on screen ${src.w24.toFixed(2)} m and ${src.w5.toFixed(2)} m; wall damping ${src.g24.toFixed(0)} and ${src.g5.toFixed(0)}`);
    check(/Wavelength scaled ×\d+ for visibility/.test(src.note), 'the on-screen note says that the wavelength is scaled');
    // node card
    const card = await page.evaluate(async () => { const a = window.__atlas; a.selectNode(a.model.nodes.find((n) => n.type === 'pi').id); await new Promise((r) => setTimeout(r, 700)); return document.getElementById('node-card').textContent; });
    check(/RSSI/.test(card) && /SNR/.test(card) && /Channel/.test(card) && /BSSID/.test(card), 'a click on a sensor opens a card with RSSI, SNR, band, channel and BSSID');
    await page.close();
  }
  { // 2. public demo house
    const { page, errors } = await open(browser, srv.url, 'nolive=1&demo=1&orbit=0');
    const info = await page.evaluate(() => ({ ready: window.__atlas.ready, badges: document.getElementById('badges').textContent, plan: window.__atlas.config.paths.floorplan, dead: window.__atlas.latest.metrics?.house.deadArea }));
    check(info.ready && errors.length === 0 && /Synthetic layout · all floors/i.test(info.badges) && info.plan === 'data/synthetic/floorplan.json', 'without private files the page shows the generated house, labelled SYNTHETIC LAYOUT on all floors', errors.join(' | '));
    const dead5 = await page.evaluate(async () => { window.__atlas.apply('band', '5'); await new Promise((r) => setTimeout(r, 2500)); return window.__atlas.latest.metrics.house.deadArea; });
    check(dead5 > 5, 'the synthetic house has a dead zone on 5 GHz', `${dead5.toFixed(0)} m2 below the dead-zone limit`);
    await page.close();
  }
  if (hadPrivate) { // 3. broken floor plan
    const { page } = await open(browser, srv.url, 'nolive=1&orbit=0', { route: (p) => p.route('**/data/private/floorplan.json', async (route) => {
      const res = await route.fetch(); const plan = await res.json();
      plan.levels[1].walls[3].material = 'ext-sidng'; delete plan.levels[0].elevation;
      await route.fulfill({ response: res, json: plan });
    }) });
    const info = await page.evaluate(() => ({ ready: window.__atlas.ready, banner: document.getElementById('banner').textContent, plan: window.__atlas.config?.paths.floorplan }));
    check(info.ready && info.plan === 'data/synthetic/floorplan.json' && /missing the required field "elevation"/.test(info.banner), 'a broken floor plan gives a readable message and the demo house is shown instead', info.banner.split('\n').slice(0, 2).join(' / ').replace(/data\/private\/\S+/g, '<private path>'));
    await page.close();
  }
  { // 4. drag an access point
    const saved = fs.existsSync(AP_FILE) ? fs.readFileSync(AP_FILE) : null;
    // once the owner saved a setup in the page, a drag is saved there instead: keep that file too
    const savedSetup = fs.existsSync(SETUP_FILE) ? fs.readFileSync(SETUP_FILE) : null;
    const { page, errors } = await open(browser, srv.url, 'nolive=1&orbit=0&view=plan&level=1');
    const r = await page.evaluate(async () => {
      const a = window.__atlas;
      a.apply('placing', true);
      await new Promise((res) => setTimeout(res, 600));
      const ap = a.model.aps.filter((x) => x.position.level === '1' || x.position.level === a.model.levels[1].id).slice(-1)[0];
      const li = a.scene.levelIndex(ap.position.level);
      const rect = a.scene.renderer.domElement.getBoundingClientRect();
      const w = a.scene.worldOf(li, ap.position.x, ap.position.y, 1.0).project(a.scene.camera);
      return { id: ap.id, x: rect.left + (w.x * 0.5 + 0.5) * rect.width, y: rect.top + (-w.y * 0.5 + 0.5) * rect.height, from: { ...ap.position }, src: Array.from(a.solver.srcData.slice(0, 8)) };
    });
    await page.mouse.move(r.x, r.y);
    await page.mouse.down();
    await page.mouse.move(r.x - 60, r.y - 40, { steps: 6 });
    const mid = await page.evaluate((id) => { const a = window.__atlas; const ap = a.model.aps.find((x) => x.id === id); return { pos: { ...ap.position }, src: Array.from(a.solver.srcData.slice(0, 8)) }; }, r.id);
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const end = await page.evaluate((id) => { const ap = window.__atlas.model.aps.find((x) => x.id === id); return { pos: { ...ap.position }, calibrated: window.__atlas.model.calibration.calibrated }; }, r.id);
    const moved = Math.hypot(mid.pos.x - r.from.x, mid.pos.y - r.from.y);
    check(moved > 0.5 && JSON.stringify(mid.src) !== JSON.stringify(r.src), 'dragging an access-point marker moves it, and the wave sources change while the mouse is still down', `moved ${moved.toFixed(2)} m`);
    let inFile = null;
    if (savedSetup) inFile = (JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8')).devices.find((d) => d.id === r.id) || {}).position;
    else if (fs.existsSync(AP_FILE)) inFile = JSON.parse(fs.readFileSync(AP_FILE, 'utf8')).positions[r.id];
    // put both files back before anything else can fail: they are the owner's real positions
    if (saved) fs.writeFileSync(AP_FILE, saved); else if (fs.existsSync(AP_FILE)) fs.unlinkSync(AP_FILE);
    if (savedSetup) fs.writeFileSync(SETUP_FILE, savedSetup);
    check(!!inFile && Math.abs(inFile.x - end.pos.x) < 0.02 && end.pos.source === 'placed', `the new position is saved to data/private/${savedSetup ? 'network-setup.json' : 'ap-positions.json'} and marked "placed"`);
    check(errors.length === 0, 'no error during the drag', errors.join(' | '));
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('signal-atlas:')) localStorage.removeItem(k); });
    await page.close();
  }
  { // 5. live feed
    const { page, errors } = await open(browser, live.url, 'orbit=0');
    const before = await page.evaluate(() => window.__atlas.store.count);
    await page.waitForTimeout(5000);
    const after = await page.evaluate(() => ({ count: window.__atlas.store.count, mode: window.__atlas.state.mode, live: window.__atlas.state.liveAvailable, clock: document.getElementById('clock-mode').textContent, age: Date.now() - window.__atlas.state.cursor }));
    check(after.live && after.count > before && after.mode === 'live' && /LIVE/.test(after.clock) && Math.abs(after.age) < 5000 && errors.length === 0, 'with a live feed the page switches to LIVE and new samples arrive', `${after.count - before} new sample rows in 5 s${errors.length ? ' | ' + errors.join(' | ') : ''}`);
    await page.close();
  }
  { // 5b. colour themes
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const look = () => page.evaluate(() => ({ theme: window.__atlas.state.theme, ramp: document.querySelector('#legend .ramp').style.background, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), badges: document.getElementById('badges').textContent }));
    await page.goto(`${srv.url}/?nolive=1&orbit=0`);
    await page.waitForFunction(() => window.__atlas && window.__atlas.ready, null, { timeout: 120_000 });
    await page.waitForTimeout(700);
    const first = await look();
    await page.goto(`${srv.url}/?nolive=1&orbit=0&theme=heat`);
    await page.waitForFunction(() => window.__atlas && window.__atlas.ready, null, { timeout: 120_000 });
    await page.waitForTimeout(700);
    const heat = await look();
    check(first.theme === 'mission' && heat.theme === 'heat' && heat.ramp !== first.ramp && heat.accent !== first.accent, 'the address can pick a theme: ?theme=heat changes the legend and the accent colour', `${first.theme} -> ${heat.theme}`);
    // pick a colour: the theme becomes "custom", is saved in this browser and comes back after a reload
    await page.goto(`${srv.url}/?nolive=1&orbit=0`);
    await page.waitForFunction(() => window.__atlas && window.__atlas.ready, null, { timeout: 120_000 });
    await page.waitForTimeout(700);
    const setColor = (key, value) => page.evaluate(([k, v]) => { const el = document.querySelector(`[data-theme-color="${k}"]`); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, [key, value]);
    await setColor('signalHigh', '#ff66cc');
    await page.waitForTimeout(600);
    const picked = await look();
    await page.reload();
    await page.waitForFunction(() => window.__atlas && window.__atlas.ready, null, { timeout: 120_000 });
    await page.waitForTimeout(700);
    const back = await look();
    check(picked.theme === 'custom' && /ff66cc/i.test(picked.ramp.replace(/rgb\((\d+), (\d+), (\d+)\)/g, (_, r, g, b) => '#' + [r, g, b].map((v) => Number(v).toString(16).padStart(2, '0')).join(''))) && back.theme === 'custom' && back.ramp === picked.ramp,
      'picking a colour makes a custom theme, and the choice is still there after a reload', `${picked.theme}, after reload ${back.theme}`);
    // a palette that is hard to read: a plain warning, and the palette stays in use
    await setColor('signalLow', '#ffffaa');
    await setColor('signalHigh', '#101030');
    await page.waitForTimeout(700);
    const warn = await page.evaluate(() => ({ text: document.querySelector('#controls .hint.warn')?.textContent || '', theme: window.__atlas.state.theme, ramp: document.querySelector('#legend .ramp').style.background }));
    check(/hard to read/.test(warn.text) && /still in use/.test(warn.text) && warn.theme === 'custom' && warn.ramp !== picked.ramp, 'a custom palette that fails the readability check shows a warning and is still used', warn.text.slice(0, 110));
    check(/Synthetic data/i.test(heat.badges) && /Synthetic layout/i.test(heat.badges) && errors.length === 0, 'the SYNTHETIC labels are the same in another theme, and no error was logged', errors.join(' | '));
    await ctx.close();
  }
  if (hadPrivate) { // 5c. survey mode, with its files in a temporary folder so the real waypoints are not touched
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-smoke-survey-'));
    const s = await openBrowser({ server: { surveyDir: dir } });
    try {
      const page = await s.browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const load = async () => { await page.goto(`${s.srv.url}/?nolive=1&view=plan&level=1&survey=1`); await page.waitForFunction(() => window.__atlas && window.__atlas.ready, null, { timeout: 120_000 }); await page.waitForTimeout(1500); };
      await load();
      const before = await page.evaluate(() => ({ survey: window.__atlas.state.survey, next: window.__atlas.model.measureNext(5).length, real: window.__atlas.model.measuredPlaces().length, panel: document.querySelector('#controls .survey')?.textContent || '' }));
      check(before.survey && /Where to measure next/.test(before.panel) && before.next > 0 && before.real === 0, 'survey mode opens with a "where to measure next" list, and synthetic points do not count as measured', `${before.next} places suggested, ${before.real} measured`);
      // click in the middle of the largest room of level 1
      const target = await page.evaluate(async () => {
        const { interiorPoint, polygonArea } = await import('/src/core/geometry.js');
        const a = window.__atlas, li = a.scene.levelIndex('1');
        const room = [...a.scene.levels[li].rooms].sort((p, q) => polygonArea(q.polygon) - polygonArea(p.polygon))[0];
        const [x, y] = interiorPoint(room.polygon, 0.3);
        const v = a.scene.worldOf(li, x, y, 1.0).project(a.scene.camera);
        const r = document.getElementById('stage').getBoundingClientRect();
        return { x, y, sx: r.left + (v.x * 0.5 + 0.5) * r.width, sy: r.top + (-v.y * 0.5 + 0.5) * r.height };
      });
      await page.mouse.click(target.sx, target.sy);
      await page.waitForTimeout(800);
      const file = path.join(dir, 'waypoints.ndjson');
      const saved = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
      const wp = saved[0];
      check(saved.length === 1 && wp.kind === 'waypoint' && wp.level === '1' && Math.hypot(wp.x - target.x, wp.y - target.y) < 0.3 && Number.isFinite(Date.parse(wp.time)),
        'a click in survey mode saves a waypoint with floor, position and time', wp ? `${Math.hypot(wp.x - target.x, wp.y - target.y).toFixed(2)} m from the clicked spot` : 'no waypoint written');
      // a made-up survey row at that waypoint: 4 dB stronger than the model says
      const made = await page.evaluate(async (w) => {
        const { predictRssi } = await import('/src/core/propagation.js');
        const a = window.__atlas, ap = a.model.aps.find((p) => p.position.level === '1' && p.bssid?.['2.4']);
        const predicted = predictRssi(a.model.ctx, a.model.calibration.params['2.4'], ap, { level: w.level, x: w.x, y: w.y });
        return { row: { time: w.time, node_id: 'survey-laptop', kind: 'scan', bssid: ap.bssid['2.4'], ssid: '', band: '2.4', channel: 6, rssi_dbm: Math.round((predicted + 4) * 10) / 10, pos_level: w.level, pos_x: w.x, pos_y: w.y, waypoint: w.id, rssi_approx: true }, predicted };
      }, wp);
      fs.writeFileSync(path.join(dir, 'survey.ndjson'), JSON.stringify({ kind: 'meta', synthetic: false }) + '\n' + JSON.stringify(made.row) + '\n');
      await load();
      const after = await page.evaluate(() => { const c = window.__atlas.comparison; return { n: c.points.length, synthetic: c.synthetic, error: c.points[0]?.error, source: c.points[0]?.source, real: window.__atlas.model.measuredPlaces().length, panel: document.querySelector('#controls .survey')?.textContent || '', marker: document.querySelector('.wp-label')?.textContent || '' }; });
      check(after.n === 1 && !after.synthetic && after.source === 'laptop' && Math.abs(after.error - 4) < 2 && after.real === 1 && /MEDIAN ERROR/.test(after.panel) && /laptop/.test(after.panel),
        'after the import the waypoint shows measured against predicted, the error, and its source', `error ${after.error?.toFixed(1)} dB (made 4 dB too strong), source ${after.source}`);
      await page.evaluate(() => document.querySelector('[data-action="undo-waypoint"]').click());
      await page.waitForTimeout(600);
      const left = fs.readFileSync(file, 'utf8').trim();
      check(left === '' && errors.length === 0, 'the last waypoint can be taken back, and no error was logged', errors.join(' | '));
      await page.close();
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  { // 5d. Setup panel: networks and devices, with its file in a temporary folder so data/user/ is not touched
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-smoke-setup-'));
    const file = path.join(dir, 'network-setup.json');
    // surveyDir too: on the owner's house the setup would otherwise go to data/private/
    const s = await openBrowser({ server: { userDir: dir, surveyDir: dir } });
    try {
      const page = await s.browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      const load = async (query = '') => { await page.goto(`${s.srv.url}/?nolive=1&quality=low&orbit=0&setup=1${query}`); await page.waitForFunction(() => window.__atlas && window.__atlas.ready, null, { timeout: 120_000 }); await page.waitForTimeout(1200); };
      // sources: place and strength of every wave source (their phase changes with time and is left out)
      const look = () => page.evaluate(() => { const a = window.__atlas; return { open: !document.getElementById('setup').hidden, aps: a.model.aps.map((x) => x.id), nets: Object.keys(a.config.networks), rows: document.querySelectorAll('#setup .dev').length, netRows: document.querySelectorAll('#setup .net-row').length, sources: JSON.stringify(Array.from({ length: a.solver?.baseCount || 0 }, (_, k) => [a.solver.srcData[k * 4], a.solver.srcData[k * 4 + 1], Math.round(a.solver.srcAmp[k] * 1000)])), view: a.state.view, level: a.state.level, armed: a.setup.armed(), panel: document.getElementById('setup').textContent, controls: document.getElementById('controls').textContent, labels: document.getElementById('labels').textContent }; });
      const type = async (locator, text) => { await locator.fill(text); await locator.press('Tab'); await page.waitForTimeout(500); };
      const saved = () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
      await load();
      const start = await look();
      check(start.open && start.netRows === start.nets.length && start.rows > start.aps.length && saved() === null, 'the Setup panel lists the networks and devices of the config and writes nothing before a change', `${start.netRows} networks, ${start.rows} devices`);

      // a third network, then a new access point on it; the new access point waits for a click on the plan
      await page.click('#setup [data-act="add-net"]');
      await page.waitForTimeout(400);
      await type(page.locator('#setup .net-row').last().locator('[data-f="label"]'), 'Smoke guests');
      await type(page.locator('#setup .net-row').last().locator('[data-f="ssid"]'), 'Guest-SMOKE');
      await page.click('#setup [data-act="add-dev"]');
      await page.waitForTimeout(600);
      const waiting = await look();
      check(waiting.armed && waiting.view === 'plan' && waiting.level !== 'all' && waiting.aps.length === start.aps.length && /Click the spot/.test(waiting.panel), 'a new device waits for a click, and the view goes to the 2D plan of one floor', `floor ${waiting.level}`);
      await page.locator('#setup .dev.is-open [data-f="network"]').selectOption({ index: 3 });
      await page.waitForTimeout(400);
      const target = await page.evaluate(async () => {
        const { interiorPoint, polygonArea } = await import('/src/core/geometry.js');
        const a = window.__atlas, li = a.scene.levelIndex(a.state.level);
        // a spot inside a large room with no label near it: the later drag grabs the marker there, and a label would catch it
        const r = document.getElementById('stage').getBoundingClientRect();
        // only sensor labels take clicks (styles/app.css)
        const busy = [...document.querySelectorAll('#labels .node-label')].map((el) => el.getBoundingClientRect()).filter((b) => b.width > 0);
        const free = (sx, sy) => !busy.some((b) => sx > b.left - 40 && sx < b.right + 110 && sy > b.top - 40 && sy < b.bottom + 70);
        let best = null;
        for (const room of [...a.scene.levels[li].rooms].sort((p, q) => polygonArea(q.polygon) - polygonArea(p.polygon))) {
          for (const f of [0.3, 0.5, 0.15, 0.7]) {
            const [x, y] = interiorPoint(room.polygon, f);
            const v = a.scene.worldOf(li, x, y, 1.0).project(a.scene.camera);
            const spot = { x, y, sx: r.left + (v.x * 0.5 + 0.5) * r.width, sy: r.top + (-v.y * 0.5 + 0.5) * r.height };
            best = best || spot;
            if (free(spot.sx, spot.sy)) return spot;
          }
        }
        return best;
      });
      await page.mouse.click(target.sx, target.sy);
      await page.waitForTimeout(1500);
      const placed = await look();
      const newId = placed.aps.find((id) => !start.aps.includes(id));
      const where = await page.evaluate((id) => { const a = window.__atlas, ap = a.model.aps.find((x) => x.id === id); return ap ? { ...ap.position, network: ap.network, label: ap.label, ready: a.workerReady } : null; }, newId);
      check(!!where && Math.hypot(where.x - target.x, where.y - target.y) < 0.3 && where.level === waiting.level && !placed.armed, 'a click on the plan places the new access point there', where ? `${Math.hypot(where.x - target.x, where.y - target.y).toFixed(2)} m from the clicked spot` : 'no new access point in the model');
      check(placed.sources !== start.sources && placed.labels.includes(where?.label) && placed.nets.length === 3 && where?.network === placed.nets[2] && /Smoke guests/.test(placed.controls) && /Best of all/.test(placed.controls),
        'without a reload: the wave sources change, the marker is on the map, and the network switch lists the new network');
      const disk = saved();
      const onDisk = disk?.devices.find((d) => d.id === newId);
      check(!!onDisk && onDisk.position.level === where.level && Math.abs(onDisk.position.x - where.x) < 0.02 && disk.networks[2].ssid === 'Guest-SMOKE' && onDisk.network === disk.networks[2].id, 'the setup is saved to its own file, with the network, the device and its place');

      // edit by typing: a name, a height and a BSSID; a wrong BSSID is refused and the old value stays
      await type(page.locator('#setup .dev.is-open [data-f="label"]'), 'Smoke AP');
      await type(page.locator('#setup .dev.is-open [data-f="z"]'), '2.2');
      await type(page.locator('#setup .dev.is-open [data-f="bssid"]').first(), '02-00-00-5A-00-01');
      await type(page.locator('#setup .dev.is-open [data-f="bssid"]').first(), 'wrong');
      await page.waitForTimeout(600);
      const edited = await page.evaluate((id) => { const a = window.__atlas, ap = a.model.aps.find((x) => x.id === id); return { label: ap.label, z: ap.position.z, bssid: Object.values(ap.bssid), known: a.model.bssids.has('02:00:00:5a:00:01'), note: document.querySelector('#setup .note')?.textContent || '', field: document.querySelector('#setup .dev.is-open [data-f="bssid"]').value, map: document.getElementById('labels').textContent }; }, newId);
      check(edited.label === 'Smoke AP' && edited.z === 2.2 && edited.known && edited.field === '02:00:00:5a:00:01' && /BSSID looks like/.test(edited.note) && edited.map.includes('Smoke AP'), 'name, height and BSSID can be typed; a wrong BSSID is refused with a plain message', edited.note);

      // dragging the marker moves it and the place goes to the setup file
      const grip = await page.evaluate((id) => { const a = window.__atlas, ap = a.model.aps.find((x) => x.id === id), li = a.scene.levelIndex(ap.position.level); const v = a.scene.worldOf(li, ap.position.x, ap.position.y, 1.0).project(a.scene.camera); const r = document.getElementById('stage').getBoundingClientRect(); return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height }; }, newId);
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x + 70, grip.y + 30, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(1200);
      const dragged = await page.evaluate((id) => ({ ...window.__atlas.model.aps.find((x) => x.id === id).position }), newId);
      // the save follows the change a moment later: wait for it instead of guessing how long it takes
      let draggedDisk = null;
      for (let i = 0; i < 25; i++) { draggedDisk = saved()?.devices.find((d) => d.id === newId)?.position; if (draggedDisk && Math.abs(draggedDisk.x - dragged.x) < 0.02) break; await page.waitForTimeout(200); }
      check(Math.hypot(dragged.x - where.x, dragged.y - where.y) > 0.5 && !!draggedDisk && Math.abs(draggedDisk.x - dragged.x) < 0.02 && draggedDisk.z === 2.2, 'dragging the marker moves the access point, and the new place and the height are in the setup file', `moved ${Math.hypot(dragged.x - where.x, dragged.y - where.y).toFixed(2)} m`);

      // a note that names a device must go when privacy mode comes on
      await page.click('#setup .dev.is-open [data-act="place"]');
      await page.waitForTimeout(400);
      const named = await page.evaluate(() => document.querySelector('#setup .status')?.textContent || '');
      await page.evaluate(() => window.__atlas.apply('privacy', true));
      await page.waitForTimeout(600);
      const masked = await page.evaluate(() => document.getElementById('setup').innerHTML);
      await page.evaluate(() => window.__atlas.apply('privacy', false));
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      check(/Smoke AP/.test(named) && !/Smoke AP|Smoke guests|Guest-SMOKE/.test(masked), 'switching privacy mode on takes a note that names a device off the panel');

      // after a reload the setup comes back from the file
      await load();
      const again = await look();
      check(again.aps.includes(newId) && again.nets.length === 3 && /Smoke AP/.test(again.panel) && again.labels.includes('Smoke AP'), 'after a reload the networks and devices come back from the setup file', `${again.aps.length} access points`);

      // privacy mode: the panel works, and none of the names is in it
      await load('&privacy=1');
      await page.locator('#setup .dev-head').nth(again.aps.indexOf(newId)).click();
      await page.waitForTimeout(500);
      const hiddenLook = await page.evaluate(() => ({ html: document.documentElement.outerHTML + [...document.querySelectorAll('input, select')].map((e) => e.value).join('\n'), body: !!document.querySelector('#setup .dev.is-open [data-f="z"]'), name: !!document.querySelector('#setup .dev.is-open [data-f="label"]') }));
      check(hiddenLook.body && !hiddenLook.name && !/Smoke AP|Smoke guests|Guest-SMOKE|02:00:00:5a:00:01/i.test(hiddenLook.html), 'in privacy mode the panel shows no name, SSID or BSSID, and place and height can still be edited');

      // remove the device, take it back, remove it again, then remove the network.
      // The first Remove is clicked straight out of a field that was just changed: the change and the click both count.
      await page.locator('#setup .dev.is-open [data-f="tx"]').first().fill('15');
      await page.click('#setup .dev.is-open [data-act="remove-dev"]');
      await page.waitForTimeout(900);
      const gone = await look();
      const typedTx = saved()?.devices.find((d) => d.id === newId);
      check(!gone.aps.includes(newId) && typedTx === undefined && /Device removed/.test(gone.panel), 'a button clicked straight out of a changed field still works');
      await page.click('#setup [data-act="undo"]');
      await page.waitForTimeout(900);
      const back = await look();
      await page.locator('#setup .dev-head').nth(back.aps.indexOf(newId)).click();
      await page.waitForTimeout(400);
      await page.click('#setup .dev.is-open [data-act="remove-dev"]');
      await page.waitForTimeout(500);
      await page.locator('#setup [data-act="remove-net"]').last().click();
      await page.waitForTimeout(1200);
      const end = await look();
      const endDisk = saved();
      check(!gone.aps.includes(newId) && back.aps.includes(newId) && !end.aps.includes(newId) && end.nets.length === 2 && endDisk.networks.length === 2 && !endDisk.devices.some((d) => d.id === newId) && end.sources === start.sources,
        'removing a device and a network takes them out of the model, the waves and the file; Undo puts the last one back');
      check(errors.length === 0, 'no error was logged while the setup changed', errors.join(' | '));
      await page.close();
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  { // 6. automatic quality steps down. This needs slow frames, so it runs in a second browser
    // that draws in software. The first browser may use the real GPU and never get slow.
    const slow = await openBrowser({ launch: { args: ['--no-sandbox', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } });
    const page = await slow.browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const srv = slow.srv;
    await page.goto(`${srv.url}/?nolive=1&quality=auto&autostart=high&orbit=0`);
    await page.waitForFunction(() => window.__atlas && window.__atlas.ready, null, { timeout: 120_000 });
    const start = await page.evaluate(() => window.__atlas.perf.quality);
    let now = start;
    for (let i = 0; i < 40 && now !== 'low'; i++) { await page.waitForTimeout(3000); now = await page.evaluate(() => window.__atlas.perf.quality); }
    const ema = await page.evaluate(() => window.__atlas.perf.ema);
    const renderer = await page.evaluate(() => window.__atlas.perf.renderer);
    check(start === 'high' && now !== 'high', 'automatic quality steps the wave grid down when frames are slow', `started at ${start}, now ${now} (software renderer: ${/swiftshader|software|llvmpipe/i.test(renderer) ? 'yes' : 'no'}, frame time about ${ema.toFixed(0)} ms)`);
    await page.close();
    await slow.close();
  }
} finally {
  await live.close();
  await close();
}
const bad = results.filter((r) => !r).length;
console.log(`${results.length - bad} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
