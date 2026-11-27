import { crops, soils } from './catalog.js';
import { forecastMoisture, type MoisturePoint } from './forecast.js';
import type { Sample } from './engine.js';

type Observation = Omit<Sample, 'groundTruth'>;
export type AdviceAction = 'observe' | 'review_irrigation' | 'check_sensor' | 'no_data';
export interface Advice { nodeId: string; eventId?: string; action: AdviceAction; reason: string; moisture?: number; threshold?: number; sources: string[]; forecast?: ReturnType<typeof forecastMoisture>; }
/** Simulation-only, deterministic advisor. Receives observations, never ground truth. */
export class LabAdvisor {
  private history = new Map<string, MoisturePoint[]>();
  evaluate(nodeId: string, sample?: Observation): Advice {
    if (!sample) { this.history.delete(nodeId); return { nodeId, action: 'no_data', reason: 'Không nhận được dữ liệu hiện tại. Kiểm tra node và kết nối trước khi đánh giá.', sources: [] }; }
    const { observations: frame, context } = sample;
    const moisture = frame.soil_moisture;
    const crop = crops.find(c => c.id === context.cropId);
    const soil = soils.find(s => s.id === context.soilId);
    const base = { nodeId, eventId: frame.eventId, moisture, sources: crop?.sourceIds || [] };
    if (sample.sourceType !== 'synthetic' || context.moistureUnit !== 'percent_vwc' || !crop || !soil || !Number.isFinite(moisture) || moisture < 0 || moisture > 100 || frame.quality !== 1) {
      this.history.delete(nodeId);
      return { ...base, action: 'check_sensor', reason: 'Dữ liệu hoặc đơn vị không hợp lệ; cần kiểm tra trước khi đánh giá.' };
    }
    const previous = this.history.get(nodeId) || [];
    const timestamp = frame.timestamp;
    const recent = [...previous.filter(point => point.timestamp !== timestamp && timestamp - point.timestamp <= 86400),
      { timestamp, moisture }].slice(-1441);
    this.history.set(nodeId, recent);
    const lastFive = recent.slice(-5);
    if (lastFive.length === 5 && lastFive.every((point, i) => point.moisture === lastFive[0].moisture && (i === 0 || (point.timestamp > lastFive[i - 1].timestamp && point.timestamp - lastFive[i - 1].timestamp <= 3600)))) {
      return { ...base, action: 'check_sensor', reason: 'Năm số đo liên tiếp giống hệt nhau; kiểm tra cảm biến. Đây là dấu hiệu nghi ngờ, chưa xác nhận lỗi.' };
    }
    // A sudden fall can be real or a sensor offset. Hold watering advice for
    // 24 simulated hours rather than identifying its cause from the readings.
    const suddenDrop = recent.some((point, i) => i > 0 && point.timestamp > recent[i - 1].timestamp &&
      point.timestamp - recent[i - 1].timestamp <= 3600 && recent[i - 1].moisture - point.moisture >= 6);
    if (suddenDrop) return { ...base, action: 'check_sensor', reason: 'Độ ẩm giảm đột ngột ít nhất 6 điểm % VWC trong một giờ. Kiểm tra cảm biến và điều kiện thực tế trước khi quyết định tưới; chưa xác định được nguyên nhân.' };
    const forecast = forecastMoisture(recent, soil.saturation * 100);
    const threshold = (soil.fc - crop.depletionP * (soil.fc - soil.wp)) * 100;
    if (moisture <= threshold) return { ...base, threshold, forecast, action: 'review_irrigation', reason: 'Độ ẩm dưới ngưỡng tham chiếu của mô hình. Cần kiểm tra thực tế và nguồn nước trước khi quyết định tưới.' };
    if (forecast && forecast.slopePerHour < 0 && forecast.moisture <= threshold) {
      return { ...base, threshold, forecast, action: 'review_irrigation', reason: 'Xu hướng hiện tại dự báo độ ẩm có thể xuống dưới ngưỡng trong 6 giờ. Kiểm tra khu trồng và lịch mưa trước khi lên lịch tưới.' };
    }
    return { ...base, threshold, forecast, action: 'observe', reason: 'Độ ẩm cao hơn ngưỡng tham chiếu mô phỏng; tiếp tục theo dõi.' };
  }
}
