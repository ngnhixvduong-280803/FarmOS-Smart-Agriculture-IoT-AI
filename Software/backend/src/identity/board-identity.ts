import crypto from "node:crypto";
import {
  DeviceGenerationState,
  DeviceIdentityState,
  FlashJobMode,
  FlashJobState,
  HardwareBoardState,
  Prisma,
} from "@prisma/client";
import { env } from "../config/env";
import {
  canonicalizeQrV3,
  devicePublicKey,
  publicKeyFingerprint,
  qrIssuer,
  qrKeyId,
  signQrV3,
  storedPublicKeyAlgorithm,
} from "../manufacturing/qr";
import { hashDeviceSecret } from "../security/device-secrets";

/**
 * Factory material is accepted only for the duration of board resolution.
 * `factoryEfuseMac` and `chipIdentity` are never returned from this module or
 * written to Prisma. The only durable board identity is the keyed digest.
 */
export interface FactoryBoardMaterial {
  chipFamily: string;
  factoryEfuseMac?: string;
  chipIdentity?: string;
  hardwareRevision?: string;
}

export interface NormalizedFactoryBoardMaterial {
  chipFamily: string;
  factoryEfuseMac: string;
  chipIdentity: string;
  hardwareRevision: string;
}

export const BOARD_KEY_VERSION = "hardware-board-hmac-v1";
const CHIP_FAMILY_PATTERN = /^[A-Z][A-Z0-9_.-]{0,63}$/;
const HEX_PATTERN = /^[a-f0-9]+$/;

export function normalizeChipFamily(value: unknown): string {
  const result = String(value ?? "").trim().toUpperCase();
  if (!CHIP_FAMILY_PATTERN.test(result)) {
    throw new Error("chipFamily must contain only uppercase hardware family characters");
  }
  return result;
}

function normalizeChipIdentity(value: unknown): string {
  const result = String(value ?? "").trim();
  if (result.length > 256 || (result && !/^[\x20-\x7e]+$/.test(result))) {
    throw new Error("chipIdentity must be printable and at most 256 characters");
  }
  return result;
}

function normalizeHardwareRevision(value: unknown): string {
  const result = String(value ?? "").trim().toUpperCase();
  if (!result) return "";
  if (!/^[A-Z0-9][A-Z0-9_.-]{0,63}$/.test(result)) throw new Error("hardwareRevision is invalid");
  return result;
}

function normalizeEfuseMac(value: unknown): string {
  const result = String(value ?? "").trim().toLowerCase().replace(/[:-]/g, "");
  if (!result) return "";
  // ESP eFuse MACs are normally 48 bits; permit 64-bit factory identities for
  // chips that expose a longer globally unique identity, but never accept an
  // unbounded opaque value.
  if (![12, 16].includes(result.length) || !HEX_PATTERN.test(result)) {
    throw new Error("factoryEfuseMac must be a 48-bit or 64-bit hexadecimal identity");
  }
  return result;
}

export function normalizeFactoryBoardMaterial(input: FactoryBoardMaterial): NormalizedFactoryBoardMaterial {
  const chipFamily = normalizeChipFamily(input.chipFamily);
  const factoryEfuseMac = normalizeEfuseMac(input.factoryEfuseMac);
  const chipIdentity = normalizeChipIdentity(input.chipIdentity);
  const hardwareRevision = normalizeHardwareRevision(input.hardwareRevision);
  if (!factoryEfuseMac && !chipIdentity) {
    throw new Error("factoryEfuseMac or chipIdentity is required");
  }
  return { chipFamily, factoryEfuseMac, chipIdentity, hardwareRevision };
}

/** Return the opaque, server-only HardwareBoard key. */
export function hardwareBoardKey(input: FactoryBoardMaterial, secret = env.HARDWARE_BOARD_HMAC_SECRET): string {
  const normalized = normalizeFactoryBoardMaterial(input);
  return crypto.createHmac("sha256", secret)
    .update(`${BOARD_KEY_VERSION}\0${normalized.chipFamily}\0${normalized.factoryEfuseMac}\0${normalized.chipIdentity}`, "utf8")
    .digest("hex");
}

/**
 * Compatibility mapping for rows created before factory board material was
 * collected. This is explicitly marked as legacy and must not be presented as
 * proof of an eFuse identity. A later factory resolve creates/rebinds the real
 * HMAC board and retires this placeholder through an audited admin flow.
 */
export function legacyHardwareBoardKey(deviceId: string, secret = env.HARDWARE_BOARD_HMAC_SECRET): string {
  const normalized = String(deviceId ?? "").trim();
  if (!normalized || normalized.length > 128) throw new Error("deviceId is required for legacy board mapping");
  return crypto.createHmac("sha256", secret).update(`legacy-board-v1\0${normalized}`, "utf8").digest("hex");
}

