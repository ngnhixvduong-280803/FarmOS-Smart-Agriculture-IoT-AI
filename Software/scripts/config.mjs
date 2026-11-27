import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";

const ROOT = resolve(import.meta.dirname, "..");
const ENV_PATH = resolve(ROOT, ".env");
const GENERATED_DIR = resolve(ROOT, "config/generated");
const GENERATED_PATH = resolve(GENERATED_DIR, "public.json");
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const PUBLIC_GENERATED_KEYS = Object.freeze([
  "schemaVersion",
  "webUrl",
  "apiUrl",
  "simulatorApiUrl",
  "sourceKeys",
]);

function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index < 1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[key] = value.replace(/\\n/g, "\n");
  }
  return values;
}

function envValues(path = ENV_PATH) {
  if (!existsSync(path)) throw new Error(`Missing ${path}; copy .env.example to .env first`);
  return parseEnv(readFileSync(path, "utf8"));
}

function normalizeUrl(raw, key, production, allowLegacyPath = false) {
  if (!raw) throw new Error(`${key} is required`);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`${key} must be an absolute http(s) URL`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`${key} must use http or https`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`${key} must not contain credentials, query, or hash`);
  if (url.pathname !== "/" && url.pathname !== "" && !(allowLegacyPath && /^\/api\/v1(?:\/.*)?\/?$/.test(url.pathname))) throw new Error(`${key} must not contain a path such as /api/v1`);
  if (production && url.protocol !== "https:") throw new Error(`${key} must use HTTPS in production`);
  return url.origin;
}

export function resolveConfig(values) {
  const production = String(values.NODE_ENV || "development").trim() === "production";
  const webKey = values.FARMOS_WEB_URL ? "FARMOS_WEB_URL" : values.DOMAIN ? "DOMAIN" : values.CORS_ORIGIN && values.CORS_ORIGIN !== "*" ? "CORS_ORIGIN" : "";
  const apiKey = values.FARMOS_API_URL ? "FARMOS_API_URL" : values.MOBILE_API_BASE_URL ? "MOBILE_API_BASE_URL" : values.BACKEND_API_URL ? "BACKEND_API_URL" : "";
  if (production && !webKey) throw new Error("FARMOS_WEB_URL is required in production");
  if (production && !apiKey) throw new Error("FARMOS_API_URL is required in production");
  const webUrl = normalizeUrl(values[webKey] || "http://localhost:8080", webKey || "FARMOS_WEB_URL", production);
  const apiUrl = normalizeUrl(values[apiKey] || "http://localhost:3000", apiKey || "FARMOS_API_URL", production, Boolean(apiKey && apiKey !== "FARMOS_API_URL"));
  const warnings = [];
  if (webKey && webKey !== "FARMOS_WEB_URL") warnings.push(`${webKey} is deprecated; use FARMOS_WEB_URL`);
  if (apiKey && apiKey !== "FARMOS_API_URL") warnings.push(`${apiKey} is deprecated; use FARMOS_API_URL`);
  return { production, webUrl, apiUrl, warnings, sourceKeys: { web: webKey || "default", api: apiKey || "default" } };
}

function requireLength(values, key, minimum, production, errors) {
  const current = String(values[key] || "");
  if (production && !current) errors.push(`${key} is required in production`);
  if (current && current.length < minimum) errors.push(`${key} must be at least ${minimum} characters`);
}

function parsePrivate(value, key) {
  try { return createPrivateKey(String(value).replace(/\\n/g, "\n")); } catch { throw new Error(`${key} is not a parseable private key`); }
}

function parsePublic(value, key) {
  try {
    if (String(value).includes("BEGIN ")) return createPublicKey(String(value).replace(/\\n/g, "\n"));
    const decoded = Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(String(value).length / 4) * 4, "="), "base64");
    return createPublicKey({ key: decoded, format: "der", type: "spki" });
  } catch { throw new Error(`${key} is not a parseable public key`); }
}

function sameKey(left, right) {
  return createHash("sha256").update(left.export({ format: "der", type: "spki" })).digest("hex") === createHash("sha256").update(right.export({ format: "der", type: "spki" })).digest("hex");
}

