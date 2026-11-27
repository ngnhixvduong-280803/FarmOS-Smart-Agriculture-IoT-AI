import fs from "node:fs";
import path from "node:path";

export type FlashLayout = {
  layoutId: string;
  partitionTable: { offset: number };
  artifacts?: Record<string, { role: string; offset: number }>;
  writePlans: Record<string, Array<Record<string, unknown>>>;
  normalReflash: { writableRoles?: string[]; readbackRole?: string; readbackPartition?: string; readbackOffset: number; writePlan?: string };
};

export interface FlashLayoutLoadOptions {
  env?: Record<string, string | undefined>;
  moduleDir?: string;
  cwd?: string;
}

const LAYOUT_FILE_NAME = "flash_layout.json";

function pathInside(root: string, candidate: string): string | null {
  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    const relative = path.relative(realRoot, realCandidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    if (path.basename(realCandidate) !== LAYOUT_FILE_NAME) return null;
    if (!fs.statSync(realCandidate).isFile()) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

function validLayout(value: unknown): value is FlashLayout {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const parsed = value as Partial<FlashLayout>;
  return typeof parsed.layoutId === "string" && parsed.layoutId.length > 0
    && parsed.partitionTable?.offset === 0x10000
    && parsed.normalReflash?.readbackOffset === 0x20000
    && Array.isArray(parsed.writePlans?.NORMAL_REFLASH) && parsed.writePlans.NORMAL_REFLASH.length > 0
    && Array.isArray(parsed.writePlans?.FACTORY_FULL_FLASH) && parsed.writePlans.FACTORY_FULL_FLASH.length > 0;
}

function readLayout(root: string, candidate: string): FlashLayout | null {
  const safePath = pathInside(root, candidate);
  if (!safePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(safePath, "utf8")) as unknown;
    return validLayout(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Load the immutable partition metadata used by Web Serial.
 *
 * Production images set FARMOS_FLASH_LAYOUT_PATH to /app/firmware/flash_layout.json
 * and copy that file during the image build. An explicitly configured mount
 * must also set FARMOS_FLASH_LAYOUT_DIR; realpath containment prevents a
 * traversal or symlink from escaping that mount. Development retains the
 * workspace fallback for source/tsx runs.
 */
export function loadFlashLayout(options: FlashLayoutLoadOptions = {}): FlashLayout {
  const source = options.env || process.env;
  const moduleDir = options.moduleDir || __dirname;
  const cwd = options.cwd || process.cwd();
  const packagedPath = path.resolve(moduleDir, "../../firmware", LAYOUT_FILE_NAME);
  const configuredPath = String(source.FARMOS_FLASH_LAYOUT_PATH || "").trim();
  const configuredDir = String(source.FARMOS_FLASH_LAYOUT_DIR || "").trim();

  if (configuredPath || configuredDir) {
    const candidate = configuredPath || path.join(configuredDir, LAYOUT_FILE_NAME);
    const root = configuredDir || path.dirname(packagedPath);
    if (!configuredDir && path.resolve(candidate) !== packagedPath) {
      throw new Error("FARMOS_FLASH_LAYOUT_PATH requires FARMOS_FLASH_LAYOUT_DIR");
    }
    const loaded = readLayout(root, candidate);
    if (loaded) return loaded;
    throw new Error("FarmOS firmware/flash_layout.json is unavailable or unsafe");
  }

  if (String(source.NODE_ENV || "").trim() === "production") {
    throw new Error("FarmOS firmware/flash_layout.json is unavailable or unsafe");
  }

  const developmentCandidates = [
    { root: path.dirname(packagedPath), candidate: packagedPath },
    { root: path.resolve(moduleDir, "../../../firmware"), candidate: path.resolve(moduleDir, "../../../firmware", LAYOUT_FILE_NAME) },
    { root: path.resolve(cwd, "../firmware"), candidate: path.resolve(cwd, "../firmware", LAYOUT_FILE_NAME) },
  ];
  for (const entry of developmentCandidates) {
    const loaded = readLayout(entry.root, entry.candidate);
    if (loaded) return loaded;
  }
  throw new Error("FarmOS firmware/flash_layout.json is unavailable or unsafe");
}
