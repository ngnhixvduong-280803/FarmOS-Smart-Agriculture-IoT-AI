import http from "http";
import mqtt, { MqttClient } from "mqtt";
import readline from "readline";
import path from "path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { SensorNode, GatewayDevice, SimulatorLog } from "./types.js";
import { GatewayPersistence, OutboundKind } from "./gateway-persistence.js";

// Nạp file .env từ thư mục gốc
dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "../.env") });
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const MQTT_BROKER = process.env.GATEWAY_MQTT_BROKER_URL?.trim() || "";
const API_CONFIG = resolveApiOrigin();
const BACKEND_API_URL = `${API_CONFIG.origin}/api/v1/telemetry`;
const BACKEND_BASE_URL = BACKEND_API_URL.replace(/\/api\/v1\/telemetry\/?$/, "");
if (!["FARMOS_API_URL", "default"].includes(API_CONFIG.sourceKey)) {
  console.warn(`Simulator config warning: ${API_CONFIG.sourceKey} is deprecated; use FARMOS_API_URL`);
}
const DEVICE_INGEST_TOKEN = process.env.DEVICE_INGEST_TOKEN || "";
const MQTT_AUTH_MODE = process.env.GATEWAY_MQTT_AUTH_MODE?.trim().toLowerCase() || "mtls";
const MQTT_USERNAME = process.env.GATEWAY_MQTT_USERNAME?.trim() || "";
const MQTT_PASSWORD = process.env.GATEWAY_MQTT_PASSWORD || "";
const MQTT_CA_FILE = process.env.GATEWAY_MQTT_CA_CERT_FILE?.trim() || "";
const MQTT_CERT_FILE = process.env.GATEWAY_MQTT_CLIENT_CERT_FILE?.trim() || "";
const MQTT_KEY_FILE = process.env.GATEWAY_MQTT_CLIENT_KEY_FILE?.trim() || "";
const FARM_ID = process.env.FARM_ID || "F01";
const WEB_CONTROL_PORT = Number(process.env.SIMULATOR_PORT) || 4000;
let telemetryIntervalSec = Number(process.env.TELEMETRY_INTERVAL_SEC) || 15;
const OUTBOX_FILE = path.resolve(process.env.GATEWAY_OUTBOX_FILE || path.join(process.cwd(), ".gateway-simulator-outbox.json"));
const OUTBOX_MAX_MESSAGES = Number(process.env.GATEWAY_OUTBOX_MAX_MESSAGES) || 500;
const MQTT_RETRY_INITIAL_MS = Number(process.env.GATEWAY_MQTT_RETRY_INITIAL_MS) || 1_000;
const MQTT_RETRY_MAX_MS = Number(process.env.GATEWAY_MQTT_RETRY_MAX_MS) || 60_000;
const MQTT_KEEPALIVE_SEC = Number(process.env.GATEWAY_MQTT_KEEPALIVE_SEC) || 60;
const commandStore = new GatewayPersistence(OUTBOX_FILE, OUTBOX_MAX_MESSAGES);

// ==========================================
// 1. DANH SÁCH NHIỀU GATEWAY ĐỘNG
// ==========================================
export const gateways: GatewayDevice[] = [
  {
    id: "GATEWAY_01",
    serial_number: "SN-FOS-GW-001",
    name: "Gateway Trạm Bơm Trung Tâm - Phân Khu A",
    farm_id: FARM_ID,
    online: true,
    water_tank_level_pct: 88.0,
    water_tank_safe: true,
    rssi: -58,
    firmware: "ESP32_GW_v2.0_DualMode",
    active_valves: [],
    is_pump_running: false,
    transport_mode: "http",
    simulate_no_flow: false,
    simulate_offline: false,
    mqtt_connected: false,
    api_connected: true,
  },
  {
    id: "GATEWAY_02",
    serial_number: "SN-FOS-GW-002",
    name: "Gateway Trạm Bơm Phụ Trợ - Phân Khu B",
    farm_id: FARM_ID,
    online: true,
    water_tank_level_pct: 75.0,
    water_tank_safe: true,
    rssi: -62,
    firmware: "ESP32_GW_v2.0_DualMode",
    active_valves: [],
    is_pump_running: false,
    transport_mode: "http",
    simulate_no_flow: false,
    simulate_offline: false,
    mqtt_connected: false,
    api_connected: true,
  },
];

// ==========================================
// 2. DANH SÁCH NHIỀU SENSOR NODE ĐỘNG
// ==========================================
export const nodes: SensorNode[] = [
  {
    node_id: "NODE_Z01_01",
    serial_number: "SN-FOS-2026-Z01",
    name: "Cảm biến Zone 1 - Cà Chua Cherry",
    farm_id: FARM_ID,
    zone_id: "Z01",
    gateway_id: "GATEWAY_01",
    valve_id: "V01",
    crop_type: "Cà chua Cherry",
    soil_moisture: 42.0,
    soil_temp: 26.5,
    air_temp: 28.5,
    air_humidity: 74.0,
    lux: 16500,
    quality: 1,
    online: true,
    auto_dry: true,
  },
  {
    node_id: "NODE_Z02_01",
    serial_number: "SN-FOS-2026-Z02",
    name: "Cảm biến Zone 2 - Dưa Lưới",
    farm_id: FARM_ID,
    zone_id: "Z02",
    gateway_id: "GATEWAY_01",
    valve_id: "V02",
    crop_type: "Dưa lưới",
    soil_moisture: 58.5,
    soil_temp: 25.8,
    air_temp: 28.2,
    air_humidity: 76.0,
    lux: 17200,
    quality: 1,
    online: true,
    auto_dry: true,
  },
  {
    node_id: "NODE_Z03_01",
    serial_number: "SN-FOS-2026-Z03",
    name: "Cảm biến Zone 3 - Rau Ăn Lá",
    farm_id: FARM_ID,
    zone_id: "Z03",
    gateway_id: "GATEWAY_01",
    valve_id: "V03",
    crop_type: "Rau ăn lá",
    soil_moisture: 35.0,
    soil_temp: 27.2,
    air_temp: 29.0,
    air_humidity: 71.0,
    lux: 15800,
    quality: 1,
    online: true,
    auto_dry: true,
  },
  {
    node_id: "NODE_Z04_01",
    serial_number: "SN-FOS-2026-Z04",
    name: "Cảm biến Zone 4 - Dâu Tây",
    farm_id: FARM_ID,
    zone_id: "Z04",
    gateway_id: "GATEWAY_02",
    valve_id: "V04",
    crop_type: "Dâu tây New Zealand",
    soil_moisture: 50.0,
    soil_temp: 24.5,
    air_temp: 26.0,
    air_humidity: 80.0,
    lux: 14000,
    quality: 1,
    online: true,
    auto_dry: true,
  },
];

