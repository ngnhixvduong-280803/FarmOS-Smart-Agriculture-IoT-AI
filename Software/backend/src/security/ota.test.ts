import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import jwt from "jsonwebtoken";
import { compareSemver, isNewerVersion, computeSha256, OtaService } from "../ota/ota.service";
import { createOtaDownloadTicket, verifyOtaDownloadTicket } from "./device-secrets";
import { env } from "../config/env";
import { canTransitionOtaStatus } from "../api/routes/ota.routes";
import { prisma } from "../database/prisma";

function testEspImage(deviceType: "GATEWAY" | "SENSOR_NODE", version: string, fill = 0x42): Buffer {
  const descriptorSize = 196;
  const image = Buffer.alloc(24 + 8 + descriptorSize, fill);
  image[0] = 0xe9;
  image[1] = 1;
  image.writeUInt32LE(descriptorSize, 28);
  image.writeUInt32LE(0xabcd5432, 32);
  image.fill(0, 48, 112);
  image.write(version, 48, "ascii");
  image.write(deviceType === "GATEWAY" ? "farmos_gateway" : "farmos_node", 80, "ascii");
  return image;
}

test("OTA semver comparison handles major, minor, patch and 'v' prefix", () => {
  assert.equal(compareSemver("0.3.0", "0.2.0"), 1);
  assert.equal(compareSemver("0.2.0", "0.3.0"), -1);
  assert.equal(compareSemver("v1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("0.3.1", "0.3.0"), 1);
  assert.equal(compareSemver("0.10.0", "0.9.0"), 1);
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);
  assert.equal(compareSemver("0.2.0", "0.2.0"), 0);

  assert.equal(isNewerVersion("0.3.0", "0.2.0"), true);
  assert.equal(isNewerVersion("0.2.0", "0.3.0"), false);
  assert.equal(isNewerVersion("0.2.0", "0.2.0"), false);
  assert.equal(isNewerVersion("v0.3.0", "0.2.0"), true);
});

test("OTA SHA-256 calculation produces correct hex digest", () => {
  const buf = Buffer.from("FarmOS-Firmware-Test-Buffer");
  const sha = computeSha256(buf);
  assert.equal(typeof sha, "string");
  assert.equal(sha.length, 64);
  // Re-hashing the same buffer should yield identical result
  assert.equal(computeSha256(buf), sha);
});

test("OTA state can reconcile a confirmed reboot after a lost status report", () => {
  assert.equal(canTransitionOtaStatus("FLASHING", "BOOT_CONFIRMED"), true);
  assert.equal(canTransitionOtaStatus("FAILED", "BOOT_CONFIRMED"), true);
  assert.equal(canTransitionOtaStatus("FLASHED", "BOOT_CONFIRMED"), true);
  assert.equal(canTransitionOtaStatus("BOOT_CONFIRMED", "FAILED"), false);
  assert.equal(canTransitionOtaStatus("AVAILABLE", "BOOT_CONFIRMED"), false);
});

test("OTA download ticket is device-scoped, signed and expiring", () => {
  const payload = { deviceId: "NODE_TEST", jobId: "job-1", releaseId: "release-1", sha256: "a".repeat(64), expiresAt: Date.now() + 60_000 };
  const ticket = createOtaDownloadTicket(payload);
  assert.deepEqual(verifyOtaDownloadTicket(ticket), payload);
  assert.equal(verifyOtaDownloadTicket(`${ticket}bad`), null);
  assert.equal(verifyOtaDownloadTicket(createOtaDownloadTicket({ ...payload, expiresAt: Date.now() - 1 })), null);
});

test("OTA registers only real-looking binaries and detects newer versions", async (t) => {
  const previousStorage = process.env.OTA_STORAGE_DIR;
  const temporaryStorage = fs.mkdtempSync(path.join(os.tmpdir(), "farmos-ota-"));
  process.env.OTA_STORAGE_DIR = temporaryStorage;
  t.after(() => {
    if (previousStorage === undefined) delete process.env.OTA_STORAGE_DIR;
    else process.env.OTA_STORAGE_DIR = previousStorage;
    fs.rmSync(temporaryStorage, { recursive: true, force: true });
  });

  await assert.rejects(
    OtaService.registerRelease({ deviceType: "GATEWAY", version: "0.3.0", changelog: "invalid" }, Buffer.alloc(32, 0xaa)),
    /ESP application image/
  );
  await assert.rejects(
    OtaService.registerRelease({ deviceType: "GATEWAY", version: "0.3.0", changelog: "wrong target" }, testEspImage("SENSOR_NODE", "0.3.0")),
    /không phải GATEWAY/
  );
  await assert.rejects(
    OtaService.registerRelease({ deviceType: "GATEWAY", version: "0.3.0", changelog: "wrong version" }, testEspImage("GATEWAY", "0.4.0")),
    /không khớp release/
  );
  const gatewayImage = testEspImage("GATEWAY", "0.3.0");
  const nodeImage = testEspImage("SENSOR_NODE", "0.3.0");
  await OtaService.registerRelease({ deviceType: "GATEWAY", version: "0.3.0", changelog: "test", rolloutPercent: 100 }, gatewayImage);
  await OtaService.registerRelease({ deviceType: "SENSOR_NODE", version: "0.3.0", changelog: "test", rolloutPercent: 100 }, nodeImage);

  const gwCheckOlder = await OtaService.checkUpdate("GATEWAY", "0.2.0", "GW_TEST");
  assert.equal(gwCheckOlder.updateAvailable, true);
  assert.ok(gwCheckOlder.latestRelease);
  assert.equal(gwCheckOlder.latestRelease?.deviceType, "GATEWAY");
  assert.equal(compareSemver(gwCheckOlder.latestRelease!.version, "0.2.0"), 1);

  const gwCheckCurrent = await OtaService.checkUpdate("GATEWAY", gwCheckOlder.latestRelease!.version, "GW_TEST");
  assert.equal(gwCheckCurrent.updateAvailable, false);

  const nodeCheckOlder = await OtaService.checkUpdate("SENSOR_NODE", "0.1.0", "NODE_TEST");
  assert.equal(nodeCheckOlder.updateAvailable, true);
  assert.ok(nodeCheckOlder.latestRelease);
  assert.equal(nodeCheckOlder.latestRelease?.deviceType, "SENSOR_NODE");

  const nodeCheckCurrent = await OtaService.checkUpdate("SENSOR_NODE", nodeCheckOlder.latestRelease!.version, "NODE_TEST");
  assert.equal(nodeCheckCurrent.updateAvailable, false);
  const binaryPath = OtaService.getBinaryPath(gwCheckOlder.latestRelease!.fileName);
  assert.ok(binaryPath !== null);
  assert.ok(binaryPath.endsWith(gwCheckOlder.latestRelease!.fileName));

  const nonExistent = OtaService.getBinaryPath("does-not-exist.bin");
  assert.equal(nonExistent, null);

  await assert.rejects(
    OtaService.registerRelease({ deviceType: "GATEWAY", version: "0.3.0", changelog: "replacement", rolloutPercent: 100 }, testEspImage("GATEWAY", "0.3.0", 0x43)),
    /bất biến/
  );
});

test("OTA HTTP endpoints reject unauthenticated clients", async () => {
  const originalFindFirst = prisma.user.findFirst;
  prisma.user.findFirst = (async () => ({
    id: "OTA_TEST_USER",
    email: "ota-test@example.invalid",
    password: "",
    name: "OTA Test User",
    role: "USER",
    created_at: new Date(),
    updated_at: new Date(),
  })) as typeof prisma.user.findFirst;
  const { createApp } = await import("../api/app");
  const app = createApp();
  const server = app.listen(0);
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const checkRes = await fetch(`${baseUrl}/api/v1/ota/check?deviceType=GATEWAY&currentVersion=0.1.0`);
    assert.equal(checkRes.status, 401);
    const relRes = await fetch(`${baseUrl}/api/v1/ota/releases`);
    assert.equal(relRes.status, 401);
    const mobileToken = jwt.sign(
      { id: "OTA_TEST_USER", email: "ota-test@example.invalid", role: "USER" },
      env.JWT_SECRET,
      { algorithm: "HS256", issuer: env.JWT_ISSUER, audience: env.MOBILE_JWT_AUDIENCE, expiresIn: "5m" }
    );
    const authenticatedReleases = await fetch(`${baseUrl}/api/v1/ota/releases`, {
      headers: { Authorization: `Bearer ${mobileToken}` },
    });
    assert.equal(authenticatedReleases.status, 200);
    const dlRes = await fetch(`${baseUrl}/api/v1/ota/download/GATEWAY/0.3.0`);
    assert.equal(dlRes.status, 401);
    const eventsRes = await fetch(`${baseUrl}/api/v1/ota/events?deviceId=GW_TEST`);
    assert.equal(eventsRes.status, 401);
    const statusRes = await fetch(`${baseUrl}/api/v1/ota/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId: "TEST_GATEWAY_OTA",
        deviceType: "GATEWAY",
        targetVersion: "0.3.0",
        status: "BOOT_CONFIRMED",
      }),
    });
    assert.equal(statusRes.status, 401);
  } finally {
    server.close();
    prisma.user.findFirst = originalFindFirst;
  }
});
