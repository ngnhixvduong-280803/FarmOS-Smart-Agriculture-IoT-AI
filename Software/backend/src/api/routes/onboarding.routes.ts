import { randomUUID } from "crypto";
import { NextFunction, Request, Response, Router } from "express";
import { DeviceClaimSessionStatus, DeviceIdentityState, DeviceLifecycleEventType, DeviceQrLabelState, NodeConnectionMode } from "@prisma/client";
import { prisma } from "../../database/prisma";
import { publishMqttMessage } from "../../mqtt/mqtt.client";
import { gatewayTelemetrySchema } from "../../security/gateway-telemetry";
import { broadcastTelemetry } from "../../websocket/socket.server";
import { createOpaqueToken, hashDeviceSecret, isProvisioningSessionUsable, matchesDeviceSecret, pairingRadioToken, gatewaySessionToken } from "../../security/device-secrets";
import { AuthRequest, authenticate } from "../middleware/auth.middleware";
import { GatewayRequest, requireGatewayAuth } from "../middleware/gateway-auth.middleware";
import { attestationMessage, attestationNonce, decodeBase64Url, parseQrPayload, verifyDeviceAttestationForFirmware, verifyQrV3 } from "../../manufacturing/qr";
import { assertTransition, recordLifecycleEvent } from "../../manufacturing/lifecycle";
import { isLegacyIdentity, isReleasedV3Identity, legacyProvisioningEnabled } from "../../security/provisioning";
import { releaseDeviceAccount } from "../../security/device-access";
import { isNodeOnline } from "../../telemetry/node-presence";

const router = Router();
const GATEWAY_SESSION_MS = 10 * 60_000;
const PAIRING_SESSION_MS = 5 * 60_000;
type DeploymentMode = "GATEWAY" | "LEAF_NODE" | "STANDALONE_NODE";

const PRINTED_QR_STATES: DeviceQrLabelState[] = [DeviceQrLabelState.PRINTED, DeviceQrLabelState.REPRINTED];

function onboardingError(error: unknown, fallback: string, status = 500): { status: number; message: string } {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "P2002") return { status: 409, message: "Một phiên cài đặt tương tự đã tồn tại" };
  const detail = error instanceof Error ? error.message : "";
  if (/signing key is unavailable|QR signing key|QR_PUBLIC_KEYS/i.test(detail)) {
    return { status: 503, message: "QR verification is not configured" };
  }
  // Domain validation errors are returned explicitly at the call sites. Any
  // exception reaching a catch block is an internal/database/crypto detail
  // and must not be reflected to an unauthenticated or farm user.
  return { status, message: fallback };
}

function isClaimableQrLabel(state: DeviceQrLabelState, identity: { identity_version: number; state: DeviceIdentityState }): boolean {
  // Manufacturing-issued labels must still pass the physical print/QC gate.
  // A Web Serial replacement, however, creates its signed QR at the moment
  // post-flash readback is attested and has no second print-confirmation API.
  // Only that already-released v3 identity may use ISSUED directly; legacy or
  // pre-QC manufacturing rows remain blocked.
  return PRINTED_QR_STATES.includes(state) ||
    (state === DeviceQrLabelState.ISSUED && isReleasedV3Identity(identity));
}

function isNumericRadioDeviceId(value: string, type: "GATEWAY" | "SENSOR_NODE"): boolean {
  const prefix = type === "GATEWAY" ? "GATEWAY" : "NODE";
  const match = new RegExp(`^${prefix}_[0-9]+$`).exec(value.trim());
  if (!match) return false;
  try {
    const suffix = BigInt(value.slice(prefix.length + 1));
    return suffix > 0n && suffix <= 0xffffffffn;
  } catch {
    return false;
  }
}

function hasSupportedIdentityType(type: string): type is "GATEWAY" | "SENSOR_NODE" {
  return type === "GATEWAY" || type === "SENSOR_NODE";
}

function requireLegacyV2(_req: Request, res: Response, next: NextFunction): void {
  if (!legacyProvisioningEnabled()) {
    res.status(410).json({ success: false, error: "Legacy v2 provisioning is disabled; use QR v3 claim" });
    return;
  }
  next();
}

async function hasFarmAccess(user: NonNullable<AuthRequest["user"]>, farmId: string): Promise<boolean> {
  if (user.role === "ADMIN") return Boolean(await prisma.farm.findUnique({ where: { id: farmId }, select: { id: true } }));
  return Boolean(await prisma.userFarm.findUnique({
    where: { user_id_farm_id: { user_id: user.id, farm_id: farmId } },
    select: { user_id: true },
  }));
}

function publicGateway(node: any) {
  return {
    id: node.id,
    serialNumber: node.serial_number,
    name: node.name || node.id,
    farmId: node.farm_id,
    online: isNodeOnline(node),
    lastSeen: node.last_seen,
    firmwareVersion: node.firmware_version,
    connectionMode: node.connection_mode,
    deploymentMode: node.deployment_mode,
    capabilities: node.capabilities,
  };
}

function identityCapabilities(identity: { type: string; capabilities: string[] }): string[] {
  if (identity.capabilities.length) return identity.capabilities;
  return identity.type === "GATEWAY"
    ? ["WIFI", "LORA", "GATEWAY", "LOCAL_SENSOR"]
    : ["WIFI", "LORA", "SENSOR_DS18B20"];
}

function allowedModes(identity: { type: string; capabilities: string[] }): DeploymentMode[] {
  const capabilities = identityCapabilities(identity);
  const modes: DeploymentMode[] = [];
  if (capabilities.includes("GATEWAY")) modes.push("GATEWAY");
  if (capabilities.includes("LORA") && capabilities.some(value => value.startsWith("SENSOR_"))) modes.push("LEAF_NODE");
  if (capabilities.includes("WIFI") && capabilities.some(value => value.startsWith("SENSOR_"))) modes.push("STANDALONE_NODE");
  return modes;
}

async function checkedQrIdentity(deviceId: string, claimCode: string) {
  const identity = await prisma.deviceIdentity.findUnique({ where: { device_id: deviceId } });
  if (!identity || !matchesDeviceSecret(`claim:${deviceId}`, identity.claim_code_hash, claimCode)) return null;
  return identity;
}

function parseV3RequestPayload(req: Request): unknown {
  return parseQrPayload(req.body?.payload ?? req.body?.qrPayload ?? req.body);
}

function publicV3Identity(identity: any) {
  return {
    deviceId: identity.device_id,
    serial: identity.serial_number,
    type: identity.type,
    model: identity.model,
    hardwareRevision: identity.hardware_revision,
    firmwareTarget: identity.firmware_target,
    partitionScheme: identity.partition_scheme,
    capabilities: identity.capabilities,
    publicKeyAlgorithm: identity.public_key_algorithm,
    publicKeyFingerprint: identity.public_key_fingerprint,
    identityVersion: identity.identity_version,
    state: identity.state,
  };
}

async function hardwareBoardAllowsIdentity(identity: any): Promise<boolean> {
  if (!identity?.hardware_board_id) return true;
  const board = await prisma.hardwareBoard.findUnique({ where: { id: identity.hardware_board_id }, select: { state: true } });
  return Boolean(board && board.state !== "BLOCKED" && board.state !== "UNBOUND");
}