// Nhật ký sự kiện phục vụ Web UI
export const recentLogs: SimulatorLog[] = [];
export function addLog(type: "CMD" | "ACK" | "INFO" | "WARN" | "ERR", message: string) {
  const time = new Date().toLocaleTimeString();
  recentLogs.unshift({ time, type, message });
  if (recentLogs.length > 80) recentLogs.pop();
}

// Bộ hẹn giờ tưới cho từng Gateway
const activeIrrigationTimers = new Map<string, NodeJS.Timeout>();

// ==========================================
// 3. KẾT NỐI MQTT BROKER
// ==========================================
let mqttClient: MqttClient | null = null;
let mqttReconnectTimer: NodeJS.Timeout | null = null;
let mqttReconnectDelayMs = MQTT_RETRY_INITIAL_MS;
let publishingOutbox = false;
const mqttConfigurationError = getMqttConfigurationError();

if (mqttConfigurationError) {
  addLog("WARN", `MQTT chưa được bật: ${mqttConfigurationError}`);
} else {
  startMqttConnection();
}

function startMqttConnection(): void {
  try {
    mqttClient = mqtt.connect(MQTT_BROKER, {
      clientId: `FarmOS_GW_MultiSim_${Math.random().toString(16).substring(2, 6)}`,
      clean: false,
      protocolVersion: 4,
      reconnectPeriod: 0,
      connectTimeout: 10_000,
      keepalive: MQTT_KEEPALIVE_SEC,
      resubscribe: true,
      ...(MQTT_AUTH_MODE === "mtls" ? getMutualTlsOptions() : {
        username: MQTT_USERNAME,
        password: MQTT_PASSWORD,
      }),
      will: {
        topic: `farm/${FARM_ID}/node/GATEWAY_01/status`,
        payload: JSON.stringify(createGatewayStatusPayload(gateways[0], false, "last_will")),
        qos: 1,
        retain: true,
      },
    });

    mqttClient.on("connect", () => {
      if (mqttReconnectTimer) clearTimeout(mqttReconnectTimer);
      mqttReconnectTimer = null;
      mqttReconnectDelayMs = MQTT_RETRY_INITIAL_MS;
      gateways.forEach((gw) => (gw.mqtt_connected = true));
      addLog("INFO", `Đã kết nối MQTT Broker (${MQTT_AUTH_MODE.toUpperCase()}): ${MQTT_BROKER}`);

      // Lắng nghe lệnh cho tất cả các zone
      const commandTopic = `farm/${FARM_ID}/zone/+/command`;
      mqttClient?.subscribe(commandTopic, { qos: 1 }, (err) => {
        if (!err) {
          addLog("INFO", `Đang lắng nghe lệnh QoS 1 tại: ${commandTopic}`);
          recoverInterruptedCommands();
          flushMqttOutbox();
          void sendSnapshot();
        } else {
          addLog("ERR", `Không thể subscribe lệnh MQTT: ${err.message}`);
        }
      });
    });

    mqttClient.on("error", (err) => {
      gateways.forEach((gw) => (gw.mqtt_connected = false));
      addLog("WARN", `Cảnh báo MQTT: ${err.message}`);
    });

    mqttClient.on("close", () => {
      gateways.forEach((gw) => (gw.mqtt_connected = false));
      scheduleMqttReconnect();
    });

    mqttClient.on("message", (topic, message) => {
      try {
        const payload = JSON.parse(message.toString());
        const parts = topic.split("/");
        const zoneId = parts[3];
        handleIncomingIrrigationCommand(zoneId, payload);
      } catch (e: any) {
        addLog("ERR", `Lỗi parse JSON lệnh từ ${topic}: ${e.message}`);
      }
    });
  } catch (e: any) {
    addLog("ERR", `Không thể khởi tạo MQTT: ${e.message}`);
    scheduleMqttReconnect();
  }
}

function scheduleMqttReconnect(): void {
  if (mqttReconnectTimer || mqttConfigurationError) return;

  const jitter = Math.floor(Math.random() * Math.max(250, mqttReconnectDelayMs * 0.2));
  const delay = Math.min(MQTT_RETRY_MAX_MS, mqttReconnectDelayMs + jitter);
  addLog("WARN", `MQTT đã ngắt; thử lại sau ${delay}ms.`);
  mqttReconnectTimer = setTimeout(() => {
    mqttReconnectTimer = null;
    if (mqttClient) mqttClient.reconnect();
  }, delay);
  mqttReconnectDelayMs = Math.min(MQTT_RETRY_MAX_MS, mqttReconnectDelayMs * 2);
}

