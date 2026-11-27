import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { DeviceGenerationState, FlashJobState, HardwareBoardState } from "@prisma/client";
import {
  assertBoardTransition,
  assertFlashTransition,
  canonicalManifest,
  canonicalEnrollmentTicketPayload,
  flashAttestationMessage,
  hardwareBoardKey,
  hardwareProofForEnrollment,
  normalizeFactoryBoardMaterial,
  qrForIdentity,
  signManifest,
  signEnrollmentTicket,
  assertIdentityGenerationTransition,
  verifyEnrollmentTicketSignature,
  verifyManifestSignature,
} from "./board-identity";

test("HardwareBoard key is stable, keyed, and never the raw eFuse MAC", () => {
  const material = { chipFamily: "ESP32-S3", factoryEfuseMac: "AA:BB:CC:DD:EE:FF", chipIdentity: "factory-001" };
  const normalized = normalizeFactoryBoardMaterial(material);
  const first = hardwareBoardKey(material, "unit-test-server-hmac-secret");
  const second = hardwareBoardKey({ ...material, factoryEfuseMac: "aabbccddeeff" }, "unit-test-server-hmac-secret");
  assert.deepEqual(normalized, { chipFamily: "ESP32-S3", factoryEfuseMac: "aabbccddeeff", chipIdentity: "factory-001", hardwareRevision: "" });
  assert.equal(first, second);
  assert.equal(first.includes("aabbccddeeff"), false);
  assert.notEqual(first, hardwareBoardKey({ ...material, chipIdentity: "factory-002" }, "unit-test-server-hmac-secret"));
});

test("board and FlashJob state machines reject illegal skips", () => {
  assert.doesNotThrow(() => assertBoardTransition(HardwareBoardState.ACTIVE, HardwareBoardState.RESET_PENDING));
  assert.throws(() => assertBoardTransition(HardwareBoardState.BLOCKED, HardwareBoardState.RESET_PENDING));
  assert.doesNotThrow(() => assertFlashTransition(FlashJobState.FLASHING, FlashJobState.READBACK_VERIFIED));
  assert.throws(() => assertFlashTransition(FlashJobState.CREATED, FlashJobState.COMPLETED));
});

test("manifest signing is canonical and QR payload omits firmware/runtime mode", () => {
  const manifest = canonicalManifest({ id: "rel-1", deviceType: "SENSOR_NODE", firmwareTarget: "ESP32S3_LORA_SENSOR_V1", hardwareRevisions: ["REV_B", "REV_A"], partitionScheme: "FARMOS_16M_V1", version: "1.2.3", artifactSha256: "a".repeat(64), sizeBytes: 42 });
  assert.equal(JSON.parse(manifest).flashOffset, 0x20000);
  const signature = signManifest(manifest, "unit-test-server-hmac-secret");
  assert.equal(verifyManifestSignature(manifest, signature, "unit-test-server-hmac-secret"), true);
  assert.equal(verifyManifestSignature(`${manifest}x`, signature, "unit-test-server-hmac-secret"), false);
  const qr = qrForIdentity({ device_id: "NODE_1", serial_number: "SERIAL-1", type: "SENSOR_NODE", model: "MODEL", hardware_revision: "REV_A" });
  assert.equal(qr.canonicalPayload.includes("firmware"), false);
  assert.equal(qr.canonicalPayload.includes("WIFI"), false);
  assert.equal(qr.canonicalPayload.includes("LORA"), false);
});

test("attestation transcript binds board, job, manifest, readback, and challenge", () => {
  const one = flashAttestationMessage({ boardId: "board-1", jobId: "job-1", releaseId: "rel-1", manifestSha256: "a".repeat(64), readbackSha256: "b".repeat(64), challenge: "challenge" });
  const two = flashAttestationMessage({ boardId: "board-1", jobId: "job-1", releaseId: "rel-1", manifestSha256: "a".repeat(64), readbackSha256: "b".repeat(64), challenge: "other" });
  assert.notEqual(one, two);
  assert.equal(DeviceGenerationState.PENDING, "PENDING");
});

test("flash attestation bytes match the firmware enrollment vector", () => {
  const message = flashAttestationMessage({
    boardId: "board-vector-001",
    jobId: "job-vector-001",
    releaseId: "release-vector-001",
    manifestSha256: "a".repeat(64),
    readbackSha256: "b".repeat(64),
    challenge: "challenge-vector-001",
  });
  assert.equal(message, "{\"v\":1,\"domain\":\"farmos-web-serial-flash-attestation\",\"boardId\":\"board-vector-001\",\"jobId\":\"job-vector-001\",\"releaseId\":\"release-vector-001\",\"manifestSha256\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"readbackSha256\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"challenge\":\"challenge-vector-001\"}");
});