async function resolveV3Qr(req: Request, res: Response) {
  try {
    const payload = verifyQrV3(parseV3RequestPayload(req));
    const label = await prisma.deviceQrLabel.findUnique({ where: { qr_id: payload.qrId }, include: { device: true } });
    if (!label || label.version !== 3 || label.issuer !== payload.issuer || label.kid !== payload.kid ||
        label.state === DeviceQrLabelState.REVOKED || label.state === DeviceQrLabelState.QUARANTINED) {
      return res.status(404).json({ success: false, error: "QR v3 không tồn tại hoặc đã bị vô hiệu hóa" });
    }
    const identity = label.device;
    if (!(await hardwareBoardAllowsIdentity(identity))) {
      return res.status(409).json({ success: false, error: "HardwareBoard is blocked or unbound" });
    }
    if (!hasSupportedIdentityType(identity.type) || !isNumericRadioDeviceId(identity.device_id, identity.type)) {
      return res.status(409).json({ success: false, error: "Factory identity dùng device ID không phải numeric radio ID" });
    }
    const expectedModel = identity.model || "unknown";
    if (payload.deviceId !== identity.device_id || payload.serial !== identity.serial_number ||
        payload.type !== identity.type || payload.model !== expectedModel ||
        payload.hardwareRevision !== identity.hardware_revision ||
        payload.issuer !== label.issuer || payload.kid !== label.kid || payload.sig !== label.signature) {
      return res.status(409).json({ success: false, error: "QR v3 không khớp factory identity" });
    }
    if (!isReleasedV3Identity(identity) || !isClaimableQrLabel(label.state, identity)) {
      return res.status(409).json({ success: false, error: "QR/device chưa qua release gate READY_TO_SHIP" });
    }
    return res.json({ success: true, data: {
      payload,
      identity: publicV3Identity(identity),
      claimable: isReleasedV3Identity(identity),
    } });
  } catch (error: any) {
    const failure = onboardingError(error, "QR v3 không hợp lệ", 400);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

// QR v3 is public metadata plus a signature. It contains no setup secret or
// private key, so a phone can resolve it before an authenticated claim flow.
router.post("/qr/resolve", resolveV3Qr);
router.post("/devices/resolve-qr-v3", resolveV3Qr);

const createQrClaimSession = async (req: AuthRequest, res: Response) => {
  try {
    const payload = verifyQrV3(parseV3RequestPayload(req));
    const user = req.user!;
    const farmId = String(req.body.farmId || "").trim();
    const zoneId = req.body.zoneId ? String(req.body.zoneId).trim() : null;
    const requestedMode = String(req.body.deploymentMode || "").trim().toUpperCase();
    if (!farmId || !["GATEWAY", "LEAF_NODE", "STANDALONE_NODE"].includes(requestedMode)) {
      return res.status(400).json({ success: false, error: "Thiếu farmId hoặc deploymentMode hợp lệ" });
    }
    if (!(await hasFarmAccess(user, farmId))) return res.status(403).json({ success: false, error: "Bạn không có quyền với Farm này" });
    const label = await prisma.deviceQrLabel.findUnique({ where: { qr_id: payload.qrId }, include: { device: true } });
    if (!label || label.state === DeviceQrLabelState.REVOKED || label.state === DeviceQrLabelState.QUARANTINED || label.device.state === DeviceIdentityState.REVOKED || label.device.state === DeviceIdentityState.QUARANTINED) {
      return res.status(409).json({ success: false, error: "QR hoặc thiết bị không còn hợp lệ" });
    }
    const identity = label.device;
    if (!(await hardwareBoardAllowsIdentity(identity))) {
      return res.status(409).json({ success: false, error: "HardwareBoard is blocked or unbound" });
    }
    if (!hasSupportedIdentityType(identity.type) || !isNumericRadioDeviceId(identity.device_id, identity.type)) {
      return res.status(409).json({ success: false, error: "Factory identity dùng device ID không phải numeric radio ID" });
    }
    if (payload.deviceId !== identity.device_id || payload.serial !== identity.serial_number || payload.type !== identity.type || payload.model !== (identity.model || "unknown") || payload.hardwareRevision !== identity.hardware_revision || payload.sig !== label.signature) {
      return res.status(409).json({ success: false, error: "QR không khớp factory identity" });
    }
    if (!identity.public_key || !identity.public_key_algorithm) {
      return res.status(409).json({ success: false, error: "Thiết bị chưa có public key factory để attest" });
    }
    if (!isReleasedV3Identity(identity) || !isClaimableQrLabel(label.state, identity)) {
      return res.status(409).json({ success: false, error: `Thiết bị đang ở trạng thái ${identity.state}` });
    }
    if ((identity.type === "GATEWAY" && requestedMode !== "GATEWAY") || (identity.type !== "GATEWAY" && requestedMode === "GATEWAY")) {
      return res.status(400).json({ success: false, error: "Deployment mode không khớp loại thiết bị" });
    }
    if (!allowedModes(identity).includes(requestedMode as DeploymentMode)) {
      return res.status(400).json({ success: false, error: "Phần cứng không hỗ trợ deployment mode đã chọn" });
    }
    if (identity.claimed_by_id && identity.claimed_by_id !== user.id && user.role !== "ADMIN") return res.status(409).json({ success: false, error: "Thiết bị đã thuộc tài khoản khác" });
    if (zoneId) {
      const zone = await prisma.zone.findUnique({ where: { id: zoneId }, select: { farm_id: true } });
      if (!zone || zone.farm_id !== farmId) return res.status(400).json({ success: false, error: "Zone không thuộc Farm đã chọn" });
    }
    const idempotencyKey = req.header("Idempotency-Key")?.trim() || `claim-${randomUUID()}`;
    const existing = await prisma.deviceClaimSession.findUnique({ where: { idempotency_key: idempotencyKey }, include: { device: true } });
    if (existing && existing.user_id === user.id) {
      return res.status(200).json({ success: true, idempotent: true, data: {
        sessionId: existing.id,
        deviceId: existing.device_id,
        challenge: existing.challenge,
        // These values are ephemeral claim-session material, never QR data.
        // Firmware needs both fields to build its canonical transcript.
        provisioningToken: existing.challenge,
        nonce: attestationNonce(existing.challenge),
        identityVersion: existing.device.identity_version,
        expiresAt: existing.expires_at,
        status: existing.status,
      } });
    }
    const challenge = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    // BLE pairing firmware accepts a maximum five-minute grant. Keep a LEAF
    // claim and its derived pairing session on that same expiry boundary.
    const expiresAt = new Date(Date.now() + (requestedMode === "LEAF_NODE" ? PAIRING_SESSION_MS : 10 * 60_000));
    const session = await prisma.$transaction(async (tx) => {
      await tx.deviceClaimSession.updateMany({ where: { device_id: identity.device_id, user_id: user.id, status: DeviceClaimSessionStatus.CHALLENGE_ISSUED }, data: { status: DeviceClaimSessionStatus.CANCELLED } });
      const created = await tx.deviceClaimSession.create({ data: {
        device_id: identity.device_id,
        user_id: user.id,
        farm_id: farmId,
        zone_id: zoneId,
        deployment_mode: requestedMode,
        status: DeviceClaimSessionStatus.CHALLENGE_ISSUED,
        challenge,
        challenge_hash: hashDeviceSecret(`claim-session:${identity.device_id}`, challenge),
        expires_at: expiresAt,
        idempotency_key: idempotencyKey,
      } });
      await recordLifecycleEvent(tx, {
        deviceId: identity.device_id,
        batchId: identity.batch_id,
        eventType: DeviceLifecycleEventType.CLAIM_CHALLENGE_ISSUED,
        fromState: identity.state,
        toState: identity.state,
        actorType: "USER",
        actorId: user.id,
        idempotencyKey: `claim-event:${idempotencyKey}`,
        metadata: { sessionId: created.id, deploymentMode: requestedMode },
      });
      return created;
    });
    return res.status(201).json({ success: true, data: {
      sessionId: session.id,
      deviceId: session.device_id,
      challenge: session.challenge,
      provisioningToken: session.challenge,
      nonce: attestationNonce(session.challenge),
      identityVersion: identity.identity_version,
      expiresAt: session.expires_at,
      status: session.status,
    } });
  } catch (error: any) {
    const failure = onboardingError(error, "Không tạo được claim session", 400);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
};

/**
 * A claimed sensor can change transport without being treated as a new
 * factory generation.  This deliberately reuses DeviceClaimSession as a
 * short-lived, attested operation record: the physical mode is not changed
 * until the resulting provisioning/pairing session is redeemed/confirmed.
 * The factory identity and printed QR therefore remain untouched.
 */
router.post("/devices/:deviceId/mode-sessions", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const deviceId = String(req.params.deviceId || "").trim();
    const farmId = String(req.body.farmId || "").trim();
    const requestedMode = String(req.body.deploymentMode || "").trim().toUpperCase() as DeploymentMode;
    const wifiReconfigure = req.body.wifiReconfigure === true;
    const requestedZoneId = req.body.zoneId ? String(req.body.zoneId).trim() : null;
    const requestedGatewayId = req.body.gatewayId ? String(req.body.gatewayId).trim() : null;
    if (!deviceId || !farmId || !["GATEWAY", "LEAF_NODE", "STANDALONE_NODE"].includes(requestedMode)) {
      return res.status(400).json({ success: false, error: "Thiếu deviceId, farmId hoặc deploymentMode hợp lệ" });
    }
    if (!(await hasFarmAccess(user, farmId))) return res.status(403).json({ success: false, error: "Bạn không có quyền với Farm này" });

    const identity = await prisma.deviceIdentity.findUnique({ where: { device_id: deviceId } });
    const node = await prisma.node.findUnique({ where: { id: deviceId } });
    if (!identity || identity.identity_version < 3 || !node || !node.is_activated || identity.state !== DeviceIdentityState.CLAIMED || identity.claimed_by_id !== user.id) {
      return res.status(409).json({ success: false, error: "Thiết bị phải đang được tài khoản hiện tại claim" });
    }
    if (node.farm_id !== farmId || node.owner_id !== user.id) {
      return res.status(403).json({ success: false, error: "Thiết bị không thuộc Farm hoặc tài khoản hiện tại" });
    }
    if (wifiReconfigure ? requestedMode === "LEAF_NODE" || node.deployment_mode !== requestedMode : node.deployment_mode === requestedMode) {
      return res.status(409).json({ success: false, error: "Chế độ hiện tại không phù hợp với thao tác cài đặt" });
    }
    if (!(await hardwareBoardAllowsIdentity(identity)) || !hasSupportedIdentityType(identity.type) || !isNumericRadioDeviceId(deviceId, identity.type)) {
      return res.status(409).json({ success: false, error: "Factory identity hoặc HardwareBoard không còn hợp lệ" });
    }
    if ((identity.type === "GATEWAY" && requestedMode !== "GATEWAY") || (identity.type !== "GATEWAY" && requestedMode === "GATEWAY") ||
        !allowedModes(identity).includes(requestedMode)) {
      return res.status(400).json({ success: false, error: "Deployment mode không được phần cứng hỗ trợ" });
    }

    const zoneId = wifiReconfigure ? node.zone_id : requestedMode === "GATEWAY" ? null : requestedZoneId || node.zone_id;
    if (requestedMode !== "GATEWAY") {
      const zone = zoneId ? await prisma.zone.findUnique({ where: { id: zoneId }, select: { farm_id: true } }) : null;
      if (!zone || zone.farm_id !== farmId) return res.status(400).json({ success: false, error: "Hãy chọn Zone thuộc Farm này" });
    }
    if (requestedMode === "LEAF_NODE") {
      if (!requestedGatewayId || !isNumericRadioDeviceId(requestedGatewayId, "GATEWAY")) return res.status(400).json({ success: false, error: "LEAF_NODE cần Gateway_<numeric-radio-id>" });
      const gateway = await prisma.node.findUnique({ where: { id: requestedGatewayId }, select: { type: true, farm_id: true, is_activated: true, owner_id: true } });
      if (!gateway || gateway.type !== "GATEWAY" || !gateway.is_activated || gateway.farm_id !== farmId || gateway.owner_id !== user.id) {
        return res.status(400).json({ success: false, error: "Gateway không hoạt động trong Farm đã chọn hoặc không thuộc tài khoản" });
      }
    }

    const idempotencyKey = req.header("Idempotency-Key")?.trim() || `mode-${randomUUID()}`;
    const existing = await prisma.deviceClaimSession.findUnique({ where: { idempotency_key: idempotencyKey }, include: { device: true } });
    if (existing) {
      if (existing.user_id !== user.id || existing.device_id !== deviceId || existing.deployment_mode !== requestedMode || existing.wifi_reconfigure !== wifiReconfigure || existing.farm_id !== farmId) {
        return res.status(409).json({ success: false, error: "Idempotency key đã dùng cho mode session khác" });
      }
      return res.json({ success: true, idempotent: true, data: {
        sessionId: existing.id,
        deviceId: existing.device_id,
        challenge: existing.challenge,
        provisioningToken: existing.challenge,
        nonce: attestationNonce(existing.challenge),
        identityVersion: existing.device.identity_version,
        expiresAt: existing.expires_at,
        status: existing.status,
        identity: { deviceId, serial: existing.device.serial_number, type: existing.device.type, model: existing.device.model || "unknown", hardwareRevision: existing.device.hardware_revision },
      } });
    }

    const challenge = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + (requestedMode === "LEAF_NODE" ? PAIRING_SESSION_MS : GATEWAY_SESSION_MS));
    const session = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT device_id FROM device_identities WHERE device_id = ${deviceId} FOR UPDATE`;
      const currentIdentity = await tx.deviceIdentity.findUnique({ where: { device_id: deviceId } });
      const currentNode = await tx.node.findUnique({ where: { id: deviceId } });
      const pendingRelease = await tx.deviceLifecycleCommand.findFirst({
        where: { device_id: deviceId, type: "RELEASE_ACCOUNT", status: { in: ["PENDING", "ACKNOWLEDGED"] }, expires_at: { gt: new Date() } },
        select: { id: true },
      });
      if (pendingRelease || !currentIdentity?.is_current || currentIdentity.generation_state !== "ACTIVE" ||
          currentIdentity.state !== "CLAIMED" || currentIdentity.claimed_by_id !== user.id ||
          !currentNode?.is_activated || currentNode.owner_id !== user.id || currentNode.farm_id !== farmId ||
          currentNode.deployment_mode !== node.deployment_mode || (wifiReconfigure && currentNode.zone_id !== zoneId)) return null;
      // A timed-out physical transition must not leave a second operation
      // racing the next one. Existing active Node mode remains unchanged.
      const stale = await tx.deviceClaimSession.findMany({ where: { device_id: deviceId, user_id: user.id, status: { in: [DeviceClaimSessionStatus.CHALLENGE_ISSUED, DeviceClaimSessionStatus.ATTESTED] } }, select: { id: true } });
      if (stale.length) await tx.deviceClaimSession.updateMany({ where: { id: { in: stale.map(item => item.id) } }, data: { status: DeviceClaimSessionStatus.CANCELLED, expires_at: new Date() } });
      const pendingFinalized = await tx.deviceClaimSession.findMany({ where: { device_id: deviceId, user_id: user.id, status: DeviceClaimSessionStatus.FINALIZED }, select: { id: true } });
      if (pendingFinalized.length) {
        const ids = pendingFinalized.map(item => item.id);
        const [pendingCloud, pendingPairing] = await Promise.all([
          tx.gatewayProvisioningSession.findMany({ where: { id: { in: ids }, status: "PENDING" }, select: { id: true } }),
          tx.pairingSession.findMany({ where: { id: { in: ids }, status: { in: ["PENDING", "GATEWAY_READY"] } }, select: { id: true } }),
        ]);
        await tx.gatewayProvisioningSession.updateMany({ where: { id: { in: ids }, status: "PENDING" }, data: { status: "CANCELLED", expires_at: new Date() } });
        await tx.pairingSession.updateMany({ where: { id: { in: ids }, status: { in: ["PENDING", "GATEWAY_READY"] } }, data: { status: "CANCELLED", failure_reason: "Replaced by a newer mode transition", expires_at: new Date() } });
        const cancelledIds = [...pendingCloud, ...pendingPairing].map(item => item.id);
        if (cancelledIds.length) await tx.deviceClaimSession.updateMany({ where: { id: { in: cancelledIds }, status: DeviceClaimSessionStatus.FINALIZED }, data: { status: DeviceClaimSessionStatus.CANCELLED, expires_at: new Date() } });
      }
      const created = await tx.deviceClaimSession.create({ data: {
        device_id: deviceId,
        user_id: user.id,
        farm_id: farmId,
        zone_id: zoneId,
        deployment_mode: requestedMode,
        wifi_reconfigure: wifiReconfigure,
        status: DeviceClaimSessionStatus.CHALLENGE_ISSUED,
        challenge,
        challenge_hash: hashDeviceSecret(`claim-session:${deviceId}`, challenge),
        expires_at: expiresAt,
        idempotency_key: idempotencyKey,
      } });
      await recordLifecycleEvent(tx, { deviceId, batchId: identity.batch_id, eventType: DeviceLifecycleEventType.CLAIM_CHALLENGE_ISSUED, fromState: identity.state, toState: identity.state, actorType: "USER", actorId: user.id, idempotencyKey: `claim-event:${idempotencyKey}`, metadata: { sessionId: created.id, deploymentMode: requestedMode, modeSwitch: !wifiReconfigure, wifiReconfigure, previousMode: node.deployment_mode } });
      return created;
    });
    if (!session) return res.status(409).json({ success: false, error: "Thiết bị đã thay đổi hoặc đang chờ gỡ liên kết" });
    return res.status(201).json({ success: true, data: {
      sessionId: session.id,
      deviceId,
      challenge: session.challenge,
      provisioningToken: session.challenge,
      nonce: attestationNonce(session.challenge),
      identityVersion: identity.identity_version,
      expiresAt: session.expires_at,
      status: session.status,
      identity: { deviceId, serial: identity.serial_number, type: identity.type, model: identity.model || "unknown", hardwareRevision: identity.hardware_revision },
    } });
  } catch (error: any) {
    const failure = onboardingError(error, "Không tạo được mode session");
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.post("/qr/claim-sessions", authenticate, createQrClaimSession);
router.post("/qr/claim-session", authenticate, createQrClaimSession);

router.get("/qr/claim-sessions/:id", authenticate, async (req: AuthRequest, res: Response) => {
  const session = await prisma.deviceClaimSession.findUnique({ where: { id: req.params.id } });
  if (!session || (session.user_id !== req.user!.id && req.user!.role !== "ADMIN")) return res.status(404).json({ success: false, error: "Không tìm thấy claim session" });
  let status = session.status;
  if ((status === DeviceClaimSessionStatus.CHALLENGE_ISSUED || status === DeviceClaimSessionStatus.ATTESTED) && session.expires_at <= new Date()) {
    status = DeviceClaimSessionStatus.EXPIRED;
    await prisma.deviceClaimSession.update({ where: { id: session.id }, data: { status } });
  }
  return res.json({ success: true, data: { sessionId: session.id, deviceId: session.device_id, status, farmId: session.farm_id, zoneId: session.zone_id, deploymentMode: session.deployment_mode, expiresAt: session.expires_at, finalizedNodeId: session.finalized_node_id } });
});

router.post("/qr/claim-sessions/:id/attest", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const session = await prisma.deviceClaimSession.findUnique({ where: { id: req.params.id }, include: { device: true } });
    if (!session || (session.user_id !== req.user!.id && req.user!.role !== "ADMIN")) return res.status(404).json({ success: false, error: "Không tìm thấy claim session" });
    if (session.device.state === DeviceIdentityState.REVOKED || session.device.state === DeviceIdentityState.QUARANTINED) {
      return res.status(409).json({ success: false, error: "Thiết bị đã bị vô hiệu hóa hoặc cách ly" });
    }
    const modeSwitchSession = session.device.state === DeviceIdentityState.CLAIMED && Boolean(session.device.claimed_by_id) && session.device.claimed_by_id === session.user_id;
    if (!isReleasedV3Identity(session.device) && !modeSwitchSession) return res.status(409).json({ success: false, error: "Thiết bị chưa ở READY_TO_SHIP hoặc không còn thuộc tài khoản hiện tại" });
    if (session.status === DeviceClaimSessionStatus.ATTESTED) return res.json({ success: true, idempotent: true, data: { sessionId: session.id, status: session.status, attestedAt: session.attested_at } });
    if (session.status !== DeviceClaimSessionStatus.CHALLENGE_ISSUED || session.expires_at <= new Date()) {
      if (session.status === DeviceClaimSessionStatus.CHALLENGE_ISSUED && session.expires_at <= new Date()) await prisma.deviceClaimSession.update({ where: { id: session.id }, data: { status: DeviceClaimSessionStatus.EXPIRED } });
      return res.status(409).json({ success: false, error: "Claim challenge is expired or no longer pending" });
    }
    const signature = String(req.body.signature || req.body.attestationSignature || req.body.attestation?.signature || "").trim();
    const provisioningToken = String(req.body.provisioningToken || req.body.attestation?.provisioningToken || session.challenge).trim();
    const nonceText = String(req.body.nonce || req.body.attestation?.nonce || "").trim();
    let nonce: Buffer;
    try {
      nonce = decodeBase64Url(nonceText);
    } catch {
      nonce = Buffer.alloc(0);
    }
    const expectedNonce = attestationNonce(session.challenge);
    const attestationDigest = nonceText === expectedNonce && provisioningToken === session.challenge && nonce.length >= 16 && nonce.length <= 32
      ? attestationMessage({
          deviceId: session.device_id,
          sessionId: session.id,
          provisioningToken,
          nonce,
          identityVersion: session.device.identity_version,
        })
      : null;
    if (!matchesDeviceSecret(`claim-session:${session.device_id}`, session.challenge_hash, session.challenge) || !signature || !session.device.public_key || !session.device.public_key_algorithm || !attestationDigest || !verifyDeviceAttestationForFirmware(session.device.public_key, session.device.public_key_algorithm, session.device.firmware_target, attestationDigest, signature)) {
      return res.status(401).json({ success: false, error: "Device attestation không hợp lệ" });
    }
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT device_id FROM device_identities WHERE device_id = ${session.device_id} FOR UPDATE`;
      const currentIdentity = await tx.deviceIdentity.findUnique({ where: { device_id: session.device_id } });
      if (!currentIdentity?.is_current || currentIdentity.generation_state !== "ACTIVE" ||
          currentIdentity.public_key !== session.device.public_key ||
          (session.wifi_reconfigure
            ? currentIdentity.state !== "CLAIMED" || currentIdentity.claimed_by_id !== session.user_id
            : !isReleasedV3Identity(currentIdentity) && (currentIdentity.state !== "CLAIMED" || currentIdentity.claimed_by_id !== session.user_id))) return null;
      const changed = await tx.deviceClaimSession.updateMany({
        where: { id: session.id, status: DeviceClaimSessionStatus.CHALLENGE_ISSUED, expires_at: { gt: new Date() } },
        data: { status: DeviceClaimSessionStatus.ATTESTED, attestation_signature: signature, attestation_message: attestationDigest.toString("base64"), attested_at: now },
      });
      if (!changed.count) return null;
      await recordLifecycleEvent(tx, { deviceId: session.device_id, batchId: session.device.batch_id, eventType: DeviceLifecycleEventType.CLAIM_ATTESTED, fromState: session.device.state, toState: session.device.state, actorType: "USER", actorId: req.user!.id, idempotencyKey: `claim-attest:${session.id}`, metadata: { sessionId: session.id } });
      return tx.deviceClaimSession.findUnique({ where: { id: session.id } });
    });
    if (!updated) return res.status(409).json({ success: false, error: "Phiên cài đặt hoặc quyền sở hữu đã thay đổi" });
    return res.json({ success: true, data: { sessionId: updated.id, status: updated.status, attestedAt: updated.attested_at } });
  } catch (error: any) {
    const failure = onboardingError(error, "Không xác minh được device attestation");
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.post("/qr/claim-sessions/:id/finalize", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const session = await prisma.deviceClaimSession.findUnique({ where: { id: req.params.id }, include: { device: true } });
    if (!session || (session.user_id !== req.user!.id && req.user!.role !== "ADMIN")) return res.status(404).json({ success: false, error: "Không tìm thấy claim session" });
    if (session.status === DeviceClaimSessionStatus.FINALIZED) {
      const node = session.finalized_node_id ? await prisma.node.findUnique({ where: { id: session.finalized_node_id } }) : null;
      const cloudSession = session.deployment_mode === "LEAF_NODE" ? null : await prisma.gatewayProvisioningSession.findUnique({ where: { id: session.id } });
      const pairingSession = session.deployment_mode === "LEAF_NODE" ? await prisma.pairingSession.findUnique({ where: { id: session.id } }) : null;
      const pairing = pairingSession ? {
        pairingId: pairingSession.id,
        nodeId: pairingSession.node_id,
        gatewayId: pairingSession.gateway_id,
        radioToken: pairingRadioToken({ id: pairingSession.id, nodeId: pairingSession.node_id, gatewayId: pairingSession.gateway_id, farmId: pairingSession.farm_id, zoneId: pairingSession.zone_id, expiresAt: pairingSession.expires_at }),
        expiresAt: pairingSession.expires_at.toISOString(),
        status: pairingSession.status,
      } : undefined;
      const provisioning = cloudSession ? { sessionId: cloudSession.id, deviceId: cloudSession.gateway_id, provisioningToken: session.challenge, expiresAt: cloudSession.expires_at.toISOString(), deploymentMode: cloudSession.deployment_mode } : undefined;
      return res.json({ success: true, idempotent: true, data: { sessionId: session.id, status: session.status, node, provisioning, pairing } });
    }
    if (session.status !== DeviceClaimSessionStatus.ATTESTED || session.expires_at <= new Date()) return res.status(409).json({ success: false, error: "Device must attest an unexpired challenge before finalize" });
    const identity = session.device;
    if (identity.state === DeviceIdentityState.REVOKED) return res.status(409).json({ success: false, error: "REVOKED identity is terminal" });
    const modeSwitch = identity.state === DeviceIdentityState.CLAIMED && identity.claimed_by_id === session.user_id;
    if (session.wifi_reconfigure && !modeSwitch) return res.status(409).json({ success: false, error: "Thiết bị không còn thuộc tài khoản" });
    if (!isReleasedV3Identity(identity) && !modeSwitch) return res.status(409).json({ success: false, error: `Thiết bị đang ở trạng thái ${identity.state}` });
    const existingModeNode = modeSwitch ? await prisma.node.findUnique({ where: { id: identity.device_id } }) : null;
    if (modeSwitch && (!existingModeNode || !existingModeNode.is_activated || existingModeNode.owner_id !== session.user_id || existingModeNode.farm_id !== session.farm_id || (session.wifi_reconfigure ? existingModeNode.deployment_mode !== session.deployment_mode || existingModeNode.zone_id !== session.zone_id : existingModeNode.deployment_mode === session.deployment_mode))) {
      return res.status(409).json({ success: false, error: "Thiết bị hoặc deployment mode đã thay đổi; tạo lại mode session" });
    }
    const name = req.body.name ? String(req.body.name).trim().slice(0, 128) : identity.device_id;
    const latitude = req.body.latitude == null ? null : Number(req.body.latitude);
    const longitude = req.body.longitude == null ? null : Number(req.body.longitude);
    if ((req.body.latitude != null || req.body.longitude != null) && (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude! < -90 || latitude! > 90 || longitude! < -180 || longitude! > 180)) {
      return res.status(400).json({ success: false, error: "Tọa độ GPS không hợp lệ" });
    }
    const gatewayId = session.deployment_mode === "LEAF_NODE" && req.body.gatewayId ? String(req.body.gatewayId).trim() : null;
    const leafZoneId = session.zone_id;
    if (session.deployment_mode === "LEAF_NODE" && (!gatewayId || !leafZoneId)) return res.status(400).json({ success: false, error: "LEAF_NODE cần gatewayId và Zone" });
    if (gatewayId && !isNumericRadioDeviceId(gatewayId, "GATEWAY")) {
      return res.status(400).json({ success: false, error: "gatewayId phải có dạng GATEWAY_<numeric-radio-id>" });
    }
    if (gatewayId) {
      const gateway = await prisma.node.findUnique({ where: { id: gatewayId }, select: { type: true, farm_id: true, is_activated: true, owner_id: true } });
      if (!gateway || gateway.type !== "GATEWAY" || !gateway.is_activated || gateway.farm_id !== session.farm_id || (gateway.owner_id !== session.user_id && req.user!.role !== "ADMIN")) return res.status(400).json({ success: false, error: "Gateway không hoạt động trong Farm đã chọn hoặc không thuộc tài khoản" });
    }
    if (session.zone_id) {
      const zone = await prisma.zone.findUnique({ where: { id: session.zone_id }, select: { farm_id: true } });
      if (!zone || zone.farm_id !== session.farm_id) return res.status(400).json({ success: false, error: "Zone không thuộc Farm đã chọn" });
    }
    const now = new Date();
    const finalized = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT device_id FROM device_identities WHERE device_id = ${identity.device_id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM device_claim_sessions WHERE id = ${session.id} FOR UPDATE`;
      const current = await tx.deviceClaimSession.findUnique({ where: { id: session.id } });
      const currentIdentity = await tx.deviceIdentity.findUnique({ where: { device_id: identity.device_id } });
      const currentDevice = await tx.node.findUnique({ where: { id: identity.device_id } });
      if (!current || current.status !== DeviceClaimSessionStatus.ATTESTED || current.expires_at <= new Date() || !currentIdentity || currentIdentity.state === DeviceIdentityState.REVOKED || currentIdentity.state === DeviceIdentityState.QUARANTINED) return null;
      const currentModeSwitch = currentIdentity.state === DeviceIdentityState.CLAIMED && currentIdentity.claimed_by_id === session.user_id;
      if (currentIdentity.claimed_by_id && currentIdentity.claimed_by_id !== session.user_id) return null;
      if (current.wifi_reconfigure && !currentModeSwitch) return null;
      if (currentModeSwitch && (!currentDevice || !currentDevice.is_activated || currentDevice.owner_id !== session.user_id || currentDevice.farm_id !== session.farm_id || (current.wifi_reconfigure ? currentDevice.deployment_mode !== session.deployment_mode || currentDevice.zone_id !== session.zone_id : currentDevice.deployment_mode === session.deployment_mode))) return null;
      if (!currentModeSwitch) assertTransition(currentIdentity.state, DeviceIdentityState.CLAIMED);
      const connectionMode = session.deployment_mode === "LEAF_NODE" ? NodeConnectionMode.LORA_GATEWAY : NodeConnectionMode.WIFI;
      // For a mode transition leave the existing Node untouched until the
      // physical device redeems/confirms the new session. This gives BLE
      // failure and expiry a safe rollback: the server still advertises the
      // old working mode and identity.
      const locationData = latitude == null || longitude == null ? {} : { latitude, longitude };
      const node = currentModeSwitch ? currentDevice : await tx.node.upsert({ where: { id: identity.device_id }, update: { name, farm_id: session.farm_id, zone_id: session.zone_id, gateway_id: gatewayId, owner_id: session.user_id, is_activated: true, type: identity.type, connection_mode: connectionMode, deployment_mode: session.deployment_mode, capabilities: identity.capabilities, serial_number: identity.serial_number, online: false, ...locationData }, create: { id: identity.device_id, serial_number: identity.serial_number, name, farm_id: session.farm_id, zone_id: session.zone_id, gateway_id: gatewayId, owner_id: session.user_id, type: identity.type, connection_mode: connectionMode, deployment_mode: session.deployment_mode, capabilities: identity.capabilities, is_activated: true, online: false, ...locationData } });
      if (!currentModeSwitch) await tx.deviceIdentity.update({ where: { device_id: identity.device_id }, data: { state: DeviceIdentityState.CLAIMED, claimed_by_id: session.user_id, claimed_farm_id: session.farm_id, claimed_at: now } });
      if (session.deployment_mode === "LEAF_NODE") {
        const pairingExpiresAt = session.expires_at;
        const pairingToken = pairingRadioToken({ id: session.id, nodeId: identity.device_id, gatewayId: gatewayId!, farmId: session.farm_id, zoneId: leafZoneId!, expiresAt: pairingExpiresAt });
        const existingPairing = await tx.pairingSession.findUnique({ where: { id: session.id } });
        if (existingPairing) {
          if (existingPairing.node_id !== identity.device_id || existingPairing.gateway_id !== gatewayId || existingPairing.requested_by_id !== session.user_id || existingPairing.token_hash !== hashDeviceSecret(`pair:${session.id}`, pairingToken)) {
            throw new Error("Claim pairing session conflict");
          }
        } else {
          await tx.pairingSession.create({ data: {
            id: session.id,
            node_id: identity.device_id,
            gateway_id: gatewayId!,
            farm_id: session.farm_id,
            zone_id: leafZoneId!,
            requested_by_id: session.user_id,
            token_hash: hashDeviceSecret(`pair:${session.id}`, pairingToken),
            status: "PENDING",
            expires_at: pairingExpiresAt,
          } });
        }
      } else {
        const provisioningTokenHash = hashDeviceSecret(`provision:${identity.device_id}`, session.challenge);
        const existingProvisioning = await tx.gatewayProvisioningSession.findUnique({ where: { id: session.id } });
        if (existingProvisioning) {
          if (existingProvisioning.gateway_id !== identity.device_id || existingProvisioning.user_id !== session.user_id || existingProvisioning.farm_id !== session.farm_id || existingProvisioning.token_hash !== provisioningTokenHash) {
            throw new Error("Claim provisioning session conflict");
          }
        } else {
          await tx.gatewayProvisioningSession.create({ data: {
            id: session.id,
            gateway_id: identity.device_id,
            user_id: session.user_id,
            farm_id: session.farm_id,
            zone_id: session.zone_id,
            deployment_mode: session.deployment_mode,
            token_hash: provisioningTokenHash,
            status: "PENDING",
            expires_at: session.expires_at,
          } });
        }
      }
      await tx.deviceClaimSession.update({ where: { id: session.id }, data: { status: DeviceClaimSessionStatus.FINALIZED, finalized_at: now, finalized_node_id: node!.id } });
      await recordLifecycleEvent(tx, { deviceId: identity.device_id, batchId: identity.batch_id, eventType: DeviceLifecycleEventType.CLAIM_FINALIZED, fromState: currentIdentity.state, toState: DeviceIdentityState.CLAIMED, actorType: "USER", actorId: session.user_id, idempotencyKey: `claim-finalize:${session.id}`, metadata: { sessionId: session.id, nodeId: node!.id, modeSwitch: currentModeSwitch && !current.wifi_reconfigure, wifiReconfigure: current.wifi_reconfigure, previousMode: currentDevice?.deployment_mode || null, nextMode: session.deployment_mode } });
      return node;
    });
    if (!finalized) return res.status(409).json({ success: false, error: "Claim session or identity changed; retry with a new session" });
    const pairingSession = session.deployment_mode === "LEAF_NODE" ? await prisma.pairingSession.findUnique({ where: { id: session.id } }) : null;
    const pairing = pairingSession ? {
      pairingId: pairingSession.id,
      nodeId: pairingSession.node_id,
      gatewayId: pairingSession.gateway_id,
      radioToken: pairingRadioToken({ id: pairingSession.id, nodeId: pairingSession.node_id, gatewayId: pairingSession.gateway_id, farmId: pairingSession.farm_id, zoneId: pairingSession.zone_id, expiresAt: pairingSession.expires_at }),
      expiresAt: pairingSession.expires_at.toISOString(),
      status: pairingSession.status,
    } : undefined;
    if (pairing) {
      publishMqttMessage(`farm/${session.farm_id}/gateway/${pairing.gatewayId}/command/pairing`, {
        pairingId: pairing.pairingId,
        nodeId: pairing.nodeId,
        radioToken: pairing.radioToken,
        expiresAt: Math.floor(Date.parse(pairing.expiresAt) / 1000),
      });
    }
    const provisioning = session.deployment_mode === "LEAF_NODE" ? undefined : {
      sessionId: session.id,
      deviceId: session.device_id,
      provisioningToken: session.challenge,
      expiresAt: session.expires_at.toISOString(),
      deploymentMode: session.deployment_mode,
    };
    return res.status(201).json({ success: true, data: { sessionId: session.id, status: DeviceClaimSessionStatus.FINALIZED, node: finalized, provisioning, pairing } });
  } catch (error: any) {
    const failure = onboardingError(error, "Không finalize được claim session");
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

// One QR contract for every FarmOS device. The server, not the QR payload,
// decides which deployment modes the manufactured model supports.
router.post("/devices/resolve-qr", authenticate, requireLegacyV2, async (req: AuthRequest, res: Response) => {
  if (!legacyProvisioningEnabled()) return res.status(410).json({ success: false, error: "Legacy v2 provisioning is disabled; use QR v3 claim" });
  const deviceId = String(req.body.deviceId || "").trim();
  const claimCode = String(req.body.claimCode || "").trim();
  if (!deviceId || !claimCode) return res.status(400).json({ success: false, error: "QR thiếu deviceId hoặc claimCode" });
  const identity = await checkedQrIdentity(deviceId, claimCode);
  if (!identity) return res.status(404).json({ success: false, error: "QR không hợp lệ hoặc thiết bị chưa được xuất xưởng" });
  if (!isLegacyIdentity(identity)) return res.status(409).json({ success: false, error: "Identity is not a legacy v2 device" });
  if (identity.state === DeviceIdentityState.REVOKED || identity.state === DeviceIdentityState.QUARANTINED) return res.status(409).json({ success: false, error: "Thiết bị đã bị thu hồi hoặc cách ly" });
  if (identity.claimed_by_id && identity.claimed_by_id !== req.user!.id && req.user!.role !== "ADMIN") {
    return res.status(409).json({ success: false, error: "Thiết bị đã thuộc tài khoản khác" });
  }
  const capabilities = identityCapabilities(identity);
  return res.json({ success: true, data: {
    deviceId: identity.device_id,
    serialNumber: identity.serial_number,
    model: identity.model,
    bleName: identity.ble_name,
    hardwareType: identity.type,
    capabilities,
    firmwareTarget: identity.firmware_target,
    hardwareRevision: identity.hardware_revision,
    partitionScheme: identity.partition_scheme,
    allowedModes: allowedModes(identity),
    state: identity.state,
  } });
});

router.post("/devices/cloud-session", authenticate, requireLegacyV2, async (req: AuthRequest, res: Response) => {
  if (!legacyProvisioningEnabled()) return res.status(410).json({ success: false, error: "Legacy v2 cloud provisioning is disabled; use QR v3 claim" });
  const user = req.user!;
  const deviceId = String(req.body.deviceId || "").trim();
  const claimCode = String(req.body.claimCode || "").trim();
  const farmId = String(req.body.farmId || "").trim();
  const zoneId = req.body.zoneId ? String(req.body.zoneId).trim() : null;
  const deploymentMode = String(req.body.deploymentMode || "") as DeploymentMode;
  if (!deviceId || !claimCode || !farmId || !["GATEWAY", "STANDALONE_NODE"].includes(deploymentMode)) {
    return res.status(400).json({ success: false, error: "Thiếu hoặc sai thông tin cài đặt thiết bị cloud" });
  }
  if (!(await hasFarmAccess(user, farmId))) return res.status(403).json({ success: false, error: "Bạn không có quyền với Farm này" });
  const identity = await checkedQrIdentity(deviceId, claimCode);
  if (!identity || !allowedModes(identity).includes(deploymentMode)) {
    return res.status(404).json({ success: false, error: "Thiết bị không hợp lệ hoặc không hỗ trợ chế độ đã chọn" });
  }
  if (!isLegacyIdentity(identity)) return res.status(409).json({ success: false, error: "Identity is not a legacy v2 device" });
  if ((identity.state === DeviceIdentityState.REVOKED || identity.state === DeviceIdentityState.QUARANTINED) || identity.claimed_by_id && identity.claimed_by_id !== user.id) {
    return res.status(409).json({ success: false, error: "Thiết bị đã thuộc tài khoản khác hoặc bị thu hồi" });
  }
  // A Gateway with the LOCAL_SENSOR capability emits its own telemetry using
  // the same authenticated cloud path as a standalone Node, so it needs a
  // farm Zone as well. Without this check the session succeeds but every
  // self-telemetry row is rejected later because the Gateway has no zone_id.
  const requiresZone = deploymentMode === "STANDALONE_NODE" ||
    deploymentMode === "GATEWAY" && identityCapabilities(identity).includes("LOCAL_SENSOR");
  if (requiresZone) {
    const zone = zoneId ? await prisma.zone.findUnique({ where: { id: zoneId } }) : null;
    if (!zone || zone.farm_id !== farmId) return res.status(400).json({ success: false, error: "Hãy chọn Zone thuộc Farm này" });
  }
  await prisma.gatewayProvisioningSession.updateMany({
    where: { gateway_id: deviceId, status: "PENDING" }, data: { status: "CANCELLED" },
  });
  const provisioningToken = createOpaqueToken();
  const expiresAt = new Date(Date.now() + GATEWAY_SESSION_MS);
  const session = await prisma.gatewayProvisioningSession.create({ data: {
    gateway_id: deviceId, user_id: user.id, farm_id: farmId, zone_id: zoneId,
    deployment_mode: deploymentMode,
    token_hash: hashDeviceSecret(`provision:${deviceId}`, provisioningToken), expires_at: expiresAt,
  } });
  return res.status(201).json({ success: true, data: {
    sessionId: session.id, deviceId, provisioningToken,
    bleName: identity.ble_name, expiresAt: expiresAt.toISOString(), deploymentMode,
  } });
});

// This endpoint is shared by the production QR-v3 redeem flow and the
// explicitly opt-in v2 compatibility flow. The session/identity checks below
// keep v2 disabled without blocking a finalized v3 claim.
router.post("/devices/redeem", async (req: Request, res: Response) => {
  const deviceId = String(req.body.deviceId || req.body.gatewayId || "").trim();
  const sessionId = String(req.body.sessionId || "").trim();
  const provisioningToken = String(req.body.provisioningToken || "").trim();
  const firmwareVersion = String(req.body.firmwareVersion || "unknown").slice(0, 64);
  const session = await prisma.gatewayProvisioningSession.findUnique({ where: { id: sessionId } });
  if (!session || session.gateway_id !== deviceId || !isProvisioningSessionUsable(session.status, session.expires_at) ||
      !matchesDeviceSecret(`provision:${deviceId}`, session.token_hash, provisioningToken)) {
    return res.status(401).json({ success: false, error: "Provisioning session không hợp lệ hoặc đã hết hạn" });
  }
  const identity = await prisma.deviceIdentity.findUnique({ where: { device_id: deviceId } });
  const mode = session.deployment_mode as DeploymentMode;
  if (!identity || (identity.state === DeviceIdentityState.REVOKED || identity.state === DeviceIdentityState.QUARANTINED) || !allowedModes(identity).includes(mode)) {
    return res.status(409).json({ success: false, error: "Thiết bị hoặc deployment mode không còn hợp lệ" });
  }
  const v3Claim = identity.identity_version >= 3
    ? await prisma.deviceClaimSession.findUnique({ where: { id: session.id }, select: { device_id: true, status: true, wifi_reconfigure: true } })
    : null;
  if (identity.identity_version >= 3 && (!v3Claim || v3Claim.device_id !== deviceId || v3Claim.status !== DeviceClaimSessionStatus.FINALIZED)) {
    return res.status(409).json({ success: false, error: "QR v3 claim session is not finalized" });
  }
  if (identity.identity_version < 3 && !legacyProvisioningEnabled()) {
    return res.status(410).json({ success: false, error: "Legacy v2 provisioning is disabled; use QR v3 claim" });
  }
  if (identity.identity_version < 3 && !isLegacyIdentity(identity)) {
    return res.status(409).json({ success: false, error: "Identity is not an explicit legacy v2 device" });
  }
  const deviceAccessToken = gatewaySessionToken(deviceId, session.id, provisioningToken);
  if (session.status === "REDEEMED") {
    const credential = await prisma.gatewayCredential.findUnique({ where: { gateway_id: deviceId } });
    if (!credential || credential.revoked_at || !matchesDeviceSecret(`gateway:${deviceId}`, credential.token_hash, deviceAccessToken)) {
      return res.status(409).json({ success: false, error: "Phiên cũ đã bị thay thế; cần cài đặt lại" });
    }
    return res.json({ success: true, data: { deviceAccessToken, gatewayAccessToken: deviceAccessToken, deploymentMode: mode } });
  }
  const now = new Date();
  const activated = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT device_id FROM device_identities WHERE device_id = ${deviceId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM gateway_provisioning_sessions WHERE id = ${session.id} FOR UPDATE`;
    const current = await tx.gatewayProvisioningSession.findUnique({ where: { id: session.id } });
    const currentIdentity = await tx.deviceIdentity.findUnique({ where: { device_id: deviceId } });
    const currentDevice = await tx.node.findUnique({ where: { id: deviceId } });
    if (!current || current.status !== "PENDING" || current.expires_at <= new Date() ||
        !currentIdentity || (currentIdentity.state === DeviceIdentityState.REVOKED || currentIdentity.state === DeviceIdentityState.QUARANTINED) ||
        !allowedModes(currentIdentity).includes(mode) ||
        currentIdentity.claimed_by_id && currentIdentity.claimed_by_id !== session.user_id) return null;
    const modeSwitch = Boolean(currentDevice?.is_activated && currentDevice.deployment_mode !== mode && currentIdentity.state === DeviceIdentityState.CLAIMED && currentIdentity.claimed_by_id === session.user_id);
    if (v3Claim?.wifi_reconfigure) {
      if (!currentDevice?.is_activated || currentDevice.owner_id !== session.user_id || currentDevice.farm_id !== session.farm_id ||
          currentDevice.zone_id !== session.zone_id || currentDevice.deployment_mode !== mode || !currentIdentity.is_current ||
          currentIdentity.generation_state !== "ACTIVE" || currentIdentity.state !== "CLAIMED" ||
          currentIdentity.claimed_by_id !== session.user_id) return null;
      const pendingRelease = await tx.deviceLifecycleCommand.findFirst({
        where: { device_id: deviceId, type: "RELEASE_ACCOUNT", status: { in: ["PENDING", "ACKNOWLEDGED"] }, expires_at: { gt: now } },
        select: { id: true },
      });
      if (pendingRelease) return null;
      await tx.gatewayProvisioningSession.updateMany({
        where: { gateway_id: deviceId, id: { not: session.id }, status: "REDEEMED" },
        data: { status: "CANCELLED", expires_at: now },
      });
    }
    if (modeSwitch) {
      // Revoke the old transport grants only at the point the new device
      // session is actually redeemed. Until then a failed BLE write leaves
      // the old Node mode and credential working.
      await tx.gatewayProvisioningSession.updateMany({ where: { gateway_id: deviceId, id: { not: session.id }, status: { in: ["PENDING", "REDEEMED"] } }, data: { status: "CANCELLED", expires_at: now } });
      await tx.pairingSession.updateMany({ where: { OR: [{ node_id: deviceId }, { gateway_id: deviceId }], id: { not: session.id }, status: { notIn: ["FAILED", "EXPIRED", "CANCELLED"] } }, data: { status: "CANCELLED", failure_reason: "Replaced by a confirmed mode transition", expires_at: now } });
      await tx.nodeGatewayBinding.updateMany({ where: { OR: [{ node_id: deviceId }, { gateway_id: deviceId }], status: "ACTIVE" }, data: { status: "REVOKED", revoked_at: now } });
    }
    await tx.gatewayCredential.upsert({ where: { gateway_id: deviceId },
      update: { token_hash: hashDeviceSecret(`gateway:${deviceId}`, deviceAccessToken), issued_at: now, revoked_at: null },
      create: { gateway_id: deviceId, token_hash: hashDeviceSecret(`gateway:${deviceId}`, deviceAccessToken) } });
    if (v3Claim?.wifi_reconfigure) {
      const device = await tx.node.update({ where: { id: deviceId }, data: { online: true, firmware_version: firmwareVersion, last_seen: now } });
      await tx.gatewayProvisioningSession.update({ where: { id: session.id }, data: { status: "REDEEMED", redeemed_at: now } });
      return device;
    }
    await tx.nodeGatewayBinding.updateMany({ where: { node_id: deviceId, status: "ACTIVE" }, data: { status: "REVOKED", revoked_at: now } });
    if (currentDevice?.deployment_mode === "GATEWAY" && mode !== "GATEWAY") {
      await tx.nodeGatewayBinding.updateMany({
        where: { gateway_id: deviceId, status: "ACTIVE" },
        data: { status: "REVOKED", revoked_at: now },
      });
      await tx.node.updateMany({ where: { gateway_id: deviceId }, data: { gateway_id: null } });
    }
    const device = await tx.node.upsert({ where: { id: deviceId }, update: {
      farm_id: session.farm_id, zone_id: session.zone_id, gateway_id: null, owner_id: session.user_id,
      type: mode === "GATEWAY" ? "GATEWAY" : "SENSOR_NODE", connection_mode: mode === "LEAF_NODE" ? NodeConnectionMode.LORA_GATEWAY : NodeConnectionMode.WIFI, deployment_mode: mode,
      capabilities: identityCapabilities(currentIdentity), is_activated: true, online: true,
      firmware_version: firmwareVersion, last_seen: now,
    }, create: {
      id: deviceId, serial_number: identity.serial_number, name: deviceId, farm_id: session.farm_id,
      zone_id: session.zone_id, owner_id: session.user_id,
      type: mode === "GATEWAY" ? "GATEWAY" : "SENSOR_NODE", connection_mode: mode === "LEAF_NODE" ? NodeConnectionMode.LORA_GATEWAY : NodeConnectionMode.WIFI, deployment_mode: mode,
      capabilities: identityCapabilities(currentIdentity), is_activated: true, online: true,
      firmware_version: firmwareVersion, last_seen: now,
    } });
    await tx.deviceIdentity.update({ where: { device_id: deviceId }, data: {
      state: "CLAIMED", claimed_by_id: session.user_id, claimed_farm_id: session.farm_id, claimed_at: now,
    } });
    await tx.gatewayProvisioningSession.update({ where: { id: session.id }, data: { status: "REDEEMED", redeemed_at: now } });
    return device;
  });
  if (!activated) return res.status(409).json({ success: false, error: "Phiên cài đặt đã thay đổi; hãy thử lại" });
  return res.json({ success: true, data: {
    device: publicGateway(activated), deviceAccessToken, gatewayAccessToken: deviceAccessToken,
    deploymentMode: mode,
  } });
});

