// The Setup panel: the user's own networks and devices (docs/network-setup.md).
//
// The panel edits one document (see src/core/setup.js). Every committed change goes
// to the page at once (applyDoc) and is saved a moment later: to the local server
// when it can save (data/private/network-setup.json for the owner's house,
// data/user/network-setup.json for a user layout), else to this browser.
//
// Privacy: names, SSIDs, BSSIDs, MAC addresses, models and sensor ids are private.
// In privacy mode they are not put into the panel at all; elements carry list
// positions, never ids.

import { escapeHtml as esc } from './scene.js';
import { DEVICE_TYPES, MOUNTS, NETWORK_COLORS, LIMITS, isEmitter, mountHeight, normalizeMac, nextId, newDevice, setupFromConfig, applySetup, validateSetup, cleanSetup, scanCandidates } from '../core/setup.js';

// One setup per workspace: the owner's house ('private', data/private/) and a user layout ('user', data/user/).
const STORE_KEY = 'signal-atlas:setup';
const storeKey = (workspace) => (workspace === 'private' ? `${STORE_KEY}:private` : STORE_KEY);
const apiPath = (base, workspace) => (workspace === 'private' ? `${base}?ws=private` : base);
const ID = /^[\w.-]{1,40}$/;
const clone = (v) => JSON.parse(JSON.stringify(v));
const round2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Read the saved setup and put it into the configuration. Without one, the setup starts
 * from what the configuration holds. Returns { config, nodes, doc, owned, canSave, file, scan }:
 * owned says that the user has a setup of their own; canSave that the server keeps the file.
 */
export async function loadSetup({ config, nodes, levelIds, bandIds, demo, workspace = 'user' }) {
  const out = { config, nodes, doc: null, owned: false, canSave: false, file: '', scan: false, workspace };
  if (!demo) {
    let feed = null;
    try { const res = await fetch(apiPath('/api/setup', workspace), { cache: 'no-store' }); if (res.ok) feed = await res.json(); } catch { /* a static host has no such address */ }
    if (feed && typeof feed === 'object' && 'setup' in feed) Object.assign(out, { canSave: true, file: String(feed.file || ''), scan: !!feed.scan, doc: feed.setup });
    else { try { out.doc = JSON.parse(localStorage.getItem(storeKey(workspace)) || 'null'); } catch { /* storage is not available */ } }
    if (out.doc && validateSetup(out.doc).length) out.doc = null;
  }
  if (out.doc) {
    out.owned = true;
    // places are plan metres: on another plan they may be wrong even where a floor has the same id
    out.otherPlan = !!out.doc.floorplan && !!config.paths?.floorplan && out.doc.floorplan !== config.paths.floorplan;
    Object.assign(out, applySetup(config, nodes, out.doc, { levelIds, bandIds }));
  }
  else out.doc = setupFromConfig(config, nodes);
  return out;
}

/**
 * opts: el, boot (from loadSetup), levels [{ id, name, height }], bands [{ id, label }], demo, floorplan,
 * getRedact(), isPrivate(), getView() -> { view, level }, setView({ view, level }), applyDoc(doc).
 */
