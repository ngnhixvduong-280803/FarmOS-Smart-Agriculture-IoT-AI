import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface FirmwareRelease {
  id: string;
  deviceType: "GATEWAY" | "SENSOR_NODE";
  firmwareTarget: string;
  hardwareRevisions: string[];
  partitionScheme: string;
  version: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  changelog: string;
  releaseDate: string;
  minVersion?: string;
  rolloutPercent?: number;
  status: "DRAFT" | "ACTIVE" | "PAUSED" | "REVOKED";
}

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-secure)?$/;
const SAFE_TARGET_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;
const ESP_IMAGE_HEADER_SIZE = 24;
const ESP_SEGMENT_HEADER_SIZE = 8;
const ESP_APP_DESCRIPTOR_SIZE = 196;
const ESP_APP_DESCRIPTOR_MAGIC = 0xabcd5432;

export function defaultFirmwareTarget(deviceType: "GATEWAY" | "SENSOR_NODE"): string {
  return deviceType === "GATEWAY" ? "ESP32S3_LORA_GATEWAY_V1" : "ESP32S3_LORA_SENSOR_V1";
}

function storageDir(): string {
  return path.resolve(process.env.OTA_STORAGE_DIR || path.resolve(__dirname, "../../storage/firmware"));
}

function safeStoredFileName(fileName: string): string | null {
  const value = String(fileName || "");
  if (!value || path.basename(value) !== value || !/^[A-Za-z0-9_.-]+$/.test(value) || value.includes("..")) return null;
  return value;
}

function manifestFile(): string {
  return path.join(storageDir(), "manifest.json");
}

/**
 * Compare two semver strings (e.g. "0.3.0" vs "0.2.0" or "v1.0.1" vs "v1.0.0").
 * Returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal.
 */
export function compareSemver(v1: string, v2: string): number {
  const clean = (v: string) => v.replace(/^v/i, "").trim().split(".").map((n) => parseInt(n, 10) || 0);
  const p1 = clean(v1);
  const p2 = clean(v2);
  const maxLen = Math.max(p1.length, p2.length);

  for (let i = 0; i < maxLen; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

function normalizeVersion(version: string): string {
  const clean = version.replace(/^v/i, "").trim();
  if (!SEMVER_PATTERN.test(clean)) throw new Error(`Phiên bản firmware không hợp lệ: ${version}`);
  return clean;
}

export function isNewerVersion(targetVersion: string, currentVersion: string): boolean {
  return compareSemver(targetVersion, currentVersion) > 0;
}

export function computeSha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function descriptorString(buffer: Buffer, offset: number, length: number): string | null {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  const value = field.subarray(0, end < 0 ? field.length : end).toString("utf8");
  return /^[\x20-\x7e]+$/.test(value) ? value : null;
}

/**
 * Read the ESP-IDF application descriptor from an image without trusting the
 * upload filename or any client-provided metadata.  The first segment of an
 * ESP application image contains the descriptor at the fixed image-header
 * offset; callers use this for release validation and version inference.
 */
export function inspectEspApplicationImage(buffer: Buffer): { version: string; projectName: string } | null {
  const descriptorOffset = ESP_IMAGE_HEADER_SIZE + ESP_SEGMENT_HEADER_SIZE;
  if (buffer.length < descriptorOffset + ESP_APP_DESCRIPTOR_SIZE || buffer[0] !== 0xe9) return null;
  const segmentCount = buffer[1];
  const firstSegmentLength = buffer.readUInt32LE(ESP_IMAGE_HEADER_SIZE + 4);
  if (segmentCount < 1 || segmentCount > 16 || firstSegmentLength < ESP_APP_DESCRIPTOR_SIZE ||
      descriptorOffset + firstSegmentLength > buffer.length ||
      buffer.readUInt32LE(descriptorOffset) !== ESP_APP_DESCRIPTOR_MAGIC) return null;
  const version = descriptorString(buffer, descriptorOffset + 16, 32);
  const projectName = descriptorString(buffer, descriptorOffset + 48, 32);
  return version && projectName ? { version, projectName } : null;
}

export function expectedProjectName(deviceType: "GATEWAY" | "SENSOR_NODE"): string {
  return deviceType === "GATEWAY" ? "farmos_gateway" : "farmos_node";
}

function ensureStorage(): void {
  const directory = storageDir();
  const manifest = manifestFile();
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  // Firmware binaries and the manifest contain deployment material. Keep the
  // directory private even when it was created by an older process with the
  // platform default permissions.
  try { fs.chmodSync(directory, 0o700); } catch { /* best-effort on platforms without chmod */ }
  if (!fs.existsSync(manifest)) {
    try {
      fs.writeFileSync(manifest, "[]\n", { encoding: "utf-8", flag: "wx", mode: 0o600 });
    } catch (error: any) {
      // Another backend process may have initialized the storage between the
      // exists check and wx creation.  Only that expected race is harmless.
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

/** Read an artifact through an already-open descriptor and refuse symlinks.
 * This closes the lstat/readFile TOCTOU window at the security boundary. */
function readRegularArtifact(filePath: string): Buffer | null {
  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW || 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    return fs.readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best-effort cleanup */ }
    }
  }
}

type ManifestLock = { fd: number; token: string; path: string };

const MANIFEST_LOCK_WAIT_MS = 15_000;
const MANIFEST_LOCK_STALE_MS = 60_000;

function manifestLockFile(): string {
  return `${manifestFile()}.lock`;
}

function sleepSync(milliseconds: number): void {
  // Manifest mutations are synchronous by design.  A bounded wait prevents
  // two backend processes from losing each other's load/modify/save update
  // while keeping lock contention finite and observable.
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function acquireManifestLock(): ManifestLock {
  ensureStorage();
  const lockPath = manifestLockFile();
  const deadline = Date.now() + MANIFEST_LOCK_WAIT_MS;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, token, undefined, "utf8");
        return { fd, token, path: lockPath };
      } catch (writeError) {
        try { fs.closeSync(fd); } catch { /* best-effort close */ }
        try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort cleanup */ }
        throw writeError;
      }
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > MANIFEST_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError: any) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new Error("OTA manifest is busy; retry the firmware operation");
      sleepSync(10);
    }
  }
}

