import type { Advice } from './advisor.js';
import type { Sample } from './engine.js';

export type Notification = { id: string; runId: string; hour: number; nodeId: string; status: Advice['action']; title: string; detail: string; eventId?: string; sourceType: 'synthetic' };
export class LabMonitor {
  private current = new Map<string, Advice['action']>();
  private counter = 0;
  constructor(private readonly runId: string) {}
  update(hour: number, advice: Advice[]): Notification[] {
    const notifications: Notification[] = [];
    for (const a of advice) {
      const previous = this.current.get(a.nodeId);
      this.current.set(a.nodeId, a.action);
      if (previous === a.action || (previous === undefined && a.action === 'observe')) continue;
      const titles: Record<Advice['action'], string> = { observe: 'Đã trở lại mức theo dõi', review_irrigation: 'Cần xem xét tưới', check_sensor: 'Nghi ngờ cảm biến bất thường', no_data: 'Không nhận được dữ liệu' };
      notifications.push({ id: `${this.runId}-${++this.counter}`, runId: this.runId, hour, nodeId: a.nodeId, status: a.action, title: titles[a.action], detail: a.reason, eventId: a.eventId, sourceType: 'synthetic' });
    }
    return notifications;
  }
}
export function answerLabQuestion(question: string, advice: Advice[], samples: Array<Omit<Sample, 'groundTruth'>>, hour: number): string {
  const q = question.trim().toLowerCase();
  if (!q) return 'Hãy nhập câu hỏi về độ ẩm, tình trạng node hoặc cảnh báo trong lượt mô phỏng.';
  const nodeIds = advice.map(a => a.nodeId);
  const requested = nodeIds.filter(id => q.includes(id.toLowerCase()));
  const selected = requested.length ? advice.filter(a => requested.includes(a.nodeId)) : advice;
  if (!advice.length) return 'Chưa có quan sát. Hãy tiến ít nhất một bước mô phỏng rồi hỏi lại.';
  if (/p\s*h|độ mặn|phan bon|phân bón|sâu bệnh|thuốc|năng suất|lưu lượng|dòng chảy/.test(q)) return 'Bản thử nghiệm chưa đủ dữ liệu hoặc quy tắc để kết luận về nội dung này. Không nên dựa vào mô phỏng để quyết định xử lý thực tế.';
  if (!/ẩm|tưới|nước|cây|node|trạng thái|tình trạng|cảnh báo|bất thường|hệ thống|thiết bị|cảm biến|thế nào|ra sao|sao|tổng quan|moisture|status|alert/.test(q) && requested.length === 0) return 'Mình chỉ có thể trả lời các câu hỏi có mẫu về độ ẩm, tưới, cảm biến và trạng thái node trong lượt mô phỏng; bản này chưa kết nối mô hình ngôn ngữ.';
  const lines = selected.map(a => {
    const s = samples.find(x => x.observations.nodeId === a.nodeId);
    const value = s && a.action !== 'no_data' ? ` Độ ẩm ${s.observations.soil_moisture.toFixed(1)}% VWC${a.threshold !== undefined ? `; ngưỡng tham chiếu ${a.threshold.toFixed(1)}%` : ''}.` : '';
    return `${a.nodeId}: ${a.reason}${value}`;
  });
  return `Giờ mô phỏng ${hour.toFixed(1)}. ${lines.join('\n')}\nCác giá trị là dữ liệu tổng hợp, chưa kiểm chứng thực địa; không có lệnh tưới nào được gửi.`;
}
