// A layout that a user makes for their own house (docs/custom-layout.md).
//
// The Layout setup panel works on a "draft": floors with rooms, extra walls,
// openings and stairs, as a person draws them. This file turns a draft into a
// floorplan.json that follows docs/data-contract.md, and back. It also holds the
// rules for the user workspace (data/user/), which is kept apart from data/private/.
//
// Pure functions: browser and Node.

import { dist, pointInPolygon, polygonArea, signedArea, findHostWall, projectOnSegment, interiorPoint, sortedLevels } from './geometry.js';
import { mergeConfig } from './config.js';

export const DRAFT_VERSION = 1;
/** Everything a user makes is under this folder. Nothing here is ever read from data/private/. */
export const USER_PATHS = {
  floorplan: 'data/user/floorplan.json', draft: 'data/user/layout-draft.json', config: 'data/user/config.user.json',
  apPositions: 'data/user/ap-positions.json', nodes: 'data/user/nodes.json',
};
/** Kinds of floor. Each is a key of construction.levels in data/materials.json. */
export const LEVEL_KINDS = { basement: { label: 'Basement', height: 2.4 }, main: { label: 'Main floor', height: 2.7 }, upper: { label: 'Upper floor', height: 2.44 } };
const FLOOR_STRUCTURE_M = 0.3;
const FALLBACK_RULES = { exteriorWall: 'ext-siding', interiorWall: 'int-drywall', window: 'glass-lowe', doorInterior: 'door-hollow', doorExterior: 'door-exterior', floorUnder: 'floor-wood' };

const r3 = (v) => Math.round(v * 1000) / 1000;
const pt = (p) => [r3(p[0]), r3(p[1])];
const vkey = (p) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * A length that a person typed, in metres, or null. Accepts 3.5, "3,5 m", "350 cm",
 * "12 ft", "12' 6\"" and "150 in". A bare number is metres.
 */