export function publicBoardReference(boardId: string): string {
  // A UUID/opaque database id is safe to expose; board_key and all factory
  // material remain server-only.
  return `HB-${String(boardId).replace(/[^a-zA-Z0-9-]/g, "")}`;
}

export const FLASH_TERMINAL_STATES = new Set<FlashJobState>([
  FlashJobState.COMPLETED,
  FlashJobState.FAILED,
  FlashJobState.CANCELLED,
]);

const FLASH_TRANSITIONS: Record<FlashJobState, FlashJobState[]> = {
  [FlashJobState.CREATED]: [FlashJobState.BOARD_RESOLVED, FlashJobState.FAILED, FlashJobState.CANCELLED],
  [FlashJobState.BOARD_RESOLVED]: [FlashJobState.MANIFEST_READY, FlashJobState.FAILED, FlashJobState.CANCELLED],
  [FlashJobState.MANIFEST_READY]: [FlashJobState.ENROLLMENT_ISSUED, FlashJobState.FAILED, FlashJobState.CANCELLED],
  [FlashJobState.ENROLLMENT_ISSUED]: [FlashJobState.FLASHING, FlashJobState.FAILED, FlashJobState.CANCELLED],
  [FlashJobState.FLASHING]: [FlashJobState.READBACK_VERIFIED, FlashJobState.COMPLETED, FlashJobState.FAILED, FlashJobState.CANCELLED],
  [FlashJobState.READBACK_VERIFIED]: [FlashJobState.COMPLETED, FlashJobState.FAILED, FlashJobState.CANCELLED],
  [FlashJobState.COMPLETED]: [],
  [FlashJobState.FAILED]: [FlashJobState.BOARD_RESOLVED, FlashJobState.CANCELLED],
  [FlashJobState.CANCELLED]: [],
};

export function canTransitionFlashJob(current: FlashJobState, next: FlashJobState): boolean {
  return current === next || (FLASH_TRANSITIONS[current] || []).includes(next);
}

export function assertFlashTransition(current: FlashJobState, next: FlashJobState): void {
  if (!canTransitionFlashJob(current, next)) {
    throw new Error(`Invalid flash job transition ${current} -> ${next}`);
  }
}

export const BOARD_TRANSITIONS: Record<HardwareBoardState, HardwareBoardState[]> = {
  [HardwareBoardState.ACTIVE]: [HardwareBoardState.RESET_PENDING, HardwareBoardState.BLOCKED, HardwareBoardState.UNBOUND],
  [HardwareBoardState.RESET_PENDING]: [HardwareBoardState.ACTIVE, HardwareBoardState.BLOCKED, HardwareBoardState.UNBOUND],
  [HardwareBoardState.BLOCKED]: [HardwareBoardState.ACTIVE],
  [HardwareBoardState.UNBOUND]: [HardwareBoardState.ACTIVE, HardwareBoardState.RESET_PENDING, HardwareBoardState.BLOCKED],
};

export function assertBoardTransition(current: HardwareBoardState, next: HardwareBoardState): void {
  if (current !== next && !(BOARD_TRANSITIONS[current] || []).includes(next)) {
    throw new Error(`Invalid HardwareBoard transition ${current} -> ${next}`);
  }
}

export function canonicalManifest(input: {
  id: string;
  deviceType: string;
  firmwareTarget: string;
  hardwareRevisions: string[];
  partitionScheme: string;
  version: string;
  artifactSha256: string;
  sizeBytes: number;
  flashOffset?: number;
  images?: Array<{
    id: string;
    name: string;
    address: number;
    sizeBytes: number;
    sha256: string;
    role: string;
    required: boolean;
  }>;
  writePlans?: Record<string, Array<Record<string, unknown>>>;
}): string {
  const images = input.images?.length ? input.images.map((image) => ({
    id: image.id,
    name: image.name,
    address: image.address,
    sizeBytes: image.sizeBytes,
    sha256: image.sha256,
    role: image.role,
    required: image.required,
  })) : [{
    id: input.id,
    name: `${input.id}.bin`,
    address: input.flashOffset ?? 0x20000,
    sizeBytes: input.sizeBytes,
    sha256: input.artifactSha256,
    role: "APP",
    required: true,
  }];
  return JSON.stringify({
    v: 1,
    id: input.id,
    deviceType: input.deviceType,
    firmwareTarget: input.firmwareTarget,
    hardwareRevisions: [...input.hardwareRevisions].sort(),
    partitionScheme: input.partitionScheme,
    version: input.version,
    artifactSha256: input.artifactSha256,
    sizeBytes: input.sizeBytes,
    flashOffset: input.flashOffset ?? 0x20000,
    images,
    imageSetSha256: crypto.createHash("sha256").update(JSON.stringify(images), "utf8").digest("hex"),
    ...(input.writePlans ? { writePlans: input.writePlans } : {}),
  });
}

