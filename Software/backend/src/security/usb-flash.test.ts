import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { createApp } from "../api/app";
import { env } from "../config/env";
import { prisma } from "../database/prisma";
import { computeSha256 } from "../ota/ota.service";

test("USB inspect selects plain artifacts by default and cannot select a secure or damaged release", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "farmos-usb-policy-"));
  const originals = {
    user: prisma.user.findFirst, board: prisma.hardwareBoard.findUnique,
    many: prisma.firmwareRelease.findMany, one: prisma.firmwareRelease.findUnique,
    storage: process.env.OTA_STORAGE_DIR,
  };
  function release(id: string, secure: boolean) {
    const images = [
      ["BOOTLOADER", 0, secure ? "secure_boot_v2 flash_encrypt" : "plain bootloader"],
      ["PARTITION_TABLE", 0x10000, "partition table"],
      ["OTA_DATA", 0x19000, "ota data"],
      ["APP", 0x20000, secure ? "Flash encryption eFuse bit was not enabled in bootloader" : "plain app"],
    ].map(([role, address, content]) => {
      const bytes = Buffer.from(String(content));
      const fileName = `${id}-${role}.bin`;
      fs.writeFileSync(path.join(folder, fileName), bytes);
      return { id: fileName, fileName, role, address, required: true, sizeBytes: bytes.length, sha256: computeSha256(bytes) };
    });
    return { id, version: secure ? "1.0.1-secure" : "1.0.0", status: "ACTIVE", device_type: "GATEWAY",
      firmware_target: "ESP32S3_LORA_GATEWAY_V1", hardware_revisions: ["*"], images_json: images, created_at: new Date() };
  }
  const plain = release("plain", false);
  const secure = release("secure", true);
  // The newer secure version must not win automatic selection.
  const releases = [secure, plain];
  prisma.user.findFirst = (async () => ({ id: "USB_TEST_ADMIN", email: "usb-test@farmos.invalid", role: "ADMIN" })) as any;
  prisma.hardwareBoard.findUnique = (async () => null) as any;
  prisma.firmwareRelease.findMany = (async () => releases) as any;
  prisma.firmwareRelease.findUnique = (async ({ where }: any) => releases.find(r => r.id === where.id) || null) as any;
  process.env.OTA_STORAGE_DIR = folder;
  const token = jwt.sign({ id: "USB_TEST_ADMIN", email: "usb-test@farmos.invalid", role: "ADMIN" }, env.JWT_SECRET,
    { algorithm: "HS256", issuer: env.JWT_ISSUER, audience: env.MOBILE_JWT_AUDIENCE, expiresIn: "5m" });
  const server = createApp().listen(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  async function inspect(body: object) {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/flash/boards/inspect`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ chipFamily: "ESP32-S3", factoryEfuseMac: "02:00:00:00:00:01", targetType: "GATEWAY", ...body }),
    });
    return { status: response.status, body: await response.json() as any };
  }
  try {
    for (const body of [{}, { flashEncryptionEnabled: false }, { releaseId: "plain" }]) {
      const result = await inspect(body);
      assert.equal(result.status, 200);
      assert.equal(result.body.data.ready, true);
      assert.equal(result.body.data.release.id, "plain");
    }
    for (const body of [{ flashEncryptionEnabled: true }, { releaseId: "secure" }]) {
      const result = await inspect(body);
      assert.equal(result.status, 200);
      assert.equal(result.body.data.ready, false);
      assert.equal(result.body.data.release, null);
      assert.ok(result.body.data.releaseError);
    }
    assert.equal((await inspect({ flashEncryptionEnabled: "false" })).status, 400);
    fs.appendFileSync(path.join(folder, plain.images_json[0].fileName), "tampered");
    const damaged = await inspect({ releaseId: "plain" });
    assert.equal(damaged.body.data.ready, false);
    assert.match(damaged.body.data.releaseError, /hash verification/);
  } finally {
    server.close();
    prisma.user.findFirst = originals.user;
    prisma.hardwareBoard.findUnique = originals.board;
    prisma.firmwareRelease.findMany = originals.many;
    prisma.firmwareRelease.findUnique = originals.one;
    if (originals.storage === undefined) delete process.env.OTA_STORAGE_DIR;
    else process.env.OTA_STORAGE_DIR = originals.storage;
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
