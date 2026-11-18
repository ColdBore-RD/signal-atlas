// Tests for src/core/layout.js: a user's draft becomes a valid floor plan.
// Every house here is made up in the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from './helpers.mjs';
import { validateFloorplan } from '../src/core/validate.js';
import { polygonArea, pointInPolygon, dist } from '../src/core/geometry.js';
import {
  parseLength, newDraft, addLevel, nextItemId, levelElevations, splitSegments, wallsFromRooms, openingOnWall,
  draftToFloorplan, floorplanToDraft, isDraft, normalizeDraft, wantsUserLayout, placeDefaultAps, userConfig, USER_PATHS,
} from '../src/core/layout.js';

const materials = readJson('data/materials.json');
const schema = readJson('data/schema/floorplan.schema.json');
const base = readJson('data/config.default.json');
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const total = (walls, material) => walls.filter((w) => w.material === material).reduce((s, w) => s + dist(w.a, w.b), 0);

/** Two rooms side by side and a third below both: 8 x 7 m. */
function simpleDraft() {
  const d = newDraft('Test house');
  const l = d.levels[0];
  l.rooms.push({ id: '1-r1', name: 'Living room', polygon: rect(0, 0, 5, 4) }, { id: '1-r2', name: 'Kitchen', polygon: rect(5, 0, 8, 4) }, { id: '1-r3', name: 'Hall', polygon: rect(0, 4, 8, 7) });
  return d;
}

test('a typed length is read as metres, feet or inches', () => {
  assert.equal(parseLength('3.5'), 3.5);
  assert.equal(parseLength('3,5 m'), 3.5);
  assert.equal(parseLength('350 cm'), 3.5);
  assert.equal(parseLength('2400mm'), 2.4);
  assert.ok(Math.abs(parseLength('12 ft') - 3.6576) < 1e-9);
  assert.ok(Math.abs(parseLength('12\' 6"') - 3.81) < 1e-9);
  assert.ok(Math.abs(parseLength('30 in') - 0.762) < 1e-9);
  for (const bad of ['', 'abc', '0', '-2', '3 parsecs', null]) assert.equal(parseLength(bad), null, String(bad));
});

test('segments are cut where they touch or cross, and doubles are dropped', () => {
  const pieces = splitSegments([{ a: [0, 0], b: [8, 0] }, { a: [5, 0], b: [5, 4] }, { a: [0, 2], b: [8, 2] }, { a: [8, 0], b: [0, 0] }]);
  const keys = pieces.map((p) => `${p.a}|${p.b}`).sort();
  assert.equal(pieces.length, 6, keys.join(' '));               // top edge in 2, the vertical in 2, the crossing line in 2
  assert.ok(pieces.some((p) => p.from.length === 2));            // the top edge was given twice
});

test('rooms give exterior walls on the outside, interior walls between them, and one outline', () => {
  const d = simpleDraft();
  const { plan, warnings } = draftToFloorplan(d, materials);
  assert.deepEqual(warnings, []);
  const level = plan.levels[0];
  assert.ok(Math.abs(polygonArea(level.outline) - 56) < 1e-6, `outline area ${polygonArea(level.outline)}`);
  assert.equal(level.outline.length, 4, 'straight runs of the outline are one edge');
  assert.ok(Math.abs(total(level.walls, 'ext-siding') - 30) < 1e-6);        // the 8 x 7 perimeter
  assert.ok(Math.abs(total(level.walls, 'int-drywall') - 12) < 1e-6);       // 4 m between the top rooms, 8 m above the hall
  assert.equal(level.walls.filter((w) => w.material === 'ext-siding').length, 4, 'collinear pieces are joined');
  assert.equal(level.source, 'drawn');
  assert.equal(level.floorMaterial, 'floor-wood');
  const issues = validateFloorplan(plan, schema, materials);
  assert.deepEqual(issues.errors, []);
});

