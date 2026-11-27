import { Router } from "express";
import bcrypt from "bcryptjs";
import { authenticate, requireRole, AuthRequest } from "../middleware/auth.middleware";
import { rateLimit } from "express-rate-limit";
import { isNodeOnline } from "../../telemetry/node-presence";
import { prisma } from "../../database/prisma";
import { cleanUserAvatars } from "../avatar-upload";

const router = Router();
const systemRoles = new Set(["ADMIN", "USER"]);
router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));

// GET /api/v1/users - Admin lấy danh sách toàn bộ khách hàng và cây phân cấp thiết bị (Gateway -> Nodes con & Độc lập)
router.get("/", authenticate, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const [users, allNodes] = await Promise.all([
      prisma.user.findMany({
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          avatar_url: true,
          created_at: true,
          user_farms: {
            include: {
              farm: {
                select: {
                  id: true,
                  name: true,
                  location: true,
                  latitude: true,
                  longitude: true,
                  zones: {
                    select: { id: true, name: true, crop_type: true },
                  },
                  _count: {
                    select: { nodes: true, zones: true },
                  },
                },
              },
            },
          },
        },
        orderBy: { created_at: "desc" },
      }),
      prisma.node.findMany({
        include: {
          farm: {
            select: { id: true, name: true, location: true },
          },
          zone: {
            select: { id: true, name: true, crop_type: true },
          },
          gateway: {
            select: { id: true, name: true, serial_number: true, online: true },
          },
          telemetries: {
            orderBy: { timestamp: "desc" },
            take: 1,
          },
        },
        orderBy: { created_at: "desc" },
      }),
    ]);

    // Format response data kèm cấu trúc Gateway -> Node con và Node độc lập cho từng khách hàng
    const formatted = users.map((u) => {
      const userFarmIds = new Set(u.user_farms.map((uf) => uf.farm.id));
      const userNodes = allNodes.filter(
        (n) => n.owner_id === u.id || (n.farm_id && userFarmIds.has(n.farm_id))
      );

      const formattedNodes = userNodes.map((n: any) => {
        const latestTelemetry = n.telemetries?.[0] || null;
        return {
          id: n.id,
          serial_number: n.serial_number,
          name: n.name || n.id,
          type: n.type,
          deployment_mode: n.deployment_mode,
          capabilities: n.capabilities,
          gateway_id: n.gateway_id,
          gateway: n.gateway,
          is_activated: n.is_activated,
          online: isNodeOnline(n),
          rssi: n.rssi,
          firmware_version: n.firmware_version,
          last_seen: n.last_seen,
          latitude: n.latitude,
          longitude: n.longitude,
          farm_id: n.farm_id,
          farm: n.farm,
          zone_id: n.zone_id,
          zone: n.zone,
          latest_telemetry: latestTelemetry
            ? {
                soil_moisture: latestTelemetry.soil_moisture,
                soil_temp: latestTelemetry.soil_temp,
                air_temp: latestTelemetry.air_temp,
                air_humidity: latestTelemetry.air_humidity,
                lux: latestTelemetry.lux,
                timestamp: latestTelemetry.timestamp,
              }
            : null,
        };
      });

      const gateways = formattedNodes.filter((n) => n.type === "GATEWAY");
      const sensorNodes = formattedNodes.filter((n) => n.type !== "GATEWAY");
      const gatewayIds = new Set(gateways.map((gw) => gw.id));

      // Gom nhóm Node con vào Gateway tương ứng
      const gatewayTree = gateways.map((gw) => {
        const childNodes = sensorNodes.filter((sn) => sn.gateway_id === gw.id);
        return {
          ...gw,
          childNodes,
          totalChildCount: childNodes.length,
          onlineChildCount: childNodes.filter((cn) => cn.online).length,
        };
      });

      // Các Node độc lập (không có gateway_id hoặc gateway_id không thuộc user)
      const standaloneNodes = sensorNodes.filter(
        (sn) => !sn.gateway_id || !gatewayIds.has(sn.gateway_id)
      );

      const totalOnline = formattedNodes.filter((n) => n.online).length;
      const onlinePct =
        formattedNodes.length > 0 ? Math.round((totalOnline / formattedNodes.length) * 100) : 0;

      return {
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        avatar_url: u.avatar_url,
        created_at: u.created_at,
        farms: u.user_farms.map((uf) => uf.farm),
        farmsCount: u.user_farms.length,
        nodesCount: formattedNodes.length,
        gatewaysCount: gateways.length,
        sensorNodesCount: sensorNodes.length,
        totalOnline,
        onlinePct,
        gateways: gatewayTree,
        standaloneNodes,
        nodes: formattedNodes,
      };
    });

    res.json({ success: true, data: formatted });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/v1/users - Admin tạo người dùng mới
router.post("/", authenticate, requireRole(["ADMIN"]), async (req, res) => {
  try {
    const { email, password, name, role = "USER" } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: "Email và mật khẩu là bắt buộc" });
    }
    if (typeof role !== "string" || !systemRoles.has(role)) {
      return res.status(400).json({ success: false, error: "Vai trò chỉ có thể là ADMIN hoặc USER" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ success: false, error: "Email này đã tồn tại" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        created_at: true
      }
    });

    res.status(201).json({ success: true, data: user });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// PATCH /api/v1/users/:id - Admin cập nhật quyền / thông tin khách hàng
router.patch("/:id", authenticate, requireRole(["ADMIN"]), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { name, role, avatar_url } = req.body;

    if (role !== undefined && (typeof role !== "string" || !systemRoles.has(role))) {
      return res.status(400).json({ success: false, error: "Vai trò chỉ có thể là ADMIN hoặc USER" });
    }

    const targetUser = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!targetUser) {
      return res.status(404).json({ success: false, error: "Người dùng không tồn tại" });
    }
    if (targetUser.role === "ADMIN" && role === "USER") {
      const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
      if (adminCount <= 1) {
        return res.status(409).json({ success: false, error: "Không thể hạ quyền Admin cuối cùng của hệ thống" });
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(role && { role }),
        ...(avatar_url !== undefined && { avatar_url })
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatar_url: true,
        updated_at: true
      }
    });

    res.json({ success: true, data: user });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// DELETE /api/v1/users/:id - Admin xóa tài khoản
router.delete("/:id", authenticate, requireRole(["ADMIN"]), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    if (id === req.user!.id) {
      return res.status(400).json({ success: false, error: "Không thể tự xóa tài khoản Admin đang đăng nhập" });
    }

    const targetUser = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!targetUser) {
      return res.status(404).json({ success: false, error: "Người dùng không tồn tại" });
    }
    if (targetUser.role === "ADMIN") {
      const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
      if (adminCount <= 1) {
        return res.status(409).json({ success: false, error: "Không thể xóa Admin cuối cùng của hệ thống" });
      }
    }

    cleanUserAvatars(id);
    await prisma.user.delete({ where: { id } });
    res.json({ success: true, message: "Đã xóa tài khoản người dùng thành công" });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
