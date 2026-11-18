// The colour scales of the display, defined once, as themes.
//
// A theme holds:
// 1. Signal scale: sequential, for signal strength in dBm. The presets are built
//    in the OKLCH colour space with lightness rising in equal steps, so equal dB
//    steps look like equal steps, and the order survives colour blindness because
//    lightness alone carries it.
// 2. Wave scale: diverging, for the signed wave field. Trough and crest have
//    different hues and zero stays near black.
// 3. The accent colour of the interface and the colour of the flow arrows.
//
// One theme is active at a time. signalRamp(), waveRamp() and the other helpers
// read the active theme, so every layer, the legend and the panels follow it.
// src/core/colorcheck.js tests a theme for readability; tools/verify/check-colormap.mjs
// runs that test for every preset.
//
// Pure functions: browser and Node.

function oklabToLinear(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const decode = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** OKLCH to sRGB (0..1 each). Chroma is reduced until the colour fits in sRGB. */
export function oklchToSrgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  for (let i = 0; i < 24; i++) {
    const rgb = oklabToLinear(L, C * Math.cos(h), C * Math.sin(h));
    if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) return rgb.map((v) => clamp01(encode(clamp01(v))));
    C *= 0.93;
  }
  return oklabToLinear(L, 0, 0).map((v) => clamp01(encode(clamp01(v))));
}

/** sRGB (0..1 each) to OKLab [L, a, b]. */
export function srgbToOklab([r, g, b]) {
  const [lr, lg, lb] = [r, g, b].map(decode);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** sRGB (0..1 each) to OKLCH { L, C, h } with h in degrees. */
export function srgbToOklch(rgb) {
  const [L, a, b] = srgbToOklab(rgb);
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
}

export function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return /^[0-9a-f]{6}$/i.test(full) ? [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) : null;
}

const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Colour of a list of stops at position t. A stop is { t, L, C, h } (the hue is
 * interpolated, which keeps the colour vivid between stops) or { t, L, a, b }
 * (interpolated in OKLab: the straight line between two picked colours).
 */
function pick(stops, t) {
  t = clamp01(t);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].t) {
      const p = stops[i - 1], q = stops[i];
      const f = (t - p.t) / (q.t - p.t);
      if (p.a !== undefined) {
        const a = lerp(p.a, q.a, f), b = lerp(p.b, q.b, f);
        return [lerp(p.L, q.L, f), Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
      }
      return [lerp(p.L, q.L, f), lerp(p.C, q.C, f), lerp(p.h, q.h, f)];
    }
  }
  const s = stops[stops.length - 1];
  return s.a !== undefined ? [s.L, Math.hypot(s.a, s.b), ((Math.atan2(s.b, s.a) * 180) / Math.PI + 360) % 360] : [s.L, s.C, s.h];
}

// ---------------------------------------------------------------- themes
// In every preset the lightness of the signal scale is linear in t from 0.20 to 0.94.
const evenLightness = (rows) => rows.map(([C, h], i) => ({ t: i / (rows.length - 1), L: 0.2 + (0.74 * i) / (rows.length - 1), C, h }));

export const THEMES = {
  mission: {
    id: 'mission', label: 'Mission control', accent: '#9fd8ff', arrow: '#fff4dc',
    about: 'The original look: violet to blue to teal to green to yellow; blue troughs, amber crests.',
    signal: evenLightness([[0.07, 300], [0.125, 268], [0.11, 212], [0.135, 158], [0.13, 104]]),
    wave: { trough: { h: [262, 225], C: 0.2, L: 0.97 }, crest: { h: [48, 88], C: 0.2, L: 0.97 } },
  },
  aurora: {
    id: 'aurora', label: 'Aurora', accent: '#9df5c8', arrow: '#f2fff8',
    about: 'Night-sky greens: deep indigo to teal to green to pale mint; violet troughs, green crests.',
    signal: evenLightness([[0.08, 292], [0.12, 262], [0.12, 205], [0.15, 165], [0.13, 135]]),
    wave: { trough: { h: [305, 325], C: 0.2, L: 0.8 }, crest: { h: [165, 140], C: 0.19, L: 0.97 } },
  },
  heat: {
    id: 'heat', label: 'Heat', accent: '#ffb38a', arrow: '#ffffff',
    about: 'Like a thermal camera: dark red to orange to yellow to near white; cyan troughs, red-orange crests.',
    signal: evenLightness([[0.07, 15], [0.15, 28], [0.17, 48], [0.16, 78], [0.09, 100]]),
    // the crest starts at orange, not red: a dim red crest looks as dark as a trough to a protanope
    wave: { trough: { h: [252, 228], C: 0.19, L: 0.78 }, crest: { h: [58, 90], C: 0.2, L: 0.97 } },
  },
  mono: {
    id: 'mono', label: 'Mono', accent: '#d6dde8', arrow: '#ffffff',
    about: 'Almost no colour: the signal scale is grey; troughs are dim steel, crests are bright and warm.',
    signal: evenLightness([[0.012, 255], [0.014, 255], [0.014, 250], [0.012, 240], [0.01, 100]]),
    wave: { trough: { h: [250, 245], C: 0.07, L: 0.62 }, crest: { h: [85, 95], C: 0.05, L: 0.98 } },
  },
  safe: {
    id: 'safe', label: 'Colour-blind safe', accent: '#ffd166', arrow: '#ffffff',
    about: 'Blue to grey to yellow, the pair that every common kind of colour blindness can tell apart; troughs are darker than crests as well.',
    signal: evenLightness([[0.1, 264], [0.085, 262], [0.03, 250], [0.085, 98], [0.15, 100]]),
    wave: { trough: { h: [258, 245], C: 0.17, L: 0.74 }, crest: { h: [70, 98], C: 0.17, L: 0.98 } },
  },
};
export const THEME_ORDER = ['mission', 'aurora', 'heat', 'mono', 'safe'];

