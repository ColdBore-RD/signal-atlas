// The 3D picture: the house as a cutaway, the wave field of each level as a lit
// slice, access points with a volumetric glow, sensors with beams, labels.
// Three.js draws it. The wave solver shares the same WebGL context, so its
// state texture is sampled here directly, without any copy.

import * as THREE from '../../vendor/three/three.module.min.js';
import { OrbitControls } from '../../vendor/three/addons/controls/OrbitControls.js';
import { buildObstacles, interiorPoint, planBounds, pointInPolygon } from '../core/geometry.js';
import { signalRamp, waveRamp, rampToLut, activeTheme } from '../core/colormaps.js';

const WALL_HEIGHT = 1.25;        // the cutaway cuts every wall at this height (metres)
const MARKER_HEIGHT = 1.0;
const EXPLODE_GAP = 5.2;         // extra metres between levels at explode = 1
const NETWORK_COLOR = { home: '#ff9d6e', mesh: '#7cc7ff' };

const FIELD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Modes: 0 waves, 1 envelope, 2 fused, 3 contours.
const FIELD_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tState;      // R = wave, B = running mean of wave^2 (all levels in one atlas)
uniform sampler2D tEnv;        // R = that mean, averaged over 8 x 8 cells; G, B = energy flow; A = its upper limit
uniform sampler2D tModel;      // R = signal in dBm, G = 1 inside the house, B = metres to the nearest measured place
uniform float uSurvey;         // 1 = mark where the model is far from any measurement
uniform vec2 uFarRange;        // metres: where the mark starts and where it is full
uniform sampler2D tSignalLut;
uniform sampler2D tWaveLut;
uniform float uLevel;          // index of this level in the atlas
uniform float uLevels;
uniform int uMode;
uniform float uHasWaves;
uniform vec2 uRange;           // dBm at the two ends of the signal scale
uniform vec4 uThresholds;      // the four band limits in dBm
uniform float uWaveGain;
uniform float uAgc;
uniform float uDetailDb;
uniform float uOpacity;
uniform float uDim;
uniform float uWaveCurve;
uniform int uStyle;            // 0 = automatic gain (the continuous-tone look), 1 = brightness follows the signal level
uniform float uFlow;           // 1 = draw energy-flow arrows
uniform vec2 uTileSize;        // metres that one tile covers
uniform float uFlowCell;       // metres between arrows
uniform vec2 uLevelRange;      // dBm at which the wave brightness is 0 and 1
uniform vec3 uArrowColor;

vec3 signalColor(float dbm) {
  return texture2D(tSignalLut, vec2(clamp((dbm - uRange.x) / (uRange.y - uRange.x), 0.0, 1.0), 0.5)).rgb;
}

void main() {
  vec2 auv = vec2(vUv.x, (uLevel + vUv.y) / uLevels);
  vec2 model = texture2D(tModel, auv).rg;
  float inside = smoothstep(0.35, 0.65, model.g);
  float dbm = model.r;

  float wave = 0.0, glow = 0.0, detail = 0.0;
  // how bright a wave may be here: from the calibrated signal level, not from the animation
  float level = pow(smoothstep(uLevelRange.x, uLevelRange.y, dbm), 0.85);
  if (uHasWaves > 0.5) {
    vec4 st = texture2D(tState, auv);
    float envNear = max(st.b, 1e-12);
    float envFar = max(texture2D(tEnv, auv).r, 1e-12);
    float amp = sqrt(envFar);
    if (uStyle == 0) {
      // automatic gain: compress the huge range between "next to the access point" and "three rooms away"
      float w = st.r / pow(amp + 0.02, uAgc) * uWaveGain;
      wave = w / (1.0 + abs(w));
      float g = amp / pow(amp + 0.02, uAgc) * uWaveGain * 1.2;
      glow = g / (1.0 + g);
    } else {
      // The simulation gives the shape of the wavefront (where it is, how the walls bend it).
      // Its own strength is divided out, and the signal level of the model takes its place.
      // A pulse front is a few times stronger than the mean level here, its echoes are weaker.
      // The curve keeps the front at full strength and turns the echoes down, so that the
      // front stays readable; it does not hide them.
      float w = st.r / (amp + 2e-4);
      wave = sign(w) * pow(min(0.92, abs(w) * uWaveGain), uWaveCurve) * level;
      glow = level * 0.6;
    }
    detail = clamp(10.0 * log(envNear / envFar) / 2.302585, -uDetailDb, uDetailDb);
  }

  vec3 col;
  float alpha = 1.0;
  if (uMode == 0) {
    col = texture2D(tWaveLut, vec2(wave * 0.5 + 0.5, 0.5)).rgb;
    col += vec3(0.10, 0.13, 0.22) * glow * glow * 0.9;                      // soft bloom around busy areas
  } else if (uMode == 1) {
    col = signalColor(dbm + detail);
  } else if (uMode == 2) {
    vec3 base = signalColor(dbm + detail);
    col = base * (0.74 + 0.5 * wave);                                 // crests brighten, troughs darken
    col += vec3(1.0, 0.96, 0.86) * smoothstep(0.55, 1.0, wave) * 0.22;  // thin highlight on high crests
  } else {
    vec3 base = signalColor(dbm);
    col = base * 0.30 + vec3(0.012, 0.016, 0.024);
    float aa = max(fwidth(dbm), 1e-4);
    for (int i = 0; i < 4; i++) {
      float thr = uThresholds[i];
      float line = 1.0 - smoothstep(0.0, 1.6 * aa, abs(dbm - thr));
      col = mix(col, signalColor(thr + 4.0) * 1.15 + 0.08, line * 0.95);
    }
    // faint lines every 2.5 dB between the band limits
    float fine = abs(fract(dbm / 2.5 + 0.5) - 0.5) * 2.5;
    col += base * 0.25 * (1.0 - smoothstep(0.0, 1.2 * aa, fine));
    col += vec3(0.5, 0.6, 0.8) * max(wave, 0.0) * 0.05;
  }

  // energy-flow arrows: one per block, pointing where the signal travels on average
  if (uFlow > 0.5 && uHasWaves > 0.5) {
    vec2 pm = vUv * uTileSize;
    vec2 centre = (floor(pm / uFlowCell) + 0.5) * uFlowCell;
    vec2 cuv = vec2(centre.x / uTileSize.x, (uLevel + centre.y / uTileSize.y) / uLevels);
    vec4 flow = texture2D(tEnv, cuv);
    vec2 at = texture2D(tModel, cuv).rg;
    float there = pow(smoothstep(uLevelRange.x, uLevelRange.y, at.r), 0.85) * smoothstep(0.35, 0.65, at.g);   // arrows only inside the house
    float mag = length(flow.gb);
    float directed = clamp(mag / max(flow.a, 1e-14), 0.0, 1.0);
    vec2 dir = mag > 0.0 ? flow.gb / mag : vec2(1.0, 0.0);
    vec2 q = (pm - centre) / uFlowCell;
    vec2 r = vec2(dot(q, dir), dot(q, vec2(-dir.y, dir.x)));          // along and across the arrow
    float px = max(fwidth(pm.x) / uFlowCell, 1e-4);                    // one screen pixel, in arrow-block units
    float len = 0.20 + 0.20 * directed;                               // a longer arrow where the flow is more one-way
    float shaft = (1.0 - smoothstep(0.028, 0.028 + px, abs(r.y))) * smoothstep(-len - px, -len, r.x) * (1.0 - smoothstep(len - 0.15, len - 0.15 + px, r.x));
    float hx = (len - r.x) / 0.17;                                    // 0 at the tip, 1 at the base of the head
    float head = step(0.0, hx) * step(hx, 1.0) * (1.0 - smoothstep(0.11 * hx, 0.11 * hx + px, abs(r.y)));
    float a = max(shaft, head) * smoothstep(0.06, 0.30, directed) * there;
    col = mix(col, uArrowColor, a * 0.9);
  }

  // survey mode: dim and hatch the places that are far from every measured point
  if (uSurvey > 0.5) {
    float farness = smoothstep(uFarRange.x, uFarRange.y, texture2D(tModel, auv).b) * inside;
    vec2 ps = vUv * uTileSize;
    float px = max(fwidth(ps.x), 1e-4);
    float line = 1.0 - smoothstep(0.035, 0.035 + px, abs(fract((ps.x + ps.y) / 0.55) - 0.5));
    col = mix(col, col * 0.5, farness * 0.6);
    col = mix(col, vec3(1.0, 0.78, 0.46), farness * line * 0.55);
  }

  // outside the house: keep a ghost of the field, fading toward the edge of the grid
  vec2 e = min(vUv, 1.0 - vUv);
  float edge = smoothstep(0.0, 0.085, min(e.x, e.y));
  float outside = (uMode == 0 ? 0.42 : 0.26) * edge;
  alpha = mix(outside, 1.0, inside) * uOpacity;
  col *= mix(0.7, 1.0, inside) * uDim;
  gl_FragColor = vec4(col, alpha);
}`;

const WALL_VERT = /* glsl */ `
attribute float aHeight;
attribute vec3 aTint;
varying float vH;
varying vec3 vTint;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vH = aHeight;
  vTint = aTint;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const WALL_FRAG = /* glsl */ `
precision highp float;
varying float vH;
varying vec3 vTint;
varying vec3 vNormal;
varying vec3 vView;
uniform float uOpacity;
uniform float uFlat;   // 1 in plan mode: walls become solid lines
void main() {
  float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
  float rim = smoothstep(0.80, 1.0, vH);
  float a = 0.055 + 0.20 * fres + 0.55 * rim;
  vec3 col = vTint * (0.30 + 0.85 * fres + 1.35 * rim);
  a = mix(a, 0.9, uFlat);
  col = mix(col, vTint * 1.05, uFlat);
  gl_FragColor = vec4(col * a * uOpacity, 1.0);
}`;