function releaseManifestLock(lock: ManifestLock): void {
  try { fs.closeSync(lock.fd); } catch { /* best-effort close */ }
  try {
    // Do not remove a lock that was replaced after a stale-lock recovery.
    if (fs.readFileSync(lock.path, "utf8") === lock.token) fs.rmSync(lock.path, { force: true });
  } catch { /* best-effort cleanup */ }
}

function withManifestLock<T>(operation: () => T): T {
  const lock = acquireManifestLock();
  try {
    return operation();
  } finally {
    releaseManifestLock(lock);
  }
}

function normalizedRelease(value: unknown): FirmwareRelease | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<FirmwareRelease>;
  if (!raw.deviceType || !["GATEWAY", "SENSOR_NODE"].includes(raw.deviceType)) return null;
  const release: FirmwareRelease = {
    ...(raw as FirmwareRelease),
    firmwareTarget: raw.firmwareTarget || defaultFirmwareTarget(raw.deviceType),
    hardwareRevisions: raw.hardwareRevisions?.length ? raw.hardwareRevisions : ["REV_A"],
    partitionScheme: raw.partitionScheme || "FARMOS_16M_V1",
    status: raw.status || ((raw.rolloutPercent ?? 0) > 0 ? "ACTIVE" : "DRAFT"),
  };
  if (!["GATEWAY", "SENSOR_NODE"].includes(release.deviceType) ||
      typeof release.id !== "string" || !release.id ||
      !SAFE_TARGET_PATTERN.test(release.firmwareTarget) ||
      !Array.isArray(release.hardwareRevisions) || !release.hardwareRevisions.length ||
      release.hardwareRevisions.some(value => value !== "*" && !SAFE_TARGET_PATTERN.test(value)) ||
      !SAFE_TARGET_PATTERN.test(release.partitionScheme) ||
      !["DRAFT", "ACTIVE", "PAUSED", "REVOKED"].includes(release.status) ||
      !SEMVER_PATTERN.test(String(release.version || "")) ||
      (release.minVersion !== undefined && !SEMVER_PATTERN.test(String(release.minVersion))) ||
      typeof release.fileName !== "string" || path.basename(release.fileName) !== release.fileName ||
      typeof release.changelog !== "string" ||
      !/^[a-f0-9]{64}$/.test(String(release.sha256 || "")) ||
      !Number.isSafeInteger(release.sizeBytes) || release.sizeBytes <= 0 ||
      (release.rolloutPercent !== undefined &&
       (!Number.isInteger(release.rolloutPercent) || release.rolloutPercent < 0 || release.rolloutPercent > 100))) return null;
  const fileName = safeStoredFileName(String(release.fileName || ""));
  if (!fileName) return null;
  const binaryPath = path.join(storageDir(), fileName);
  const binary = readRegularArtifact(binaryPath);
  if (!binary) return null;
  const descriptor = inspectEspApplicationImage(binary);
  // The embedded descriptor prevents a valid-looking image for a different
  // firmware target/version from being advertised by a mistaken manifest.
  return binary.length === release.sizeBytes && descriptor?.version === release.version &&
    descriptor.projectName === expectedProjectName(release.deviceType) && computeSha256(binary) === release.sha256
    ? release
    : null;
}