export function parseLength(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/,/g, '.').replace(/[′’]/g, "'").replace(/[″”]/g, '"');
  const pos = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  let m;
  if ((m = /^(\d+(?:\.\d+)?)\s*(?:m|meters?|metres?)?$/.exec(s))) return pos(Number(m[1]));
  if ((m = /^(\d+(?:\.\d+)?)\s*cm$/.exec(s))) return pos(Number(m[1]) / 100);
  if ((m = /^(\d+(?:\.\d+)?)\s*mm$/.exec(s))) return pos(Number(m[1]) / 1000);
  if ((m = /^(?:(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|'))?\s*(?:(\d+(?:\.\d+)?)\s*(?:in|inch|inches|"))?$/.exec(s)) && (m[1] || m[2])) {
    return pos(Number(m[1] || 0) * 0.3048 + Number(m[2] || 0) * 0.0254);
  }
  return null;
}

// ---------------------------------------------------------------------------
// the draft
// ---------------------------------------------------------------------------

export function newLevel(id, kind = 'main', name = null) {
  return { id, name: name || LEVEL_KINDS[kind].label, kind, height: LEVEL_KINDS[kind].height, derive: true, rooms: [], walls: [], openings: [], stairs: [], underlay: null };
}

export function newDraft(name = 'My house') {
  return { version: DRAFT_VERSION, name, levels: [newLevel('1', 'main', 'First floor')] };
}

/** A level id that is not in use: 2, 3, ... going up and B, B2, ... going down. */
export function nextLevelId(levels, where) {
  const used = new Set(levels.map((l) => l.id));
  if (where === 'below') { for (let i = 1; ; i++) { const id = i === 1 ? 'B' : `B${i}`; if (!used.has(id)) return id; } }
  for (let i = 1; ; i++) if (!used.has(String(i))) return String(i);
}

/**
 * Add a floor above the top one or below the bottom one. With copyFrom (a level id) the
 * new floor starts as a copy of that floor's rooms and walls, without its doors and windows.
 */
export function addLevel(draft, where, copyFrom = null) {
  const id = nextLevelId(draft.levels, where);
  const kind = where === 'below' ? 'basement' : draft.levels.some((l) => l.kind === 'main') ? 'upper' : 'main';
  const names = { basement: 'Basement', main: 'First floor', upper: ['Second floor', 'Third floor', 'Fourth floor'][draft.levels.filter((l) => l.kind === 'upper').length] || `Floor ${id}` };
  const level = newLevel(id, kind, names[kind]);
  const src = copyFrom ? draft.levels.find((l) => l.id === copyFrom) : null;
  if (src) {
    level.rooms = src.rooms.map((r, i) => ({ id: `${id}-r${i + 1}`, name: r.name, polygon: clone(r.polygon) }));
    if (src.derive) level.walls = clone(src.walls);
    else { level.derive = false; level.walls = clone(src.walls); level.outline = clone(src.outline); }
  }
  if (where === 'below') draft.levels.unshift(level); else draft.levels.push(level);
  return level;
}

/** An id for a new room or stair on a level that no other item of the draft uses. */
export function nextItemId(draft, levelId, prefix) {
  const used = new Set();
  for (const l of draft.levels) for (const list of [l.rooms, l.stairs]) for (const it of list || []) used.add(it.id);
  for (let i = 1; ; i++) { const id = `${levelId}-${prefix}${i}`; if (!used.has(id)) return id; }
}

/** Floor heights above the main floor, lowest level first. Imported levels keep their own. */
export function levelElevations(levels) {
  const n = levels.length;
  const out = new Array(n).fill(0);
  if (!n) return out;
  let g = levels.findIndex((l) => l.kind !== 'basement');
  if (g < 0) g = n - 1;
  const own = (l) => (Number.isFinite(l.elevation) ? l.elevation : null);
  out[g] = own(levels[g]) ?? 0;
  for (let i = g + 1; i < n; i++) out[i] = own(levels[i]) ?? r3(out[i - 1] + levels[i - 1].height + FLOOR_STRUCTURE_M);
  for (let i = g - 1; i >= 0; i--) out[i] = own(levels[i]) ?? r3(out[i + 1] - levels[i].height - FLOOR_STRUCTURE_M);
  return out;
}

// ---------------------------------------------------------------------------
// rooms -> walls and outline
// ---------------------------------------------------------------------------

function crossingT(s, o) {
  const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], ex = o.b[0] - o.a[0], ey = o.b[1] - o.a[1];
  const d = dx * ey - dy * ex;
  if (Math.abs(d) < 1e-9) return null;
  const t = ((o.a[0] - s.a[0]) * ey - (o.a[1] - s.a[1]) * ex) / d;
  const u = ((o.a[0] - s.a[0]) * dy - (o.a[1] - s.a[1]) * dx) / d;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 ? t : null;
}

/**
 * Cut every segment where another one touches or crosses it, and drop doubles.
 * segs: [{ a, b, ... }]. Returns [{ a, b, from: [indices of the segments this piece lies on] }].
 */
export function splitSegments(segs) {
  const pieces = new Map();
  segs.forEach((s, i) => {
    const len = dist(s.a, s.b);
    if (len < 1e-3) return;
    const ts = [0, 1];
    segs.forEach((o, j) => {
      if (i === j) return;
      for (const p of [o.a, o.b]) { const pr = projectOnSegment(p, s.a, s.b); if (pr.off < 1e-3 && pr.t > 1e-6 && pr.t < 1 - 1e-6) ts.push(pr.t); }
      const x = crossingT(s, o);
      if (x != null) ts.push(x);
    });
    ts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < ts.length; k++) {
      if ((ts[k + 1] - ts[k]) * len < 1e-3) continue;
      const a = pt([s.a[0] + (s.b[0] - s.a[0]) * ts[k], s.a[1] + (s.b[1] - s.a[1]) * ts[k]]);
      const b = pt([s.a[0] + (s.b[0] - s.a[0]) * ts[k + 1], s.a[1] + (s.b[1] - s.a[1]) * ts[k + 1]]);
      const ka = vkey(a), kb = vkey(b);
      if (ka === kb) continue;
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (pieces.has(key)) pieces.get(key).from.push(i); else pieces.set(key, { a, b, from: [i] });
    }
  });
  return [...pieces.values()];
}

