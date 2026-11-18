#!/usr/bin/env node
// Runs the wave-solver tests (tests/solver/solver-tests.js) in headless Chromium.
//   node tools/verify/solver-tests.mjs
import { openBrowser } from './browser.mjs';

const { srv, browser, close } = await openBrowser();
let failed = 1;
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`${srv.url}/tests/solver/index.html`);
  await page.waitForFunction(() => window.__results, null, { timeout: 600_000 });
  const results = await page.evaluate(() => window.__results);
  if (results.fatal) throw new Error(results.fatal);
  console.log(`Wave solver tests. Renderer: ${results.env.renderer}. ${results.env.precision}. Courant number ${results.env.courant}.`);
  for (const t of results.tests) console.log(`${t.pass ? 'PASS' : 'FAIL'}  ${t.name}  (${t.ms} ms)\n      ${t.detail}`);
  console.log(`${results.passed} passed, ${results.failed} failed`);
  failed = results.failed;
} catch (e) {
  console.error('solver tests could not run:', e.message);
} finally {
  await close();
}
process.exit(failed ? 1 : 0);
