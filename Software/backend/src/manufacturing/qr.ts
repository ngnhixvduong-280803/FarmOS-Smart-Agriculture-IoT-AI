import {
  KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "crypto";
import { env } from "../config/env";

export const QR_V3_VERSION = 3 as const;

export interface QrV3UnsignedPayload {
  v: 3;
  issuer: string;
  qrId: string;
  deviceId: string;
  serial: string;
  type: string;
  model: string;
  hardwareRevision: string;
  kid: string;
}

export interface QrV3Payload extends QrV3UnsignedPayload {
  sig: string;
}

let developmentKeyPair: { privateKey: KeyObject; publicKey: KeyObject } | undefined;

function runtimeValue(name: keyof typeof env): string | undefined {
  const processValue = process.env[name];
  if (typeof processValue === "string" && processValue.length > 0) return processValue;
  const configured = env[name];
  return typeof configured === "string" && configured.length > 0 ? configured : undefined;
}

function runtimeAny(names: Array<keyof typeof env | string>): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.length > 0) return value;
    const configured = (env as Record<string, unknown>)[name];
    if (typeof configured === "string" && configured.length > 0) return configured;
  }
  return undefined;
}

export function decodeBase64Url(value: string): Buffer {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(normalized, "base64");
}

export function encodeBase64Url(value: Buffer): string {
  return value.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function normalisePem(raw: string): string {
  return raw.trim().replace(/\\n/g, "\n");
}

function keyFromRaw(raw: string, kind: "private" | "public"): KeyObject {
  const normalised = normalisePem(raw);
  if (normalised.includes("BEGIN ")) {
    return kind === "private" ? createPrivateKey(normalised) : createPublicKey(normalised);
  }

  // Accept PKCS#8/SPKI DER in base64, plus a raw Ed25519 public key. Raw
  // private seeds are accepted using the standard PKCS#8 wrapper.
  const decoded = /^[0-9a-fA-F]+$/.test(normalised) && normalised.length % 2 === 0
    ? Buffer.from(normalised, "hex")
    : Buffer.from(normalised, "base64");
  if (kind === "public" && decoded.length === 32) {
    return createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), decoded]),
      format: "der",
      type: "spki",
    });
  }
  if (kind === "private" && decoded.length === 32) {
    return createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), decoded]),
      format: "der",
      type: "pkcs8",
    });
  }
  return kind === "private"
    ? createPrivateKey({ key: decoded, format: "der", type: "pkcs8" })
    : createPublicKey({ key: decoded, format: "der", type: "spki" });
}

function signingKeyPair(): { privateKey: KeyObject; publicKey: KeyObject } {
  const configured = runtimeAny(["MANUFACTURING_QR_SIGNING_KEY", "QR_SIGNING_PRIVATE_KEY", "QR_PRIVATE_KEY", "FARMOS_QR_SIGNING_KEY"]);
  if (configured) {
    const privateKey = keyFromRaw(configured, "private");
    return { privateKey, publicKey: createPublicKey(privateKey) };
  }
  if (env.NODE_ENV === "production") {
    throw new Error("MANUFACTURING_QR_SIGNING_KEY is required in production");
  }
  developmentKeyPair ??= generateKeyPairSync("ed25519");
  return developmentKeyPair;
}

function verificationKey(kid: string): KeyObject {
  const configuredMap = runtimeAny(["MANUFACTURING_QR_PUBLIC_KEYS", "QR_PUBLIC_KEYS", "FARMOS_QR_PUBLIC_KEYS"]);
  if (configuredMap) {
    try {
      const values = JSON.parse(configuredMap) as Record<string, string>;
      if (values[kid]) return keyFromRaw(values[kid], "public");
    } catch {
      if (env.NODE_ENV === "production") throw new Error("MANUFACTURING_QR_PUBLIC_KEYS must be valid JSON");
    }
  }
  const keyPair = signingKeyPair();
  const configuredKid = runtimeAny(["MANUFACTURING_QR_KEY_ID", "QR_KEY_ID", "QR_KID", "FARMOS_QR_KEY_ID"]) || "dev-v3";
  if (kid !== configuredKid) throw new Error("Unknown QR signing key id");
  return keyPair.publicKey;
}

export function qrIssuer(): string {
  return runtimeAny(["MANUFACTURING_QR_ISSUER", "QR_ISSUER", "FARMOS_QR_ISSUER"]) || "farmos";
}

export function qrKeyId(): string {
  return runtimeAny(["MANUFACTURING_QR_KEY_ID", "QR_KEY_ID", "QR_KID", "FARMOS_QR_KEY_ID"]) || "dev-v3";
}

