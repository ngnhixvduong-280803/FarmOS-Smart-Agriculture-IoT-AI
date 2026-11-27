import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DeviceGenerationState, DeviceIdentityState, DeviceQrLabelState, FlashJobMode, FlashJobState, FlashTargetType, FirmwareReleaseState, HardwareBoardState, Prisma } from "@prisma/client";
import { rateLimit } from "express-rate-limit";
import { Request, Response, Router } from "express";
import { prisma } from "../../database/prisma";
import { AuthRequest, authenticate, requireRole } from "../middleware/auth.middleware";
import { OtaService, compareSemver, defaultFirmwareTarget } from "../../ota/ota.service";
import { createOtaDownloadTicket, createOpaqueToken, hashDeviceSecret, verifyOtaDownloadTicket } from "../../security/device-secrets";
import { invalidateDeviceAccess } from "../../security/device-access";
import { isAttestationAlgorithmAllowed, publicKeyFingerprint } from "../../manufacturing/qr";
import { env } from "../../config/env";
import { loadFlashLayout, type FlashLayout } from "../../config/flash-layout";
import { canRefreshSerialEnrollmentTicket, completedIdentityMaterial, flashPreflightDecision, shouldUpdateNormalReflashNode } from "../../identity/flash-flow";
import { firmwareMatchesBoardSecurity, usbFlashEncryptionEnabled } from "../../identity/firmware-security";
import {
  assertBoardTransition,
  assertFlashTransition,
  auditBoard,
  canonicalEnrollmentTicketPayload,
  challengeHash,
  currentBoardIdentity,
  deterministicFlashSecret,
  flashAttestationMessage,
  flashModeRequiresReset,
  generationDeviceId,
  generationSerial,
  hardwareProofForEnrollment,
  hardwareBoardKey,
  publicBoardReference,
  qrForIdentity,
  recordFlashEvent,
  resolveHardwareBoard,
  signEnrollmentTicket,
  ticketHash,
  validateEnrollmentPublicKey,
  verifyFlashAttestation,
} from "../../identity/board-identity";

const router = Router();
// FarmOS ESP32-S3 partition layout: bootloader, partition table, ota_data,
// then OTA_0 application. factory_cfg and nvs_keys live above 0x620000 and
// are never valid Web Serial targets.
const DEFAULT_FLASH_OFFSET = 0x20000;

const FARMOS_FLASH_LAYOUT: FlashLayout = loadFlashLayout();

function selectedPlanForJob(job: any, release: any): { name: string; imageIds: string[]; steps: Array<Record<string, unknown>> } {
  const plans = release.write_plans_json && typeof release.write_plans_json === "object" ? release.write_plans_json as Record<string, Array<Record<string, unknown>>> : {};
  // A first enrollment is represented by the default NORMAL_REFLASH job mode
  // for API compatibility, but it has no source generation and therefore
  // must receive the approved full layout. Existing identities alone use the
  // APP -> OTA_DATA reflash plan; RESET_REPROVISION always uses full layout.
  const name = job.mode === FlashJobMode.NORMAL_REFLASH && job.source_device_id
    ? "NORMAL_REFLASH"
    : "FACTORY_FULL_FLASH";
  const steps = Array.isArray(plans[name]) ? plans[name] : [];
  if (!steps.length) throw new FlashRequestError(409, `FirmwareRelease has no ${name} write plan`);
  return { name, imageIds: steps.map((step) => String(step.imageId)), steps };
}
router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));
router.use(authenticate);

class FlashRequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export type FlashProgressDecision = { ignore: boolean; progress: number };
export type ActiveFlashJobDecision = "resume" | "expire" | "conflict";

/**
 * A page reload creates a new HTTP idempotency key even though the physical
 * board may still have an unfinished job. Reuse that job only when it is still
 * live and represents the same requested operation. Expired jobs are closed
 * under the board lock so they cannot permanently prevent a new session.
 */
export function activeFlashJobDecision(
  active: { mode: FlashJobMode; target_type: FlashTargetType; expires_at: Date },
  requested: { mode: FlashJobMode; targetType: FlashTargetType; now?: Date },
): ActiveFlashJobDecision {
  if (active.expires_at <= (requested.now || new Date())) return "expire";
  if (active.mode !== requested.mode || active.target_type !== requested.targetType) return "conflict";
  return "resume";
}

/**
 * Progress reports can arrive out of order because the browser deliberately
 * does not await every upload callback. Keep this state-machine rule pure so
 * it can be regression-tested without a database: post-readback/terminal
 * reports are harmlessly ignored, while active progress is monotonic.
 */
export function nextFlashProgress(
  currentStatus: FlashJobState,
  currentProgress: number,
  requestedProgress: number,
): FlashProgressDecision {
  if (currentStatus === FlashJobState.READBACK_VERIFIED || flashStateIs(currentStatus, FlashJobState.COMPLETED, FlashJobState.FAILED, FlashJobState.CANCELLED)) {
    return { ignore: true, progress: currentProgress };
  }
  if (!flashStateIs(currentStatus, FlashJobState.ENROLLMENT_ISSUED, FlashJobState.FLASHING)) {
    throw new FlashRequestError(409, `Progress is not valid from ${currentStatus}`);
  }
  return { ignore: false, progress: Math.max(currentProgress, requestedProgress) };
}

type ActorRequest = AuthRequest;

function text(value: unknown, field: string, max = 256): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new FlashRequestError(400, `${field} is required and must be at most ${max} characters`);
  return result;
}

function optionalText(value: unknown, max = 256): string | null {
  if (value === undefined || value === null || value === "") return null;
  const result = String(value).trim();
  if (result.length > max) throw new FlashRequestError(400, `Value must be at most ${max} characters`);
  return result || null;
}

function idempotencyKey(req: Request): string {
  const value = String(req.header("Idempotency-Key") || (req.body as any)?.idempotencyKey || "").trim();
  if (!value || value.length > 128) throw new FlashRequestError(400, "Idempotency-Key is required (1-128 characters)");
  return value;
}

function actor(req: ActorRequest): { type: string; id: string } {
  return { type: "USER", id: req.user?.id || "unknown" };
}

function isAdmin(req: ActorRequest): boolean {
  return req.user?.role === "ADMIN";
}

function errorResponse(error: unknown): { status: number; message: string } {
  if (error instanceof FlashRequestError) return { status: error.status, message: error.message };
  if ((error as any)?.code === "P2002") return { status: 409, message: "Flash record already exists; retry with the same idempotency key" };
  if ((error as any)?.code === "P2025") return { status: 404, message: "Flash record not found" };
  if (error instanceof Error && /chipFamily|factoryEfuseMac|chipIdentity|hardwareRevision|enrollment public key/.test(error.message)) return { status: 400, message: error.message };
  // Do not expose Prisma/filesystem/crypto errors to a browser.  In addition
  // to leaking implementation details, those messages can contain paths or
  // SQL fragments that make later attacks easier to tune.
  return { status: 500, message: "Flash operation failed" };
}

function safeQrLabel(label: any): any {
  if (!label) return null;
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(label.canonical_payload);
  } catch {
    payload = {};
  }
  if (label.signature) payload.sig = label.signature;
  return {
    qrId: label.qr_id,
    version: label.version,
    state: label.state,
    payload,
  };
}

function safeIdentity(identity: any, qrLabel?: any): any {
  if (!identity) return null;
  const qr = safeQrLabel(qrLabel || identity.qr_label);
  return {
    deviceId: identity.device_id,
    serial: identity.serial_number,
    type: identity.type,
    model: identity.model,
    hardwareRevision: identity.hardware_revision,
    firmwareTarget: identity.firmware_target,
    partitionScheme: identity.partition_scheme,
    capabilities: identity.capabilities,
    state: identity.state,
    generation: identity.generation,
    generationState: identity.generation_state,
    current: identity.is_current,
    claimedById: identity.claimed_by_id,
    claimedFarmId: identity.claimed_farm_id,
    identityVersion: identity.identity_version,
    publicKeyAlgorithm: identity.public_key_algorithm,
    publicKeyFingerprint: identity.public_key_fingerprint,
    identityKeyVersion: identity.identity_key_version,
    qrId: qr?.qrId || null,
    qrPayload: qr?.payload || null,
    createdAt: identity.created_at,
    updatedAt: identity.updated_at,
  };
}

function safeRelease(release: any): any {
  if (!release) return null;
  const images = releaseImages(release);
  return {
    id: release.id,
    deviceType: release.device_type,
    firmwareTarget: release.firmware_target,
    hardwareRevisions: release.hardware_revisions,
    partitionScheme: release.partition_scheme,
    version: release.version,
    artifactFileName: release.artifact_file_name,
    // The browser must only receive the ticketed, same-origin download URLs
    // emitted by the manifest endpoint.  Legacy artifact_url values may be
    // external and would otherwise bypass the artifact ticket boundary.
    artifactUrl: null,
    flashOffset: release.flash_offset ?? DEFAULT_FLASH_OFFSET,
    artifactSha256: release.artifact_sha256,
    manifestSha256: release.manifest_sha256,
    manifestSignature: release.manifest_signature,
    manifestKeyId: release.manifest_key_id,
    sizeBytes: release.size_bytes,
    images: images.map((image) => ({
      id: image.id,
      name: image.name,
      address: image.address,
      sizeBytes: image.sizeBytes,
      sha256: image.sha256,
      role: image.role,
      required: image.required,
    })),
    layoutId: FARMOS_FLASH_LAYOUT.layoutId,
    writePlans: release.write_plans_json || [],
    status: release.status,
    minVersion: release.min_version,
    changelog: release.changelog,
  };
}

type ReleaseImage = {
  id: string;
  name: string;
  fileName: string;
  address: number;
  sizeBytes: number;
  sha256: string;
  role: "BOOTLOADER" | "PARTITION_TABLE" | "OTA_DATA" | "APP" | "MERGED_IMAGE";
  required: boolean;
  artifactUrl?: string | null;
};

const FIXED_IMAGE_OFFSETS: Record<ReleaseImage["role"], number[]> = {
  BOOTLOADER: [0x0],
  PARTITION_TABLE: [0x10000],
  OTA_DATA: [0x19000],
  APP: [0x20000],
  MERGED_IMAGE: [0x0],
};

function releaseImages(release: any): ReleaseImage[] {
  const raw = Array.isArray(release?.images_json) ? release.images_json : [];
  if (raw.length) return raw.map((value: any, index: number) => ({
    id: String(value.id || `${release.id}-image-${index + 1}`),
    name: String(value.name || value.fileName || `${release.id}-${index + 1}.bin`),
    fileName: String(value.fileName || value.name || release.artifact_file_name || `${release.id}-${index + 1}.bin`),
    address: Number(value.address),
    sizeBytes: Number(value.sizeBytes),
    sha256: String(value.sha256 || "").toLowerCase(),
    role: String(value.role || "APP").toUpperCase() as ReleaseImage["role"],
    required: value.required !== false,
    artifactUrl: value.artifactUrl ? String(value.artifactUrl) : null,
  }));
  return [{
    id: `${release.id}-app`,
    name: release.artifact_file_name || `${release.id}.bin`,
    fileName: release.artifact_file_name || `${release.id}.bin`,
    address: release.flash_offset ?? DEFAULT_FLASH_OFFSET,
    sizeBytes: Number(release.size_bytes),
    sha256: String(release.artifact_sha256 || "").toLowerCase(),
    role: "APP",
    required: true,
    artifactUrl: release.artifact_url || null,
  }];
}

function assertReleaseImageLayout(images: ReleaseImage[], active: boolean): void {
  const ids = new Set<string>();
  const addresses = new Set<number>();
  for (const image of images) {
    if (ids.has(image.id) || addresses.has(image.address)) throw new FlashRequestError(409, "FirmwareRelease images must have unique ids and partition offsets");
    if (!Object.prototype.hasOwnProperty.call(FIXED_IMAGE_OFFSETS, image.role) ||
        !FIXED_IMAGE_OFFSETS[image.role].includes(image.address) ||
        !image.required || !/^[A-Za-z0-9_.-]+$/.test(image.fileName) || image.fileName.includes("..")) {
      throw new FlashRequestError(409, "FirmwareRelease contains a non-canonical image descriptor");
    }
    ids.add(image.id); addresses.add(image.address);
  }
  const merged = images.filter((image) => image.role === "MERGED_IMAGE");
  const canonicalRoles = ["BOOTLOADER", "PARTITION_TABLE", "OTA_DATA", "APP"] as const;
  const roleCounts = new Map<string, number>();
  for (const image of images) roleCounts.set(image.role, (roleCounts.get(image.role) || 0) + 1);
  const mergedReady = merged.length === 1 && images.length === 1 && merged[0].address === 0;
  const fullReady = images.length === canonicalRoles.length && canonicalRoles.every((role) => roleCounts.get(role) === 1);
  const complete = mergedReady || fullReady;
  if (active && !complete) throw new FlashRequestError(409, "ACTIVE FirmwareRelease must register a merged image or bootloader/partition/ota_data/app image set");
  if (merged.length > 0 && !mergedReady) throw new FlashRequestError(409, "MERGED_IMAGE must be the only image at address 0");
  if (fullReady && images.some((image) => image.role === "MERGED_IMAGE")) throw new FlashRequestError(409, "MERGED_IMAGE cannot be combined with canonical factory images");
}

function readbackImage(release: any): ReleaseImage {
  const images = releaseImages(release);
  return images.find((image) => image.role === "APP") || images.find((image) => image.role === "MERGED_IMAGE") || images[images.length - 1];
}

function safeBoard(board: any, current?: any): any {
  return {
    id: board.id,
    boardRef: publicBoardReference(board.id),
    chipFamily: board.chip_family,
    hardwareRevision: board.hardware_revision,
    identitySource: board.identity_source,
    state: board.state,
    blockReason: board.block_reason,
    blockedAt: board.blocked_at,
    lastSeenAt: board.last_seen_at,
    currentIdentity: safeIdentity(current),
    createdAt: board.created_at,
    updatedAt: board.updated_at,
  };
}

function normalizeTarget(value: unknown): FlashTargetType {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "GATEWAY") return FlashTargetType.GATEWAY;
  if (normalized === "NODE" || normalized === "SENSOR_NODE" || normalized === "LEAF_NODE" || normalized === "STANDALONE_NODE") return FlashTargetType.NODE;
  throw new FlashRequestError(400, "targetType must be NODE or GATEWAY");
}

