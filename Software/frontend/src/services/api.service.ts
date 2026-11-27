import { Zone, WaterTankState, IrrigationLog, WaterSummary, AlertItem, TelemetryPoint, NodeDevice, UserProfile, FarmItem, ManufacturingBatch, ManufacturingIdentity, ManufacturingQrLabel, ManufacturingLifecycleEvent } from "../types";
import { supabase, isSupabaseConfigured } from "./supabase";

const API_BASE = "/api/v1";

// Authentication is an HttpOnly session cookie. The CSRF value intentionally
// remains memory-only: a page reload obtains a fresh copy from /auth/csrf.
let csrfToken: string | null = null;

function clearClientSession() {
  csrfToken = null;
  localStorage.removeItem("farmos_user");
}

export function getCurrentUser(): UserProfile | null {
  const userStr = localStorage.getItem("farmos_user");
  if (!userStr) return null;
  try {
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

export function setCurrentUser(user: UserProfile) {
  localStorage.setItem("farmos_user", JSON.stringify(user));
}

function getHeaders(extraHeaders: Record<string, string> = {}) {
  return {
    "Content-Type": "application/json",
    ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
    ...extraHeaders,
  };
}

function configuredSupabase() {
  if (!supabase) throw new Error("Chưa cấu hình Supabase public cho web.");
  return supabase;
}

// Kept as a small adapter seam for admin flows that need the same authenticated
// session/CSRF headers without coupling their UI to the rest of this service.
export function getApiHeaders(extraHeaders: Record<string, string> = {}) {
  return getHeaders(extraHeaders);
}

async function establishSession(accessToken: string): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/session`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accessToken }),
  });
  if (res.status === 429) throw new Error("Có quá nhiều lần đăng nhập. Vui lòng chờ rồi thử lại.");
  const data = await res.json();
  if (!data.success || typeof data.data?.csrfToken !== "string") {
    throw new Error(data.error || "Không thể tạo phiên đăng nhập an toàn");
  }
  csrfToken = data.data.csrfToken;
}

async function refreshCsrfToken(): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/csrf`, { credentials: "include" });
  const data = await res.json();
  if (!data.success || typeof data.data?.csrfToken !== "string") {
    throw new Error(data.error || "Phiên đăng nhập đã hết hạn");
  }
  csrfToken = data.data.csrfToken;
}

// 1. AUTH API (Supabase Auth & Fallback)

/**
 * Đăng nhập qua Supabase Auth (hoặc fallback về API nội bộ nếu chưa cấu hình Supabase Key)
 */
export async function loginUser(email: string, password: string): Promise<{ user: UserProfile }> {
  if (isSupabaseConfigured) {
    const { data, error } = await configuredSupabase().auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw new Error(error.message);
    if (!data.session?.access_token) throw new Error("Không nhận được phiên đăng nhập từ Supabase");

    await establishSession(data.session.access_token);

    // Đồng bộ và tải thông tin Profile từ FarmOS Backend
    const userProfile = await syncUserProfile({ email });
    return { user: userProfile };
  }

  // Fallback: Gọi trực tiếp Express Backend REST API
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Đăng nhập thất bại");
  await establishSession(data.data.token);
  const user = await syncUserProfile({ email });
  return { user };
}

/**
 * Đăng ký tài khoản mới qua Supabase Auth và tự động khởi tạo Vườn mặc định
 */
export async function registerUser(params: {
  email: string;
  password: string;
  name?: string;
  farmName?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}): Promise<{ user: UserProfile }> {
  if (isSupabaseConfigured) {
    const { data, error } = await configuredSupabase().auth.signUp({
      email: params.email,
      password: params.password,
      options: {
        data: {
          full_name: params.name || params.email.split("@")[0],
        },
      },
    });

    if (error) throw new Error(error.message);
    
    // Nếu Supabase yêu cầu xác nhận email hoặc trả về session
    const token = data.session?.access_token;
    if (token) {
      await establishSession(token);
      const userProfile = await syncUserProfile(params);
      return { user: userProfile };
    } else {
      throw new Error("Đăng ký thành công! Vui lòng kiểm tra hộp thư email để kích hoạt tài khoản Supabase.");
    }
  }

  // Fallback: Gọi trực tiếp Express Backend REST API
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Đăng ký thất bại");
  await establishSession(data.data.token);
  const user = await syncUserProfile(params);
  return { user };
}

