import { NextFunction, Request, Response } from "express";
import { prisma } from "../../database/prisma";
import { matchesDeviceSecret } from "../../security/device-secrets";

export interface GatewayRequest extends Request {
  gatewayId?: string;
}

export async function requireGatewayAuth(req: GatewayRequest, res: Response, next: NextFunction) {
  // New unified device headers are preferred. Keep the Gateway names during the
  // migration so already-flashed boards do not lose access.
  const gatewayId = (req.header("x-farmos-device-id") || req.header("x-farmos-gateway-id"))?.trim();
  const token = (req.header("x-farmos-device-token") || req.header("x-farmos-gateway-token"))?.trim();
  if (!gatewayId || !token) {
    return res.status(401).json({ success: false, error: "Thiếu định danh hoặc token Gateway" });
  }

  // Credential validity is not sufficient: manufacturing quarantine/revoke
  // must take effect even when an old token has not yet expired. Keep this
  // check in the auth middleware so every Gateway/device route inherits the
  // lifecycle terminal-state decision.
  const [identity, node] = await Promise.all([
    prisma.deviceIdentity.findUnique({ where: { device_id: gatewayId }, select: { state: true, type: true, identity_version: true, hardware_board_id: true, generation_state: true, is_current: true } }),
    prisma.node.findUnique({ where: { id: gatewayId }, select: { is_activated: true, type: true, deployment_mode: true, connection_mode: true } }),
  ]);
  if (!identity) return res.status(401).json({ success: false, error: "Gateway identity is not registered" });
  if (identity.state === "REVOKED") {
    return res.status(401).json({ success: false, error: "GATEWAY_REVOKED", revoked: true });
  }
  if (identity.state === "QUARANTINED") {
    return res.status(401).json({ success: false, error: "GATEWAY_QUARANTINED", quarantined: true });
  }
  if (identity.generation_state !== "ACTIVE" || !identity.is_current) {
    return res.status(401).json({ success: false, error: "DEVICE_GENERATION_RETIRED", retired: true });
  }
  if (identity.hardware_board_id) {
    const board = await prisma.hardwareBoard.findUnique({ where: { id: identity.hardware_board_id }, select: { state: true } });
    if (!board || board.state === "BLOCKED" || board.state === "UNBOUND") {
      return res.status(401).json({ success: false, error: board?.state === "BLOCKED" ? "HARDWARE_BOARD_BLOCKED" : "HARDWARE_BOARD_UNBOUND" });
    }
  }

  const credential = await prisma.gatewayCredential.findUnique({ where: { gateway_id: gatewayId } });
  if (!credential || !matchesDeviceSecret(`gateway:${gatewayId}`, credential.token_hash, token)) {
    return res.status(401).json({ success: false, error: "Gateway authentication failed" });
  }
  // An account release deactivates the row and revokes the credential together.
  // Tell only the board presenting that revoked credential to clear its settings.
  if (credential.revoked_at) return res.status(401).json({ success: false, error: "GATEWAY_REVOKED", revoked: true });

  const isGateway = identity.type === "GATEWAY" && node?.type === "GATEWAY" && node.deployment_mode === "GATEWAY" && node.connection_mode === "WIFI";
  const isStandaloneNode = identity.type === "SENSOR_NODE" && node?.type === "SENSOR_NODE" && node.deployment_mode === "STANDALONE_NODE" && node.connection_mode === "WIFI";
  if (!node?.is_activated || (!isGateway && !isStandaloneNode)) {
    return res.status(401).json({ success: false, error: "Device is not activated for cloud authentication" });
  }
  if (identity.identity_version >= 3) {
    const prefix = identity.type === "GATEWAY" ? "GATEWAY" : "NODE";
    const suffix = gatewayId.startsWith(`${prefix}_`) ? gatewayId.slice(prefix.length + 1) : "";
    let numeric = false;
    try {
      const parsed = BigInt(suffix);
      numeric = parsed > 0n && parsed <= 0xffffffffn && /^[0-9]+$/.test(suffix);
    } catch { /* malformed IDs are rejected below */ }
    if (!numeric) return res.status(401).json({ success: false, error: "Device identity has an invalid numeric radio ID" });
  }

  req.gatewayId = gatewayId;
  next();
}
