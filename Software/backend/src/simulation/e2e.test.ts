import type { Prisma } from '@prisma/client';
import { compactSimulationSamples } from './retention';
// Run only against a disposable local Docker PostgreSQL, never a configured cloud DB.
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { prisma } from '../database/prisma';
import { env } from '../config/env';
import simulationRoutes from '../api/routes/simulation.routes';
import nodeRoutes from '../api/routes/node.routes';
const { defaultConfig, sources } = require('../../../simulator/dist/lab/catalog.js');
const { LabEngine } = require('../../../simulator/dist/lab/engine.js');
const { CloudOutbox } = require('../../../simulator/dist/lab/cloud.js');
test('real PostgreSQL: provision → authenticated gateway → persisted dataset → tenant-scoped agent read', async () => {
  const url = new URL(env.DATABASE_URL);
  assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.port, '55439'); assert.equal(url.pathname, '/farmos_lab_test');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'farmos-lab-e2e-'));
  const email = 'simulation-e2e@farmos.invalid';
  const owner = await prisma.user.upsert({ where: { email }, create: { email, password: 'not-a-login-hash', role: 'USER' }, update: {} });
  const outsider = await prisma.user.upsert({ where: { email: 'simulation-outsider@farmos.invalid' }, create: { email: 'simulation-outsider@farmos.invalid', password: 'not-a-login-hash', role: 'USER' }, update: {} });
  const app = express(); app.use(express.json({ limit: '64kb' })); app.use('/api/v1/simulation', simulationRoutes); app.use('/api/v1/nodes', nodeRoutes);
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const credentialFile = path.join(temp, '.env.lab');
  try {
    const result = spawnSync(process.execPath, ['dist/simulation/provision.cli.js', '--farm', 'SIM_E2E_LAB', '--owner-email', email, '--output', credentialFile, '--api', origin], { cwd: path.resolve(__dirname, '../..'), env: process.env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const creds = JSON.parse(fs.readFileSync(credentialFile, 'utf8').split('\n').find(l => l.startsWith('FARMOS_LAB_GATEWAY_TOKENS='))!.split('=').slice(1).join('='));
    const headers = { 'Content-Type': 'application/json', 'x-farmos-device-id': 'SIM_GATEWAY_01', 'x-farmos-device-token': creds.SIM_GATEWAY_01 };
    const config = defaultConfig(); const runId = '837cba93-248c-43d4-a6ab-36f9c6b57c20';
    const engine = new LabEngine(config, runId); const sample = engine.step()[0];
    const envelope = { manifest: { runId, sourceType: 'synthetic', modelVersion: 'bucket-v1', config, sources }, sample };
    const ingest = (body: unknown, h = headers) => fetch(origin + '/api/v1/simulation/ingest', { method: 'POST', headers: h, body: JSON.stringify(body) });
    assert.equal((await ingest(envelope, { ...headers, 'x-farmos-device-token': 'wrong' })).status, 401);
    const accepted = await ingest(envelope); assert.equal(accepted.status, 200); const ack: any = await accepted.json(); assert.equal(ack.data.persisted, true);
    const presenceBeforeReplay = (await prisma.node.findUniqueOrThrow({ where: { id: sample.observations.nodeId } })).last_seen;
    const replay: any = await (await ingest(envelope)).json(); assert.equal(replay.data.duplicate, true);
    assert.equal(await prisma.simulationSample.count({ where: { run_id: runId } }), 1);
    assert.equal(await prisma.telemetryData.count({ where: { farm_id: 'SIM_E2E_LAB' } }), 0);
    assert.equal(await prisma.alert.count({ where: { farm_id: 'SIM_E2E_LAB' } }), 0);
    const bearer = (user: typeof owner) => ({ Authorization: 'Bearer ' + jwt.sign({ id: user.id, email: user.email, role: 'USER' }, env.JWT_SECRET, { issuer: env.JWT_ISSUER, audience: env.MOBILE_JWT_AUDIENCE, expiresIn: '1h' }) });
    const batch = (samples: unknown[], auth = headers) => fetch(origin + '/api/v1/simulation/replay', {
      method: 'POST', headers: auth, body: JSON.stringify({ manifest: envelope.manifest, samples }),
    });
    assert.equal((await batch([sample], { ...headers, 'x-farmos-device-token': 'wrong' })).status, 401);
    assert.equal((await batch([{ ...sample, gatewayId: 'SIM_FOREIGN' }])).status, 400);
    const replayResponse = await batch([sample]);
    assert.equal(replayResponse.status, 200);
    assert.equal((await replayResponse.json() as any).data.count, 0);
    const memberAnalysis = origin + '/api/v1/simulation/farm-analysis?farmId=SIM_E2E_LAB';
    assert.equal((await fetch(memberAnalysis)).status, 401);
    assert.equal((await fetch(memberAnalysis, { headers: bearer(outsider) })).status, 403);
    const ownAnalysis: any = await (await fetch(memberAnalysis, { headers: bearer(owner) })).json();
    assert.equal(ownAnalysis.sourceType, 'synthetic');
    assert.equal(ownAnalysis.data.id, 'SIM_E2E_LAB');
    assert.equal(ownAnalysis.data.nodes[0].moisture, sample.observations.soil_moisture);
    assert.equal(JSON.stringify(ownAnalysis).includes('ground_truth'), false);
    const analysisPath = origin + '/api/v1/simulation/analysis';
    assert.equal((await fetch(analysisPath)).status, 401);
    assert.equal((await fetch(analysisPath, { headers: bearer(owner) })).status, 403);
    const admin = await prisma.user.create({ data: { email: 'simulation-admin@farmos.invalid', password: 'test-only', role: 'ADMIN' } });
    const analysisResponse = await fetch(analysisPath, { headers: bearer(admin) });
    assert.equal(analysisResponse.status, 200);
    const analysis: any = await analysisResponse.json();
    assert.equal(analysis.data[0].nodes[0].moisture, sample.observations.soil_moisture);
    assert.equal(analysis.data[0].nodes[0].models, undefined);
    await prisma.simulationSample.update({
      where: { id: ack.data.sampleId }, data: { received_at: new Date(Date.now() - 16 * 60_000) },
    });
    // Let the shared analysis cache expire after the direct database change.
    await new Promise(resolve => setTimeout(resolve, 5100));
    const stale: any = await (await fetch(analysisPath, { headers: bearer(admin) })).json();
    assert.match(stale.data[0].nodes[0].recommendation, /Tạm giữ đề xuất tưới/);
    assert.equal(stale.data[0].nodes[0].models, undefined);
    const readPath = origin + `/api/v1/simulation/runs/${runId}/samples?farmId=SIM_E2E_LAB`;
    assert.equal((await fetch(readPath)).status, 401);
    assert.equal((await fetch(readPath, { headers: bearer(outsider) })).status, 403);
    const read: any = await (await fetch(readPath, { headers: bearer(owner) })).json();
    const deviceResponse: any = await (await fetch(origin + '/api/v1/nodes', { headers: bearer(owner) })).json();
    const device = deviceResponse.data.find((n: any) => n.id === sample.observations.nodeId);
    assert.ok(device.is_simulation); assert.equal(device.online, true);
    assert.equal(device.latest_telemetry.soil_moisture, sample.observations.soil_moisture);
    assert.equal(device.simulation.sample_id, ack.data.sampleId);
    assert.equal(device.simulation.context.cropId, 'mustard-greens');
    assert.equal(device.simulation.ground_truth, undefined);
    assert.equal(new Date(device.last_seen).getTime(), presenceBeforeReplay!.getTime());
    await prisma.node.update({ where: { id: device.id }, data: { last_seen: new Date('2000-01-01T00:00:00Z') } });
    await ingest(envelope);
    const afterStaleReplay: any = await (await fetch(origin + '/api/v1/nodes', { headers: bearer(owner) })).json();
    assert.equal(afterStaleReplay.data.find((n: any) => n.id === device.id).online, false);
    const gateway = deviceResponse.data.find((n: any) => n.id === sample.gatewayId);
    assert.equal(gateway.online, true); assert.equal(gateway.latest_telemetry, null);
    assert.equal(gateway.simulation.source_node_id, device.id);
    const outsiderDevices: any = await (await fetch(origin + '/api/v1/nodes', { headers: bearer(outsider) })).json();
    assert.equal(outsiderDevices.data.length, 0);
    assert.equal(read.data.length, 1); assert.equal(read.data[0].id, ack.data.sampleId);
    assert.ok(read.data[0].provenance.sources.length > 0); assert.equal(read.data[0].ground_truth, undefined); assert.equal(read.data[0].manifest, undefined);
    const labels: any = await (await fetch(readPath + '&includeLabels=1', { headers: bearer(owner) })).json(); assert.ok(labels.data[0].ground_truth); assert.ok(labels.data[0].manifest.sources.length > 0);
    const outbox = new CloudOutbox(path.join(temp, 'outbox.json'), origin, creds); outbox.enqueue(envelope); outbox.enable(true); await outbox.flush(); assert.equal(outbox.queue.length, 0); assert.equal(outbox.status.duplicates, 1);
    const standaloneNodeId = 'SIM_DIRECT_01';
    const standaloneFarmId = 'SIM_E2E_DIRECT';
    const standaloneTopology = path.join(temp, 'standalone.json');
    const standaloneCredentials = path.join(temp, '.env.direct');
    const standaloneNode = { ...config.nodes[0], id: standaloneNodeId, gatewayId: standaloneNodeId, zoneId: 'SIM_DIRECT_ZONE' };
    fs.writeFileSync(standaloneTopology, JSON.stringify({ nodes: [{ id: standaloneNodeId, zoneId: standaloneNode.zoneId, cropId: standaloneNode.cropId }] }));
    const directProvision = spawnSync(process.execPath, [
      'dist/simulation/provision.cli.js', '--standalone', '--topology', standaloneTopology,
      '--farm', standaloneFarmId, '--owner-email', email, '--output', standaloneCredentials, '--api', origin,
    ], { cwd: path.resolve(__dirname, '../..'), env: process.env, encoding: 'utf8' });
    assert.equal(directProvision.status, 0, directProvision.stderr);
    assert.equal(await prisma.node.count({ where: { farm_id: standaloneFarmId, type: 'GATEWAY' } }), 0);
    assert.equal(await prisma.nodeGatewayBinding.count({ where: { farm_id: standaloneFarmId } }), 0);
    const directTokens = JSON.parse(fs.readFileSync(standaloneCredentials, 'utf8').split('\n')
      .find(line => line.startsWith('FARMOS_LAB_GATEWAY_TOKENS='))!.slice('FARMOS_LAB_GATEWAY_TOKENS='.length));
    const directHeaders = { ...headers, 'x-farmos-device-id': standaloneNodeId, 'x-farmos-device-token': directTokens[standaloneNodeId] };
    const directConfig = { ...config, nodes: [standaloneNode], events: [] };
    const directEngine = new LabEngine(directConfig, randomUUID());
    const directSample = directEngine.step()[0];
    const directManifest = { ...envelope.manifest, runId: directSample.runId, config: directConfig };
    assert.equal((await ingest({ manifest: directManifest, sample: directSample }, directHeaders)).status, 200);
    const replayDirect = await fetch(origin + '/api/v1/simulation/replay', {
      method: 'POST', headers: directHeaders, body: JSON.stringify({ manifest: directManifest, samples: directEngine.step() }),
    });
    assert.equal(replayDirect.status, 200);
    assert.equal(await prisma.simulationSample.count({ where: { farm_id: standaloneFarmId, node_id: standaloneNodeId, gateway_id: standaloneNodeId } }), 2);

    // Exercise the actual Lab HTTP server and its persistent outbox through the
    // same ingest and farm-analysis endpoints used by the FarmOS report.
    const labPort = 55440;
    const lab = spawn(process.execPath, [path.resolve(__dirname, '../../../simulator/dist/lab/server.js')], {
      env: { ...process.env, FARMOS_LAB_PORT: String(labPort), FARMOS_LAB_DATA_DIR: path.join(temp, 'lab'),
        FARMOS_LAB_API_URL: origin, FARMOS_LAB_GATEWAY_TOKENS: JSON.stringify(creds), DEEPSEEK_API_KEY: '' },
      stdio: 'ignore',
    });
    const labOrigin = `http://127.0.0.1:${labPort}`;
    const pause = () => new Promise(resolve => setTimeout(resolve, 250));
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) { try { if (await predicate()) return; } catch {} await pause(); }
      throw new Error('Timed out waiting for Lab or persisted analysis');
    };
    const postLab = async (route: string, body: unknown) => {
      const response = await fetch(labOrigin + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<any>;
    };
    try {
      await waitFor(async () => (await fetch(labOrigin + '/api/state')).ok);
      const labConfig = defaultConfig(); labConfig.events = []; labConfig.nodes[0].initialVwc = 0.25;
      const created = await postLab('/api/reset', labConfig);
      await postLab('/api/cloud', { enabled: true });
      await postLab('/api/step', { count: 1 });
      await postLab('/api/actions/irrigate', { nodeId: 'SIM_NODE_01', mm: 10 });
      const watered = await postLab('/api/step', { count: 1 });
      assert.equal(watered.advice.find((a: any) => a.nodeId === 'SIM_NODE_01').action, 'observe');
      await waitFor(async () => await prisma.simulationSample.count({ where: { run_id: created.runId } }) === 6);
      let node: any;
      const readNode = async () => {
        const report: any = await (await fetch(memberAnalysis, { headers: bearer(owner) })).json();
        node = report.data.nodes.find((n: any) => n.nodeId === 'SIM_NODE_01');
      };
      await waitFor(async () => { await readNode(); return node?.irrigationResponse?.mm === 10; });
      assert.equal(node.irrigationResponse.mm, 10);
      assert.equal(node.irrigationResponse.status, 'responded');
      const value = watered.latest.find((s: any) => s.observations.nodeId === 'SIM_NODE_01').observations.soil_moisture;
      const fault = await postLab('/api/test-reading', { nodeId: 'SIM_NODE_01', values: { soil_moisture: value - 12 } });
      assert.equal(fault.advice.find((a: any) => a.nodeId === 'SIM_NODE_01').action, 'check_sensor');
      await waitFor(async () => await prisma.simulationSample.count({ where: { run_id: created.runId } }) === 9);
      await waitFor(async () => { await readNode(); return node?.usable === false; });
      assert.equal(node.usable, false);
      assert.match(node.qualityReason, /giảm đột ngột/);
      assert.match(node.recommendation, /Tạm giữ/);
      assert.equal(node.irrigationPlan, undefined);
      const noFlowConfig = defaultConfig(); noFlowConfig.nodes[0].initialVwc = 0.25;
      noFlowConfig.events = [{ id: 'no_flow_test', kind: 'no_flow', nodeId: 'SIM_NODE_01', atHour: 1, durationHours: 1, value: 0 }];
      const noFlowRun = await postLab('/api/reset', noFlowConfig);
      await postLab('/api/step', { count: 1 });
      await postLab('/api/actions/irrigate', { nodeId: 'SIM_NODE_01', mm: 10 });
      await postLab('/api/step', { count: 1 });
      await waitFor(async () => await prisma.simulationSample.count({ where: { run_id: noFlowRun.runId } }) === 6);
      await waitFor(async () => { await readNode(); return node?.irrigationResponse?.status === 'no_response'; });
      assert.equal(node.irrigationResponse.status, 'no_response');

      const day = 24 * 3600_000;
      const now = new Date();
      const archived = await prisma.simulationSample.findFirstOrThrow({ where: { run_id: noFlowRun.runId } });
      const { id, event_id, ...fixture } = archived;
      const good = { ...fixture, manifest: fixture.manifest as Prisma.InputJsonValue, context: fixture.context as Prisma.InputJsonValue, ground_truth: fixture.ground_truth as Prisma.InputJsonValue, observations: { quality: 1, soil_moisture: 20 } };
      await prisma.simulationSample.createMany({ data: [
        { ...good, id: id + '-a', event_id: event_id + '-a', received_at: new Date(+now - 2 * day) },
        { ...good, id: id + '-expired', event_id: event_id + '-expired', received_at: new Date(+now - 31 * day) },
      ] });
      assert.equal(await compactSimulationSamples(now), 2);
      await prisma.simulationSample.create({ data: {
        ...good, id: id + '-b', event_id: event_id + '-b', received_at: new Date(+now - 2 * day), simulated_at: new Date(+good.simulated_at + 12 * 3600_000),
        observations: { quality: 1, soil_moisture: 30 },
      } });
      assert.equal(await compactSimulationSamples(now), 1);
      assert.equal(await compactSimulationSamples(now), 0);
      const archivedPath = origin + '/api/v1/simulation/runs/' + noFlowRun.runId +
        '/hourly?farmId=SIM_E2E_LAB&nodeId=' + archived.node_id;
      assert.equal((await fetch(archivedPath, { headers: bearer(outsider) })).status, 403);
      const archive: any = await (await fetch(archivedPath, { headers: bearer(owner) })).json();
      assert.equal(archive.data.hours.length, 1);
      assert.equal(archive.data.clock, "received_at");
      assert.deepEqual(archive.data.hours[0].stats.soil_moisture, { count: 2, sum: 50, avg: 25, min: 20, max: 30 });
      assert.equal(await prisma.simulationSample.count({ where: { run_id: noFlowRun.runId } }), 6);
      console.log('Verified Lab action → authenticated outbox → database → FarmOS analysis, including successful watering, no-flow and abrupt sensor drop.');
    } finally {
      lab.kill('SIGTERM');
      await new Promise<void>(resolve => lab.once('exit', () => resolve()));
    }
    await prisma.nodeGatewayBinding.updateMany({ where: { node_id: sample.observations.nodeId }, data: { status: 'REVOKED' } });
    const next = { ...envelope, sample: engine.step()[0] }; assert.equal((await ingest(next)).status, 403);
    await prisma.nodeGatewayBinding.updateMany({ where: { node_id: sample.observations.nodeId }, data: { status: 'ACTIVE' } });
    await prisma.gatewayCredential.update({ where: { gateway_id: 'SIM_GATEWAY_01' }, data: { revoked_at: new Date() } });
    assert.equal((await ingest(next)).status, 401);
    console.log('Verified persisted sample ID, duplicate replay, hidden labels, tenant boundaries, revoked binding and revoked credential.');
  } finally {
    await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect(); fs.rmSync(temp, { recursive: true, force: true });
  }
});