function getMutualTlsOptions(): { ca: Buffer; cert: Buffer; key: Buffer; rejectUnauthorized: true; servername?: string } {
  return {
    ca: fs.readFileSync(MQTT_CA_FILE),
    cert: fs.readFileSync(MQTT_CERT_FILE),
    key: fs.readFileSync(MQTT_KEY_FILE),
    rejectUnauthorized: true,
  };
}

function resolveApiOrigin(): { origin: string; sourceKey: string } {
  const candidates: Array<[string, string, boolean]> = [
    ["FARMOS_API_URL", process.env.FARMOS_API_URL || "", false],
    ["MOBILE_API_BASE_URL", process.env.MOBILE_API_BASE_URL || "", true],
    ["BACKEND_API_URL", process.env.BACKEND_API_URL || "", true],
  ];
  const selected = candidates.find(([, value]) => value.trim());
  if (!selected) return { origin: "http://localhost:3000", sourceKey: "default" };
  const [sourceKey, raw, allowLegacyPath] = selected;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`${sourceKey} must be an absolute http(s) URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${sourceKey} must be an http(s) origin without credentials, query, or fragment`);
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "" && !(allowLegacyPath && /^\/api\/v1(?:\/.*)?\/?$/.test(parsed.pathname))) {
    throw new Error(`${sourceKey} must be an origin URL without a path`);
  }
  return { origin: parsed.origin, sourceKey };
}

function getMqttConfigurationError(): string | null {
  if (!MQTT_BROKER) {
    return "thiếu GATEWAY_MQTT_BROKER_URL (hoạt động chế độ REST API hoặc local broker)";
  }

  let url: URL;
  try {
    url = new URL(MQTT_BROKER);
  } catch {
    return "GATEWAY_MQTT_BROKER_URL không phải URL hợp lệ";
  }

  if (url.protocol !== "mqtt:" && url.protocol !== "mqtts:") {
    return "broker phải dùng mqtt:// (local) hoặc mqtts:// (production)";
  }

  const localBroker = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (!localBroker && url.protocol !== "mqtts:") {
    return "broker từ xa phải dùng mqtts:// để xác thực TLS";
  }
  if (MQTT_AUTH_MODE !== "mtls" && MQTT_AUTH_MODE !== "password") {
    return "GATEWAY_MQTT_AUTH_MODE chỉ nhận mtls hoặc password";
  }
  if (!localBroker && MQTT_AUTH_MODE !== "mtls") {
    return "gateway từ xa bắt buộc GATEWAY_MQTT_AUTH_MODE=mtls";
  }
  if (MQTT_AUTH_MODE === "password" && (!MQTT_USERNAME || !MQTT_PASSWORD)) {
    return "thiếu GATEWAY_MQTT_USERNAME hoặc GATEWAY_MQTT_PASSWORD riêng của gateway";
  }
  if (MQTT_AUTH_MODE === "mtls") {
    const requiredFiles = [MQTT_CA_FILE, MQTT_CERT_FILE, MQTT_KEY_FILE];
    if (requiredFiles.some((filePath) => !filePath)) {
      return "thiếu GATEWAY_MQTT_CA_CERT_FILE, GATEWAY_MQTT_CLIENT_CERT_FILE hoặc GATEWAY_MQTT_CLIENT_KEY_FILE";
    }
    const missing = requiredFiles.find((filePath) => !fs.existsSync(filePath));
    if (missing) {
      return `không đọc được file certificate: ${missing}`;
    }
  }
  return null;
}

// ==========================================
// 4. XỬ LÝ LỆNH TƯỚI TỪ SERVER
// ==========================================
function findGatewayForZone(zoneId: string): GatewayDevice {
  const targetNode = nodes.find((n) => n.zone_id === zoneId);
  if (targetNode) {
    const foundGw = gateways.find((g) => g.id === targetNode.gateway_id);
    if (foundGw) return foundGw;
  }
  return gateways[0];
}

