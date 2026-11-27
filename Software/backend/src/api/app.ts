import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { rateLimit } from "express-rate-limit";
import { env } from "../config/env";
import { prisma } from "../database/prisma";
import authRoutes from "./routes/auth.routes";
import userRoutes from "./routes/user.routes";
import nodeRoutes from "./routes/node.routes";
import farmRoutes from "./routes/farm.routes";
import zoneRoutes from "./routes/zone.routes";
import simulationRoutes from "./routes/simulation.routes";
import telemetryRoutes from "./routes/telemetry.routes";
import irrigationRoutes from "./routes/irrigation.routes";
import { pumpDeviceRoutes, pumpWebRoutes } from "./routes/pump.routes";
import alertRoutes from "./routes/alert.routes";
import onboardingRoutes from "./routes/onboarding.routes";
import otaRoutes from "./routes/ota.routes";
import manufacturingRoutes from "./routes/manufacturing.routes";
import flashRoutes from "./routes/flash.routes";
import adminFirmwareRoutes from "./routes/admin-firmware.routes";
import adminDeviceRoutes from "./routes/admin-device.routes";
import farmAssistantRoutes from "./routes/farm-assistant.routes";
import farmJournalRoutes from "./routes/farm-journal.routes";
import { avatarStorageDir } from "./avatar-upload";

export function createApp() {
  const app = express();
  // The backend is reachable through the local reverse proxy/Tunnel only.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Middleware
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    })
  );
  app.use(express.json({ limit: "64kb" }));
  app.use("/uploads/avatars", express.static(avatarStorageDir(), {
    fallthrough: false,
    immutable: true,
    maxAge: "1y",
    setHeaders: (res) => res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"),
  }));
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
    next();
  });
  app.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: "draft-7", legacyHeaders: false }));
  app.use("/api/v1/auth", rateLimit({
    windowMs: 15 * 60_000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false,
    skip: (req) => req.method === "GET" || req.method === "HEAD",
  }));

  // Logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (env.NODE_ENV === "development" && !req.path.includes("/health")) {
      console.log(`📡 [HTTP] ${req.method} ${req.path}`);
    }
    next();
  });

  // Health Check
  app.get("/health", (req: Request, res: Response) => {
    res.json({
      status: "healthy",
      service: "farmos-backend",
      timestamp: new Date().toISOString(),
      uptime_sec: process.uptime(),
    });
  });

  // Liveness deliberately stays cheap. Production orchestration must use this
  // readiness endpoint so a process that started without PostgreSQL is never
  // promoted as a healthy application.
  app.get("/readyz", async (req: Request, res: Response) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: "ready", service: "farmos-backend" });
    } catch {
      res.status(503).json({ status: "not_ready", service: "farmos-backend" });
    }
  });

  // API v1 Routes
  app.use("/api/v1/auth", authRoutes);
  app.use("/api/v1/users", userRoutes);
  app.use("/api/v1/nodes", nodeRoutes);
  
  app.use("/api/v1/farms", farmRoutes);
  app.use("/api/v1/zones", zoneRoutes);
  app.use("/api/v1/telemetry", telemetryRoutes);
  app.use("/api/v1/simulation", simulationRoutes);
  app.use("/api/v1/farm-assistant", farmAssistantRoutes);
  app.use("/api/v1/farm-journal", farmJournalRoutes);
  app.use("/api/v1/irrigation", irrigationRoutes);
  app.use("/api/v1/alerts", alertRoutes);
  app.use("/api/v1/onboarding/pump", pumpDeviceRoutes);
  app.use("/api/v1/onboarding", onboardingRoutes);
  app.use("/api/v1/pumps", pumpWebRoutes);
  app.use("/api/v1/ota", otaRoutes);
  app.use("/api/v1/admin/firmware", adminFirmwareRoutes);
  app.use("/api/v1/admin/devices", adminDeviceRoutes);
  app.use("/api/v1/manufacturing", manufacturingRoutes);
  // HardwareBoard generations and Web Serial FlashJob orchestration. This is
  // additive to the legacy /ota API, which remains available to already
  // flashed Gateway/Node firmware during migration.
  app.use("/api/v1/flash", flashRoutes);
  // Short contract aliases used by the Web Serial client during migration;
  // the canonical documented prefix remains /api/v1/flash.
  app.use("/api/v1", flashRoutes);

  // 404 Handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      error: `Không tìm thấy tài nguyên: ${req.method} ${req.path}`,
    });
  });

  // Error handling middleware
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (err?.type === "entity.too.large" || err?.status === 413) {
      return res.status(413).json({
        success: false,
        error: "Payload quá lớn",
      });
    }

    console.error("❌ [UNCAUGHT ERROR]:", err);
    res.status(500).json({
      success: false,
      error: "Đã xảy ra lỗi hệ thống nội bộ",
      ...(env.NODE_ENV === "development" ? { message: err.message } : {}),
    });
  });

  return app;
}
