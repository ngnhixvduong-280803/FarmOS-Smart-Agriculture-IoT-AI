import { access, copyFile, mkdir, rm, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const source = process.env.FARMOS_ESPTOOL_BIN;
if (!source) {
  throw new Error("FARMOS_ESPTOOL_BIN phải trỏ đến binary esptool standalone đã kiểm thử cho nền tảng build.");
}
await access(source, constants.R_OK);
const target = path.resolve("src-tauri/resources/tools/esptool/farmos-esptool");
await mkdir(path.dirname(target), { recursive: true });
await rm(target, { force: true });
await copyFile(source, target);
await chmod(target, 0o755);
console.log(`Bundled native flash tool: ${target}`);
