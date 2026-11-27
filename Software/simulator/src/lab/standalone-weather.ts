export interface WeatherSite { latitude: number; longitude: number }
export interface ForecastHour { endAt: number; rainMm: number; rainProbability: number; et0Mm: number }
export type NodeWeather =
  | { status: 'unconfigured' | 'unavailable' }
  | { status: 'ready'; source: 'Open-Meteo'; fetchedAt: number; hours: ForecastHour[] };

const HOUR = 3600_000;

export function validateWeatherSite(value: unknown): WeatherSite {
  const site = value as WeatherSite | undefined;
  if (!site || !Number.isFinite(site.latitude) || Math.abs(site.latitude) > 90 ||
      !Number.isFinite(site.longitude) || Math.abs(site.longitude) > 180) {
    throw new Error('Vĩ độ phải từ −90 đến 90 và kinh độ từ −180 đến 180.');
  }
  return { latitude: site.latitude, longitude: site.longitude };
}

export function parseWeatherForecast(value: unknown, now: number, horizon = 24): ForecastHour[] {
  const hourly = (value as { hourly?: Record<string, unknown[]> } | null)?.hourly;
  const fields = ['time', 'precipitation', 'precipitation_probability', 'et0_fao_evapotranspiration'];
  if (!hourly || fields.some(key => !Array.isArray(hourly[key]))) throw new Error('Dự báo thiếu trường.');
  const start = Math.ceil(now / HOUR) * HOUR;
  const window: ForecastHour[] = [];

  for (let i = 0; i < hourly.time.length && window.length < horizon; i++) {
    const unix = hourly.time[i];
    if (typeof unix !== 'number' || unix * 1000 <= start) continue;
    const rainMm = hourly.precipitation[i];
    const rainProbability = hourly.precipitation_probability[i];
    const et0Mm = hourly.et0_fao_evapotranspiration[i];
    const endAt = unix * 1000;
    if (endAt !== start + (window.length + 1) * HOUR ||
        typeof rainMm !== 'number' || !Number.isFinite(rainMm) || rainMm < 0 ||
        typeof rainProbability !== 'number' || !Number.isFinite(rainProbability) || rainProbability < 0 || rainProbability > 100 ||
        typeof et0Mm !== 'number' || !Number.isFinite(et0Mm) || et0Mm < 0) throw new Error('Dự báo không hợp lệ.');
    window.push({ endAt, rainMm, rainProbability, et0Mm });
  }
  if (window.length !== horizon) throw new Error('Dự báo thiếu giờ.');
  return window;
}

export class StandaloneWeather {
  private cached?: { key: string; until: number; result: NodeWeather };
  private pending = new Map<string, Promise<NodeWeather>>();

  constructor(private request: typeof fetch = fetch) {}

  async read(site?: WeatherSite): Promise<NodeWeather> {
    if (!site) return { status: 'unconfigured' };
    const key = `${site.latitude},${site.longitude}`;
    const current = this.cached;
    if (current?.key === key && Date.now() < current.until) return current.result;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const operation = this.fetchForecast(site).then(result => {
      this.cached = { key, result, until: Date.now() + (result.status === 'ready' ? 600_000 : 60_000) };
      return result;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async fetchForecast(site: WeatherSite): Promise<NodeWeather> {
    const params = new URLSearchParams({
      latitude: String(site.latitude), longitude: String(site.longitude), timezone: 'GMT',
      timeformat: 'unixtime', forecast_days: '9',
      hourly: 'precipitation,precipitation_probability,et0_fao_evapotranspiration',
    });
    try {
      const response = await this.request('https://api.open-meteo.com/v1/forecast?' + params, {
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) return { status: 'unavailable' };
      const data = await response.json();
      const fetchedAt = Date.now();
      return { status: 'ready', source: 'Open-Meteo', fetchedAt, hours: parseWeatherForecast(data, fetchedAt, 168) };
    } catch {
      return { status: 'unavailable' };
    }
  }
}
