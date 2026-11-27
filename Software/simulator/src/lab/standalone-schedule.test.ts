import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LabEngine } from './engine.js';
import { standalonePresets } from './catalog.js';
import { scheduleSlots, StandaloneSchedule } from './standalone-schedule.js';
import type { Advice } from './advisor.js';
import type { NodeWeather } from './standalone-weather.js';

const hour = 3600_000;
const morning = Date.parse('2026-11-20T06:00:00+07:00');
const sample = new LabEngine(standalonePresets()[0].config, 'schedule-test').step()[0];
const advice: Advice = {
  nodeId: sample.observations.nodeId, action: 'observe', reason: '', sources: [], moisture: 32, threshold: 26.9,
};
function weather(now: number, rain = 0): NodeWeather {
  return { status: 'ready', source: 'Open-Meteo', fetchedAt: now,
    hours: Array.from({ length: 168 }, (_, index) => ({
      endAt: now + (index + 1) * hour, rainMm: rain, rainProbability: rain ? 80 : 20, et0Mm: 0.12,
    })),
  };
}
const input = (now: number, moisture = 32, rain = 0) => ({
  sampleId: String(now), context: sample.context, advice: { ...advice, moisture }, weather: weather(now, rain),
});

test('rolling week recalculates at 06:00 Vietnam time, not at midnight or on hourly checks', () => {
  assert.equal(scheduleSlots(morning - 1).daily, morning - 24 * hour);
  assert.equal(scheduleSlots(morning).daily, morning);
  const scheduler = new StandaloneSchedule();
  const before = scheduler.tick(morning - hour, input(morning - hour));
  const at = scheduler.tick(morning, input(morning));
  assert.notEqual(at?.weekly?.slotAt, before?.weekly?.slotAt);
  assert.equal(at?.weekly?.calculatedAt, morning);
  assert.equal(scheduler.tick(morning + 5000, input(morning)), undefined);
  const after = scheduler.tick(morning + hour, input(morning + hour));
  assert.equal(after?.weekly, at?.weekly);
  assert.equal(at?.weekly?.forecast.status, 'ready');
  if (at?.weekly?.forecast.status !== 'ready') return;
  assert.equal(at.weekly.forecast.days.length, 7);
  assert.equal(at.weekly.forecast.days[6].endsAt - at.weekly.forecast.days[0].startsAt, 168 * hour);
  assert.equal(at.weekly.forecast.trajectory.length, 169);
  const crossing = at.weekly.forecast.firstBelowWithoutRain;
  const point = at.weekly.forecast.trajectory.find(point => point.at === crossing);
  assert.ok(point && point.withoutRain <= at.weekly.forecast.threshold);
});

test('hourly check keeps the 24 hour plan until soil, weather or input availability changes', () => {
  const scheduler = new StandaloneSchedule();
  const first = scheduler.tick(morning, input(morning));
  const quiet = scheduler.tick(morning + hour, input(morning + hour, 31.6));
  assert.equal(quiet?.lastCheck?.updated, false);
  assert.equal(quiet?.plan24h, first?.plan24h);
  const dry = scheduler.tick(morning + 2 * hour, input(morning + 2 * hour, 30.9));
  assert.equal(dry?.lastCheck?.reason, 'soil_changed');
  const wet = scheduler.tick(morning + 3 * hour, input(morning + 3 * hour, 30.9, 0.25));
  assert.equal(wet?.lastCheck?.reason, 'weather_changed');
  scheduler.requestPlanUpdate();
  const event = scheduler.tick(morning + 3 * hour + 1000, input(morning + 3 * hour, 30.9, 0.25));
  assert.equal(event?.lastCheck?.reason, 'input_event');
  const offline = scheduler.tick(morning + 4 * hour, { ...input(morning + 4 * hour), advice: undefined });
  assert.equal(offline?.lastCheck?.reason, 'input_availability');
  assert.equal(offline?.plan24h?.result.status, 'soil_unavailable');
});

test('accelerated sensor readings request a fresh plan immediately on meaningful change', () => {
  const scheduler = new StandaloneSchedule();
  scheduler.tick(morning, input(morning));
  scheduler.observe({ ...advice, moisture: 30.9 });
  assert.equal(scheduler.due(morning + 5000), true);
  const updated = scheduler.tick(morning + 5000, input(morning + 5000, 30.9));
  assert.equal(updated?.plan24h?.result.status, 'ready');
  assert.equal(updated?.lastCheck?.updated, true);
  assert.equal(updated?.weekly?.forecast.status, 'ready');
  if (updated?.weekly?.forecast.status !== 'ready') return;
  assert.equal(updated.weekly.forecast.trajectory[0].withRain, 30.9);
  assert.equal(updated.weekly.sampleId, String(morning + 5000));
  scheduler.observe(undefined);
  const offline = scheduler.tick(morning + 6000, { ...input(morning + 6000), advice: undefined });
  assert.equal(offline?.plan24h?.result.status, 'soil_unavailable');
  assert.equal(offline?.weekly?.forecast.status, 'soil_unavailable');
});
