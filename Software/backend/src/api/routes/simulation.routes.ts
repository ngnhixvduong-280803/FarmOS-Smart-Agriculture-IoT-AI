import { Router, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../database/prisma';
import { requireGatewayAuth, GatewayRequest } from '../middleware/gateway-auth.middleware';
import { authenticate, AuthRequest } from '../middleware/auth.middleware';
import { simulationEnvelopeSchema } from '../../security/simulation';
import { getSimulationAnalysisData } from '../../simulation/analysis-data';
import { evaluateMoisture, type Reading } from '../../simulation/moisture-model';
import { compareIrrigation, getGardenWeather } from '../../simulation/irrigation-plan';
import { broadcastTelemetry } from '../../websocket/socket.server';
import { z } from 'zod';
const router = Router();
const agentSnapshotSchema = z.object({
  version: z.literal(1), runId: z.string().uuid(), nodeId: z.string(), eventId: z.string(),
  generatedAt: z.number().finite(), quality: z.string(),
  irrigation: z.object({ action: z.string(), reason: z.string().max(1000) }),
  moisture: z.object({
    source: z.string(), current: z.number().finite().nullable(),
    forecast: z.object({ method: z.string(), horizonHours: z.number().finite(), moisture: z.number().finite(),
      slopePerHour: z.number().finite(), sampleCount: z.number().int(), observedAt: z.number().finite() }).nullable(),
  }).optional(),
  deviceHealth: z.object({ status: z.string() }),
  ambient: z.object({ dewPointC: z.number().finite() }).nullable(),
  weather: z.object({ status: z.string(), rainMm24h: z.number().finite().optional(), maxRainProbability: z.number().finite().optional() }),
  irrigationFollowup: z.object({ status: z.string(), before: z.number().finite().nullable().optional(), after: z.number().finite().nullable().optional(), requestedMm: z.number().finite().optional() }),
  forecastSchedule: z.object({
    lastCheck: z.object({ checkedAt: z.number().finite(), updated: z.boolean() }).nullable(),
    plan24h: z.object({ calculatedAt: z.number().finite(), result: z.object({
      status: z.string(), startsAt: z.number().finite().optional(),
      selected: z.object({ delayHours: z.number().finite().nullable(), mm: z.number().finite(), liters: z.number().finite() }).optional(),
    }) }).nullable(),
    weekly: z.object({ calculatedAt: z.number().finite(), forecast: z.object({
      status: z.string(), threshold: z.number().finite().optional(),
      firstBelowWithRain: z.number().finite().nullable().optional(), firstBelowWithoutRain: z.number().finite().nullable().optional(),
      trajectory: z.array(z.object({ at: z.number().finite(), withRain: z.number().finite(), withoutRain: z.number().finite() })).max(8).optional(),
    }) }).nullable(),
  }),
});

router.post('/ingest', requireGatewayAuth, async (req: GatewayRequest, res: Response) => {
  const parsed = simulationEnvelopeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid synthetic envelope' });
  const { sample, manifest } = parsed.data;
  if (sample.gatewayId !== req.gatewayId || !sample.gatewayId.startsWith('SIM_') || !sample.observations.nodeId.startsWith('SIM_')) return res.status(403).json({ success: false, error: 'Gateway mismatch' });
  try {
    const result = await prisma.$transaction(async tx => {
      const nodeId = sample.observations.nodeId;
      const senderId = req.gatewayId!;
      const direct = senderId === nodeId;
      const [node, gateway, binding] = await Promise.all([
        tx.node.findUnique({ where: { id: nodeId }, select: {
          id: true, is_activated: true, farm_id: true, zone_id: true, gateway_id: true, deployment_mode: true,
        } }),
        direct ? null : tx.node.findUnique({ where: { id: senderId }, select: { farm_id: true } }),
        direct ? null : tx.nodeGatewayBinding.findFirst({
          where: { node_id: nodeId, gateway_id: senderId, status: 'ACTIVE' }, select: { node_id: true },
        }),
      ]);
      if (!node?.is_activated || !node.farm_id?.startsWith('SIM_') ||
          !node.zone_id || node.zone_id !== sample.zoneId) return null;
      if (direct ? node.deployment_mode !== 'STANDALONE_NODE' || node.gateway_id !== null
        : !binding || gateway?.farm_id !== node.farm_id || node.gateway_id !== senderId) return null;
      const farmId = node.farm_id;
      const id = randomUUID();
      const created = await tx.simulationSample.createMany({ data: [{ id, event_id: sample.observations.eventId, run_id: sample.runId, sequence: sample.sequence, farm_id: farmId, gateway_id: senderId, node_id: node.id, zone_id: node.zone_id, simulated_at: new Date(sample.simulatedAt), manifest: manifest as Prisma.InputJsonValue, observations: sample.observations as Prisma.InputJsonValue, context: sample.context as Prisma.InputJsonValue, ground_truth: sample.groundTruth as Prisma.InputJsonValue }], skipDuplicates: true });
      const row = await tx.simulationSample.findUnique({ where: { gateway_id_event_id: { gateway_id: senderId, event_id: sample.observations.eventId } }, select: { id: true, farm_id: true, node_id: true, run_id: true } });
      if (!row || row.farm_id !== farmId || row.node_id !== node.id || row.run_id !== sample.runId) throw new Error('Event identity collision');
      if (created.count > 0) {
        // Presence uses receipt time, never the accelerated simulation clock.
        await tx.node.updateMany({ where: { id: { in: direct ? [node.id] : [senderId, node.id] }, farm_id: farmId }, data: { online: true, last_seen: new Date() } });
      }
      return { persisted: true, duplicate: created.count === 0, sampleId: row.id, farmId: row.farm_id };
    }, { isolationLevel: 'Serializable' });
    if (!result) return res.status(403).json({ success: false, error: 'Requires an active synthetic device assigned to this zone' });
    if (!result.duplicate) {
      const { nodeId, soil_moisture, soil_temp, air_temp, air_humidity, quality, timestamp } = sample.observations;
      broadcastTelemetry({
        farmId: result.farmId, zoneId: sample.zoneId, nodeId,
        soil_moisture, soil_temp, air_temp, air_humidity, quality,
        timestamp: timestamp ?? Math.floor(Date.parse(sample.simulatedAt) / 1000),
      });
    }
    return res.json({ success: true, data: { persisted: result.persisted, duplicate: result.duplicate, sampleId: result.sampleId } });
  } catch { return res.status(503).json({ success: false, error: 'Synthetic sample not persisted; retry with same eventId' }); }
});

// Replay clients can checkpoint batches without replaying live device writes.
router.post('/replay', requireGatewayAuth, async (req: GatewayRequest, res: Response) => {
  const { manifest, samples } = req.body ?? {};
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > 48) {
    return res.status(400).json({ success: false, error: 'Invalid replay batch' });
  }
  const parsed = samples.map(sample => simulationEnvelopeSchema.safeParse({ manifest, sample }));
  if (parsed.some(item => !item.success)) return res.status(400).json({ success: false, error: 'Invalid replay samples' });
  const envelopes = parsed.flatMap(item => item.success ? [item.data] : []);
  const gatewayId = req.gatewayId;
  if (!gatewayId?.startsWith('SIM_') || envelopes.some(({ sample }) => sample.gatewayId !== gatewayId ||
      !sample.observations.nodeId.startsWith('SIM_') || sample.runId !== envelopes[0].sample.runId)) {
    return res.status(403).json({ success: false, error: 'Replay identity mismatch' });
  }
  try {
    const result = await prisma.$transaction(async tx => {
      const sender = await tx.node.findUnique({
        where: { id: gatewayId },
        select: { farm_id: true, gateway_id: true, zone_id: true, deployment_mode: true, is_activated: true },
      });
      if (!sender?.is_activated || !sender.farm_id?.startsWith('SIM_')) return undefined;
      const farmId = sender.farm_id;
      const ids = [...new Set(envelopes.map(({ sample }) => sample.observations.nodeId))];
      if (sender.deployment_mode === 'STANDALONE_NODE') {
        if (sender.gateway_id !== null || ids.length !== 1 || ids[0] !== gatewayId ||
            !sender.zone_id || envelopes.some(({ sample }) => sample.zoneId !== sender.zone_id)) return undefined;
      } else {
        const nodes = await tx.node.findMany({ where: { id: { in: ids }, is_activated: true, farm_id: farmId, gateway_id: gatewayId } });
        const bindings = await tx.nodeGatewayBinding.findMany({ where: { node_id: { in: ids }, gateway_id: gatewayId, farm_id: farmId, status: 'ACTIVE' } });
        if (envelopes.some(({ sample }) => !nodes.some(node => node.id === sample.observations.nodeId && node.zone_id === sample.zoneId) ||
            !bindings.some(binding => binding.node_id === sample.observations.nodeId && binding.zone_id === sample.zoneId))) return undefined;
      }
      const records = envelopes.map(({ sample, manifest }) => ({
        id: randomUUID(), event_id: sample.observations.eventId, run_id: sample.runId, sequence: sample.sequence,
        farm_id: farmId, gateway_id: gatewayId, node_id: sample.observations.nodeId, zone_id: sample.zoneId,
        simulated_at: new Date(sample.simulatedAt), manifest: manifest as Prisma.InputJsonValue,
        observations: sample.observations as Prisma.InputJsonValue,
        context: sample.context as Prisma.InputJsonValue, ground_truth: sample.groundTruth as Prisma.InputJsonValue,
      }));
      const { count } = await tx.simulationSample.createMany({ data: records, skipDuplicates: true });
      const stored = await tx.simulationSample.findMany({
        where: { gateway_id: gatewayId, event_id: { in: records.map(record => record.event_id) } },
        select: { event_id: true, farm_id: true, run_id: true, node_id: true },
      });
      if (records.some(record => !stored.some(row => row.event_id === record.event_id &&
          row.farm_id === farmId && row.run_id === record.run_id && row.node_id === record.node_id))) {
        throw new Error('Replay event identity collision');
      }
      if (count > 0) {
        await tx.node.updateMany({
          where: { id: { in: [...new Set([gatewayId, ...ids])] }, farm_id: farmId },
          data: { online: true, last_seen: new Date() },
        });
      }
      return count;
    });
    if (result === undefined) return res.status(403).json({ success: false, error: 'Replay requires active synthetic devices assigned to the requested zones' });
    return res.json({ success: true, data: { persisted: true, count: result } });
  } catch {
    return res.status(503).json({ success: false, error: 'Replay batch not stored' });
  }
});

