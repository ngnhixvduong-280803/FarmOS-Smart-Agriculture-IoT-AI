import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { collectProductionConfigErrors } from "./preflight";

function productionConfig() {
  const enrollment = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const qr = generateKeyPairSync("ed25519");
  return {
    NODE_ENV: "production",
    FARMOS_WEB_URL: "https://farm.example",
    FARMOS_API_URL: "https://api.example",
    DATABASE_URL: "postgresql://db.example/farmos",
    DIRECT_URL: "postgresql://db.example/farmos-direct",
    MQTT_BROKER_URL: "mqtt://mosquitto:1883",
    MQTT_USERNAME: "farmos-backend",
    MQTT_PASSWORD: "m".repeat(16),
    JWT_SECRET: "j".repeat(32),
    DEVICE_INGEST_TOKEN: "d".repeat(32),
    HARDWARE_BOARD_HMAC_SECRET: "h".repeat(32),
    FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY: enrollment.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY: enrollment.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    MANUFACTURING_QR_SIGNING_KEY: qr.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

test("production preflight accepts the canonical environment", () => {
  assert.deepEqual(collectProductionConfigErrors(productionConfig()), []);
});

test("production preflight reports names, not secret values, for missing configuration", () => {
  const values = productionConfig() as Record<string, string | undefined>;
  delete values.HARDWARE_BOARD_HMAC_SECRET;
  delete values.FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY;
  delete values.FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY;
  delete values.MANUFACTURING_QR_SIGNING_KEY;
  const errors = collectProductionConfigErrors(values);
  assert.ok(errors.some((error) => error.includes("HARDWARE_BOARD_HMAC_SECRET")));
  assert.ok(errors.some((error) => error.includes("FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY")));
  assert.ok(errors.some((error) => error.includes("FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY")));
  assert.ok(errors.some((error) => error.includes("MANUFACTURING_QR_SIGNING_KEY")));
  assert.ok(errors.every((error) => !error.includes("postgresql://db.example")));
  assert.ok(errors.every((error) => !error.includes("j".repeat(32))));
});

test("legacy public URL aliases remain accepted during migration", () => {
  const values = productionConfig() as Record<string, string | undefined>;
  delete values.FARMOS_WEB_URL;
  delete values.FARMOS_API_URL;
  values.DOMAIN = "https://legacy.example/";
  values.BACKEND_API_URL = "https://legacy-api.example/api/v1/telemetry";
  assert.deepEqual(collectProductionConfigErrors(values), []);
});
