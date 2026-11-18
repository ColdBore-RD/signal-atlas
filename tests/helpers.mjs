import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
export const materials = readJson('data/materials.json');
export const schema = readJson('data/schema/floorplan.schema.json');
export const grades = readJson('data/grades.json');

/** A 10 m x 6 m test house: one drywall wall at x = 5 with a doorway, concrete shell, two levels. */
export function boxHouse({ door = true, wallMaterial = 'int-drywall' } = {}) {
  const outline = [[0, 0], [10, 0], [10, 6], [0, 6]];
  const shell = outline.map((p, i) => ({ a: p, b: outline[(i + 1) % 4], material: 'concrete' }));
  const level = (id, name, elevation) => ({
    id, name, elevation, height: 2.5, source: 'synthetic', floorMaterial: 'floor-wood', outline,
    rooms: [
      { id: `${id}-west`, name: 'West room', polygon: [[0, 0], [5, 0], [5, 6], [0, 6]] },
      { id: `${id}-east`, name: 'East room', polygon: [[5, 0], [10, 0], [10, 6], [5, 6]] },
    ],
    walls: [...shell, { a: [5, 0], b: [5, 6], material: wallMaterial }],
    openings: door ? [{ type: 'door', id: `${id}-door`, a: [5, 2.5], b: [5, 3.5], material: 'door-hollow', state: 'open' }] : [],
    stairs: [],
    fixtures: [],
  });
  return { schemaVersion: 1, name: 'Box', units: 'm', levels: [level('G', 'Ground', 0), level('U', 'Upper', 3)] };
}

export const testAp = (over = {}) => ({ id: 'ap1', network: 'home', tx_dbm: { 2.4: 20, 5: 20 }, bssid: { 2.4: '02:00:00:00:00:01', 5: '02:00:00:00:00:02' }, channel: { 2.4: 1, 5: 36 }, position: { level: 'G', x: 2, y: 3 }, ...over });
