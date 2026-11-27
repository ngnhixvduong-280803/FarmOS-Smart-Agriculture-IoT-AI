import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { FlashJobState } from "@prisma/client";
import { createApp } from "../api/app";
import {
  cleanupFirmwareMultipart,
  deleteFirmwareReleaseRecords,
  effectiveFirmwareChangelog,
  parseFirmwareMultipart,
  MAX_FIRMWARE_FILE_BYTES,
  MAX_FIRMWARE_TOTAL_BYTES,
  FirmwareUploadError,
  assertFactoryBundleRoles,
  validateFactoryBinary,
} from "../ota/firmware-upload.service";
import { env } from "../config/env";
import { OtaService, computeSha256 } from "../ota/ota.service";
import { mergeAdminDevices } from "../api/routes/admin-device.routes";
import { activeFlashJobDecision, nextFlashProgress } from "../api/routes/flash.routes";
import { prisma } from "../database/prisma";

function multipart(fields: Record<string, string>, files: Array<{ field: string; filename: string; content: Buffer }>): { body: Buffer; contentType: string } {
  const boundary = `----FarmOS-${Date.now().toString(16)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(file.content);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function parseBody(body: Buffer, contentType: string) {
  const request = new PassThrough() as PassThrough & { headers: Record<string, string> };
  request.headers = { "content-type": contentType };
  const parsed = parseFirmwareMultipart(request as any);
  request.end(body);
  return parsed;
}

test("admin firmware upload route rejects unauthenticated multipart writes before parsing", async () => {
  const app = createApp();
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const { body, contentType } = multipart({ deviceType: "GATEWAY" }, [{ field: "app", filename: "../../evil.bin", content: Buffer.from("not-an-image") }]);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/admin/firmware/releases`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(body),
    });
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

test("legacy JSON flash release registration is disabled", async () => {
  const originalFindFirst = prisma.user.findFirst;
  prisma.user.findFirst = (async () => ({
    id: "ADMIN_LEGACY_ROUTE",
    email: "admin@farmos.local",
    password: "",
    name: "Test Admin",
    role: "ADMIN",
    created_at: new Date(),
    updated_at: new Date(),
  })) as typeof prisma.user.findFirst;
  const app = createApp();
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const token = jwt.sign(
    { id: "ADMIN_LEGACY_ROUTE", email: "admin@farmos.local", role: "ADMIN" },
    env.JWT_SECRET,
    { algorithm: "HS256", issuer: env.JWT_ISSUER, audience: env.MOBILE_JWT_AUDIENCE, expiresIn: "5m" },
  );
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/flash/releases`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "attacker-controlled", status: "ACTIVE", artifactSha256: "a".repeat(64), sizeBytes: 1 }),
    });
    assert.equal(response.status, 410);
    const payload = await response.json() as { error?: string };
    assert.match(payload.error || "", /admin\/firmware\/releases/i);
  } finally {
    server.close();
    prisma.user.findFirst = originalFindFirst;
  }
});

test("multipart firmware parser streams into a private temp dir and strips traversal filenames", async () => {
  const { body, contentType } = multipart({ deviceType: "GATEWAY", version: "1.2.3" }, [
    { field: "app", filename: "../../firmware.bin", content: Buffer.from("binary") },
  ]);
  const parsed = await parseBody(body, contentType);
  try {
    assert.equal(parsed.fields.deviceType[0], "GATEWAY");
    assert.equal(parsed.files.length, 1);
    assert.equal(parsed.files[0].role, "APP");
    assert.equal(parsed.files[0].originalName, "firmware.bin");
    assert.ok(parsed.files[0].tempPath.startsWith(parsed.tempDir));
    assert.equal(parsed.files[0].sizeBytes, 6);
    assert.equal(parsed.files[0].sha256.length, 64);
  } finally {
    cleanupFirmwareMultipart(parsed);
  }
});

test("multipart firmware parser rejects unknown metadata and keeps bounded limits explicit", async () => {
  const { body, contentType } = multipart({ unknown: "nope" }, []);
  await assert.rejects(
    parseBody(body, contentType),
    (error: unknown) => error instanceof FirmwareUploadError && error.status === 400,
  );
  assert.ok(MAX_FIRMWARE_FILE_BYTES > 0);
  assert.ok(MAX_FIRMWARE_TOTAL_BYTES >= MAX_FIRMWARE_FILE_BYTES);
});

test("firmware upload enforces browser CSRF and multipart field-size limits", async () => {
  const app = createApp();
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const session = jwt.sign(
    { id: "ADMIN_TEST", email: "admin@farmos.local", role: "ADMIN", csrf: "csrf-test" },
    env.JWT_SECRET,
    { algorithm: "HS256", issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE, expiresIn: "5m" },
  );
  const { body, contentType } = multipart({ deviceType: "GATEWAY" }, []);
  try {
    const csrfResponse = await fetch(`http://127.0.0.1:${port}/api/v1/admin/firmware/releases`, {
      method: "POST",
      headers: { "Content-Type": contentType, Cookie: `${env.SESSION_COOKIE_NAME}=${encodeURIComponent(session)}`, Origin: "http://localhost:3000" },
      body: new Uint8Array(body),
    });
    assert.equal(csrfResponse.status, 403);
  } finally {
    server.close();
  }

  const tooLarge = multipart({ changelog: "x".repeat(9 * 1024) }, []);
  await assert.rejects(
    parseBody(tooLarge.body, tooLarge.contentType),
    (error: unknown) => error instanceof FirmwareUploadError && error.status === 413,
  );
});

