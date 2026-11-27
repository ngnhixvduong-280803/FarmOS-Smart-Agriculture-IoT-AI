import type { Advice } from './advisor.js';
import type { standaloneTelemetry } from './standalone-telemetry.js';
import type { NodeWeather } from './standalone-weather.js';

type Reading = ReturnType<typeof standaloneTelemetry>;

export const standaloneAgents = {
  quality: 'Kiểm tra kết nối, mã chất lượng firmware, độ ẩm đất và dấu hiệu bất thường.',
  moisture: 'Dự báo xu hướng độ ẩm đất 6 giờ mô phỏng.',
  weather: 'Tổng hợp mưa, xác suất mưa và ET₀ 24 giờ tại tọa độ đã cấu hình.',
  ambient: 'Tính điểm sương từ nhiệt độ và độ ẩm không khí.',
  irrigation: 'Tổng hợp chất lượng, xu hướng và thời tiết thành đề xuất để người dùng xem xét.',
  deviceHealth: 'Kiểm tra phiên chạy, tuổi bản tin và trạng thái kết nối của node.',
  irrigationFollowup: 'So sánh VWC trước và sau lệnh tưới mô phỏng.',
  irrigationSchedule: 'So sánh lịch và liều tưới giả lập trong 24 giờ.',
};

export function soilInputStatus(reading: Reading) {
  if (!reading) return 'offline';
  if (reading.payload.quality !== 0) return 'suspect';
  if (!Number.isFinite(reading.payload.soil_moisture)) return 'missing_soil';
  if (!reading.vwcLinked) return 'missing_vwc';
  return 'ready';
}

export function evaluateStandaloneAgents(reading: Reading, advice: Advice | undefined, weather: NodeWeather) {
  const input = soilInputStatus(reading);
  const quality = input === 'ready' && advice?.action === 'check_sensor' ? 'anomaly' : input;
  const forecast = quality === 'ready' ? advice?.forecast ?? null : null;
  const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
  const nextRain = weather.status === 'ready'
    ? weather.hours.slice(0, 6).find(hour => hour.rainMm > 0 && hour.rainProbability >= 60)
    : undefined;
  const rain6h = weather.status === 'ready'
    ? sum(weather.hours.slice(0, 6).map(hour => hour.rainProbability >= 60 ? hour.rainMm : 0))
    : 0;
  const firstDay = weather.status === 'ready' ? weather.hours.slice(0, 24) : [];
  const weatherSummary = weather.status === 'ready' ? {
    ...weather, hours: firstDay,
    rainMm24h: sum(firstDay.map(hour => hour.rainMm)),
    et0Mm24h: sum(firstDay.map(hour => hour.et0Mm)),
    maxRainProbability: Math.max(...firstDay.map(hour => hour.rainProbability)),
    nextLikelyRainEndAt: nextRain?.endAt ?? null,
  } : weather;

  const air = reading?.payload;
  let ambient = null;
  if (air && air.quality === 0 && Number.isFinite(air.air_temp) && air.air_humidity > 0 && air.air_humidity <= 100) {
    const gamma = Math.log(air.air_humidity / 100) + (17.62 * air.air_temp) / (243.12 + air.air_temp);
    ambient = { dewPointC: Math.round(243.12 * gamma / (17.62 - gamma) * 10) / 10 };
  }

  let irrigation: { action: string; reason: string };
  if (quality !== 'ready' || !advice || advice.moisture === undefined || advice.threshold === undefined) {
    irrigation = { action: 'hold', reason: 'Tạm giữ đề xuất tưới. Kiểm tra kết nối và chất lượng số đo đất.' };
  } else if (advice.moisture <= advice.threshold) {
    irrigation = { action: 'inspect_dry_soil', reason: 'Độ ẩm mô phỏng đã dưới ngưỡng. Kiểm tra đất tại chỗ và mưa sắp tới trước khi quyết định tưới.' };
  } else if (advice.action === 'review_irrigation' && rain6h >= 2) {
    irrigation = { action: 'consider_waiting_for_rain', reason: 'Đất hiện trên ngưỡng. Có thể chờ mưa rồi đo lại vì dự báo có ít nhất 2 mm mưa trong các giờ có xác suất từ 60%.' };
  } else if (advice.action === 'review_irrigation') {
    irrigation = { action: 'monitor_drying', reason: 'Xu hướng mô phỏng có thể xuống dưới ngưỡng. Theo dõi thêm và kiểm tra đất trước khi lên lịch tưới.' };
  } else {
    irrigation = { action: 'observe', reason: 'Tiếp tục theo dõi độ ẩm đất.' };
  }

  return { quality, moisture: { source: 'simulated_percent_vwc', current: quality === 'ready' ? advice?.moisture ?? null : null, forecast },
    weather: weatherSummary, ambient, irrigation };
}
