import crypto from "crypto";
import { env } from "../config/env";

export function createOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

// Retry a redeemed session without persisting the plaintext operational token.
// The session secret and server key are both needed to reproduce it.
export function gatewaySessionToken(gatewayId: string, sessionId: string, provisioningToken: string): string {
  return crypto.createHmac("sha384", env.JWT_SECRET)
    .update(["gateway-credential-v1", gatewayId, sessionId, provisioningToken].join("\0"))
    .digest("base64url");
}

export function hashDeviceSecret(scope: string, value: string): string {
  return crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update(`${scope}\0${value}`)
    .digest("hex");
}

export function matchesDeviceSecret(scope: string, expectedHash: string, value: string): boolean {
  const actual = Buffer.from(hashDeviceSecret(scope, value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * A redeemed session may be retried only to recover the same already-issued
 * credential after a transport failure. The route still checks the
 * device-scoped token and stored credential before returning it.
 */
export function isProvisioningSessionUsable(
  status: string,
  expiresAt: Date,
  now = new Date(),
): boolean {
  return (status === "PENDING" || status === "REDEEMED") && expiresAt.getTime() > now.getTime();
}

export function pairingRadioToken(input: {
  id: string;
  nodeId: string;
  gatewayId: string;
  farmId: string;
  zoneId: string;
  expiresAt: Date;
}): string {
  return crypto
    .createHmac("sha256", env.JWT_SECRET)
    .update([input.id, input.nodeId, input.gatewayId, input.farmId, input.zoneId, input.expiresAt.toISOString()].join("\0"))
    .digest("hex")
    .slice(0, 32);
}

export interface OtaDownloadTicket {
  deviceId: string;
  jobId: string;
  releaseId: string;
  sha256: string;
  imageId?: string;
  expiresAt: number;
}

export function createOtaDownloadTicket(payload: OtaDownloadTicket): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", env.JWT_SECRET)
    .update(`ota-download-v1\0${encoded}`)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyOtaDownloadTicket(value: string): OtaDownloadTicket | null {
  const [encoded, provided, extra] = value.split(".");
  if (!encoded || !provided || extra) return null;
  const expected = crypto.createHmac("sha256", env.JWT_SECRET)
    .update(`ota-download-v1\0${encoded}`)
    .digest();
  const actual = Buffer.from(provided, "base64url");
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OtaDownloadTicket;
    if (!parsed.deviceId || !parsed.jobId || !parsed.releaseId || (parsed.imageId !== undefined && typeof parsed.imageId !== "string") || !/^[a-f0-9]{64}$/.test(parsed.sha256) ||
        !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt <= Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}
