import { Router, Response } from "express";
import { prisma } from "../../database/prisma";
import { authenticate, AuthRequest } from "../middleware/auth.middleware";
import { rateLimit } from "express-rate-limit";

const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

// GET /api/v1/zones - Danh sách các Zone (Admin lấy tất cả, User lấy các zone của vườn mình)
router.get("/", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const where =
      user.role === "ADMIN"
        ? {}
        : {
            farm: {
              user_farms: { some: { user_id: user.id } },
            },
          };

    const zones = await prisma.zone.findMany({
      where,
      include: {
        farm: { select: { id: true, name: true } },
        nodes: true,
        telemetries: {
          orderBy: { timestamp: "desc" },
          take: 1,
        },
      },
      orderBy: { id: "asc" },
    });

    const formattedZones = zones.map((z) => ({
      id: z.id,
      name: z.name,
      farm_id: z.farm_id,
      farm_name: z.farm.name,
      crop_type: z.crop_type,
      target_moisture_min: z.target_moisture_min,
      target_moisture_max: z.target_moisture_max,
      valve_id: z.valve_id,
      nodes: z.nodes,
      latest_telemetry: z.telemetries[0] || null,
    }));

    res.json({ success: true, data: formattedZones });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/v1/zones/:zoneId - Chi tiết một Zone
router.get("/:zoneId", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { zoneId } = req.params;
    const user = req.user!;

    const zone = await prisma.zone.findUnique({
      where: { id: zoneId },
      include: {
        farm: {
          include: { user_farms: true },
        },
        nodes: true,
        telemetries: {
          orderBy: { timestamp: "desc" },
          take: 1,
        },
      },
    });

    if (!zone) {
      return res.status(404).json({ success: false, error: `Không tìm thấy Zone ${zoneId}` });
    }

    const hasAccess = user.role === "ADMIN" || zone.farm.user_farms.some((uf) => uf.user_id === user.id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: "Bạn không có quyền truy cập Zone này" });
    }

    res.json({
      success: true,
      data: {
        ...zone,
        latest_telemetry: zone.telemetries[0] || null,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/v1/zones/:zoneId - Cập nhật cấu hình Zone (ngưỡng ẩm mong muốn, tên loại cây)
router.patch("/:zoneId", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { zoneId } = req.params;
    const { name, crop_type, target_moisture_min, target_moisture_max } = req.body;
    const user = req.user!;

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

    const hasAccess = user.role === "ADMIN" || zone.farm.user_farms.some((uf) => uf.user_id === user.id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: "Bạn không có quyền chỉnh sửa Zone này" });
    }

    const updated = await prisma.zone.update({
      where: { id: zoneId },
      data: {
        ...(name && { name }),
        ...(crop_type && { crop_type }),
        ...(target_moisture_min !== undefined && { target_moisture_min: parseFloat(target_moisture_min) }),
        ...(target_moisture_max !== undefined && { target_moisture_max: parseFloat(target_moisture_max) }),
      },
    });

    res.json({ success: true, data: updated, message: `Cập nhật cấu hình Zone ${zoneId} thành công` });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
