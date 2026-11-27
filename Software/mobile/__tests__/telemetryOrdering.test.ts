import { newerTelemetry, reconcileOverview } from '../src/services/telemetryOrdering';
test('older socket events do not overwrite a newer full observation', () => {
 const current = { timestamp: '2026-11-18T12:21:16.500Z', air_temp: 28.93, air_humidity: 66.13 };
 const old = { timestamp: '2026-11-18T12:21:15.000Z', soil_temp: 28.38 };
 expect(newerTelemetry(current, old)).toEqual(current);
 const fresh = { timestamp: '2026-11-18T12:21:17.000Z', soil_temp: 28.38 };
 expect(newerTelemetry(current, fresh)).toEqual(fresh);
});
test('slower overview fetch cannot replace a newer live sample', () => {
 const mk = (t: string, temp: number): any => ({ farm: { id:'F', zones:[{ id:'Z', telemetries:[{ timestamp:t, air_temp:temp }] }] }, zones: [] });
 expect(reconcileOverview(mk('2026-11-18T12:21:17Z', 29), mk('2026-11-18T12:21:16Z', 28))?.farm.zones?.[0].telemetries?.[0].air_temp).toBe(29);
 expect(reconcileOverview(mk('2026-11-18T12:21:16Z', 28), mk('2026-11-18T12:21:17Z', 29))?.farm.zones?.[0].telemetries?.[0].air_temp).toBe(29);
});
