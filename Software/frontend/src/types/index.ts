export interface UserProfile {
  id: string;
  email: string;
  name?: string | null;
  avatar_url?: string | null;
  role: "ADMIN" | "USER";
  created_at?: string;
  farms?: FarmItem[];
  farmsCount?: number;
  nodesCount?: number;
  gatewaysCount?: number;
  sensorNodesCount?: number;
  totalOnline?: number;
  onlinePct?: number;
  gateways?: Array<NodeDevice & { childNodes: NodeDevice[]; totalChildCount: number; onlineChildCount: number }>;
  standaloneNodes?: NodeDevice[];
  nodes?: NodeDevice[];
}

export interface NodeDevice {
  can_unbind?: boolean;
  is_simulation?: boolean;
  simulation?: {
    sample_id: string; event_id: string; run_id: string; source_node_id: string;
    received_at: string; simulated_at: string;
    context: { cropId?: string; ph?: number; eceDsM?: number; moistureUnit?: string };
  } | null;
  id: string;
  serial_number?: string | null;
  name?: string | null;
  farm_id: string;
  zone_id?: string | null;
  owner_id?: string | null;
  owner?: { id: string; name?: string | null; email: string } | null;
  type: string;
  deployment_mode?: "GATEWAY" | "LEAF_NODE" | "STANDALONE_NODE" | null;
  capabilities?: string[];
  gateway_id?: string | null;
  gateway?: { id: string; name?: string | null; serial_number?: string | null; online?: boolean } | null;
  is_activated?: boolean;
  online: boolean;
  rssi?: number | null;
  firmware_version?: string | null;
  last_seen?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  farm?: { id: string; name: string; location?: string | null; latitude?: number | null; longitude?: number | null } | null;
  zone?: { id: string; name: string; crop_type?: string | null; target_moisture_min?: number; target_moisture_max?: number; valve_id?: string | null } | null;
  latest_telemetry?: {
    soil_moisture: number | null;
    soil_temp?: number | null;
    air_temp?: number | null;
    air_humidity?: number | null;
    lux?: number | null;
    timestamp: string;
  } | null;
}

export interface TelemetryPoint {
  id: string;
  timestamp: string;
  farm_id: string;
  zone_id: string;
  node_id: string;
  soil_moisture: number;
  soil_temp?: number | null;
  air_temp?: number | null;
  air_humidity?: number | null;
  lux?: number | null;
  quality?: number;
  created_at?: string;
}

export interface Zone {
  id: string;
  farm_id?: string;
  name: string;
  crop_type?: string | null;
  target_moisture_min: number;
  target_moisture_max: number;
  valve_id?: string | null;
  nodes?: NodeDevice[];
  latest_telemetry?: TelemetryPoint | null;
}

export interface FarmItem {
  id: string;
  name: string;
  location?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  zonesCount?: number;
  nodesCount?: number;
  owners?: Array<{ id: string; name?: string | null; email: string }>;
  zones?: Zone[];
  nodes?: NodeDevice[];
}

export interface WaterTankState {
  level_pct: number;
  safe: boolean;
  last_updated?: string;
}

export interface IrrigationLog {
  id: string;
  command_id: string;
  zone_id: string;
  valve_id?: string | null;
  duration_sec: number;
  trigger_source: string;
  status: "PENDING" | "EXECUTING" | "COMPLETED" | "FAILED" | "TIMEOUT" | "REJECTED";
  rejection_reason?: string | null;
  measured_flow_liters?: number | null;
  safety_checks_passed: boolean;
  error_code: number;
  created_at: string;
  completed_at?: string | null;
  zone?: {
    name: string;
    crop_type?: string | null;
  };
}

export interface WaterSummary {
  zoneId: string;
  totalLiters: number;
  totalDurationSec: number;
  totalIrrigationSessions: number;
}

export interface AlertItem {
  id: string;
  farm_id: string;
  zone_id?: string | null;
  level: "INFO" | "WARNING" | "CRITICAL";
  type: string;
  message: string;
  resolved: boolean;
  created_at: string;
  resolved_at?: string | null;
  zone?: {
    name: string;
  };
}

export type ManufacturingIdentityState =
  | "INVENTORY"
  | "LEGACY"
  | "ALLOCATED"
  | "FACTORY_WRITTEN"
  | "VERIFIED"
  | "QC_PASSED"
  | "READY_TO_SHIP"
  | "CLAIMED"
  | "REVOKED"
  | "QUARANTINED";

export type ManufacturingBatchStatus = "DRAFT" | "OPEN" | "IN_PROGRESS" | "COMPLETE" | "QC_PASSED" | "READY_TO_SHIP" | "QUARANTINED" | "CANCELLED";
export type ManufacturingQrState = "ISSUED" | "PRINTED" | "REPRINTED" | "REVOKED" | "QUARANTINED";

export interface ManufacturingIdentity {
  deviceId: string;
  serial: string;
  type: "GATEWAY" | "SENSOR_NODE";
  model?: string | null;
  hardwareRevision?: string | null;
  firmwareTarget?: string | null;
  partitionScheme?: string | null;
  bootloaderVersion?: string | null;
  capabilities?: string[];
  state: ManufacturingIdentityState;
  batchId?: string | null;
  publicKeyAlgorithm?: string | null;
  publicKeyFingerprint?: string | null;
  factoryCfgHash?: string | null;
  factoryFirmwareSha256?: string | null;
  factoryStationId?: string | null;
  factoryWrittenAt?: string | null;
  factoryVerifiedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface ManufacturingBatch {
  id: string;
  batchNumber: string;
  model: string;
  type: "GATEWAY" | "SENSOR_NODE";
  hardwareRevision: string;
  firmwareTarget?: string | null;
  quantity: number;
  status: ManufacturingBatchStatus;
  metadata?: unknown;
  createdAt: string;
  updatedAt: string;
  identities?: ManufacturingIdentity[];
}

export interface ManufacturingQrLabel {
  qrId: string;
  version: 3;
  state: ManufacturingQrState;
  deviceId: string;
  batchId?: string | null;
  issuer: string;
  kid: string;
  payload: {
    v: 3;
    issuer: "farmos";
    qrId: string;
    deviceId: string;
    serial: string;
    type: "GATEWAY" | "SENSOR_NODE";
    model: string;
    hardwareRevision: string;
    kid: string;
    sig: string;
  } | null;
  printedAt?: string | null;
  printedById?: string | null;
  reprintCount: number;
  revokedAt?: string | null;
  revokeReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ManufacturingLifecycleEvent {
  id: string;
  device_id?: string | null;
  batch_id?: string | null;
  qr_label_id?: string | null;
  event_type: string;
  from_state?: string | null;
  to_state?: string | null;
  actor_type?: string | null;
  actor_id?: string | null;
  station_id?: string | null;
  metadata?: unknown;
  created_at: string;
}
