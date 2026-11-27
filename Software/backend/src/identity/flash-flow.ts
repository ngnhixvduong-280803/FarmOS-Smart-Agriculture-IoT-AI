import { FlashJobMode } from "@prisma/client";

export function flashPreflightDecision(input: {
  targetType: "NODE" | "GATEWAY";
  currentDeviceType?: string | null;
  currentIdentityState?: string | null;
  currentGenerationState?: string | null;
  boardState?: string | null;
  hasRelease: boolean;
  requireNewDevice?: boolean;
}): { ready: boolean; typeMismatch: boolean; reason: "TYPE_MISMATCH" | "BOARD_UNAVAILABLE" | "IDENTITY_UNAVAILABLE" | "NO_RELEASE" | "DEVICE_ALREADY_EXISTS" | null } {
  const typeMismatch = Boolean(input.currentDeviceType &&
    ((input.targetType === "GATEWAY") !== (input.currentDeviceType === "GATEWAY")));
  if (input.requireNewDevice && input.currentDeviceType) return { ready: false, typeMismatch, reason: "DEVICE_ALREADY_EXISTS" };
  if (typeMismatch) return { ready: false, typeMismatch: true, reason: "TYPE_MISMATCH" };
  if (input.boardState && input.boardState !== "ACTIVE") return { ready: false, typeMismatch: false, reason: "BOARD_UNAVAILABLE" };
  if (input.currentDeviceType &&
    (input.currentGenerationState !== "ACTIVE" || ["REVOKED", "QUARANTINED"].includes(input.currentIdentityState || ""))) {
    return { ready: false, typeMismatch: false, reason: "IDENTITY_UNAVAILABLE" };
  }
  if (!input.hasRelease) return { ready: false, typeMismatch: false, reason: "NO_RELEASE" };
  return { ready: true, typeMismatch: false, reason: null };
}

/**
 * A serial enrollment ticket is bound to the firmware HELLO nonce.  A browser
 * may therefore need a fresh ticket after losing the HTTP response, but only
 * while the FlashJob is still waiting for the first physical commit.  Keep
 * this predicate small and explicit so callers cannot accidentally make
 * initial enrollment or reset/reprovision tickets refreshable.
 */
export function canRefreshSerialEnrollmentTicket(input: {
  sameSession: boolean;
  operation: string;
  mode: FlashJobMode;
  sourceDeviceId?: string | null;
  currentIdentityDeviceId?: string | null;
  boundPublicKey?: string | null;
  enrollmentPublicKey: string;
  enrollmentPublicKeyFingerprint?: string | null;
  currentIdentityFingerprint?: string | null;
  existingOperation?: string | null;
}): boolean {
  return !input.sameSession &&
    input.operation === "REFLASH" &&
    input.mode === FlashJobMode.NORMAL_REFLASH &&
    Boolean(input.sourceDeviceId) &&
    input.sourceDeviceId === input.currentIdentityDeviceId &&
    input.boundPublicKey === input.enrollmentPublicKey &&
    input.currentIdentityFingerprint === (input.enrollmentPublicKeyFingerprint || input.enrollmentPublicKey) &&
    input.existingOperation === "REFLASH";
}

/**
 * Web Serial normal reflash updates an operational Node only when the
 * completed job still points at the same active identity generation.  Blank
 * enrollment and replacement deliberately return false so an unclaimed
 * generation never inherits a legacy Node's ownership or firmware row.
 */
export function shouldUpdateNormalReflashNode(input: {
  mode: FlashJobMode;
  sourceDeviceId?: string | null;
  currentIdentityDeviceId?: string | null;
  resultingDeviceId?: string | null;
}): boolean {
  return input.mode === FlashJobMode.NORMAL_REFLASH &&
    Boolean(input.sourceDeviceId) &&
    input.sourceDeviceId === input.currentIdentityDeviceId &&
    input.sourceDeviceId === input.resultingDeviceId;
}

/**
 * Resolve the immutable material for a newly completed identity.  The
 * enrollment ticket is signed and therefore is the browser/firmware
 * transcript, but it must agree with the server's current board and release
 * records before it is copied into DeviceIdentity.  In particular, never
 * silently turn a registered REV_B board into the historical REV_A default.
 */
export function completedIdentityMaterial(input: {
  role: "NODE" | "GATEWAY";
  releaseFirmwareTarget: string;
  sourceHardwareRevision?: string | null;
  boardHardwareRevision?: string | null;
  ticketHardwareRevision?: unknown;
  sourceModel?: string | null;
  ticketModel?: unknown;
  ticketFirmwareTarget?: unknown;
  ticketRole?: unknown;
}): { hardwareRevision: string; model: string; firmwareTarget: string } {
  const sourceHardwareRevision = input.sourceHardwareRevision?.trim().toUpperCase() || null;
  const boardHardwareRevision = input.boardHardwareRevision?.trim().toUpperCase() || null;
  const ticketHardwareRevision = typeof input.ticketHardwareRevision === "string"
    ? input.ticketHardwareRevision.trim().toUpperCase() || null
    : null;
  if (sourceHardwareRevision && boardHardwareRevision && sourceHardwareRevision !== boardHardwareRevision) {
    throw new Error("Device identity hardware revision does not match its HardwareBoard");
  }
  const hardwareRevision = sourceHardwareRevision || boardHardwareRevision || ticketHardwareRevision;
  if (!hardwareRevision) throw new Error("Completed identity hardware revision is missing");
  if (ticketHardwareRevision && ticketHardwareRevision !== hardwareRevision) {
    throw new Error("Enrollment ticket hardware revision does not match the HardwareBoard");
  }

  const ticketFirmwareTarget = typeof input.ticketFirmwareTarget === "string" ? input.ticketFirmwareTarget.trim() : null;
  if (ticketFirmwareTarget && ticketFirmwareTarget !== input.releaseFirmwareTarget) {
    throw new Error("Enrollment ticket firmware target does not match the FirmwareRelease");
  }
  const ticketRole = typeof input.ticketRole === "string" ? input.ticketRole.trim().toUpperCase() : null;
  if (ticketRole && ticketRole !== input.role) throw new Error("Enrollment ticket role does not match the FlashJob target");

  const sourceModel = input.sourceModel?.trim() || null;
  const ticketModel = typeof input.ticketModel === "string" ? input.ticketModel.trim() || null : null;
  if (sourceModel && ticketModel && sourceModel !== ticketModel) {
    throw new Error("Enrollment ticket model does not match the current identity");
  }
  const model = sourceModel || ticketModel || (input.role === "GATEWAY" ? "GATEWAY_V1" : "NODE_V1");
  return { hardwareRevision, model, firmwareTarget: input.releaseFirmwareTarget };
}
