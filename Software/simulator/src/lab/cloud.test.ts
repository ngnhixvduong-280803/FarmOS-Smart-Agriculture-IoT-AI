import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudOutbox } from './cloud.js';
import { LabEngine } from './engine.js';
import { defaultConfig } from './catalog.js';
test('authenticated HTTP contract, offline queue, persisted ACK, replay and rejected dropped ACK', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farmos-lab-'));
  let requests = 0; let dropped = true;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.url, '/api/v1/simulation/ingest'); assert.equal(req.headers['x-farmos-device-token'], 'private-test-token');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const envelope = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(envelope.sample.sourceType, 'synthetic');
    requests++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, data: { persisted: true, dropped, sampleId: 'persisted-id' } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  const file = path.join(dir, 'outbox.json');
  try {
    const outbox = new CloudOutbox(file, `http://127.0.0.1:${address.port}`, { SIM_GATEWAY_01: 'private-test-token' });
    const engine = new LabEngine(defaultConfig(), 'sample-run');
    const sample = engine.step()[0]; outbox.enqueue({ manifest: { sourceType: 'synthetic' }, sample });
    const restart = new CloudOutbox(file, `http://127.0.0.1:${address.port}`, { SIM_GATEWAY_01: 'private-test-token' });
    assert.equal(restart.queue.length, 1); restart.enable(true);
    await restart.flush(new Set(['SIM_GATEWAY_01'])); assert.equal(requests, 0);
    await restart.flush(); assert.equal(restart.queue.length, 1); assert.equal(restart.status.persisted, 0); assert.equal(restart.receipts[sample.observations.nodeId], undefined);
    dropped = false;
    // Restart retains the same event ID, even if the prior HTTP response was lost.
    const retry = new CloudOutbox(file, `http://127.0.0.1:${address.port}`, { SIM_GATEWAY_01: 'private-test-token' }); retry.enable(true); await retry.flush();
    assert.equal(retry.queue.length, 0); assert.equal(retry.status.lastTelemetryId, 'persisted-id'); assert.equal(requests, 2);
    assert.equal(retry.receipts[sample.observations.nodeId].eventId, sample.observations.eventId);
    assert.deepEqual(retry.receipts[sample.observations.nodeId].observations, sample.observations);
    assert.equal(retry.receipts[sample.observations.nodeId].sampleId, 'persisted-id');
    assert.ok(!JSON.stringify(retry.info()).includes('private-test-token'));
  } finally { await new Promise<void>(r => server.close(() => r())); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('public plaintext HTTP and credential-bearing URL are refused', () => {
  assert.throws(() => new CloudOutbox('/nonexistent', 'http://example.com', {}));
  assert.throws(() => new CloudOutbox('/nonexistent', 'https://name:secret@example.com', {}));
});
