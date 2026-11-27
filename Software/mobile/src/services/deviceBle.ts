import { decode as decodeBase64, encode as encodeBase64 } from "base-64";
import { PermissionsAndroid, Platform } from "react-native";
import { BleManager, Device, State, Subscription } from "react-native-ble-plx";
import type { QrV3Payload, QrClaimSession } from "../types";

export const GATEWAY_SERVICE_UUID = "7f510001-9f10-4f10-a001-4641524d4f53";
export const GATEWAY_IDENTITY_UUID = "7f510002-9f10-4f10-a001-4641524d4f53";
export const GATEWAY_CONFIG_UUID = "7f510003-9f10-4f10-a001-4641524d4f53";
export const GATEWAY_AUTH_UUID = "7f510004-9f10-4f10-a001-4641524d4f53";
export const NODE_SERVICE_UUID = "7f520001-9f10-4f10-a001-4641524d4f53";
export const NODE_IDENTITY_UUID = "7f520002-9f10-4f10-a001-4641524d4f53";
export const NODE_PAIRING_UUID = "7f520003-9f10-4f10-a001-4641524d4f53";
export const NODE_OTA_UUID = "7f520004-9f10-4f10-a001-4641524d4f53";
export const NODE_AUTH_UUID = "7f520005-9f10-4f10-a001-4641524d4f53";

export interface BleIdentity {
  version: number;
  type: "GATEWAY" | "SENSOR_NODE";
  id: string;
  serialNumber: string;
  model?: string;
  hardwareRevision?: string;
  firmwareTarget?: string;
  identityVersion?: number;
  attestationPublicKey?: string;
  certFingerprint?: string;
  possessionCode?: string;
  pairingMode?: boolean;
  firmwareVersion?: string;
  capabilities?: string[];
  currentMode?: "GATEWAY" | "LEAF_NODE" | "STANDALONE_NODE" | "UNCONFIGURED";
}

export interface NearbyFarmDevice {
  bleId: string;
  name: string;
  type: "GATEWAY" | "SENSOR_NODE";
  rssi?: number | null;
}

let manager: BleManager | null = null;
let otaTransactionSequence = 0;
let activeOtaController: AbortController | null = null;

const BLE_OPERATION_TIMEOUT_MS = 12_000;
const OTA_WRITE_TIMEOUT_MS = 15_000;
const OTA_ABORT_TIMEOUT_MS = 3_000;
const MIN_BLE_PAYLOAD_BYTES = 20;
const MAX_OTA_CHUNK_BYTES = 240;

// react-native-ble-plx does not expose a portable "link is encrypted" query or
// a bonding API. When a protected characteristic is accessed, Android/iOS may
// initiate pairing themselves; these are the native error values that tell us
// that the operation was rejected before any sensitive payload was accepted.
const BLE_SECURITY_ERROR_CODES = new Set([5, 8, 12, 15, 0x89, 0x8d, 0x8e]);

export class BleProvisioningSecurityError extends Error {
  readonly code = "BLE_PROVISIONING_SECURITY";

  constructor(message = bleProvisioningSecurityInstructions()) {
    super(message);
    this.name = "BleProvisioningSecurityError";
  }
}

export function isBleSecurityError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    attErrorCode?: unknown;
    iosErrorCode?: unknown;
    androidErrorCode?: unknown;
    message?: unknown;
    reason?: unknown;
    internalMessage?: unknown;
  };
  if ([candidate.attErrorCode, candidate.iosErrorCode, candidate.androidErrorCode]
    .some((value) => BLE_SECURITY_ERROR_CODES.has(Number(value)))) return true;
  const text = [candidate.message, candidate.reason, candidate.internalMessage]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return /not encrypted|insufficient (authentication|authorization|encryption)|authentication failed|bond(?:ing)? required|pair(?:ing)? required/.test(text);
}

export function bleProvisioningSecurityInstructions(): string {
  return Platform.OS === "ios"
    ? "BLE chưa được bảo mật. Hãy bật Bluetooth, đặt thiết bị gần iPhone và chấp nhận yêu cầu ghép đôi của iOS rồi thử lại. FarmOS không gửi Wi‑Fi khi kết nối chưa được bảo vệ."
    : "BLE chưa được bảo mật. Hãy bật Bluetooth, cấp quyền Nearby devices, ghép đôi thiết bị trong hộp thoại hệ thống rồi thử lại. FarmOS không gửi Wi‑Fi khi kết nối chưa được bảo vệ.";
}

