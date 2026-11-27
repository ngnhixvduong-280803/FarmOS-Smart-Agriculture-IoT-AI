import { crops, soils, type LabConfig } from './catalog.js';
import { LabEngine } from './engine.js';
import { LabAdvisor } from './advisor.js';

interface WeatherHour { time: string; rain: number; et0: number }
const locations = {
  SIM_VUON_A: { latitude: 10.78, longitude: 106.69 },
  SIM_VUON_B: { latitude: 11.94, longitude: 108.44 },
} as const;

type GardenId = keyof typeof locations;
const weatherCache = new Map<GardenId, { fetchedAt: number; hours: WeatherHour[] }>();

async function weather(garden: GardenId, fallbackEt0: number) {
  const cached = weatherCache.get(garden);
  if (cached && Date.now() - cached.fetchedAt < 600_000) return { ...cached, source: 'Open-Meteo' };
  try {
    const { latitude, longitude } = locations[garden];
    const params = new URLSearchParams({
      latitude: String(latitude), longitude: String(longitude), timezone: 'GMT',
      hourly: 'precipitation,et0_fao_evapotranspiration', forecast_days: '3',
    });
    const response = await fetch('https://api.open-meteo.com/v1/forecast?' + params, {
      signal: AbortSignal.timeout(8000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Weather request failed');
    const { hourly } = await response.json();
    const hours: WeatherHour[] = hourly.time.map((time: string, index: number) => ({
      time: time + 'Z', rain: hourly.precipitation[index], et0: hourly.et0_fao_evapotranspiration[index],
    })).filter((entry: WeatherHour) => Date.parse(entry.time) >= Date.now() &&
      Number.isFinite(entry.rain) && Number.isFinite(entry.et0) && entry.rain >= 0 && entry.et0 >= 0).slice(0, 24);
    if (hours.length !== 24 || hours.some((entry, index) => index > 0 &&
        Date.parse(entry.time) - Date.parse(hours[index - 1].time) !== 3600000)) throw new Error('Incomplete forecast');
    const result = { fetchedAt: Date.now(), hours };
    weatherCache.set(garden, result);
    return { ...result, source: 'Open-Meteo' };
  } catch {
    return { fetchedAt: null, source: 'Kịch bản dự phòng: không mưa', hours: Array.from({ length: 24 }, (_, i) =>
      ({ time: new Date((Math.floor(Date.now() / 3600000) + i + 1) * 3600000).toISOString(), rain: 0, et0: fallbackEt0 / 24 })) };
  }
}

export async function planHistory(config: LabConfig) {
  const engine = new LabEngine(config, 'planner-history');
  const advisor = new LabAdvisor();
  const samples = new Map<string, { hour: number; moisture: number }[]>();
  for (let step = 1; step <= 1440; step++) {
    for (const { groundTruth, ...sample } of engine.step()) {
      const id = sample.observations.nodeId;
      const observation = groundTruth.nodeOnline && groundTruth.gatewayOnline ? sample : undefined;
      const result = advisor.evaluate(id, observation);
      if (result.action === 'check_sensor' || result.moisture === undefined) continue;
      const series = samples.get(id) ?? [];
      series.push({ hour: step, moisture: result.moisture });
      samples.set(id, series);
    }
  }

  const forecasts = await Promise.all((Object.keys(locations) as GardenId[]).map(async garden =>
    [garden, await weather(garden, config.weather.et0MmDay)] as const));
  return forecasts.map(([garden, forecast]) => ({
    garden,
    source: forecast.source,
    fetchedAt: forecast.fetchedAt,
    location: locations[garden],
    rainMm: forecast.hours.reduce((sum, hour) => sum + hour.rain, 0),
    startsAt: forecast.hours[0].time,
    nodes: config.nodes.filter(node => node.gatewayId === garden).map(node => {
      const soil = soils.find(item => item.id === node.soilId)!;
      const crop = crops.find(item => item.id === node.cropId)!;
      const series = samples.get(node.id) ?? [];
      const moisture = series.at(-1)?.moisture;
      const base = { nodeId: node.id, crop: crop.name, soil: soil.name, observedHours: series.length, moisture };
      if (moisture === undefined || series.at(-1)?.hour !== 1440) return {
        ...base, alerts: ['Thiếu số đo mới hoặc cảm biến bị nghi đứng trong cuối kỳ.'],
        reason: 'Tạm giữ kế hoạch tưới. Kiểm tra gateway và cảm biến trước khi đánh giá lại.',
      };
      const depth = crop.rootM * 1000;
      const threshold = (soil.fc - crop.depletionP * (soil.fc - soil.wp)) * 100;
      const wetThreshold = (soil.fc + 0.02) * 100;
      const inputs = config.events.filter(event => (!event.nodeId || event.nodeId === node.id) &&
        (event.kind === 'rain' || event.kind === 'irrigation'));
      const wetLoss: number[] = [];
      const dryLoss: number[] = [];
      let wetHours = 0, prolongedEpisodes = 0, streak = 0;
      const examples: { hour: number; moisture: number; input: string }[] = [];
      for (let i = 0; i < series.length; i++) {
        const current = series[i], previous = series[i - 1];
        const contiguous = previous && current.hour === previous.hour + 1;
        streak = current.moisture > wetThreshold ? (contiguous ? streak : 0) + 1 : 0;
        if (streak > 0) wetHours++;
        if (streak === 12) {
          prolongedEpisodes++;
          const start = current.hour - 11;
          const input = inputs.filter(event => event.atHour < start && event.atHour + event.durationHours >= start - 24)
            .sort((a, b) => b.atHour - a.atHour)[0];
          if (input) examples.push({ hour: start, moisture: current.moisture, input: input.kind === 'rain' ? 'mưa mô phỏng' : 'lịch tưới mô phỏng' });
        }
        if (inputs.some(event => event.atHour < current.hour && event.atHour + event.durationHours > current.hour - 1)) continue;
        if (!contiguous || previous.moisture <= current.moisture) continue;
        const drop = (previous.moisture - current.moisture) * depth / 100;
        if (current.moisture > wetThreshold) wetLoss.push(drop);
        else if (current.moisture >= threshold && previous.moisture <= soil.fc * 100) dryLoss.push(drop);
      }
      const median = (values: number[], fallback: number) => {
        values.sort((a, b) => a - b);
        return values.length >= 12 ? values[Math.floor(values.length / 2)] : fallback;
      };
      const referenceEt0 = config.weather.et0MmDay / 24;
      const age = node.ageDays + 60;
      const [initial, development, middle] = crop.days;
      const stage = age < initial ? 0 : age < initial + development ? 1 : age < initial + development + middle ? 2 : 3;
      const kc = median(dryLoss, referenceEt0 * crop.kc[stage]) / Math.max(referenceEt0, 0.01);
      const drainage = Math.max(0, median(wetLoss, soil.drainageMmDay / 24 + referenceEt0 * kc) - referenceEt0 * kc);
      const dose = Math.min(12, Math.max(4, Math.ceil(((threshold + 1 - moisture) * depth / 100) / 0.9)));
      const options = [null, 0, 6, 12].map(hour => {
        let water = moisture * depth / 100;
        let dryHours = 0, excessHours = 0;
        const trajectory = forecast.hours.map((item, index) => {
          water += item.rain + (index === hour ? dose * 0.9 : 0);
          water -= item.et0 * kc;
          water -= Math.min(drainage, Math.max(0, water - soil.fc * depth));
          water = Math.max(0, Math.min(soil.saturation * depth, water));
          const vwc = water / depth * 100;
          if (vwc < threshold) dryHours++;
          if (vwc > wetThreshold) excessHours++;
          return Number(vwc.toFixed(2));
        });
        return { hour, mm: hour === null ? 0 : dose, dryHours, excessHours, trajectory,
          score: dryHours + excessHours * 2 + (hour === null ? 0 : dose / 8) };
      }).sort((a, b) => a.score - b.score);
      const best = options[0];
      const alerts = [];
      if (moisture < threshold) alerts.push('Độ ẩm cuối kỳ dưới ngưỡng của cây.');
      if (options.find(option => option.hour === null)!.dryHours > 0) alerts.push('Có nguy cơ thiếu ẩm trong 24 giờ nếu chờ.');
      if (prolongedEpisodes >= 2) alerts.push('Lịch sử có nhiều đợt ẩm cao kéo dài.');
      return { ...base, alerts, ageDays: age, threshold, wetThreshold, wetHours, prolongedEpisodes,
        drainage, examples: examples.slice(-3), dryFitHours: dryLoss.length, wetFitHours: wetLoss.length, options,
        reason: `${best.hour === null ? 'Theo dõi, chưa tưới' : `Xem xét tưới ${best.mm} mm từ giờ +${best.hour}`}. Phương án có điểm rủi ro thấp nhất trong 24 giờ, tính từ số giờ khô, số giờ ẩm cao và lượng nước tưới.`,
        soilAdvice: prolongedEpisodes >= 2
          ? `Có ${prolongedEpisodes} đợt ẩm cao liên tục ít nhất 12 giờ với cấu hình ${crop.name}. Kiểm tra lối thoát nước và độ nén, thử một luống cao đối chứng rồi đo lại sau mưa.`
          : 'Chưa thấy ít nhất hai đợt ẩm cao kéo dài. Tiếp tục ghi nhận phản ứng sau mưa/tưới và kiểm tra đất trước khi đề xuất cải tạo.' };
    }),
  }));
}
