import fs from 'node:fs';
import path from 'node:path';
import type { Sample } from './engine.js';
export interface Envelope { manifest: Record<string, unknown>; sample: Sample; }
export class CloudOutbox {
  queue: Envelope[] = [];
  status = { enabled: false, persisted: 0, duplicates: 0, failed: 0, lastError: '', lastTelemetryId: '', lastSuccessAt: '' };
  receipts: Record<string, { eventId: string; sampleId: string; acknowledgedAt: string; gatewayId: string; observations: Sample['observations'] }> = {};
  private busy = false;
  private retryAt = 0;
  private failures = 0;
  constructor(private file: string, private origin: string, private credentials: Record<string, string>, private mode: 'dataset' | 'telemetry' = 'dataset') {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(saved) || saved.length > 10000) throw new Error('Outbox không hợp lệ; giữ file để kiểm tra');
      this.queue = saved;
    }
    if (origin) {
      const u = new URL(origin);
      if (u.username || u.password || u.search || u.hash || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))) throw new Error('Cloud cần HTTPS; HTTP chỉ dùng cho localhost');
    }
  }
  info() { return { ...this.status, receipts: this.receipts, depth: this.queue.length, origin: this.origin, mode: this.mode, configuredGateways: Object.keys(this.credentials) }; }
  enable(enabled: boolean) {
    if (enabled && (!this.origin || !Object.keys(this.credentials).length)) throw new Error('Cần FARMOS_LAB_API_URL và FARMOS_LAB_GATEWAY_TOKENS trong .env.lab');
    this.status.enabled = enabled;
  }
  enqueue(envelope: Envelope) {
    if (this.queue.length >= 10000) throw new Error('Outbox đạt 10.000 mẫu; tạm dừng mô phỏng để tránh mất dữ liệu');
    this.queue.push(structuredClone(envelope)); this.save();
  }
  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.queue), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  async flush(offlineGateways: Set<string> = new Set()) {
    if (!this.status.enabled || this.busy || Date.now() < this.retryAt) return;
    const index = this.queue.findIndex(e => !offlineGateways.has(e.sample.gatewayId));
    if (index < 0) return;
    const envelope = this.queue[index];
    const token = this.credentials[envelope.sample.gatewayId];
    if (!token) { this.status.lastError = `Thiếu credential cho ${envelope.sample.gatewayId}`; return; }
    this.busy = true;
    try {
      const route = this.mode === 'dataset' ? '/api/v1/simulation/ingest' : '/api/v1/onboarding/gateway/telemetry';
      if (this.mode === 'telemetry' && envelope.sample.observations.timestamp * 1000 > Date.now() + 300000) throw new Error('Future timestamp cannot be mirrored to telemetry');
      const body = this.mode === 'dataset' ? envelope : envelope.sample.observations;
      const r = await fetch(this.origin.replace(/\/$/, '') + route, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'x-farmos-device-id': envelope.sample.gatewayId, 'x-farmos-device-token': token }, body: JSON.stringify(body) });
      const response = await r.json() as { success?: boolean; data?: { persisted?: boolean; dropped?: boolean; duplicate?: boolean; telemetryId?: string; sampleId?: string } };
      // A 200 with dropped=true is NOT proof that telemetry was accepted.
      if (!r.ok || response.success !== true || response.data?.persisted !== true || response.data.dropped) throw new Error(`HTTP ${r.status}: ${response.data?.dropped ? 'node chưa kích hoạt hoặc chưa thuộc gateway' : 'server chưa xác nhận lưu dữ liệu'}`);
      const position = this.queue.findIndex(e => e.sample.observations.eventId === envelope.sample.observations.eventId);
      if (position >= 0) this.queue.splice(position, 1);
      this.save();
      this.receipts[envelope.sample.observations.nodeId] = {
        eventId: envelope.sample.observations.eventId,
        sampleId: response.data.sampleId || response.data.telemetryId || '',
        acknowledgedAt: new Date().toISOString(), gatewayId: envelope.sample.gatewayId,
        observations: structuredClone(envelope.sample.observations),
      };
      this.status.persisted++; if (response.data.duplicate) this.status.duplicates++;
      this.status.lastTelemetryId = response.data.telemetryId || response.data.sampleId || '';
      this.status.lastSuccessAt = new Date().toISOString(); this.status.lastError = ''; this.failures = 0; this.retryAt = 0;
    } catch {
      this.status.failed++; this.failures++;
      // Never return response bodies, URLs with credentials, or device secrets to UI/logs.
      this.status.lastError = 'Chưa lưu được trên cloud. Kiểm tra endpoint, migration, credential và binding; mẫu vẫn trong outbox.';
      this.retryAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(this.failures, 6));
    } finally { this.busy = false; }
  }
}
