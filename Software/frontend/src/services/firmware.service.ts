import { getApiHeaders } from "./api.service";

const API_BASE = "/api/v1/admin/firmware";

export type FirmwareDeviceType = "GATEWAY" | "SENSOR_NODE";
export type FirmwareReleaseStatus = "DRAFT" | "ACTIVE" | "PAUSED" | "REVOKED";
export type FirmwareReleaseChannel = "OTA" | "FACTORY";
export type FirmwareImageRole = "BOOTLOADER" | "PARTITION_TABLE" | "OTA_DATA" | "APP";

export interface FirmwareImage {
  id: string;
  name: string;
  fileName?: string;
  address?: number;
  sizeBytes: number;
  sha256: string;
  role: FirmwareImageRole;
  required?: boolean;
}

export interface FirmwareRelease {
  id: string;
  deviceType: FirmwareDeviceType;
  firmwareTarget: string;
  hardwareRevisions: string[];
  partitionScheme: string;
  version: string;
  artifactFileName?: string | null;
  artifactSha256: string;
  sizeBytes: number;
  images: FirmwareImage[];
  manifestSha256?: string | null;
  manifestSignature?: string | null;
  manifestKeyId?: string | null;
  writePlans?: Record<string, Array<Record<string, unknown>>>;
  changelog?: string | null;
  minVersion?: string | null;
  otaStatus: FirmwareReleaseStatus;
  flashStatus: FirmwareReleaseStatus;
  factoryReady: boolean;
  rolloutPercent?: number;
  createdAt: string;
  updatedAt: string;
}

export interface FirmwareUploadResult {
  release: FirmwareRelease;
  ota?: Record<string, unknown> | null;
  factoryReady: boolean;
}

export interface FirmwareUploadInput {
  deviceType?: FirmwareDeviceType;
  app: File;
  bootloader?: File;
  partitionTable?: File;
  otaData?: File;
  version?: string;
  changelog?: string;
  hardwareRevisions?: string;
  firmwareTarget?: string;
  partitionScheme?: string;
  minVersion?: string;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

type JsonEnvelope<T> = { success?: boolean; data?: T; error?: string; message?: string };

function apiError(payload: JsonEnvelope<unknown> | null, fallback: string) {
  return String(payload?.error || payload?.message || fallback);
}

function normalizeImage(value: any, index: number): FirmwareImage {
  return {
    id: String(value?.id || `image-${index + 1}`),
    name: String(value?.name || value?.fileName || `image-${index + 1}.bin`),
    fileName: value?.fileName ? String(value.fileName) : undefined,
    address: value?.address === undefined ? undefined : Number(value.address),
    sizeBytes: Number(value?.sizeBytes || value?.size_bytes || 0),
    sha256: String(value?.sha256 || "").toLowerCase(),
    role: String(value?.role || "APP").toUpperCase() as FirmwareImageRole,
    required: value?.required !== false,
  };
}

function normalizeRelease(value: any): FirmwareRelease {
  const release = value?.release && typeof value.release === "object" ? value.release : value;
  const images = Array.isArray(release?.images) ? release.images.map(normalizeImage) : [];
  const status = String(release?.status || release?.otaStatus || "DRAFT").toUpperCase() as FirmwareReleaseStatus;
  const factoryReady = Boolean(release?.factoryReady ?? value?.factoryReady ?? ["BOOTLOADER", "PARTITION_TABLE", "OTA_DATA", "APP"].every((role) => images.some((image: FirmwareImage) => image.role === role)));
  return {
    id: String(release?.id || ""),
    deviceType: String(release?.deviceType || release?.device_type || "SENSOR_NODE").toUpperCase() as FirmwareDeviceType,
    firmwareTarget: String(release?.firmwareTarget || release?.firmware_target || "—"),
    hardwareRevisions: Array.isArray(release?.hardwareRevisions) ? release.hardwareRevisions.map(String) : ["*"],
    partitionScheme: String(release?.partitionScheme || release?.partition_scheme || "—"),
    version: String(release?.version || "—"),
    artifactFileName: release?.artifactFileName ?? release?.artifact_file_name ?? null,
    artifactSha256: String(release?.artifactSha256 || release?.artifact_sha256 || ""),
    sizeBytes: Number(release?.sizeBytes || release?.size_bytes || 0),
    images,
    manifestSha256: release?.manifestSha256 ?? release?.manifest_sha256 ?? null,
    manifestSignature: release?.manifestSignature ?? release?.manifest_signature ?? null,
    manifestKeyId: release?.manifestKeyId ?? release?.manifest_key_id ?? null,
    writePlans: release?.writePlans || release?.write_plans_json || {},
    changelog: release?.changelog ?? null,
    minVersion: release?.minVersion ?? release?.min_version ?? null,
    otaStatus: String(release?.otaStatus || release?.ota_status || status).toUpperCase() as FirmwareReleaseStatus,
    flashStatus: String(release?.flashStatus || release?.flash_status || (factoryReady ? status : "DRAFT")).toUpperCase() as FirmwareReleaseStatus,
    factoryReady,
    rolloutPercent: release?.rolloutPercent === undefined ? Number(release?.rollout_percent ?? 0) : Number(release.rolloutPercent),
    createdAt: String(release?.createdAt || release?.created_at || new Date().toISOString()),
    updatedAt: String(release?.updatedAt || release?.updated_at || new Date().toISOString()),
  };
}

function normalizedInput(input: FirmwareUploadInput): FormData {
  const form = new FormData();
  if (input.deviceType) form.append("deviceType", input.deviceType);
  form.append("app", input.app, input.app.name);
  if (input.bootloader) form.append("bootloader", input.bootloader, input.bootloader.name);
  if (input.partitionTable) form.append("partitionTable", input.partitionTable, input.partitionTable.name);
  if (input.otaData) form.append("otaData", input.otaData, input.otaData.name);
  for (const [key, value] of Object.entries({
    version: input.version,
    changelog: input.changelog,
    hardwareRevisions: input.hardwareRevisions,
    firmwareTarget: input.firmwareTarget,
    partitionScheme: input.partitionScheme,
    minVersion: input.minVersion,
  })) {
    if (value?.trim()) form.append(key, value.trim());
  }
  // The server intentionally ignores a client-supplied hash and always starts
  // the release as DRAFT; do not put JSON/image metadata into this form.
  return form;
}

export async function fetchFirmwareReleases(): Promise<FirmwareRelease[]> {
  const response = await fetch(`${API_BASE}/releases`, { credentials: "include", headers: getApiHeaders() });
  const payload = await response.json().catch(() => null) as JsonEnvelope<any> | null;
  if (!response.ok || !payload?.success) throw new Error(apiError(payload, "Không thể tải danh sách firmware."));
  const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.data?.releases) ? payload.data.releases : [];
  return list.map(normalizeRelease).filter((release: FirmwareRelease) => release.id);
}