/**
 * Đăng nhập bằng tài khoản Google (OAuth 1-Click) qua Supabase
 */
export async function loginWithGoogle(): Promise<void> {
  if (!isSupabaseConfigured) {
    throw new Error("Chưa cấu hình Supabase Key để sử dụng Google OAuth.");
  }

  const { error } = await configuredSupabase().auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${window.location.origin}/dashboard`,
    },
  });

  if (error) throw new Error(error.message);
}

function parseJwtPayload(token: string): any {
  try {
    const base64Url = token.split(".")[1];
    if (!base64Url) return null;
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(jsonPayload);
  } catch {
    return null;
  }
}

/**
 * Hoàn tất One Tap bằng ID token Google và nonce Supabase kiểm tra lại.
 */
export async function signInWithGoogleIdToken(credential: string, nonce: string): Promise<UserProfile> {
  if (!isSupabaseConfigured) {
    throw new Error("Chưa cấu hình Supabase Key để sử dụng Google Sign-In.");
  }

  const { data, error } = await configuredSupabase().auth.signInWithIdToken({
    provider: "google",
    token: credential,
    nonce,
  });

  if (error) throw new Error(error.message);
  if (!data.session?.access_token) throw new Error("Không nhận được phiên đăng nhập từ Google.");

  await establishSession(data.session.access_token);

  const googleJwt = parseJwtPayload(credential);
  const avatarUrl =
    data.user?.user_metadata?.avatar_url ||
    data.user?.user_metadata?.picture ||
    googleJwt?.picture ||
    null;

  return syncUserProfile({
    email: data.user?.email || googleJwt?.email,
    name: data.user?.user_metadata?.full_name || data.user?.user_metadata?.name || googleJwt?.name,
    avatar_url: avatarUrl,
  });
}

/**
 * Đăng xuất khỏi hệ thống & Supabase
 */
export async function logoutUser(): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      credentials: "include",
      headers: getHeaders(),
    });
  } catch {
    // Clear browser state even if an expired session no longer reaches the API.
  }
  if (isSupabaseConfigured) {
    try {
      await configuredSupabase().auth.signOut();
    } catch {
      // Ignored
    }
  }
  clearClientSession();
}

/**
 * Đồng bộ Profile người dùng và thông tin Vườn sau khi xác thực
 */
export async function syncUserProfile(extraData?: {
  email?: string;
  name?: string;
  avatar_url?: string | null;
  farmName?: string;
  address?: string;
  latitude?: number;
  longitude?: number;
}): Promise<UserProfile> {

  const res = await fetch(`${API_BASE}/auth/sync`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(extraData || {}),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Không thể đồng bộ hồ sơ người dùng");
  setCurrentUser(data.data);
  return data.data;
}

export async function fetchMe(): Promise<UserProfile> {
  await refreshCsrfToken();
  const res = await fetch(`${API_BASE}/auth/me`, {
    credentials: "include",
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  setCurrentUser(data.data);
  return data.data;
}

// 2. FARMS & MAP OVERVIEW API
export async function fetchFarms(): Promise<FarmItem[]> {
  const res = await fetch(`${API_BASE}/farms`, {
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function fetchMapOverview(): Promise<FarmItem[]> {
  const res = await fetch(`${API_BASE}/farms/map-overview`, {
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

// 3. NODE MANAGEMENT & CLAIMING (GPS)
export async function fetchNodes(): Promise<NodeDevice[]> {
  const res = await fetch(`${API_BASE}/nodes`, {
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function fetchNodeQr(deviceId: string): Promise<Pick<ManufacturingQrLabel, "qrId" | "deviceId" | "state" | "payload"> | null> {
  const res = await fetch(`${API_BASE}/nodes/${encodeURIComponent(deviceId)}/qr`, {
    credentials: "include",
    headers: getHeaders(),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error || "Không thể tải QR thiết bị");
  return data.data;
}

export async function claimNode(params: {
  nodeId?: string;
  serialNumber?: string;
  claimCode: string;
  name?: string;
  farmId: string;
  zoneId?: string;
  gatewayId?: string;
  latitude?: number;
  longitude?: number;
  type?: string;
}): Promise<NodeDevice> {
  const res = await fetch(`${API_BASE}/nodes/claim`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Kích hoạt thiết bị thất bại");
  return data.data;
}

export async function updateNodeLocation(
  nodeId: string,
  params: { latitude?: number; longitude?: number; zoneId?: string; gatewayId?: string; name?: string }
): Promise<NodeDevice> {
  const res = await fetch(`${API_BASE}/nodes/${nodeId}/location`, {
    method: "PATCH",
    headers: getHeaders(),
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Cập nhật vị trí thất bại");
  return data.data;
}

export async function deleteNode(nodeId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/nodes/${nodeId}`, {
    method: "DELETE",
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
}

export async function unbindNode(nodeId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/nodes/${encodeURIComponent(nodeId)}/unbind`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ offlineRelease: true }),
  });
  const data = await res.json();
  if (!data.success || data.data?.status !== "APPLIED") throw new Error(data.error || "Hủy liên kết thiết bị thất bại");
}

// ADMIN PROVISIONING & INVENTORY API
export async function provisionNode(params: {
  id: string;
  serialNumber?: string;
  name?: string;
  type?: string;
  farmId?: string;
  gatewayId?: string;
}): Promise<any> {
  const res = await fetch(`${API_BASE}/nodes/provision`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Đăng ký thiết bị thất bại");
  return data;
}

export async function fetchInventoryNodes(status?: "all" | "unactivated" | "activated"): Promise<any[]> {
  const query = status && status !== "all" ? `?status=${status}` : "";
  // The identity-aware admin inventory is the source of truth for newly
  // enrolled boards. Keep the legacy Node endpoint as a compatibility path
  // for old installations that have not deployed the admin route yet.
  const identityResponse = await fetch(`${API_BASE}/admin/devices${query}`, {
    credentials: "include",
    headers: getHeaders(),
  });
  if (identityResponse.ok) {
    const identityPayload = await identityResponse.json();
    if (!identityPayload.success) throw new Error(identityPayload.error || "Không thể tải kho identity");
    const rawDevices = Array.isArray(identityPayload.data)
      ? identityPayload.data
      : Array.isArray(identityPayload.data?.devices)
        ? identityPayload.data.devices
        : [];
    return rawDevices.map((device: any) => {
      const identity = device.identity || device.deviceIdentity || device.device_identity || {};
      const node = device.node || {};
      const id = String(device.id || device.deviceId || device.device_id || identity.deviceId || identity.device_id || "");
      const type = String(device.type || device.device_type || identity.type || node.type || "SENSOR_NODE").toUpperCase();
      // A claimed identity remains activated even if its legacy Node row has
      // not caught up yet. Treat any claim or an explicitly active Node as
      // authoritative; do not let an explicit `false` mask a claim.
      const activated = Boolean(
        device.is_activated === true ||
        device.isActivated === true ||
        node.isActivated === true ||
        device.claimedById ||
        device.claimedFarmId,
      );
      return {
        ...device,
        id,
        serial_number: device.serial_number ?? device.serial ?? identity.serial ?? node.serial ?? null,
        name: device.name ?? identity.name ?? node.name ?? device.model ?? id,
        type,
        farm_id: device.farm_id ?? device.farm?.id ?? device.claimedFarmId ?? node.farmId ?? null,
        gateway_id: device.gateway_id ?? device.gatewayId ?? node.gatewayId ?? null,
        is_activated: Boolean(activated),
        online: Boolean(device.online ?? node.online),
        rssi: device.rssi ?? node.rssi ?? null,
        firmware_version: device.firmware_version ?? device.firmwareVersion ?? identity.firmwareVersion ?? node.firmwareVersion ?? null,
        created_at: device.created_at ?? device.createdAt ?? node.createdAt ?? null,
        updated_at: device.updated_at ?? device.updatedAt ?? node.updatedAt ?? null,
        farm: device.farm || (node.farmName ? { id: node.farmId || device.claimedFarmId || "", name: node.farmName } : null),
        gateway: device.gateway || (node.gatewayId ? { id: node.gatewayId, name: null, serial_number: null } : null),
        identity_state: identity.state ?? device.identity_state ?? null,
        firmware_target: identity.firmware_target ?? identity.firmwareTarget ?? device.firmware_target ?? device.firmwareTarget ?? null,
        hardware_revision: identity.hardware_revision ?? identity.hardwareRevision ?? device.hardware_revision ?? device.hardwareRevision ?? null,
      };
    }).filter((device: any) => device.id);
  }
  if (identityResponse.status !== 404) {
    const payload = await identityResponse.json().catch(() => null);
    throw new Error(payload?.error || "Không thể tải kho identity");
  }

  const res = await fetch(`${API_BASE}/nodes/inventory${query}`, {
    credentials: "include",
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!res.ok || !data.success) throw new Error(data.error || "Không thể tải kho thiết bị");
  return data.data;
}

function manufacturingIdempotencyKey(operation: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `web-${operation}-${random}`;
}

async function manufacturingRequest<T>(path: string, init: RequestInit = {}, idempotent = false): Promise<T> {
  const headers = getHeaders({
    ...(idempotent ? { "Idempotency-Key": manufacturingIdempotencyKey(path.replace(/[^a-z0-9]+/gi, "-")) } : {}),
    ...(init.headers as Record<string, string> | undefined),
  });
  const res = await fetch(`${API_BASE}/manufacturing${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) throw new Error(data?.error || "Manufacturing API request failed");
  return data.data as T;
}

export async function fetchManufacturingBatches(): Promise<ManufacturingBatch[]> {
  return manufacturingRequest<ManufacturingBatch[]>("/batches");
}

export async function createManufacturingBatch(input: {
  batchNumber: string;
  model: string;
  type: "GATEWAY" | "SENSOR_NODE";
  hardwareRevision: string;
  quantity: number;
  firmwareTarget?: string;
}): Promise<ManufacturingBatch> {
  return manufacturingRequest<ManufacturingBatch>("/batches", { method: "POST", body: JSON.stringify(input) }, true);
}

export async function allocateManufacturingIdentities(batchId: string, quantity: number): Promise<{ batchId: string; identities: ManufacturingIdentity[] }> {
  return manufacturingRequest<{ batchId: string; identities: ManufacturingIdentity[] }>(`/batches/${encodeURIComponent(batchId)}/allocate`, {
    method: "POST",
    body: JSON.stringify({ quantity }),
  }, true);
}

export async function qcPassManufacturingBatch(batchId: string, deviceIds?: string[]): Promise<ManufacturingBatch> {
  return manufacturingRequest<ManufacturingBatch>(`/batches/${encodeURIComponent(batchId)}/qc-pass`, {
    method: "POST",
    body: JSON.stringify(deviceIds?.length ? { deviceIds } : {}),
  }, true);
}

export async function releaseManufacturingBatch(batchId: string): Promise<ManufacturingBatch> {
  return manufacturingRequest<ManufacturingBatch>(`/batches/${encodeURIComponent(batchId)}/ready-to-ship`, {
    method: "POST",
    body: JSON.stringify({}),
  }, true);
}

export async function fetchManufacturingLabels(batchId?: string): Promise<ManufacturingQrLabel[]> {
  const query = batchId ? `?batchId=${encodeURIComponent(batchId)}` : "";
  return manufacturingRequest<ManufacturingQrLabel[]>(`/qr${query}`);
}

export async function issueManufacturingQr(batchId: string, deviceIds?: string[]): Promise<ManufacturingQrLabel[]> {
  return manufacturingRequest<ManufacturingQrLabel[]>(`/batches/${encodeURIComponent(batchId)}/qr/issue`, {
    method: "POST",
    body: JSON.stringify(deviceIds?.length ? { deviceIds } : {}),
  }, true);
}

export async function confirmManufacturingPrint(qrId: string): Promise<ManufacturingQrLabel> {
  return manufacturingRequest<ManufacturingQrLabel>(`/qr/${encodeURIComponent(qrId)}/print-confirm`, { method: "POST", body: JSON.stringify({}) }, true);
}

export async function reprintManufacturingQr(qrId: string, reason: string): Promise<ManufacturingQrLabel> {
  return manufacturingRequest<ManufacturingQrLabel>(`/qr/${encodeURIComponent(qrId)}/reprint`, { method: "POST", body: JSON.stringify({ reason }) }, true);
}

export async function quarantineManufacturingDevice(deviceId: string, reason: string): Promise<ManufacturingIdentity> {
  return manufacturingRequest<ManufacturingIdentity>(`/devices/${encodeURIComponent(deviceId)}/quarantine`, { method: "POST", body: JSON.stringify({ reason }) }, true);
}

export async function revokeManufacturingQr(qrId: string, reason: string): Promise<ManufacturingQrLabel> {
  return manufacturingRequest<ManufacturingQrLabel>(`/qr/${encodeURIComponent(qrId)}/revoke`, { method: "POST", body: JSON.stringify({ reason }) }, true);
}

export async function fetchManufacturingAudit(deviceId: string): Promise<ManufacturingLifecycleEvent[]> {
  return manufacturingRequest<ManufacturingLifecycleEvent[]>(`/devices/${encodeURIComponent(deviceId)}/events`);
}

export async function exportManufacturingQrCsv(batchId?: string): Promise<Blob> {
  const query = batchId ? `?batchId=${encodeURIComponent(batchId)}` : "";
  const res = await fetch(`${API_BASE}/manufacturing/qr/export${query}`, {
    credentials: "include",
    headers: getHeaders(),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error || "Không thể xuất danh sách QR");
  }
  return res.blob();
}

// 4. ADMIN USER MANAGEMENT API
export async function fetchUsers(): Promise<UserProfile[]> {
  const res = await fetch(`${API_BASE}/users`, {
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function createAdminUser(params: {
  email: string;
  password: string;
  name?: string;
  role?: "ADMIN" | "USER";
}): Promise<UserProfile> {
  const res = await fetch(`${API_BASE}/users`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function updateUserRole(userId: string, role: string): Promise<UserProfile> {
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    method: "PATCH",
    headers: getHeaders(),
    body: JSON.stringify({ role }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function deleteUser(userId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/users/${userId}`, {
    method: "DELETE",
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
}

// 5. ZONES & IRRIGATION & TELEMETRY
export async function fetchZones(): Promise<Zone[]> {
  const res = await fetch(`${API_BASE}/zones`, {
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function fetchFarmOverview(farmId: string = "F01"): Promise<{
  farm: any;
  tankState: WaterTankState;
  activeAlertsCount: number;
}> {
  const res = await fetch(`${API_BASE}/farms/${farmId}/overview`, {
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function fetchTelemetryHistory(
  zoneId: string,
  range: string = "1h"
): Promise<{ count: number; points: TelemetryPoint[] }> {
  const res = await fetch(`${API_BASE}/telemetry/zones/${zoneId}/history?range=${range}`, {
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function triggerManualIrrigation(params: {
  zoneId: string;
  valveId?: string;
  durationSec: number;
  reason?: string;
}): Promise<{ success: boolean; message: string; error?: string; data?: { commandId: string; durationSec: number } }> {
  const res = await fetch(`${API_BASE}/irrigation/manual`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify(params),
  });
  return res.json();
}

export async function triggerEmergencyStop(farmId: string = "F01"): Promise<{ success: boolean; message: string }> {
  const res = await fetch(`${API_BASE}/irrigation/emergency-stop`, {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ farmId }),
  });
  return res.json();
}

export async function fetchIrrigationLogs(params?: {
  zoneId?: string;
  limit?: number;
  page?: number;
}): Promise<{ total: number; logs: IrrigationLog[] }> {
  const query = new URLSearchParams();
  if (params?.zoneId) query.set("zoneId", params.zoneId);
  if (params?.limit) query.set("limit", String(params.limit));
  if (params?.page) query.set("page", String(params.page));

  const res = await fetch(`${API_BASE}/irrigation/logs?${query.toString()}`, {
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function fetchWaterSummary(): Promise<WaterSummary[]> {
  const res = await fetch(`${API_BASE}/irrigation/water-summary`, {
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function fetchAlerts(resolved: boolean = false): Promise<AlertItem[]> {
  const res = await fetch(`${API_BASE}/alerts?resolved=${resolved}`, {
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function resolveAlert(alertId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/alerts/${alertId}/resolve`, {
    method: "PATCH",
    headers: getHeaders(),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
}

export async function updateZoneConfig(
  zoneId: string,
  config: { target_moisture_min?: number; target_moisture_max?: number; crop_type?: string }
): Promise<Zone> {
  const res = await fetch(`${API_BASE}/zones/${zoneId}`, {
    method: "PATCH",
    headers: getHeaders(),
    body: JSON.stringify(config),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export interface OtaCheckResponse {
  updateAvailable: boolean;
  currentVersion: string;
  latestRelease?: {
    id: string;
    deviceType: "GATEWAY" | "SENSOR_NODE";
    version: string;
    fileName: string;
    sha256: string;
    sizeBytes: number;
    changelog: string;
    releaseDate: string;
  };
  downloadUrl?: string;
}

export async function checkFirmwareUpdate(
  deviceType: "GATEWAY" | "SENSOR_NODE",
  currentVersion: string,
  deviceId: string
): Promise<OtaCheckResponse> {
  const res = await fetch(
    `${API_BASE}/ota/check?deviceType=${encodeURIComponent(deviceType)}&currentVersion=${encodeURIComponent(currentVersion)}&deviceId=${encodeURIComponent(deviceId)}`,
    { headers: getHeaders() }
  );
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
}

export async function fetchFirmwareReleases(
  deviceType?: "GATEWAY" | "SENSOR_NODE"
): Promise<any[]> {
  const url = deviceType ? `${API_BASE}/ota/releases?deviceType=${deviceType}` : `${API_BASE}/ota/releases`;
  const res = await fetch(url, { headers: getHeaders() });
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.data;
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

async function pumpRequest<T>(nodeId: string, init: RequestInit, commandId?: string): Promise<T> {
  let response: Response;
  try {
    const query = commandId ? `?${new URLSearchParams({ commandId })}` : "";
    response = await fetch(`${API_BASE}/pumps/${encodeURIComponent(nodeId)}${query}`, { ...init, headers: getHeaders(), cache: "no-store" });
  } catch {
    throw new Error("NETWORK_ERROR");
  }
  if (response.status === 401 || response.status === 403) throw new Error("SESSION_EXPIRED");
  if (response.status === 429) throw new Error("RATE_LIMITED");
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) throw new Error(body?.error || "SERVER_UNAVAILABLE");
  return body.data;
}

export function getPumpControl(nodeId: string, signal: AbortSignal, commandId?: string) {
  return pumpRequest<PumpControlStatus>(nodeId, { signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) }, commandId);
}

export function sendPumpCommand(nodeId: string, on: boolean, requestId: string) {
  return pumpRequest<PumpCommand>(nodeId, { method: "POST", body: JSON.stringify({ on, requestId }), signal: AbortSignal.timeout(8000) });
}