/** The colours a person picks for a custom theme, as hex strings. */
export const CUSTOM_DEFAULT = { signalLow: '#2b1f5c', signalMid: '#2a8f9d', signalHigh: '#f3e96b', waveTrough: '#3aa0ff', waveCrest: '#ffb347', accent: '#9fd8ff' };

/**
 * A theme from picked colours. The signal scale goes through the three colours in
 * a straight line in OKLab, with the lightness as picked: a pick that does not get
 * lighter from weak to strong gives a scale that is hard to read, and
 * checkTheme() will say so. A wave colour gives the hue and strength of its side;
 * the brightness still follows the size of the wave, so zero stays dark.
 */
export function customTheme(picked = {}) {
  const c = { ...CUSTOM_DEFAULT, ...picked };
  const lab = (hex, t) => { const [L, a, b] = srgbToOklab(hexToRgb(hex) || [0.5, 0.5, 0.5]); return { t, L, a, b }; };
  const side = (hex, L) => { const o = srgbToOklch(hexToRgb(hex) || [0.5, 0.5, 0.5]); return { h: [o.h, o.h], C: Math.max(0.02, Math.min(0.22, o.C)), L }; };
  return {
    id: 'custom', label: 'Custom', accent: hexToRgb(c.accent) ? c.accent : CUSTOM_DEFAULT.accent, arrow: '#ffffff', picked: c,
    signal: [lab(c.signalLow, 0), lab(c.signalMid, 0.5), lab(c.signalHigh, 1)],
    wave: { trough: side(c.waveTrough, 0.9), crest: side(c.waveCrest, 0.97) },
  };
}

let active = THEMES.mission;
/** Make a theme the active one. Everything that calls signalRamp() or waveRamp() afterwards uses it. */
export function setActiveTheme(theme) { active = theme && theme.signal && theme.wave ? theme : THEMES.mission; return active; }
export function activeTheme() { return active; }

// ---------------------------------------------------------------- ramps
/** The three ramps of one theme, without touching the active theme. */
export function themeRamps(theme) {
  const signal = (t) => { const [L, C, h] = pick(theme.signal, t); return oklchToSrgb(L, C, h); };
  const signalText = (t) => { const [L, C, h] = pick(theme.signal, t); return oklchToSrgb(Math.max(0.74, L), Math.min(C, 0.12), h); };
  const wave = (v) => {
    const m = clamp01(Math.abs(v));
    const side = v < 0 ? theme.wave.trough : theme.wave.crest;
    const L = lerp(0.085, side.L ?? 0.97, m ** 1.2);
    const C = Math.min(0.04, side.C * 0.4) + side.C * Math.sin(Math.PI * Math.min(1, m * 1.08)) ** 0.9;
    return oklchToSrgb(L, m < 0.02 ? 0.02 : C, lerp(side.h[0], side.h[1], m));
  };
  return { signal, signalText, wave };
}

/** Signal scale. t = 0 is the weakest displayed level, t = 1 the strongest. Returns [r, g, b] in 0..1. */
export function signalRamp(t) { return themeRamps(active).signal(t); }

/**
 * The signal colour made light enough to be read as text on the dark background.
 * Same hue as signalRamp(t); the lightness never goes below 0.74.
 */
export function signalTextRamp(t) { return themeRamps(active).signalText(t); }

/** Wave scale. v = -1 (deep trough) .. 0 (still) .. +1 (high crest). Returns [r, g, b] in 0..1. */
export function waveRamp(v) { return themeRamps(active).wave(v); }

/** A 256-entry RGBA lookup table (Uint8Array) for a ramp over [from, to]. */
export function rampToLut(ramp, from = 0, to = 1, size = 256) {
  const out = new Uint8Array(size * 4);
  for (let i = 0; i < size; i++) {
    const [r, g, b] = ramp(lerp(from, to, i / (size - 1)));
    out[i * 4] = Math.round(r * 255);
    out[i * 4 + 1] = Math.round(g * 255);
    out[i * 4 + 2] = Math.round(b * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}

export function toHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

/** CSS linear-gradient stops for a ramp. */
export function cssGradient(ramp, from = 0, to = 1, steps = 16) {
  const parts = [];
  for (let i = 0; i <= steps; i++) parts.push(`${toHex(ramp(lerp(from, to, i / steps)))} ${((i / steps) * 100).toFixed(1)}%`);
  return parts.join(', ');
}

/** Map dBm to the 0..1 position on the signal scale. */
export function dbmToT(dbm, range) {
  return clamp01((dbm - range[0]) / (range[1] - range[0]));
}

/**
 * One colour per signal band (excellent ... poor), taken from the signal scale at
 * the middle of each band, so chips, markers and the heatmap agree.
 */
export function bandColors(grades, ramp = signalRamp) {
  const range = grades.display_range_dbm;
  const out = {};
  let upper = range[1];
  for (const band of grades.bands) {
    const lower = Math.max(band.min_dbm, range[0]);
    out[band.id] = toHex(ramp(dbmToT((upper + lower) / 2, range)));
    upper = lower;
  }
  return out;
}

/** The band colours for text: same hues, light enough to read on the dark background. */
export function bandTextColors(grades) {
  return bandColors(grades, signalTextRamp);
}
