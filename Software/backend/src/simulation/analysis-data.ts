import { Prisma } from '@prisma/client';
import { prisma } from '../database/prisma';

type Sample = {
  node_id: string;
  run_id: string;
  event_id: string;
  simulated_at: Date;
  received_at: Date;
  observations: Prisma.JsonValue;
  context: Prisma.JsonValue;
  manifest: Prisma.JsonValue;
  sudden_drop: boolean;
  stuck: boolean;
};

export async function getSimulationAnalysisData(farmId: string) {
  const latest = await prisma.simulationSample.findFirst({
    where: { farm_id: farmId }, orderBy: { received_at: 'desc' }, select: { run_id: true },
  });
  if (!latest) return { current: [], history: [], events: [] };
  const runId = latest.run_id;

  const [current, history, events] = await Promise.all([
    prisma.$queryRaw<Sample[]>`
      WITH current AS (
        SELECT DISTINCT ON (node_id) node_id, run_id, event_id, simulated_at,
          received_at, observations, context,
          jsonb_build_object('agentSnapshot', manifest->'agentSnapshot') AS manifest
        FROM simulation_samples WHERE farm_id = ${farmId} AND run_id = ${runId}
        ORDER BY node_id, simulated_at DESC, received_at DESC, id DESC
      )
      SELECT current.*, checks.sudden_drop, checks.stuck FROM current
      CROSS JOIN LATERAL (
        SELECT coalesce(bool_or(elapsed > interval '0' AND elapsed <= interval '1 hour'
          AND previous - moisture >= 6), false) AS sudden_drop,
          count(*) FILTER (WHERE position <= 5) = 5
          AND min(moisture) FILTER (WHERE position <= 5) = max(moisture) FILTER (WHERE position <= 5)
          AND coalesce(bool_and(elapsed > interval '0' AND elapsed <= interval '1 hour')
            FILTER (WHERE position < 5), false) AS stuck
        FROM (
          SELECT moisture,
            lead(moisture) OVER ordering AS previous,
            simulated_at - lead(simulated_at) OVER ordering AS elapsed,
            row_number() OVER ordering AS position
          FROM (
            SELECT simulated_at, received_at, id,
              (observations->>'soil_moisture')::double precision AS moisture
            FROM simulation_samples s
            WHERE s.farm_id = ${farmId} AND s.run_id = ${runId} AND s.node_id = current.node_id
              AND s.simulated_at >= current.simulated_at - interval '24 hours'
              AND s.observations->>'quality' = '1'
              AND jsonb_typeof(s.observations->'soil_moisture') = 'number'
          ) valid
          WINDOW ordering AS (ORDER BY simulated_at DESC, received_at DESC, id DESC)
        ) changes
      ) checks
      ORDER BY current.simulated_at DESC
    `,
    cachedHourlyAnalysis(farmId, runId),
    prisma.$queryRaw<{ node_id: string; simulated_at: Date; irrigation_mm: number }[]>`
      SELECT DISTINCT ON (node_id) node_id, simulated_at, irrigation_mm
      FROM (
        SELECT node_id, simulated_at, (context->>'autoIrrigationMm')::double precision AS irrigation_mm
        FROM simulation_samples WHERE farm_id = ${farmId} AND run_id = ${runId}
          AND jsonb_typeof(context->'autoIrrigationMm') = 'number'
        UNION ALL
        SELECT node_id, simulated_at, irrigation_mm FROM simulation_history_events
        WHERE farm_id = ${farmId} AND run_id = ${runId} AND irrigation_mm IS NOT NULL
      ) events ORDER BY node_id, simulated_at DESC
    `,
  ]);
  return { current, history, events };
}

const hourlyCache = new Map<string, {
  runId: string;
  expiresAt: number;
  rows: ReturnType<typeof getHourlyAnalysis>;
}>();

function cachedHourlyAnalysis(farmId: string, runId: string) {
  const now = Date.now();
  for (const [id, entry] of hourlyCache) {
    if (entry.expiresAt <= now) hourlyCache.delete(id);
  }
  const cached = hourlyCache.get(farmId);
  if (cached?.runId === runId) return cached.rows;
  const rows = getHourlyAnalysis(farmId, runId);
  const entry = { runId, expiresAt: now + 5 * 60_000, rows };
  hourlyCache.set(farmId, entry);
  void rows.catch(() => {
    if (hourlyCache.get(farmId) === entry) hourlyCache.delete(farmId);
  });
  return rows;
}

async function getHourlyAnalysis(farmId: string, runId: string) {
  // This history uses the simulated clock. The long-term cloud archive is
  // bucketed by receipt time and must not be fed into the simulation model.
  return prisma.$queryRaw<{ node_id: string; simulated_at: Date; observations: Prisma.JsonValue }[]>`
    WITH latest AS (
      SELECT node_id, max(simulated_at) AS simulated_at
      FROM simulation_samples
      WHERE farm_id = ${farmId} AND run_id = ${runId}
      GROUP BY node_id
    ), metrics AS (
      SELECT s.node_id, date_trunc('hour', s.simulated_at) AS hour, field.key,
        sum((field.value #>> '{}')::double precision) AS total, count(*) AS samples
      FROM latest
      JOIN simulation_samples s ON s.node_id = latest.node_id
        AND s.simulated_at >= date_trunc('hour', latest.simulated_at) - interval '167 hours'
      CROSS JOIN LATERAL jsonb_each(s.observations) field
      WHERE s.farm_id = ${farmId} AND s.run_id = ${runId} AND s.observations->>'quality' = '1'
        AND field.key IN ('soil_moisture', 'soil_temp', 'air_temp', 'air_humidity', 'lux')
        AND jsonb_typeof(field.value) = 'number'
      GROUP BY s.node_id, date_trunc('hour', s.simulated_at), field.key
    ), combined AS (
      SELECT node_id, hour, key, sum(total) / sum(samples) AS average
      FROM metrics GROUP BY node_id, hour, key
    ), hourly AS (
      SELECT node_id, hour AS simulated_at, jsonb_object_agg(key, average) || '{"quality":1}'::jsonb AS observations,
        row_number() OVER (PARTITION BY node_id ORDER BY hour DESC) AS position
      FROM combined GROUP BY node_id, hour
    )
    SELECT node_id, simulated_at, observations FROM hourly WHERE position <= 168
    ORDER BY simulated_at DESC
  `;
}