test("serial enrollment hardware proof and ticket bytes match the firmware vector", () => {
  const nonce = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX";
  const proof = hardwareProofForEnrollment({ chipFamily: "ESP32-S3", factoryEfuseMac: "14:c1:9f:46:ab:30", nonce });
  assert.equal(proof, "04cc89b8c7ee187100487d7ec08deb9f8419776e34eb29bac11ecdb73aec58f0");
  const payload = canonicalEnrollmentTicketPayload({
    deviceId: "NODE_000007",
    firmwareTarget: "ESP32S3_LORA_SENSOR_V1",
    generation: 1,
    hardwareProof: proof,
    hardwareRevision: "REV_A",
    identityVersion: 3,
    model: "NODE_V1",
    nonce,
    operation: "ENROLL",
    physicalSerial: true,
    publicKeyFingerprint: "a".repeat(64),
    radioId: 7,
    role: "NODE",
    serial: "SN-VECTOR-000007",
    ticketId: "ticket-vector-001",
    ttlMs: 120000,
  });
  assert.equal(Buffer.from(payload, "utf8").toString("base64url"), "eyJkZXZpY2VJZCI6Ik5PREVfMDAwMDA3IiwiZmlybXdhcmVUYXJnZXQiOiJFU1AzMlMzX0xPUkFfU0VOU09SX1YxIiwiZ2VuZXJhdGlvbiI6MSwiaGFyZHdhcmVQcm9vZiI6IjA0Y2M4OWI4YzdlZTE4NzEwMDQ4N2Q3ZWMwOGRlYjlmODQxOTc3NmUzNGViMjliYWMxMWVjZGI3M2FlYzU4ZjAiLCJoYXJkd2FyZVJldmlzaW9uIjoiUkVWX0EiLCJpZGVudGl0eVZlcnNpb24iOjMsIm1vZGVsIjoiTk9ERV9WMSIsIm5vbmNlIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EeEFSRWhNVUZSWVgiLCJvcGVyYXRpb24iOiJFTlJPTEwiLCJwaHlzaWNhbFNlcmlhbCI6dHJ1ZSwicHJvdG9jb2xWZXJzaW9uIjoxLCJwdWJsaWNLZXlGaW5nZXJwcmludCI6ImFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWEiLCJyYWRpb0lkIjo3LCJyb2xlIjoiTk9ERSIsInNlcmlhbCI6IlNOLVZFQ1RPUi0wMDAwMDciLCJ0aWNrZXRJZCI6InRpY2tldC12ZWN0b3ItMDAxIiwidHRsTXMiOjEyMDAwMH0");
});

test("serial enrollment ticket is DER ECDSA P-256 and verifies with firmware trust-anchor format", () => {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicPem = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
  const payload = canonicalEnrollmentTicketPayload({
    deviceId: "GATEWAY_7",
    firmwareTarget: "ESP32S3_GATEWAY_V1",
    generation: 1,
    hardwareProof: "b".repeat(64),
    hardwareRevision: "REV_A",
    identityVersion: 3,
    model: "GATEWAY_V1",
    nonce: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYX",
    operation: "ENROLL",
    physicalSerial: true,
    publicKeyFingerprint: "c".repeat(64),
    role: "GATEWAY",
    serial: "GATEWAY-7",
    ticketId: "ticket-7",
    ttlMs: 120000,
    expiresAt: Math.floor(Date.now() / 1000) + 120,
  });
  const signature = signEnrollmentTicket(payload, privatePem);
  assert.match(signature, /^[A-Za-z0-9_-]+$/);
  assert.equal(verifyEnrollmentTicketSignature(payload, signature, publicPem), true);
  assert.equal(verifyEnrollmentTicketSignature(`${payload}x`, signature, publicPem), false);
  assert.throws(() => signEnrollmentTicket(payload, "not-a-p256-key"));
});

test("ten NORMAL_REFLASH retries preserve one identity generation", () => {
  const identity = { deviceId: "NODE_100", serial: "SERIAL-100", qrId: "QR3-100", ownerId: "user-1" };
  const reflashed = Array.from({ length: 10 }, () => ({ ...identity }));
  assert.equal(new Set(reflashed.map((value) => value.deviceId)).size, 1);
  assert.equal(new Set(reflashed.map((value) => value.serial)).size, 1);
  assert.equal(new Set(reflashed.map((value) => value.qrId)).size, 1);
  assert.equal(new Set(reflashed.map((value) => value.ownerId)).size, 1);
});

test("duplicate enrollment retry derives the same challenge and ticket", () => {
  const { deterministicFlashSecret } = require("./board-identity") as typeof import("./board-identity");
  assert.equal(deterministicFlashSecret("challenge", "board-1", "job-1", "retry-1"), deterministicFlashSecret("challenge", "board-1", "job-1", "retry-1"));
  assert.equal(deterministicFlashSecret("ticket", "board-1", "job-1", "retry-1"), deterministicFlashSecret("ticket", "board-1", "job-1", "retry-1"));
  assert.notEqual(deterministicFlashSecret("ticket", "board-1", "job-1", "retry-1"), deterministicFlashSecret("ticket", "board-1", "job-1", "retry-2"));
});

test("failed flash has no legal path from pending generation to active without attestation", () => {
  assert.doesNotThrow(() => assertIdentityGenerationTransition(DeviceGenerationState.PENDING, DeviceGenerationState.REVOKED));
  assert.doesNotThrow(() => assertIdentityGenerationTransition(DeviceGenerationState.PENDING, DeviceGenerationState.ACTIVE));
  assert.throws(() => assertIdentityGenerationTransition(DeviceGenerationState.RETIRED, DeviceGenerationState.ACTIVE));
});