export function createSetupPanel({ el, boot, levels, bands, demo, floorplan, getRedact, isPrivate, getView, setView, applyDoc }) {
  let doc = clone(boot.doc);
  let owned = boot.owned, isOpen = false;
  let openId = null, armedId = null, note = '', noteWarn = false, lastRemoved = null, resetAsk = false;
  let radios = null, radiosAsked = false, saveTimer = 0, renderTimer = 0, showOpen = false;
  let saveNote = demo ? 'Demo house: changes last until you reload.' : owned ? '' : 'Nothing of your own is saved yet. These are the defaults.';
  const bandIds = bands.map((b) => b.id);
  const levelById = new Map(levels.map((l) => [l.id, l]));
  const placed = (d) => !!d.position && levelById.has(d.position.level);
  const netIndex = (id) => doc.networks.findIndex((n) => n.id === id);
  const netColor = (id) => { const i = netIndex(id); return i < 0 ? '#8fa6c8' : doc.networks[i].color || NETWORK_COLORS[i % NETWORK_COLORS.length]; };
  const typeWord = (d) => DEVICE_TYPES.find((t) => t.id === d.type)?.word || d.type;
  const shownName = (d) => { const r = getRedact(); return isEmitter(d) ? r.ap(d.id, d.label) : r.node(d.id, d.label); };
  // A new note ends the offer to undo the last removal, so Undo never sits next to an unrelated note.
  const say = (text, warn = false) => { note = text; noteWarn = warn; lastRemoved = null; };
  // In privacy mode a problem is named without its device: the checks quote ids, and ids are private.
  const problemText = (problems) => (isPrivate() ? 'a value is not valid' : problems[0]);
  let lastPrivate = isPrivate(), pointerHeld = false, renderWaits = false;
  if (boot.otherPlan) say('This setup was made on another floor plan. Check where each device stands.', true);

  // ------------------------------------------------------------------ saving
  const where = () => (isPrivate() ? 'your setup file' : boot.file || `data/${boot.workspace === 'private' ? 'private' : 'user'}/network-setup.json`);
  async function save() {
    if (demo) return;
    const problems = validateSetup(doc);
    if (problems.length) { saveNote = `Not saved: ${problemText(problems)}.`; scheduleRender(); return; }
    const body = cleanSetup({ ...doc, floorplan });
    const time = new Date().toLocaleTimeString([], { hour12: false });
    let ok = false;
    if (boot.canSave) {
      try { ok = (await fetch(apiPath('/api/setup', boot.workspace), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).ok; } catch { /* the server does not answer */ }
      saveNote = ok ? `Saved to ${where()} at ${time}.` : 'The server did not save the setup. Check that node tools/serve.mjs still runs.';
    } else {
      try { localStorage.setItem(storeKey(boot.workspace), JSON.stringify(body)); ok = true; } catch { /* private window */ }
      saveNote = ok ? `This server cannot save files. The setup is kept in this browser (${time}). Use Export for a copy.` : 'The setup could not be saved. It lasts until you reload. Use Export for a copy.';
    }
    scheduleRender();
  }
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 350); };
  // The panel is rebuilt a moment after a change, so that the field the user moved on to keeps the focus.
  const scheduleRender = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 0); };
  function commit() {
    owned = true;
    applyDoc(doc);
    scheduleSave();
    scheduleRender();
  }

  // ------------------------------------------------------------------ the scan helper
  async function loadRadios() {
    if (radiosAsked || !boot.scan || isPrivate()) return;
    radiosAsked = true;
    try { const res = await fetch(apiPath('/api/scan-radios', boot.workspace), { cache: 'no-store' }); if (res.ok) radios = (await res.json()).radios || []; } catch { /* no helper */ }
    if (radios?.length) scheduleRender();
  }

  // ------------------------------------------------------------------ placing
  function arm(d, level) {
    const view = getView();
    const target = levelById.has(level) ? level : placed(d) ? d.position.level : levelById.has(view.level) ? view.level : (levels.find((l) => l.id === '1') || levels[0]).id;
    armedId = d.id;
    openId = d.id;
    showOpen = true;
    setView({ view: 'plan', level: target });
    say(`Click the spot of ${shownName(d)} on the plan of ${levelById.get(target).name}. Esc cancels.`);
    scheduleRender();
  }
  function disarm(text = '') {
    if (!armedId) return;
    armedId = null;
    say(text);
    scheduleRender();
  }
  /** The page calls this when the plan was clicked while a device waits for its place. */
  function placeAt(level, x, y) {
    const d = doc.devices.find((v) => v.id === armedId);
    if (!d || !levelById.has(level)) return false;
    const keep = Number.isFinite(d.position?.z) ? d.position.z : mountHeight(d.mount, levelById.get(level).height);
    d.position = { level, x: round2(x), y: round2(y), ...(keep != null ? { z: keep, heightSource: d.position?.heightSource || 'assumed' } : {}), source: 'placed' };
    armedId = null;
    say(`${shownName(d)} is placed on ${levelById.get(level).name}. Drag an access point to move it, or type the numbers.`);
    commit();
    return true;
  }
  /** The page calls this when an access-point marker was dragged. Returns false when the setup is not in use. */
  function apMoved(id, position, force = false) {
    const d = doc.devices.find((v) => v.id === id);
    if (!d || (!owned && !force)) return false;
    d.position = { level: position.level, x: round2(position.x), y: round2(position.y), ...(Number.isFinite(position.z) ? { z: position.z, heightSource: position.heightSource || 'assumed' } : {}), source: 'placed' };
    owned = true;
    scheduleSave();
    scheduleRender();
    return true;
  }

  // ------------------------------------------------------------------ edits
  function editNetwork(n, field, raw) {
    if (field === 'label') n.label = raw.trim().slice(0, 60) || n.label;
    else if (field === 'ssid') n.ssid = raw.slice(0, 32);
    else if (field === 'color' && /^#[0-9a-f]{6}$/i.test(raw)) n.color = raw.toLowerCase();
    else return;
    commit();
  }
  function editDevice(d, field, band, raw) {
    const value = raw.trim(), number = value === '' ? null : Number(value);
    const perBand = (key, v) => { d[key] = { ...(d[key] || {}) }; if (v == null) delete d[key][band]; else d[key][band] = v; };
    switch (field) {
      case 'label': d.label = value.slice(0, 60) || d.label; break;
      case 'model': d.model = value.slice(0, 60); break;
      case 'type': {
        if (!DEVICE_TYPES.some((t) => t.id === value)) return;
        d.type = value;
        if (isEmitter(d)) { const usual = newDevice(value, doc, bandIds); for (const key of ['network', 'tx_dbm', 'channel', 'bssid']) if (d[key] === undefined) d[key] = usual[key]; }
        break;
      }
      case 'network': d.network = doc.networks[Number(value)]?.id || ''; break;
      case 'id':
        if (!ID.test(value) || value === '__proto__') return say('An id has letters, digits, dot, dash or underscore, at most 40.', true);
        if (doc.devices.some((o) => o !== d && o.id === value)) return say('Another device has this id already.', true);
        if (openId === d.id) openId = value;
        d.id = value;
        break;
      case 'mac': case 'bssid': {
        const mac = value === '' ? '' : normalizeMac(value);
        if (mac === null) return say(`${field === 'mac' ? 'A MAC address' : 'A BSSID'} looks like aa:bb:cc:dd:ee:ff.`, true);
        if (field === 'mac') d.mac = mac; else perBand('bssid', mac || null);
        break;
      }
      case 'tx': if (number !== null && !Number.isFinite(number)) return; perBand('tx_dbm', number === null ? null : clamp(Math.round(number * 10) / 10, -20, 36)); break;
      case 'channel': if (number !== null && !Number.isFinite(number)) return; perBand('channel', number === null ? null : clamp(Math.round(number), 1, 233)); break;
      case 'enclosure':
        if (number === null || !(number > 0)) { delete d.enclosureLossDb; delete d.enclosureSource; } else { d.enclosureLossDb = clamp(Math.round(number * 10) / 10, 0, 59); d.enclosureSource = d.enclosureSource || 'assumed'; }
        break;
      case 'level':
        if (value === '') { d.position = null; if (armedId === d.id) armedId = null; break; }
        if (!levelById.has(value)) return;
        if (!d.position) return arm(d, value);          // no spot yet: the next click on that floor sets it
        d.position = { ...d.position, level: value, source: 'placed' };
        break;
      case 'x': case 'y':
        if (!d.position || !Number.isFinite(number)) return;
        d.position = { ...d.position, [field]: round2(clamp(number, -500, 500)), source: 'placed' };
        break;
      case 'z':
        if (!d.position) return;
        d.position = { ...d.position };
        if (number === null || !Number.isFinite(number)) { delete d.position.z; delete d.position.heightSource; } else { d.position.z = round2(clamp(number, 0, 19.99)); d.position.heightSource = d.position.heightSource || 'assumed'; }
        break;
      case 'mount': {
        if (value === '') { delete d.mount; break; }
        if (!MOUNTS.some((m) => m.id === value)) return;
        d.mount = value;
        if (d.position) d.position = { ...d.position, z: mountHeight(value, levelById.get(d.position.level)?.height), heightSource: 'assumed' };
        break;
      }
      default: return;
    }
    say('');
    commit();
  }
  function addNetwork() {
    if (doc.networks.length >= LIMITS.networks) return say(`At most ${LIMITS.networks} networks.`, true);
    const used = new Set(doc.networks.map((n) => n.color));
    const names = new Set(doc.networks.map((n) => n.label));
    let k = doc.networks.length + 1;
    while (names.has(`Network ${k}`)) k++;
    doc.networks.push({ id: nextId('net', doc.networks.map((n) => n.id)), label: `Network ${k}`, ssid: '', color: NETWORK_COLORS.find((c) => !used.has(c)) || NETWORK_COLORS[doc.networks.length % NETWORK_COLORS.length], upstream: null });
    say('Network added. Give it its name and SSID.');
    commit();
  }
  function addDevice(type) {
    if (doc.devices.length >= LIMITS.devices) return say(`At most ${LIMITS.devices} devices.`, true);
    const d = newDevice(type, doc, bandIds);
    // senders stay together at the top of the list; listeners go to the end
    const lastEmitter = doc.devices.reduce((at, v, k) => (isEmitter(v) ? k : at), -1);
    doc.devices.splice(isEmitter(d) ? lastEmitter + 1 : doc.devices.length, 0, d);
    commit();
    arm(d);
  }
  function remove(kind, index) {
    const list = kind === 'net' ? doc.networks : doc.devices;
    const [item] = list.splice(index, 1);
    if (!item) return;
    const users = [];
    if (kind === 'net') {
      for (const d of doc.devices) if (d.network === item.id) { users.push(d.id); d.network = ''; }
      for (const n of doc.networks) if (n.upstream === item.id) n.upstream = null;
    } else { if (armedId === item.id) armedId = null; if (openId === item.id) openId = null; }
    say(kind === 'net' ? `Network removed.${users.length ? ` ${users.length} device${users.length > 1 ? 's' : ''} now belong${users.length > 1 ? '' : 's'} to no network.` : ''}` : 'Device removed.');
    lastRemoved = { kind, index, item, users };   // after say(), which ends an older offer
    commit();
  }
  function undo() {
    if (!lastRemoved) return;
    const { kind, index, item, users } = lastRemoved;
    const list = kind === 'net' ? doc.networks : doc.devices;
    if (list.some((v) => v.id === item.id)) { say('It cannot be put back: its id is in use again.', true); scheduleRender(); return; }
    list.splice(Math.min(index, list.length), 0, item);
    for (const d of doc.devices) if (users.includes(d.id) && !d.network) d.network = item.id;
    say('Put back.');
    commit();
  }
  function exportFile() {
    const blob = new Blob([JSON.stringify(cleanSetup({ ...doc, floorplan }), null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'signal-atlas-setup.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    say('Exported. The file holds your network names and BSSIDs: keep it private.');
    scheduleRender();
  }
  async function importFile(file) {
    if (!file) return;
    let next = null;
    try { next = JSON.parse((await file.text()).replace(/^﻿/, '')); } catch { /* not JSON */ }
    const problems = next ? validateSetup(next) : ['the file is not JSON'];
    if (problems.length) { say(`Not imported: ${problemText(problems)}.`, true); scheduleRender(); return; }
    doc = cleanSetup(next);
    openId = null; armedId = null; lastRemoved = null;
    say(`Imported ${doc.networks.length} network${doc.networks.length === 1 ? '' : 's'} and ${doc.devices.length} device${doc.devices.length === 1 ? '' : 's'}.`);
    commit();
  }
  async function reset() {
    clearTimeout(saveTimer);
    let ok = true;
    if (boot.canSave) { try { ok = (await fetch(apiPath('/api/setup', boot.workspace), { method: 'DELETE' })).ok; } catch { ok = false; } }
    try { localStorage.removeItem(storeKey(boot.workspace)); } catch { /* storage is not available */ }
    if (!ok) { say('The server did not remove the setup file.', true); resetAsk = false; scheduleRender(); return; }
    location.reload();
  }

  // ------------------------------------------------------------------ drawing
  const opt = (value, label, current) => `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
  const num = (v) => (Number.isFinite(v) ? String(v) : '');
  const hidden = '<span class="redacted">hidden</span>';

  function deviceBody(d, i, priv) {
    const at = (field, band = '') => `data-scope="dev" data-i="${i}" data-f="${field}"${band ? ` data-band="${esc(band)}"` : ''} data-fkey="d${i}:${field}:${esc(band)}"`;
    const emitter = isEmitter(d), on = placed(d), p = d.position;
    const redact = getRedact();
    const rows = [];
    const row = (label, inner, title = '') => rows.push(`<label${title ? ` title="${esc(title)}"` : ''}><span>${label}</span>${inner}</label>`);
    if (!priv) row('Name', `<input type="text" maxlength="60" ${at('label')} value="${esc(d.label)}">`);
    row('Type', `<select ${at('type')}>${DEVICE_TYPES.map((t) => opt(t.id, t.label, d.type)).join('')}</select>`);
    if (emitter) {
      row('Network', `<select ${at('network')}>${opt('', '(none)', netIndex(d.network) < 0 ? '' : ' ')}${doc.networks.map((n, k) => opt(k, redact.network(n.id, n.label), netIndex(d.network))).join('')}</select>`);
      if (!priv) row('Model', `<input type="text" maxlength="60" ${at('model')} value="${esc(d.model || '')}" placeholder="optional">`);
    } else if (!priv) {
      row('Sensor id', `<input type="text" class="mono" maxlength="40" ${at('id')} value="${esc(d.id)}">`, 'Must be the node_id that this device writes into its samples');
      row('MAC', `<input type="text" class="mono" maxlength="17" ${at('mac')} value="${esc(d.mac || '')}" placeholder="optional">`);
    }
    let radioTable = '';
    if (emitter) {
      radioTable = `<div class="radios"><span></span><span>dBm</span><span>Channel</span><span>BSSID</span>${bands.map((b) => {
        const found = !priv && radios ? scanCandidates(radios, doc, d, b.id) : [];
        const bssid = d.bssid?.[b.id] || '';
        return `<span class="lbl">${esc(b.label)}</span>
          <input type="number" step="0.5" min="-20" max="36" ${at('tx', b.id)} value="${num(d.tx_dbm?.[b.id])}" aria-label="Transmit power, ${esc(b.label)}">
          <input type="number" step="1" min="1" max="233" ${at('channel', b.id)} value="${num(d.channel?.[b.id])}" aria-label="Channel, ${esc(b.label)}">
          ${priv ? `<span class="redacted">${bssid ? esc(redact.bssid(bssid)) : 'none'}</span>` : `<span class="bssid"><input type="text" class="mono" maxlength="17" ${at('bssid', b.id)} value="${esc(bssid)}" placeholder="aa:bb:cc:dd:ee:ff" aria-label="BSSID, ${esc(b.label)}">${found.length
    ? `<select data-scan="${i}" data-band="${esc(b.id)}" aria-label="Pick the BSSID from the last scan" title="Radios with this SSID in the last scan"><option value="">from scan (${found.length})</option>${found.slice(0, 20).map((r) => opt(r.bssid, `${r.bssid} · ch ${r.channel ?? '?'} · ${Math.round(r.rssi_dbm)} dBm`, '')).join('')}</select>` : ''}</span>`}`;
      }).join('')}</div>`;
    }
    const pos = [];
    const prow = (label, inner, title = '') => pos.push(`<label${title ? ` title="${esc(title)}"` : ''}><span>${label}</span>${inner}</label>`);
    prow('Floor', `<select ${at('level')}>${opt('', 'not placed', on ? ' ' : '')}${levels.map((l) => opt(l.id, l.name, on ? p.level : ' ')).join('')}</select>`);
    prow('x, y', `<span class="pair"><input type="number" step="0.1" ${at('x')} value="${on ? num(p.x) : ''}" ${on ? '' : 'disabled'} aria-label="x in metres"><input type="number" step="0.1" ${at('y')} value="${on ? num(p.y) : ''}" ${on ? '' : 'disabled'} aria-label="y in metres"><small>m</small></span>`, 'Plan metres: x runs right, y runs down the page');
    prow('Height', `<span class="pair"><input type="number" step="0.05" min="0" max="19.95" ${at('z')} value="${on ? num(p.z) : ''}" ${on ? '' : 'disabled'} placeholder="usual" aria-label="Height above the floor in metres"><small>m above the floor${on && p.heightSource ? ` · ${esc(p.heightSource)}` : ''}</small></span>`);
    prow('Mount', `<select ${at('mount')}>${opt('', '(not said)', d.mount || '')}${MOUNTS.map((m) => opt(m.id, m.label, d.mount || '')).join('')}</select>`, 'Choosing a mount sets the usual height for it');
    if (emitter) prow('Cabinet', `<span class="pair"><input type="number" step="0.5" min="0" max="59" ${at('enclosure')} value="${num(d.enclosureLossDb)}" placeholder="0" aria-label="Loss of a cabinet around the device in dB"><small>dB lost in a cabinet or box</small></span>`);
    return `<div class="dev-body">
      <div class="fields">${rows.join('')}</div>
      ${radioTable}
      <div class="fields">${pos.join('')}</div>
      ${p && !on ? '<p class="hint warn">Its floor is not in this plan, so it is not shown. Place it again.</p>' : ''}
      ${priv ? '<p class="hint">Names, SSIDs, BSSIDs and MAC addresses are hidden in privacy mode. Place, height, power and channel can still be changed.</p>' : ''}
      <div class="row"><button type="button" class="btn" data-act="place" data-i="${i}" aria-pressed="${armedId === d.id}">${armedId === d.id ? 'Click the plan…' : on ? 'Place again' : 'Place on plan'}</button><button type="button" class="btn danger" data-act="remove-dev" data-i="${i}">Remove</button></div>
    </div>`;
  }

  function render() {
    // while a device waits for its place, the labels on the map let the click through to the plan
    document.body.classList.toggle('setup-armed', isOpen && !!armedId);
    if (!isOpen) return;
    // While a button of the panel is held down the panel is not rebuilt: a rebuilt button would lose its click.
    if (pointerHeld) { renderWaits = true; return; }
    const priv = isPrivate(), redact = getRedact();
    // a note may name a device: it must not stay on screen when privacy mode comes on
    if (priv !== lastPrivate) { lastPrivate = priv; if (priv) { note = ''; lastRemoved = null; if (!demo) saveNote = ''; } }
    loadRadios();
    const active = el.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = active?.dataset.fkey || '', filterText = el.querySelector('[data-filter]')?.value || '';
    const scroll = el.scrollTop;
    const unplaced = doc.devices.filter((d) => !placed(d)).length;
    const ssids = !priv && radios ? [...new Set(radios.map((r) => r.ssid).filter(Boolean))].slice(0, 60) : [];
    // what just happened stays in view at the top while the list scrolls
    const status = `${note ? `<p class="hint note${noteWarn ? ' warn' : ''}">${esc(note)}${lastRemoved ? ' <button type="button" class="link" data-act="undo">Undo</button>' : ''}</p>` : ''}${saveNote ? `<p class="hint save-note">${esc(saveNote)}</p>` : ''}`;
    el.innerHTML = `
      ${status ? `<div class="status" aria-live="polite">${status}</div>` : ''}
      <div class="sec"><h2>Setup <small>your networks and devices</small></h2>
        <p class="hint" style="margin-top:0">Say which networks are yours, add the devices you want on the map, and put each one where it stands. The page only reads: nothing here changes a router or a device.</p>
        <div class="row tools">${resetAsk
    ? '<span class="lbl" style="min-width:0">Remove your setup and go back to the defaults?</span><button type="button" class="btn danger" data-act="reset-yes">Yes, reset</button><button type="button" class="btn" data-act="reset-no">Cancel</button>'
    : `<button type="button" class="btn" data-act="export" title="Download the setup as a JSON file">Export</button><label class="btn" title="Load a setup from a JSON file">Import<input type="file" accept=".json,application/json" data-import hidden></label><button type="button" class="btn" data-act="reset" ${owned && !demo ? '' : 'disabled'} title="Remove your setup and go back to the defaults">Reset</button>`}</div>
      </div>
      <div class="sec"><h2>Networks <small>${doc.networks.length}</small></h2>
        ${doc.networks.map((n, i) => {
    const users = doc.devices.filter((d) => isEmitter(d) && d.network === n.id).length;
    const at = (field) => `data-scope="net" data-i="${i}" data-f="${field}" data-fkey="n${i}:${field}"`;
    return `<div class="net-row"><input type="color" ${at('color')} value="${esc(netColor(n.id))}" aria-label="Colour of this network">
          ${priv ? `<span class="redacted name">${esc(redact.network(n.id, n.label))}</span><span class="redacted">name and SSID hidden</span>`
    : `<input type="text" maxlength="60" ${at('label')} value="${esc(n.label)}" placeholder="Name" aria-label="Name of this network"><input type="text" class="mono" maxlength="32" ${at('ssid')} value="${esc(n.ssid)}" placeholder="SSID" list="setup-ssids" aria-label="SSID of this network">`}
          <span class="count" title="Access points on this network">${users}</span>
          <button type="button" class="x" data-act="remove-net" data-i="${i}" aria-label="Remove this network" title="Remove this network">×</button></div>`;
  }).join('') || '<p class="hint" style="margin-top:0">No network yet.</p>'}
        ${ssids.length ? `<datalist id="setup-ssids">${ssids.map((s) => `<option value="${esc(s)}"></option>`).join('')}</datalist>` : ''}
        <div class="row"><button type="button" class="btn" data-act="add-net">Add network</button></div>
        ${priv ? '' : '<p class="hint">The SSID is the name your devices see. One network can run on many access points: each access point below has its own BSSIDs.</p>'}
      </div>
      <div class="sec"><h2>Devices <small>${doc.devices.length}${unplaced ? ` · ${unplaced} not placed` : ''}</small></h2>
        <div class="row"><select data-new-type aria-label="Type of the new device">${DEVICE_TYPES.map((t) => opt(t.id, t.label, 'ap')).join('')}</select><button type="button" class="btn" data-act="add-dev">Add device</button></div>
        ${doc.devices.length > 8 ? `<div class="row"><input type="search" data-filter data-fkey="filter" value="${esc(filterText)}" placeholder="Filter devices" aria-label="Filter devices"></div>` : ''}
        <div class="devs">${doc.devices.map((d, i) => {
    const on = placed(d), isOpenRow = openId === d.id;
    const whereText = on ? levelById.get(d.position.level).name : 'not placed';
    return `<div class="dev${isOpenRow ? ' is-open' : ''}${armedId === d.id ? ' is-armed' : ''}">
            <button type="button" class="dev-head" data-act="open" data-i="${i}" aria-expanded="${isOpenRow}"><i style="background:${isEmitter(d) ? esc(netColor(d.network)) : '#8fa6c8'}" class="${isEmitter(d) ? '' : 'rx'}"></i><span class="nm">${esc(shownName(d))}</span><span class="ty">${esc(typeWord(d))}</span><span class="wh${on ? '' : ' off'}">${esc(whereText)}</span></button>
            ${isOpenRow ? deviceBody(d, i, priv) : ''}</div>`;
  }).join('') || '<p class="hint" style="margin-top:0">No device yet. Add your router or first access point.</p>'}</div>
        <p class="hint">Access points and mesh points send: they are the sources of the waves and of the signal map. Sensors and clients listen: their samples calibrate the map. The wave view draws the 16 strongest sources.</p>
      </div>`;
    el.scrollTop = scroll;
    if (showOpen) { showOpen = false; el.querySelector('.dev.is-open')?.scrollIntoView({ block: 'nearest' }); }
    if (filterText) applyFilter(filterText);
    if (focusKey) {
      const again = [...el.querySelectorAll('[data-fkey]')].find((n) => n.dataset.fkey === focusKey);
      if (again) { again.focus(); if (focusKey === 'filter') again.setSelectionRange(filterText.length, filterText.length); }
    }
  }
  function applyFilter(textValue) {
    const q = textValue.trim().toLowerCase();
    for (const row of el.querySelectorAll('.dev')) row.hidden = !!q && !row.classList.contains('is-open') && !row.querySelector('.dev-head').textContent.toLowerCase().includes(q);
  }

  // ------------------------------------------------------------------ events
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const i = Number(b.dataset.i), d = doc.devices[i];
    switch (b.dataset.act) {
      case 'open': if (d) { openId = openId === d.id ? null : d.id; showOpen = !!openId; if (armedId && armedId !== openId) armedId = null; scheduleRender(); } break;
      case 'place': if (d) { if (armedId === d.id) disarm('Not placed.'); else arm(d); } break;
      case 'remove-dev': remove('dev', i); break;
      case 'remove-net': remove('net', i); break;
      case 'add-net': addNetwork(); break;
      case 'add-dev': addDevice(el.querySelector('[data-new-type]').value); break;
      case 'undo': undo(); break;
      case 'export': exportFile(); break;
      case 'reset': resetAsk = true; scheduleRender(); break;
      case 'reset-no': resetAsk = false; scheduleRender(); break;
      case 'reset-yes': reset(); break;
      default: break;
    }
  });
  el.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.import !== undefined) { importFile(t.files?.[0]); return; }
    if (t.dataset.scan !== undefined) {
      const d = doc.devices[Number(t.dataset.scan)], band = t.dataset.band, hit = radios?.find((r) => r.bssid === t.value);
      if (!d || !hit) return;
      d.bssid = { ...(d.bssid || {}), [band]: hit.bssid };
      if (Number.isInteger(hit.channel)) d.channel = { ...(d.channel || {}), [band]: hit.channel };
      say('BSSID and channel taken from the scan.');
      commit();
      return;
    }
    const item = (t.dataset.scope === 'net' ? doc.networks : doc.devices)[Number(t.dataset.i)];
    if (!item || !t.dataset.f) return;
    if (t.dataset.scope === 'net') editNetwork(item, t.dataset.f, t.value);
    else if (t.dataset.scope === 'dev') editDevice(item, t.dataset.f, t.dataset.band || '', t.value);
    scheduleRender();   // also after a refused value: the field shows the kept value again
  });
  el.addEventListener('input', (ev) => { if (ev.target.dataset.filter !== undefined) applyFilter(ev.target.value); });
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && armedId) disarm('Not placed.'); });
  const released = () => { pointerHeld = false; if (renderWaits) { renderWaits = false; scheduleRender(); } };
  window.addEventListener('pointerdown', (ev) => { if (el.contains(ev.target)) pointerHeld = true; else released(); }, true);
  for (const type of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(type, released, true);

  return {
    /** Show or hide the panel. */
    open(on) { isOpen = !!on; el.hidden = !isOpen; if (isOpen) render(); else disarm(); },
    render: scheduleRender,
    /** The id of the device that waits for a click on the plan, or null. */
    armed: () => armedId,
    placeAt, apMoved,
    get doc() { return doc; },
    get owned() { return owned; },
  };
}