test('an L-shaped house and a room drawn corner by corner give the right outline', () => {
  const d = newDraft();
  d.levels[0].rooms.push({ id: 'a', name: 'A', polygon: [[0, 0], [6, 0], [6, 3], [3, 3], [3, 6], [0, 6]] }, { id: 'b', name: 'B', polygon: rect(6, 0, 9, 3) });
  const { plan } = draftToFloorplan(d, materials);
  const outline = plan.levels[0].outline;
  assert.ok(Math.abs(polygonArea(outline) - 36) < 1e-6);
  assert.equal(outline.length, 6);
  assert.ok(pointInPolygon(8, 1, outline) && !pointInPolygon(5, 5, outline));
  assert.deepEqual(validateFloorplan(plan, schema, materials).errors, []);
});

test('doors and windows get materials from the wall they are on', () => {
  const d = simpleDraft();
  const first = draftToFloorplan(d, materials).plan.levels[0];
  const front = openingOnWall([4, 7.1], first.walls, 0.9);
  const inner = openingOnWall([5.05, 2], first.walls, 0.8);
  const win = openingOnWall([2, -0.1], first.walls, 1.2);
  assert.ok(front && inner && win);
  assert.ok(Math.abs(dist(front.a, front.b) - 0.9) < 1e-6);
  d.levels[0].openings.push({ type: 'door', ...front }, { type: 'door', ...inner }, { type: 'window', ...win }, { type: 'opening', a: [1, 4], b: [3, 4] }, { type: 'door', a: [20, 20], b: [21, 20] });
  const { plan, warnings } = draftToFloorplan(d, materials);
  const ops = plan.levels[0].openings;
  assert.equal(ops.length, 4);
  assert.deepEqual(ops.map((o) => [o.type, o.material, o.state]), [['door', 'door-exterior', 'closed'], ['door', 'door-hollow', 'open'], ['window', 'glass-lowe', undefined], ['opening', 'open', undefined]]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no longer on a wall/);
  assert.ok(!('wall' in ops[0]), 'editor fields do not reach the file');
  assert.deepEqual(validateFloorplan(plan, schema, materials).errors, []);
});

test('an opening keeps inside a short wall and none is made far from every wall', () => {
  const walls = [{ a: [0, 0], b: [1, 0] }];
  const o = openingOnWall([0.05, 0.1], walls, 0.9);
  assert.ok(o.a[0] >= 0.05 - 1e-9 && o.b[0] <= 0.95 + 1e-9);
  assert.equal(openingOnWall([0.5, 2], walls, 0.9), null);
  assert.equal(openingOnWall([0.1, 0], [{ a: [0, 0], b: [0.25, 0] }], 0.9), null);
});

test('floors stack by their heights, a basement goes below zero, and stairs join neighbours', () => {
  const d = simpleDraft();
  const up = addLevel(d, 'above', '1');
  const down = addLevel(d, 'below', '1');
  assert.deepEqual(d.levels.map((l) => [l.id, l.kind]), [['B', 'basement'], ['1', 'main'], ['2', 'upper']]);
  assert.equal(up.rooms.length, 3);
  assert.notEqual(up.rooms[0].id, d.levels[1].rooms[0].id);
  assert.deepEqual(levelElevations(d.levels), [-2.7, 0, 3]);
  d.levels[1].stairs.push({ id: nextItemId(d, '1', 's'), polygon: rect(1, 5, 2, 6.5) });
  down.stairs.push({ id: nextItemId(d, 'B', 's'), polygon: rect(1, 5, 2, 6.5) });
  up.stairs.push({ id: nextItemId(d, '2', 's'), polygon: rect(6, 5, 7, 6.5) });
  const { plan, warnings } = draftToFloorplan(d, materials);
  assert.deepEqual(warnings, []);
  assert.deepEqual(plan.levels.map((l) => l.stairs[0].connects), [['1'], ['2'], ['1']]);
  assert.equal(plan.levels[0].walls.find((w) => dist(w.a, w.b) > 7.9 && w.a[1] === 0).material, 'concrete');
  assert.equal(plan.levels[0].floorMaterial, 'floor-concrete');
  const issues = validateFloorplan(plan, schema, materials);
  assert.deepEqual(issues.errors, []);
  assert.deepEqual(issues.warnings, []);
  assert.equal(new Set(plan.levels.flatMap((l) => l.rooms.map((r) => r.id))).size, 9);
});

