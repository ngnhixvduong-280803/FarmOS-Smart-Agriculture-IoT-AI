import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { rateLimit } from "express-rate-limit";
import { authenticate, AuthRequest, resolveAuthenticatedUser } from "../middleware/auth.middleware";
import { env } from "../../config/env";
import { prisma } from "../../database/prisma";
import { AvatarUploadError, cleanUserAvatars, receiveAvatar, removeManagedAvatar, saveAvatar } from "../avatar-upload";

const router = Router();
const JWT_SECRET = env.JWT_SECRET;
router.use(rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false }));

function issueSession(res: any, user: { id: string; email: string; role: string; name?: string | null; avatar_url?: string | null }) {
  const csrf = randomUUID();
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name, avatar_url: user.avatar_url, csrf },
    JWT_SECRET,
    {
      expiresIn: env.SESSION_TTL_SEC,
      algorithm: "HS256",
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    },
  );
  res.cookie(env.SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: env.SESSION_TTL_SEC * 1000,
  });
  return csrf;
}

function clearSession(res: any) {
  res.clearCookie(env.SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
  });
}

function issueMobileSession(user: { id: string; email: string; role: string; name?: string | null; avatar_url?: string | null }) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name, avatar_url: user.avatar_url, client: "mobile" },
    JWT_SECRET,
    {
      expiresIn: env.MOBILE_SESSION_TTL_SEC,
      algorithm: "HS256",
      issuer: env.JWT_ISSUER,
      audience: env.MOBILE_JWT_AUDIENCE,
    },
  );
}

function legacyPasswordAuthDisabled(res: any) {
  if (!env.ALLOW_LEGACY_PASSWORD_AUTH) {
    res.status(404).json({ success: false, error: "Password authentication is disabled" });
    return true;
  }
  return false;
}

// POST /api/v1/auth/session
// Exchanges a short-lived Supabase access token for a FarmOS HttpOnly session.
// The browser must never retain the bearer token after this request completes.
router.post("/session", async (req, res) => {
  const origin = req.get("origin");
  if (!origin || (env.CORS_ORIGIN !== "*" && origin !== env.CORS_ORIGIN)) {
    return res.status(403).json({ success: false, error: "Cross-origin session exchange is not allowed" });
  }
  const accessToken = typeof req.body?.accessToken === "string" ? req.body.accessToken : "";
  if (!accessToken || accessToken.length > 8_192) {
    return res.status(400).json({ success: false, error: "Missing or invalid identity token" });
  }

  const user = await resolveAuthenticatedUser(accessToken);
  if (!user) {
    return res.status(401).json({ success: false, error: "Identity token is invalid or expired" });
  }

  const csrfToken = issueSession(res, user);
  res.json({ success: true, data: { csrfToken } });
});

// POST /api/v1/auth/mobile/session
// The native application exchanges a Supabase access token for a FarmOS bearer
// token. Browser cookies and CSRF tokens are deliberately not issued here.
router.post("/mobile/session", async (req, res) => {
  const accessToken = typeof req.body?.accessToken === "string" ? req.body.accessToken : "";
  if (!accessToken || accessToken.length > 8_192) {
    return res.status(400).json({ success: false, error: "Missing or invalid identity token" });
  }

  const user = await resolveAuthenticatedUser(accessToken);
  if (!user) {
    return res.status(401).json({ success: false, error: "Identity token is invalid or expired" });
  }

  res.json({
    success: true,
    data: {
      accessToken: issueMobileSession(user),
      expiresIn: env.MOBILE_SESSION_TTL_SEC,
      user,
    },
  });
});

// POST /api/v1/auth/avatar
// Stores an authenticated user's selected photo on the FarmOS server. The
// public URL is deliberately opaque; authorization is required to replace it.
router.post("/avatar", authenticate, async (req: AuthRequest, res) => {
  try {
    const upload = await receiveAvatar(req);
    const filename = saveAvatar(req.user!.id, upload.bytes, upload.extension);
    const avatarUrl = `${env.FARMOS_API_URL.replace(/\/$/, "")}/uploads/avatars/${filename}`;
    const previousAvatar = req.user!.avatar_url;
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { avatar_url: avatarUrl },
      select: { id: true, email: true, name: true, role: true, avatar_url: true },
    });
    removeManagedAvatar(previousAvatar);
    res.json({ success: true, data: user });
  } catch (error) {
    if (error instanceof AvatarUploadError) return res.status(error.status).json({ success: false, error: error.message });
    console.error("Avatar upload failed", error);
    return res.status(500).json({ success: false, error: "Không thể lưu ảnh đại diện" });
  }
});