export function loadReleases(): FirmwareRelease[] {
  ensureStorage();
  try {
    const raw = fs.readFileSync(manifestFile(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(normalizedRelease).filter((release): release is FirmwareRelease => Boolean(release))
      : [];
  } catch {
    return [];
  }
}

export function saveReleases(releases: FirmwareRelease[]): void {
  withManifestLock(() => saveReleasesUnlocked(releases));
}

function saveReleasesUnlocked(releases: FirmwareRelease[]): void {
  const manifest = manifestFile();
  const temporary = `${manifest}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(releases, null, 2)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, manifest);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export class OtaService {
  static getStorageDir(): string {
    ensureStorage();
    return storageDir();
  }

  static async listReleases(deviceType?: "GATEWAY" | "SENSOR_NODE"): Promise<FirmwareRelease[]> {
    const all = loadReleases();
    if (!deviceType) return all;
    return all.filter((r) => r.deviceType === deviceType);
  }

  static async getReleaseById(releaseId: string): Promise<FirmwareRelease | null> {
    return loadReleases().find((release) => release.id === releaseId) || null;
  }

  static async getLatestRelease(deviceType: "GATEWAY" | "SENSOR_NODE"): Promise<FirmwareRelease | null> {
    const list = await this.listReleases(deviceType);
    if (list.length === 0) return null;
    return list.sort((a, b) => compareSemver(b.version, a.version))[0] || null;
  }

  static async checkUpdate(
    deviceType: "GATEWAY" | "SENSOR_NODE",
    currentVersion: string,
    deviceId: string,
    compatibility?: { firmwareTarget: string; hardwareRevision: string; partitionScheme: string }
  ): Promise<{
    updateAvailable: boolean;
    currentVersion: string;
    latestRelease?: FirmwareRelease;
  }> {
    const cleanCurrent = normalizeVersion(currentVersion);
    const expectedTarget = compatibility?.firmwareTarget || defaultFirmwareTarget(deviceType);
    const releases = (await this.listReleases(deviceType))
      .filter((release) => release.status === "ACTIVE" &&
        // OTA must stay on the installed security profile. Ordinary USB boards
        // must never be offered a newer hardware-secured runtime.
        release.version.endsWith("-secure") === cleanCurrent.endsWith("-secure") &&
        release.firmwareTarget === expectedTarget &&
        (!compatibility || release.partitionScheme === compatibility.partitionScheme) &&
        (!compatibility || release.hardwareRevisions.includes("*") ||
          release.hardwareRevisions.includes(compatibility.hardwareRevision)))
      .sort((a, b) => compareSemver(b.version, a.version));
    // minVersion supports staged migrations when a device cannot jump directly
    // from an old layout/protocol to the newest image.
    const latest = releases.find((release) =>
      (!release.minVersion || compareSemver(cleanCurrent, release.minVersion) >= 0) &&
      this.isRolloutEligible(release, deviceId)
    ) || null;
    if (!latest) {
      return { updateAvailable: false, currentVersion: cleanCurrent };
    }
    const updateAvailable = isNewerVersion(latest.version, cleanCurrent);
    return {
      updateAvailable,
      currentVersion: cleanCurrent,
      latestRelease: latest,
    };
  }

  static isRolloutEligible(release: FirmwareRelease, deviceId: string): boolean {
    const percent = release.rolloutPercent ?? 0;
    if (percent <= 0 || !deviceId) return false;
    if (percent >= 100) return true;
    const digest = crypto.createHash("sha256").update(`${release.id}\0${deviceId}`).digest();
    return digest.readUInt32BE(0) % 100 < percent;
  }

  static async getReleaseByVersion(
    deviceType: "GATEWAY" | "SENSOR_NODE",
    version: string
  ): Promise<FirmwareRelease | null> {
    const list = await this.listReleases(deviceType);
    const cleanVer = normalizeVersion(version);
    return list.find((r) => r.version.replace(/^v/i, "").trim() === cleanVer) || null;
  }

  static getBinaryPath(fileName: string): string | null {
    ensureStorage();
    const safeName = safeStoredFileName(fileName);
    if (!safeName) return null;
    const filePath = path.join(storageDir(), safeName);
    try {
      return fs.lstatSync(filePath).isFile() ? filePath : null;
    } catch {
      return null;
    }
  }

  /**
   * Verify the bytes currently stored under a catalog filename.  Catalog
   * metadata is immutable, but the private storage volume can still be
   * truncated or replaced after registration; callers must fail closed at
   * every download/flash boundary instead of trusting a stale manifest.
   */
  static verifyStoredArtifact(fileName: string, sha256: string, sizeBytes: number): string | null {
    if (!/^[a-f0-9]{64}$/.test(String(sha256 || "")) || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) return null;
    const filePath = this.getBinaryPath(fileName);
    if (!filePath) return null;
    const binary = readRegularArtifact(filePath);
    return binary && binary.length === sizeBytes && computeSha256(binary) === sha256 ? filePath : null;
  }

  static async registerRelease(
    data: {
      deviceType: "GATEWAY" | "SENSOR_NODE";
      version: string;
      changelog: string;
      fileName?: string;
      minVersion?: string;
      rolloutPercent?: number;
      firmwareTarget?: string;
      hardwareRevisions?: string[];
      partitionScheme?: string;
      status?: "DRAFT" | "ACTIVE" | "PAUSED" | "REVOKED";
    },
    buffer?: Buffer
  ): Promise<FirmwareRelease> {
    ensureStorage();
    const cleanVer = normalizeVersion(data.version);
    const minimum = data.minVersion ? normalizeVersion(data.minVersion) : undefined;
    if (minimum && compareSemver(minimum, cleanVer) > 0) {
      throw new Error("minVersion không được lớn hơn phiên bản phát hành");
    }
    const rolloutPercent = data.rolloutPercent ?? 0;
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
      throw new Error("rolloutPercent phải là số nguyên từ 0 đến 100");
    }
    if (!buffer?.length) throw new Error("Bản phát hành OTA phải chứa firmware binary");
    const descriptor = inspectEspApplicationImage(buffer);
    if (!descriptor) throw new Error("Firmware không phải ESP application image hợp lệ");
    if (descriptor.projectName !== expectedProjectName(data.deviceType)) {
      throw new Error(`Firmware binary thuộc project ${descriptor.projectName}, không phải ${data.deviceType}`);
    }
    if (descriptor.version !== cleanVer) {
      throw new Error(`Version trong firmware (${descriptor.version}) không khớp release (${cleanVer})`);
    }
    const firmwareTarget = data.firmwareTarget || defaultFirmwareTarget(data.deviceType);
    const hardwareRevisions = data.hardwareRevisions?.length ? [...new Set(data.hardwareRevisions)] : ["REV_A"];
    const partitionScheme = data.partitionScheme || "FARMOS_16M_V1";
    const status = data.status || (rolloutPercent > 0 ? "ACTIVE" : "DRAFT");
    if (!SAFE_TARGET_PATTERN.test(firmwareTarget) || !SAFE_TARGET_PATTERN.test(partitionScheme) ||
        !["DRAFT", "ACTIVE", "PAUSED", "REVOKED"].includes(status) ||
        hardwareRevisions.some(value => value !== "*" && !SAFE_TARGET_PATTERN.test(value))) {
      throw new Error("Firmware target, hardware revision hoặc partition scheme không hợp lệ");
    }
    const sha256 = computeSha256(buffer);
    const sizeBytes = buffer.length;
    return withManifestLock(() => {
      const existing = loadReleases().find((release) =>
        release.firmwareTarget === firmwareTarget && release.version === cleanVer
      );
      if (existing && existing.sha256 !== sha256) {
        throw new Error(`Release ${firmwareTarget} v${cleanVer} là bất biến; hãy tăng version cho binary mới`);
      }
      if (existing && (existing.deviceType !== data.deviceType || existing.partitionScheme !== partitionScheme ||
          existing.minVersion !== minimum ||
          JSON.stringify([...existing.hardwareRevisions].sort()) !== JSON.stringify([...hardwareRevisions].sort()))) {
        throw new Error(`Metadata tương thích của ${firmwareTarget} v${cleanVer} là bất biến; chỉ được đổi rollout/status`);
      }
      const requestedFileName = data.fileName || `${data.deviceType.toLowerCase()}-v${cleanVer}.bin`;
      const normalizedRequestedFileName = requestedFileName.replaceAll("\\", "/");
      if (path.basename(normalizedRequestedFileName) !== normalizedRequestedFileName) {
        throw new Error("Tên file firmware không hợp lệ");
      }
      const fileName = existing?.fileName || normalizedRequestedFileName;
      if (!fileName || fileName !== path.basename(fileName) || !/^[A-Za-z0-9_.-]+$/.test(fileName) || fileName.includes("..")) {
        throw new Error("Tên file firmware không hợp lệ");
      }
      const targetPath = path.join(storageDir(), fileName);
      let createdBinary = false;
      try {
        let existingFile: fs.Stats | null = null;
        try { existingFile = fs.lstatSync(targetPath); } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
        if (existingFile) {
          if (!existingFile.isFile() || existingFile.isSymbolicLink()) {
            throw new Error("Firmware artifact đã tồn tại nhưng không khớp hash/size");
          }
          const stored = readRegularArtifact(targetPath);
          if (!stored || stored.length !== sizeBytes || computeSha256(stored) !== sha256) {
            throw new Error("Firmware artifact đã tồn tại nhưng không khớp hash/size");
          }
        } else {
          const temporary = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
          try {
            fs.writeFileSync(temporary, buffer, { mode: 0o600, flag: "wx" });
            fs.renameSync(temporary, targetPath);
            createdBinary = true;
          } catch (error) {
            try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
            throw error;
          }
        }

        const newRelease: FirmwareRelease = {
          id: existing?.id || `rel-${firmwareTarget.toLowerCase()}-${cleanVer}`,
          deviceType: data.deviceType,
          firmwareTarget,
          hardwareRevisions,
          partitionScheme,
          version: cleanVer,
          fileName,
          sha256,
          sizeBytes,
          changelog: data.changelog || `Bản phát hành firmware ${data.deviceType} v${cleanVer}`,
          releaseDate: existing?.releaseDate || new Date().toISOString(),
          minVersion: minimum,
          rolloutPercent,
          status,
        };

        const releases = loadReleases().filter(
          (r) => !(r.firmwareTarget === firmwareTarget && r.version === cleanVer)
        );
        releases.push(newRelease);
        saveReleasesUnlocked(releases);
        return newRelease;
      } catch (error) {
        if (createdBinary) {
          try { fs.rmSync(targetPath, { force: true }); } catch { /* best-effort cleanup */ }
        }
        throw error;
      }
    });
  }

  /**
   * Remove a newly-created draft release after a later catalog write fails.
   * The hash guard prevents a failed request from deleting an immutable
   * artifact that another request already owns.
   */
  static removeReleaseIfDraft(releaseId: string, sha256: string): boolean {
    return withManifestLock(() => {
      const releases = loadReleases();
      const release = releases.find((value) => value.id === releaseId);
      if (!release || release.status !== "DRAFT" || release.sha256 !== sha256) return false;
      const remaining = releases.filter((value) => value.id !== releaseId);
      saveReleasesUnlocked(remaining);
      const binaryPath = path.join(storageDir(), path.basename(release.fileName));
      try { fs.rmSync(binaryPath, { force: true }); } catch { /* best-effort cleanup */ }
      return true;
    });
  }

  /** Permanently remove a release manifest and its app artifact. */
  static deleteRelease(releaseId: string): boolean {
    return withManifestLock(() => {
      const releases = loadReleases();
      const release = releases.find((value) => value.id === releaseId);
      if (!release) return false;
      const fileName = path.basename(release.fileName);
      if (!/^[A-Za-z0-9_.-]+$/.test(fileName) || fileName.includes("..")) {
        throw new Error("Firmware artifact filename is invalid");
      }
      saveReleasesUnlocked(releases.filter((value) => value.id !== releaseId));
      fs.rmSync(path.join(storageDir(), fileName), { force: true });
      return true;
    });
  }

  /** Update the mutable rollout controls without re-ingesting the binary. */
  static updateReleaseStatus(
    releaseId: string,
    patch: { status?: FirmwareRelease["status"]; rolloutPercent?: number; changelog?: string }
  ): FirmwareRelease {
    return withManifestLock(() => {
      const releases = loadReleases();
      const index = releases.findIndex((release) => release.id === releaseId);
      if (index < 0) throw new Error("Firmware release artifact is unavailable");
      const current = releases[index];
      const rolloutPercent = patch.rolloutPercent ?? current.rolloutPercent ?? 0;
      if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
        throw new Error("rolloutPercent phải là số nguyên từ 0 đến 100");
      }
      const updated: FirmwareRelease = {
        ...current,
        status: patch.status || current.status,
        rolloutPercent,
        changelog: patch.changelog === undefined ? current.changelog : patch.changelog.slice(0, 2_000),
      };
      releases[index] = updated;
      saveReleasesUnlocked(releases);
      return updated;
    });
  }
}