test("multipart parser cleans up an interrupted upload and rejects duplicate file roles", async () => {
  const boundary = "----FarmOS-abort";
  const request = new PassThrough() as PassThrough & { headers: Record<string, string> };
  request.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const interrupted = parseFirmwareMultipart(request as any);
  request.emit("aborted");
  await assert.rejects(interrupted, (error: unknown) => error instanceof FirmwareUploadError && error.status === 400);

  const erroredRequest = new PassThrough() as PassThrough & { headers: Record<string, string> };
  erroredRequest.headers = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const errored = parseFirmwareMultipart(erroredRequest as any);
  erroredRequest.emit("error", new Error("socket reset"));
  await assert.rejects(errored, (error: unknown) => error instanceof FirmwareUploadError && error.status === 400);

  const duplicate = multipart({}, [
    { field: "app", filename: "one.bin", content: Buffer.from("a") },
    { field: "app", filename: "two.bin", content: Buffer.from("b") },
  ]);
  await assert.rejects(
    parseBody(duplicate.body, duplicate.contentType),
    (error: unknown) => error instanceof FirmwareUploadError && error.status === 400,
  );
});

test("factory upload rejects partial image sets while keeping app-only OTA valid", () => {
  assert.doesNotThrow(() => assertFactoryBundleRoles(["APP"]));
  assert.doesNotThrow(() => assertFactoryBundleRoles(["BOOTLOADER", "PARTITION_TABLE", "OTA_DATA"]));
  assert.throws(
    () => assertFactoryBundleRoles(["APP", "BOOTLOADER", "OTA_DATA"]),
    (error: unknown) => error instanceof FirmwareUploadError && error.status === 400,
  );
});

test("factory upload accepts the ESP-IDF little-endian partition-table magic", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "farmos-partition-table-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const validPath = path.join(tempDir, "partitions.bin");
  const invalidPath = path.join(tempDir, "reversed-partitions.bin");
  fs.writeFileSync(validPath, Buffer.from([0xaa, 0x50, 0x01]));
  fs.writeFileSync(invalidPath, Buffer.from([0x50, 0xaa, 0x01]));

  const file = (tempPath: string): Parameters<typeof validateFactoryBinary>[1] => ({
    fieldName: "partitionTable",
    role: "PARTITION_TABLE",
    originalName: path.basename(tempPath),
    tempPath,
    sha256: "0".repeat(64),
    sizeBytes: 3,
  });
  assert.doesNotThrow(() => validateFactoryBinary("PARTITION_TABLE", file(validPath)));
  assert.throws(() => validateFactoryBinary("PARTITION_TABLE", file(invalidPath)), /invalid ESP magic/i);
});

