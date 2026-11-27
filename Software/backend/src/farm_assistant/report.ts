export type Finding = { agent: string; level: 'info' | 'warning'; title: string; detail: string; observedAt?: string };
type Node = { id: string; name: string | null; type: string; online: boolean; last_seen: Date | null; telemetries: { timestamp: Date; quality: number; soil_moisture: number | null }[] };
type Log = { status: string; created_at: Date; zone: { name: string } };
export function buildReport(nodes: Node[], logs: Log[], now = Date.now()): Finding[] {
  const findings: Finding[] = [];
  for (const node of nodes) {
    const name = node.name || node.id;
    if (!node.online || !node.last_seen || now - node.last_seen.getTime() > 30 * 60_000) {
      findings.push({ agent: 'device', level: 'warning', title: `${name}: cần kiểm tra kết nối`, detail: 'Thiết bị chưa có tín hiệu gần đây. Kiểm tra nguồn và kết nối trước khi dựa vào số đo.', observedAt: node.last_seen?.toISOString() });
      continue;
    }
    if (node.type === 'GATEWAY') continue;
    const latest = node.telemetries[0];
    if (!latest || now - latest.timestamp.getTime() > 30 * 60_000 || latest.timestamp.getTime() > now + 5 * 60_000 || latest.quality !== 0) {
      findings.push({ agent: 'sensor', level: 'warning', title: `${name}: thiếu số đo mới đáng tin cậy`, detail: 'Kiểm tra cảm biến và đường truyền trước khi quyết định tưới.', observedAt: latest?.timestamp.toISOString() });
      continue;
    }
    const samples = node.telemetries.slice(0, 5);
    if (samples.length === 5 && samples.every(s => s.quality === 0 && s.soil_moisture !== null && s.soil_moisture === samples[0].soil_moisture)) {
      findings.push({ agent: 'sensor', level: 'info', title: `${name}: số đo độ ẩm không đổi`, detail: 'Năm số đo gần nhất giống nhau. Đây chỉ là dấu hiệu cần kiểm tra, chưa xác nhận cảm biến bị lỗi.', observedAt: latest.timestamp.toISOString() });
    }
  }
  for (const log of logs) if (['FAILED', 'TIMEOUT', 'REJECTED'].includes(log.status)) {
    findings.push({ agent: 'irrigation', level: 'warning', title: `${log.zone.name}: lần tưới chưa thành công`, detail: `Trạng thái ${log.status}. Kiểm tra lịch sử lệnh và nguồn nước trước khi thử lại.`, observedAt: log.created_at.toISOString() });
  }
  return findings;
}
