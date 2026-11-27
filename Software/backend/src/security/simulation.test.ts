import test from 'node:test';
import assert from 'node:assert/strict';
import { simulationEnvelopeSchema } from './simulation';
const runId = 'a4535246-6585-4a7e-956a-a3d8a6c616ca';
const envelope = () => ({ manifest: { runId, sourceType: 'synthetic', modelVersion: 'bucket-v1', config: { nodes: [{ id: 'SIM_NODE_01', gatewayId: 'SIM_GATEWAY_01', zoneId: 'SIM_ZONE_A' }] }, sources: [] }, sample: { runId, sequence: 1, simulatedAt: '2026-01-01T00:00:00.000Z', sourceType: 'synthetic', gatewayId: 'SIM_GATEWAY_01', zoneId: 'SIM_ZONE_A', observations: { eventId: 'simulation_event_0001', nodeId: 'SIM_NODE_01', timestamp: 1767225600, soil_moisture: 24, quality: 1 }, context: { cropId: 'tomato', soilId: 'silt', ageDays: 30, areaM2: 100, ph: 6, eceDsM: 1, organicPct: 2, et0MmDay: 4, moistureUnit: 'percent_vwc' }, groundTruth: { stress: true } } });
test('synthetic provenance, units, topology and time must match', () => {
  assert.equal(simulationEnvelopeSchema.safeParse(envelope()).success, true);
  for (const mutate of [(e: any) => e.sample.sourceType = 'real', (e: any) => e.sample.context.moistureUnit = 'adc', (e: any) => e.sample.gatewayId = 'another', (e: any) => e.sample.simulatedAt = '2026-01-02T00:00:00.000Z', (e: any) => e.sample.observations.soil_moisture = 120, (e: any) => e.sample.context.ph = -1]) { const e = envelope(); mutate(e); assert.equal(simulationEnvelopeSchema.safeParse(e).success, false); }
});
