import { cropCoefficient, crops, soils, LabConfig, ScenarioEvent, EventKind } from './catalog.js';
const kinds: EventKind[] = ['rain', 'irrigation', 'heat', 'gateway_offline', 'node_offline', 'sensor_stuck', 'sensor_bias', 'no_flow', 'soil_amendment'];
export function validateConfig(value: unknown): LabConfig {
  const c = structuredClone(value) as LabConfig;
  const num = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v);
  if (!c || !num(c.seed, 0, 0xffffffff) || !Number.isInteger(c.seed) || !num(c.stepMinutes, 1, 60) || !Number.isFinite(Date.parse(c.startAt)) || Date.parse(c.startAt) < 1577836800000) throw new Error('Seed, thời điểm hoặc bước thời gian không hợp lệ');
  if (!Array.isArray(c.nodes) || c.nodes.length < 1 || c.nodes.length > 20 || new Set(c.nodes.map(n => n.id)).size !== c.nodes.length) throw new Error('Cần 1–20 node với ID duy nhất');
  for (const n of c.nodes) {
    const s = soils.find(s => s.id === n.soilId);
    if (!id(n.id) || !id(n.gatewayId) || !id(n.zoneId) || !s || !crops.some(x => x.id === n.cropId) || !num(n.ageDays, 0, 1000) || !num(n.areaM2, 0.1, 100000) || !num(n.initialVwc, 0, s.saturation) || !num(n.ph, 0, 14) || !num(n.ec, 0, 50) || !num(n.organicPct, 0, 100)) throw new Error('Thông số node/đất/cây không hợp lệ');
  }
  if (!c.weather || !num(c.weather.meanC, -20, 50) || !num(c.weather.amplitudeC, 0, 20) || !num(c.weather.humidityPct, 0, 100) || !num(c.weather.peakLux, 0, 200000) || !num(c.weather.et0MmDay, 0, 20)) throw new Error('Thông số thời tiết không hợp lệ');
  if (!Array.isArray(c.events) || c.events.length > 1000 || new Set(c.events.map(e => e.id)).size !== c.events.length) throw new Error('Danh sách sự kiện không hợp lệ hoặc trùng ID');
  for (const e of c.events) {
    if (!id(e.id) || !kinds.includes(e.kind) || !num(e.atHour, 0, 87600) || !num(e.durationHours, 1 / 60, 8760) || !num(e.value, -100, 1000) || (e.nodeId !== undefined && !c.nodes.some(n => n.id === e.nodeId))) throw new Error('Sự kiện không hợp lệ');
    if (['rain', 'irrigation'].includes(e.kind) && e.value < 0) throw new Error('Lượng nước không được âm');
    if (e.kind === 'soil_amendment' && !num(e.value, 0, 14)) throw new Error('Kịch bản cải tạo cần pH mục tiêu 0–14');
  }
  return c;
}
export interface Frame {
  eventId: string; nodeId: string; timestamp: number; soil_temp: number; air_temp: number;
  soil_moisture: number; air_humidity: number; lux: number; quality: number;
}
export interface Sample {
  runId: string; sequence: number; simulatedAt: string; sourceType: 'synthetic'; gatewayId: string; zoneId: string;
  observations: Frame;
  context: { cropId: string; soilId: string; ageDays: number; areaM2: number; ph: number; eceDsM: number; organicPct: number; et0MmDay: number; moistureUnit: 'percent_vwc'; autoIrrigationMm?: number };
  groundTruth: { vwc: number; kc: number; ks: number; depletionMm: number; rawMm: number; stress: boolean; waterlogged: boolean; gatewayOnline: boolean; nodeOnline: boolean; sensorFault: boolean; activeEvents: string[]; rainMm: number; irrigationMm: number; etMm: number; drainageMm: number; runoffMm: number; storageDeltaMm: number; irrigationNeedGrossMm: number; expectedChecks: string[] };
}
interface Physical { vwc: number; ph: number; lastObserved?: Frame; }
export class LabEngine {
  hour = 0; sequence = 0;
  private state: Physical[];
  config: LabConfig;
  constructor(config: LabConfig, readonly runId: string) {
    this.config = validateConfig(config);
    this.state = this.config.nodes.map(n => ({ vwc: n.initialVwc, ph: n.ph }));
  }
  step(): Sample[] {
    const dt = this.config.stepMinutes / 60;
    const begin = this.hour, end = begin + dt;
    const timestamp = Math.floor((Date.parse(this.config.startAt) + end * 3600000) / 1000);
    this.sequence++;
    const result = this.config.nodes.map((node, index) => {
      const crop = crops.find(c => c.id === node.cropId)!;
      const soil = soils.find(s => s.id === node.soilId)!;
      const state = this.state[index];
      const events = this.config.events.filter(e => (!e.nodeId || e.nodeId === node.id || (e.kind === 'gateway_offline' && this.config.nodes.find(n => n.id === e.nodeId)?.gatewayId === node.gatewayId)) && e.atHour < end && e.atHour + e.durationHours > begin);
      const overlap = (e: ScenarioEvent) => Math.max(0, Math.min(end, e.atHour + e.durationHours) - Math.max(begin, e.atHour));
      const has = (kind: EventKind) => events.some(e => e.kind === kind);
      const dose = (kind: EventKind) => events.filter(e => e.kind === kind).reduce((sum, e) => sum + e.value * overlap(e) / e.durationHours, 0);
      const age = node.ageDays + end / 24;
      const kc = cropCoefficient(crop, age);
      const depthMm = crop.rootM * 1000;
      const taw = (soil.fc - soil.wp) * depthMm, raw = taw * crop.depletionP;
      const depletion = Math.max(0, (soil.fc - state.vwc) * depthMm);
      const ks = depletion <= raw ? 1 : Math.max(0, Math.min(1, (taw - depletion) / (taw - raw)));
      const rainMm = dose('rain'), irrigationMm = has('no_flow') ? 0 : dose('irrigation');
      const etDemand = this.config.weather.et0MmDay * kc * ks * dt / 24;
      const before = state.vwc * depthMm;
      const incoming = rainMm + irrigationMm * 0.9; // Engineering assumption: irrigation application efficiency.
      const etMm = Math.min(etDemand, Math.max(0, before + incoming - soil.wp * depthMm));
      const runoffMm = Math.max(0, before + incoming - etMm - soil.saturation * depthMm);
      const afterRunoff = before + incoming - etMm - runoffMm;
      const drainageMm = Math.min(Math.max(0, afterRunoff - soil.fc * depthMm), soil.drainageMmDay * dt / 24);
      state.vwc = Math.max(0, (afterRunoff - drainageMm) / depthMm);
      for (const e of events.filter(e => e.kind === 'soil_amendment')) state.ph += (e.value - state.ph) * overlap(e) / Math.max(e.atHour + e.durationHours - Math.max(begin, e.atHour), overlap(e));
      const dayHour = (new Date(timestamp * 1000).getUTCHours() + 7) % 24;
      const daylight = Math.max(0, Math.sin((dayHour - 6) * Math.PI / 12));
      const heat = events.filter(e => e.kind === 'heat').reduce((s, e) => s + e.value * overlap(e) / dt, 0);
      // Stateless hash-derived noise makes identical config+seed reproducible, independent of wall time.
      let h = (this.config.seed ^ Math.imul(this.sequence, 2654435761) ^ Math.imul(index + 1, 1597334677)) >>> 0;
      h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
      const noise = (h / 4294967296 - 0.5) * 0.2;
      const air = Math.max(-55, Math.min(125, this.config.weather.meanC + this.config.weather.amplitudeC * Math.sin((dayHour - 9) * Math.PI / 12) + heat + noise));
      const bias = events.filter(e => e.kind === 'sensor_bias').reduce((s, e) => s + e.value, 0);
      let frame: Frame = { eventId: `${this.runId}_${this.sequence}_${node.id}`, nodeId: node.id, timestamp,
        soil_moisture: Math.max(0, Math.min(100, state.vwc * 100 + bias)), soil_temp: Math.max(-55, Math.min(125, this.config.weather.meanC + heat * 0.4 + daylight * 3 + noise)), air_temp: air,
        air_humidity: Math.max(0, Math.min(100, this.config.weather.humidityPct - daylight * 15 - heat * 0.5)), lux: this.config.weather.peakLux * daylight, quality: 1 };
      if (has('sensor_stuck') && state.lastObserved) frame = { ...state.lastObserved, eventId: frame.eventId, timestamp };
      state.lastObserved = frame;
      const finalDepletion = Math.max(0, (soil.fc - state.vwc) * depthMm);
      const stress = finalDepletion > raw;
      const checks: string[] = [];
      if (stress) checks.push('Đối chiếu độ ẩm với loại đất và nhu cầu tưới');
      if (has('sensor_stuck') || has('sensor_bias')) checks.push('Kiểm tra cảm biến; không suy ra nguyên nhân từ một số đo');
      if (has('no_flow')) checks.push('Kiểm tra cấp nước và lưu lượng trước khi tưới lại');
      if (!checks.length) checks.push('Theo dõi diễn biến; chưa có nhãn bất thường của mô hình');
      return { runId: this.runId, sequence: this.sequence, simulatedAt: new Date(timestamp * 1000).toISOString(), sourceType: 'synthetic' as const, gatewayId: node.gatewayId, zoneId: node.zoneId, observations: frame,
        context: { cropId: node.cropId, soilId: node.soilId, ageDays: age, areaM2: node.areaM2, ph: state.ph, eceDsM: node.ec, organicPct: node.organicPct, et0MmDay: this.config.weather.et0MmDay, moistureUnit: 'percent_vwc' as const },
        groundTruth: { vwc: state.vwc, kc, ks, depletionMm: finalDepletion, rawMm: raw, stress, waterlogged: state.vwc > soil.fc + 0.02, gatewayOnline: !has('gateway_offline'), nodeOnline: !has('node_offline'), sensorFault: has('sensor_stuck') || has('sensor_bias'), activeEvents: events.map(e => e.id), rainMm, irrigationMm, etMm, drainageMm, runoffMm, storageDeltaMm: (state.vwc * depthMm - before), irrigationNeedGrossMm: stress ? finalDepletion / 0.9 : 0, expectedChecks: checks } };
    });
    this.hour = end;
    return result;
  }
}
