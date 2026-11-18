// The Layout setup panel: a person makes the atlas look like their own house.
//
// Three ways in (docs/custom-layout.md): a scan export, a plan image to trace over,
// or drawing rooms on a grid. All of them end in the same editor and in one
// floorplan.json. The panel reads and writes only the user workspace: data/user/
// through /api/layout of the local server, or this browser's storage when the page
// runs without that server. It never touches data/private/.
//
// The module mounts its own button, style sheet and overlay, so the rest of the
// page needs only one call: initLayoutSetup().

import {
  USER_PATHS, LEVEL_KINDS, parseLength, newDraft, addLevel, nextItemId, nextLevelId, levelElevations, openingOnWall,
  draftToFloorplan, floorplanToDraft, isDraft, normalizeDraft,
} from '../core/layout.js';
import { validateFloorplan, formatIssues } from '../core/validate.js';
import { dist, pointInPolygon, polygonArea, pointSegmentDistance, interiorPoint, bounds, findHostWall } from '../core/geometry.js';

const KEYS = { layout: 'signal-atlas:user-layout', draft: 'signal-atlas:user-layout:draft', image: 'signal-atlas:user-layout:image:' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (v) => JSON.parse(JSON.stringify(v));
const r3 = (v) => Math.round(v * 1000) / 1000;
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* storage is not available */ } },
};

/**
 * The layout a user made, or null: data/user/floorplan.json from the local server,
 * else the copy this browser keeps. Called at start-up unless ?demo=1 is set.
 */
export async function loadUserLayout(getJson) {
  const plan = await getJson(USER_PATHS.floorplan, true);
  if (plan && typeof plan === 'object') return { plan, config: await getJson(USER_PATHS.config, true), from: 'data/user' };
  const kept = store.get(KEYS.layout);
  return kept?.plan && typeof kept.plan === 'object' ? { plan: kept.plan, config: kept.config || null, from: 'browser' } : null;
}

const TOOLS = [
  ['select', 'Select', 'V', 'Click an item to select it. Drag a room, or a corner or an edge of the selected room. Delete removes it.'],
  ['rect', 'Room', 'R', 'Drag from one corner of the room to the opposite corner.'],
  ['poly', 'Room by corners', 'C', 'Click each corner. Click the first corner again or press Enter to finish. Shift keeps lines at 45° steps.'],
  ['wall', 'Wall', 'W', 'Click the start and the end of a wall. Esc stops.'],
  ['door', 'Door', 'D', 'Click a wall to put a door there.'],
  ['window', 'Window', 'N', 'Click a wall to put a window there.'],
  ['opening', 'Opening', 'O', 'Click a wall to open it: a doorway without a door, or two rooms that are one space.'],
  ['stairs', 'Stairs', 'T', 'Drag a rectangle over the stairs. They join this floor to the one above.'],
  ['erase', 'Erase', 'E', 'Click an item to remove it.'],
];
const TOOL_HINT = { ...Object.fromEntries(TOOLS.map((t) => [t[0], t[3]])), scale: 'Click the two ends of a length you know on the image, for example a wall you measured.', image: 'Drag the image to where it belongs.' };
const C = {
  bg: '#070a10', grid: 'rgba(140,170,215,0.06)', grid1: 'rgba(140,170,215,0.13)', grid5: 'rgba(140,170,215,0.26)', room: 'rgba(159,216,255,0.09)', roomSel: 'rgba(159,216,255,0.24)',
  ext: '#e6edf7', int: '#8fa3bf', door: '#9be8b0', window: '#7cc7ff', opening: '#ffc876', stairs: '#ffd9a0', bad: '#ff7a7a', ghost: 'rgba(140,170,215,0.38)', accent: '#9fd8ff', text: '#e6edf7', text2: '#a9b6c9',
};
const WIDTHS = { door: 0.9, window: 1.2, opening: 1.5 };

/**
 * materials, schema: the loaded data files. workspace: 'demo', 'user' or 'private' (what the page shows now).
 * userPlan: the plan on screen when it is the user's. privacy(): true while privacy mode is on.
 */
