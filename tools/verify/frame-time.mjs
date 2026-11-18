#!/usr/bin/env node
// Measures frame time in headless Chromium.
//
//   node tools/verify/frame-time.mjs [--seconds 8] [--size 1920x1080] [--quality auto|low|medium|high|ultra]
//                                    [--query "waves=flow&layer=waves"] [--uncapped]
//
// --uncapped switches the display sync of the browser off, so the number shows how much
// time a frame really needs (the headroom), not the refresh rate of the screen.
//
// It reports the time between frames (median and 95th percentile), the time the
// page's own script uses per frame, the wave grid in use, and the renderer.
// IMPORTANT: headless Chromium in a container draws with a software renderer
// (SwiftShader). That number says nothing about a laptop GPU. The script time per
// frame and the renderer name are printed so the reader can judge. For the real
// number, press F in the page on the target laptop.
import { openBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const seconds = Number(value('--seconds', 8));
const [w, h] = value('--size', '1920x1080').split('x').map(Number);
const quality = value('--quality', 'auto');
const extra = value('--query', '');

const uncapped = args.includes('--uncapped');
const { srv, browser, close } = await openBrowser(uncapped ? { launch: { args: ['--no-sandbox', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] } } : {});
try {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${srv.url}/?nolive=1&quality=${quality}&${extra}`);
  await page.waitForFunction(() => window.__atlas && window.__atlas.ready, null, { timeout: 120_000 });
  await page.waitForTimeout(6000); // let automatic quality settle
  const result = await page.evaluate(async (ms) => {
    const a = window.__atlas;
    const deltas = [];
    await new Promise((resolve) => {
      let last = 0, start = 0;
      const tick = (now) => {
        if (last) deltas.push(now - last); else start = now;
        last = now;
        if (now - start < ms) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
    deltas.sort((x, y) => x - y);
    const q = (p) => deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))];
    return {
      frames: deltas.length, median: q(0.5), p95: q(0.95), best: deltas[0], scriptMs: a.perf.jsMs, waveStepMs: a.perf.simMs,
      quality: a.perf.quality, grid: a.spec ? `${a.spec.nx} x ${a.spec.ny} cells x ${a.spec.levels} floors` : 'waves off',
      pixelRatio: a.scene.renderer.getPixelRatio(), renderer: a.perf.renderer, software: a.perf.software, qualitySetting: a.state.quality,
    };
  }, seconds * 1000);
  console.log(`Frame time at ${w}x${h}${uncapped ? ' (display sync off)' : ''}, quality setting "${result.qualitySetting}" (grid in use: ${result.quality}, ${result.grid}, pixel ratio ${result.pixelRatio})`);
  console.log(`  renderer: ${result.renderer}`);
  console.log(`  ${result.frames} frames in ${seconds} s: median ${result.median.toFixed(1)} ms (${(1000 / result.median).toFixed(1)} fps), 95th percentile ${result.p95.toFixed(1)} ms, best ${result.best.toFixed(1)} ms`);
  console.log(`  page script per frame: ${result.scriptMs.toFixed(2)} ms (of which wave-step calls ${result.waveStepMs.toFixed(2)} ms). The rest of the frame is drawing.`);
  if (result.software) console.log('  This is a SOFTWARE renderer: the CPU draws every pixel. It does not show what a GPU does.');
  console.log(result.median <= 17.5 ? '  60 fps: reached' : '  60 fps: NOT reached in this environment');
} finally {
  await close();
}