export async function uploadFirmwareRelease(input: FirmwareUploadInput): Promise<FirmwareUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let removeAbortListener: () => void = () => undefined;
    const resolveOnce = (value: FirmwareUploadResult) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      resolve(value);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      reject(error);
    };
    xhr.open("POST", `${API_BASE}/releases`);
    xhr.withCredentials = true;
    xhr.timeout = 10 * 60 * 1000;
    const { ["Content-Type"]: _contentType, ...headers } = getApiHeaders();
    // Browser must set the multipart boundary. Keep CSRF/session headers only.
    Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) input.onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onerror = () => rejectOnce(new Error("Không thể kết nối server khi tải firmware."));
    xhr.onabort = () => rejectOnce(new Error("Đã hủy tải firmware."));
    xhr.ontimeout = () => rejectOnce(new Error("Upload firmware quá thời gian chờ; kiểm tra kết nối rồi thử lại."));
    if (input.signal) {
      const abort = () => xhr.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      removeAbortListener = () => input.signal?.removeEventListener("abort", abort);
      if (input.signal.aborted) {
        rejectOnce(new Error("Đã hủy tải firmware."));
        return;
      }
    }
    xhr.onload = () => {
      const payload = (() => { try { return JSON.parse(xhr.responseText) as JsonEnvelope<any>; } catch { return null; } })();
      if (xhr.status < 200 || xhr.status >= 300 || !payload?.success) {
        rejectOnce(new Error(apiError(payload, `Upload firmware thất bại (${xhr.status}).`)));
        return;
      }
      const data = payload.data || {};
      input.onProgress?.(100);
      resolveOnce({ release: normalizeRelease(data.release || data), ota: data.ota || null, factoryReady: Boolean(data.factoryReady ?? data.release?.factoryReady) });
    };
    try {
      xhr.send(normalizedInput(input));
    } catch (error) {
      rejectOnce(error instanceof Error ? error : new Error("Không thể bắt đầu tải firmware."));
    }
  });
}

export async function updateFirmwareRelease(releaseId: string, patch: { channel: FirmwareReleaseChannel; status?: FirmwareReleaseStatus; rolloutPercent?: number; changelog?: string }): Promise<FirmwareRelease> {
  const response = await fetch(`${API_BASE}/releases/${encodeURIComponent(releaseId)}`, {
    method: "PATCH",
    credentials: "include",
    headers: getApiHeaders(),
    body: JSON.stringify(patch),
  });
  const payload = await response.json().catch(() => null) as JsonEnvelope<any> | null;
  if (!response.ok || !payload?.success) throw new Error(apiError(payload, "Không thể cập nhật firmware."));
  return normalizeRelease(payload.data);
}

export async function deleteFirmwareRelease(releaseId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/releases/${encodeURIComponent(releaseId)}`, {
    method: "DELETE",
    credentials: "include",
    headers: getApiHeaders(),
  });
  if (response.status === 204) return;
  const payload = await response.json().catch(() => null) as JsonEnvelope<unknown> | null;
  throw new Error(apiError(payload, "Không thể xóa firmware."));
}

export async function downloadFirmwareArtifact(releaseId: string, imageId?: string, fallbackFileName?: string): Promise<void> {
  const query = imageId ? `?imageId=${encodeURIComponent(imageId)}` : "";
  const response = await fetch(`${API_BASE}/releases/${encodeURIComponent(releaseId)}/download${query}`, {
    credentials: "include",
    headers: getApiHeaders(),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as JsonEnvelope<any> | null;
    throw new Error(apiError(payload, `Không thể tải file firmware (${response.status}).`));
  }
  const contentDisposition = response.headers.get("Content-Disposition");
  let fileName = fallbackFileName || `${releaseId}.bin`;
  if (contentDisposition) {
    const match = contentDisposition.match(/filename="?([^";]+)"?/i);
    if (match?.[1]) fileName = match[1].trim();
  }
  const blob = await response.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
  }, 1000);
}
