import { Router, Request, Response } from "express";
import { prisma } from "../../database/prisma";
import { handleTelemetryMessage } from "../../mqtt/handlers/telemetry.handler";
import { handleStatusMessage } from "../../mqtt/handlers/status.handler";
import { handleAckMessage } from "../../mqtt/handlers/ack.handler";
import { requireDeviceAuth } from "../middleware/device-auth.middleware";
import { rateLimit } from "express-rate-limit";

const router = Router();
const ingestRateLimit = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: "draft-7", legacyHeaders: false });
router.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: "draft-7", legacyHeaders: false }));

// POST /api/v1/telemetry/ingest - Nhận dữ liệu Telemetry trực tiếp qua HTTP REST API (thay thế hoặc song song với MQTT)
router.post("/ingest", requireDeviceAuth, ingestRateLimit, async (req: Request, res: Response) => {
  try {
    const { farmId = "F01", nodeId, zoneId, soil_moisture, soil_temp, air_temp, air_humidity, lux, timestamp } = req.body;

    if (!nodeId || (soil_moisture === undefined && soil_temp === undefined && air_temp === undefined)) {
      return res.status(400).json({ success: false, error: "Thiếu nodeId hoặc dữ liệu cảm biến" });
    }

    await handleTelemetryMessage(farmId, nodeId, {
      farmId,
      nodeId,
      zoneId: zoneId || "Z01",
      soil_moisture: soil_moisture !== undefined ? Number(soil_moisture) : undefined,
      soil_temp: soil_temp !== undefined ? Number(soil_temp) : undefined,
      air_temp: air_temp !== undefined ? Number(air_temp) : undefined,
      air_humidity: air_humidity !== undefined ? Number(air_humidity) : undefined,
      lux: lux !== undefined ? Number(lux) : undefined,
      timestamp: timestamp || Math.floor(Date.now() / 1000),
    });

    res.json({ success: true, message: "Đã tiếp nhận telemetry thành công" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/v1/telemetry/gateway-status - Nhận trạng thái Gateway trực tiếp qua HTTP REST API
router.post("/gateway-status", requireDeviceAuth, ingestRateLimit, async (req: Request, res: Response) => {
  try {
    const { farmId = "F01", nodeId = "GATEWAY_01", online, water_tank_level_pct, water_tank_safe, rssi, active_valves, firmware } = req.body;

    await handleStatusMessage(farmId, nodeId, {
      online: online !== undefined ? online : true,
      water_tank_level_pct: water_tank_level_pct !== undefined ? Number(water_tank_level_pct) : undefined,
      water_tank_safe: water_tank_safe !== undefined ? water_tank_safe : true,
      rssi: rssi !== undefined ? Number(rssi) : undefined,
      firmware,
      active_valves,
      timestamp: Math.floor(Date.now() / 1000),
    });

    res.json({ success: true, message: "Đã cập nhật trạng thái Gateway thành công" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/v1/telemetry/gateway-ack - Nhận phản hồi ACK thực thi lệnh từ Gateway qua HTTP REST API
router.post("/gateway-ack", requireDeviceAuth, ingestRateLimit, async (req: Request, res: Response) => {
  try {
    const { farmId = "F01", nodeId = "GATEWAY_01", commandId, zoneId, status, measured_flow_liters, error_code } = req.body;

    if (!commandId || !status) {
      return res.status(400).json({ success: false, error: "Thiếu commandId hoặc status" });
    }

    await handleAckMessage(farmId, nodeId, {
      commandId,
      zoneId,
      status,
      measured_flow_liters: Number(measured_flow_liters || 0),
      error_code: Number(error_code || 0),
      timestamp: Math.floor(Date.now() / 1000),
    });

    res.json({ success: true, message: "Đã tiếp nhận phản hồi ACK lệnh thành công" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

import { authenticate, AuthRequest } from "../middleware/auth.middleware";

// GET /api/v1/telemetry/zones/:zoneId/latest - Dữ liệu cảm biến mới nhất của Zone
router.get("/zones/:zoneId/latest", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { zoneId } = req.params;
    const user = req.user!;

    const zone = await prisma.zone.findUnique({
      where: { id: zoneId },
      include: {
        farm: { include: { user_farms: true } },
      },
    });

    if (!zone) {
      return res.status(404).json({ success: false, error: `Không tìm thấy Zone ${zoneId}` });
    }

    const hasAccess = user.role === "ADMIN" || zone.farm.user_farms.some((uf) => uf.user_id === user.id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: "Bạn không có quyền truy cập dữ liệu Zone này" });
    }

    const latest = await prisma.telemetryData.findFirst({
      where: { zone_id: zoneId },
      orderBy: { timestamp: "desc" },
    });

    if (!latest) {
      return res.status(404).json({ success: false, error: `Chưa có dữ liệu cảm biến cho Zone ${zoneId}` });
    }

    res.json({ success: true, data: latest });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/v1/telemetry/zones/:zoneId/history - Chuỗi dữ liệu lịch sử để vẽ biểu đồ
router.get("/zones/:zoneId/history", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { zoneId } = req.params;
    const { range = "1h", limit = 100 } = req.query;
    const user = req.user!;

    const zone = await prisma.zone.findUnique({
      where: { id: zoneId },
      include: {
        farm: { include: { user_farms: true } },
      },
    });

    if (!zone) {
      return res.status(404).json({ success: false, error: `Không tìm thấy Zone ${zoneId}` });
    }

    const hasAccess = user.role === "ADMIN" || zone.farm.user_farms.some((uf) => uf.user_id === user.id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: "Bạn không có quyền truy cập dữ liệu Zone này" });
    }

    let timeFilter: Date;
    const now = new Date();

    switch (range) {
      case "1h":
        timeFilter = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case "6h":
        timeFilter = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        break;
      case "24h":
        timeFilter = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case "7d":
        timeFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      default:
        timeFilter = new Date(now.getTime() - 60 * 60 * 1000);
    }

    const history = await prisma.telemetryData.findMany({
      where: {
        zone_id: zoneId,
        timestamp: { gte: timeFilter },
      },
      orderBy: { timestamp: "asc" },
      take: Number(limit) > 500 ? 500 : Number(limit),
    });

    res.json({
      success: true,
      data: {
        zoneId,
        range,
        count: history.length,
        points: history,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