const GLOW_VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

// A sphere whose brightness follows the length of the view ray inside it: it reads as a glowing volume.
const GLOW_FRAG = /* glsl */ `
precision highp float;
varying vec3 vNormal;
varying vec3 vView;
uniform vec3 uColor;
uniform float uStrength;
void main() {
  float chord = max(dot(normalize(vNormal), normalize(vView)), 0.0);
  float a = pow(chord, 2.6) * uStrength;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

const BEAM_VERT = /* glsl */ `
attribute float aT;
varying float vT;
void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const BEAM_FRAG = /* glsl */ `
precision highp float;
varying float vT;
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
void main() {
  float pulse = smoothstep(0.82, 1.0, fract(vT * 1.5 - uTime * 0.22));   // a slow bead that travels to the access point
  float ends = smoothstep(0.0, 0.08, vT) * smoothstep(1.0, 0.92, vT);
  float a = (0.16 + 0.7 * pulse) * ends * uOpacity;
  gl_FragColor = vec4(uColor * a, 1.0);
}`;

function lutTexture(bytes) {
  const tex = new THREE.DataTexture(bytes, bytes.length / 4, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function dotTexture(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  if (kind === 'ring') {
    g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 5;
    g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.stroke();
  } else if (kind === 'diamond') {
    g.fillStyle = 'rgba(255,255,255,1)';
    g.beginPath(); g.moveTo(64, 14); g.lineTo(114, 64); g.lineTo(64, 114); g.lineTo(14, 64); g.closePath(); g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.moveTo(64, 38); g.lineTo(90, 64); g.lineTo(64, 90); g.lineTo(38, 64); g.closePath(); g.fill();
  } else if (kind === 'hollow') {
    g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 12;
    g.beginPath(); g.arc(64, 64, 40, 0, Math.PI * 2); g.stroke();
  } else {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 62);
    grad.addColorStop(0, 'rgba(255,255,255,1)'); grad.addColorStop(0.42, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.55)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class AtlasScene {
  /**
   * opts: { canvas, plan, materials, grades, modelGrid, insets() -> { left, right, top, bottom } in CSS pixels }
   */
  constructor(opts) {
    this.opts = opts;
    this.plan = opts.plan;
    this.levels = [...opts.plan.levels].sort((a, b) => a.elevation - b.elevation);
    this.grades = opts.grades;
    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x05070b, 1);
    this.renderer.sortObjects = true;
    this.gl = this.renderer.getContext();
    this.pixelRatioCap = 1.5;

    const b = planBounds(this.plan, 0);
    this.center = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
    this.size = [b.maxX - b.minX, b.maxY - b.minY];
    this.scene = new THREE.Scene();
    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.persp = new THREE.PerspectiveCamera(32, 1, 0.5, 400);
    this.ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 400);
    this.camera = this.persp;
    this.controls3d = new OrbitControls(this.persp, opts.canvas);
    Object.assign(this.controls3d, { enableDamping: true, dampingFactor: 0.07, minDistance: 8, maxDistance: 110, maxPolarAngle: Math.PI * 0.48, autoRotateSpeed: 0.28, zoomSpeed: 0.7, rotateSpeed: 0.6 });
    this.controlsPlan = new OrbitControls(this.ortho, opts.canvas);
    Object.assign(this.controlsPlan, { enableRotate: false, enableDamping: true, dampingFactor: 0.1, screenSpacePanning: true, zoomSpeed: 0.9, enabled: false });
    this.controlsPlan.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.controlsPlan.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
    this.lastInteraction = -1e9;
    for (const c of [this.controls3d, this.controlsPlan]) c.addEventListener('start', () => { this.lastInteraction = performance.now(); this.controls3d.autoRotate = false; });

    this.state = { view: '3d', level: 'all', explode: 0.55, autoOrbit: true, reducedMotion: false, mode: 2, placing: false };
    this.layout = this.levels.map(() => ({ pos: new THREE.Vector3(), target: new THREE.Vector3(), opacity: 1, targetOpacity: 1 }));
    this.labels = [];
    this.labelLayer = opts.labelLayer;
    this.pulses = [];
    this.time = 0;
    this.pickables = [];

    this.signalLut = lutTexture(rampToLut(signalRamp));
    this.waveLut = lutTexture(rampToLut(waveRamp, -1, 1));
    this.modelTex = null;
    this.stateTex = [new THREE.Texture(), new THREE.Texture()];
    this.envTex = [new THREE.Texture(), new THREE.Texture()];
    this.hasWaves = false;
    this.fieldUniformsShared = {
      tState: { value: this.stateTex[0] }, tEnv: { value: this.envTex[0] }, tModel: { value: null }, tSignalLut: { value: this.signalLut }, tWaveLut: { value: this.waveLut },
      uLevels: { value: this.levels.length }, uMode: { value: 2 }, uHasWaves: { value: 0 },
      uRange: { value: new THREE.Vector2(...this.grades.display_range_dbm) },
      uThresholds: { value: new THREE.Vector4(...this.grades.bands.slice(0, 4).map((x) => x.min_dbm)) },
      uWaveGain: { value: 0.95 }, uAgc: { value: 0.5 }, uDetailDb: { value: 3.0 },
      uStyle: { value: 0 }, uWaveCurve: { value: 1.6 }, uFlow: { value: 0 }, uFlowCell: { value: 0.75 }, uArrowColor: { value: new THREE.Color(activeTheme().arrow || '#fff4dc') },
      uTileSize: { value: new THREE.Vector2(opts.waveExtent.width, opts.waveExtent.height) },
      uSurvey: { value: 0 }, uFarRange: { value: new THREE.Vector2(3, 5) },
      uLevelRange: { value: new THREE.Vector2(this.grades.display_range_dbm[0], this.grades.display_range_dbm[1] - 12) },
    };
    this.textures = { dot: dotTexture('dot'), ring: dotTexture('ring'), diamond: dotTexture('diamond'), hollow: dotTexture('hollow') };
    this.buildLevels();
    this.markers = { aps: new Map(), nodes: new Map(), probe: null, survey: [], waypoints: [], next: [] };
    this.beams = new THREE.Group();
    this.scene.add(this.beams);
    this.beamList = [];
    this.setView('3d', true);
    this.resize();
  }

  // ------------------------------------------------------------------ geometry
  toWorld(x, y, h = 0) { return new THREE.Vector3(x - this.center[0], h, y - this.center[1]); }

  buildLevels() {
    const mats = this.opts.materials.materials;
    const tints = {
      concrete: [0.62, 0.72, 0.92], 'ext-siding': [0.78, 0.86, 1.0], 'ext-brick': [1.0, 0.78, 0.66], 'int-drywall': [0.55, 0.66, 0.84], 'int-garage': [0.6, 0.7, 0.86],
      'glass-lowe': [0.45, 0.95, 1.0], 'door-glass': [0.45, 0.95, 1.0], 'door-hollow': [0.95, 0.82, 0.6], 'door-exterior': [1.0, 0.8, 0.55], 'door-garage': [0.9, 0.84, 0.72],
      masonry: [1.0, 0.7, 0.55], 'appliance-metal': [0.8, 0.84, 0.9], cabinetry: [0.6, 0.6, 0.66],
    };
    const grid = this.opts.waveExtent; // { minX, minY, width, height } of the wave grid tile
    this.levelGroups = this.levels.map((level, li) => {
      const group = new THREE.Group();
      group.name = `level-${level.id}`;
      this.world.add(group);

      // floor plate
      const contour = level.outline.map(([x, y]) => new THREE.Vector2(x - this.center[0], y - this.center[1]));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const pos = new Float32Array(contour.length * 3);
      contour.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = p.y; });
      const plateGeo = new THREE.BufferGeometry();
      plateGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      plateGeo.setIndex(tris.flat());
      const plate = new THREE.Mesh(plateGeo, new THREE.MeshBasicMaterial({ color: 0x06090f, side: THREE.DoubleSide, transparent: true, opacity: 0.96, depthWrite: true }));
      plate.position.y = -0.04;
      plate.renderOrder = 0;
      group.add(plate);

      const rim = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(contour.map((p) => new THREE.Vector3(p.x, -0.03, p.y))),
        new THREE.LineBasicMaterial({ color: 0x4a6a96, transparent: true, opacity: 0.55 }),
      );
      group.add(rim);

      // the wave slice: one rectangle that covers the whole wave grid of this level
      const x0 = grid.minX - this.center[0], x1 = x0 + grid.width, z0 = grid.minY - this.center[1], z1 = z0 + grid.height;
      const sliceGeo = new THREE.BufferGeometry();
      sliceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([x0, 0, z0, x1, 0, z0, x1, 0, z1, x0, 0, z1]), 3));
      sliceGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
      sliceGeo.setIndex([0, 2, 1, 0, 3, 2]);
      const sliceMat = new THREE.ShaderMaterial({
        vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { ...this.fieldUniformsShared, uLevel: { value: li }, uOpacity: { value: 1 }, uDim: { value: 1 } },
      });
      const slice = new THREE.Mesh(sliceGeo, sliceMat);
      slice.position.y = 0.012;
      slice.renderOrder = 1;
      slice.frustumCulled = false;
      group.add(slice);

      // walls, doors, windows as cut-away glass
      const obstacles = buildObstacles(level, mats);
      const P = [], N = [], H = [], T = [], I = [];
      const edge = [];
      const addBox = (ax, ay, bx, by, thickness, h0, h1, tint) => {
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
        if (len < 1e-4) return;
        const ux = dx / len, uy = dy / len, nx = -uy, ny = ux, t = thickness / 2;
        const c = [[ax + nx * t, ay + ny * t], [bx + nx * t, by + ny * t], [bx - nx * t, by - ny * t], [ax - nx * t, ay - ny * t]].map(([x, y]) => [x - this.center[0], y - this.center[1]]);
        const quad = (p0, p1, p2, p3, n, hs) => {
          const base = P.length / 3;
          [p0, p1, p2, p3].forEach((p, k) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); H.push(hs[k]); T.push(tint[0], tint[1], tint[2]); });
          I.push(base, base + 1, base + 2, base, base + 2, base + 3);
        };
        const hn = (h) => (h - 0) / WALL_HEIGHT;
        for (let k = 0; k < 4; k++) {
          const p = c[k], q = c[(k + 1) % 4];
          const ex = q[0] - p[0], ez = q[1] - p[1], el = Math.hypot(ex, ez) || 1;
          quad([p[0], h0, p[1]], [q[0], h0, q[1]], [q[0], h1, q[1]], [p[0], h1, p[1]], [ez / el, 0, -ex / el], [hn(h0), hn(h0), hn(h1), hn(h1)]);
        }
        quad([c[0][0], h1, c[0][1]], [c[1][0], h1, c[1][1]], [c[2][0], h1, c[2][1]], [c[3][0], h1, c[3][1]], [0, 1, 0], [1, 1, 1, 1]);
        for (let k = 0; k < 4; k++) { const p = c[k], q = c[(k + 1) % 4]; edge.push(p[0], h1 + 0.002, p[1], q[0], h1 + 0.002, q[1]); }
      };
      for (const o of obstacles) {
        if (o.kind === 'fixture') continue;
        const tint = tints[o.material] || [0.6, 0.7, 0.85];
        const th = Math.max(o.thickness, 0.07);
        if (o.kind === 'wall') addBox(o.ax, o.ay, o.bx, o.by, th, 0, WALL_HEIGHT, tint);
        else if (o.kind === 'window') { addBox(o.ax, o.ay, o.bx, o.by, th, 0, 0.45, tints['ext-siding']); addBox(o.ax, o.ay, o.bx, o.by, 0.05, 0.45, WALL_HEIGHT * 0.98, tint); }
        else if (o.kind === 'door') addBox(o.ax, o.ay, o.bx, o.by, 0.06, 0, WALL_HEIGHT * 0.9, tint);
      }
      for (const fx of level.fixtures || []) {
        const tint = (tints[fx.material] || [0.6, 0.6, 0.7]).map((v) => v * 0.7);
        const p = fx.polygon;
        const h = fx.type === 'fireplace' ? WALL_HEIGHT : 0.5;
        for (let i = 0; i < p.length; i++) { const a = p[i], q = p[(i + 1) % p.length]; addBox(a[0], a[1], q[0], q[1], 0.05, 0, h, tint); }
      }
      const wallGeo = new THREE.BufferGeometry();
      wallGeo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
      wallGeo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
      wallGeo.setAttribute('aHeight', new THREE.Float32BufferAttribute(H, 1));
      wallGeo.setAttribute('aTint', new THREE.Float32BufferAttribute(T, 3));
      wallGeo.setIndex(I);
      const wallMat = new THREE.ShaderMaterial({
        vertexShader: WALL_VERT, fragmentShader: WALL_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending, uniforms: { uOpacity: { value: 1 }, uFlat: { value: 0 } },
      });
      const walls = new THREE.Mesh(wallGeo, wallMat);
      walls.renderOrder = 3;
      group.add(walls);
      const edgeGeo = new THREE.BufferGeometry();
      edgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(edge, 3));
      const edges = new THREE.LineSegments(edgeGeo, new THREE.LineBasicMaterial({ color: 0xbcd6ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
      edges.renderOrder = 4;
      group.add(edges);

      // stairs: tread lines on the floor
      const stairPts = [];
      for (const st of level.stairs || []) {
        const p = st.polygon;
        for (let i = 0; i < p.length; i++) { const a = p[i], q = p[(i + 1) % p.length]; stairPts.push(this.toWorld(a[0], a[1], 0.03), this.toWorld(q[0], q[1], 0.03)); }
        // treads run across the staircase: the run follows the longest edge, at any angle on the plan
        let run = [1, 0], longest = 0;
        for (let i = 0; i < p.length; i++) {
          const a = p[i], q = p[(i + 1) % p.length], len = Math.hypot(q[0] - a[0], q[1] - a[1]);
          if (len > longest) { longest = len; run = [(q[0] - a[0]) / len, (q[1] - a[1]) / len]; }
        }
        const across = [-run[1], run[0]];
        const along = p.map((v) => v[0] * run[0] + v[1] * run[1]), side = p.map((v) => v[0] * across[0] + v[1] * across[1]);
        const s0 = Math.min(...along), s1 = Math.max(...along), t0 = Math.min(...side), t1 = Math.max(...side);
        const n = Math.max(3, Math.round((s1 - s0) / 0.28));
        const PIECES = 8;
        for (let k = 1; k < n; k++) {
          const s = s0 + ((s1 - s0) * k) / n;
          for (let j = 0; j < PIECES; j++) {
            const ta = t0 + ((t1 - t0) * j) / PIECES, tb = t0 + ((t1 - t0) * (j + 1)) / PIECES, tm = (ta + tb) / 2;
            // an L-shaped staircase: draw only the pieces of the tread that lie on the stairs
            if (!pointInPolygon(run[0] * s + across[0] * tm, run[1] * s + across[1] * tm, p)) continue;
            stairPts.push(this.toWorld(run[0] * s + across[0] * ta, run[1] * s + across[1] * ta, 0.03), this.toWorld(run[0] * s + across[0] * tb, run[1] * s + across[1] * tb, 0.03));
          }
        }
      }
      if (stairPts.length) {
        const stairs = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(stairPts), new THREE.LineBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.42, depthWrite: false }));
        stairs.renderOrder = 2;
        group.add(stairs);
      }

      // labels: level tag and room names
      const b = level.outline.reduce((acc, [x, y]) => ({ minX: Math.min(acc.minX, x), maxY: Math.max(acc.maxY, y), minY: Math.min(acc.minY, y), maxX: Math.max(acc.maxX, x) }), { minX: 1e9, maxY: -1e9, minY: 1e9, maxX: -1e9 });
      const synthetic = level.source === 'synthetic';
      const tag = this.addLabel({
        html: `<span class="lvl-name">${escapeHtml(level.name)}</span><span class="lvl-src ${synthetic ? 'is-synth' : ''}">${synthetic ? 'SYNTHETIC LAYOUT' : level.source === 'lidar-scan' ? 'LiDAR scan' : level.source === 'lidar-trace' ? 'LiDAR trace' : level.source === 'image-trace' ? 'traced from an image' : level.source === 'drawn' ? 'drawn by hand' : 'measured'}</span>`,
        className: 'label level-tag', level: li, x: b.minX, y: b.maxY, h: 0, anchor: 'r', priority: 100,
      });
      tag.planAnchor = [b.minX, b.minY];
      tag.corners = level.outline;     // in 3D the tag sits beside the outline corner that is furthest left on screen
      for (const room of level.rooms || []) {
        const [rx, ry] = interiorPoint(room.polygon, 0.3);
        const lab = this.addLabel({ html: '', className: 'label room-label', level: li, x: rx, y: ry, h: 0.05, anchor: 'c', priority: 10, kind: 'room' });
        lab.room = room;
      }
      return { group, level, slice, sliceMat, walls, wallMat, edges, plate, rim };
    });
  }

  addLabel({ html, className, level, x, y, h, anchor = 'c', priority = 0, kind = '' }) {
    const el = document.createElement('div');
    el.className = className;
    el.innerHTML = html;
    this.labelLayer.appendChild(el);
    const label = { el, level, x, y, h, anchor, priority, kind, shown: true, w: 0, hgt: 0, world: new THREE.Vector3(), visible: () => true };
    this.labels.push(label);
    return label;
  }

  removeLabel(label) {
    label.el.remove();
    this.labels = this.labels.filter((l) => l !== label);
  }

  // ------------------------------------------------------------------ textures
  /** Hand the solver's two state textures to Three.js (raw WebGL textures, no copy). */
  bindSolver(solver) {
    this.solver = solver;
    this.hasWaves = !!solver;
    this.fieldUniformsShared.uHasWaves.value = solver ? 1 : 0;
    if (!solver) return;
    [...solver.textures, ...solver.envTextures].forEach((raw, i) => {
      const props = this.renderer.properties.get(i < 2 ? this.stateTex[i] : this.envTex[i - 2]);
      props.__webglTexture = raw;
      props.__webglInit = true;
    });
  }

  /** The active colour theme changed: rebuild the two lookup textures and the arrow colour. */
  setTheme() {
    this.signalLut.image.data.set(rampToLut(signalRamp));
    this.signalLut.needsUpdate = true;
    this.waveLut.image.data.set(rampToLut(waveRamp, -1, 1));
    this.waveLut.needsUpdate = true;
    this.fieldUniformsShared.uArrowColor.value.set(activeTheme().arrow || '#ffffff');
  }

  /**
   * How the wave field is drawn. levelLinked: brightness follows the calibrated signal
   * level (else the old automatic gain). flow: draw the energy-flow arrows. gain: wave contrast.
   */
  setWaveStyle({ levelLinked, flow, gain }) {
    const u = this.fieldUniformsShared;
    u.uStyle.value = levelLinked ? 1 : 0;
    u.uFlow.value = flow ? 1 : 0;
    u.uWaveGain.value = gain ?? (levelLinked ? 0.27 : 0.95);
  }

  /** dbm: Float32Array(levels * cells) on the model grid. inside: Uint8Array of the same size. */
  setModelField(dbm, inside, nx, ny) {
    const n = nx * ny * this.levels.length;
    if (!this.modelTex || this.modelTex.image.width !== nx) {
      this.modelData = new Uint16Array(n * 4);
      this.modelTex = new THREE.DataTexture(this.modelData, nx, ny * this.levels.length, THREE.RGBAFormat, THREE.HalfFloatType);
      this.modelTex.minFilter = this.modelTex.magFilter = THREE.LinearFilter;
      this.modelTex.wrapS = this.modelTex.wrapT = THREE.ClampToEdgeWrapping;
      this.fieldUniformsShared.tModel.value = this.modelTex;
    }
    const toHalf = THREE.DataUtils.toHalfFloat;
    const far = this.sampleDistance;
    for (let k = 0; k < n; k++) {
      this.modelData[k * 4] = toHalf(Math.max(-150, dbm[k]));
      this.modelData[k * 4 + 1] = toHalf(inside[k] ? 1 : 0);
      this.modelData[k * 4 + 2] = toHalf(far ? far[k] : 0);
    }
    this.modelTex.needsUpdate = true;
    this.lastField = { dbm, inside, nx, ny };
  }

  /** Metres to the nearest measured place for every cell of the signal grid (see AtlasModel.sampleDistance). */
  setSampleDistance(grid) {
    this.sampleDistance = grid;
    if (this.lastField) this.setModelField(this.lastField.dbm, this.lastField.inside, this.lastField.nx, this.lastField.ny);
  }

  /** Survey mode on or off: the hatch for places far from any measurement, and the waypoint markers. */
  setSurveyMode(on) {
    this.fieldUniformsShared.uSurvey.value = on ? 1 : 0;
    this.surveyOn = !!on;
  }

  /**
   * Numbered markers of the survey waypoints and "measure here" markers.
   * waypoints: [{ seq, level, x, y, color, text }]. next: [{ level, x, y, text }].
   * They show only in survey mode.
   */
  setSurveyMarkers(waypoints, next) {
    for (const m of [...this.markers.waypoints, ...this.markers.next]) { m.sprite?.parent?.remove(m.sprite); this.removeLabel(m.label); }
    this.markers.waypoints = [];
    this.markers.next = [];
    const add = (list, p, className, texture, size) => {
      const li = this.levelIndex(p.level);
      if (li < 0) return;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, color: new THREE.Color(p.color || '#ffffff'), transparent: true, depthWrite: false, depthTest: false }));
      sprite.scale.setScalar(size);
      sprite.position.set(p.x - this.center[0], 0.08, p.y - this.center[1]);
      sprite.renderOrder = 11;
      this.levelGroups[li].group.add(sprite);
      const label = this.addLabel({ html: p.text, className, level: li, x: p.x, y: p.y, h: 0.1, anchor: 'b', priority: className.includes('next') ? 65 : 75 });
      label.visible = () => !!this.surveyOn;
      list.push({ sprite, label });
    };
    for (const p of waypoints) add(this.markers.waypoints, p, 'label wp-label', this.textures.hollow, 0.5);
    for (const p of next) add(this.markers.next, p, 'label next-label', this.textures.diamond, 0.42);
  }

  // ------------------------------------------------------------------ view state
  setMode(mode) { this.state.mode = mode; this.fieldUniformsShared.uMode.value = mode; }

  setView(view, instant = false) {
    this.state.view = view;
    const plan = view === 'plan';
    this.camera = plan ? this.ortho : this.persp;
    this.controls3d.enabled = !plan;
    this.controlsPlan.enabled = plan;
    if (plan) {
      this.ortho.position.set(0, 120, 0.0001);
      this.ortho.up.set(0, 0, -1);
      this.ortho.lookAt(0, 0, 0);
      this.controlsPlan.target.set(0, 0, 0);
      this.frameChanged = true;
    } else if (instant || !this.persp.userData.placed) {
      this.persp.position.set(-25, 25.5, 38);
      this.controls3d.target.set(0, 0.6, 0);
      this.persp.userData.placed = true;
    }
    for (const lg of this.levelGroups) lg.wallMat.uniforms.uFlat.value = plan ? 1 : 0;
    this.updateLayoutTargets(instant);
    this.resize();
  }

  setLevel(level) { this.state.level = level; this.updateLayoutTargets(); this.frameChanged = true; }
  setExplode(v) { this.state.explode = v; this.updateLayoutTargets(); }

  updateLayoutTargets(instant = false) {
    const { view, level, explode } = this.state;
    const n = this.levels.length;
    const shownIdx = this.levels.map((l, i) => (level === 'all' || l.id === level ? i : -1)).filter((i) => i >= 0);
    this.levels.forEach((l, i) => {
      const lay = this.layout[i];
      const shown = level === 'all' || l.id === level;
      lay.targetOpacity = shown ? 1 : 0;
      if (view === 'plan') {
        const slot = shownIdx.indexOf(i);
        const gap = this.size[0] + 3.2;
        lay.target.set(shown ? (slot - (shownIdx.length - 1) / 2) * gap : 0, 0, 0);
      } else {
        const mid = (n - 1) / 2;
        const base = l.elevation + (i - mid) * EXPLODE_GAP * explode;
        lay.target.set(0, level === 'all' ? base : 0, 0);
      }
      if (instant) { lay.pos.copy(lay.target); lay.opacity = lay.targetOpacity; }
    });
    this.beamsDirty = true;
  }

  levelIndex(id) { return this.levels.findIndex((l) => l.id === id); }

  /** World position of a floor-plan point on a level, h metres above its floor. */
  worldOf(levelIndex, x, y, h = 0) {
    const lay = this.layout[levelIndex];
    return new THREE.Vector3(x - this.center[0] + lay.pos.x, h + lay.pos.y, y - this.center[1] + lay.pos.z);
  }

  // ------------------------------------------------------------------ markers
  setAccessPoints(aps, redact) {
    for (const m of this.markers.aps.values()) { m.group.parent?.remove(m.group); this.removeLabel(m.label); }
    this.markers.aps.clear();
    for (const ap of aps) {
      const li = this.levelIndex(ap.position.level);
      if (li < 0) continue;
      // networkColors is set by the page from the list of networks; the fixed pair is the fallback
      const css = (this.networkColors || NETWORK_COLOR)[ap.network] || '#ffffff';
      const color = new THREE.Color(css);
      const group = new THREE.Group();
      const glowMat = (strength) => new THREE.ShaderMaterial({ vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uColor: { value: color.clone() }, uStrength: { value: strength } } });
      const halo = new THREE.Mesh(new THREE.SphereGeometry(1.25, 28, 18), glowMat(0.42));
      const inner = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), glowMat(1.1));
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      halo.renderOrder = 6; inner.renderOrder = 7; core.renderOrder = 8;
      const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -MARKER_HEIGHT, 0), new THREE.Vector3(0, 0, 0)]), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.5 }));
      const foot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.textures.ring, color, transparent: true, opacity: 0.0, depthWrite: false }));
      group.add(halo, inner, core, stem, foot);
      const label = this.addLabel({ html: '', className: 'label ap-label', level: li, x: ap.position.x, y: ap.position.y, h: MARKER_HEIGHT + 0.55, anchor: 'b', priority: 80 });
      label.el.dataset.net = ap.network;
      if (/^#[0-9a-f]{6}$/i.test(css) && css !== '#ffffff') label.el.style.borderColor = `${css}99`;
      const marker = { ap, group, halo, inner, core, label, level: li, color };
      this.levelGroups[li].group.add(group);
      this.markers.aps.set(ap.id, marker);
      this.placeAp(ap.id, ap.position);
    }
    this.refreshApLabels(redact);
  }

  refreshApLabels(redact) {
    for (const m of this.markers.aps.values()) {
      const source = m.ap.position.source || '';
      // say where a position comes from when it is not one the owner dragged into place
      const tag = source === 'guess' ? 'position guess' : /marks/i.test(source) ? 'from the owner\'s marks' : '';
      m.label.el.innerHTML = `<b>${escapeHtml(redact.ap(m.ap.id, m.ap.label))}</b>${tag ? `<i>${tag}</i>` : ''}`;
      m.label.w = 0;
    }
  }

  placeAp(apId, position) {
    const m = this.markers.aps.get(apId);
    if (!m) return;
    const li = this.levelIndex(position.level);
    if (li !== m.level && li >= 0) { this.levelGroups[li].group.add(m.group); m.level = li; m.label.level = li; }
    m.group.position.set(position.x - this.center[0], MARKER_HEIGHT, position.y - this.center[1]);
    m.label.x = position.x; m.label.y = position.y;
    // two access points side by side: lift the label of the later one so both can be read
    let lift = 0;
    for (const other of this.markers.aps.values()) {
      if (other === m) break;
      if (other.level === m.level && Math.hypot(other.ap.position.x - position.x, other.ap.position.y - position.y) < 1.6) lift += 0.95;
    }
    m.label.h = MARKER_HEIGHT + 0.55 + lift;
    this.beamsDirty = true;
  }

  setActiveAps(ids) {
    for (const [id, m] of this.markers.aps) {
      const on = ids.includes(id);
      m.halo.material.uniforms.uStrength.value = on ? 0.42 : 0.06;
      m.inner.material.uniforms.uStrength.value = on ? 1.1 : 0.25;
      m.active = on;
      m.label.el.classList.toggle('is-off', !on);
    }
  }

  setNodes(nodes) {
    for (const m of this.markers.nodes.values()) { m.group.parent?.remove(m.group); this.removeLabel(m.label); }
    this.markers.nodes.clear();
    nodes.forEach((node, index) => {
      if (!node.position) return;
      const li = this.levelIndex(node.position.level);
      if (li < 0) return;
      const group = new THREE.Group();
      const wired = node.type === 'wired';
      const size = node.type === 'client' ? 0.34 : 0.46;
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: wired ? this.textures.diamond : this.textures.dot, color: 0xffffff, transparent: true, depthWrite: false, depthTest: false }));
      dot.scale.setScalar(size);
      dot.renderOrder = 10;
      const ring = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.textures.ring, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, depthTest: false }));
      ring.renderOrder = 9;
      const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -MARKER_HEIGHT, 0), new THREE.Vector3(0, 0, 0)]), new THREE.LineBasicMaterial({ color: 0x8fa6c8, transparent: true, opacity: 0.35 }));
      group.add(stem, ring, dot);
      group.position.set(node.position.x - this.center[0], MARKER_HEIGHT, node.position.y - this.center[1]);
      this.levelGroups[li].group.add(group);
      const label = this.addLabel({ html: '', className: 'label node-label', level: li, x: node.position.x, y: node.position.y, h: MARKER_HEIGHT + 0.3, anchor: 'b', priority: wired ? 40 : node.type === 'client' ? 30 : 50, kind: 'node' });
      label.el.dataset.node = String(index);
      this.markers.nodes.set(node.id, { node, index, group, dot, ring, label, level: li, pulse: 0, lastT: -1 });
    });
  }

  /** states: output of AtlasModel.nodeStates(). colors: band id -> css colour. */
  updateNodes(states, colors, textColors, redact, animate) {
    const beams = [];
    for (const s of states) {
      const m = this.markers.nodes.get(s.node.id);
      if (!m) continue;
      const wired = s.node.type === 'wired';
      const color = wired ? '#c9d6ea' : s.online && s.link ? colors[s.link.quality.id] : '#5d6b80';
      m.dot.material.color.set(color);
      m.dot.material.map = wired ? this.textures.diamond : s.online ? this.textures.dot : this.textures.hollow;
      m.dot.material.opacity = s.online || wired ? 1 : 0.7;
      m.ring.material.color.set(color);
      const name = escapeHtml(redact.node(s.node.id, s.node.name));
      const value = wired ? '<span class="v">wired</span>' : s.online && s.link ? `<span class="v" style="color:${textColors[s.link.quality.id]}">${Math.round(s.link.rssi)}<small> dBm</small></span>` : '<span class="v off">offline</span>';
      const html = `<span class="n">${name}</span>${value}`;
      if (m.label.html !== html) { m.label.el.innerHTML = html; m.label.html = html; m.label.w = 0; }
      m.label.el.classList.toggle('is-offline', !s.online && !wired);
      if (s.link && s.link.t !== m.lastT) { if (m.lastT > 0 && animate) m.pulse = 1; m.lastT = s.link.t; }
      if (s.online && s.link?.apId && this.markers.aps.has(s.link.apId)) beams.push({ node: m, ap: this.markers.aps.get(s.link.apId), color });
      m.state = s;
    }
    const key = beams.map((b) => `${b.node.node.id}>${b.ap.ap.id}:${b.color}`).join('|');
    if (key !== this.beamKey) { this.beamKey = key; this.beamSpec = beams; this.beamsDirty = true; }
  }

  rebuildBeams() {
    for (const b of this.beamList) { b.line.geometry.dispose(); this.beams.remove(b.line); }
    this.beamList = [];
    for (const spec of this.beamSpec || []) {
      const SEG = 28;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array((SEG + 1) * 3), 3));
      geo.setAttribute('aT', new THREE.BufferAttribute(Float32Array.from({ length: SEG + 1 }, (_, i) => i / SEG), 1));
      const mat = new THREE.ShaderMaterial({ vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, uniforms: { uColor: { value: new THREE.Color(spec.color) }, uTime: { value: 0 }, uOpacity: { value: 1 } } });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 5;
      line.frustumCulled = false;
      this.beams.add(line);
      this.beamList.push({ ...spec, line, SEG, offset: Math.random() * 10 });
    }
    this.updateBeamGeometry();
  }

  updateBeamGeometry() {
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const beam of this.beamList) {
      beam.node.group.getWorldPosition(a);
      beam.ap.group.getWorldPosition(b);
      const lift = 0.35 + a.distanceTo(b) * 0.09;
      const pos = beam.line.geometry.attributes.position;
      for (let i = 0; i <= beam.SEG; i++) {
        const t = i / beam.SEG;
        pos.setXYZ(i, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t + Math.sin(Math.PI * t) * lift, a.z + (b.z - a.z) * t);
      }
      pos.needsUpdate = true;
      const vis = Math.min(this.layout[beam.node.level].opacity, this.layout[beam.ap.level].opacity);
      beam.line.visible = vis > 0.05 && this.state.view !== 'plan' || (this.state.view === 'plan' && beam.node.level === beam.ap.level && vis > 0.05);
      beam.line.material.uniforms.uOpacity.value = vis;
    }
  }

  /** Small dots for walk-test points. points: [{ level, x, y, color }] */
  setSurveyPoints(points) {
    for (const s of this.markers.survey) s.parent?.remove(s);
    this.markers.survey = [];
    const byLevel = new Map();
    for (const p of points) { const li = this.levelIndex(p.level); if (li < 0) continue; if (!byLevel.has(li)) byLevel.set(li, []); byLevel.get(li).push(p); }
    for (const [li, pts] of byLevel) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x - this.center[0], 0.06, p.y - this.center[1]]), 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(pts.flatMap((p) => new THREE.Color(p.color).toArray()), 3));
      const cloud = new THREE.Points(geo, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, map: this.textures.hollow, transparent: true, opacity: 0.9, depthWrite: false, alphaTest: 0.05 }));
      cloud.renderOrder = 4;
      this.levelGroups[li].group.add(cloud);
      this.markers.survey.push(cloud);
    }
  }

  setProbe(probe) {
    if (!this.markers.probe) {
      const group = new THREE.Group();
      const color = new THREE.Color('#f4f0ff');
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), new THREE.ShaderMaterial({ vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, uniforms: { uColor: { value: color }, uStrength: { value: 0.9 } } }));
      const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.13), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      glow.renderOrder = 7; core.renderOrder = 8;
      group.add(glow, core);
      const label = this.addLabel({ html: '<b>Virtual source</b><i>drag me</i>', className: 'label ap-label probe-label', level: 0, x: 0, y: 0, h: MARKER_HEIGHT + 0.45, anchor: 'b', priority: 90 });
      this.markers.probe = { group, label, level: 0 };
    }
    const m = this.markers.probe;
    m.group.visible = probe.on;
    m.label.visible = () => probe.on;
    const li = Math.max(0, this.levelIndex(probe.level));
    this.levelGroups[li].group.add(m.group);
    m.level = li; m.label.level = li;
    m.group.position.set(probe.x - this.center[0], MARKER_HEIGHT, probe.y - this.center[1]);
    m.label.x = probe.x; m.label.y = probe.y;
  }

  // ------------------------------------------------------------------ picking and dragging
  /** Find the marker nearest to a screen point. kinds: array of 'ap' | 'node' | 'probe'. */
  pick(clientX, clientY, kinds, radius = 26) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3();
    let best = null, bestD = radius;
    const consider = (kind, id, group, levelIndex) => {
      if (this.layout[levelIndex].opacity < 0.5 || !group.visible) return;
      group.getWorldPosition(v).project(this.camera);
      const sx = rect.left + (v.x * 0.5 + 0.5) * rect.width, sy = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - clientX, sy - clientY);
      if (d < bestD && v.z < 1) { bestD = d; best = { kind, id, levelIndex }; }
    };
    if (kinds.includes('probe') && this.markers.probe?.group.visible) consider('probe', 'probe', this.markers.probe.group, this.markers.probe.level);
    if (kinds.includes('ap')) for (const [id, m] of this.markers.aps) consider('ap', id, m.group, m.level);
    if (kinds.includes('node')) for (const [id, m] of this.markers.nodes) consider('node', id, m.group, m.level);
    return best;
  }

  /** Floor-plan point under a screen point, on the marker plane of a level. */
  planPointAt(clientX, clientY, levelIndex) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const lay = this.layout[levelIndex];
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(lay.pos.y + MARKER_HEIGHT));
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x - lay.pos.x + this.center[0], y: hit.z - lay.pos.z + this.center[1] };
  }

  setControlsEnabled(on) {
    (this.state.view === 'plan' ? this.controlsPlan : this.controls3d).enabled = on;
  }

  // ------------------------------------------------------------------ frame
  resize() {
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    this.renderer.setSize(w, h, false);
    const inset = this.opts.insets ? this.opts.insets() : { left: 0, right: 0, top: 0, bottom: 0 };
    const offX = (inset.right - inset.left) / 2, offY = (inset.bottom - inset.top) / 2;
    this.persp.aspect = w / h;
    this.persp.setViewOffset(w, h, offX, offY, w, h);
    this.persp.updateProjectionMatrix();
    // plan view: fit the shown levels into the free area between the panels
    const shown = this.state.level === 'all' ? this.levels.length : 1;
    const spanX = shown * this.size[0] + (shown - 1) * 3.2 + 3.4, spanY = this.size[1] + 3.6;
    const freeW = Math.max(200, w - inset.left - inset.right), freeH = Math.max(200, h - inset.top - inset.bottom);
    const mPerPx = Math.max(spanX / freeW, spanY / freeH);
    this.ortho.left = (-w / 2) * mPerPx; this.ortho.right = (w / 2) * mPerPx;
    this.ortho.top = (h / 2) * mPerPx; this.ortho.bottom = (-h / 2) * mPerPx;
    this.ortho.setViewOffset(w, h, offX, offY, w, h);
    if (this.frameChanged) { this.ortho.zoom = 1; this.controlsPlan.target.set(0, 0, 0); this.ortho.position.set(0, 120, 0.0001); this.frameChanged = false; }
    this.ortho.updateProjectionMatrix();
    this.viewport = { w, h };
  }

  /** Called once per frame before render. dt in seconds. */
  update(dt, nowMs) {
    this.time += dt;
    const { state } = this;
    if (this.frameChanged) this.resize();
    // idle auto-orbit
    const idle = nowMs - this.lastInteraction > 14000;
    this.controls3d.autoRotate = state.view === '3d' && state.autoOrbit && !state.reducedMotion && !state.placing && idle && !this.dragging;
    (state.view === 'plan' ? this.controlsPlan : this.controls3d).update(dt);

    let moving = false;
    const ease = state.reducedMotion ? 1 : 1 - Math.exp(-dt * 6);
    this.levelGroups.forEach((lg, i) => {
      const lay = this.layout[i];
      if (lay.pos.distanceToSquared(lay.target) > 1e-6 || Math.abs(lay.opacity - lay.targetOpacity) > 1e-3) moving = true;
      lay.pos.lerp(lay.target, ease);
      lay.opacity += (lay.targetOpacity - lay.opacity) * ease;
      lg.group.position.copy(lay.pos);
      lg.group.visible = lay.opacity > 0.02;
      lg.sliceMat.uniforms.uOpacity.value = lay.opacity;
      lg.wallMat.uniforms.uOpacity.value = lay.opacity;
      lg.plate.material.opacity = 0.96 * lay.opacity;
      lg.edges.material.opacity = (state.view === 'plan' ? 0.0 : 0.5) * lay.opacity;
      lg.rim.material.opacity = 0.55 * lay.opacity;
    });
    if (moving || this.beamsDirty) {
      this.world.updateMatrixWorld(true);
      if (this.beamsDirty && !moving) { this.rebuildBeams(); this.beamsDirty = false; } else this.updateBeamGeometry();
    }
    for (const b of this.beamList) b.line.material.uniforms.uTime.value = state.reducedMotion ? 0.35 : this.time + b.offset;

    // soft pulse when a sample arrives
    for (const m of this.markers.nodes.values()) {
      if (m.pulse > 0) {
        m.pulse = Math.max(0, m.pulse - dt / 1.8);
        const k = 1 - m.pulse;
        m.ring.scale.setScalar(0.5 + 1.6 * k);
        m.ring.material.opacity = state.reducedMotion ? 0 : 0.6 * m.pulse;
      } else m.ring.material.opacity = 0;
    }
    // access points breathe very slightly
    for (const m of this.markers.aps.values()) {
      const s = state.reducedMotion ? 1 : 1 + 0.035 * Math.sin(this.time * 1.4 + m.level);
      m.halo.scale.setScalar(s);
    }
    for (const m of this.markers.waypoints) m.sprite.visible = !!this.surveyOn;
    for (const m of this.markers.next) m.sprite.visible = !!this.surveyOn;
    if (this.solver) {
      this.fieldUniformsShared.tState.value = this.stateTex[this.solver.front];
      this.fieldUniformsShared.tEnv.value = this.envTex[this.solver.envFront];
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  /** Move the HTML labels to their projected places and hide those that would overlap. */
  updateLabels(force = false) {
    const { w, h } = this.viewport;
    const v = new THREE.Vector3();
    this.labelFrame = (this.labelFrame || 0) + 1;
    const declutter = force || this.labelFrame % 5 === 0;
    const plan = this.state.view === 'plan';
    const inset = this.opts.insets ? this.opts.insets() : { left: 0, right: 0, top: 0, bottom: 0 };
    const offX = (inset.right - inset.left) / 2, offY = (inset.bottom - inset.top) / 2;
    for (const l of this.labels) {
      const lay = this.layout[l.level];
      let on = lay.opacity > 0.5 && l.visible();
      if (l.kind === 'room') on = on && this.state.level !== 'all';
      if (on) {
        let x = l.x, y = l.y;
        if (plan && l.planAnchor) { x = l.planAnchor[0]; y = l.planAnchor[1] - 0.5; l.anchor = 'tl-up'; }
        else if (l.corners) {
          l.anchor = 'r';
          let bestX = Infinity;
          for (const c of l.corners) {
            v.set(c[0] - this.center[0] + lay.pos.x, lay.pos.y, c[1] - this.center[1] + lay.pos.z).project(this.camera);
            if (v.x < bestX) { bestX = v.x; x = c[0]; y = c[1]; }
          }
        }
        v.set(x - this.center[0] + lay.pos.x, l.h + lay.pos.y, y - this.center[1] + lay.pos.z).project(this.camera);
        on = v.z > -1 && v.z < 1;
        l.sx = (v.x * 0.5 + 0.5) * w; l.sy = (-v.y * 0.5 + 0.5) * h;
        l.depth = v.z;
      }
      l.candidate = on;
    }
    if (declutter) {
      const placed = [];
      const sorted = this.labels.filter((l) => l.candidate).sort((a, b) => b.priority - a.priority || a.depth - b.depth);
      for (const l of sorted) {
        if (!l.w) { l.w = l.el.offsetWidth || 60; l.hgt = l.el.offsetHeight || 18; }
        const r = rectOf(l);
        const clash = l.priority < 100 && placed.some((p) => r.x0 < p.x1 + 3 && r.x1 > p.x0 - 3 && r.y0 < p.y1 + 2 && r.y1 > p.y0 - 2);
        const off = r.x1 < inset.left || r.x0 > w - inset.right || r.y1 < inset.top || r.y0 > h - inset.bottom;
        l.shown = !clash && !off;
        if (l.shown) placed.push(r);
      }
      for (const l of this.labels) if (!l.candidate) l.shown = false;
    }
    for (const l of this.labels) {
      const show = l.candidate && l.shown;
      if (show) {
        const r = rectOf(l);
        if (l.corners) r.x0 = Math.max(r.x0, inset.left + 6);   // a level tag never slides under the left panel
        l.el.style.transform = `translate(${Math.round(r.x0)}px, ${Math.round(r.y0)}px)`;
      }
      if (l.isShown !== show) { l.el.style.opacity = show ? '' : '0'; l.el.style.pointerEvents = show ? '' : 'none'; l.isShown = show; }
    }
    void offX; void offY;
  }

  dispose() { this.renderer.dispose(); }
}

function rectOf(l) {
  const w = l.w || 60, h = l.hgt || 18;
  let x0 = l.sx - w / 2, y0 = l.sy - h / 2;
  if (l.anchor === 'b') y0 = l.sy - h - 6;
  if (l.anchor === 'tl') { x0 = l.sx; y0 = l.sy + 6; }
  if (l.anchor === 'tl-up') { x0 = l.sx; y0 = l.sy - h - 4; }
  if (l.anchor === 'r') { x0 = l.sx - w - 14; y0 = l.sy - h / 2; }
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
