// The panels around the 3D view. Every function takes plain data and writes HTML.
// Every string that comes from data goes through escapeHtml, and every private
// string goes through the redactor first (see core/privacy.js).

import { escapeHtml as esc } from './scene.js';
import { signalRamp, signalTextRamp, waveRamp, cssGradient, dbmToT, toHex } from '../core/colormaps.js';
import { letterOf } from '../core/metrics.js';
import { compassWord } from '../core/orientation.js';
import { QUALITY, QUALITY_ORDER } from '../sim/rasterize.js';

const seg = (key, options, current, extra = '') => `<div class="seg" role="group" ${extra}>${options.map(([value, label, title]) =>
  `<button type="button" data-set="${key}" data-value="${esc(value)}" aria-pressed="${String(value) === String(current)}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}</button>`).join('')}</div>`;
const toggle = (key, label, on, kbd = '') => `<button type="button" class="toggle" data-toggle="${key}" aria-pressed="${on}"><span>${esc(label)}${kbd ? `<kbd>${kbd}</kbd>` : ''}</span><span class="sw"></span></button>`;

export const LAYERS = [['waves', 'Waves'], ['envelope', 'Envelope'], ['fused', 'Fused'], ['contours', 'Contours']];
/** How the wave field is driven and drawn. The first one is the default. */
export const WAVE_MODELS = [
  ['beacon', 'Beacons', 'Each access point sends one short pulse per beacon. Access points on one channel take turns. Brightness is the calibrated signal level.'],
  ['flow', 'Beacons + flow', 'The beacon pulses, plus arrows that show where signal energy travels on average.'],
  ['tone', 'Continuous', 'The earlier look: every access point sends an endless tone and the brightness is evened out. Illustrative only.'],
];
const WAVE_HINT = {
  beacon: 'One pulse = one beacon. Its path comes from the scanned walls and openings. Its brightness is the calibrated signal level.',
  flow: 'Beacon pulses, with arrows that show where signal energy travels on average. Watch doorways and the stairs.',
  tone: 'Endless tones with evened-out brightness. This look is illustrative: it does not show signal strength.',
};

