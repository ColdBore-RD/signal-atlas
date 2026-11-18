// Shared helper for the verification tools: start the dev server on a free port
// and open headless Chromium with Playwright.
import { createRequire } from 'node:module';
import { startServer } from '../serve.mjs';

export function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const candidate of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { return require(candidate); } catch { /* try the next place */ }
  }
  throw new Error('Playwright is not installed. Install it with: npm install --no-save playwright');
}

export async function openBrowser({ server = {}, launch = {} } = {}) {
  const srv = await startServer({ port: 0, quiet: true, ...server });
  const { chromium } = loadPlaywright();
  const args = ['--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  // Playwright's own Chromium may not be downloaded on this machine. The installed Chrome or
  // Edge does the same job, so try those before giving up. ATLAS_BROWSER=chrome|msedge picks one.
  const wanted = process.env.ATLAS_BROWSER;
  const fs = await import('node:fs');
  const bundled = !wanted && fs.existsSync(chromium.executablePath());
  const channels = wanted ? [wanted] : bundled ? [undefined] : ['chrome', 'msedge'];
  let browser = null, lastError = null;
  for (const channel of channels) {
    try { browser = await chromium.launch({ args, ...(channel ? { channel } : {}), ...launch }); break; } catch (e) { lastError = e; }
  }
  if (!browser) throw new Error(`No browser could be started (${lastError?.message.split('\n')[0]}). Run: npx playwright install chromium`);
  return { srv, browser, close: async () => { await browser.close(); await srv.close(); } };
}
