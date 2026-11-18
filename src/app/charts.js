// Small canvas charts: node history, channel map, timeline. No library.
// Nothing private is ever drawn as text here: only numbers, hours and channel numbers.

import { channelFreq, blockOf } from '../core/metrics.js';

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Size a canvas for the device pixel ratio and return a context scaled to CSS pixels. */
export function prepare(canvas, cssHeight) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || canvas.parentElement.clientWidth;
  const h = cssHeight ?? canvas.clientHeight;
  if (cssHeight) canvas.style.height = `${cssHeight}px`;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h, rem: parseFloat(getComputedStyle(document.documentElement).fontSize) };
}

const hourLabel = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** RSSI history of one node. rows: [{ t, rssi, noise }]. */
export function drawHistory(canvas, rows, { from, to, cursor, grades, colors }) {
  const { g, w, h, rem } = prepare(canvas, 9.4 * parseFloat(getComputedStyle(document.documentElement).fontSize));
  const padL = 2.3 * rem, padB = 1.1 * rem, padT = 0.3 * rem, padR = 0.3 * rem;
  const x = (t) => padL + ((t - from) / (to - from)) * (w - padL - padR);
  const lo = -100, hi = -25;
  const y = (v) => padT + ((hi - v) / (hi - lo)) * (h - padT - padB);
  g.font = `${0.6 * rem}px ${css('--mono')}`;
  g.textBaseline = 'middle';
  // band limits as quiet guide lines
  for (const band of grades.bands.slice(0, 4)) {
    g.strokeStyle = 'rgba(140,170,215,0.16)'; g.lineWidth = 1; g.setLineDash([3, 4]);
    g.beginPath(); g.moveTo(padL, y(band.min_dbm)); g.lineTo(w - padR, y(band.min_dbm)); g.stroke();
    g.setLineDash([]);
    g.fillStyle = colors[band.id]; g.textAlign = 'right';
    g.fillText(String(band.min_dbm), padL - 0.35 * rem, y(band.min_dbm));
  }
  g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillStyle = css('--text-3');
  const span = to - from, stepH = span > 12 * 3600e3 ? 6 : span > 4 * 3600e3 ? 2 : 1;
  const first = new Date(from); first.setMinutes(0, 0, 0);
  for (let t = first.getTime(); t <= to; t += 3600e3) {
    if (t < from || new Date(t).getHours() % stepH) continue;
    g.fillText(hourLabel(t), x(t), h - 0.2 * rem);
  }
  const inRange = rows.filter((r) => r.t >= from && r.t <= to);
  // noise floor
  g.strokeStyle = 'rgba(255,200,118,0.75)'; g.lineWidth = 1;
  g.beginPath();
  let started = false, prevT = 0;
  for (const r of inRange) {
    if (!Number.isFinite(r.noise)) continue;
    const gap = r.t - prevT > 20 * 60000;
    if (!started || gap) g.moveTo(x(r.t), y(Math.max(lo, r.noise))); else g.lineTo(x(r.t), y(Math.max(lo, r.noise)));
    started = true; prevT = r.t;
  }
  g.stroke();
  // signal
  g.strokeStyle = '#e6edf7'; g.lineWidth = 1.4; g.lineJoin = 'round';
  g.beginPath(); started = false; prevT = 0;
  for (const r of inRange) {
    const gap = r.t - prevT > 20 * 60000;      // a gap in the line means the node sent nothing
    if (!started || gap) g.moveTo(x(r.t), y(r.rssi)); else g.lineTo(x(r.t), y(r.rssi));
    started = true; prevT = r.t;
  }
  g.stroke();
  if (cursor >= from && cursor <= to) {
    g.strokeStyle = css('--accent'); g.lineWidth = 1;
    g.beginPath(); g.moveTo(x(cursor), padT); g.lineTo(x(cursor), h - padB); g.stroke();
  }
  if (!inRange.length) { g.fillStyle = css('--text-3'); g.textAlign = 'center'; g.font = `${0.7 * rem}px ${css('--sans')}`; g.fillText('no samples in this period', w / 2, h / 2); }
}

