#!/usr/bin/env node
// Rattle test of the Layout setup panel: bad input, odd shapes and a seeded random "monkey"
// in headless Chromium. layout-check.mjs walks the happy paths; this one tries to break them.
//
//   node tools/verify/layout-rattle.mjs [--out tmp/rattle] [--no-shots] [--steps 400] [--seed 7]
//
// Every house is made up. Like layout-check.mjs the server gets an empty user workspace in the
// temp folder and runs in public mode, so neither data/user/ nor data/private/ is read or written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBrowser } from './browser.mjs';
import { startServer } from '../serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const outDir = path.resolve(value('--out', 'tmp/rattle'));
const shots = !args.includes('--no-shots');
const STEPS = Number(value('--steps', 400));
const SEED = Number(value('--seed', 7));
if (shots) fs.mkdirSync(outDir, { recursive: true });
const results = [];
const check = (ok, name, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`); };
const note = (name, detail = '') => console.log(`NOTE  ${name}${detail ? `\n      ${detail}` : ''}`);

const venv = [path.join(ROOT, '.venv', 'Scripts', 'python.exe'), path.join(ROOT, '.venv', 'bin', 'python')].find((p) => fs.existsSync(p));
const pythonOk = !!venv && spawnSync(venv, ['-c', 'import ezdxf, shapely, numpy, PIL']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-layout-rattle-'));
const userDir = path.join(tmp, 'user');
const { srv, browser, close } = await openBrowser({ server: { userDir, publicMode: true, python: pythonOk ? venv : false } });
// a second server like the one a person gets after a clone: no Python environment
const bare = await startServer({ port: 0, quiet: true, userDir: path.join(tmp, 'user-bare'), publicMode: true, python: false });

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

async function newPage(query = '', { base = srv.url, viewport = { width: 1600, height: 1000 } } = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`${base}/?nolive=1&orbit=0&quality=low&${query}`);
  await page.waitForFunction(() => window.__atlas, null, { timeout: 120_000 });
  return { page, errors };
}
async function openPanel(page) {
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* none */ } });
  await page.click('#layout-open');
  await page.waitForFunction(() => window.__layoutSetup?.state.loaded, null, { timeout: 60_000 });
}
const shot = async (page, name) => { if (!shots) return; await page.screenshot({ path: path.join(outDir, `${name}.png`) }); };
const at = (page, x, y) => page.evaluate(([px, py]) => window.__layoutSetup.toScreen(px, py), [x, y]);
async function click(page, x, y) { const p = await at(page, x, y); await page.mouse.click(p.x, p.y); }
async function drag(page, a, b) {
  const p = await at(page, a[0], a[1]), q = await at(page, b[0], b[1]);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 5 }); await page.mouse.up();
}
const tool = (page, id) => page.click(`#layout-setup [data-tool="${id}"]`);
const draft = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.__layoutSetup.state.draft)));
const preview = (page) => page.evaluate(() => ({ errors: window.__layoutSetup.state.preview.errors, warnings: window.__layoutSetup.state.preview.warnings }));
const alive = (page) => Promise.race([page.evaluate(() => !!window.__layoutSetup && typeof window.__layoutSetup.state === 'object'), new Promise((r) => setTimeout(() => r(false), 10_000))]);
const rooms = (d, i = 0) => d.levels[i]?.rooms.length ?? -1;

