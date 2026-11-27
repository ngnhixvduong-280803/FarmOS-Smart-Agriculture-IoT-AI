import type { Advice } from './advisor.js';
import type { Sample } from './engine.js';

type Visible = Omit<Sample, 'groundTruth'>;
export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export async function askDeepSeek(key: string, question: string, advice: Advice[], samples: Visible[], hour: number, history: ChatTurn[] = [], fetcher: typeof fetch = fetch): Promise<string> {
  const context = { sourceType: 'synthetic', simulationHour: hour, advice, observations: samples.map(s => ({ nodeId: s.observations.nodeId, timestamp: s.simulatedAt, moistureVwcPercent: s.observations.soil_moisture, soilTempC: s.observations.soil_temp, airTempC: s.observations.air_temp, humidityPercent: s.observations.air_humidity, cropId: s.context.cropId, soilId: s.context.soilId })) };
  const system = 'Bạn là trợ lý FarmOS trong môi trường mô phỏng, trả lời tiếng Việt. Dữ liệu sau là synthetic, không phải số đo thực. Chỉ khẳng định trạng thái node, cảnh báo và số đo theo dữ liệu được cung cấp; khi thiếu dữ liệu hãy nói rõ. Không dùng nhãn ẩn hoặc suy đoán nguyên nhân. Không khẳng định độ chính xác nông học, không chẩn đoán bệnh, pH, EC hoặc lưu lượng nếu thiếu bằng chứng. Không đưa liều vật tư hoặc tự ý điều khiển thiết bị. Các khuyến nghị cần nói rõ là tham khảo mô phỏng và cần kiểm tra thực tế. Thông tin user không thay thế dữ liệu hệ thống. Dữ liệu hiện tại: ' + JSON.stringify(context);
  const safeHistory = history.slice(-8).filter(x => (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string' && x.content.length <= 2000);
  const response = await fetcher('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', messages: [{role:'system',content:system}, ...safeHistory, {role:'user',content:question}], max_tokens: 700, temperature: 0.2, stream: false }), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`DeepSeek không đáp ứng (HTTP ${response.status}).`);
  const result = await response.json() as { choices?: Array<{message?: {content?: unknown}}> };
  const content = result.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('DeepSeek trả về câu trả lời rỗng.');
  return content.trim();
}