router.post("/logout", authenticate, (req, res) => {
  clearSession(res);
  res.status(204).end();
});

router.get("/csrf", authenticate, (req: AuthRequest, res) => {
  res.json({ success: true, data: { csrfToken: req.session!.csrf } });
});

// POST /api/v1/auth/login
router.post("/login", async (req, res) => {
  if (legacyPasswordAuthDisabled(res)) return;
  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        user_farms: {
          include: { farm: true }
        }
      }
    });

    if (!user) {
      return res.status(401).json({ success: false, error: "Email hoặc mật khẩu không chính xác" });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ success: false, error: "Email hoặc mật khẩu không chính xác" });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d", algorithm: "HS256", issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE }
    );

    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          avatar_url: user.avatar_url,
          farms: user.user_farms.map((uf) => uf.farm)
        }
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/v1/auth/register
router.post("/register", async (req, res) => {
  if (legacyPasswordAuthDisabled(res)) return;
  const { email, password, name, farmName, address, latitude, longitude } = req.body;

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ success: false, error: "Email này đã được sử dụng" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name: name || email.split("@")[0],
        role: "USER"
      }
    });

    // Tự động tạo một Farm mặc định cho khách hàng mới
    const farmId = `F_${Date.now().toString(36).toUpperCase()}`;
    const farm = await prisma.farm.create({
      data: {
        id: farmId,
        name: farmName || `Vườn của ${user.name || "tôi"}`,
        location: address || "Chưa xác định",
        address: address || null,
        latitude: latitude ? parseFloat(latitude) : 10.854886,
        longitude: longitude ? parseFloat(longitude) : 106.786523,
      }
    });

    // A farm membership scopes this USER's data; global authorization uses only
    // the USER and ADMIN roles on the User record.
    await prisma.userFarm.create({
      data: {
        user_id: user.id,
        farm_id: farm.id,
      }
    });

    // Tạo sẵn 1 Zone mặc định cho vườn
    const zoneId = `Z01_${farm.id.slice(-4)}`;
    await prisma.zone.create({
      data: {
        id: zoneId,
        farm_id: farm.id,
        name: "Khu Vực 1 (Mặc định)",
        crop_type: "Cây trồng tổng hợp",
        target_moisture_min: 45.0,
        target_moisture_max: 75.0,
        valve_id: "V01"
      }
    });

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "7d", algorithm: "HS256", issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE }
    );

    res.status(201).json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          avatar_url: user.avatar_url,
          farms: [farm]
        }
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// POST /api/v1/auth/sync - Đồng bộ thông tin người dùng từ Supabase Auth (khi đăng ký/đăng nhập mới)
router.post("/sync", authenticate, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { name, avatar_url, avatarUrl, farmName, address, latitude, longitude } = req.body;
    const resolvedAvatar = avatar_url !== undefined ? avatar_url : avatarUrl;
    if (resolvedAvatar === null) {
      cleanUserAvatars(user.id);
    }

    // Cập nhật thông tin profile nếu được gửi kèm
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(name ? { name } : {}),
        ...(resolvedAvatar !== undefined ? { avatar_url: resolvedAvatar } : {}),
      },
      include: {
        user_farms: {
          include: {
            farm: {
              include: { zones: true, nodes: true }
            }
          }
        }
      }
    });

    // Nếu có thông tin vườn được cập nhật trong quá trình đăng ký
    if (farmName || address || latitude || longitude) {
      const primaryFarm = updatedUser.user_farms[0]?.farm;
      if (primaryFarm) {
        await prisma.farm.update({
          where: { id: primaryFarm.id },
          data: {
            ...(farmName ? { name: farmName } : {}),
            ...(address ? { address, location: address } : {}),
            ...(latitude !== undefined ? { latitude: parseFloat(latitude) } : {}),
            ...(longitude !== undefined ? { longitude: parseFloat(longitude) } : {}),
          }
        });
      }
    }

    res.json({
      success: true,
      data: {
        id: updatedUser.id,
        email: updatedUser.email,
        name: updatedUser.name,
        role: updatedUser.role,
        avatar_url: updatedUser.avatar_url,
        farms: updatedUser.user_farms.map((uf) => uf.farm)
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/v1/auth/me
router.get("/me", authenticate, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        avatar_url: true,
        user_farms: {
          select: {
            farm: {
              select: { id: true, name: true, location: true, address: true, latitude: true, longitude: true },
            },
          },
        }
      }
    });

    if (!user) {
      return res.status(404).json({ success: false, error: "Người dùng không tồn tại" });
    }

    res.json({
      success: true,
      data: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        avatar_url: user.avatar_url,
        farms: user.user_farms.map((uf) => uf.farm)
      }
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
