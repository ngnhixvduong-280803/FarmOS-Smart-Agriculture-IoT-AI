import { PermissionsAndroid, Platform } from "react-native";
import Geolocation from "react-native-geolocation-service";

export type WeatherSnapshot = { temperature: number; code: number };
let cachedWeather: WeatherSnapshot | null = null;
let cachedAt = 0;

async function requestLocationPermission() {
  if (Platform.OS !== "android") return true;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION, {
    title: "Vị trí cho thời tiết", message: "FarmOS dùng vị trí hiện tại để hiển thị thời tiết tại nơi bạn đang mở ứng dụng.", buttonPositive: "Cho phép", buttonNegative: "Không cho phép",
  });
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

function currentPosition() {
  return new Promise<{ latitude: number; longitude: number }>((resolve, reject) => {
    Geolocation.getCurrentPosition(
      (position) => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude }),
      reject,
      { enableHighAccuracy: false, timeout: 12_000, maximumAge: 10 * 60_000 },
    );
  });
}

export async function getCurrentWeather(): Promise<WeatherSnapshot> {
  if (cachedWeather && Date.now() - cachedAt < 10 * 60_000) return cachedWeather;
  if (!(await requestLocationPermission())) throw new Error("LOCATION_DENIED");
  if (Platform.OS === "ios") await Geolocation.requestAuthorization("whenInUse");
  const { latitude, longitude } = await currentPosition();
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,weather_code&timezone=auto`);
  if (!response.ok) throw new Error("WEATHER_UNAVAILABLE");
  const body = await response.json() as { current?: { temperature_2m?: number; weather_code?: number } };
  if (typeof body.current?.temperature_2m !== "number" || typeof body.current.weather_code !== "number") throw new Error("WEATHER_UNAVAILABLE");
  cachedWeather = { temperature: Math.round(body.current.temperature_2m), code: body.current.weather_code };
  cachedAt = Date.now();
  return cachedWeather;
}

export function weatherIcon(code: number): "sun" | "cloud" | "cloudRain" {
  if (code <= 1) return "sun";
  if (code >= 51) return "cloudRain";
  return "cloud";
}