router.get("/devices/cloud-sessions/:id", authenticate, async (req: AuthRequest, res: Response) => {
  const session = await prisma.gatewayProvisioningSession.findUnique({ where: { id: req.params.id } });
  if (!session || session.user_id !== req.user!.id && req.user!.role !== "ADMIN") {
    return res.status(404).json({ success: false, error: "Không tìm thấy phiên cài đặt" });
  }
  // QR v3 finalization reuses the claim-session id for its cloud provisioning
  // row. Keep the legacy gate for v2 sessions, but allow an authenticated user
  // to poll a finalized v3 session after BLE configuration without requiring
  // ENABLE_LEGACY_PROVISIONING.
  if (!legacyProvisioningEnabled()) {
    const claim = await prisma.deviceClaimSession.findUnique({ where: { id: session.id }, select: { status: true } });
    if (claim?.status !== DeviceClaimSessionStatus.FINALIZED) {
      return res.status(410).json({ success: false, error: "Legacy v2 cloud sessions are disabled; use QR v3 claim" });
    }
  }
  const status = session.status === "PENDING" && session.expires_at <= new Date() ? "EXPIRED" : session.status;
  return res.json({ success: true, data: { sessionId: session.id, deviceId: session.gateway_id, status, deploymentMode: session.deployment_mode } });
});