function handleIncomingIrrigationCommand(zoneId: string, payload: any) {
  const { commandId, action, duration_sec = 10, valve_id = "V01" } = payload;
  if (typeof commandId !== "string" || !commandId.trim()) {
    addLog("ERR", "Từ chối lệnh MQTT không có commandId.");
    return;
  }

  const targetGw = findGatewayForZone(zoneId);

  if (targetGw.simulate_offline) {
    addLog("WARN", `[${targetGw.id}] Đang offline - Bỏ qua lệnh cho Zone ${zoneId}`);
    return;
  }

  const completed = commandStore.getCompletedCommand(commandId);
  if (completed) {
    addLog("ACK", `Lệnh trùng ${commandId}; gửi lại ACK đã lưu.`);
    void sendAckResponse(
      targetGw,
      completed.commandId,
      completed.zoneId,
      completed.status,
      completed.measuredFlowLiters,
      completed.errorCode,
      targetGw.transport_mode,
    );
    return;
  }

  commandStore.markCommandExecuting(commandId, zoneId);
  addLog("CMD", `[${targetGw.id}] Nhận lệnh [${action.toUpperCase()}] cho Zone ${zoneId} (${duration_sec}s) - Cmd: ${commandId}`);

  if (action === "stop") {
    addLog("WARN", `[${targetGw.id}] DỪNG KHẨN CẤP: Tắt bơm và đóng toàn bộ van!`);
    const timer = activeIrrigationTimers.get(targetGw.id);
    if (timer) {
      clearTimeout(timer);
      activeIrrigationTimers.delete(targetGw.id);
    }
    targetGw.is_pump_running = false;
    targetGw.active_valves = [];
    void sendGatewayStatus(targetGw);
    completeIrrigationCommand(targetGw, commandId, zoneId, "COMPLETED", 0, 0, targetGw.transport_mode);
    return;
  }

  // 1. Khóa liên động an toàn (Hard Interlock bể nước của Gateway)
  if (!targetGw.water_tank_safe || targetGw.water_tank_level_pct < 15) {
    addLog("ERR", `[${targetGw.id}] TỪ CHỐI TƯỚI: Bể cạn (${targetGw.water_tank_level_pct}%). Ngắt bơm an toàn!`);
    completeIrrigationCommand(targetGw, commandId, zoneId, "FAILED", 0, 101, targetGw.transport_mode);
    return;
  }

  // 2. Kích hoạt chấp hành
  targetGw.is_pump_running = true;
  if (!targetGw.active_valves.includes(valve_id)) {
    targetGw.active_valves.push(valve_id);
  }
  void sendGatewayStatus(targetGw);

  addLog("INFO", `[${targetGw.id}] Đang chạy bơm & mở van ${valve_id} cho Zone ${zoneId} (${duration_sec}s)...`);

  const startTime = Date.now();
  const flowRateLitersPerSec = 0.09 + Math.random() * 0.03; // ~6L/min

  const existingTimer = activeIrrigationTimers.get(targetGw.id);
  if (existingTimer) clearTimeout(existingTimer);

  const timer = setTimeout(() => {
    const elapsedSec = (Date.now() - startTime) / 1000;
    const measuredFlow = targetGw.simulate_no_flow ? 0 : Number((elapsedSec * flowRateLitersPerSec).toFixed(2));

    // Sau khi tưới xong: Tăng độ ẩm các Node thuộc Zone đó
    const zoneNodes = nodes.filter((n) => n.zone_id === zoneId);
    for (const zNode of zoneNodes) {
      if (!targetGw.simulate_no_flow) {
        zNode.soil_moisture = Math.min(92.0, +(zNode.soil_moisture + 28.0 + Math.random() * 4).toFixed(1));
        addLog("INFO", `Độ ẩm đất ${zNode.name} (${zNode.node_id}) tăng lên ${zNode.soil_moisture}% sau khi tưới`);
      }
    }

    // Tắt bơm và đóng van
    targetGw.is_pump_running = false;
    targetGw.active_valves = targetGw.active_valves.filter((v) => v !== valve_id);
    void sendGatewayStatus(targetGw);

    const status = targetGw.simulate_no_flow ? "FAILED" : "COMPLETED";
    const errorCode = targetGw.simulate_no_flow ? 102 : 0;

    addLog("ACK", `[${targetGw.id}] Hoàn tất tưới Zone ${zoneId}: ${status} | Lưu lượng: ${measuredFlow}L`);
    completeIrrigationCommand(targetGw, commandId, zoneId, status, measuredFlow, errorCode, targetGw.transport_mode);
    activeIrrigationTimers.delete(targetGw.id);
  }, duration_sec * 1000);

  activeIrrigationTimers.set(targetGw.id, timer);
}

function recoverInterruptedCommands(): void {
  for (const command of commandStore.getInterruptedCommands()) {
    addLog("WARN", `Gateway vừa khởi động lại khi xử lý ${command.commandId}; phản hồi FAILED an toàn.`);
    const defaultGw = gateways[0];
    completeIrrigationCommand(defaultGw, command.commandId, command.zoneId, "FAILED", 0, 103, defaultGw.transport_mode);
  }
}

function completeIrrigationCommand(
  gw: GatewayDevice,
  commandId: string,
  zoneId: string,
  status: "COMPLETED" | "FAILED",
  measuredFlowLiters: number,
  errorCode: number,
  source: "mqtt" | "http",
): void {
  commandStore.completeCommand({
    commandId,
    zoneId,
    status,
    measuredFlowLiters,
    errorCode,
    completedAt: new Date().toISOString(),
  });
  void sendAckResponse(gw, commandId, zoneId, status, measuredFlowLiters, errorCode, source);
}

// ==========================================
// 5. GỬI DỮ LIỆU ĐA GIAO THỨC (MQTT / REST API)
// ==========================================
async function sendNodeTelemetry(node: SensorNode) {
  if (!node.online) return;
  const parentGw = gateways.find((g) => g.id === node.gateway_id) || gateways[0];
  if (parentGw.simulate_offline) return;

  const payload = {
    eventId: randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    farmId: node.farm_id || FARM_ID,
    zoneId: node.zone_id,
    nodeId: node.node_id,
    serial_number: node.serial_number,
    soil_moisture: node.soil_moisture,
    soil_temp: +(node.soil_temp + (Math.random() * 0.2 - 0.1)).toFixed(1),
    air_temp: +(node.air_temp + (Math.random() * 0.6 - 0.3)).toFixed(1),
    air_humidity: +(node.air_humidity + (Math.random() * 1.5 - 0.7)).toFixed(1),
    lux: Math.floor(node.lux + (Math.random() * 400 - 200)),
    quality: node.quality ?? 1,
  };

  if (parentGw.transport_mode === "mqtt" && mqttClient?.connected) {
    queueMqttPublish(`farm/${payload.farmId}/node/${node.node_id}/telemetry`, payload, "telemetry");
  } else {
    await postToServer("/ingest", payload, parentGw);
  }
}

async function sendGatewayStatus(gw: GatewayDevice) {
  const payload = createGatewayStatusPayload(gw, !gw.simulate_offline);

  if (gw.transport_mode === "mqtt" && mqttClient?.connected) {
    queueMqttPublish(`farm/${gw.farm_id}/node/${gw.id}/status`, payload, "status", true);
  } else {
    await postToServer("/gateway-status", payload, gw);
  }
}

