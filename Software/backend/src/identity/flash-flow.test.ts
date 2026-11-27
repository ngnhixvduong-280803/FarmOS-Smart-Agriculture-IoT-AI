import assert from "node:assert/strict";
import { test } from "node:test";
import { FlashJobMode } from "@prisma/client";
import { canRefreshSerialEnrollmentTicket, completedIdentityMaterial, flashPreflightDecision, shouldUpdateNormalReflashNode } from "./flash-flow";

test("flash preflight refuses a registered Node when Gateway is selected before any write", () => {
  const existingNode = { targetType: "GATEWAY" as const, currentDeviceType: "SENSOR_NODE", currentIdentityState: "READY_TO_SHIP", currentGenerationState: "ACTIVE", boardState: "ACTIVE", hasRelease: true };
  assert.deepEqual(flashPreflightDecision(existingNode), { ready: false, typeMismatch: true, reason: "TYPE_MISMATCH" });
  assert.deepEqual(flashPreflightDecision({ ...existingNode, currentDeviceType: "GATEWAY", hasRelease: false }), { ready: false, typeMismatch: false, reason: "NO_RELEASE" });
  assert.deepEqual(flashPreflightDecision({ ...existingNode, currentDeviceType: "GATEWAY", boardState: "BLOCKED" }), { ready: false, typeMismatch: false, reason: "BOARD_UNAVAILABLE" });
  assert.deepEqual(flashPreflightDecision({ ...existingNode, currentDeviceType: "GATEWAY", currentIdentityState: "REVOKED" }), { ready: false, typeMismatch: false, reason: "IDENTITY_UNAVAILABLE" });
  assert.deepEqual(flashPreflightDecision({ ...existingNode, currentDeviceType: "GATEWAY" }), { ready: true, typeMismatch: false, reason: null });
});

const refreshInput = {
  sameSession: false,
  operation: "REFLASH",
  mode: FlashJobMode.NORMAL_REFLASH,
  sourceDeviceId: "NODE_7",
  currentIdentityDeviceId: "NODE_7",
  boundPublicKey: "key-7",
  enrollmentPublicKey: "key-7",
  currentIdentityFingerprint: "key-7",
  existingOperation: "REFLASH",
};

test("serial ticket refresh is limited to the same active normal-reflash identity/key", () => {
  assert.equal(canRefreshSerialEnrollmentTicket(refreshInput), true);
  assert.equal(canRefreshSerialEnrollmentTicket({ ...refreshInput, boundPublicKey: "pem-key", enrollmentPublicKey: "pem-key", enrollmentPublicKeyFingerprint: "key-7" }), true, "the bound PEM and stored fingerprint are separate checks");
  assert.equal(canRefreshSerialEnrollmentTicket({ ...refreshInput, enrollmentPublicKeyFingerprint: "other-fingerprint" }), false);
  assert.equal(canRefreshSerialEnrollmentTicket({ ...refreshInput, sameSession: true }), false);
  assert.equal(canRefreshSerialEnrollmentTicket({ ...refreshInput, mode: FlashJobMode.RESET_REPROVISION }), false);
  assert.equal(canRefreshSerialEnrollmentTicket({ ...refreshInput, sourceDeviceId: null }), false);
  assert.equal(canRefreshSerialEnrollmentTicket({ ...refreshInput, currentIdentityDeviceId: "NODE_8" }), false);
  assert.equal(canRefreshSerialEnrollmentTicket({ ...refreshInput, enrollmentPublicKey: "other-key" }), false);
  assert.equal(canRefreshSerialEnrollmentTicket({ ...refreshInput, existingOperation: "ENROLL" }), false);
});

test("only a normal reflash of the same identity may update an operational Node", () => {
  assert.equal(shouldUpdateNormalReflashNode({
    mode: FlashJobMode.NORMAL_REFLASH,
    sourceDeviceId: "NODE_7",
    currentIdentityDeviceId: "NODE_7",
    resultingDeviceId: "NODE_7",
  }), true);
  assert.equal(shouldUpdateNormalReflashNode({
    mode: FlashJobMode.RESET_REPROVISION,
    sourceDeviceId: "NODE_7",
    currentIdentityDeviceId: "NODE_7",
    resultingDeviceId: "NODE_8",
  }), false);
  assert.equal(shouldUpdateNormalReflashNode({
    mode: FlashJobMode.NORMAL_REFLASH,
    sourceDeviceId: null,
    currentIdentityDeviceId: null,
    resultingDeviceId: "NODE_8",
  }), false);
  assert.equal(shouldUpdateNormalReflashNode({
    mode: FlashJobMode.NORMAL_REFLASH,
    sourceDeviceId: "NODE_7",
    currentIdentityDeviceId: "NODE_7",
    resultingDeviceId: "NODE_8",
  }), false);
});

test("new REV_B enrollment keeps the board revision and ticket model for inventory and QR", () => {
  const material = completedIdentityMaterial({
    role: "NODE",
    releaseFirmwareTarget: "ESP32S3_LORA_SENSOR_V1",
    boardHardwareRevision: "REV_B",
    ticketHardwareRevision: "REV_B",
    ticketModel: "NODE_V2",
    ticketFirmwareTarget: "ESP32S3_LORA_SENSOR_V1",
    ticketRole: "NODE",
  });
  assert.deepEqual(material, {
    hardwareRevision: "REV_B",
    model: "NODE_V2",
    firmwareTarget: "ESP32S3_LORA_SENSOR_V1",
  });
  assert.throws(() => completedIdentityMaterial({
    role: "NODE",
    releaseFirmwareTarget: "ESP32S3_LORA_SENSOR_V1",
    boardHardwareRevision: "REV_B",
    ticketHardwareRevision: "REV_A",
    ticketFirmwareTarget: "ESP32S3_LORA_SENSOR_V1",
    ticketRole: "NODE",
  }), /hardware revision/);
});

 test("desktop enrollment blocks registered boards and permits deleted/new boards", () => {
  const input = { targetType: "GATEWAY" as const, currentDeviceType: "GATEWAY", currentIdentityState: "INVENTORY", currentGenerationState: "ACTIVE", boardState: "ACTIVE", hasRelease: true, requireNewDevice: true };
  assert.equal(flashPreflightDecision(input).reason, "DEVICE_ALREADY_EXISTS");
  assert.equal(flashPreflightDecision(input).ready, false);
  assert.equal(flashPreflightDecision({ ...input, currentDeviceType: null }).ready, true);
});