function describeBleConnectionError(error: unknown, stage: string): Error {
  if (error instanceof BleProvisioningSecurityError) return error;
  const native = error as { iosErrorCode?: number; androidErrorCode?: number; attErrorCode?: number; errorCode?: number } | null;
  if (Platform.OS === "ios" && native?.iosErrorCode === 14) {
    return new BleProvisioningSecurityError(
      "Thông tin ghép đôi Bluetooth trên iPhone đã cũ. Vào Cài đặt → Bluetooth, quên thiết bị FarmOS rồi ghép lại trong ứng dụng. (iOS 14)",
    );
  }
  const iosCode = native?.iosErrorCode;
  const androidCode = native?.androidErrorCode;
  const code = iosCode != null ? `iOS ${iosCode}`
    : native?.attErrorCode != null ? `ATT ${native.attErrorCode}`
    : androidCode != null ? `Android ${androidCode}` : native?.errorCode;
  return new Error(`${stage}. ${code != null ? `Mã BLE: ${code}. ` : ""}Hãy đưa thiết bị về chế độ ghép đôi và thử lại.`);
}

function normalizeBleProvisioningError(error: unknown): Error {
  if (isBleSecurityError(error)) return new BleProvisioningSecurityError();
  return error instanceof Error ? error : new Error(String(error || "Lỗi BLE"));
}

// ble-plx deliberately does not expose a portable isEncrypted()/bond() API.
// Keep a per-connection proof after a read of the firmware's protected auth
// characteristic succeeds. The firmware marks that characteristic
// READ_ENC|READ_AUTHEN with a 16-byte minimum key, so a successful read is the
// only portable proof available to this React Native client. The proof is
// required by writeProvisioningCharacteristic below; callers cannot
// accidentally send Wi-Fi credentials on an unverified link.
const secureBleDevices = new WeakSet<object>();

export async function ensureSecureBleLink(
  device: Device,
  type: "GATEWAY" | "SENSOR_NODE",
): Promise<void> {
  const serviceUUID = type === "GATEWAY" ? GATEWAY_SERVICE_UUID : NODE_SERVICE_UUID;
  const authUUID = type === "GATEWAY" ? GATEWAY_AUTH_UUID : NODE_AUTH_UUID;
  try {
    const characteristics = await device.characteristicsForService(serviceUUID);
    const authCharacteristic = characteristics.find((characteristic) => characteristic.uuid.toLowerCase() === authUUID);
    if (!authCharacteristic?.isReadable) {
      throw new BleProvisioningSecurityError(
        `${bleProvisioningSecurityInstructions()} Thiết bị không cung cấp kênh xác thực BLE bảo mật; hãy cập nhật firmware trước khi cài đặt.`,
      );
    }
    // This read is intentionally a harmless preflight. It lets the OS start
    // authenticated LE Secure Connections and sends no claim or Wi-Fi data.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await device.readCharacteristicForService(serviceUUID, authUUID);
        break;
      } catch (error) {
        const attCode = (error as { attErrorCode?: number } | null)?.attErrorCode;
        // CoreBluetooth can return insufficient authentication or encryption
        // while the peripheral's security request is still being negotiated.
        // Keep the same connection open and retry only this payload-free read.
        const pairingInProgress = Platform.OS === "ios" && (attCode === 5 || attCode === 15);
        if (!pairingInProgress || attempt >= 10) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 750));
      }
    }
    secureBleDevices.add(device);
  } catch (error) {
    if (error instanceof BleProvisioningSecurityError) throw error;
    // A native rejection may arrive as ATT 5/12/15 or iOS 0x89/0x8d/0x8e.
    // Unknown failures are also fail-closed: without a successful protected
    // read there is no portable way for ble-plx to prove the link is secure.
    const diagnosis = describeBleConnectionError(error, "Không thể xác thực kết nối Bluetooth");
    if (diagnosis instanceof BleProvisioningSecurityError) throw diagnosis;
    if (isBleSecurityError(error)) {
      throw new BleProvisioningSecurityError(bleProvisioningSecurityInstructions());
    }
    throw new BleProvisioningSecurityError(diagnosis.message);
  }
}