/** Join pieces that lie end to end on one line and are alike (same material and kind). */
function mergeCollinear(pieces) {
  const groups = new Map();
  for (const p of pieces) {
    let dx = p.b[0] - p.a[0], dy = p.b[1] - p.a[1];
    const len = Math.hypot(dx, dy);
    dx /= len; dy /= len;
    if (dx < -1e-9 || (Math.abs(dx) < 1e-9 && dy < 0)) { dx = -dx; dy = -dy; }
    const key = `${p.material}|${p.kind}|${Math.round((Math.atan2(dy, dx) * 1800) / Math.PI)}|${Math.round((p.a[1] * dx - p.a[0] * dy) * 200)}`;
    const sa = p.a[0] * dx + p.a[1] * dy, sb = p.b[0] * dx + p.b[1] * dy;
    const run = sa <= sb ? { s0: sa, s1: sb, a: p.a, b: p.b } : { s0: sb, s1: sa, a: p.b, b: p.a };
    if (!groups.has(key)) groups.set(key, { like: p, runs: [] });
    groups.get(key).runs.push(run);
  }
  const out = [];
  for (const { like, runs } of groups.values()) {
    runs.sort((p, q) => p.s0 - q.s0);
    let cur = runs[0];
    const flush = () => out.push({ a: cur.a, b: cur.b, material: like.material, kind: like.kind });
    for (let i = 1; i < runs.length; i++) {
      if (runs[i].s0 <= cur.s1 + 2e-3) { if (runs[i].s1 > cur.s1) cur = { ...cur, s1: runs[i].s1, b: runs[i].b }; } else { flush(); cur = runs[i]; }
    }
    flush();
  }
  return out;
}

function dropStraight(loop) {
  const out = [];
  for (let i = 0; i < loop.length; i++) {
    const p = loop[(i + loop.length - 1) % loop.length], q = loop[i], r = loop[(i + 1) % loop.length];
    const cross = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    if (Math.abs(cross) > 1e-6) out.push(q);
  }
  return out;
}

