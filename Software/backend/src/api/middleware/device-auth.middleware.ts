import { NextFunction, Request, Response } from "express";
import crypto from "crypto";
import { env } from "../../config/env";

function safelyMatches(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Protects the HTTP fallback used by physical gateways. Browser user sessions are
 * intentionally not accepted here: a device must present its provisioned secret.
 */
export function requireDeviceAuth(req: Request, res: Response, next: NextFunction) {
  if (!env.ENABLE_LEGACY_PROVISIONING) {
    return res.status(410).json({ success: false, error: "Legacy v2 telemetry is disabled; use device-scoped onboarding credentials" });
  }
  const token = req.header("x-farmos-device-token");
  if (!env.DEVICE_INGEST_TOKEN || !token || !safelyMatches(env.DEVICE_INGEST_TOKEN, token)) {
    return res.status(401).json({ success: false, error: "Device authentication failed" });
  }
  next();
}