async function accessibleFarm(req: AuthRequest): Promise<string | null> {
  const farmId = String(req.query.farmId || '');
  if (!farmId.startsWith('SIM_') || farmId.length > 100) return null;
  if (req.user!.role === 'ADMIN') return (await prisma.farm.findUnique({ where: { id: farmId }, select: { id: true } }))?.id || null;
  const member = await prisma.userFarm.findUnique({ where: { user_id_farm_id: { user_id: req.user!.id, farm_id: farmId } } });
  return member ? farmId : null;
}
router.get('/runs', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const farmId = await accessibleFarm(req);
    if (!farmId) return res.status(403).json({ success: false, error: 'Farm access denied' });
    const runs = await prisma.simulationSample.groupBy({ by: ['run_id', 'gateway_id'], where: { farm_id: farmId }, _count: { _all: true }, _min: { simulated_at: true }, _max: { simulated_at: true }, orderBy: { _max: { received_at: 'desc' } }, take: 100 });
    return res.json({ success: true, data: runs });
  } catch { return res.status(503).json({ success: false, error: 'Cannot read simulation runs' }); }
});
router.get('/runs/:runId/hourly', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const farmId = await accessibleFarm(req);
    if (!farmId) return res.status(403).json({ success: false, error: 'Farm access denied' });
    const nodeId = typeof req.query.nodeId === 'string' ? req.query.nodeId : '';
    if (!nodeId) return res.status(400).json({ success: false, error: 'nodeId is required' });
    const runId = req.params.runId;
    const hours = await prisma.$queryRaw`
      SELECT hour, stats FROM simulation_hourly
      WHERE farm_id = ${farmId} AND run_id = ${runId} AND node_id = ${nodeId}
      ORDER BY hour DESC LIMIT 720
    `;
    const events = await prisma.$queryRaw`
      SELECT event_id, simulated_at, quality, irrigation_mm FROM simulation_history_events
      WHERE farm_id = ${farmId} AND run_id = ${runId} AND node_id = ${nodeId}
      ORDER BY simulated_at DESC LIMIT 720
    `;
    return res.json({ success: true, sourceType: 'synthetic', data: { clock: "received_at", hours, events } });
  } catch { return res.status(503).json({ success: false, error: 'Cannot read hourly simulation data' }); }
});
router.get('/runs/:runId/samples', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const farmId = await accessibleFarm(req);
    if (!farmId) return res.status(403).json({ success: false, error: 'Farm access denied' });
    const limit = Math.min(500, Math.max(1, Math.floor(Number(req.query.limit) || 100)));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
    if (cursor) {
      const anchor = await prisma.simulationSample.findFirst({ where: { id: cursor, farm_id: farmId, run_id: req.params.runId }, select: { id: true } });
      if (!anchor) return res.status(400).json({ success: false, error: 'Invalid cursor' });
    }
    const includeLabels = req.query.includeLabels === '1';
    const rows = await prisma.simulationSample.findMany({ where: { farm_id: farmId, run_id: req.params.runId }, orderBy: [{ sequence: 'asc' }, { id: 'asc' }], take: Math.floor(limit), ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: { id: true, run_id: true, sequence: true, gateway_id: true, node_id: true, zone_id: true, simulated_at: true, received_at: true, observations: true, context: true, manifest: true, ...(includeLabels ? { ground_truth: true } : {}) } });
    const data = rows.map(row => {
      const { manifest, ...observation } = row;
      const metadata = manifest as Prisma.JsonObject;
      return { ...observation, provenance: { modelVersion: metadata.modelVersion, sources: metadata.sources, assumptions: metadata.assumptions }, ...(includeLabels ? { manifest } : {}) };
    });
    return res.json({ success: true, sourceType: 'synthetic', data, nextCursor: rows.length === Math.floor(limit) ? rows.at(-1)?.id : null });
  } catch { return res.status(503).json({ success: false, error: 'Cannot read simulation samples' }); }
});
async function analyzeSimulation(farmId?: string) {
    const farms = await prisma.farm.findMany({
      where: { id: farmId ?? { startsWith: 'SIM_' } }, take: 20, select: { id: true, name: true, latitude: true, longitude: true },
    });
    const data = await Promise.all(farms.map(async farm => {
      const { current: rows, history: hourly, events } = await getSimulationAnalysisData(farm.id);
      if (!rows.length) return { ...farm, nodes: [] };
      const forecast = await getGardenWeather(farm.id, farm);
      const groups = new Map<string, typeof hourly>();
      for (const row of hourly) {
        const group = groups.get(row.node_id) ?? [];
        group.push(row);
        groups.set(row.node_id, group);
      }
      return { ...farm, nodes: rows.map(current => {
        const nodeId = current.node_id;
        const currentHour = Math.floor(current.simulated_at.getTime() / 3600_000);
        const group = [current, ...(groups.get(nodeId) ?? []).filter(row =>
          Math.floor(row.simulated_at.getTime() / 3600_000) < currentHour)];
        const readings = new Map<number, Reading>();
        for (const row of group) {
          const frame = row.observations as Prisma.JsonObject;
          const hour = Math.floor(row.simulated_at.getTime() / 3600000);
          if (!readings.has(hour) && typeof frame.soil_moisture === 'number' && typeof frame.air_temp === 'number' && frame.quality === 1) {
            readings.set(hour, { hour, moisture: frame.soil_moisture, temperature: frame.air_temp });
          }
        }
        const history = [...readings.values()].reverse();
        const context = current.context as Prisma.JsonObject;
        const farmClock = rows[0].simulated_at.getTime();
        const hasAgentSnapshot = Boolean((current.manifest as Prisma.JsonObject).agentSnapshot);
        const stale = Date.now() - current.received_at.getTime() > (hasAgentSnapshot ? 30_000 : 15 * 60_000) ||
          farmClock - current.simulated_at.getTime() > 3 * 3600_000;
        const thresholds: Record<string, [number, number]> = { silt: [32, 15], 'loamy-sand': [15, 6], 'silty-clay': [35, 23] };
        const soil = typeof context.soilId === 'string' ? thresholds[context.soilId] : undefined;
        const currentFrame = current.observations as Prisma.JsonObject;
        const parsedSnapshot = agentSnapshotSchema.safeParse((current.manifest as Prisma.JsonObject).agentSnapshot);
        const candidate = parsedSnapshot.success ? parsedSnapshot.data : undefined;
        const agentSnapshot = candidate && candidate.runId === current.run_id &&
          candidate.nodeId === current.node_id && candidate.eventId === current.event_id &&
          typeof candidate.generatedAt === 'number' &&
          Math.abs(current.received_at.getTime() - candidate.generatedAt) <= 15 * 60_000 &&
          Date.now() - current.received_at.getTime() <= 30_000 ? candidate : undefined;
        const validCurrent = currentFrame.quality === 1 && typeof currentFrame.soil_moisture === 'number' &&
          Number.isFinite(currentFrame.soil_moisture) && currentFrame.soil_moisture >= 0 && currentFrame.soil_moisture <= 100 &&
          typeof currentFrame.air_temp === 'number' && Number.isFinite(currentFrame.air_temp) &&
          history.at(-1)?.hour === Math.floor(current.simulated_at.getTime() / 3600000);
        const moisture = validCurrent ? currentFrame.soil_moisture as number : undefined;
        const threshold = soil ? soil[0] - (context.cropId === 'tomato' ? 0.4 : 0.3) * (soil[0] - soil[1]) : undefined;
        let wetEpisodes = 0, streak = 0;
        for (let i = 0; i < history.length; i++) {
          const reading = history[i];
          if (i > 0 && reading.hour !== history[i - 1].hour + 1) streak = 0;
          streak = soil && reading.moisture > soil[0] + 2 ? streak + 1 : 0;
          if (streak === 12) wetEpisodes++;
        }
        const qualityReason = stale ? 'Số đo đã cũ hoặc node chậm hơn đồng hồ vườn.'
          : !validCurrent || context.moistureUnit !== 'percent_vwc' ? 'Số đo hiện tại hoặc đơn vị không hợp lệ.'
          : current.stuck ? 'Năm số đo liên tiếp giống nhau; cần kiểm tra cảm biến.'
          : current.sudden_drop ? 'Độ ẩm giảm đột ngột ít nhất 6 điểm % trong một giờ; cần kiểm tra cảm biến và điều kiện thực tế.' : undefined;
        const usable = !qualityReason;
        // Compare uninterrupted six-hour declines against the same node's history.
        const drops: number[] = [];
        let recentDrop: number | undefined;
        for (let i = 6; i < history.length; i++) {
          const window = history.slice(i - 6, i + 1);
          if (window.some((point, j) => j > 0 &&
            (point.hour !== window[j - 1].hour + 1 || point.moisture > window[j - 1].moisture))) continue;
          const drop = window[0].moisture - window[6].moisture;
          if (i === history.length - 1) recentDrop = drop;
          else if (window[6].hour <= current.simulated_at.getTime() / 3600_000 - 24) drops.push(drop);
        }
        drops.sort((a, b) => a - b);
        const typicalDrop = drops[Math.floor(drops.length / 2)];
        const rapidDrying = usable && drops.length >= 24 && recentDrop !== undefined &&
          recentDrop >= Math.max(2, typicalDrop * 3) ? { drop: recentDrop, typicalDrop } : undefined;
        const wetNow = usable && soil !== undefined && moisture !== undefined && moisture > soil[0] + 2
          ? { hours: streak, threshold: soil[0] + 2 } : undefined;
        const attempt = events.find(row => row.node_id === nodeId);
        let irrigationResponse;
        if (attempt && usable) {
          const hour = Math.floor(attempt.simulated_at.getTime() / 3600_000);
          const before = readings.get(hour - 1)?.moisture;
          const after = readings.get(hour)?.moisture;
          const afterSix = readings.get(hour + 6)?.moisture;
          if (before !== undefined && after !== undefined) {
            const gain = after - before;
            const loss = afterSix === undefined ? undefined : after - afterSix;
            irrigationResponse = {
              mm: attempt.irrigation_mm,
              before, after, gain, loss,
              status: gain < 0.15 ? 'no_response' : loss !== undefined && loss >= 2 && loss >= gain * 0.6
                ? 'rapid_loss' : streak >= 12 ? 'wet' : 'responded',
            };
          }
        }
        const fields = ['soil_moisture', 'soil_temp', 'air_temp', 'air_humidity', 'lux'] as const;
        const recentFrames = new Map<number, Prisma.JsonObject>();
        for (const row of group) {
          const hour = Math.floor(row.simulated_at.getTime() / 3600_000);
          const frame = row.observations as Prisma.JsonObject;
          if (hour > currentHour - 24 && !recentFrames.has(hour) && frame.quality === 1) recentFrames.set(hour, frame);
        }
        const sensors = fields.map(field => {
          const values = [...recentFrames.values()].map(frame => frame[field])
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
          const currentValue = currentFrame[field];
          return { field, current: currentFrame.quality === 1 && typeof currentValue === 'number' ? currentValue : null,
            average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, count: values.length };
        });
        const makePlan = (hours: NonNullable<typeof forecast>['hours'], input: Reading[]) =>
          compareIrrigation(String(context.soilId), String(context.cropId), Number(context.ageDays), input,
            { fetchedAt: forecast!.fetchedAt, hours });
        const irrigationPlan = usable && forecast ? makePlan(forecast.hours.slice(0, 24), history) : undefined;
        let tomorrowPlan;
        if (forecast && irrigationPlan) {
          const dayMs = 86400_000;
          const vietnamOffset = 7 * 3600_000;
          const midnight = (Math.floor((Date.now() + vietnamOffset) / dayMs) + 1) * dayMs - vietnamOffset;
          const offset = forecast.hours.findIndex(hour => hour.endAt === midnight + 3600_000);
          const startMoisture = offset === 0 ? moisture : irrigationPlan.options.find(option => option.delay === null)?.trajectory[offset - 1];
          if (offset >= 0 && startMoisture !== undefined && offset + 24 <= forecast.hours.length) {
            tomorrowPlan = makePlan(forecast.hours.slice(offset, offset + 24),
              [{ ...history[history.length - 1], moisture: startMoisture }]);
          }
        }
        return {
          nodeId, crop: context.cropId, soil: context.soilId, receivedAt: current.received_at, qualityReason, agentSnapshot,
          samples: history.length, moisture, threshold, wetEpisodes, sensors, usable, tomorrowPlan, rapidDrying, wetNow, irrigationResponse,
          models: usable ? evaluateMoisture(history) : undefined,
          irrigationPlan,
          weatherUnavailable: usable && !forecast,
          weatherLocationMissing: usable && !forecast && (farm.latitude === null || farm.longitude === null) && !['SIM_AGENT_A', 'SIM_AGENT_B', 'SIM_AGENT_C'].includes(farm.id),
          recommendation: !usable ? 'Tạm giữ đề xuất tưới. Kiểm tra dữ liệu mới và cảm biến.'
            : threshold !== undefined && moisture !== undefined && moisture < threshold
              ? 'Độ ẩm dưới ngưỡng tham chiếu. Kiểm tra mưa và lượng nước cấp trước khi lên lịch tưới.'
              : 'Tiếp tục theo dõi độ ẩm.',
          soilRecommendation: wetEpisodes >= 2 ? 'Nhiều đợt ẩm cao từ 12 giờ. Kiểm tra đường thoát và thử luống đối chứng.' : undefined,
        };
      }) };
    }));
  return { success: true, sourceType: 'synthetic', analyzedAt: new Date().toISOString(), data };
}

