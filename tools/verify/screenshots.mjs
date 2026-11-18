#!/usr/bin/env node
// Takes screenshots of the page in headless Chromium, for a person to look at.
//
//   node tools/verify/screenshots.mjs [--out tmp/screens] [--only <name-part>] [--settle 6000]
//
// It makes normal and privacy-mode pictures at 1920x1080 and 2560x1440, plus a
// few more views at 1920x1080. With a private floor plan the normal-mode pictures
// show private names: keep them out of git (tmp/ is ignored).
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const outDir = path.resolve(value('--out', 'tmp/screens'));
const only = value('--only', '');
const settle = Number(value('--settle', 6000));
// Headless Chromium draws with a software renderer, where automatic quality would pick the lowest grid.
// The pictures use the grid that a laptop GPU gets.
const quality = value('--quality', 'high');
fs.mkdirSync(outDir, { recursive: true });

const shots = [
  { name: '1080-normal-3d', w: 1920, h: 1080, query: 'orbit=0' },
  { name: '1080-privacy-3d', w: 1920, h: 1080, query: 'orbit=0&privacy=1' },
  { name: '1440-normal-3d', w: 2560, h: 1440, query: 'orbit=0' },
  { name: '1440-privacy-3d', w: 2560, h: 1440, query: 'orbit=0&privacy=1' },
  { name: '1080-privacy-plan-waves', w: 1920, h: 1080, query: 'privacy=1&view=plan&level=1&layer=waves' },
  { name: '1080-privacy-plan-contours-5ghz', w: 1920, h: 1080, query: 'privacy=1&view=plan&layer=contours&band=5' },
  { name: '1080-privacy-plan-envelope-all', w: 1920, h: 1080, query: 'privacy=1&view=plan&layer=envelope&band=5' },
  { name: '1080-privacy-3d-waves-node', w: 1920, h: 1080, query: 'orbit=0&privacy=1&layer=waves&t=0.55', select: true },
  { name: '1440-privacy-plan-fused', w: 2560, h: 1440, query: 'privacy=1&view=plan&level=1&layer=fused' },
].filter((s) => !only || s.name.includes(only));
// --shot "name|query" (repeatable) adds a 1920x1080 picture of any view; with it, only those are taken unless --only is given too
const extra = args.flatMap((a, i) => (a === '--shot' && args[i + 1] ? [args[i + 1]] : []));
if (extra.length) {
  if (!only) shots.length = 0;
  for (const e of extra) { const [name, query = ''] = e.split('|'); shots.push({ name, w: 1920, h: 1080, query }); }
}

const { srv, browser, close } = await openBrowser();
let failed = 0;
try {
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${srv.url}/?nolive=1&quality=${quality}&${shot.query}`);
    await page.waitForFunction(() => window.__atlas, null, { timeout: 120_000 });
    const ready = await page.evaluate(() => window.__atlas.ready);
    if (shot.select && ready) await page.evaluate(() => { const a = window.__atlas; const n = a.model.nodes.find((x) => x.type === 'pi') || a.model.nodes[0]; a.selectNode(n.id); });
    await page.waitForTimeout(settle);
    const file = path.join(outDir, `${shot.name}.png`);
    await page.screenshot({ path: file });
    const info = ready ? await page.evaluate(() => ({ q: window.__atlas.perf.quality, ema: window.__atlas.perf.ema, waves: !!window.__atlas.solver })) : { error: await page.evaluate(() => window.__atlas.error) };
    console.log(`${shot.name}: ${path.relative(process.cwd(), file)}  ${JSON.stringify(info)}${errors.length ? `\n   page errors: ${errors.slice(0, 4).join(' | ')}` : ''}`);
    if (errors.length || !ready) failed++;
    await page.close();
  }
} finally {
  await close();
}
process.exit(failed ? 1 : 0);
