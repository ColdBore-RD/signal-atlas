#!/usr/bin/env node
// End-to-end check of the Layout setup panel in headless Chromium, with screenshots.
//
//   node tools/verify/layout-check.mjs [--out tmp/layout] [--no-shots]
//
// It walks the three ways in (docs/custom-layout.md) the way a person would, with
// the mouse on the editor canvas: drawing a house on the grid, tracing a plan
// image after setting its scale by a known length, and importing a scan export
// (skipped without the Python packages). Each result is applied and must come up
// in the atlas as a valid plan with a running wave simulation.
// Every house here is made up. The server gets an empty user workspace in the
// temp folder and runs in public mode, so neither data/user/ nor data/private/
// of this checkout is read or written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.mjs';
import { validateFloorplan } from '../../src/core/validate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const outDir = path.resolve(value('--out', 'tmp/layout'));
const shots = !args.includes('--no-shots');
if (shots) fs.mkdirSync(outDir, { recursive: true });
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/schema/floorplan.schema.json'), 'utf8'));
const materials = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/materials.json'), 'utf8'));
const results = [];
const check = (ok, name, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`); };

const venv = [path.join(ROOT, '.venv', 'Scripts', 'python.exe'), path.join(ROOT, '.venv', 'bin', 'python')].find((p) => fs.existsSync(p));
const pythonOk = !!venv && spawnSync(venv, ['-c', 'import ezdxf, shapely, numpy, PIL']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-layout-check-'));
const userDir = path.join(tmp, 'user');
const { srv, browser, close } = await openBrowser({ server: { userDir, publicMode: true, python: pythonOk ? venv : false } });

/** A made-up plan picture: white paper, black walls, 50 pixels per metre, a 6 m dimension line. */
function planImageHtml() {
  return `<canvas id="c" width="700" height="500"></canvas><script>
    const g = document.getElementById('c').getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 700, 500);
    g.strokeStyle = '#000'; g.lineWidth = 6;
    g.strokeRect(100, 100, 500, 300);                       // 10 x 6 m
    g.beginPath(); g.moveTo(400, 100); g.lineTo(400, 400); g.stroke();   // a wall at x = 6 m
    g.lineWidth = 2; g.beginPath(); g.moveTo(100, 440); g.lineTo(400, 440); g.moveTo(100, 430); g.lineTo(100, 450); g.moveTo(400, 430); g.lineTo(400, 450); g.stroke();
    g.fillStyle = '#000'; g.font = '20px sans-serif'; g.fillText('6.00 m', 220, 470); g.fillText('LIVING', 210, 250); g.fillText('BEDROOM', 450, 250);
    g.font = '14px sans-serif'; g.fillText('1 Made-up Lane, Nowhere', 100, 80);
  </script>`;
}

async function newPage(query = '') {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${srv.url}/?nolive=1&orbit=0&quality=low&${query}`);
  await page.waitForFunction(() => window.__atlas, null, { timeout: 120_000 });
  return { page, errors };
}
const shot = async (page, name) => { if (!shots) return; const file = path.join(outDir, `${name}.png`); await page.screenshot({ path: file }); console.log(`      screenshot ${path.relative(process.cwd(), file)}`); };
const at = (page, x, y) => page.evaluate(([px, py]) => window.__layoutSetup.toScreen(px, py), [x, y]);
async function click(page, x, y) { const p = await at(page, x, y); await page.mouse.click(p.x, p.y); }
async function drag(page, a, b) {
  const p = await at(page, a[0], a[1]), q = await at(page, b[0], b[1]);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 4 }); await page.mouse.move(q.x, q.y, { steps: 4 }); await page.mouse.up();
}
const tool = (page, id) => page.click(`#layout-setup [data-tool="${id}"]`);
const draft = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__layoutSetup.state.draft)));
/** How many pixels of the editor canvas near a plan point are brighter than the grid can be: tells whether the plan image is drawn there. */
const lightAt = (page, x, y) => page.evaluate(([px, py]) => {
  const c = document.querySelector('#layout-setup canvas'), r = c.getBoundingClientRect(), s = window.__layoutSetup.toScreen(px, py), k = c.width / r.width;
  const d = c.getContext('2d').getImageData(Math.round((s.x - r.left) * k) - 6, Math.round((s.y - r.top) * k) - 6, 13, 13).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 320) n++;
  return n;
}, [x, y]);
const preview = (page) => page.evaluate(() => ({ errors: window.__layoutSetup.state.preview.errors, warnings: window.__layoutSetup.state.preview.warnings }));
/** Apply in the panel, wait for the reload, and report what the atlas shows. */
async function applyAndRead(page) {
  await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click('#layout-setup .ls-bar [data-act="apply"]')]);
  await page.waitForFunction(() => window.__atlas, null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const a = window.__atlas;
    if (!a.ready) return { ready: false, error: a.error };
    return {
      ready: true, url: location.search, floorplan: a.config.paths.floorplan, samples: a.config.paths.samples.length, house: document.getElementById('house-name').textContent,
      levels: a.model.levels.map((l) => ({ id: l.level.id, name: l.level.name, source: l.level.source, rooms: (l.level.rooms || []).length, walls: l.level.walls.length, openings: (l.level.openings || []).length })),
      waves: !!a.solver, banner: document.getElementById('banner').hidden ? '' : document.getElementById('banner').textContent,
      aps: a.model.aps.map((ap) => ap.position.level), badges: document.getElementById('badges').textContent,
    };
  });
}

