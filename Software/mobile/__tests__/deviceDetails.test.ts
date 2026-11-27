jest.mock("../src/services/api", () => ({ api: {} }));

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock"),
);

import { isTelemetryStale, TELEMETRY_STALE_AFTER_MS } from "../src/components/DeviceDetailsPanel";

describe("device telemetry freshness", () => {
  const now = Date.parse("2026-09-07T10:00:00.000Z");

  test("marks missing and old telemetry as stale", () => {
    expect(isTelemetryStale(undefined, now)).toBe(true);
    expect(isTelemetryStale("not-a-date", now)).toBe(true);
    expect(isTelemetryStale(new Date(now - TELEMETRY_STALE_AFTER_MS - 1).toISOString(), now)).toBe(true);
  });

  test("keeps telemetry inside the freshness window fresh", () => {
    expect(isTelemetryStale(new Date(now - TELEMETRY_STALE_AFTER_MS + 1).toISOString(), now)).toBe(false);
  });
});
