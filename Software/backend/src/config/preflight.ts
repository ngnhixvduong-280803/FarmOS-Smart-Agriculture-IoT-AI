import { resolveCanonicalUrls, type ConfigSource, validateSecurityConfig } from "./config-contract";

/**
 * Names that the production image must receive before migrations or the
 * application are started. Values are deliberately never included in the
 * diagnostics emitted by this module.
 */
const REQUIRED_PRODUCTION_KEYS: ReadonlyArray<ReadonlyArray<string>> = [
  ["DATABASE_URL"],
  ["DIRECT_URL"],
  ["MQTT_BROKER_URL"],
  ["MQTT_USERNAME"],
  ["MQTT_PASSWORD"],
  ["JWT_SECRET"],
  ["DEVICE_INGEST_TOKEN"],
  ["HARDWARE_BOARD_HMAC_SECRET"],
  ["FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY"],
  ["FIRMWARE_ENROLLMENT_SIGNING_PUBLIC_KEY"],
  ["MANUFACTURING_QR_SIGNING_KEY", "QR_SIGNING_PRIVATE_KEY"],
];

function configured(source: ConfigSource, key: string): boolean {
  return typeof source[key] === "string" && source[key]!.trim().length > 0;
}

function label(keys: ReadonlyArray<string>): string {
  return keys.length === 1 ? keys[0] : keys.join(" or ");
}

/**
 * Validate the exact production environment without importing the server.
 * This lets the deployment runner report actionable variable names before it
 * runs a migration or replaces a healthy release.
 */
export function collectProductionConfigErrors(source: ConfigSource = process.env): string[] {
  const errors: string[] = [];
  if (String(source.NODE_ENV ?? "").trim() !== "production") {
    errors.push("NODE_ENV must be production");
  }
  for (const keys of REQUIRED_PRODUCTION_KEYS) {
    if (!keys.some((key) => configured(source, key))) errors.push(`${label(keys)} is required in production`);
  }

  try {
    resolveCanonicalUrls(source, true);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Canonical URL configuration is invalid");
  }

  // These ids have safe schema defaults at runtime. Apply the same defaults
  // here so the preflight only reports missing values that are truly required.
  const securitySource: ConfigSource = {
    ...source,
    FIRMWARE_MANIFEST_KEY_ID: source.FIRMWARE_MANIFEST_KEY_ID || "farmos-manifest-hmac-v1",
    FIRMWARE_ENROLLMENT_KEY_ID: source.FIRMWARE_ENROLLMENT_KEY_ID || "farmos-enrollment-p256-v1",
    MANUFACTURING_QR_KEY_ID: source.MANUFACTURING_QR_KEY_ID || "dev-v3",
  };
  errors.push(...validateSecurityConfig(securitySource, true).errors);

  return [...new Set(errors)];
}

export function runProductionConfigPreflight(source: ConfigSource = process.env): number {
  const errors = collectProductionConfigErrors(source);
  if (errors.length) {
    for (const error of errors) console.error(`CONFIG_ERROR: ${error}`);
    return 1;
  }
  console.log("FarmOS production config preflight: OK (secret values redacted)");
  return 0;
}

if (require.main === module) {
  process.exitCode = runProductionConfigPreflight();
}
