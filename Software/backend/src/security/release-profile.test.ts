import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import jwt from "jsonwebtoken";
import { createApp } from "../api/app";
import { env } from "../config/env";
import { prisma } from "../database/prisma";
import { FirmwareUploadService, type ParsedFirmwareUpload } from "../ota/firmware-upload.service";

test("admin catalog defaults to ordinary releases and exposes legacy history only on request", async () => {
  const user = prisma.user.findFirst;
  const list = FirmwareUploadService.list;
  prisma.user.findFirst = (async () => ({ id: "RELEASE_TEST_ADMIN", email: "release-test@farmos.invalid", role: "ADMIN" })) as any;
  FirmwareUploadService.list = (async () => [{ id: "plain", version: "1.0.0" }, { id: "legacy", version: "1.0.0-secure" }]) as any;
  const server = createApp().listen(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const token = jwt.sign({ id: "RELEASE_TEST_ADMIN", email: "release-test@farmos.invalid" }, env.JWT_SECRET,
    { algorithm: "HS256", issuer: env.JWT_ISSUER, audience: env.MOBILE_JWT_AUDIENCE, expiresIn: "5m" });
  try {
    const base = `http://127.0.0.1:${address.port}/api/v1/admin/firmware/releases`;
    for (const [query, ids] of [["", ["plain"]], ["?includeLegacy=true", ["plain", "legacy"]]] as const) {
      const response = await fetch(base + query, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json() as any).data.map((r: any) => r.id), ids);
    }
  } finally {
    server.close();
    prisma.user.findFirst = user;
    FirmwareUploadService.list = list;
  }
});

test("new uploads reject secured firmware before looking up or writing release records", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "farmos-release-policy-"));
  try {
    for (const [version, marker] of [["1.0.0-secure", ""], ["1.0.0", "Flash encryption eFuse bit was not enabled in bootloader"]]) {
      const bytes = Buffer.alloc(512);
      bytes[0] = 0xe9; bytes[1] = 1;
      bytes.writeUInt32LE(256, 28); bytes.writeUInt32LE(0xabcd5432, 32);
      bytes.write(version, 48); bytes.write("farmos_node", 80); bytes.write(marker, 256);
      const tempPath = path.join(folder, "app.bin"); fs.writeFileSync(tempPath, bytes);
      const upload: ParsedFirmwareUpload = { fields: {}, tempDir: folder,
        files: [{ fieldName: "app", role: "APP", originalName: "app.bin", tempPath, sizeBytes: bytes.length, sha256: "a".repeat(64) }] };
      await assert.rejects(FirmwareUploadService.ingest(upload, "TEST"), /secured releases are historical|hardware Secure Boot/);
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
