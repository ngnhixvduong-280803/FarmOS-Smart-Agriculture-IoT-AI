import assert from "node:assert/strict";
import test from "node:test";
import { firmwareMatchesBoardSecurity, firmwareSecurityRequirements } from "./firmware-security";

test("unlocked boards select plain firmware and never a fuse-burning bootloader", () => {
  const plain = Buffer.from("plain-esp-idf-image");
  const secureBoot = Buffer.from("secure_boot_v2 flash_encrypt");
  assert.equal(firmwareMatchesBoardSecurity(plain, plain, false), true);
  assert.equal(firmwareMatchesBoardSecurity(plain, secureBoot, false), false);
});

test("encrypted boards select the encrypted runtime and secure bootloader together", () => {
  const app = Buffer.from("Flash encryption eFuse bit was not enabled in bootloader but CONFIG_SECURE_FLASH_ENC_ENABLED is on");
  const boot = Buffer.from("secure_boot_v2 flash_encrypt");
  assert.deepEqual(firmwareSecurityRequirements(app, boot), { flashEncryption: true, secureBoot: true });
  assert.equal(firmwareMatchesBoardSecurity(app, boot, true), true);
  assert.equal(firmwareMatchesBoardSecurity(app, boot, false), false);
  assert.equal(firmwareMatchesBoardSecurity(Buffer.from("plain"), Buffer.from("plain"), true), false);
});

test("USB flash policy defaults to plain firmware and rejects secured boards", async () => {
  const { usbFlashEncryptionEnabled } = await import("./firmware-security");
  assert.equal(usbFlashEncryptionEnabled(undefined), false);
  assert.equal(usbFlashEncryptionEnabled(false), false);
  for (const value of [true, "false", null, 0]) assert.throws(() => usbFlashEncryptionEnabled(value));
});
