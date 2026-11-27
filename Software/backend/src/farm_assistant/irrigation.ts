export type Reading = { timestamp: Date; quality: number; soil_moisture: number | null };
export type Irrigation = { status: string; created_at: Date; completed_at: Date | null; zone_id: string; zone: { name: string } };
export type ZoneSensor = { id: string; name: string | null; zone_id: string | null; telemetries: Reading[] };
export function irrigationFollowup(logs: Irrigation[], nodes: ZoneSensor[], now = Date.now()) {
  const findings: { agent: string; level: 'info'; title: string; detail: string; observedAt: string }[] = [];
  for (const log of logs) {
    if (log.status !== 'COMPLETED' || !log.completed_at || log.completed_at.getTime() > now || now - log.completed_at.getTime() > 24 * 3600_000) continue;
    const end = log.completed_at.getTime(), start = log.created_at.getTime();
    if (end < start || logs.some(other => other !== log && other.zone_id === log.zone_id && other.created_at.getTime() > start && other.created_at.getTime() <= end + 2 * 3600_000)) continue;
    for (const node of nodes.filter(n => n.zone_id === log.zone_id)) {
      const valid = node.telemetries.filter(r => r.quality === 0 && r.soil_moisture !== null && Number.isFinite(r.soil_moisture));
      const before = valid.filter(r => r.timestamp.getTime() <= start && r.timestamp.getTime() >= start - 2 * 3600_000).sort((a,b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
      const after = valid.filter(r => r.timestamp.getTime() >= end + 15 * 60_000 && r.timestamp.getTime() <= Math.min(now, end + 2 * 3600_000)).sort((a,b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
      if (!before || !after) continue;
      const diff = after.soil_moisture! - before.soil_moisture!;
      findings.push({ agent: 'post_irrigation', level: 'info', title: `${log.zone.name}: theo dõi sau tưới (${node.name || node.id})`, detail: `Độ ẩm đo được ${before.soil_moisture} trước tưới và ${after.soil_moisture} sau tưới (chênh lệch ${diff.toFixed(1)} điểm). Số đo có thể chịu ảnh hưởng vị trí đầu dò và thời gian nước ngấm; kiểm tra thực tế nếu bất thường.`, observedAt: after.timestamp.toISOString() });
    }
  }
  return findings;
}
