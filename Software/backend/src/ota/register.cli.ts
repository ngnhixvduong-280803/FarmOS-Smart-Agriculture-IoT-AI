import fs from "node:fs";
import path from "node:path";
import { OtaService } from "./ota.service";

async function main() {
  const [deviceType, version, binaryInput, changelog = "", minVersion, rolloutInput = "0",
    firmwareTarget, hardwareRevisionsInput = "REV_A", partitionScheme = "FARMOS_16M_V1", statusInput] = process.argv.slice(2);
  if (!(["GATEWAY", "SENSOR_NODE"] as string[]).includes(deviceType) || !version || !binaryInput) {
    throw new Error("Usage: npm run ota:register -- <GATEWAY|SENSOR_NODE> <x.y.z> <firmware.bin> [changelog] [minVersion] [rolloutPercent] [firmwareTarget] [hardwareRevisionsCsv] [partitionScheme] [DRAFT|ACTIVE|PAUSED|REVOKED]");
  }
  const binaryPath = path.resolve(binaryInput);
  const binary = fs.readFileSync(binaryPath);
  const release = await OtaService.registerRelease({
    deviceType: deviceType as "GATEWAY" | "SENSOR_NODE",
    version,
    changelog,
    fileName: `${deviceType.toLowerCase()}-v${version.replace(/^v/i, "")}.bin`,
    minVersion,
    rolloutPercent: Number(rolloutInput),
    firmwareTarget,
    hardwareRevisions: hardwareRevisionsInput.split(",").map(value => value.trim()).filter(Boolean),
    partitionScheme,
    status: statusInput as "DRAFT" | "ACTIVE" | "PAUSED" | "REVOKED" | undefined,
  }, binary);
  process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
