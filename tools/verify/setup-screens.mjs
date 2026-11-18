#!/usr/bin/env node
// Pictures of the Setup panel at 1920x1080, for a person to look at: the panel open, a device
// added and waiting for its place, the device placed, the device removed. Once in normal mode
// and once in privacy mode.
//
//   node tools/verify/setup-screens.mjs [--out tmp/screens/setup] [--settle 3500]
//
// The setup is saved to a temporary folder, never to data/user/. With a private configuration
// the normal-mode pictures show private names: keep them out of git (tmp/ is ignored).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const outDir = path.resolve(value('--out', 'tmp/screens/setup'));
const settle = Number(value('--settle', 3500));
fs.mkdirSync(outDir, { recursive: true });

let failed = 0;
for (const mode of ['normal', 'privacy']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-setup-screens-'));
  // surveyDir too: on the owner's house the setup would otherwise go to data/private/
  const { srv, browser, close } = await openBrowser({ server: { userDir: dir, surveyDir: dir } });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const shot = async (name) => { await page.waitForTimeout(settle); const file = path.join(outDir, `${mode}-${name}.png`); await page.screenshot({ path: file }); console.log(path.relative(process.cwd(), file)); };
    await page.goto(`${srv.url}/?nolive=1&orbit=0&quality=high&setup=1${mode === 'privacy' ? '&privacy=1' : ''}`);
    await page.waitForFunction(() => window.__atlas && window.__atlas.ready, null, { timeout: 120_000 });
    await page.click('#setup .dev-head');            // open the editor of the first device
    await shot('1-open');
    await page.click('#setup [data-act="add-dev"]'); // a new access point; it waits for a click on the plan
    await shot('2-added-waiting');
    const target = await page.evaluate(async () => {
      const { interiorPoint, polygonArea } = await import('/src/core/geometry.js');
      const a = window.__atlas, li = a.scene.levelIndex(a.state.level);
      const room = [...a.scene.levels[li].rooms].sort((p, q) => polygonArea(q.polygon) - polygonArea(p.polygon))[1];
      const [x, y] = interiorPoint(room.polygon, 0.3);
      const v = a.scene.worldOf(li, x, y, 1.0).project(a.scene.camera);
      const r = document.getElementById('stage').getBoundingClientRect();
      return { sx: r.left + (v.x * 0.5 + 0.5) * r.width, sy: r.top + (-v.y * 0.5 + 0.5) * r.height };
    });
    await page.mouse.click(target.sx, target.sy);
    await shot('3-placed');
    await page.click('#setup .dev.is-open [data-act="remove-dev"]');
    await shot('4-removed');
    if (errors.length) { failed++; console.log(`   page errors (${mode}): ${errors.slice(0, 4).join(' | ')}`); }
    await page.close();
  } finally {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