// Mobile creates this short-lived session after scanning the Gateway QR.
router.post("/gateways/claim-session", authenticate, requireLegacyV2, async (req: AuthRequest, res: Response) => {
  if (!legacyProvisioningEnabled()) return res.status(410).json({ success: false, error: "Legacy v2 claim sessions are disabled; use QR v3 claim" });
  try {
    const user = req.user!;
    const gatewayId = String(req.body.gatewayId || "").trim();
    const claimCode = String(req.body.claimCode || "").trim();
    const farmId = String(req.body.farmId || "").trim();
    if (!gatewayId || !claimCode || !farmId) {
      return res.status(400).json({ success: false, error: "Thiếu gatewayId, claimCode hoặc farmId" });
    }
    if (!(await hasFarmAccess(user, farmId))) {
      return res.status(403).json({ success: false, error: "Bạn không có quyền thêm Gateway vào Farm này" });
    }

    const identity = await prisma.deviceIdentity.findUnique({ where: { device_id: gatewayId } });
    if (!identity || identity.type !== "GATEWAY" ||
        !matchesDeviceSecret(`claim:${gatewayId}`, identity.claim_code_hash, claimCode)) {
      return res.status(404).json({ success: false, error: "QR Gateway không hợp lệ hoặc thiết bị chưa được xuất xưởng" });
    }
    if (!isLegacyIdentity(identity)) return res.status(409).json({ success: false, error: "Identity is not a legacy v2 device" });
    if (identity.state === DeviceIdentityState.REVOKED || identity.state === DeviceIdentityState.QUARANTINED) {
      return res.status(409).json({ success: false, error: "Gateway đã bị thu hồi" });
    }
    if (identity.claimed_by_id && identity.claimed_by_id !== user.id) {
      return res.status(409).json({ success: false, error: "Gateway đã thuộc tài khoản khác" });
    }

    const existingNode = await prisma.node.findUnique({ where: { id: gatewayId } });
    if (existingNode?.is_activated && existingNode.owner_id && existingNode.owner_id !== user.id) {
      return res.status(409).json({ success: false, error: "Gateway đã được kích hoạt bởi tài khoản khác" });
    }

    await prisma.gatewayProvisioningSession.updateMany({
      where: { gateway_id: gatewayId, status: "PENDING" },
      data: { status: "CANCELLED" },
    });
    const provisioningToken = createOpaqueToken();
    const expiresAt = new Date(Date.now() + GATEWAY_SESSION_MS);
    const session = await prisma.gatewayProvisioningSession.create({
      data: {
        gateway_id: gatewayId,
        user_id: user.id,
        farm_id: farmId,
        deployment_mode: "GATEWAY",
        token_hash: hashDeviceSecret(`provision:${gatewayId}`, provisioningToken),
        expires_at: expiresAt,
      },
    });

    return res.status(201).json({
      success: true,
      data: {
        sessionId: session.id,
        gatewayId,
        provisioningToken,
        bleName: identity.ble_name || `FarmOS-GW-${gatewayId.slice(-6)}`,
        expiresAt: expiresAt.toISOString(),
      },
    });
  } catch (error: any) {
    const failure = onboardingError(error, "Không tạo được phiên cài đặt Gateway");
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

// Called by the Gateway after BLE provisioning and Wi-Fi association.
router.get("/gateways/claim-sessions/:id", authenticate, requireLegacyV2, async (req: AuthRequest, res: Response) => {
  if (!legacyProvisioningEnabled()) return res.status(410).json({ success: false, error: "Legacy v2 claim sessions are disabled; use QR v3 claim" });
  try {
    const session = await prisma.gatewayProvisioningSession.findUnique({ where: { id: req.params.id } });
    if (!session || session.user_id !== req.user!.id) {
      return res.status(404).json({ success: false, error: "Không tìm thấy phiên cài đặt" });
    }
    const status = session.status === "PENDING" && session.expires_at <= new Date() ? "EXPIRED" : session.status;
    return res.json({ success: true, data: { sessionId: session.id, gatewayId: session.gateway_id, status } });
  } catch {
    return res.status(500).json({ success: false, error: "Không đọc được trạng thái cài đặt" });
  }
});

router.post("/gateways/redeem", requireLegacyV2, async (req: Request, res: Response) => {
  try {
    const gatewayId = String(req.body.gatewayId || "").trim();
    const sessionId = String(req.body.sessionId || "").trim();
    const provisioningToken = String(req.body.provisioningToken || "").trim();
    const firmwareVersion = String(req.body.firmwareVersion || "unknown").slice(0, 64);
    const session = await prisma.gatewayProvisioningSession.findUnique({ where: { id: sessionId } });
    if (!session || session.gateway_id !== gatewayId || !isProvisioningSessionUsable(session.status, session.expires_at) ||
        !matchesDeviceSecret(`provision:${gatewayId}`, session.token_hash, provisioningToken)) {
      return res.status(401).json({ success: false, error: "Provisioning session không hợp lệ hoặc đã hết hạn" });
    }

    const identity = await prisma.deviceIdentity.findUnique({ where: { device_id: gatewayId } });
    if (!identity || identity.type !== "GATEWAY" || (identity.state === DeviceIdentityState.REVOKED || identity.state === DeviceIdentityState.QUARANTINED)) {
      return res.status(409).json({ success: false, error: "Gateway không còn hợp lệ" });
    }
    if (!isLegacyIdentity(identity)) {
      return res.status(409).json({ success: false, error: "Identity is not an explicit legacy v2 device" });
    }

    const gatewayAccessToken = gatewaySessionToken(gatewayId, session.id, provisioningToken);
    if (identity.claimed_by_id && identity.claimed_by_id !== session.user_id) {
      return res.status(409).json({ success: false, error: "Gateway đã thuộc tài khoản khác" });
    }
    if (session.status === "REDEEMED") {
      const [credential, gateway] = await Promise.all([
        prisma.gatewayCredential.findUnique({ where: { gateway_id: gatewayId } }),
        prisma.node.findUnique({ where: { id: gatewayId } }),
      ]);
      // Never reactivate a token revoked or replaced by a later provisioning.
      if (!gateway || !credential || credential.revoked_at ||
          !matchesDeviceSecret(`gateway:${gatewayId}`, credential.token_hash, gatewayAccessToken)) {
        return res.status(409).json({ success: false, error: "Phiên cũ đã bị thay thế; cần cài đặt lại" });
      }
      return res.json({ success: true, data: { gateway: publicGateway(gateway), gatewayAccessToken,
        topicPrefix: `farm/${session.farm_id}/gateway/${gatewayId}` } });
    }
    const now = new Date();
    const gateway = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT device_id FROM device_identities WHERE device_id = ${gatewayId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM gateway_provisioning_sessions WHERE id = ${session.id} FOR UPDATE`;
      const currentIdentity = await tx.deviceIdentity.findUnique({ where: { device_id: gatewayId } });
      const currentSession = await tx.gatewayProvisioningSession.findUnique({ where: { id: session.id } });
      if (!currentIdentity || (currentIdentity.state === DeviceIdentityState.REVOKED || currentIdentity.state === DeviceIdentityState.QUARANTINED) ||
          currentIdentity.claimed_by_id && currentIdentity.claimed_by_id !== session.user_id ||
          currentSession?.status !== "PENDING" || currentSession.expires_at <= new Date()) return null;
      await tx.gatewayCredential.upsert({
        where: { gateway_id: gatewayId },
        update: { token_hash: hashDeviceSecret(`gateway:${gatewayId}`, gatewayAccessToken), issued_at: now, revoked_at: null },
        create: { gateway_id: gatewayId, token_hash: hashDeviceSecret(`gateway:${gatewayId}`, gatewayAccessToken) },
      });
      const activated = await tx.node.upsert({
        where: { id: gatewayId },
        update: { farm_id: session.farm_id, owner_id: session.user_id, type: "GATEWAY", connection_mode: NodeConnectionMode.WIFI, deployment_mode: "GATEWAY", capabilities: identityCapabilities(identity), gateway_id: null, zone_id: null, is_activated: true, online: true, firmware_version: firmwareVersion, last_seen: now },
        create: { id: gatewayId, serial_number: identity.serial_number, name: gatewayId, farm_id: session.farm_id, owner_id: session.user_id, type: "GATEWAY", connection_mode: NodeConnectionMode.WIFI, deployment_mode: "GATEWAY", capabilities: identityCapabilities(identity), is_activated: true, online: true, firmware_version: firmwareVersion, last_seen: now },
      });
      await tx.deviceIdentity.update({
        where: { device_id: gatewayId },
        data: { state: "CLAIMED", claimed_by_id: session.user_id, claimed_farm_id: session.farm_id, claimed_at: now },
      });
      await tx.gatewayProvisioningSession.update({
        where: { id: session.id },
        data: { status: "REDEEMED", redeemed_at: now },
      });
      return activated;
    });
    if (!gateway) return res.status(409).json({ success: false, error: "Phiên cài đặt đã thay đổi; hãy thử lại" });

    return res.json({
      success: true,
      data: {
        gateway: publicGateway(gateway),
        gatewayAccessToken,
        topicPrefix: `farm/${session.farm_id}/gateway/${gatewayId}`,
      },
    });
  } catch (error: any) {
    const failure = onboardingError(error, "Không đổi được thông tin cài đặt Gateway");
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.get("/gateways/:gatewayId/status", authenticate, async (req: AuthRequest, res: Response) => {
  const gateway = await prisma.node.findUnique({ where: { id: req.params.gatewayId } });
  if (!gateway || gateway.type !== "GATEWAY" || !gateway.farm_id || !(await hasFarmAccess(req.user!, gateway.farm_id))) {
    return res.status(404).json({ success: false, error: "Không tìm thấy Gateway" });
  }
  return res.json({ success: true, data: publicGateway(gateway) });
});

// Mobile reads the Node identity/possession code over BLE, then selects Farm,
// Zone and one online Gateway. No Internet connection is required on the Node.
router.post("/nodes/pairing-sessions", authenticate, requireLegacyV2, async (req: AuthRequest, res: Response) => {
  if (!legacyProvisioningEnabled()) return res.status(410).json({ success: false, error: "Legacy v2 pairing is disabled; use QR v3 claim" });
  try {
    const user = req.user!;
    const nodeId = String(req.body.nodeId || "").trim();
    const possessionCode = String(req.body.possessionCode || "").trim();
    const gatewayId = String(req.body.gatewayId || "").trim();
    const farmId = String(req.body.farmId || "").trim();
    const zoneId = String(req.body.zoneId || "").trim();
    if (!nodeId || !possessionCode || !gatewayId || !farmId || !zoneId) {
      return res.status(400).json({ success: false, error: "Thiếu Node, mã sở hữu, Gateway, Farm hoặc Zone" });
    }
    if (!(await hasFarmAccess(user, farmId))) {
      return res.status(403).json({ success: false, error: "Bạn không có quyền với Farm này" });
    }
    const [identity, gateway, zone, existingNode] = await Promise.all([
      prisma.deviceIdentity.findUnique({ where: { device_id: nodeId } }),
      prisma.node.findUnique({ where: { id: gatewayId } }),
      prisma.zone.findUnique({ where: { id: zoneId } }),
      prisma.node.findUnique({ where: { id: nodeId } }),
    ]);
    if (!identity || identity.type !== "SENSOR_NODE" ||
        !matchesDeviceSecret(`claim:${nodeId}`, identity.claim_code_hash, possessionCode)) {
      return res.status(404).json({ success: false, error: "Node không hợp lệ hoặc chưa được xuất xưởng" });
    }
    if (!isLegacyIdentity(identity)) return res.status(409).json({ success: false, error: "Identity is not a legacy v2 device" });
    if ((identity.state === DeviceIdentityState.REVOKED || identity.state === DeviceIdentityState.QUARANTINED) || (identity.claimed_by_id && identity.claimed_by_id !== user.id)) {
      return res.status(409).json({ success: false, error: "Node đã thuộc tài khoản khác hoặc đã bị thu hồi" });
    }
    if (existingNode?.is_activated && existingNode.owner_id && existingNode.owner_id !== user.id) {
      return res.status(409).json({ success: false, error: "Node đã được kích hoạt bởi tài khoản khác" });
    }
    if (!gateway || gateway.type !== "GATEWAY" || !gateway.is_activated || gateway.farm_id !== farmId || gateway.owner_id !== user.id && user.role !== "ADMIN") {
      return res.status(400).json({ success: false, error: "Gateway không hoạt động trong Farm đã chọn" });
    }
    if (!zone || zone.farm_id !== farmId) {
      return res.status(400).json({ success: false, error: "Zone không thuộc Farm đã chọn" });
    }

    await prisma.pairingSession.updateMany({
      where: { node_id: nodeId, status: { in: ["PENDING", "GATEWAY_READY"] } },
      data: { status: "CANCELLED", failure_reason: "Replaced by a newer pairing request" },
    });
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + PAIRING_SESSION_MS);
    const descriptor = { id: sessionId, nodeId, gatewayId, farmId, zoneId, expiresAt };
    const radioToken = pairingRadioToken(descriptor);
    const session = await prisma.pairingSession.create({
      data: {
        id: sessionId,
        node_id: nodeId,
        gateway_id: gatewayId,
        farm_id: farmId,
        zone_id: zoneId,
        requested_by_id: user.id,
        token_hash: hashDeviceSecret(`pair:${sessionId}`, radioToken),
        expires_at: expiresAt,
      },
    });

    publishMqttMessage(`farm/${farmId}/gateway/${gatewayId}/command/pairing`, {
      pairingId: session.id,
      nodeId,
      radioToken,
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
    });

    return res.status(201).json({
      success: true,
      data: { pairingId: session.id, nodeId, gatewayId, radioToken, expiresAt: expiresAt.toISOString(), status: session.status },
    });
  } catch (error: any) {
    const failure = onboardingError(error, "Không tạo được phiên ghép nối");
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.get("/pairing-sessions/:id", authenticate, async (req: AuthRequest, res: Response) => {
  const session = await prisma.pairingSession.findUnique({ where: { id: req.params.id } });
  if (!session || session.requested_by_id !== req.user!.id && req.user!.role !== "ADMIN") {
    return res.status(404).json({ success: false, error: "Không tìm thấy phiên ghép nối" });
  }
  // v3 LEAF_NODE finalization creates a pairing row with the same id as the
  // finalized claim session. Permit its status polling in production while
  // retaining the explicit legacy flag for v2 pairing sessions.
  if (!legacyProvisioningEnabled()) {
    const claim = await prisma.deviceClaimSession.findUnique({ where: { id: session.id }, select: { status: true } });
    if (claim?.status !== DeviceClaimSessionStatus.FINALIZED) {
      return res.status(410).json({ success: false, error: "Legacy v2 pairing is disabled; use QR v3 claim" });
    }
  }
  const status = session.expires_at <= new Date() && ["PENDING", "GATEWAY_READY"].includes(session.status) ? "EXPIRED" : session.status;
  if (status === "EXPIRED" && session.status !== status) {
    await prisma.pairingSession.update({ where: { id: session.id }, data: { status } });
  }
  return res.json({ success: true, data: { ...session, status, token_hash: undefined } });
});

router.get("/gateway/pairing-sessions/next", requireGatewayAuth, async (req: GatewayRequest, res: Response) => {
  const session = await prisma.pairingSession.findFirst({
    where: { gateway_id: req.gatewayId!, status: { in: ["PENDING", "GATEWAY_READY"] }, expires_at: { gt: new Date() } },
    orderBy: { created_at: "asc" },
  });
  if (!session) return res.json({ success: true, data: null });
  const radioToken = pairingRadioToken({ id: session.id, nodeId: session.node_id, gatewayId: session.gateway_id, farmId: session.farm_id, zoneId: session.zone_id, expiresAt: session.expires_at });
  if (session.status === "PENDING") {
    const updated = await prisma.pairingSession.updateMany({ where: { id: session.id, status: "PENDING" }, data: { status: "GATEWAY_READY", gateway_ready_at: new Date() } });
    if (!updated.count) return res.json({ success: true, data: null });
  }
  return res.json({ success: true, data: { pairingId: session.id, nodeId: session.node_id, radioToken,
    ttlMs: Math.max(0, session.expires_at.getTime() - Date.now()), expiresAt: session.expires_at.toISOString() } });
});

router.post("/gateway/pairing-sessions/:id/confirm", requireGatewayAuth, async (req: GatewayRequest, res: Response) => {
  try {
    const session = await prisma.pairingSession.findUnique({ where: { id: req.params.id } });
    const radioToken = String(req.body.radioToken || "").trim();
    if (!session || session.gateway_id !== req.gatewayId ||
        !matchesDeviceSecret(`pair:${session?.id || "invalid"}`, session?.token_hash || "", radioToken)) {
      return res.status(401).json({ success: false, error: "Xác nhận pairing không hợp lệ hoặc đã hết hạn" });
    }
    if (session.status === "ACTIVE") return res.json({ success: true, data: { pairingId: session.id, status: "ACTIVE" } });
    if (session.expires_at <= new Date() || !["PENDING", "GATEWAY_READY"].includes(session.status)) {
      return res.status(409).json({ success: false, error: "Phiên ghép đã hết hạn hoặc bị hủy" });
    }

    const identity = await prisma.deviceIdentity.findUnique({ where: { device_id: session.node_id } });
    if (!identity) return res.status(404).json({ success: false, error: "Không tìm thấy danh tính Node" });
    const now = new Date();
    const activeBinding = await prisma.nodeGatewayBinding.findFirst({ where: { node_id: session.node_id, status: "ACTIVE" }, orderBy: { paired_at: "desc" } });
    const nextKeyVersion = (activeBinding?.key_version || 0) + 1;
    const rssi = Number.isFinite(Number(req.body.rssi)) ? Number(req.body.rssi) : null;
    const snr = Number.isFinite(Number(req.body.snr)) ? Number(req.body.snr) : null;

    await prisma.$transaction([
      prisma.nodeGatewayBinding.updateMany({ where: { node_id: session.node_id, status: "ACTIVE" }, data: { status: "REVOKED", revoked_at: now } }),
      prisma.gatewayCredential.updateMany({ where: { gateway_id: session.node_id }, data: { revoked_at: now } }),
      prisma.nodeGatewayBinding.create({ data: { node_id: session.node_id, gateway_id: session.gateway_id, farm_id: session.farm_id, zone_id: session.zone_id, key_version: nextKeyVersion } }),
      prisma.node.upsert({
        where: { id: session.node_id },
        update: { farm_id: session.farm_id, zone_id: session.zone_id, gateway_id: session.gateway_id, owner_id: session.requested_by_id, type: "SENSOR_NODE", connection_mode: NodeConnectionMode.LORA_GATEWAY, deployment_mode: "LEAF_NODE", capabilities: identityCapabilities(identity), is_activated: true, online: true, rssi, last_seen: now },
        create: { id: session.node_id, serial_number: identity.serial_number, name: session.node_id, farm_id: session.farm_id, zone_id: session.zone_id, gateway_id: session.gateway_id, owner_id: session.requested_by_id, type: "SENSOR_NODE", connection_mode: NodeConnectionMode.LORA_GATEWAY, deployment_mode: "LEAF_NODE", capabilities: identityCapabilities(identity), is_activated: true, online: true, rssi, last_seen: now },
      }),
      prisma.deviceIdentity.update({ where: { device_id: session.node_id }, data: { state: "CLAIMED", claimed_by_id: session.requested_by_id, claimed_farm_id: session.farm_id, claimed_at: now } }),
      prisma.pairingSession.update({ where: { id: session.id }, data: { status: "ACTIVE", confirmed_at: now, last_rssi: rssi, last_snr: snr } }),
    ]);
    return res.json({ success: true, data: { pairingId: session.id, status: "ACTIVE", nodeId: session.node_id, gatewayId: session.gateway_id } });
  } catch (error: any) {
    const failure = onboardingError(error, "Không xác nhận được phiên ghép nối");
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

// The board polls this endpoint with its existing credential; commands are
// strictly scoped to that credential and expired commands are not deliverable.
async function nextDeviceCommand(req: GatewayRequest, res: Response) {
  const now = new Date();
  await prisma.deviceLifecycleCommand.updateMany({ where: { device_id: req.gatewayId!, status: { in: ["PENDING", "ACKNOWLEDGED"] }, expires_at: { lte: now } }, data: { status: "EXPIRED" } });
  const command = await prisma.deviceLifecycleCommand.findFirst({ where: { device_id: req.gatewayId!, status: { in: ["PENDING", "ACKNOWLEDGED"] }, expires_at: { gt: now } }, orderBy: { created_at: "asc" } });
  if (!command) return res.json({ success: true, data: null });
  return res.json({ success: true, data: { commandId: command.id, type: command.type, expiresAt: command.expires_at.toISOString() } });
}
router.get("/device-commands/next", requireGatewayAuth, nextDeviceCommand);
router.post("/device-commands/next", requireGatewayAuth, nextDeviceCommand);

router.post("/device-commands/:id/ack", requireGatewayAuth, async (req: GatewayRequest, res: Response) => {
  const command = await prisma.deviceLifecycleCommand.findFirst({ where: { id: req.params.id, device_id: req.gatewayId!, expires_at: { gt: new Date() } } });
  if (!command || !["PENDING", "ACKNOWLEDGED"].includes(command.status)) return res.status(409).json({ success: false, error: "Lệnh không còn hiệu lực" });
  const updated = await prisma.deviceLifecycleCommand.updateMany({ where: { id: command.id, status: "PENDING" }, data: { status: "ACKNOWLEDGED", acknowledged_at: new Date() } });
  return res.json({ success: true, data: { commandId: command.id, status: updated.count ? "ACKNOWLEDGED" : command.status } });
});

router.post("/device-commands/:id/applied", requireGatewayAuth, async (req: GatewayRequest, res: Response) => {
  try {
    const result = await prisma.$transaction(async (tx) => {
      const deviceId = req.gatewayId!;
      await tx.$queryRaw`SELECT device_id FROM device_identities WHERE device_id = ${deviceId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM device_lifecycle_commands WHERE id = ${req.params.id} AND device_id = ${deviceId} FOR UPDATE`;
      const command = await tx.deviceLifecycleCommand.findFirst({ where: { id: req.params.id, device_id: deviceId } });
      if (!command || command.expires_at <= new Date()) throw new Error("Lệnh không còn hiệu lực");
      if (command.status === "APPLIED") return command;
      if (command.status !== "ACKNOWLEDGED" || command.type !== "RELEASE_ACCOUNT") throw new Error("Lệnh chưa được board xác nhận");
      const identity = await tx.deviceIdentity.findUnique({ where: { device_id: deviceId }, select: { state: true, identity_version: true, batch_id: true } });
      if (!identity) throw new Error("Không tìm thấy danh tính board");
      await releaseDeviceAccount(tx, deviceId, identity, { commandId: command.id });
      return tx.deviceLifecycleCommand.update({ where: { id: command.id }, data: { status: "APPLIED", applied_at: new Date() } });
    });
    return res.json({ success: true, data: { commandId: result.id, status: result.status } });
  } catch (error: any) {
    return res.status(409).json({ success: false, error: error.message || "Không thể hoàn tất lệnh" });
  }
});

router.post("/device/status", requireGatewayAuth, async (req: GatewayRequest, res: Response) => {
  const device = await prisma.node.update({ where: { id: req.gatewayId! }, data: {
    online: true, last_seen: new Date(),
    firmware_version: req.body.firmwareVersion ? String(req.body.firmwareVersion).slice(0, 64) : undefined,
  } });
  return res.json({ success: true, data: publicGateway(device) });
});

router.post("/gateway/status", requireGatewayAuth, async (req: GatewayRequest, res: Response) => {
  const gateway = await prisma.node.update({
    where: { id: req.gatewayId! },
    data: { online: true, last_seen: new Date(), firmware_version: req.body.firmwareVersion ? String(req.body.firmwareVersion).slice(0, 64) : undefined },
  });
  return res.json({ success: true, data: publicGateway(gateway) });
});

router.post("/gateway/telemetry", requireGatewayAuth, async (req: GatewayRequest, res: Response) => {
  const parsed = gatewayTelemetrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Telemetry không hợp lệ" });
  const payload = parsed.data;
  try {
    const result = await prisma.$transaction(async tx => {
      const gateway = await tx.node.findUnique({ where: { id: req.gatewayId! } });
      const node = await tx.node.findUnique({ where: { id: payload.nodeId } });
      const isDirect = payload.nodeId === req.gatewayId! &&
        ["GATEWAY", "STANDALONE_NODE"].includes(node?.deployment_mode || "");
      const binding = isDirect ? null : await tx.nodeGatewayBinding.findFirst({ where: {
        node_id: payload.nodeId, gateway_id: req.gatewayId!, status: "ACTIVE",
      } });
      if (!gateway || !node?.is_activated || !node.zone_id || !node.farm_id ||
          (!isDirect && (!binding || node.gateway_id !== gateway.id || node.farm_id !== gateway.farm_id))) return null;
      // Namespacing prevents a different Gateway consuming this event identifier.
      const eventId = `gw:${gateway.id}:${payload.eventId}`;
      const inserted = await tx.ingestEvent.createMany({ data: [{ event_id: eventId,
        message_type: "telemetry", farm_id: node.farm_id, node_id: node.id }], skipDuplicates: true });
      if (inserted.count === 0) return { duplicate: true, nodeId: node.id };
      const { eventId: ignored, nodeId: ignoredNode, timestamp, ...sensors } = payload;
      const now = Date.now();
      const recordedAt = timestamp !== undefined && timestamp >= 1577836800 && timestamp * 1000 <= now + 300000
        ? new Date(timestamp * 1000) : new Date(now);
      const row = await tx.telemetryData.create({ data: { ...sensors, node_id: node.id,
        farm_id: node.farm_id, zone_id: node.zone_id, timestamp: recordedAt } });
      await tx.node.update({ where: { id: node.id }, data: { online: true, last_seen: new Date() } });
      return { duplicate: false, nodeId: node.id, row };
    }, { isolationLevel: "Serializable" });
    // A revoked leaf must not permanently block the Gateway's persistent outbox.
    // It is acknowledged as dropped, but no telemetry row is accepted.
    if (!result) return res.json({ success: true, data: { persisted: true, dropped: true } });
    if (result.row) {
      const row = result.row;
      broadcastTelemetry({ farmId: row.farm_id, zoneId: row.zone_id, nodeId: row.node_id,
        soil_temp: row.soil_temp ?? undefined, air_temp: row.air_temp ?? undefined,
        soil_moisture: row.soil_moisture ?? undefined, air_humidity: row.air_humidity ?? undefined,
        lux: row.lux ?? undefined,
        quality: row.quality, timestamp: Math.floor(row.timestamp.getTime() / 1000) });
    }
    return res.json({ success: true, data: { persisted: true, duplicate: result.duplicate,
      nodeId: result.nodeId, telemetryId: result.row?.id } });
  } catch {
    // The dedup marker rolls back with the row: a Gateway may retry safely.
    return res.status(503).json({ success: false, error: "Chưa lưu được dữ liệu; Gateway cần gửi lại" });
  }
});

router.post("/device/telemetry", requireGatewayAuth, async (req: GatewayRequest, res: Response) => {
  // Reuse the exact persistence contract while accepting unified device headers.
  req.body = { ...req.body, nodeId: req.gatewayId };
  const parsed = gatewayTelemetrySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ success: false, error: "Telemetry không hợp lệ" });
  const payload = parsed.data;
  try {
    const result = await prisma.$transaction(async tx => {
      const device = await tx.node.findUnique({ where: { id: req.gatewayId! } });
      if (!device?.is_activated || !device.zone_id || !device.farm_id || !["GATEWAY", "STANDALONE_NODE"].includes(device.deployment_mode)) return null;
      const eventId = `direct:${device.id}:${payload.eventId}`;
      const inserted = await tx.ingestEvent.createMany({ data: [{ event_id: eventId,
        message_type: "telemetry", farm_id: device.farm_id, node_id: device.id }], skipDuplicates: true });
      if (!inserted.count) return { duplicate: true, device, row: null };
      const { eventId: ignoredEvent, nodeId: ignoredNode, timestamp, ...sensors } = payload;
      const now = Date.now();
      const recordedAt = timestamp !== undefined && timestamp >= 1577836800 && timestamp * 1000 <= now + 300000
        ? new Date(timestamp * 1000) : new Date(now);
      const row = await tx.telemetryData.create({ data: { ...sensors, node_id: device.id,
        farm_id: device.farm_id, zone_id: device.zone_id, timestamp: recordedAt } });
      await tx.node.update({ where: { id: device.id }, data: { online: true, last_seen: new Date() } });
      return { duplicate: false, device, row };
    }, { isolationLevel: "Serializable" });
    if (!result) return res.status(403).json({ success: false, error: "Thiết bị không ở chế độ cloud trực tiếp" });
    if (result.row) broadcastTelemetry({ farmId: result.row.farm_id, zoneId: result.row.zone_id,
      nodeId: result.row.node_id, soil_temp: result.row.soil_temp ?? undefined,
      soil_moisture: result.row.soil_moisture ?? undefined,
      air_temp: result.row.air_temp ?? undefined,
      air_humidity: result.row.air_humidity ?? undefined,
      lux: result.row.lux ?? undefined,
      quality: result.row.quality, timestamp: Math.floor(result.row.timestamp.getTime() / 1000) });
    return res.json({ success: true, data: { persisted: true, duplicate: result.duplicate, telemetryId: result.row?.id } });
  } catch {
    return res.status(503).json({ success: false, error: "Chưa lưu được dữ liệu; thiết bị cần gửi lại" });
  }
});


export default router;
