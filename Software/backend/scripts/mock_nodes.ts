import http from "http";
import mqtt from "mqtt";
import readline from "readline";

const MQTT_BROKER = process.env.MQTT_BROKER_URL || "mqtt://localhost:1883";
const BACKEND_API_URL = process.env.BACKEND_API_URL || "http://localhost:3000/api/v1/telemetry";
const FARM_ID = process.env.FARM_ID || "F01";
const WEB_CONTROL_PORT = Number(process.env.SIMULATOR_PORT) || 4000;

// Giao diện dữ liệu của từng Node cảm biến
export interface SensorNode {
  node_id: string;
  name: string;
  zone_id: string;
  valve_id: string;
  crop_type: string;
  soil_moisture: number;
  soil_temp: number;
  air_temp: number;
  air_humidity: number;
  lux: number;
  online: boolean;
}

// 1. Khởi tạo 3 Node cảm biến tương ứng với 3 phân vùng thực tế
const nodes: SensorNode[] = [
  {
    node_id: "NODE_Z01_01",
    name: "Cảm biến Zone 1",
    zone_id: "Z01",
    valve_id: "V01",
    crop_type: "Cà chua Cherry",
    soil_moisture: 42.0,
    soil_temp: 26.5,
    air_temp: 28.5,
    air_humidity: 74.0,
    lux: 16500,
    online: true,
  },
  {
    node_id: "NODE_Z02_01",
    name: "Cảm biến Zone 2",
    zone_id: "Z02",
    valve_id: "V02",
    crop_type: "Dưa lưới",
    soil_moisture: 58.5,
    soil_temp: 25.8,
    air_temp: 28.2,
    air_humidity: 76.0,
    lux: 17200,
    online: true,
  },
  {
    node_id: "NODE_Z03_01",
    name: "Cảm biến Zone 3",
    zone_id: "Z03",
    valve_id: "V03",
    crop_type: "Rau ăn lá",
    soil_moisture: 35.0,
    soil_temp: 27.2,
    air_temp: 29.0,
    air_humidity: 71.0,
    lux: 15800,
    online: true,
  },
];

// 2. Trạng thái phần cứng của Gateway
export interface GatewayState {
  online: boolean;
  water_tank_level_pct: number;
  water_tank_safe: boolean;
  rssi: number;
  firmware: string;
  active_valves: string[];
  is_pump_running: boolean;
  transport_mode: "mqtt" | "http"; // Chuyển đổi dễ dàng giữa MQTT và REST API
  simulate_no_flow: boolean;
  simulate_offline: boolean;
  auto_dry_enabled: boolean;
}

const gatewayState: GatewayState = {
  online: true,
  water_tank_level_pct: 88.0,
  water_tank_safe: true,
  rssi: -58,
  firmware: "ESP32_GW_v2.0_DualMode",
  active_valves: [],
  is_pump_running: false,
  transport_mode: "mqtt", // Mặc định qua MQTT, có thể đổi sang 'http' tức thì
  simulate_no_flow: false,
  simulate_offline: false,
  auto_dry_enabled: true,
};

// Nhật ký sự kiện phục vụ Web UI
const recentLogs: { time: string; type: string; message: string }[] = [];
function addLog(type: "CMD" | "ACK" | "INFO" | "WARN" | "ERR", message: string) {
  const time = new Date().toLocaleTimeString();
  recentLogs.unshift({ time, type, message });
  if (recentLogs.length > 50) recentLogs.pop();
}

let activeIrrigationTimer: NodeJS.Timeout | null = null;

// ==========================================
// 3. KẾT NỐI MQTT BROKER
// ==========================================
const mqttClient = mqtt.connect(MQTT_BROKER, {
  clientId: `FarmOS_GW_Sim_${Math.random().toString(16).substring(2, 8)}`,
  reconnectPeriod: 3000,
});

mqttClient.on("connect", () => {
  addLog("INFO", `Đã kết nối MQTT Broker: ${MQTT_BROKER}`);
  const commandTopic = `farm/${FARM_ID}/zone/+/command`;
  mqttClient.subscribe(commandTopic, (err) => {
    if (!err) {
      addLog("INFO", `Đang subscribe lệnh tại: ${commandTopic}`);
    }
  });
});

