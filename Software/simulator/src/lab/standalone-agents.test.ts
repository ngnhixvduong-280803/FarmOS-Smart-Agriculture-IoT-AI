import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Advice } from './advisor.js';
import { standalonePresets } from './catalog.js';
import { LabEngine } from './engine.js';
import { evaluateStandaloneAgents } from './standalone-agents.js';
import { standaloneTelemetry } from './standalone-telemetry.js';
import { parseWeatherForecast, StandaloneWeather, type NodeWeather } from './standalone-weather.js';

const sample = new LabEngine(standalonePresets()[0].config, '12345678-test').step()[0];
const advice: Advice = {
  nodeId: sample.observations.nodeId, action: 'review_irrigation',
  reason: '', sources: [], moisture: 28, threshold: 27,
};
const rain: NodeWeather = {
  status: 'ready', source: 'Open-Meteo', fetchedAt: 0,
  hours: Array.from({ length: 24 }, (_, index) => ({
    endAt: (index + 1) * 3600_000, rainMm: index === 1 ? 3 : 0, rainProbability: 75, et0Mm: 0.1,
  })),
};

test('rain only changes an early drying recommendation when soil is still above threshold', () => {
  const reading = standaloneTelemetry(sample);
  const wetForecast = evaluateStandaloneAgents(reading, advice, rain);
  assert.equal(wetForecast.irrigation.action, 'consider_waiting_for_rain');
  assert.equal(wetForecast.weather.status === 'ready' && wetForecast.weather.rainMm24h, 3);
  assert.ok(wetForecast.ambient);
  assert.equal(evaluateStandaloneAgents(reading, { ...advice, moisture: 26 }, rain).irrigation.action, 'inspect_dry_soil');
  assert.equal(evaluateStandaloneAgents(reading, advice, { status: 'unavailable' }).irrigation.action, 'monitor_drying');
});

test('missing, suspect, detached and anomalous soil input hold advice regardless of rain', () => {
  const readings = [
    null,
    standaloneTelemetry(sample, { calibration: 'bench' }),
    standaloneTelemetry(sample, { calibration: 'none' }),
    standaloneTelemetry(sample, { adc: 640 }),
  ];
  for (const reading of readings) {
    const result = evaluateStandaloneAgents(reading, advice, rain);
    assert.equal(result.irrigation.action, 'hold');
    assert.equal(result.moisture.forecast, null);
  }
  assert.equal(evaluateStandaloneAgents(standaloneTelemetry(sample), { ...advice, action: 'check_sensor' }, rain).irrigation.action, 'hold');
});

function providerData(now: number) {
  return { hourly: {
    time: Array.from({ length: 168 }, (_, index) => Math.ceil(now / 3600_000) * 3600 + (index + 1) * 3600),
    precipitation: Array(168).fill(0), precipitation_probability: Array(168).fill(40),
    et0_fao_evapotranspiration: Array(168).fill(0.1),
  } };
}

test('weather requires 24 contiguous hours with valid numbers', () => {
  const now = 3600_000 + 100;
  const data = providerData(now);
  assert.equal(parseWeatherForecast(data, now).length, 24);
  data.hourly.precipitation[10] = null;
  assert.throws(() => parseWeatherForecast(data, now));
});

test('weather coalesces concurrent requests and caches success and failure', async () => {
  let calls = 0;
  const provider: typeof fetch = async () => {
    calls++;
    return calls === 1 ? Response.json(providerData(Date.now())) : new Response(null, { status: 503 });
  };
  const client = new StandaloneWeather(provider);
  const site = { latitude: 10.78, longitude: 106.69 };
  assert.equal((await client.read()).status, 'unconfigured');
  const results = await Promise.all([client.read(site), client.read(site)]);
  assert.deepEqual(results.map(result => result.status), ['ready', 'ready']);
  assert.equal((await client.read(site)).status, 'ready');
  assert.equal(calls, 1);
  const other = { ...site, latitude: 11 };
  assert.equal((await client.read(other)).status, 'unavailable');
  assert.equal((await client.read(other)).status, 'unavailable');
  assert.equal(calls, 2);
});
