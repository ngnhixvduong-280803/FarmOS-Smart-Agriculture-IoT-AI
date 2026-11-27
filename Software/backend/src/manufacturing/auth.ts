import crypto from "crypto";
import { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { AuthRequest, authenticate } from "../api/middleware/auth.middleware";

export interface ManufacturingActor {
  type: "USER" | "STATION" | "MTLS";
  id: string;
  scopes: string[];
}

export interface ManufacturingRequest extends AuthRequest {
  manufacturingActor?: ManufacturingActor;
  idempotencyKey?: string;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function stationCredentials(): Array<{ id: string; token: string; scopes: string[] }> {
  const configured: Array<{ id: string; token: string; scopes: string[] }> = [];
  const pairs = env.MANUFACTURING_STATION_TOKENS || process.env.MANUFACTURING_STATION_TOKENS || "";
  for (const entry of pairs.split(",")) {
    const value = entry.trim();
    if (!value) continue;
    const separator = value.indexOf(":");
    if (separator <= 0) continue;
    const id = value.slice(0, separator).trim();
    const tokenAndScopes = value.slice(separator + 1).trim();
    const [token, scopeText] = tokenAndScopes.split("|", 2);
    if (id && token) configured.push({ id, token, scopes: scopeText ? scopeText.split(";").filter(Boolean) : ["manufacturing:write"] });
  }
  const singleToken = env.MANUFACTURING_STATION_TOKEN || process.env.MANUFACTURING_STATION_TOKEN;
  if (singleToken) {
    configured.push({
      id: env.MANUFACTURING_STATION_ID || process.env.MANUFACTURING_STATION_ID || "manufacturing-station",
      token: singleToken,
      scopes: ["manufacturing:write"],
    });
  }
  return configured;
}

function resolveStation(req: Request): ManufacturingActor | null {
  const stationId = (req.header("x-farmos-station-id") || req.header("x-manufacturing-station-id") || "").trim();
  const token = (req.header("x-farmos-station-token") || req.header("x-manufacturing-station-token") || "").trim();
  if (stationId && token) {
    const station = stationCredentials().find((candidate) => candidate.id === stationId && safeEqual(candidate.token, token));
    if (station) return { type: "STATION", id: station.id, scopes: station.scopes };
  }

  // When TLS is terminated inside the Node process, use the socket-level
  // certificate verification result. A proxy-provided header is intentionally
  // not trusted here; deployments can map verified mTLS identities to the
  // same station token at the edge.
  const socket = req.socket as typeof req.socket & { authorized?: boolean; getPeerCertificate?: () => { subject?: { CN?: string } } };
  if (socket.authorized === true && stationId) {
    const subject = socket.getPeerCertificate?.()?.subject?.CN;
    if (subject && subject === stationId) return { type: "MTLS", id: stationId, scopes: ["manufacturing:write"] };
  }
  return null;
}

export function requireManufacturingAuth(req: ManufacturingRequest, res: Response, next: NextFunction): void {
  const station = resolveStation(req);
  if (station) {
    req.manufacturingActor = station;
    next();
    return;
  }

  // Admin browser/mobile sessions are also permitted for the management UI.
  // Factory station writes should use the scoped station credential above.
  void authenticate(req as AuthRequest, res, () => {
    if (!req.user || req.user.role !== "ADMIN") {
      res.status(403).json({ success: false, error: "Manufacturing admin hoặc station credential bắt buộc" });
      return;
    }
    req.manufacturingActor = { type: "USER", id: req.user.id, scopes: ["manufacturing:read", "manufacturing:write"] };
    next();
  });
}

export function requireIdempotency(req: ManufacturingRequest, res: Response, next: NextFunction): void {
  const key = req.header("Idempotency-Key")?.trim();
  if (!key || key.length > 128) {
    res.status(400).json({ success: false, error: "Idempotency-Key header is required (1-128 characters)" });
    return;
  }
  req.idempotencyKey = key;
  next();
}

export function actorOf(req: ManufacturingRequest): ManufacturingActor {
  return req.manufacturingActor || { type: "USER", id: "unknown", scopes: [] };
}