export function manifestDigest(manifest: string): string {
  return crypto.createHash("sha256").update(manifest, "utf8").digest("hex");
}

export function signManifest(manifest: string, secret = env.FIRMWARE_MANIFEST_SIGNING_KEY || env.HARDWARE_BOARD_HMAC_SECRET): string {
  return crypto.createHmac("sha256", secret).update(`farmos-firmware-manifest-v1\0${manifest}`, "utf8").digest("base64url");
}

export function verifyManifestSignature(manifest: string, signature: string, secret = env.FIRMWARE_MANIFEST_SIGNING_KEY || env.HARDWARE_BOARD_HMAC_SECRET): boolean {
  const expected = Buffer.from(signManifest(manifest, secret), "utf8");
  const provided = Buffer.from(String(signature || ""), "utf8");
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

const ENROLLMENT_HARDWARE_DOMAIN = "farmos-enrollment-hardware-v1";

function enrollmentLengthPrefix(value: Buffer): Buffer {
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

function decodeEnrollmentNonce(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 128) {
    throw new Error("serial enrollment nonce must be unpadded base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length < 16 || decoded.length > 32) throw new Error("serial enrollment nonce must be 16-32 bytes");
  return decoded;
}

/**
 * Exact firmware hardware-proof transcript. The MAC is consumed only for this
 * comparison and is never returned or persisted by the backend.
 */
export function hardwareProofForEnrollment(input: { chipFamily: string; factoryEfuseMac: string; nonce: string }): string {
  const chipFamily = normalizeChipFamily(input.chipFamily);
  const mac = normalizeEfuseMac(input.factoryEfuseMac);
  if (mac.length !== 12) throw new Error("firmware hardware proof requires a 48-bit eFuse MAC");
  const nonce = decodeEnrollmentNonce(String(input.nonce || ""));
  const domain = Buffer.from(ENROLLMENT_HARDWARE_DOMAIN, "utf8");
  const family = Buffer.from(chipFamily, "utf8");
  const rawMac = Buffer.from(mac, "hex");
  return crypto.createHash("sha256")
    .update(Buffer.concat([enrollmentLengthPrefix(domain), enrollmentLengthPrefix(family), enrollmentLengthPrefix(rawMac), enrollmentLengthPrefix(nonce)]))
    .digest("hex");
}

export interface EnrollmentTicketFields {
  deviceId: string;
  firmwareTarget: string;
  generation: number;
  hardwareProof: string;
  hardwareRevision: string;
  identityVersion: number;
  model: string;
  nonce: string;
  operation: "ENROLL" | "ROTATE_KEY" | "RECOVER" | "REFLASH";
  physicalSerial: boolean;
  publicKeyFingerprint: string;
  currentPublicKeyFingerprint?: string;
  radioId?: number;
  role: "NODE" | "GATEWAY";
  serial: string;
  ticketId: string;
  ttlMs: number;
  expiresAt?: number;
}

/** Keep object insertion order aligned with firmware's cJSON ticket vector. */
export function canonicalEnrollmentTicketPayload(fields: EnrollmentTicketFields): string {
  const payload: Record<string, unknown> = {
    deviceId: fields.deviceId,
    firmwareTarget: fields.firmwareTarget,
    generation: fields.generation,
    hardwareProof: fields.hardwareProof,
    hardwareRevision: fields.hardwareRevision,
    identityVersion: fields.identityVersion,
    model: fields.model,
    nonce: fields.nonce,
    operation: fields.operation,
    physicalSerial: fields.physicalSerial,
    // This field is required by serial_enrollment.cpp even though the
    // protocol currently has only one ticket version. Keep it in the
    // canonical object (and in this exact order) so the decoded bytes match
    // the manufacturing vector.
    protocolVersion: 1,
    publicKeyFingerprint: fields.publicKeyFingerprint,
  };
  if (fields.currentPublicKeyFingerprint) payload.currentPublicKeyFingerprint = fields.currentPublicKeyFingerprint;
  if (fields.radioId !== undefined) payload.radioId = fields.radioId;
  payload.role = fields.role;
  payload.serial = fields.serial;
  payload.ticketId = fields.ticketId;
  payload.ttlMs = fields.ttlMs;
  if (fields.expiresAt !== undefined) payload.expiresAt = fields.expiresAt;
  return JSON.stringify(payload);
}

export function signEnrollmentTicket(payload: string, privateKeyPem = env.FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY): string {
  if (!privateKeyPem) throw new Error("FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY is required for serial enrollment");
  const key = crypto.createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("FIRMWARE_ENROLLMENT_SIGNING_PRIVATE_KEY must be an EC P-256 private key");
  }
  return crypto.sign("sha256", Buffer.from(payload, "utf8"), { key, dsaEncoding: "der" }).toString("base64url");
}

export function verifyEnrollmentTicketSignature(payload: string, signature: string, publicKey: string | crypto.KeyObject): boolean {
  try {
    const key = typeof publicKey === "string" ? crypto.createPublicKey(publicKey) : publicKey;
    return crypto.verify("sha256", Buffer.from(payload, "utf8"), { key, dsaEncoding: "der" }, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function challengeHash(boardId: string, jobId: string, challenge: string): string {
  return hashDeviceSecret(`flash-challenge:${boardId}:${jobId}`, challenge);
}

export function ticketHash(boardId: string, jobId: string, ticket: string): string {
  return hashDeviceSecret(`flash-ticket:${boardId}:${jobId}`, ticket);
}

/**
 * Deterministic per-request enrollment material lets a browser safely retry a
 * timed-out enrollment call with the same Idempotency-Key without storing a
 * plaintext challenge/ticket in the database. A different key intentionally
 * rotates both values before flashing starts.
 */
export function deterministicFlashSecret(kind: "challenge" | "ticket", boardId: string, jobId: string, idempotencyKey: string): string {
  return crypto.createHmac("sha256", env.HARDWARE_BOARD_HMAC_SECRET)
    .update(`farmos-flash-${kind}-v1\0${boardId}\0${jobId}\0${idempotencyKey}`, "utf8")
    .digest("base64url");
}

export function flashAttestationMessage(input: {
  boardId: string;
  jobId: string;
  releaseId: string;
  manifestSha256: string;
  readbackSha256: string;
  challenge: string;
}): string {
  return JSON.stringify({
    v: 1,
    domain: "farmos-web-serial-flash-attestation",
    boardId: input.boardId,
    jobId: input.jobId,
    releaseId: input.releaseId,
    manifestSha256: input.manifestSha256,
    readbackSha256: input.readbackSha256,
    challenge: input.challenge,
  });
}

export function verifyFlashAttestation(publicKey: string, message: string, signature: string): boolean {
  try {
    const key = devicePublicKey(publicKey);
    const decoded = Buffer.from(signature, "base64url");
    if (!decoded.length) return false;
    return key.asymmetricKeyType === "ed25519"
      ? crypto.verify(null, Buffer.from(message, "utf8"), key, decoded)
      : crypto.verify("sha256", Buffer.from(message, "utf8"), key, decoded);
  } catch {
    return false;
  }
}

export function validateEnrollmentPublicKey(raw: unknown): { value: string; algorithm: string; fingerprint: string } {
  const value = String(raw ?? "").trim();
  if (!value || value.length > 16_384) throw new Error("enrollment public key is required");
  const key = devicePublicKey(value);
  const algorithm = storedPublicKeyAlgorithm(key);
  if (!algorithm) throw new Error("enrollment public key must be Ed25519 or ECDSA P-256");
  return { value, algorithm, fingerprint: publicKeyFingerprint(value) };
}

export function generationDeviceId(type: string): string {
  const prefix = type === "GATEWAY" ? "GATEWAY" : "NODE";
  return `${prefix}_${crypto.randomInt(1, 0xffffffff).toString(10)}`;
}

export function generationSerial(prefix = "FARMOS"): string {
  return `${prefix.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 24) || "FARMOS"}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
}

export function qrForIdentity(identity: {
  device_id: string;
  serial_number: string;
  type: string;
  model: string | null;
  hardware_revision: string;
}) {
  const qrId = `QR3-${crypto.randomBytes(10).toString("hex").toUpperCase()}`;
  const unsigned = {
    v: 3 as const,
    issuer: qrIssuer(),
    qrId,
    deviceId: identity.device_id,
    serial: identity.serial_number,
    type: identity.type,
    model: identity.model || "unknown",
    hardwareRevision: identity.hardware_revision,
    kid: qrKeyId(),
  };
  const payload = signQrV3(unsigned);
  return { qrId, canonicalPayload: canonicalizeQrV3(unsigned), signature: payload.sig, issuer: payload.issuer, kid: payload.kid };
}

export async function resolveHardwareBoard(
  tx: Prisma.TransactionClient,
  material: FactoryBoardMaterial,
): Promise<Prisma.HardwareBoardGetPayload<{}>> {
  const normalized = normalizeFactoryBoardMaterial(material);
  const key = hardwareBoardKey(normalized);
  // Upsert on the keyed digest closes the find-then-create race when two
  // browser tabs discover the same physical board at once. Revision checks
  // remain after the upsert because a revision is immutable once observed.
  const board = await tx.hardwareBoard.upsert({
    where: { board_key: key },
    update: { last_seen_at: new Date() },
    create: {
        board_key: key,
        chip_family: normalized.chipFamily,
        ...(normalized.hardwareRevision ? { hardware_revision: normalized.hardwareRevision } : {}),
        identity_source: "FACTORY_EFUSE_HMAC",
        state: HardwareBoardState.ACTIVE,
        last_seen_at: new Date(),
    },
  });
  if (normalized.hardwareRevision && board.hardware_revision && board.hardware_revision !== normalized.hardwareRevision) {
    throw new Error("HardwareBoard hardware revision is immutable");
  }
  if (normalized.hardwareRevision && !board.hardware_revision) {
    return tx.hardwareBoard.update({ where: { id: board.id }, data: { hardware_revision: normalized.hardwareRevision } });
  }
  return board;
}

export async function currentBoardIdentity(tx: Prisma.TransactionClient, boardId: string) {
  return tx.deviceIdentity.findFirst({
    where: { hardware_board_id: boardId, is_current: true, generation_state: DeviceGenerationState.ACTIVE },
    orderBy: { generation: "desc" },
  });
}

export async function auditBoard(
  tx: Prisma.TransactionClient,
  input: {
    boardId: string;
    action: string;
    actorType: string;
    actorId?: string | null;
    idempotencyKey?: string | null;
    reason?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
) {
  if (input.idempotencyKey) {
    return tx.hardwareBoardAudit.upsert({
      where: { idempotency_key: input.idempotencyKey },
      update: {},
      create: {
        hardware_board_id: input.boardId,
        action: input.action,
        actor_type: input.actorType,
        actor_id: input.actorId || null,
        idempotency_key: input.idempotencyKey,
        reason: input.reason || null,
        metadata: input.metadata,
      },
    });
  }
  return tx.hardwareBoardAudit.create({
    data: {
      hardware_board_id: input.boardId,
      action: input.action,
      actor_type: input.actorType,
      actor_id: input.actorId || null,
      reason: input.reason || null,
      metadata: input.metadata,
    },
  });
}

export async function recordFlashEvent(
  tx: Prisma.TransactionClient,
  input: {
    jobId: string;
    fromState?: FlashJobState | null;
    toState: FlashJobState;
    progress?: number | null;
    actorType: string;
    actorId?: string | null;
    idempotencyKey?: string | null;
    metadata?: Prisma.InputJsonValue;
  },
) {
  const data = {
    flash_job_id: input.jobId,
    from_state: input.fromState || null,
    to_state: input.toState,
    progress: input.progress ?? null,
    actor_type: input.actorType,
    actor_id: input.actorId || null,
    idempotency_key: input.idempotencyKey || null,
    metadata: input.metadata,
  };
  if (input.idempotencyKey) {
    return tx.flashJobEvent.upsert({ where: { idempotency_key: input.idempotencyKey }, update: {}, create: data });
  }
  return tx.flashJobEvent.create({ data });
}

export function assertIdentityGenerationTransition(from: DeviceGenerationState, to: DeviceGenerationState): void {
  const allowed: Record<DeviceGenerationState, DeviceGenerationState[]> = {
    [DeviceGenerationState.PENDING]: [DeviceGenerationState.ACTIVE, DeviceGenerationState.REVOKED],
    [DeviceGenerationState.ACTIVE]: [DeviceGenerationState.RETIRED, DeviceGenerationState.REVOKED],
    [DeviceGenerationState.RETIRED]: [DeviceGenerationState.REVOKED],
    [DeviceGenerationState.REVOKED]: [],
  };
  if (from !== to && !allowed[from].includes(to)) throw new Error(`Invalid identity generation transition ${from} -> ${to}`);
}

export function identityStateForGeneration(claimed: boolean): DeviceIdentityState {
  return claimed ? DeviceIdentityState.CLAIMED : DeviceIdentityState.READY_TO_SHIP;
}

export function flashModeRequiresReset(mode: FlashJobMode): boolean {
  return mode === FlashJobMode.RESET_REPROVISION;
}
