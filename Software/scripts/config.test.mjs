import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { checkConfig, generatedContract, resolveConfig } from "./config.mjs";

function keys() {
  const enrollment = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const qr = generateKeyPairSync("ed25519");
  return {
    NODE_ENV: "production",
    FARMOS_WEB_URL: "https://farm.example",
    FARMOS_API_URL: "https://api.example",
    JWT_SECRET: "j".repeat(32),
    HARDWARE_BOARD_HMAC_SECRET: "h".repeat(32),
    DEVICE_INGEST_TOKEN: "d".repeat(32),
    MQTT_PASSWORD: "m".repeat(16),
    FIRMWARE_MANIFEST_KEY_ID: "manifest-v1",
    FIRMWARE_ENROLLMENT_KEY_ID: "enrollment-v1",
    MANUFACTURING_QR_KEY_ID: "qr-v1",
    FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY: enrollment.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY: enrollment.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    MANUFACTURING_QR_SIGNING_KEY: qr.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    MANUFACTURING_QR_PUBLIC_KEYS: JSON.stringify({ "qr-v1": qr.publicKey.export({ format: "der", type: "spki" }).toString("base64url") }),
  };
}

test("canonical URL aliases normalize without leaking API paths", () => {
  const values = keys();
  delete values.FARMOS_WEB_URL;
  delete values.FARMOS_API_URL;
  values.DOMAIN = "https://farm.example/";
  values.BACKEND_API_URL = "https://api.example/api/v1/telemetry";
  const resolved = resolveConfig(values);
  assert.equal(resolved.webUrl, "https://farm.example");
  assert.equal(resolved.apiUrl, "https://api.example");
  assert.equal(resolved.warnings.length, 2);
});

test("production rejects insecure canonical URLs and mismatched enrollment public key", () => {
  const values = keys();
  values.FARMOS_WEB_URL = "http://farm.example";
  values.FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const result = checkConfig(values);
  assert.ok(result.errors.some((error) => error.includes("FARMOS_WEB_URL") && error.includes("HTTPS")));
  assert.ok(result.errors.some((error) => error.includes("does not match")));
});

test("generated contract is a strict non-secret whitelist", () => {
  const contract = generatedContract({ webUrl: "https://farm.example", apiUrl: "https://api.example", sourceKeys: { web: "FARMOS_WEB_URL", api: "FARMOS_API_URL" } });
  assert.deepEqual(Object.keys(contract).sort(), ["apiUrl", "schemaVersion", "simulatorApiUrl", "sourceKeys", "webUrl"].sort());
  assert.equal(JSON.stringify(contract).includes("JWT_SECRET"), false);
});
