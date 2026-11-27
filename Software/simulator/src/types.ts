export interface SensorNode {
  node_id: string;
  serial_number: string;
  name: string;
  farm_id: string;
  zone_id: string;
  gateway_id: string;
  valve_id: string;
  crop_type: string;
  soil_moisture: number;
  soil_temp: number;
  air_temp: number;
  air_humidity: number;
  lux: number;
  quality: number;
  online: boolean;
  auto_dry: boolean;
}

export interface GatewayDevice {
  id: string;
  serial_number: string;
  name: string;
  farm_id: string;
  online: boolean;
  water_tank_level_pct: number;
  water_tank_safe: boolean;
  rssi: number;
  firmware: string;
  active_valves: string[];
  is_pump_running: boolean;
  transport_mode: "mqtt" | "http";
  simulate_no_flow: boolean;
  simulate_offline: boolean;
  mqtt_connected: boolean;
  api_connected: boolean | null;
}

// Backward compatibility alias
export type GatewayState = GatewayDevice;

export interface SimulatorLog {
  time: string;
  type: "CMD" | "ACK" | "INFO" | "WARN" | "ERR";
  message: string;
}

export interface SimulatorStateResponse {
  gateways: GatewayDevice[];
  nodes: SensorNode[];
  logs: SimulatorLog[];
  backendApiUrl: string;
  mqttBrokerUrl: string;
  farmId: string;
  outboxDepth: number;
}