export function renderControls(el, s, vm) {
  const scroll = el.scrollTop;   // the panel is rebuilt: keep the place the reader scrolled to
  const levelOptions = [['all', 'All'], ...vm.levels.map((l) => [l.id, l.id, l.name])];
  // the networks come from the config or from the Setup panel; more than two get a list instead of buttons
  const netOptions = [['best', vm.networks.length === 2 ? 'Best of both' : 'Best of all'], ...vm.networks.map((n) => [n.id, n.label])];
  const netSwitch = vm.networks.length <= 2 ? seg('network', netOptions, s.network)
    : `<span class="lbl">Network</span><select data-select="network" aria-label="Network">${netOptions.map(([v, l]) => `<option value="${esc(v)}" ${s.network === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const qualityOptions = [['auto', `Auto (${QUALITY[vm.quality]?.label || vm.quality})`], ...QUALITY_ORDER.map((q) => [q, `${QUALITY[q].label} (${Math.round(QUALITY[q].dx * 100)} cm grid)`])];
  el.innerHTML = `
    <div class="sec"><h2>View</h2>
      <div class="row">${seg('view', [['3d', '3D cutaway'], ['plan', '2D plan']], s.view)}</div>
      <div class="row"><span class="lbl">Floors</span>${seg('level', levelOptions, s.level)}</div>
      <div class="row"><span class="lbl">Explode</span><input type="range" min="0" max="1" step="0.01" value="${s.explode}" data-range="explode" aria-label="Distance between floors" ${s.view === 'plan' || s.level !== 'all' ? 'disabled' : ''}></div>
    </div>
    ${vm.survey ? renderSurvey(vm.survey) : ''}
    <div class="sec"><h2>Layer</h2>
      <div class="row">${seg('layer', LAYERS, s.layer)}</div>
      <p class="hint">${{ waves: 'The moving wave field alone. Crest and trough have opposite colours.', envelope: 'The steady signal level in dBm from the calibrated model.', fused: 'Signal level, with the moving waves on top.', contours: 'Lines at the limits of the signal bands.' }[s.layer]}</p>
    </div>
    <div class="sec"><h2>Signal</h2>
      <div class="row"><span class="lbl">Band</span>${seg('band', vm.bands.map((b) => [b.id, b.label]), s.band)}</div>
      <div class="row">${netSwitch}</div>
    </div>
    <div class="sec"><h2>Wave simulation <small>${vm.wavesOk ? `${vm.gridText}` : 'not available'}</small></h2>
      <div class="row">
        <button type="button" class="btn" data-action="pause" aria-pressed="${s.paused}" ${vm.wavesOk ? '' : 'disabled'}>${s.paused ? 'Resume' : 'Pause'}</button>
        <button type="button" class="btn" data-action="step" ${vm.wavesOk ? '' : 'disabled'} title="Advance a few time steps">Step</button>
        <button type="button" class="btn" data-action="restart" ${vm.wavesOk ? '' : 'disabled'} title="Clear the field and watch the first wavefronts spread">Restart</button>
      </div>
      <div class="row">${seg('waveModel', WAVE_MODELS, s.waveModel)}</div>
      <p class="hint">${WAVE_HINT[s.waveModel]}</p>
      <div class="row"><span class="lbl">Speed</span>${seg('speed', [[1, '1×'], [0.5, '½×'], [0.25, '¼×']], s.speed)}</div>
      <div class="row"><span class="lbl">Quality</span><select data-select="quality" aria-label="Wave grid quality">${qualityOptions.map(([v, l]) => `<option value="${v}" ${s.quality === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
      ${toggle('probe', 'Virtual source (drag it)', s.probe)}
      ${vm.wavesOk ? '' : `<p class="hint">${esc(vm.wavesWhy)} The signal map still works.</p>`}
    </div>
    <div class="sec"><h2>Theme</h2>
      <div class="row"><span class="lbl">Colours</span><select data-select="theme" aria-label="Colour theme">${vm.themes.map(([id, label]) => `<option value="${esc(id)}" ${s.theme === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div>
      <p class="hint">${esc(vm.themeAbout)}</p>
      <div class="swatches">
        ${[['signalLow', 'Signal: weak'], ['signalMid', 'Signal: middle'], ['signalHigh', 'Signal: strong'], ['waveTrough', 'Wave: trough'], ['waveCrest', 'Wave: crest'], ['accent', 'Accent']].map(([key, label]) =>
    `<label><input type="color" data-theme-color="${key}" value="${esc(vm.picked[key])}" aria-label="${label}"><span>${label}</span></label>`).join('')}
      </div>
      <p class="hint">${s.theme === 'custom' ? 'Zero in the wave scale stays dark.' : 'Pick any colour to start your own theme from this one.'} The choice is kept in this browser.</p>
      ${vm.themeIssues.length ? `<p class="hint warn">This palette is hard to read in ${vm.themeIssues.length} way${vm.themeIssues.length > 1 ? 's' : ''}. It is still in use. First problem: ${esc(vm.themeIssues[0])}.</p>` : ''}
    </div>
    <div class="sec"><h2>Display</h2>
      ${toggle('autoOrbit', 'Slow auto-orbit', s.autoOrbit)}
      ${toggle('reducedMotion', 'Reduced motion', s.reducedMotion, 'M')}
      ${toggle('privacy', 'Privacy mode', s.privacy, 'P')}
      ${toggle('survey', 'Survey mode', s.survey, 'S')}
      ${toggle('setup', 'Networks and devices', s.setup, 'D')}
      ${toggle('placing', 'Place access points', s.placing)}
      ${s.placing ? `<div class="place">
        ${vm.aps.map((ap) => `<div class="ap-row"><i style="background:${ap.color}"></i><span>${esc(vm.redact.ap(ap.id, ap.label))}${ap.source === 'guess' ? '<span class="src">guess</span>' : ''}</span>
          <select data-ap-level="${ap.index}" aria-label="Floor of this access point">${vm.levels.map((l) => `<option value="${esc(l.id)}" ${l.id === ap.level ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></div>`).join('')}
        <p class="hint">Drag a glowing marker to move it. The waves follow at once. ${esc(vm.saveNote)}</p></div>` : ''}
    </div>
    <div class="sec"><h2>Keys</h2>
      <p class="hint" style="margin-top:0">Space pause · . step · R restart · 1 to 4 layer · W wave model · S survey · D devices · B band · N network · V view · P privacy · L layout setup · H hide panels · F frame time</p>
    </div>`;
  el.scrollTop = scroll;
}

const signed = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;

/** The Survey section of the left panel: what was measured against what the model says. */
function renderSurvey(v) {
  const st = v.stats;
  return `<div class="sec survey"><h2>Survey <small>${v.waypoints} waypoint${v.waypoints === 1 ? '' : 's'} · ${v.measured} measured</small></h2>
      <p class="hint" style="margin-top:0">Click the spot where you stand, then stay 10 seconds. A scanner must run while you walk: <span class="mono">tools\\walk-sample.ps1</span> on this laptop, or the Pi. Afterwards run <span class="mono">node tools/survey-import.mjs</span> and reload.</p>
      <div class="row"><button type="button" class="btn" data-action="undo-waypoint" ${v.waypoints ? '' : 'disabled'}>Take last waypoint back</button><button type="button" class="btn" data-action="reload">Reload data</button></div>
      ${v.note ? `<p class="hint">${esc(v.note)}</p>` : ''}${v.canSave ? '' : '<p class="hint warn">This server cannot save waypoints. Start the page with node tools/serve.mjs.</p>'}
      ${st && st.count ? `<div class="err"><div><span class="k">MEDIAN ERROR</span><span class="num">${st.medianAbs.toFixed(1)}<small> dB</small></span></div><div><span class="k">90TH PCT</span><span class="num">${st.p90Abs.toFixed(1)}<small> dB</small></span></div><div><span class="k">BEFORE CAL.</span><span class="num" style="color:var(--text-3)">${v.prior.medianAbs.toFixed(1)}<small> dB</small></span></div></div>
      ${v.synthetic ? '<p class="hint warn">Nothing is measured yet. These numbers come from the generated (synthetic) walk test, not from your house.</p>' : ''}
      <p class="hint">${esc(v.bandLabel)}: ${st.count} readings of your own access points at ${v.places} places. On average the model is ${Math.abs(st.bias).toFixed(1)} dB too ${st.bias >= 0 ? 'low' : 'high'}.${!v.synthetic && v.bySource.length ? ' By source: ' + v.bySource.map((b) => `${esc(b.source)} ${b.medianAbs.toFixed(1)} dB (${b.count})`).join(', ') + '.' : ''}</p>`
    : `<p class="hint">No measured point of your own access points for ${esc(v.bandLabel)} and this network yet.</p>`}
      ${v.mixed ? '<p class="hint warn">Synthetic samples are still loaded next to the real survey, so the model is calibrated on a mix. Remove the synthetic file from paths.samples in the private config.</p>' : ''}
      ${v.rows.length ? `<table class="survey-table"><thead><tr><th>Place</th><th>Meas.</th><th>Model</th><th>Error</th><th>By</th></tr></thead><tbody>${v.rows.map((r) =>
    `<tr title="Strongest own access point here: ${esc(r.ap)}"><td>${esc(r.place)}</td><td class="num">${r.measured.toFixed(0)}</td><td class="num">${r.predicted.toFixed(0)}</td><td class="num" style="color:${r.color}">${signed(r.error)}</td><td>${esc(r.source)}</td></tr>`).join('')}</tbody></table>
      <p class="hint">dBm of the strongest own access point at each place, largest error first${v.more ? `; ${v.more} more places are not listed` : ''}. Error = measured minus model.</p>` : ''}
      <h3>Where to measure next</h3>
      ${v.next.length ? `<ol class="next-list">${v.next.map((n) => `<li>${esc(n.text)}${n.synthetic ? ' <small>(layout not scanned)</small>' : ''}<span class="num">${n.far >= 90 ? 'no point yet' : `${n.far.toFixed(1)} m away`}</span></li>`).join('')}</ol>
      <p class="hint">Ranked by how far the room is, on average, from the nearest measured point. The numbered diamonds on the map show the spots.</p>` : '<p class="hint">Every room has a measured point within 2.5 m.</p>'}
    </div>`;
}

const pct = (v) => `${Math.round(v)}`;
const dbm = (v) => (Number.isFinite(v) ? `${Math.round(v)}` : '–');

export function renderMetrics(el, vm) {
  const { grades, colors } = vm;
  const colorAt = (v) => toHex(signalRamp(dbmToT(v, grades.display_range_dbm)));
  const textAt = (v) => toHex(signalTextRamp(dbmToT(v, grades.display_range_dbm)));
  const cov = vm.metrics;
  const netName = Object.fromEntries(vm.networks.map((n) => [n.id, n.label]));
  const netLabel = { ...netName, best: vm.networks.length === 2 ? 'best of both networks' : 'best of all networks' };
  // one line per network that no other network sits behind: Internet, then the networks down to it
  const chains = vm.networks.filter((n) => !vm.networks.some((o) => o.upstream === n.id)).slice(0, 6).map((leaf) => {
    const path = [];
    for (let n = leaf; n && !path.includes(n) && path.length < 8; n = vm.networks.find((o) => o.id === n.upstream)) path.unshift(n);
    return path;
  });
  const covColor = (p) => colorAt(-78 + (p / 100) * 30);
  const covText = (p) => textAt(-78 + (p / 100) * 30);
  const totalArea = cov.house.area || 1;
  const bandArea = {};
  for (const p of cov.perLevel) for (const [id, a] of Object.entries(p.stats.bandArea)) bandArea[id] = (bandArea[id] || 0) + a;
  const dead = cov.house.deadRooms;
  const roomLine = (r) => (r ? `<div class="v">${esc(r.name)}<span class="num">${dbm(r.median)}</span></div><div class="s">${esc(r.levelName)} · grade ${letterOf(r.p10, grades)}</div>` : '<div class="v">–</div>');
  const err = vm.calibration;
  const letterColor = { A: colors.excellent, B: colors.good, C: colors.fair, D: colors.weak, F: colors.poor };

  const open = el.dataset.built === '1';
  const html = `
    <div class="sec"><h2>Coverage <small>${esc(vm.bandLabel)} · ${esc(netLabel[vm.network])}</small></h2>
      <div class="headline"><div class="big" style="color:${covText(cov.house.coveragePct)}">${pct(cov.house.coveragePct)}<small>%</small></div>
        <div class="cap">of floor area is above <b class="num">${grades.coverage_threshold_dbm} dBm</b><br>${Math.round(totalArea)} m² on ${cov.perLevel.length} floors</div></div>
      <div class="bars">${cov.perLevel.slice().reverse().map((p) => `<div class="bar"><span>${esc(p.level.name)}</span><span class="track"><span class="fill" style="display:block;width:${p.stats.coveragePct.toFixed(1)}%;background:${covColor(p.stats.coveragePct)}"></span></span><span class="num">${pct(p.stats.coveragePct)}%</span></div>`).join('')}</div>
      <table class="matrix"><thead><tr><th>Above ${grades.coverage_threshold_dbm} dBm</th>${vm.levels.slice().reverse().map((l) => `<th>${esc(l.name)}</th>`).join('')}<th>House</th></tr></thead><tbody>
        ${vm.matrix.map((row) => `<tr class="${row.network === vm.network && row.band === vm.band ? 'is-current' : ''}"><td>${esc(row.network === 'best' ? 'Best' : netName[row.network] || row.network)} ${esc(row.band)}</td>${row.levels.slice().reverse().map((l) => `<td class="cell" style="color:${covText(l.pct)}">${pct(l.pct)}%</td>`).join('')}<td class="cell" style="color:${covText(row.house)}">${pct(row.house)}%</td></tr>`).join('')}
      </tbody></table>
    </div>
    <div class="sec"><h2>Dead zones <small>below ${grades.dead_zone_below_dbm} dBm</small></h2>
      <div class="dead"><span class="num big" style="color:${cov.house.deadArea > 1 ? vm.textColors.weak : vm.textColors.good}">${cov.house.deadArea.toFixed(0)}<small> m²</small></span>
        <span class="dead-list">${dead.length ? dead.slice(0, 3).map((r) => `<b>${esc(r.name)}</b> (${esc(r.levelName)}, ${r.area.toFixed(0)} m²)`).join('<br>') + (dead.length > 3 ? `<br>and ${dead.length - 3} more` : '') : 'No room has a dead zone at this setting.'}</span></div>
      <div class="kv" style="margin-top:0.7rem"><div><div class="k">WEAKEST ROOM</div>${roomLine(cov.house.weakest)}</div><div><div class="k">STRONGEST ROOM</div>${roomLine(cov.house.strongest)}</div></div>
    </div>
    <div class="sec"><h2>Model error <small>against held-out samples</small></h2>
      ${err.calibrated && err.heldOut ? `<div class="err"><div><span class="k">MEDIAN</span><span class="num">${err.heldOut.withResidual.median.toFixed(1)}<small> dB</small></span></div><div><span class="k">90TH PERCENTILE</span><span class="num">${err.heldOut.withResidual.p90.toFixed(1)}<small> dB</small></span></div><div><span class="k">BEFORE CALIBRATION</span><span class="num" style="color:var(--text-3)">${err.heldOut.prior.median.toFixed(1)}<small> dB</small></span></div></div>
      <p class="hint">Each of ${err.sensors} measuring places was left out in turn and predicted from the others (${err.heldOut.withResidual.count} readings). The map is this uncertain.</p>`
    : `<p class="hint" style="margin-top:0">Not calibrated: only ${err.observations} usable readings from ${err.sensors} places. The map uses the assumptions in data/materials.json and its error is unknown.</p>`}
    </div>
    <div class="sec"><h2>Wired reference health <small>${vm.wired.length ? `probed over Wi-Fi by ${esc(vm.wired[0].proberName)}` : ''}</small></h2>
      ${vm.wired.length ? `<table class="wired"><thead><tr><th></th><th>latency</th><th>jitter</th><th>loss</th><th>iperf3</th></tr></thead><tbody>${vm.wired.map((wd) => (wd.latest
    ? `<tr><td>${esc(wd.name)}</td><td class="${wd.latest.latency > 15 ? 'bad' : ''}">${wd.latest.latency.toFixed(1)}<small>ms</small></td><td class="${wd.latest.jitter > 5 ? 'bad' : ''}">${wd.latest.jitter.toFixed(1)}<small>ms</small></td><td class="${wd.latest.loss > 1 ? 'bad' : ''}">${wd.latest.loss.toFixed(1)}<small>%</small></td><td>${Math.round(wd.latest.throughput)}<small>Mbps</small></td></tr>`
    : `<tr><td>${esc(wd.name)}</td><td colspan="4" style="color:var(--text-3);font-family:var(--sans)">no recent probe</td></tr>`)).join('')}</tbody></table>` : '<p class="hint" style="margin-top:0">No probe rows in the samples.</p>'}
    </div>
    <div class="sec"><h2>Channels <small>mine in colour, neighbours grey</small></h2>
      <canvas class="chart" id="ch-chart"></canvas>
      <p class="hint">${esc(vm.channelNote)}</p>
    </div>
    <div class="sec"><h2>Signal bands <small>share of floor area</small></h2>
      <div class="stack">${grades.bands.map((b) => `<i style="width:${(((bandArea[b.id] || 0) / totalArea) * 100).toFixed(2)}%;background:${colors[b.id]}" title="${esc(b.label)}"></i>`).join('')}</div>
      <div class="stack-key">${grades.bands.map((b) => `<span><i style="background:${colors[b.id]}"></i>${esc(b.label)} <b class="num">${pct(((bandArea[b.id] || 0) / totalArea) * 100)}%</b></span>`).join('')}</div>
    </div>
    <div class="sec"><h2>Room grades</h2>
            <div class="grades">${cov.perLevel.slice().reverse().map((p) => `<h3>${esc(p.level.name)}</h3>` + p.stats.rooms.map((r) => `<div class="grade" title="90 % of this room is at ${dbm(r.p10)} dBm or better"><span class="g" style="background:${letterColor[r.grade]}">${r.grade}</span><span class="nm">${esc(r.name)}</span><span class="num">${dbm(r.p10)}</span></div>`).join('')).join('')}</div>
      <p class="hint">Grade from the level that 90 % of the room reaches: ${grades.room_grade.letters.slice(0, 4).map((g) => `${g.letter} ≥ ${g.min_dbm}`).join(', ')} dBm, else F. Thresholds: data/grades.json.</p>
    </div>
    <div class="sec"><h2>Networks <small>worked out from BSSIDs</small></h2>
      <div class="topo">${chains.map((path) => `<div class="chain"><span class="box">Internet</span>${path.map((n) => `→<span class="box" style="border-color:${esc(n.color)}99">${esc(n.label)}${n.points > 1 ? ` · ${n.points} points` : ''}</span>`).join('')}</div>`).join('')}
      ${vm.topology.map((t) => `<p><span class="${t.ok ? 'ok' : 'no'}">${t.ok ? '✓' : '!'}</span> ${t.text}</p>`).join('')}
      <p style="color:var(--text-3)">${esc(vm.meshNote)}</p></div>
    </div>`;
  const scroll = el.scrollTop;
  el.innerHTML = html;
  el.dataset.built = '1';
  if (open) el.scrollTop = scroll;
}

export function renderLegend(el, vm) {
  const { grades, colors } = vm;
  const [lo, hi] = grades.display_range_dbm;
  const pos = (v) => `${(((v - lo) / (hi - lo)) * 100).toFixed(1)}%`;
  const limits = grades.bands.slice(0, 4).map((b) => b.min_dbm);
  const mids = [];
  let upper = hi;
  for (const b of grades.bands) { const lower = Math.max(b.min_dbm, lo); mids.push({ label: b.label, at: (upper + lower) / 2 }); upper = lower; }
  el.innerHTML = `
    <h2>Signal strength, dBm</h2>
    <div class="ramp" style="background:linear-gradient(90deg, ${cssGradient(signalRamp)})"></div>
    <div class="ticks">${limits.map((v) => `<span style="left:${pos(v)}"><b>${v}</b></span>`).join('')}</div>
    <div class="ticks" style="height:1rem;margin-top:-0.75rem">${mids.map((m) => `<span class="band" style="left:${pos(m.at)}">${esc(m.label)}</span>`).join('')}</div>
    <div class="wave-key"><span>trough</span><div class="ramp" style="background:linear-gradient(90deg, ${cssGradient(waveRamp, -1, 1, 20)})"></div><span>crest</span></div>
    ${vm.survey ? '<p class="note"><b>Survey mode.</b> Hatched and dimmed: more than 4 m from any measured point, so the map there rests on the model alone.</p>' : ''}
    <p class="note"><b>Wavelength scaled ×${vm.scaleText} for visibility.</b> ${!vm.wavesOk ? 'The numbers come from the calibrated model and the samples.'
    : vm.waveModel === 'tone' ? 'Continuous tones with evened-out brightness: illustrative only. The numbers come from the calibrated model and the samples.'
    : `Real: one pulse per beacon, access points on one channel take turns, paths follow the scanned walls, brightness is the calibrated signal level${vm.waveModel === 'flow' ? ', arrows show where energy travels' : ''}. Not real: the speed. A beacon crosses the house in 50 billionths of a second and the next one comes 2 million times later.`}</p>`;
  void colors;
}

export function renderCompass(el, vm) {
  if (vm.hidden) { el.hidden = true; return; }
  el.hidden = false;
  const a = vm.northDeg - vm.viewRotationDeg;
  el.title = vm.title;
  el.innerHTML = `<svg viewBox="-50 -50 100 100" aria-label="${esc(vm.title)}">
    <circle r="38" fill="none" stroke="rgba(140,170,215,0.25)" stroke-width="1"/>
    <g transform="rotate(${a.toFixed(1)})">
      <path d="M0 -34 L7 0 L0 -6 L-7 0 Z" fill="#e6edf7"/>
      <path d="M0 34 L7 0 L0 6 L-7 0 Z" fill="rgba(140,170,215,0.3)"/>
      <text y="-37" text-anchor="middle" font-size="13" font-family="Inter, sans-serif" font-weight="600" fill="#e6edf7" transform="rotate(${(-a).toFixed(1)} 0 -42)" dy="-1">N</text>
    </g></svg>${vm.guess ? '<span class="guess">north: guess</span>' : ''}`;
}

export function renderTray(el, vm) {
  el.innerHTML = `<h2>Roaming devices <small style="letter-spacing:0;text-transform:none;font-weight:400">position unknown</small></h2>
    <div class="chips">${vm.items.length ? vm.items.map((d) => `<button type="button" class="chip" data-node="${d.index}"><i style="background:${d.color}"></i>${esc(d.name)}<span class="num">${d.value}</span><span style="color:var(--text-3)">${esc(d.where)}</span></button>`).join('') : '<span style="font-size:0.72rem;color:var(--text-3)">none</span>'}</div>`;
}

export function renderNodeCard(el, vm) {
  if (!vm) { el.hidden = true; el.innerHTML = ''; return false; }
  el.hidden = false;
  const l = vm.link;
  el.innerHTML = `<header><div><h2>${esc(vm.name)}</h2><div class="where">${esc(vm.where)}</div></div><button type="button" class="x" data-action="close-node" aria-label="Close">×</button></header>
    ${l ? `<div class="facts">
      <div><div class="k">RSSI</div><div class="v" style="color:${vm.color}">${Math.round(l.rssi)}<small>dBm</small></div></div>
      <div><div class="k">SNR</div><div class="v">${l.snr != null ? Math.round(l.snr) : '–'}<small>dB</small></div></div>
      <div><div class="k">Band</div><div class="v">${esc(l.band || '–')}<small>GHz</small></div></div>
      <div><div class="k">Channel</div><div class="v">${l.channel ?? '–'}</div></div></div>
      <div class="idline">Attached to <b>${esc(vm.apName)}</b> · network <span class="mono">${esc(vm.ssid)}</span><br>BSSID <span class="mono">${esc(vm.bssid)}</span>${vm.mac ? ` · device <span class="mono">${esc(vm.mac)}</span>` : ''}</div>`
    : `<div class="idline">${esc(vm.status)}</div>`}
    <canvas class="chart" id="node-chart"></canvas>
    <p class="note">White: signal of the link in use over the last 24 h. Amber: noise floor. A gap means the device sent nothing.</p>`;
  return true;
}

export function renderTopbar(vm) {
  document.getElementById('house-name').textContent = vm.house;
  document.getElementById('house-address').textContent = vm.address;
  document.getElementById('badges').innerHTML = vm.badges.map((b) => `<span class="badge ${b.kind}">${esc(b.text)}</span>`).join('');
}

export function renderClock(vm) {
  const mode = document.getElementById('clock-mode');
  mode.textContent = vm.modeText;
  mode.className = `mode ${vm.modeClass}`;
  document.getElementById('clock-time').textContent = vm.time;
  document.getElementById('clock-date').textContent = vm.date;
}

export function renderTimelineButtons(el, vm) {
  el.innerHTML = `<div class="row"><button type="button" class="btn" data-action="live" aria-pressed="${vm.mode === 'live'}" ${vm.liveAvailable ? '' : 'disabled'} title="${vm.liveAvailable ? 'Follow new samples as they arrive' : 'No live feed at /live'}">Live</button>
      <button type="button" class="btn" data-action="replay" aria-pressed="${vm.mode === 'replay'}">${vm.mode === 'replay' ? 'Stop replay' : 'Replay last 24 h'}</button></div>
    <div class="row"><span class="lbl" style="min-width:auto">Replay speed</span>${seg('replaySpeed', [[360, '4 min'], [720, '2 min'], [1440, '1 min']], vm.replaySpeed)}</div>`;
}

export function northTitle(deg, guess) {
  return `North is ${compassWord(deg)} on the plan (${deg}° clockwise from up)${guess ? '. This comes from the front-door guess.' : ''}`;
}
