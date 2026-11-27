import { firmwareMatchesBoardSecurity } from "../identity/firmware-security";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Request } from "express";
import busboy from "busboy";
import type { FileInfo } from "busboy";
import { Prisma } from "@prisma/client";
import { prisma } from "../database/prisma";
import { OtaService, defaultFirmwareTarget, expectedProjectName, inspectEspApplicationImage, type FirmwareRelease } from "./ota.service";
import { canonicalManifest, manifestDigest, signManifest } from "../identity/board-identity";
import { loadFlashLayout } from "../config/flash-layout";

export type FirmwareDeviceType = "GATEWAY" | "SENSOR_NODE";
export type FirmwareImageRole = "BOOTLOADER" | "PARTITION_TABLE" | "OTA_DATA" | "APP";
export type FirmwareReleaseStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "REVOKED";
export type FirmwareReleaseChannel = "OTA" | "FACTORY";

type FirmwareReleaseDeleteTransaction = {
  flashJob: { deleteMany(args: { where: { release_id: string } }): Promise<unknown> };
  firmwareRelease: { delete(args: { where: { id: string } }): Promise<unknown> };
};

/** Delete dependent flash history before the release that owns it. */
export async function deleteFirmwareReleaseRecords(
  tx: FirmwareReleaseDeleteTransaction,
  releaseId: string,
): Promise<void> {
  await tx.flashJob.deleteMany({ where: { release_id: releaseId } });
  await tx.firmwareRelease.delete({ where: { id: releaseId } });
}

/** Keep the upload bounded even when a reverse proxy was misconfigured. */
export const MAX_FIRMWARE_FILE_BYTES = boundedLimit(process.env.FARMOS_MAX_FIRMWARE_FILE_BYTES, 64 * 1024 * 1024);
export const MAX_FIRMWARE_TOTAL_BYTES = boundedLimit(process.env.FARMOS_MAX_FIRMWARE_TOTAL_BYTES, 128 * 1024 * 1024);
const configuredUploadTimeout = Number(process.env.FARMOS_FIRMWARE_UPLOAD_TIMEOUT_MS);
/** Bound wall-clock time as well as bytes so a slow client cannot hold an
 * upload slot forever while staying below the multipart size limits. */
export const MAX_FIRMWARE_UPLOAD_DURATION_MS = Number.isSafeInteger(configuredUploadTimeout) && configuredUploadTimeout >= 30_000 && configuredUploadTimeout <= 15 * 60_000
  ? configuredUploadTimeout
  : 10 * 60_000;
const MAX_FIRMWARE_FILES = 5;
const MAX_FIELD_BYTES = 8 * 1024;
const APP_OFFSET = 0x20000;
const PARTITION_TABLE_OFFSET = 0x10000;
const OTA_DATA_OFFSET = 0x19000;
const BOOTLOADER_OFFSET = 0x0000;
const MAX_APP_BYTES = 0x300000;
const MAX_BOOTLOADER_BYTES = 0x10000;
const MAX_PARTITION_TABLE_BYTES = 0x1000;
const MAX_OTA_DATA_BYTES = 0x2000;

const FILE_FIELD_TO_ROLE: Record<string, FirmwareImageRole> = {
  app: "APP",
  bootloader: "BOOTLOADER",
  partitionTable: "PARTITION_TABLE",
  partition_table: "PARTITION_TABLE",
  otaData: "OTA_DATA",
  ota_data: "OTA_DATA",
};

const ALLOWED_FIELDS = new Set([
  // Metadata is deliberately small.  Release identity, version, target,
  // partition, hashes, offsets, and signatures are server-derived; matching
  // legacy fields remain accepted only so old clients can migrate safely.
  "id", "deviceType", "version", "firmwareTarget", "hardwareRevisions", "partitionScheme",
  "minVersion", "changelog", "rolloutPercent", "status",
]);

function boundedLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 512 * 1024 * 1024) return fallback;
  return parsed;
}

export class FirmwareUploadError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "FirmwareUploadError";
  }
}

export interface UploadedFirmwareFile {
  fieldName: string;
  role: FirmwareImageRole;
  originalName: string;
  tempPath: string;
  sha256: string;
  sizeBytes: number;
}

export interface ParsedFirmwareUpload {
  fields: Record<string, string[]>;
  files: UploadedFirmwareFile[];
  tempDir: string;
}

export interface FirmwareImageDescriptor {
  id: string;
  name: string;
  fileName: string;
  address: number;
  sizeBytes: number;
  sha256: string;
  role: FirmwareImageRole;
  required: true;
}

export interface FirmwareCatalogRelease {
  id: string;
  deviceType: FirmwareDeviceType;
  firmwareTarget: string;
  hardwareRevisions: string[];
  partitionScheme: string;
  version: string;
  artifactFileName: string;
  artifactSha256: string;
  sizeBytes: number;
  images: FirmwareImageDescriptor[];
  manifestSha256: string;
  manifestSignature: string;
  manifestKeyId: string;
  writePlans: Record<string, Array<Record<string, unknown>>>;
  changelog: string | null;
  minVersion: string | null;
  rolloutPercent: number;
  otaStatus: FirmwareReleaseStatus;
  flashStatus: FirmwareReleaseStatus;
  factoryReady: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FirmwareUploadResult {
  release: FirmwareCatalogRelease;
  ota: FirmwareRelease;
  factoryReady: boolean;
}

/** Resolve the one changelog value shared by the file and relational catalogs. */
export function effectiveFirmwareChangelog(
  requested: string | null | undefined,
  existingDatabase: string | null | undefined,
  existingOta: string | null | undefined,
  fallback: string,
): string {
  return requested?.trim() || existingDatabase?.trim() || existingOta?.trim() || fallback;
}

function firstField(fields: Record<string, string[]>, name: string): string | undefined {
  const value = fields[name]?.[0];
  return value === undefined ? undefined : value.trim();
}

function optionalText(fields: Record<string, string[]>, name: string, max: number): string | undefined {
  const value = firstField(fields, name);
  if (value === undefined || value === "") return undefined;
  if (value.length > max) throw new FirmwareUploadError(400, `${name} must be at most ${max} characters`);
  return value;
}

function normalizeSemver(value: string, field: string): string {
  const clean = value.replace(/^v/i, "").trim();
  if (!/^\d+\.\d+\.\d+(?:-secure)?$/.test(clean)) throw new FirmwareUploadError(400, `${field} must use x.y.z or x.y.z-secure`);
  return clean;
}

function normalizeTarget(value: string, field: string): string {
  const clean = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(clean)) throw new FirmwareUploadError(400, `${field} is invalid`);
  return clean;
}

