// Privacy mode. Every private string goes through one of these functions before
// it reaches the screen. With privacy on, the page shows stable generic names,
// and the original text is never put into the page at all, so a screenshot or
// a copy of the page text cannot leak it.
//
// What is treated as private: the street address and house name, every SSID,
// every BSSID and MAC address, and every device name and node id.
//
// Pure functions: browser and Node.

/** Short non-reversible tag for an identifier (FNV-1a, 16 bits shown). */
export function shortHash(text, salt = 'signal-atlas') {
  let h = 0x811c9dc5;
  const s = `${salt}|${String(text).toLowerCase()}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h & 0xffff).toString(16).padStart(4, '0');
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * known = {
 *   address, houseName,
 *   networks: [{ id, ssid, label }],            // own networks, in display order
 *   aps: [{ id, label, bssids: [..] }],
 *   nodes: [{ id, name, type }],
 * }
 */
export function createRedactor(known, enabled) {
  const ownSsid = new Map();
  (known.networks || []).forEach((n, i) => ownSsid.set(n.ssid, `Network ${LETTERS[i] || i + 1}`));
  const netLabel = new Map((known.networks || []).map((n, i) => [n.id, `Network ${LETTERS[i] || i + 1}`]));
  const apLabel = new Map();
  const bssidLabel = new Map();
  (known.aps || []).forEach((ap, i) => {
    apLabel.set(ap.id, `Access point ${i + 1}`);
    for (const [band, b] of Object.entries(ap.bssid || {})) bssidLabel.set(String(b).toLowerCase(), `AP${i + 1} radio ${band} GHz`);
  });
  const nodeLabel = new Map();
  const counters = {};
  for (const node of known.nodes || []) {
    const kind = node.type === 'wired' ? 'Wired reference' : node.type === 'client' ? 'Client' : 'Sensor';
    counters[kind] = (counters[kind] || 0) + 1;
    nodeLabel.set(node.id, `${kind} ${counters[kind]}`);
  }
  const neighbours = new Map();

  return {
    enabled,
    address: () => (enabled ? '' : known.address || ''),
    house: () => (enabled ? 'Home' : known.houseName || 'Home'),
    network: (id, label) => (enabled ? netLabel.get(id) || 'Network' : label),
    ssid(ssid) {
      if (!enabled) return ssid || '(hidden network)';
      if (ownSsid.has(ssid)) return ownSsid.get(ssid);
      if (!neighbours.has(ssid)) neighbours.set(ssid, `Neighbour ${neighbours.size + 1}`);
      return neighbours.get(ssid);
    },
    bssid(bssid) {
      if (!enabled) return bssid;
      const key = String(bssid).toLowerCase();
      return bssidLabel.get(key) || `radio #${shortHash(key)}`;
    },
    mac: (mac) => (enabled ? `device #${shortHash(mac)}` : mac),
    ap: (id, label) => (enabled ? apLabel.get(id) || 'Access point' : label),
    node: (id, name) => (enabled ? nodeLabel.get(id) || `Device #${shortHash(id)}` : name || id),
    nodeId: (id) => (enabled ? nodeLabel.get(id) || `device #${shortHash(id)}` : id),
  };
}
