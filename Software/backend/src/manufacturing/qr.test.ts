import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import vector from "./attestation-vector.json";
import { attestationMessage, attestationNonce, canonicalizeQrV3, decodeBase64Url, encodeBase64Url, isAttestationAlgorithmAllowed, publicKeyFingerprint, qrKeyId, signQrV3, verifyDeviceAttestation, verifyDeviceAttestationForFirmware, verifyQrV3 } from "./qr";

test("QR v3 signing is canonical, verifiable, and contains only public identity fields", () => {
  const unsigned = {
    v: 3 as const,
    issuer: "farmos",
    qrId: "QR3-UNIT-01",
    deviceId: "NODE-UNIT-01",
    serial: "SN-UNIT-01",
    type: "SENSOR_NODE",
    model: "MODEL-A",
    hardwareRevision: "REV_A",
    kid: qrKeyId(),
  };
  const payload = signQrV3(unsigned);
  assert.equal(verifyQrV3(payload).sig, payload.sig);
  assert.equal(canonicalizeQrV3(unsigned), JSON.stringify(unsigned));
  assert.equal("claim" in payload, false);
  assert.throws(() => verifyQrV3({ ...payload, serial: "SPOOFED" }), /invalid|unavailable/i);
  assert.throws(() => verifyQrV3({ ...payload, extra: "setup-secret" }), /unsupported fields/i);
});

test("device claim attestation verifies against stored Ed25519 public key", () => {
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const challenge = "claim-session-challenge";
  const context = {
    deviceId: "NODE-TEST-01",
    sessionId: "session-test-01",
    provisioningToken: challenge,
    nonce: decodeBase64Url(attestationNonce(challenge)),
    identityVersion: 3,
  };
  const signature = encodeBase64Url(sign(null, attestationMessage(context), pair.privateKey));
  assert.equal(verifyDeviceAttestation(publicKey, attestationMessage(context), signature), true);
  assert.equal(verifyDeviceAttestation(publicKey, attestationMessage({ ...context, sessionId: "different" }), signature), false);
  assert.equal(publicKeyFingerprint(publicKey).length, 64);
});

test("firmware attestation transcript vector stays canonical", () => {
  const nonce = decodeBase64Url(vector.vector.nonce);
  const digest = attestationMessage({
    deviceId: vector.vector.deviceId,
    sessionId: vector.vector.sessionId,
    provisioningToken: vector.vector.provisioningToken,
    nonce,
    identityVersion: vector.vector.identityVersion,
  });
  assert.equal(digest.toString("hex"), vector.vector.transcriptDigest);
  assert.equal(verifyDeviceAttestationForFirmware(vector.vector.publicKeySpki, "ecdsa-p256-sha256", "ESP32S3_LORA_SENSOR_V1", digest, vector.vector.signature), true);
  assert.equal(verifyDeviceAttestationForFirmware(vector.vector.publicKeySpki, "ecdsa-p256-sha256", "ESP32S3_LORA_SENSOR_V1", Buffer.from(vector.vector.provisioningToken, "utf8"), vector.vector.signature), false);
  assert.equal(publicKeyFingerprint(vector.vector.publicKeySpki), vector.vector.publicKeyFingerprint);
});

test("production ESP32-S3 targets require ECDSA P-256 attestation", () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const target = "ESP32S3_LORA_SENSOR_V1";
  const message = attestationMessage({
    deviceId: "NODE_7",
    sessionId: "session-p256",
    provisioningToken: "challenge-p256",
    nonce: decodeBase64Url(attestationNonce("challenge-p256")),
    identityVersion: 3,
  });
  const signature = encodeBase64Url(sign("sha256", message, pair.privateKey));

  assert.equal(isAttestationAlgorithmAllowed(publicKey, target), true);
  assert.equal(verifyDeviceAttestationForFirmware(publicKey, "ecdsa-p256-sha256", target, message, signature), true);

  const ed25519 = generateKeyPairSync("ed25519");
  const edPublic = ed25519.publicKey.export({ format: "pem", type: "spki" }).toString();
  assert.equal(isAttestationAlgorithmAllowed(edPublic, target), false);
  assert.equal(verifyDeviceAttestationForFirmware(edPublic, "ed25519", target, message, signature), false);
});
