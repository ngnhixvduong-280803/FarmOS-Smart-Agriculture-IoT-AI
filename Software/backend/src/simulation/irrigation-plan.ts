import type { Reading } from './moisture-model';

export interface WeatherHour { endAt: number; rain: number; et0: number }
export interface GardenWeather { fetchedAt: number; hours: WeatherHour[] }
const sites: Record<string, [number, number]> = {
  SIM_AGENT_A: [10.78, 106.69],
  SIM_AGENT_B: [11.94, 108.44],
  SIM_AGENT_C: [10.36, 107.08],
};
const cache = new Map<string, GardenWeather>();

export async function getGardenWeather(farmId: string, location?: { latitude: number | null; longitude: number | null }): Promise<GardenWeather | undefined> {
  const site = location?.latitude != null && location.longitude != null &&
    Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90 &&
    Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180
    ? [location.latitude, location.longitude] : sites[farmId];
  if (!site) return undefined;
  const cacheKey = `${farmId}:${site[0]}:${site[1]}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && now - cached.fetchedAt < 10 * 60_000) return cached;
  try {
    const params = new URLSearchParams({
      latitude: String(site[0]), longitude: String(site[1]),
      timezone: 'GMT', timeformat: 'unixtime', forecast_days: '4',
      hourly: 'precipitation,et0_fao_evapotranspiration',
    });
    const response = await fetch('https://api.open-meteo.com/v1/forecast?' + params, {
      signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    if (!response.ok) return undefined;
    const { hourly } = await response.json();
    // Use complete future hours. The provider timestamps the end of each accumulation.
    const start = Math.ceil(now / 3600_000) * 3600_000;
    const hours: WeatherHour[] = hourly.time.map((unix: number, i: number) => ({
      endAt: unix * 1000, rain: hourly.precipitation[i], et0: hourly.et0_fao_evapotranspiration[i],
    })).filter((entry: WeatherHour) => entry.endAt > start).slice(0, 48);
    if (hours.length !== 48 || hours.some((entry, i) => entry.endAt !== start + (i + 1) * 3600_000 ||
      !Number.isFinite(entry.rain) || !Number.isFinite(entry.et0) || entry.rain < 0 || entry.et0 < 0)) return undefined;
    const forecast = { fetchedAt: now, hours };
    cache.set(cacheKey, forecast);
    return forecast;
  } catch { return undefined; }
}

const soilProfiles: Record<string, { fc: number; wp: number; saturation: number; drainage: number }> = {
  silt: { fc: 32, wp: 15, saturation: 46, drainage: 15 },
  'loamy-sand': { fc: 15, wp: 6, saturation: 38, drainage: 35 },
  'silty-clay': { fc: 35, wp: 23, saturation: 50, drainage: 5 },
};
const plantProfiles: Record<string, { depth: number; p: number; days: number[]; kc: number[] }> = {
  'mustard-greens': { depth: 300, p: 0.3, days: [10, 25, 40], kc: [0.7, 1.05, 1.05, 0.95] },
  chilli: { depth: 300, p: 0.3, days: [20, 50, 90], kc: [0.425, 0.54, 0.925, 0.625] },
  tomato: { depth: 800, p: 0.4, days: [30, 70, 110], kc: [0.6, 0.88, 1.15, 0.8] },
};

export function compareIrrigation(
  soilId: string, cropId: string, age: number, history: Reading[], forecast: GardenWeather,
) {
  const soil = soilProfiles[soilId], crop = plantProfiles[cropId], latest = history.at(-1);
  if (!soil || !crop || !latest || forecast.hours.length !== 24) return undefined;
  const stage = crop.days.filter(day => age >= day).length;
  const kc = crop.kc[stage];
  const depth = crop.depth;
  const threshold = soil.fc - crop.p * (soil.fc - soil.wp);
  const wet = soil.fc + 2;
  const gross = Math.min(12, Math.max(4, Math.ceil((threshold + 1 - latest.moisture) * depth / 90)));
  const rainMm = forecast.hours.reduce((sum, hour) => sum + hour.rain, 0);

  function simulate(delay: number | null, withRain: boolean) {
    let water = latest!.moisture * depth / 100;
    let dryHours = 0, wetHours = 0;
    const trajectory = forecast.hours.map((hour, index) => {
      water = Math.min(soil.saturation * depth / 100, water + (withRain ? hour.rain : 0) +
        (delay === index ? gross * 0.9 : 0));
      water = Math.max(0, water - hour.et0 * kc - Math.min(soil.drainage / 24, Math.max(0, water - soil.fc * depth / 100)));
      const vwc = water * 100 / depth;
      if (vwc < threshold) dryHours++;
      if (vwc > wet) wetHours++;
      return Math.round(vwc * 100) / 100;
    });
    const mm = delay === null ? 0 : gross;
    return { delay, mm, dryHours, wetHours, trajectory, score: dryHours + 2 * wetHours + mm / 8 };
  }

  const options = [null, 0, 6, 12].map(delay => simulate(delay, true)).sort((a, b) => a.score - b.score);
  const selected = options[0];
  const dryWithoutRain = simulate(null, false).dryHours;
  const rainHelped = selected.delay === null && selected.dryHours < dryWithoutRain;
  const unresolved = options.every(option => option.dryHours === 24 || option.wetHours === 24);
  const reason = unresolved
    ? 'Cảnh báo: các lịch thử chưa khắc phục được tình trạng độ ẩm. Kiểm tra cảm biến, khả năng cấp thoát nước và ngưỡng cây trước khi lập lịch.'
    : selected.delay === null
    ? rainHelped
      ? `Hoãn tưới: dự báo ${rainMm.toFixed(1)} mm mưa làm giảm số giờ thiếu ẩm từ ${dryWithoutRain} xuống ${selected.dryHours} trong phương án chờ.`
      : 'Theo dõi, chưa tưới: phương án chờ có điểm thấp nhất khi xét số giờ khô, ẩm cao và lượng nước.'
    : `Xem xét tưới mô phỏng ${selected.mm} mm tại mốc +${selected.delay} giờ: phương án này có điểm thấp nhất sau khi tính mưa, ET₀ và nguy cơ ẩm cao.`;
  return { options, unresolved, reason, rainMm, startsAt: forecast.hours[0].endAt - 3600_000, fetchedAt: forecast.fetchedAt };
}