test('problems in a draft are said in words and never give an unusable file silently', () => {
  const d = newDraft();
  d.levels[0].rooms.push({ id: 'a', name: '', polygon: rect(0, 0, 4, 4) }, { id: 'b', name: 'Shed', polygon: rect(10, 0, 13, 3) }, { id: 'c', name: 'Dot', polygon: rect(0, 0, 0.1, 0.1) });
  d.levels[0].stairs.push({ id: 's', polygon: rect(1, 1, 2, 3) });
  const { plan, warnings } = draftToFloorplan(d, materials);
  assert.equal(plan.levels[0].rooms.length, 2);
  assert.equal(plan.levels[0].rooms[0].name, 'Room');
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((w) => /smaller than 0.2/.test(w)) && warnings.some((w) => /do not touch/.test(w)) && warnings.some((w) => /only one floor/.test(w)));
  assert.ok(pointInPolygon(11, 1, plan.levels[0].outline) && pointInPolygon(2, 2, plan.levels[0].outline));
  assert.deepEqual(validateFloorplan(plan, schema, materials).errors, []);

  const empty = draftToFloorplan(newDraft(), materials);
  assert.ok(validateFloorplan(empty.plan, schema, materials).errors.length > 0, 'an empty floor is not a valid plan');
});

test('walls drawn by hand cut a room and keep a chosen kind', () => {
  const d = newDraft();
  d.levels[0].rooms.push({ id: 'a', name: 'Big', polygon: rect(0, 0, 8, 6) });
  d.levels[0].walls.push({ a: [4, 0], b: [4, 6], kind: 'auto' }, { a: [8, 6], b: [8, 9], kind: 'exterior' });
  const level = draftToFloorplan(d, materials).plan.levels[0];
  assert.ok(Math.abs(total(level.walls, 'int-drywall') - 6) < 1e-6);
  assert.ok(Math.abs(total(level.walls, 'ext-siding') - 31) < 1e-6);
});

test('a traced image marks its floor as image-trace', () => {
  const d = simpleDraft();
  d.levels[0].underlay = { mPerPx: 0.02, scaled: false, x: 0, y: 0, opacity: 0.6, w: 800, h: 600 };
  assert.equal(draftToFloorplan(d, materials).plan.levels[0].source, 'drawn', 'an image without a scale is only a backdrop');
  d.levels[0].underlay.scaled = true;
  assert.equal(draftToFloorplan(d, materials).plan.levels[0].source, 'image-trace');
});

test('a floor plan goes into the editor and comes out the same', () => {
  const plan = readJson('data/synthetic/floorplan.json');
  const draft = floorplanToDraft(plan);
  assert.ok(isDraft(draft));
  assert.ok(draft.levels.every((l) => l.derive === false));
  assert.deepEqual(draft.levels.map((l) => l.kind), ['basement', 'main', 'upper']);
  const back = draftToFloorplan(draft, materials).plan;
  assert.deepEqual(validateFloorplan(back, schema, materials).errors, []);
  for (const level of plan.levels) {
    const b = back.levels.find((l) => l.id === level.id);
    assert.deepEqual(b.walls, level.walls);
    assert.deepEqual(b.outline, level.outline);
    assert.deepEqual(b.openings, level.openings);
    assert.deepEqual(b.rooms, level.rooms);
    assert.deepEqual(b.stairs, level.stairs);
    assert.equal(b.elevation, level.elevation);
    assert.equal(b.source, level.source);
  }
  // a door added in the editor to an imported floor gets a material like any other
  const first = draft.levels[1];
  const spot = openingOnWall([(first.walls[0].a[0] + first.walls[0].b[0]) / 2, (first.walls[0].a[1] + first.walls[0].b[1]) / 2], first.walls, 0.5);
  first.openings.push({ type: 'window', a: spot.a, b: spot.b });
  const again = draftToFloorplan(draft, materials).plan;
  assert.equal(again.levels[1].openings.at(-1).material, 'glass-lowe');
  assert.ok(!isDraft({ version: 99, levels: [] }) && !isDraft(null) && !isDraft(plan));
});

