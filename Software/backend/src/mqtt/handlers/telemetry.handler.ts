import { prisma } from "../../database/prisma";
import { broadcastAlert, broadcastTelemetry } from "../../websocket/socket.server";
import { claimIngestEvent } from "./ingest-event";

export interface TelemetryPayload {
  eventId?: string;
  timestamp: number;
  farmId?: string;
  zoneId: string;
  nodeId?: string;
  soil_moisture?: number;
  soil_temp?: number;
  air_temp?: number;
  air_humidity?: number;
  lux?: number;
  quality?: number;
}

// Lưu trữ thời điểm ghi DB gần nhất cho mỗi node để tránh spam ghi DB quá dày đặc
const lastDbSaveTime: Map<string, number> = new Map();
const MIN_DB_SAVE_INTERVAL_MS = 10000; // Lưu DB tối đa 10s một lần mỗi node (WebSocket vẫn stream 100% realtime)

export async function handleTelemetryMessage(
  farmId: string,
  nodeId: string,
  payload: TelemetryPayload,
  sourceGatewayId?: string
) {
  try {
    if (sourceGatewayId) {
      const boundNode = await prisma.node.findUnique({
        where: { id: nodeId },
        select: { farm_id: true, gateway_id: true, is_activated: true },
      });
      if (!boundNode?.is_activated || boundNode.farm_id !== farmId || boundNode.gateway_id !== sourceGatewayId) {
        console.warn("[TELEMETRY] Từ chối %s: không thuộc Gateway %s", nodeId, sourceGatewayId);
        return;
      }
    }
    if (!(await claimIngestEvent(payload.eventId, "telemetry", farmId, nodeId))) return;
    const zoneId = payload.zoneId || "Z01";
    const timestampDate = payload.timestamp ? new Date(payload.timestamp * 1000) : new Date();

    // 1. Luôn phát Realtime qua WebSocket để giao diện Web nhảy số tức thì
    broadcastTelemetry({
      farmId,
      zoneId,
      nodeId,
      soil_moisture: payload.soil_moisture,
      soil_temp: payload.soil_temp,
      air_temp: payload.air_temp,
      air_humidity: payload.air_humidity,
      lux: payload.lux,
      quality: payload.quality ?? 1,
      timestamp: payload.timestamp || Math.floor(Date.now() / 1000),
    });

    // 2. Throttling lưu Database (Giảm tải I/O & tương thích tốt với Cloud/Supabase)
    const now = Date.now();
    const lastSave = lastDbSaveTime.get(nodeId) || 0;

    if (now - lastSave >= MIN_DB_SAVE_INTERVAL_MS) {
      lastDbSaveTime.set(nodeId, now);

      // Đảm bảo Node tồn tại trong DB
      await prisma.node.upsert({
        where: { id: nodeId },
        update: {
          online: true,
          last_seen: new Date(),
          zone_id: zoneId,
        },
        create: {
          id: nodeId,
          farm_id: farmId,
          zone_id: zoneId,
          type: "SENSOR_NODE",
          online: true,
          last_seen: new Date(),
        },
      });

      // Lưu bản ghi TelemetryData
      await prisma.telemetryData.create({
        data: {
          farm_id: farmId,
          zone_id: zoneId,
          node_id: nodeId,
          soil_moisture: payload.soil_moisture,
          soil_temp: payload.soil_temp,
          air_temp: payload.air_temp,
          air_humidity: payload.air_humidity,
          lux: payload.lux,
          quality: payload.quality ?? 1,
          timestamp: timestampDate,
        },
      });

      // 3. Kiểm tra ngưỡng khô hạn bất thường để phát cảnh báo
      if (payload.soil_moisture !== undefined && payload.soil_moisture < 25.0) {
        checkAndCreateMoistureAlert(farmId, zoneId, payload.soil_moisture);
      }
    }
  } catch (e: any) {
    console.error("❌ [TELEMETRY HANDLER] Lỗi khi xử lý dữ liệu từ %s:", nodeId, e.message);
  }
}

async function checkAndCreateMoistureAlert(farmId: string, zoneId: string, moisture: number) {
  try {
    const existing = await prisma.alert.findFirst({
      where: {
        farm_id: farmId,
        zone_id: zoneId,
        type: "SOIL_DRY",
        resolved: false,
      },
    });

    if (!existing) {
      const alert = await prisma.alert.create({
        data: {
          farm_id: farmId,
          zone_id: zoneId,
          level: "WARNING",
          type: "SOIL_DRY",
          message: `Độ ẩm đất tại Zone ${zoneId} giảm xuống mức báo động (${moisture}%). Cần kiểm tra lịch tưới!`,
        },
      });

      broadcastAlert({
        id: alert.id,
        farm_id: alert.farm_id,
        zone_id: alert.zone_id,
        level: alert.level,
        type: alert.type,
        message: alert.message,
        created_at: alert.created_at.toISOString(),
      });
    }
  } catch (e) {
    // Không block flow chính nếu lỗi alert
  }
}