test("progress decisions are monotonic and fail closed after readback", () => {
  assert.deepEqual(nextFlashProgress(FlashJobState.ENROLLMENT_ISSUED, 0, 20), { ignore: false, progress: 20 });
  assert.deepEqual(nextFlashProgress(FlashJobState.FLASHING, 80, 20), { ignore: false, progress: 80 });
  assert.deepEqual(nextFlashProgress(FlashJobState.READBACK_VERIFIED, 100, 90), { ignore: true, progress: 100 });
  assert.deepEqual(nextFlashProgress(FlashJobState.COMPLETED, 100, 100), { ignore: true, progress: 100 });
  assert.throws(() => nextFlashProgress(FlashJobState.MANIFEST_READY, 0, 1), /Progress is not valid/);
});

test("active flash jobs resume after a page reload but expired or mismatched jobs do not", () => {
  const now = new Date("2026-09-12T12:00:00.000Z");
  const active = {
    mode: "NORMAL_REFLASH" as const,
    target_type: "NODE" as const,
    expires_at: new Date("2026-09-12T12:05:00.000Z"),
  };
  assert.equal(activeFlashJobDecision(active, { mode: "NORMAL_REFLASH", targetType: "NODE", now }), "resume");
  assert.equal(activeFlashJobDecision({ ...active, expires_at: now }, { mode: "NORMAL_REFLASH", targetType: "NODE", now }), "expire");
  assert.equal(activeFlashJobDecision(active, { mode: "RESET_REPROVISION", targetType: "NODE", now }), "conflict");
  assert.equal(activeFlashJobDecision(active, { mode: "NORMAL_REFLASH", targetType: "GATEWAY", now }), "conflict");
});

test("draft upload retries preserve one changelog across OTA and Prisma catalogs", () => {
  assert.equal(effectiveFirmwareChangelog(undefined, "Existing DB changelog", "Existing OTA changelog", "Fallback"), "Existing DB changelog");
  assert.equal(effectiveFirmwareChangelog("  New changelog  ", "Existing DB changelog", "Existing OTA changelog", "Fallback"), "New changelog");
  assert.equal(effectiveFirmwareChangelog(undefined, undefined, "Existing OTA changelog", "Fallback"), "Existing OTA changelog");
  assert.equal(effectiveFirmwareChangelog(undefined, undefined, undefined, "Fallback"), "Fallback");
});

test("draft artifact cleanup removes only the hash-matching release", async (t) => {
  const previousStorage = process.env.OTA_STORAGE_DIR;
  const temporaryStorage = fs.mkdtempSync(path.join(os.tmpdir(), "farmos-upload-cleanup-"));
  process.env.OTA_STORAGE_DIR = temporaryStorage;
  t.after(() => {
    if (previousStorage === undefined) delete process.env.OTA_STORAGE_DIR;
    else process.env.OTA_STORAGE_DIR = previousStorage;
    fs.rmSync(temporaryStorage, { recursive: true, force: true });
  });
  const image = Buffer.alloc(24 + 8 + 196, 0x42);
  image[0] = 0xe9;
  image[1] = 1;
  image.writeUInt32LE(196, 28);
  image.writeUInt32LE(0xabcd5432, 32);
  image.fill(0, 48, 112);
  image.write("0.9.0", 48, "ascii");
  image.write("farmos_gateway", 80, "ascii");
  const release = await OtaService.registerRelease({ deviceType: "GATEWAY", version: "0.9.0", changelog: "cleanup" }, image);
  assert.ok(OtaService.getBinaryPath(release.fileName));
  assert.equal(OtaService.removeReleaseIfDraft(release.id, computeSha256(image)), true);
  assert.equal(OtaService.getBinaryPath(release.fileName), null);
  assert.equal((await OtaService.listReleases()).length, 0);
});

