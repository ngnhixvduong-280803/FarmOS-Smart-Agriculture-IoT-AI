import { randomUUID } from "node:crypto";
import { Router, Response } from "express";
import { prisma } from "../../database/prisma";
import { safetyEngine } from "../../safety_engine/safety.service";
import { isNodeOnline } from "../../telemetry/node-presence";
import { authenticate, AuthRequest } from "../middleware/auth.middleware";
import { rateLimit } from "express-rate-limit";

const router = Router();
router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false }));

// GET /api/v1/farms/map-overview - Lấy dữ liệu vị trí các Farm và Node phục vụ hiển thị Bản đồ (Admin xem tất cả, User xem của mình)
router.get("/map-overview", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const where = user.role === "ADMIN" ? {} : { user_farms: { some: { user_id: user.id } } };

    const farms = await prisma.farm.findMany({
      where,
      include: {
        user_farms: {
          include: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
        zones: {
          include: {
            telemetries: {
              orderBy: { timestamp: "desc" },
              take: 1,
            },
          },
        },
        nodes: {
          where:
            user.role === "ADMIN"
              ? {}
              : {
                  OR: [
                    { owner_id: user.id },
                    { farm: { user_farms: { some: { user_id: user.id } } } },
                  ],
                },
          include: {
            telemetries: {
              orderBy: { timestamp: "desc" },
              take: 1,
            },
            zone: true,
            owner: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    const formattedFarms = farms.map((farm) => {
      return {
        id: farm.id,
        name: farm.name,
        location: farm.location,
        address: farm.address,
        latitude: farm.latitude || 10.854886,
        longitude: farm.longitude || 106.786523,
        zonesCount: farm.zones.length,
        nodesCount: farm.nodes.length,
        owners: farm.user_farms.map(({ user: owner }) => ({
          id: owner.id,
          name: owner.name,
          email: owner.email,
        })),
        nodes: farm.nodes.map((node) => {
          const sample = node.telemetries[0];
          const latest = sample?.farm_id === farm.id ? sample : null;
          return {
            id: node.id,
            name: node.name || node.id,
            serial_number: node.serial_number,
            type: node.type,
            online: isNodeOnline(node),
            rssi: node.rssi,
            latitude: node.latitude || farm.latitude || 10.854886,
            longitude: node.longitude || farm.longitude || 106.786523,
            zone: node.zone,
            owner: node.owner,
            latest_telemetry: latest
              ? {
                  soil_moisture: latest.soil_moisture,
                  soil_temp: latest.soil_temp,
                  air_temp: latest.air_temp,
                  air_humidity: latest.air_humidity,
                  lux: latest.lux,
                  timestamp: latest.timestamp,
                }
              : null,
          };
        }),
      };
    });

    res.json({ success: true, data: formattedFarms });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/v1/farms - Lấy danh sách trang trại (Admin lấy tất cả, User lấy của mình)
router.get("/", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = req.user!;
    const where = user.role === "ADMIN" ? {} : { user_farms: { some: { user_id: user.id } } };

    const farms = await prisma.farm.findMany({
      where,
      select: {
        id: true,
        name: true,
        location: true,
        address: true,
        latitude: true,
        longitude: true,
        created_at: true,
        zones: {
          select: { id: true },
        },
        user_farms: {
          select: {
            user: { select: { id: true, name: true, email: true, role: true } },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });
    res.json({ success: true, data: farms });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// GET /api/v1/farms/:farmId/overview - Tổng quan trang trại (Mực nước bể, cảnh báo, trạng thái các zone)
router.get("/:farmId/overview", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { farmId } = req.params;
    const user = req.user!;

    // Kiểm tra quyền truy cập Farm
    if (user.role !== "ADMIN") {
      const userFarm = await prisma.userFarm.findUnique({
        where: {
          user_id_farm_id: { user_id: user.id, farm_id: farmId },
        },
      });
      if (!userFarm) {
        return res.status(403).json({ success: false, error: "Bạn không có quyền truy cập trang trại này" });
      }
    }

    const farm = await prisma.farm.findUnique({
      where: { id: farmId },
      include: {
        zones: {
          include: {
            telemetries: {
              orderBy: { timestamp: "desc" },
              take: 1,
            },
          },
        },
        nodes: true,
      },
    });

    if (!farm) {
      return res.status(404).json({ success: false, error: "Không tìm thấy trang trại" });
    }

    const activeAlertsCount = await prisma.alert.count({
      where: { farm_id: farmId, resolved: false },
    });

    const tankState = safetyEngine.getTankState();

    res.json({
      success: true,
      data: {
        farm,
        tankState,
        activeAlertsCount,
      },
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// POST /api/v1/farms - Tạo Farm mới
router.post("/", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id, name, location, address, latitude, longitude } = req.body;
    const user = req.user!;

    if (name !== undefined && (typeof name !== "string" || !name.trim() || name.trim().length > 100)) {
      return res.status(400).json({ success: false, error: "Tên vườn phải có từ 1 đến 100 ký tự." });
    }
    const farmId = id || `F_${randomUUID()}`;

    const farm = await prisma.farm.create({
      data: {
        id: farmId,
        name: name?.trim() || "Trang Trại Mới",
        user_farms: { create: { user_id: user.id } },
        zones: { create: { id: `Z_${randomUUID()}`, name: "Khu vực 1", crop_type: "Cây trồng tổng hợp" } },
        location: location || address || "Chưa xác định",
        address: address || null,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
      },
    });

    res.status(201).json({ success: true, data: farm });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.delete("/:farmId", authenticate, async (req: AuthRequest, res: Response) => {
  const { farmId } = req.params;
  const user = req.user!;
  try {
    const outcome = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM farms WHERE id = ${farmId} FOR UPDATE`;
      const farm = await tx.farm.findUnique({
        where: { id: farmId },
        select: { user_farms: { select: { user_id: true } }, _count: { select: { nodes: true } } },
      });
      if (!farm || (user.role !== "ADMIN" && !farm.user_farms.some(entry => entry.user_id === user.id))) return 404;
      if (user.role !== "ADMIN" && farm.user_farms.length !== 1) return 403;
      const claimed = await tx.deviceIdentity.count({ where: { claimed_farm_id: farmId } });
      if (farm._count.nodes || claimed) return 409;
      await tx.farm.delete({ where: { id: farmId } });
      return 200;
    }, { isolationLevel: "Serializable" });
    if (outcome === 404) return res.status(404).json({ success: false, error: "Không tìm thấy vườn." });
    if (outcome === 403) return res.status(403).json({ success: false, error: "Vườn dùng chung cần quản trị viên xóa." });
    if (outcome === 409) return res.status(409).json({ success: false, error: "Hãy gỡ hoặc chuyển thiết bị trước khi xóa vườn." });
    return res.json({ success: true, data: { id: farmId } });
  } catch {
    return res.status(500).json({ success: false, error: "Không thể xóa vườn. Vui lòng thử lại." });
  }
});

// PATCH /api/v1/farms/:farmId/location - Cập nhật vị trí GPS của Farm
router.patch("/:farmId/location", authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { farmId } = req.params;
    const { latitude, longitude, address, name } = req.body;
    const user = req.user!;

    if (user.role !== "ADMIN") {
      const userFarm = await prisma.userFarm.findUnique({
        where: {
          user_id_farm_id: { user_id: user.id, farm_id: farmId },
        },
      });
      if (!userFarm) {
        return res.status(403).json({ success: false, error: "Bạn không có quyền chỉnh sửa trang trại này" });
      }
    }

    const farm = await prisma.farm.update({
      where: { id: farmId },
      data: {
        ...(latitude !== undefined && { latitude: parseFloat(latitude) }),
        ...(longitude !== undefined && { longitude: parseFloat(longitude) }),
        ...(address !== undefined && { address, location: address }),
        ...(name && { name }),
      },
    });

    res.json({ success: true, message: "Cập nhật vị trí trang trại thành công", data: farm });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
