// Values are reference scenarios, not locally calibrated crop recommendations.
export const sources = [
  { id: 'fao56-6', title: 'FAO-56, Chapter 6', url: 'https://www.fao.org/4/X0490E/x0490e0b.htm', locator: 'Equation 58; Tables 11–12', use: 'ETc = Kc × ET0; hệ số và thời đoạn sinh trưởng tham chiếu.', scope: 'Điều kiện khí hậu tham chiếu; cần hiệu chỉnh tại địa phương.' },
  { id: 'fao56-8', title: 'FAO-56, Chapter 8', url: 'https://www.fao.org/4/X0490E/x0490e0e.htm', locator: 'Equations 82–84; Table 22; Example 36', use: 'Nước hữu dụng vùng rễ, thiếu hụt nước và stress; FC/WP của đất ví dụ.', scope: 'Xấp xỉ một vùng rễ; chưa có mao dẫn hoặc dòng nước nhiều lớp.' },
  { id: 'tomato-2018', title: 'Acquah et al. (2018), IJABE 11(6), 95–103', url: 'https://doi.org/10.25165/j.ijabe.20181106.3972', locator: 'Abstract, stage-specific measured Kc', use: 'Kc đối chiếu cho cà chua nhà kính: 0.40 / 0.62 / 1.12 / 0.83.', scope: 'Nhà kính Venlo không sưởi, thông gió tự nhiên tại Đông Bắc Trung Quốc; chưa kiểm chứng tại Việt Nam.' },
  { id: 'mustard-2021', title: 'Sustainability (2021), 13(24), 13948 · Brassica juncea', url: 'https://doi.org/10.3390/su132413948', locator: 'Abstract; Section 2.1', use: 'Cơ sở kịch bản stress nước và hữu cơ ở cải xanh giai đoạn sinh dưỡng; thí nghiệm có các mức 100%, 50%, 25% FC.', scope: 'Thí nghiệm chậu/nhà kính tại Texas, Mỹ. Không chuyển các mức %FC thành %VWC; bài này không cung cấp Kc/rễ/p cho hồ sơ mô phỏng.' },
  { id: 'chilli-2011', title: 'A. S. Rao (2011), Journal of Agrometeorology 13(2), 128–130', url: 'https://journal.agrimetassociation.org/index.php/jam/article/download/1356/1134', locator: 'Abstract; Results: Crop coefficients', use: 'Kc ớt theo bốn giai đoạn: khoảng 0.38–0.47 / 0.39–0.69 / 0.85–1.00 / 0.34–0.91; hồ sơ chọn trung điểm từng khoảng.', scope: 'Ớt Haripur/Raipur tại Jodhpur, Ấn Độ, 2006–2008; rễ tham chiếu 0.30 m. Chưa hiệu chuẩn cho giống ớt tại Việt Nam.' },
];
export const crops = [
  { id: 'mustard-greens', name: 'Cải xanh · Brassica juncea', kc: [0.7, 1.05, 1.05, 0.95], days: [10, 15, 15, 5], rootM: 0.3, depletionP: 0.3, stageMeans: false, sourceIds: ['mustard-2021', 'fao56-6', 'fao56-8'], parameterNotes: 'Cải xanh ăn lá (Brassica juncea), không phải xà lách hay cải lấy hạt. Bài 2021 làm căn cứ kịch bản stress. Kc mượn nhóm rau nhỏ FAO; thời đoạn 10/15/15/5 ngày, rễ 0.3 m và p=0.3 là giả định kỹ thuật chưa hiệu chuẩn cho cải xanh.' },
  { id: 'chilli', name: 'Ớt · Capsicum annuum', kc: [0.425, 0.54, 0.925, 0.625], days: [20, 30, 40, 30], rootM: 0.3, depletionP: 0.3, stageMeans: true, sourceIds: ['chilli-2011', 'fao56-8'], parameterNotes: 'Ớt cay: Kc chọn trung điểm bốn khoảng của Rao 2011, giữ hằng theo giai đoạn; không phải số đo trung bình của bài. Rễ chọn 0.30 m theo nghiên cứu; thời đoạn 20/30/40/30 ngày là giả định, p=0.3 mượn tham chiếu ớt chuông FAO. Cần hiệu chỉnh theo giống và nơi trồng.' },
  { id: 'tomato', name: 'Cà chua · Solanum lycopersicum', kc: [0.6, 1.15, 1.15, 0.8], days: [30, 40, 40, 25], rootM: 0.8, depletionP: 0.4, stageMeans: false, sourceIds: ['fao56-6', 'fao56-8', 'tomato-2018'], parameterNotes: 'Kc cuối chọn 0.8 trong khoảng 0.70–0.90; rễ 0.8 m theo Example 36. Thời đoạn: vùng khô hạn, tháng 1. Nội suy Kc giai đoạn phát triển/cuối vụ. Bài nhà kính 2018 là nguồn đối chiếu, không phải các hệ số FAO đang dùng.' },
];
export function cropCoefficient(crop: (typeof crops)[number], age: number) {
  const [initial, development, middle, late] = crop.days;
  const [earlyKc, developmentKc, midKc, lateKc] = crop.kc;
  const developmentEnd = initial + development;
  const middleEnd = developmentEnd + middle;
  if (age < initial) return earlyKc;
  if (age < developmentEnd) return crop.stageMeans ? developmentKc : earlyKc + (midKc - earlyKc) * (age - initial) / development;
  if (age < middleEnd) return midKc;
  return crop.stageMeans ? lateKc : midKc + (lateKc - midKc) * Math.min(1, (age - middleEnd) / late);
}
export const soils = [
  { id: 'loamy-sand', name: 'Cát pha', fc: 0.15, wp: 0.06, saturation: 0.38, drainageMmDay: 35 },
  { id: 'silt', name: 'Đất thịt bụi', fc: 0.32, wp: 0.15, saturation: 0.46, drainageMmDay: 15 },
  { id: 'silty-clay', name: 'Sét pha bụi', fc: 0.35, wp: 0.23, saturation: 0.5, drainageMmDay: 5 },
];
export const assumptions = {
  soil: 'FC/WP: FAO-56 Example 36. Saturation và tốc độ thoát nước là giả định kỹ thuật, cần hiệu chuẩn.',
  weather: 'ET0 nhập trực tiếp (mm/ngày), không suy ra từ lux/nhiệt độ. Chu kỳ nhiệt/ẩm/ánh sáng là tổng hợp.',
  chemistry: 'pH, ECe dịch chiết bão hòa (dS/m), hữu cơ (%) là biến kịch bản. Không mô phỏng phản ứng hóa học, NPK, năng suất hoặc tính liều vật tư.',
  water: 'Bucket một lớp, rễ cố định; bước ≤ 1 giờ. Ks áp lên ETc tổng là xấp xỉ; p giữ cố định ở giá trị tham chiếu ET≈5 mm/ngày.',
  provenance: 'Tất cả mẫu là synthetic. Nguồn cung cấp tham số/phương pháp, không phải bộ số đo thực nghiệm.',
};
export type EventKind = 'rain' | 'irrigation' | 'heat' | 'gateway_offline' | 'node_offline' | 'sensor_stuck' | 'sensor_bias' | 'no_flow' | 'soil_amendment';
export interface ScenarioEvent { id: string; kind: EventKind; atHour: number; durationHours: number; value: number; nodeId?: string; }
export interface LabNode { id: string; gatewayId: string; zoneId: string; cropId: string; soilId: string; ageDays: number; areaM2: number; initialVwc: number; ph: number; ec: number; organicPct: number; }
export interface LabConfig { seed: number; startAt: string; stepMinutes: number; nodes: LabNode[]; events: ScenarioEvent[]; weather: { meanC: number; amplitudeC: number; humidityPct: number; peakLux: number; et0MmDay: number }; }
export function defaultConfig(): LabConfig {
  return { seed: 42, startAt: new Date(Date.now() - 7 * 86400000).toISOString(), stepMinutes: 60,
    weather: { meanC: 28, amplitudeC: 6, humidityPct: 70, peakLux: 50000, et0MmDay: 4.5 },
    nodes: [{ id: 'SIM_NODE_01', gatewayId: 'SIM_GATEWAY_01', zoneId: 'SIM_ZONE_A', cropId: 'mustard-greens', soilId: 'silt', ageDays: 18, areaM2: 100, initialVwc: 0.29, ph: 6.2, ec: 1, organicPct: 2 },
      { id: 'SIM_NODE_02', gatewayId: 'SIM_GATEWAY_01', zoneId: 'SIM_ZONE_B', cropId: 'chilli', soilId: 'loamy-sand', ageDays: 45, areaM2: 50, initialVwc: 0.14, ph: 6.5, ec: 0.8, organicPct: 1.5 },
      { id: 'SIM_NODE_03', gatewayId: 'SIM_GATEWAY_01', zoneId: 'SIM_ZONE_C', cropId: 'tomato', soilId: 'silt', ageDays: 45, areaM2: 100, initialVwc: 0.29, ph: 6.2, ec: 1, organicPct: 2 }],
    events: [{ id: 'rain-1', kind: 'rain', atHour: 48, durationHours: 3, value: 18 }, { id: 'heat-1', kind: 'heat', atHour: 72, durationHours: 48, value: 8 }, { id: 'offline-1', kind: 'gateway_offline', atHour: 96, durationHours: 6, value: 0 }] };
}

