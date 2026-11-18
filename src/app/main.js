// Signal Atlas: start-up, state, the frame loop, and the wiring between the
// model, the wave solver, the 3D scene and the panels.
//
// The page only displays. It reads files under data/ and, when present, the
// read-only feed at /live. The one thing it can save is the position of the
// access-point markers (PUT /api/ap-positions on the local dev server).

import { mergeConfig, applyApPositions, bandList } from '../core/config.js';
import { validateFloorplan, formatIssues } from '../core/validate.js';
import { SampleStore, parseNdjson } from '../core/samples.js';
import { createRedactor } from '../core/privacy.js';
import { bandColors, bandTextColors, signalRamp, dbmToT, toHex, THEMES, THEME_ORDER, customTheme, setActiveTheme, themeRamps, CUSTOM_DEFAULT } from '../core/colormaps.js';
import { checkTheme } from '../core/colorcheck.js';
import { bandOf } from '../core/metrics.js';
import { waypointsFromRows } from '../core/survey.js';
import { pointInPolygon, sortedLevels } from '../core/geometry.js';
import { WaveSolver } from '../sim/wave-solver.js';
import { QUALITY, QUALITY_ORDER, COURANT, STAIR_COUPLING, waveGridSpec, waveArea, rasterizeMedium, buildSources, toCell, spreadingLossDbPerM, sourceAmplitudes, beaconSchedule } from '../sim/rasterize.js';
import { AtlasModel } from './atlas-model.js';
import { AtlasScene, escapeHtml as esc } from './scene.js';
import { drawHistory, drawChannels, drawTimeline } from './charts.js';
import * as ui from './ui.js';
import { wantsUserLayout, userConfig, placeDefaultAps } from '../core/layout.js';
import { initLayoutSetup, loadUserLayout } from './setup-layout.js';
import { applySetup, networkColors } from '../core/setup.js';
import { loadSetup, createSetupPanel } from './setup-network.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const flag = (name) => params.has(name) && params.get(name) !== '0' && params.get(name) !== 'false';
const LIGHT_MHZ = 299.792458;
const DAY = 24 * 3600e3;

async function getJson(path, optional = false) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) { if (optional) return null; throw new Error(`${path}: HTTP ${res.status}`); }
    return await res.json();
  } catch (e) {
    if (optional) return null;
    throw new Error(`could not read ${path}: ${e.message}`);
  }
}
async function getText(path) {
  try { const res = await fetch(path, { cache: 'no-store' }); return res.ok ? await res.text() : null; } catch { return null; }
}

function showBanner(html) { const b = $('banner'); b.innerHTML = html; b.hidden = false; }
/** A short message in the banner for the result of a Survey click; it hides itself (a warning stays longer). */
let toastTimer = 0;
function surveyToast(html, warn = false) {
  showBanner(html);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('banner').hidden = true; }, warn ? 9000 : 4000);
}

