import { readFileSync } from 'node:fs';
import { LabAdvisor } from '../src/lab/advisor.js';
import { LabEngine } from '../src/lab/engine.js';

const preset = JSON.parse(readFileSync(new URL('../scenarios/sixty-day-history.json', import.meta.url), 'utf8'));
const engine = new LabEngine(preset.config, 'history-evaluation');
const advisor = new LabAdvisor();
const pending = new Map<string, { due: number; forecast: number; persistence: number }[]>();
const scores = new Map<string, { count: number; model: number; baseline: number }>();

for (let step = 0; step < 60 * 24; step++) {
  for (const { groundTruth, ...sample } of engine.step()) {
    const { nodeId, timestamp } = sample.observations;
    const visible = groundTruth.nodeOnline && groundTruth.gatewayOnline;
    const result = advisor.evaluate(nodeId, visible ? sample : undefined);
    const forecasts = pending.get(nodeId) ?? [];
    const score = scores.get(sample.gatewayId) ?? { count: 0, model: 0, baseline: 0 };
    if (visible && !groundTruth.sensorFault) {
      for (const item of forecasts.filter(item => item.due === timestamp)) {
        const actual = groundTruth.vwc * 100;
        score.count++;
        score.model += Math.abs(item.forecast - actual);
        score.baseline += Math.abs(item.persistence - actual);
      }
    }
    const future = forecasts.filter(item => item.due > timestamp);
    if (result.forecast && result.moisture !== undefined) {
      future.push({
        due: timestamp + result.forecast.horizonHours * 3600,
        forecast: result.forecast.moisture,
        persistence: result.moisture,
      });
    }
    pending.set(nodeId, future);
    scores.set(sample.gatewayId, score);
  }
}
for (const [garden, score] of scores) {
  console.log(JSON.stringify({
    garden, evaluated: score.count,
    regressionMAE: score.model / score.count,
    persistenceMAE: score.baseline / score.count,
  }));
}
