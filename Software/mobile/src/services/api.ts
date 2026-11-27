import type { PumpCommand, PumpControlStatus } from "../types";
import { config } from "../config";
import { saveMobileToken } from "./session";
import { getFreshIdentityToken } from "./supabase";
import type { AdminDeviceInventory, AlertItem, CloudProvisioningSession, CloudProvisioningStatus, DeploymentMode, DeviceModeSession, Farm, FarmDevice, FarmOverview, GatewayClaimSession, IrrigationLog, MapFarm, PairingSessionResult, PairingSessionStatus, QrClaimSession, QrClaimSessionStatus, QrV3Payload, ResolvedDeviceQr, ResolvedDeviceQrV3, UserProfile, Zone } from "../types";

let accessToken: string | null = null;

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const FIRMWARE_DOWNLOAD_TIMEOUT_MS = 120_000;

export class ApiTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  readonly timeoutMs: number;
  readonly path: string;

  constructor(path: string, timeoutMs: number) {
    super(`Yêu cầu quá thời gian sau ${Math.round(timeoutMs / 1000)} giây`);
    this.name = "ApiTimeoutError";
    this.timeoutMs = timeoutMs;
    this.path = path;
  }
}

export type ApiRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  idempotencyKey?: string;
};

const transientGatewayStatuses = new Set([502, 503, 504]);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function createAbortError() {
  const error = new Error("Yêu cầu đã bị hủy");
  error.name = "AbortError";
  return error;
}

/**
 * Runs both the request and response-body read under one timeout. React Native
 * supports AbortController, but a timeout still needs to race the operation so
 * a fetch implementation that does not immediately reject on abort cannot
 * leave the caller waiting forever.
 */
async function withTimeout<T>(
  path: string,
  operation: (signal: AbortSignal) => Promise<T>,
  options: ApiRequestOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let rejectExternalAbort: ((reason?: unknown) => void) | undefined;

  if (options.signal?.aborted) throw createAbortError();

  const externalAbortPromise = options.signal
    ? new Promise<never>((_, reject) => {
      rejectExternalAbort = reject;
    })
    : undefined;

  if (options.signal) {
    const onAbort = () => {
      controller.abort();
      rejectExternalAbort?.(createAbortError());
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
  }

  const operationPromise = operation(controller.signal);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ApiTimeoutError(path, timeoutMs));
    }, timeoutMs);
  });

  try {
    return await Promise.race(externalAbortPromise
      ? [operationPromise, timeoutPromise, externalAbortPromise]
      : [operationPromise, timeoutPromise]);
  } catch (error) {
    if (timedOut) throw new ApiTimeoutError(path, timeoutMs);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeAbortListener?.();
    // If the timeout won the race, the native fetch may reject a little later.
    // Consume that rejection so it cannot become an unhandled promise.
    operationPromise.catch(() => undefined);
  }
}

let refreshInFlight: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/**
 * Attempts a silent refresh of the FarmOS mobile session using Supabase stored credentials.
 * Concurrently queued 401s reuse a single in-flight refresh promise.
 */
export async function silentRefreshToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const freshIdentityToken = await getFreshIdentityToken();
      if (!freshIdentityToken) return null;

      const newMobileToken = await exchangeSupabaseToken(freshIdentityToken);
      if (!newMobileToken) return null;

      setAccessToken(newMobileToken);
      await saveMobileToken(newMobileToken);
      return newMobileToken;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

