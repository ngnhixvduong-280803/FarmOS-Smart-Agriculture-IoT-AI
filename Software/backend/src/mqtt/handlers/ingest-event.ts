import { Prisma } from "@prisma/client";
import { prisma } from "../../database/prisma";

/** Returns false when a retry has already been accepted by the server. */
export async function claimIngestEvent(
  eventId: unknown,
  messageType: "telemetry" | "status" | "ack",
  farmId: string,
  nodeId: string,
): Promise<boolean> {
  if (typeof eventId !== "string" || eventId.length < 16 || eventId.length > 128) {
    // Legacy/third-party devices can continue to publish while they are migrated.
    // Gateway Simulator and future ESP32 firmware always supply an eventId.
    return true;
  }

  try {
    await prisma.ingestEvent.create({
      data: { event_id: eventId, message_type: messageType, farm_id: farmId, node_id: nodeId },
    });
    return true;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return false;
    }
    throw error;
  }
}
