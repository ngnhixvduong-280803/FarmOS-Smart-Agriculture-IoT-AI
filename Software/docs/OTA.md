# FarmOS OTA

## Runtime flow

Gateway and `STANDALONE_NODE` firmware check the authenticated OTA API immediately
after cloud authentication and then every six hours. `LEAF_NODE` uses mobile BLE
because it has no Internet transport. The server selects releases from the immutable
`firmware_target`, `hardware_revision` and `partition_scheme` in factory identity;
deployment mode is never used as the binary compatibility key.

Each available update creates one device-scoped `ota_update_jobs` row and a signed,
15-minute download ticket. The binary download must match the job, device, release
ID and SHA-256. The job enforces `AVAILABLE → DOWNLOADING → FLASHING → FLASHED →
BOOT_CONFIRMED`; failures can retry from `FAILED → DOWNLOADING`.

The downloaded image is written to the inactive OTA partition, hashed from flash,
and compared with the release SHA-256. Firmware also rejects a project name/version
that does not match its target and rejects non-increasing versions. A new image
remains pending until its mode-specific health proof succeeds; otherwise ESP-IDF
rollback remains available.

Sensor Nodes may be updated by FarmOS Mobile over an encrypted BLE connection.
An already configured Node does not advertise the OTA characteristic during a
normal boot. Hold BOOT for 3 to under 10 seconds and release it; the reset task
reboots into the physical service window. A factory-new, unconfigured Node keeps
the service available for onboarding. The service window closes on the next normal
reboot. After an OTA reboot, it remains open while health verification is pending
and closes when Mobile reads the confirmed health status.
Mobile authenticates to the OTA API, verifies the downloaded SHA-256, sends the
expected size, version and checksum to the Node, and streams the image. The Node
rejects overflow, short writes, downgrade, wrong project/version and checksum
mismatch. For a Leaf Node, firmware is marked valid only after a valid sensor sample
receives an authenticated LoRa ACK. Mobile waits for this on-device health flag
before it reports `BOOT_CONFIRMED`. A standalone Node confirms only after an
authenticated cloud heartbeat.

The API does not update the inventory version for `FLASHED`. Only `BOOT_CONFIRMED`, or the authenticated Gateway heartbeat carrying its running version, is authoritative.
Every accepted status transition is appended to `ota_events` with the authenticated
reporter and OTA job. Apply every pending Prisma migration before deploying this backend.
Authorized clients can read the latest audit entries from `GET /api/v1/ota/events?deviceId=...`; Gateway credentials can read only their own history.

## Registering a release

Firmware files and `manifest.json` live in `OTA_STORAGE_DIR`. Production Compose mounts the `firmware_data` volume at `/var/lib/farmos/firmware`; do not store binaries in the container layer or Git.

Build and inspect the image first:

```sh
$HOME/.platformio/penv/bin/pio run -d firmware/gateway
$HOME/.platformio/penv/bin/pio run -d firmware/node
```

Register from a trusted administration environment with the production volume mounted:

```sh
cd backend
OTA_STORAGE_DIR=/var/lib/farmos/firmware npm run ota:register -- \
  GATEWAY 0.3.0 ../firmware/gateway/.pio/build/gateway/firmware.bin \
  "Release notes" 0.2.0 5
```

For the production container, copy the already verified binary into a temporary container path, then run `npm run ota:register:prod -- ...`; the compiled CLI writes the persistent Compose volume. Delete the temporary copy after registration.

Use `SENSOR_NODE` and the Node binary for both Leaf and Standalone modes. Positional
arguments after rollout are `firmwareTarget`, comma-separated hardware revisions,
partition scheme and release status. Defaults are the current ESP32-S3 targets,
`REV_A`, `FARMOS_16M_V1`, and `DRAFT` when rollout is zero or `ACTIVE` otherwise.

A release binary and its compatibility metadata are immutable for one
`firmwareTarget + version`. Re-registering the same SHA may change rollout/status;
a different binary must use a new semantic version. Use `5`, observe the cohort,
then use `25`, `50` and `100`. `PAUSED` and `REVOKED` releases are never offered;
a revoked release cannot complete an OTA job. There is intentionally no public
HTTP upload endpoint. Registration reads the ESP application descriptor and rejects
a binary whose embedded `project_name` or version does not match the requested
device type and release version.

## Production signing gate

SHA-256 and download tickets do not replace firmware signing. Before commercial
deployment, provision an ESP-IDF signed-app trust anchor through factory flashing
and build every later release with the offline signing key. The production build
is intentionally blocked unless signed-app verification is enabled. Keep the
private key outside Git, CI logs, VPS and OTA storage.

Current custom BLE provisioning remains development-only and the build intentionally
stops when that component is used without the development identity flag. Replace it
with authenticated provisioning (for example protocomm Security 2) before creating
a commercial image. Do not interpret BLE link encryption with Just Works pairing as
proof of device ownership. Requiring a physical BOOT action reduces exposure but is
not a substitute for authenticated production provisioning.

Do not enable Secure Boot or burn eFuses remotely. Validate signed update, invalid-signature rejection, power loss during download/write, failed health check rollback, and recovery through the physical programming header on sacrificial hardware first.

## Release checks

Before making a release visible:

1. Confirm the source version in both the application descriptor and `board_config.h` matches the release version.
2. Build both firmware targets and retain build logs and SHA-256 values.
3. Exercise update and rollback on physical Gateway and Node hardware.
4. Start with a small deterministic rollout percentage, observe boot confirmation and telemetry, then expand it.
5. Retain the previous signed image until the new cohort is stable.
6. Verify the release target, hardware revision and partition scheme match factory identity.
7. Verify Leaf ACK health, Standalone cloud health and Gateway cloud health separately.
