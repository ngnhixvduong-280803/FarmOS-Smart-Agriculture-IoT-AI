import type { FarmOverview, TelemetryPoint, Zone } from '../types';
export function newerTelemetry(current?: TelemetryPoint, incoming?: TelemetryPoint): TelemetryPoint | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  const oldTime = Date.parse(current.timestamp), newTime = Date.parse(incoming.timestamp);
  if (!Number.isFinite(newTime)) return current;
  if (!Number.isFinite(oldTime)) return incoming;
  return newTime < oldTime ? current : incoming;
}
export function reconcileOverview(current: FarmOverview | null, incoming: FarmOverview | null): FarmOverview | null {
  if (!current || !incoming || current.farm.id !== incoming.farm.id) return incoming;
  const oldZones = current.farm.zones ?? current.zones ?? [];
  const reconcile = (zones: Zone[] | undefined) => zones?.map(zone => {
    const old = oldZones.find(z => z.id === zone.id)?.telemetries?.[0];
    const latest = newerTelemetry(old, zone.telemetries?.[0]);
    return latest ? { ...zone, telemetries: [latest] } : zone;
  });
  return { ...incoming, farm: { ...incoming.farm, zones: reconcile(incoming.farm.zones) }, zones: reconcile(incoming.zones) ?? incoming.zones };
}
