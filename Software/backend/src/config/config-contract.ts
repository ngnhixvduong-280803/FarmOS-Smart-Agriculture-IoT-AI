import crypto from "node:crypto";

export type ConfigSource = Record<string, string | undefined>;

export interface CanonicalUrls {
  webUrl: string;
  apiUrl: string;
  warnings: string[];
}

export interface SecurityConfigResult {
  errors: string[];
  warnings: string[];
}

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function value(source: ConfigSource, key: string): string {
  return String(source[key] ?? "").trim();
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function normalizePem(value: string): string {
  return unquote(value).replace(/\\n/g, "\n").trim();
}

export function normalizeCanonicalUrl(raw: string, key: string, production = false): string {
  const candidate = unquote(raw);
  if (!candidate) throw new Error(`${key} is required`);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${key} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${key} must use http or https`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`${key} must not contain credentials, query, or hash`);
  if (parsed.pathname !== "/" && parsed.pathname !== "") throw new Error(`${key} must not contain a path such as /api/v1`);
  if (production && parsed.protocol !== "https:") throw new Error(`${key} must use HTTPS in production`);
  return parsed.origin;
}

function normalizeLegacyApiUrl(raw: string, key: string, production: boolean): string {
  const candidate = unquote(raw);
  if (!candidate) throw new Error(`${key} is required`);
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`${key} must be an absolute http(s) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error(`${key} must use http or https`);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(`${key} must not contain credentials, query, or hash`);
  if (parsed.pathname && parsed.pathname !== "/" && !/^\/api\/v1(?:\/.*)?\/?$/.test(parsed.pathname)) {
    throw new Error(`${key} may only contain the legacy /api/v1 path`);
  }
  if (production && parsed.protocol !== "https:") throw new Error(`${key} must use HTTPS in production`);
  return parsed.origin;
}

export function resolveCanonicalUrls(source: ConfigSource = process.env, production = value(source, "NODE_ENV") === "production"): CanonicalUrls {
  const warnings: string[] = [];
  const webKey = value(source, "FARMOS_WEB_URL") ? "FARMOS_WEB_URL" : value(source, "DOMAIN") ? "DOMAIN" : value(source, "CORS_ORIGIN") && value(source, "CORS_ORIGIN") !== "*" ? "CORS_ORIGIN" : "";
  const apiKey = value(source, "FARMOS_API_URL") ? "FARMOS_API_URL" : value(source, "MOBILE_API_BASE_URL") ? "MOBILE_API_BASE_URL" : value(source, "BACKEND_API_URL") ? "BACKEND_API_URL" : "";
  if (!webKey) {
    if (production) throw new Error("FARMOS_WEB_URL is required in production");
  } else if (webKey !== "FARMOS_WEB_URL") warnings.push(`${webKey} is deprecated; use FARMOS_WEB_URL`);
  if (!apiKey) {
    if (production) throw new Error("FARMOS_API_URL is required in production");
  } else if (apiKey !== "FARMOS_API_URL") warnings.push(`${apiKey} is deprecated; use FARMOS_API_URL`);
  const webUrl = webKey ? normalizeCanonicalUrl(value(source, webKey), webKey, production) : "http://localhost:8080";
  const apiUrl = apiKey ? (apiKey === "FARMOS_API_URL" ? normalizeCanonicalUrl(value(source, apiKey), apiKey, production) : normalizeLegacyApiUrl(value(source, apiKey), apiKey, production)) : "http://localhost:3000";
  return { webUrl, apiUrl, warnings };
}

function parsePrivate(raw: string, key: string): crypto.KeyObject {
  try {
    return crypto.createPrivateKey(normalizePem(raw));
  } catch {
    throw new Error(`${key} is not a parseable private key`);
  }
}

function parsePublic(raw: string, key: string): crypto.KeyObject {
  try {
    const normalized = normalizePem(raw);
    if (normalized.includes("BEGIN ")) return crypto.createPublicKey(normalized);
    const decoded = Buffer.from(normalized.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64");
    return crypto.createPublicKey({ key: decoded, format: "der", type: "spki" });
  } catch {
    throw new Error(`${key} is not a parseable public key`);
  }
}

function spkiDer(key: crypto.KeyObject): Buffer {
  return key.export({ format: "der", type: "spki" }) as Buffer;
}

function samePublicKey(left: crypto.KeyObject, right: crypto.KeyObject): boolean {
  const a = spkiDer(left);
  const b = spkiDer(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function validateSecurityConfig(source: ConfigSource = process.env, production = value(source, "NODE_ENV") === "production"): SecurityConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    const urls = resolveCanonicalUrls(source, production);
    warnings.push(...urls.warnings);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "URL configuration is invalid");
  }
  const requireValue = (key: string, minimum: number) => {
    const raw = value(source, key);
    if (production && !raw) errors.push(`${key} is required in production`);
    if (raw && raw.length < minimum) errors.push(`${key} must be at least ${minimum} characters`);
  };
  requireValue("JWT_SECRET", 32);
  requireValue("HARDWARE_BOARD_HMAC_SECRET", 32);
  requireValue("DEVICE_INGEST_TOKEN", 32);
  requireValue("MQTT_PASSWORD", 16);
  if (value(source, "FIRMWARE_MANIFEST_SIGNING_KEY")) requireValue("FIRMWARE_MANIFEST_SIGNING_KEY", 32);
  for (const key of ["FIRMWARE_MANIFEST_KEY_ID", "FIRMWARE_ENROLLMENT_KEY_ID", "MANUFACTURING_QR_KEY_ID"]) {
    const raw = value(source, key);
    if (production && !raw) errors.push(`${key} is required in production`);
    if (raw && !KEY_ID_PATTERN.test(raw)) errors.push(`${key} contains invalid characters`);
  }
  const enrollmentPrivate = value(source, "FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY");
  const enrollmentPublic = value(source, "FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY");
  if (production && !enrollmentPrivate) errors.push("FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY is required in production");
  if (production && !enrollmentPublic) errors.push("FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY is required in production");
  if (enrollmentPrivate) {
    try {
      const privateKey = parsePrivate(enrollmentPrivate, "FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY");
      if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") errors.push("FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY must be EC P-256");
      if (enrollmentPublic) {
        const publicKey = parsePublic(enrollmentPublic, "FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY");
        if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") errors.push("FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY must be EC P-256");
        if (!samePublicKey(crypto.createPublicKey(privateKey), publicKey)) errors.push("FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY does not match the private key");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Firmware enrollment key configuration is invalid");
    }
  }
  const qrPrivate = value(source, "MANUFACTURING_QR_SIGNING_KEY") || value(source, "QR_SIGNING_PRIVATE_KEY");
  if (production && !qrPrivate) errors.push("MANUFACTURING_QR_SIGNING_KEY is required in production");
  if (qrPrivate) {
    try {
      if (parsePrivate(qrPrivate, "MANUFACTURING_QR_SIGNING_KEY").asymmetricKeyType !== "ed25519") errors.push("MANUFACTURING_QR_SIGNING_KEY must be Ed25519");
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "QR signing key configuration is invalid");
    }
  }
  const qrPublicMap = value(source, "MANUFACTURING_QR_PUBLIC_KEYS") || value(source, "QR_PUBLIC_KEYS");
  if (qrPublicMap) {
    try {
      const parsed = JSON.parse(qrPublicMap) as Record<string, string>;
      for (const [kid, raw] of Object.entries(parsed)) {
        if (!KEY_ID_PATTERN.test(kid)) errors.push("MANUFACTURING_QR_PUBLIC_KEYS contains an invalid key id");
        const key = parsePublic(raw, "MANUFACTURING_QR_PUBLIC_KEYS");
        if (key.asymmetricKeyType !== "ed25519") errors.push("MANUFACTURING_QR_PUBLIC_KEYS entries must be Ed25519");
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "MANUFACTURING_QR_PUBLIC_KEYS must be valid JSON");
    }
  }
  return { errors, warnings };
}

export function redactConfigKey(key: string): string {
  return /SECRET|TOKEN|PASSWORD|PRIVATE|SERVICE_ROLE|ANON_KEY|SIGNING_KEY/i.test(key) ? "[REDACTED]" : "[configured]";
}
