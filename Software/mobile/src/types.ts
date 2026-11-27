export type Role = "ADMIN" | "USER";
export type DeploymentMode = "GATEWAY" | "LEAF_NODE" | "STANDALONE_NODE";
// GatewayProvisioningSession.status in the backend schema has no FAILED
// state. Device-side redeem failures are surfaced by the session remaining
// PENDING until it expires (or by the redeem request itself), so keep this
// union aligned with GET /onboarding/devices/cloud-sessions/:id.
export type CloudProvisioningStatus = "PENDING" | "REDEEMED" | "EXPIRED" | "CANCELLED";
export type PairingSessionStatus = "PENDING" | "GATEWAY_READY" | "ACTIVE" | "FAILED" | "EXPIRED" | "CANCELLED";

export interface Farm {
  id: string;
  name: string;
  location?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  user_farms?: Array<{
    user?: Pick<UserProfile, "id" | "name" | "email" | "role">;
  }>;
}

export interface MapNode {
  id: string;
  name?: string | null;
  serial_number?: string | null;
  type: string;
  online: boolean;
  latitude?: number | null;
  longitude?: number | null;
  zone?: Pick<Zone, "id" | "name" | "crop_type"> | null;
  owner?: Pick<UserProfile, "id" | "name" | "email"> | null;
}

export interface MapFarm extends Farm {
  nodes?: MapNode[];
  owners?: Array<Pick<UserProfile, "id" | "name" | "email">>;
  zonesCount?: number;
  nodesCount?: number;
}

export interface Zone {
  id: string;
  farm_id: string;
  name: string;
  crop_type?: string | null;
  target_moisture_min?: number | null;
  target_moisture_max?: number | null;
  status?: string;
  telemetries?: TelemetryPoint[];
}

export interface TelemetryPoint {
  id?: string;
  quality?: number;
  timestamp: string;
  soil_moisture?: number | null;
  soil_temp?: number | null;
  air_temp?: number | null;
  air_humidity?: number | null;
  lux?: number | null;
}

export interface UserProfile {
  id: string;
  email: string;
  name?: string | null;
  avatar_url?: string | null;
  role: Role;
  farms: Farm[];
}

export interface FarmOverview {
  farm: Farm & { zones?: Zone[] };
  zones: Zone[];
  tankState?: { safe?: boolean; level_pct?: number; last_updated?: string };
  activeAlertsCount?: number;
}

export interface AlertItem {
  id: string;
  farm_id?: string;
  resolved?: boolean;
  level: string;
  type: string;
  message: string;
  created_at: string;
  zone_id?: string | null;
  zone?: { name: string } | null;
  farm?: { id: string; name: string } | null;
}

export interface PumpCommand {
  id: string;
  on: boolean;
  status: "PENDING" | "DELIVERED" | "CONFIRMED" | "FAILED" | "TIMEOUT" | "CANCELLED";
  error: string | null;
  feedbackOn: boolean | null;
  confirmedAt: string | null;
}

export interface PumpControlStatus {
  reason: string | null;
  runSeconds: number;
  command: PumpCommand | null;
}

export interface FarmDevice {
  is_simulation?: boolean;
  can_unbind?: boolean;
  can_reconfigure_wifi?: boolean;
  release_pending?: boolean;
  id: string;
  serial_number?: string | null;
  name: string;
  type: "GATEWAY" | "SENSOR_NODE";
  deployment_mode?: DeploymentMode;
  capabilities?: string[];
  farm?: Farm | null;
  zone?: Zone | null;
  gateway_id?: string | null;
  is_activated: boolean;
  online: boolean;
  last_seen?: string | null;
  firmware_version?: string | null;
  rssi?: number | null;
  gateway?: { id: string; name: string; serial_number?: string | null; online: boolean } | null;
  latest_telemetry?: TelemetryPoint | null;
}

/**
 * A redacted, admin-only inventory record. This is deliberately different
 * from FarmDevice: a factory identity can exist before it has a runtime Node
 * row or is assigned to a farm.
 */
