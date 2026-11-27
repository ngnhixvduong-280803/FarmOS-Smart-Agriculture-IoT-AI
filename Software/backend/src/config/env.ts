import dotenv from "dotenv";
import path from "path";
import { z } from "zod";
import { resolveCanonicalUrls, validateSecurityConfig } from "./config-contract";

// 1. Tải .env từ nhiều cấp thư mục để đảm bảo luôn load được dù chạy từ root hay backend
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const isProduction = process.env.NODE_ENV === "production";

// Canonical public origins are resolved once at process start. Legacy names
// remain accepted during migration, but downstream code only consumes the
// canonical values. Never print these values or any secret aliases.
const canonicalUrls = resolveCanonicalUrls(process.env, isProduction);
process.env.FARMOS_WEB_URL ||= canonicalUrls.webUrl;
process.env.FARMOS_API_URL ||= canonicalUrls.apiUrl;
if (isProduction || (process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== "*")) {
  process.env.CORS_ORIGIN = canonicalUrls.webUrl;
}
if (!process.env.MANUFACTURING_QR_SIGNING_KEY && process.env.QR_SIGNING_PRIVATE_KEY) process.env.MANUFACTURING_QR_SIGNING_KEY = process.env.QR_SIGNING_PRIVATE_KEY;
if (!process.env.MANUFACTURING_QR_PUBLIC_KEYS && process.env.QR_PUBLIC_KEYS) process.env.MANUFACTURING_QR_PUBLIC_KEYS = process.env.QR_PUBLIC_KEYS;
if (!process.env.MANUFACTURING_QR_KEY_ID && process.env.QR_KEY_ID) process.env.MANUFACTURING_QR_KEY_ID = process.env.QR_KEY_ID;
if (!process.env.MANUFACTURING_QR_ISSUER && process.env.QR_ISSUER) process.env.MANUFACTURING_QR_ISSUER = process.env.QR_ISSUER;

// Local development can run against the default Docker database. Production must
// provide explicit connection and signing values through its server-only env file.
if (!process.env.DATABASE_URL && !isProduction) {
  process.env.DATABASE_URL = "postgresql://farmos_user:farmos_password@localhost:5432/farmos_db?schema=public";
}
if (!process.env.DIRECT_URL && !isProduction) {
  process.env.DIRECT_URL = process.env.DATABASE_URL;
}

