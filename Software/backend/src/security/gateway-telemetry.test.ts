import assert from "node:assert/strict";
import { test } from "node:test";
import { gatewayTelemetrySchema } from "./gateway-telemetry";

const frame = { eventId: "NODE_000001-123-456", nodeId: "NODE_000001", soil_temp: 28.25 };
test("DS18B20-only telemetry is accepted without invented moisture", () => {
  const value = gatewayTelemetrySchema.parse(frame);
  assert.equal(value.soil_temp, 28.25);
  assert.equal(value.soil_moisture, undefined);
});
for (const value of [null, "28.25", NaN, Infinity, -56, 126]) {
  test(`reject invalid temperature ${String(value)}`, () => {
    assert.equal(gatewayTelemetrySchema.safeParse({ ...frame, soil_temp: value }).success, false);
  });
}
test("reject missing reading, id, spoofed zone and invalid quality", () => {
  for (const value of [
    { ...frame, soil_temp: undefined }, { ...frame, eventId: "" },
    { ...frame, zoneId: "other-farm" }, { ...frame, quality: 1.5 },
  ]) assert.equal(gatewayTelemetrySchema.safeParse(value).success, false);
});
