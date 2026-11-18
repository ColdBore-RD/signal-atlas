// A small JSON Schema checker and the extra floor-plan checks that a schema
// cannot express. It exists so that a hand-edited floorplan.json fails with a
// message a person can act on. Pure functions: runs in the browser and in Node.
//
// Supported schema keywords: type, const, enum, required, properties,
// additionalProperties, items, minItems, maxItems, minLength, minimum, maximum,
// exclusiveMinimum, pattern, and $ref to "#/definitions/<name>".

import { findHostWall, polygonArea, pointSegmentDistance, dist, pointInPolygon, polygonCentroid } from './geometry.js';

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function show(v) {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? s.slice(0, 57) + '...' : s;
}

/** Check a value against a schema. Returns [{ path, message }]. */
export function checkSchema(value, schema, root = schema, path = '') {
  const errors = [];
  walk(value, schema, root, path, errors);
  return errors;
}

function walk(value, schema, root, path, errors) {
  if (schema.$ref) {
    const name = schema.$ref.replace('#/definitions/', '');
    const target = root.definitions?.[name];
    if (!target) { errors.push({ path, message: `the schema refers to an unknown definition "${name}"` }); return; }
    walk(value, target, root, path, errors);
    return;
  }
  const where = path || 'the file';
  const t = typeOf(value);
  if (schema.type) {
    const ok = schema.type === t || (schema.type === 'number' && t === 'integer');
    if (!ok) { errors.push({ path, message: `${where} must be ${article(schema.type)}, but it is ${article(t)} (${show(value)})` }); return; }
  }
  if ('const' in schema && value !== schema.const) errors.push({ path, message: `${where} must be ${show(schema.const)}, but it is ${show(value)}` });
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `${where} must be one of ${schema.enum.map(show).join(', ')}, but it is ${show(value)}` });
  }
  if (t === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) errors.push({ path, message: `${where} must not be empty` });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push({ path, message: `${where} has the wrong format: ${show(value)}` });
  }
  if (t === 'number' || t === 'integer') {
    if (schema.minimum != null && value < schema.minimum) errors.push({ path, message: `${where} must be at least ${schema.minimum}, but it is ${value}` });
    if (schema.maximum != null && value > schema.maximum) errors.push({ path, message: `${where} must be at most ${schema.maximum}, but it is ${value}` });
    if (schema.exclusiveMinimum != null && value <= schema.exclusiveMinimum) errors.push({ path, message: `${where} must be greater than ${schema.exclusiveMinimum}, but it is ${value}` });
  }
  if (t === 'array') {
    if (schema.minItems != null && value.length < schema.minItems) errors.push({ path, message: `${where} needs at least ${schema.minItems} items, but it has ${value.length}` });
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push({ path, message: `${where} must have at most ${schema.maxItems} items, but it has ${value.length}` });
    if (schema.items) value.forEach((item, i) => walk(item, schema.items, root, `${path}[${i}]`, errors));
  }
  if (t === 'object') {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push({ path, message: `${where} is missing the required field "${key}"` });
    }
    const props = schema.properties || {};
    for (const [key, v] of Object.entries(value)) {
      const sub = path ? `${path}.${key}` : key;
      if (props[key]) walk(v, props[key], root, sub, errors);
      else if (schema.additionalProperties === false) {
        const hint = nearest(key, Object.keys(props));
        errors.push({ path: sub, message: `${where} has an unknown field "${key}"${hint ? `. Did you mean "${hint}"?` : ''}` });
      }
    }
  }
}