function normalizeMode(value: unknown): FlashJobMode {
  const normalized = String(value || "NORMAL_REFLASH").trim().toUpperCase();
  if (normalized === "NORMAL_REFLASH" || normalized === "REFLASH" || normalized === "NORMAL") return FlashJobMode.NORMAL_REFLASH;
  if (normalized === "RESET_REPROVISION" || normalized === "RESET" || normalized === "REPROVISION") return FlashJobMode.RESET_REPROVISION;
  throw new FlashRequestError(400, "mode must be NORMAL_REFLASH or RESET_REPROVISION");
}

function materialFromBody(body: any): { chipFamily: string; factoryEfuseMac?: string; chipIdentity?: string; hardwareRevision?: string } | null {
  const source = body?.board && typeof body.board === "object" && !Array.isArray(body.board)
    ? { ...body, ...body.board, ...(body.hello && typeof body.hello === "object" ? body.hello : {}) }
    : body?.hello && typeof body.hello === "object" && !Array.isArray(body.hello)
      ? { ...body, ...body.hello }
      : body;
  if (!source || (source.chipFamily === undefined && source.factoryEfuseMac === undefined && source.chipIdentity === undefined)) return null;
  return {
    chipFamily: text(source.chipFamily, "chipFamily", 64),
    factoryEfuseMac: optionalText(source.factoryEfuseMac ?? source.factoryEfuseMAC ?? source.efuseMac, 32) || undefined,
    chipIdentity: optionalText(source.chipIdentity ?? source.chipId, 256) || undefined,
    hardwareRevision: optionalText(source.hardwareRevision, 64) || undefined,
  };
}

async function boardFromRequest(tx: Prisma.TransactionClient, req: ActorRequest, body: any, allowBlocked = false) {
  const material = materialFromBody(body);
  const source = body?.board && typeof body.board === "object" && !Array.isArray(body.board) ? { ...body, ...body.board } : body;
  let board = material
    ? await resolveHardwareBoard(tx, material)
    : await tx.hardwareBoard.findUnique({ where: { id: optionalText(source?.boardId ?? source?.hardwareBoardId, 128) || "" } });
  if (!board) throw new FlashRequestError(404, "HardwareBoard could not be resolved");
  if (!allowBlocked && board.state === HardwareBoardState.BLOCKED) throw new FlashRequestError(409, "HardwareBoard is blocked");
  if (board.state === HardwareBoardState.UNBOUND && !isAdmin(req)) throw new FlashRequestError(409, "HardwareBoard requires admin recovery before use");
  return board;
}

// Read-only preflight for a board physically probed by the desktop station.
// Resolve its HMAC key without creating or changing a HardwareBoard row.
router.post("/boards/inspect", requireRole(["ADMIN"]), async (req: ActorRequest, res: Response) => {
  try {
    const material = materialFromBody(req.body);
    if (!material) throw new FlashRequestError(400, "chipFamily and factoryEfuseMac are required");
    const targetType = normalizeTarget(req.body?.targetType);
    const board = await prisma.hardwareBoard.findUnique({ where: { board_key: hardwareBoardKey(material) } });
    const identity = board ? await currentBoardIdentity(prisma as unknown as Prisma.TransactionClient, board.id) : null;
    const targetDeviceType = targetType === FlashTargetType.GATEWAY ? "GATEWAY" : "SENSOR_NODE";
    const identityMatchesTarget = !identity || ((targetType === FlashTargetType.GATEWAY) === (identity.type === "GATEWAY"));
    const firmwareTarget = identityMatchesTarget ? identity?.firmware_target || defaultFirmwareTarget(targetDeviceType) : defaultFirmwareTarget(targetDeviceType);
    let release: any = null;
    let releaseError: string | null = null;
    try {
      release = await resolveRelease(prisma as unknown as Prisma.TransactionClient, { flashEncryptionEnabled: req.body?.flashEncryptionEnabled, releaseId: req.body?.releaseId }, targetType,
        identity?.hardware_revision || board?.hardware_revision, firmwareTarget);
    } catch (error) {
      if (!(error instanceof FlashRequestError) || ![404, 409].includes(error.status)) throw error;
      releaseError = error.message;
    }
    const decision = flashPreflightDecision({
      targetType: targetType === FlashTargetType.GATEWAY ? "GATEWAY" : "NODE",
      currentDeviceType: identity?.type,
      currentIdentityState: identity?.state,
      currentGenerationState: identity?.generation_state,
      boardState: board?.state,
      hasRelease: Boolean(release),
      requireNewDevice: req.body?.requireNewDevice === true,
    });
    return res.json({ success: true, data: {
      board: board ? safeBoard(board, identity) : null,
      currentDeviceId: identity?.device_id || null,
      currentDeviceType: identity?.type || null,
      targetDeviceType,
      typeMismatch: decision.typeMismatch,
      reason: decision.reason,
      releaseError,
      release: release ? { id: release.id, version: release.version, firmwareTarget: release.firmware_target } : null,
      ready: decision.ready,
    } });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

async function userMayAccessBoard(req: ActorRequest, boardId: string, identity?: any): Promise<boolean> {
  if (isAdmin(req)) return true;
  if (identity?.claimed_by_id === req.user?.id) return true;
  if (identity?.device_id) {
    const node = await prisma.node.findUnique({ where: { id: identity.device_id }, select: { owner_id: true, farm_id: true } });
    if (node?.owner_id === req.user?.id) return true;
    if (node?.farm_id && req.user?.id) {
      return Boolean(await prisma.userFarm.findUnique({ where: { user_id_farm_id: { user_id: req.user.id, farm_id: node.farm_id } }, select: { user_id: true } }));
    }
    // An existing but unclaimed generation is still controlled inventory; it
    // may only be flashed by an administrator until ownership is established.
    return false;
  }
  // A first enrollment has no DeviceIdentity yet. The authenticated Web Serial
  // operator is allowed to create the pending job; ownership is finalized only
  // after board attestation and an explicit claim/farm action.
  return Boolean(boardId && req.user);
}

function releaseManifestData(release: any, downloadUrl: string | ((image: ReleaseImage) => string), expiresAt?: Date, selectedPlan?: { name: string; imageIds: string[]; steps: Array<Record<string, unknown>> }) {
  const flashOffset = release.flash_offset ?? DEFAULT_FLASH_OFFSET;
  const fileName = release.artifact_file_name || `${release.id}.bin`;
  const images = releaseImages(release);
  return {
    id: release.id,
    deviceType: release.device_type,
    firmwareTarget: release.firmware_target,
    hardwareRevisions: [...release.hardware_revisions].sort(),
    partitionScheme: release.partition_scheme,
    version: release.version,
    artifactSha256: release.artifact_sha256,
    sizeBytes: release.size_bytes,
    flashOffset,
    images: images.map((image) => ({
      id: image.id,
      name: image.name,
      address: image.address,
      sizeBytes: image.sizeBytes,
      sha256: image.sha256,
      role: image.role,
      required: image.required,
      downloadUrl: typeof downloadUrl === "function" ? downloadUrl(image) : downloadUrl,
      signature: release.manifest_signature,
    })),
    signature: release.manifest_signature,
    keyId: release.manifest_key_id,
    manifestSha256: release.manifest_sha256,
    layoutId: FARMOS_FLASH_LAYOUT.layoutId,
    writePlans: release.write_plans_json || [],
    ...(selectedPlan ? { selectedPlan } : {}),
    ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}),
  };
}

function storedReleaseArtifactsMatch(release: any): boolean {
  for (const image of releaseImages(release)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(image.fileName) || image.fileName.includes("..") ||
        !/^[a-f0-9]{64}$/.test(image.sha256) || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0) {
      return false;
    }
    if (!OtaService.verifyStoredArtifact(image.fileName, image.sha256, image.sizeBytes)) return false;
  }
  return true;
}

function hardwareCompatible(release: any, hardwareRevision: string | null | undefined): boolean {
  // A board with no trusted revision may only receive a wildcard release.
  // Treating unknown as compatible with every specific revision would allow
  // the newest incompatible target to win automatic selection.
  const revisions = Array.isArray(release.hardware_revisions) ? release.hardware_revisions : [];
  return hardwareRevision
    ? revisions.includes("*") || revisions.includes(hardwareRevision)
    : revisions.includes("*");
}

function assertStoredReleaseArtifacts(release: any): void {
  if (!storedReleaseArtifactsMatch(release)) {
    throw new FlashRequestError(409, "FirmwareRelease artifact is unavailable or failed size/hash verification");
  }
}

function assertFlashReleaseUsable(release: any): void {
  if (!release || release.status !== FirmwareReleaseState.ACTIVE) {
    throw new FlashRequestError(409, `FirmwareRelease is ${release?.status || "unavailable"}`);
  }
  assertReleaseImageLayout(releaseImages(release), true);
  assertStoredReleaseArtifacts(release);
}

export async function resolveRelease(tx: Prisma.TransactionClient, body: any, target: FlashTargetType, hardwareRevision?: string | null, firmwareTarget?: string | null) {
  let encrypted: false;
  try { encrypted = usbFlashEncryptionEnabled(body.flashEncryptionEnabled); }
  catch (error) {
    throw new FlashRequestError(body.flashEncryptionEnabled === true ? 409 : 400, (error as Error).message);
  }
  const matchesSecurity = (candidate: any): boolean => {
    const images = releaseImages(candidate);
    const app = images.find((image) => image.role === "APP");
    const boot = images.find((image) => image.role === "BOOTLOADER");
    if (!app || !boot) return false;
    // Check immutable hashes before interpreting artifacts; no client-provided
    // profile label can turn a hardware-encryption image into a plain release.
    if (!storedReleaseArtifactsMatch(candidate)) return false;
    try {
      const root = OtaService.getStorageDir();
      return firmwareMatchesBoardSecurity(fs.readFileSync(path.join(root, app.fileName)),
        fs.readFileSync(path.join(root, boot.fileName)), encrypted);
    } catch { return false; }
  };
  const requestedId = optionalText(body.releaseId, 256);
  const requestedVersion = optionalText(body.version ?? body.targetVersion, 32);
  let release = requestedId ? await tx.firmwareRelease.findUnique({ where: { id: requestedId } }) : null;

  const otaType = target === FlashTargetType.GATEWAY ? "GATEWAY" : "SENSOR_NODE";
  const expectedFirmwareTarget = firmwareTarget || defaultFirmwareTarget(otaType);
  // Automatic Web Serial selection must come from the relational catalog only.
  // Legacy OtaService entries may be valid app-only OTA releases, but they are
  // not factory-ready and must never be silently selected for a blank board.
  if (!requestedId && !requestedVersion) {
    const candidates = await tx.firmwareRelease.findMany({
      where: { device_type: otaType, status: FirmwareReleaseState.ACTIVE, firmware_target: expectedFirmwareTarget },
    });
    const compatible = candidates
      .filter((candidate) => {
        try { assertReleaseImageLayout(releaseImages(candidate), true); } catch { return false; }
        return hardwareCompatible(candidate, hardwareRevision);
      })
      .sort((a, b) => compareSemver(b.version, a.version) || b.created_at.getTime() - a.created_at.getTime() || b.id.localeCompare(a.id));
    release = compatible.find((candidate) => storedReleaseArtifactsMatch(candidate) && matchesSecurity(candidate)) || null;
    if (!release) throw new FlashRequestError(404, "No active factory-ready firmware release is available for this board");
  }

  // An explicit version is resolved from the relational factory catalog too.
  // Falling straight through to the legacy OTA manifest here used to reject a
  // perfectly valid uploaded factory release as "not factory-ready".
  if (!requestedId && requestedVersion) {
    const candidates = await tx.firmwareRelease.findMany({
      where: { device_type: otaType, version: requestedVersion, firmware_target: expectedFirmwareTarget },
      orderBy: [{ firmware_target: "asc" }],
    });
    release = candidates
      .filter((candidate) => candidate.status === FirmwareReleaseState.ACTIVE)
      .filter((candidate) => {
        try { assertReleaseImageLayout(releaseImages(candidate), true); } catch { return false; }
        return hardwareCompatible(candidate, hardwareRevision) && storedReleaseArtifactsMatch(candidate) && matchesSecurity(candidate);
      })[0] || null;
    if (!release && candidates.length) throw new FlashRequestError(409, "No active factory-ready firmware release is compatible with this board");
  }

  // Explicit release selection still resolves through the relational catalog;
  // legacy file-backed OTA metadata is intentionally not promoted into a
  // Web-Serial release because it has no factory image set/write plan.
  if (!release) {
    const source = requestedId
      ? await OtaService.getReleaseById(requestedId)
      : requestedVersion ? await OtaService.getReleaseByVersion(otaType, requestedVersion) : await OtaService.getLatestRelease(otaType);
    if (!source) throw new FlashRequestError(404, "FirmwareRelease not found");
    if (source.status !== "ACTIVE") throw new FlashRequestError(409, `FirmwareRelease is ${source.status}`);
    // A file-backed legacy release is app-only by definition. It remains
    // usable by /ota for existing devices, but cannot create a Web Serial job.
    throw new FlashRequestError(409, "FirmwareRelease is not factory-ready; upload the complete bootloader/partition/ota_data/app set before flashing a blank board");
  }
  if (!release) throw new FlashRequestError(404, "FirmwareRelease not found");
  if (release.status !== FirmwareReleaseState.ACTIVE) throw new FlashRequestError(409, `FirmwareRelease is ${release.status}`);
  assertReleaseImageLayout(releaseImages(release), true);
  assertStoredReleaseArtifacts(release);
  if (!matchesSecurity(release)) throw new FlashRequestError(409, "Phiên bản firmware đã chọn không phù hợp trạng thái bảo mật của board. Hãy chọn bản không mã hóa cho board chưa mã hóa.");
  if ((target === FlashTargetType.GATEWAY && release.device_type !== "GATEWAY") || (target === FlashTargetType.NODE && release.device_type !== "SENSOR_NODE")) {
    throw new FlashRequestError(409, "Firmware target does not match Gateway/Node type");
  }
  if (release.firmware_target !== expectedFirmwareTarget) {
    throw new FlashRequestError(409, "Firmware target does not match this board");
  }
  if (!hardwareCompatible(release, hardwareRevision)) {
    throw new FlashRequestError(409, "FirmwareRelease is not compatible with this hardware revision");
  }
  return release;
}

