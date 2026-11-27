import { Router, Response } from "express";
import { prisma } from "../../database/prisma";
import { authenticate, AuthRequest } from "../middleware/auth.middleware";
import { rateLimit } from "express-rate-limit";

const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

// GET /api/v1/alerts - Danh sách cảnh báo sự cố (Admin xem tất cả, User xem của mình)
router.get("/", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const { resolved = "false", limit = 50 } = req.query;

    const where: any = {
      resolved: resolved === "true",
    };

    if (user.role !== "ADMIN") {
      where.farm = {
        user_farms: { some: { user_id: user.id } },
      };
    }

    const alerts = await prisma.alert.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: Number(limit),
      include: {
        zone: {
          select: { name: true },
        },
        farm: {
          select: { id: true, name: true },
        },
      },
    });

    res.json({ success: true, data: alerts });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// PATCH /api/v1/alerts/:alertId/resolve - Đánh dấu đã giải quyết cảnh báo
router.patch("/:alertId/resolve", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { alertId } = req.params;
    const user = req.user!;

    const alert = await prisma.alert.findUnique({
      where: { id: alertId },
      include: {
        farm: { include: { user_farms: true } },
      },
    });

    if (!alert) {
      return res.status(404).json({ success: false, error: "Không tìm thấy cảnh báo" });
    }

    const hasAccess = user.role === "ADMIN" || alert.farm.user_farms.some((uf) => uf.user_id === user.id);
    if (!hasAccess) {
      return res.status(403).json({ success: false, error: "Bạn không có quyền xử lý cảnh báo này" });
    }

    const updated = await prisma.alert.update({
      where: { id: alertId },
      data: {
        resolved: true,
        resolved_at: new Date(),
      },
    });

    res.json({ success: true, data: updated, message: "Đã xử lý cảnh báo thành công" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/v1/alerts/resolve-all - Xử lý toàn bộ cảnh báo của User / Hệ thống
router.post("/resolve-all", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const where: any = { resolved: false };

    if (user.role !== "ADMIN") {
      where.farm = {
        user_farms: { some: { user_id: user.id } },
      };
    }

    await prisma.alert.updateMany({
      where,
      data: {
        resolved: true,
        resolved_at: new Date(),
      },
    });

    res.json({ success: true, message: "Đã giải quyết toàn bộ cảnh báo thành công" });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