function encodeBleText(text: string): string {
  // base-64 expects a byte string. Wi-Fi credentials and other JSON fields
  // can contain Unicode, which the firmware reads as UTF-8.
  const utf8 = encodeURIComponent(text).replace(/%([0-9A-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return encodeBase64(utf8);
}

async function writeProvisioningCharacteristic(
  device: Device,
  serviceUUID: string,
  characteristicUUID: string,
  json: string,
): Promise<void> {
  if (!secureBleDevices.has(device)) {
    throw new BleProvisioningSecurityError();
  }
  try {
    await device.writeCharacteristicWithResponseForService(serviceUUID, characteristicUUID, encodeBleText(json));
  } catch (error) {
    // Never turn a native encryption/authentication rejection into a generic
    // onboarding failure: the UI must tell the user to pair the device and
    // must not retry the sensitive write automatically.
    throw normalizeBleProvisioningError(error);
  }
}

function ble(): BleManager {
  manager ||= new BleManager();
  return manager;
}

export async function requestBlePermission(): Promise<void> {
  if (Platform.OS !== "android") return;
  if (Number(Platform.Version) >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    if (Object.values(result).some((value) => value !== PermissionsAndroid.RESULTS.GRANTED)) {
      throw new Error("FarmOS cần quyền Bluetooth để tìm thiết bị ở gần");
    }
  } else {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error("FarmOS cần quyền vị trí để quét BLE trên Android này");
  }
}

async function waitUntilPoweredOn(timeoutMs = 10_000): Promise<void> {
  const current = await ble().state();
  if (current === State.PoweredOn) return;
  if (current === State.Unauthorized) {
    throw new Error("FarmOS chưa được cấp quyền Bluetooth. Hãy cho phép Bluetooth trong Cài đặt.");
  }
  if (current === State.Unsupported) {
    throw new Error("Thiết bị này không hỗ trợ Bluetooth Low Energy.");
  }
  if (current === State.PoweredOff) {
    // Keep listening so a user who turns Bluetooth on while this flow is open
    // can continue without restarting the screen.
  }
  await new Promise<void>((resolve, reject) => {
    let subscription: Subscription | null = null;
    const timer = setTimeout(() => {
      subscription?.remove();
      reject(new Error("Bluetooth chưa được bật"));
    }, timeoutMs);
    subscription = ble().onStateChange((state) => {
      if (state === State.PoweredOn) {
        clearTimeout(timer);
        subscription?.remove();
        resolve();
      } else if (state === State.Unauthorized) {
        clearTimeout(timer);
        subscription?.remove();
        reject(new Error("FarmOS chưa được cấp quyền Bluetooth. Hãy cho phép Bluetooth trong Cài đặt."));
      } else if (state === State.Unsupported) {
        clearTimeout(timer);
        subscription?.remove();
        reject(new Error("Thiết bị này không hỗ trợ Bluetooth Low Energy."));
      }
    }, true);
  });
}

export type BleScanErrorHandler = (error: Error) => void;

export async function scanFarmDevices(
  type: "GATEWAY" | "SENSOR_NODE",
  onDevice: (device: NearbyFarmDevice) => void,
  durationMs = 12_000,
  onError?: BleScanErrorHandler,
): Promise<() => void> {
  await requestBlePermission();
  await waitUntilPoweredOn();
  const service = type === "GATEWAY" ? GATEWAY_SERVICE_UUID : NODE_SERVICE_UUID;
  const seen = new Set<string>();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    ble().stopDeviceScan().catch(() => undefined);
  };
  const reportError = (cause: unknown) => {
    stop();
    const error = cause instanceof Error ? cause : new Error(String(cause || "Không thể quét BLE"));
    onError?.(error);
  };
  ble().startDeviceScan([service], { allowDuplicates: true }, (error, device) => {
    if (error) {
      reportError(error);
      return;
    }
    if (!device) return;
    const first = !seen.has(device.id);
    seen.add(device.id);
    if (first || device.rssi !== null) {
      onDevice({ bleId: device.id, name: device.localName || device.name || device.id, type, rssi: device.rssi });
    }
  }).catch(reportError);
  const timer = setTimeout(stop, durationMs);
  return () => {
    clearTimeout(timer);
    stop();
  };
}

async function connectedDevice(bleId: string, secureType?: "GATEWAY" | "SENSOR_NODE"): Promise<Device> {
  let device: Device | null = null;
  let stage = "Không thể kết nối Bluetooth với thiết bị";
  try {
    device = await ble().connectToDevice(bleId, { timeout: BLE_OPERATION_TIMEOUT_MS });
    if (Platform.OS === "android") {
      // A rejected MTU request must not leak the connection. Falling back to
      // the library's reported MTU keeps iOS and older Android devices safe.
      device = await device.requestMTU(512).catch(() => device as Device);
    }
    stage = "Không thể đọc dịch vụ Bluetooth của thiết bị";
    device = await device.discoverAllServicesAndCharacteristics();
    if (secureType) await ensureSecureBleLink(device, secureType);
    return device;
  } catch (error) {
    await device?.cancelConnection().catch(() => undefined);
    throw describeBleConnectionError(error, stage);
  }
}

export async function readIdentity(nearby: NearbyFarmDevice): Promise<{ device: Device; identity: BleIdentity }> {
  let device: Device | null = null;
  try {
    device = await connectedDevice(nearby.bleId, nearby.type);
    const service = nearby.type === "GATEWAY" ? GATEWAY_SERVICE_UUID : NODE_SERVICE_UUID;
    const characteristic = nearby.type === "GATEWAY" ? GATEWAY_IDENTITY_UUID : NODE_IDENTITY_UUID;
    const value = await device.readCharacteristicForService(service, characteristic);
    if (!value.value) throw new Error("Thiết bị không trả về danh tính BLE");
    const identity = JSON.parse(decodeBase64(value.value)) as BleIdentity;
    if (!identity.id || identity.type !== nearby.type) throw new Error("Danh tính BLE không hợp lệ");
    return { device, identity };
  } catch (error) {
    await device?.cancelConnection().catch(() => undefined);
    throw error;
  }
}

/**
 * Compare the physical identity document with the signed QR before any
 * provisioning write. Serial and hardware revision are mandatory for v3;
 * matching only the BLE id would allow a swapped board to be claimed.
 */
export function assertBleIdentityMatchesQr(identity: BleIdentity, payload: QrV3Payload): void {
  if (identity.type !== payload.type || identity.id !== payload.deviceId) {
    throw new Error(`QR thuộc ${payload.deviceId}, nhưng BLE là ${identity.id || "thiết bị khác"}`);
  }
  if (identity.serialNumber !== payload.serial) {
    throw new Error(`Serial QR (${payload.serial}) không khớp BLE (${identity.serialNumber || "trống"})`);
  }
  if (identity.hardwareRevision !== payload.hardwareRevision) {
    throw new Error(`Hardware revision QR (${payload.hardwareRevision}) không khớp BLE (${identity.hardwareRevision || "trống"})`);
  }
  if (!identity.attestationPublicKey) {
    throw new Error("Thiết bị không công bố public key factory để attestation");
  }
}

export interface ExistingDeviceIdentityExpectation {
  deviceId: string;
  type: "GATEWAY" | "SENSOR_NODE";
  serialNumber: string;
  hardwareRevision: string;
}

export function assertBleIdentityMatchesExpected(identity: BleIdentity, expected: ExistingDeviceIdentityExpectation): void {
  if (identity.type !== expected.type || identity.id !== expected.deviceId) {
    throw new Error(`Đã chọn ${expected.deviceId}, nhưng BLE là ${identity.id || "thiết bị khác"}`);
  }
  if (identity.serialNumber !== expected.serialNumber) {
    throw new Error(`Serial server (${expected.serialNumber}) không khớp BLE (${identity.serialNumber || "trống"})`);
  }
  if (identity.hardwareRevision !== expected.hardwareRevision) {
    throw new Error(`Hardware revision server (${expected.hardwareRevision}) không khớp BLE (${identity.hardwareRevision || "trống"})`);
  }
  if (!identity.attestationPublicKey) throw new Error("Thiết bị không công bố public key factory để attestation");
}

export interface BleClaimAttestation {
  signature: string;
  sessionId: string;
  deviceId: string;
  nonce?: string;
  expiresAtMs?: number;
  publicKey?: string;
  certFingerprint?: string;
}

/**
 * Ask the factory firmware's auth characteristic to sign the claim
 * challenge, then return only the public attestation proof to the API layer.
 * The provisioning token and nonce are short-lived values returned by the
 * authenticated claim-session API; no QR setup secret is exposed to the UI.
 */
export async function attestClaimSession(
  nearby: NearbyFarmDevice,
  payload: QrV3Payload,
  session: Pick<QrClaimSession, "sessionId" | "challenge" | "provisioningToken" | "nonce" | "expiresAt">,
): Promise<BleClaimAttestation> {
  const { device, identity } = await readIdentity(nearby);
  try {
    assertBleIdentityMatchesQr(identity, payload);
    const expiresAt = Date.parse(session.expiresAt);
    const ttlMs = Math.min(300_000, expiresAt - Date.now());
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Claim challenge đã hết hạn, hãy quét lại QR");
    const service = nearby.type === "GATEWAY" ? GATEWAY_SERVICE_UUID : NODE_SERVICE_UUID;
    const characteristic = nearby.type === "GATEWAY" ? GATEWAY_AUTH_UUID : NODE_AUTH_UUID;
    if (!session.provisioningToken || !session.nonce) {
      throw new Error("Claim session thiếu attestation token/nonce; hãy cập nhật FarmOS server");
    }
    const nonce = session.nonce;
    const request = JSON.stringify({
      op: "CHALLENGE",
      deviceId: payload.deviceId,
      sessionId: session.sessionId,
      provisioningToken: session.provisioningToken,
      nonce,
      ttlMs,
    });
    await writeProvisioningCharacteristic(device, service, characteristic, request);
    const responseValue = await device.readCharacteristicForService(service, characteristic);
    if (!responseValue.value) throw new Error("Thiết bị không trả về chữ ký attestation");
    let response: Partial<BleClaimAttestation> & { status?: string };
    try {
      response = JSON.parse(decodeBase64(responseValue.value)) as Partial<BleClaimAttestation> & { status?: string };
    } catch {
      throw new Error("Phản hồi attestation BLE không đúng JSON");
    }
    if (response.status !== "CHALLENGE_ACCEPTED" || response.sessionId !== session.sessionId || response.deviceId !== payload.deviceId || response.nonce !== session.nonce || typeof response.signature !== "string" || !response.signature) {
      throw new Error("Thiết bị từ chối claim challenge");
    }
    return {
      signature: response.signature,
      sessionId: response.sessionId,
      deviceId: response.deviceId,
      nonce: response.nonce,
      expiresAtMs: response.expiresAtMs,
      publicKey: response.publicKey,
      certFingerprint: response.certFingerprint,
    };
  } finally {
    await device.cancelConnection().catch(() => undefined);
  }
}

/** Attest a mode transition against the stored identity, without a new QR. */
export async function attestExistingDeviceSession(
  nearby: NearbyFarmDevice,
  expected: ExistingDeviceIdentityExpectation,
  session: Pick<QrClaimSession, "sessionId" | "challenge" | "provisioningToken" | "nonce" | "expiresAt">,
): Promise<BleClaimAttestation> {
  const { device, identity } = await readIdentity(nearby);
  try {
    assertBleIdentityMatchesExpected(identity, expected);
    const expiresAt = Date.parse(session.expiresAt);
    const ttlMs = Math.min(300_000, expiresAt - Date.now());
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Mode session đã hết hạn, hãy thử lại");
    const service = nearby.type === "GATEWAY" ? GATEWAY_SERVICE_UUID : NODE_SERVICE_UUID;
    const characteristic = nearby.type === "GATEWAY" ? GATEWAY_AUTH_UUID : NODE_AUTH_UUID;
    if (!session.provisioningToken || !session.nonce) throw new Error("Mode session thiếu attestation token/nonce; hãy cập nhật FarmOS server");
    const request = JSON.stringify({
      op: "CHALLENGE",
      deviceId: expected.deviceId,
      sessionId: session.sessionId,
      provisioningToken: session.provisioningToken,
      nonce: session.nonce,
      ttlMs,
    });
    await writeProvisioningCharacteristic(device, service, characteristic, request);
    const responseValue = await device.readCharacteristicForService(service, characteristic);
    if (!responseValue.value) throw new Error("Thiết bị không trả về chữ ký attestation");
    let response: Partial<BleClaimAttestation> & { status?: string };
    try {
      response = JSON.parse(decodeBase64(responseValue.value)) as Partial<BleClaimAttestation> & { status?: string };
    } catch {
      throw new Error("Phản hồi attestation BLE không đúng JSON");
    }
    if (response.status !== "CHALLENGE_ACCEPTED" || response.sessionId !== session.sessionId || response.deviceId !== expected.deviceId || response.nonce !== session.nonce || typeof response.signature !== "string" || !response.signature) {
      throw new Error("Thiết bị từ chối mode challenge");
    }
    return { signature: response.signature, sessionId: response.sessionId, deviceId: response.deviceId, nonce: response.nonce, expiresAtMs: response.expiresAtMs, publicKey: response.publicKey, certFingerprint: response.certFingerprint };
  } finally {
    await device.cancelConnection().catch(() => undefined);
  }
}

export interface AttestedBleConfiguration {
  sessionId: string;
  provisioningToken: string;
  signature: string;
  nonce?: string;
}

function attestedConfig(input: AttestedBleConfiguration) {
  return {
    sessionId: input.sessionId,
    // This value is a short-lived claim-session token, not QR data.
    // Firmware uses it as the provisioning token when it redeems the config.
    provisioningToken: input.provisioningToken,
    ...(input.nonce ? { nonce: input.nonce } : {}),
    signature: input.signature,
  };
}

/** Write an attested cloud configuration only after the API claim is finalized. */
export async function provisionAttestedCloudDevice(
  nearby: NearbyFarmDevice,
  payload: QrV3Payload,
  input: AttestedBleConfiguration & {
    deploymentMode: "GATEWAY" | "STANDALONE_NODE";
    ssid: string;
    password: string;
    apiBaseUrl: string;
  },
): Promise<void> {
  const { device, identity } = await readIdentity(nearby);
  try {
    assertBleIdentityMatchesQr(identity, payload);
    const service = nearby.type === "GATEWAY" ? GATEWAY_SERVICE_UUID : NODE_SERVICE_UUID;
    const characteristic = nearby.type === "GATEWAY" ? GATEWAY_CONFIG_UUID : NODE_PAIRING_UUID;
    const value = JSON.stringify({
      version: 3,
      mode: input.deploymentMode,
      deploymentMode: input.deploymentMode,
      deviceId: payload.deviceId,
      // The gateway identity check is only meaningful for a gateway. A
      // standalone sensor must not receive a self-referential gatewayId:
      // production firmware validates that any supplied target is GATEWAY_*.
      ...(nearby.type === "GATEWAY" ? { gatewayId: payload.deviceId } : {}),
      ssid: input.ssid,
      password: input.password,
      apiBaseUrl: input.apiBaseUrl,
      ...attestedConfig(input),
    });
    await writeProvisioningCharacteristic(device, service, characteristic, value);
  } finally {
    await device.cancelConnection().catch(() => undefined);
  }
}

/** Write a cloud mode transition after attestation, preserving the board key. */
export async function provisionAttestedExistingDevice(
  nearby: NearbyFarmDevice,
  expected: ExistingDeviceIdentityExpectation,
  input: AttestedBleConfiguration & {
    deploymentMode: "GATEWAY" | "STANDALONE_NODE";
    ssid: string;
    password: string;
    apiBaseUrl: string;
  },
): Promise<void> {
  const { device, identity } = await readIdentity(nearby);
  try {
    assertBleIdentityMatchesExpected(identity, expected);
    const service = nearby.type === "GATEWAY" ? GATEWAY_SERVICE_UUID : NODE_SERVICE_UUID;
    const characteristic = nearby.type === "GATEWAY" ? GATEWAY_CONFIG_UUID : NODE_PAIRING_UUID;
    const value = JSON.stringify({
      version: 3,
      mode: input.deploymentMode,
      deploymentMode: input.deploymentMode,
      deviceId: expected.deviceId,
      ...(nearby.type === "GATEWAY" ? { gatewayId: expected.deviceId } : {}),
      ssid: input.ssid,
      password: input.password,
      apiBaseUrl: input.apiBaseUrl,
      ...attestedConfig(input),
    });
    await writeProvisioningCharacteristic(device, service, characteristic, value);
  } finally {
    await device.cancelConnection().catch(() => undefined);
  }
}

/**
 * Put a leaf node into its attested pairing state. The gateway radio grant is
 * still completed by the existing pairing service; this write is intentionally
 * kept separate from the v2 possession-code path.
 */
export async function configureAttestedNode(
  nearby: NearbyFarmDevice,
  payload: QrV3Payload,
  input: AttestedBleConfiguration & { gatewayId: string; pairingId: string; radioToken: string; expiresAt: string },
): Promise<void> {
  const { device, identity } = await readIdentity(nearby);
  try {
    assertBleIdentityMatchesQr(identity, payload);
    const ttlMs = Math.min(300_000, Date.parse(input.expiresAt) - Date.now());
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Claim session đã hết hạn, hãy thử lại");
    const value = JSON.stringify({
      version: 3,
      mode: "LEAF_NODE",
      deploymentMode: "LEAF_NODE",
      nodeId: payload.deviceId,
      gatewayId: input.gatewayId,
      pairingId: input.pairingId,
      radioToken: input.radioToken,
      ttlMs,
      ...attestedConfig(input),
    });
    await writeProvisioningCharacteristic(device, NODE_SERVICE_UUID, NODE_PAIRING_UUID, value);
  } finally {
    await device.cancelConnection().catch(() => undefined);
  }
}

/** Write a LoRa mode transition using the current board identity, no QR. */
export async function configureAttestedExistingNode(
  nearby: NearbyFarmDevice,
  expected: ExistingDeviceIdentityExpectation,
  input: AttestedBleConfiguration & { gatewayId: string; pairingId: string; radioToken: string; expiresAt: string },
): Promise<void> {
  const { device, identity } = await readIdentity(nearby);
  try {
    assertBleIdentityMatchesExpected(identity, expected);
    const ttlMs = Math.min(300_000, Date.parse(input.expiresAt) - Date.now());
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Mode session đã hết hạn, hãy thử lại");
    const value = JSON.stringify({
      version: 3,
      mode: "LEAF_NODE",
      deploymentMode: "LEAF_NODE",
      nodeId: expected.deviceId,
      gatewayId: input.gatewayId,
      pairingId: input.pairingId,
      radioToken: input.radioToken,
      ttlMs,
      ...attestedConfig(input),
    });
    await writeProvisioningCharacteristic(device, NODE_SERVICE_UUID, NODE_PAIRING_UUID, value);
  } finally {
    await device.cancelConnection().catch(() => undefined);
  }
}

export async function provisionGateway(
  nearby: NearbyFarmDevice,
  expectedGatewayId: string,
  input: { ssid: string; password: string; apiBaseUrl: string; sessionId: string; provisioningToken: string },
): Promise<void> {
  const { device, identity } = await readIdentity(nearby);
  try {
    if (identity.id !== expectedGatewayId) {
      throw new Error(`QR thuộc ${expectedGatewayId}, nhưng BLE là ${identity.id}`);
    }
    const payload = JSON.stringify({ version: 1, gatewayId: identity.id, ...input });
    await writeProvisioningCharacteristic(device, GATEWAY_SERVICE_UUID, GATEWAY_CONFIG_UUID, payload);
  } finally {
    await device.cancelConnection().catch(() => undefined);
  }
}

export async function provisionCloudDevice(
  nearby: NearbyFarmDevice,
  expectedDeviceId: string,
  input: {
    deploymentMode: "GATEWAY" | "STANDALONE_NODE";
    ssid: string;
    password: string;
    apiBaseUrl: string;
    sessionId: string;
    provisioningToken: string;
  },
): Promise<void> {
  const { device, identity } = await readIdentity(nearby);
  try {
    if (identity.id !== expectedDeviceId) {
      throw new Error(`QR thuộc ${expectedDeviceId}, nhưng BLE là ${identity.id}`);
    }
    const service = nearby.type === "GATEWAY" ? GATEWAY_SERVICE_UUID : NODE_SERVICE_UUID;
    const characteristic = nearby.type === "GATEWAY" ? GATEWAY_CONFIG_UUID : NODE_PAIRING_UUID;
    const payload = JSON.stringify({
      version: 2,
      mode: input.deploymentMode,
      deviceId: identity.id,
      gatewayId: identity.id,
      ...input,
    });
    await writeProvisioningCharacteristic(device, service, characteristic, payload);
  } finally {
    await device.cancelConnection().catch(() => undefined);
  }
}

export async function configureNodePairing(
  nearby: NearbyFarmDevice,
  expectedNodeId: string,
  input: { pairingId: string; gatewayId: string; radioToken: string; expiresAt: string },
): Promise<BleIdentity> {
  const { device, identity } = await readIdentity(nearby);
  try {
    if (identity.id !== expectedNodeId) {
      throw new Error(`Bạn đã chọn ${expectedNodeId}, nhưng BLE trả về ${identity.id}`);
    }
    const ttlMs = Math.min(300_000, Date.parse(input.expiresAt) - Date.now());
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Phiên ghép đã hết hạn, hãy thử lại.");
    }
    const payload = JSON.stringify({ version: 1, nodeId: identity.id, ...input, ttlMs });
    await writeProvisioningCharacteristic(device, NODE_SERVICE_UUID, NODE_PAIRING_UUID, payload);
    return identity;
  } finally {
    await device.cancelConnection().catch(() => undefined);
  }
}

export interface NodeOtaStatus {
  state: "IDLE" | "RECEIVING" | "VERIFYING" | "SUCCESS" | "ERROR";
  progress: number;
  written: number;
  total: number;
  version: string;
  healthConfirmed: boolean;
  error: string;
}

export interface NodeOtaFlashOptions {
  signal?: AbortSignal;
}

/**
 * BLE ATT reserves three bytes for the ATT header. react-native-ble-plx
 * exposes the negotiated MTU on Device; its Base64 value is decoded by the
 * native layer before the write, so chunk sizing must use binary bytes.
 */
export function calculateOtaChunkSize(mtu: number | null | undefined): number {
  const numericMtu = Number(mtu);
  const payload = Number.isFinite(numericMtu) && numericMtu > 3
    ? Math.floor(numericMtu - 3)
    : MIN_BLE_PAYLOAD_BYTES;
  return Math.min(MAX_OTA_CHUNK_BYTES, Math.max(MIN_BLE_PAYLOAD_BYTES, payload));
}

function nextOtaTransactionId(prefix: string): string {
  otaTransactionSequence += 1;
  return `farmos-ota-${prefix}-${Date.now()}-${otaTransactionSequence}`;
}

async function writeWithTimeout(
  device: Device,
  valueBase64: string,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const transactionId = nextOtaTransactionId(label);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
      device
        .writeCharacteristicWithResponseForService(NODE_SERVICE_UUID, NODE_OTA_UUID, valueBase64, transactionId)
        .then(() => resolve())
        .catch(reject);
    });
  } catch (error) {
    await ble().cancelTransaction(transactionId).catch(() => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readOtaStatusWithTimeout(device: Device): Promise<NodeOtaStatus> {
  const transactionId = nextOtaTransactionId("status");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{ value: string | null }>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Đọc trạng thái OTA timeout")), BLE_OPERATION_TIMEOUT_MS);
      device
        .readCharacteristicForService(NODE_SERVICE_UUID, NODE_OTA_UUID, transactionId)
        .then(resolve)
        .catch(reject);
    });
    if (!result.value) throw new Error("Node không trả về kết quả xác minh firmware");
    return JSON.parse(decodeBase64(result.value)) as NodeOtaStatus;
  } catch (error) {
    await ble().cancelTransaction(transactionId).catch(() => undefined);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function sendOtaAbort(device: Device): Promise<void> {
  try {
    await writeWithTimeout(device, encodeBase64(JSON.stringify({ cmd: "ABORT" })), OTA_ABORT_TIMEOUT_MS, "OTA ABORT");
  } catch {
    // ABORT is best effort. The Node-side session timeout is the final safety net
    // when the BLE link is already unavailable.
  }
}

function throwIfOtaCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("OTA đã bị hủy");
}