function normalizeHardwareRevisions(value: string | undefined): string[] {
  if (!value) return ["*"];
  let values: unknown[];
  try {
    values = value.trim().startsWith("[") ? JSON.parse(value) : value.split(",");
  } catch {
    throw new FirmwareUploadError(400, "hardwareRevisions must be CSV or a JSON array");
  }
  if (!Array.isArray(values) || !values.length) throw new FirmwareUploadError(400, "hardwareRevisions must contain at least one value");
  const normalized = [...new Set(values.map((item) => String(item).trim().toUpperCase()))];
  if (normalized.some((item) => item !== "*" && !/^[A-Z0-9][A-Z0-9_.-]{0,63}$/.test(item))) {
    throw new FirmwareUploadError(400, "hardwareRevisions contains an invalid value");
  }
  return normalized;
}

function safeReleaseId(value: string, expected: string): string {
  const clean = value.trim();
  if (clean && clean !== expected) throw new FirmwareUploadError(409, `id must be the generated release id ${expected}`);
  return expected;
}

function safeOriginalName(value: string, fallback: string): string {
  const basename = path.basename(value.replaceAll("\\", "/"));
  if (!basename || basename === "." || basename === "..") return fallback;
  const clean = basename.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 128);
  return clean || fallback;
}

function fileForRole(files: UploadedFirmwareFile[], role: FirmwareImageRole): UploadedFirmwareFile | undefined {
  return files.find((file) => file.role === role);
}

function imageAddress(role: FirmwareImageRole): number {
  switch (role) {
    case "BOOTLOADER": return BOOTLOADER_OFFSET;
    case "PARTITION_TABLE": return PARTITION_TABLE_OFFSET;
    case "OTA_DATA": return OTA_DATA_OFFSET;
    case "APP": return APP_OFFSET;
  }
}

export function validateFactoryBinary(role: FirmwareImageRole, file: UploadedFirmwareFile): void {
  if (file.sizeBytes <= 0) throw new FirmwareUploadError(400, `${role.toLowerCase()} firmware file must not be empty`);
  if (role === "APP") {
    if (file.sizeBytes > MAX_APP_BYTES) throw new FirmwareUploadError(400, "app firmware exceeds the ESP32-S3 OTA partition size");
    return;
  }
  if (role === "BOOTLOADER") {
    if (file.sizeBytes > MAX_BOOTLOADER_BYTES) throw new FirmwareUploadError(400, "bootloader exceeds its reserved flash region");
    const header = fs.readFileSync(file.tempPath, { encoding: null, flag: "r" }).subarray(0, 1);
    if (header[0] !== 0xe9) throw new FirmwareUploadError(400, "bootloader is not an ESP image");
    return;
  }
  if (role === "PARTITION_TABLE") {
    if (file.sizeBytes > MAX_PARTITION_TABLE_BYTES) throw new FirmwareUploadError(400, "partition table exceeds its reserved flash region");
    const header = fs.readFileSync(file.tempPath, { encoding: null, flag: "r" }).subarray(0, 2);
    // ESP-IDF writes the 16-bit partition-entry magic 0x50AA in little-endian
    // order, so a valid partitions.bin starts with AA 50 (not 50 AA).
    if (header.length < 2 || header[0] !== 0xaa || header[1] !== 0x50) throw new FirmwareUploadError(400, "partition table has an invalid ESP magic");
    return;
  }
  if (file.sizeBytes > MAX_OTA_DATA_BYTES) throw new FirmwareUploadError(400, "ota_data exceeds its reserved flash region");
}

function isFactoryReady(images: FirmwareImageDescriptor[]): boolean {
  const roles = new Set(images.map((image) => image.role));
  return ["BOOTLOADER", "PARTITION_TABLE", "OTA_DATA", "APP"].every((role) => roles.has(role as FirmwareImageRole));
}

function createWritePlans(images: FirmwareImageDescriptor[]): Record<string, Array<Record<string, unknown>>> {
  if (!isFactoryReady(images)) return {};
  const layout = loadFlashLayout();
  const byRole = new Map(images.map((image) => [image.role, image]));
  const plans: Record<string, Array<Record<string, unknown>>> = {};
  for (const [planName, steps] of Object.entries(layout.writePlans)) {
    plans[planName] = steps.map((step) => {
      const role = String(step.role || "").toUpperCase() as FirmwareImageRole;
      const image = byRole.get(role);
      if (!image || image.address !== Number(step.address)) {
        throw new FirmwareUploadError(409, `Factory bundle is missing the canonical ${role} image`);
      }
      return {
        order: Number(step.order),
        phase: String(step.phase || ""),
        imageId: image.id,
        role,
        address: image.address,
        selector: step.selector || null,
        requiresPrevious: step.requiresPrevious || null,
        verifyBeforeNext: step.verifyBeforeNext === true,
        verifyBeforeReboot: step.verifyBeforeReboot === true,
        artifact: String(step.artifact || ""),
      };
    });
  }
  return plans;
}