test('the user workspace is chosen by the address, and ?demo=1 never reads it', () => {
  assert.equal(wantsUserLayout({ demo: true, layout: 'user', hasPrivateConfig: false }), false);
  assert.equal(wantsUserLayout({ demo: false, layout: 'user', hasPrivateConfig: true }), true);
  assert.equal(wantsUserLayout({ demo: false, layout: null, hasPrivateConfig: true }), false);
  assert.equal(wantsUserLayout({ demo: false, layout: null, hasPrivateConfig: false }), true);
});

test('the user configuration points only into data/user and carries no sample of the demo house', () => {
  const plan = draftToFloorplan(simpleDraft(), materials).plan;
  const config = userConfig(base, { plan, config: { site: { northDeg: 20, northSource: 'measured' } } });
  assert.deepEqual(config.paths, { floorplan: USER_PATHS.floorplan, nodes: USER_PATHS.nodes, samples: [], apPositions: USER_PATHS.apPositions });
  assert.ok(Object.values(USER_PATHS).every((p) => p.startsWith('data/user/')));
  assert.ok(!JSON.stringify(config.paths).includes('private') && !JSON.stringify(config.paths).includes('synthetic'));
  assert.equal(config.private.houseName, 'Test house');
  assert.equal(config.private.address, '');
  assert.equal(config.site.northDeg, 20);
  assert.equal(userConfig(base, { plan }).site.northDeg, 0);
  assert.equal(base.paths.samples.length, 1, 'the defaults are not changed');
});

test('every access point gets a place inside the new plan', () => {
  const d = simpleDraft();
  addLevel(d, 'above', '1');
  const plan = draftToFloorplan(d, materials).plan;
  const aps = placeDefaultAps(base.aps, plan);
  assert.equal(aps.length, base.aps.length);
  for (const ap of aps) {
    const level = plan.levels.find((l) => l.id === ap.position.level);
    assert.ok(level && pointInPolygon(ap.position.x, ap.position.y, level.outline), `${ap.id} at ${JSON.stringify(ap.position)}`);
    assert.equal(ap.position.source, 'guess');
  }
  assert.equal(new Set(aps.map((a) => `${a.position.level}:${a.position.x}:${a.position.y}`)).size, aps.length, 'no two on one spot');
  const kept = placeDefaultAps([{ id: 'x', position: { level: '1', x: 1, y: 1, source: 'placed' } }], plan);
  assert.deepEqual(kept[0].position, { level: '1', x: 1, y: 1, source: 'placed' });
});