export interface AdminDeviceInventory {
  id: string;
  deviceId: string;
  serial: string | null;
  type: "GATEWAY" | "SENSOR_NODE";
  model: string | null;
  identityState: string | null;
  claimedById: string | null;
  claimedFarmId: string | null;
  node: {
    id: string;
    name: string | null;
    serial: string | null;
    farmId: string | null;
    farmName: string | null;
    zoneId: string | null;
    type: "GATEWAY" | "SENSOR_NODE";
    isActivated: boolean;
    online: boolean;
    firmwareVersion: string | null;
    lastSeen: string | null;
  } | null;
}

export interface IrrigationLog {
  id: string;
  command_id: string;
  zone_id: string;
  valve_id?: string | null;
  duration_sec: number;
  trigger_source?: string;
  status: string;
  rejection_reason?: string | null;
  measured_flow_liters?: number | null;
  safety_checks_passed?: boolean;
  error_code?: number;
  created_at: string;
  completed_at?: string | null;
  zone?: { name?: string; crop_type?: string | null } | null;
}

export interface GatewayClaimSession {
  sessionId: string;
  gatewayId: string;
  provisioningToken: string;
  bleName: string;
  expiresAt: string;
}

export interface PairingSessionResult {
  pairingId: string;
  nodeId: string;
  gatewayId: string;
  radioToken: string;
  expiresAt: string;
  status: PairingSessionStatus;
  failure_reason?: string | null;
}

export interface ResolvedDeviceQr {
  deviceId: string;
  serialNumber: string;
  model?: string | null;
  bleName?: string | null;
  hardwareType: "GATEWAY" | "SENSOR_NODE";
  capabilities: string[];
  allowedModes: DeploymentMode[];
  state: "INVENTORY" | "LEGACY" | "CLAIMED" | "REVOKED" | "ALLOCATED" | "FACTORY_WRITTEN" | "VERIFIED" | "QC_PASSED" | "READY_TO_SHIP" | "QUARANTINED";
}

export interface QrV3Payload {
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
}

export interface ResolvedDeviceQrV3 {
  payload: QrV3Payload;
  identity: {
    deviceId: string;
    serial: string;
    type: "GATEWAY" | "SENSOR_NODE";
    model: string;
    hardwareRevision: string;
    firmwareTarget?: string | null;
    partitionScheme?: string | null;
    capabilities: string[];
    publicKeyAlgorithm?: string | null;
    publicKeyFingerprint?: string | null;
    identityVersion?: number;
    state: "ALLOCATED" | "FACTORY_WRITTEN" | "VERIFIED" | "QC_PASSED" | "READY_TO_SHIP" | "CLAIMED" | "REVOKED" | "QUARANTINED";
  };
  claimable: boolean;
}

export interface QrClaimSession {
  sessionId: string;
  deviceId: string;
  challenge: string;
  provisioningToken?: string;
  nonce?: string;
  identityVersion?: number;
  expiresAt: string;
  status: "CHALLENGE_ISSUED" | "ATTESTED" | "FINALIZED" | "EXPIRED" | "CANCELLED";
}

export interface DeviceModeSession extends QrClaimSession {
  identity: {
    deviceId: string;
    serial: string;
    type: "GATEWAY" | "SENSOR_NODE";
    model: string;
    hardwareRevision: string;
  };
}

// GET /onboarding/qr/claim-sessions/:id intentionally omits challenge,
// provisioningToken and attestation material after creation.
export interface QrClaimSessionStatus {
  sessionId: string;
  deviceId: string;
  status: QrClaimSession["status"];
  farmId: string;
  zoneId?: string | null;
  deploymentMode: DeploymentMode;
  expiresAt: string;
  finalizedNodeId?: string | null;
}

export interface CloudProvisioningSession {
  sessionId: string;
  deviceId: string;
  provisioningToken: string;
  bleName?: string | null;
  expiresAt: string;
  deploymentMode: "GATEWAY" | "STANDALONE_NODE";
}