function imageFromUpload(releaseId: string, file: UploadedFirmwareFile, role: FirmwareImageRole, storedFileName?: string): FirmwareImageDescriptor {
  const suffix = role.toLowerCase();
  const fileName = storedFileName || `${releaseId}-${suffix}.bin`;
  return {
    id: `${releaseId}-${suffix}`,
    name: safeOriginalName(file.originalName, fileName),
    fileName,
    address: imageAddress(role),
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    role,
    required: true,
  };
}

export function assertFactoryBundleRoles(roles: FirmwareImageRole[]): void {
  const factoryParts = ["BOOTLOADER", "PARTITION_TABLE", "OTA_DATA"] as const;
  const supplied = factoryParts.filter((role) => roles.includes(role));
  if (supplied.length > 0 && supplied.length !== factoryParts.length) {
    throw new FirmwareUploadError(400, "Factory flashing requires bootloader, partitionTable, and otaData together; upload app alone for OTA-only release");
  }
}

function parseUploadFields(parsed: ParsedFirmwareUpload, appDescriptor: { version: string; projectName: string }) {
  const requestedType = optionalText(parsed.fields, "deviceType", 32)?.toUpperCase() as FirmwareDeviceType | undefined;
  const inferredType = appDescriptor.projectName === "farmos_gateway" ? "GATEWAY" : appDescriptor.projectName === "farmos_node" ? "SENSOR_NODE" : null;
  const deviceType = requestedType || inferredType;
  if (!deviceType || !["GATEWAY", "SENSOR_NODE"].includes(deviceType)) throw new FirmwareUploadError(400, "deviceType must be GATEWAY or SENSOR_NODE (or a FarmOS app descriptor must be present)");
  if (inferredType && requestedType && inferredType !== requestedType) throw new FirmwareUploadError(409, `Firmware descriptor belongs to ${inferredType}, not ${requestedType}`);
  const suppliedVersion = optionalText(parsed.fields, "version", 32);
  const version = normalizeSemver(suppliedVersion || appDescriptor.version, "version");
  if (appDescriptor.version !== version) throw new FirmwareUploadError(409, `version in firmware (${appDescriptor.version}) does not match release (${version})`);
  // The ESP project descriptor determines the FarmOS target.  A client may
  // repeat the derived value during migration, but may not mint a custom
  // target or partition scheme through the admin form.
  const firmwareTarget = defaultFirmwareTarget(deviceType);
  const suppliedFirmwareTarget = optionalText(parsed.fields, "firmwareTarget", 64);
  if (suppliedFirmwareTarget && suppliedFirmwareTarget.trim().toUpperCase() !== firmwareTarget) {
    throw new FirmwareUploadError(409, `firmwareTarget is server-derived as ${firmwareTarget}`);
  }
  const partitionScheme = "FARMOS_16M_V1";
  const suppliedPartitionScheme = optionalText(parsed.fields, "partitionScheme", 64);
  if (suppliedPartitionScheme && suppliedPartitionScheme.trim().toUpperCase() !== partitionScheme) {
    throw new FirmwareUploadError(409, `partitionScheme is server-derived as ${partitionScheme}`);
  }
  const hardwareRevisions = normalizeHardwareRevisions(optionalText(parsed.fields, "hardwareRevisions", 512));
  const minVersionInput = optionalText(parsed.fields, "minVersion", 32);
  const minVersion = minVersionInput ? normalizeSemver(minVersionInput, "minVersion") : null;
  if (minVersion && compareVersions(minVersion, version) > 0) throw new FirmwareUploadError(400, "minVersion must not be greater than version");
  const changelog = optionalText(parsed.fields, "changelog", 2_000) || null;
  const requestedStatus = (optionalText(parsed.fields, "status", 32) || "DRAFT").toUpperCase();
  if (requestedStatus !== "DRAFT") throw new FirmwareUploadError(400, "new firmware uploads always start as DRAFT; activate it with PATCH after review");
  const rolloutInput = optionalText(parsed.fields, "rolloutPercent", 16);
  const rolloutPercent = rolloutInput === undefined || rolloutInput === "" ? 0 : Number(rolloutInput);
  if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) throw new FirmwareUploadError(400, "rolloutPercent must be an integer from 0 to 100");
  const expectedId = `rel-${firmwareTarget.toLowerCase()}-${version}`;
  const id = safeReleaseId(optionalText(parsed.fields, "id", 128) || "", expectedId);
  return { id, deviceType, firmwareTarget, partitionScheme, hardwareRevisions, version, minVersion, changelog, rolloutPercent };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    if (pa[index] !== pb[index]) return pa[index] > pb[index] ? 1 : -1;
  }
  return 0;
}

function temporaryFileName(tempDir: string): string {
  return path.join(tempDir, `${crypto.randomUUID()}.part`);
}

const firmwareReleaseLocks = new Map<string, Promise<void>>();
const UPLOAD_LOCK_WAIT_MS = 15_000;
const UPLOAD_LOCK_STALE_MS = 60_000;

type FirmwareReleaseFileLock = { fd: number; path: string; token: string };

function firmwareReleaseLockPath(releaseId: string): string {
  // releaseId is a URL path parameter on PATCH. Hash it before using it as a
  // filesystem name; prefixing an untrusted value is not enough because
  // segments such as `foo/../../bar` can still escape the storage directory.
  const lockKey = crypto.createHash("sha256").update(String(releaseId), "utf8").digest("hex");
  return path.join(OtaService.getStorageDir(), `.release-${lockKey}.lock`);
}

async function acquireFirmwareReleaseFileLock(releaseId: string): Promise<FirmwareReleaseFileLock> {
  const lockPath = firmwareReleaseLockPath(releaseId);
  const token = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + UPLOAD_LOCK_WAIT_MS;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeSync(fd, token, undefined, "utf8");
        return { fd, path: lockPath, token };
      } catch (error) {
        try { fs.closeSync(fd); } catch { /* best-effort close */ }
        try { fs.rmSync(lockPath, { force: true }); } catch { /* best-effort cleanup */ }
        throw error;
      }
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > UPLOAD_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError: any) {
        if (statError?.code === "ENOENT") continue;
        throw statError;
      }
      if (Date.now() >= deadline) throw new FirmwareUploadError(503, "Firmware release is busy; retry the upload");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
}

