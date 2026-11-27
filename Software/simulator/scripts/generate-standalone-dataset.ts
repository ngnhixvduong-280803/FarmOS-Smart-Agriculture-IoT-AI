import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { assumptions, crops, soils, sources, standalonePresets, type ScenarioEvent } from '../src/lab/catalog.js';
import { LabEngine } from '../src/lab/engine.js';
import { standaloneTelemetry } from '../src/lab/standalone-telemetry.js';

const output = process.argv[2];
if (!output) throw new Error('Usage: tsx scripts/generate-standalone-dataset.ts <new-output-directory>');
mkdirSync(output);
const observations = openSync(path.join(output, 'observations.jsonl'), 'wx');
const labels = openSync(path.join(output, 'labels.jsonl'), 'wx');
const cropInstances = [
  ['NORMAL', 'mustard-greens'],
  ['DRY', 'chilli'],
  ['FAULT', 'tomato'],
] as const;
const families = ['normal', 'dry', 'heavy-rain', 'sensor-stuck', 'sensor-bias', 'offline', 'irrigation', 'no-flow'];
const hours = 336;
const runs = [];
for (const [cropIndex, [instance, cropId]] of cropInstances.entries()) {
  const nodeId = 'SIM_NODE_' + instance;
  const presets = standalonePresets({ id: nodeId, gatewayId: nodeId, zoneId: 'SIM_ZONE_' + instance }, cropId);
  for (const [familyIndex, family] of families.entries()) {
    for (let variant = 0; variant < 12; variant++) {
      const split = variant < 8 ? 'train' : variant < 10 ? 'validation' : 'test';
      const config = structuredClone(presets[familyIndex < 6 ? familyIndex : 1].config);
      config.seed = 20261125 + cropIndex * 1000 + familyIndex * 20 + variant;
      config.startAt = new Date(Date.UTC(2025, 0, 1 + familyIndex * 17 + variant, variant * 3 % 24)).toISOString();
      const node = config.nodes[0];
      const soil = soils.find(item => item.id === node.soilId)!;
      node.initialVwc = Math.min(soil.saturation, Math.max(soil.wp, node.initialVwc + (variant - 5.5) * 0.002));
      node.ageDays += variant;
      config.weather.et0MmDay = 2.9 + ((variant * 7 + familyIndex * 3) % 13) * 0.25;
      config.weather.meanC += (variant % 5) - 2;
      const event = (kind: ScenarioEvent['kind'], id: string, atHour: number, durationHours: number, value: number): ScenarioEvent =>
        ({ kind, id, atHour, durationHours, value, nodeId });
      for (const item of config.events) {
        item.atHour = 28 + ((variant * 17) % 49);
        if (item.kind === 'rain') item.value = 18 + (variant % 6) * 5;
        if (item.kind === 'sensor_bias') item.value = -(5 + (variant % 7));
      }
      const rainfall = family === 'dry' ? [] : [
        event('rain', 'rain-background-1', 103 + (variant * 13) % 39, 4, 4 + variant % 6),
        event('rain', 'rain-background-2', 216 + (variant * 11) % 45, 3, 8 + variant % 9),
      ];
      const command = familyIndex >= 6 ? event('irrigation', 'irrigation-command', 40 + variant * 3, 1, 6 + variant % 7) : undefined;
      if (command) {
        config.events.push(command);
        if (family === 'no-flow') config.events.push(event('no_flow', 'blocked-flow', command.atHour, 1, 0));
      }
      config.events.push(...rainfall);
      const runId = [cropId, family, variant].join('-');
      const engine = new LabEngine(config, runId);
      runs.push({runId, split, family, config});
      const inputs: string[] = [];
      const targets: string[] = [];
      for (let hour = 1; hour <= hours; hour++) {
        const [sample] = engine.step();
        const packet = standaloneTelemetry(sample)?.payload ?? null;
        const key = {runId, nodeId, sequence: sample.sequence, simulatedAt: sample.simulatedAt};
        inputs.push(JSON.stringify({
          ...key,
          cropId, soilId: node.soilId, ageDays: sample.context.ageDays, et0MmDay: sample.context.et0MmDay,
          areaM2: node.areaM2, ph: node.ph, eceDsM: node.ec, organicPct: node.organicPct,
          soilMoistureVwc: packet ? sample.observations.soil_moisture : null,
          soilTemperatureC: packet?.soil_temp ?? null, airTemperatureC: packet?.air_temp ?? null,
          airHumidityPct: packet?.air_humidity ?? null, quality: packet?.quality ?? null,
          irrigationCommandMm: command?.atHour === hour - 1 ? command.value : 0,
        }));
        targets.push(JSON.stringify({...key, ...sample.groundTruth, soilMoistureVwc: sample.groundTruth.vwc * 100,
          noFlow: Boolean(command && family === 'no-flow' && command.atHour === hour - 1)}));
      }
      writeSync(observations, inputs.join('\n') + '\n');
      writeSync(labels, targets.join('\n') + '\n');
    }
  }
}
closeSync(observations);
closeSync(labels);
writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({
  sourceType: 'synthetic', modelVersion: 'bucket-v1', stepMinutes: 60, hoursPerRun: hours,
  joinKey: ['runId', 'nodeId', 'sequence'], crops, soils, sources, assumptions, runs,
}, null, 2));
