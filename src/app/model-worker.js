// Background worker: computes the signal grid and the panel numbers off the main
// thread, so the animation never waits for them.

import { AtlasModel } from './atlas-model.js';
import { SampleStore } from '../core/samples.js';

let model = null;
let lastCalibration = 0;

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === 'init') {
      const store = new SampleStore().addAll(m.rows);
      model = new AtlasModel({ plan: m.plan, materials: m.materials, grades: m.grades, config: m.config, nodes: m.nodes, store });
      lastCalibration = Date.now();
      self.postMessage({ type: 'ready' });
    } else if (!model) {
      return;
    } else if (m.type === 'compute') {
      const env = model.envelope(m.band, m.network, m.time, m.residual);
      const out = { type: 'result', seq: m.seq, band: m.band, network: m.network, time: m.time, dbm: env.dbm.slice() };
      if (m.wantMetrics) {
        out.metrics = model.metrics(m.band, m.network, m.time);
        out.matrix = model.coverageMatrix(m.time);
      }
      self.postMessage(out, [out.dbm.buffer]);
    } else if (m.type === 'moveAp') {
      model.moveAp(m.apId, m.position);
      if (m.final) { model.calibrate(); lastCalibration = Date.now(); }
    } else if (m.type === 'setDevices') {
      model.setDevices(m.config, m.nodes);
      lastCalibration = Date.now();
    } else if (m.type === 'rows') {
      model.addRows(m.rows);
      if (Date.now() - lastCalibration > 5 * 60000) { model.calibrate(); lastCalibration = Date.now(); }
    }
  } catch (e) {
    self.postMessage({ type: 'error', message: String(e && e.message || e) });
  }
};
