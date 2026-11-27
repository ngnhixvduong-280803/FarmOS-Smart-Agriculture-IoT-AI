import { Prisma, DeviceIdentityState, DeviceLifecycleEventType } from "@prisma/client";

export const TERMINAL_IDENTITY_STATES = new Set<DeviceIdentityState>([DeviceIdentityState.REVOKED]);

const transitions: Record<DeviceIdentityState, DeviceIdentityState[]> = {
  [DeviceIdentityState.INVENTORY]: [DeviceIdentityState.ALLOCATED, DeviceIdentityState.CLAIMED, DeviceIdentityState.QUARANTINED, DeviceIdentityState.REVOKED],
  [DeviceIdentityState.LEGACY]: [DeviceIdentityState.CLAIMED, DeviceIdentityState.QUARANTINED, DeviceIdentityState.REVOKED],
  [DeviceIdentityState.ALLOCATED]: [DeviceIdentityState.FACTORY_WRITTEN, DeviceIdentityState.QUARANTINED, DeviceIdentityState.REVOKED],
  [DeviceIdentityState.FACTORY_WRITTEN]: [DeviceIdentityState.VERIFIED, DeviceIdentityState.QUARANTINED, DeviceIdentityState.REVOKED],
  [DeviceIdentityState.VERIFIED]: [DeviceIdentityState.QC_PASSED, DeviceIdentityState.QUARANTINED, DeviceIdentityState.REVOKED],
  [DeviceIdentityState.QC_PASSED]: [DeviceIdentityState.READY_TO_SHIP, DeviceIdentityState.QUARANTINED, DeviceIdentityState.REVOKED],
  [DeviceIdentityState.READY_TO_SHIP]: [DeviceIdentityState.CLAIMED, DeviceIdentityState.QUARANTINED, DeviceIdentityState.REVOKED],
  // A released device returns to the explicit shipping state. This preserves
  // factory evidence and the v3 QR instead of pretending it needs a new
  // factory write/readback cycle. REVOKED remains terminal.
  [DeviceIdentityState.CLAIMED]: [DeviceIdentityState.LEGACY, DeviceIdentityState.READY_TO_SHIP, DeviceIdentityState.QUARANTINED, DeviceIdentityState.REVOKED],
  [DeviceIdentityState.QUARANTINED]: [DeviceIdentityState.REVOKED],
  [DeviceIdentityState.REVOKED]: [],
};

export function canTransition(from: DeviceIdentityState, to: DeviceIdentityState): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function assertTransition(from: DeviceIdentityState, to: DeviceIdentityState): void {
  if (from === DeviceIdentityState.REVOKED) throw new Error("REVOKED identity is terminal");
  if (!canTransition(from, to)) throw new Error(`Invalid device lifecycle transition ${from} -> ${to}`);
}

export interface LifecycleInput {
  deviceId?: string | null;
  batchId?: string | null;
  qrLabelId?: string | null;
  eventType: DeviceLifecycleEventType;
  fromState?: DeviceIdentityState | null;
  toState?: DeviceIdentityState | null;
  actorType: string;
  actorId?: string | null;
  stationId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Prisma.InputJsonValue;
}

export async function recordLifecycleEvent(
  tx: Prisma.TransactionClient | PrismaClientLike,
  input: LifecycleInput,
): Promise<{ created: boolean; id: string }> {
  const data = {
    device_id: input.deviceId || null,
    batch_id: input.batchId || null,
    qr_label_id: input.qrLabelId || null,
    event_type: input.eventType,
    from_state: input.fromState || null,
    to_state: input.toState || null,
    actor_type: input.actorType,
    actor_id: input.actorId || null,
    station_id: input.stationId || null,
    idempotency_key: input.idempotencyKey || null,
    metadata: input.metadata,
  };
  if (input.idempotencyKey) {
    // Upsert closes the check-then-create race when a station retries the
    // same idempotency key concurrently after a network timeout.
    const event = await tx.deviceLifecycleEvent.upsert({
      where: { idempotency_key: input.idempotencyKey },
      update: {},
      create: data,
    });
    return { created: true, id: event.id };
  }
  const created = await tx.deviceLifecycleEvent.create({
    data,
  });
  return { created: true, id: created.id };
}

// Kept structural to make helpers usable in tests with a mocked Prisma client
// without weakening the production transaction type.
type PrismaClientLike = Pick<Prisma.TransactionClient, "deviceLifecycleEvent">;
