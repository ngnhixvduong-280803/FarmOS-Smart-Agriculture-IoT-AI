/**
 * FarmOS device QR contracts.
 *
 * QR v3 is deliberately a bounded, signed JSON document. It is not a URL,
 * and the mobile app must never follow arbitrary QR links. Signature
 * verification remains server-side at /onboarding/qr/resolve; this module is
 * only the strict parser and transport guard used before that request.
 */

import type { QrV3Payload } from "../types";

export const MAX_QR_PAYLOAD_LENGTH = 4096;

const V3_KEYS = [
  "v",
  "issuer",
  "qrId",
  "deviceId",
  "serial",
  "type",
  "model",
  "hardwareRevision",
  "kid",
  "sig",
] as const;

type LegacyQr = {
  version: 1 | 2;
  deviceId: string;
  serial?: string;
  claim: string;
};

export type ParsedDeviceQr =
  | { version: 3; payload: QrV3Payload }
  | { version: 1 | 2; legacy: LegacyQr };

function boundedString(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string") throw new Error(`QR thiếu ${field}`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`QR có ${field} không hợp lệ`);
  return normalized;
}

function rejectArbitraryTransport(value: string): void {
  const trimmed = value.trim();
  // A QR is data, never a navigation surface. Reject URLs and URI schemes
  // before JSON parsing so javascript:, intent:, file:, and custom app links
  // cannot enter the onboarding flow either.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    throw new Error("QR FarmOS phải là JSON v3/v2, không phải đường dẫn URL");
  }
}

function parseV3(value: Record<string, unknown>): QrV3Payload {
  const keys = Object.keys(value).sort();
  const expected = [...V3_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("QR v3 phải có đúng payload v,issuer,qrId,deviceId,serial,type,model,hardwareRevision,kid,sig");
  }
  if (value.v !== 3) throw new Error("QR không phải FarmOS v3");
  const issuer = boundedString(value.issuer, "issuer", 32);
  if (issuer !== "farmos") throw new Error("QR không thuộc issuer FarmOS");
  const type = boundedString(value.type, "type", 32);
  if (type !== "GATEWAY" && type !== "SENSOR_NODE") throw new Error("QR có loại thiết bị không hợp lệ");
  const sig = boundedString(value.sig, "sig", 512);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(sig)) throw new Error("QR có chữ ký không hợp lệ");
  const kid = boundedString(value.kid, "kid", 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(kid)) throw new Error("QR có key id không hợp lệ");
  return {
    v: 3,
    issuer,
    qrId: boundedString(value.qrId, "qrId", 128),
    deviceId: boundedString(value.deviceId, "deviceId", 128),
    serial: boundedString(value.serial, "serial", 128),
    type,
    model: boundedString(value.model, "model", 128),
    hardwareRevision: boundedString(value.hardwareRevision, "hardwareRevision", 64),
    kid,
    sig,
  };
}

function parseLegacy(value: Record<string, unknown>): LegacyQr {
  if (value.v !== 1 && value.v !== 2) throw new Error("QR FarmOS chỉ hỗ trợ v2 legacy hoặc v3");
  const deviceId = boundedString(value.deviceId ?? value.id, "deviceId", 128);
  const claim = boundedString(value.claim ?? value.claimCode, "claim", 256);
  return {
    version: value.v,
    deviceId,
    serial: typeof value.serial === "string" ? value.serial.trim().slice(0, 128) || undefined : undefined,
    claim,
  };
}

/** Parse a raw camera value. URLs and non-JSON URI payloads are rejected. */
export function parseDeviceQr(value: string): ParsedDeviceQr {
  if (typeof value !== "string") throw new Error("QR thiết bị phải là chuỗi JSON");
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_QR_PAYLOAD_LENGTH) throw new Error("QR thiết bị rỗng hoặc vượt giới hạn");
  rejectArbitraryTransport(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("QR thiết bị phải là JSON FarmOS");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("QR thiết bị không đúng định dạng");
  const record = parsed as Record<string, unknown>;
  if (record.v === 3) return { version: 3, payload: parseV3(record) };
  return { version: record.v as 1 | 2, legacy: parseLegacy(record) };
}

export function qrModeForType(type: QrV3Payload["type"]): "GATEWAY" | "SENSOR_NODE" {
  return type;
}
