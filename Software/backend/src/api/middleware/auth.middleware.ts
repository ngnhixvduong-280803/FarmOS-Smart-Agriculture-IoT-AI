import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../../database/prisma";
import { supabase, isDefaultAdmin } from "../../config/supabase";
import { env } from "../../config/env";

const JWT_SECRET = env.JWT_SECRET;

export interface AuthUser {
  id: string;
  email: string;
  role: "ADMIN" | "USER" | string;
  name?: string | null;
  avatar_url?: string | null;
}

interface SessionClaims extends AuthUser {
  csrf: string;
}

export type SessionRequest = Pick<Request, "headers"> & Partial<Pick<Request, "get">>;

function readHeader(req: SessionRequest, name: string): string | null {
  const expressValue = typeof req.get === "function" ? req.get(name) : undefined;
  const rawValue = expressValue ?? req.headers[name.toLowerCase()];
  if (Array.isArray(rawValue)) return rawValue[0] || null;
  return typeof rawValue === "string" ? rawValue : null;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
  session?: SessionClaims;
}

function readCookie(req: SessionRequest, name: string): string | null {
  const cookieHeader = readHeader(req, "cookie");
  if (!cookieHeader) return null;
  const prefix = `${name}=`;
  for (const entry of cookieHeader.split(";")) {
    const cookie = entry.trim();
    if (cookie.startsWith(prefix)) return decodeURIComponent(cookie.slice(prefix.length));
  }
  return null;
}

function resolveSession(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as SessionClaims;
    return decoded?.id && decoded.email && typeof decoded.csrf === "string" ? decoded : null;
  } catch {
    return null;
  }
}

function readBearerToken(req: SessionRequest): string | null {
  const authorization = readHeader(req, "authorization");
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1] || null;
}

function resolveMobileSession(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: env.JWT_ISSUER,
      audience: env.MOBILE_JWT_AUDIENCE,
    }) as SessionClaims;
    return decoded?.id && decoded.email ? decoded : null;
  } catch {
    return null;
  }
}

function isUnsafeMethod(req: Request): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(req.method);
}

function isSameOriginRequest(req: Request): boolean {
  const origin = req.get("origin");
  if (!origin) return false;
  if (env.CORS_ORIGIN === "*") return true;
  return origin === env.CORS_ORIGIN;
}

/**
 * Middleware xác thực người dùng:
 * 1. Thử xác thực qua Supabase Auth nếu token từ Supabase
 * 2. Nếu thất bại hoặc chạy offline/local, fallback kiểm tra JWT nội bộ của FarmOS
 * 3. Tự động đồng bộ và nạp Role (ADMIN / USER) từ CSDL
 */
