import { readFileSync } from 'node:fs';
import { LabEngine } from '../src/lab/engine.js';
import { LabAdvisor } from '../src/lab/advisor.js';
import { evaluateMoisture, type Reading } from '../../backend/src/simulation/moisture-model.js';

const preset = JSON.parse(readFileSync(new URL('../scenarios/sixty-day-history.json', import.meta.url), 'utf8'));
const engine = new LabEngine(preset.config, 'model-evaluation');
const advisor = new LabAdvisor();
const histories = new Map<string, Reading[]>();
for (let hour = 1; hour <= 1440; hour++) {
  for (const { groundTruth, ...sample } of engine.step()) {
    const frame = sample.observations;
    const advice = advisor.evaluate(frame.nodeId, groundTruth.gatewayOnline && groundTruth.nodeOnline ? sample : undefined);
    if (advice.action === 'check_sensor' || advice.moisture === undefined) continue;
    const key = sample.gatewayId + '/' + frame.nodeId;
    const history = histories.get(key) ?? [];
    history.push({ hour, moisture: advice.moisture, temperature: frame.air_temp });
    histories.set(key, history);
  }
}
for (const [node, history] of histories) console.log(JSON.stringify({ node, ...evaluateMoisture(history) }));