function releaseFirmwareReleaseFileLock(lock: FirmwareReleaseFileLock): void {
  try { fs.closeSync(lock.fd); } catch { /* best-effort close */ }
  try {
    if (fs.readFileSync(lock.path, "utf8") === lock.token) fs.rmSync(lock.path, { force: true });
  } catch { /* best-effort cleanup */ }
}

async function acquireFirmwareReleaseLock(releaseId: string): Promise<() => void> {
  let unlock!: () => void;
  const current = new Promise<void>((resolve) => { unlock = resolve; });
  const previous = firmwareReleaseLocks.get(releaseId) || Promise.resolve();
  firmwareReleaseLocks.set(releaseId, current);
  await previous;
  return () => {
    unlock();
    if (firmwareReleaseLocks.get(releaseId) === current) firmwareReleaseLocks.delete(releaseId);
  };
}

/**
 * Parse and persist multipart parts to a private temporary directory.  Files
 * are hashed while streaming and never use the client filename as a path.
 */
export async function parseFirmwareMultipart(req: Request): Promise<ParsedFirmwareUpload> {
  const contentType = String(req.headers["content-type"] || "");
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new FirmwareUploadError(415, "firmware upload requires multipart/form-data");
  const tempDir = fs.mkdtempSync(path.join(OtaService.getStorageDir(), ".upload-"));
  const fields: Record<string, string[]> = {};
  const files: UploadedFirmwareFile[] = [];
  const seenRoles = new Set<FirmwareImageRole>();
  let totalBytes = 0;
  let parser: ReturnType<typeof busboy> | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let parsingFinished = false;
  let pendingFiles = 0;

  const cleanup = () => {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        try { if (parser) req.unpipe(parser); } catch { /* request may already be closed */ }
        // Unpipe before destroying so a client abort cannot later deliver an
        // implicit EOF to busboy and surface an uncaught "Unexpected end of
        // form" after the route has already returned its bounded error.
        try { parser?.destroy(); } catch { /* parser may already be closed */ }
        reject(error instanceof FirmwareUploadError ? error : new FirmwareUploadError(400, error instanceof Error ? error.message : "Invalid multipart upload"));
      };
      const complete = () => {
        if (!settled && parsingFinished && pendingFiles === 0) {
          settled = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          resolve();
        }
      };
      try {
        parser = busboy({ headers: req.headers, preservePath: false, limits: {
          files: MAX_FIRMWARE_FILES,
          fields: 32,
          parts: MAX_FIRMWARE_FILES + 32,
          fileSize: MAX_FIRMWARE_FILE_BYTES,
          fieldSize: MAX_FIELD_BYTES,
        } });
      } catch (error) {
        fail(new FirmwareUploadError(400, error instanceof Error ? error.message : "Invalid multipart upload"));
        return;
      }
      parser.on("field", (name, value, info) => {
        if (!ALLOWED_FIELDS.has(name)) return fail(new FirmwareUploadError(400, `Unknown firmware field: ${name}`));
        if (info.valueTruncated) return fail(new FirmwareUploadError(413, `${name} is too large`));
        if (fields[name] && !["hardwareRevisions"].includes(name)) return fail(new FirmwareUploadError(400, `Duplicate firmware field: ${name}`));
        (fields[name] ||= []).push(value);
      });
      parser.on("file", (fieldName, file, info: FileInfo) => {
        const role = FILE_FIELD_TO_ROLE[fieldName];
        if (!role) {
          file.on("error", fail);
          file.resume();
          return fail(new FirmwareUploadError(400, `Unknown firmware file field: ${fieldName}`));
        }
        if (seenRoles.has(role)) {
          file.on("error", fail);
          file.resume();
          return fail(new FirmwareUploadError(400, `Duplicate firmware file for ${role}`));
        }
        seenRoles.add(role);
        pendingFiles += 1;
        const tempPath = temporaryFileName(tempDir);
        const output = fs.createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
        const hash = crypto.createHash("sha256");
        let sizeBytes = 0;
        let done = false;
        const finishFile = (error?: unknown) => {
          if (done) return;
          done = true;
          pendingFiles -= 1;
          if (error) {
            try { output.destroy(); } catch { /* best-effort cleanup */ }
            try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort cleanup */ }
            fail(error);
            return;
          }
          if (file.truncated) {
            try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort cleanup */ }
            fail(new FirmwareUploadError(413, `${fieldName} exceeds the firmware upload limit`));
            return;
          }
          files.push({
            fieldName,
            role,
            originalName: safeOriginalName(info.filename, `${role.toLowerCase()}.bin`),
            tempPath,
            sha256: hash.digest("hex"),
            sizeBytes,
          });
          complete();
        };
        file.on("data", (chunk: Buffer) => {
          sizeBytes += chunk.length;
          totalBytes += chunk.length;
          if (totalBytes > MAX_FIRMWARE_TOTAL_BYTES) {
            file.destroy(new FirmwareUploadError(413, "firmware upload exceeds the total size limit"));
            return;
          }
          hash.update(chunk);
        });
        file.on("limit", () => finishFile(new FirmwareUploadError(413, `${fieldName} exceeds the firmware file size limit`)));
        file.on("error", finishFile);
        output.on("error", finishFile);
        output.on("finish", () => finishFile());
        file.pipe(output);
      });
      parser.on("filesLimit", () => fail(new FirmwareUploadError(413, "too many firmware files")));
      parser.on("fieldsLimit", () => fail(new FirmwareUploadError(413, "too many firmware metadata fields")));
      parser.on("partsLimit", () => fail(new FirmwareUploadError(413, "too many multipart parts")));
      parser.on("error", fail);
      parser.on("finish", () => {
        parsingFinished = true;
        complete();
      });
      req.once("aborted", () => fail(new FirmwareUploadError(400, "firmware upload was interrupted")));
      req.once("error", () => fail(new FirmwareUploadError(400, "firmware upload stream failed")));
      if (req.aborted) fail(new FirmwareUploadError(400, "firmware upload was interrupted"));
      timeoutHandle = setTimeout(() => {
        fail(new FirmwareUploadError(408, "firmware upload timed out"));
      }, MAX_FIRMWARE_UPLOAD_DURATION_MS);
      timeoutHandle.unref?.();
      req.pipe(parser);
    });
    return { fields, files, tempDir };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function cleanupFirmwareMultipart(upload: ParsedFirmwareUpload): void {
  try { fs.rmSync(upload.tempDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}

function commitArtifact(file: UploadedFirmwareFile, finalPath: string): boolean {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  const verifyExisting = () => {
    // OtaService verifies through an open descriptor and rejects symlinks;
    // never follow an attacker-controlled path merely because its size/hash
    // happened to match during an earlier stat call.
    if (!OtaService.verifyStoredArtifact(path.basename(finalPath), file.sha256, file.sizeBytes)) {
      throw new FirmwareUploadError(409, `Existing artifact conflicts with ${path.basename(finalPath)}`);
    }
    fs.rmSync(file.tempPath, { force: true });
  };
  try {
    const existing = fs.lstatSync(finalPath);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new FirmwareUploadError(409, `Existing artifact conflicts with ${path.basename(finalPath)}`);
    }
    verifyExisting();
    return false;
  } catch (error: any) {
    if (error instanceof FirmwareUploadError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    // Both paths are inside OTA_STORAGE_DIR.  A hard-link creates the final
    // directory entry without the overwrite race inherent in renameSync;
    // duplicate concurrent uploads then take the existing-artifact branch.
    fs.linkSync(file.tempPath, finalPath);
    fs.rmSync(file.tempPath, { force: true });
    return true;
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    verifyExisting();
    return false;
  }
}

function imageDescriptors(id: string, files: UploadedFirmwareFile[], appFileName?: string): FirmwareImageDescriptor[] {
  const app = fileForRole(files, "APP");
  if (!app) throw new FirmwareUploadError(400, "app firmware file is required");
  const roles: FirmwareImageRole[] = ["BOOTLOADER", "PARTITION_TABLE", "APP", "OTA_DATA"];
  assertFactoryBundleRoles(roles.filter((role) => role !== "APP" && Boolean(fileForRole(files, role))));
  return roles
    .filter((role) => Boolean(fileForRole(files, role)))
    .map((role) => imageFromUpload(id, fileForRole(files, role)!, role, role === "APP" ? appFileName : undefined));
}

function rowImages(row: any): FirmwareImageDescriptor[] {
  const rawImages = Array.isArray(row.images_json) ? row.images_json : [];
  if (rawImages.length) {
    return rawImages.map((raw: any, index: number) => ({
      id: String(raw.id || `${row.id}-image-${index + 1}`),
      name: String(raw.name || raw.fileName || `${row.id}-${index + 1}.bin`),
      fileName: String(raw.fileName || raw.name || `${row.id}-${index + 1}.bin`),
      address: Number(raw.address),
      sizeBytes: Number(raw.sizeBytes),
      sha256: String(raw.sha256 || "").toLowerCase(),
      role: String(raw.role || "APP").toUpperCase() as FirmwareImageRole,
      required: raw.required !== false,
    }));
  }
  return [{
    id: `${row.id}-app`,
    name: String(row.artifact_file_name || `${row.id}.bin`),
    fileName: String(row.artifact_file_name || `${row.id}.bin`),
    address: Number(row.flash_offset ?? APP_OFFSET),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.artifact_sha256 || "").toLowerCase(),
    role: "APP",
    required: true,
  }];
}

function catalogArtifactsMatch(images: FirmwareImageDescriptor[]): boolean {
  for (const image of images) {
    if (!/^[A-Za-z0-9_.-]+$/.test(image.fileName) || image.fileName.includes("..") || !/^[a-f0-9]{64}$/.test(image.sha256) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0) return false;
    if (!OtaService.verifyStoredArtifact(image.fileName, image.sha256, image.sizeBytes)) return false;
  }
  return true;
}

function verifyCatalogArtifacts(row: any): FirmwareImageDescriptor[] {
  const images = rowImages(row);
  if (!catalogArtifactsMatch(images)) {
    for (const image of images) {
      if (!/^[A-Za-z0-9_.-]+$/.test(image.fileName) || image.fileName.includes("..") || !/^[a-f0-9]{64}$/.test(image.sha256) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0) {
        throw new FirmwareUploadError(409, "Firmware catalog contains invalid artifact metadata");
      }
      if (!OtaService.verifyStoredArtifact(image.fileName, image.sha256, image.sizeBytes)) {
        throw new FirmwareUploadError(409, `Firmware artifact ${image.fileName} failed size/hash verification`);
      }
    }
    throw new FirmwareUploadError(409, "Firmware catalog artifact verification failed");
  }
  return images;
}

function catalogFromRow(row: any, otaStatus?: FirmwareReleaseStatus): FirmwareCatalogRelease {
  const images = rowImages(row);
  const factoryReady = isFactoryReady(images) && catalogArtifactsMatch(images);
  const releaseStatus = String(row.status || "DRAFT").toUpperCase() as FirmwareReleaseStatus;
  const flashStatus: FirmwareReleaseStatus = factoryReady
    ? releaseStatus
    : releaseStatus === "REVOKED" ? "REVOKED" : "DRAFT";
  return {
    id: row.id,
    deviceType: row.device_type,
    firmwareTarget: row.firmware_target,
    hardwareRevisions: row.hardware_revisions,
    partitionScheme: row.partition_scheme,
    version: row.version,
    artifactFileName: row.artifact_file_name || images.find((image) => image.role === "APP")?.fileName || `${row.id}.bin`,
    artifactSha256: row.artifact_sha256,
    sizeBytes: row.size_bytes,
    images,
    manifestSha256: row.manifest_sha256,
    manifestSignature: row.manifest_signature,
    manifestKeyId: row.manifest_key_id,
    writePlans: row.write_plans_json && typeof row.write_plans_json === "object" ? row.write_plans_json : {},
    changelog: row.changelog,
    minVersion: row.min_version,
    rolloutPercent: Number(row.rollout_percent ?? 0),
    otaStatus: otaStatus || releaseStatus,
    flashStatus,
    factoryReady,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function catalogFromOtaRelease(ota: FirmwareRelease): FirmwareCatalogRelease {
  const image: FirmwareImageDescriptor = {
    id: `${ota.id}-app`,
    name: ota.fileName,
    fileName: ota.fileName,
    address: APP_OFFSET,
    sizeBytes: ota.sizeBytes,
    sha256: ota.sha256,
    role: "APP",
    required: true,
  };
  const manifest = canonicalManifest({
    id: ota.id,
    deviceType: ota.deviceType,
    firmwareTarget: ota.firmwareTarget,
    hardwareRevisions: [...ota.hardwareRevisions].sort(),
    partitionScheme: ota.partitionScheme,
    version: ota.version,
    artifactSha256: ota.sha256,
    sizeBytes: ota.sizeBytes,
    flashOffset: APP_OFFSET,
    images: [image],
  });
  const now = new Date(ota.releaseDate).toISOString();
  return {
    id: ota.id,
    deviceType: ota.deviceType,
    firmwareTarget: ota.firmwareTarget,
    hardwareRevisions: ota.hardwareRevisions,
    partitionScheme: ota.partitionScheme,
    version: ota.version,
    artifactFileName: ota.fileName,
    artifactSha256: ota.sha256,
    sizeBytes: ota.sizeBytes,
    images: [image],
    manifestSha256: manifestDigest(manifest),
    manifestSignature: signManifest(manifest),
    manifestKeyId: process.env.FIRMWARE_MANIFEST_KEY_ID || "farmos-manifest-hmac-v1",
    writePlans: {},
    changelog: ota.changelog,
    minVersion: ota.minVersion || null,
    rolloutPercent: ota.rolloutPercent ?? 0,
    otaStatus: ota.status,
    flashStatus: "DRAFT",
    factoryReady: false,
    createdAt: now,
    updatedAt: now,
  };
}

export class FirmwareUploadService {
  static async ingest(upload: ParsedFirmwareUpload, actorId: string): Promise<FirmwareUploadResult> {
    const app = fileForRole(upload.files, "APP");
    if (!app) throw new FirmwareUploadError(400, "app firmware file is required");
    const appBuffer = fs.readFileSync(app.tempPath);
    const descriptor = inspectEspApplicationImage(appBuffer);
    if (!descriptor) throw new FirmwareUploadError(400, "app firmware is not a valid ESP application image");
    if (descriptor.version.endsWith("-secure")) {
      throw new FirmwareUploadError(400, "New releases use ordinary x.y.z firmware; secured releases are historical only");
    }
    const bootloader = fileForRole(upload.files, "BOOTLOADER");
    const bootloaderBytes = bootloader ? fs.readFileSync(bootloader.tempPath) : Buffer.alloc(0);
    if (!firmwareMatchesBoardSecurity(appBuffer, bootloaderBytes, false)) {
      throw new FirmwareUploadError(400, "Firmware requires hardware Secure Boot/Flash Encryption; use the ordinary USB release build");
    }
    const data = parseUploadFields(upload, descriptor);
    if (descriptor.projectName !== expectedProjectName(data.deviceType)) throw new FirmwareUploadError(409, `Firmware binary belongs to ${descriptor.projectName}, not ${data.deviceType}`);

    const unlockRelease = await acquireFirmwareReleaseLock(data.id);
    let fileLock: FirmwareReleaseFileLock | undefined;
    try {
    fileLock = await acquireFirmwareReleaseFileLock(data.id);
    const existingById = await prisma.firmwareRelease.findUnique({ where: { id: data.id } });
    const existingByKey = await prisma.firmwareRelease.findFirst({ where: { firmware_target: data.firmwareTarget, version: data.version } });
    if (existingByKey && existingByKey.id !== data.id) throw new FirmwareUploadError(409, `Firmware target ${data.firmwareTarget} v${data.version} already has release ${existingByKey.id}`);
    if (existingById && existingById.status !== "DRAFT") {
      throw new FirmwareUploadError(409, "This release is already published; update rollout/status with PATCH instead of uploading it again");
    }

    // A legacy OTA manifest may already own the target/version with a
    // historical filename.  Reuse that exact filename in images_json so the
    // signed relational catalog never points at an artifact that was not
    // written to OTA_STORAGE_DIR.
    const otaBefore = await OtaService.getReleaseById(data.id);
    if (otaBefore && otaBefore.status !== "DRAFT") {
      throw new FirmwareUploadError(409, "This OTA release is already published; update rollout/status with PATCH instead of uploading it again");
    }
    const appFileName = otaBefore?.fileName || `${data.id}-app.bin`;
    const images = imageDescriptors(data.id, upload.files, appFileName);
    if (fileForRole(upload.files, "BOOTLOADER")) validateFactoryBinary("BOOTLOADER", fileForRole(upload.files, "BOOTLOADER")!);
    if (fileForRole(upload.files, "PARTITION_TABLE")) validateFactoryBinary("PARTITION_TABLE", fileForRole(upload.files, "PARTITION_TABLE")!);
    if (fileForRole(upload.files, "OTA_DATA")) validateFactoryBinary("OTA_DATA", fileForRole(upload.files, "OTA_DATA")!);
    validateFactoryBinary("APP", app);
    const factoryReady = isFactoryReady(images);
    const writePlans = createWritePlans(images);
    const manifest = canonicalManifest({
      id: data.id,
      deviceType: data.deviceType,
      firmwareTarget: data.firmwareTarget,
      hardwareRevisions: [...data.hardwareRevisions].sort(),
      partitionScheme: data.partitionScheme,
      version: data.version,
      artifactSha256: app.sha256,
      sizeBytes: app.sizeBytes,
      flashOffset: APP_OFFSET,
      images,
      writePlans,
    });
    const manifestSha256 = manifestDigest(manifest);
    const manifestSignature = signManifest(manifest);
    if (existingById && (
      existingById.device_type !== data.deviceType ||
      existingById.firmware_target !== data.firmwareTarget ||
      existingById.partition_scheme !== data.partitionScheme ||
      existingById.version !== data.version ||
      JSON.stringify([...existingById.hardware_revisions].sort()) !== JSON.stringify([...data.hardwareRevisions].sort()) ||
      (existingById.min_version || null) !== (data.minVersion || null) ||
      existingById.artifact_file_name !== appFileName ||
      existingById.flash_offset !== APP_OFFSET ||
      existingById.artifact_sha256 !== app.sha256 ||
      existingById.size_bytes !== app.sizeBytes ||
      existingById.manifest_sha256 !== manifestSha256 ||
      JSON.stringify(existingById.images_json) !== JSON.stringify(images)
    )) {
      throw new FirmwareUploadError(409, "Existing firmware release is immutable; use a new version for different bytes or image layout");
    }
    if (otaBefore && (
      otaBefore.deviceType !== data.deviceType ||
      otaBefore.firmwareTarget !== data.firmwareTarget ||
      otaBefore.partitionScheme !== data.partitionScheme ||
      otaBefore.version !== data.version ||
      JSON.stringify([...otaBefore.hardwareRevisions].sort()) !== JSON.stringify([...data.hardwareRevisions].sort()) ||
      (otaBefore.minVersion || null) !== (data.minVersion || null) ||
      otaBefore.sha256 !== app.sha256 ||
      otaBefore.sizeBytes !== app.sizeBytes ||
      otaBefore.fileName !== appFileName
    )) {
      throw new FirmwareUploadError(409, "Existing OTA release is immutable; use a new version for different bytes or image layout");
    }

    const storage = OtaService.getStorageDir();
    let ota: FirmwareRelease;
    const createdFiles: string[] = [];
    // A retry of an existing draft may omit changelog. Keep the effective
    // value identical in both the file-backed OTA manifest and Prisma; using
    // the fresh default here would silently drift the two catalogs.
    const effectiveChangelog = effectiveFirmwareChangelog(data.changelog, existingById?.changelog, otaBefore?.changelog, `Firmware ${data.deviceType} v${data.version}`);
    try {
      ota = await OtaService.registerRelease({
        deviceType: data.deviceType,
        version: data.version,
        changelog: effectiveChangelog,
        // Keep the app artifact name identical to the signed catalog image.
        // FlashJob manifests download by image.fileName, so allowing the
        // legacy device/version default here would create a catalog pointing
        // at a file that was never written to OTA_STORAGE_DIR.
        fileName: appFileName,
        minVersion: data.minVersion || undefined,
        rolloutPercent: existingById?.rollout_percent ?? otaBefore?.rolloutPercent ?? data.rolloutPercent,
        firmwareTarget: data.firmwareTarget,
        hardwareRevisions: data.hardwareRevisions,
        partitionScheme: data.partitionScheme,
        // Multipart ingest is never an activation operation.  Published
        // releases are rejected above; a draft re-upload remains a draft.
        status: "DRAFT",
      }, appBuffer);
      if (ota.id !== data.id || ota.fileName !== appFileName || ota.status !== "DRAFT") {
        throw new FirmwareUploadError(409, "Stored OTA artifact does not match the server-derived release mapping");
      }
      if (!OtaService.verifyStoredArtifact(ota.fileName, app.sha256, app.sizeBytes)) {
        throw new FirmwareUploadError(409, "Stored application artifact failed size/hash verification");
      }
      for (const image of images) {
        if (image.role === "APP") continue;
        const source = fileForRole(upload.files, image.role)!;
        const finalPath = path.join(storage, image.fileName);
        if (commitArtifact(source, finalPath)) createdFiles.push(finalPath);
      }
      const row = await prisma.firmwareRelease.upsert({
        where: { id: data.id },
        update: {
          changelog: effectiveChangelog,
          rollout_percent: existingById?.rollout_percent ?? data.rolloutPercent,
        },
        create: {
          id: data.id,
          device_type: data.deviceType,
          firmware_target: data.firmwareTarget,
          hardware_revisions: data.hardwareRevisions,
          partition_scheme: data.partitionScheme,
          version: data.version,
          artifact_file_name: appFileName,
          artifact_url: null,
          flash_offset: APP_OFFSET,
          artifact_sha256: app.sha256,
          manifest_sha256: manifestSha256,
          manifest_signature: manifestSignature,
          manifest_key_id: process.env.FIRMWARE_MANIFEST_KEY_ID || "farmos-manifest-hmac-v1",
          size_bytes: app.sizeBytes,
          images_json: images as unknown as Prisma.InputJsonValue,
          write_plans_json: writePlans as unknown as Prisma.InputJsonValue,
          status: "DRAFT",
          min_version: data.minVersion,
          rollout_percent: data.rolloutPercent,
          changelog: effectiveChangelog,
          created_by_id: actorId,
        },
      });
      return { release: catalogFromRow(row, ota.status), ota, factoryReady };
    } catch (error) {
      for (const finalPath of createdFiles) {
        try { fs.rmSync(finalPath, { force: true }); } catch { /* best-effort cleanup */ }
      }
      // Never remove an artifact another request may have published while
      // this transaction was unwinding.  The DB existence check is a second
      // guard in addition to the immutable/hash check above.
      if (!otaBefore && !existingById) {
        const persisted = await prisma.firmwareRelease.findUnique({ where: { id: data.id }, select: { id: true } }).catch(() => null);
        if (!persisted) OtaService.removeReleaseIfDraft(data.id, app.sha256);
      }
      throw error;
    }
    } finally {
      if (fileLock) releaseFirmwareReleaseFileLock(fileLock);
      unlockRelease();
    }
  }

  static async list(): Promise<FirmwareCatalogRelease[]> {
    const rows = await prisma.firmwareRelease.findMany({ orderBy: [{ created_at: "desc" }] });
    const releases = new Map<string, FirmwareCatalogRelease>();
    for (const row of rows) {
      const ota = await OtaService.getReleaseById(row.id);
      releases.set(row.id, catalogFromRow(row, ota?.status));
    }
    for (const ota of await OtaService.listReleases()) {
      if (!releases.has(ota.id)) releases.set(ota.id, catalogFromOtaRelease(ota));
    }
    return [...releases.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * Permanently delete a release, its artifacts, and its related Web Serial
   * flash history. This is an explicit admin cleanup operation: FlashJobEvent
   * rows cascade from FlashJob, while unrelated board audit records remain.
   */
  static async delete(releaseId: string): Promise<void> {
    const unlockRelease = await acquireFirmwareReleaseLock(releaseId);
    let fileLock: FirmwareReleaseFileLock | undefined;
    try {
      fileLock = await acquireFirmwareReleaseFileLock(releaseId);
      const row = await prisma.firmwareRelease.findUnique({ where: { id: releaseId } });
      // App-only releases created before the relational catalog existed still
      // appear in the admin list. They have no factory artifacts or flash-job
      // history, so delete their manifest/app pair directly as well.
      if (!row) {
        if (!OtaService.deleteRelease(releaseId)) throw new FirmwareUploadError(404, "Firmware release not found");
        return;
      }
      const images = rowImages(row);
      const extraArtifactNames = images
        .filter((image) => image.role !== "APP")
        .map((image) => path.basename(image.fileName))
        .filter((fileName) => /^[A-Za-z0-9_.-]+$/.test(fileName) && !fileName.includes(".."));

      // The release lock prevents a concurrent upload/update in this process.
      // Delete dependent jobs and the catalog row atomically so the Restrict
      // foreign key never leaves a partially removed release.
      await prisma.$transaction(async (tx) => {
        await deleteFirmwareReleaseRecords(tx, releaseId);
      });
      OtaService.deleteRelease(releaseId);
      for (const fileName of extraArtifactNames) {
        fs.rmSync(path.join(OtaService.getStorageDir(), fileName), { force: true });
      }
    } finally {
      if (fileLock) releaseFirmwareReleaseFileLock(fileLock);
      unlockRelease();
    }
  }

  /**
   * OTA distribution and factory flashing are intentionally independent
   * release channels.  The OTA manifest controls what connected devices may
   * download; the relational catalog status controls what Web Serial may
   * flash onto a board on the production line.  Never mirror a status change
   * from one channel into the other.
   */
  static async update(releaseId: string, patch: { channel: FirmwareReleaseChannel; status?: FirmwareReleaseStatus; rolloutPercent?: number; changelog?: string }): Promise<FirmwareCatalogRelease> {
    const unlockRelease = await acquireFirmwareReleaseLock(releaseId);
    let fileLock: FirmwareReleaseFileLock | undefined;
    try {
    fileLock = await acquireFirmwareReleaseFileLock(releaseId);
    const row = await prisma.firmwareRelease.findUnique({ where: { id: releaseId } });
    if (!row) throw new FirmwareUploadError(404, "Firmware release not found");
    const ota = await OtaService.getReleaseById(releaseId);
    if (!ota) throw new FirmwareUploadError(409, "Firmware release artifact is unavailable");
    const channel = patch.channel;
    if (channel !== "OTA" && channel !== "FACTORY") throw new FirmwareUploadError(400, "channel must be OTA or FACTORY");
    const images = verifyCatalogArtifacts(row);
    const factoryReady = isFactoryReady(images);
    if (channel === "OTA" && factoryReady) {
      throw new FirmwareUploadError(409, "Factory packages are released only through the factory channel; upload an app-only artifact for OTA");
    }
    if (channel === "FACTORY" && !factoryReady) {
      throw new FirmwareUploadError(409, "This release is OTA-only and cannot be used for factory flashing");
    }
    const status = patch.status || (channel === "OTA" ? ota.status : String(row.status).toUpperCase() as FirmwareReleaseStatus);
    if (!["DRAFT", "ACTIVE", "PAUSED", "REVOKED"].includes(status)) throw new FirmwareUploadError(400, "Invalid firmware release status");
    const rolloutPercent = patch.rolloutPercent === undefined ? row.rollout_percent : patch.rolloutPercent;
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) throw new FirmwareUploadError(400, "rolloutPercent must be an integer from 0 to 100");
    if (channel === "OTA") {
      const nextOta = OtaService.updateReleaseStatus(releaseId, { status, rolloutPercent, changelog: patch.changelog });
      // Changelog is deliberately shared metadata, but the factory state is
      // not touched by an OTA action.
      const updated = patch.changelog === undefined
        ? row
        : await prisma.firmwareRelease.update({ where: { id: releaseId }, data: { changelog: patch.changelog.slice(0, 2_000) } });
      return catalogFromRow(updated, nextOta.status);
    }

    const updated = await prisma.firmwareRelease.update({
      where: { id: releaseId },
      data: {
        status,
        ...(patch.changelog !== undefined ? { changelog: patch.changelog.slice(0, 2_000) } : {}),
      },
    });
    // Preserve OTA status and rollout exactly as they were before the
    // factory operator changed this package's manufacturing availability.
    return catalogFromRow(updated, ota.status);
    } finally {
      if (fileLock) releaseFirmwareReleaseFileLock(fileLock);
      unlockRelease();
    }
  }
}
