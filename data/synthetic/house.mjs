// Builds a plausible three-level suburban house from data/synthetic/house-rules.json.
// Used only when no real floor plan exists. Every level is marked "synthetic".

const r2 = (v) => Math.round(v * 100) / 100;

export function buildSyntheticHouse(rules) {
  const W = rules.main.width, D = rules.main.depth;
  const GW = rules.garage.width, GD = rules.garage.depth;
  const F = rules.frontRoomsDepth;
  const SX = rules.stairs.x, SW = rules.stairs.width, SY0 = rules.stairs.y0, SY1 = rules.stairs.y1;
  const X1 = 5.0;              // living room / hall
  const X2 = r2(SX + SW);      // stairs / front-right room
  const outline = [[0, 0], [W + GW, 0], [W + GW, GD], [W, GD], [W, D], [0, D]];
  const stairPoly = [[SX, SY0], [X2, SY0], [X2, SY1], [SX, SY1]];

  const wall = (ax, ay, bx, by, material) => ({ a: [r2(ax), r2(ay)], b: [r2(bx), r2(by)], material });
  const opening = (type, ax, ay, bx, by, material, extra = {}) => ({ type, a: [r2(ax), r2(ay)], b: [r2(bx), r2(by)], material, ...extra });
  const room = (id, name, x0, y0, x1, y1) => ({ id, name, nameSource: 'synthetic', polygon: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });

  function shell(material, frontMaterial) {
    return outline.map((p, i) => {
      const q = outline[(i + 1) % outline.length];
      const front = p[1] === 0 && q[1] === 0;
      return wall(p[0], p[1], q[0], q[1], front && frontMaterial ? frontMaterial : material);
    });
  }
  function windows(width, every, skip = []) {
    const out = [];
    outline.forEach((p, i) => {
      const q = outline[(i + 1) % outline.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const n = Math.floor(len / every);
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const cx = p[0] + (q[0] - p[0]) * t, cy = p[1] + (q[1] - p[1]) * t;
        if (skip.some(([x0, y0, x1, y1]) => cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1)) continue;
        const ux = (q[0] - p[0]) / len, uy = (q[1] - p[1]) / len;
        out.push(opening('window', cx - (ux * width) / 2, cy - (uy * width) / 2, cx + (ux * width) / 2, cy + (uy * width) / 2, 'glass-lowe'));
      }
    });
    return out;
  }
  const stairWalls = [wall(SX, 0, SX, SY1, 'int-drywall'), wall(X2, 0, X2, F, 'int-drywall')];
  const L = rules.levels;
  const base = (id) => ({ id, name: L[id].name, elevation: L[id].elevation, height: L[id].height, source: 'synthetic', outline });

  const main = {
    ...base('1'), floorMaterial: 'floor-wood',
    rooms: [
      room('1-living', 'Living room', 0, 0, X1, F),
      room('1-hall', 'Entry hall', X1, 0, X2, F),
      room('1-office', 'Office', X2, 0, W, F),
      room('1-kitchen', 'Kitchen', 0, F, 5.5, D),
      room('1-family', 'Family room', 5.5, F, W, D),
      room('1-garage', 'Garage', W, 0, W + GW, GD),
    ],
    walls: [
      ...shell(L['1'].shell, L['1'].front),
      wall(W, 0, W, GD, 'int-garage'),
      wall(X1, 0, X1, F, 'int-drywall'),
      ...stairWalls,
      wall(0, F, W, F, 'int-drywall'),
      wall(5.5, F, 5.5, D, 'int-drywall'),
    ],
    openings: [
      ...windows(rules.window.width, rules.window.everyMetres, [[5.2, -0.1, 7.0, 0.1], [W + 0.3, -0.1, W + GW - 0.3, 0.1], [7.0, D - 0.1, 9.8, D + 0.1]]),
      opening('door', 5.6, 0, 6.5, 0, 'door-exterior', { id: 'front-door', state: 'closed' }),
      opening('door', W + 0.6, 0, W + GW - 0.6, 0, 'door-garage', { id: 'garage-door', state: 'closed' }),
      opening('door', 7.5, D, 9.3, D, 'door-glass', { id: 'patio-door', state: 'closed' }),
      opening('opening', X1, 1.5, X1, 3.2, 'open'),
      opening('opening', 5.6, F, 6.9, F, 'open'),
      opening('door', 9.2, F, 10.0, F, 'door-hollow', { state: 'open' }),
      opening('opening', 5.5, 6.0, 5.5, 7.6, 'open'),
      opening('opening', 1.5, F, 2.6, F, 'open'),
      opening('door', W, 5.0, W, 5.8, 'door-exterior', { id: 'garage-entry', state: 'closed' }),
    ],
    stairs: [{ id: 'main-stairs', polygon: stairPoly, connects: ['B', '2'] }],
    fixtures: [
      { type: 'appliance', name: 'Range', material: 'appliance-metal', polygon: [[0.1, 6.2], [0.75, 6.2], [0.75, 6.95], [0.1, 6.95]] },
      { type: 'appliance', name: 'Refrigerator', material: 'appliance-metal', polygon: [[0.1, 4.7], [0.85, 4.7], [0.85, 5.5], [0.1, 5.5]] },
      { type: 'counter', name: 'Kitchen island', material: 'cabinetry', polygon: [[2.2, 6.2], [4.0, 6.2], [4.0, 7.2], [2.2, 7.2]] },
      { type: 'fireplace', material: 'masonry', polygon: [[8.0, D - 0.5], [9.6, D - 0.5], [9.6, D + 0.3], [8.0, D + 0.3]] },
    ],
  };
  // the fireplace replaces the patio door position: move the patio door
  main.openings = main.openings.map((o) => (o.id === 'patio-door' ? opening('door', 6.0, D, 7.6, D, 'door-glass', { id: 'patio-door', state: 'closed' }) : o));

  const upper = {
    ...base('2'), floorMaterial: 'floor-wood',
    rooms: [
      room('2-bed2', 'Bedroom 2', 0, 0, X1, F),
      room('2-hall', 'Upper hall', X1, 0, X2, F),
      room('2-bed3', 'Bedroom 3', X2, 0, W, F),
      room('2-primary', 'Primary bedroom', 0, F, 6.5, D),
      room('2-bath', 'Bath', 6.5, F, 9.0, D),
      room('2-bed4', 'Bedroom 4', 9.0, F, W, D),
      room('2-bonus', 'Bonus room', W, 0, W + GW, GD),
    ],
    walls: [
      ...shell(L['2'].shell),
      wall(W, 0, W, GD, 'int-drywall'),
      wall(X1, 0, X1, F, 'int-drywall'),
      ...stairWalls,
      wall(0, F, W, F, 'int-drywall'),
      wall(6.5, F, 6.5, D, 'int-drywall'),
      wall(9.0, F, 9.0, D, 'int-drywall'),
    ],
    openings: [
      ...windows(rules.window.width, rules.window.everyMetres),
      opening('door', X1, 3.3, X1, 4.1, 'door-hollow', { state: 'open' }),
      opening('door', X2, 3.3, X2, 4.1, 'door-hollow', { state: 'closed' }),
      opening('door', 5.3, F, 6.1, F, 'door-hollow', { state: 'open' }),
      opening('door', 6.9, F, 7.7, F, 'door-hollow', { state: 'closed' }),
      opening('door', 9.4, F, 10.2, F, 'door-hollow', { state: 'closed' }),
      opening('door', W, 3.4, W, 4.2, 'door-hollow', { state: 'open' }),
    ],
    stairs: [{ id: 'main-stairs', polygon: stairPoly, connects: ['1'] }],
    fixtures: [],
  };

  const basement = {
    ...base('B'),
    rooms: [
      room('B-utility', 'Utility room', 0, 0, X1, F),
      room('B-hall', 'Basement hall', X1, 0, X2, F),
      room('B-storage', 'Storage', X2, 0, W, F),
      room('B-rec', 'Rec room', 0, F, W, D),
      room('B-crawl', 'Under-garage storage', W, 0, W + GW, GD),
    ],
    walls: [
      ...shell(L.B.shell),
      wall(W, 0, W, GD, 'concrete'),
      wall(X1, 0, X1, F, 'int-drywall'),
      ...stairWalls,
      wall(0, F, W, F, 'int-drywall'),
    ],
    openings: [
      ...windows(rules.window.basementWidth, rules.window.basementEveryMetres),
      opening('door', X1, 3.3, X1, 4.1, 'door-hollow', { state: 'closed' }),
      opening('door', X2, 3.3, X2, 4.1, 'door-hollow', { state: 'closed' }),
      opening('opening', 5.4, F, 6.9, F, 'open'),
      opening('door', W, 3.0, W, 3.8, 'door-exterior', { state: 'closed' }),
    ],
    stairs: [{ id: 'main-stairs', polygon: stairPoly, connects: ['1'] }],
    fixtures: [
      { type: 'appliance', name: 'Furnace and water heater', material: 'appliance-metal', polygon: [[0.4, 0.4], [1.9, 0.4], [1.9, 1.2], [0.4, 1.2]] },
    ],
  };

  return {
    schemaVersion: 1,
    name: rules.name,
    units: 'm',
    note: 'SYNTHETIC LAYOUT. Generated by data/synthetic/generate.mjs from data/synthetic/house-rules.json. Not a real house.',
    levels: [basement, main, upper],
  };
}