mqttClient.on("message", (topic, message) => {
  if (gatewayState.simulate_offline) {
    addLog("WARN", `Mất kết nối mạng - Bỏ qua lệnh từ ${topic}`);
    return;
  }

  try {
    const payload = JSON.parse(message.toString());
    const parts = topic.split("/");
    const zoneId = parts[3];
    handleIncomingIrrigationCommand(zoneId, payload);
  } catch (e: any) {
    addLog("ERR", `Lỗi parse JSON lệnh: ${e.message}`);
  }
});

// ==========================================
// 4. XỬ LÝ LỆNH TƯỚI TỪ SERVER
// ==========================================
function handleIncomingIrrigationCommand(zoneId: string, payload: any) {
  const { commandId, action, duration_sec = 10, valve_id = "V01" } = payload;
  addLog("CMD", `Nhận lệnh [${action.toUpperCase()}] cho Zone ${zoneId} (${duration_sec}s) - Cmd: ${commandId}`);

  if (action === "stop") {
    addLog("WARN", `DỪNG KHẨN CẤP: Tắt bơm và đóng mọi van!`);
    if (activeIrrigationTimer) {
      clearTimeout(activeIrrigationTimer);
      activeIrrigationTimer = null;
    }
    gatewayState.is_pump_running = false;
    gatewayState.active_valves = [];
    sendGatewayStatus();
    return;
  }

  // 1. Khóa liên động an toàn (Hard Interlock bể nước)
  if (!gatewayState.water_tank_safe || gatewayState.water_tank_level_pct < 15) {
    addLog("ERR", `TỪ CHỐI TƯỚI: Bể nước cạn (${gatewayState.water_tank_level_pct}%). Ngắt bơm an toàn.`);
    sendAckResponse(commandId, zoneId, "FAILED", 0, 101);
    return;
  }

  // 2. Kích hoạt chấp hành
  const targetNode = nodes.find((n) => n.zone_id === zoneId);
  gatewayState.is_pump_running = true;
  if (!gatewayState.active_valves.includes(valve_id)) {
    gatewayState.active_valves.push(valve_id);
  }
  sendGatewayStatus();

  addLog("INFO", `Đang chạy bơm và mở van ${valve_id} cho Zone ${zoneId} trong ${duration_sec}s...`);

  const startTime = Date.now();
  const flowRateLitersPerSec = 0.09 + Math.random() * 0.03; // ~6L/min

  if (activeIrrigationTimer) clearTimeout(activeIrrigationTimer);

  activeIrrigationTimer = setTimeout(() => {
    const elapsedSec = (Date.now() - startTime) / 1000;
    const measuredFlow = gatewayState.simulate_no_flow ? 0 : Number((elapsedSec * flowRateLitersPerSec).toFixed(2));

    // Sau khi tưới xong: Tăng độ ẩm đất
    if (targetNode && !gatewayState.simulate_no_flow) {
      targetNode.soil_moisture = Math.min(88.0, +(targetNode.soil_moisture + 28.0 + Math.random() * 4).toFixed(1));
      addLog("INFO", `Độ ẩm đất Zone ${zoneId} tăng lên: ${targetNode.soil_moisture}% sau khi tưới`);
    }

    // Tắt bơm và đóng van
    gatewayState.is_pump_running = false;
    gatewayState.active_valves = gatewayState.active_valves.filter((v) => v !== valve_id);
    sendGatewayStatus();

    const status = gatewayState.simulate_no_flow ? "FAILED" : "COMPLETED";
    const errorCode = gatewayState.simulate_no_flow ? 102 : 0;

    addLog("ACK", `Hoàn tất tưới Zone ${zoneId}: ${status} | Lưu lượng: ${measuredFlow}L`);
    sendAckResponse(commandId, zoneId, status, measuredFlow, errorCode);
    activeIrrigationTimer = null;
  }, duration_sec * 1000);
}

