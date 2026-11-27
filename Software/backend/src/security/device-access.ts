import { DeviceIdentityState, DeviceLifecycleEventType, Prisma } from "@prisma/client";
import { assertTransition, recordLifecycleEvent } from "../manufacturing/lifecycle";

/**
 * Invalidate every server-side device capability in one transaction.
 *
 * Device tokens are intentionally opaque and stateless at the edge, so
 * deleting/cancelling only a provisioning session is insufficient: an issued
 * GatewayCredential would remain usable. This helper is shared by factory
 * quarantine/revoke and user unbind so the lifecycle paths cannot drift.
 */
export async function invalidateDeviceAccess(
  tx: Prisma.TransactionClient,
  deviceId: string,
  reason: string,
): Promise<{
  gatewayCredentials: number;
  gatewaySessions: number;
  claimSessions: number;
  pairingSessions: number;
  bindings: number;
  otaJobs: number;
  flashJobs: number;
  nodes: number;
}> {
  const now = new Date();
  await tx.pumpCommand.updateMany({
    where: { node_id: deviceId, status: { in: ["PENDING", "DELIVERED"] } },
    data: { status: "CANCELLED" },
  });
  const [gatewayCredentials, gatewaySessions, claimSessions, pairingSessions, bindings, otaJobs, flashJobs, nodes, childNodes] = await Promise.all([
    tx.gatewayCredential.updateMany({ where: { gateway_id: deviceId }, data: { revoked_at: now } }),
    tx.gatewayProvisioningSession.updateMany({
      where: { gateway_id: deviceId, status: { in: ["PENDING", "REDEEMED"] } },
      data: { status: "CANCELLED", expires_at: now },
    }),
    tx.deviceClaimSession.updateMany({
      // FINALIZED sessions are cancelled too: otherwise a replay of the old
      // finalize idempotency key could disclose/reuse a runtime binding after
      // unbind or quarantine.
      where: { device_id: deviceId, status: { in: ["CHALLENGE_ISSUED", "ATTESTED", "FINALIZED"] } },
      data: { status: "CANCELLED", expires_at: now },
    }),
    tx.pairingSession.updateMany({
      where: { OR: [{ node_id: deviceId }, { gateway_id: deviceId }], status: { notIn: ["FAILED", "EXPIRED", "CANCELLED"] } },
      data: { status: "CANCELLED", failure_reason: reason, expires_at: now },
    }),
    tx.nodeGatewayBinding.updateMany({
      where: { OR: [{ node_id: deviceId }, { gateway_id: deviceId }], status: "ACTIVE" },
      data: { status: "REVOKED", revoked_at: now },
    }),
    tx.otaUpdateJob.updateMany({
      where: { device_id: deviceId, status: { notIn: ["BOOT_CONFIRMED", "FAILED"] } },
      data: { status: "FAILED", expires_at: now },
    }),
    tx.flashJob.updateMany({
      where: { source_device_id: deviceId, status: { notIn: ["COMPLETED", "FAILED", "CANCELLED"] } },
      data: { status: "FAILED", error_code: "DEVICE_ACCESS_INVALIDATED", error_message: reason, expires_at: now },
    }),
    tx.node.updateMany({ where: { id: deviceId }, data: { online: false, is_activated: false, pump_ready_at: null } }),
    // A Gateway's children must not retain a stale foreign-key binding after
    // the Gateway is quarantined, revoked, or unbound. They remain claimable
    // runtime records, but telemetry is blocked until a new pairing exists.
    tx.node.updateMany({ where: { gateway_id: deviceId }, data: { gateway_id: null, online: false } }),
  ]);
  return {
    gatewayCredentials: gatewayCredentials.count,
    gatewaySessions: gatewaySessions.count,
    claimSessions: claimSessions.count,
    pairingSessions: pairingSessions.count,
    bindings: bindings.count,
    otaJobs: otaJobs.count,
    flashJobs: flashJobs.count,
    nodes: nodes.count + childNodes.count,
  };
}


export async function releaseDeviceAccount(
  tx: Prisma.TransactionClient,
  deviceId: string,
  identity: { state: DeviceIdentityState; identity_version: number; batch_id: string | null },
  release: { commandId?: string; forcedBy?: string },
) {
  const target = identity.identity_version >= 3 ? DeviceIdentityState.READY_TO_SHIP : DeviceIdentityState.LEGACY;
  if (identity.state !== target) assertTransition(identity.state, target);
  const boardConfirmed = !release.forcedBy;
  await invalidateDeviceAccess(tx, deviceId, boardConfirmed ? "Board confirmed account release" : "Device released by account operator");
  await tx.deviceLifecycleCommand.updateMany({
    where: { device_id: deviceId, ...(release.commandId ? { id: { not: release.commandId } } : {}), status: { in: ["PENDING", "ACKNOWLEDGED"] } },
    data: { status: "CANCELLED", expires_at: new Date() },
  });
  await tx.deviceIdentity.update({
    where: { device_id: deviceId },
    data: { state: target, claimed_by_id: null, claimed_farm_id: null, claimed_at: null },
  });
  await tx.node.update({
    where: { id: deviceId },
    data: { name: null, farm_id: null, zone_id: null, gateway_id: null, owner_id: null, is_activated: false, online: false, latitude: null, longitude: null, rssi: null, last_seen: null },
  });
  await recordLifecycleEvent(tx, {
    deviceId, batchId: identity.batch_id, eventType: DeviceLifecycleEventType.DEVICE_RELEASED,
    fromState: identity.state, toState: target, actorType: boardConfirmed ? "DEVICE" : "USER", actorId: release.forcedBy,
    metadata: { ...(release.commandId ? { commandId: release.commandId } : {}), operation: "RELEASE_ACCOUNT", boardConfirmed },
  });
}