export async function request<T>(path: string, init: RequestInit = {}, options: ApiRequestOptions = {}): Promise<T> {
  const { signal: requestSignal, ...requestInit } = init;
  return withTimeout(path, async (signal) => {
    const doFetch = (bearer: string | null) =>
      fetch(`${config.apiBaseUrl}/api/v1${path}`, {
        ...requestInit,
        signal,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
          ...init.headers,
        },
      });

    let response = await doFetch(accessToken);
    let body = await response.json().catch(() => null);

    // A deploy/tunnel rotation can briefly return a gateway error even though
    // the mobile session is still valid. Retry only safe, read-only requests;
    // mutations remain single-shot so irrigation and provisioning are never
    // replayed without the user's intent.
    if (
      requestInit.method === undefined || requestInit.method.toUpperCase() === "GET"
        ? transientGatewayStatuses.has(response.status)
        : false
    ) {
      await wait(500);
      response = await doFetch(accessToken);
      body = await response.json().catch(() => null);
    }

    // If 401 occurs on any resource path, attempt transparent silent refresh and retry
    if (response.status === 401 && path !== "/auth/mobile/session") {
      const refreshedToken = await silentRefreshToken();
      if (refreshedToken) {
        response = await doFetch(refreshedToken);
        body = await response.json().catch(() => null);
      }
    }

    if (response.status === 401) {
      throw new Error(body?.error || "Phiên đăng nhập đã hết hạn (401). Vui lòng đăng nhập lại.");
    }
    if (!response.ok || !body?.success) {
      throw new Error(body?.error || `Không thể kết nối đến FarmOS (${response.status})`);
    }
    return body.data as T;
  }, { ...options, signal: options.signal ?? requestSignal });
}

export async function exchangeSupabaseToken(identityToken: string): Promise<string> {
  return withTimeout("/auth/mobile/session", async (signal) => {
    const response = await fetch(`${config.apiBaseUrl}/api/v1/auth/mobile/session`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ accessToken: identityToken }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.success || typeof body?.data?.accessToken !== "string") {
      throw new Error(body?.error || "Không thể tạo phiên đăng nhập mobile");
    }
    return body.data.accessToken;
  });
}

async function uploadAvatar(asset: { uri: string; type?: string | null; fileName?: string | null }): Promise<Pick<UserProfile, "id" | "email" | "name" | "role" | "avatar_url">> {
  return withTimeout("/auth/avatar", async (signal) => {
    const upload = async (bearer: string | null) => {
      const form = new FormData();
      form.append("avatar", {
        uri: asset.uri,
        type: asset.type || "image/jpeg",
        name: asset.fileName || "avatar.jpg",
      } as never);
      return fetch(`${config.apiBaseUrl}/api/v1/auth/avatar`, {
        method: "POST",
        signal,
        headers: { Accept: "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
        body: form,
      });
    };

    let response = await upload(accessToken);
    let body = await response.json().catch(() => null);
    if (response.status === 401) {
      const refreshedToken = await silentRefreshToken();
      if (refreshedToken) {
        response = await upload(refreshedToken);
        body = await response.json().catch(() => null);
      }
    }
    if (!response.ok || !body?.success) throw new Error(body?.error || "Không thể tải ảnh đại diện lên FarmOS");
    return body.data;
  }, { timeoutMs: 60_000 });
}

function newIdempotencyKey(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 12);
  return `${prefix}-${Date.now()}-${random}`;
}

