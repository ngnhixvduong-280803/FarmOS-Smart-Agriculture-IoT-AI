import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LabAdvisor } from './advisor.js';
import { LabEngine } from './engine.js';
import { defaultConfig } from './catalog.js';

test('advisor uses observations and detects dry, missing and stuck readings', () => {
  const cfg = defaultConfig(); cfg.nodes = [cfg.nodes[0]]; cfg.nodes[0].initialVwc = 0.20; cfg.events = [];
  const engine = new LabEngine(cfg, 'test');
  const advisor = new LabAdvisor();
  const { groundTruth, ...sample } = engine.step()[0];
  assert.equal(advisor.evaluate(sample.observations.nodeId, sample).action, 'review_irrigation');
  assert.equal(advisor.evaluate(sample.observations.nodeId).action, 'no_data');
  for (let i = 0; i < 4; i++) advisor.evaluate(sample.observations.nodeId, { ...sample, observations: { ...sample.observations, timestamp: sample.observations.timestamp + i * 3600 } });
  assert.equal(advisor.evaluate(sample.observations.nodeId, { ...sample, observations: { ...sample.observations, timestamp: sample.observations.timestamp + 14400 } }).action, 'check_sensor');
  assert.equal(groundTruth.nodeOnline, true);
});

test('sudden moisture drop holds advice without calling it a diagnosis; normal watering is allowed', () => {
  const cfg = defaultConfig(); cfg.nodes = [cfg.nodes[0]]; cfg.events = [];
  const engine = new LabEngine(cfg, 'quality');
  const advisor = new LabAdvisor();
  const first = engine.step()[0];
  const { groundTruth: _firstTruth, ...initial } = first;
  advisor.evaluate(initial.observations.nodeId, initial);
  const second = engine.step()[0];
  const { groundTruth: _secondTruth, ...next } = second;
  const dropped = { ...next, observations: { ...next.observations, soil_moisture: initial.observations.soil_moisture - 12 } };
  assert.equal(advisor.evaluate(next.observations.nodeId, dropped).action, 'check_sensor');
  assert.equal(advisor.evaluate(next.observations.nodeId, { ...next, observations: { ...next.observations, timestamp: next.observations.timestamp + 3600, soil_moisture: dropped.observations.soil_moisture - 0.1 } }).action, 'check_sensor');
  const watering = new LabAdvisor();
  watering.evaluate(initial.observations.nodeId, initial);
  assert.equal(watering.evaluate(next.observations.nodeId, { ...next, observations: { ...next.observations, soil_moisture: initial.observations.soil_moisture + 8 } }).action, 'observe');
});

test('unchanged readings separated by long gaps do not imply a stuck sensor', () => {
  const engine = new LabEngine(defaultConfig(), 'gaps');
  const { groundTruth: _truth, ...sample } = engine.step()[0];
  const advisor = new LabAdvisor();
  let result;
  for (let i = 0; i < 5; i++) result = advisor.evaluate(sample.observations.nodeId, { ...sample, observations: { ...sample.observations, timestamp: sample.observations.timestamp + i * 7200 } });
  assert.notEqual(result?.action, 'check_sensor');
});