function article(type) {
  return /^[aeio]/.test(type) ? `an ${type}` : `a ${type}`;
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** The closest known name, when it is close enough to be a likely typing error. */
export function nearest(word, known) {
  let best = null, bestD = Infinity;
  for (const k of known) {
    const d = editDistance(String(word).toLowerCase(), k.toLowerCase());
    if (d < bestD) { bestD = d; best = k; }
  }
  return bestD <= Math.max(2, Math.floor(String(word).length / 3)) ? best : null;
}

/**
 * Full check of a floor plan: the schema, then the cross-references.
 * Returns { errors, warnings }, each a list of { path, message }.
 * A plan with errors must not be used. Warnings are worth reading.
 */
export function validateFloorplan(plan, schema, materialsFile) {
  const errors = checkSchema(plan, schema);
  const warnings = [];
  if (errors.length) return { errors, warnings };

  const materialNames = Object.keys(materialsFile?.materials || {});
  const floorNames = Object.keys(materialsFile?.floors || {});
  const levelIds = plan.levels.map((l) => l.id);
  const seenLevels = new Set();
  const seenRooms = new Set();

  const needMaterial = (name, path, what) => {
    if (!materialNames.length || materialNames.includes(name)) return;
    const hint = nearest(name, materialNames);
    errors.push({ path, message: `${what} uses the material "${name}", which is not in materials.json${hint ? `. Did you mean "${hint}"?` : `. Known materials: ${materialNames.join(', ')}`}` });
  };

  plan.levels.forEach((level, li) => {
    const lp = `levels[${li}]`;
    const lname = `level "${level.id}" (${level.name})`;
    if (seenLevels.has(level.id)) errors.push({ path: `${lp}.id`, message: `two levels have the id "${level.id}". Each level needs its own id` });
    seenLevels.add(level.id);
    if (level.floorMaterial && floorNames.length && !floorNames.includes(level.floorMaterial)) {
      const hint = nearest(level.floorMaterial, floorNames);
      errors.push({ path: `${lp}.floorMaterial`, message: `${lname} uses the floor material "${level.floorMaterial}", which is not in the floors table of materials.json${hint ? `. Did you mean "${hint}"?` : ''}` });
    }
    if (polygonArea(level.outline) < 1) errors.push({ path: `${lp}.outline`, message: `the outline of ${lname} encloses less than 1 square metre. Check the order of its points` });

    (level.walls || []).forEach((w, wi) => {
      const wp = `${lp}.walls[${wi}]`;
      if (dist(w.a, w.b) < 0.01) errors.push({ path: wp, message: `wall ${wi} of ${lname} has no length: a and b are the same point (${show(w.a)})` });
      needMaterial(w.material, `${wp}.material`, `wall ${wi} of ${lname}`);
    });

    (level.openings || []).forEach((op, oi) => {
      const op_ = `${lp}.openings[${oi}]`;
      const label = `${op.type} ${op.id ? `"${op.id}"` : oi} of ${lname}`;
      needMaterial(op.material, `${op_}.material`, label);
      if (dist(op.a, op.b) < 0.05) errors.push({ path: op_, message: `${label} is narrower than 5 cm` });
      if (findHostWall(op, level.walls || []) < 0) {
        let near = Infinity;
        for (const w of level.walls || []) {
          near = Math.min(near, Math.max(
            pointSegmentDistance(op.a[0], op.a[1], w.a[0], w.a[1], w.b[0], w.b[1]),
            pointSegmentDistance(op.b[0], op.b[1], w.a[0], w.a[1], w.b[0], w.b[1])));
        }
        errors.push({ path: op_, message: `${label} from ${show(op.a)} to ${show(op.b)} does not lie on any wall. Both ends must be on one wall line. The nearest wall is ${near.toFixed(2)} m away` });
      }
      if (op.type === 'door' && !op.state) warnings.push({ path: op_, message: `${label} has no "state". It is treated as closed` });
    });

    (level.rooms || []).forEach((room, ri) => {
      const rp = `${lp}.rooms[${ri}]`;
      if (seenRooms.has(room.id)) errors.push({ path: `${rp}.id`, message: `two rooms have the id "${room.id}". Each room needs its own id` });
      seenRooms.add(room.id);
      if (polygonArea(room.polygon) < 0.2) errors.push({ path: `${rp}.polygon`, message: `room "${room.name}" of ${lname} encloses less than 0.2 square metres. Check the order of its points` });
      const c = polygonCentroid(room.polygon);
      const anyInside = pointInPolygon(c[0], c[1], level.outline) || room.polygon.some((p) => pointInPolygon(p[0], p[1], level.outline));
      if (!anyInside) warnings.push({ path: `${rp}.polygon`, message: `room "${room.name}" of ${lname} lies outside the outline of its level` });
    });

    (level.stairs || []).forEach((st, si) => {
      const sp = `${lp}.stairs[${si}]`;
      for (const target of st.connects) {
        if (!levelIds.includes(target)) {
          const hint = nearest(target, levelIds);
          errors.push({ path: `${sp}.connects`, message: `stairs "${st.id}" of ${lname} lead to level "${target}", which does not exist${hint ? `. Did you mean "${hint}"?` : `. Levels are: ${levelIds.join(', ')}`}` });
        }
        if (target === level.id) errors.push({ path: `${sp}.connects`, message: `stairs "${st.id}" of ${lname} lead to their own level` });
      }
    });

    (level.fixtures || []).forEach((fx, fi) => needMaterial(fx.material, `${lp}.fixtures[${fi}].material`, `fixture ${fx.name ? `"${fx.name}"` : fi} of ${lname}`));
  });

  const sorted = [...plan.levels].sort((a, b) => a.elevation - b.elevation);
  for (let i = 1; i < sorted.length; i++) {
    const lower = sorted[i - 1], upper = sorted[i];
    if (lower.elevation + lower.height > upper.elevation + 1e-6) {
      warnings.push({ path: 'levels', message: `level "${lower.id}" (floor at ${lower.elevation} m, ${lower.height} m high) reaches above the floor of level "${upper.id}" (${upper.elevation} m)` });
    }
  }
  return { errors, warnings };
}

/** One line per problem, ready to print or to show in a banner. */
export function formatIssues(issues) {
  return issues.map((e) => (e.path && !e.message.startsWith(e.path) ? `${e.path}: ${e.message}` : e.message));
}
