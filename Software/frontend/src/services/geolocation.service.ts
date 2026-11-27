/**
 * FarmOS Geolocation Service
 * Provides robust GPS / browser location retrieval with automatic fallback:
 * 1. Attempts high-accuracy GPS positioning with reasonable timeout and cache window.
 * 2. If high-accuracy times out or fails (common on laptops/desktops without GPS hardware,
 *    or indoors where satellite reception is poor), automatically falls back to low-accuracy
 *    network/Wi-Fi positioning (enableHighAccuracy: false).
 * 3. Translates browser error codes into friendly Vietnamese instructions.
 */

export interface GpsLocationResult {
  latitude: number;
  longitude: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  altitude: number | null;
  altitudeAccuracy: number | null;
  isFallbackLowAccuracy: boolean;
}

export interface GpsLocationError {
  code: number; // 1: PERMISSION_DENIED, 2: POSITION_UNAVAILABLE, 3: TIMEOUT, -1: NOT_SUPPORTED
  message: string;
  originalError?: GeolocationPositionError;
}

export interface GetLocationOptions {
  highAccuracyTimeout?: number;
  lowAccuracyTimeout?: number;
  maximumAge?: number;
  allowFallback?: boolean;
}

/**
 * Maps browser GeolocationPositionError codes to clear, actionable Vietnamese messages.
 */
export function getFriendlyGpsErrorMessage(err: { code: number; message?: string }): string {
  switch (err.code) {
    case 1: // PERMISSION_DENIED
      return "Bạn đã từ chối quyền vị trí. Vui lòng cho phép quyền vị trí trong cài đặt trình duyệt để xem vị trí trên bản đồ.";
    case 2: // POSITION_UNAVAILABLE
      return "Không thể xác định vị trí GPS. Vui lòng kiểm tra dịch vụ định vị (Location Services) trên máy hoặc kết nối mạng.";
    case 3: // TIMEOUT
      return "Hết thời gian chờ GPS. Vui lòng kiểm tra quyền Vị trí (Location Services) trong Cài đặt hệ thống (System Settings) hoặc thử lại nơi thoáng hơn.";
    case -1:
      return "Trình duyệt của bạn không hỗ trợ định vị GPS.";
    default:
      return err.message
        ? `Không thể lấy vị trí GPS: ${err.message}`
        : "Không thể lấy vị trí GPS từ thiết bị.";
  }
}

/**
 * Retrieves the device's current location with automatic fallback from high to low accuracy.
 */
export function getCurrentPositionWithFallback(
  options: GetLocationOptions = {}
): Promise<GpsLocationResult> {
  const {
    highAccuracyTimeout = 7000,
    lowAccuracyTimeout = 12000,
    maximumAge = 30000,
    allowFallback = true,
  } = options;

  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      return reject({
        code: -1,
        message: getFriendlyGpsErrorMessage({ code: -1 }),
      });
    }

    // Step 1: Attempt high accuracy
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          heading: pos.coords.heading,
          speed: pos.coords.speed,
          altitude: pos.coords.altitude,
          altitudeAccuracy: pos.coords.altitudeAccuracy,
          isFallbackLowAccuracy: false,
        });
      },
      (firstErr) => {
        // If user explicitly denied permission (code 1), do not retry
        if (firstErr.code === 1 || !allowFallback) {
          return reject({
            code: firstErr.code,
            message: getFriendlyGpsErrorMessage(firstErr),
            originalError: firstErr,
          });
        }

        // Step 2: Fallback to low accuracy (Wi-Fi / IP / cellular cache)
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            resolve({
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
              heading: pos.coords.heading,
              speed: pos.coords.speed,
              altitude: pos.coords.altitude,
              altitudeAccuracy: pos.coords.altitudeAccuracy,
              isFallbackLowAccuracy: true,
            });
          },
          (secondErr) => {
            reject({
              code: secondErr.code,
              message: getFriendlyGpsErrorMessage(secondErr),
              originalError: secondErr,
            });
          },
          {
            enableHighAccuracy: false,
            timeout: lowAccuracyTimeout,
            maximumAge: Math.max(maximumAge, 60000),
          }
        );
      },
      {
        enableHighAccuracy: true,
        timeout: highAccuracyTimeout,
        maximumAge: maximumAge,
      }
    );
  });
}
