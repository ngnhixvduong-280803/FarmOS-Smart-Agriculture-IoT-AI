import { Router, Response } from "express";
import { prisma } from "../../database/prisma";
import { commandDispatcher } from "../../safety_engine/command.dispatcher";
import { authenticate, AuthRequest } from "../middleware/auth.middleware";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config/env";

const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));

const manualIrrigationSchema = z.object({
  zoneId: z.string(),
  valveId: z.string().optional(),
  durationSec: z.number().int().min(5).max(600),
  reason: z.string().optional(),
});

// POST /api/v1/irrigation/manual - Bấm nút tưới thủ công từ Dashboard/Mobile
router.post("/manual", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const parsed = manualIrrigationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: "Dữ liệu yêu cầu không hợp lệ",
        details: parsed.error.format(),
      });
    }

    const { zoneId, valveId, durationSec, reason } = parsed.data;

    // Tìm Zone và Farm tương ứng để kiểm tra quyền
    const zone = await prisma.zone.findUnique({
      where: { id: zoneId },
      include: {
        farm: {
          include: { user_farms: true },
        },
      },
    });

    if (!zone) {
      return res.status(404).json({ success: false, error: `Không tìm thấy Zone ${zoneId}` });
    }

    const membership = zone.farm.user_farms.find((uf) => uf.user_id === user.id);
    const canManage = user.role === "ADMIN" || Boolean(membership);
    if (!canManage) {
      return res.status(403).json({ success: false, error: "Bạn không có quyền điều khiển tưới ở khu vực này" });
    }

    if (!env.IRRIGATION_CONTROL_ENABLED) {
      return res.status(503).json({
        success: false,
        error: "Điều khiển tưới chưa khả dụng: firmware Gateway chưa có relay/interlock/ACK vật lý đã xác minh.",
      });
    }

    // Farm ownership is derived from the authorized zone, never from client input.
    const farmId = zone.farm_id;

    const result = await commandDispatcher.dispatchIrrigation({
      farmId,
      zoneId,
      valveId: valveId || zone.valve_id || undefined,
      durationSec,
      triggerSource: "MANUAL",
      reason: reason || `Người dùng ${user.name || user.email} điều khiển từ Dashboard`,
    });

    if (!result.success) {
      return res.status(result.statusCode || 409).json({
        success: false,
        message: result.message,
      });
    }

    res.json({
      success: true,
      message: result.message,
      data: {
        commandId: result.commandId,
        durationSec: result.durationSec,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/v1/irrigation/emergency-stop - Dừng khẩn cấp toàn bộ van & bơm
router.post("/emergency-stop", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const farmId = (req.body.farmId as string) || "F01";

    if (user.role !== "ADMIN") {
      const userFarm = await prisma.userFarm.findUnique({
        where: {
          user_id_farm_id: { user_id: user.id, farm_id: farmId },
        },
      });
      if (!userFarm) {
        return res.status(403).json({ success: false, error: "Bạn không có quyền can thiệp vào trang trại này" });
      }
    }

    if (!env.IRRIGATION_CONTROL_ENABLED) {
      return res.status(503).json({
        success: false,
        error: "Emergency stop chưa khả dụng vì phần cứng điều khiển tưới chưa được phát hành.",
      });
    }

    const result = await commandDispatcher.emergencyStop(farmId);
    res.status(result.success ? 200 : (result.statusCode || 503)).json({ success: result.success, message: result.message });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/v1/irrigation/logs - Lịch sử tưới & Kiểm toán an toàn
router.get("/logs", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const { zoneId, status, limit = 20, page = 1 } = req.query;
    const take = Number(limit);
    const skip = (Number(page) - 1) * take;

    const where: any = {};
    if (zoneId) where.zone_id = String(zoneId);
    if (status) where.status = String(status);

    if (user.role !== "ADMIN") {
      where.zone = {
        farm: {
          user_farms: { some: { user_id: user.id } },
        },
      };
    }

    const [logs, total] = await Promise.all([
      prisma.irrigationLog.findMany({
        where,
        orderBy: { created_at: "desc" },
        take,
        skip,
        include: {
          zone: {
            select: { name: true, crop_type: true },
          },
        },
      }),
      prisma.irrigationLog.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        total,
        page: Number(page),
        limit: take,
        logs,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/v1/irrigation/water-summary - Tổng hợp lượng nước tiêu thụ theo từng Zone
router.get("/water-summary", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;

    // Xác định danh sách zoneId hợp lệ cho User
    let zoneFilter: any = {};
    if (user.role !== "ADMIN") {
      const userZones = await prisma.zone.findMany({
        where: {
          farm: { user_farms: { some: { user_id: user.id } } },
        },
        select: { id: true },
      });
      const validZoneIds = userZones.map((z) => z.id);
      zoneFilter = { in: validZoneIds };
    }

    const aggregates = await prisma.irrigationLog.groupBy({
      by: ["zone_id"],
      where: {
        status: "COMPLETED",
        measured_flow_liters: { not: null },
        ...(user.role !== "ADMIN" ? { zone_id: zoneFilter } : {}),
      },
      _sum: {
        measured_flow_liters: true,
        duration_sec: true,
      },
      _count: {
        id: true,
      },
    });

    const summary = aggregates.map((item) => ({
      zoneId: item.zone_id,
      totalLiters: item._sum.measured_flow_liters || 0,
      totalDurationSec: item._sum.duration_sec || 0,
      totalIrrigationSessions: item._count.id,
    }));

    res.json({ success: true, data: summary });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