/** Cancel the currently active OTA operation, if one exists. */
export function cancelNodeOtaFirmware(): void {
  activeOtaController?.abort();
}

export async function readNodeOtaStatus(nearby: NearbyFarmDevice): Promise<NodeOtaStatus> {
  const device = await connectedDevice(nearby.bleId, "SENSOR_NODE");
  try {
    return await readOtaStatusWithTimeout(device);
  } finally {
    await device.cancelConnection().catch(() => undefined);
  }
}

export async function flashNodeOtaFirmware(
  nearby: NearbyFarmDevice,
  binaryBytes: Uint8Array,
  targetVersion: string,
  expectedSha256: string,
  onProgress?: (percent: number, written: number, total: number) => void,
  options: NodeOtaFlashOptions = {},
): Promise<void> {
  const device = await connectedDevice(nearby.bleId, "SENSOR_NODE");
  const controller = new AbortController();
  const externalSignal = options.signal;
  const forwardAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  externalSignal?.addEventListener("abort", forwardAbort, { once: true });
  activeOtaController = controller;
  let completed = false;
  try {
    const totalBytes = binaryBytes.byteLength;
    if (totalBytes === 0) throw new Error("Firmware OTA không được rỗng");
    throwIfOtaCancelled(controller.signal);

    // 1. Send START command
    const startCmd = JSON.stringify({
      cmd: "START",
      size: totalBytes,
      version: targetVersion,
      sha256: expectedSha256,
    });
    await writeWithTimeout(device, encodeBase64(startCmd), OTA_WRITE_TIMEOUT_MS, "OTA START");

    await new Promise<void>((resolve) => setTimeout(() => resolve(), 200));
    throwIfOtaCancelled(controller.signal);

    // 2. Stream binary chunks according to the negotiated MTU. The Base64
    // string is decoded by react-native-ble-plx before CoreBluetooth/NimBLE.
    const chunkSize = calculateOtaChunkSize(device.mtu);
    let offset = 0;
    while (offset < totalBytes) {
      throwIfOtaCancelled(controller.signal);
      const slice = binaryBytes.subarray(offset, Math.min(offset + chunkSize, totalBytes));
      let binaryStr = "";
      for (let i = 0; i < slice.length; i++) {
        binaryStr += String.fromCharCode(slice[i]);
      }
      const chunkB64 = encodeBase64(binaryStr);

      await writeWithTimeout(device, chunkB64, OTA_WRITE_TIMEOUT_MS, "OTA chunk");

      offset += slice.length;
      if (onProgress) {
        const percent = Math.min(100, Math.round((offset * 100) / totalBytes));
        onProgress(percent, offset, totalBytes);
      }
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 15));
    }

    await new Promise<void>((resolve) => setTimeout(() => resolve(), 300));
    throwIfOtaCancelled(controller.signal);

    // 3. Send FINISH command
    const finishCmd = JSON.stringify({ cmd: "FINISH" });
    await writeWithTimeout(device, encodeBase64(finishCmd), OTA_WRITE_TIMEOUT_MS, "OTA FINISH");

    const status = await readOtaStatusWithTimeout(device);
    if (status.state !== "SUCCESS") {
      throw new Error(status.error || `Node kết thúc OTA ở trạng thái ${status.state}`);
    }

    if (onProgress) {
      onProgress(100, totalBytes, totalBytes);
    }
    completed = true;
  } catch (error) {
    if (!completed) await sendOtaAbort(device);
    throw error;
  } finally {
    externalSignal?.removeEventListener("abort", forwardAbort);
    if (activeOtaController === controller) activeOtaController = null;
    await device.cancelConnection().catch(() => undefined);
  }
}

export async function waitForNodeFirmware(
  nearby: NearbyFarmDevice,
  expectedVersion: string,
  attempts = 20,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 2500 : 1500));
    try {
      const { device, identity } = await readIdentity(nearby);
      await device.cancelConnection().catch(() => undefined);
      const actual = String(identity.firmwareVersion || "").replace(/^v/i, "");
      if (actual === expectedVersion.replace(/^v/i, "")) {
        const otaStatus = await readNodeOtaStatus(nearby);
        if (otaStatus.healthConfirmed) return;
        lastError = new Error("Firmware mới đang chờ cảm biến và đường truyền xác nhận sức khỏe");
        continue;
      }
      lastError = new Error(`Node khởi động với firmware ${actual || "không xác định"}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Không xác nhận được firmware sau khi Node khởi động lại");
}

export function shutdownBle() {
  manager?.stopDeviceScan();
  manager?.destroy();
  manager = null;
}