async function sendAckResponse(
  gw: GatewayDevice,
  commandId: string,
  zoneId: string,
  status: "COMPLETED" | "FAILED",
  flowLiters: number,
  errorCode: number,
  source: "mqtt" | "http" = gw.transport_mode,
) {
  const payload = {
    eventId: randomUUID(),
    farmId: gw.farm_id,
    nodeId: gw.id,
    commandId,
    zoneId,
    status,
    measured_flow_liters: flowLiters,
    error_code: errorCode,
    timestamp: Math.floor(Date.now() / 1000),
  };

  if (source === "mqtt") {
    queueMqttPublish(`farm/${gw.farm_id}/node/${gw.id}/ack`, payload, "ack");
  } else {
    await postToServer("/gateway-ack", payload, gw);
  }
}

function createGatewayStatusPayload(gw: GatewayDevice, online: boolean, reason?: "last_will") {
  return {
    eventId: randomUUID(),
    timestamp: Math.floor(Date.now() / 1000),
    farmId: gw.farm_id,
    nodeId: gw.id,
    serial_number: gw.serial_number,
    online,
    ...(reason ? { reason } : {}),
    water_tank_level_pct: gw.water_tank_level_pct,
    water_tank_safe: gw.water_tank_safe,
    rssi: gw.rssi,
    firmware: gw.firmware,
    active_valves: gw.active_valves,
  };
}

function queueMqttPublish(topic: string, payload: unknown, kind: OutboundKind, retain = false): void {
  const result = commandStore.enqueue({
    id: typeof payload === "object" && payload !== null && "eventId" in payload && typeof payload.eventId === "string"
      ? payload.eventId
      : randomUUID(),
    kind,
    topic,
    payload: JSON.stringify(payload),
    qos: 1,
    retain,
    createdAt: new Date().toISOString(),
    attempts: 0,
  });

  if (!result.accepted) {
    addLog("WARN", `Outbox đầy; bỏ ${kind} mới nhất.`);
    return;
  }
  flushMqttOutbox();
}

function flushMqttOutbox(): void {
  if (publishingOutbox || !mqttClient?.connected) {
    return;
  }

  const nextMessage = commandStore.peek();
  if (!nextMessage) return;
  publishingOutbox = true;
  commandStore.markAttempt(nextMessage.id);
  try {
    mqttClient.publish(nextMessage.topic, nextMessage.payload, {
      qos: nextMessage.qos,
      retain: nextMessage.retain,
    }, (error) => {
      publishingOutbox = false;
      if (error) {
        addLog("WARN", `Lỗi gửi ${nextMessage.kind}: ${error.message}`);
        scheduleMqttReconnect();
        return;
      }
      commandStore.acknowledge(nextMessage.id);
      queueMicrotask(flushMqttOutbox);
    });
  } catch (error: any) {
    publishingOutbox = false;
    addLog("WARN", `Không gửi được ${nextMessage.kind}: ${error.message}`);
    scheduleMqttReconnect();
  }
}

async function postToServer(pathname: "/ingest" | "/gateway-status" | "/gateway-ack", payload: unknown, gw: GatewayDevice): Promise<void> {
  if (!DEVICE_INGEST_TOKEN) {
    gw.api_connected = false;
    addLog("WARN", "Không gửi REST API: thiếu DEVICE_INGEST_TOKEN.");
    return;
  }

  try {
    const response = await fetch(`${BACKEND_API_URL}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-FarmOS-Device-Token": DEVICE_INGEST_TOKEN,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      gw.api_connected = false;
      const detail = (await response.text()).slice(0, 180);
      addLog("ERR", `REST API ${pathname} trả HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      return;
    }

    if (gw.api_connected !== true) {
      addLog("INFO", `[${gw.id}] REST API kết nối thành công tới ${BACKEND_API_URL}`);
    }
    gw.api_connected = true;

    const anyPayload = payload as any;
    if (pathname === "/ingest") {
      addLog("ACK", `[REST API -> Server] ${anyPayload.nodeId}: Ẩm=${anyPayload.soil_moisture}% -> Server nhận OK (Đã lưu Supabase)`);
    } else if (pathname === "/gateway-status") {
      addLog("ACK", `[REST API -> Server] Gateway ${gw.id}: Bể=${gw.water_tank_level_pct}%, Bơm=${gw.is_pump_running ? "BẬT" : "TẮT"} -> Server nhận OK`);
    }
  } catch (error: any) {
    gw.api_connected = false;
    addLog("ERR", `Không kết nối được REST API ${BACKEND_API_URL}: ${error.message}`);
  }
}

async function sendSnapshot() {
  for (const node of nodes) {
    if (node.online) await sendNodeTelemetry(node);
  }
  for (const gw of gateways) {
    await sendGatewayStatus(gw);
  }
}

// ==========================================
// 6. VÒNG LẶP CHẠY ĐỊNH KỲ (TỰ ĐỘNG THU THẬP & BỐC HƠI)
// ==========================================
let telemetryIntervalTimer: NodeJS.Timeout;

