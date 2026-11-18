import test from 'node:test';
import assert from 'node:assert/strict';
import { grades } from './helpers.mjs';
import { THEMES, THEME_ORDER, customTheme, themeRamps, setActiveTheme, activeTheme, signalRamp, waveRamp, bandColors, toHex, CUSTOM_DEFAULT } from '../src/core/colormaps.js';
import { checkTheme, luminance } from '../src/core/colorcheck.js';

test('there are five presets and "Mission control" is the first', () => {
  assert.deepEqual(THEME_ORDER, ['mission', 'aurora', 'heat', 'mono', 'safe']);
  assert.equal(THEMES.mission.label, 'Mission control');
  for (const id of THEME_ORDER) assert.equal(THEMES[id].id, id);
});

test('every preset passes every readability check', () => {
  for (const id of THEME_ORDER) {
    const failed = checkTheme(THEMES[id], grades).filter((r) => !r.ok).map((r) => r.text);
    assert.deepEqual(failed, [], `theme ${id}`);
  }
});

test('"Mission control" keeps the colours the page had before themes existed', () => {
  setActiveTheme(THEMES.mission);
  assert.deepEqual(bandColors(grades), { excellent: '#a7dd82', good: '#1cac9b', fair: '#0e8197', weak: '#105b90', poor: '#29245e' });
});

test('the active theme drives the ramps that the layers and the legend use', () => {
  setActiveTheme(THEMES.mission);
  const before = [toHex(signalRamp(0.7)), toHex(waveRamp(0.6)), toHex(waveRamp(-0.6))];
  setActiveTheme(THEMES.heat);
  const after = [toHex(signalRamp(0.7)), toHex(waveRamp(0.6)), toHex(waveRamp(-0.6))];
  assert.equal(activeTheme().id, 'heat');
  assert.ok(before.every((c, i) => c !== after[i]));
  setActiveTheme(null);                                   // nonsense falls back to the default
  assert.equal(activeTheme().id, 'mission');
});

test('in every theme the wave scale is dark at zero and crest and trough differ', () => {
  for (const id of THEME_ORDER) {
    const r = themeRamps(THEMES[id]);
    assert.ok(luminance(r.wave(0)) < 0.02, id);
    assert.notEqual(toHex(r.wave(0.8)), toHex(r.wave(-0.8)), id);
  }
});

test('a custom theme goes through the picked colours', () => {
  const t = customTheme({ signalLow: '#101040', signalMid: '#208080', signalHigh: '#f0f080', accent: '#ff8800' });
  const r = themeRamps(t);
  assert.equal(toHex(r.signal(0)), '#101040');
  assert.equal(toHex(r.signal(0.5)), '#208080');
  assert.equal(toHex(r.signal(1)), '#f0f080');
  assert.equal(t.accent, '#ff8800');
  assert.equal(t.id, 'custom');
  assert.deepEqual(checkTheme(customTheme(CUSTOM_DEFAULT), grades).filter((x) => !x.ok), []);
});

test('a custom palette that is hard to read is reported, in plain words, and still returned', () => {
  // strong signal darker than weak signal: the order of the scale is lost
  const t = customTheme({ signalLow: '#f0f080', signalMid: '#208080', signalHigh: '#101040' });
  const failed = checkTheme(t, grades).filter((x) => !x.ok).map((x) => x.text);
  assert.ok(failed.length >= 1);
  assert.match(failed[0], /signal scale: lightness rises/);
  assert.equal(toHex(themeRamps(t).signal(1)), '#101040');
  // the same colour for crest and trough cannot be told apart
  const same = checkTheme(customTheme({ waveTrough: '#ff8800', waveCrest: '#ff8800' }), grades).filter((x) => !x.ok).map((x) => x.text);
  assert.ok(same.some((x) => /crest and trough/.test(x)));
  // a nonsense colour does not break the theme
  assert.equal(customTheme({ accent: 'not-a-colour' }).accent, CUSTOM_DEFAULT.accent);
});