export function canonicalizeQrV3(payload: QrV3UnsignedPayload): string {
  // Do not use a generic object spread here. This field order is the signed
  // wire contract and is intentionally independent from database key order.
  return JSON.stringify({
    v: payload.v,
    issuer: payload.issuer,
    qrId: payload.qrId,
    deviceId: payload.deviceId,
    serial: payload.serial,
    type: payload.type,
    model: payload.model,
    hardwareRevision: payload.hardwareRevision,
    kid: payload.kid,
  });
}

export function signQrV3(payload: QrV3UnsignedPayload): QrV3Payload {
  const keyPair = signingKeyPair();
  const canonical = canonicalizeQrV3(payload);
  const signature = sign(null, Buffer.from(canonical, "utf8"), keyPair.privateKey);
  return { ...payload, sig: encodeBase64Url(signature) };
}

function isNonEmptyString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

export function parseQrPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function verifyQrV3(value: unknown): QrV3Payload {
  const candidate = parseQrPayload(value) as Partial<QrV3Payload> | null;
  if (!candidate || typeof candidate !== "object") throw new Error("QR payload must be an object");
  if (candidate.v !== QR_V3_VERSION ||
      !isNonEmptyString(candidate.issuer, 128) ||
      !isNonEmptyString(candidate.qrId, 128) ||
      !isNonEmptyString(candidate.deviceId, 128) ||
      !isNonEmptyString(candidate.serial, 128) ||
      !isNonEmptyString(candidate.type, 64) ||
      !isNonEmptyString(candidate.model, 128) ||
      !isNonEmptyString(candidate.hardwareRevision, 64) ||
      !isNonEmptyString(candidate.kid, 128) ||
      !isNonEmptyString(candidate.sig, 256)) {
    throw new Error("QR v3 payload is incomplete");
  }
  const allowedKeys = new Set(["v", "issuer", "qrId", "deviceId", "serial", "type", "model", "hardwareRevision", "kid", "sig"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) throw new Error("QR v3 payload contains unsupported fields");
  if (candidate.issuer !== qrIssuer()) throw new Error("QR issuer is not trusted");
  const signature = decodeBase64Url(candidate.sig);
  if (signature.length !== 64) throw new Error("QR signature is malformed");
  const unsigned: QrV3UnsignedPayload = {
    v: 3,
    issuer: candidate.issuer,
    qrId: candidate.qrId,
    deviceId: candidate.deviceId,
    serial: candidate.serial,
    type: candidate.type,
    model: candidate.model,
    hardwareRevision: candidate.hardwareRevision,
    kid: candidate.kid,
  };
  let trustedKey: KeyObject;
  try {
    trustedKey = verificationKey(candidate.kid);
  } catch {
    throw new Error("QR signing key is unavailable");
  }
  if (!verify(null, Buffer.from(canonicalizeQrV3(unsigned), "utf8"), trustedKey, signature)) {
    throw new Error("QR signature is invalid");
  }
  return { ...unsigned, sig: candidate.sig };
}

export function qrPayloadForLabel(label: { canonical_payload: string; signature: string }): QrV3Payload {
  const unsigned = parseQrPayload(label.canonical_payload) as QrV3UnsignedPayload | null;
  if (!unsigned) throw new Error("Stored QR canonical payload is malformed");
  return verifyQrV3({ ...unsigned, sig: label.signature });
}

export function devicePublicKey(raw: string): KeyObject {
  const key = keyFromRaw(raw, "public");
  if (!key.asymmetricKeyType || !["ed25519", "rsa", "rsa-pss", "ec"].includes(key.asymmetricKeyType)) {
    throw new Error("Unsupported device public key algorithm");
  }
  return key;
}

export function publicKeyFingerprint(raw: string): string {
  const key = devicePublicKey(raw);
  return createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex");
}

export interface DeviceAttestationContext {
  deviceId: string;
  sessionId: string;
  provisioningToken: string;
  nonce: Buffer;
  identityVersion: number;
}

export type DeviceAttestationAlgorithm = "ed25519" | "ecdsa-p256-sha256";

/**
 * Firmware targets are an explicit algorithm contract. The production
 * ESP32-S3 LoRa targets sign the SHA-256 transcript with a P-256 ECDSA key;
 * a target may opt into the older Ed25519 vector only by naming it
 * explicitly. Unknown targets are rejected by the route rather than silently
 * falling back to whatever key happens to be stored.
 */
export function expectedAttestationAlgorithm(firmwareTarget: string): DeviceAttestationAlgorithm | null {
  const target = firmwareTarget.trim().toUpperCase();
  if (!target) return null;
  if (target.includes("ED25519")) return "ed25519";
  if (target.includes("ECDSA") || target.includes("P256") || target.startsWith("ESP32S3_LORA_")) return "ecdsa-p256-sha256";
  return null;
}

export function keyAttestationAlgorithm(key: KeyObject): DeviceAttestationAlgorithm | null {
  if (key.asymmetricKeyType === "ed25519") return "ed25519";
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return "ecdsa-p256-sha256";
  return null;
}

/**
 * Store an explicit algorithm name rather than Node's ambiguous `ec` label.
 * Keeping the value stable in the database makes the firmware-target contract
 * auditable and avoids treating an arbitrary EC curve as P-256.
 */
export function storedPublicKeyAlgorithm(key: KeyObject): string | null {
  const algorithm = keyAttestationAlgorithm(key);
  if (algorithm === "ed25519") return "ed25519";
  if (algorithm === "ecdsa-p256-sha256") return "ecdsa-p256-sha256";
  return null;
}

export function isAttestationAlgorithmAllowed(publicKeyRaw: string, firmwareTarget: string): boolean {
  try {
    const expected = expectedAttestationAlgorithm(firmwareTarget);
    const actual = keyAttestationAlgorithm(devicePublicKey(publicKeyRaw));
    return Boolean(expected && actual && expected === actual);
  } catch {
    return false;
  }
}

const ATTESTATION_DOMAIN = "farmos-ble-provision-v3";

function u32(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value >>> 0, 0);
  return output;
}