const envSchema = z.object({
  // Keep the internal container contract on port 3000. The production Nginx
  // proxy, Docker healthcheck, and Compose service all target this port.
  PORT: z.string().default("3000").transform((val) => parseInt(val, 10)),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  FARMOS_WEB_URL: z.string().url().default(canonicalUrls.webUrl),
  FARMOS_API_URL: z.string().url().default(canonicalUrls.apiUrl),
  // Immutable firmware layout packaged in the backend image. A custom mount
  // may override it only with the paired FARMOS_FLASH_LAYOUT_DIR guard.
  FARMOS_FLASH_LAYOUT_PATH: z.string().optional(),
  FARMOS_FLASH_LAYOUT_DIR: z.string().optional(),
  CORS_ORIGIN: isProduction ? z.string().url() : z.union([z.string().url(), z.literal("*")]).default("*"),
  DATABASE_URL: z.string().min(1),
  DIRECT_URL: isProduction ? z.string().min(1) : z.string().optional(),
  MQTT_BROKER_URL: isProduction ? z.string().min(1) : z.string().default("mqtt://localhost:1883"),
  MQTT_CLIENT_ID: z.string().default("farmos_backend_server"),
  MQTT_USERNAME: isProduction ? z.string().min(1) : z.string().optional(),
  MQTT_PASSWORD: isProduction ? z.string().min(16) : z.string().optional(),
  JWT_SECRET: isProduction
    ? z.string().min(32)
    : z.string().min(32).default("local-development-secret-change-before-production-123456"),
  JWT_ISSUER: z.string().default("farmos-api"),
  JWT_AUDIENCE: z.string().default("farmos-web"),
  // Native clients use a separate audience from the browser cookie session.
  // This prevents a token copied from a mobile device being accepted as a web
  // session cookie (and vice versa).
  MOBILE_JWT_AUDIENCE: z.string().default("farmos-mobile"),
  SESSION_COOKIE_NAME: isProduction
    ? z.string().regex(/^__Host-[A-Za-z0-9_-]+$/).default("__Host-farmos-session")
    : z.string().default("farmos-session"),
  SESSION_TTL_SEC: z.string().default("28800").transform((val) => parseInt(val, 10)).refine((value) => value >= 300 && value <= 86_400, "SESSION_TTL_SEC must be 5 minutes to 24 hours"),
  MOBILE_SESSION_TTL_SEC: z.string().default("2592000").transform((val) => parseInt(val, 10)).refine((value) => value >= 3600, "MOBILE_SESSION_TTL_SEC must be at least 1 hour"),
  // Local HTTP development cannot use a Secure cookie. Production must never
  // opt out of it, and the __Host- prefix prevents Domain/path confusion.
  SESSION_COOKIE_SECURE: z.enum(["true", "false"]).default(isProduction ? "true" : "false").transform((value) => value === "true").refine((value) => !isProduction || value, "Production session cookies must be Secure"),
  // Direct password login is retained only for an explicitly enabled local migration.
  // Public production deployments must use the configured Supabase identity provider.
  ALLOW_LEGACY_PASSWORD_AUTH: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  // The v2 claim/session/cloud onboarding surface is a migration escape hatch,
  // never an implicit production capability. It must be explicitly enabled
  // per environment while QR v3 remains the default path.
  ENABLE_LEGACY_PROVISIONING: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  // MQTT telemetry/status/ACK routes predate device-scoped HTTPS onboarding.
  // Keep the backend MQTT connection available for explicitly approved internal
  // workflows, but never accept legacy ingestion just because a broker exists.
  ENABLE_LEGACY_MQTT_INGEST: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  // There is no released Gateway actuator implementation yet. This is an
  // explicit, fail-closed release switch so UI/API requests cannot be recorded
  // as "executing" when no physical command channel is available.
  PUMP_CONTROL_NODE_IDS: z.string().default("").transform(value => new Set(value.split(",").map(id => id.trim()).filter(id => /^NODE_[0-9]+$/.test(id)))),
  IRRIGATION_CONTROL_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  // `online` is only a cached last report. API responses derive live presence
  // from last_seen so a silent Node does not remain green indefinitely.
  NODE_ONLINE_TTL_SEC: z.string().default("120").transform((value) => parseInt(value, 10)).refine((value) => Number.isInteger(value) && value >= 15 && value <= 86_400, "NODE_ONLINE_TTL_SEC must be 15 seconds to 24 hours"),
  // After a process restart, irrigation must remain blocked until the Gateway
  // sends a fresh, complete water-level interlock heartbeat.
  SAFETY_TANK_STATUS_TTL_SEC: z.string().default("120").transform((value) => parseInt(value, 10)).refine((value) => Number.isInteger(value) && value >= 15 && value <= 86_400, "SAFETY_TANK_STATUS_TTL_SEC must be 15 seconds to 24 hours"),
  // Shared gateway credential. Provision a distinct value for every deployment and
  // rotate it whenever a gateway is lost. Device-specific credentials are the next
  // step once the device registry has a credential column.
  DEVICE_INGEST_TOKEN: isProduction ? z.string().min(32) : z.string().min(32).optional(),
  // Manufacturing stations use a narrowly scoped token (or a terminating
  // mTLS identity) for factory writes. The signing key is intentionally
  // optional in development/test but required by the QR issue route in
  // production; it is never returned in an API payload.
  MANUFACTURING_QR_ISSUER: z.string().min(1).default("farmos"),
  MANUFACTURING_QR_KEY_ID: z.string().min(1).default("dev-v3"),
  MANUFACTURING_QR_SIGNING_KEY: z.string().optional(),
  MANUFACTURING_QR_PUBLIC_KEYS: z.string().optional(),
  // Short aliases are kept for deployments that already standardise on QR_*
  // names; MANUFACTURING_QR_* remains the documented canonical prefix.
  QR_ISSUER: z.string().optional(),
  QR_KEY_ID: z.string().optional(),
  QR_SIGNING_PRIVATE_KEY: z.string().optional(),
  QR_PUBLIC_KEYS: z.string().optional(),
  MANUFACTURING_STATION_TOKEN: z.string().optional(),
  MANUFACTURING_STATION_ID: z.string().optional(),
  MANUFACTURING_STATION_TOKENS: z.string().optional(),
  // Server-only secret used to derive opaque HardwareBoard keys from factory
  // chip material. Never expose this value or persist the raw eFuse MAC.
  HARDWARE_BOARD_HMAC_SECRET: isProduction
    ? z.string().min(32)
    : z.string().min(16).default("local-hardware-board-hmac-secret-change-me"),
  // Optional independent release-manifest signer. Development falls back to
  // the board HMAC key; production should provision a dedicated value.
  FIRMWARE_MANIFEST_SIGNING_KEY: isProduction ? z.string().min(32).optional() : z.string().optional(),
  FIRMWARE_MANIFEST_KEY_ID: z.string().min(1).default("farmos-manifest-hmac-v1"),
  // The serial-enrollment ticket is verified on-device with the matching
  // CONFIG_FARMOS_ENROLLMENT_SERVER_PUBLIC_KEY. It must be an EC P-256
  // private key; the route fails closed when production has no key.
  FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY: isProduction ? z.string().min(1) : z.string().optional(),
  FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY: z.string().optional(),
  FIRMWARE_ENROLLMENT_KEY_ID: z.string().min(1).default("farmos-enrollment-p256-v1"),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  ADMIN_EMAILS: z.string().default("admin@farmos.local"),
  SAFETY_MAX_RUNTIME_SEC: z.string().default("600").transform((val) => parseInt(val, 10)),
  SAFETY_MIN_WATER_TANK_PCT: z.string().default("20.0").transform((val) => parseFloat(val)),
  SAFETY_ACK_TIMEOUT_SEC: z.string().default("20").transform((val) => parseInt(val, 10)),
});

const parsedEnv = envSchema.parse(process.env);
const securityConfig = validateSecurityConfig(parsedEnv as unknown as Record<string, string | undefined>, isProduction);
if (securityConfig.errors.length) {
  throw new Error(`Invalid FarmOS security configuration: ${securityConfig.errors.join("; ")}`);
}

export const env = parsedEnv;
