import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import { env } from "../config/env";
import { prisma } from "../database/prisma";
import { AuthUser, getSessionFromRequest } from "../api/middleware/auth.middleware";

let io: SocketIOServer | null = null;

function farmRoom(farmId: string) {
  return `farm:${farmId}`;
}

export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: { origin: env.CORS_ORIGIN, methods: ["GET", "POST"] },
  });

  io.use(async (socket, next) => {
    const bearerToken = typeof socket.handshake.auth?.token === "string" ? socket.handshake.auth.token : null;
    const headers = bearerToken
      ? { ...socket.handshake.headers, authorization: `Bearer ${bearerToken}` }
      : socket.handshake.headers;
    const session = getSessionFromRequest({ headers });
    if (!session) return next(new Error("Unauthorized"));
    const user: AuthUser = { id: session.id, email: session.email, role: session.role, name: session.name };

    socket.data.user = user;
    const farmIds = user.role === "ADMIN"
      ? (await prisma.farm.findMany({ select: { id: true } })).map((farm) => farm.id)
      : (await prisma.userFarm.findMany({ where: { user_id: user.id }, select: { farm_id: true } })).map((membership) => membership.farm_id);
    farmIds.forEach((farmId) => socket.join(farmRoom(farmId)));
    next();
  });

  io.on("connection", (socket: Socket) => {
    const user = socket.data.user as AuthUser;
    console.log(`🔌 [WebSocket] Authenticated client connected: ${socket.id}`);

    socket.on("disconnect", () => {
      console.log(`❌ [WebSocket] Client disconnected: ${socket.id}`);
    });

    socket.on("subscribe:zone", async (zoneId: string, callback?: (result: { ok: boolean; error?: string }) => void) => {
      if (typeof zoneId !== "string" || zoneId.length > 128) {
        callback?.({ ok: false, error: "Invalid zone" });
        return;
      }
      const zone = await prisma.zone.findUnique({
        where: { id: zoneId },
        select: { farm: { select: { user_farms: { where: { user_id: user.id }, select: { user_id: true } } } } },
      });
      const permitted = user.role === "ADMIN" || Boolean(zone?.farm.user_farms.length);
      if (!permitted || !zone) {
        callback?.({ ok: false, error: "Forbidden" });
        return;
      }
      socket.join(`zone:${zoneId}`);
      callback?.({ ok: true });
    });
  });

  return io;
}

export function getSocketServer(): SocketIOServer | null {
  return io;
}

export function broadcastTelemetry(payload: { farmId: string; zoneId: string; nodeId: string; soil_moisture?: number | null; soil_temp?: number | null; air_temp?: number | null; air_humidity?: number | null; lux?: number | null; quality?: number; timestamp: number }) {
  if (!io) return;
  io.to(farmRoom(payload.farmId)).emit("telemetry:update", payload);
  io.to(`zone:${payload.zoneId}`).emit("telemetry:zone_update", payload);
}

export function broadcastGatewayStatus(payload: { farmId: string; nodeId: string; online: boolean; water_tank_level_pct: number; water_tank_safe: boolean; rssi?: number; active_valves?: string[]; timestamp: number }) {
  io?.to(farmRoom(payload.farmId)).emit("gateway:status", payload);
}

export function broadcastIrrigationStatus(payload: { farmId: string; commandId: string; zoneId: string; status: string; measured_flow_liters?: number | null; error_code?: number; timestamp: number }) {
  io?.to(farmRoom(payload.farmId)).emit("irrigation:status", payload);
}

export function broadcastAlert(payload: { farm_id: string; id: string; zone_id?: string | null; level: string; type: string; message: string; created_at: string }) {
  io?.to(farmRoom(payload.farm_id)).emit("alert:new", payload);
}