export const api = {
  me: () => request<UserProfile>("/auth/me"),
  syncProfile: (input: { name?: string; avatar_url?: string | null }) => request<UserProfile>("/auth/sync", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  uploadAvatar,
  farms: () => request<Farm[]>("/farms"),
  createFarm: (name: string) => request<Farm>("/farms", { method: "POST", body: JSON.stringify({ name }) }),
  deleteFarm: (id: string) => request<{ id: string }>(`/farms/${encodeURIComponent(id)}`, { method: "DELETE" }),
  mapOverview: () => request<MapFarm[]>("/farms/map-overview"),
  zones: () => request<Zone[]>("/zones"),
  overview: (farmId: string) => request<FarmOverview>(`/farms/${encodeURIComponent(farmId)}/overview`),
  alerts: () => request<AlertItem[]>("/alerts?resolved=false"),
  users: () => request<Array<UserProfile>>("/users"),
  updateUser: (userId: string, input: { name?: string; role?: UserProfile["role"] }) => request<UserProfile>(`/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  }),
  deleteUser: (userId: string) => request<{ message?: string }>(`/users/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  }),
  devices: () => request<FarmDevice[]>("/nodes"),
  pumpStatus: (nodeId: string, signal: AbortSignal, commandId?: string) =>
    request<PumpControlStatus>(`/pumps/${encodeURIComponent(nodeId)}${commandId ? `?commandId=${encodeURIComponent(commandId)}` : ""}`,
      {}, { signal, timeoutMs: 8000 }),
  sendPumpCommand: (nodeId: string, on: boolean, requestId: string) =>
    request<PumpCommand>(`/pumps/${encodeURIComponent(nodeId)}`, {
      method: "POST",
      body: JSON.stringify({ on, requestId }),
    }, { timeoutMs: 8000 }),
  // This is the same ADMIN-only, identity-aware registry used by the web
  // inventory. It includes unclaimed factory boards, which /nodes cannot.
  adminDevices: () => request<AdminDeviceInventory[]>("/admin/devices"),
  resolveDeviceQr: (input: { deviceId: string; claimCode: string }) =>
    request<ResolvedDeviceQr>("/onboarding/devices/resolve-qr", { method: "POST", body: JSON.stringify(input) }),
  resolveQrV3: (payload: QrV3Payload) =>
    request<ResolvedDeviceQrV3>("/onboarding/qr/resolve", { method: "POST", body: JSON.stringify({ payload }) }),
  createQrClaimSession: (input: { payload: QrV3Payload; farmId: string; zoneId?: string; deploymentMode: DeploymentMode; idempotencyKey?: string }) =>
    request<QrClaimSession>("/onboarding/qr/claim-sessions", {
      method: "POST",
      body: JSON.stringify({ payload: input.payload, farmId: input.farmId, zoneId: input.zoneId, deploymentMode: input.deploymentMode }),
    }, { idempotencyKey: input.idempotencyKey || newIdempotencyKey("claim") }),
  createDeviceModeSession: (input: { deviceId: string; farmId: string; zoneId?: string; gatewayId?: string; deploymentMode: DeploymentMode; wifiReconfigure?: boolean; idempotencyKey?: string }) =>
    request<DeviceModeSession>(`/onboarding/devices/${encodeURIComponent(input.deviceId)}/mode-sessions`, {
      method: "POST",
      body: JSON.stringify({ deviceId: input.deviceId, farmId: input.farmId, zoneId: input.zoneId, gatewayId: input.gatewayId, deploymentMode: input.deploymentMode, wifiReconfigure: input.wifiReconfigure }),
    }, { idempotencyKey: input.idempotencyKey || newIdempotencyKey(`mode-${input.deviceId}`) }),
  qrClaimSessionStatus: (sessionId: string) =>
    request<QrClaimSessionStatus>(`/onboarding/qr/claim-sessions/${encodeURIComponent(sessionId)}`),
  attestQrClaimSession: (sessionId: string, proof: { signature: string; nonce: string; provisioningToken: string }) =>
    request<{ sessionId: string; status: "ATTESTED"; attestedAt?: string | null }>(`/onboarding/qr/claim-sessions/${encodeURIComponent(sessionId)}/attest`, {
      method: "POST",
      body: JSON.stringify(proof),
    }, { idempotencyKey: newIdempotencyKey(`attest-${sessionId}`) }),
  finalizeQrClaimSession: (sessionId: string, input: { name?: string; gatewayId?: string; latitude?: number; longitude?: number }) =>
    request<{
      sessionId: string;
      status: "FINALIZED";
      node: FarmDevice;
      provisioning?: { sessionId: string; deviceId: string; provisioningToken: string; expiresAt: string; deploymentMode: DeploymentMode };
      pairing?: { pairingId: string; nodeId: string; gatewayId: string; radioToken: string; expiresAt: string; status: PairingSessionStatus };
    }>(`/onboarding/qr/claim-sessions/${encodeURIComponent(sessionId)}/finalize`, {
      method: "POST",
      body: JSON.stringify(input),
    }, { idempotencyKey: newIdempotencyKey(`finalize-${sessionId}`) }),
  createCloudDeviceSession: (input: { deviceId: string; claimCode: string; farmId: string; zoneId?: string; deploymentMode: Exclude<DeploymentMode, "LEAF_NODE"> }) =>
    request<CloudProvisioningSession>("/onboarding/devices/cloud-session", { method: "POST", body: JSON.stringify(input) }),
  cloudDeviceSessionStatus: (sessionId: string, options?: ApiRequestOptions) =>
    request<{ sessionId: string; deviceId: string; status: CloudProvisioningStatus; deploymentMode: DeploymentMode }>(`/onboarding/devices/cloud-sessions/${encodeURIComponent(sessionId)}`, {}, options),
  createGatewayClaimSession: (input: { gatewayId: string; claimCode: string; farmId: string }) =>
    request<GatewayClaimSession>("/onboarding/gateways/claim-session", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  gatewayStatus: (gatewayId: string) =>
    request<{ id: string; online: boolean; farmId: string; lastSeen?: string }>(`/onboarding/gateways/${encodeURIComponent(gatewayId)}/status`),
  gatewayClaimStatus: (sessionId: string) =>
    request<{ sessionId: string; gatewayId: string; status: string }>(`/onboarding/gateways/claim-sessions/${encodeURIComponent(sessionId)}`),
  createNodePairingSession: (input: { nodeId: string; possessionCode: string; gatewayId: string; farmId: string; zoneId: string }) =>
    request<PairingSessionResult>("/onboarding/nodes/pairing-sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  pairingStatus: (pairingId: string, options?: ApiRequestOptions) =>
    request<PairingSessionResult & { status: PairingSessionStatus; confirmed_at?: string; failure_reason?: string | null }>(`/onboarding/pairing-sessions/${encodeURIComponent(pairingId)}`, {}, options),
  irrigate: (zoneId: string, durationSec: number) => request<{ commandId?: string; durationSec?: number }>("/irrigation/manual", {
    method: "POST",
    body: JSON.stringify({ zoneId, durationSec }),
  }),
  irrigationLogs: (options: { zoneId?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (options.zoneId) query.set("zoneId", options.zoneId);
    query.set("limit", String(options.limit ?? 50));
    return request<{ total: number; page: number; limit: number; logs: IrrigationLog[] }>(`/irrigation/logs?${query.toString()}`);
  },
  emergencyStop: (farmId: string) => request("/irrigation/emergency-stop", {
    method: "POST",
    body: JSON.stringify({ farmId }),
  }),
  unbindDevice: (deviceId: string) => request<{ status: string }>(`/nodes/${encodeURIComponent(deviceId)}/unbind`, {
    method: "POST",
    body: JSON.stringify({ offlineRelease: true }),
  }),
  resolveAlert: (alertId: string) => request<AlertItem>(`/alerts/${encodeURIComponent(alertId)}/resolve`, {
    method: "PATCH",
  }),
  checkFirmwareUpdate: (deviceType: "GATEWAY" | "SENSOR_NODE", currentVersion: string, deviceId: string) =>
    request<{
      updateAvailable: boolean;
      currentVersion: string;
      jobId?: string;
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
    }>(`/ota/check?deviceType=${encodeURIComponent(deviceType)}&currentVersion=${encodeURIComponent(currentVersion)}&deviceId=${encodeURIComponent(deviceId)}`),
  downloadFirmwareBinary: async (downloadPath: string): Promise<Uint8Array> => {
    const url = downloadPath.startsWith("http") ? downloadPath : `${config.apiBaseUrl}${downloadPath}`;
    return withTimeout("/ota/firmware", async (signal) => {
      const response = await fetch(url, {
        signal,
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });
      if (!response.ok) throw new Error("Không thể tải file firmware");
      const arrayBuffer = await response.arrayBuffer();
      return new Uint8Array(arrayBuffer);
    }, { timeoutMs: FIRMWARE_DOWNLOAD_TIMEOUT_MS });
  },
  reportOtaStatus: (input: {
    deviceId: string;
    jobId: string;
    deviceType: "GATEWAY" | "SENSOR_NODE";
    targetVersion: string;
    status: "DOWNLOADING" | "FLASHING" | "FLASHED" | "BOOT_CONFIRMED" | "FAILED";
    progress?: number;
    error?: string;
  }) =>
    request("/ota/status", {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