/** Closed loops made of the given pieces (each piece is used once). */
function traceLoops(pieces) {
  const at = new Map();
  pieces.forEach((p, i) => { for (const k of [vkey(p.a), vkey(p.b)]) { if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
  const used = new Array(pieces.length).fill(false);
  const loops = [];
  for (let start = 0; start < pieces.length; start++) {
    if (used[start]) continue;
    const loop = [pieces[start].a];
    let here = pieces[start].b, cur = start;
    used[start] = true;
    for (let guard = 0; guard < pieces.length + 2; guard++) {
      if (vkey(here) === vkey(loop[0])) break;
      loop.push(here);
      const next = (at.get(vkey(here)) || []).find((i) => !used[i] && i !== cur);
      if (next === undefined) break;                    // an open chain: not a loop
      used[next] = true;
      cur = next;
      here = vkey(pieces[next].a) === vkey(here) ? pieces[next].b : pieces[next].a;
    }
    if (vkey(here) === vkey(loop[0]) && loop.length >= 3) loops.push(loop);
  }
  // Two rooms that meet at one corner give two loops with that corner in common. They are one
  // outline that passes the corner twice: join them there, both running the same way round.
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < loops.length && !again; i++) {
      for (let j = i + 1; j < loops.length && !again; j++) {
        const keys = new Map(loops[i].map((p, k) => [vkey(p), k]));
        const at2 = loops[j].findIndex((p) => keys.has(vkey(p)));
        if (at2 < 0) continue;
        const at1 = keys.get(vkey(loops[j][at2]));
        let other = [...loops[j].slice(at2), ...loops[j].slice(0, at2)];
        if (signedArea(other) * signedArea(loops[i]) < 0) other = [other[0], ...other.slice(1).reverse()];
        loops[i] = [...loops[i].slice(0, at1), ...other, ...loops[i].slice(at1)];
        loops.splice(j, 1);
        again = true;
      }
    }
  }
  return loops.map(dropStraight).filter((l) => l.length >= 3);
}

export function convexHull(points) {
  const pts = [...new Map(points.map((p) => [vkey(p), p])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => { const h = []; for (const p of list) { while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop(); h.push(p); } h.pop(); return h; };
  return [...half(pts), ...half([...pts].reverse())];
}

/**
 * Walls and outline of a drawn floor.
 * rooms: [{ polygon }], extra: [{ a, b, kind?, material? }] (walls drawn by hand).
 * Returns { walls: [{ a, b, material, kind }], outline, warnings }.
 * An edge with a room on one side is an exterior wall; an edge between two rooms is interior.
 */
export function wallsFromRooms(rooms, extra, rules, levelName = 'this floor') {
  const warnings = [];
  const segs = [];
  rooms.forEach((room, ri) => room.polygon.forEach((p, i) => segs.push({ a: p, b: room.polygon[(i + 1) % room.polygon.length], room: ri })));
  const roomSegs = segs.length;
  for (const w of extra) segs.push({ a: w.a, b: w.b, wall: w });
  const inRoom = (x, y) => rooms.some((r) => pointInPolygon(x, y, r.polygon));

  const pieces = [];
  const boundary = [];
  for (const piece of splitSegments(segs)) {
    const mx = (piece.a[0] + piece.b[0]) / 2, my = (piece.a[1] + piece.b[1]) / 2;
    const len = dist(piece.a, piece.b);
    const nx = (-(piece.b[1] - piece.a[1]) / len) * 0.03, ny = ((piece.b[0] - piece.a[0]) / len) * 0.03;
    const left = inRoom(mx + nx, my + ny), right = inRoom(mx - nx, my - ny);
    const onRoomEdge = piece.from.some((i) => i < roomSegs);
    const own = piece.from.map((i) => segs[i].wall).find((w) => w);
    let kind = left && right ? 'interior' : 'exterior';
    if (onRoomEdge && left !== right) boundary.push(piece);
    if (own && (own.kind === 'interior' || own.kind === 'exterior')) kind = own.kind;
    pieces.push({ a: piece.a, b: piece.b, kind, material: own?.material || (kind === 'exterior' ? rules.exteriorWall : rules.interiorWall) });
  }

  let outline = null;
  if (rooms.length) {
    const loops = traceLoops(boundary).sort((p, q) => polygonArea(q) - polygonArea(p));
    outline = loops[0] || null;
    const apart = outline ? rooms.filter((r) => { const c = interiorPoint(r.polygon, 0.25); return !pointInPolygon(c[0], c[1], outline); }) : rooms;
    if (!outline || apart.length) {
      outline = convexHull(rooms.flatMap((r) => r.polygon)).map(pt);
      warnings.push(`The rooms of ${levelName} do not touch each other, so its outline is drawn around all of them. Move the rooms together, or draw the space between them as a room.`);
    }
  } else if (extra.length) {
    outline = convexHull(extra.flatMap((w) => [w.a, w.b])).map(pt);
    if (outline.length >= 3) warnings.push(`${levelName} has walls but no rooms. Its outline is drawn around the walls. Draw rooms to get room names and room grades.`);
  }
  return { walls: mergeCollinear(pieces), outline: outline && outline.length >= 3 ? outline : null, warnings };
}

/**
 * Where a door or window of the given width lands on the nearest wall.
 * Returns { a, b, wall } (wall = index) or null when no wall is within reach.
 */
export function openingOnWall(point, walls, width, reach = 0.5) {
  let best = -1, bestOff = reach, bestT = 0;
  walls.forEach((w, i) => {
    const pr = projectOnSegment(point, w.a, w.b);
    if (pr.len < 0.3 || pr.t < -0.02 || pr.t > 1.02 || pr.off > bestOff) return;
    best = i; bestOff = pr.off; bestT = pr.t;
  });
  if (best < 0) return null;
  const w = walls[best];
  const len = dist(w.a, w.b);
  const wd = Math.min(width, len - 0.1);
  if (wd < 0.2) return null;
  const centre = Math.max(wd / 2 + 0.05, Math.min(len - wd / 2 - 0.05, bestT * len));
  const ux = (w.b[0] - w.a[0]) / len, uy = (w.b[1] - w.a[1]) / len;
  return { a: pt([w.a[0] + ux * (centre - wd / 2), w.a[1] + uy * (centre - wd / 2)]), b: pt([w.a[0] + ux * (centre + wd / 2), w.a[1] + uy * (centre + wd / 2)]), wall: best };
}

// ---------------------------------------------------------------------------
// draft -> floorplan.json
// ---------------------------------------------------------------------------

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined && obj[k] !== null).map((k) => [k, obj[k]]));
const ROOM_KEYS = ['id', 'name', 'nameSource', 'nameReason', 'sourceLabel', 'ceilingHeight', 'ceilingHeightMax', 'ceilingSource', 'polygon'];
const WALL_KEYS = ['a', 'b', 'material', 'thickness', 'origin', 'note'];
const OPENING_KEYS = ['id', 'type', 'a', 'b', 'material', 'state', 'thickness', 'note'];
const FIXTURE_KEYS = ['type', 'name', 'material', 'polygon', 'note'];

function rulesFor(kind, materialsFile) {
  const c = materialsFile?.construction;
  return { ...FALLBACK_RULES, interiorDoorState: c?.interiorDoorState || 'open', exteriorDoorState: c?.exteriorDoorState || 'closed', ...(c?.levels?.[kind] || c?.levels?.main || {}) };
}

/**
 * Turn a draft into a floor plan. Returns { plan, warnings: [text] }.
 * The plan still has to pass validateFloorplan: a floor without any room or wall
 * gives a plan that fails there with a readable message.
 */
export function draftToFloorplan(draft, materialsFile) {
  const warnings = [];
  const elevations = levelElevations(draft.levels);
  const ids = draft.levels.map((l) => l.id);
  const seenIds = new Set();
  const unique = (id) => { let out = id, n = 2; while (seenIds.has(out)) out = `${id}-${n++}`; seenIds.add(out); return out; };

  const levels = draft.levels.map((level, li) => {
    const rules = rulesFor(level.kind, materialsFile);
    const where = `"${level.name}"`;
    const rooms = [];
    for (const room of level.rooms || []) {
      const polygon = (room.polygon || []).map(pt);
      if (polygon.length < 3 || polygonArea(polygon) < 0.2) { warnings.push(`A room of ${where} is smaller than 0.2 square metres and was left out.`); continue; }
      const name = String(room.name || '').trim() || 'Room';
      rooms.push({ ...pick(room, ROOM_KEYS), id: unique(room.id || `${level.id}-room`), name, nameSource: room.nameSource || 'confirmed', polygon });
    }

    let walls, outline;
    if (level.derive) {
      const made = wallsFromRooms(rooms, (level.walls || []).filter((w) => dist(w.a, w.b) >= 0.05), rules, where);
      walls = made.walls; outline = made.outline;
      warnings.push(...made.warnings);
    } else {
      const exterior = (m) => m === rules.exteriorWall || /^ext-|^concrete$/.test(m || '');
      walls = (level.walls || []).filter((w) => dist(w.a, w.b) >= 0.01).map((w) => {
        const material = w.material || (w.kind === 'exterior' ? rules.exteriorWall : rules.interiorWall);
        return { ...pick(w, WALL_KEYS), a: pt(w.a), b: pt(w.b), material, kind: exterior(material) ? 'exterior' : 'interior' };
      });
      outline = (level.outline || []).map(pt);
    }

    const openings = [];
    for (const op of level.openings || []) {
      const host = findHostWall(op, walls);
      if (host < 0) { warnings.push(`A ${op.type} of ${where} is no longer on a wall and was left out.`); continue; }
      const outside = walls[host].kind === 'exterior';
      const material = op.material || (op.type === 'window' ? rules.window : op.type === 'door' ? (outside ? rules.doorExterior : rules.doorInterior) : 'open');
      const out = { ...pick(op, OPENING_KEYS), type: op.type, a: pt(op.a), b: pt(op.b), material };
      if (op.type === 'door') out.state = op.state || (outside ? rules.exteriorDoorState : rules.interiorDoorState);
      else delete out.state;
      openings.push(out);
    }

    const stairs = [];
    for (const st of level.stairs || []) {
      let connects = (st.connects || []).filter((id) => ids.includes(id) && id !== level.id);
      if (!connects.length) connects = li + 1 < ids.length ? [ids[li + 1]] : li > 0 ? [ids[li - 1]] : [];
      if (!connects.length) { warnings.push(`The stairs of ${where} lead nowhere, because there is only one floor. They were left out.`); continue; }
      stairs.push({ id: st.id || `${level.id}-stairs`, polygon: st.polygon.map(pt), connects, ...(st.note ? { note: st.note } : {}) });
    }

    const out = {
      id: level.id, name: String(level.name || '').trim() || `Floor ${level.id}`, elevation: elevations[li], height: level.height,
      source: level.source || (level.underlay?.scaled ? 'image-trace' : 'drawn'),
      floorMaterial: level.floorMaterial || rules.floorUnder,
      ...(level.note ? { note: level.note } : {}),
      outline: outline || [], rooms,
      walls: walls.map((w) => pick(w, WALL_KEYS)), openings, stairs,
    };
    const fixtures = (level.fixtures || []).map((f) => pick(f, FIXTURE_KEYS));
    if (fixtures.length) out.fixtures = fixtures;
    return out;
  });

  const plan = { schemaVersion: 1, name: String(draft.name || '').trim() || 'My house', units: 'm', note: 'Made in the Layout setup panel of Signal Atlas. Materials are assumptions from data/materials.json.', levels };
  return { plan, warnings };
}

/** Load a floor plan into the editor. Its floors keep their walls and outline as they are. */
export function floorplanToDraft(plan) {
  const levels = sortedLevels(plan);
  const ground = levels.find((l) => l.elevation >= -0.01) || levels[levels.length - 1];
  return {
    version: DRAFT_VERSION, name: plan.name || 'My house',
    levels: levels.map((l) => ({
      id: l.id, name: l.name, kind: l.elevation < -0.01 ? 'basement' : l === ground ? 'main' : 'upper', height: l.height, elevation: l.elevation,
      source: l.source, derive: false, ...(l.floorMaterial ? { floorMaterial: l.floorMaterial } : {}), ...(l.note ? { note: l.note } : {}),
      outline: clone(l.outline), rooms: clone(l.rooms || []), walls: clone(l.walls || []), openings: clone(l.openings || []),
      stairs: clone(l.stairs || []), fixtures: clone(l.fixtures || []), underlay: null,
    })),
  };
}

/** True when the value looks like a draft this version can open. */
export function isDraft(v) {
  return !!v && v.version === DRAFT_VERSION && Array.isArray(v.levels) && v.levels.length > 0 && v.levels.every((l) => l && typeof l.id === 'string' && Array.isArray(l.rooms) && Array.isArray(l.walls));
}

/**
 * A draft from a file, the server or the browser's storage, made safe to use: every number
 * is a number in range, every point is a point, unknown kinds fall back, and items with broken
 * geometry are dropped. Returns null when nothing usable is left. The panel shows names and
 * numbers of a draft, so nothing from outside reaches it without passing here.
 */
export function normalizeDraft(v) {
  if (!isDraft(v)) return null;
  const num = (x, lo, hi, fallback) => (typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi ? x : fallback);
  const str = (x, fallback, max = 80) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : fallback);
  const point = (p) => (Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1e4) ? [p[0], p[1]] : null);
  const poly = (list) => { const out = Array.isArray(list) ? list.map(point) : []; return out.length >= 3 && out.every(Boolean) ? out : null; };
  const items = (list) => (Array.isArray(list) ? list.filter((o) => o && typeof o === 'object' && !Array.isArray(o)) : []);
  const seen = new Set();
  const levels = [];
  for (const l of v.levels) {
    if (!/^[\w-]{1,12}$/.test(l.id) || seen.has(l.id)) continue;
    seen.add(l.id);
    const kind = Object.hasOwn(LEVEL_KINDS, l.kind) ? l.kind : 'main';
    const outline = poly(l.outline);
    const level = {
      id: l.id, name: str(l.name, `Floor ${l.id}`, 40), kind, height: num(l.height, 1.5, 15, LEVEL_KINDS[kind].height), derive: l.derive !== false || !outline,
      rooms: [], walls: [], openings: [], stairs: [], underlay: null,
    };
    if (!level.derive) {
      level.outline = outline;
      if (Number.isFinite(l.elevation) && Math.abs(l.elevation) < 200) level.elevation = l.elevation;
      if (['lidar-scan', 'lidar-trace', 'measured', 'image-trace', 'drawn', 'synthetic'].includes(l.source)) level.source = l.source;
      for (const key of ['floorMaterial', 'note']) if (typeof l[key] === 'string') level[key] = l[key].slice(0, 400);
      level.fixtures = items(l.fixtures).filter((f) => poly(f.polygon) && typeof f.material === 'string').map((f) => ({ ...f, polygon: poly(f.polygon) }));
    }
    for (const r of items(l.rooms)) {
      const polygon = poly(r.polygon);
      if (!polygon) continue;
      const room = { ...r, id: str(r.id, `${l.id}-r${level.rooms.length + 1}`, 60), name: str(r.name, 'Room', 40), polygon };
      for (const key of ['ceilingHeight', 'ceilingHeightMax']) { if (num(r[key], 0.5, 30, null) === null) delete room[key]; }
      level.rooms.push(room);
    }
    for (const w of items(l.walls)) { const a = point(w.a), b = point(w.b); if (a && b) level.walls.push({ ...w, a, b }); }
    for (const o of items(l.openings)) { const a = point(o.a), b = point(o.b); if (a && b && ['door', 'window', 'opening'].includes(o.type)) level.openings.push({ ...o, a, b }); }
    for (const s of items(l.stairs)) { const polygon = poly(s.polygon); if (polygon) level.stairs.push({ ...s, id: str(s.id, `${l.id}-s${level.stairs.length + 1}`, 60), polygon, ...(Array.isArray(s.connects) ? { connects: s.connects.filter((c) => typeof c === 'string') } : {}) }); }
    const u = l.underlay;
    if (u && typeof u === 'object' && num(u.w, 1, 20000, null) && num(u.h, 1, 20000, null) && num(u.mPerPx, 1e-5, 10, null)) {
      level.underlay = { ...(typeof u.key === 'string' && /^[\w-]{1,40}$/.test(u.key) ? { key: u.key } : {}), w: u.w, h: u.h, mPerPx: u.mPerPx, scaled: u.scaled === true, x: num(u.x, -1e4, 1e4, 0), y: num(u.y, -1e4, 1e4, 0), opacity: num(u.opacity, 0.05, 1, 0.55), invert: u.invert !== false };
    }
    levels.push(level);
  }
  if (!levels.length) return null;
  const out = { version: DRAFT_VERSION, name: str(v.name, 'My house', 60), levels };
  if (typeof v.saved === 'string' && Number.isFinite(Date.parse(v.saved))) out.saved = v.saved;
  if (v.site && typeof v.site === 'object' && Number.isFinite(v.site.northDeg)) out.site = { northDeg: v.site.northDeg, northSource: str(v.site.northSource, 'set in the Layout setup panel', 160) };
  return out;
}

