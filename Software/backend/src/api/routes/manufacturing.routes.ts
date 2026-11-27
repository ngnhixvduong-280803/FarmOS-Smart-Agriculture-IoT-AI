import crypto from "crypto";
import { DeviceClaimSessionStatus, DeviceIdentityState, DeviceLifecycleEventType, DeviceQrLabelState, ManufacturingBatchStatus, Prisma } from "@prisma/client";
import { Request, Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import { prisma } from "../../database/prisma";
import { createOpaqueToken, hashDeviceSecret } from "../../security/device-secrets";
import { actorOf, ManufacturingRequest, requireIdempotency, requireManufacturingAuth } from "../../manufacturing/auth";
import { assertTransition, recordLifecycleEvent } from "../../manufacturing/lifecycle";
import { canonicalizeQrV3, qrIssuer, qrKeyId, qrPayloadForLabel, signQrV3, publicKeyFingerprint, devicePublicKey, isAttestationAlgorithmAllowed, storedPublicKeyAlgorithm } from "../../manufacturing/qr";
import { invalidateDeviceAccess } from "../../security/device-access";

const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: "draft-7", legacyHeaders: false }));
router.use(requireManufacturingAuth);

const ALLOWED_TYPES = new Set(["GATEWAY", "SENSOR_NODE"]);
const MAX_BATCH_QUANTITY = 100_000;

function text(value: unknown, field: string, max = 256): string {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) throw new RequestError(400, `${field} is required and must be at most ${max} characters`);
  return result;
}

function optionalText(value: unknown, max = 256): string | null {
  if (value === undefined || value === null || value === "") return null;
  const result = String(value).trim();
  if (result.length > max) throw new RequestError(400, `Value must be at most ${max} characters`);
  return result || null;
}

function positiveInteger(value: unknown, field: string, fallback?: number): number {
  const parsed = value === undefined && fallback !== undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_BATCH_QUANTITY) {
    throw new RequestError(400, `${field} must be an integer from 1 to ${MAX_BATCH_QUANTITY}`);
  }
  return parsed;
}

function requestError(error: unknown): { status: number; message: string } {
  if (error instanceof RequestError) return { status: error.status, message: error.message };
  if (error instanceof Error && error.message.includes("REVOKED identity is terminal")) return { status: 409, message: error.message };
  if (error instanceof Error && /QR signing key|QR_PUBLIC_KEYS/.test(error.message)) return { status: 503, message: "QR signing is not configured" };
  if ((error as any)?.code === "P2002") return { status: 409, message: "Manufacturing record already exists" };
  return { status: 500, message: "Internal manufacturing error" };
}

class RequestError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function actorFields(req: ManufacturingRequest) {
  const actor = actorOf(req);
  return { actor_type: actor.type, actor_id: actor.id, station_id: actor.type === "USER" ? null : actor.id };
}

function requireFactoryStation(req: ManufacturingRequest): string {
  const actor = actorOf(req);
  if (actor.type !== "STATION" && actor.type !== "MTLS") {
    throw new RequestError(403, "Factory write/readback requires a scoped station credential or mTLS identity");
  }
  return actor.id;
}

function requiredHash(value: unknown, field: string): string {
  const normalized = text(value, field, 128).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new RequestError(400, `${field} must be a SHA-256 hex digest`);
  }
  return normalized;
}

function readbackObject(body: any): any | null {
  // A readback must be an explicit second-step object. Accepting factory-write
  // fields at the top level would let a station mark an identity verified
  // without proving that the board was physically read back.
  return body?.readback && typeof body.readback === "object" && !Array.isArray(body.readback)
    ? body.readback
    : null;
}

