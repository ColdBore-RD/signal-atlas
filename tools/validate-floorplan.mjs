#!/usr/bin/env node
// Check a floor plan file and print readable problems.
//
//   node tools/validate-floorplan.mjs [path/to/floorplan.json]
//
// Without a path it checks the active plan: data/private/floorplan.json when it
// exists, else data/synthetic/floorplan.json. Exit code 1 when there are errors.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateFloorplan, formatIssues } from '../src/core/validate.js';
import { polygonArea } from '../src/core/geometry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const file = arg ? path.resolve(arg) : [path.join(ROOT, 'data/private/floorplan.json'), path.join(ROOT, 'data/synthetic/floorplan.json')].find((f) => fs.existsSync(f));
if (!file || !fs.existsSync(file)) { console.error('No floor plan file found.'); process.exit(1); }
let plan;
try { plan = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error(`${path.relative(ROOT, file)} is not valid JSON: ${e.message}`); process.exit(1); }
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/schema/floorplan.schema.json'), 'utf8'));
const materials = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/materials.json'), 'utf8'));
const { errors, warnings } = validateFloorplan(plan, schema, materials);
const rel = path.relative(ROOT, file);
if (errors.length) {
  console.error(`${rel}: ${errors.length} error${errors.length > 1 ? 's' : ''}`);
  for (const line of formatIssues(errors)) console.error('  ERROR  ' + line);
}
for (const line of formatIssues(warnings)) console.log('  WARN   ' + line);
if (!errors.length) {
  console.log(`${rel}: valid. ${plan.levels.length} levels.`);
  for (const l of plan.levels) {
    console.log(`  ${l.id.padEnd(3)} ${l.name.padEnd(14)} ${l.source.padEnd(12)} outline ${polygonArea(l.outline).toFixed(1)} m2, ${(l.rooms || []).length} rooms, ${l.walls.length} walls, ${(l.openings || []).length} openings`);
  }
}
process.exit(errors.length ? 1 : 0);
