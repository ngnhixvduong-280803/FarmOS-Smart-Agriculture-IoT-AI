# FarmOS configuration contract

The repository-root `.env` is the only local configuration source. Server
deployments may continue to pass a separate `env_file`, but it must contain the
same canonical names.

## Canonical public origins

```dotenv
FARMOS_WEB_URL=https://farmos.example.com
FARMOS_API_URL=https://api.farmos.example.com
```

Both values are absolute `http(s)` origins, have no trailing slash, and never
contain `/api/v1`, credentials, query strings, or fragments. Production requires
HTTPS. The following aliases are accepted temporarily and produce a deprecation
warning: `DOMAIN`, `CORS_ORIGIN`, `MOBILE_API_BASE_URL`, and `BACKEND_API_URL`.
Legacy API aliases may include `/api/v1/...`; the resolver strips that path when
deriving `FARMOS_API_URL`.

`npm run config:generate` writes only this non-secret whitelist to the ignored
`config/generated/public.json` file:

```json
{
  "schemaVersion": 1,
  "webUrl": "https://farmos.example.com",
  "apiUrl": "https://api.farmos.example.com",
  "simulatorApiUrl": "https://api.farmos.example.com/api/v1/telemetry",
  "sourceKeys": { "web": "FARMOS_WEB_URL", "api": "FARMOS_API_URL" }
}
```

No database URL, token, password, private key, service-role key, or signing
secret is emitted or logged. Consumers should treat unknown generated fields as
invalid rather than silently accepting an expanded public contract.

## Validation commands

```bash
npm run config:check
npm run config:generate
npm run build
```

The checker validates production HTTPS, HMAC/token minimum lengths, key IDs,
EC P-256 enrollment private/public key correspondence, Ed25519 QR signing keys,
and the explicit production requirements. Backend startup applies the same URL
and security checks after resolving aliases. The backend's internal container
port is `3000`; production Compose pins `PORT=3000` so the frontend proxy and
readiness check cannot drift from the application listener. `/health` is
liveness-only; orchestration must use `/readyz`, which returns `503` until
PostgreSQL accepts a query.

## Migration and actuator gates

`ENABLE_LEGACY_MQTT_INGEST=false` is the default. The current physical
firmware ingests device-scoped telemetry through HTTPS, so enabling a broker
connection alone must not reactivate the older unauthenticated MQTT ingestion
topics. Set the flag only for a separately reviewed migration environment.

`IRRIGATION_CONTROL_ENABLED=false` is also the default. Do not set it to true
until the released Gateway firmware has a verified relay/valve driver, hard
water-level interlock, flow feedback, authenticated command receipt and a
hardware emergency-stop test record. It prevents the API from presenting a
cloud MQTT publish as a physical irrigation action.

`NODE_ONLINE_TTL_SEC=120` derives the displayed online state from `last_seen`,
rather than trusting a stale database boolean. `SAFETY_TANK_STATUS_TTL_SEC=120`
requires a complete, fresh Gateway water-level/safety heartbeat after every
backend restart; a missing, partial, inactive, or cross-farm report cannot
unlock the pump interlock.

Gateway LoRa bindings persist the newest Node boot epoch immediately and their
sequence watermark every 16 accepted frames. Old boot epochs are rejected even
after a Gateway restart; the bounded checkpoint interval avoids excessive NVS
wear. This is transport replay protection, not a replacement for a physical
actuator interlock.

Before a production migration or release replacement, the deploy runner invokes
the image's redacted preflight directly:

```bash
node dist/config/preflight.js
```

Missing or malformed production variables are reported by name only and stop
the release before migration. The preflight never prints secret values or
private-key material.
