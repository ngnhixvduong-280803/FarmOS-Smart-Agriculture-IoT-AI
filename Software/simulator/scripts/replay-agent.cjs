const { readFileSync, writeFileSync, existsSync, renameSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { LabEngine } = require('./engine');
const { sources, crops, soils } = require('./catalog');

async function main() {
  const garden = process.argv[2];
  const config = JSON.parse(readFileSync('/replay/' + garden + '.json', 'utf8'));
  const key = '/state/progress.json';
  const progress = existsSync(key) ? JSON.parse(readFileSync(key, 'utf8')) : { runId: randomUUID(), hour: 0 };
  const save = () => {
    writeFileSync(key + '.tmp', JSON.stringify(progress));
    renameSync(key + '.tmp', key);
  };
  progress.autoStart ??= Math.max(1441, progress.hour + 2);
  save();
  const engine = new LabEngine(config, progress.runId);
  const tokens = JSON.parse(process.env.FARMOS_LAB_GATEWAY_TOKENS);
  const manifest = { runId: progress.runId, sourceType: 'synthetic', modelVersion: 'bucket-v1', config, sources };
  let batch = [];
  const send = async hour => {
    if (batch.length) {
      const body = JSON.stringify({ manifest, samples: batch });
      for (;;) {
        const gateway = config.nodes[0].gatewayId;
        const response = await fetch('http://backend:3000/api/v1/simulation/replay', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), body,
          headers: { 'Content-Type': 'application/json', 'x-farmos-device-id': gateway, 'x-farmos-device-token': tokens[gateway] },
        });
        if (response.status === 429 || response.status >= 500) {
          await response.body?.cancel();
          await delay(response.status === 429 ? 60000 : 2000);
          continue;
        }
        if (!response.ok || !(await response.json()).data?.persisted) throw new Error('Replay rejected: HTTP ' + response.status);
        break;
      }
      batch = [];
    }
    progress.hour = hour;
    save();
  };
  const node = config.nodes[0];
  const crop = crops.find(item => item.id === node.cropId);
  const soil = soils.find(item => item.id === node.soilId);
  const threshold = soil.fc - crop.depletionP * (soil.fc - soil.wp);
  let previous;
  let lastIrrigation = -Infinity;
  let failedResponse = false;
  for (let hour = 1; ; hour++) {
    if (hour > progress.hour && hour > 1440) await delay(10_000);
    const demo = hour === progress.autoStart;
    const demoAge = hour - progress.autoStart;
    if (demoAge === -1) {
      // Inject a controlled starting moisture into the virtual soil only.
      engine.state[0].vwc = garden === 'B' ? soil.fc - 0.005 : threshold - 0.01;
    }
    if (garden === 'C' && demoAge >= 1 && demoAge <= 6) {
      engine.state[0].vwc = Math.max(soil.wp, engine.state[0].vwc - 0.005);
    }
    const eligible = hour >= progress.autoStart && previous && previous.quality === 1 &&
      !failedResponse && (demo || (previous.soil_moisture / 100 < threshold && hour - lastIrrigation >= 24));
    const dose = eligible ? Math.min(12, Math.max(4, Math.ceil((threshold + 0.01 - previous.soil_moisture / 100) * crop.rootM * 1000 / 0.9))) : 0;
    if (dose) {
      lastIrrigation = hour;
      const event = { id: 'auto-' + hour, nodeId: node.id, atHour: engine.hour, durationHours: 1 };
      engine.config.events.push({ ...event, kind: 'irrigation', value: dose });
      if (demo && garden === 'A') engine.config.events.push({ ...event, id: 'fault-' + hour, kind: 'no_flow', value: 0 });
      if (demo && garden === 'B') engine.config.events.push({ ...event, id: 'rain-demo-' + hour, kind: 'rain', value: 45 });
    }
    const samples = engine.step();
    const current = samples[0];
    if (dose && current.groundTruth.nodeOnline && current.groundTruth.gatewayOnline) {
      current.context.autoIrrigationMm = dose;
      // Compare true consecutive observed frames, including the run's pre-demo sample.
      failedResponse = current.observations.soil_moisture - previous.soil_moisture < 0.15;
    }
    previous = current.groundTruth.nodeOnline && current.groundTruth.gatewayOnline ? current.observations : undefined;
    if (hour <= progress.hour) continue;
    batch.push(...samples.filter(sample => sample.groundTruth.nodeOnline && sample.groundTruth.gatewayOnline));
    if (batch.length >= 24 || hour >= 1440) await send(hour);
    if (hour % 24 === 0) console.log('Ngày mô phỏng đã gửi:', hour / 24);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
