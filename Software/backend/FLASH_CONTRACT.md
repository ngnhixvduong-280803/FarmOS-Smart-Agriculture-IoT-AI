# HardwareBoard / FlashJob contract

The server derives `HardwareBoard.board_key` with a server-only
`HARDWARE_BOARD_HMAC_SECRET` over `chipFamily`, normalized factory eFuse MAC,
and/or factory chip identity. Raw MAC/chip identity is never persisted or
returned. Production must provision a random secret of at least 32 characters;
rotating it intentionally creates a new resolution namespace and therefore
requires a controlled board migration.

The backend image must contain the immutable `firmware/flash_layout.json`
metadata at `/app/firmware/flash_layout.json`. Production Compose pins
`FARMOS_FLASH_LAYOUT_PATH` to that path. A custom read-only mount is accepted
only when `FARMOS_FLASH_LAYOUT_DIR` is also configured; the loader resolves
real paths and rejects missing files, traversal, and symlinks that escape the
configured directory.

`POST /api/v1/flash/jobs` creates an idempotent Web Serial job. The caller
resolves a board from factory material (or an existing opaque `boardId`),
selects `targetType: NODE|GATEWAY`, and chooses `NORMAL_REFLASH` or
admin-only `RESET_REPROVISION`. The normal path keeps the current
`deviceId`, serial, QR, ownership, and key binding. Reset leaves the old
generation current while the job is pending; only a successful readback plus
post-flash board attestation retires that generation and creates the next
`DeviceIdentity`/QR/key binding in one transaction.

The orchestration sequence is:

1. `GET /api/v1/flash/jobs/:id/manifest` — returns the signed release plus an
   ordered immutable `images[]` (`id`, `name`, `role`, `required`, `address`,
   size, SHA-256, and a per-image ticketed `downloadUrl`). The only accepted
   ESP32-S3 offsets are bootloader `0x0000`, partition table `0x10000`,
   `ota_data_initial` `0x19000`, and OTA_0 app `0x20000`; factory_cfg
   (`0x620000-0x62ffff`) and nvs_keys (`0x630000-0x630fff`) are never valid
   targets. A release must register this complete set or an explicitly
   generated/registered `MERGED_IMAGE` at address `0`; merged images are
   approved for `FACTORY_FULL_FLASH` (NEW/RESET) only.
   App-only legacy metadata may remain DRAFT but cannot create an active job.
   The response also contains `writePlans`, an operation-keyed map with the
   server-owned ordered steps, and `selectedPlan: { name, imageIds, steps }`
   selected for this FlashJob. `NORMAL_REFLASH` is exactly APP at `0x20000`
   followed by OTA_DATA at `0x19000` with selector `ota_0`; the full plan is
   BOOTLOADER -> PARTITION_TABLE -> APP -> OTA_DATA, with OTA_DATA last.
2. `POST /api/v1/flash/jobs/:id/enrollment` with the HELLO public key, nonce,
   raw factory material (consumed transiently), and hardware proof. The
   response `ticket` is a compact `{payload, signature, kid}` envelope:
   payload is base64url canonical JSON and signature is DER ECDSA P-256/SHA-256.
   It binds protocolVersion, operation (`ENROLL`, `REFLASH`, `RECOVER`/
   `ROTATE_KEY`), board proof, nonce, release target, device/generation, key
   fingerprints, role, serial, expiry, and ticket id. The same signed envelope
   authenticates progress/readback/complete; only its server HMAC digest is
   persisted.
3. `POST /api/v1/flash/jobs/:id/progress`
4. `POST /api/v1/flash/jobs/:id/readback` with the running OTA_0 application
   SHA-256 and `readbackLength` equal to its signed size. Other images remain
   bound by the signed ordered manifest. The firmware serial challenge carries
   `flashAttestation: { boardId, jobId, releaseId, manifestSha256,
   readbackSha256, challenge, readbackLength }` and returns the nested signed
   flash attestation plus `readbackPartition: "ota_0"`, `readbackAddress:
   0x20000`, and `readbackLength`.
5. `POST /api/v1/flash/jobs/:id/complete` with challenge, ticket, readback
   hash/length, and the nested `flashAttestation` message/signature. The
   response includes the finalized identity and, for a generation that has a
   QR label, `qr: { qrId, payload }` directly; the Web Flasher must not call a
   second QR reissue endpoint after completion.

`fail` and `cancel` never create a new `DeviceIdentity`. Board block/unblock,
unbind, legacy rebind, identity recovery/key rotation, QR reissue, and reset are audited
admin operations under `/api/v1/flash/boards/:boardId/*`. Hardware boards are
never hard deleted. QR v3 remains firmware-version/runtime-mode independent;
reissue records the previous signed QR in `device_qr_revocations` before
activating the replacement.

`GET /api/v1/flash/boards/:boardId/generations` is an admin-only read-only
history endpoint. It returns opaque identity fields, current QR payload (when
present), and QR/key revocation records; it never returns `board_key`, raw MAC,
or chip identity.

The relational `FirmwareRelease` manifest stores the legacy application hash,
ordered `images_json` descriptors, canonical manifest hash, HMAC signature,
target type, hardware revisions, and partition scheme. The canonical signature
covers the complete ordered image set and its image-set hash. Existing
file-backed releases are materialized as explicit app-only legacy metadata;
replace them with a complete layout or explicit merged image before activation.
Normal REFLASH preserves identity/key/generation and the protected factory_cfg
and nvs_keys partitions; reset/reprovision creates a new generation only after
post-flash attestation.