function lengthPrefixed(value: Buffer): Buffer {
  return Buffer.concat([u32(value.length), value]);
}

function stringPart(value: string): Buffer {
  return lengthPrefixed(Buffer.from(value, "utf8"));
}

/** The nonce sent over BLE is deterministic from the server challenge. */
export function attestationNonce(challenge: string): string {
  return encodeBase64Url(createHash("sha256").update(`farmos-ble-nonce:${challenge}`, "utf8").digest().subarray(0, 24));
}

/**
 * Canonical message signed by factory firmware. Production ESP32-S3 targets
 * sign the SHA-256 transcript digest with ECDSA P-256/SHA-256; the explicit
 * firmware algorithm gate below prevents falling back to the raw challenge.
 */
export function attestationMessage(context: DeviceAttestationContext): Buffer {
  if (!Number.isInteger(context.identityVersion) || context.identityVersion < 1 || context.identityVersion > 0xffffffff) {
    throw new Error("identityVersion is invalid");
  }
  const tokenDigest = createHash("sha256").update(context.provisioningToken, "utf8").digest();
  const transcript = Buffer.concat([
    stringPart(ATTESTATION_DOMAIN),
    stringPart(context.deviceId),
    stringPart(context.sessionId),
    lengthPrefixed(tokenDigest),
    lengthPrefixed(context.nonce),
    u32(context.identityVersion),
  ]);
  return createHash("sha256").update(transcript).digest();
}

export function verifyDeviceAttestation(publicKeyRaw: string, message: Buffer, signatureValue: string): boolean {
  try {
    const signature = decodeBase64Url(signatureValue);
    if (signature.length === 0) return false;
    const key = devicePublicKey(publicKeyRaw);
    if (key.asymmetricKeyType === "ed25519" && verify(null, message, key, signature)) return true;
    // Keep the digest contract for RSA/EC factory keys as well. The firmware
    // currently provisions Ed25519, but accepting the stored algorithm here
    // preserves the explicit manufacturing key-type contract.
    return verify("sha256", message, key, signature);
  } catch {
    return false;
  }
}

export function verifyDeviceAttestationForFirmware(
  publicKeyRaw: string,
  storedAlgorithm: string,
  firmwareTarget: string,
  message: Buffer,
  signatureValue: string,
): boolean {
  try {
    const key = devicePublicKey(publicKeyRaw);
    const expected = expectedAttestationAlgorithm(firmwareTarget);
    const actual = keyAttestationAlgorithm(key);
    const normalizedStoredAlgorithm = storedAlgorithm.trim().toLowerCase();
    const storedMatches = actual === "ed25519"
      ? normalizedStoredAlgorithm === "ed25519"
      : ["ecdsa-p256-sha256", "ecdsa-p256", "ec"].includes(normalizedStoredAlgorithm);
    if (!expected || !actual || expected !== actual || !storedMatches) return false;
    const signature = decodeBase64Url(signatureValue);
    if (!signature.length) return false;
    return actual === "ed25519"
      ? verify(null, message, key, signature)
      : verify("sha256", message, key, signature);
  } catch {
    return false;
  }
}