test('a draft from outside is cleaned before the panel uses it', () => {
  const good = simpleDraft();
  good.levels[0].openings.push({ type: 'door', a: [5, 1], b: [5, 1.9] });
  good.levels[0].underlay = { w: 800, h: 600, mPerPx: 0.02, scaled: true, x: 1, y: 2, opacity: 0.4 };
  const same = normalizeDraft(JSON.parse(JSON.stringify(good)));
  assert.deepEqual(draftToFloorplan(same, materials).plan, draftToFloorplan(good, materials).plan, 'a good draft is not changed in substance');
  assert.equal(same.levels[0].underlay.invert, true);

  const hostile = {
    version: 1, name: { toString: 'x' }, levels: [
      { id: '1', name: '<img src=x onerror=alert(1)>', kind: '__proto__', height: '"><script>', derive: true,
        rooms: [{ id: 'a', name: 7, polygon: [[0, 0], [4, 0], [4, 'x']] }, { id: 'b', name: 'Fine', polygon: [[0, 0], [4, 0], [4, 4], [0, 4]], ceilingHeight: '"><b>' }, null, 'text'],
        walls: [{ a: [0, 0], b: [NaN, 1] }, { a: [0, 0], b: [2, 2] }], openings: [{ type: 'portal', a: [0, 0], b: [1, 0] }, { type: 'door', a: [1, 0], b: [2, 0] }],
        stairs: [{ id: 's', polygon: 'nope' }], underlay: { w: 100, h: 100, mPerPx: 0.02, opacity: '"><img>' } },
      { id: '../../etc', name: 'bad id', kind: 'main', height: 2.5, rooms: [], walls: [] },
      { id: '1', name: 'second with the same id', kind: 'main', height: 2.5, rooms: [], walls: [] },
    ],
  };
  const clean = normalizeDraft(hostile);
  assert.equal(clean.levels.length, 1);
  const l = clean.levels[0];
  assert.deepEqual([clean.name, l.kind, l.height, l.rooms.length, l.walls.length, l.openings.length, l.stairs.length], ['My house', 'main', 2.7, 1, 1, 1, 0]);
  assert.ok(!('ceilingHeight' in l.rooms[0]));
  assert.equal(l.underlay.opacity, 0.55);
  assert.equal(l.name, '<img src=x onerror=alert(1)>', 'text is kept as text; the panel escapes it when it shows it');
  assert.deepEqual(validateFloorplan(draftToFloorplan(clean, materials).plan, schema, materials).errors, []);
  assert.equal(normalizeDraft({ version: 1, levels: [{ id: '???', rooms: [], walls: [] }] }), null);
  assert.equal(normalizeDraft('text'), null);
  // an imported floor without a usable outline becomes a drawn floor instead of an invalid one
  const imported = floorplanToDraft(readJson('data/synthetic/floorplan.json'));
  imported.levels[0].outline = [[0, 0]];
  assert.equal(normalizeDraft(imported).levels[0].derive, true);
  assert.equal(normalizeDraft(imported).levels[1].derive, false);
});

test('rooms that meet at one corner are one house, and a ring of rooms keeps its outer outline', () => {
  const d = newDraft();
  d.levels[0].rooms.push({ id: 'a', name: 'A', polygon: rect(0, 0, 4, 4) }, { id: 'b', name: 'B', polygon: rect(4, 4, 7, 7) });
  const corner = draftToFloorplan(d, materials);
  assert.deepEqual(corner.warnings, [], 'no "do not touch" warning');
  const outline = corner.plan.levels[0].outline;
  assert.ok(Math.abs(polygonArea(outline) - 25) < 1e-6, `area ${polygonArea(outline)}`);
  assert.ok(pointInPolygon(2, 2, outline) && pointInPolygon(6, 6, outline) && !pointInPolygon(6, 2, outline) && !pointInPolygon(2, 6, outline));
  assert.deepEqual(validateFloorplan(corner.plan, schema, materials).errors, []);

  const ring = newDraft();
  ring.levels[0].rooms.push({ id: 'n', name: 'N', polygon: rect(0, 0, 9, 3) }, { id: 's', name: 'S', polygon: rect(0, 6, 9, 9) }, { id: 'w', name: 'W', polygon: rect(0, 3, 3, 6) }, { id: 'e', name: 'E', polygon: rect(6, 3, 9, 6) });
  const made = draftToFloorplan(ring, materials);
  assert.deepEqual(made.warnings, []);
  assert.ok(Math.abs(polygonArea(made.plan.levels[0].outline) - 81) < 1e-6, 'the outline is the outer edge; the courtyard counts as inside');
  assert.ok(Math.abs(total(made.plan.levels[0].walls, 'ext-siding') - 48) < 1e-6, 'the courtyard walls are exterior walls');
});
