import { Linking, Platform } from "react-native";

export const ANDROID_LOCATION_SOURCE_SETTINGS = "android.settings.LOCATION_SOURCE_SETTINGS";

interface BleErrorLike {
  errorCode?: string | number;
  message?: string;
}

export function isBluetoothPermissionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as BleErrorLike;
  return candidate.errorCode === 102
    || candidate.errorCode === "BluetoothUnauthorized"
    || /bluetooth.*(permission|unauthori[sz]ed|not authorized)|quyền bluetooth|chưa được cấp quyền bluetooth/i.test(candidate.message || "");
}

export function isLocationServicesDisabledError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as BleErrorLike;
  // react-native-ble-plx exposes BleErrorCode.LocationServicesDisabled as 601
  // in the current release; keep the symbolic form for adapters that forward
  // enum names instead of numeric codes.
  return candidate.errorCode === 601
    || candidate.errorCode === "LocationServicesDisabled"
    || /location services are disabled|location service.*disabled|gps.*disabled/i.test(candidate.message || "");
}

export function requiresAndroidLocationService(): boolean {
  return Platform.OS === "android" && Number(Platform.Version) <= 30;
}

export async function openAndroidLocationSettings(): Promise<void> {
  if (Platform.OS !== "android") {
    await Linking.openSettings().catch(() => undefined);
    return;
  }
  await Linking.sendIntent(ANDROID_LOCATION_SOURCE_SETTINGS).catch(async () => {
    await Linking.openSettings().catch(() => undefined);
  });
}

export async function openAppSettings(): Promise<void> {
  await Linking.openSettings().catch(() => undefined);
}