export function standalonePresets(
  identity: Pick<LabNode, 'id' | 'gatewayId' | 'zoneId'> = {
    id: 'SIM_STANDALONE_01', gatewayId: 'SIM_STANDALONE_01', zoneId: 'SIM_ZONE_A',
  },
  cropId = 'mustard-greens',
) {
  const config = defaultConfig();
  const profile = config.nodes.find(node => node.cropId === cropId);
  if (!profile) throw new Error('Hồ sơ cây mô phỏng không hợp lệ.');
  const node = { ...profile, ...identity };
  const soil = soils.find(item => item.id === node.soilId)!;
  const dryVwc = Math.round((soil.fc - 0.7 * (soil.fc - soil.wp)) * 100) / 100;
  const baseline: LabConfig = { ...config, nodes: [node], events: [] };
  const scenario = (name: string, kind: EventKind, atHour: number, durationHours: number, value: number) => ({
    name,
    config: { ...baseline, events: [{ id: kind, kind, atHour, durationHours, value, nodeId: node.id }] },
  });
  return [
    { name: 'Số đo bình thường', config: baseline },
    { name: 'Đất khô', config: { ...baseline, nodes: [{ ...node, initialVwc: dryVwc }] } },
    scenario('Mưa lớn', 'rain', 2, 3, 30),
    scenario('Cảm biến độ ẩm đất đứng số', 'sensor_stuck', 2, 12, 0),
    scenario('Cảm biến độ ẩm đất lệch thấp', 'sensor_bias', 2, 12, -12),
    scenario('Node mất kết nối rồi phục hồi', 'node_offline', 2, 4, 0),
  ];
}
