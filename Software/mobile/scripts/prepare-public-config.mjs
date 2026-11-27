import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The mobile bundle is allowed to contain only these public values. In
 * particular, do not parse/hash the complete .env: it also contains server
 * credentials and signing material that must never reach a client artifact.
 */
export const PUBLIC_ENV_KEYS = Object.freeze([
  "FARMOS_API_URL",
  "FARMOS_WEB_URL",
  // These URL aliases are accepted only as migration inputs. They are never
  // emitted into the generated client config or its source hash.
  "DOMAIN",
  "CORS_ORIGIN",
  "MOBILE_API_BASE_URL",
  "BACKEND_API_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
]);

function unwrap(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Read only the four explicitly approved public keys from dotenv text. */
export function readPublicEnv(source) {
  const values = {};
  const allowed = new Set(PUBLIC_ENV_KEYS);
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    if (!allowed.has(key)) continue;
    values[key] = unwrap(line.slice(separator + 1));
  }
  return values;
}

/**
 * Canonical client URLs are origins. A route such as
 * `/api/v1/telemetry` is a telemetry endpoint, not a mobile API base, and is
 * rejected instead of being silently trimmed or rewritten.
 */
export function normalizePublicUrl(value, key) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${key} is required in the repository-root .env.`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be a valid http(s) URL origin.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${key} must use an http(s) URL without credentials.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${key} must be an origin URL without a path, query, or fragment.`);
  }
  return parsed.origin;
}

function normalizeLegacyApiUrl(value, key) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${key} is required in the repository-root .env.`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be a valid http(s) URL.`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${key} must use an http(s) URL without credentials, query, or fragment.`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "" && !/^\/api\/v1(?:\/.*)?\/?$/.test(parsed.pathname)) {
    throw new Error(`${key} may only contain the legacy /api/v1 path.`);
  }
  return parsed.origin;
}

function firstConfigured(values, keys) {
  for (const key of keys) {
    if (String(values[key] ?? "").trim()) return key;
  }
  return "";
}

function publicSourceHash(config) {
  // This projection contains only the allowlisted public values. It must not
  // be replaced with a hash of the complete dotenv file because that file has
  // server secrets and private signing keys.
  return createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex");
}

export function buildPublicConfig(source) {
  const values = readPublicEnv(source);
  const apiKey = firstConfigured(values, ["FARMOS_API_URL", "MOBILE_API_BASE_URL", "BACKEND_API_URL"]);
  const webKey = firstConfigured(values, ["FARMOS_WEB_URL", "DOMAIN", "CORS_ORIGIN"]);
  if (!apiKey) throw new Error("FARMOS_API_URL is required in the repository-root .env.");
  if (!webKey || (webKey === "CORS_ORIGIN" && values[webKey] === "*")) throw new Error("FARMOS_WEB_URL is required in the repository-root .env.");
  const config = {
    apiBaseUrl: apiKey === "FARMOS_API_URL" ? normalizePublicUrl(values[apiKey], apiKey) : normalizeLegacyApiUrl(values[apiKey], apiKey),
    webBaseUrl: normalizePublicUrl(values[webKey], webKey),
    supabaseUrl: normalizePublicUrl(values.SUPABASE_URL, "SUPABASE_URL"),
    supabaseAnonKey: String(values.SUPABASE_ANON_KEY ?? "").trim(),
  };
  if (!config.supabaseAnonKey) throw new Error("SUPABASE_ANON_KEY is required in the repository-root .env.");
  return {
    config,
    sourceHash: publicSourceHash(config),
    warnings: [
      ...(apiKey !== "FARMOS_API_URL" ? [`${apiKey} is deprecated; use FARMOS_API_URL`] : []),
      ...(webKey !== "FARMOS_WEB_URL" ? [`${webKey} is deprecated; use FARMOS_WEB_URL`] : []),
    ],
  };
}

export function renderPublicConfig({ config, sourceHash }) {
  return `// Generated from FarmOS/.env public allowlist. Never commit this file.\n// Source hash covers only FARMOS_API_URL, FARMOS_WEB_URL, SUPABASE_URL, and SUPABASE_ANON_KEY.\nexport const publicConfig = ${JSON.stringify(config, null, 2)} as const;\nexport const PUBLIC_CONFIG_SOURCE_HASH = ${JSON.stringify(sourceHash)} as const;\n`;
}

export function preparePublicConfig({
  rootEnvPath = resolve(import.meta.dirname, "../../.env"),
  outputPath = resolve(import.meta.dirname, "../src/generated/config.ts"),
  check = false,
} = {}) {
  if (!existsSync(rootEnvPath)) {
    throw new Error(`Không tìm thấy ${rootEnvPath}. Sao chép .env.example thành .env trước khi build mobile.`);
  }
  const built = buildPublicConfig(readFileSync(rootEnvPath, "utf8"));
  const expected = renderPublicConfig(built);
  if (check) {
    if (!existsSync(outputPath)) throw new Error("Mobile public config bị thiếu; chạy npm run prepare:config.");
    const actual = readFileSync(outputPath, "utf8");
    if (actual !== expected) throw new Error("Mobile public config đã cũ; chạy npm run prepare:config.");
    return { outputPath, changed: false, warnings: built.warnings };
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, expected);
  return { outputPath, changed: true, warnings: built.warnings };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, "prepare-public-config.mjs");
if (isMain) {
  try {
    const result = preparePublicConfig({ check: process.argv.includes("--check") });
    for (const warning of result.warnings || []) console.warn(`Mobile public config warning: ${warning}`);
  } catch (error) {
    console.error(`Mobile public config error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