try {
  // ---------------------------------------------------------------- odd shapes
  {
    const { page, errors } = await newPage('demo=1');
    await openPanel(page);
    await tool(page, 'rect');
    await drag(page, [2, 2], [2, 2]);
    await drag(page, [3, 3], [3.02, 3.01]);
    let d = await draft(page);
    check(rooms(d) === 0 || (await preview(page)).errors.length > 0, 'a zero-size or hair-thin room is not taken as a valid room', `${rooms(d)} rooms, errors: ${(await preview(page)).errors.join(' | ')}`);
    await page.click('#layout-setup [data-act="new"]').catch(() => {});
    await page.waitForTimeout(100);

    await tool(page, 'poly');
    for (const p of [[0, 0], [6, 6], [6, 0], [0, 6]]) await click(page, p[0], p[1]);   // a bow tie
    await page.keyboard.press('Enter');
    d = await draft(page);
    const bow = await preview(page);
    check(rooms(d) === 0 || bow.errors.length > 0 || bow.warnings.length > 0, 'a self-crossing room (bow tie) is refused or flagged', `${rooms(d)} rooms; ${[...bow.errors, ...bow.warnings].join(' | ') || 'nothing said'}`);
    await shot(page, 'odd-1-bowtie');

    await page.keyboard.press('Control+z');
    await tool(page, 'rect');
    await drag(page, [0, 0], [6, 5]);
    await drag(page, [3, 2], [9, 7]);   // overlaps the first
    const ov = await preview(page);
    check(ov.errors.length > 0 || ov.warnings.length > 0, 'two overlapping rooms are flagged', [...ov.errors, ...ov.warnings].join(' | ') || 'nothing said');
    await shot(page, 'odd-2-overlap');

    // names that try to be HTML, a very long name, and other scripts
    await page.evaluate(() => { window.__rattled = false; });
    await tool(page, 'select');
    await click(page, 1, 1);
    await page.fill('#layout-setup [data-field="room-name"]', '<img src=x onerror="window.__rattled=true"><script>window.__rattled=true</script>');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await click(page, 8, 6);
    await page.fill('#layout-setup [data-field="room-name"]', 'Ж'.repeat(5000));
    await page.keyboard.press('Tab');
    await page.waitForTimeout(200);
    await click(page, 1, 1);
    await page.waitForTimeout(200);
    check(await page.evaluate(() => window.__rattled === false), 'a room name written as HTML is shown as text, not run');
    d = await draft(page);
    check(d.levels[0].rooms.some((r) => r.name.includes('<img')) && d.levels[0].rooms.every((r) => r.name.length <= 5000), 'odd names are kept as typed (or cut), the draft stays valid JSON', d.levels[0].rooms.map((r) => `${r.name.length} chars`).join(', '));
    await page.fill('#layout-setup [data-field="room-name"]', 'غرفة المعيشة 🛋️ 居間');
    await page.keyboard.press('Tab');
    await shot(page, 'odd-3-names');

    // undo and redo far past the ends
    for (let i = 0; i < 120; i++) await page.keyboard.press('Control+z');
    const bottom = await draft(page);
    for (let i = 0; i < 120; i++) await page.keyboard.press('Control+y');
    check(await alive(page) && rooms(bottom) >= 0, 'undo and redo pressed 120 times past either end do nothing bad', `${rooms(bottom)} rooms at the bottom, ${rooms(await draft(page))} after redo`);

    // delete every floor
    for (let i = 0; i < 6; i++) { await page.click('#layout-setup [data-act="level-delete"]').catch(() => {}); await page.waitForTimeout(60); }
    d = await draft(page);
    check(d.levels.length >= 1, 'deleting floors again and again leaves at least one floor', `${d.levels.length} floor(s) left`);

    // open and close the panel quickly
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Escape');
      await page.click('#layout-open').catch(() => {});
    }
    await page.waitForTimeout(300);
    check(await alive(page), 'opening and closing the panel 15 times in a row leaves the page working');
    check(errors.length === 0, 'odd shapes, odd names and key spam log no error', errors.slice(0, 5).join(' | '));
    await page.close();
  }

  // ---------------------------------------------------------------- a huge picture and a picture that is not one
  {
    const maker = await browser.newPage();
    await maker.setContent('<canvas id="c" width="8000" height="6000"></canvas>');
    const big = path.join(tmp, 'huge.png');
    const data = await maker.evaluate(() => { const c = document.getElementById('c'), g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 8000, 6000); g.lineWidth = 20; g.strokeRect(500, 500, 7000, 5000); return c.toDataURL('image/png'); });
    fs.writeFileSync(big, Buffer.from(data.split(',')[1], 'base64'));
    await maker.close();
    const fake = path.join(tmp, 'not-a-picture.png');
    fs.writeFileSync(fake, 'this is text with a png name');

    const { page, errors } = await newPage('demo=1');
    await openPanel(page);
    const t0 = Date.now();
    let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#layout-setup .ls-start [data-act="img-load"]')]);
    await chooser.setFiles(big);
    await page.waitForFunction(() => window.__layoutSetup.state.draft.levels[0].underlay || window.__layoutSetup.state.note, null, { timeout: 60_000 }).catch(() => {});
    const u = (await draft(page)).levels[0].underlay;
    const ms = Date.now() - t0;
    check(await alive(page) && ms < 30_000, 'an 8000 x 6000 px plan picture loads (or is refused) without hanging the page', u ? `loaded as ${u.w} x ${u.h} px in ${ms} ms` : `refused: ${await page.evaluate(() => window.__layoutSetup.state.note)}`);
    await shot(page, 'image-1-huge');
    const before = JSON.stringify((await draft(page)).levels[0].underlay || null);
    [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#layout-setup [data-act="img-load"]').catch(() => page.click('#layout-setup .ls-start [data-act="img-load"]'))]);
    await chooser.setFiles(fake);
    await page.waitForTimeout(1500);
    const msg = await page.evaluate(() => window.__layoutSetup.state.note || document.querySelector('#layout-setup .ls-status')?.textContent || '');
    check(await alive(page) && JSON.stringify((await draft(page)).levels[0].underlay || null) === before, 'a text file named .png is refused and the picture already loaded stays', msg);
    check(errors.filter((e) => !/Failed to load resource|decode|EncodingError/i.test(e)).length === 0, 'pictures log no error beyond the refused file', errors.slice(0, 5).join(' | '));
    await page.close();
  }

  // ---------------------------------------------------------------- broken scan exports
  if (pythonOk) {
    const junk = path.join(tmp, 'junk');
    fs.mkdirSync(junk, { recursive: true });
    fs.writeFileSync(path.join(junk, 'floorplan.dxf'), Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)));
    fs.writeFileSync(path.join(junk, 'floorplan.csv'), 'not,a,polycam\ncsv');
    fs.writeFileSync(path.join(junk, 'model.glb'), 'glTF but not really');
    const { page, errors } = await newPage('demo=1');
    await openPanel(page);
    await page.click('#layout-setup [data-act="scan-toggle"]');
    await page.waitForSelector('#layout-setup [data-act="scan-files"]', { timeout: 60_000 });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#layout-setup [data-act="scan-files"][data-i="0"]')]);
    await chooser.setFiles(['floorplan.dxf', 'floorplan.csv', 'model.glb'].map((n) => path.join(junk, n)));
    const roomsBefore = rooms(await draft(page));
    await page.click('#layout-setup [data-act="scan-import"]');
    await page.waitForFunction(() => !window.__layoutSetup.state.scan.busy, null, { timeout: 240_000 });
    const said = await page.evaluate(() => window.__layoutSetup.state.note || window.__layoutSetup.state.scan.error || '');
    check(await alive(page) && rooms(await draft(page)) === roomsBefore && said.length > 0, 'garbage scan files are refused with a reason and the draft stays', said.slice(0, 200));
    await shot(page, 'scan-1-garbage');
    check(errors.filter((e) => !/Failed to load resource|status of 4\d\d/i.test(e)).length === 0, 'a refused scan logs no script error', errors.slice(0, 5).join(' | '));
    await page.close();
  } else note('broken scan exports skipped: no .venv with ezdxf, shapely, numpy, pillow');

  {
    const { page, errors } = await newPage('demo=1', { base: bare.url });
    await openPanel(page);
    await page.click('#layout-setup [data-act="scan-toggle"]');
    await page.waitForTimeout(1500);
    const text = await page.evaluate(() => document.getElementById('layout-setup').innerText);
    check(/python|venv|pip/i.test(text), 'without a Python environment the scan section says what to install instead of failing', (text.match(/[^\n]*(python|venv|pip)[^\n]*/i) || ['nothing said'])[0].slice(0, 200));
    await shot(page, 'scan-2-no-python');
    check(errors.filter((e) => !/Failed to load resource|status of 4\d\d|status of 5\d\d/i.test(e)).length === 0, 'the scan section without Python logs no script error', errors.slice(0, 5).join(' | '));
    await page.close();
  }

  // ---------------------------------------------------------------- reload in the middle of drawing
  {
    const { page } = await newPage('demo=1');
    await openPanel(page);
    await tool(page, 'rect');
    await drag(page, [0, 0], [5, 4]);
    await drag(page, [5, 0], [9, 4]);
    await page.waitForTimeout(800);
    await page.reload();
    await page.waitForFunction(() => window.__atlas, null, { timeout: 120_000 });
    await page.click('#layout-open');
    await page.waitForFunction(() => window.__layoutSetup?.state.loaded, null, { timeout: 60_000 });
    const n = rooms(await draft(page));
    if (n === 2) check(true, 'a reload before Apply keeps the unsaved drawing');
    else note('a reload before Apply loses the unsaved drawing', `${n} rooms after the reload (2 were drawn); say so in the panel or keep a draft`);
    await page.close();
  }

  // ---------------------------------------------------------------- phone-sized window
  {
    const { page, errors } = await newPage('demo=1', { viewport: { width: 390, height: 844 } });
    const btn = await page.evaluate(() => { const r = document.getElementById('layout-open').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) }; });
    check(btn.x >= 0 && btn.x + btn.w <= 390 && btn.y >= 0 && btn.y < 844, 'on a phone-sized window the Layout button can be reached', `button at x ${btn.x}, y ${btn.y}`);
    await page.evaluate(() => { try { localStorage.clear(); } catch { /* none */ } });
    await page.keyboard.press('l');
    await page.waitForFunction(() => window.__layoutSetup?.state.loaded, null, { timeout: 60_000 });
    const box = await page.evaluate(() => { const c = document.querySelector('#layout-setup canvas').getBoundingClientRect(); return { w: Math.round(c.width), h: Math.round(c.height), scroll: document.documentElement.scrollWidth > window.innerWidth + 1 }; });
    check(box.w > 150 && box.h > 150, 'on a phone-sized window the editor canvas is still usable', `${box.w} x ${box.h} px${box.scroll ? ', the page scrolls sideways' : ''}`);
    if (box.scroll) note('the page scrolls sideways on a 390 px window');
    await tool(page, 'rect').catch(() => {});
    await drag(page, [0, 0], [4, 3]).catch(() => {});
    await shot(page, 'phone-1-editor');
    check(errors.length === 0, 'the phone-sized panel logs no error', errors.slice(0, 5).join(' | '));
    await page.close();
  }

  // ---------------------------------------------------------------- the monkey
  {
    const { page, errors } = await newPage('demo=1');
    await openPanel(page);
    const rnd = mulberry32(SEED);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const pt = () => [Math.round((rnd() * 16 - 2) * 4) / 4, Math.round((rnd() * 12 - 2) * 4) / 4];
    const tools = ['select', 'rect', 'poly', 'wall', 'door', 'window', 'opening', 'stairs', 'erase'];
    const counts = {};
    for (let i = 0; i < STEPS; i++) {
      const r = rnd();
      let act;
      try {
        if (r < 0.15) { act = 'tool'; await tool(page, pick(tools)); }
        else if (r < 0.45) { act = 'click'; const p = pt(); await click(page, p[0], p[1]); }
        else if (r < 0.65) { act = 'drag'; await drag(page, pt(), pt()); }
        else if (r < 0.72) { act = 'key'; await page.keyboard.press(pick(['Enter', 'Escape', 'Delete', 'Backspace', 'Shift', 'r', 'c', 'w', 'd', 'v'])); }
        else if (r < 0.80) { act = 'undo'; await page.keyboard.press(pick(['Control+z', 'Control+y'])); }
        else if (r < 0.85) { act = 'level'; await page.click(`#layout-setup [data-act="${pick(['level-above', 'level-below', 'level-delete'])}"]`, { timeout: 500 }); }
        else if (r < 0.90) { act = 'switch'; await page.click('#layout-setup [data-act="level"]', { timeout: 500 }); }
        else if (r < 0.95) { act = 'wheel'; await page.mouse.wheel(0, (rnd() - 0.5) * 600); }
        else { act = 'name'; await page.fill('#layout-setup [data-field="room-name"]', `Room ${i}`, { timeout: 300 }); await page.keyboard.press('Tab'); }
      } catch { act = `${act} (not there)`; }
      counts[act] = (counts[act] || 0) + 1;
      if (i % 100 === 99 && !(await alive(page))) break;
    }
    const ok = await alive(page);
    const d = ok ? await draft(page) : null;
    const pv = ok ? await preview(page) : { errors: ['page dead'], warnings: [] };
    check(ok && d.levels.length >= 1, `${STEPS} random actions (seed ${SEED}) leave the panel working with a readable draft`, d ? `${d.levels.length} floors, ${d.levels.reduce((s, l) => s + l.rooms.length, 0)} rooms; ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}` : '');
    await page.click('#layout-setup [data-act="fit"]').catch(() => {});
    await shot(page, 'monkey-1-result');
    check(errors.length === 0, 'the random actions log no error', errors.slice(0, 5).join(' | '));
    if (ok && pv.errors.length === 0 && d.levels.some((l) => l.rooms.length)) {
      await Promise.all([page.waitForNavigation({ timeout: 60_000 }), page.click('#layout-setup .ls-bar [data-act="apply"]')]);
      await page.waitForFunction(() => window.__atlas, null, { timeout: 120_000 });
      await page.waitForTimeout(1500);
      const ready = await page.evaluate(() => ({ ready: window.__atlas.ready, error: window.__atlas.error || '' }));
      check(ready.ready, 'whatever the monkey drew, once the panel calls it valid, it applies and the atlas comes up', ready.error);
      await shot(page, 'monkey-2-atlas');
    } else {
      const disabled = ok && await page.evaluate(() => document.querySelector('#layout-setup .ls-bar [data-act="apply"]')?.disabled === true);
      check(!ok || disabled || pv.errors.length > 0, 'a draft the panel calls invalid cannot be applied', pv.errors.slice(0, 3).join(' | '));
    }
    await page.close();
  }
} finally {
  await close();
  await bare.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
