import { MAX_QR_PAYLOAD_LENGTH, parseDeviceQr } from "../src/services/qr";

const v3 = {
  v: 3,
  issuer: "farmos",
  qrId: "QR3-TEST",
  deviceId: "NODE_TEST_01",
  serial: "SN-TEST-01",
  type: "SENSOR_NODE",
  model: "FARMOS-SENSOR",
  hardwareRevision: "REV-A",
  kid: "farmos-2026-01",
  sig: "c2lnbmF0dXJl",
};

describe("FarmOS QR parser", () => {
  it("accepts the exact bounded v3 public payload", () => {
    expect(parseDeviceQr(JSON.stringify(v3))).toEqual({ version: 3, payload: v3 });
  });

  it("rejects arbitrary URL/URI QR values", () => {
    expect(() => parseDeviceQr("https://example.invalid/device?payload=%7B%7D")).toThrow(/JSON v3\/v2/);
    expect(() => parseDeviceQr("farmos://device/NODE_TEST_01")).toThrow(/JSON v3\/v2/);
  });

  it("rejects unknown keys and secret-bearing v3 payloads", () => {
    expect(() => parseDeviceQr(JSON.stringify({ ...v3, claim: "legacy-secret" }))).toThrow(/đúng payload/);
    expect(() => parseDeviceQr(JSON.stringify({ ...v3, setupSecret: "secret" }))).toThrow(/đúng payload/);
  });

  it("keeps v2 parsing explicit and bounded", () => {
    expect(parseDeviceQr(JSON.stringify({ v: 2, deviceId: "NODE_TEST_01", serial: "SN-TEST-01", claim: "legacy-claim" }))).toEqual({
      version: 2,
      legacy: { version: 2, deviceId: "NODE_TEST_01", serial: "SN-TEST-01", claim: "legacy-claim" },
    });
    expect(() => parseDeviceQr("x".repeat(MAX_QR_PAYLOAD_LENGTH + 1))).toThrow(/vượt giới hạn/);
  });
});