function factoryEvidence(body: any, key: { fingerprint: string }, stationId: string) {
  const publicKeyFingerprintValue = text(body.publicKeyFingerprint ?? body.fingerprint ?? key.fingerprint, "publicKeyFingerprint", 256).toLowerCase();
  if (publicKeyFingerprintValue !== key.fingerprint) throw new RequestError(409, "Factory evidence mismatch: publicKeyFingerprint");
  const requestedStation = text(body.stationId ?? body.station, "station", 128);
  if (requestedStation !== stationId) throw new RequestError(409, "Factory evidence mismatch: station");
  return {
    factoryCfgHash: requiredHash(body.factoryCfgHash ?? body.factory_cfg_hash, "factoryCfgHash"),
    firmwareSha256: requiredHash(body.firmwareSha256 ?? body.firmware_sha256, "firmwareSha256"),
    stationId: requestedStation,
    // The station proof is a SHA-256 digest over the identity/station/image/
    // readback/artifact binding. Do not accept an opaque token here: accepting
    // one would make the manufacturing evidence fields look authoritative
    // while the backend could not compare their hash shape with readback.
    readbackProof: requiredHash(body.readbackProof ?? body.readback_proof ?? body.proof, "readbackProof"),
    publicKeyFingerprint: publicKeyFingerprintValue,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function verifyStructuredReadbackEvidence(value: unknown, identity: any, stationId: string, keyFingerprint: string): {
  factoryCfgHash: string;
  firmwareSha256: string;
  readbackProof: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError(409, "Factory readback evidence is required");
  }
  const evidence = value as Record<string, any>;
  if (evidence.evidenceVersion !== 1 || evidence.stationId !== stationId) {
    throw new RequestError(409, "Factory readback evidence version or station mismatch");
  }
  const evidenceIdentity = evidence.identity;
  if (!evidenceIdentity || evidenceIdentity.deviceId !== identity.device_id ||
      evidenceIdentity.serial !== identity.serial_number || evidenceIdentity.type !== identity.type ||
      evidenceIdentity.model !== (identity.model || "unknown") ||
      evidenceIdentity.hardwareRevision !== identity.hardware_revision ||
      evidenceIdentity.firmwareTarget !== identity.firmware_target ||
      evidenceIdentity.publicKeyFingerprint !== keyFingerprint) {
    throw new RequestError(409, "Factory readback evidence identity mismatch");
  }
  const partition = evidence.partitionProof;
  if (!partition || partition.name !== "factory_cfg" || partition.offset !== 0x620000 || partition.size !== 0x10000 || partition.matches !== true ||
      requiredHash(partition.imageSha256, "factoryCfgHash") !== requiredHash(partition.readbackSha256, "readbackSha256")) {
    throw new RequestError(409, "Factory readback partition proof is missing or does not match");
  }
  const firmware = evidence.firmware;
  if (!firmware || firmware.target !== identity.firmware_target) {
    throw new RequestError(409, "Factory readback firmware target mismatch");
  }
  const factoryCfgHash = requiredHash(partition.imageSha256, "factoryCfgHash");
  const firmwareSha256 = requiredHash(firmware.artifactSha256, "firmwareSha256");
  const readbackSha256 = requiredHash(partition.readbackSha256, "readbackSha256");
  const readbackProof = requiredHash(evidence.readbackProof, "readbackProof");
  const expectedReadbackProof = crypto.createHash("sha256").update(canonicalJson({
    deviceId: identity.device_id,
    stationId,
    factoryCfgHash,
    readbackSha256,
    firmwareSha256,
  }), "utf8").digest("hex");
  if (readbackProof !== expectedReadbackProof) throw new RequestError(409, "Factory readback proof is invalid");
  const suppliedDigest = requiredHash(evidence.evidenceSha256, "evidenceSha256");
  const withoutDigest = { ...evidence };
  delete withoutDigest.evidenceSha256;
  const expectedDigest = crypto.createHash("sha256").update(canonicalJson(withoutDigest), "utf8").digest("hex");
  if (suppliedDigest !== expectedDigest) throw new RequestError(409, "Factory readback evidence digest is invalid");
  return { factoryCfgHash, firmwareSha256, readbackProof };
}

function validateNumericDeviceId(value: string, type: string): string {
  const prefix = type === "GATEWAY" ? "GATEWAY" : "NODE";
  const match = new RegExp(`^${prefix}_[0-9]+$`).exec(value);
  if (!match) throw new RequestError(400, `${type} deviceId must use ${prefix}_<numeric-radio-id>`);
  const suffix = value.slice(prefix.length + 1);
  try {
    const numeric = BigInt(suffix);
    if (numeric < 1n || numeric > 0xffffffffn) throw new Error("out of range");
  } catch {
    throw new RequestError(400, `${type} deviceId must use a non-zero uint32 numeric suffix`);
  }
  return value;
}

export function generatedFactoryDeviceId(type: string): string {
  // The manufacturing CLI and firmware use decimal radio IDs for both
  // prefixes. Keeping the allocator numeric prevents a gateway generated in
  // the admin API from being rejected by the station/firmware parser.
  const prefix = type === "GATEWAY" ? "GATEWAY" : "NODE";
  return `${prefix}_${crypto.randomInt(1, 0xffffffff).toString(10)}`;
}

function safeIdentity(identity: any) {
  return {
    deviceId: identity.device_id,
    serial: identity.serial_number,
    type: identity.type,
    model: identity.model,
    hardwareRevision: identity.hardware_revision,
    firmwareTarget: identity.firmware_target,
    partitionScheme: identity.partition_scheme,
    bootloaderVersion: identity.bootloader_version,
    capabilities: identity.capabilities,
    state: identity.state,
    batchId: identity.batch_id,
    publicKeyAlgorithm: identity.public_key_algorithm,
    publicKeyFingerprint: identity.public_key_fingerprint,
    identityVersion: identity.identity_version,
    factoryCfgHash: identity.factory_cfg_hash,
    factoryFirmwareSha256: identity.factory_firmware_sha256,
    factoryStationId: identity.factory_station_id,
    factoryWrittenAt: identity.factory_written_at,
    factoryVerifiedAt: identity.factory_verified_at,
    createdAt: identity.created_at,
    updatedAt: identity.updated_at,
  };
}

function safeLabel(label: any) {
  let payload: unknown = null;
  try {
    payload = qrPayloadForLabel(label);
  } catch {
    // Do not make a corrupted label response disclose its stored signature or
    // private manufacturing material.
  }
  return {
    qrId: label.qr_id,
    version: label.version,
    state: label.state,
    deviceId: label.device_id,
    batchId: label.batch_id,
    issuer: label.issuer,
    kid: label.kid,
    payload,
    printedAt: label.printed_at,
    printedById: label.printed_by_id,
    reprintCount: label.reprint_count,
    revokedAt: label.revoked_at,
    revokeReason: label.revoke_reason,
    createdAt: label.created_at,
    updatedAt: label.updated_at,
  };
}

function metadata(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    JSON.stringify(value);
    return value as Prisma.InputJsonValue;
  } catch {
    throw new RequestError(400, "metadata must be JSON serializable");
  }
}

async function duplicateResult(req: ManufacturingRequest) {
  const key = req.idempotencyKey;
  if (!key) return null;
  const event = await prisma.deviceLifecycleEvent.findUnique({ where: { idempotency_key: key } });
  if (!event) return null;
  if (event.batch_id) {
    const batch = await prisma.manufacturingBatch.findUnique({ where: { id: event.batch_id }, include: { identities: true } });
    return batch ? { kind: "batch", batch } : null;
  }
  if (event.qr_label_id) {
    const label = await prisma.deviceQrLabel.findUnique({ where: { id: event.qr_label_id }, include: { device: true } });
    return label ? { kind: "label", label } : null;
  }
  if (event.device_id) {
    const identity = await prisma.deviceIdentity.findUnique({ where: { device_id: event.device_id } });
    return identity ? { kind: "identity", identity } : null;
  }
  return null;
}

function batchResponse(batch: any) {
  return {
    id: batch.id,
    batchNumber: batch.batch_number,
    model: batch.model,
    type: batch.type,
    hardwareRevision: batch.hardware_revision,
    firmwareTarget: batch.firmware_target,
    quantity: batch.quantity,
    status: batch.status,
    metadata: batch.metadata,
    createdById: batch.created_by_id,
    createdAt: batch.created_at,
    updatedAt: batch.updated_at,
    identities: Array.isArray(batch.identities) ? batch.identities.map(safeIdentity) : undefined,
  };
}

function ensureBatchType(value: unknown): string {
  const type = text(value, "type", 64).toUpperCase();
  if (!ALLOWED_TYPES.has(type)) throw new RequestError(400, "type must be GATEWAY or SENSOR_NODE");
  return type;
}

async function findBatch(batchId: string) {
  const batch = await prisma.manufacturingBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new RequestError(404, "Manufacturing batch not found");
  return batch;
}

async function findIdentity(deviceId: string) {
  const identity = await prisma.deviceIdentity.findUnique({ where: { device_id: deviceId } });
  if (!identity) throw new RequestError(404, "Device identity not found");
  return identity;
}

