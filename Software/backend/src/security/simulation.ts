import { z } from 'zod';
import { gatewayTelemetrySchema } from './gateway-telemetry';
const safeId = z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);
export const simulationEnvelopeSchema = z.object({
  manifest: z.object({ runId: z.string().uuid(), sourceType: z.literal('synthetic'), modelVersion: z.literal('bucket-v1'), config: z.record(z.string(), z.unknown()), sources: z.array(z.object({ id: z.string(), url: z.string().url() }).passthrough()).max(30) }).passthrough(),
  sample: z.object({
    runId: z.string().uuid(), sequence: z.number().int().min(1).max(10000000), simulatedAt: z.string().datetime(), sourceType: z.literal('synthetic'), gatewayId: safeId, zoneId: safeId,
    observations: gatewayTelemetrySchema,
    context: z.object({ cropId: safeId, soilId: safeId, ageDays: z.number().finite().min(0), areaM2: z.number().positive().max(100000), ph: z.number().min(0).max(14), eceDsM: z.number().min(0).max(50), organicPct: z.number().min(0).max(100), et0MmDay: z.number().min(0).max(20), moistureUnit: z.literal('percent_vwc'), autoIrrigationMm: z.number().positive().max(50).optional() }).strict(),
    groundTruth: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict().superRefine((e, ctx) => {
  if (e.manifest.runId !== e.sample.runId || Math.abs(Date.parse(e.sample.simulatedAt) - (e.sample.observations.timestamp ?? 0) * 1000) > 1000) ctx.addIssue({ code: 'custom', message: 'Run/timestamp mismatch' });
  const nodes = e.manifest.config.nodes;
  if (!Array.isArray(nodes) || !nodes.some(n => n && n.id === e.sample.observations.nodeId && n.gatewayId === e.sample.gatewayId && n.zoneId === e.sample.zoneId)) ctx.addIssue({ code: 'custom', message: 'Manifest topology mismatch' });
});