/** Channel map. report: output of channelReport(). Own radios are bright, neighbours grey. */
export function drawChannels(canvas, report, { networkColors }) {
  const { g, w, h, rem } = prepare(canvas, 7.4 * parseFloat(getComputedStyle(document.documentElement).fontSize));
  const half = (h - 0.2 * rem) / 2;
  const rows = [
    { band: '2.4', f0: 2400, f1: 2474, width: 20, y0: 0, labels: [1, 6, 11] },
    { band: '5', f0: 5160, f1: 5840, width: 80, y0: half + 0.2 * rem, labels: [36, 52, 100, 116, 132, 149, 165] },
  ];
  for (const row of rows) {
    const base = row.y0 + half - 1.05 * rem, top = row.y0 + 0.25 * rem;
    const x = (f) => 2.6 * rem + ((f - row.f0) / (row.f1 - row.f0)) * (w - 3.4 * rem);
    g.font = `${0.6 * rem}px ${css('--sans')}`; g.fillStyle = css('--text-3'); g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillText(`${row.band}`, 0, (base + top) / 2 - 0.3 * rem);
    g.fillText('GHz', 0, (base + top) / 2 + 0.4 * rem);
    g.strokeStyle = 'rgba(140,170,215,0.25)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x(row.f0), base); g.lineTo(x(row.f1), base); g.stroke();
    g.font = `${0.58 * rem}px ${css('--mono')}`; g.textAlign = 'center'; g.textBaseline = 'top';
    for (const ch of row.labels) g.fillText(String(ch), x(channelFreq(row.band, ch)), base + 0.25 * rem);
    const slots = report.byBand[row.band]?.channels || [];
    const hump = (ch, widthMhz, height, fill, stroke) => {
      const block = row.band === '5' && widthMhz === 80 ? blockOf(ch) : null;
      const fc = block ? (channelFreq('5', block[0]) + channelFreq('5', block[1])) / 2 : channelFreq(row.band, ch);
      const xl = x(fc - widthMhz / 2), xr = x(fc + widthMhz / 2), yt = base - height;
      const sh = (xr - xl) * 0.18;
      g.beginPath(); g.moveTo(xl, base); g.lineTo(xl + sh, yt); g.lineTo(xr - sh, yt); g.lineTo(xr, base); g.closePath();
      if (fill) { g.fillStyle = fill; g.fill(); }
      g.strokeStyle = stroke; g.lineWidth = 1.2; g.stroke();
    };
    const maxH = base - top;
    for (const slot of slots) {
      slot.neighbours.forEach((nb, i) => {
        const strength = Math.min(1, Math.max(0.18, ((nb.rssi ?? -85) + 95) / 40));
        hump(slot.channel, row.band === '5' ? 80 : 20, maxH * (0.25 + 0.4 * strength) - i * 1.5, 'rgba(140,160,190,0.10)', 'rgba(150,170,200,0.45)');
      });
    }
    for (const slot of slots) {
      slot.own.forEach((r, i) => {
        const c = networkColors[r.network] || '#ffffff';
        hump(slot.channel, row.width, maxH * (0.96 - 0.11 * i), `${c}22`, c);
      });
    }
  }
}

/**
 * Timeline strip. data: { from, to, cursor, trend: [{ t, v }], events: [{ type, from, to }], live }.
 * trend is the median signal of all sensors (dBm).
 */
export function drawTimeline(canvas, data, { colorFor }) {
  const { g, w, h, rem } = prepare(canvas);
  const { from, to, cursor } = data;
  const padB = 1.15 * rem, padT = 0.25 * rem;
  const x = (t) => ((t - from) / (to - from)) * w;
  const lo = -90, hi = -35;
  const y = (v) => padT + ((hi - Math.max(lo, Math.min(hi, v))) / (hi - lo)) * (h - padT - padB);
  // hour grid
  g.font = `${0.62 * rem}px ${css('--mono')}`; g.textBaseline = 'alphabetic'; g.textAlign = 'center';
  const first = new Date(from); first.setMinutes(0, 0, 0);
  const everyH = w < 900 ? 3 : 2;
  for (let t = first.getTime(); t <= to; t += 3600e3) {
    if (t < from) continue;
    const hour = new Date(t).getHours();
    g.strokeStyle = hour === 0 ? 'rgba(140,170,215,0.32)' : 'rgba(140,170,215,0.10)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(Math.round(x(t)) + 0.5, padT); g.lineTo(Math.round(x(t)) + 0.5, h - padB); g.stroke();
    if (hour % everyH === 0 && x(t) > 1.6 * rem && x(t) < w - 1.6 * rem) { g.fillStyle = css('--text-3'); g.fillText(hourLabel(t), x(t), h - 0.22 * rem); }
  }
  // events
  for (const e of data.events) {
    const xa = Math.max(0, x(e.from)), xb = Math.min(w, Math.max(x(e.to), xa + 3));
    if (xb < 0 || xa > w) continue;
    if (e.type === 'interference') {
      g.fillStyle = 'rgba(255,200,118,0.20)'; g.fillRect(xa, padT, xb - xa, h - padT - padB);
      g.fillStyle = 'rgba(255,200,118,0.95)'; g.fillRect(xa, padT, xb - xa, 2);
    } else if (e.type === 'offline') {
      g.fillStyle = 'rgba(140,160,190,0.14)'; g.fillRect(xa, h - padB - 0.5 * rem, xb - xa, 0.5 * rem);
      g.fillStyle = 'rgba(170,185,210,0.8)'; g.fillRect(xa, h - padB - 2, xb - xa, 2);
    }
  }
  // trend, coloured by signal band
  if (data.trend.length > 1) {
    g.lineWidth = 1.6; g.lineJoin = 'round';
    for (let i = 1; i < data.trend.length; i++) {
      const a = data.trend[i - 1], b = data.trend[i];
      if (b.t - a.t > 30 * 60000) continue;
      g.strokeStyle = colorFor((a.v + b.v) / 2);
      g.beginPath(); g.moveTo(x(a.t), y(a.v)); g.lineTo(x(b.t), y(b.v)); g.stroke();
    }
  }
  // cursor
  const cx = Math.max(1, Math.min(w - 1, x(cursor)));
  g.strokeStyle = '#ffffff'; g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(cx, 0); g.lineTo(cx, h - padB + 2); g.stroke();
  g.fillStyle = '#ffffff';
  g.beginPath(); g.moveTo(cx - 5, 0); g.lineTo(cx + 5, 0); g.lineTo(cx, 7); g.closePath(); g.fill();
}
