import { invoke } from "@tauri-apps/api/core";

export type NativeToolchain = {
  platformioHome: string | null;
  pioPath: string | null;
  pythonPath: string | null;
  esptoolPath: string | null;
  ready: boolean;
  message: string;
};

export type NativePort = {
  path: string;
  label: string;
  kind: string;
  vid: string | null;
  pid: string | null;
};

export type BoardProbe = {
  ok: boolean;
  output: string;
  chip: string | null;
  mac: string | null;
};

export type BoardPreflight = {
  board: { id: string; state: string; currentIdentity?: { deviceId: string; type: string; state: string } | null } | null;
  currentDeviceId: string | null;
  currentDeviceType: string | null;
  targetDeviceType: "SENSOR_NODE" | "GATEWAY";
  typeMismatch: boolean;
  reason: "DEVICE_ALREADY_EXISTS" | "TYPE_MISMATCH" | "BOARD_UNAVAILABLE" | "IDENTITY_UNAVAILABLE" | "NO_RELEASE" | null;
  release: { id: string; version: string; firmwareTarget: string } | null;
  ready: boolean;
  releaseError?: string | null;
};

export type FlashIdentityStatus = {
  found: boolean;
  identityState: string | null;
  online: boolean;
  lastSeen: string | null;
};

export type DesktopImage = {
  id: string;
  name: string;
  fileName?: string | null;
  address?: number | null;
  sizeBytes: number;
  sha256: string;
  role: string;
};

export type DesktopRelease = {
  id: string;
  version: string;
  deviceType: string;
  otaStatus: string;
  flashStatus: string;
  factoryReady: boolean;
  updatedAt: string;
  createdAt?: string | null;
  changelog?: string | null;
  firmwareTarget?: string | null;
  artifactFileName?: string | null;
  artifactSha256?: string | null;
  images?: DesktopImage[];
};

export type NativeFileInfo = {
  path: string;
  name: string;
  sizeBytes: number;
};

export type NativeFlashResult = {
  jobId: string;
  status: string;
  logs: string[];
  deviceId: string | null;
  qrId: string | null;
  qrPayload: Record<string, unknown> | null;
  newIdentity: boolean;
};

export const nativeToolchainStatus = () => invoke<NativeToolchain>("native_toolchain_status");
export const listNativePorts = () => invoke<NativePort[]>("list_native_ports");
export const probeEsp32 = (port: string) => invoke<BoardProbe>("probe_esp32", { port });
export const inspectBoardForFlash = (input: { chipFamily: string; macAddress: string; targetType: "NODE" | "GATEWAY"; releaseId: string }) =>
  invoke<BoardPreflight>("inspect_board_for_flash", input);
export const verifyFlashIdentity = (deviceId: string) => invoke<FlashIdentityStatus>("verify_flash_identity", { deviceId });
export const repurposeBoardForFlash = (input: { boardId: string; expectedDeviceId: string; targetType: "NODE" | "GATEWAY"; reason: string }) =>
  invoke<{ oldDeviceId: string; targetDeviceType: string; releaseId: string }>("repurpose_board_for_flash", input);
export const listDesktopReleases = () => invoke<DesktopRelease[]>("list_desktop_releases");

export const uploadDesktopRelease = (upload: {
  app: string;
  bootloader?: string;
  partitionTable?: string;
  otaData?: string;
  deviceType?: "SENSOR_NODE" | "GATEWAY" | "";
  changelog?: string;
}) =>
  invoke<DesktopRelease>("upload_desktop_release", {
    upload: {
      ...upload,
      deviceType: upload.deviceType ? upload.deviceType : undefined,
    },
  });

export const inspectLocalFile = (path: string) =>
  invoke<NativeFileInfo>("inspect_local_file", { path });

export const updateDesktopReleaseStatus = (
  releaseId: string,
  channel: "OTA" | "FACTORY",
  status: "ACTIVE" | "PAUSED"
) =>
  invoke<DesktopRelease>("update_desktop_release_status", {
    releaseId,
    channel,
    status,
  });

export const deleteDesktopRelease = (releaseId: string) =>
  invoke<void>("delete_desktop_release", { releaseId });

export const downloadDesktopArtifact = (
  releaseId: string,
  imageId: string | undefined,
  savePath: string
) =>
  invoke<void>("download_desktop_artifact", { releaseId, imageId, savePath });

export const flashServerRelease = (input: {
  port: string;
  targetType: "NODE" | "GATEWAY";
  chipFamily: string;
  macAddress: string;
  releaseId: string;
  expectedDeviceId: string | null;
}) => invoke<NativeFlashResult>("flash_server_release", { request: input });

export type DesktopNode = {
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
  farm?: { id: string; name: string; location?: string | null } | null;
  zone?: { id: string; name: string; crop_type?: string | null } | null;
  latest_telemetry?: {
    soil_moisture?: number | null;
    soil_temp?: number | null;
    air_temp?: number | null;
    air_humidity?: number | null;
    lux?: number | null;
    battery_level?: number | null;
    timestamp: string;
  } | null;
};

export const listDesktopNodes = () => invoke<DesktopNode[]>("list_desktop_nodes");
export const unbindDesktopNode = (nodeId: string) => invoke<any>("unbind_desktop_node", { nodeId });
export const deleteDesktopNode = (nodeId: string) => invoke<any>("delete_desktop_node", { nodeId });

export const startSerialMonitor = (port: string, baudRate: number) =>
  invoke<void>("start_serial_monitor", { port, baudRate });
export const stopSerialMonitor = () => invoke<void>("stop_serial_monitor");
export const sendSerialData = (data: string) => invoke<void>("send_serial_data", { data });
export const resetEsp32Device = (port?: string) => invoke<void>("reset_esp32_device", { port });

export const saveQrPng = (path: string, bytes: number[]) => invoke<void>("save_qr_png", { path, bytes });

export type DesktopDeviceQr = { qrId: string; deviceId: string; state: string; payload: Record<string, unknown> | null };
export const getDesktopNodeQr = (nodeId: string) => invoke<DesktopDeviceQr | null>("get_desktop_node_qr", { nodeId });
