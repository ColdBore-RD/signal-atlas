// Configuration helpers shared by the page and the Node tools.

/** Deep merge. Arrays of objects that all have an "id" are merged by id; other arrays are replaced. */
export function mergeConfig(base, over) {
  if (over === undefined) return base;
  if (Array.isArray(base) && Array.isArray(over)) {
    const keyed = (arr) => arr.length > 0 && arr.every((v) => v && typeof v === 'object' && 'id' in v);
    if (keyed(base) && keyed(over)) {
      const out = base.map((b) => {
        const o = over.find((v) => v.id === b.id);
        return o ? mergeConfig(b, o) : b;
      });
      for (const o of over) if (!base.some((b) => b.id === o.id)) out.push(o);
      return out;
    }
    return over;
  }
  if (base && over && typeof base === 'object' && typeof over === 'object' && !Array.isArray(base) && !Array.isArray(over)) {
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) out[k] = k in base ? mergeConfig(base[k], v) : v;
    return out;
  }
  return over;
}

/**
 * Apply saved positions ({ positions: { id: { level, x, y, z?, ... } } }) to the emitters.
 * z is the height above the floor of the level, metres. enclosureLossDb is extra loss of
 * a cabinet around the device: it is taken off the transmit power, and the nominal power
 * is kept in tx_dbm_nominal.
 */
export function applyApPositions(aps, saved, levelIds) {
  if (!saved?.positions) return aps;
  return aps.map((ap) => {
    const p = saved.positions[ap.id];
    if (!p || !levelIds.includes(p.level)) return ap;
    const position = { ...ap.position, level: p.level, x: p.x, y: p.y, source: p.source || 'placed' };
    for (const key of ['z', 'heightSource', 'mount']) if (p[key] !== undefined) position[key] = p[key];
    const out = { ...ap, position };
    if (Number.isFinite(p.enclosureLossDb) && p.enclosureLossDb > 0) {
      const nominal = ap.tx_dbm_nominal || ap.tx_dbm;
      out.tx_dbm_nominal = nominal;
      out.tx_dbm = Object.fromEntries(Object.entries(nominal).map(([band, v]) => [band, v - p.enclosureLossDb]));
      out.enclosure = { lossDb: p.enclosureLossDb, source: p.enclosureSource || 'assumed' };
    }
    return out;
  });
}

/**
 * The bands the page works with: [{ id, label, freq_mhz }]. The list is a setting
 * (config.bands), so a plan can be reused for other radio work. A band needs
 * path-loss numbers in materials.json to be usable; one without them is left out.
 */
export function bandList(config, materialsFile) {
  const pathLoss = materialsFile?.pathLoss || {};
  const wanted = Array.isArray(config?.bands) && config.bands.length ? config.bands : (materialsFile?.bands || []).map((id) => ({ id }));
  return wanted
    .map((b) => (typeof b === 'string' ? { id: b } : b))
    .filter((b) => b && pathLoss[b.id] && typeof pathLoss[b.id] === 'object')
    .map((b) => ({ id: String(b.id), label: b.label || `${b.id} GHz`, freq_mhz: b.freq_mhz ?? pathLoss[b.id].freq_mhz }));
}

/** Map of lower-case BSSID -> { apId, network, band, ap }. */
export function bssidIndex(aps) {
  const map = new Map();
  for (const ap of aps) for (const [band, bssid] of Object.entries(ap.bssid || {})) map.set(String(bssid).toLowerCase(), { apId: ap.id, network: ap.network, band, ap });
  return map;
}
