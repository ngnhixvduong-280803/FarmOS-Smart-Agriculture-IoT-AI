import { prisma } from "../../database/prisma";
import { safetyEngine } from "../../safety_engine/safety.service";
import { broadcastGatewayStatus } from "../../websocket/socket.server";
import { claimIngestEvent } from "./ingest-event";

export interface StatusPayload {
  eventId?: string;
  timestamp?: number;
  online?: boolean;
  water_tank_level_pct?: number;
  water_tank_safe?: boolean;
  rssi?: number;
  firmware?: string;
  active_valves?: string[];
}

export async function handleStatusMessage(
  farmId: string,
  nodeId: string,
  payload: StatusPayload
) {
  try {
    if (!(await claimIngestEvent(payload.eventId, "status", farmId, nodeId))) return;
    // An unactivated inventory board (or an unknown identifier on a legacy
    // path) must not influence a farm-wide pump interlock.
    const existingNode = await prisma.node.findUnique({
      where: { id: nodeId },
      select: { is_activated: true, type: true, farm_id: true },
    });
    if (!existingNode || !existingNode.is_activated || existingNode.farm_id !== farmId) {
      console.warn("[STATUS] Ignoring status from unknown, inactive, or cross-farm node %s", nodeId);
      return;
    }
    const isOnline = payload.online !== undefined ? payload.online : true;
    const hasWaterLevel = payload.water_tank_level_pct !== undefined;
    const hasWaterSafe = payload.water_tank_safe !== undefined;
    const waterLevel = payload.water_tank_level_pct;
    const waterSafe = payload.water_tank_safe;

    // A partial or malformed status must never synthesize the missing field as
    // safe. Only a complete physical interlock report can unlock irrigation.
    if (existingNode.type === "GATEWAY" && hasWaterLevel && hasWaterSafe && Number.isFinite(waterLevel) && waterLevel! >= 0 && waterLevel! <= 100 && typeof waterSafe === "boolean") {
      safetyEngine.updateTankState(waterLevel!, waterSafe);
    } else if (hasWaterLevel || hasWaterSafe) {
      console.warn("[STATUS] Ignoring non-Gateway, incomplete, or invalid tank interlock report from %s", nodeId);
    }
    const tankState = safetyEngine.getTankState();

    // 2. Cập nhật trạng thái Node/Gateway trong Database
    await prisma.node.update({
      where: { id: nodeId },
      data: {
        online: isOnline,
        rssi: payload.rssi,
        firmware_version: payload.firmware,
        last_seen: new Date(),
      },
    });

    // 3. Broadcast Realtime qua WebSocket
    broadcastGatewayStatus({
      farmId,
      nodeId,
      online: isOnline,
      water_tank_level_pct: tankState.level_pct,
      water_tank_safe: tankState.safe && safetyEngine.hasFreshTankState(),
      rssi: payload.rssi,
      active_valves: payload.active_valves || [],
      timestamp: payload.timestamp || Math.floor(Date.now() / 1000),
    });
  } catch (e: any) {
    console.error("❌ [STATUS HANDLER] Lỗi khi cập nhật trạng thái từ %s:", nodeId, e.message);
  }
}