function startTelemetryLoop() {
  if (telemetryIntervalTimer) clearInterval(telemetryIntervalTimer);

  telemetryIntervalTimer = setInterval(() => {
    // 1. Giả lập bốc hơi đất và gửi Telemetry cho từng Node
    for (const node of nodes) {
      const parentGw = gateways.find((g) => g.id === node.gateway_id) || gateways[0];
      if (node.auto_dry && !parentGw.active_valves.includes(node.valve_id)) {
        node.soil_moisture = Math.max(12.0, +(node.soil_moisture - 0.1).toFixed(1));
      }
      void sendNodeTelemetry(node);
    }

    // 2. Từng Gateway gửi trạng thái của mình lên Server
    for (const gw of gateways) {
      void sendGatewayStatus(gw);
    }

    const dryZones = nodes.filter((n) => n.soil_moisture < 45).map((n) => `${n.zone_id}(${n.soil_moisture}%)`);
    const dryStr = dryZones.length > 0 ? `⚠️ Cần tưới: ${dryZones.join(", ")}` : `✅ Đủ ẩm`;
    console.log(`[📡 GATEWAY CHU KỲ ${telemetryIntervalSec}s] Đã gửi ${nodes.length} Node & ${gateways.length} Gateway | ${dryStr}`);
    addLog("INFO", `Chu kỳ ${telemetryIntervalSec}s: Đã đẩy dữ liệu ${nodes.length} Node & ${gateways.length} Gateway lên Server`);
  }, telemetryIntervalSec * 1000);
}

startTelemetryLoop();
void sendSnapshot();