const farmAnalysisCache = new Map<string, {
  expiresAt: number;
  result: Promise<Awaited<ReturnType<typeof analyzeSimulation>>>;
}>();

function cachedFarmAnalysis(farmId: string) {
  const now = Date.now();
  for (const [id, entry] of farmAnalysisCache) {
    if (entry.expiresAt <= now) farmAnalysisCache.delete(id);
  }
  const cached = farmAnalysisCache.get(farmId);
  if (cached) return cached.result;

  const result = analyzeSimulation(farmId);
  const entry = { expiresAt: now + 5000, result };
  farmAnalysisCache.set(farmId, entry);
  void result.catch(() => {
    if (farmAnalysisCache.get(farmId) === entry) farmAnalysisCache.delete(farmId);
  });
  return result;
}

const analysisPaused = process.env.FARMOS_SIMULATION_ANALYSIS_PAUSED === '1';
// Members can view only the synthetic analysis for their own farm. The admin
// dashboard endpoint remains admin-only and never accepts a client farm list.
router.get('/farm-analysis', authenticate, async (req: AuthRequest, res: Response) => {
  if (analysisPaused) {
    return res.status(503).json({ success: false, error: 'Phân tích mô phỏng đang tạm dừng để ổn định hệ thống.' });
  }
  try {
    const farmId = await accessibleFarm(req);
    if (!farmId) return res.status(403).json({ success: false, error: 'Farm access denied' });
    const result = await cachedFarmAnalysis(farmId);
    return res.json({ ...result, data: result.data[0] ?? null });
  } catch { return res.status(503).json({ success: false, error: 'Không đọc được phân tích mô phỏng.' }); }
});

router.get('/analysis', authenticate, async (req: AuthRequest, res: Response) => {
  if (analysisPaused) {
    return res.status(503).json({ success: false, error: 'Phân tích mô phỏng đang tạm dừng để ổn định hệ thống.' });
  }
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ success: false });
  try {
    const farms = await prisma.farm.findMany({
      where: { id: { startsWith: 'SIM_' } }, take: 20, select: { id: true },
    });
    const results = await Promise.all(farms.map(farm => cachedFarmAnalysis(farm.id)));
    return res.json({ success: true, sourceType: 'synthetic', analyzedAt: new Date().toISOString(),
      data: results.flatMap(result => result.data) });
  } catch { return res.status(503).json({ success: false, error: 'Không đọc được phân tích mô phỏng.' }); }
});
export default router;
