import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildReport } from './report';
const now = Date.parse('2026-01-01T12:00:00Z');
const node = { id: 'N1', name: null, type: 'SENSOR_NODE', online: true, last_seen: new Date(now), telemetries: [{ timestamp: new Date(now), quality: 0, soil_moisture: 32 }] };
test('missing, stale and invalid readings never imply a watering recommendation', () => {
  for (const telemetries of [[], [{ ...node.telemetries[0], timestamp: new Date(now - 31 * 60_000) }], [{ ...node.telemetries[0], quality: 2 }]]) {
    const result = buildReport([{ ...node, telemetries }], [], now);
    assert.equal(result[0].agent, 'sensor');
    assert.match(result[0].detail, /trước khi quyết định tưới/);
  }
});
test('flags offline and unsuccessful irrigation without claiming a diagnosis', () => {
  const findings = buildReport([{ ...node, online: false }], [{ status: 'FAILED', created_at: new Date(now), zone: { name: 'A' } }], now);
  assert.deepEqual(findings.map(item => item.agent), ['device', 'irrigation']);
});
import { irrigationFollowup } from './irrigation';
test('compares only valid observations around a completed irrigation in the same zone', () => {
  const logs = [{ status: 'COMPLETED', created_at: new Date(now - 60 * 60_000), completed_at: new Date(now - 45 * 60_000), zone_id: 'z', zone: { name: 'A' } }];
  const nodes = [{ id: 'n', name: null, zone_id: 'z', telemetries: [
    { timestamp: new Date(now - 70 * 60_000), quality: 0, soil_moisture: 30 },
    { timestamp: new Date(now - 20 * 60_000), quality: 0, soil_moisture: 35 },
  ] }];
  assert.match(irrigationFollowup(logs, nodes, now)[0].detail, /chênh lệch 5.0/);
  assert.equal(irrigationFollowup(logs, [{ ...nodes[0], zone_id: 'other' }], now).length, 0);
  assert.equal(irrigationFollowup([{ ...logs[0], status: 'FAILED' }], nodes, now).length, 0);
});