// ==========================================
// 7. WEB CONTROL PANEL UI TÍCH HỢP (PORT 4000)
// ==========================================
function getDashboardHtml(): string {
  const localPath = path.join(__dirname, "dashboard.html");
  if (fs.existsSync(localPath)) return fs.readFileSync(localPath, "utf8");
  const srcPath = path.join(__dirname, "../src/dashboard.html");
  if (fs.existsSync(srcPath)) return fs.readFileSync(srcPath, "utf8");
  return "<!DOCTYPE html><html><body><h1>FarmOS Simulator</h1><p>Dashboard HTML not found.</p></body></html>";
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API lấy state toàn bộ
  if (req.url === "/api/state" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      gateways,
      nodes,
      logs: recentLogs,
      config: {
        backendApiUrl: BACKEND_API_URL,
        backendBaseUrl: BACKEND_BASE_URL,
        mqttBrokerUrl: MQTT_BROKER,
        farmId: FARM_ID,
        telemetryIntervalSec,
        deviceIngestConfigured: Boolean(DEVICE_INGEST_TOKEN),
      },
      outboxDepth: commandStore.outboxDepth,
    }));
    return;
  }

  // API Cập nhật Gateway
  if (req.url === "/api/gateways/update" && req.method === "POST") {
    parseJsonBody(req, res, (data) => {
      const { id, patch } = data;
      const gw = gateways.find((g) => g.id === id);
      if (!gw) return sendJson(res, 404, { success: false, error: "Không tìm thấy Gateway" });

      if (patch.name !== undefined) gw.name = String(patch.name);
      if (patch.serial_number !== undefined) gw.serial_number = String(patch.serial_number);
      if (patch.water_tank_level_pct !== undefined) {
        gw.water_tank_level_pct = Number(patch.water_tank_level_pct);
        gw.water_tank_safe = gw.water_tank_level_pct >= 20;
      }
      if (patch.water_tank_safe !== undefined) gw.water_tank_safe = Boolean(patch.water_tank_safe);
      if (patch.transport_mode !== undefined) {
        gw.transport_mode = patch.transport_mode;
        addLog("INFO", `[${gw.id}] Đổi phương thức truyền dẫn: ${gw.transport_mode.toUpperCase()}`);
      }
      if (patch.simulate_no_flow !== undefined) gw.simulate_no_flow = Boolean(patch.simulate_no_flow);
      if (patch.simulate_offline !== undefined) {
        gw.simulate_offline = Boolean(patch.simulate_offline);
        gw.online = !gw.simulate_offline;
        if (!gw.simulate_offline && mqttClient?.connected) {
          gw.mqtt_connected = true;
          flushMqttOutbox();
        }
      }

      void sendGatewayStatus(gw);
      sendJson(res, 200, { success: true, data: gw });
    });
    return;
  }

  // API Thêm Gateway mới
  if (req.url === "/api/gateways/add" && req.method === "POST") {
    parseJsonBody(req, res, (data) => {
      const { id, serial_number, name, farm_id = FARM_ID, water_tank_level_pct = 85.0 } = data;
      if (!id || !serial_number) {
        return sendJson(res, 400, { success: false, error: "Thiếu ID hoặc Serial Number cho Gateway" });
      }
      if (gateways.some((g) => g.id === id)) {
        return sendJson(res, 400, { success: false, error: "Gateway ID đã tồn tại" });
      }

      const newGw: GatewayDevice = {
        id: id.trim(),
        serial_number: serial_number.trim(),
        name: name?.trim() || `Gateway ${id}`,
        farm_id: farm_id.trim(),
        online: true,
        water_tank_level_pct: Number(water_tank_level_pct),
        water_tank_safe: Number(water_tank_level_pct) >= 20,
        rssi: -60,
        firmware: "ESP32_GW_v2.0_DualMode",
        active_valves: [],
        is_pump_running: false,
        transport_mode: "mqtt",
        simulate_no_flow: false,
        simulate_offline: false,
        mqtt_connected: mqttClient?.connected || false,
        api_connected: null,
      };
      gateways.push(newGw);
      addLog("INFO", `Đã thêm Gateway mới: ${newGw.name} (${newGw.id} / ${newGw.serial_number})`);
      void sendGatewayStatus(newGw);
      sendJson(res, 200, { success: true, data: newGw });
    });
    return;
  }

  // API Xóa Gateway
  if (req.url === "/api/gateways/delete" && req.method === "POST") {
    parseJsonBody(req, res, (data) => {
      const { id } = data;
      const idx = gateways.findIndex((g) => g.id === id);
      if (idx === -1) return sendJson(res, 404, { success: false, error: "Không tìm thấy Gateway" });
      if (gateways.length <= 1) {
        return sendJson(res, 400, { success: false, error: "Phải giữ lại ít nhất 1 Gateway trong simulator" });
      }
      const [deleted] = gateways.splice(idx, 1);
      addLog("WARN", `Đã xóa Gateway ${deleted.id}`);
      sendJson(res, 200, { success: true });
    });
    return;
  }

  // API Cập nhật Node
  if (req.url === "/api/nodes/update" && req.method === "POST") {
    parseJsonBody(req, res, (data) => {
      const { node_id, patch } = data;
      const node = nodes.find((n) => n.node_id === node_id);
      if (!node) return sendJson(res, 404, { success: false, error: "Không tìm thấy Node" });

      if (patch.name !== undefined) node.name = String(patch.name);
      if (patch.serial_number !== undefined) node.serial_number = String(patch.serial_number);
      if (patch.crop_type !== undefined) node.crop_type = String(patch.crop_type);
      if (patch.zone_id !== undefined) node.zone_id = String(patch.zone_id);
      if (patch.gateway_id !== undefined) node.gateway_id = String(patch.gateway_id);
      if (patch.valve_id !== undefined) node.valve_id = String(patch.valve_id);
      if (patch.soil_moisture !== undefined) node.soil_moisture = Number(patch.soil_moisture);
      if (patch.soil_temp !== undefined) node.soil_temp = Number(patch.soil_temp);
      if (patch.air_temp !== undefined) node.air_temp = Number(patch.air_temp);
      if (patch.air_humidity !== undefined) node.air_humidity = Number(patch.air_humidity);
      if (patch.lux !== undefined) node.lux = Number(patch.lux);
      if (patch.online !== undefined) node.online = Boolean(patch.online);
      if (patch.auto_dry !== undefined) node.auto_dry = Boolean(patch.auto_dry);

      void sendNodeTelemetry(node);
      addLog("INFO", `Cập nhật ${node.name}: Ẩm=${node.soil_moisture}%, Nhiệt=${node.air_temp}°C`);
      sendJson(res, 200, { success: true, data: node });
    });
    return;
  }

  // API Thêm Node mới
  if (req.url === "/api/nodes/add" && req.method === "POST") {
    parseJsonBody(req, res, (data) => {
      const {
        node_id,
        serial_number,
        name,
        farm_id = FARM_ID,
        zone_id = "Z01",
        gateway_id = gateways[0]?.id || "GATEWAY_01",
        valve_id = "V01",
        crop_type = "Cây trồng mới",
        soil_moisture = 45.0,
        soil_temp = 26.0,
        air_temp = 28.0,
        air_humidity = 70.0,
        lux = 15000,
      } = data;

      if (!node_id || !serial_number) {
        return sendJson(res, 400, { success: false, error: "Thiếu Mã Node hoặc Số Serial" });
      }
      if (nodes.some((n) => n.node_id === node_id)) {
        return sendJson(res, 400, { success: false, error: "Mã Node đã tồn tại trong danh sách" });
      }

      const newNode: SensorNode = {
        node_id: node_id.trim(),
        serial_number: serial_number.trim(),
        name: name?.trim() || `Node ${node_id}`,
        farm_id: farm_id.trim(),
        zone_id: zone_id.trim(),
        gateway_id: gateway_id.trim(),
        valve_id: valve_id.trim(),
        crop_type: crop_type.trim(),
        soil_moisture: Number(soil_moisture),
        soil_temp: Number(soil_temp),
        air_temp: Number(air_temp),
        air_humidity: Number(air_humidity),
        lux: Number(lux),
        quality: 1,
        online: true,
        auto_dry: true,
      };
      nodes.push(newNode);
      addLog("INFO", `Đã thêm Node mới: ${newNode.name} (${newNode.node_id} / ${newNode.serial_number})`);
      void sendNodeTelemetry(newNode);
      sendJson(res, 200, { success: true, data: newNode });
    });
    return;
  }

  // API Xóa Node
  if (req.url === "/api/nodes/delete" && req.method === "POST") {
    parseJsonBody(req, res, (data) => {
      const { node_id } = data;
      const idx = nodes.findIndex((n) => n.node_id === node_id);
      if (idx === -1) return sendJson(res, 404, { success: false, error: "Không tìm thấy Node" });
      const [deleted] = nodes.splice(idx, 1);
      addLog("WARN", `Đã xóa Node ${deleted.node_id} (${deleted.name})`);
      sendJson(res, 200, { success: true });
    });
    return;
  }

  // API Sync danh sách thiết bị sang Backend (Admin Provisioning)
  if (req.url === "/api/sync-to-backend" && req.method === "POST") {
    parseJsonBody(req, res, async (data) => {
      const { adminToken } = data;
      const provisionUrl = `${BACKEND_BASE_URL}/api/v1/nodes/provision`;

      const devicesToSync = [
        ...gateways.map((g) => ({
          id: g.id,
          serialNumber: g.serial_number,
          name: g.name,
          type: "GATEWAY",
          farmId: g.farm_id,
        })),
        ...nodes.map((n) => ({
          id: n.node_id,
          serialNumber: n.serial_number,
          name: n.name,
          type: "SENSOR_NODE",
          farmId: n.farm_id,
          gatewayId: n.gateway_id,
        })),
      ];

      try {
        const response = await fetch(provisionUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
            "X-FarmOS-Device-Token": DEVICE_INGEST_TOKEN,
          },
          body: JSON.stringify({ devices: devicesToSync }),
        });

        const respData: any = await response.json();
        if (response.ok) {
          addLog("INFO", `Đã đăng ký ${devicesToSync.length} thiết bị vào hệ thống Backend thành công!`);
          sendJson(res, 200, { success: true, message: "Đã đồng bộ thiết bị vào Supabase thành công!", count: devicesToSync.length, data: respData });
        } else {
          addLog("ERR", `Lỗi đăng ký thiết bị vào Backend: ${respData.error || response.statusText}`);
          sendJson(res, response.status, { success: false, error: respData.error || "Không thể đăng ký thiết bị vào Backend" });
        }
      } catch (err: any) {
        addLog("ERR", `Không thể kết nối Backend tại ${provisionUrl}: ${err.message}`);
        sendJson(res, 500, { success: false, error: `Không thể kết nối Backend: ${err.message}` });
      }
    });
    return;
  }

  // API Gửi dữ liệu Telemetry tức thì lên Server API
  if (req.url === "/api/send-now" && req.method === "POST") {
    await sendSnapshot();
    addLog("INFO", `Đã gửi toàn bộ dữ liệu Gateway & Node lên Server API`);
    sendJson(res, 200, { success: true, message: "Đã gửi telemetry lên Server API thành công" });
    return;
  }

  // HTML Web Dashboard tương tác trực tiếp
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getDashboardHtml());
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

