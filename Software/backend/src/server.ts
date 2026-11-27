import "./config/env";
import http from "http";
import { createApp } from "./api/app";
import { env } from "./config/env";
import { initSocketServer } from "./websocket/socket.server";
import { initMqttClient } from "./mqtt/mqtt.client";
import { startSimulationRetention } from './simulation/retention';
import { prisma } from "./database/prisma";

async function bootstrap() {
  console.log("🌾 ==========================================");
  console.log("🌾 FarmOS — AIoT Retrofit Server Khởi Động");
  console.log("🌾 ==========================================");

  // 1. Kiểm tra kết nối Cơ sở dữ liệu (PostgreSQL / Supabase)
  try {
    await prisma.$connect();
    console.log("✅ [DATABASE] Kết nối cơ sở dữ liệu thành công!");
  } catch (dbError: any) {
    console.warn("⚠️ [DATABASE] Chưa thể kết nối Cơ sở dữ liệu (Hãy đảm bảo Docker Postgres hoặc Supabase đang chạy):", dbError.message);
  }

  // 2. Khởi tạo Express App & HTTP Server
  const app = createApp();
  const httpServer = http.createServer(app);
  // Bound headers/body lifetime independently of Express route handlers. The
  // firmware multipart parser applies the same ten-minute wall-clock bound;
  // these server defaults also protect JSON and legacy clients when a proxy
  // is bypassed accidentally.
  httpServer.requestTimeout = 10 * 60_000;
  httpServer.headersTimeout = 15_000;
  httpServer.keepAliveTimeout = 65_000;

  // 3. Khởi tạo WebSocket Server (Socket.io)
  initSocketServer(httpServer);
  console.log("✅ [WEBSOCKET] Socket.io Realtime Server đã sẵn sàng!");

  // 4. Khởi tạo MQTT Client Worker
  try {
    initMqttClient({ enableLegacyIngest: env.ENABLE_LEGACY_MQTT_INGEST });
  } catch (mqttError: any) {
    console.warn("⚠️ [MQTT] Chưa thể kết nối MQTT Broker (Hãy đảm bảo Mosquitto đang chạy):", mqttError.message);
  }

  // 5. Bắt đầu lắng nghe HTTP Port
  httpServer.listen(env.PORT, () => {
    if (process.env.FARMOS_SIMULATION_RETENTION === '1') startSimulationRetention();
    console.log(`🚀 [SERVER] REST API & WebSocket đang chạy tại: http://localhost:${env.PORT}`);
    console.log(`📊 [HEALTH] Liveness: http://localhost:${env.PORT}/health | Readiness: http://localhost:${env.PORT}/readyz`);
    console.log("🌾 ==========================================\n");
  });

  // Xử lý tắt server an toàn (Graceful Shutdown)
  const shutdown = async () => {
    console.log("\n🛑 Đang dừng server...");
    await prisma.$disconnect();
    httpServer.close(() => {
      console.log("👋 Đã đóng toàn bộ kết nối. Hẹn gặp lại!");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((err) => {
  console.error("❌ Lỗi nghiêm trọng khi khởi động server:", err);
  process.exit(1);
});
