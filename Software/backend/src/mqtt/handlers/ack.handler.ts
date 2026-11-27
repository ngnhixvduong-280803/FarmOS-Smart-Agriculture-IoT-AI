import { prisma } from "../../database/prisma";
import { commandDispatcher } from "../../safety_engine/command.dispatcher";
import { broadcastIrrigationStatus } from "../../websocket/socket.server";
import { claimIngestEvent } from "./ingest-event";

export interface AckPayload {
  eventId?: string;
  commandId: string;
  zoneId?: string;
  status: "COMPLETED" | "FAILED";
  measured_flow_liters?: number;
  error_code?: number;
  timestamp?: number;
}

export async function handleAckMessage(
  farmId: string,
  nodeId: string,
  payload: AckPayload
) {
  const { commandId, status, measured_flow_liters = 0, error_code = 0 } = payload;
  console.log("📥 [ACK HANDLER] Nhận ACK từ %s cho %s: Trạng thái = %s, Lưu lượng = %sL", nodeId, commandId, status, measured_flow_liters);

  try {
    if (!(await claimIngestEvent(payload.eventId, "ack", farmId, nodeId))) return;
    // 1. Cập nhật bản ghi IrrigationLog
    const updatedLog = await prisma.irrigationLog.updateMany({
      where: { command_id: commandId },
      data: {
        status: status,
        measured_flow_liters: measured_flow_liters,
        error_code: error_code,
        completed_at: new Date(),
      },
    });

    // 2. Thông báo cho CommandDispatcher để hủy timeout timer & giải phóng Safety Engine
    commandDispatcher.handleAckReceived(commandId, measured_flow_liters, error_code);

    // 3. Broadcast trạng thái mới qua WebSocket
    broadcastIrrigationStatus({
      farmId,
      commandId,
      zoneId: payload.zoneId || "Z01",
      status: status,
      measured_flow_liters: measured_flow_liters,
      error_code: error_code,
      timestamp: payload.timestamp || Math.floor(Date.now() / 1000),
    });
  } catch (e: any) {
    console.error("❌ [ACK HANDLER] Lỗi khi cập nhật ACK cho lệnh %s:", commandId, e.message);
  }
}
