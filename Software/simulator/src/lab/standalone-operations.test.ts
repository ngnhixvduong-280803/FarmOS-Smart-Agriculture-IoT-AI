import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LabEngine } from './engine.js';
import { standalonePresets } from './catalog.js';
import { deviceHealth, IrrigationFollowup, irrigationSchedule } from './standalone-operations.js';
import type { Advice } from './advisor.js';
import type { NodeWeather } from './standalone-weather.js';

test('node health distinguishes paused, disconnected, current and stale samples', () => {
  assert.equal(deviceHealth(false, 5000, true, 0, 5000).status, 'paused');
  assert.equal(deviceHealth(true, 5000, false, 0, 5000).status, 'offline');
  assert.equal(deviceHealth(true, 5000, true, 0, 5000).status, 'online');
  assert.equal(deviceHealth(true, 5000, true, 0, 15001).status, 'stale');
});

test('irrigation followup requires adjacent baseline and valid post sample', () => {
  const agent = new IrrigationFollowup();
  agent.record(1, 1, undefined, 24);
  agent.record(2, 1, 8, undefined);
  assert.equal(agent.report(2).status, 'waiting');
  agent.record(3, 1, undefined, 26);
  assert.deepEqual(agent.report(3), {
    status: 'compared', hour: 2, requestedMm: 8, before: 24, after: 26, afterHour: 3,
    deltaVwc: 2, deliveredMm: null, source: 'simulated_command_and_vwc',
  });
  agent.record(7, 1, 8, 26);
  assert.equal(agent.report(7).status, 'insufficient');
});

test('irrigation schedule compares weather scenarios and requires suitable soil and weather', () => {
  const sample = new LabEngine(standalonePresets()[0].config, "operations-test").step()[0];
  const advice: Advice = { nodeId: sample.observations.nodeId, action: 'review_irrigation',
    reason: '', sources: [], moisture: 24, threshold: 26.9 };
  const weather: NodeWeather = { status: 'ready', source: 'Open-Meteo', fetchedAt: 0,
    hours: Array.from({ length: 24 }, (_, i) => ({ endAt: (i + 1) * 3600_000,
      rainProbability: 80, rainMm: i === 0 ? 12 : 0, et0Mm: 0.15 })) };
  assert.equal(irrigationSchedule(sample.context, undefined, weather).status, 'soil_unavailable');
  assert.equal(irrigationSchedule(sample.context, advice, { status: 'unavailable' }).status, 'weather_unavailable');
  const report = irrigationSchedule(sample.context, advice, weather);
  assert.equal(report.status, 'ready');
  if (report.status !== 'ready') return;
  assert.equal(report.selected.delayHours, null);
  assert.equal(report.withoutRain.delayHours, 0);
  assert.equal(report.rainSensitive, true);
  assert.equal(report.withoutRain.liters, report.withoutRain.mm * sample.context.areaM2);
});