export function initLayoutSetup({ materials, schema, workspace = 'demo', userPlan = null, privacy = () => false }) {
  const S = {
    draft: null, li: 0, tool: 'select', sel: null, view: { x: -1.5, y: -1.5, s: 48 }, pending: null, hover: null, drag: null, cursor: null,
    history: [], future: [], images: new Map(), onServer: new Map(), preview: null, server: null, loaded: false, space: false, busy: false,
    note: '', noteKind: '', snap: 0.1, width: { ...WIDTHS }, wallKind: 'auto', copyRooms: true, scale: null,
    scan: { open: false, status: null, busy: false, rows: [{ kind: 'main', name: 'First floor', files: [] }] },
  };
  let root = null, side, bar, canvas, ctx, statusEl, saveTimer = 0, sideTimer = 0;
  let panelDown = false, sidePending = false, barPending = false;
  const labelSpot = new Map();

  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'styles/setup-layout.css';
  document.head.append(link);
  const btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'layout-open'; btn.className = 'btn';
  btn.title = 'Set up the layout of your own house: import a scan, trace a plan image, or draw the rooms';
  btn.innerHTML = 'Layout <kbd>L</kbd>';
  const topbar = document.getElementById('topbar');
  topbar.insertBefore(btn, topbar.querySelector('.clock'));
  btn.addEventListener('click', () => open());

  const isOpen = () => !!root && !root.hidden;
  const cur = () => S.draft.levels[S.li];
  const planLevel = () => S.preview.plan.levels[S.li];
  const say = (text, kind = '') => { S.note = text; S.noteKind = kind; };

  async function api(method, path, body, raw = false) {
    try {
      const res = await fetch(path, { method, cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': raw ? 'application/octet-stream' : 'application/json' }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
      const data = /json/.test(res.headers.get('content-type') || '') ? await res.json() : null;
      return { status: res.status, data };
    } catch { return { status: 0, data: null }; }
  }
  function pickFiles(accept, multiple = false) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = accept; input.multiple = multiple; input.hidden = true;
      input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
      input.addEventListener('cancel', () => { resolve([]); input.remove(); });
      root.append(input);
      input.click();
    });
  }

  // ------------------------------------------------------------------ open, load, close
  function build() {
    root = document.createElement('div');
    root.id = 'layout-setup'; root.tabIndex = -1; root.hidden = true;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Layout setup');
    root.innerHTML = '<aside class="ls-side" aria-label="Layout settings"></aside><div class="ls-main"><div class="ls-bar" role="toolbar" aria-label="Drawing tools"></div><div class="ls-stage"><canvas tabindex="0" aria-label="Floor plan editor"></canvas></div><div class="ls-status" aria-live="polite"></div></div>';
    document.body.append(root);
    side = root.querySelector('.ls-side'); bar = root.querySelector('.ls-bar'); canvas = root.querySelector('canvas'); statusEl = root.querySelector('.ls-status');
    ctx = canvas.getContext('2d');
    side.addEventListener('click', onSideClick);
    side.addEventListener('change', onSideChange);
    side.addEventListener('input', onSideInput);
    // A click is lost when its button is rebuilt between press and release (leaving a text box by
    // clicking a button does that). So while a pointer is down on the panel, rebuilding waits.
    for (const el of [side, bar]) el.addEventListener('pointerdown', () => { panelDown = true; });
    const release = () => { if (panelDown) setTimeout(() => { panelDown = false; if (barPending) renderBar(); if (sidePending) renderSide(); }, 0); };
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    bar.addEventListener('click', onBarClick);
    bar.addEventListener('change', onBarChange);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('dblclick', () => { if (S.pending?.type === 'poly') finishPoly(); else if (S.pending?.type === 'wall') { S.pending = null; draw(); } });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    window.addEventListener('resize', () => { if (isOpen()) { resize(); draw(); } });
    window.addEventListener('keyup', (ev) => { if (ev.key === ' ') S.space = false; });
  }

  async function open() {
    if (!root) build();
    root.hidden = false;
    root.focus();
    if (!S.loaded) await load();
    resize(); fit(); refresh();
  }
  function close() { if (root && !root.hidden) { root.hidden = true; btn.focus(); } }

  async function load() {
    const r = await api('GET', '/api/layout');
    S.server = r.status === 200 && r.data?.ok ? r.data : null;
    const drafts = [S.server?.draft, store.get(KEYS.draft)].map(normalizeDraft).filter(Boolean).sort((a, b) => (Date.parse(b.saved || '') || 0) - (Date.parse(a.saved || '') || 0));
    const plan = S.server?.plan || store.get(KEYS.layout)?.plan || userPlan;
    S.draft = drafts[0] || (plan ? floorplanToDraft(plan) : newDraft());
    S.li = Math.max(0, S.draft.levels.findIndex((l) => l.kind === 'main'));
    for (const level of S.draft.levels) {
      if (!level.underlay) continue;
      const fromServer = S.server?.underlays?.[level.id];
      const src = fromServer || store.get(KEYS.image + level.id);
      if (!src) { level.underlay = null; continue; }
      const key = level.underlay.key || (level.underlay.key = `saved-${level.id}`);
      if (fromServer) S.onServer.set(level.id, key);
      const img = new Image();
      img.onload = () => {
        // a copy as data is kept too, so the picture can be saved again after an undo
        let dataUrl = src.startsWith('data:') ? src : null;
        if (!dataUrl) { try { const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight; c.getContext('2d').drawImage(img, 0, 0); dataUrl = c.toDataURL('image/jpeg', 0.9); } catch { /* shown, but cannot be saved again */ } }
        S.images.set(key, { img, dataUrl });
        draw();
      };
      img.src = src.startsWith('data:') ? src : `${src}?v=${Date.now()}`;
    }
    S.loaded = true;
  }

  // ------------------------------------------------------------------ changes, undo
  function change(fn) {
    S.history.push(JSON.stringify(S.draft));
    if (S.history.length > 100) S.history.shift();
    S.future = [];
    fn();
    refresh();
  }
  function jump(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify(S.draft));
    S.draft = JSON.parse(from.pop());
    S.li = Math.min(S.li, S.draft.levels.length - 1);
    S.sel = null; S.pending = null;
    refresh();
  }

  /** The floors that hold nothing yet: said in plain words instead of the checker's wording. */
  function check() {
    const made = draftToFloorplan(S.draft, materials);
    const issues = validateFloorplan(made.plan, schema, materials);
    const empty = S.draft.levels.map((l, i) => (l.derive && !l.rooms.length && !l.walls.length ? i : -1)).filter((i) => i >= 0);
    const errors = empty.map((i) => `The floor "${S.draft.levels[i].name}" is empty. Draw a room on it, or delete the floor.`);
    for (const e of issues.errors) if (!empty.some((i) => e.path.startsWith(`levels[${i}]`))) errors.push(formatIssues([e])[0]);
    return { plan: made.plan, errors, warnings: [...made.warnings, ...formatIssues(issues.warnings)] };
  }
  function refresh(light = false) {
    S.preview = check();
    if (light) { draw(); return; }
    S.draft.saved = new Date().toISOString();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set(KEYS.draft, S.draft), 400);
    renderBar(); renderSide(); draw();
  }

  // ------------------------------------------------------------------ view
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  }
  function fit() {
    const level = cur(), pts = [];
    for (const r of level.rooms) pts.push(...r.polygon);
    for (const w of level.walls) pts.push(w.a, w.b);
    for (const s of level.stairs) pts.push(...s.polygon);
    for (const p of level.outline || []) pts.push(p);
    const u = level.underlay;
    if (u) pts.push([u.x, u.y], [u.x + u.w * u.mPerPx, u.y + u.h * u.mPerPx]);
    if (!pts.length) for (const l of S.preview?.plan.levels || []) pts.push(...l.outline);
    const b = pts.length ? bounds(pts) : { minX: 0, minY: 0, maxX: 14, maxY: 9 };
    const w = canvas.clientWidth || 800, h = canvas.clientHeight || 600, pad = 70;
    const s = Math.max(6, Math.min(140, (w - pad * 2) / Math.max(4, b.maxX - b.minX), (h - pad * 2) / Math.max(3, b.maxY - b.minY)));
    S.view = { s, x: (b.minX + b.maxX) / 2 - w / 2 / s, y: (b.minY + b.maxY) / 2 - h / 2 / s };
  }
  const planAt = (ev) => { const r = canvas.getBoundingClientRect(); return [S.view.x + (ev.clientX - r.left) / S.view.s, S.view.y + (ev.clientY - r.top) / S.view.s]; };
  const px = (n) => n / S.view.s;

  /** Snap to a corner that is already there, else to the grid. Alt switches snapping off. */
  function snap(p, ev, from = null) {
    if (ev?.altKey) return [r3(p[0]), r3(p[1])];
    let q = p;
    if (ev?.shiftKey && from) {
      const dx = p[0] - from[0], dy = p[1] - from[1];
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(dx, dy);
      q = [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
    } else {
      let best = null, bd = px(10);
      const level = cur();
      const near = (v) => { const d = Math.hypot(v[0] - p[0], v[1] - p[1]); if (d < bd) { bd = d; best = v; } };
      for (const r of level.rooms) r.polygon.forEach(near);
      for (const w of planLevel().walls) { near(w.a); near(w.b); }
      const below = S.preview.plan.levels[S.li - 1];
      if (below) below.outline.forEach(near);
      if (best) return [best[0], best[1]];
    }
    return [r3(Math.round(q[0] / S.snap) * S.snap), r3(Math.round(q[1] / S.snap) * S.snap)];
  }

  // ------------------------------------------------------------------ drawing
  function draw() {
    if (!isOpen() || !S.preview) return;
    resize();   // the bar above can wrap to a second row, which changes the height of the canvas
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight, v = S.view;
    const X = (x) => (x - v.x) * v.s, Y = (y) => (y - v.y) * v.s;
    const level = cur(), pl = planLevel();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, w, h);
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    const path = (pts, closed = true) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); if (closed) ctx.closePath(); };
    const seg = (a, b) => { ctx.beginPath(); ctx.moveTo(X(a[0]), Y(a[1])); ctx.lineTo(X(b[0]), Y(b[1])); ctx.stroke(); };
    const tag = (text, sx, sy, color = C.text) => {
      ctx.font = '12px Inter, system-ui, sans-serif';
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(5,7,11,0.86)'; ctx.fillRect(sx - tw / 2 - 5, sy - 10, tw + 10, 20);
      ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, sx, sy);
    };

    // the picture to trace over
    const u = level.underlay, pic = u ? S.images.get(u.key) : null;
    if (u) {
      const iw = u.w * u.mPerPx * v.s, ih = u.h * u.mPerPx * v.s;
      if (privacy() || !pic) {
        ctx.strokeStyle = C.grid5; ctx.setLineDash([6, 6]); ctx.strokeRect(X(u.x), Y(u.y), iw, ih); ctx.setLineDash([]);
        tag(privacy() ? 'Plan image hidden in privacy mode' : 'Loading the image', X(u.x) + iw / 2, Y(u.y) + 18, C.text2);
      } else {
        ctx.save();
        ctx.globalAlpha = u.opacity;
        if (u.invert !== false && 'filter' in ctx) ctx.filter = 'invert(1) hue-rotate(180deg)';
        ctx.drawImage(pic.img, X(u.x), Y(u.y), iw, ih);
        ctx.restore();
      }
    }

    // grid: the snap step when it is wide enough to see, every metre, every 5 metres
    const lines = (step, color) => {
      ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = Math.ceil(v.x / step) * step; X(x) < w; x += step) { ctx.moveTo(Math.round(X(x)) + 0.5, 0); ctx.lineTo(Math.round(X(x)) + 0.5, h); }
      for (let y = Math.ceil(v.y / step) * step; Y(y) < h; y += step) { ctx.moveTo(0, Math.round(Y(y)) + 0.5); ctx.lineTo(w, Math.round(Y(y)) + 0.5); }
      ctx.stroke();
    };
    if (S.snap * v.s >= 9 && S.snap < 1) lines(S.snap, C.grid);
    if (v.s >= 9) lines(1, C.grid1);
    lines(5, C.grid5);

    // the floor below, as a guide to stack floors
    const below = S.preview.plan.levels[S.li - 1];
    if (below && below.outline.length >= 3) { ctx.strokeStyle = C.ghost; ctx.lineWidth = 1.5; ctx.setLineDash([7, 5]); path(below.outline); ctx.stroke(); ctx.setLineDash([]); }

    // rooms
    level.rooms.forEach((room, i) => {
      if (room.polygon.length < 3) return;
      const on = S.sel?.type === 'room' && S.sel.i === i;
      path(room.polygon);
      ctx.fillStyle = on ? C.roomSel : C.room; ctx.fill();
      if (!level.derive || on) { ctx.strokeStyle = on ? C.accent : 'rgba(159,216,255,0.25)'; ctx.lineWidth = on ? 1.5 : 1; ctx.stroke(); }
    });
    // stairs
    level.stairs.forEach((st, i) => {
      const on = S.sel?.type === 'stairs' && S.sel.i === i;
      const b = bounds(st.polygon);
      ctx.save(); path(st.polygon); ctx.clip();
      ctx.strokeStyle = C.stairs; ctx.globalAlpha = 0.55; ctx.lineWidth = 1; ctx.beginPath();
      const wide = b.maxX - b.minX >= b.maxY - b.minY;
      for (let t = wide ? b.minX : b.minY; t < (wide ? b.maxX : b.maxY); t += 0.28) { if (wide) { ctx.moveTo(X(t), Y(b.minY)); ctx.lineTo(X(t), Y(b.maxY)); } else { ctx.moveTo(X(b.minX), Y(t)); ctx.lineTo(X(b.maxX), Y(t)); } }
      ctx.stroke(); ctx.restore();
      path(st.polygon); ctx.strokeStyle = on ? C.accent : C.stairs; ctx.lineWidth = on ? 2 : 1.25; ctx.stroke();
    });
    // fixtures of an imported floor
    for (const fx of level.fixtures || []) { path(fx.polygon); ctx.strokeStyle = C.int; ctx.lineWidth = 1; ctx.stroke(); }

    // walls of the plan as it will be saved
    const thick = (m) => materials.materials?.[m]?.thickness ?? 0.12;
    for (const wl of pl.walls) {
      const t = thick(wl.material), outer = t >= 0.15;
      ctx.strokeStyle = outer ? C.ext : C.int; ctx.lineWidth = Math.max(outer ? 3 : 1.75, t * v.s); ctx.lineCap = 'square';
      seg(wl.a, wl.b);
    }
    ctx.lineCap = 'butt';
    if (S.sel?.type === 'wall' && level.walls[S.sel.i]) { ctx.strokeStyle = C.accent; ctx.lineWidth = 3; seg(level.walls[S.sel.i].a, level.walls[S.sel.i].b); }

    // doors, windows, openings
    const drawOpening = (op, on, ghost = false) => {
      const host = findHostWall(op, pl.walls);
      const t = host >= 0 ? thick(pl.walls[host].material) : 0.12;
      const lw = Math.max(4, t * v.s + 2);
      ctx.globalAlpha = ghost ? 0.6 : 1;
      ctx.strokeStyle = C.bg; ctx.lineWidth = lw; seg(op.a, op.b);
      const color = host < 0 && !ghost ? C.bad : on ? C.accent : C[op.type];
      ctx.strokeStyle = color;
      if (op.type === 'window') { ctx.lineWidth = Math.max(2.5, lw * 0.4); seg(op.a, op.b); } else if (op.type === 'door') {
        ctx.lineWidth = 2; seg(op.a, op.b);
        if ((op.state || 'x') !== 'open') { ctx.lineWidth = 1; for (const e of [op.a, op.b]) { ctx.beginPath(); ctx.arc(X(e[0]), Y(e[1]), 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); } }
      } else { ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); seg(op.a, op.b); ctx.setLineDash([]); }
      ctx.globalAlpha = 1;
    };
    level.openings.forEach((op, i) => drawOpening(op, S.sel?.type === 'opening' && S.sel.i === i));
    if (S.hover) drawOpening({ ...S.hover, type: S.tool }, false, true);

    // room names and sizes
    level.rooms.forEach((room) => {
      if (room.polygon.length < 3) return;
      const b = bounds(room.polygon);
      if ((b.maxX - b.minX) * v.s < 54 || (b.maxY - b.minY) * v.s < 30) return;
      const key = JSON.stringify(room.polygon);
      if (!labelSpot.has(key)) { if (labelSpot.size > 400) labelSpot.clear(); labelSpot.set(key, interiorPoint(room.polygon, 0.25)); }
      const c = labelSpot.get(key);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 12px Inter, system-ui, sans-serif'; ctx.fillStyle = C.text; ctx.fillText(room.name || 'Room', X(c[0]), Y(c[1]) - 7);
      ctx.font = '11px Inter, system-ui, sans-serif'; ctx.fillStyle = C.text2; ctx.fillText(`${polygonArea(room.polygon).toFixed(1)} m²`, X(c[0]), Y(c[1]) + 8);
    });

    // handles of the selected room
    if (S.sel?.type === 'room' && level.rooms[S.sel.i] && S.tool === 'select') {
      ctx.fillStyle = C.accent;
      for (const p of level.rooms[S.sel.i].polygon) ctx.fillRect(X(p[0]) - 4, Y(p[1]) - 4, 8, 8);
    }

    // what is being drawn right now
    const pd = S.pending;
    ctx.strokeStyle = C.accent; ctx.lineWidth = 1.5;
    if (pd?.type === 'rect') {
      const x0 = Math.min(pd.a[0], pd.b[0]), x1 = Math.max(pd.a[0], pd.b[0]), y0 = Math.min(pd.a[1], pd.b[1]), y1 = Math.max(pd.a[1], pd.b[1]);
      ctx.setLineDash([6, 4]); ctx.strokeRect(X(x0), Y(y0), (x1 - x0) * v.s, (y1 - y0) * v.s); ctx.setLineDash([]);
      if (x1 - x0 > 0 && y1 - y0 > 0) tag(`${(x1 - x0).toFixed(2)} × ${(y1 - y0).toFixed(2)} m`, X((x0 + x1) / 2), Y(y0) - 14, C.accent);
    } else if (pd?.type === 'poly') {
      path([...pd.pts, pd.cur], false); ctx.stroke();
      ctx.fillStyle = C.accent;
      pd.pts.forEach((p, i) => { ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), i ? 3 : 5, 0, Math.PI * 2); ctx.fill(); });
      const last = pd.pts[pd.pts.length - 1];
      if (dist(last, pd.cur) > 0.01) tag(`${dist(last, pd.cur).toFixed(2)} m`, X((last[0] + pd.cur[0]) / 2), Y((last[1] + pd.cur[1]) / 2) - 14, C.accent);
    } else if (pd?.type === 'wall') {
      seg(pd.a, pd.b);
      if (dist(pd.a, pd.b) > 0.01) tag(`${dist(pd.a, pd.b).toFixed(2)} m`, X((pd.a[0] + pd.b[0]) / 2), Y((pd.a[1] + pd.b[1]) / 2) - 14, C.accent);
    }
    if (S.scale?.pts.length) {
      ctx.strokeStyle = C.opening; ctx.fillStyle = C.opening; ctx.lineWidth = 2;
      const pts = S.scale.pts.length === 1 && S.cursor ? [S.scale.pts[0], S.cursor] : S.scale.pts;
      if (pts.length === 2) seg(pts[0], pts[1]);
      for (const p of S.scale.pts) { ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 5, 0, Math.PI * 2); ctx.fill(); }
    }

    // a scale bar, so a glance tells how large things are
    const barM = [0.5, 1, 2, 5, 10, 20].find((m) => m * v.s >= 70) || 50;
    ctx.strokeStyle = C.text2; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(18, h - 20); ctx.lineTo(18 + barM * v.s, h - 20); ctx.stroke();
    ctx.font = '11px Inter, system-ui, sans-serif'; ctx.fillStyle = C.text2; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(`${barM} m`, 18, h - 25);

    statusEl.innerHTML = `<span>${esc(TOOL_HINT[S.tool] || '')}</span><span class="num">${S.cursor ? `x ${S.cursor[0].toFixed(2)} m · y ${S.cursor[1].toFixed(2)} m · ` : ''}grid ${S.snap} m · wheel zooms · right-drag moves</span>`;
  }

  // ------------------------------------------------------------------ pointer
  function hit(p) {
    const level = cur();
    const near = (a, b, tol) => pointSegmentDistance(p[0], p[1], a[0], a[1], b[0], b[1]) < px(tol);
    let i = level.openings.findIndex((o) => near(o.a, o.b, 7));
    if (i >= 0) return { type: 'opening', i };
    i = level.stairs.findIndex((s) => pointInPolygon(p[0], p[1], s.polygon));
    if (i >= 0) return { type: 'stairs', i };
    i = level.walls.findIndex((w) => near(w.a, w.b, 6));
    if (i >= 0) return { type: 'wall', i };
    let best = -1, area = Infinity;
    level.rooms.forEach((r, k) => { if (pointInPolygon(p[0], p[1], r.polygon) && polygonArea(r.polygon) < area) { best = k; area = polygonArea(r.polygon); } });
    return best >= 0 ? { type: 'room', i: best } : null;
  }
  const listOf = (type) => ({ room: 'rooms', wall: 'walls', opening: 'openings', stairs: 'stairs' }[type]);
  function removeItem(h) { cur()[listOf(h.type)].splice(h.i, 1); S.sel = null; }
  function setTool(tool) {
    S.tool = tool; S.pending = null; S.hover = null;
    if (tool !== 'scale') S.scale = null;
    renderBar(); renderSide(); draw();
  }

  function onDown(ev) {
    canvas.focus();
    const raw = planAt(ev), level = cur();
    if (ev.button === 1 || ev.button === 2 || S.space) { S.drag = { mode: 'pan', sx: ev.clientX, sy: ev.clientY, vx: S.view.x, vy: S.view.y }; canvas.setPointerCapture(ev.pointerId); return; }
    if (ev.button !== 0) return;
    canvas.setPointerCapture(ev.pointerId);
    const p = snap(raw, ev);
    if (S.tool === 'select') {
      if (S.sel?.type === 'room' && level.rooms[S.sel.i]) {
        const poly = level.rooms[S.sel.i].polygon, n = poly.length;
        const vi = poly.findIndex((q) => Math.hypot(q[0] - raw[0], q[1] - raw[1]) < px(9));
        if (vi >= 0) { S.drag = { mode: 'vertex', vi, orig: clone(poly) }; return; }
        const ei = poly.findIndex((q, k) => pointSegmentDistance(raw[0], raw[1], q[0], q[1], poly[(k + 1) % n][0], poly[(k + 1) % n][1]) < px(6));
        if (ei >= 0) { S.drag = { mode: 'edge', ei, start: raw, orig: clone(poly) }; return; }
      }
      S.sel = hit(raw);
      if (S.sel) S.drag = { mode: 'move', start: raw, orig: clone(level[listOf(S.sel.type)][S.sel.i]) };
      renderSide(); draw();
    } else if (S.tool === 'rect' || S.tool === 'stairs') {
      if (S.pending?.type === 'rect') finishRect(p); else S.pending = { type: 'rect', a: p, b: p, sx: ev.clientX, sy: ev.clientY };
    } else if (S.tool === 'poly') {
      if (!S.pending) S.pending = { type: 'poly', pts: [p], cur: p };
      else {
        const q = snap(raw, ev, S.pending.pts[S.pending.pts.length - 1]);
        if (S.pending.pts.length >= 3 && Math.hypot(q[0] - S.pending.pts[0][0], q[1] - S.pending.pts[0][1]) < Math.max(px(10), 1e-6)) finishPoly();
        else if (dist(q, S.pending.pts[S.pending.pts.length - 1]) > 0.02) S.pending.pts.push(q);
      }
      draw();
    } else if (S.tool === 'wall') {
      if (S.pending?.type === 'wall') {
        const a = S.pending.a, b = snap(raw, ev, a);
        if (dist(a, b) >= 0.1) { change(() => { level.walls.push({ a, b, kind: S.wallKind }); }); S.pending = { type: 'wall', a: b, b }; }
      } else S.pending = { type: 'wall', a: p, b: p };
      draw();
    } else if (['door', 'window', 'opening'].includes(S.tool)) {
      const o = openingOnWall(raw, planLevel().walls, S.width[S.tool], Math.max(0.5, px(14)));
      if (!o) { say('Click on a wall. Draw a room first if there is none.', 'warn'); renderSide(); return; }
      change(() => { level.openings.push({ type: S.tool, a: o.a, b: o.b }); S.sel = { type: 'opening', i: level.openings.length - 1 }; });
    } else if (S.tool === 'erase') {
      const h = hit(raw);
      if (h) change(() => removeItem(h));
    } else if (S.tool === 'scale' && level.underlay) {
      if (!S.scale || S.scale.pts.length >= 2) S.scale = { pts: [] };
      S.scale.pts.push(raw);
      renderSide(); draw();
    } else if (S.tool === 'image' && level.underlay) {
      S.drag = { mode: 'image', start: raw, ox: level.underlay.x, oy: level.underlay.y };
    }
  }

  /** The first movement of a drag saves the state before it, so one undo takes the whole drag back. */
  function dragChange(fn) {
    if (!S.drag.saved) { S.history.push(JSON.stringify(S.draft)); S.future = []; S.drag.saved = true; }
    fn();
    refresh(true);
  }
  function onMove(ev) {
    const raw = planAt(ev), level = cur(), d = S.drag;
    S.cursor = raw;
    if (d?.mode === 'pan') { S.view.x = d.vx - (ev.clientX - d.sx) / S.view.s; S.view.y = d.vy - (ev.clientY - d.sy) / S.view.s; draw(); return; }
    if (d?.mode === 'image') { dragChange(() => { level.underlay.x = r3(d.ox + raw[0] - d.start[0]); level.underlay.y = r3(d.oy + raw[1] - d.start[1]); }); return; }
    if (d && S.sel) {
      const item = level[listOf(S.sel.type)][S.sel.i];
      const step = ev.altKey ? 0.001 : S.snap;
      const dx = r3(Math.round((raw[0] - (d.start?.[0] || 0)) / step) * step), dy = r3(Math.round((raw[1] - (d.start?.[1] || 0)) / step) * step);
      const shift = (p) => [r3(p[0] + dx), r3(p[1] + dy)];
      if (d.mode === 'vertex') dragChange(() => { item.polygon[d.vi] = snap(raw, ev); });
      else if (d.mode === 'edge') {
        const a = d.orig[d.ei], b = d.orig[(d.ei + 1) % d.orig.length], len = dist(a, b) || 1;
        const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len;
        const m = Math.round(((raw[0] - d.start[0]) * nx + (raw[1] - d.start[1]) * ny) / step) * step;
        dragChange(() => { item.polygon[d.ei] = [r3(a[0] + nx * m), r3(a[1] + ny * m)]; item.polygon[(d.ei + 1) % d.orig.length] = [r3(b[0] + nx * m), r3(b[1] + ny * m)]; });
      } else if (d.mode === 'move' && (dx || dy || d.saved)) {
        if (S.sel.type === 'opening') {
          const o = openingOnWall(raw, planLevel().walls, dist(d.orig.a, d.orig.b), 1.5);
          if (o) dragChange(() => { item.a = o.a; item.b = o.b; });
        } else if (S.sel.type === 'wall') dragChange(() => { item.a = shift(d.orig.a); item.b = shift(d.orig.b); });
        else dragChange(() => { item.polygon = d.orig.polygon.map(shift); });
      }
      return;
    }
    const pd = S.pending;
    if (pd?.type === 'rect') pd.b = snap(raw, ev);
    else if (pd?.type === 'poly') pd.cur = snap(raw, ev, pd.pts[pd.pts.length - 1]);
    else if (pd?.type === 'wall') pd.b = snap(raw, ev, pd.a);
    S.hover = ['door', 'window', 'opening'].includes(S.tool) ? openingOnWall(raw, planLevel().walls, S.width[S.tool], Math.max(0.5, px(14))) : null;
    draw();
  }
  function onUp(ev) {
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
    const d = S.drag;
    S.drag = null;
    if (d?.saved) { refresh(); return; }
    const pd = S.pending;
    if (pd?.type === 'rect' && Math.hypot(ev.clientX - pd.sx, ev.clientY - pd.sy) > 5) finishRect(snap(planAt(ev), ev));
  }
  function onWheel(ev) {
    ev.preventDefault();
    const before = planAt(ev);
    S.view.s = Math.max(5, Math.min(400, S.view.s * Math.exp(-ev.deltaY * 0.0015)));
    const r = canvas.getBoundingClientRect();
    S.view.x = before[0] - (ev.clientX - r.left) / S.view.s;
    S.view.y = before[1] - (ev.clientY - r.top) / S.view.s;
    draw();
  }

  function finishRect(b) {
    const a = S.pending.a, level = cur(), stairs = S.tool === 'stairs';
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    S.pending = null;
    if (x1 - x0 < 0.3 || y1 - y0 < 0.3) { draw(); return; }
    const polygon = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    change(() => {
      if (stairs) { level.stairs.push({ id: nextItemId(S.draft, level.id, 's'), polygon }); S.sel = { type: 'stairs', i: level.stairs.length - 1 }; } else addRoom(polygon);
    });
  }
  function addRoom(polygon) {
    const level = cur();
    level.rooms.push({ id: nextItemId(S.draft, level.id, 'r'), name: `Room ${level.rooms.length + 1}`, polygon });
    S.sel = { type: 'room', i: level.rooms.length - 1 };
  }
  function finishPoly() {
    const pts = S.pending?.pts || [];
    S.pending = null;
    if (pts.length < 3 || polygonArea(pts) < 0.2) { draw(); return; }
    change(() => addRoom(pts));
  }

  function onKey(ev) {
    const typing = ev.target instanceof Element && ev.target.matches('input, select, textarea');
    const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (key === 'Escape') {
      if (typing) ev.target.blur();
      else if (S.pending || S.scale) { S.pending = null; S.scale = null; if (S.tool === 'scale') S.tool = 'select'; renderBar(); renderSide(); draw(); } else if (S.tool !== 'select') setTool('select');
      else close();
      return;
    }
    if (typing) return;
    if ((ev.ctrlKey || ev.metaKey) && key === 'z') { ev.preventDefault(); if (ev.shiftKey) jump(S.future, S.history); else jump(S.history, S.future); return; }
    if ((ev.ctrlKey || ev.metaKey) && key === 'y') { ev.preventDefault(); jump(S.future, S.history); return; }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.target instanceof Element && ev.target.closest('button, a') && (key === ' ' || key === 'Enter')) return;   // the key presses that button
    if (key === ' ') { ev.preventDefault(); S.space = true; return; }
    if (key === 'Enter' && S.pending?.type === 'poly') { finishPoly(); return; }
    if (key === 'Backspace' && S.pending?.type === 'poly') { S.pending.pts.pop(); if (!S.pending.pts.length) S.pending = null; draw(); return; }
    if ((key === 'Delete' || key === 'Backspace') && S.sel) { const h = S.sel; change(() => removeItem(h)); return; }
    if (key === 'f') { fit(); draw(); return; }
    const tool = TOOLS.find((t) => t[2].toLowerCase() === key);
    if (tool) setTool(tool[0]);
  }
  // One listener for the whole window, in the capture phase: while the panel is open no key
  // reaches the page behind it (where P is privacy mode and H hides the panels).
  window.addEventListener('keydown', (ev) => {
    if (isOpen()) { ev.stopPropagation(); onKey(ev); return; }
    const typing = ev.target instanceof Element && ev.target.matches('input, select, textarea');
    if (!typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey && ev.key.toLowerCase() === 'l') { ev.stopPropagation(); open(); }
  }, true);

  // ------------------------------------------------------------------ toolbar
  function renderBar() {
    if (panelDown) { barPending = true; return; }
    barPending = false;
    const opening = ['door', 'window', 'opening'].includes(S.tool);
    bar.innerHTML = `
      <div class="ls-tools">${TOOLS.map(([id, label, key, hint]) => `<button type="button" class="btn" data-tool="${id}" aria-pressed="${S.tool === id}" title="${esc(hint)}">${esc(label)}<kbd>${key}</kbd></button>`).join('')}</div>
      <div class="ls-opts">
        ${opening ? `<label>Width <input type="text" data-field="width" value="${S.width[S.tool]} m" size="6" aria-label="Width of the next ${S.tool}"></label>` : ''}
        ${S.tool === 'wall' ? `<label>Kind <select data-field="wall-kind" aria-label="Kind of the next wall">${[['auto', 'Automatic'], ['exterior', 'Exterior'], ['interior', 'Interior']].map(([v, l]) => `<option value="${v}" ${S.wallKind === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}
        <label>Grid <select data-field="snap" aria-label="Grid step">${[0.05, 0.1, 0.25, 0.5, 1].map((v) => `<option value="${v}" ${S.snap === v ? 'selected' : ''}>${v} m</option>`).join('')}</select></label>
        <button type="button" class="btn" data-act="undo" ${S.history.length ? '' : 'disabled'} title="Undo (Ctrl+Z)">Undo</button>
        <button type="button" class="btn" data-act="redo" ${S.future.length ? '' : 'disabled'} title="Redo (Ctrl+Y)">Redo</button>
        <button type="button" class="btn" data-act="fit" title="Show the whole floor (F)">Fit</button>
      </div>
      <div class="ls-end">
        <button type="button" class="btn" data-act="close" title="Back to the atlas. Your draft is kept. (Esc)">Close</button>
        <button type="button" class="btn primary" data-act="apply" ${S.preview?.errors.length || S.busy ? 'disabled' : ''} title="Check the plan, save it and show it in the atlas">Apply to the atlas</button>
      </div>`;
  }
  function onBarClick(ev) {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) setTool(b.dataset.tool);
    else act(b.dataset.act, b);
  }
  function onBarChange(ev) {
    const f = ev.target.dataset.field;
    if (f === 'snap') S.snap = Number(ev.target.value);
    else if (f === 'wall-kind') S.wallKind = ev.target.value;
    else if (f === 'width') { const m = parseLength(ev.target.value); if (m && m >= 0.3 && m <= 8) S.width[S.tool] = r3(m); else say('A width is a length such as 0.9 m or 3 ft.', 'warn'); }
    renderBar(); renderSide(); draw();
  }

  // ------------------------------------------------------------------ side panel
  function renderSide() {
    if (panelDown) { sidePending = true; return; }
    sidePending = false;
    clearTimeout(sideTimer);
    const focus = side.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    const scroll = side.scrollTop;
    const level = cur(), hidden = privacy();
    const elev = levelElevations(S.draft.levels);
    const where = S.server ? 'the folder data/user/ on this computer' : 'this browser';
    const u = level.underlay;
    const sel = S.sel ? level[listOf(S.sel.type)][S.sel.i] : null;
    const pv = S.preview;
    const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    const scanForm = () => {
      const st = S.scan.status;
      if (!S.server) return '<p class="hint warn">Scan import runs on the local server. Start the page with <span class="mono">node tools/serve.mjs</span>. The other ways work here.</p>';
      if (!st) return '<p class="hint">Looking for Python…</p>';
      if (!st.available) return `<p class="hint warn">${esc(st.why)}</p><p class="hint mono">${esc(st.setup)}</p>`;
      return `<p class="hint" style="margin-top:0">One row per floor. Pick the files Polycam exported for that floor: <span class="mono">floorplan.dxf</span> is needed; <span class="mono">floorplan.csv</span> (ceiling heights, compass) and <span class="mono">model.glb</span> (stairs) help. The files stay on this computer.</p>
        ${S.scan.rows.map((row, i) => `<div class="ls-scan-row">
          <select data-field="scan-kind" data-i="${i}" data-k="scan-kind-${i}" aria-label="Kind of floor">${Object.entries(LEVEL_KINDS).map(([k, v]) => `<option value="${k}" ${row.kind === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
          <input type="text" data-field="scan-name" data-i="${i}" data-k="scan-name-${i}" value="${esc(row.name)}" maxlength="40" aria-label="Name of the floor">
          <button type="button" class="btn" data-act="scan-files" data-i="${i}" data-k="scan-files-${i}">${row.files.length ? count(row.files.length, 'file') : 'Files…'}</button>
          ${S.scan.rows.length > 1 ? `<button type="button" class="btn x" data-act="scan-del" data-i="${i}" aria-label="Remove this floor">×</button>` : ''}
          ${row.files.length && !row.files.some((f) => /\.dxf$/i.test(f.name)) ? '<p class="hint warn">No .dxf file among them.</p>' : ''}
        </div>`).join('')}
        <div class="row"><button type="button" class="btn" data-act="scan-add" data-k="scan-add">Add a floor</button><button type="button" class="btn primary" data-act="scan-import" data-k="scan-import" ${S.scan.busy || !S.scan.rows.some((r) => r.files.some((f) => /\.dxf$/i.test(f.name))) ? 'disabled' : ''}>${S.scan.busy ? 'Importing…' : 'Import'}</button></div>`;
    };
    const selected = () => {
      if (!sel) return '<p class="hint" style="margin-top:0">Nothing is selected. With the Select tool, click a room, a wall, a door, a window or the stairs.</p>';
      if (S.sel.type === 'room') {
        return `<label class="ls-f">Name <input type="text" data-field="room-name" data-k="room-name" value="${esc(sel.name)}" maxlength="40"></label>
          <label class="ls-f">Ceiling <input type="text" data-field="room-height" data-k="room-height" value="${sel.ceilingHeight ? `${esc(sel.ceilingHeight)} m` : ''}" placeholder="as the floor: ${esc(level.height)} m"></label>
          <p class="hint">${polygonArea(sel.polygon).toFixed(1)} m² · ${sel.polygon.length} corners. Drag a corner or an edge to change the shape.</p>`;
      }
      if (S.sel.type === 'wall') {
        return `${level.derive ? `<label class="ls-f">Kind <select data-field="wall-kind-sel" data-k="wall-kind-sel">${[['auto', 'Automatic'], ['exterior', 'Exterior'], ['interior', 'Interior']].map(([v, l]) => `<option value="${v}" ${(sel.kind || 'auto') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : `<p class="hint" style="margin-top:0">Material: ${esc(materials.materials?.[sel.material]?.label || sel.material || 'interior wall')}</p>`}
          <p class="hint">${dist(sel.a, sel.b).toFixed(2)} m long.</p>`;
      }
      if (S.sel.type === 'opening') {
        return `<p class="hint" style="margin-top:0">${esc(sel.type[0].toUpperCase() + sel.type.slice(1))}, ${dist(sel.a, sel.b).toFixed(2)} m wide. Drag it along the wall.</p>
          ${sel.type === 'door' ? `<label class="ls-f">Door is <select data-field="door-state" data-k="door-state">${[['', 'as usual (inside open, outside closed)'], ['open', 'open'], ['closed', 'closed']].map(([v, l]) => `<option value="${v}" ${(sel.state || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}`;
      }
      return '<p class="hint" style="margin-top:0">Stairs. They join this floor to the next one up (or down, on the top floor).</p>';
    };
    side.innerHTML = `
      <div class="ls-head"><h1>Layout setup</h1><p class="hint">Make the atlas look like your house. Your layout is kept in ${where}, apart from everything else.${workspace === 'private' ? ' The private house on screen is not changed by this panel.' : ''}</p></div>
      <div class="sec"><h2>Start from</h2>
        <div class="ls-start">
          <button type="button" class="btn" data-act="scan-toggle" data-k="scan-toggle" aria-pressed="${S.scan.open}" title="Polycam floor-plan export: DXF, CSV, GLB">A scan export</button>
          <button type="button" class="btn" data-act="img-load" data-k="img-load" title="A picture or rendering of this floor, to trace over">A plan image</button>
          <button type="button" class="btn" data-act="new" data-k="new" title="Start with an empty grid">An empty grid</button>
          <button type="button" class="btn" data-act="open-file" data-k="open-file" title="A floorplan.json, or a draft saved from this panel">A plan file</button>
        </div>
        ${S.scan.open ? scanForm() : ''}
        <p class="hint">Want to look first? <button type="button" class="linklike" data-act="demo" data-k="demo">Open the demo house</button> in the editor.</p>
      </div>
      <div class="sec"><h2>House</h2>
        ${hidden ? '<p class="hint" style="margin-top:0">The name is hidden in privacy mode.</p>' : `<label class="ls-f">Name <input type="text" data-field="house-name" data-k="house-name" value="${esc(S.draft.name)}" maxlength="60"></label>`}
      </div>
      <div class="sec"><h2>Floors <small>${count(S.draft.levels.length, 'floor')}</small></h2>
        <div class="ls-levels">${S.draft.levels.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => `<button type="button" class="ls-level" data-act="level" data-i="${i}" data-k="level-${i}" aria-pressed="${i === S.li}"><b>${esc(l.name)}</b><span>${count(l.rooms.length, 'room')} · floor at ${elev[i] >= 0 ? '+' : ''}${elev[i].toFixed(2)} m</span></button>`).join('')}</div>
        <label class="ls-f">Name <input type="text" data-field="lvl-name" data-k="lvl-name" value="${esc(level.name)}" maxlength="40"></label>
        <label class="ls-f">Kind <select data-field="lvl-kind" data-k="lvl-kind" title="Decides the assumed materials: a basement has concrete outer walls">${Object.entries(LEVEL_KINDS).map(([k, v]) => `<option value="${k}" ${level.kind === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
        <label class="ls-f">Ceiling <input type="text" data-field="lvl-height" data-k="lvl-height" value="${esc(level.height)} m" title="Floor to ceiling. Metres, or feet such as 8 ft"></label>
        <div class="row"><button type="button" class="btn" data-act="level-above" data-k="level-above">Add floor above</button><button type="button" class="btn" data-act="level-below" data-k="level-below">Add floor below</button></div>
        <label class="ls-check"><input type="checkbox" data-field="copy-rooms" data-k="copy-rooms" ${S.copyRooms ? 'checked' : ''}> start the new floor as a copy of this one</label>
        <div class="row"><button type="button" class="btn" data-act="level-delete" data-k="level-delete" ${S.draft.levels.length > 1 ? '' : 'disabled'}>Delete this floor</button></div>
        ${level.derive ? '' : '<p class="hint">This floor was imported. Its walls and outline stay as imported; you can rename rooms and add or erase walls, doors, windows and stairs.</p>'}
      </div>
      <div class="sec"><h2>Plan image <small>${esc(level.name)}</small></h2>
        ${u ? `
          <p class="hint ${u.scaled ? '' : 'warn'}" style="margin-top:0">${u.scaled ? `Scale set: the image is ${(u.w * u.mPerPx).toFixed(1)} m wide.` : 'The scale is not set yet. The size on screen is a guess until you set it.'}</p>
          <div class="row"><button type="button" class="btn" data-act="img-scale" data-k="img-scale" aria-pressed="${S.tool === 'scale'}">Set scale</button><button type="button" class="btn" data-act="img-move" data-k="img-move" aria-pressed="${S.tool === 'image'}">Move</button><button type="button" class="btn" data-act="img-remove" data-k="img-remove">Remove</button></div>
          ${S.tool === 'scale' ? `<div class="ls-scale"><p class="hint" style="margin-top:0">${(S.scale?.pts.length || 0) < 2 ? `Click the two ends of a length you know (${S.scale?.pts.length || 0} of 2).` : 'How long is that in reality?'}</p>
            ${S.scale?.pts.length === 2 ? '<div class="row"><input type="text" data-field="scale-length" data-k="scale-length" placeholder="3.5 m or 11 ft 6 in" aria-label="Real length between the two points"><button type="button" class="btn primary" data-act="scale-set" data-k="scale-set">Set</button></div>' : ''}</div>` : ''}
          <div class="row"><span class="lbl">Opacity</span><input type="range" min="0.1" max="1" step="0.05" value="${esc(u.opacity)}" data-field="img-opacity" data-k="img-opacity" aria-label="Opacity of the image"></div>
          <label class="ls-check"><input type="checkbox" data-field="img-invert" data-k="img-invert" ${u.invert !== false ? 'checked' : ''}> dark image (invert a white plan)</label>
          ${hidden ? '<p class="hint">The image is hidden while privacy mode is on.</p>' : ''}`
    : '<p class="hint" style="margin-top:0">No image on this floor. Load a picture of the floor plan, set its scale with a length you know, then draw the rooms over it.</p><div class="row"><button type="button" class="btn" data-act="img-load" data-k="img-load-2">Load an image…</button></div>'}
      </div>
      <div class="sec"><h2>Selected</h2>${selected()}${sel ? '<div class="row"><button type="button" class="btn" data-act="sel-delete" data-k="sel-delete">Delete</button></div>' : ''}</div>
      <div class="sec"><h2>Check <small>${pv.errors.length ? count(pv.errors.length, 'error') : 'ready'}</small></h2>
        ${pv.errors.length ? `<ul class="ls-issues bad">${pv.errors.slice(0, 6).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>${pv.errors.length > 6 ? `<p class="hint">and ${pv.errors.length - 6} more</p>` : ''}` : `<p class="hint ok" style="margin-top:0">The plan is valid: ${count(pv.plan.levels.length, 'floor')}, ${count(pv.plan.levels.reduce((n, l) => n + l.rooms.length, 0), 'room')}, ${count(pv.plan.levels.reduce((n, l) => n + l.walls.length, 0), 'wall')}, ${count(pv.plan.levels.reduce((n, l) => n + l.openings.length, 0), 'opening')}.</p>`}
        ${pv.warnings.length ? `<ul class="ls-issues warn">${pv.warnings.slice(0, 5).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
        ${S.note ? `<p class="ls-note ${S.noteKind}" role="status">${esc(S.note)}</p>` : ''}
        <div class="row"><button type="button" class="btn primary" data-act="apply" data-k="apply" ${pv.errors.length || S.busy ? 'disabled' : ''}>Apply to the atlas</button><button type="button" class="btn" data-act="save" data-k="save" ${S.busy ? 'disabled' : ''} title="Keep the draft without showing it in the atlas">Save draft</button></div>
        <p class="hint">Materials are assumed from the kind of floor (data/materials.json). Access points are put in the largest rooms as a guess; move them with "Place access points".</p>
        <p class="hint"><button type="button" class="linklike" data-act="download" data-k="download">Download floorplan.json</button> · <button type="button" class="linklike" data-act="remove-layout" data-k="remove-layout">Remove my layout</button></p>
      </div>`;
    side.scrollTop = scroll;
    const again = focus ? side.querySelector(`[data-k="${focus}"]`) : null;
    if (again) again.focus(); else if (!root.contains(document.activeElement)) root.focus();
  }
  /** Rebuild the side panel after the browser has moved the focus (Tab from a text box). */
  const sideSoon = () => { clearTimeout(sideTimer); sideTimer = setTimeout(() => { renderBar(); renderSide(); }, 0); };

  function onSideClick(ev) {
    const b = ev.target.closest('button');
    if (b?.dataset.act) act(b.dataset.act, b);
  }
  function onSideInput(ev) {
    if (ev.target.dataset.field === 'img-opacity' && cur().underlay) { cur().underlay.opacity = Number(ev.target.value); draw(); }
  }
  // A changed field is applied a moment later, not inside the change event. On Tab the browser
  // moves the focus right after that event; rebuilding the panel before it would drop the focus.
  let fieldJob = null, fieldTimer = 0;
  function flushField() { clearTimeout(fieldTimer); const job = fieldJob; fieldJob = null; if (job) job(); }
  function onSideChange(ev) {
    const t = ev.target;
    if (!t.dataset.field) return;
    flushField();
    fieldJob = () => applyField(t);
    fieldTimer = setTimeout(flushField, 0);
  }
  function applyField(t) {
    const f = t.dataset.field, level = cur();
    const sel = S.sel ? level[listOf(S.sel.type)][S.sel.i] : null;
    const length = (min, max, what) => { const m = parseLength(t.value); if (m && m >= min && m <= max) return r3(m); say(`${what} is a length such as 2.4 m or 8 ft.`, 'warn'); return null; };
    say('');
    if (f === 'house-name') change(() => { S.draft.name = t.value.trim() || 'My house'; });
    else if (f === 'lvl-name') change(() => { level.name = t.value.trim() || `Floor ${level.id}`; });
    else if (f === 'lvl-kind') change(() => { if (level.height === LEVEL_KINDS[level.kind].height) level.height = LEVEL_KINDS[t.value].height; level.kind = t.value; if (!level.derive) delete level.floorMaterial; });
    else if (f === 'lvl-height') { const m = length(1.8, 8, 'A ceiling height'); if (m) change(() => { level.height = m; }); else sideSoon(); } else if (f === 'copy-rooms') S.copyRooms = t.checked;
    else if (f === 'room-name' && sel) change(() => { sel.name = t.value.trim() || 'Room'; sel.nameSource = 'confirmed'; });
    else if (f === 'room-height' && sel) { if (!t.value.trim()) change(() => { delete sel.ceilingHeight; }); else { const m = length(1.5, 15, 'A ceiling height'); if (m) change(() => { sel.ceilingHeight = m; sel.ceilingSource = 'measured'; }); else sideSoon(); } } else if (f === 'wall-kind-sel' && sel) change(() => { sel.kind = t.value; });
    else if (f === 'door-state' && sel) change(() => { if (t.value) sel.state = t.value; else delete sel.state; });
    else if (f === 'img-invert' && level.underlay) change(() => { level.underlay.invert = t.checked; });
    else if (f === 'img-opacity') { S.draft.saved = new Date().toISOString(); store.set(KEYS.draft, S.draft); } else if (f === 'scan-kind') { const row = S.scan.rows[Number(t.dataset.i)]; if (row.name === LEVEL_KINDS[row.kind].label || /floor$/i.test(row.name)) row.name = LEVEL_KINDS[t.value].label; row.kind = t.value; sideSoon(); } else if (f === 'scan-name') S.scan.rows[Number(t.dataset.i)].name = t.value.trim() || 'Floor';
  }

  // ------------------------------------------------------------------ actions
  function useDraft(draft, note) {
    change(() => { S.draft = draft; S.li = Math.max(0, draft.levels.findIndex((l) => l.kind === 'main')); S.sel = null; S.pending = null; });
    fit(); say(note, 'ok'); renderSide(); draw();
  }
  async function act(name, b) {
    flushField();          // a field that was just left is applied before the button acts
    const level = cur();
    say('');
    if (name === 'close') close();
    else if (name === 'undo') jump(S.history, S.future);
    else if (name === 'redo') jump(S.future, S.history);
    else if (name === 'fit') { fit(); draw(); } else if (name === 'apply') await apply();
    else if (name === 'save') await save(false);
    else if (name === 'level') { S.li = Number(b.dataset.i); S.sel = null; S.pending = null; S.scale = null; fit(); renderSide(); draw(); } else if (name === 'level-above' || name === 'level-below') {
      change(() => { const made = addLevel(S.draft, name === 'level-above' ? 'above' : 'below', S.copyRooms ? level.id : null); S.li = S.draft.levels.indexOf(made); S.sel = null; });
      fit(); draw();
    } else if (name === 'level-delete' && S.draft.levels.length > 1) change(() => { S.draft.levels.splice(S.li, 1); S.li = Math.min(S.li, S.draft.levels.length - 1); S.sel = null; });
    else if (name === 'sel-delete' && S.sel) { const h = S.sel; change(() => removeItem(h)); } else if (name === 'new') useDraft(newDraft(S.draft.name), 'An empty grid. Choose Room in the bar above and drag your first room.');
    else if (name === 'demo') {
      const r = await api('GET', 'data/synthetic/floorplan.json');
      if (r.data) useDraft(floorplanToDraft(r.data), 'The demo house is in the editor. It is a made-up layout.');
    } else if (name === 'open-file') await openFile();
    else if (name === 'img-load') await loadImage();
    else if (name === 'img-scale') { S.tool = 'scale'; S.scale = { pts: [] }; S.pending = null; renderBar(); renderSide(); draw(); } else if (name === 'img-move') setTool(S.tool === 'image' ? 'select' : 'image');
    else if (name === 'img-remove') change(() => { level.underlay = null; });     // the stored picture goes at the next save, so undo can bring it back
    else if (name === 'scale-set') setScale();
    else if (name === 'scan-toggle') {
      S.scan.open = !S.scan.open;
      renderSide();
      if (S.scan.open && S.server && !S.scan.status) { const r = await api('GET', '/api/layout/scan-status'); S.scan.status = r.data || { available: false, why: 'The local server did not answer.', setup: '' }; renderSide(); }
    } else if (name === 'scan-add') { const kind = S.scan.rows.some((r) => r.kind === 'main') ? 'upper' : 'main'; S.scan.rows.push({ kind, name: LEVEL_KINDS[kind].label, files: [] }); renderSide(); } else if (name === 'scan-del') { S.scan.rows.splice(Number(b.dataset.i), 1); renderSide(); } else if (name === 'scan-files') {
      const files = await pickFiles('.dxf,.csv,.glb,.png', true);
      if (files.length) S.scan.rows[Number(b.dataset.i)].files = files;
      renderSide();
    } else if (name === 'scan-import') await importScan();
    else if (name === 'download') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(S.preview.plan, null, 1) + '\n'], { type: 'application/json' }));
      a.download = 'floorplan.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } else if (name === 'remove-layout') {
      if (!window.confirm('Remove your layout? The saved plan, the draft, the plan images, the places of the access points and the uploaded scan files are deleted. Network and device settings are kept. This cannot be undone.')) return;
      if (S.server) await api('DELETE', '/api/layout');
      store.del(KEYS.layout); store.del(KEYS.draft);
      for (const l of S.draft.levels) store.del(KEYS.image + l.id);
      const q = new URLSearchParams(location.search);
      q.delete('layout');
      location.assign(`${location.pathname}${q.size ? `?${q}` : ''}`);
    }
  }

  async function openFile() {
    const [file] = await pickFiles('.json,application/json');
    if (!file) return;
    let data;
    try { data = JSON.parse((await file.text()).replace(/^﻿/, '')); } catch { say('That file is not JSON.', 'bad'); renderSide(); return; }
    if (isDraft(data)) {
      const draft = normalizeDraft(data);
      if (!draft) { say('That draft holds no floor this version can read.', 'bad'); renderSide(); return; }
      for (const l of draft.levels) l.underlay = null;     // the picture is not part of the file
      useDraft(draft, 'The draft is open.');
      return;
    }
    const issues = validateFloorplan(data, schema, materials);
    if (issues.errors.length) { say(`That file is not a floor plan this version can read. ${formatIssues(issues.errors).slice(0, 3).join(' ')}`, 'bad'); renderSide(); return; }
    useDraft(floorplanToDraft(data), `The plan is open: ${data.levels.length} floor${data.levels.length === 1 ? '' : 's'}.`);
  }

  async function loadImage() {
    const [file] = await pickFiles('image/png,image/jpeg,image/webp');
    if (!file) return;
    const level = cur(), url = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(url); say('This browser cannot read that picture. Use PNG, JPEG or WebP.', 'bad'); renderSide(); };
    img.onload = () => {
      // The picture is drawn again and stored as that copy: smaller, and without the camera data of the file.
      const k = Math.min(1, 2600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL('image/jpeg', 0.85);
      const copy = new Image();
      copy.onload = () => {
        const key = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        S.images.set(key, { img: copy, dataUrl });
        change(() => { level.underlay = { key, w: c.width, h: c.height, mPerPx: r3(14 / c.width * 1000) / 1000, scaled: false, x: 0, y: 0, opacity: 0.55, invert: true }; });
        S.tool = 'scale'; S.scale = { pts: [] };
        fit(); say('The image is loaded. Now set its scale: click the two ends of a length you know.', 'ok'); renderBar(); renderSide(); draw();
      };
      copy.src = dataUrl;
    };
    img.src = url;
  }
  function setScale() {
    const u = cur().underlay, input = side.querySelector('[data-field="scale-length"]');
    const m = parseLength(input?.value);
    if (!u || !S.scale || S.scale.pts.length < 2) return;
    const [p, q] = S.scale.pts;
    if (!m || dist(p, q) < 1e-6) { say('Type the real length between the two points, such as 3.5 m or 11 ft 6 in.', 'warn'); renderSide(); return; }
    const next = m / (dist(p, q) / u.mPerPx);
    change(() => {
      // the first point stays where it is on screen; everything else grows or shrinks around it
      u.x = r3(p[0] - ((p[0] - u.x) / u.mPerPx) * next); u.y = r3(p[1] - ((p[1] - u.y) / u.mPerPx) * next);
      u.mPerPx = next; u.scaled = true;
    });
    S.scale = null; S.tool = 'rect';
    fit(); say(`Scale set: the image is ${(u.w * u.mPerPx).toFixed(1)} m wide. Now draw the rooms over it.`, 'ok'); renderBar(); renderSide(); draw();
  }

  async function importScan() {
    const rows = S.scan.rows.filter((r) => r.files.some((f) => /\.dxf$/i.test(f.name)));
    if (!rows.length || S.scan.busy) return;
    S.scan.busy = true; say('Sending the files to the local server…'); renderSide();
    const order = { basement: 0, main: 1, upper: 2 };
    const sorted = [...rows].sort((a, b) => order[a.kind] - order[b.kind]);
    const made = [];
    const levels = sorted.map((row, i) => { const id = nextLevelId(made, row.kind === 'basement' ? 'below' : 'above'); made.push({ id }); return { key: `floor-${i + 1}`, id, name: row.name, construction: row.kind, row }; });
    const anchor = levels.find((l) => l.construction === 'main') || levels[0];
    let failed = '';
    await api('DELETE', '/api/layout/scan');     // files of an earlier import must not be mixed into this one
    for (const l of levels) {
      for (const file of l.row.files) {
        const name = /\.dxf$/i.test(file.name) ? 'floorplan.dxf' : /\.csv$/i.test(file.name) ? 'floorplan.csv' : /\.glb$/i.test(file.name) ? 'model.glb' : /\.png$/i.test(file.name) ? 'floorplan.png' : null;
        if (!name) continue;
        const r = await api('PUT', `/api/layout/scan-file?level=${l.key}&name=${name}`, file, true);
        if (r.status !== 200) failed = r.data?.error || 'A file could not be sent.';
      }
    }
    const r = failed ? { status: 0, data: { error: failed } } : await api('POST', '/api/layout/import-scan', { levels: levels.map((l) => ({ key: l.key, id: l.id, name: l.name, construction: l.construction, anchor: l === anchor })) });
    S.scan.busy = false;
    if (r.status !== 200 || !r.data?.plan) { say(`${r.data?.error || 'The import did not work.'}${r.data?.detail ? ` (${r.data.detail.split('\n').pop()})` : ''}`, 'bad'); renderSide(); return; }
    const draft = floorplanToDraft(r.data.plan);
    draft.name = S.draft.name;
    if (r.data.site) draft.site = r.data.site;
    S.scan.open = false;
    useDraft(draft, `Imported ${draft.levels.length} floor${draft.levels.length === 1 ? '' : 's'}. Check the rooms and names, then apply.${r.data.warnings?.length ? ` The importer had ${r.data.warnings.length} remark${r.data.warnings.length === 1 ? '' : 's'}: ${r.data.warnings[0]}` : ''}`);
  }

  /** Save the draft (and the plan, when apply is true). The local server first, else this browser. */
  async function save(withPlan) {
    S.busy = true; renderBar();
    let where = '';
    const stop = (text) => { S.busy = false; say(text, 'bad'); renderBar(); renderSide(); return false; };
    if (S.server) {
      for (const level of S.draft.levels) {
        const u = level.underlay, pic = u ? S.images.get(u.key) : null;
        if (!u || !pic?.dataUrl || S.onServer.get(level.id) === u.key) continue;
        const r = await api('PUT', `/api/layout/underlay?level=${encodeURIComponent(level.id)}`, { dataUrl: pic.dataUrl });
        if (r.status === 200) S.onServer.set(level.id, u.key); else say('A plan image could not be saved. The plan itself is saved without it.', 'warn');
      }
      for (const id of [...S.onServer.keys()]) {
        if (S.draft.levels.some((l) => l.id === id && l.underlay)) continue;
        await api('DELETE', `/api/layout/underlay?level=${encodeURIComponent(id)}`);      // its floor or its picture was removed
        S.onServer.delete(id);
      }
      const r = await api('PUT', '/api/layout', { draft: S.draft, ...(withPlan ? { plan: S.preview.plan, ...(S.draft.site ? { site: S.draft.site } : {}) } : {}) });
      // the server is there, so a failure is said as a failure; it is not papered over with a copy in the browser
      if (r.status !== 200 || !r.data?.ok) return stop(`The local server did not save it. ${r.data?.error || (r.status ? `It answered ${r.status}.` : 'It did not answer.')} ${(r.data?.errors || []).slice(0, 2).join(' ')}`);
      where = 'data/user/';
      if (withPlan) store.del(KEYS.layout);
    } else {
      const kept = store.set(KEYS.draft, S.draft) && (!withPlan || store.set(KEYS.layout, { plan: S.preview.plan, config: { private: { houseName: S.preview.plan.name }, ...(S.draft.site ? { site: S.draft.site } : {}) } }));
      if (!kept) return stop('Nothing could be saved: there is no local server and this browser gives no storage. Use "Download floorplan.json".');
      for (const level of S.draft.levels) {
        const pic = level.underlay ? S.images.get(level.underlay.key) : null;
        if (!pic?.dataUrl) store.del(KEYS.image + level.id);
        else if (!store.set(KEYS.image + level.id, pic.dataUrl)) say('The plan image is too large for this browser\'s storage and was not kept.', 'warn');
      }
      where = 'this browser';
    }
    S.busy = false;
    if (!S.note) say(`Saved to ${where} at ${new Date().toLocaleTimeString([], { hour12: false })}.`, 'ok');
    renderBar(); renderSide();
    return true;
  }
  async function apply() {
    S.preview = check();
    if (S.preview.errors.length) { say('The plan still has errors. They are listed above.', 'bad'); renderSide(); return; }
    if (!(await save(true))) return;
    const q = new URLSearchParams(location.search);
    q.delete('demo'); q.set('layout', 'user');
    location.assign(`${location.pathname}?${q}`);
  }

  // a handle for the verification tools
  window.__layoutSetup = {
    open, close, setTool, apply, fit: () => { fit(); draw(); },
    get state() { return S; }, get isOpen() { return isOpen(); },
    /** Where a plan point is on the screen, in page pixels. */
    toScreen(x, y) { const r = canvas.getBoundingClientRect(); return { x: r.left + (x - S.view.x) * S.view.s, y: r.top + (y - S.view.y) * S.view.s }; },
  };
  return { open, close };
}