export function checkConfig(values) {
  const errors = [];
  const warnings = [];
  let resolved;
  try { resolved = resolveConfig(values); warnings.push(...resolved.warnings); } catch (error) { errors.push(error.message); }
  const production = String(values.NODE_ENV || "development") === "production";
  requireLength(values, "JWT_SECRET", 32, production, errors);
  requireLength(values, "HARDWARE_BOARD_HMAC_SECRET", 32, production, errors);
  requireLength(values, "DEVICE_INGEST_TOKEN", 32, production, errors);
  requireLength(values, "MQTT_PASSWORD", 16, production, errors);
  for (const key of ["FIRMWARE_MANIFEST_KEY_ID", "FIRMWARE_ENROLLMENT_KEY_ID", "MANUFACTURING_QR_KEY_ID"]) {
    if (production && !values[key]) errors.push(`${key} is required in production`);
    if (values[key] && !KEY_ID_PATTERN.test(values[key])) errors.push(`${key} contains invalid characters`);
  }
  const enrollmentPrivate = values.FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY;
  const enrollmentPublic = values.FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY;
  if (production && !enrollmentPrivate) errors.push("FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY is required in production");
  if (production && !enrollmentPublic) errors.push("FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY is required in production");
  if (enrollmentPrivate) {
    try {
      const privateKey = parsePrivate(enrollmentPrivate, "FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY");
      if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") errors.push("FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY must be EC P-256");
      if (enrollmentPublic) {
        const publicKey = parsePublic(enrollmentPublic, "FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY");
        if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") errors.push("FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY must be EC P-256");
        if (!sameKey(createPublicKey(privateKey), publicKey)) errors.push("FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY does not match the private key");
      }
    } catch (error) { errors.push(error.message); }
  }
  const qrPrivate = values.MANUFACTURING_QR_SIGNING_KEY || values.QR_SIGNING_PRIVATE_KEY;
  if (production && !qrPrivate) errors.push("MANUFACTURING_QR_SIGNING_KEY is required in production");
  if (qrPrivate) {
    try { if (parsePrivate(qrPrivate, "MANUFACTURING_QR_SIGNING_KEY").asymmetricKeyType !== "ed25519") errors.push("MANUFACTURING_QR_SIGNING_KEY must be Ed25519"); } catch (error) { errors.push(error.message); }
  }
  const qrMap = values.MANUFACTURING_QR_PUBLIC_KEYS || values.QR_PUBLIC_KEYS;
  if (qrMap) {
    try {
      const parsed = JSON.parse(qrMap);
      for (const [kid, raw] of Object.entries(parsed)) {
        if (!KEY_ID_PATTERN.test(kid)) errors.push("MANUFACTURING_QR_PUBLIC_KEYS contains an invalid key id");
        if (parsePublic(raw, "MANUFACTURING_QR_PUBLIC_KEYS").asymmetricKeyType !== "ed25519") errors.push("MANUFACTURING_QR_PUBLIC_KEYS entries must be Ed25519");
      }
    } catch (error) { errors.push(error.message || "MANUFACTURING_QR_PUBLIC_KEYS must be valid JSON"); }
  }
  if (!resolved) return { errors, warnings };
  return { errors, warnings, resolved };
}

export function generatedContract(resolved) {
  return {
    schemaVersion: 1,
    webUrl: resolved.webUrl,
    apiUrl: resolved.apiUrl,
    simulatorApiUrl: `${resolved.apiUrl}/api/v1/telemetry`,
    sourceKeys: resolved.sourceKeys,
  };
}

export function run(mode = "check", envPath = ENV_PATH) {
  const values = envValues(envPath);
  const checked = checkConfig(values);
  if (checked.errors.length) {
    for (const error of checked.errors) console.error(`CONFIG_ERROR: ${error}`);
    process.exitCode = 1;
    return checked;
  }
  if (mode === "generate") {
    mkdirSync(GENERATED_DIR, { recursive: true });
    writeFileSync(GENERATED_PATH, `${JSON.stringify(generatedContract(checked.resolved), null, 2)}\n`, { mode: 0o644 });
    console.log("FarmOS config generated: config/generated/public.json (non-secret whitelist only)");
  } else {
    console.log("FarmOS config check: OK (secret values redacted)");
  }
  for (const warning of checked.warnings) console.warn(`CONFIG_WARNING: ${warning}`);
  return checked;
}

if (import.meta.url === `file://${process.argv[1]}`) run(process.argv[2] || "check");