// ==========================================
// 5. GỬI DỮ LIỆU ĐA GIAO THỨC (MQTT / REST API)
// ==========================================
// Gửi Telemetry của 1 Node
async function sendNodeTelemetry(node: SensorNode) {
  if (gatewayState.simulate_offline || !node.online) return;

  const payload = {
    timestamp: Math.floor(Date.now() / 1000),
    farmId: FARM_ID,
    zoneId: node.zone_id,
    nodeId: node.node_id,
    soil_moisture: node.soil_moisture,
    soil_temp: +(node.soil_temp + (Math.random() * 0.2 - 0.1)).toFixed(1),
    air_temp: +(node.air_temp + (Math.random() * 0.6 - 0.3)).toFixed(1),
    air_humidity: +(node.air_humidity + (Math.random() * 1.5 - 0.7)).toFixed(1),
    lux: Math.floor(node.lux + (Math.random() * 400 - 200)),
    quality: 1,
  };

  if (gatewayState.transport_mode === "mqtt") {
    const topic = `farm/${FARM_ID}/node/${node.node_id}/telemetry`;
    mqttClient.publish(topic, JSON.stringify(payload));
  } else {
    // Gửi qua HTTP REST API
    try {
      await fetch(`${BACKEND_API_URL}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e: any) {
      // Backend có thể chưa bật hoặc lỗi mạng
    }
  }
}

// Gửi trạng thái Gateway
async function sendGatewayStatus() {
  const payload = {
    timestamp: Math.floor(Date.now() / 1000),
    farmId: FARM_ID,
    nodeId: "GATEWAY_01",
    online: !gatewayState.simulate_offline,
    water_tank_level_pct: gatewayState.water_tank_level_pct,
    water_tank_safe: gatewayState.water_tank_safe,
    rssi: gatewayState.rssi,
    firmware: gatewayState.firmware,
    active_valves: gatewayState.active_valves,
  };

  if (gatewayState.transport_mode === "mqtt") {
    mqttClient.publish(`farm/${FARM_ID}/node/GATEWAY_01/status`, JSON.stringify(payload));
  } else {
    try {
      await fetch(`${BACKEND_API_URL}/gateway-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {}
  }
}

// Gửi phản hồi ACK
async function sendAckResponse(commandId: string, zoneId: string, status: "COMPLETED" | "FAILED", flowLiters: number, errorCode: number) {
  const payload = {
    farmId: FARM_ID,
    nodeId: "GATEWAY_01",
    commandId,
    zoneId,
    status,
    measured_flow_liters: flowLiters,
    error_code: errorCode,
    timestamp: Math.floor(Date.now() / 1000),
  };

  if (gatewayState.transport_mode === "mqtt") {
    mqttClient.publish(`farm/${FARM_ID}/node/GATEWAY_01/ack`, JSON.stringify(payload), { qos: 1 });
  } else {
    try {
      await fetch(`${BACKEND_API_URL}/gateway-ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {}
  }
}

// ==========================================
// 6. VÒNG LẶP CHẠY ĐỊNH KỲ (TỰ ĐỘNG THU THẬP & BỐC HƠI)
// ==========================================
setInterval(() => {
  for (const node of nodes) {
    if (gatewayState.auto_dry_enabled && !gatewayState.active_valves.includes(node.valve_id)) {
      // Đất khô dần -0.1% mỗi chu kỳ
      node.soil_moisture = Math.max(12.0, +(node.soil_moisture - 0.1).toFixed(1));
    }
    sendNodeTelemetry(node);
  }
  sendGatewayStatus();
}, 4000);

// ==========================================
// 7. WEB CONTROL PANEL UI TÍCH HỢP (PORT 4000)
// ==========================================
const server = http.createServer((req, res) => {
  // Cho phép CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // API lấy state hiện tại
  if (req.url === "/api/state" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ nodes, gatewayState, logs: recentLogs }));
    return;
  }

  // API cập nhật thông số từ Web UI
  if (req.url === "/api/update" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const data = JSON.parse(body);

        // Cập nhật thông số Node
        if (data.nodeId) {
          const node = nodes.find((n) => n.node_id === data.nodeId);
          if (node) {
            if (data.soil_moisture !== undefined) node.soil_moisture = Number(data.soil_moisture);
            if (data.air_temp !== undefined) node.air_temp = Number(data.air_temp);
            if (data.air_humidity !== undefined) node.air_humidity = Number(data.air_humidity);
            if (data.lux !== undefined) node.lux = Number(data.lux);
            if (data.online !== undefined) node.online = Boolean(data.online);
            sendNodeTelemetry(node);
            addLog("INFO", `Đã cập nhật ${node.name}: Ẩm=${node.soil_moisture}%, Nhiệt=${node.air_temp}°C`);
          }
        }

        // Cập nhật thông số Gateway
        if (data.gateway) {
          if (data.gateway.water_tank_level_pct !== undefined) {
            gatewayState.water_tank_level_pct = Number(data.gateway.water_tank_level_pct);
            gatewayState.water_tank_safe = gatewayState.water_tank_level_pct >= 20;
          }
          if (data.gateway.water_tank_safe !== undefined) {
            gatewayState.water_tank_safe = Boolean(data.gateway.water_tank_safe);
          }
          if (data.gateway.transport_mode !== undefined) {
            gatewayState.transport_mode = data.gateway.transport_mode;
            addLog("INFO", `Đổi phương thức truyền dẫn sang: ${gatewayState.transport_mode.toUpperCase()}`);
          }
          if (data.gateway.simulate_no_flow !== undefined) {
            gatewayState.simulate_no_flow = Boolean(data.gateway.simulate_no_flow);
          }
          if (data.gateway.simulate_offline !== undefined) {
            gatewayState.simulate_offline = Boolean(data.gateway.simulate_offline);
          }
          if (data.gateway.auto_dry_enabled !== undefined) {
            gatewayState.auto_dry_enabled = Boolean(data.gateway.auto_dry_enabled);
          }
          sendGatewayStatus();
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      } catch (e: any) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // HTML Web Dashboard tương tác trực tiếp
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🌾 FarmOS — Bảng Điều Khiển Gateway & 3 Node Simulator</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; }
    input[type=range] { accent-color: #10b981; }
  </style>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-4 sm:p-8">
  <div class="max-w-6xl mx-auto space-y-6">
    <!-- Header -->
    <header class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-2xl">
      <div>
        <div class="flex items-center gap-3">
          <span class="text-3xl">🌾</span>
          <div>
            <h1 class="text-2xl font-black text-white">FarmOS Gateway Simulator</h1>
            <p class="text-xs text-slate-400">Bộ giả lập Gateway & 3 Node cảm biến đa giao thức (MQTT / REST API)</p>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-3">
        <!-- Chế độ truyền dẫn -->
        <div class="flex items-center bg-slate-950 border border-slate-800 rounded-2xl p-1.5 text-xs font-bold">
          <span class="px-2 text-slate-400">Giao thức:</span>
          <button id="btnMqtt" onclick="setTransport('mqtt')" class="px-3 py-1 rounded-xl transition-all bg-emerald-600 text-white shadow">MQTT</button>
          <button id="btnHttp" onclick="setTransport('http')" class="px-3 py-1 rounded-xl transition-all text-slate-400 hover:text-white">REST API</button>
        </div>
        <span id="gwLiveBadge" class="flex items-center gap-2 px-3 py-1.5 bg-emerald-950/80 border border-emerald-500/30 text-emerald-400 rounded-2xl text-xs font-bold">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span> Live Realtime
        </span>
      </div>
    </header>

    <!-- Gateway Controls & Hardware Banner -->
    <section class="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <!-- Mực nước bể & Khóa an toàn -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-4 shadow-xl">
        <div class="flex justify-between items-center">
          <div class="flex items-center gap-2 text-sm font-bold text-slate-300">
            <i class="fa-solid fa-water text-blue-400"></i> Bể Nước Cấp (Gateway)
          </div>
          <span id="tankBadge" class="text-xs font-black px-2.5 py-1 rounded-full bg-blue-950 text-blue-300 border border-blue-800">88%</span>
        </div>
        <div>
          <input type="range" id="sliderTank" min="0" max="100" value="88" class="w-full h-2 bg-slate-800 rounded-lg cursor-pointer" oninput="updateTank(this.value)">
          <div class="flex justify-between text-[10px] text-slate-500 mt-1">
            <span>0% (Cạn - Ngắt bơm)</span>
            <span>20% (Ngưỡng an toàn)</span>
            <span>100%</span>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 pt-2 text-xs font-bold">
          <button onclick="toggleTankEmpty()" class="p-2.5 bg-slate-800 hover:bg-slate-700 text-amber-300 rounded-2xl border border-slate-700 flex items-center justify-center gap-1.5 transition active:scale-95">
            <i class="fa-solid fa-triangle-exclamation"></i> Bể cạn (10%)
          </button>
          <button onclick="fillTank()" class="p-2.5 bg-slate-800 hover:bg-slate-700 text-blue-300 rounded-2xl border border-slate-700 flex items-center justify-center gap-1.5 transition active:scale-95">
            <i class="fa-solid fa-fill-drip"></i> Đầy bể (90%)
          </button>
        </div>
      </div>

      <!-- Trạng thái Bơm & Van Chấp Hành -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-4 shadow-xl">
        <div class="text-sm font-bold text-slate-300 flex items-center gap-2">
          <i class="fa-solid fa-faucet-drip text-emerald-400"></i> Cơ Cấu Chấp Hành
        </div>
        <div class="grid grid-cols-2 gap-3 text-center">
          <div class="p-3 bg-slate-950 border border-slate-800 rounded-2xl">
            <span class="text-[10px] text-slate-500 font-bold uppercase tracking-wider block">Bơm Chính 12V</span>
            <span id="pumpStatus" class="text-sm font-black text-slate-400 mt-1 inline-block">TẮT ⚪</span>
          </div>
          <div class="p-3 bg-slate-950 border border-slate-800 rounded-2xl">
            <span class="text-[10px] text-slate-500 font-bold uppercase tracking-wider block">Van Đang Mở</span>
            <span id="valvesStatus" class="text-sm font-black text-slate-400 mt-1 inline-block">Không có</span>
          </div>
        </div>
        <p class="text-[11px] text-slate-400 leading-relaxed">
          * Tự động bật khi nhận lệnh tưới từ Server/Web và đếm ngược trả ACK.
        </p>
      </div>

      <!-- Giả lập Sự Cố Kiểm Thử (Failure Injection) -->
      <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-3 shadow-xl">
        <div class="text-sm font-bold text-slate-300 flex items-center gap-2">
          <i class="fa-solid fa-flask text-purple-400"></i> Giả Lập Tình Huống Test
        </div>
        <div class="space-y-2 text-xs">
          <label class="flex items-center justify-between p-2.5 bg-slate-950 border border-slate-800 rounded-2xl cursor-pointer">
            <span>🚨 Kẹt van / Không có dòng chảy (No-flow)</span>
            <input type="checkbox" id="chkNoFlow" onchange="toggleNoFlow(this.checked)" class="w-4 h-4 rounded text-emerald-600 bg-slate-800">
          </label>
          <label class="flex items-center justify-between p-2.5 bg-slate-950 border border-slate-800 rounded-2xl cursor-pointer">
            <span>📡 Giả lập rớt mạng Gateway (Offline)</span>
            <input type="checkbox" id="chkOffline" onchange="toggleOffline(this.checked)" class="w-4 h-4 rounded text-emerald-600 bg-slate-800">
          </label>
        </div>
      </div>
    </section>

    <!-- 3 SENSOR NODES CONTROLS -->
    <section class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <!-- Node 1 -->
      <div id="cardNode0" class="bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-4 shadow-xl relative overflow-hidden">
        <div class="flex justify-between items-start">
          <div>
            <span class="text-[10px] font-extrabold px-2.5 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800">ZONE 1 (V01)</span>
            <h3 class="text-lg font-black text-white mt-1">Cà Chua Cherry</h3>
            <p class="text-xs text-slate-400 font-mono">NODE_Z01_01</p>
          </div>
          <span id="badgeN0" class="text-2xl font-black text-emerald-400">42%</span>
        </div>

        <div class="space-y-3">
          <div>
            <div class="flex justify-between text-xs text-slate-300 font-semibold mb-1">
              <span>Độ ẩm đất:</span>
              <span id="valMoistureN0">42%</span>
            </div>
            <input type="range" id="sliderMoistureN0" min="10" max="95" value="42" class="w-full" oninput="updateNode(0, 'soil_moisture', this.value)">
          </div>

          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="p-2 bg-slate-950 rounded-xl border border-slate-800">
              <span class="text-slate-500 block text-[10px]">Nhiệt độ KK</span>
              <input type="number" id="numTempN0" value="28.5" step="0.5" class="w-full bg-transparent font-bold text-white focus:outline-none" onchange="updateNode(0, 'air_temp', this.value)">
            </div>
            <div class="p-2 bg-slate-950 rounded-xl border border-slate-800">
              <span class="text-slate-500 block text-[10px]">Độ ẩm KK</span>
              <input type="number" id="numHumN0" value="74" step="1" class="w-full bg-transparent font-bold text-white focus:outline-none" onchange="updateNode(0, 'air_humidity', this.value)">
            </div>
          </div>

          <div class="flex gap-2">
            <button onclick="setQuickMoisture(0, 28)" class="flex-1 py-1.5 bg-amber-950/60 border border-amber-800/60 text-amber-300 rounded-xl text-xs font-bold hover:bg-amber-900/80 transition">
              ⚠️ Ép Khô (28%)
            </button>
            <button onclick="setQuickMoisture(0, 75)" class="flex-1 py-1.5 bg-blue-950/60 border border-blue-800/60 text-blue-300 rounded-xl text-xs font-bold hover:bg-blue-900/80 transition">
              💧 Đủ Ẩm (75%)
            </button>
          </div>
        </div>
      </div>

      <!-- Node 2 -->
      <div id="cardNode1" class="bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-4 shadow-xl relative overflow-hidden">
        <div class="flex justify-between items-start">
          <div>
            <span class="text-[10px] font-extrabold px-2.5 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800">ZONE 2 (V02)</span>
            <h3 class="text-lg font-black text-white mt-1">Dưa Lưới</h3>
            <p class="text-xs text-slate-400 font-mono">NODE_Z02_01</p>
          </div>
          <span id="badgeN1" class="text-2xl font-black text-emerald-400">58%</span>
        </div>

        <div class="space-y-3">
          <div>
            <div class="flex justify-between text-xs text-slate-300 font-semibold mb-1">
              <span>Độ ẩm đất:</span>
              <span id="valMoistureN1">58%</span>
            </div>
            <input type="range" id="sliderMoistureN1" min="10" max="95" value="58" class="w-full" oninput="updateNode(1, 'soil_moisture', this.value)">
          </div>

          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="p-2 bg-slate-950 rounded-xl border border-slate-800">
              <span class="text-slate-500 block text-[10px]">Nhiệt độ KK</span>
              <input type="number" id="numTempN1" value="28.2" step="0.5" class="w-full bg-transparent font-bold text-white focus:outline-none" onchange="updateNode(1, 'air_temp', this.value)">
            </div>
            <div class="p-2 bg-slate-950 rounded-xl border border-slate-800">
              <span class="text-slate-500 block text-[10px]">Độ ẩm KK</span>
              <input type="number" id="numHumN1" value="76" step="1" class="w-full bg-transparent font-bold text-white focus:outline-none" onchange="updateNode(1, 'air_humidity', this.value)">
            </div>
          </div>

          <div class="flex gap-2">
            <button onclick="setQuickMoisture(1, 28)" class="flex-1 py-1.5 bg-amber-950/60 border border-amber-800/60 text-amber-300 rounded-xl text-xs font-bold hover:bg-amber-900/80 transition">
              ⚠️ Ép Khô (28%)
            </button>
            <button onclick="setQuickMoisture(1, 75)" class="flex-1 py-1.5 bg-blue-950/60 border border-blue-800/60 text-blue-300 rounded-xl text-xs font-bold hover:bg-blue-900/80 transition">
              💧 Đủ Ẩm (75%)
            </button>
          </div>
        </div>
      </div>

      <!-- Node 3 -->
      <div id="cardNode2" class="bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-4 shadow-xl relative overflow-hidden">
        <div class="flex justify-between items-start">
          <div>
            <span class="text-[10px] font-extrabold px-2.5 py-0.5 rounded-full bg-amber-950 text-amber-400 border border-amber-800">ZONE 3 (V03)</span>
            <h3 class="text-lg font-black text-white mt-1">Rau Ăn Lá</h3>
            <p class="text-xs text-slate-400 font-mono">NODE_Z03_01</p>
          </div>
          <span id="badgeN2" class="text-2xl font-black text-amber-400">35%</span>
        </div>

        <div class="space-y-3">
          <div>
            <div class="flex justify-between text-xs text-slate-300 font-semibold mb-1">
              <span>Độ ẩm đất:</span>
              <span id="valMoistureN2">35%</span>
            </div>
            <input type="range" id="sliderMoistureN2" min="10" max="95" value="35" class="w-full" oninput="updateNode(2, 'soil_moisture', this.value)">
          </div>

          <div class="grid grid-cols-2 gap-2 text-xs">
            <div class="p-2 bg-slate-950 rounded-xl border border-slate-800">
              <span class="text-slate-500 block text-[10px]">Nhiệt độ KK</span>
              <input type="number" id="numTempN2" value="29.0" step="0.5" class="w-full bg-transparent font-bold text-white focus:outline-none" onchange="updateNode(2, 'air_temp', this.value)">
            </div>
            <div class="p-2 bg-slate-950 rounded-xl border border-slate-800">
              <span class="text-slate-500 block text-[10px]">Độ ẩm KK</span>
              <input type="number" id="numHumN2" value="71" step="1" class="w-full bg-transparent font-bold text-white focus:outline-none" onchange="updateNode(2, 'air_humidity', this.value)">
            </div>
          </div>

          <div class="flex gap-2">
            <button onclick="setQuickMoisture(2, 28)" class="flex-1 py-1.5 bg-amber-950/60 border border-amber-800/60 text-amber-300 rounded-xl text-xs font-bold hover:bg-amber-900/80 transition">
              ⚠️ Ép Khô (28%)
            </button>
            <button onclick="setQuickMoisture(2, 75)" class="flex-1 py-1.5 bg-blue-950/60 border border-blue-800/60 text-blue-300 rounded-xl text-xs font-bold hover:bg-blue-900/80 transition">
              💧 Đủ Ẩm (75%)
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- LIVE EVENT CONSOLE -->
    <section class="bg-slate-900 border border-slate-800 rounded-3xl p-6 space-y-3 shadow-xl">
      <div class="flex justify-between items-center">
        <h3 class="text-sm font-bold text-slate-300 flex items-center gap-2">
          <i class="fa-solid fa-terminal text-emerald-400"></i> Nhật Ký Lệnh & Phản Hồi Realtime
        </h3>
        <span class="text-[10px] text-slate-500">Tự động làm mới 1s</span>
      </div>
      <div id="logsConsole" class="bg-slate-950 border border-slate-800/80 rounded-2xl p-4 font-mono text-xs text-slate-300 h-44 overflow-y-auto space-y-1.5">
        <div class="text-slate-500">Đang lắng nghe sự kiện...</div>
      </div>
    </section>
  </div>

  <script>
    let localState = null;

    async function fetchState() {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();
        localState = data;
        renderUI(data);
      } catch(e) {}
    }

    function renderUI(data) {
      // 1. Gateway
      const gw = data.gatewayState;
      document.getElementById('tankBadge').innerText = gw.water_tank_level_pct + '%';
      document.getElementById('sliderTank').value = gw.water_tank_level_pct;
      document.getElementById('pumpStatus').innerHTML = gw.is_pump_running 
        ? '<span class="text-emerald-400 animate-pulse">ĐANG CHẠY 🟢</span>' 
        : 'TẮT ⚪';
      document.getElementById('valvesStatus').innerText = gw.active_valves.length > 0 
        ? gw.active_valves.join(', ') 
        : 'Không có';
      
      document.getElementById('chkNoFlow').checked = gw.simulate_no_flow;
      document.getElementById('chkOffline').checked = gw.simulate_offline;

      if (gw.transport_mode === 'mqtt') {
        document.getElementById('btnMqtt').className = "px-3 py-1 rounded-xl transition-all bg-emerald-600 text-white shadow";
        document.getElementById('btnHttp').className = "px-3 py-1 rounded-xl transition-all text-slate-400 hover:text-white";
      } else {
        document.getElementById('btnHttp').className = "px-3 py-1 rounded-xl transition-all bg-blue-600 text-white shadow";
        document.getElementById('btnMqtt').className = "px-3 py-1 rounded-xl transition-all text-slate-400 hover:text-white";
      }

      // 2. Nodes
      data.nodes.forEach((n, idx) => {
        document.getElementById('badgeN' + idx).innerText = n.soil_moisture + '%';
        document.getElementById('valMoistureN' + idx).innerText = n.soil_moisture + '%';
        document.getElementById('sliderMoistureN' + idx).value = n.soil_moisture;
        document.getElementById('numTempN' + idx).value = n.air_temp;
        document.getElementById('numHumN' + idx).value = n.air_humidity;

        if (n.soil_moisture < 40) {
          document.getElementById('badgeN' + idx).className = "text-2xl font-black text-amber-400";
        } else {
          document.getElementById('badgeN' + idx).className = "text-2xl font-black text-emerald-400";
        }
      });

      // 3. Logs
      const logBox = document.getElementById('logsConsole');
      if (data.logs && data.logs.length > 0) {
        logBox.innerHTML = data.logs.map(l => {
          let color = "text-slate-300";
          if (l.type === "CMD") color = "text-blue-400 font-bold";
          if (l.type === "ACK") color = "text-emerald-400 font-bold";
          if (l.type === "WARN") color = "text-amber-400";
          if (l.type === "ERR") color = "text-red-400 font-bold";
          return '<div class="' + color + '">[' + l.time + '] [' + l.type + '] ' + l.message + '</div>';
        }).join('');
      }
    }

    async function sendUpdate(payload) {
      await fetch('/api/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      fetchState();
    }

    function updateTank(val) {
      sendUpdate({ gateway: { water_tank_level_pct: Number(val) } });
    }
    function toggleTankEmpty() {
      sendUpdate({ gateway: { water_tank_level_pct: 10, water_tank_safe: false } });
    }
    function fillTank() {
      sendUpdate({ gateway: { water_tank_level_pct: 90, water_tank_safe: true } });
    }
    function setTransport(mode) {
      sendUpdate({ gateway: { transport_mode: mode } });
    }
    function toggleNoFlow(val) {
      sendUpdate({ gateway: { simulate_no_flow: val } });
    }
    function toggleOffline(val) {
      sendUpdate({ gateway: { simulate_offline: val } });
    }
    function updateNode(idx, field, val) {
      const nodeId = localState ? localState.nodes[idx].node_id : 'NODE_Z0' + (idx+1) + '_01';
      const payload = { nodeId };
      payload[field] = Number(val);
      sendUpdate(payload);
    }
    function setQuickMoisture(idx, val) {
      updateNode(idx, 'soil_moisture', val);
    }

    setInterval(fetchState, 1200);
    fetchState();
  </script>
</body>
</html>
    `);
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(WEB_CONTROL_PORT, () => {
  console.clear();
  console.log("===================================================================");
  console.log("🌾 FarmOS — GATEWAY & 3-NODE MULTI-PROTOCOL SIMULATOR");
  console.log("===================================================================");
  console.log(`🚀 [WEB CONTROL PANEL] Mở trình duyệt điều chỉnh thông số: http://localhost:${WEB_CONTROL_PORT}`);
  console.log(`🔌 [MQTT BROKER]      ${MQTT_BROKER} (Topic: farm/${FARM_ID}/#)`);
  console.log(`🌐 [REST API INGEST]  ${BACKEND_API_URL}`);
  console.log(`📡 [GIAO THỨC HIỆN TẠI] ${gatewayState.transport_mode.toUpperCase()} (Đổi sang REST API bất cứ lúc nào)`);
  console.log("===================================================================");
  printHelpMenu();
});

// Phím tắt CLI
function printHelpMenu() {
  console.log("🎮 PHÍM TẮT CLI BÀN PHÍM:");
  console.log("  [1] Hạ ẩm Zone 1 xuống 30%  |  [2] Hạ ẩm Zone 2  |  [3] Hạ ẩm Zone 3");
  console.log("  [4] Giả lập Bể cạn (10%)    |  [5] Giả lập Kẹt van (No-flow)");
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
      nodes[0].soil_moisture = 30.0;
      sendNodeTelemetry(nodes[0]);
      addLog("INFO", `[CLI] Hạ ẩm Zone 1 xuống 30%`);
      console.log(`👉 Đã hạ ẩm Zone 1 xuống 30.0% (Báo động cần tưới)`);
      break;
    case "2":
      nodes[1].soil_moisture = 30.0;
      sendNodeTelemetry(nodes[1]);
      addLog("INFO", `[CLI] Hạ ẩm Zone 2 xuống 30%`);
      console.log(`👉 Đã hạ ẩm Zone 2 xuống 30.0% (Báo động cần tưới)`);
      break;
    case "3":
      nodes[2].soil_moisture = 30.0;
      sendNodeTelemetry(nodes[2]);
      addLog("INFO", `[CLI] Hạ ẩm Zone 3 xuống 30%`);
      console.log(`👉 Đã hạ ẩm Zone 3 xuống 30.0% (Báo động cần tưới)`);
      break;
    case "4":
      gatewayState.water_tank_safe = !gatewayState.water_tank_safe;
      gatewayState.water_tank_level_pct = gatewayState.water_tank_safe ? 88.0 : 10.0;
      sendGatewayStatus();
      console.log(`👉 Trạng thái bể nước: ${gatewayState.water_tank_safe ? "ĐỦ NƯỚC (88%)" : "🚨 BỂ CẠN (10% - Ngắt bơm)"}`);
      break;
    case "5":
      gatewayState.simulate_no_flow = !gatewayState.simulate_no_flow;
      console.log(`👉 Giả lập kẹt van / No-flow: ${gatewayState.simulate_no_flow ? "🚨 BẬT (Flow=0L, ACK FAILED)" : "✅ TẮT"}`);
      break;
    case "m":
    case "M":
      gatewayState.transport_mode = gatewayState.transport_mode === "mqtt" ? "http" : "mqtt";
      console.log(`👉 Đổi chế độ truyền dữ liệu sang: ${gatewayState.transport_mode.toUpperCase()}`);
      break;
    case "h":
    case "H":
      printHelpMenu();
      break;
    case "q":
    case "Q":
      console.log("👋 Đang dừng Gateway Simulator...");
      process.exit(0);
  }
});
