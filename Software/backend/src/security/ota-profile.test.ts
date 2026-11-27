import assert from "node:assert/strict";
import { test } from "node:test";
import { OtaService, type FirmwareRelease } from "../ota/ota.service";

test("OTA never crosses between ordinary firmware and historical secured firmware", async () => {
  const original = OtaService.listReleases;
  const plain: FirmwareRelease = {
    id: "plain", deviceType: "GATEWAY", firmwareTarget: "ESP32S3_LORA_GATEWAY_V1",
    hardwareRevisions: ["*"], partitionScheme: "test", version: "1.1.0",
    fileName: "plain.bin", sha256: "a".repeat(64), sizeBytes: 1,
    changelog: "", releaseDate: new Date().toISOString(), rolloutPercent: 100, status: "ACTIVE",
  };
  const secure = { ...plain, id: "secure", version: "2.0.0-secure" };
  try {
    OtaService.listReleases = async () => [secure, plain];
    assert.equal((await OtaService.checkUpdate("GATEWAY", "1.0.0", "GW_TEST")).latestRelease?.id, "plain");
    assert.equal((await OtaService.checkUpdate("GATEWAY", "1.0.0-secure", "GW_TEST")).latestRelease?.id, "secure");
    OtaService.listReleases = async () => [secure];
    assert.equal((await OtaService.checkUpdate("GATEWAY", "1.0.0", "GW_TEST")).updateAvailable, false);
    OtaService.listReleases = async () => [plain];
    assert.equal((await OtaService.checkUpdate("GATEWAY", "1.0.0-secure", "GW_TEST")).updateAvailable, false);
  } finally {
    OtaService.listReleases = original;
  }
});