// ---------------------------------------------------------------------------
// the user workspace
// ---------------------------------------------------------------------------

/**
 * Which data the page loads. "demo" reads only data/synthetic/. "user" reads data/user/
 * (or this browser's storage). "private" reads data/private/. ?demo=1 always wins;
 * ?layout=user asks for the user workspace; otherwise the private config wins when it exists.
 */
export function wantsUserLayout({ demo, layout, hasPrivateConfig }) {
  if (demo) return false;
  return layout === 'user' || !hasPrivateConfig;
}

/**
 * Give every emitter a place inside the plan. One that already stands inside the outline of an
 * existing floor is kept; the others go to the middle of the largest rooms, main floor first,
 * and are marked as a guess.
 */
export function placeDefaultAps(aps, plan) {
  const levels = sortedLevels(plan);
  const ground = levels.find((l) => l.elevation >= -0.01) || levels[0];
  const spots = [];
  for (const level of [ground, ...levels.filter((l) => l !== ground)]) {
    const rooms = [...(level.rooms || [])].sort((a, b) => polygonArea(b.polygon) - polygonArea(a.polygon));
    for (const r of rooms) spots.push({ level: level.id, p: interiorPoint(r.polygon, 0.25), within: r.polygon });
    if (!rooms.length) spots.push({ level: level.id, p: interiorPoint(level.outline, 0.5), within: level.outline });
  }
  let next = 0;
  return (aps || []).map((ap) => {
    const lv = levels.find((l) => l.id === ap.position?.level);
    if (lv && ap.position.source !== 'guess' && pointInPolygon(ap.position.x, ap.position.y, lv.outline)) return ap;
    const s = spots[next % spots.length];
    // more access points than rooms: the next round stands a little beside the first, when that is still inside
    const beside = s.p[0] + Math.floor(next / spots.length) * 0.4;
    next++;
    const x = pointInPolygon(beside, s.p[1], s.within) ? beside : s.p[0];
    return { ...ap, position: { level: s.level, x: Math.round(x * 100) / 100, y: Math.round(s.p[1] * 100) / 100, source: 'guess' } };
  });
}

/**
 * The configuration for a user layout: the public defaults, then data/user/config.user.json,
 * with every path pointing into data/user/. No sample file and no address unless the user's
 * own config names them. The demo house's samples never apply to another plan.
 */
export function userConfig(base, layout) {
  const own = layout.config && typeof layout.config === 'object' ? layout.config : {};
  const merged = mergeConfig(base, own);
  return {
    ...merged,
    paths: { floorplan: USER_PATHS.floorplan, nodes: own.paths?.nodes || USER_PATHS.nodes, samples: own.paths?.samples || [], apPositions: USER_PATHS.apPositions },
    private: { address: '', houseName: layout.plan.name || 'My house', ...(own.private || {}) },
    site: { northDeg: 0, northSource: 'guess: the plan is taken as drawn north up', frontDoor: null, ...(own.site || {}) },
    aps: placeDefaultAps(merged.aps, layout.plan),
  };
}
