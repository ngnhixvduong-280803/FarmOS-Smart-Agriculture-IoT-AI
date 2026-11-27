import { prisma } from '../database/prisma';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export async function compactSimulationSamples(now = new Date()) {
  const cutoff = new Date(now.getTime() - DAY);
  const expiry = new Date(now.getTime() - 30 * DAY);

  return prisma.$transaction(async tx => {
    const [lock] = await tx.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(611231500) AS acquired
    `;
    if (!lock.acquired) return 0;

    // Materialize exactly the rows removed by this transaction. A failed
    // summary or event write rolls back the raw deletion as well.
    const [result] = await tx.$queryRaw<{ removed: number }[]>`
      WITH batch AS (
        SELECT id FROM simulation_samples
        WHERE received_at < ${cutoff}
        ORDER BY received_at, id
        LIMIT 2000
        FOR UPDATE SKIP LOCKED
      ), removed AS (
        DELETE FROM simulation_samples s USING batch
        WHERE s.id = batch.id
        RETURNING s.*
      ), retained AS (
        SELECT *, date_trunc('hour', received_at) AS hour
        FROM removed WHERE received_at >= ${expiry}
      ), metrics AS (
        SELECT s.farm_id, s.run_id, s.gateway_id, s.node_id, s.hour,
          field.name, count(*) AS samples, sum(field.value) AS total,
          min(field.value) AS minimum, max(field.value) AS maximum
        FROM retained s
        CROSS JOIN LATERAL (
          SELECT key AS name,
            CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::double precision END AS value
          FROM jsonb_each(s.observations)
          WHERE key IN ('soil_moisture', 'soil_temp', 'air_temp', 'air_humidity', 'lux')
        ) field
        WHERE s.observations->>'quality' = '1' AND field.value IS NOT NULL
        GROUP BY s.farm_id, s.run_id, s.gateway_id, s.node_id, s.hour, field.name
      ), hours AS (
        SELECT farm_id, run_id, gateway_id, node_id, hour, max(received_at) AS received_at
        FROM retained GROUP BY farm_id, run_id, gateway_id, node_id, hour
      ), written AS (
        INSERT INTO simulation_hourly (farm_id, run_id, gateway_id, node_id, hour, received_at, stats)
        SELECT h.*, coalesce(m.stats, '{}'::jsonb)
        FROM hours h
        LEFT JOIN LATERAL (
          SELECT jsonb_object_agg(name, jsonb_build_object(
            'count', samples, 'sum', total, 'min', minimum, 'max', maximum, 'avg', total / samples
          )) AS stats
          FROM metrics WHERE (farm_id, run_id, gateway_id, node_id, hour) =
            (h.farm_id, h.run_id, h.gateway_id, h.node_id, h.hour)
        ) m ON true
        ON CONFLICT (farm_id, run_id, gateway_id, node_id, hour) DO UPDATE SET
          received_at = greatest(simulation_hourly.received_at, excluded.received_at),
          stats = coalesce((
            SELECT jsonb_object_agg(coalesce(a.key, b.key), jsonb_build_object(
              'count', totals.samples, 'sum', totals.total,
              'min', least((a.value->>'min')::double precision, (b.value->>'min')::double precision),
              'max', greatest((a.value->>'max')::double precision, (b.value->>'max')::double precision),
              'avg', totals.total / totals.samples
            ))
            FROM jsonb_each(simulation_hourly.stats) a FULL JOIN jsonb_each(excluded.stats) b USING (key)
            CROSS JOIN LATERAL (SELECT
              coalesce((a.value->>'count')::bigint, 0) + coalesce((b.value->>'count')::bigint, 0) AS samples,
              coalesce((a.value->>'sum')::double precision, 0) + coalesce((b.value->>'sum')::double precision, 0) AS total
            ) totals
          ), '{}'::jsonb)
        RETURNING 1
      ), events AS (
        INSERT INTO simulation_history_events
          (gateway_id, event_id, farm_id, run_id, node_id, simulated_at, received_at, quality, irrigation_mm)
        SELECT gateway_id, event_id, farm_id, run_id, node_id, simulated_at, received_at,
          (observations->>'quality')::integer,
          CASE WHEN jsonb_typeof(context->'autoIrrigationMm') = 'number'
            THEN (context->>'autoIrrigationMm')::double precision END
        FROM retained
        WHERE jsonb_typeof(context->'autoIrrigationMm') = 'number'
          OR observations->>'quality' IS DISTINCT FROM '1'
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      SELECT count(*)::int AS removed FROM removed
    `;
    await tx.$executeRaw`DELETE FROM simulation_hourly WHERE received_at < ${expiry}`;
    await tx.$executeRaw`DELETE FROM simulation_history_events WHERE received_at < ${expiry}`;
    return result.removed;
  }, { timeout: 30_000 });
}

export function startSimulationRetention() {
  const sweep = async () => {
    try {
      const removed = await compactSimulationSamples();
      setTimeout(sweep, removed === 2000 ? 1000 : 60_000).unref();
    } catch {
      console.error('[simulation] Retention failed. Will retry.');
      setTimeout(sweep, 60_000).unref();
    }
  };
  void sweep();
}