export async function resolveAuthenticatedUser(token: string, allowVerifiedJwt = false): Promise<AuthUser | null> {
  let identifiedEmail: string | null = null;
  let identifiedId: string | null = null;
  let userName: string | null = null;
  let userAvatar: string | null = null;

  // A mobile bearer has already been signature/audience checked by
  // authenticate(). It is issued by FarmOS, not Supabase, so sending it to
  // Supabase first creates a needless external network hop on every request.
  if (allowVerifiedJwt) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: env.JWT_ISSUER,
        audience: [env.JWT_AUDIENCE, env.MOBILE_JWT_AUDIENCE],
      }) as any;
      if (decoded && (decoded.email || decoded.id)) {
        identifiedId = decoded.id;
        identifiedEmail = decoded.email;
        userName = decoded.name;
        userAvatar = decoded.avatar_url;
      }
    } catch { /* verification failure is an authentication failure */ }
  }

  // Supabase identity tokens are verified only at the OAuth exchange boundary.
  if (!identifiedEmail && supabase) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(token);
      if (user && !error) {
        identifiedId = user.id;
        identifiedEmail = user.email || null;
        userName = user.user_metadata?.full_name || user.user_metadata?.name || null;
        userAvatar = user.user_metadata?.avatar_url || user.user_metadata?.picture || null;
      }
    } catch {
      // Bỏ qua lỗi để thử fallback sang JWT
    }
  }

  // 2. Local migration tokens must be verified with a server-side secret. Never
  // decode an unverified JWT: its payload is attacker-controlled input.
  if (!identifiedEmail && env.ALLOW_LEGACY_PASSWORD_AUTH) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: env.JWT_ISSUER,
        audience: [env.JWT_AUDIENCE, env.MOBILE_JWT_AUDIENCE],
      }) as any;
      if (decoded && (decoded.email || decoded.id)) {
        identifiedId = decoded.id;
        identifiedEmail = decoded.email;
        userName = decoded.name;
        userAvatar = decoded.avatar_url;
      }
    } catch { /* verification failure is an authentication failure */ }
  }

  if (!identifiedEmail) {
    return null;
  }

  try {
    // 3. Tra cứu User trong CSDL Prisma
    let dbUser = await prisma.user.findFirst({
      where: {
        OR: [
          ...(identifiedId ? [{ id: identifiedId }] : []),
          { email: identifiedEmail },
        ],
      },
    });

    const shouldBeAdmin = isDefaultAdmin(identifiedEmail);
    const assignedRole = shouldBeAdmin ? "ADMIN" : "USER";

    // 4. Tự động tạo bản ghi User trong DB nếu chưa tồn tại (Auto-provisioning)
    if (!dbUser) {
      const userId = identifiedId || `U_${Date.now().toString(36).toUpperCase()}`;
      dbUser = await prisma.user.create({
        data: {
          id: userId,
          email: identifiedEmail,
          password: "", // Tài khoản xác thực qua Supabase OAuth / Auth
          name: userName || identifiedEmail.split("@")[0],
          avatar_url: userAvatar,
          role: assignedRole,
        },
      });

      // Tự động khởi tạo Farm & Zone mặc định cho User mới
      const farmId = `F_${Date.now().toString(36).toUpperCase()}`;
      const defaultFarm = await prisma.farm.create({
        data: {
          id: farmId,
          name: `Vườn của ${dbUser.name || "tôi"}`,
          location: "Thành phố Hồ Chí Minh, Việt Nam",
          latitude: 10.854886,
          longitude: 106.786523,
        },
      });

      await prisma.userFarm.create({
        data: {
          user_id: dbUser.id,
          farm_id: defaultFarm.id,
        },
      });

      await prisma.zone.create({
        data: {
          id: `Z01_${defaultFarm.id.slice(-4)}`,
          farm_id: defaultFarm.id,
          name: "Khu Vực 1 (Mặc định)",
          crop_type: "Cây trồng tổng hợp",
          target_moisture_min: 45.0,
          target_moisture_max: 75.0,
          valve_id: "V01",
        },
      });
    } else {
      const updateData: Record<string, any> = {};
      if (shouldBeAdmin && dbUser.role !== "ADMIN") {
        updateData.role = "ADMIN";
      }
      if (userAvatar && dbUser.avatar_url !== userAvatar) {
        updateData.avatar_url = userAvatar;
      }
      if (Object.keys(updateData).length > 0) {
        dbUser = await prisma.user.update({
          where: { id: dbUser.id },
          data: updateData,
        });
      }
    }

    return {
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
      name: dbUser.name,
      avatar_url: dbUser.avatar_url,
    };
  } catch (error: any) {
    console.error("❌ [AUTH MIDDLEWARE ERROR]:", error);
    return null;
  }
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction) => {
  // A React Native app cannot safely depend on browser cookies or same-origin
  // CSRF semantics. Its short-lived, device-stored bearer is signed with a
  // dedicated audience and is therefore intentionally CSRF-exempt.
  const bearerToken = readBearerToken(req);
  const mobileSession = bearerToken ? resolveMobileSession(bearerToken) : null;
  if (bearerToken) {
    if (!mobileSession) {
      return res.status(401).json({ success: false, error: "Invalid or expired mobile session" });
    }
    // JWT claims are only an authentication hint. Roles and account existence
    // are authoritative in the database so an already-issued token cannot
    // retain ADMIN access after a role change or user deletion.
    const currentUser = await resolveAuthenticatedUser(bearerToken, true);
    if (!currentUser) {
      return res.status(401).json({ success: false, error: "User session is no longer valid" });
    }
    req.session = mobileSession;
    req.user = { id: currentUser.id, email: currentUser.email, role: currentUser.role, name: currentUser.name, avatar_url: currentUser.avatar_url };
    return next();
  }

  const sessionToken = readCookie(req, env.SESSION_COOKIE_NAME);
  const session = sessionToken ? resolveSession(sessionToken) : null;
  if (!session) {
    return res.status(401).json({ success: false, error: "Authentication token is missing" });
  }

  if (isUnsafeMethod(req)) {
    const csrfToken = req.get("x-csrf-token");
    if (!isSameOriginRequest(req) || !csrfToken || csrfToken !== session.csrf) {
      return res.status(403).json({ success: false, error: "CSRF validation failed" });
    }
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: session.id },
    select: { id: true, email: true, role: true, name: true, avatar_url: true },
  });
  if (!currentUser) {
    return res.status(401).json({ success: false, error: "User session is no longer valid" });
  }

  req.session = session;
  req.user = { id: currentUser.id, email: currentUser.email, role: currentUser.role, name: currentUser.name, avatar_url: currentUser.avatar_url };
  next();
};

export function getSessionFromRequest(req: SessionRequest): SessionClaims | null {
  const bearerToken = readBearerToken(req);
  if (bearerToken) return resolveMobileSession(bearerToken);
  const token = readCookie(req, env.SESSION_COOKIE_NAME);
  return token ? resolveSession(token) : null;
}

/**
 * Middleware kiểm tra quyền theo Role (ADMIN, USER,...)
 */
export const requireRole = (roles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: "Unauthorized: Vui lòng đăng nhập" });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        error: `Forbidden: Yêu cầu quyền [${roles.join(", ")}], quyền hiện tại của bạn là [${req.user.role}]`,
      });
    }

    next();
  };
};