function parseJsonBody(req: http.IncomingMessage, res: http.ServerResponse, next: (data: any) => void) {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    try {
      const data = body ? JSON.parse(body) : {};
      next(data);
    } catch (e: any) {
      sendJson(res, 400, { success: false, error: "JSON không hợp lệ: " + e.message });
    }
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, data: any) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

server.listen(WEB_CONTROL_PORT, () => {
  console.clear();
  console.log("===================================================================");
  console.log("🌾 FarmOS — MULTI-GATEWAY & MULTI-NODE SMART SIMULATOR");
  console.log("===================================================================");
  console.log(`🚀 [WEB CONTROL PANEL] Mở trình duyệt cấu hình & mô phỏng: http://localhost:${WEB_CONTROL_PORT}`);
  console.log(`🔌 [MQTT BROKER]      ${MQTT_BROKER || "CHƯA BẬT (Đang chạy chế độ REST API Ingest)"}`);
  console.log(`🌐 [REST API INGEST]  ${BACKEND_API_URL}`);
  console.log(`📋 [GATEWAYS SẴN CÓ]  ${gateways.map((g) => `${g.id} (${g.serial_number})`).join(", ")}`);
  console.log(`🌱 [NODES SẴN CÓ]     ${nodes.map((n) => `${n.node_id} (${n.serial_number})`).join(", ")}`);
  console.log("===================================================================");
  printHelpMenu();
});

function printHelpMenu() {
  console.log("🎮 PHÍM TẮT CLI BÀN PHÍM:");
  console.log("  [1] Hạ ẩm Node 1 xuống 30%  |  [2] Hạ ẩm Node 2  |  [3] Hạ ẩm Node 3");
  console.log("  [4] Giả lập Bể cạn Gateway 1 (10%) | [5] Bật/tắt Kẹt van / No-flow");
  console.log("  [m] Đổi giao thức (MQTT 🔁 REST API)");
  console.log("  [h] Trợ giúp                |  [q] Thoát");
  console.log("-------------------------------------------------------------------\n");
}

readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}

process.stdin.on("keypress", (str, key) => {
  if (key.ctrl && key.name === "c") process.exit();

  switch (str) {
    case "1":
      if (nodes[0]) {
        nodes[0].soil_moisture = 30.0;
        void sendNodeTelemetry(nodes[0]);
        console.log(`👉 Đã hạ ẩm ${nodes[0].node_id} xuống 30.0% (Báo động cần tưới)`);
      }
      break;
    case "2":
      if (nodes[1]) {
        nodes[1].soil_moisture = 30.0;
        void sendNodeTelemetry(nodes[1]);
        console.log(`👉 Đã hạ ẩm ${nodes[1].node_id} xuống 30.0% (Báo động cần tưới)`);
      }
      break;
    case "3":
      if (nodes[2]) {
        nodes[2].soil_moisture = 30.0;
        void sendNodeTelemetry(nodes[2]);
        console.log(`👉 Đã hạ ẩm ${nodes[2].node_id} xuống 30.0% (Báo động cần tưới)`);
      }
      break;
    case "4":
      if (gateways[0]) {
        gateways[0].water_tank_safe = !gateways[0].water_tank_safe;
        gateways[0].water_tank_level_pct = gateways[0].water_tank_safe ? 88.0 : 10.0;
        void sendGatewayStatus(gateways[0]);
        console.log(`👉 Trạng thái bể nước ${gateways[0].id}: ${gateways[0].water_tank_safe ? "ĐỦ NƯỚC (88%)" : "🚨 BỂ CẠN (10% - Ngắt bơm)"}`);
      }
      break;
    case "5":
      if (gateways[0]) {
        gateways[0].simulate_no_flow = !gateways[0].simulate_no_flow;
        console.log(`👉 Giả lập kẹt van / No-flow: ${gateways[0].simulate_no_flow ? "🚨 BẬT (Flow=0L, ACK FAILED)" : "✅ TẮT"}`);
      }
      break;
    case "m":
    case "M":
      gateways.forEach((gw) => {
        gw.transport_mode = gw.transport_mode === "mqtt" ? "http" : "mqtt";
      });
      void sendSnapshot();
      console.log(`👉 Đổi tất cả Gateway sang: ${gateways[0]?.transport_mode.toUpperCase()}`);
      break;
    case "h":
    case "H":
      printHelpMenu();
      break;
    case "q":
    case "Q":
      console.log("👋 Đang dừng Multi-Gateway Simulator...");
      process.exit(0);
  }
});
