// Readability checks for a colour theme, with numbers instead of by eye.
//
// Signal scale: (1) lightness rises all the way, in nearly equal steps, so equal
// dB steps look equal; (2) the order holds for the three common kinds of colour
// blindness; (3) the five signal bands stay apart for every kind of colour vision;
// (4) text in signal colours has enough contrast on the dark panels (WCAG 4.5:1).
// Wave scale: crest and trough stay apart for every kind of colour vision, and
// zero is near black. Accent: enough contrast on the panel for controls (3:1).
//
// Colour difference is measured in OKLab (a difference of 0.02 is just visible).
// Colour blindness is simulated with the matrices of Machado, Oliveira and
// Fernandes (2009). Pure functions: the page uses them to warn about a custom
// palette, and tools/verify/check-colormap.mjs uses them for every preset.

import { themeRamps, srgbToOklab, bandColors, hexToRgb, dbmToT } from './colormaps.js';

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export const CVD = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

export function simulate(rgb, m) {
  const lin = rgb.map(toLinear);
  return m.map((row) => clamp01(toSrgb(clamp01(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]))));
}
export function deltaE(a, b) {
  const p = srgbToOklab(a), q = srgbToOklab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
export function luminance(rgb) { const [r, g, b] = rgb.map(toLinear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
export function contrast(a, b) { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); }

/**
 * Check one theme. Returns [{ ok, text }], one entry per check, in plain words.
 * grades is data/grades.json (the signal bands). panel is the panel background.
 */
export function checkTheme(theme, grades, panel = '#0a0e15') {
  const out = [];
  const check = (ok, text) => out.push({ ok: !!ok, text });
  const ramps = themeRamps(theme);
  const N = 64;

  const L = Array.from({ length: N + 1 }, (_, i) => srgbToOklab(ramps.signal(i / N))[0]);
  const steps = L.slice(1).map((v, i) => v - L[i]);
  check(steps.every((d) => d > 0), `signal scale: lightness rises at every one of ${N} steps (from ${L[0].toFixed(2)} to ${L[N].toFixed(2)})`);
  const mean = (L[N] - L[0]) / N;
  const worst = mean > 0 ? Math.max(...steps.map((d) => Math.abs(d - mean) / mean)) : Infinity;
  check(worst < 0.25, `signal scale: lightness steps are even (largest deviation from the mean step ${Number.isFinite(worst) ? (worst * 100).toFixed(0) : 'more than 999'} %, limit 25 %)`);
  for (const [name, m] of Object.entries(CVD)) {
    if (name === 'normal') continue;
    const Ls = Array.from({ length: N + 1 }, (_, i) => srgbToOklab(simulate(ramps.signal(i / N), m))[0]);
    check(Ls.slice(1).every((v, i) => v > Ls[i]), `signal scale: still ordered from dark to light with ${name} vision`);
  }

  const bands = bandColors(grades, ramps.signal);
  const ids = grades.bands.map((b) => b.id);
  for (const [name, m] of Object.entries(CVD)) {
    let min = Infinity, pair = '';
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const d = deltaE(simulate(hexToRgb(bands[ids[i]]), m), simulate(hexToRgb(bands[ids[j]]), m));
      if (d < min) { min = d; pair = `${ids[i]} / ${ids[j]}`; }
    }
    check(min > 0.08, `signal bands: closest pair with ${name} vision is ${pair}, difference ${min.toFixed(3)} (limit 0.08)`);
  }

  const bg = hexToRgb(panel);
  let minContrast = Infinity;
  for (let i = 0; i <= 20; i++) minContrast = Math.min(minContrast, contrast(ramps.signalText(i / 20), bg));
  for (const band of grades.bands) minContrast = Math.min(minContrast, contrast(ramps.signalText(dbmToT(band.min_dbm, grades.display_range_dbm)), bg));
  check(minContrast >= 4.5, `text in signal colours: lowest contrast on the panel background is ${minContrast.toFixed(1)}:1 (limit 4.5:1)`);

  for (const [name, m] of Object.entries(CVD)) {
    const d = Math.min(...[0.3, 0.6, 0.9].map((a) => deltaE(simulate(ramps.wave(a), m), simulate(ramps.wave(-a), m))));
    check(d > 0.1, `wave scale: crest and trough differ by at least ${d.toFixed(3)} with ${name} vision (limit 0.1)`);
  }
  check(luminance(ramps.wave(0)) < 0.02, `wave scale: zero is near black (relative luminance ${luminance(ramps.wave(0)).toFixed(4)})`);

  const accent = hexToRgb(theme.accent);
  const ac = accent ? contrast(accent, bg) : 0;
  check(ac >= 3, `accent colour ${theme.accent}: contrast ${ac.toFixed(1)}:1 on the panel background (limit 3:1 for controls)`);
  return out;
}
