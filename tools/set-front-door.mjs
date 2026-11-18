#!/usr/bin/env node
// Choose the front door.
//
//   node tools/set-front-door.mjs --list
//   node tools/set-front-door.mjs <opening-id> [--level 1]
//
// Reads data/private/floorplan.json, finds the door with that id, works out which
// side of it is outside, and writes site.frontDoor into
// data/private/config.local.json with source "chosen".
//
// North:
//   - When north was measured (the plan was imported from LiDAR scans with a
//     compass heading), north stays as measured. The tool only reports how well
//     the door fits the owner's rule "standing outside and facing the front door,
//     north is to your left".
//   - Otherwise north is computed from the door with that rule, as before.
//
// The floor-plan importer keeps a chosen front door when it runs again.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { northFromOutwardNormal, outwardNormal, compassWord } from '../src/core/orientation.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planFile = path.join(ROOT, 'data/private/floorplan.json');
const configFile = path.join(ROOT, 'data/private/config.local.json');
const args = process.argv.slice(2);
if (!fs.existsSync(planFile)) { console.error('data/private/floorplan.json is missing'); process.exit(1); }
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
const measured = config.site?.northMeasured === true;
const levelArg = args.includes('--level') ? args[args.indexOf('--level') + 1] : null;

/** Degrees between the north that the rule gives for this door and the measured north (0 = perfect fit). */
const ruleMiss = (out) => {
  const d = Math.abs(northFromOutwardNormal(out) - (config.site?.northDeg ?? 0)) % 360;
  return Math.round(Math.min(d, 360 - d));
};

const candidates = [];
for (const level of plan.levels) {
  if (levelArg && level.id !== levelArg) continue;
  for (const op of level.openings || []) {
    if (op.type !== 'door' || !op.id) continue;
    const out = outwardNormal(op, level.outline);
    if (out) candidates.push({ level, op, out });
  }
}
const idArg = args.find((a) => !a.startsWith('--') && a !== levelArg);
if (args.includes('--list') || !idArg) {
  console.log('Exterior doors with an id:');
  for (const c of candidates) {
    const width = Math.hypot(c.op.b[0] - c.op.a[0], c.op.b[1] - c.op.a[1]).toFixed(2);
    const north = measured ? `the rule "north is to your left" misses the measured north by ${ruleMiss(c.out)} degrees` : `north would be ${northFromOutwardNormal(c.out)} degrees`;
    console.log(`  ${c.op.id} (level ${c.level.id}, ${width} m wide, ${c.op.material}) -> ${north}`);
  }
  process.exit(0);
}
const hit = candidates.find((c) => c.op.id === idArg);
if (!hit) { console.error(`No exterior door with the id "${idArg}". Run with --list to see the choices.`); process.exit(1); }
const frontDoor = {
  level: hit.level.id, openingId: hit.op.id,
  x: Math.round(((hit.op.a[0] + hit.op.b[0]) / 2) * 100) / 100, y: Math.round(((hit.op.a[1] + hit.op.b[1]) / 2) * 100) / 100,
  outward: hit.out.map((v) => Math.round(v * 1000) / 1000), source: 'chosen',
};
if (measured) {
  config.site = { ...(config.site || {}), frontDoor };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  console.log(`Front door set to "${idArg}" on level ${hit.level.id}. North stays as measured (${config.site.northDeg} degrees clockwise from up the page). The rule "north is to your left" misses it by ${ruleMiss(hit.out)} degrees. Saved to data/private/config.local.json.`);
} else {
  const northDeg = northFromOutwardNormal(hit.out);
  config.site = {
    ...(config.site || {}), northDeg,
    northSource: 'computed from the chosen front door with the rule: outside, facing the front door, north is to your left',
    frontDoor,
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
  console.log(`Front door set to "${idArg}" on level ${hit.level.id}. North is ${northDeg} degrees clockwise from up the page (${compassWord(northDeg)}). Saved to data/private/config.local.json.`);
}
