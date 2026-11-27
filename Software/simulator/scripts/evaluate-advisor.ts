import fs from 'node:fs';
import path from 'node:path';
import { LabEngine } from '../src/lab/engine.js';
import { LabAdvisor } from '../src/lab/advisor.js';

const directory = path.resolve(__dirname, '../scenarios');
for (const file of fs.readdirSync(directory).filter(x => x.endsWith('.json')).sort()) {
  const preset = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
  const engine = new LabEngine(preset.config, file);
  const advisor = new LabAdvisor();
  const counts: Record<string, number> = {};
  let stressMissed = 0, observableStress = 0, faultFlags = 0, observableFault = 0;
  for (let i = 0; i < 168; i++) for (const { groundTruth, ...sample } of engine.step()) {
    const visible = groundTruth.nodeOnline && groundTruth.gatewayOnline;
    const result = advisor.evaluate(sample.observations.nodeId, visible ? sample : undefined);
    counts[result.action] = (counts[result.action] || 0) + 1;
    if (visible && groundTruth.stress) { observableStress++; if (result.action !== 'review_irrigation') stressMissed++; }
    if (visible && groundTruth.sensorFault) { observableFault++; if (result.action === 'check_sensor') faultFlags++; }
  }
  console.log(JSON.stringify({ scenario: preset.name, steps: 168, counts, observableStress, stressMissed, observableFault, faultFlags }));
}