try {
  // ------------------------------------------------------------------ 3. build it on the grid
  {
    const { page, errors } = await newPage('demo=1');
    check(await page.evaluate(() => window.__atlas.ready && window.__atlas.config.paths.floorplan === 'data/synthetic/floorplan.json'), 'with ?demo=1 the page shows the demo house');
    await page.keyboard.press('l');
    await page.waitForSelector('#layout-setup:not([hidden])');
    await page.waitForFunction(() => window.__layoutSetup.state.loaded);
    check(await page.evaluate(() => window.__layoutSetup.state.draft.levels.length === 1 && window.__layoutSetup.state.preview.errors.length === 1), 'the key L opens the panel on an empty grid, and an empty floor is said to be an error in plain words', (await preview(page)).errors.join(' | '));
    await shot(page, '3-build-0-empty');

    await tool(page, 'rect');
    await drag(page, [0, 0], [5, 4]);
    await drag(page, [5, 0], [9, 4]);
    await drag(page, [0, 4], [9, 7]);
    // a room drawn corner by corner: an L-shaped garage on the right
    await tool(page, 'poly');
    for (const p of [[9, 0], [13, 0], [13, 7], [11, 7], [11, 4], [9, 4]]) await click(page, p[0], p[1]);
    await page.keyboard.press('Enter');
    let d = await draft(page);
    check(d.levels[0].rooms.length === 4 && d.levels[0].rooms[3].polygon.length === 6, 'three rooms drawn by dragging and one corner by corner', d.levels[0].rooms.map((r) => `${r.name} ${r.polygon.length}`).join(', '));

    // names: select a room and type
    await tool(page, 'select');
    const names = ['Living room', 'Kitchen', 'Hall', 'Garage'];
    const spots = [[2, 2], [7, 2], [4, 5.5], [12, 2]];
    let tabbedTo = '';
    for (let i = 0; i < 4; i++) {
      await click(page, spots[i][0], spots[i][1]);
      await page.fill('#layout-setup [data-field="room-name"]', names[i]);
      await page.keyboard.press('Tab');
      await page.waitForTimeout(60);
      if (i === 0) tabbedTo = await page.evaluate(() => document.activeElement?.dataset.k || document.activeElement?.tagName);
    }
    check(tabbedTo === 'room-height', 'Tab from a text box goes on to the next box, although the panel is rebuilt', `focus is on "${tabbedTo}"`);
    // doors, windows, an opening, stairs
    await tool(page, 'door');
    await click(page, 4, 7); await click(page, 5, 2); await click(page, 9, 5.5);
    await tool(page, 'window');
    await click(page, 2, 0); await click(page, 7, 0); await click(page, 0, 2);
    await tool(page, 'opening');
    await click(page, 2.5, 4);
    await tool(page, 'stairs');
    await drag(page, [6.5, 4.5], [8.5, 5.5]);
    // a second floor as a copy, then a basement without a copy
    // leave a text box by clicking a button: the typed name is kept and the click still counts
    await page.fill('#layout-setup [data-field="lvl-name"]', 'Ground floor');
    await page.click('#layout-setup [data-act="level-above"]');
    await page.fill('#layout-setup [data-field="lvl-height"]', '8 ft');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);
    await page.click('#layout-setup [data-act="level"][data-i="0"]');
    d = await draft(page);
    const pv = await preview(page);
    check(d.levels.length === 2 && d.levels[0].name === 'Ground floor' && d.levels[0].openings.length === 7 && d.levels[0].stairs.length === 1 && d.levels[1].rooms.length === 4 && Math.abs(d.levels[1].height - 2.438) < 0.001,
      'doors, windows, an opening and stairs were placed by clicks; a second floor is a copy with a ceiling typed in feet', `${d.levels[0].openings.map((o) => o.type).join(', ')}; upper ceiling ${d.levels[1].height} m`);
    check(pv.errors.length === 0, 'the drawn house is a valid plan', [...pv.errors, ...pv.warnings].join(' | ') || 'no error, no warning');
    // undo and redo
    await page.keyboard.press('Control+z');
    const undone = (await draft(page)).levels.length;
    await page.keyboard.press('Control+y');
    check(undone === 2 && (await draft(page)).levels[1].height !== undefined, 'undo and redo work from the keyboard');
    // keys must not reach the page behind the panel
    await page.keyboard.press('p');
    check(await page.evaluate(() => window.__atlas.state.privacy === false), 'a key pressed in the panel does not reach the atlas behind it (P is privacy mode there)');
    await tool(page, 'select');
    await click(page, 2, 2);
    await shot(page, '3-build-1-editor');

    const info = await applyAndRead(page);
    const first = info.levels?.find((l) => l.id === '1');
    check(info.ready && info.floorplan === 'data/user/floorplan.json' && /layout=user/.test(info.url) && !/demo/.test(info.url) && info.samples === 0, 'Apply saves the plan to the user workspace and reloads the atlas on it, without the demo samples', JSON.stringify({ url: info.url, floorplan: info.floorplan, error: info.error }));
    check(info.ready && info.levels.length === 2 && first?.rooms === 4 && first?.source === 'drawn' && first.openings === 7 && info.waves && !info.banner, 'the atlas shows the drawn house: 2 floors, 4 rooms, 7 openings, waves running, no warning banner', JSON.stringify(info.levels));
    check(info.ready && !/Synthetic layout/i.test(info.badges) && info.aps.every((l) => ['1', '2'].includes(l)), 'no SYNTHETIC LAYOUT badge, and every access point stands on a floor of the new house', info.badges);
    const stored = JSON.parse(fs.readFileSync(path.join(userDir, 'floorplan.json'), 'utf8'));
    check(validateFloorplan(stored, schema, materials).errors.length === 0 && stored.levels[0].rooms.some((r) => r.name === 'Garage'), 'the stored file passes the same check as tools/validate-floorplan.mjs');
    await page.waitForTimeout(3500);
    await shot(page, '3-build-2-atlas');
    check(errors.length === 0, 'building a house logs no error', errors.join(' | '));
    await page.close();

    for (const [name, query] of [['3-build-3-atlas-plan', 'layout=user&view=plan&level=1&layer=fused'], ['3-build-4-atlas-privacy', 'layout=user&privacy=1']]) {
      const v = await newPage(query);
      await v.page.waitForTimeout(4000);
      if (name.includes('privacy')) check(await v.page.evaluate(() => document.getElementById('house-name').textContent === 'Home' && !document.body.innerText.includes('My house')), 'privacy mode hides the name of the house');
      await shot(v.page, name);
      check(v.errors.length === 0, `the user layout opens with "${query}" without an error`, v.errors.join(' | '));
      await v.page.close();
    }
    // the panel opens again on the saved draft, also in privacy mode
    const again = await newPage('layout=user&privacy=1');
    await again.page.click('#layout-open');
    await again.page.waitForFunction(() => window.__layoutSetup.state.loaded);
    check((await draft(again.page)).levels[0].rooms.length === 4, 'the panel opens again on the saved draft');
    check(await again.page.evaluate(() => !document.querySelector('#layout-setup [data-field="house-name"]')), 'in privacy mode the panel does not show the house name');
    await shot(again.page, '3-build-5-editor-privacy');
    await again.page.close();
    // ?demo=1 still shows the demo house although a user layout exists now
    const demo = await newPage('demo=1');
    check(await demo.page.evaluate(() => window.__atlas.config.paths.floorplan === 'data/synthetic/floorplan.json'), '?demo=1 shows the demo house even when a user layout exists');
    await demo.page.close();
  }

  // ------------------------------------------------------------------ 2. trace a plan image
  {
    fs.rmSync(userDir, { recursive: true, force: true });
    const maker = await browser.newPage();
    await maker.setContent(planImageHtml());
    const png = path.join(tmp, 'plan.png');
    fs.writeFileSync(png, Buffer.from((await maker.evaluate(() => document.getElementById('c').toDataURL('image/png'))).split(',')[1], 'base64'));
    await maker.close();

    const { page, errors } = await newPage('demo=1');
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* none */ } });
    await page.click('#layout-open');
    await page.waitForFunction(() => window.__layoutSetup.state.loaded);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#layout-setup .ls-start [data-act="img-load"]')]);
    await chooser.setFiles(png);
    await page.waitForFunction(() => window.__layoutSetup.state.draft.levels[0].underlay && window.__layoutSetup.state.tool === 'scale');
    const before = (await draft(page)).levels[0].underlay;
    check(before.scaled === false && before.w === 700, 'a plan image is loaded under the grid and the panel asks for its scale', `${before.w} x ${before.h} px`);
    await shot(page, '2-image-0-loaded');
    // the two ends of the 6.00 m dimension line: pixels (100, 440) and (400, 440) of the picture
    const k = before.mPerPx;
    await click(page, before.x + 100 * k, before.y + 440 * k);
    await click(page, before.x + 400 * k, before.y + 440 * k);
    await page.fill('#layout-setup [data-field="scale-length"]', '6 m');
    await shot(page, '2-image-1-scale');
    await page.click('#layout-setup [data-act="scale-set"]');
    const u = (await draft(page)).levels[0].underlay;
    check(u.scaled && Math.abs(u.mPerPx - 0.02) < 1e-4, 'two clicks on a known length set the scale', `1 pixel = ${(u.mPerPx * 100).toFixed(2)} cm (the picture was drawn at 2.00 cm)`);
    // trace the two rooms: picture pixels (100..400, 100..400) and (400..600, 100..400)
    const P = (ix, iy) => [u.x + ix * u.mPerPx, u.y + iy * u.mPerPx];
    await tool(page, 'rect');
    await drag(page, P(100, 100), P(400, 400));
    await drag(page, P(400, 100), P(600, 400));
    await tool(page, 'door');
    const dp = P(400, 250);
    await click(page, dp[0], dp[1]);
    const d = await draft(page);
    const sizes = d.levels[0].rooms.map((r) => { const xs = r.polygon.map((p) => p[0]), ys = r.polygon.map((p) => p[1]); return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]; });
    check(d.levels[0].rooms.length === 2 && Math.abs(sizes[0][0] - 6) < 0.11 && Math.abs(sizes[0][1] - 6) < 0.11 && Math.abs(sizes[1][0] - 4) < 0.11, 'rooms traced over the image have the size the picture says (6 x 6 m and 4 x 6 m)', sizes.map((s) => `${s[0].toFixed(2)} x ${s[1].toFixed(2)} m`).join(', '));
    await tool(page, 'select');
    await page.mouse.move(5, 5);
    const line = P(250, 440);                               // the middle of the dimension line of the picture, outside the rooms
    const seen = await lightAt(page, line[0], line[1]);
    await shot(page, '2-image-2-traced');
    // removing the image and taking that back with undo brings the picture back, not an empty frame
    await page.click('#layout-setup [data-act="img-remove"]');
    const gone = (await draft(page)).levels[0].underlay === null && (await lightAt(page, line[0], line[1])) === 0;
    await page.keyboard.press('Control+z');
    await page.mouse.move(6, 6);
    const back = await lightAt(page, line[0], line[1]);
    check(gone && back >= 10 && (await draft(page)).levels[0].underlay?.scaled === true, 'undo brings a removed plan image back with its scale', `bright pixels after undo: ${back}`);
    const info = await applyAndRead(page);
    check(info.ready && info.levels.length === 1 && info.levels[0].source === 'image-trace' && info.levels[0].rooms === 2 && info.waves && !info.banner, 'the traced plan is applied and its floor is marked as traced from an image', JSON.stringify(info.levels || info.error));
    check(fs.readdirSync(userDir).some((n) => /^underlay-1\.jpg$/.test(n)), 'the image is kept in the user workspace as a copy drawn by the browser (JPEG, no camera data)');
    await page.waitForTimeout(3500);
    await shot(page, '2-image-3-atlas');
    check(errors.length === 0, 'tracing an image logs no error', errors.join(' | '));
    await page.close();

    const priv = await newPage('layout=user&privacy=1');
    await priv.page.click('#layout-open');
    await priv.page.waitForFunction(() => window.__layoutSetup.state.loaded);
    await priv.page.waitForTimeout(600);
    // in privacy mode the picture itself must not be drawn: where its dimension line was bright, there is only the grid now
    const hiddenLight = await lightAt(priv.page, line[0], line[1]);
    check(seen >= 10 && hiddenLight === 0 && (await draft(priv.page)).levels[0].underlay !== null, 'in privacy mode the panel keeps the plan image hidden (it may show an address)', `bright pixels at a line of the picture: ${seen} when shown, ${hiddenLight} in privacy mode`);
    await shot(priv.page, '2-image-4-editor-privacy');
    await priv.page.close();
    const privAtlas = await newPage('layout=user&privacy=1&view=plan');
    await privAtlas.page.waitForTimeout(3500);
    await shot(privAtlas.page, '2-image-5-atlas-privacy');
    await privAtlas.page.close();
  }

  // ------------------------------------------------------------------ 1. scan export
  if (!pythonOk) console.log('SKIP  scan import: no .venv with ezdxf, numpy, pillow and shapely');
  else {
    fs.rmSync(userDir, { recursive: true, force: true });
    const src = path.join(tmp, 'scan');
    fs.mkdirSync(path.join(src, 'main'), { recursive: true });
    fs.mkdirSync(path.join(src, 'cellar'), { recursive: true });
    // made-up exports, written by the helpers of the importer's own test: two floors with stairs, a secret address in each file
    const q = (p) => JSON.stringify(p);
    const script = [
      'import sys', `sys.path.insert(0, ${q(path.join(ROOT, 'tools', 'trace'))})`, 'import test_import_polycam as t',
      'outer = [((0, 0), (11, 0)), ((11, 0), (11, 7)), ((11, 7), (0, 7)), ((0, 7), (0, 0))]',
      'walls = outer + [((6, 0), (6, 7)), ((6, 4), (11, 4))]',
      'rooms = [("Living Room 1", [(0, 0), (6, 0), (6, 7), (0, 7)]), ("Kitchen 1", [(6, 0), (11, 0), (11, 4), (6, 4)]), ("Bedroom 1", [(6, 4), (11, 4), (11, 7), (6, 7)])]',
      `t.write_dxf(${q(path.join(src, 'main', 'floorplan.dxf'))}, walls, rooms, doors=[((6, 1), (6, 1.9)), ((6, 5), (6, 5.9)), ((3, 0), (3.9, 0))], windows=[((1, 0), (2.2, 0)), ((8, 0), (9.5, 0)), ((11, 5), (11, 6))])`,
      `t.write_csv(${q(path.join(src, 'main', 'floorplan.csv'))}, 0.0, [("Living Room 1", 41.0, 2.7), ("Kitchen 1", 19.5, 2.7), ("Bedroom 1", 14.5, 2.7)], 77.0)`,
      `t.write_glb(${q(path.join(src, 'main', 'model.glb'))}, [("stairs7_0", 1.0, 2.0, 0.5, 2.8, 1.7)])`,
      `t.write_dxf(${q(path.join(src, 'cellar', 'floorplan.dxf'))}, outer, [("Basement 1", [(0, 0), (11, 0), (11, 7), (0, 7)])])`,
      `t.write_csv(${q(path.join(src, 'cellar', 'floorplan.csv'))}, 0.0, [("Basement 1", 76.0, 2.3)], 77.0)`,
      `t.write_glb(${q(path.join(src, 'cellar', 'model.glb'))}, [("stairs7_0", 1.0, 2.0, 0.5, 2.8, 1.3)])`,
      'print(t.SECRET_ADDRESS)',
    ].join('\n');
    const made = spawnSync(venv, ['-c', script], { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(`could not write the made-up scan export: ${made.stderr}`);
    const secret = made.stdout.trim();

    const { page, errors } = await newPage('demo=1');
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* none */ } });
    await page.click('#layout-open');
    await page.waitForFunction(() => window.__layoutSetup.state.loaded);
    await page.click('#layout-setup [data-act="scan-toggle"]');
    await page.waitForSelector('#layout-setup [data-act="scan-files"]', { timeout: 60_000 });
    let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#layout-setup [data-act="scan-files"][data-i="0"]')]);
    await chooser.setFiles(['floorplan.dxf', 'floorplan.csv', 'model.glb'].map((n) => path.join(src, 'main', n)));
    await page.click('#layout-setup [data-act="scan-add"]');
    await page.selectOption('#layout-setup [data-field="scan-kind"][data-i="1"]', 'basement');
    await page.waitForTimeout(100);
    [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#layout-setup [data-act="scan-files"][data-i="1"]')]);
    await chooser.setFiles(['floorplan.dxf', 'floorplan.csv', 'model.glb'].map((n) => path.join(src, 'cellar', n)));
    await shot(page, '1-scan-0-files');
    await page.click('#layout-setup [data-act="scan-import"]');
    await page.waitForFunction(() => !window.__layoutSetup.state.scan.busy, null, { timeout: 240_000 });
    const d = await draft(page);
    const note = await page.evaluate(() => window.__layoutSetup.state.note);
    const main = d.levels.find((l) => l.id === '1');
    check(d.levels.length === 2 && d.levels[0].id === 'B' && main?.rooms.length === 3 && main.openings.length === 6 && d.levels.every((l) => l.derive === false && l.source === 'lidar-scan'),
      'a two-floor scan export is imported through the local server into the editor', note || JSON.stringify(d.levels.map((l) => [l.id, l.rooms.length, l.openings.length])));
    check(main?.stairs.length === 1 && d.levels[0].stairs.length >= 0, 'the stairs come from the 3D model of the export', `${main?.stairs.length} on the main floor`);
    // correct the import in the editor: rename a room and add a window
    await page.click('#layout-setup [data-act="level"][data-i="1"]');
    await tool(page, 'select');
    const living = main.rooms.find((r) => /living/i.test(r.name)) || main.rooms[0];
    const c = living.polygon.reduce((s, p) => [s[0] + p[0] / living.polygon.length, s[1] + p[1] / living.polygon.length], [0, 0]);
    await click(page, c[0], c[1]);
    await page.fill('#layout-setup [data-field="room-name"]', 'Family room');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(80);
    await click(page, c[0], c[1]);
    await shot(page, '1-scan-1-editor');
    const info = await applyAndRead(page);
    check(info.ready && info.levels.length === 2 && info.levels.every((l) => l.source === 'lidar-scan') && info.waves && !info.banner, 'the imported house is applied: both floors marked as LiDAR scan, waves running', JSON.stringify(info.levels || info.error));
    const stored = fs.readFileSync(path.join(userDir, 'floorplan.json'), 'utf8');
    check(stored.includes('Family room') && validateFloorplan(JSON.parse(stored), schema, materials).errors.length === 0, 'the room renamed in the editor is in the stored plan, and the plan is valid');
    const texts = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { if (!/[\\/]scan[\\/]floor-\d+$/.test(f)) walk(f); } else if (/\.(json|ndjson)$/.test(e.name)) texts.push(f); } };
    walk(userDir);
    const leaks = texts.filter((f) => fs.readFileSync(f, 'utf8').includes(secret) || /secret street/i.test(fs.readFileSync(f, 'utf8')));
    check(leaks.length === 0 && texts.length >= 3, 'the address written in the exports is in none of the files the import made', `${texts.length} files read${leaks.length ? `; found in ${leaks.map((f) => path.basename(f)).join(', ')}` : ''}`);
    await page.waitForTimeout(3500);
    await shot(page, '1-scan-2-atlas');
    check(errors.length === 0, 'importing a scan logs no error', errors.join(' | '));
    await page.close();
    const priv = await newPage('layout=user&privacy=1');
    await priv.page.waitForTimeout(3500);
    await shot(priv.page, '1-scan-3-atlas-privacy');
    check(priv.errors.length === 0, 'the imported house opens in privacy mode without an error', priv.errors.join(' | '));
    await priv.page.close();
  }

  // ------------------------------------------------------------------ 1b. a plan file, and a file that is not a plan
  {
    fs.rmSync(userDir, { recursive: true, force: true });
    const { page, errors } = await newPage('demo=1');
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* none */ } });
    await page.click('#layout-open');
    await page.waitForFunction(() => window.__layoutSetup.state.loaded);
    const bad = path.join(tmp, 'not-a-plan.json');
    fs.writeFileSync(bad, JSON.stringify({ schemaVersion: 1, levels: [{ id: '1', name: 'x' }] }));
    let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#layout-setup [data-act="open-file"]')]);
    await chooser.setFiles(bad);
    await page.waitForFunction(() => window.__layoutSetup.state.note);
    const note = await page.evaluate(() => window.__layoutSetup.state.note);
    check(/not a floor plan/.test(note) && (await draft(page)).levels[0].rooms.length === 0, 'a file that is not a floor plan is refused with the reason, and the draft stays', note.slice(0, 140));
    [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#layout-setup [data-act="open-file"]')]);
    await chooser.setFiles(path.join(ROOT, 'data/synthetic/floorplan.json'));
    await page.waitForFunction(() => window.__layoutSetup.state.draft.levels.length === 3);
    await shot(page, '1b-file-0-editor');
    const info = await applyAndRead(page);
    check(info.ready && info.levels.length === 3 && info.waves, 'a complex plan file (three floors) is opened, applied and shown', JSON.stringify(info.levels?.map((l) => [l.id, l.rooms, l.walls]) || info.error));
    check(errors.length === 0, 'opening plan files logs no error', errors.join(' | '));
    await page.close();
  }

  // ------------------------------------------------------------------ without /api/layout (the page on a static host)
  {
    fs.rmSync(userDir, { recursive: true, force: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/layout**', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
    await page.goto(`${srv.url}/?nolive=1&orbit=0&quality=low&demo=1`);
    await page.waitForFunction(() => window.__atlas, null, { timeout: 120_000 });
    await page.click('#layout-open');
    await page.waitForFunction(() => window.__layoutSetup.state.loaded);
    await tool(page, 'rect');
    await drag(page, [0, 0], [7, 5]);
    const info = await applyAndRead(page);
    check(info.ready && info.levels.length === 1 && info.levels[0].rooms === 1 && info.waves && !fs.existsSync(path.join(userDir, 'floorplan.json')), 'without the local server the plan is kept in the browser and still comes up after Apply', JSON.stringify(info.levels || info.error));
    check(errors.length === 0, 'the static-host way throws no error', errors.join(' | '));
    await page.close();
  }
} finally {
  await close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