function safeJob(job: any, release?: any, board?: any, identity?: any): any {
  return {
    id: job.id,
    idempotencyKey: job.idempotency_key,
    status: job.status,
    mode: job.mode,
    targetType: job.target_type,
    progress: job.progress,
    board: board ? safeBoard(board, identity) : undefined,
    sourceDeviceId: job.source_device_id,
    resultingDeviceId: job.resulting_device_id,
    release: safeRelease(release || job.release),
    readbackSha256: job.readback_sha256,
    readbackLength: job.readback_length ?? null,
    errorCode: job.error_code,
    errorMessage: job.error_message,
    initiatedByType: job.initiated_by_type,
    initiatedById: job.initiated_by_id,
    expiresAt: job.expires_at,
    completedAt: job.completed_at,
    cancelledAt: job.cancelled_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

async function loadJob(req: ActorRequest, jobId: string) {
  const job = await prisma.flashJob.findUnique({ where: { id: jobId }, include: { release: true, hardware_board: true } });
  if (!job) throw new FlashRequestError(404, "FlashJob not found");
  const identity = await currentBoardIdentity(prisma as unknown as Prisma.TransactionClient, job.hardware_board_id);
  // `userMayAccessBoard` deliberately permits a first-enrollment operator to
  // create a pending job before an identity exists.  That exception must not
  // become a read/flash capability for anyone who guesses an unclaimed job
  // UUID: only the initiator (or an administrator) may continue such a job.
  const mayAccessExistingBoard = identity
    ? await userMayAccessBoard(req, job.hardware_board_id, identity)
    : false;
  if (!isAdmin(req) && job.initiated_by_id !== req.user?.id && !mayAccessExistingBoard) {
    throw new FlashRequestError(404, "FlashJob not found");
  }
  // A board block/unbind is an immediate safety boundary. Existing jobs must
  // not continue flashing or finalize an identity until explicit recovery.
  if (job.hardware_board.state === HardwareBoardState.BLOCKED) {
    throw new FlashRequestError(409, "HardwareBoard is blocked");
  }
  if (job.hardware_board.state === HardwareBoardState.UNBOUND && !isAdmin(req)) {
    throw new FlashRequestError(409, "HardwareBoard requires admin recovery before use");
  }
  if (job.expires_at <= new Date() && !flashStateIs(job.status, FlashJobState.COMPLETED, FlashJobState.FAILED, FlashJobState.CANCELLED)) {
    throw new FlashRequestError(409, "FlashJob has expired");
  }
  return { job, identity };
}

function requireTicket(job: any, req: Request): string {
  const ticket = String(req.body?.ticket || req.header("x-farmos-flash-ticket") || "").trim();
  if (!ticket || !job.ticket_hash || ticketHash(job.hardware_board_id, job.id, ticket) !== job.ticket_hash) {
    throw new FlashRequestError(401, "Flash ticket is invalid");
  }
  return ticket;
}

function validateProgress(value: unknown): number {
  const progress = Number(value);
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw new FlashRequestError(400, "progress must be an integer from 0 to 100");
  return progress;
}

function validateReadbackLength(value: unknown, expected: number): number {
  const length = value === undefined || value === null || value === "" ? expected : Number(value);
  if (!Number.isSafeInteger(length) || length <= 0 || length !== expected) {
    throw new FlashRequestError(409, `readbackLength must equal the signed artifact size (${expected})`);
  }
  return length;
}

function serialTicketOperation(job: any, identity: any, requested: unknown): "ENROLL" | "ROTATE_KEY" | "RECOVER" | "REFLASH" {
  const value = String(requested || "").trim().toUpperCase();
  if (value === "ENROLL" || value === "ROTATE_KEY" || value === "RECOVER" || value === "REFLASH") return value;
  if (!identity) return "ENROLL";
  // RESET_REPROVISION follows the firmware's signed recovery path. A normal
  // reflash has a distinct marker so firmware can preserve its key binding;
  // current production firmware must explicitly support REFLASH before this
  // operation is accepted on physical boards.
  return job.mode === FlashJobMode.RESET_REPROVISION ? "RECOVER" : "REFLASH";
}

function identitySuffix(value: string): number | undefined {
  const match = /_(\d+)$/.exec(value);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 0xffffffff ? parsed : undefined;
}

function requiredSerialNonce(value: unknown): string {
  const nonce = text(value, "nonce", 128);
  if (!/^[A-Za-z0-9_-]+$/.test(nonce)) throw new FlashRequestError(400, "nonce must be unpadded base64url");
  return nonce;
}

function requiredHardwareProof(value: unknown): string {
  const proof = text(value, "hardwareProof", 128).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(proof)) throw new FlashRequestError(400, "hardwareProof must be a SHA-256 hex digest");
  return proof;
}

function serialHello(body: any): any {
  return body?.hello && typeof body.hello === "object" && !Array.isArray(body.hello) ? body.hello : body;
}

function requestedSerialRole(job: any, body: any): "NODE" | "GATEWAY" {
  const hello = serialHello(body);
  const value = String(body?.role ?? hello?.role ?? (job.target_type === FlashTargetType.GATEWAY ? "GATEWAY" : "NODE")).trim().toUpperCase();
  if (value !== "NODE" && value !== "GATEWAY") throw new FlashRequestError(400, "role must be NODE or GATEWAY");
  const expected = job.target_type === FlashTargetType.GATEWAY ? "GATEWAY" : "NODE";
  if (value !== expected) throw new FlashRequestError(409, "Serial enrollment role does not match FlashJob target");
  return value;
}

function requiredPhysicalSerial(body: any): boolean {
  const hello = serialHello(body);
  const value = body?.physicalSerial ?? hello?.physicalSerial;
  if (value !== undefined && value !== true) throw new FlashRequestError(400, "physicalSerial must be true for serial enrollment");
  return true;
}

/**
 * The serial protocol used by the shipped ESP32-S3 images is P-256/ECDSA.
 * `validateEnrollmentPublicKey` deliberately accepts the older Ed25519
 * manufacturing format for other API surfaces, so the Web Serial boundary
 * must apply the firmware-target-specific algorithm gate explicitly.
 */
function assertSerialAttestationAlgorithm(publicKey: string, firmwareTarget: string): void {
  if (!isAttestationAlgorithmAllowed(publicKey, firmwareTarget)) {
    throw new FlashRequestError(409, "Serial enrollment public key algorithm does not match the firmware target");
  }
}

/**
 * Pending generation material is derived once from the board/job pair and
 * persisted on FlashJob. It is not a DeviceIdentity: a failed flash therefore
 * cannot leave a visible identity row, while concurrent enrollment retries
 * still receive the same deviceId/serial before the attested completion.
 */
function deterministicPendingIdentity(job: any, role: "NODE" | "GATEWAY", generation: number): { deviceId: string; serial: string } {
  const seed = crypto.createHmac("sha256", env.HARDWARE_BOARD_HMAC_SECRET)
    .update(`farmos-pending-generation-v1\0${job.hardware_board_id}\0${job.id}\0${generation}\0${role}`, "utf8")
    .digest("hex");
  const numeric = (Number.parseInt(seed.slice(0, 8), 16) % 0xfffffffe) + 1;
  const prefix = role === "GATEWAY" ? "GATEWAY" : "NODE";
  return {
    deviceId: `${prefix}_${numeric}`,
    serial: `${prefix}-${seed.slice(8, 20).toUpperCase()}`,
  };
}

function parseStoredEnrollmentPayload(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function flashStateIs(status: FlashJobState, ...states: FlashJobState[]): boolean {
  return states.includes(status);
}

async function createFlashJob(req: ActorRequest, res: Response) {
  try {
    const key = idempotencyKey(req);
    const mode = normalizeMode(req.body?.mode);
    if (flashModeRequiresReset(mode) && !isAdmin(req)) throw new FlashRequestError(403, "RESET_REPROVISION requires administrator authorization");
    const targetType = normalizeTarget(req.body?.targetType ?? req.body?.deviceType);
    const existing = await prisma.flashJob.findUnique({ where: { idempotency_key: key }, include: { release: true, hardware_board: true } });
    if (existing) {
      if (!isAdmin(req) && existing.initiated_by_id !== req.user!.id) throw new FlashRequestError(404, "FlashJob not found");
      const identity = await currentBoardIdentity(prisma as unknown as Prisma.TransactionClient, existing.hardware_board_id);
      return res.status(200).json({ success: true, idempotent: true, data: safeJob(existing, existing.release, existing.hardware_board, identity) });
    }
    const boardAndJob = await prisma.$transaction(async (tx) => {
      const board = await boardFromRequest(tx, req, req.body || {});
      // boardFromRequest may resolve by opaque boardId (a read-only lookup),
      // so explicitly serialize all job creation paths on the board row.  This
      // closes the double-tab race where two new-board jobs otherwise issue
      // different pending generations before either identity exists.
      const lockedBoard = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "hardware_boards" WHERE "id" = ${board.id} FOR UPDATE
      `;
      if (!lockedBoard.length) throw new FlashRequestError(404, "HardwareBoard could not be resolved");
      const activeJob = await tx.flashJob.findFirst({
        where: { hardware_board_id: board.id, status: { notIn: [FlashJobState.COMPLETED, FlashJobState.FAILED, FlashJobState.CANCELLED] } },
        include: { release: true, hardware_board: true },
        orderBy: { created_at: "desc" },
      });
      if (activeJob) {
        const activeIdentity = await currentBoardIdentity(tx, board.id);
        const mayAccessExistingBoard = activeIdentity
          ? await userMayAccessBoard(req, board.id, activeIdentity)
          : false;
        if (!isAdmin(req) && activeJob.initiated_by_id !== req.user?.id && !mayAccessExistingBoard) {
          throw new FlashRequestError(409, "HardwareBoard already has an active FlashJob");
        }
        if (activeJob.idempotency_key === key) {
          return { job: activeJob, release: activeJob.release, board: activeJob.hardware_board, identity: activeIdentity, idempotent: true };
        }
        const decision = activeFlashJobDecision(activeJob, { mode, targetType });
        if (decision === "conflict") {
          throw new FlashRequestError(409, "HardwareBoard already has an active FlashJob for a different operation; resume or cancel it first");
        }
        if (decision === "resume") {
          return { job: activeJob, release: activeJob.release, board: activeJob.hardware_board, identity: activeIdentity, idempotent: true };
        }
        if (activeJob.mode === FlashJobMode.RESET_REPROVISION && activeJob.enrollment_ticket_signature) {
          throw new FlashRequestError(409, "Expired reset FlashJob has a signed physical ticket; use admin recovery instead of starting another job");
        }
        const expiredAt = new Date();
        const expired = await tx.flashJob.update({
          where: { id: activeJob.id },
          data: {
            status: FlashJobState.FAILED,
            error_code: "FLASH_JOB_EXPIRED",
            error_message: "FlashJob expired before completion",
            expires_at: expiredAt,
          },
        });
        await recordFlashEvent(tx, {
          jobId: expired.id,
          fromState: activeJob.status,
          toState: FlashJobState.FAILED,
          actorType: "SYSTEM",
          actorId: "flash-job-expiry",
          idempotencyKey: `${expired.id}:expired`,
          metadata: { expiredAt: expiredAt.toISOString() },
        });
        if (activeJob.mode === FlashJobMode.RESET_REPROVISION) {
          await tx.hardwareBoard.update({
            where: { id: board.id },
            data: { state: HardwareBoardState.ACTIVE, block_reason: null, blocked_at: null },
          });
        }
        await auditBoard(tx, {
          boardId: board.id,
          action: "FLASH_JOB_EXPIRED",
          actorType: "SYSTEM",
          actorId: "flash-job-expiry",
          idempotencyKey: `${expired.id}:expired:audit`,
          metadata: { jobId: expired.id, previousStatus: activeJob.status },
        });
      }
      const identity = await currentBoardIdentity(tx, board.id);
      if (req.body?.requireNewDevice === true && identity) throw new FlashRequestError(409, `Thiết bị ${identity.device_id} đã có trên hệ thống. Hãy xóa thiết bị trước khi nạp.`);
      if (!identity && !isAdmin(req)) {
        throw new FlashRequestError(403, "Initial Web Serial enrollment requires administrator authorization");
      }
      if (board.state === HardwareBoardState.RESET_PENDING && !flashModeRequiresReset(mode)) throw new FlashRequestError(409, "HardwareBoard is awaiting reset reprovision");
      if (identity && identity.generation_state !== DeviceGenerationState.ACTIVE) throw new FlashRequestError(409, "Current device generation is not active");
      if (identity && (identity.state === DeviceIdentityState.REVOKED || identity.state === DeviceIdentityState.QUARANTINED)) throw new FlashRequestError(409, `Current device identity is ${identity.state}`);
      if (!(await userMayAccessBoard(req, board.id, identity))) throw new FlashRequestError(403, "You do not have access to this HardwareBoard");
      if (identity && ((targetType === FlashTargetType.GATEWAY) !== (identity.type === "GATEWAY"))) {
        throw new FlashRequestError(409, `Board ${identity.device_id} is registered as ${identity.type}; factory reprovisioning is required before flashing as ${targetType}`);
      }
      if (flashModeRequiresReset(mode) && !identity) throw new FlashRequestError(409, "RESET_REPROVISION requires an existing identity generation");
      if (flashModeRequiresReset(mode)) {
        const activeReset = await tx.flashJob.findFirst({
          where: {
            hardware_board_id: board.id,
            mode: FlashJobMode.RESET_REPROVISION,
            status: { notIn: [FlashJobState.COMPLETED, FlashJobState.FAILED, FlashJobState.CANCELLED] },
          },
          select: { id: true },
        });
        if (activeReset) throw new FlashRequestError(409, "HardwareBoard already has a reset/reprovision FlashJob in progress");
      }
      const requestedHardwareRevision = optionalText(req.body?.hardwareRevision, 64)?.trim().toUpperCase() || null;
      const trustedHardwareRevision = (identity?.hardware_revision || board.hardware_revision || null)?.trim().toUpperCase() || null;
      if (requestedHardwareRevision && trustedHardwareRevision && requestedHardwareRevision !== trustedHardwareRevision) {
        throw new FlashRequestError(409, "hardwareRevision does not match the registered HardwareBoard identity");
      }
      const hardwareRevision = trustedHardwareRevision;
      const firmwareTarget = identity?.firmware_target || defaultFirmwareTarget(targetType === FlashTargetType.GATEWAY ? "GATEWAY" : "SENSOR_NODE");
      const release = await resolveRelease(tx, req.body || {}, targetType, hardwareRevision, firmwareTarget);
      if (identity && identity.firmware_target !== release.firmware_target && mode === FlashJobMode.NORMAL_REFLASH) {
        throw new FlashRequestError(409, "Firmware target is incompatible with current identity");
      }
      const expiresAt = new Date(Date.now() + 30 * 60_000);
      const job = await tx.flashJob.create({ data: {
        idempotency_key: key,
        hardware_board_id: board.id,
        source_device_id: identity?.device_id || null,
        release_id: release.id,
        target_type: targetType,
        mode,
        status: FlashJobState.BOARD_RESOLVED,
        progress: 0,
        initiated_by_type: "USER",
        initiated_by_id: req.user!.id,
        expires_at: expiresAt,
      } });
      await recordFlashEvent(tx, { jobId: job.id, toState: FlashJobState.BOARD_RESOLVED, actorType: "USER", actorId: req.user!.id, idempotencyKey: `${key}:board-resolved`, metadata: { boardRef: publicBoardReference(board.id), mode } });
      await auditBoard(tx, { boardId: board.id, action: "FLASH_JOB_CREATED", actorType: "USER", actorId: req.user!.id, idempotencyKey: `${key}:board-audit`, metadata: { jobId: job.id, releaseId: release.id, mode, targetType } });
      if (flashModeRequiresReset(mode)) {
        assertBoardTransition(board.state, HardwareBoardState.RESET_PENDING);
        await tx.hardwareBoard.update({ where: { id: board.id }, data: { state: HardwareBoardState.RESET_PENDING, block_reason: "Admin reset pending successful flash", blocked_at: null } });
        await auditBoard(tx, { boardId: board.id, action: "RESET_PENDING", actorType: "USER", actorId: req.user!.id, idempotencyKey: `${key}:reset-pending` });
      }
      return { job, release, board, identity, idempotent: false };
    });
    return res.status(boardAndJob.idempotent ? 200 : 201).json({ success: true, ...(boardAndJob.idempotent ? { idempotent: true } : {}), data: safeJob(boardAndJob.job, boardAndJob.release, boardAndJob.board, boardAndJob.identity) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/jobs", createFlashJob);
router.post("/flash-jobs", createFlashJob);

// The former JSON metadata registration endpoint is intentionally disabled.
// It allowed callers to mint a relational release without uploading and
// verifying the bytes that the catalog would later serve.  Keep GET/read
// compatibility below, but make all writes use the multipart admin contract,
// which derives identity/hash/offset/signature and always starts as DRAFT.
router.post("/releases", (_req: ActorRequest, res: Response) => {
  return res.status(410).json({
    success: false,
    error: "Legacy JSON release registration is disabled; upload firmware with POST /api/v1/admin/firmware/releases",
  });
});

router.get("/releases", async (req: ActorRequest, res: Response) => {
  try {
    const target = req.query.targetType || req.query.deviceType;
    const where = {
      ...(target ? { device_type: normalizeTarget(target) === FlashTargetType.GATEWAY ? "GATEWAY" : "SENSOR_NODE" } : {}),
      // Draft/paused/revoked firmware belongs to the admin catalog. The
      // legacy authenticated read surface should expose only usable releases.
      ...(!isAdmin(req) ? { status: FirmwareReleaseState.ACTIVE } : {}),
    };
    const releases = await prisma.firmwareRelease.findMany({ where, orderBy: [{ created_at: "desc" }] });
    return res.json({ success: true, count: releases.length, data: releases.map(safeRelease) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.get("/jobs/:jobId", async (req: ActorRequest, res: Response) => {
  try {
    const { job, identity } = await loadJob(req, req.params.jobId);
    return res.json({ success: true, data: safeJob(job, job.release, job.hardware_board, identity) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

async function manifest(req: ActorRequest, res: Response) {
  try {
    const { job, identity } = await loadJob(req, req.params.jobId);
    if (flashStateIs(job.status, FlashJobState.FAILED, FlashJobState.CANCELLED)) throw new FlashRequestError(409, `FlashJob is ${job.status}`);
    // A ticketed manifest is a capability to program a board.  Re-check the
    // release at issuance time so a release revoked after job creation cannot
    // continue to mint fresh download tickets.
    assertFlashReleaseUsable(job.release);
    if (job.status === FlashJobState.CREATED || job.status === FlashJobState.BOARD_RESOLVED) {
      assertFlashTransition(job.status, FlashJobState.MANIFEST_READY);
      await prisma.$transaction(async (tx) => {
        const changed = await tx.flashJob.updateMany({ where: { id: job.id, status: job.status }, data: { status: FlashJobState.MANIFEST_READY } });
        if (!changed.count) throw new FlashRequestError(409, "FlashJob changed concurrently; retry");
        await recordFlashEvent(tx, { jobId: job.id, fromState: job.status, toState: FlashJobState.MANIFEST_READY, actorType: "USER", actorId: req.user!.id, idempotencyKey: `${job.id}:manifest-ready` });
      });
      job.status = FlashJobState.MANIFEST_READY;
    }
    const release = job.release;
    const selectedPlan = selectedPlanForJob(job, release);
    const downloadExpiresAt = Math.min(job.expires_at.getTime(), Date.now() + 15 * 60_000);
    const imageTickets = new Map<string, string>();
    for (const image of releaseImages(release)) {
      imageTickets.set(image.id, createOtaDownloadTicket({
        deviceId: job.source_device_id || job.hardware_board_id,
        jobId: job.id,
        releaseId: release.id,
        imageId: image.id,
        sha256: image.sha256,
        expiresAt: downloadExpiresAt,
      }));
    }
    const downloadUrl = (image: ReleaseImage) => `/api/v1/flash/jobs/${job.id}/download?image=${encodeURIComponent(image.id)}&ticket=${encodeURIComponent(imageTickets.get(image.id) || "")}`;
    return res.json({ success: true, data: {
      job: safeJob(job, release, job.hardware_board, identity),
      manifest: releaseManifestData(release, downloadUrl, new Date(downloadExpiresAt), selectedPlan),
      manifestSha256: release.manifest_sha256,
      manifestSignature: release.manifest_signature,
      manifestKeyId: release.manifest_key_id,
      keyId: release.manifest_key_id,
      download: { url: downloadUrl(releaseImages(release)[0]), expiresAt: job.expires_at, offset: release.flash_offset ?? DEFAULT_FLASH_OFFSET, selectedPlan },
    } });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.get("/jobs/:jobId/manifest", manifest);
router.get("/flash-jobs/:jobId/manifest", manifest);

router.get("/jobs/:jobId/download", async (req: ActorRequest, res: Response) => {
  try {
    const { job } = await loadJob(req, req.params.jobId);
    if (flashStateIs(job.status, FlashJobState.FAILED, FlashJobState.CANCELLED)) throw new FlashRequestError(409, `FlashJob is ${job.status}`);
    // The download route is also a capability boundary; do not rely only on
    // the job's historical release selection because an administrator may
    // revoke that release while a job is still open.
    assertFlashReleaseUsable(job.release);
    const ticket = String(req.query.ticket || "");
    const verified = verifyOtaDownloadTicket(ticket);
    const images = releaseImages(job.release);
    const requestedImageId = String(req.query.image || verified?.imageId || "");
    const image = images.find((value) => value.id === requestedImageId) || (images.length === 1 ? images[0] : null);
    if (!verified || !image || verified.jobId !== job.id || verified.releaseId !== job.release_id || verified.imageId !== image.id || verified.sha256 !== image.sha256 || verified.deviceId !== (job.source_device_id || job.hardware_board_id)) {
      throw new FlashRequestError(401, "Download ticket is invalid or expired");
    }
    const fileName = image.fileName;
    if (!fileName) throw new FlashRequestError(404, "Firmware artifact metadata has no file");
    const binaryPath = OtaService.verifyStoredArtifact(fileName, image.sha256, image.sizeBytes);
    if (!binaryPath) throw new FlashRequestError(409, "Firmware artifact is unavailable or failed size/hash verification");
    const stat = fs.statSync(binaryPath);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/[^a-zA-Z0-9_.-]/g, "_")}"`);
    res.setHeader("X-FarmOS-Manifest-SHA256", job.release.manifest_sha256);
    res.setHeader("X-FarmOS-Artifact-SHA256", image.sha256);
    res.setHeader("Cache-Control", "private, no-store");
    return fs.createReadStream(binaryPath).pipe(res);
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.post("/jobs/:jobId/enrollment", async (req: ActorRequest, res: Response) => {
  try {
    const key = idempotencyKey(req);
    const { job, identity } = await loadJob(req, req.params.jobId);
    if (flashStateIs(job.status, FlashJobState.COMPLETED, FlashJobState.CANCELLED)) throw new FlashRequestError(409, "FlashJob is terminal");
    if (job.status !== FlashJobState.MANIFEST_READY && job.status !== FlashJobState.ENROLLMENT_ISSUED) throw new FlashRequestError(409, `Enrollment is not valid from ${job.status}`);
    const board = job.hardware_board;
    // A blank board has no stored identity/key to authenticate the physical
    // endpoint. Keep the first enrollment on the administrator/factory path;
    // ordinary farm users may still reflash an already-owned identity.
    if (!identity && !isAdmin(req)) throw new FlashRequestError(403, "Initial Web Serial enrollment requires administrator authorization");
    if (board.state === HardwareBoardState.BLOCKED) throw new FlashRequestError(409, "HardwareBoard is blocked");
    const hello = serialHello(req.body);
    const material = materialFromBody(req.body || {});
    if (!material?.factoryEfuseMac) throw new FlashRequestError(400, "factoryEfuseMac is required for serial enrollment");
    const nonce = requiredSerialNonce(req.body?.nonce ?? req.body?.serialNonce ?? hello?.nonce);
    const suppliedHardwareProof = requiredHardwareProof(req.body?.hardwareProof ?? hello?.hardwareProof);
    let expectedHardwareProof: string;
    try {
      expectedHardwareProof = hardwareProofForEnrollment({ chipFamily: material.chipFamily, factoryEfuseMac: material.factoryEfuseMac, nonce });
    } catch {
      throw new FlashRequestError(400, "Serial enrollment hardware material is invalid");
    }
    if (suppliedHardwareProof !== expectedHardwareProof) throw new FlashRequestError(409, "Serial enrollment hardware proof does not match this board");
    const enrollment = validateEnrollmentPublicKey(req.body?.publicKey ?? req.body?.enrollmentPublicKey ?? hello?.attestationPublicKey);
    assertSerialAttestationAlgorithm(enrollment.value, job.release.firmware_target);
    const helloFingerprint = optionalText(req.body?.publicKeyFingerprint ?? hello?.publicKeyFingerprint, 128)?.toLowerCase();
    if (helloFingerprint && helloFingerprint !== enrollment.fingerprint) throw new FlashRequestError(409, "Serial enrollment public key fingerprint does not match the supplied key");
    const role = requestedSerialRole(job, req.body);
    const physicalSerial = requiredPhysicalSerial(req.body);
    const requestedOperation = optionalText(req.body?.operation ?? req.body?.ticketOperation ?? hello?.operation, 32);
    const challenge = deterministicFlashSecret("challenge", board.id, job.id, "serial-enrollment-v1");
    const issued = await prisma.$transaction(async (tx) => {
      // Enrollment is a one-time physical authorization. Serialize retries
      // before reading the ticket so two browser requests cannot both mint a
      // different ticket and leave the first response unusable.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "flash_jobs" WHERE "id" = ${job.id} FOR UPDATE
      `;
      const current = await tx.flashJob.findUnique({ where: { id: job.id } });
      const currentBoard = await tx.hardwareBoard.findUnique({ where: { id: job.hardware_board_id } });
      if (!current || !currentBoard) throw new FlashRequestError(404, "FlashJob not found");
      if (!flashStateIs(current.status, FlashJobState.MANIFEST_READY, FlashJobState.ENROLLMENT_ISSUED)) throw new FlashRequestError(409, `Enrollment is not valid from ${current.status}`);
      if (currentBoard.state === HardwareBoardState.BLOCKED) throw new FlashRequestError(409, "HardwareBoard is blocked");
      const resolved = await resolveHardwareBoard(tx, material);
      if (resolved.id !== currentBoard.id) throw new FlashRequestError(409, "Serial enrollment material resolves to a different HardwareBoard");
      const currentIdentity = await currentBoardIdentity(tx, currentBoard.id);
      if (current.source_device_id && currentIdentity?.device_id !== current.source_device_id) throw new FlashRequestError(409, "Current HardwareBoard generation changed during enrollment");
      if (current.mode === FlashJobMode.RESET_REPROVISION && !currentIdentity) throw new FlashRequestError(409, "Reset source identity is missing");
      if (currentIdentity && currentIdentity.generation_state !== DeviceGenerationState.ACTIVE) throw new FlashRequestError(409, "Current device generation is not active");

      // The firmware binds every existing-identity ticket to the key it
      // advertised in HELLO. Enforce that binding at the API boundary too;
      // otherwise a client could obtain a normal-REFLASH ticket for an
      // arbitrary key and only discover the mismatch after the physical
      // ticket has been issued.
      if (currentIdentity) {
        if (!currentIdentity.public_key || !currentIdentity.public_key_fingerprint || currentIdentity.identity_version < 3) {
          throw new FlashRequestError(409, "Current identity has no complete P-256 serial key; use physical recovery before flashing");
        }
        if (enrollment.fingerprint !== currentIdentity.public_key_fingerprint) {
          throw new FlashRequestError(409, "Serial enrollment key does not match the current HardwareBoard identity");
        }
        if (currentIdentity.public_key_algorithm && currentIdentity.public_key_algorithm !== enrollment.algorithm) {
          throw new FlashRequestError(409, "Serial enrollment key algorithm does not match the current HardwareBoard identity");
        }
      }

      const operation = serialTicketOperation(current, currentIdentity, undefined);
      if (requestedOperation && requestedOperation.toUpperCase() !== operation) throw new FlashRequestError(409, `Serial enrollment operation must be ${operation}`);
      const source = currentIdentity;
      const needsPendingGeneration = !source || current.mode === FlashJobMode.RESET_REPROVISION;
      const generation = needsPendingGeneration ? (current.pending_generation || ((source?.generation || 0) + 1)) : source.generation;
      if (!Number.isSafeInteger(generation) || generation <= 0) throw new FlashRequestError(409, "Serial enrollment generation is invalid");
      const pending = needsPendingGeneration ? deterministicPendingIdentity(current, role, generation) : null;
      const deviceId = needsPendingGeneration ? (current.pending_device_id || pending!.deviceId) : source!.device_id;
      const serial = needsPendingGeneration ? (current.pending_serial_number || pending!.serial) : source!.serial_number;
      if (role === "NODE" && identitySuffix(deviceId) === undefined) throw new FlashRequestError(409, "Node serial enrollment requires a numeric NODE device id");
      const hardwareRevision = source?.hardware_revision || currentBoard.hardware_revision || material.hardwareRevision || "REV_A";
      const model = source?.model || (role === "GATEWAY" ? "GATEWAY_V1" : "NODE_V1");
      const currentPublicKeyFingerprint = source?.public_key_fingerprint || undefined;
      const now = Date.now();
      const ttlMs = Math.min(120_000, 300_000, Math.max(1_000, current.expires_at.getTime() - now));
      const expiresAt = Math.floor((now + ttlMs) / 1000);
      const existingPayload = parseStoredEnrollmentPayload(current.enrollment_ticket_payload);
      let payload = current.enrollment_ticket_payload || "";
      let signature = current.enrollment_ticket_signature || "";
      let keyId = current.enrollment_ticket_key_id || env.FIRMWARE_ENROLLMENT_KEY_ID;
      if (current.enrollment_public_key && current.enrollment_public_key !== enrollment.value) {
        throw new FlashRequestError(409, "FlashJob is already bound to a different enrollment public key");
      }
      if (existingPayload && signature) {
        const sameSession = existingPayload.nonce === nonce && existingPayload.hardwareProof === suppliedHardwareProof && existingPayload.publicKeyFingerprint === enrollment.fingerprint && existingPayload.operation === operation;
        // A lost response can leave a normal reflash ticket committed on the
        // board while the browser starts a fresh HELLO session. Reissue only
        // for an existing active identity and the same bound P-256 key; the
        // new ticket is still signed over the new nonce/proof, so the
        // firmware's physical-session binding is not weakened. Initial
        // enrollment/reset remain fail-closed because the server cannot prove
        // whether the old one-time ticket was already committed.
        const refreshableReflash = canRefreshSerialEnrollmentTicket({
          sameSession,
          operation,
          mode: current.mode,
          sourceDeviceId: current.source_device_id,
          currentIdentityDeviceId: currentIdentity?.device_id,
          boundPublicKey: current.enrollment_public_key,
          enrollmentPublicKey: enrollment.value,
          enrollmentPublicKeyFingerprint: enrollment.fingerprint,
          currentIdentityFingerprint: currentIdentity?.public_key_fingerprint,
          existingOperation: typeof existingPayload.operation === "string" ? existingPayload.operation : null,
        });
        if (!sameSession && !refreshableReflash) throw new FlashRequestError(409, "FlashJob already has a different serial enrollment ticket; resume the original physical session");
        if (sameSession) {
          // Reuse the original ECDSA signature on transport retries. ECDSA
          // DER signatures are intentionally not regenerated for the same
          // physical session.
          payload = current.enrollment_ticket_payload!;
        } else {
          payload = canonicalEnrollmentTicketPayload({
            deviceId,
            firmwareTarget: job.release.firmware_target,
            generation,
            hardwareProof: suppliedHardwareProof,
            hardwareRevision,
            identityVersion: 3,
            model,
            nonce,
            operation,
            physicalSerial,
            publicKeyFingerprint: enrollment.fingerprint,
            ...(currentPublicKeyFingerprint ? { currentPublicKeyFingerprint } : {}),
            ...(role === "NODE" ? { radioId: identitySuffix(deviceId) } : {}),
            role,
            serial,
            ticketId: `flash-${current.id}`,
            ttlMs,
            expiresAt,
          });
          try {
            signature = signEnrollmentTicket(payload);
          } catch {
            throw new FlashRequestError(503, "Serial enrollment signing is unavailable");
          }
          keyId = env.FIRMWARE_ENROLLMENT_KEY_ID;
        }
      } else {
        payload = canonicalEnrollmentTicketPayload({
          deviceId,
          firmwareTarget: current.release_id === job.release_id ? job.release.firmware_target : job.release.firmware_target,
          generation,
          hardwareProof: suppliedHardwareProof,
          hardwareRevision,
          identityVersion: 3,
          model,
          nonce,
          operation,
          physicalSerial,
          publicKeyFingerprint: enrollment.fingerprint,
          ...(currentPublicKeyFingerprint ? { currentPublicKeyFingerprint } : {}),
          ...(role === "NODE" ? { radioId: identitySuffix(deviceId) } : {}),
          role,
          serial,
          ticketId: `flash-${current.id}`,
          ttlMs,
          expiresAt,
        });
        try {
          signature = signEnrollmentTicket(payload);
        } catch {
          throw new FlashRequestError(503, "Serial enrollment signing is unavailable");
        }
        keyId = env.FIRMWARE_ENROLLMENT_KEY_ID;
      }
      const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
      const envelope = { payload: encodedPayload, signature, kid: keyId };
      const ticket = JSON.stringify(envelope);
      const data: Prisma.FlashJobUpdateInput = {
        status: FlashJobState.ENROLLMENT_ISSUED,
        enrollment_public_key: enrollment.value,
        enrollment_key_algorithm: enrollment.algorithm,
        enrollment_ticket_payload: payload,
        enrollment_ticket_signature: signature,
        enrollment_ticket_key_id: keyId,
        challenge_hash: challengeHash(currentBoard.id, current.id, challenge),
        ticket_hash: ticketHash(currentBoard.id, current.id, ticket),
        ...(needsPendingGeneration ? { pending_device_id: deviceId, pending_serial_number: serial, pending_generation: generation } : {}),
      };
      const value = await tx.flashJob.update({ where: { id: current.id }, data });
      const sessionRefresh = Boolean(existingPayload && signature && existingPayload.nonce !== nonce && operation === "REFLASH");
      if (current.status !== FlashJobState.ENROLLMENT_ISSUED || sessionRefresh) {
        await recordFlashEvent(tx, { jobId: current.id, fromState: current.status, toState: FlashJobState.ENROLLMENT_ISSUED, actorType: "USER", actorId: req.user!.id, idempotencyKey: sessionRefresh ? `${current.id}:enrollment-refresh:${nonce}` : `${current.id}:enrollment-issued`, metadata: { publicKeyFingerprint: enrollment.fingerprint, algorithm: enrollment.algorithm, keyId, sessionRefresh } });
      }
      await auditBoard(tx, { boardId: currentBoard.id, action: "ENROLLMENT_ISSUED", actorType: "USER", actorId: req.user!.id, idempotencyKey: sessionRefresh ? `${current.id}:enrollment-refresh:${nonce}:audit` : `${current.id}:enrollment-audit`, metadata: { jobId: current.id, publicKeyFingerprint: enrollment.fingerprint, keyId, operation, sessionRefresh } });
      return { value, ticket, envelope, payload, operation, nonce, hardwareProof: suppliedHardwareProof, deviceId, serial, generation, keyId, board: currentBoard, currentIdentity };
    });
    const updated = issued.value;
    return res.json({ success: true, data: {
      job: safeJob(updated, job.release, issued.board, issued.currentIdentity || identity),
      challenge,
      // `ticket` is the signed envelope as a compact string so the same
      // value can cross the FO binary frame and authenticate progress/
      // readback/complete API calls. The server stores only its HMAC digest.
      ticket: issued.ticket,
      firmwareTicket: issued.envelope,
      ticketEnvelope: issued.envelope,
      ticketPayload: issued.payload,
      ticketSignature: issued.envelope.signature,
      ticketKeyId: issued.keyId,
      serial: {
        protocol: "farmos.serial-enrollment.v1",
        operation: issued.operation,
        nonce: issued.nonce,
        hardwareProof: issued.hardwareProof,
        boardId: issued.board.id,
        jobId: job.id,
        releaseId: job.release_id,
        deviceId: issued.deviceId,
        generation: issued.generation,
      },
      publicKeyFingerprint: enrollment.fingerprint,
      algorithm: enrollment.algorithm,
      expiresAt: updated.expires_at,
    } });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.post("/jobs/:jobId/progress", async (req: ActorRequest, res: Response) => {
  try {
    const key = idempotencyKey(req);
    const { job, identity } = await loadJob(req, req.params.jobId);
    requireTicket(job, req);
    const progress = validateProgress(req.body?.progress);
    if (!flashStateIs(job.status, FlashJobState.ENROLLMENT_ISSUED, FlashJobState.FLASHING)) throw new FlashRequestError(409, `Progress is not valid from ${job.status}`);
    const updated = await prisma.$transaction(async (tx) => {
      // Progress callbacks are intentionally fire-and-forget in the browser.
      // Serialize against readback/completion so a delayed callback cannot
      // move a job backwards from READBACK_VERIFIED (or terminal state) to
      // FLASHING, nor overwrite a newer progress value with an older one.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "flash_jobs" WHERE "id" = ${job.id} FOR UPDATE
      `;
      const current = await tx.flashJob.findUnique({ where: { id: job.id } });
      if (!current) throw new FlashRequestError(404, "FlashJob not found");
      const progressDecision = nextFlashProgress(current.status, current.progress, progress);
      if (progressDecision.ignore) return current;
      const progressEventKey = `${job.id}:progress:${key}`;
      const priorProgress = await tx.flashJobEvent.findUnique({ where: { idempotency_key: progressEventKey } });
      if (priorProgress) return current;
      if (current.status === FlashJobState.ENROLLMENT_ISSUED) assertFlashTransition(current.status, FlashJobState.FLASHING);
      const value = await tx.flashJob.update({ where: { id: job.id }, data: { status: FlashJobState.FLASHING, progress: progressDecision.progress } });
      await recordFlashEvent(tx, { jobId: job.id, fromState: current.status, toState: FlashJobState.FLASHING, progress: progressDecision.progress, actorType: "USER", actorId: req.user!.id, idempotencyKey: progressEventKey, metadata: { sequence: req.body?.sequence ?? null } });
      return value;
    });
    return res.json({ success: true, data: safeJob(updated, job.release, job.hardware_board, identity) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.post("/jobs/:jobId/readback", async (req: ActorRequest, res: Response) => {
  try {
    const key = idempotencyKey(req);
    const { job, identity } = await loadJob(req, req.params.jobId);
    requireTicket(job, req);
    if (!flashStateIs(job.status, FlashJobState.FLASHING, FlashJobState.READBACK_VERIFIED)) throw new FlashRequestError(409, `Readback is not valid from ${job.status}`);
    const selectedPlan = selectedPlanForJob(job, job.release);
    const requestedPlan = optionalText(req.body?.planName ?? req.body?.selectedPlan, 64);
    if (requestedPlan && requestedPlan !== selectedPlan.name) throw new FlashRequestError(409, "Readback selectedPlan does not match FlashJob mode");
    const appImage = readbackImage(job.release);
    const readbackSha256 = text(req.body?.readbackSha256 ?? req.body?.firmwareSha256, "readbackSha256", 128).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(readbackSha256)) throw new FlashRequestError(400, "readbackSha256 must be a SHA-256 hex digest");
    if (readbackSha256 !== appImage.sha256) throw new FlashRequestError(409, "Board readback does not match signed application image");
    const readbackLength = validateReadbackLength(req.body?.readbackLength ?? job.readback_length, appImage.sizeBytes);
    const updated = await prisma.$transaction(async (tx) => {
      // Serialize readback with progress/fail/cancel/complete. Without the
      // row lock a stale FLASHING read could overwrite a concurrent FAILED or
      // COMPLETED transition after that transition has already committed.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "flash_jobs" WHERE "id" = ${job.id} FOR UPDATE
      `;
      const current = await tx.flashJob.findUnique({ where: { id: job.id } });
      if (!current) throw new FlashRequestError(404, "FlashJob not found");
      if (current.status === FlashJobState.READBACK_VERIFIED) return current;
      assertFlashTransition(current.status, FlashJobState.READBACK_VERIFIED);
      if (current.readback_length && current.readback_length !== readbackLength) throw new FlashRequestError(409, "FlashJob readbackLength changed during retry");
      const value = await tx.flashJob.update({ where: { id: job.id }, data: { status: FlashJobState.READBACK_VERIFIED, progress: 100, readback_sha256: readbackSha256, readback_length: readbackLength } });
      await recordFlashEvent(tx, { jobId: job.id, fromState: current.status, toState: FlashJobState.READBACK_VERIFIED, progress: 100, actorType: "USER", actorId: req.user!.id, idempotencyKey: `${job.id}:readback:${key}`, metadata: { readbackSha256, readbackLength } });
      return value;
    });
    return res.json({ success: true, data: safeJob(updated, job.release, job.hardware_board, identity) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

function revocationReason(body: any): string {
  return optionalText(body?.reason, 512) || "Superseded by HardwareBoard generation transition";
}

async function completeFlash(req: ActorRequest, res: Response) {
  try {
    const key = idempotencyKey(req);
    const { job, identity } = await loadJob(req, req.params.jobId);
    requireTicket(job, req);
    const nestedAttestation = req.body?.flashAttestation && typeof req.body.flashAttestation === "object" && !Array.isArray(req.body.flashAttestation) ? req.body.flashAttestation : null;
    if (job.status === FlashJobState.COMPLETED) {
      // A completed job is a safe read/retry endpoint only for the same
      // physical transcript.  Do not let a caller with the valid job ticket
      // silently turn a conflicting retry (especially a new enrollment
      // nonce/readback) into an idempotent success.
      const requestedChallenge = optionalText(req.body?.challenge ?? nestedAttestation?.challenge, 512);
      if (requestedChallenge && (!job.challenge_hash || challengeHash(job.hardware_board_id, job.id, requestedChallenge) !== job.challenge_hash)) {
        throw new FlashRequestError(401, "Flash challenge is invalid");
      }
      const requestedReadback = optionalText(req.body?.readbackSha256 ?? nestedAttestation?.readbackSha256, 128)?.toLowerCase();
      const completedReadback = String(job.readback_sha256 || readbackImage(job.release).sha256).toLowerCase();
      if (requestedReadback && requestedReadback !== completedReadback) {
        throw new FlashRequestError(409, "Readback hash does not match the completed FlashJob");
      }
      const rawReadbackLength = req.body?.readbackLength ?? nestedAttestation?.readbackLength;
      if (rawReadbackLength !== undefined && rawReadbackLength !== null && rawReadbackLength !== "") {
        const requestedLength = Number(rawReadbackLength);
        if (!Number.isSafeInteger(requestedLength) || requestedLength !== (job.readback_length ?? readbackImage(job.release).sizeBytes)) {
          throw new FlashRequestError(409, "FlashJob readbackLength does not match the completed FlashJob");
        }
      }
      const requestedNonce = optionalText(req.body?.nonce ?? req.body?.serialNonce ?? nestedAttestation?.nonce, 128);
      const storedTicket = parseStoredEnrollmentPayload(job.enrollment_ticket_payload);
      if (requestedNonce && storedTicket?.nonce !== undefined && requestedNonce !== String(storedTicket.nonce)) {
        throw new FlashRequestError(409, "Enrollment nonce does not match the completed FlashJob");
      }
      const requestedSignature = optionalText(req.body?.flashAttestationSignature ?? nestedAttestation?.signature ?? req.body?.attestationSignature ?? req.body?.signature, 512);
      if (requestedSignature && job.attestation_signature && requestedSignature !== job.attestation_signature) {
        throw new FlashRequestError(409, "Flash attestation does not match the completed FlashJob");
      }
      const requestedMessage = optionalText(req.body?.flashAttestationMessage ?? nestedAttestation?.message ?? req.body?.attestationMessage, 2_048);
      if (requestedMessage && job.attestation_message && requestedMessage !== job.attestation_message) {
        throw new FlashRequestError(409, "Flash attestation message does not match the completed FlashJob");
      }
      const identity = job.resulting_device_id ? await prisma.deviceIdentity.findUnique({ where: { device_id: job.resulting_device_id } }) : null;
      const qr = identity ? await prisma.deviceQrLabel.findUnique({ where: { device_id: identity.device_id } }) : null;
      return res.json({ success: true, idempotent: true, data: { job: safeJob(job, job.release, job.hardware_board, identity), identity: safeIdentity(identity, qr), qr: safeQrLabel(qr) } });
    }
    if (!flashStateIs(job.status, FlashJobState.READBACK_VERIFIED)) throw new FlashRequestError(409, `Completion requires READBACK_VERIFIED, not ${job.status}`);
    const selectedPlan = selectedPlanForJob(job, job.release);
    const requestedPlan = optionalText(req.body?.planName ?? req.body?.selectedPlan ?? nestedAttestation?.planName, 64);
    if (requestedPlan && requestedPlan !== selectedPlan.name) throw new FlashRequestError(409, "Completion selectedPlan does not match FlashJob mode");
    const appImage = readbackImage(job.release);
    const challenge = text(req.body?.challenge ?? nestedAttestation?.challenge, "challenge", 512);
    if (!job.challenge_hash || challengeHash(job.hardware_board_id, job.id, challenge) !== job.challenge_hash) throw new FlashRequestError(401, "Flash challenge is invalid");
    const readbackSha256 = text(req.body?.readbackSha256 ?? nestedAttestation?.readbackSha256 ?? job.readback_sha256, "readbackSha256", 128).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(readbackSha256) || readbackSha256 !== appImage.sha256) throw new FlashRequestError(409, "Readback hash does not match signed application image");
    const readbackLength = validateReadbackLength(req.body?.readbackLength ?? nestedAttestation?.readbackLength ?? job.readback_length, appImage.sizeBytes);
    if (job.readback_length && job.readback_length !== readbackLength) throw new FlashRequestError(409, "FlashJob readbackLength does not match completion");
    if (nestedAttestation) {
      const nestedBoard = optionalText(nestedAttestation.boardId, 128);
      const nestedJob = optionalText(nestedAttestation.jobId, 128);
      const nestedRelease = optionalText(nestedAttestation.releaseId, 128);
      const nestedManifest = optionalText(nestedAttestation.manifestSha256, 128)?.toLowerCase();
      if (nestedBoard && nestedBoard !== job.hardware_board_id || nestedJob && nestedJob !== job.id || nestedRelease && nestedRelease !== job.release_id || nestedManifest && nestedManifest !== job.release.manifest_sha256) {
        throw new FlashRequestError(409, "Nested flashAttestation does not match FlashJob");
      }
    }
    const appStep = selectedPlan.steps.find((step) => step.role === "APP");
    if (job.mode === FlashJobMode.NORMAL_REFLASH && (!appStep || Number(appStep.address) !== FARMOS_FLASH_LAYOUT.normalReflash.readbackOffset || selectedPlan.steps[selectedPlan.steps.length - 1]?.role !== "OTA_DATA")) {
      throw new FlashRequestError(409, "NORMAL_REFLASH selectedPlan must write APP ota_0 and commit OTA_DATA last");
    }
    // Firmware returns `flashAttestationSignature` alongside the enrollment
    // transcript `signature`. Accept the explicit firmware name first so a
    // client cannot accidentally submit the wrong (pre-flash) signature.
    const signature = text(req.body?.flashAttestationSignature ?? nestedAttestation?.signature ?? req.body?.attestationSignature ?? req.body?.signature, "attestationSignature", 512);
    const message = flashAttestationMessage({ boardId: job.hardware_board_id, jobId: job.id, releaseId: job.release_id, manifestSha256: job.release.manifest_sha256, readbackSha256, challenge });
    const suppliedMessage = optionalText(req.body?.flashAttestationMessage ?? nestedAttestation?.message ?? req.body?.attestationMessage, 2_048);
    if (suppliedMessage && suppliedMessage !== message) throw new FlashRequestError(401, "Flash attestation message is invalid");
    const suppliedAttestationKey = optionalText(req.body?.attestationPublicKey ?? nestedAttestation?.attestationPublicKey ?? req.body?.publicKey, 16_384);
    const attestationKey = suppliedAttestationKey ? validateEnrollmentPublicKey(suppliedAttestationKey) : null;
    if (attestationKey) assertSerialAttestationAlgorithm(attestationKey.value, job.release.firmware_target);
    if (attestationKey && job.mode === FlashJobMode.NORMAL_REFLASH && (!job.enrollment_public_key || attestationKey.fingerprint !== publicKeyFingerprint(job.enrollment_public_key))) {
      throw new FlashRequestError(409, "Normal reflash cannot rotate the identity key binding");
    }
    if (job.mode === FlashJobMode.NORMAL_REFLASH && job.source_device_id) {
      if (!identity?.public_key_fingerprint || !job.enrollment_public_key || publicKeyFingerprint(job.enrollment_public_key) !== identity.public_key_fingerprint) {
        throw new FlashRequestError(409, "Normal reflash key binding no longer matches the current HardwareBoard identity");
      }
    }
    const verificationKey = attestationKey?.value || job.enrollment_public_key;
    if (verificationKey) assertSerialAttestationAlgorithm(verificationKey, job.release.firmware_target);
    if (!verificationKey || !verifyFlashAttestation(verificationKey, message, signature)) throw new FlashRequestError(401, "Post-flash board attestation is invalid");

    const result = await prisma.$transaction(async (tx) => {
      // Identity creation for a RESET_REPROVISION/new enrollment is part of
      // completion. Lock the FlashJob before reading its state so two
      // identical completion requests cannot both create the deterministic
      // replacement identity/QR and race into a unique-key failure.
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "flash_jobs" WHERE "id" = ${job.id} FOR UPDATE
      `;
      const currentJob = await tx.flashJob.findUnique({ where: { id: job.id }, include: { hardware_board: true, release: true } });
      if (!currentJob) throw new FlashRequestError(404, "FlashJob not found");
      if (currentJob.status === FlashJobState.COMPLETED) {
        const existing = currentJob.resulting_device_id ? await tx.deviceIdentity.findUnique({ where: { device_id: currentJob.resulting_device_id } }) : null;
        const existingQr = existing ? await tx.deviceQrLabel.findUnique({ where: { device_id: existing.device_id } }) : null;
        return { job: currentJob, identity: existing, qr: existingQr, idempotent: true };
      }
      if (currentJob.status !== FlashJobState.READBACK_VERIFIED) throw new FlashRequestError(409, `FlashJob changed concurrently to ${currentJob.status}`);
      if (currentJob.readback_length && currentJob.readback_length !== readbackLength) throw new FlashRequestError(409, "FlashJob readbackLength changed during completion");
      const currentIdentity = await currentBoardIdentity(tx, currentJob.hardware_board_id);
      if (currentJob.source_device_id && currentIdentity?.device_id !== currentJob.source_device_id) {
        throw new FlashRequestError(409, "Current HardwareBoard generation changed during flash");
      }
      if (currentJob.mode === FlashJobMode.NORMAL_REFLASH && currentJob.source_device_id) {
        if (!currentIdentity?.public_key_fingerprint || !currentJob.enrollment_public_key || publicKeyFingerprint(currentJob.enrollment_public_key) !== currentIdentity.public_key_fingerprint) {
          throw new FlashRequestError(409, "Normal reflash key binding no longer matches the current HardwareBoard identity");
        }
      }
      if (currentJob.mode === FlashJobMode.RESET_REPROVISION) {
        if (!currentIdentity?.public_key_fingerprint || !attestationKey || attestationKey.fingerprint === currentIdentity.public_key_fingerprint) {
          throw new FlashRequestError(409, "Reset/reprovision must attest with a newly generated device key");
        }
      } else if (!currentIdentity && attestationKey && currentJob.enrollment_public_key && attestationKey.fingerprint !== publicKeyFingerprint(currentJob.enrollment_public_key)) {
        throw new FlashRequestError(409, "Initial enrollment attestation key does not match the enrollment key");
      }
      let resulting = currentIdentity;
      let resultingQr: any = null;
      let replacementQrId: string | null = null;
      if (currentJob.mode === FlashJobMode.RESET_REPROVISION || !currentIdentity) {
        if (currentJob.mode === FlashJobMode.RESET_REPROVISION && !currentIdentity) throw new FlashRequestError(409, "Reset source identity is missing");
        const source = currentIdentity;
        const storedTicket = parseStoredEnrollmentPayload(currentJob.enrollment_ticket_payload);
        const nextGeneration = currentJob.pending_generation || (storedTicket && Number.isSafeInteger(storedTicket.generation) ? Number(storedTicket.generation) : (source?.generation || 0) + 1);
        const ticketDeviceId = typeof storedTicket?.deviceId === "string" ? storedTicket.deviceId : null;
        const ticketSerial = typeof storedTicket?.serial === "string" ? storedTicket.serial : null;
        const deviceId = currentJob.pending_device_id || ticketDeviceId || generationDeviceId(currentJob.target_type === FlashTargetType.GATEWAY ? "GATEWAY" : "SENSOR_NODE");
        const serial = currentJob.pending_serial_number || ticketSerial || generationSerial(source?.serial_number || (currentJob.target_type === FlashTargetType.GATEWAY ? "GATEWAY" : "NODE"));
        if (!currentJob.enrollment_ticket_payload || !currentJob.enrollment_ticket_signature) throw new FlashRequestError(409, "Post-flash enrollment ticket is missing");
        if (storedTicket && (storedTicket.deviceId !== deviceId || storedTicket.serial !== serial || Number(storedTicket.generation) !== nextGeneration)) throw new FlashRequestError(409, "Post-flash identity does not match the signed enrollment ticket");
        const targetRole = currentJob.target_type === FlashTargetType.GATEWAY ? "GATEWAY" : "NODE";
        if (!storedTicket || typeof storedTicket.deviceId !== "string" || typeof storedTicket.serial !== "string" || !Number.isSafeInteger(Number(storedTicket.generation))) {
          throw new FlashRequestError(409, "Post-flash enrollment ticket payload is invalid");
        }
        let identityMaterial: ReturnType<typeof completedIdentityMaterial>;
        try {
          identityMaterial = completedIdentityMaterial({
            role: targetRole,
            releaseFirmwareTarget: currentJob.release.firmware_target,
            sourceHardwareRevision: source?.hardware_revision,
            boardHardwareRevision: currentJob.hardware_board.hardware_revision,
            ticketHardwareRevision: storedTicket.hardwareRevision,
            sourceModel: source?.model,
            ticketModel: storedTicket.model,
            ticketFirmwareTarget: storedTicket.firmwareTarget,
            ticketRole: storedTicket.role,
          });
        } catch (error) {
          throw new FlashRequestError(409, error instanceof Error ? error.message : "Post-flash enrollment material is invalid");
        }
        const claimCode = createOpaqueToken(24);
        if (source) {
          if (source.generation_state === DeviceGenerationState.ACTIVE) {
            await tx.deviceIdentity.update({ where: { device_id: source.device_id }, data: {
              generation_state: DeviceGenerationState.RETIRED,
              is_current: false,
              state: source.state === DeviceIdentityState.REVOKED ? source.state : DeviceIdentityState.READY_TO_SHIP,
            } });
          }
          await invalidateDeviceAccess(tx, source.device_id, "HardwareBoard generation reset/reprovision");
          const oldLabel = await tx.deviceQrLabel.findUnique({ where: { device_id: source.device_id } });
          if (oldLabel && oldLabel.state !== DeviceQrLabelState.REVOKED) {
            await tx.deviceQrLabel.update({ where: { id: oldLabel.id }, data: { state: DeviceQrLabelState.REVOKED, revoked_at: new Date(), revoke_reason: "Superseded by reset/reprovision generation" } });
            await tx.deviceQrRevocation.create({ data: {
              qr_id: oldLabel.qr_id,
              device_id: source.device_id,
              generation: source.generation,
              canonical_payload: oldLabel.canonical_payload,
              signature: oldLabel.signature,
              reason: "Superseded by reset/reprovision generation",
              actor_type: "USER",
              actor_id: req.user!.id,
              idempotency_key: `${currentJob.id}:generation:${source.generation}:old-qr`,
            } });
          }
        }
        const sourceType = source?.type || (currentJob.target_type === FlashTargetType.GATEWAY ? "GATEWAY" : "SENSOR_NODE");
        const created = await tx.deviceIdentity.create({ data: {
          device_id: deviceId,
          serial_number: serial,
          type: sourceType,
          capabilities: source?.capabilities || (sourceType === "GATEWAY" ? ["WIFI", "LORA", "GATEWAY", "LOCAL_SENSOR"] : ["WIFI", "LORA", "SENSOR_DS18B20"]),
          firmware_target: identityMaterial.firmwareTarget,
          hardware_revision: identityMaterial.hardwareRevision,
          partition_scheme: currentJob.release.partition_scheme,
          model: identityMaterial.model,
          claim_code_hash: hashDeviceSecret(`claim:${deviceId}`, claimCode),
          // RESET_REPROVISION creates a new physical generation.  Ownership
          // belongs to the retired QR/generation and is never copied into a
          // replacement that has not completed a new claim flow.
          state: DeviceIdentityState.READY_TO_SHIP,
          claimed_by_id: null,
          claimed_farm_id: null,
          claimed_at: null,
          hardware_board_id: currentJob.hardware_board_id,
          generation: nextGeneration,
          generation_state: DeviceGenerationState.ACTIVE,
          is_current: true,
          public_key: attestationKey?.value || currentJob.enrollment_public_key,
          public_key_algorithm: attestationKey?.algorithm || currentJob.enrollment_key_algorithm,
          public_key_fingerprint: attestationKey?.fingerprint || (currentJob.enrollment_public_key ? publicKeyFingerprint(currentJob.enrollment_public_key) : null),
          identity_version: 3,
          factory_firmware_sha256: currentJob.release.artifact_sha256,
        } });
        resulting = created;
        const qr = qrForIdentity(created);
        const label = await tx.deviceQrLabel.create({ data: {
          qr_id: qr.qrId,
          device_id: created.device_id,
          version: 3,
          issuer: qr.issuer,
          kid: qr.kid,
          canonical_payload: qr.canonicalPayload,
          signature: qr.signature,
          state: DeviceQrLabelState.ISSUED,
        } });
        resultingQr = label;
        replacementQrId = label.qr_id;
      } else {
        // Normal reflash deliberately preserves deviceId, serial, QR, owner,
        // and the existing key binding. Attestation proves this same board and
        // release; it does not silently rotate identity material.
        // A normal reflash is an operational firmware change, not a new
        // factory-write event. Preserve the immutable manufacturing evidence
        // and the identity/QR/ownership generation exactly as-is.
        resulting = currentIdentity;
        resultingQr = await tx.deviceQrLabel.findUnique({ where: { device_id: resulting.device_id } });
      }
      if (shouldUpdateNormalReflashNode({
        mode: currentJob.mode,
        sourceDeviceId: currentJob.source_device_id,
        currentIdentityDeviceId: currentIdentity?.device_id,
        resultingDeviceId: resulting?.device_id,
      })) {
        // Do not create or rebind a Node here.  A successful Web Serial
        // completion may update an already-associated operational row only;
        // an unclaimed/replacement generation remains inventory-only until a
        // later QR claim creates its Node.
        await tx.node.updateMany({
          where: { id: currentJob.source_device_id! },
          data: { firmware_version: currentJob.release.version, updated_at: new Date() },
        });
      }
      const updated = await tx.flashJob.update({ where: { id: currentJob.id }, data: {
        status: FlashJobState.COMPLETED,
        progress: 100,
        readback_sha256: readbackSha256,
        readback_length: readbackLength,
        attestation_message: message,
        attestation_signature: signature,
        resulting_device_id: resulting!.device_id,
        completed_at: new Date(),
      } });
      await recordFlashEvent(tx, { jobId: currentJob.id, fromState: FlashJobState.READBACK_VERIFIED, toState: FlashJobState.COMPLETED, progress: 100, actorType: "USER", actorId: req.user!.id, idempotencyKey: `${currentJob.id}:complete:${key}`, metadata: { resultingDeviceId: resulting!.device_id, replacementQrId, mode: currentJob.mode } });
      await auditBoard(tx, { boardId: currentJob.hardware_board_id, action: currentJob.mode === FlashJobMode.RESET_REPROVISION ? "GENERATION_FINALIZED" : "REFLASH_COMPLETED", actorType: "USER", actorId: req.user!.id, idempotencyKey: `${currentJob.id}:complete-audit:${key}`, metadata: { jobId: currentJob.id, resultingDeviceId: resulting!.device_id, replacementQrId, readbackSha256 } });
      await tx.hardwareBoard.update({ where: { id: currentJob.hardware_board_id }, data: { state: HardwareBoardState.ACTIVE, block_reason: null, blocked_at: null, last_seen_at: new Date() } });
      return { job: updated, identity: resulting, qr: resultingQr, idempotent: false, replacementQrId };
    });
    return res.json({ success: true, idempotent: result.idempotent, data: { job: safeJob(result.job, job.release, job.hardware_board, result.identity), identity: safeIdentity(result.identity, result.qr), qr: safeQrLabel(result.qr), replacementQrId: result.replacementQrId || null } });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/jobs/:jobId/complete", completeFlash);
router.post("/jobs/:jobId/attest", completeFlash);

async function failFlash(req: ActorRequest, res: Response) {
  try {
    const key = idempotencyKey(req);
    const { job, identity } = await loadJob(req, req.params.jobId);
    if (flashStateIs(job.status, FlashJobState.COMPLETED, FlashJobState.CANCELLED)) throw new FlashRequestError(409, `FlashJob is ${job.status}`);
    const reason = optionalText(req.body?.error ?? req.body?.reason, 512) || "Flash failed";
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "flash_jobs" WHERE "id" = ${job.id} FOR UPDATE
      `;
      const current = await tx.flashJob.findUnique({ where: { id: job.id } });
      if (!current) throw new FlashRequestError(404, "FlashJob not found");
      if (flashStateIs(current.status, FlashJobState.COMPLETED, FlashJobState.CANCELLED)) throw new FlashRequestError(409, `FlashJob is ${current.status}`);
      // A reset ticket authorizes a physical generation transition. Once the
      // signed ticket exists, the server cannot distinguish a rejected write
      // from a USB timeout after firmware committed it. Do not release the
      // board back to ACTIVE and allow a second generation to race this job;
      // the same FlashJob must be resumed/reconciled instead.
      if (current.mode === FlashJobMode.RESET_REPROVISION && current.enrollment_ticket_signature) {
        throw new FlashRequestError(409, "Reset FlashJob has a signed physical ticket; resume it instead of marking it failed");
      }
      const value = await tx.flashJob.update({ where: { id: job.id }, data: { status: FlashJobState.FAILED, error_code: optionalText(req.body?.errorCode, 128), error_message: reason } });
      await recordFlashEvent(tx, { jobId: job.id, fromState: current.status, toState: FlashJobState.FAILED, actorType: "USER", actorId: req.user!.id, idempotencyKey: `${job.id}:failed:${key}`, metadata: { reason } });
      if (current.mode === FlashJobMode.RESET_REPROVISION) {
        await tx.hardwareBoard.update({ where: { id: current.hardware_board_id }, data: { state: HardwareBoardState.ACTIVE, block_reason: null, blocked_at: null } });
        await auditBoard(tx, { boardId: current.hardware_board_id, action: "RESET_FLASH_FAILED", actorType: "USER", actorId: req.user!.id, idempotencyKey: `${job.id}:failed-audit:${key}`, reason });
      }
      return value;
    });
    return res.json({ success: true, data: safeJob(updated, job.release, job.hardware_board, identity) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/jobs/:jobId/fail", failFlash);

async function cancelFlash(req: ActorRequest, res: Response) {
  try {
    const key = idempotencyKey(req);
    const { job, identity } = await loadJob(req, req.params.jobId);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "flash_jobs" WHERE "id" = ${job.id} FOR UPDATE
      `;
      const current = await tx.flashJob.findUnique({ where: { id: job.id } });
      if (!current) throw new FlashRequestError(404, "FlashJob not found");
      if (current.status === FlashJobState.COMPLETED) throw new FlashRequestError(409, "Completed FlashJob cannot be cancelled");
      if (current.status === FlashJobState.CANCELLED) return current;
      if (current.mode === FlashJobMode.RESET_REPROVISION && current.enrollment_ticket_signature) {
        throw new FlashRequestError(409, "Reset FlashJob has a signed physical ticket; resume it instead of cancelling it");
      }
      if (current.status !== FlashJobState.FAILED) assertFlashTransition(current.status, FlashJobState.CANCELLED);
      const value = await tx.flashJob.update({ where: { id: job.id }, data: { status: FlashJobState.CANCELLED, cancelled_at: new Date(), error_code: "CANCELLED", error_message: optionalText(req.body?.reason, 512) } });
      await recordFlashEvent(tx, { jobId: job.id, fromState: current.status, toState: FlashJobState.CANCELLED, actorType: "USER", actorId: req.user!.id, idempotencyKey: `${job.id}:cancel:${key}` });
      if (current.mode === FlashJobMode.RESET_REPROVISION) await tx.hardwareBoard.update({ where: { id: current.hardware_board_id }, data: { state: HardwareBoardState.ACTIVE, block_reason: null, blocked_at: null } });
      return value;
    });
    return res.json({ success: true, data: safeJob(updated, job.release, job.hardware_board, identity) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/jobs/:jobId/cancel", cancelFlash);

router.post("/boards/resolve", async (req: ActorRequest, res: Response) => {
  try {
    const board = await prisma.$transaction((tx) => boardFromRequest(tx, req, req.body || {}, true));
    const identity = await currentBoardIdentity(prisma as unknown as Prisma.TransactionClient, board.id);
    if (!materialFromBody(req.body || {}) && !identity && !isAdmin(req)) throw new FlashRequestError(403, "Factory board material is required to resolve an unbound board");
    if (board.state === HardwareBoardState.BLOCKED && !isAdmin(req)) throw new FlashRequestError(409, "HardwareBoard is blocked");
    return res.json({ success: true, data: safeBoard(board, identity) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

// Generation history is intentionally an admin-only, read-only view. It
// exposes opaque identity/QR/key fingerprints and revocation reasons, never
// the HardwareBoard HMAC key or factory MAC/chip material.
router.get("/boards/:boardId/generations", requireRole(["ADMIN"]), async (req: ActorRequest, res: Response) => {
  try {
    const board = await prisma.hardwareBoard.findUnique({ where: { id: req.params.boardId }, select: { id: true } });
    if (!board) throw new FlashRequestError(404, "HardwareBoard not found");
    const generations = await prisma.deviceIdentity.findMany({
      where: { hardware_board_id: board.id },
      include: {
        qr_label: true,
        qr_revocations: { orderBy: { revoked_at: "desc" } },
        key_revocations: { orderBy: { revoked_at: "desc" } },
      },
      orderBy: { generation: "desc" },
    });
    return res.json({ success: true, data: generations.map((generation) => ({
      identity: safeIdentity(generation, generation.qr_label),
      qr: safeQrLabel(generation.qr_label),
      qrRevocations: generation.qr_revocations.map((revocation) => ({
        qrId: revocation.qr_id,
        replacementQrId: revocation.replacement_qr_id,
        generation: revocation.generation,
        reason: revocation.reason,
        actorType: revocation.actor_type,
        actorId: revocation.actor_id,
        revokedAt: revocation.revoked_at,
      })),
      keyRevocations: generation.key_revocations.map((revocation) => ({
        generation: revocation.generation,
        keyVersion: revocation.key_version,
        publicKeyFingerprint: revocation.public_key_fingerprint,
        publicKeyAlgorithm: revocation.public_key_algorithm,
        reason: revocation.reason,
        actorType: revocation.actor_type,
        actorId: revocation.actor_id,
        revokedAt: revocation.revoked_at,
      })),
    })) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.get("/boards/:boardId", async (req: ActorRequest, res: Response) => {
  try {
    const board = await prisma.hardwareBoard.findUnique({ where: { id: req.params.boardId } });
    if (!board) throw new FlashRequestError(404, "HardwareBoard not found");
    const identity = await currentBoardIdentity(prisma as unknown as Prisma.TransactionClient, board.id);
    if (!(await userMayAccessBoard(req, board.id, identity))) throw new FlashRequestError(404, "HardwareBoard not found");
    return res.json({ success: true, data: safeBoard(board, identity) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

async function adminBoard(req: ActorRequest): Promise<any> {
  if (!isAdmin(req)) throw new FlashRequestError(403, "Administrator authorization required");
  const board = await prisma.hardwareBoard.findUnique({ where: { id: req.params.boardId } });
  if (!board) throw new FlashRequestError(404, "HardwareBoard not found");
  return board;
}

router.post("/boards/:boardId/block", requireRole(["ADMIN"]), async (req: ActorRequest, res: Response) => {
  try {
    const board = await adminBoard(req);
    const key = idempotencyKey(req);
    const reason = optionalText(req.body?.reason, 512) || "Blocked by administrator";
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.hardwareBoard.findUnique({ where: { id: board.id } });
      if (!current) throw new FlashRequestError(404, "HardwareBoard not found");
      if (current.state !== HardwareBoardState.BLOCKED) assertBoardTransition(current.state, HardwareBoardState.BLOCKED);
      const identity = await currentBoardIdentity(tx, board.id);
      if (identity) await invalidateDeviceAccess(tx, identity.device_id, `HardwareBoard blocked: ${reason}`);
      const value = await tx.hardwareBoard.update({ where: { id: board.id }, data: { state: HardwareBoardState.BLOCKED, block_reason: reason, blocked_at: new Date() } });
      await auditBoard(tx, { boardId: board.id, action: "BLOCK", actorType: "ADMIN", actorId: req.user!.id, idempotencyKey: key, reason, metadata: { deviceId: identity?.device_id || null } });
      return { value, identity };
    });
    return res.json({ success: true, data: safeBoard(updated.value, updated.identity) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.post("/boards/:boardId/unblock", requireRole(["ADMIN"]), async (req: ActorRequest, res: Response) => {
  try {
    const board = await adminBoard(req);
    const key = idempotencyKey(req);
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.hardwareBoard.findUnique({ where: { id: board.id } });
      if (!current) throw new FlashRequestError(404, "HardwareBoard not found");
      if (current.state === HardwareBoardState.BLOCKED) assertBoardTransition(current.state, HardwareBoardState.ACTIVE);
      const value = await tx.hardwareBoard.update({ where: { id: board.id }, data: { state: HardwareBoardState.ACTIVE, block_reason: null, blocked_at: null } });
      await auditBoard(tx, { boardId: board.id, action: "UNBLOCK", actorType: "ADMIN", actorId: req.user!.id, idempotencyKey: key });
      return value;
    });
    const identity = await currentBoardIdentity(prisma as unknown as Prisma.TransactionClient, board.id);
    return res.json({ success: true, data: safeBoard(updated, identity) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

// Retire a bench board's old role before a new factory enrollment. This is an
// explicit Admin action bound to the probed board and the exact old device ID;
// the ordinary reset flow deliberately cannot change a device's role.
router.post("/boards/:boardId/repurpose", requireRole(["ADMIN"]), async (req: ActorRequest, res: Response) => {
  try {
    const board = await adminBoard(req);
    const key = idempotencyKey(req);
    const expectedDeviceId = text(req.body?.expectedDeviceId, "expectedDeviceId", 128);
    const targetType = normalizeTarget(req.body?.targetType);
    const reason = text(req.body?.reason, "reason", 512);
    if (reason.length < 10) throw new FlashRequestError(400, "Repurpose reason must contain at least 10 characters");
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "hardware_boards" WHERE "id" = ${board.id} FOR UPDATE`;
      const currentBoard = await tx.hardwareBoard.findUnique({ where: { id: board.id } });
      if (!currentBoard || currentBoard.state !== HardwareBoardState.ACTIVE) throw new FlashRequestError(409, "HardwareBoard is not active");
      const identity = await currentBoardIdentity(tx, board.id);
      if (!identity || identity.device_id !== expectedDeviceId) throw new FlashRequestError(409, "Current board identity changed; inspect the physical board again");
      if ((targetType === FlashTargetType.GATEWAY) === (identity.type === "GATEWAY")) {
        throw new FlashRequestError(409, "Repurpose requires a different device type");
      }
      const activeJob = await tx.flashJob.findFirst({
        where: { hardware_board_id: board.id, status: { notIn: [FlashJobState.COMPLETED, FlashJobState.FAILED, FlashJobState.CANCELLED] } },
        select: { id: true },
      });
      if (activeJob) throw new FlashRequestError(409, "Finish or cancel the active FlashJob before repurposing");
      const targetDeviceType = targetType === FlashTargetType.GATEWAY ? "GATEWAY" : "SENSOR_NODE";
      const release = await resolveRelease(tx, {}, targetType, identity.hardware_revision || board.hardware_revision, defaultFirmwareTarget(targetDeviceType));
      await invalidateDeviceAccess(tx, identity.device_id, `HardwareBoard repurposed: ${reason}`);
      await tx.deviceIdentity.update({ where: { device_id: identity.device_id }, data: {
        generation_state: DeviceGenerationState.RETIRED, is_current: false,
        state: DeviceIdentityState.REVOKED, claimed_by_id: null, claimed_farm_id: null, claimed_at: null,
      } });
      const label = await tx.deviceQrLabel.findUnique({ where: { device_id: identity.device_id } });
      if (label && label.state !== DeviceQrLabelState.REVOKED) {
        await tx.deviceQrLabel.update({ where: { id: label.id }, data: { state: DeviceQrLabelState.REVOKED, revoked_at: new Date(), revoke_reason: reason } });
        await tx.deviceQrRevocation.create({ data: {
          qr_id: label.qr_id, device_id: identity.device_id, generation: identity.generation,
          canonical_payload: label.canonical_payload, signature: label.signature,
          reason, actor_type: "USER", actor_id: req.user!.id, idempotency_key: `${key}:qr`,
        } });
      }
      await tx.node.updateMany({ where: { id: identity.device_id }, data: {
        is_activated: false, online: false, owner_id: null, farm_id: null, zone_id: null, gateway_id: null,
      } });
      await auditBoard(tx, { boardId: board.id, action: "ROLE_REPURPOSED", actorType: "ADMIN", actorId: req.user!.id,
        idempotencyKey: key, reason, metadata: { oldDeviceId: identity.device_id, oldType: identity.type, targetType, releaseId: release.id } });
      return { oldDeviceId: identity.device_id, targetDeviceType, releaseId: release.id };
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.post("/boards/:boardId/reset", requireRole(["ADMIN"]), async (req: ActorRequest, res: Response) => {
  try {
    const board = await adminBoard(req);
    const identity = await currentBoardIdentity(prisma as unknown as Prisma.TransactionClient, board.id);
    if (!identity) throw new FlashRequestError(409, "HardwareBoard has no active identity to reset");
    req.body = { ...(req.body || {}), boardId: board.id, targetType: identity.type === "GATEWAY" ? "GATEWAY" : "NODE", mode: "RESET_REPROVISION" };
    return createFlashJob(req, res);
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.post("/boards/:boardId/unbind", requireRole(["ADMIN"]), async (req: ActorRequest, res: Response) => {
  try {
    const board = await adminBoard(req);
    const key = idempotencyKey(req);
    const result = await prisma.$transaction(async (tx) => {
      const previousAudit = await tx.hardwareBoardAudit.findUnique({ where: { idempotency_key: key } });
      if (previousAudit?.action === "UNBIND") {
        const current = await currentBoardIdentity(tx, board.id);
        const existingLabel = current ? await tx.deviceQrLabel.findUnique({ where: { device_id: current.device_id } }) : null;
        if (existingLabel) return existingLabel;
      }
      const identity = await currentBoardIdentity(tx, board.id);
      if (!identity) throw new FlashRequestError(409, "HardwareBoard has no active identity");
      if (identity.state !== DeviceIdentityState.READY_TO_SHIP && identity.state !== DeviceIdentityState.REVOKED) {
        const node = await tx.node.findUnique({ where: { id: identity.device_id }, select: { id: true } });
        await invalidateDeviceAccess(tx, identity.device_id, "HardwareBoard unbound by administrator");
        await tx.deviceIdentity.update({ where: { device_id: identity.device_id }, data: { claimed_by_id: null, claimed_farm_id: null, claimed_at: null, state: DeviceIdentityState.READY_TO_SHIP } });
        if (node) await tx.node.update({ where: { id: node.id }, data: { is_activated: false, owner_id: null, online: false } });
      }
      await tx.hardwareBoard.update({ where: { id: board.id }, data: { state: HardwareBoardState.UNBOUND } });
      await auditBoard(tx, { boardId: board.id, action: "UNBIND", actorType: "ADMIN", actorId: req.user!.id, idempotencyKey: key, reason: optionalText(req.body?.reason, 512) });
      return tx.deviceIdentity.findUnique({ where: { device_id: identity.device_id } });
    });
    return res.json({ success: true, data: { board: safeBoard(await prisma.hardwareBoard.findUnique({ where: { id: board.id } }), result), identity: safeIdentity(result) } });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

async function rotateIdentityKey(req: ActorRequest, res: Response, recovery: boolean) {
  try {
    const board = await adminBoard(req);
    const key = idempotencyKey(req);
    const enrollment = validateEnrollmentPublicKey(req.body?.publicKey ?? req.body?.enrollmentPublicKey);
    const result = await prisma.$transaction(async (tx) => {
      const previousAudit = await tx.hardwareBoardAudit.findUnique({ where: { idempotency_key: key } });
      const identity = await currentBoardIdentity(tx, board.id);
      if (!identity) throw new FlashRequestError(409, "HardwareBoard has no active identity");
      if (previousAudit && (previousAudit.action === "IDENTITY_RECOVERY" || previousAudit.action === "KEY_ROTATED")) return identity;
      if (identity.public_key_fingerprint) {
        await tx.deviceIdentityKeyRevocation.upsert({ where: { idempotency_key: `${key}:old-key` }, update: {}, create: {
          device_id: identity.device_id,
          generation: identity.generation,
          key_version: identity.identity_key_version,
          public_key_fingerprint: identity.public_key_fingerprint,
          public_key_algorithm: identity.public_key_algorithm,
          reason: recovery ? "Identity recovery replaced key binding" : "Administrator rotated key binding",
          actor_type: "ADMIN",
          actor_id: req.user!.id,
          idempotency_key: `${key}:old-key`,
        } });
      }
      await invalidateDeviceAccess(tx, identity.device_id, recovery ? "Identity recovery replaced key binding" : "Administrator rotated key binding");
      const updated = await tx.deviceIdentity.update({ where: { device_id: identity.device_id }, data: {
        public_key: enrollment.value,
        public_key_algorithm: enrollment.algorithm,
        public_key_fingerprint: enrollment.fingerprint,
        identity_key_version: { increment: 1 },
        key_rotated_at: new Date(),
      } });
      await tx.hardwareBoard.update({ where: { id: board.id }, data: { state: HardwareBoardState.ACTIVE, block_reason: null, blocked_at: null } });
      await auditBoard(tx, { boardId: board.id, action: recovery ? "IDENTITY_RECOVERY" : "KEY_ROTATED", actorType: "ADMIN", actorId: req.user!.id, idempotencyKey: key, metadata: { deviceId: identity.device_id, newKeyFingerprint: enrollment.fingerprint, oldKeyFingerprint: identity.public_key_fingerprint } });
      return updated;
    });
    return res.json({ success: true, data: safeIdentity(result) });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/boards/:boardId/rotate-key", requireRole(["ADMIN"]), (req: ActorRequest, res: Response) => rotateIdentityKey(req, res, false));
router.post("/boards/:boardId/recover", requireRole(["ADMIN"]), (req: ActorRequest, res: Response) => rotateIdentityKey(req, res, true));
router.post("/boards/:boardId/identity-recovery", requireRole(["ADMIN"]), (req: ActorRequest, res: Response) => rotateIdentityKey(req, res, true));

// Explicitly replace a pre-HardwareBoard legacy placeholder with the HMAC
// board resolved from factory material. The old placeholder is retained as an
// UNBOUND audit record; it is never deleted or silently treated as factory
// proof.
router.post("/boards/:boardId/rebind", requireRole(["ADMIN"]), async (req: ActorRequest, res: Response) => {
  try {
    const oldBoard = await adminBoard(req);
    const key = idempotencyKey(req);
    const material = materialFromBody(req.body || {});
    if (!material) throw new FlashRequestError(400, "Factory board material is required for legacy rebind");
    const result = await prisma.$transaction(async (tx) => {
      const target = await resolveHardwareBoard(tx, material);
      const previousAudit = await tx.hardwareBoardAudit.findUnique({ where: { idempotency_key: `${key}:legacy` } });
      if (previousAudit) return { target, identity: await currentBoardIdentity(tx, target.id) };
      if (target.id === oldBoard.id) return { target, identity: await currentBoardIdentity(tx, target.id) };
      const sourceIdentity = await currentBoardIdentity(tx, oldBoard.id);
      const targetIdentity = await currentBoardIdentity(tx, target.id);
      if (!sourceIdentity) throw new FlashRequestError(409, "Legacy HardwareBoard has no active identity");
      if (targetIdentity) throw new FlashRequestError(409, "Resolved HardwareBoard already has an active identity");
      await tx.deviceIdentity.update({ where: { device_id: sourceIdentity.device_id }, data: { hardware_board_id: target.id } });
      await tx.hardwareBoard.update({ where: { id: oldBoard.id }, data: { state: HardwareBoardState.UNBOUND, block_reason: "Rebound to factory HMAC HardwareBoard" } });
      await tx.hardwareBoard.update({ where: { id: target.id }, data: { state: HardwareBoardState.ACTIVE } });
      await auditBoard(tx, { boardId: oldBoard.id, action: "LEGACY_REBOUND", actorType: "ADMIN", actorId: req.user!.id, idempotencyKey: `${key}:legacy`, metadata: { targetBoardId: target.id, deviceId: sourceIdentity.device_id } });
      await auditBoard(tx, { boardId: target.id, action: "LEGACY_REBOUND_TARGET", actorType: "ADMIN", actorId: req.user!.id, idempotencyKey: `${key}:target`, metadata: { sourceBoardId: oldBoard.id, deviceId: sourceIdentity.device_id } });
      return { target, identity: await tx.deviceIdentity.findUnique({ where: { device_id: sourceIdentity.device_id } }) };
    });
    return res.json({ success: true, data: { board: safeBoard(result.target, result.identity), identity: safeIdentity(result.identity) } });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.post("/boards/:boardId/reissue-qr", requireRole(["ADMIN"]), async (req: ActorRequest, res: Response) => {
  try {
    const board = await adminBoard(req);
    const key = idempotencyKey(req);
    const result = await prisma.$transaction(async (tx) => {
      const identity = await currentBoardIdentity(tx, board.id);
      if (!identity) throw new FlashRequestError(409, "HardwareBoard has no active identity");
      const previous = await tx.deviceQrLabel.findUnique({ where: { device_id: identity.device_id } });
      const priorAudit = await tx.hardwareBoardAudit.findUnique({ where: { idempotency_key: key } });
      if ((priorAudit?.action === "QR_REISSUED" || priorAudit?.action === "QR_ISSUED") && previous) return previous;
      const qr = qrForIdentity(identity);
      if (previous) {
        await tx.deviceQrLabel.update({ where: { id: previous.id }, data: { state: DeviceQrLabelState.REVOKED, revoked_at: new Date(), revoke_reason: revocationReason(req.body) } });
        await tx.deviceQrRevocation.upsert({ where: { idempotency_key: `${key}:old-qr` }, update: {}, create: {
          qr_id: previous.qr_id,
          device_id: identity.device_id,
          generation: identity.generation,
          canonical_payload: previous.canonical_payload,
          signature: previous.signature,
          replacement_qr_id: qr.qrId,
          reason: revocationReason(req.body),
          actor_type: "ADMIN",
          actor_id: req.user!.id,
          idempotency_key: `${key}:old-qr`,
        } });
        const replacement = await tx.deviceQrLabel.update({ where: { id: previous.id }, data: {
          qr_id: qr.qrId,
          canonical_payload: qr.canonicalPayload,
          signature: qr.signature,
          issuer: qr.issuer,
          kid: qr.kid,
          state: DeviceQrLabelState.ISSUED,
          printed_at: null,
          printed_by_id: null,
          reprint_count: 0,
          revoked_at: null,
          revoke_reason: null,
        } });
        await auditBoard(tx, { boardId: board.id, action: "QR_REISSUED", actorType: "ADMIN", actorId: req.user!.id, idempotencyKey: key, metadata: { deviceId: identity.device_id, oldQrId: previous.qr_id, newQrId: replacement.qr_id } });
        return replacement;
      }
      const created = await tx.deviceQrLabel.create({ data: { qr_id: qr.qrId, device_id: identity.device_id, version: 3, issuer: qr.issuer, kid: qr.kid, canonical_payload: qr.canonicalPayload, signature: qr.signature, state: DeviceQrLabelState.ISSUED } });
      await auditBoard(tx, { boardId: board.id, action: "QR_ISSUED", actorType: "ADMIN", actorId: req.user!.id, idempotencyKey: key, metadata: { deviceId: identity.device_id, newQrId: created.qr_id } });
      return created;
    });
    return res.json({ success: true, data: { qrId: result.qr_id, version: result.version, state: result.state, payload: { ...JSON.parse(result.canonical_payload), sig: result.signature } } });
  } catch (error) {
    const failure = errorResponse(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

export default router;
