import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from './catalog.js';
import { LabEngine, validateConfig } from './engine.js';
function config() { const c = defaultConfig(); c.startAt = '2026-01-01T00:00:00Z'; c.events = []; return c; }
test('fixed seed produces identical observations and water mass is conserved over a season', () => {
  const a = new LabEngine(config(), 'same-run'), b = new LabEngine(config(), 'same-run');
  for (let i = 0; i < 24 * 140; i++) {
    const aa = a.step(), bb = b.step(); assert.deepEqual(aa, bb);
    for (const s of aa) {
      const g = s.groundTruth;
      assert.ok(Math.abs(g.storageDeltaMm - (g.rainMm + g.irrigationMm * 0.9 - g.etMm - g.drainageMm - g.runoffMm)) < 1e-8);
      assert.ok(g.ks >= 0 && g.ks <= 1);
      assert.ok(Number.isFinite(s.observations.soil_moisture));
    }
  }
});
test('rain amount is integrated exactly across non-aligned time windows', () => {
  const c = config(); c.stepMinutes = 17; c.weather.et0MmDay = 0;
  c.events = [{ id: 'rain', kind: 'rain', atHour: .2, durationHours: 1.7, value: 19 }];
  const e = new LabEngine(c, 'run'); let rain = 0;
  for (let i = 0; i < 10; i++) rain += e.step()[0].groundTruth.rainMm;
  assert.ok(Math.abs(rain - 19) < 1e-10);
});
test('irrigation changes physical soil water and no-flow cancels the application', () => {
  const c = config(); c.events = [{ id: 'irrigation', kind: 'irrigation', atHour: 0, durationHours: 1, value: 10 }];
  const watered = new LabEngine(c, 'a').step()[0];
  c.events.push({ id: 'blocked', kind: 'no_flow', atHour: 0, durationHours: 1, value: 0 });
  const blocked = new LabEngine(c, 'b').step()[0];
  assert.equal(watered.groundTruth.irrigationMm, 10); assert.equal(blocked.groundTruth.irrigationMm, 0);
  assert.ok(watered.groundTruth.vwc > blocked.groundTruth.vwc);
});
test('sensor stuck freezes observation while physical moisture continues to change', () => {
  const c = config(); c.events = [{ id: 'stuck', kind: 'sensor_stuck', atHour: 1, durationHours: 3, value: 0 }];
  const e = new LabEngine(c, 'run'); const a = e.step()[0], b = e.step()[0];
  assert.equal(a.observations.soil_moisture, b.observations.soil_moisture);
  assert.notEqual(a.groundTruth.vwc, b.groundTruth.vwc); assert.equal(b.groundTruth.sensorFault, true);
  assert.notEqual(a.observations.eventId, b.observations.eventId);
});
test('invalid crop, numeric fields, duplicate node, chemistry and targeted event are rejected', () => {
  for (const mutate of [(c: any) => c.nodes[0].cropId = 'invented', (c: any) => c.weather.et0MmDay = NaN, (c: any) => c.nodes.push(c.nodes[0]), (c: any) => c.nodes[0].ph = 20, (c: any) => c.events.push({ id: 'x', kind: 'rain', nodeId: 'foreign', atHour: 0, durationHours: 1, value: 5 })]) {
    const c = config(); mutate(c); assert.throws(() => validateConfig(c));
  }
});
test('soil amendment is explicitly prescribed pH and stops at target', () => {
  const c = config(); c.events = [{ id: 'amend', kind: 'soil_amendment', atHour: .5, durationHours: 2, value: 7 }];
  const e = new LabEngine(c, 'run'); e.step(); e.step(); assert.equal(e.step()[0].context.ph, 7);
});

test('crop group is mustard greens, chilli and tomato in defaults and all presets', async () => {
  const { crops } = await import('./catalog.js');
  assert.deepEqual(crops.map(c => c.id), ['mustard-greens', 'chilli', 'tomato']);
  assert.deepEqual(defaultConfig().nodes.map(n => n.cropId), crops.map(c => c.id));
  const fs = await import('node:fs');
  for (const file of fs.readdirSync('scenarios')) {
    const c = validateConfig(JSON.parse(fs.readFileSync('scenarios/' + file, 'utf8')).config);
    assert.deepEqual(c.nodes.map(n => n.cropId), crops.map(c => c.id));
    assert.equal(new LabEngine(c, 'preset-test').step().length, 3);
  }
});