function validatePublicKey(value: unknown, firmwareTarget?: string): { value: string; fingerprint: string; algorithm: string } {
  const raw = text(value, "publicKey", 16_384);
  try {
    // Parsing rejects arbitrary/non-signing key material while accepting the
    // Ed25519/RSA/EC formats emitted by supported factory stations.
    const parsed = devicePublicKey(raw);
    if (firmwareTarget && !isAttestationAlgorithmAllowed(raw, firmwareTarget)) {
      throw new RequestError(400, `publicKey algorithm does not match firmware target ${firmwareTarget}`);
    }
    const algorithm = storedPublicKeyAlgorithm(parsed);
    if (!algorithm) throw new RequestError(400, "publicKey must be an Ed25519 or ECDSA P-256 attestation key");
    return { value: raw, fingerprint: publicKeyFingerprint(raw), algorithm };
  } catch {
    throw new RequestError(400, "publicKey must be a valid device public key (Ed25519 or ECDSA P-256)");
  }
}

async function createAudit(
  tx: Prisma.TransactionClient,
  req: ManufacturingRequest,
  data: Omit<Parameters<typeof recordLifecycleEvent>[1], "actorType" | "actorId" | "stationId">,
) {
  const actor = actorFields(req);
  return recordLifecycleEvent(tx, {
    ...data,
    actorType: actor.actor_type,
    actorId: actor.actor_id,
    stationId: actor.station_id,
  });
}

