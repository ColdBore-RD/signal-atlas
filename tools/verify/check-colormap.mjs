#!/usr/bin/env node
// Checks the colour scales of every preset theme with numbers instead of by eye.
//
//   node tools/verify/check-colormap.mjs [theme-id]
//
// The checks themselves are in src/core/colorcheck.js (the page uses the same code
// to warn about a custom palette). This tool runs them for each preset in
// src/core/colormaps.js and adds the checks of the fixed interface colours.
// Exit code 1 when a check fails.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, THEME_ORDER, themeRamps, bandColors, hexToRgb, customTheme } from '../../src/core/colormaps.js';
import { checkTheme, contrast } from '../../src/core/colorcheck.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const grades = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/grades.json'), 'utf8'));
const only = process.argv[2];
if (only && !THEMES[only]) { console.error(`Unknown theme "${only}". Themes: ${THEME_ORDER.join(', ')}`); process.exit(1); }

let failed = 0;
const say = (ok, text) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`); if (!ok) failed++; };

for (const id of THEME_ORDER) {
  if (only && only !== id) continue;
  const theme = THEMES[id];
  console.log(`\n${theme.label} (${id})`);
  for (const r of checkTheme(theme, grades)) say(r.ok, r.text);
  const bands = bandColors(grades, themeRamps(theme).signal);
  console.log('      band colours: ' + grades.bands.map((b) => `${b.id} ${bands[b.id]}`).join(', '));
}

if (!only) {
  console.log('\nFixed interface colours');
  const panel = hexToRgb('#0a0e15');
  for (const [name, hex] of [['body text', '#e6edf7'], ['secondary text', '#a9b6c9'], ['small labels', '#718096'], ['warning amber', '#ffc876']]) {
    const c = contrast(hexToRgb(hex), panel);
    say(c >= 4.5, `${name} ${hex}: contrast ${c.toFixed(1)}:1 on the panel background (limit 4.5:1)`);
  }
  console.log('\nThe start colours of the custom theme');
  for (const r of checkTheme(customTheme(), grades)) say(r.ok, r.text);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall colour checks passed');
process.exit(failed ? 1 : 0);
