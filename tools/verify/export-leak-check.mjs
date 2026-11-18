#!/usr/bin/env node
// Checks that the street address and the GPS position in the Polycam exports did
// not leak out of data/private/photos/.
//
//   node tools/verify/export-leak-check.mjs
//
// It reads the address, latitude and longitude rows of every
// data/private/photos/polycam/<level>/floorplan.csv, then searches for them in
//   - every text file under data/private/ except photos/
//   - every file of the repository that git does not ignore.
// It prints file names only, never the strings. Exit code 1 on a hit.
// Without Polycam exports there is nothing to check and it passes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const POLYCAM = path.join(ROOT, 'data/private/photos/polycam');
const TEXT = /\.(json|ndjson|md|txt|csv|js|mjs|py|ps1|html|css|svg|yaml|yml|ino|h|example)$/i;

const secrets = new Set();
if (fs.existsSync(POLYCAM)) {
  for (const level of fs.readdirSync(POLYCAM)) {
    const csv = path.join(POLYCAM, level, 'floorplan.csv');
    if (!fs.existsSync(csv)) continue;
    for (const line of fs.readFileSync(csv, 'utf8').split(/\r?\n/)) {
      const m = /^Entire Roomplan,([^,]*),(.*)$/.exec(line);
      if (!m || !/address|latitude|longitude|location|gps/i.test(m[1])) continue;
      const value = m[2].trim().replace(/^"|"$/g, '');
      if (value.length < 5) continue;
      secrets.add(value.toLowerCase());
      const street = value.split(',')[0].trim();                 // "12 Example Way" of "12 Example Way, Town, ST"
      if (/[a-z]/i.test(street) && street.length >= 8) secrets.add(street.toLowerCase());
      if (/^-?\d+\.\d{4,}$/.test(value)) secrets.add(value.slice(0, value.indexOf('.') + 5));   // a coordinate cut to 4 decimals
    }
  }
}
if (!secrets.size) { console.log('export leak check: no Polycam export with an address or position found. Nothing to check.'); process.exit(0); }

const files = new Set();
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (full !== path.join(ROOT, 'data/private/photos')) walk(full); } else if (TEXT.test(e.name)) files.add(full);
  }
};
if (fs.existsSync(path.join(ROOT, 'data/private'))) walk(path.join(ROOT, 'data/private'));
try {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  for (const rel of listed.split('\n')) if (rel && TEXT.test(rel) && fs.existsSync(path.join(ROOT, rel))) files.add(path.join(ROOT, rel));
} catch { /* not a git checkout: the private folder was still checked */ }

const hits = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8').toLowerCase();
  if ([...secrets].some((s) => text.includes(s))) hits.push(path.relative(ROOT, file));
}
if (hits.length) {
  console.error(`export leak check FAILED: the address or the position of the exports is in ${hits.length} file${hits.length > 1 ? 's' : ''}:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`export leak check passed: ${secrets.size} strings (address and position of the exports) are in none of ${files.size} files outside data/private/photos/.`);