// POST /api/v1/manufacturing/batches
router.post("/batches", requireIdempotency, async (req: ManufacturingRequest, res: Response) => {
  try {
    const duplicate = await duplicateResult(req);
    if (duplicate?.kind === "batch") return res.status(200).json({ success: true, idempotent: true, data: batchResponse(duplicate.batch) });
    const batchNumber = text(req.body.batchNumber ?? req.body.batch_number, "batchNumber", 128);
    const model = text(req.body.model, "model", 128);
    const type = ensureBatchType(req.body.type);
    const hardwareRevision = text(req.body.hardwareRevision ?? req.body.hardware_revision, "hardwareRevision", 64);
    const quantity = positiveInteger(req.body.quantity, "quantity");
    const firmwareTarget = optionalText(req.body.firmwareTarget ?? req.body.firmware_target, 128);
    const created = await prisma.$transaction(async (tx) => {
      const batch = await tx.manufacturingBatch.create({ data: {
        batch_number: batchNumber,
        model,
        type,
        hardware_revision: hardwareRevision,
        firmware_target: firmwareTarget,
        quantity,
        status: ManufacturingBatchStatus.DRAFT,
        metadata: metadata(req.body.metadata),
        created_by_id: actorOf(req).id,
      } });
      await createAudit(tx, req, {
        batchId: batch.id,
        eventType: DeviceLifecycleEventType.IDENTITY_ALLOCATED,
        idempotencyKey: req.idempotencyKey,
        metadata: { operation: "BATCH_CREATED", batchNumber, quantity },
      });
      return batch;
    });
    return res.status(201).json({ success: true, data: batchResponse(created) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

// GET /api/v1/manufacturing/batches
router.get("/batches", async (req: ManufacturingRequest, res: Response) => {
  try {
    const status = req.query.status ? String(req.query.status).toUpperCase() as ManufacturingBatchStatus : undefined;
    if (status && !Object.values(ManufacturingBatchStatus).includes(status)) throw new RequestError(400, "Invalid batch status");
    const batches = await prisma.manufacturingBatch.findMany({
      where: { ...(status ? { status } : {}) },
      include: { identities: { select: { device_id: true, serial_number: true, type: true, model: true, hardware_revision: true, state: true, batch_id: true, public_key_algorithm: true, public_key_fingerprint: true, factory_written_at: true, factory_verified_at: true, firmware_target: true, partition_scheme: true, bootloader_version: true, capabilities: true, claimed_by_id: true, claimed_farm_id: true, claimed_at: true, created_at: true, updated_at: true } } },
      orderBy: { created_at: "desc" },
    });
    return res.json({ success: true, count: batches.length, data: batches.map(batchResponse) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

router.get("/batches/:batchId", async (req: ManufacturingRequest, res: Response) => {
  try {
    const batch = await prisma.manufacturingBatch.findUnique({ where: { id: req.params.batchId }, include: { identities: true, qr_labels: true } });
    if (!batch) throw new RequestError(404, "Manufacturing batch not found");
    return res.json({ success: true, data: { ...batchResponse(batch), labels: batch.qr_labels.map(safeLabel) } });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

// Allocate immutable identities. The generated claim code is returned only to
// a scoped station credential, never to the admin UI or a normal user session.
async function allocateIdentities(req: ManufacturingRequest, res: Response) {
  try {
    const duplicate = await duplicateResult(req);
    if (duplicate?.kind === "batch") return res.status(200).json({ success: true, idempotent: true, data: batchResponse(duplicate.batch) });
    const batch = await findBatch(req.params.batchId);
    if (batch.status === ManufacturingBatchStatus.CANCELLED || batch.status === ManufacturingBatchStatus.QUARANTINED) {
      throw new RequestError(409, `Batch is ${batch.status}`);
    }
    const requestedEntries = Array.isArray(req.body.identities) ? req.body.identities : [];
    const quantity = requestedEntries.length || positiveInteger(req.body.quantity, "quantity", batch.quantity);
    const existingCount = await prisma.deviceIdentity.count({ where: { batch_id: batch.id } });
    if (existingCount + quantity > batch.quantity) throw new RequestError(409, "Allocation exceeds batch quantity");
    const prefix = optionalText(req.body.serialPrefix, 64) || batch.batch_number;
    const start = Number.isInteger(Number(req.body.start)) && Number(req.body.start) > 0 ? Number(req.body.start) : existingCount + 1;
    const generatedSecrets = new Map<string, string>();
    const now = new Date();
    const identities = await prisma.$transaction(async (tx) => {
      const created = [] as any[];
      for (let index = 0; index < quantity; index += 1) {
        const entry = requestedEntries[index] || {};
        const type = entry.type ? ensureBatchType(entry.type) : batch.type;
        if (type !== batch.type) throw new RequestError(400, "Identity type must match batch type");
        // Keep generated IDs compatible with the production firmware identity
        // parser. Gateway IDs are GATEWAY_*; Node IDs carry the decimal radio
        // assignment as NODE_<radio_id>. Stations may still supply an exact
        // factory-assigned ID through entry.deviceId.
        const generatedDeviceId = generatedFactoryDeviceId(type);
        const deviceId = optionalText(entry.deviceId, 128) || generatedDeviceId;
        validateNumericDeviceId(deviceId, type);
        const serial = optionalText(entry.serial ?? entry.serialNumber, 128) || `${prefix}-${String(start + index).padStart(6, "0")}`;
        const claimCode = optionalText(entry.claimCode, 256) || createOpaqueToken(18);
        generatedSecrets.set(deviceId, claimCode);
        const identity = await tx.deviceIdentity.create({ data: {
          device_id: deviceId,
          serial_number: serial,
          type,
          capabilities: (Array.isArray(entry.capabilities) ? [...new Set(entry.capabilities.map(String).map((value: string) => value.trim().toUpperCase()).filter(Boolean))] : type === "GATEWAY" ? ["WIFI", "LORA", "GATEWAY", "LOCAL_SENSOR"] : ["WIFI", "LORA", "SENSOR_DS18B20"]) as string[],
          firmware_target: optionalText(entry.firmwareTarget, 128) || batch.firmware_target || (type === "GATEWAY" ? "ESP32S3_LORA_GATEWAY_V1" : "ESP32S3_LORA_SENSOR_V1"),
          hardware_revision: optionalText(entry.hardwareRevision, 64) || batch.hardware_revision,
          partition_scheme: optionalText(entry.partitionScheme, 128) || "FARMOS_16M_V1",
          bootloader_version: optionalText(entry.bootloaderVersion, 128),
          model: optionalText(entry.model, 128) || batch.model,
          ble_name: optionalText(entry.bleName, 128),
          claim_code_hash: hashDeviceSecret(`claim:${deviceId}`, claimCode),
          state: DeviceIdentityState.ALLOCATED,
          identity_version: 3,
          batch_id: batch.id,
        } });
        await createAudit(tx, req, {
          deviceId,
          batchId: batch.id,
          eventType: DeviceLifecycleEventType.IDENTITY_ALLOCATED,
          fromState: DeviceIdentityState.INVENTORY,
          toState: DeviceIdentityState.ALLOCATED,
          metadata: { serial, type },
        });
        created.push(identity);
      }
      // Allocation is inventory bookkeeping, not a quality/release decision.
      // Never mark a batch COMPLETE merely because its quantity was allocated.
      await tx.manufacturingBatch.update({ where: { id: batch.id }, data: { status: ManufacturingBatchStatus.IN_PROGRESS } });
      await createAudit(tx, req, {
        batchId: batch.id,
        eventType: DeviceLifecycleEventType.IDENTITY_ALLOCATED,
        idempotencyKey: req.idempotencyKey,
        metadata: { operation: "IDENTITIES_ALLOCATED", deviceIds: created.map((identity) => identity.device_id) },
      });
      return created;
    });
    const stationSecrets = actorOf(req).type === "STATION" ? identities.map((identity) => ({ deviceId: identity.device_id, claimCode: generatedSecrets.get(identity.device_id) })) : undefined;
    return res.status(201).json({ success: true, data: { batchId: batch.id, identities: identities.map(safeIdentity), ...(stationSecrets ? { stationProvisioning: stationSecrets } : {}) } });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/batches/:batchId/allocate", requireIdempotency, allocateIdentities);
router.post("/batches/:batchId/allocate-identities", requireIdempotency, allocateIdentities);
router.post("/batches/:batchId/identities/allocate", requireIdempotency, allocateIdentities);

async function factoryWritten(req: ManufacturingRequest, res: Response) {
  try {
    const stationId = requireFactoryStation(req);
    const batch = await findBatch(req.params.batchId);
    const deviceId = text(req.body.deviceId, "deviceId", 128);
    const identity = await findIdentity(deviceId);
    if (identity.batch_id !== batch.id) throw new RequestError(404, "Device is not in this batch");
    if (identity.state === DeviceIdentityState.REVOKED) throw new RequestError(409, "REVOKED identity is terminal");
    if (identity.identity_version < 3) throw new RequestError(409, "Legacy identity cannot enter QR v3 manufacturing");
    validateNumericDeviceId(deviceId, identity.type);
    if (identity.state !== DeviceIdentityState.ALLOCATED && identity.state !== DeviceIdentityState.FACTORY_WRITTEN) {
      throw new RequestError(409, `Factory write is not valid from ${identity.state}`);
    }
    const key = validatePublicKey(req.body.publicKey ?? req.body.devicePublicKey, identity.firmware_target);
    const evidenceFields = ["publicKeyFingerprint", "fingerprint", "factoryCfgHash", "factory_cfg_hash",
      "firmwareSha256", "firmware_sha256", "stationId", "station", "readbackProof", "readback_proof", "proof"];
    if (evidenceFields.some((field) => req.body[field] !== undefined)) {
      // Factory-write is allowed to register the key before the strict
      // readback transition, but any evidence fields supplied by a station
      // must already use the exact API names/hash format. Persistence of the
      // hashes/proof remains the responsibility of factory-readback below.
      factoryEvidence(req.body, key, stationId);
    }
    const claimCode = optionalText(req.body.claimCode, 256);
    if (identity.state === DeviceIdentityState.FACTORY_WRITTEN &&
        (identity.public_key_fingerprint !== key.fingerprint ||
         (claimCode && identity.claim_code_hash !== hashDeviceSecret(`claim:${deviceId}`, claimCode)))) {
      throw new RequestError(409, "Factory write conflicts with existing evidence");
    }
    const updated = await prisma.$transaction(async (tx) => {
      const value = await tx.deviceIdentity.update({ where: { device_id: deviceId }, data: {
        public_key: key.value,
        public_key_algorithm: key.algorithm,
        public_key_fingerprint: key.fingerprint,
        factory_written_at: identity.factory_written_at || new Date(),
        ...(claimCode ? { claim_code_hash: hashDeviceSecret(`claim:${deviceId}`, claimCode) } : {}),
        state: DeviceIdentityState.FACTORY_WRITTEN,
      } });
      await createAudit(tx, req, {
        deviceId,
        batchId: batch.id,
        eventType: DeviceLifecycleEventType.FACTORY_WRITTEN,
        fromState: identity.state,
        toState: DeviceIdentityState.FACTORY_WRITTEN,
        idempotencyKey: req.idempotencyKey,
        metadata: {
          publicKeyFingerprint: key.fingerprint,
          publicKeyAlgorithm: key.algorithm,
          readbackEvidenceRequired: true,
        },
      });
      return value;
    });
    return res.json({ success: true, data: safeIdentity(updated) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/batches/:batchId/factory-written", requireIdempotency, factoryWritten);
router.post("/batches/:batchId/factory-write", requireIdempotency, factoryWritten);
// Keep the historical alias, but make the word "readback" mean the strict
// second-step verification rather than another factory-write shortcut.
router.post("/batches/:batchId/factory-written/readback", requireIdempotency, verifyFactoryReadback);

async function verifyFactoryReadback(req: ManufacturingRequest, res: Response) {
  try {
    const stationId = requireFactoryStation(req);
    const batch = await findBatch(req.params.batchId);
    const deviceId = text(req.body.deviceId, "deviceId", 128);
    const identity = await findIdentity(deviceId);
    if (identity.batch_id !== batch.id) throw new RequestError(404, "Device is not in this batch");
    if (identity.state === DeviceIdentityState.REVOKED) throw new RequestError(409, "REVOKED identity is terminal");
    const alreadyVerified = identity.state === DeviceIdentityState.VERIFIED;
    if (identity.identity_version < 3) throw new RequestError(409, "Legacy identity cannot enter QR v3 manufacturing");
    validateNumericDeviceId(deviceId, identity.type);
    if (identity.state !== DeviceIdentityState.FACTORY_WRITTEN && !alreadyVerified) throw new RequestError(409, `Readback is not valid from ${identity.state}`);
    const readback = readbackObject(req.body);
    if (!readback) throw new RequestError(409, "Factory readback evidence is required");
    const compareRequired = (value: unknown, expected: string, field: string) => {
      if (value === undefined || value === null || String(value).trim() === "" || String(value).trim() !== expected) {
        throw new RequestError(409, `Factory readback mismatch: ${field}`);
      }
    };
    if (!identity.public_key || !identity.public_key_fingerprint || !identity.factory_cfg_hash ||
        !identity.factory_firmware_sha256 || !identity.factory_station_id || !identity.factory_readback_proof) {
      // Evidence is recorded only after this endpoint validates the physical
      // readback. A FACTORY_WRITTEN identity is expected to have these fields
      // empty; a VERIFIED retry must have them populated.
      if (alreadyVerified) throw new RequestError(409, "Factory identity is missing mandatory readback evidence");
    }
    // The station uploads the public key during factory-write. The physical
    // readback step returns the board identity plus evidence/fingerprint, not
    // another copy of the key. Re-validate a supplied key when present, but
    // otherwise bind this verification to the key already stored on the
    // FACTORY_WRITTEN identity.
    const key = validatePublicKey(readback.publicKey ?? readback.devicePublicKey ?? identity.public_key, identity.firmware_target);
    compareRequired(key.fingerprint, identity.public_key_fingerprint || "", "publicKeyFingerprint");
    const explicitEvidence = readback.evidence;
    const evidence = explicitEvidence
      ? {
          ...factoryEvidence({
            ...readback,
            factoryCfgHash: explicitEvidence.partitionProof?.imageSha256,
            firmwareSha256: explicitEvidence.firmware?.artifactSha256,
            readbackProof: explicitEvidence.readbackProof,
          }, key, stationId),
          ...verifyStructuredReadbackEvidence(explicitEvidence, identity, stationId, key.fingerprint),
        }
      : factoryEvidence(readback, key, stationId);
    compareRequired(readback.deviceId ?? readback.device_id, identity.device_id, "deviceId");
    compareRequired(readback.serial ?? readback.serialNumber ?? readback.serial_number, identity.serial_number, "serial");
    compareRequired(readback.type, identity.type, "type");
    compareRequired(readback.model, identity.model || "", "model");
    compareRequired(readback.hardwareRevision ?? readback.hardware_revision, identity.hardware_revision, "hardwareRevision");
    const identityVersionValue = readback.identityVersion ?? readback.identity_version;
    const identityVersion = identityVersionValue === undefined ? NaN : Number(identityVersionValue);
    if (!Number.isInteger(identityVersion) || identityVersion < 1 || identityVersion > 0xffffffff) throw new RequestError(409, "Factory readback mismatch: identityVersion");
    if (alreadyVerified) {
      compareRequired(key.fingerprint, identity.public_key_fingerprint || "", "publicKeyFingerprint");
      compareRequired(evidence.factoryCfgHash, identity.factory_cfg_hash || "", "factoryCfgHash");
      compareRequired(evidence.firmwareSha256, identity.factory_firmware_sha256 || "", "firmwareSha256");
      compareRequired(evidence.stationId, identity.factory_station_id || "", "station");
      compareRequired(evidence.readbackProof, identity.factory_readback_proof || "", "readbackProof");
    }
    compareRequired(String(identityVersion), String(identity.identity_version), "identityVersion");
    if (alreadyVerified) return res.json({ success: true, idempotent: true, data: safeIdentity(identity) });
    const updated = await prisma.$transaction(async (tx) => {
      const value = await tx.deviceIdentity.update({ where: { device_id: deviceId }, data: {
        identity_version: identityVersion,
        factory_cfg_hash: evidence.factoryCfgHash,
        factory_firmware_sha256: evidence.firmwareSha256,
        factory_station_id: evidence.stationId,
        factory_readback_proof: evidence.readbackProof,
        state: DeviceIdentityState.VERIFIED,
        factory_verified_at: new Date(),
      } });
      await createAudit(tx, req, {
        deviceId,
        batchId: batch.id,
        eventType: DeviceLifecycleEventType.FACTORY_READBACK_VERIFIED,
        fromState: identity.state,
        toState: DeviceIdentityState.VERIFIED,
        idempotencyKey: req.idempotencyKey,
        metadata: {
          readbackVerified: true,
          publicKeyFingerprint: evidence.publicKeyFingerprint,
          factoryCfgHash: evidence.factoryCfgHash,
          firmwareSha256: evidence.firmwareSha256,
          stationId: evidence.stationId,
          readbackProofVerified: true,
        },
      });
      return value;
    });
    return res.json({ success: true, data: safeIdentity(updated) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/batches/:batchId/factory-readback", requireIdempotency, verifyFactoryReadback);
router.post("/batches/:batchId/readback-verify", requireIdempotency, verifyFactoryReadback);
router.post("/batches/:batchId/factory-readback-verify", requireIdempotency, verifyFactoryReadback);
router.post("/batches/:batchId/readback/verify", requireIdempotency, verifyFactoryReadback);

function evidenceComplete(identity: any): boolean {
  return Boolean(identity.public_key && identity.public_key_fingerprint && identity.factory_cfg_hash &&
    identity.factory_firmware_sha256 && identity.factory_station_id && identity.factory_readback_proof &&
    identity.factory_verified_at && identity.identity_version >= 3);
}

async function qcPassBatch(req: ManufacturingRequest, res: Response) {
  try {
    const duplicate = await duplicateResult(req);
    if (duplicate?.kind === "batch") return res.json({ success: true, idempotent: true, data: batchResponse(duplicate.batch) });
    const batch = await prisma.manufacturingBatch.findUnique({ where: { id: req.params.batchId }, include: { identities: true } });
    if (!batch) throw new RequestError(404, "Manufacturing batch not found");
    if (batch.status === ManufacturingBatchStatus.CANCELLED || batch.status === ManufacturingBatchStatus.QUARANTINED) throw new RequestError(409, `Batch is ${batch.status}`);
    const requestedIds = Array.isArray(req.body.deviceIds) ? req.body.deviceIds.map((value: unknown) => text(value, "deviceId", 128)) : null;
    const selected = requestedIds?.length ? batch.identities.filter((identity) => requestedIds.includes(identity.device_id)) : batch.identities;
    if (requestedIds?.length !== undefined && selected.length !== requestedIds.length) throw new RequestError(404, "One or more devices are not in this batch");
    if (!selected.length) throw new RequestError(409, "Batch has no allocated identities");
    for (const identity of selected) {
      if (identity.state === DeviceIdentityState.REVOKED) throw new RequestError(409, `REVOKED identity is terminal: ${identity.device_id}`);
      if (identity.state === DeviceIdentityState.QUARANTINED) throw new RequestError(409, `Device is quarantined: ${identity.device_id}`);
      if (identity.state !== DeviceIdentityState.VERIFIED && identity.state !== DeviceIdentityState.QC_PASSED) throw new RequestError(409, `QC pass is not valid from ${identity.state}: ${identity.device_id}`);
      if (!evidenceComplete(identity)) throw new RequestError(409, `Mandatory factory evidence is missing: ${identity.device_id}`);
    }
    const updated = await prisma.$transaction(async (tx) => {
      for (const identity of selected) {
        if (identity.state === DeviceIdentityState.VERIFIED) {
          assertTransition(identity.state, DeviceIdentityState.QC_PASSED);
          await tx.deviceIdentity.update({ where: { device_id: identity.device_id }, data: { state: DeviceIdentityState.QC_PASSED } });
          await createAudit(tx, req, {
            deviceId: identity.device_id,
            batchId: batch.id,
            eventType: DeviceLifecycleEventType.QC_PASSED,
            fromState: identity.state,
            toState: DeviceIdentityState.QC_PASSED,
            idempotencyKey: `${req.idempotencyKey}:qc:${identity.device_id}`,
            metadata: { releaseGate: "QC_PASSED" },
          });
        }
      }
      const current = await tx.deviceIdentity.findMany({ where: { batch_id: batch.id } });
      const allQcPassed = current.length === batch.quantity && current.every((identity) => identity.state === DeviceIdentityState.QC_PASSED);
      const value = await tx.manufacturingBatch.update({ where: { id: batch.id }, data: { status: allQcPassed ? ManufacturingBatchStatus.QC_PASSED : ManufacturingBatchStatus.IN_PROGRESS }, include: { identities: true } });
      await createAudit(tx, req, {
        batchId: batch.id,
        eventType: DeviceLifecycleEventType.QC_PASSED,
        idempotencyKey: req.idempotencyKey,
        metadata: { operation: "QC_PASSED", selectedDeviceIds: selected.map((identity) => identity.device_id), allQcPassed },
      });
      return value;
    });
    return res.json({ success: true, data: batchResponse(updated) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

async function releaseBatch(req: ManufacturingRequest, res: Response) {
  try {
    const duplicate = await duplicateResult(req);
    if (duplicate?.kind === "batch") return res.json({ success: true, idempotent: true, data: batchResponse(duplicate.batch) });
    const batch = await prisma.manufacturingBatch.findUnique({ where: { id: req.params.batchId }, include: { identities: true } });
    if (!batch) throw new RequestError(404, "Manufacturing batch not found");
    if (batch.status === ManufacturingBatchStatus.CANCELLED || batch.status === ManufacturingBatchStatus.QUARANTINED) throw new RequestError(409, `Batch is ${batch.status}`);
    if (batch.status === ManufacturingBatchStatus.READY_TO_SHIP && batch.identities.every((identity) => identity.state === DeviceIdentityState.READY_TO_SHIP)) {
      return res.json({ success: true, idempotent: true, data: batchResponse(batch) });
    }
    if (batch.identities.length !== batch.quantity) throw new RequestError(409, "All batch identities must be allocated before release");
    if (batch.identities.some((identity) => identity.state === DeviceIdentityState.REVOKED || identity.state === DeviceIdentityState.QUARANTINED)) throw new RequestError(409, "A revoked or quarantined identity cannot be released");
    if (batch.identities.some((identity) => identity.state !== DeviceIdentityState.QC_PASSED)) throw new RequestError(409, "Every identity must pass QC before release");
    const updated = await prisma.$transaction(async (tx) => {
      for (const identity of batch.identities) {
        assertTransition(identity.state, DeviceIdentityState.READY_TO_SHIP);
        await tx.deviceIdentity.update({ where: { device_id: identity.device_id }, data: { state: DeviceIdentityState.READY_TO_SHIP } });
        await createAudit(tx, req, {
          deviceId: identity.device_id,
          batchId: batch.id,
          eventType: DeviceLifecycleEventType.READY_TO_SHIP,
          fromState: identity.state,
          toState: DeviceIdentityState.READY_TO_SHIP,
          idempotencyKey: `${req.idempotencyKey}:ready:${identity.device_id}`,
          metadata: { releaseGate: "READY_TO_SHIP" },
        });
      }
      const value = await tx.manufacturingBatch.update({ where: { id: batch.id }, data: { status: ManufacturingBatchStatus.READY_TO_SHIP }, include: { identities: true } });
      await createAudit(tx, req, {
        batchId: batch.id,
        eventType: DeviceLifecycleEventType.READY_TO_SHIP,
        idempotencyKey: req.idempotencyKey,
        metadata: { operation: "READY_TO_SHIP", identityCount: batch.identities.length },
      });
      return value;
    });
    return res.json({ success: true, data: batchResponse(updated) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/batches/:batchId/qc-pass", requireIdempotency, qcPassBatch);
router.post("/batches/:batchId/qc-passed", requireIdempotency, qcPassBatch);
router.post("/batches/:batchId/release", requireIdempotency, releaseBatch);
router.post("/batches/:batchId/ready-to-ship", requireIdempotency, releaseBatch);

async function issueQr(req: ManufacturingRequest, res: Response) {
  try {
    const duplicate = await duplicateResult(req);
    if (duplicate?.kind === "label") return res.status(200).json({ success: true, idempotent: true, data: safeLabel(duplicate.label) });
    const deviceIds = Array.isArray(req.body.deviceIds) ? req.body.deviceIds.map((value: unknown) => text(value, "deviceId", 128)) : req.body.deviceId ? [text(req.body.deviceId, "deviceId", 128)] : [];
    if (!deviceIds.length) throw new RequestError(400, "deviceIds is required");
    if (deviceIds.length > 500) throw new RequestError(400, "At most 500 QR labels may be issued per request");
    const identities = await prisma.deviceIdentity.findMany({ where: { device_id: { in: deviceIds } } });
    if (identities.length !== deviceIds.length) throw new RequestError(404, "One or more device identities were not found");
    const batchIds = [...new Set(identities.map((identity) => identity.batch_id).filter((value): value is string => Boolean(value)))];
    const batches = await prisma.manufacturingBatch.findMany({ where: { id: { in: batchIds } }, select: { id: true, status: true } });
    const batchById = new Map(batches.map((batch) => [batch.id, batch]));
    const payloads = await prisma.$transaction(async (tx) => {
      const result = [] as any[];
      for (const identity of identities) {
        if (identity.state === DeviceIdentityState.REVOKED) throw new RequestError(409, `REVOKED identity is terminal: ${identity.device_id}`);
        if (identity.state !== DeviceIdentityState.READY_TO_SHIP) throw new RequestError(409, `Identity must be READY_TO_SHIP before QR issue: ${identity.device_id}`);
        if (!identity.batch_id || batchById.get(identity.batch_id)?.status !== ManufacturingBatchStatus.READY_TO_SHIP) throw new RequestError(409, `Batch must be READY_TO_SHIP before QR issue: ${identity.device_id}`);
        const existing = await tx.deviceQrLabel.findUnique({ where: { device_id: identity.device_id } });
        if (existing) {
          if (existing.state === DeviceQrLabelState.REVOKED) throw new RequestError(409, `QR label is revoked: ${identity.device_id}`);
          result.push(existing);
          continue;
        }
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
        const label = await tx.deviceQrLabel.create({ data: {
          qr_id: qrId,
          device_id: identity.device_id,
          batch_id: identity.batch_id,
          version: 3,
          issuer: payload.issuer,
          kid: payload.kid,
          canonical_payload: canonicalizeQrV3(unsigned),
          signature: payload.sig,
          state: DeviceQrLabelState.ISSUED,
        } });
        await createAudit(tx, req, {
          deviceId: identity.device_id,
          batchId: identity.batch_id,
          qrLabelId: label.id,
          eventType: DeviceLifecycleEventType.QR_ISSUED,
          fromState: identity.state,
          toState: identity.state,
          idempotencyKey: deviceIds.length === 1 ? req.idempotencyKey : null,
          metadata: { qrId, version: 3 },
        });
        result.push(label);
      }
      if (deviceIds.length > 1) {
        await createAudit(tx, req, { eventType: DeviceLifecycleEventType.QR_ISSUED, idempotencyKey: req.idempotencyKey, metadata: { deviceIds } });
      }
      return result;
    });
    return res.status(201).json({ success: true, data: payloads.map(safeLabel) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/qr/issue", requireIdempotency, issueQr);
router.post("/devices/:deviceId/qr/issue", requireIdempotency, async (req: ManufacturingRequest, res: Response) => {
  req.body = { ...req.body, deviceId: req.params.deviceId };
  return issueQr(req, res);
});
router.post("/batches/:batchId/qr/issue", requireIdempotency, async (req: ManufacturingRequest, res: Response) => {
  // Keep the batch path strict while sharing the signer and audit logic.
  try {
    const batch = await findBatch(req.params.batchId);
    const deviceIds = Array.isArray(req.body.deviceIds) ? req.body.deviceIds : [];
    const identities = await prisma.deviceIdentity.findMany({ where: deviceIds.length ? { batch_id: batch.id, device_id: { in: deviceIds.map((value: unknown) => String(value)) } } : { batch_id: batch.id }, select: { device_id: true } });
    if (deviceIds.length && identities.length !== deviceIds.length) throw new RequestError(404, "One or more devices are not in this batch");
    const selected = deviceIds.length ? deviceIds : identities.map((identity) => identity.device_id);
    req.body = { ...req.body, deviceIds: selected };
    return issueQr(req, res);
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

async function getLabel(qrId: string) {
  const label = await prisma.deviceQrLabel.findUnique({ where: { qr_id: qrId }, include: { device: true } });
  if (!label) throw new RequestError(404, "QR label not found");
  return label;
}

async function printConfirm(req: ManufacturingRequest, res: Response) {
  try {
    const label = await getLabel(text(req.params.qrId, "qrId", 128));
    if (label.state === DeviceQrLabelState.REVOKED) throw new RequestError(409, "QR label is revoked");
    if (label.state === DeviceQrLabelState.QUARANTINED) throw new RequestError(409, "QR label is quarantined");
    if (label.printed_at) return res.json({ success: true, idempotent: true, data: safeLabel(label) });
    const updated = await prisma.$transaction(async (tx) => {
      const value = await tx.deviceQrLabel.update({ where: { id: label.id }, data: { state: DeviceQrLabelState.PRINTED, printed_at: new Date(), printed_by_id: actorOf(req).id } });
      await createAudit(tx, req, { deviceId: label.device_id, batchId: label.batch_id, qrLabelId: label.id, eventType: DeviceLifecycleEventType.QR_PRINT_CONFIRMED, idempotencyKey: req.idempotencyKey, metadata: { printed: true } });
      return value;
    });
    return res.json({ success: true, data: safeLabel(updated) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/qr/:qrId/print-confirm", requireIdempotency, printConfirm);
router.post("/qr/:qrId/confirm-print", requireIdempotency, printConfirm);
router.post("/labels/:qrId/print-confirm", requireIdempotency, printConfirm);

async function reprint(req: ManufacturingRequest, res: Response) {
  try {
    const label = await getLabel(text(req.params.qrId, "qrId", 128));
    if (label.state === DeviceQrLabelState.REVOKED) throw new RequestError(409, "QR label is revoked");
    if (label.state === DeviceQrLabelState.QUARANTINED) throw new RequestError(409, "QR label is quarantined");
    const updated = await prisma.$transaction(async (tx) => {
      const value = await tx.deviceQrLabel.update({ where: { id: label.id }, data: { state: DeviceQrLabelState.REPRINTED, reprint_count: { increment: 1 } } });
      await createAudit(tx, req, { deviceId: label.device_id, batchId: label.batch_id, qrLabelId: label.id, eventType: DeviceLifecycleEventType.QR_REPRINTED, idempotencyKey: req.idempotencyKey, metadata: { reason: optionalText(req.body.reason, 256) } });
      return value;
    });
    return res.json({ success: true, data: safeLabel(updated) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/qr/:qrId/reprint", requireIdempotency, reprint);
router.post("/labels/:qrId/reprint", requireIdempotency, reprint);

async function revokeQr(req: ManufacturingRequest, res: Response) {
  try {
    const label = await getLabel(text(req.params.qrId, "qrId", 128));
    const reason = optionalText(req.body.reason, 512) || "Revoked by manufacturing administrator";
    const updated = await prisma.$transaction(async (tx) => {
      const identity = await tx.deviceIdentity.findUnique({ where: { device_id: label.device_id } });
      if (!identity) throw new RequestError(404, "Device identity not found");
      if (identity.state !== DeviceIdentityState.REVOKED) assertTransition(identity.state, DeviceIdentityState.REVOKED);
      const invalidated = await invalidateDeviceAccess(tx, identity.device_id, `QR revoked: ${reason}`);
      const value = await tx.deviceQrLabel.update({ where: { id: label.id }, data: { state: DeviceQrLabelState.REVOKED, revoked_at: new Date(), revoke_reason: reason } });
      if (identity.state !== DeviceIdentityState.REVOKED) await tx.deviceIdentity.update({ where: { device_id: identity.device_id }, data: { state: DeviceIdentityState.REVOKED } });
      await createAudit(tx, req, { deviceId: identity.device_id, batchId: identity.batch_id, qrLabelId: label.id, eventType: DeviceLifecycleEventType.QR_REVOKED, fromState: identity.state, toState: DeviceIdentityState.REVOKED, idempotencyKey: req.idempotencyKey, metadata: { reason, invalidated } });
      return value;
    });
    return res.json({ success: true, data: safeLabel(updated) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/qr/:qrId/revoke", requireIdempotency, revokeQr);
router.post("/labels/:qrId/revoke", requireIdempotency, revokeQr);

async function quarantineDevice(req: ManufacturingRequest, res: Response) {
  try {
    const deviceId = text(req.params.deviceId, "deviceId", 128);
    const identity = await findIdentity(deviceId);
    if (identity.state === DeviceIdentityState.REVOKED) throw new RequestError(409, "REVOKED identity is terminal");
    if (identity.state !== DeviceIdentityState.QUARANTINED) assertTransition(identity.state, DeviceIdentityState.QUARANTINED);
    const updated = await prisma.$transaction(async (tx) => {
      const invalidated = await invalidateDeviceAccess(tx, deviceId, `Device quarantined: ${optionalText(req.body.reason, 512) || "no reason supplied"}`);
      const value = identity.state === DeviceIdentityState.QUARANTINED
        ? identity
        : await tx.deviceIdentity.update({ where: { device_id: deviceId }, data: { state: DeviceIdentityState.QUARANTINED } });
      const label = await tx.deviceQrLabel.findUnique({ where: { device_id: deviceId } });
      if (label && label.state !== DeviceQrLabelState.REVOKED) await tx.deviceQrLabel.update({ where: { id: label.id }, data: { state: DeviceQrLabelState.QUARANTINED } });
      await createAudit(tx, req, { deviceId, batchId: identity.batch_id, qrLabelId: label?.id, eventType: DeviceLifecycleEventType.DEVICE_QUARANTINED, fromState: identity.state, toState: DeviceIdentityState.QUARANTINED, idempotencyKey: req.idempotencyKey, metadata: { reason: optionalText(req.body.reason, 512), invalidated } });
      return value;
    });
    return res.json({ success: true, data: safeIdentity(updated) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}

router.post("/devices/:deviceId/quarantine", requireIdempotency, quarantineDevice);
router.post("/qr/:qrId/quarantine", requireIdempotency, async (req: ManufacturingRequest, res: Response) => {
  try {
    const label = await getLabel(text(req.params.qrId, "qrId", 128));
    req.params.deviceId = label.device_id;
    return quarantineDevice(req, res);
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

async function listQrLabels(req: ManufacturingRequest, res: Response) {
  try {
    const state = req.query.state ? String(req.query.state).toUpperCase() as DeviceQrLabelState : undefined;
    if (state && !Object.values(DeviceQrLabelState).includes(state)) throw new RequestError(400, "Invalid QR label state");
    const labels = await prisma.deviceQrLabel.findMany({ where: { ...(state ? { state } : {}), ...(req.query.batchId ? { batch_id: String(req.query.batchId) } : {}) }, include: { device: true }, orderBy: { created_at: "desc" } });
    return res.json({ success: true, count: labels.length, data: labels.map(safeLabel) });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}
router.get("/qr", listQrLabels);
router.get("/labels", listQrLabels);

async function exportQrLabels(req: ManufacturingRequest, res: Response) {
  try {
    const labels = await prisma.deviceQrLabel.findMany({ where: { ...(req.query.batchId ? { batch_id: String(req.query.batchId) } : {}) }, include: { device: true }, orderBy: { created_at: "asc" } });
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = ["qrId,deviceId,serial,type,model,hardwareRevision,state,payload", ...labels.map((label) => {
      const payload = (() => { try { return JSON.stringify(qrPayloadForLabel(label)); } catch { return ""; } })();
      return [label.qr_id, label.device_id, label.device.serial_number, label.device.type, label.device.model, label.device.hardware_revision, label.state, payload].map(escape).join(",");
    })];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=manufacturing-qr-v3.csv");
    return res.send(`${rows.join("\n")}\n`);
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
}
router.get("/qr/export", exportQrLabels);
router.get("/labels/export", exportQrLabels);

router.get("/devices/:deviceId/events", async (req: ManufacturingRequest, res: Response) => {
  try {
    const deviceId = text(req.params.deviceId, "deviceId", 128);
    const events = await prisma.deviceLifecycleEvent.findMany({ where: { device_id: deviceId }, orderBy: { created_at: "asc" } });
    return res.json({ success: true, count: events.length, data: events });
  } catch (error) {
    const failure = requestError(error);
    return res.status(failure.status).json({ success: false, error: failure.message });
  }
});

export default router;