async function boot() {
  const bootText = $('boot-text');
  // ---------------------------------------------------------------- files
  const [base, local, materials, grades, schema] = await Promise.all([
    getJson('data/config.default.json'), flag('demo') ? null : getJson('data/private/config.local.json', true),
    getJson('data/materials.json'), getJson('data/grades.json'), getJson('data/schema/floorplan.schema.json'),
  ]);
  let config = local ? mergeConfig(base, local) : base;
  const notes = [];
  // A layout from the Layout setup panel lives in data/user/, apart from data/private/ (docs/custom-layout.md).
  // ?demo=1 reads neither. ?layout=user asks for it; without a private config it is the default.
  const userLayout = wantsUserLayout({ demo: flag('demo'), layout: params.get('layout'), hasPrivateConfig: !!local }) ? await loadUserLayout(getJson) : null;
  if (userLayout) config = userConfig(base, userLayout);
  let plan = userLayout ? userLayout.plan : await getJson(config.paths.floorplan, true);
  let issues = plan ? validateFloorplan(plan, schema, materials) : { errors: [{ path: '', message: `${config.paths.floorplan} is missing` }], warnings: [] };
  if (issues.errors.length) {
    if (config.paths.floorplan !== base.paths.floorplan) {
      notes.push(`<b>The floor plan ${esc(config.paths.floorplan)} cannot be used.</b> The synthetic demo house is shown instead.\n${formatIssues(issues.errors).slice(0, 6).map(esc).join('\n')}${issues.errors.length > 6 ? `\nand ${issues.errors.length - 6} more. Run: node tools/validate-floorplan.mjs` : ''}`);
      config = base;
      plan = await getJson(base.paths.floorplan);
      issues = validateFloorplan(plan, schema, materials);
    }
    if (issues.errors.length) throw new Error(`The floor plan is not valid:\n${formatIssues(issues.errors).slice(0, 8).join('\n')}`);
  }
  bootText.textContent = 'Reading samples';
  const nodesFile = (await getJson(config.paths.nodes, true)) || { nodes: [] };
  const store = new SampleStore();
  const allRows = [];
  for (const path of config.paths.samples || []) {
    const text = await getText(path);
    if (text == null) { notes.push(`The sample file ${esc(path)} is missing.`); continue; }
    const parsed = parseNdjson(text);
    for (const r of parsed.rows) allRows.push(r);
  }
  // Walk survey of the private house: the local server hands out the waypoints that were clicked
  // in Survey mode and the rows that tools/survey-import.mjs made from the scan logs.
  let waypoints = [], surveyServer = false;
  if (config !== base && !userLayout) {   // the survey files belong to the private house, not to a user layout
    const feed = await getJson('/api/survey', true);
    if (feed && Array.isArray(feed.waypoints)) {
      surveyServer = true;
      waypoints = waypointsFromRows(feed.waypoints);
      const listed = (config.paths.samples || []).some((p) => /(^|\/)survey\.ndjson$/.test(p));
      if (!listed) for (const r of feed.rows || []) allRows.push(r);
    }
  }
  store.addAll(allRows);
  if (store.rejected) notes.push(`${store.rejected} sample rows were skipped because they do not follow docs/data-contract.md.`);

  const levels = sortedLevels(plan);
  const levelIds = levels.map((l) => l.id);
  const savedPositions = await getJson(config.paths.apPositions, true);
  const planKey = `signal-atlas:ap-positions:${config.paths.floorplan}`;
  let localPositions = null;
  try { localPositions = JSON.parse(localStorage.getItem(planKey) || 'null'); } catch { /* ignore */ }
  // the file and this browser may both hold positions: the older one is applied first, so the newer one wins
  const savedAt = (s) => Date.parse(s?.saved || '') || 0;
  for (const saved of [savedPositions, localPositions].sort((a, b) => savedAt(a) - savedAt(b))) {
    if (saved && (!saved.floorplan || saved.floorplan === config.paths.floorplan)) config = { ...config, aps: applyApPositions(config.aps, saved, levelIds) };
  }
  // a marker saved for an earlier shape of the user's layout may now lie outside the house: it gets a new guess
  if (userLayout && config !== base) config = { ...config, aps: placeDefaultAps(config.aps, plan) };

  // The user's own networks and devices (Setup panel, key D). A saved setup replaces those of the config.
  // The owner's house keeps its setup in data/private/, a user layout in data/user/ (docs/network-setup.md).
  const setupOptions = { levelIds, bandIds: bandList(config, materials).map((b) => b.id) };
  const setupWorkspace = local && !userLayout ? 'private' : 'user';
  const setupBoot = await loadSetup({ config, nodes: nodesFile.nodes, ...setupOptions, demo: flag('demo'), workspace: setupWorkspace });
  config = setupBoot.config;
  let nodes = setupBoot.nodes;

  // ---------------------------------------------------------------- model
  bootText.textContent = 'Calibrating the model';
  await new Promise((r) => setTimeout(r, 0));
  const model = new AtlasModel({ plan, materials, grades, config, nodes, store });
  // ---------------------------------------------------------------- colour theme
  // The choice is kept in this browser. ?theme=<name> in the address wins over the saved choice.
  const THEME_KEY = 'signal-atlas:theme';
  let savedTheme = null;
  try { savedTheme = JSON.parse(localStorage.getItem(THEME_KEY) || 'null'); } catch { /* storage is not available */ }
  let custom = { ...CUSTOM_DEFAULT, ...(savedTheme?.custom && typeof savedTheme.custom === 'object' ? savedTheme.custom : {}) };
  const knownTheme = (id) => id === 'custom' || THEME_ORDER.includes(id);
  const startTheme = knownTheme(params.get('theme')) ? params.get('theme') : knownTheme(savedTheme?.id) ? savedTheme.id : 'mission';
  const themeOf = (id) => (id === 'custom' ? customTheme(custom) : THEMES[id] || THEMES.mission);
  setActiveTheme(themeOf(startTheme));
  let themeIssues = [];
  let colors = bandColors(grades);
  let textColors = bandTextColors(grades);   // the same hues, light enough for text
  const colorAt = (dbm) => toHex(signalRamp(dbmToT(dbm, grades.display_range_dbm)));
  const area = waveArea(plan);
  const inside = new Uint8Array(model.levels.length * model.cells);
  model.levels.forEach((level, li) => {
    for (let j = 0; j < model.grid.ny; j++) for (let i = 0; i < model.grid.nx; i++) {
      if (pointInPolygon(model.grid.minX + (i + 0.5) * model.grid.cell, model.grid.minY + (j + 0.5) * model.grid.cell, level.level.outline)) inside[li * model.cells + j * model.grid.nx + i] = 1;
    }
  });

  // ---------------------------------------------------------------- state
  const tEnd = Number.isFinite(store.tMax) ? store.tMax : Date.now();
  const bands = bandList(config, materials).filter((b) => model.bands.includes(b.id));
  const bandLabel = (id) => bands.find((b) => b.id === id)?.label || id;
  const state = {
    view: params.get('view') === 'plan' ? 'plan' : '3d',
    level: levelIds.includes(params.get('level')) ? params.get('level') : 'all',
    explode: params.has('explode') ? Number(params.get('explode')) : config.view?.explode ?? 0.55,
    layer: ui.LAYERS.some(([id]) => id === params.get('layer')) ? params.get('layer') : 'fused',
    band: bands.some((b) => b.id === params.get('band')) ? params.get('band') : bands[0].id,
    network: Object.keys(config.networks).includes(params.get('network')) ? params.get('network') : 'best',
    paused: false, speed: 1, quality: QUALITY[params.get('quality')] ? params.get('quality') : config.wave?.quality || 'auto',
    probe: flag('probe'), autoOrbit: params.has('orbit') ? flag('orbit') : config.view?.autoOrbit !== false,
    reducedMotion: flag('reduced') || window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    privacy: flag('privacy'), placing: false, survey: flag('survey'), setup: false,
    theme: startTheme,
    waveModel: ui.WAVE_MODELS.some(([id]) => id === params.get('waves')) ? params.get('waves') : ui.WAVE_MODELS.some(([id]) => id === config.wave?.model) ? config.wave.model : 'beacon',
    mode: 'recorded', replaySpeed: 720, cursor: tEnd, selectedNode: null, liveAvailable: false,
  };
  if (params.has('t')) {
    const f = Number(params.get('t'));
    const start = Math.max(store.tMin, tEnd - DAY);
    state.cursor = Number.isFinite(f) && f >= 0 && f <= 1 ? start + f * (tEnd - start) : Date.parse(params.get('t')) || tEnd;
  }
  document.body.classList.toggle('hide-ui', params.get('ui') === '0');
  document.body.classList.toggle('reduced-motion', state.reducedMotion);
  const probe = { on: state.probe, level: levels[Math.min(1, levels.length - 1)].id, x: area.minX + area.width * 0.5, y: area.minY + area.height * 0.5 };

  let redact;
  const makeRedactor = () => {
    redact = createRedactor({
      address: config.private?.address, houseName: config.private?.houseName,
      networks: Object.entries(config.networks).map(([id, n]) => ({ id, ssid: n.ssid, label: n.label })),
      aps: config.aps, nodes: model.nodes,   // every access point, also one that is not placed yet
    }, state.privacy);
  };
  makeRedactor();

  // ---------------------------------------------------------------- scene
  const insets = () => {
    if (document.body.classList.contains('hide-ui')) return { left: 0, right: 0, top: 0, bottom: 0 };
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return {
      left: $('controls').getBoundingClientRect().right + 0.5 * rem, right: window.innerWidth - $('metrics').getBoundingClientRect().left + 0.5 * rem,
      top: $('topbar').offsetHeight * 0.8, bottom: window.innerHeight - $('timeline').getBoundingClientRect().top + 6.6 * rem,
    };
  };
  const scene = new AtlasScene({ canvas: $('stage'), labelLayer: $('labels'), plan, materials, grades, waveExtent: area, insets });
  scene.state.explode = state.explode; scene.state.autoOrbit = state.autoOrbit; scene.state.reducedMotion = state.reducedMotion;
  const gl = scene.gl;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const rendererName = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  const software = /swiftshader|llvmpipe|software|basic render/i.test(rendererName);

  // front-door marker
  const fd = config.site?.frontDoor;
  if (fd && levelIds.includes(fd.level)) {
    scene.addLabel({ html: `<b>Front door</b>${fd.source === 'guess' ? '<i>guess</i>' : fd.source === 'inferred' ? '<i>inferred</i>' : ''}`, className: 'label ap-label', level: scene.levelIndex(fd.level), x: fd.x + (fd.outward?.[0] || 0) * 0.9, y: fd.y + (fd.outward?.[1] || 0) * 0.9, h: 0.1, anchor: 'c', priority: 60 });
  }

  // ---------------------------------------------------------------- wave solver
  const perf = { ema: 16.7, jsMs: 0, simMs: 0, frames: 0, sinceChange: 0, ceiling: QUALITY_ORDER.length - 1, quality: 'high', pixelCap: 1.5, recent: [], renderer: rendererName, software };
  let solver = null, spec = null, wave = null, wavesWhy = WaveSolver.unsupportedReason(gl);
  let simAcc = 0, pendingSteps = 0, fieldMoved = true;

  const floorLossDb = (band) => {
    const p = model.calibration.params[band];
    const idx = model.ctx.featureKind.findIndex((k) => k === 'floor');
    return idx >= 0 ? p.loss[idx] : materials.floors[materials.defaults.floor_material].loss_db[band];
  };
  /** materials.json with the calibrated wall losses put in, so the waves lose what the model says. */
  const calibratedMaterials = (band) => {
    const p = model.calibration.params[band];
    const out = { ...materials, materials: { ...materials.materials } };
    model.ctx.featureNames.forEach((name, f) => {
      if (model.ctx.featureKind[f] !== 'wall' || !out.materials[name]) return;
      out.materials[name] = { ...out.materials[name], loss_db: { ...out.materials[name].loss_db, [band]: p.loss[f] } };
    });
    return out;
  };
  function waveNumbers() {
    const real = LIGHT_MHZ / materials.pathLoss[state.band].freq_mhz;
    // One scale for every band. The grid must resolve the shortest wavelength of all bands, so the
    // scale may be more than the configured one on a coarse grid; the ratio between the wavelengths
    // of two bands on screen is then still the real ratio.
    const shortest = Math.min(...bands.map((b) => LIGHT_MHZ / b.freq_mhz));
    const scale = Math.max(config.wave?.wavelengthScale ?? 10, (7.5 * spec.dx) / shortest);
    const lambda = scale * real;
    const stepsPerPeriod = lambda / (COURANT * spec.dx);
    const dtSim = (COURANT * spec.dx) / (config.wave?.speed_m_per_s ?? 1.6);
    const pulsed = state.waveModel !== 'tone';
    // one beacon interval on screen, and the length of one beacon pulse (a short wave packet)
    const beaconSteps = Math.max(40, Math.round((config.wave?.beaconPeriod_s ?? 5) / dtSim));
    const pulseSteps = Math.round(Math.max(1, Math.round(config.wave?.pulseCycles ?? 2)) * stepsPerPeriod);
    return {
      real, lambda, scale, stepsPerPeriod, dtSim, pulsed, beaconSteps, pulseSteps, omegaDt: (2 * Math.PI) / stepsPerPeriod,
      // the envelope is the mean power: over a few wave periods for a tone, over two beacon intervals for pulses
      envelopeRate: pulsed ? 1 / (2 * beaconSteps) : 1 / (2.5 * stepsPerPeriod),
      flowSeconds: pulsed ? 1.5 * beaconSteps * dtSim : 0.8,
    };
  }
  function applyMedium() {
    if (!solver) return;
    // loss in open air follows the calibrated path-loss exponent of this band (see spreadingLossDbPerM)
    const airLossDbPerM = spreadingLossDbPerM(model.calibration.params[state.band].n, Math.hypot(spec.width, spec.height) / 2);
    const medium = rasterizeMedium(plan, calibratedMaterials(state.band), spec, state.band, { airLossDbPerM });
    solver.setMedium(medium.data);
    wave = { ...waveNumbers(), airLossDbPerM };
    solver.setParams({ omegaDt: wave.omegaDt, envelopeRate: wave.envelopeRate, coupling: STAIR_COUPLING, sourceGain: wave.pulsed ? 0.6 : 0.25, courant: COURANT });
    scene.setWaveStyle({ levelLinked: wave.pulsed, flow: state.waveModel === 'flow' });
    scene.renderer.resetState();
  }
  function applySources() {
    const active = model.apsFor(state.network);
    scene.setActiveAps(active.map((a) => a.id));
    if (!solver) return;
    let list;
    if (wave.pulsed) {
      // strength from the transmit power, timing from the beacon schedule
      const amps = sourceAmplitudes(active, state.band);
      const schedule = beaconSchedule(active, state.band, wave.beaconSteps, wave.pulseSteps);
      list = active.map((ap) => ({ id: ap.id, position: ap.position, amplitude: amps.get(ap.id), pulse: schedule.get(ap.id) }));
      if (probe.on) list.push({ id: 'probe', position: { level: probe.level, x: probe.x, y: probe.y }, amplitude: 1, pulse: { period: wave.beaconSteps, offset: 0, length: wave.pulseSteps } });
    } else {
      list = active.map((ap) => ({ id: ap.id, position: ap.position }));
      if (probe.on) list.push({ id: 'probe', position: { level: probe.level, x: probe.x, y: probe.y }, amplitude: 1, phase: 0.7 });
    }
    solver.setSources(buildSources(spec, list, floorLossDb(state.band)));
  }
  /** Make the chosen theme the active one everywhere: layers, legend, panels, accent. */
  function applyTheme(save = true) {
    const theme = setActiveTheme(themeOf(state.theme));
    colors = bandColors(grades);
    textColors = bandTextColors(grades);
    scene.setTheme();
    if (comparison) refreshSurveyModel();   // the waypoint markers use theme colours
    document.documentElement.style.setProperty('--accent', theme.accent);
    // a custom palette that is hard to read is still allowed; the panel says what is wrong with it
    themeIssues = state.theme === 'custom' ? checkTheme(theme, grades).filter((r) => !r.ok).map((r) => r.text) : [];
    Object.assign(dirty, { metricsPanel: true, legend: true, nodes: true, timeline: true, card: true, tray: true, survey: true });
    if (save) { try { localStorage.setItem(THEME_KEY, JSON.stringify({ id: state.theme, custom })); } catch { /* private window */ } }
  }
  /** The six colours of the pickers for the theme in use (for a preset: read from its scales). */
  function pickedColors() {
    if (state.theme === 'custom') return custom;
    const theme = themeOf(state.theme), r = themeRamps(theme);
    return { signalLow: toHex(r.signal(0)), signalMid: toHex(r.signal(0.5)), signalHigh: toHex(r.signal(1)), waveTrough: toHex(r.wave(-0.72)), waveCrest: toHex(r.wave(0.72)), accent: theme.accent };
  }
  /** Run the field until the house is filled, so that the first frame shown is not empty. */
  function warmUp() {
    if (!solver) return;
    const fill = Math.round((1.2 * Math.max(spec.nx, spec.ny)) / COURANT);
    const total = Math.min(1400, wave.pulsed ? Math.max(fill, Math.round(2.5 * wave.beaconSteps)) : Math.min(900, fill));
    const chunks = 8;
    for (let i = 0; i < chunks; i++) { solver.step(Math.ceil(total / chunks)); solver.updateEnvelopeMap(0.35); }
    scene.renderer.resetState();
    fieldMoved = true;
  }
  /** A sensor that just reported sent a real packet: show it as one small wave packet from its place. */
  const lastBurst = new Map();
  function burstFrom(position, id) {
    if (!solver || !wave.pulsed || !position) return;
    // A fast replay brings many reports per second. Show at most one packet per sensor every
    // 2.5 s and a few at a time, so the packets stay readable and the beacons keep their slots.
    const now = performance.now();
    if (solver.bursts.length >= 6 || now - (lastBurst.get(id) || -1e9) < 2500) return;
    lastBurst.set(id, now);
    const li = spec.levelIds.indexOf(position.level);
    if (li < 0) return;
    const [cx, cy] = toCell(spec, position.x, position.y);
    solver.addBurst({ x: cx, y: cy, level: li, amp: 0.3, sigma: 1.4, length: wave.pulseSteps });
  }
  function buildSolver(quality) {
    if (wavesWhy) return;
    try {
      const next = waveGridSpec(plan, QUALITY[quality].dx);
      if (solver) solver.dispose();
      spec = next;
      solver = new WaveSolver(gl, { nx: spec.nx, ny: spec.ny, levels: spec.levels });
      perf.quality = quality;
      scene.bindSolver(solver);
      applyMedium();
      applySources();
      warmUp();
    } catch (e) {
      wavesWhy = e.message;
      solver = null;
      scene.bindSolver(null);
    }
  }
  perf.pixelCap = software ? 1 : 1.5;
  scene.pixelRatioCap = perf.pixelCap;
  // ?autostart=high starts automatic quality at a given grid; the test of the automatic downshift uses it
  buildSolver(state.quality === 'auto' ? (QUALITY[params.get('autostart')] ? params.get('autostart') : software ? 'low' : 'high') : state.quality);
  if (wavesWhy) notes.push(`The wave animation is off: ${esc(wavesWhy)}. The signal map and all numbers still work.`);

  // ---------------------------------------------------------------- background worker for the signal grid
  let worker = null, workerReady = false, seq = 0, inFlight = false;
  const want = { field: true, metrics: true };
  let latest = { metrics: null, matrix: null, key: '' };
  const fieldKey = () => `${state.band}|${state.network}|${Math.round(state.cursor / 60000)}|${dragging ? 0 : 1}`;
  let dragging = null;
  function useResult(r) {
    scene.setModelField(r.dbm, inside, model.grid.nx, model.grid.ny);
    if (r.metrics) { latest = { metrics: r.metrics, matrix: r.matrix, key: `${r.band}|${r.network}` }; dirty.metricsPanel = true; }
  }
  function requestField() {
    if (inFlight) return;
    const wantMetrics = want.metrics;
    want.field = false; want.metrics = false;
    const msg = { type: 'compute', seq: ++seq, band: state.band, network: state.network, time: state.cursor, residual: !dragging, wantMetrics };
    if (worker && workerReady) { inFlight = true; worker.postMessage(msg); return; }
    // no worker: compute here
    const env = model.envelope(msg.band, msg.network, msg.time, msg.residual);
    useResult({ ...msg, dbm: env.dbm, metrics: wantMetrics ? model.metrics(msg.band, msg.network, msg.time) : null, matrix: wantMetrics ? model.coverageMatrix(msg.time) : null });
  }
  try {
    worker = new Worker(new URL('./model-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === 'ready') { workerReady = true; want.field = true; want.metrics = true; }
      else if (m.type === 'result') { inFlight = false; if (m.seq === seq || !want.field) useResult(m); }
      else if (m.type === 'error') { inFlight = false; console.warn('model worker:', m.message); }
    };
    worker.onerror = () => { worker = null; workerReady = false; inFlight = false; want.field = true; want.metrics = true; };
    worker.postMessage({ type: 'init', plan, materials, grades, config, nodes, rows: allRows });
  } catch { worker = null; }

  // ---------------------------------------------------------------- derived data for the panels
  const dirty = { controls: true, metricsPanel: false, nodes: true, timeline: true, legend: true, top: true, tray: true, card: false, compass: true, survey: true };
  let trend = [];
  function buildTrend() {
    const buckets = new Map();
    for (const s of store.series.values()) {
      const node = model.nodeById.get(s.node);
      if (!node || (node.type !== 'esp32' && node.type !== 'pi')) continue;
      for (let i = 0; i < s.t.length; i++) {
        if (!s.assoc[i]) continue;
        const b = Math.floor(s.t[i] / 600000);
        if (!buckets.has(b)) buckets.set(b, []);
        buckets.get(b).push(s.rssi[i]);
      }
    }
    trend = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([b, v]) => { v.sort((p, q) => p - q); return { t: b * 600000 + 300000, v: v[v.length >> 1] }; });
  }
  buildTrend();
  const windowOf = () => { const to = Math.max(store.tMax, state.mode === 'live' ? Date.now() : store.tMax); return { from: Math.max(store.tMin, to - DAY), to }; };

  function nodeColor(s) { return s.node.type === 'wired' ? '#c9d6ea' : s.online && s.link ? colors[s.link.quality.id] : '#5d6b80'; }
  let nodeStates = [];
  const lastReport = new Map();
  function refreshNodes(animate = true) {
    nodeStates = model.nodeStates(state.cursor);
    // while time runs (replay or live), a new report of a placed sensor shows as one wave packet from it
    for (const s of nodeStates) {
      const t = s.link?.t;
      if (t == null) continue;
      if (animate && state.mode !== 'recorded' && lastReport.has(s.node.id) && lastReport.get(s.node.id) !== t && s.online) burstFrom(s.node.position, s.node.id);
      lastReport.set(s.node.id, t);
    }
    scene.updateNodes(nodeStates, colors, textColors, redact, animate && !state.reducedMotion);
    dirty.tray = true;
    if (state.selectedNode) dirty.card = true;
  }
  function refreshSurvey() {
    const groups = new Map();
    for (const s of store.survey) {
      const hit = model.bssids.get(s.bssid);
      if (!hit || hit.band !== state.band || (state.network !== 'best' && hit.network !== state.network)) continue;
      const key = `${s.level}|${s.x}|${s.y}`;
      const g = groups.get(key);
      if (!g || s.rssi > g.rssi) groups.set(key, { level: s.level, x: s.x, y: s.y, rssi: s.rssi });
    }
    scene.setSurveyPoints([...groups.values()].map((p) => ({ ...p, color: colorAt(p.rssi) })));
  }
  // ---------------------------------------------------------------- walk survey
  let surveyNote = '';
  let comparison = null, nextPlaces = [];
  const errorColor = (e) => (Math.abs(e) <= 3 ? textColors.excellent : Math.abs(e) <= 6 ? textColors.fair : '#ffc876');
  function refreshSurveyModel() {
    comparison = model.surveyComparison(state.band, state.network);
    // nothing measured yet: show the generated walk-test points instead, and say that they are not measurements
    comparison.synthetic = false;
    if (!comparison.points.length) { const made = model.surveyComparison(state.band, state.network, true); if (made.points.length) comparison = { ...made, synthetic: true }; }
    nextPlaces = model.measureNext(5);
    scene.setSampleDistance(model.sampleDistance());
    // one marker per waypoint: when the laptop and the Pi both measured a place, show the larger error
    const byPlace = new Map();
    for (const p of comparison.points) { const key = `${p.level}|${p.x}|${p.y}`, had = byPlace.get(key); if (!had || Math.abs(p.error) > Math.abs(had.error)) byPlace.set(key, p); }
    const anyRow = new Set(model.measuredPlaces().map((p) => `${p.level}|${p.x}|${p.y}`));
    scene.setSurveyMarkers(
      waypoints.map((w) => {
        const key = `${w.level}|${w.x}|${w.y}`, hit = byPlace.get(key);
        const text = hit ? `<b>${w.seq}</b><span class="v" style="color:${errorColor(hit.error)}">${hit.error >= 0 ? '+' : ''}${hit.error.toFixed(0)}<small> dB</small></span>` : `<b>${w.seq}</b><i>${anyRow.has(key) ? 'no own radio' : 'not measured'}</i>`;
        return { ...w, color: hit ? errorColor(hit.error) : '#8fa6c8', text };
      }),
      nextPlaces.map((p, i) => ({ ...p, color: '#ffc876', text: `<i>measure here</i><b>${i + 1}</b>` })),
    );
    dirty.controls = true;
  }
  async function placeWaypoint(level, x, y) {
    const body = { level, x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    let row = null;
    try {
      const res = await fetch('/api/waypoints', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.ok) row = (await res.json()).waypoint;
    } catch { /* no local server */ }
    const floor = (levels.find((l) => l.id === level) || {}).name || level;
    if (row) {
      surveyNote = `Waypoint ${waypoints.length + 1} saved at ${new Date(row.time).toLocaleTimeString([], { hour12: false })}. Stay here for 10 seconds.`;
      surveyToast(`<b>Waypoint ${waypoints.length + 1} saved</b> on ${esc(floor)}, written to the file. It pairs with mark ${waypoints.length + 1} of the scanner.`);
    } else {
      row = { ...body, time: new Date().toISOString(), kind: 'waypoint', id: `local-${waypoints.length + 1}` };
      surveyNote = 'This server cannot save files. The waypoint is kept only until you reload the page.';
      surveyToast('<b>NOT saved.</b> The server did not take the waypoint, so it is kept only until you reload. Check that node tools/serve.mjs still runs.', true);
    }
    waypoints = waypointsFromRows([...waypoints.map((w) => ({ ...w, kind: 'waypoint', time: new Date(w.t).toISOString() })), row]);
    refreshSurveyModel();
  }
  async function undoWaypoint() {
    if (!waypoints.length) return;
    // a waypoint that was saved is only dropped here when the server has dropped it from the file too
    const saved = !String(waypoints[waypoints.length - 1].id).startsWith('local-');
    if (saved) {
      let ok = false;
      try { ok = (await fetch('/api/waypoints/last', { method: 'DELETE' })).ok; } catch { /* the server does not answer */ }
      if (!ok) { surveyNote = 'The server did not answer, so the waypoint was not taken back. Check that node tools/serve.mjs still runs.'; dirty.controls = true; return; }
    }
    waypoints = waypoints.slice(0, -1);
    surveyNote = 'The last waypoint was taken back.';
    refreshSurveyModel();
  }
  function surveyVm() {
    const sourceName = (p) => (comparison.synthetic ? 'synth.' : p.source || 'other');
    const points = comparison ? [...comparison.points].sort((a, b) => Math.abs(b.error) - Math.abs(a.error)) : [];
    const realRows = store.survey.some((s) => /laptop|(^|[-_])pi([-_]|$)/i.test(s.node));
    return {
      waypoints: waypoints.length, measured: comparison && !comparison.synthetic ? comparison.points.length : 0, bandLabel: bandLabel(state.band),
      places: comparison ? comparison.points.length : 0, synthetic: !!comparison?.synthetic,
      stats: comparison?.stats, prior: comparison?.prior, bySource: comparison?.bySource || [],
      rows: points.slice(0, 40).map((p) => ({ place: `${p.room || 'outside the rooms'} · ${p.levelName}`, measured: p.best.measured, predicted: p.best.predicted, error: p.error, source: sourceName(p), ap: redact.ap(p.best.apId, model.aps.find((a) => a.id === p.best.apId)?.label || p.best.apId), color: errorColor(p.error) })),
      more: Math.max(0, points.length - 40),
      next: nextPlaces.map((p) => ({ text: `${p.room} · ${p.levelName}`, far: p.meanM, synthetic: p.synthetic })),
      note: surveyNote, canSave: surveyServer,
      mixed: realRows && store.meta.some((m) => m.synthetic),
    };
  }

  function refreshRoomLabels() {
    const byId = new Map();
    if (latest.metrics) for (const p of latest.metrics.perLevel) for (const r of p.stats.rooms) byId.set(r.id, r);
    const letterColor = { A: textColors.excellent, B: textColors.good, C: textColors.fair, D: textColors.weak, F: textColors.poor };
    for (const l of scene.labels) {
      if (l.kind !== 'room') continue;
      const r = byId.get(l.room.id);
      const levelHeight = levels[l.level]?.height ?? 0;
      const tall = l.room.ceilingHeight > levelHeight + 1 ? `open to above · ${l.room.ceilingHeight.toFixed(1)} m` : '';
      const tagText = [l.room.nameSource === 'inferred' ? 'inferred' : l.room.nameSource === 'synthetic' ? 'synthetic' : '', tall].filter(Boolean).join(' · ');
      const html = `${esc(l.room.name)}${r ? `<span class="g" style="color:${letterColor[r.grade]}">${r.grade}</span>` : ''}${tagText ? `<small>${tagText}</small>` : ''}`;
      if (l.html !== html) { l.el.innerHTML = html; l.html = html; l.w = 0; }
    }
  }

  // ---------------------------------------------------------------- panel view models
  let apColor = networkColors(config.networks);
  scene.networkColors = apColor;
  const networkList = () => Object.entries(config.networks).map(([id, n]) => ({ id, label: redact.network(id, n.label || id), color: apColor[id], upstream: n.upstream || null, points: config.aps.filter((a) => a.network === id).length }));
  // In privacy mode no file path is shown, because paths are part of the private config.
  const saveTarget = () => (userLayout ? 'data/user/ap-positions.json' : state.privacy ? 'the private data folder' : 'data/private/ap-positions.json');
  let saveNote = '';
  function controlsVm() {
    return {
      levels: levels.map((l) => ({ id: l.id, name: l.name })), bands, redact, quality: perf.quality, networks: networkList(),
      survey: state.survey ? surveyVm() : null,
      themes: [...THEME_ORDER.map((id) => [id, THEMES[id].label]), ['custom', 'Custom']], themeAbout: state.theme === 'custom' ? 'Your own colours. Pick below.' : THEMES[state.theme]?.about || '',
      picked: pickedColors(), themeIssues, wavesOk: !!solver, wavesWhy: wavesWhy || '',
      gridText: solver ? `${spec.nx} × ${spec.ny} cells per floor` : '', saveNote: saveNote || `Positions are saved to ${saveTarget()} when you let go.`,
      aps: model.aps.map((ap, index) => ({ index, id: ap.id, label: ap.label, level: ap.position.level, source: ap.position.source, color: apColor[ap.network] || '#fff' })),
    };
  }
  function metricsVm() {
    const report = model.channelReport(state.cursor);
    const own = report.conflicts.filter((c) => c.kind === 'own networks').length;
    const mesh = report.conflicts.filter((c) => c.kind === 'same network');
    const nb = new Set(report.conflicts.filter((c) => c.kind === 'neighbour').map((c) => c.b.bssid)).size;
    const meshBands = [...new Set(mesh.map((c) => c.band))].sort();
    const channelNote = [
      mesh.length ? `The mesh points share one channel per band (${meshBands.join(' and ')} GHz), as a mesh does.` : '',
      own ? `${own} overlap${own > 1 ? 's' : ''} between your own networks.` : Object.keys(config.networks).length > 1 ? 'Your own networks do not overlap each other.' : '',
      nb ? `${nb} neighbour network${nb > 1 ? 's' : ''} overlap${nb > 1 ? '' : 's'} an own channel.` : 'No neighbour overlaps an own channel.',
    ].filter(Boolean).join(' ');
    const wired = model.wiredHealth(state.cursor).map((w) => ({ ...w, name: redact.node(w.target, model.nodeById.get(w.target)?.name || w.target), proberName: redact.node(w.prober, model.nodeById.get(w.prober)?.name || w.prober) }));
    const topo = model.topology();
    const topology = Object.entries(config.networks).map(([id, net]) => {
      const t = topo.find((x) => x.ssid === net.ssid);
      const name = `<span class="mono">${esc(redact.ssid(net.ssid))}</span>`;
      if (!t) return { ok: false, text: `${name}: no sample has seen this network yet.` };
      const radios = `${t.bssids.length} radio${t.bssids.length > 1 ? 's' : ''} on ${t.aps.length} access point${t.aps.length > 1 ? 's' : ''}`;
      if (t.consistent) return { ok: true, text: `${name}: ${radios}, all of this network and none of another. This matches what you expected.` };
      const why = [t.foreign.length ? `it also appears on ${t.foreign.map((n) => esc(redact.network(n, config.networks[n]?.label || n))).join(', ')}` : '', t.unknownBssids.length ? `${t.unknownBssids.length} of its BSSIDs belong to no access point in the config` : ''].filter(Boolean).join(' and ');
      return { ok: false, text: `${name}: ${radios}, but ${why}. Check this against what you expected.` };
    });
    return {
      grades, colors, textColors, redact, band: state.band, bandLabel: bandLabel(state.band), network: state.network, levels: levels.map((l) => ({ id: l.id, name: l.name })),
      metrics: latest.metrics, matrix: latest.matrix, calibration: model.calibration, channelNote, report, wired, topology,
      networks: networkList(),
      meshNote: `Mesh model: ${state.privacy ? 'hidden' : config.mesh?.model || 'unknown'}. A client can roam between the mesh points, so each point is its own source. Which network a device uses is read from its BSSID.`,
    };
  }
  function topVm() {
    const synthLevels = levels.filter((l) => l.source === 'synthetic');
    const badges = [];
    if (state.privacy) badges.push({ kind: 'privacy', text: 'Privacy mode' });
    if (state.mode === 'live') badges.push({ kind: 'live', text: 'Live' });
    if (store.synthetic) badges.push({ kind: 'synth', text: 'Synthetic data' });
    if (synthLevels.length) badges.push({ kind: 'synth', text: `Synthetic layout · ${synthLevels.length === levels.length ? 'all floors' : synthLevels.map((l) => l.name).join(', ')}` });
    if (model.aps.some((a) => a.position.source === 'guess')) badges.push({ kind: '', text: 'Access-point positions: guess' });
    return { house: redact.house(), address: redact.address(), badges };
  }
  function cardVm() {
    const s = nodeStates.find((x) => x.node.id === state.selectedNode);
    if (!s) return null;
    const level = s.node.position ? levels.find((l) => l.id === s.node.position.level) : null;
    const where = s.node.type === 'wired' ? `Wired reference${level ? ` · ${level.name}` : ''}` : s.node.position ? `${s.room ? s.room.name : 'outside the rooms'} · ${level?.name || ''}${s.node.positionSource === 'guess' ? ' · position guess' : ''}` : 'Position unknown (roaming)';
    const ap = s.link?.apId ? model.aps.find((a) => a.id === s.link.apId) : null;
    return {
      name: redact.node(s.node.id, s.node.name), where, link: s.online ? s.link : null, color: s.online && s.link ? textColors[s.link.quality.id] : '#c9d6ea',
      apName: ap ? redact.ap(ap.id, ap.label) : 'an unknown access point', ssid: s.link ? redact.ssid(s.link.ssid) : '', bssid: s.link ? redact.bssid(s.link.bssid) : '',
      mac: s.node.mac ? redact.mac(s.node.mac) : '',
      status: s.node.type === 'wired' ? 'Wired server. It is the far end of the latency and throughput probes.' : s.node.type === 'survey' ? 'This phone made the walk test. Its samples are the small circles on the floors.' : s.online ? 'Online, but attached to no known access point.' : `Offline. Last heard ${Number.isFinite(s.lastHeard) ? new Date(s.lastHeard).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : 'never'}.`,
    };
  }
  function trayVm() {
    return {
      items: nodeStates.filter((s) => !s.node.position && s.node.type === 'client').map((s) => {
        const ap = s.link?.apId ? model.aps.find((a) => a.id === s.link.apId) : null;
        return { index: model.nodes.indexOf(s.node), name: redact.node(s.node.id, s.node.name), color: nodeColor(s), value: s.online && s.link ? `${Math.round(s.link.rssi)} dBm` : 'offline', where: s.online && ap ? `on ${redact.ap(ap.id, ap.label)} · ${s.link.band} GHz` : '' };
      }),
    };
  }

  // ---------------------------------------------------------------- state changes
  const layerIndex = { waves: 0, envelope: 1, fused: 2, contours: 3 };
  function apply(key, value) {
    if (state[key] === value) return;
    state[key] = value;
    switch (key) {
      case 'view': scene.setView(value); dirty.compass = true; break;
      case 'level': scene.setLevel(value); break;
      case 'explode': scene.setExplode(value); return;
      case 'layer': scene.setMode(layerIndex[value]); break;
      case 'band': applyMedium(); applySources(); want.field = want.metrics = true; dirty.survey = true; dirty.legend = true; refreshSurveyModel(); break;
      case 'network': applySources(); want.field = want.metrics = true; dirty.survey = true; refreshSurveyModel(); break;
      case 'survey': scene.setSurveyMode(value); document.body.classList.toggle('survey-on', value); dirty.legend = true; break;
      case 'speed': break;
      case 'quality': buildSolver(value === 'auto' ? perf.quality : value); dirty.legend = true; break;
      case 'theme': applyTheme(); break;
      case 'waveModel': if (solver) { applyMedium(); applySources(); solver.reset(); warmUp(); } dirty.legend = true; break;
      case 'probe': probe.on = value; scene.setProbe(probe); applySources(); break;
      case 'autoOrbit': scene.state.autoOrbit = value; scene.lastInteraction = -1e9; break;
      case 'reducedMotion': scene.state.reducedMotion = value; document.body.classList.toggle('reduced-motion', value); break;
      case 'privacy': makeRedactor(); scene.refreshApLabels(redact); refreshNodes(false); setupPanel.render(); Object.assign(dirty, { top: true, metricsPanel: true, tray: true, card: true, compass: true }); break;
      case 'setup': document.body.classList.toggle('setup-on', value); setupPanel.open(value); if (value && state.view === '3d') scene.controls3d.autoRotate = false; break;
      case 'placing': scene.state.placing = value; if (value && state.view === '3d') scene.controls3d.autoRotate = false; break;
      default: break;
    }
    dirty.controls = true;
  }
  function setCursor(t, mode) {
    const w = windowOf();
    state.cursor = Math.max(w.from, Math.min(w.to, t));
    if (mode) { if (state.mode !== mode) dirty.top = true; state.mode = mode; }
    want.field = true; want.metrics = true;
    dirty.nodes = true; dirty.timeline = true;
  }

  // ---------------------------------------------------------------- networks and devices (Setup panel)
  /** Take a changed setup: new networks, access points and nodes for the model, the worker, the scene and the panels. No reload. */
  function applyDevices(doc) {
    ({ config, nodes } = applySetup(config, nodesFile.nodes, doc, setupOptions));
    model.setDevices(config, nodes);
    worker?.postMessage({ type: 'setDevices', config, nodes });
    seq++;                              // a signal grid that is still on its way was made for the old devices
    if (state.network !== 'best' && !config.networks[state.network]) state.network = 'best';
    apColor = networkColors(config.networks);
    scene.networkColors = apColor;
    makeRedactor();
    scene.setAccessPoints(model.aps, redact);
    scene.setNodes(model.nodes);
    if (solver) applyMedium();          // the wall losses of the waves come from the calibration, which just ran again
    applySources();
    buildTrend();
    refreshNodes(false);
    refreshSurveyModel();
    want.field = want.metrics = true;
    Object.assign(dirty, { controls: true, metricsPanel: true, top: true, tray: true, card: true, survey: true, timeline: true });
  }
  const setupPanel = createSetupPanel({
    el: $('setup'), boot: setupBoot, levels, bands, demo: flag('demo'), floorplan: config.paths.floorplan,
    getRedact: () => redact, isPrivate: () => state.privacy, getView: () => ({ view: state.view, level: state.level }),
    setView: (v) => { apply('view', v.view); apply('level', v.level); }, applyDoc: applyDevices,
  });

  // ---------------------------------------------------------------- events
  $('controls').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.set) { const v = b.dataset.value; apply(b.dataset.set, b.dataset.set === 'speed' ? Number(v) : v); }
    else if (b.dataset.toggle) apply(b.dataset.toggle, !state[b.dataset.toggle]);
    else if (b.dataset.action === 'pause') apply('paused', !state.paused);
    else if (b.dataset.action === 'step') { state.paused = true; pendingSteps += 4; dirty.controls = true; }
    else if (b.dataset.action === 'restart') restartWaves();
    else if (b.dataset.action === 'undo-waypoint') undoWaypoint();
    else if (b.dataset.action === 'reload') location.reload();
  });
  $('controls').addEventListener('input', (ev) => {
    if (ev.target.dataset.range === 'explode') apply('explode', Number(ev.target.value));
    const key = ev.target.dataset.themeColor;
    if (key && key in CUSTOM_DEFAULT) {
      // The first pick starts the custom theme from the colours on screen. The panel is not
      // rebuilt while the colour picker is open, because that would close the picker.
      if (state.theme !== 'custom') { custom = { ...pickedColors() }; state.theme = 'custom'; }
      custom[key] = ev.target.value;
      applyTheme();
    }
  });
  $('controls').addEventListener('change', (ev) => {
    if (ev.target.dataset.themeColor) dirty.controls = true;
    if (ev.target.dataset.select === 'theme') apply('theme', ev.target.value);
    if (ev.target.dataset.select === 'quality') apply('quality', ev.target.value);
    if (ev.target.dataset.select === 'network') apply('network', ev.target.value);
    if (ev.target.dataset.apLevel) moveAp(model.aps[Number(ev.target.dataset.apLevel)]?.id, { level: ev.target.value }, true);
  });
  function restartWaves() { if (solver) { solver.reset(); scene.renderer.resetState(); fieldMoved = true; if (state.paused) pendingSteps += 1; } }
  const cycle = (list, current) => list[(list.indexOf(current) + 1) % list.length];

  $('tl-buttons').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.action === 'replay') {
      if (state.mode === 'replay') setCursor(state.cursor, 'recorded');
      else { const w = windowOf(); setCursor(state.cursor >= w.to - 60000 ? w.from : state.cursor, 'replay'); }
    } else if (b.dataset.action === 'live' && state.liveAvailable) setCursor(Date.now(), 'live');
    else if (b.dataset.set === 'replaySpeed') state.replaySpeed = Number(b.dataset.value);
    dirty.timeline = true; dirty.top = true; dirty.tlButtons = true;
  });
  const tl = $('tl-canvas');
  const scrub = (ev) => { const r = tl.getBoundingClientRect(); const w = windowOf(); setCursor(w.from + ((ev.clientX - r.left) / r.width) * (w.to - w.from), 'recorded'); dirty.tlButtons = true; };
  tl.addEventListener('pointerdown', (ev) => { tl.setPointerCapture(ev.pointerId); scrub(ev); tl.onpointermove = scrub; });
  tl.addEventListener('pointerup', (ev) => { tl.releasePointerCapture(ev.pointerId); tl.onpointermove = null; });

  function selectNode(id) { state.selectedNode = id; dirty.card = true; }
  $('labels').addEventListener('click', (ev) => { const el = ev.target.closest('.node-label'); if (el) selectNode(model.nodes[Number(el.dataset.node)]?.id || null); });
  $('tray').addEventListener('click', (ev) => { const el = ev.target.closest('.chip'); if (el) selectNode(model.nodes[Number(el.dataset.node)]?.id || null); });
  $('node-card').addEventListener('click', (ev) => { if (ev.target.closest('[data-action="close-node"]')) selectNode(null); });

  // dragging markers on the canvas
  const stage = $('stage');
  let down = null;
  function moveAp(apId, patch, final) {
    const ap = model.aps.find((a) => a.id === apId);
    if (!ap) return;
    const position = { ...ap.position, ...patch, source: 'placed' };
    position.x = Math.max(area.minX + 1, Math.min(area.maxX - 1, position.x));
    position.y = Math.max(area.minY + 1, Math.min(area.maxY - 1, position.y));
    ap.position = position;                     // the main-thread model re-traces only when the drag ends
    scene.placeAp(apId, position);
    applySources();
    worker?.postMessage({ type: 'moveAp', apId, position, final });
    if (final) {
      model.moveAp(apId, position);
      model.calibrate();
      applyMedium(); applySources();
      scene.refreshApLabels(redact);
      // with a setup of the user, the place belongs to the setup; else to the marker file as before
      if (!setupPanel.apMoved(apId, position, state.setup)) savePositions();
      Object.assign(dirty, { controls: true, top: true, nodes: true });
    }
    want.field = true; want.metrics = !!final;
  }
  async function savePositions() {
    const body = {
      floorplan: config.paths.floorplan, saved: new Date().toISOString(),
      positions: Object.fromEntries(model.aps.map((ap) => [ap.id, {
        level: ap.position.level, x: ap.position.x, y: ap.position.y, source: ap.position.source,
        ...(ap.position.z !== undefined ? { z: ap.position.z, heightSource: ap.position.heightSource } : {}),
        ...(ap.enclosure ? { enclosureLossDb: ap.enclosure.lossDb, enclosureSource: ap.enclosure.source } : {}),
      }])),
    };
    try { localStorage.setItem(planKey, JSON.stringify(body)); } catch { /* private window */ }
    try {
      const res = await fetch('/api/ap-positions', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      saveNote = res.ok ? `Saved to ${saveTarget()} at ${new Date().toLocaleTimeString([], { hour12: false })}.` : 'This server cannot save files. The positions are kept in this browser only.';
    } catch { saveNote = 'This server cannot save files. The positions are kept in this browser only.'; }
    dirty.controls = true;
  }
  stage.addEventListener('pointerdown', (ev) => {
    down = { x: ev.clientX, y: ev.clientY, moved: false };
    const kinds = [...(state.placing || (state.setup && !setupPanel.armed()) ? ['ap'] : []), ...(probe.on ? ['probe'] : [])];
    const hit = kinds.length ? scene.pick(ev.clientX, ev.clientY, kinds, 30) : null;
    if (hit) {
      dragging = hit; scene.dragging = true;
      scene.setControlsEnabled(false);
      stage.setPointerCapture(ev.pointerId);
      stage.style.cursor = 'grabbing';
    }
  });
  stage.addEventListener('pointermove', (ev) => {
    if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5) down.moved = true;
    if (!dragging) {
      if (setupPanel.armed()) { stage.style.cursor = 'crosshair'; return; }
      const kinds = [...(state.placing || state.setup ? ['ap'] : []), ...(probe.on ? ['probe'] : [])];
      stage.style.cursor = kinds.length && scene.pick(ev.clientX, ev.clientY, kinds, 30) ? 'grab' : scene.pick(ev.clientX, ev.clientY, ['node'], 18) ? 'pointer' : '';
      return;
    }
    const p = scene.planPointAt(ev.clientX, ev.clientY, dragging.levelIndex);
    if (!p) return;
    if (dragging.kind === 'ap') moveAp(dragging.id, p, false);
    else { probe.x = Math.max(area.minX + 1, Math.min(area.maxX - 1, p.x)); probe.y = Math.max(area.minY + 1, Math.min(area.maxY - 1, p.y)); scene.setProbe(probe); applySources(); }
  });
  const endDrag = (ev) => {
    if (dragging) {
      const d = dragging;
      dragging = null; scene.dragging = false;
      scene.setControlsEnabled(true);
      stage.style.cursor = '';
      try { stage.releasePointerCapture(ev.pointerId); } catch { /* not captured */ }
      if (d.kind === 'ap') moveAp(d.id, {}, true);
    } else if (down && !down.moved && ev.altKey) {
      // Alt + click: read the floor-plan coordinates of a spot (for the node file and the walk test)
      for (let li = 0; li < levels.length; li++) {
        if (state.level !== 'all' && levels[li].id !== state.level) continue;
        const p = scene.planPointAt(ev.clientX, ev.clientY, li);
        if (!p || !pointInPolygon(p.x, p.y, levels[li].outline)) continue;
        const text = `level ${levels[li].id}, x ${p.x.toFixed(2)}, y ${p.y.toFixed(2)}`;
        showBanner(`<b>${esc(levels[li].name)}</b>: ${esc(text)} (metres, at marker height). Click this message to close it.`);
        try { navigator.clipboard?.writeText(`{ "level": "${levels[li].id}", "x": ${p.x.toFixed(2)}, "y": ${p.y.toFixed(2)} }`); } catch { /* clipboard not allowed */ }
        break;
      }
    } else if (down && !down.moved && setupPanel.armed()) {
      // Setup panel: a device waits for its place. The topmost floor under the pointer wins.
      for (let li = levels.length - 1; li >= 0; li--) {
        if (state.level !== 'all' && levels[li].id !== state.level) continue;
        const p = scene.planPointAt(ev.clientX, ev.clientY, li);
        if (!p || !pointInPolygon(p.x, p.y, levels[li].outline)) continue;
        setupPanel.placeAt(levels[li].id, p.x, p.y);
        stage.style.cursor = '';
        break;
      }
    } else if (down && !down.moved && state.survey) {
      // Survey mode: a click on a floor is "I stand here now". The topmost floor under the pointer wins.
      let placed = false;
      for (let li = levels.length - 1; li >= 0; li--) {
        if (state.level !== 'all' && levels[li].id !== state.level) continue;
        const p = scene.planPointAt(ev.clientX, ev.clientY, li);
        if (!p || !pointInPolygon(p.x, p.y, levels[li].outline)) continue;
        placeWaypoint(levels[li].id, p.x, p.y);
        placed = true;
        break;
      }
      // a click that lands off every floor used to do nothing at all, which looked like a click that was not taken
      if (!placed) surveyToast('Nothing saved: that click is not on a floor. Click inside a floor outline (switch to 2D plan and one floor for a larger target).', true);
    } else if (down && !down.moved) {
      const hit = scene.pick(ev.clientX, ev.clientY, ['node'], 20);
      if (hit) selectNode(hit.id);
    }
    down = null;
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  $('banner').addEventListener('click', () => { $('banner').hidden = true; });
  window.addEventListener('keydown', (ev) => {
    if (ev.target.matches('input, select, textarea') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k === ' ') { ev.preventDefault(); apply('paused', !state.paused); }
    else if (k === '.') { state.paused = true; pendingSteps += 4; dirty.controls = true; }
    else if (k === 'r') restartWaves();
    else if (k >= '1' && k <= '4') apply('layer', ui.LAYERS[Number(k) - 1][0]);
    else if (k === 'b') apply('band', bands[(bands.findIndex((b) => b.id === state.band) + 1) % bands.length].id);
    else if (k === 's') apply('survey', !state.survey);
    else if (k === 'w') apply('waveModel', cycle(ui.WAVE_MODELS.map(([id]) => id), state.waveModel));
    else if (k === 'n') apply('network', cycle(['best', ...Object.keys(config.networks)], state.network));
    else if (k === 'd') apply('setup', !state.setup);
    else if (k === 'v') apply('view', state.view === '3d' ? 'plan' : '3d');
    else if (k === 'p') apply('privacy', !state.privacy);
    else if (k === 'm') apply('reducedMotion', !state.reducedMotion);
    else if (k === 'h') { document.body.classList.toggle('hide-ui'); scene.resize(); }
    else if (k === 'f') { $('perf').hidden = !$('perf').hidden; }
    else if (k === 'escape') selectNode(null);
  });
  window.addEventListener('resize', () => { scene.resize(); Object.assign(dirty, { timeline: true, metricsPanel: true, card: true }); });

  // ---------------------------------------------------------------- live feed (read-only)
  if (config.live?.url && !flag('nolive')) {
    try {
      const es = new EventSource(config.live.url);
      let batch = [];
      es.onopen = () => { state.liveAvailable = true; dirty.tlButtons = true; if (!params.has('t')) setCursor(Date.now(), 'live'); };
      es.onmessage = (ev) => {
        let row;
        try { row = JSON.parse(ev.data); } catch { return; }
        if (!store.add(row)) return;
        batch.push(row);
        if (state.mode === 'live') setCursor(Date.now());
      };
      es.onerror = () => { if (!state.liveAvailable) es.close(); };
      setInterval(() => {
        if (!batch.length) return;
        worker?.postMessage({ type: 'rows', rows: batch });
        if (!worker) model.addRows([]);
        batch = [];
        buildTrend();
        Object.assign(dirty, { nodes: true, timeline: true, top: true });
        want.field = true; want.metrics = true;
      }, 2000);
    } catch { /* no live feed */ }
  }

  // ---------------------------------------------------------------- first paint
  applyTheme(false);
  scene.setSurveyMode(state.survey);
  document.body.classList.toggle('survey-on', state.survey);
  refreshSurveyModel();
  scene.setMode(layerIndex[state.layer]);
  scene.setView(state.view, true);
  scene.setLevel(state.level);
  scene.updateLayoutTargets(true);
  scene.setAccessPoints(model.aps, redact);
  scene.setNodes(model.nodes);
  scene.setProbe(probe);
  applySources();
  refreshNodes(false);
  if (flag('setup')) apply('setup', true);
  { // a first signal grid right away, without the residual, so the first frame is not empty
    const env = model.envelope(state.band, state.network, state.cursor, true);
    scene.setModelField(env.dbm, inside, model.grid.nx, model.grid.ny);
    latest = { metrics: model.metrics(state.band, state.network, state.cursor), matrix: model.coverageMatrix(state.cursor), key: '' };
    dirty.metricsPanel = true;
  }
  if (notes.length) showBanner(notes.join('\n\n'));
  if (issues.warnings.length) console.info('Floor plan warnings:\n' + formatIssues(issues.warnings).join('\n'));

  // ---------------------------------------------------------------- frame loop
  let last = performance.now(), lastPanels = 0, lastField = 0, lastCompassAngle = 1e9, lastKey = '';
  const frameTimes = [];
  function frame(now) {
    const jsStart = performance.now();
    const rawDt = (now - last) / 1000;
    last = now;
    const dt = Math.min(0.1, rawDt);
    perf.ema += (rawDt * 1000 - perf.ema) * 0.06;
    perf.frames++; perf.sinceChange++;
    frameTimes.push(rawDt * 1000); if (frameTimes.length > 600) frameTimes.shift();

    // time
    if (state.mode === 'replay') {
      const w = windowOf();
      let t = state.cursor + Math.min(1, rawDt) * 1000 * state.replaySpeed;   // wall-clock time, also when frames are slow
      if (t >= w.to) t = w.from;
      setCursor(t);
    } else if (state.mode === 'live' && now - lastField > 1000) setCursor(Date.now());

    // waves
    if (solver) {
      let steps = pendingSteps;
      pendingSteps = 0;
      if (!state.paused) {
        simAcc += dt * state.speed * (state.reducedMotion ? 0.4 : 1);
        const n = Math.floor(simAcc / wave.dtSim);
        simAcc -= n * wave.dtSim;
        steps += Math.min(n, 8);
      }
      if (steps > 0 || fieldMoved) {
        const t0 = performance.now();
        solver.step(steps);
        solver.updateEnvelopeMap(1 - Math.exp(-dt / wave.flowSeconds));
        scene.renderer.resetState();
        perf.simMs += (performance.now() - t0 - perf.simMs) * 0.1;
        fieldMoved = false;
      }
    }

    // signal grid, computed in the worker
    const key = fieldKey();
    if (key !== lastKey) { want.field = true; lastKey = key; }
    if ((want.field || want.metrics) && now - lastField > 110) { lastField = now; requestField(); }

    scene.update(dt, now);
    scene.render();
    scene.updateLabels();

    // panels: a few times per second at most
    if (now - lastPanels > 160) {
      lastPanels = now;
      if (dirty.nodes) { refreshNodes(true); dirty.nodes = false; }
      if (dirty.survey) { refreshSurvey(); dirty.survey = false; }
      if (dirty.controls) { ui.renderControls($('controls'), state, controlsVm()); dirty.controls = false; }
      if (dirty.metricsPanel && latest.metrics) {
        const vm = metricsVm();
        ui.renderMetrics($('metrics'), vm);
        drawChannels($('ch-chart'), vm.report, { networkColors: apColor });
        refreshRoomLabels();
        dirty.metricsPanel = false;
      }
      if (dirty.top) { ui.renderTopbar(topVm()); dirty.top = false; dirty.tlButtons = true; }
      if (dirty.tlButtons !== false) { ui.renderTimelineButtons($('tl-buttons'), { mode: state.mode, liveAvailable: state.liveAvailable, replaySpeed: state.replaySpeed }); dirty.tlButtons = false; }
      if (dirty.legend) { ui.renderLegend($('legend'), { grades, colors, scaleText: wave ? String(Math.round(wave.scale)) : '10', waveModel: state.waveModel, wavesOk: !!solver, survey: state.survey }); dirty.legend = false; }
      if (dirty.tray) { ui.renderTray($('tray'), trayVm()); dirty.tray = false; }
      if (dirty.card) {
        const vm = cardVm();
        if (ui.renderNodeCard($('node-card'), vm)) { const w = windowOf(); drawHistory($('node-chart'), model.history(state.selectedNode), { from: w.from, to: w.to, cursor: state.cursor, grades, colors }); }
        dirty.card = false;
      }
      if (dirty.timeline) {
        const w = windowOf();
        drawTimeline(tl, { from: w.from, to: w.to, cursor: state.cursor, trend, events: model.events() }, { colorFor: (v) => colors[bandOf(v, grades).id] });
        const d = new Date(state.cursor);
        ui.renderClock({
          modeText: state.mode === 'live' ? 'LIVE' : state.mode === 'replay' ? `REPLAY ×${state.replaySpeed}` : 'RECORDED', modeClass: state.mode === 'live' ? 'is-live' : state.mode === 'replay' ? 'is-replay' : '',
          time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), date: d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }),
        });
        dirty.timeline = false;
      }
      const azimuth = state.view === 'plan' ? 0 : (scene.controls3d.getAzimuthalAngle() * 180) / Math.PI;
      if (dirty.compass || Math.abs(azimuth - lastCompassAngle) > 0.8) {
        const guess = /guess/.test(config.site?.northSource || '') || config.site?.frontDoor?.source === 'guess';
        ui.renderCompass($('compass'), { hidden: state.privacy, northDeg: config.site?.northDeg ?? 0, viewRotationDeg: -azimuth, guess, title: ui.northTitle(config.site?.northDeg ?? 0, guess) });
        lastCompassAngle = azimuth; dirty.compass = false;
      }
      if (!$('perf').hidden) $('perf').textContent = `frame ${perf.ema.toFixed(1)} ms (${(1000 / perf.ema).toFixed(0)} fps)\npage script ${perf.jsMs.toFixed(1)} ms per frame\nwave step ${perf.simMs.toFixed(2)} ms\ngrid ${solver ? `${spec.nx}×${spec.ny}×${spec.levels}` : 'off'} · ${perf.quality}\npixel ratio ${scene.renderer.getPixelRatio().toFixed(2)}\n${rendererName.slice(0, 60)}`;
    }

    // automatic quality: step down when frames get slow, never step back up to a level that was too slow
    if (state.quality === 'auto' && solver && perf.sinceChange > 150 && !document.hidden) {
      const i = QUALITY_ORDER.indexOf(perf.quality);
      if (perf.ema > 24) {
        if (i > 0) { perf.ceiling = i - 1; buildSolver(QUALITY_ORDER[i - 1]); dirty.controls = true; dirty.legend = true; }
        else if (perf.pixelCap > 1) { perf.pixelCap = 1; scene.pixelRatioCap = 1; scene.resize(); }
        perf.sinceChange = 0; perf.ema = 16.7;
      } else if (perf.ema < 11.5 && perf.sinceChange > 900 && i < Math.min(perf.ceiling, QUALITY_ORDER.indexOf('high'))) {
        buildSolver(QUALITY_ORDER[i + 1]); perf.sinceChange = 0; dirty.controls = true; dirty.legend = true;
      }
    }
    perf.jsMs += (performance.now() - jsStart - perf.jsMs) * 0.06;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  $('boot').classList.add('done');
  initLayoutSetup({ materials, schema, workspace: userLayout && config !== base ? 'user' : local ? 'private' : 'demo', userPlan: userLayout && config !== base ? plan : null, privacy: () => state.privacy });

  // a handle for the verification tools and for curious people in the console
  window.__atlas = {
    state, perf, frameTimes, apply, setCursor, selectNode, model, scene, store, placeWaypoint, setup: setupPanel,
    get config() { return config; },
    get waypoints() { return waypoints; }, get comparison() { return comparison; },
    get solver() { return solver; }, get workerReady() { return workerReady; }, get spec() { return spec; }, get wave() { return wave; }, get latest() { return latest; },
    ready: true,
  };
}

boot().catch((e) => {
  console.error(e);
  $('boot-text').textContent = 'Signal Atlas could not start';
  showBanner(`<b>Signal Atlas could not start.</b>\n${esc(e.message)}\n\nOpen the page through the dev server: node tools/serve.mjs`);
  window.__atlas = { ready: false, error: String(e.message) };
});