test("admin hard delete removes related flash history before the firmware release", async () => {
  const calls: string[] = [];
  await deleteFirmwareReleaseRecords({
    flashJob: {
      async deleteMany(args) {
        assert.deepEqual(args, { where: { release_id: "release-old" } });
        calls.push("flash-jobs");
      },
    },
    firmwareRelease: {
      async delete(args) {
        assert.deepEqual(args, { where: { id: "release-old" } });
        calls.push("release");
      },
    },
  }, "release-old");
  assert.deepEqual(calls, ["flash-jobs", "release"]);
});

test("stored OTA artifact verification rejects symlinks and hash/size drift", async (t) => {
  const previousStorage = process.env.OTA_STORAGE_DIR;
  const temporaryStorage = fs.mkdtempSync(path.join(os.tmpdir(), "farmos-upload-verify-"));
  process.env.OTA_STORAGE_DIR = temporaryStorage;
  const artifact = Buffer.from("immutable-artifact");
  const artifactPath = path.join(temporaryStorage, "artifact.bin");
  const outsidePath = path.join(temporaryStorage, "outside.bin");
  fs.writeFileSync(artifactPath, artifact, { mode: 0o600 });
  fs.writeFileSync(outsidePath, artifact, { mode: 0o600 });
  t.after(() => {
    if (previousStorage === undefined) delete process.env.OTA_STORAGE_DIR;
    else process.env.OTA_STORAGE_DIR = previousStorage;
    fs.rmSync(temporaryStorage, { recursive: true, force: true });
  });
  const hash = computeSha256(artifact);
  assert.equal(OtaService.verifyStoredArtifact("artifact.bin", hash, artifact.length), artifactPath);
  assert.equal(OtaService.verifyStoredArtifact("artifact.bin", hash, artifact.length + 1), null);
  fs.rmSync(artifactPath);
  fs.symlinkSync(outsidePath, artifactPath);
  assert.equal(OtaService.verifyStoredArtifact("artifact.bin", hash, artifact.length), null);
});

test("admin device inventory route is protected by ADMIN authentication", async () => {
  const app = createApp();
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/admin/devices`);
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});

test("physical board preflight and role repurpose require authentication", async () => {
  const app = createApp();
  const server = app.listen(0);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    for (const route of ["/api/v1/flash/boards/inspect", "/api/v1/flash/boards/board-id/repurpose"]) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      assert.equal(response.status, 401);
    }
  } finally {
    server.close();
  }
});

test("admin inventory merge keeps one current identity row and hides retired generations", () => {
  const now = new Date("2026-09-08T12:00:00.000Z");
  const currentIdentity = {
    device_id: "NODE_CURRENT", serial_number: "SN-CURRENT", type: "SENSOR_NODE", model: "S3",
    capabilities: [], firmware_target: "ESP32S3_LORA_SENSOR_V1", hardware_revision: "REV_A",
    partition_scheme: "FARMOS_16M_V1", state: "INVENTORY", generation: 1, generation_state: "ACTIVE",
    is_current: true, identity_version: 3, claimed_by_id: null, claimed_farm_id: null, created_at: now, updated_at: now,
  };
  const node = (id: string) => ({ id, serial_number: `SN-${id}`, type: "SENSOR_NODE", capabilities: [], name: id,
    farm_id: "FARM_1", zone_id: null, owner_id: null, deployment_mode: "LEAF_NODE", gateway_id: null,
    is_activated: false, online: false, rssi: null, firmware_version: null, last_seen: null,
    created_at: now, updated_at: now, farm: { id: "FARM_1", name: "Test farm" } });
  const rows = mergeAdminDevices([currentIdentity], [node("NODE_CURRENT"), node("NODE_LEGACY"), node("NODE_RETIRED")], ["NODE_CURRENT", "NODE_RETIRED"]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.source).sort(), ["IDENTITY", "LEGACY_NODE"]);
  assert.equal(rows.find((row) => row.id === "NODE_CURRENT")?.node?.id, "NODE_CURRENT");
  assert.equal(rows.some((row) => row.id === "NODE_RETIRED"), false);
});
