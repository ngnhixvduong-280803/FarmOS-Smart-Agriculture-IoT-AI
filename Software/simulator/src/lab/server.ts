import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { crops, soils, sources, assumptions, defaultConfig, standalonePresets, LabConfig } from './catalog.js';
import { LabEngine, Sample, validateConfig } from './engine.js';
import { CloudOutbox } from './cloud.js';
import { planHistory } from './planner.js';
import { LabAdvisor, Advice } from './advisor.js';
import { LabMonitor, Notification, answerLabQuestion } from './monitor.js';
import { askDeepSeek, ChatTurn } from './deepseek.js';
import { standaloneTelemetry, type SoilProbeInput } from './standalone-telemetry.js';
import { evaluateStandaloneAgents, soilInputStatus, standaloneAgents } from './standalone-agents.js';
import { StandaloneWeather, validateWeatherSite, type WeatherSite, type NodeWeather } from './standalone-weather.js';
import { deviceHealth, IrrigationFollowup } from './standalone-operations.js';
import { StandaloneSchedule } from './standalone-schedule.js';
dotenv.config({ path: path.resolve(__dirname, '../../.env.lab'), quiet: true } as dotenv.DotenvConfigOptions);
const port = Number(process.env.FARMOS_LAB_PORT || 4010);
const standalone = process.argv.includes('--standalone');
const deepSeekKey = standalone ? undefined : process.env.DEEPSEEK_API_KEY;
const standaloneId = process.env.FARMOS_STANDALONE_INSTANCE;
if (standaloneId && !/^[A-Z0-9_]{1,16}$/.test(standaloneId)) throw new Error('Invalid standalone instance ID');
const presets = standalonePresets(standaloneId ? {
  id: 'SIM_NODE_' + standaloneId, gatewayId: 'SIM_NODE_' + standaloneId, zoneId: 'SIM_ZONE_' + standaloneId,
} : undefined, standalone ? process.env.FARMOS_STANDALONE_CROP : undefined);
const standaloneCadenceMs = Number(process.env.FARMOS_STANDALONE_CADENCE_MS ?? '5000');
if (standalone && (!Number.isInteger(standaloneCadenceMs) || standaloneCadenceMs < 250 || standaloneCadenceMs > 60000)) {
  throw new Error('Nhịp chạy standalone phải từ 250 đến 60000 ms.');
}
const presetIndex = Number(process.env.FARMOS_STANDALONE_PRESET ?? '0');
if (standalone && (!Number.isInteger(presetIndex) || !presets[presetIndex])) {
  throw new Error('Invalid standalone preset index');
}
const initialConfig = standalone ? presets[presetIndex].config : defaultConfig();
if (standalone && process.env.FARMOS_STANDALONE_STEP_MINUTES) {
  const stepMinutes = Number(process.env.FARMOS_STANDALONE_STEP_MINUTES);
  if (!Number.isInteger(stepMinutes) || stepMinutes < 1 || stepMinutes > 60) throw new Error('Bước mô phỏng phải từ 1 đến 60 phút.');
  for (const preset of presets) preset.config.stepMinutes = stepMinutes;
}
const dataDir = path.resolve(process.env.FARMOS_LAB_DATA_DIR || path.resolve(__dirname, standalone ? '../../.lab-standalone' : '../../.lab'));
fs.mkdirSync(dataDir, { recursive: true });
const weatherFile = path.join(dataDir, 'weather-site.json');
const nodeWeather = new StandaloneWeather();
let weatherSite: WeatherSite | undefined;
if (standalone && fs.existsSync(weatherFile)) {
  const saved = JSON.parse(fs.readFileSync(weatherFile, 'utf8'));
  if (saved !== null) weatherSite = validateWeatherSite(saved);
}
const standaloneCloud = standalone && process.env.FARMOS_STANDALONE_CLOUD === '1';
const credentials = JSON.parse(standalone && !standaloneCloud ? '{}' : process.env.FARMOS_LAB_GATEWAY_TOKENS || '{}') as Record<string, string>;
if (!credentials || Array.isArray(credentials) || Object.values(credentials).some(v => typeof v !== 'string' || !v)) throw new Error('FARMOS_LAB_GATEWAY_TOKENS cần object ID:token');
const mode = !standalone && process.env.FARMOS_LAB_CLOUD_MODE === 'telemetry' ? 'telemetry' : 'dataset';
const cloud = new CloudOutbox(path.join(dataDir, 'outbox.json'), standalone && !standaloneCloud ? '' : process.env.FARMOS_LAB_API_URL || '', credentials, mode);
if (standaloneCloud) cloud.enable(true);
let engine: LabEngine;
let manifest: Record<string, unknown>;
let latest: Sample[] = [];
let directTelemetry: ReturnType<typeof standaloneTelemetry> = null;
let lastReceivedAt: number | null = null;
let followup: IrrigationFollowup;
let schedule: StandaloneSchedule;
let scheduling = false;
let lastWeather: NodeWeather = { status: 'unconfigured' };
let advisor: LabAdvisor;
let advice: Advice[] = [];
let monitor: LabMonitor;
let notifications: Notification[] = [];
let chartSamples: Sample[] = [];
let running = false;
let error = '';
let busy = false;
let cadenceMs = standalone ? standaloneCadenceMs : 1000;
let nextTick = 0;
function reset(config: LabConfig) {
  const validated = validateConfig(config);
  if (standalone && (validated.nodes.length !== 1 || validated.events.some(event => event.kind === 'gateway_offline'))) {
    throw new Error('Chế độ standalone chỉ hỗ trợ một node và sự kiện của node.');
  }
  if (standaloneCloud) {
    const expected = initialConfig.nodes[0];
    const node = validated.nodes[0];
    if (node.id !== expected.id || node.gatewayId !== expected.gatewayId || node.zoneId !== expected.zoneId ||
        (process.env.FARMOS_STANDALONE_CROP && node.cropId !== expected.cropId)) {
      throw new Error('Node và cây trồng phải khớp vườn mô phỏng đã cấp trên cloud.');
    }
  }
  engine = new LabEngine(validated, randomUUID());
  manifest = { runId: engine.runId, sourceType: 'synthetic', modelVersion: 'bucket-v1', createdAt: new Date().toISOString(), config: structuredClone(validated), sources, assumptions, crops, soils };
  fs.writeFileSync(path.join(dataDir, `${engine.runId}.manifest.json`), JSON.stringify(manifest, null, 2));
  latest = []; directTelemetry = null; advice = []; notifications = []; advisor = new LabAdvisor(); monitor = new LabMonitor(engine.runId); chartSamples = []; running = false; error = '';
  lastReceivedAt = null;
  followup = new IrrigationFollowup();
  schedule = new StandaloneSchedule();
  lastWeather = { status: weatherSite ? 'unavailable' : 'unconfigured' };
}
reset(initialConfig);
function step(count: number, override?: { nodeId: string; values: Partial<Sample['observations']>; soilProbe?: SoilProbeInput }) {
  for (let i = 0; i < count; i++) {
    if ((!standalone || standaloneCloud) && cloud.queue.length + engine.config.nodes.length > 10000) throw new Error('Outbox đầy; dừng để giữ dữ liệu');
    const beginHour = engine.hour;
    latest = engine.step();
    // Record only user-issued irrigation commands, never hidden scenario events.
    for (const sample of latest) {
      const commanded = engine.config.events.filter(event => event.id.startsWith('action_') && event.nodeId === sample.observations.nodeId && event.kind === 'irrigation' && event.atHour < engine.hour && event.atHour + event.durationHours > beginHour)
        .reduce((sum, event) => sum + event.value * Math.max(0, Math.min(engine.hour, event.atHour + event.durationHours) - Math.max(beginHour, event.atHour)) / event.durationHours, 0);
      if (commanded > 0 && commanded <= 50) sample.context.autoIrrigationMm = commanded;
    }
    if (override) {
      const sample = latest.find(item => item.observations.nodeId === override.nodeId);
      if (sample) Object.assign(sample.observations, override.values);
    }
    if (standalone) {
      directTelemetry = standaloneTelemetry(latest[0], override?.soilProbe);
      if (directTelemetry) {
        lastReceivedAt = Date.now();
        fs.appendFileSync(path.join(dataDir, `${engine.runId}.device-telemetry.jsonl`), JSON.stringify(directTelemetry.payload) + '\n');
      }
    }
    advice = latest.map(({ groundTruth, ...sample }) => {
      const id = sample.observations.nodeId;
      if (!groundTruth.nodeOnline || !groundTruth.gatewayOnline) return advisor.evaluate(id);
      if (standalone && soilInputStatus(directTelemetry) !== 'ready') {
        advisor.evaluate(id);
        return { nodeId: id, action: 'check_sensor', reason: 'Bản tin độ ẩm đất thiếu, đáng ngờ hoặc chưa có dữ liệu % VWC tương ứng.', sources: [] };
      }
      return advisor.evaluate(id, sample);
    });
    if (standalone) followup.record(engine.hour, engine.config.stepMinutes / 60,
      latest[0].context.autoIrrigationMm, advice[0].action === 'check_sensor' ? undefined : advice[0].moisture);
    if (standalone) schedule.observe(advice[0].action === 'no_data' || advice[0].action === 'check_sensor' ? undefined : advice[0]);
    if (standalone && latest[0].context.autoIrrigationMm !== undefined) schedule.requestPlanUpdate();
    const changes = monitor.update(engine.hour, advice);
    if (changes.length) { notifications.push(...changes); fs.appendFileSync(path.join(dataDir, `${engine.runId}.notifications.jsonl`), changes.map(x => JSON.stringify(x)).join('\n') + '\n'); }
    fs.appendFileSync(path.join(dataDir, `${engine.runId}.advice.jsonl`), advice.map(x => JSON.stringify({ runId: engine.runId, hour: engine.hour, ...x })).join('\n') + '\n');
    chartSamples.push(...latest.filter(sample => sample.groundTruth.nodeOnline && sample.groundTruth.gatewayOnline));
    chartSamples = chartSamples.slice(-600);
    fs.appendFileSync(path.join(dataDir, `${engine.runId}.jsonl`), latest.map(x => JSON.stringify(x)).join('\n') + '\n');
    if (!standalone || standaloneCloud) {
      for (const sample of latest) if (sample.groundTruth.nodeOnline) {
        const agents = standaloneCloud ? evaluateStandaloneAgents(directTelemetry, advice[0], lastWeather) : undefined;
        const scheduled = schedule.snapshot();
        const weekly = scheduled.weekly;
        const compactWeekly = weekly?.forecast.status === 'ready' ? {
          ...weekly, forecast: { ...weekly.forecast,
            trajectory: weekly.forecast.trajectory.filter((_, index) => index % 24 === 0) },
        } : weekly;
        const snapshot = standaloneCloud ? {
          version: 1, runId: sample.runId, nodeId: sample.observations.nodeId,
          eventId: sample.observations.eventId, generatedAt: Date.now(),
          ...agents,
          weather: agents?.weather.status === 'ready'
            ? { status: 'ready', source: agents.weather.source, fetchedAt: agents.weather.fetchedAt,
              rainMm24h: agents.weather.rainMm24h, et0Mm24h: agents.weather.et0Mm24h,
              maxRainProbability: agents.weather.maxRainProbability }
            : agents?.weather,
          deviceHealth: deviceHealth(running, cadenceMs, directTelemetry !== null, lastReceivedAt),
          irrigationFollowup: followup.report(engine.hour),
          forecastSchedule: { ...scheduled, weekly: compactWeekly, plan24h: schedule.due(Date.now()) ? null : scheduled.plan24h },
        } : undefined;
        cloud.enqueue({ manifest: snapshot ? { ...manifest, agentSnapshot: snapshot } : manifest, sample });
      }
    }
  }
}
function publicState() {
  return { standalone, agentsEnabled: standalone, directTelemetry, runId: engine.runId, hour: engine.hour, running, error, cadenceMs, config: engine.config, latest, advice, chartPoints: chartSamples.map(({simulatedAt, observations}) => ({simulatedAt, observations})), cloud: cloud.info(), catalog: { crops, soils, sources, assumptions } };
}
function startStandalone() {
  step(1);
  running = true;
  nextTick = Date.now() + cadenceMs;
}
async function checkSchedule() {
  if (scheduling || !schedule.due(Date.now())) return;
  scheduling = true;
  const site = weatherSite;
  const activeSchedule = schedule;
  const runId = engine.runId;
  try {
    const weather = await nodeWeather.read(site);
    if (activeSchedule !== schedule || site !== weatherSite) return;
    lastWeather = weather;
    const now = Date.now();
    const health = deviceHealth(running, cadenceMs, directTelemetry !== null, lastReceivedAt, now);
    const usable = health.status === 'online' && soilInputStatus(directTelemetry) === 'ready';
    const previous = schedule.snapshot().weekly;
    const result = schedule.tick(now, {
      weather, context: latest[0]?.context, advice: usable ? advice[0] : undefined,
      sampleId: directTelemetry?.payload.eventId ?? null,
    });
    if (result) {
      const entry = {
        runId, site: site ?? null, check: result.lastCheck,
        ...(result.weekly !== previous ? { weekly: result.weekly } : {}),
        ...(result.lastCheck?.updated ? { plan24h: result.plan24h } : {}),
      };
      fs.appendFileSync(path.join(dataDir, `${runId}.schedule.jsonl`), JSON.stringify(entry) + '\n');
    }
  } catch (error) {
    console.error('Không thể lưu kết quả lập lịch standalone', error);
  } finally {
    scheduling = false;
  }
}
async function jsonBody(req: http.IncomingMessage) {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 256000) throw new Error('Nội dung quá lớn'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
const server = http.createServer(async (req, res) => {
  const json = (code: number, value: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const publicPort = process.env.FARMOS_LAB_PUBLIC_PORT || String(port);
  const allowedHost = [`localhost:${port}`, `127.0.0.1:${port}`, `localhost:${publicPort}`, `127.0.0.1:${publicPort}`];
  if (!allowedHost.includes(req.headers.host || '') || (req.headers.origin && !allowedHost.map(h => `http://${h}`).includes(req.headers.origin))) return json(403, { error: 'Chỉ cho phép giao diện localhost' });
  try {
    if (req.method === 'GET' && (req.url === '/agent' || req.url === '/notifications')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(fs.readFileSync(path.join(__dirname, 'agent.html')));
    }
    if (req.method === 'GET' && req.url === '/api/assistant/gardens') {
      return json(200, [...new Set(engine.config.nodes.map(node => node.gatewayId))]);
    }
    if (req.method === 'GET' && req.url === '/api/assistant/status') return json(200, { mode: deepSeekKey ? 'deepseek' : 'rule_based' });
    if (req.method === 'GET' && req.url === '/api/notifications') return json(200, { runId: engine.runId, hour: engine.hour, notifications: notifications.slice(-500).reverse() });
    if (req.method === 'GET' && (req.url === '/' || req.url === '/test-lab')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(fs.readFileSync(path.join(__dirname, standalone || req.url === '/test-lab' ? 'test-lab.html' : 'dashboard.html')));
    }
    if (req.method === 'GET' && (req.url === '/api/presets' || req.url?.split('?')[0] === '/api/planner')) {
      if (standalone) return req.url === '/api/presets'
        ? json(200, presets)
        : json(404, { error: 'Chế độ standalone không có bộ lập kế hoạch nhiều vườn.' });
      const folder = fs.existsSync(path.join(__dirname, 'scenarios')) ? path.join(__dirname, 'scenarios') : path.resolve(__dirname, '../../scenarios');
      if (req.url?.split('?')[0] === '/api/planner') {
        const { config } = JSON.parse(fs.readFileSync(path.join(folder, 'sixty-day-history.json'), 'utf8'));
        const params = new URL(req.url!, 'http://localhost').searchParams;
        for (const node of (config as LabConfig).nodes) {
          const crop = params.get(node.id);
          if (crop && !crops.some(item => item.id === crop)) return json(400, { error: 'Hồ sơ cây không hợp lệ.' });
          if (crop) node.cropId = crop;
        }
        for (const garden of ['SIM_VUON_A', 'SIM_VUON_B']) {
          const scenario = params.get(garden + '_scenario') ?? 'baseline';
          const rainScale = Number(params.get(garden + '_rain') ?? 100) / 100;
          const irrigationScale = Number(params.get(garden + '_irrigation') ?? 100) / 100;
          if (!['baseline', 'drought', 'wet', 'offline', 'stuck'].includes(scenario) ||
              ![rainScale, irrigationScale].every(value => Number.isFinite(value) && value >= 0 && value <= 2)) {
            return json(400, { error: 'Kịch bản hoặc hệ số nằm ngoài phạm vi.' });
          }
          const farmNodes = (config as LabConfig).nodes.filter(node => node.gatewayId === garden);
          const ids = new Set(farmNodes.map(node => node.id));
          for (const event of (config as LabConfig).events) {
            if (!event.nodeId || !ids.has(event.nodeId)) continue;
            if (event.kind === 'rain') event.value *= rainScale * (scenario === 'drought' ? 0.2 : scenario === 'wet' ? 1.5 : 1);
            if (event.kind === 'irrigation') event.value *= irrigationScale * (scenario === 'drought' ? 0.5 : 1);
          }
          if (scenario === 'offline' || scenario === 'stuck') {
            for (const node of farmNodes) (config as LabConfig).events.push({
              id: 'demo-' + node.id, nodeId: node.id, kind: scenario === 'offline' ? 'node_offline' : 'sensor_stuck',
              atHour: 1416, durationHours: 24, value: 0,
            });
          }
        }
        return json(200, { historyDays: 60, gardens: await planHistory(validateConfig(config)) });
      }
      return json(200, fs.readdirSync(folder).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'))));
    }
    if (req.method === 'GET' && req.url === '/api/catalog') return json(200, { crops, soils, sources, assumptions });
    if (req.method === 'GET' && req.url === '/api/state') return json(200, publicState());
    if (standalone && req.method === 'GET' && req.url === '/api/agents') {
      const site = weatherSite;
      const weather = await nodeWeather.read(site);
      if (site !== weatherSite) return json(409, { error: 'Vị trí thời tiết vừa thay đổi. Thử lại.' });
      const result = evaluateStandaloneAgents(directTelemetry, advice[0], weather);
      const health = deviceHealth(running, cadenceMs, directTelemetry !== null, lastReceivedAt);
      const scheduled = schedule.snapshot();
      return json(200, {
        schemaVersion: 1, sourceType: 'synthetic', runId: engine.runId,
        nodeId: engine.config.nodes[0].id, eventId: directTelemetry?.payload.eventId ?? null,
        site: site ?? null, agents: standaloneAgents,
        ...result,
        irrigation: health.status === 'stale'
          ? { action: 'hold', reason: 'Tạm giữ đề xuất tưới vì bản tin node đã cũ.' }
          : result.irrigation,
        deviceHealth: health,
        irrigationFollowup: followup.report(engine.hour),
        irrigationSchedule: result.quality !== 'ready' || health.status === 'offline' || health.status === 'stale'
          ? { status: 'soil_unavailable' } : scheduled.plan24h?.result ?? { status: 'pending' },
        forecastSchedule: scheduled,
      });
    }
    if (standalone && req.method === 'GET' && req.url === '/api/device-telemetry') return json(200, directTelemetry?.payload ?? null);
    if (req.method === 'GET' && req.url === '/api/advice') return json(200, { sourceType: 'synthetic', runId: engine.runId, hour: engine.hour, advice });
    if (req.method === 'GET' && req.url === '/api/advice/export') {
      const file = path.join(dataDir, `${engine.runId}.advice.jsonl`);
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${engine.runId}.advice.jsonl"` });
      return res.end(fs.existsSync(file) ? fs.readFileSync(file) : '');
    }
    if (req.method === 'GET' && req.url === '/api/observations') return json(200, { sourceType: 'synthetic', runId: engine.runId, hour: engine.hour, samples: latest.filter(s => s.groundTruth.nodeOnline && s.groundTruth.gatewayOnline).map(({ groundTruth, ...observation }) => observation) });
    if (req.method === 'GET' && req.url?.startsWith('/api/export')) {
      const kind = new URL(req.url, 'http://localhost').searchParams.get('kind') || 'observations';
      res.writeHead(200, { 'Content-Type': kind === 'manifest' ? 'application/json' : 'application/x-ndjson', 'Content-Disposition': `attachment; filename="${engine.runId}.${kind === 'manifest' ? 'manifest.json' : kind + '.jsonl'}"` });
      if (kind === 'manifest') return res.end(JSON.stringify(manifest, null, 2));
      const file = path.join(dataDir, `${engine.runId}.jsonl`);
      // Stream line-by-line: export does not accumulate an entire long run in memory.
      if (!fs.existsSync(file)) return res.end();
      const { createInterface } = await import('node:readline');
      for await (const line of createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })) {
        const sample = JSON.parse(line) as Sample;
        if (kind !== 'labels' && !sample.groundTruth.nodeOnline) continue;
        const { groundTruth, ...observation } = sample;
        res.write(JSON.stringify(kind === 'labels' ? { eventId: sample.observations.eventId, runId: sample.runId, groundTruth } : observation) + '\n');
      }
      return res.end();
    }
    if (req.method !== 'POST') return json(404, { error: 'Không có endpoint' });
    const b = await jsonBody(req);
    if (req.url === '/api/chat') {
      if (typeof b.question !== 'string' || !b.question.trim() || b.question.length > 1000) throw new Error('Câu hỏi phải có từ 1–1000 ký tự');
      const gardens = new Set(engine.config.nodes.map(node => node.gatewayId));
      const garden = b.garden ?? (gardens.size === 1 ? [...gardens][0] : undefined);
      if (typeof garden !== 'string' || !gardens.has(garden)) return json(400, { error: 'Chọn vườn mô phỏng trước khi hỏi.' });
      const nodes = new Set(engine.config.nodes.filter(node => node.gatewayId === garden).map(node => node.id));
      const scopedAdvice = advice.filter(item => nodes.has(item.nodeId));
      const visible = latest.filter(s => s.gatewayId === garden && s.groundTruth.nodeOnline && s.groundTruth.gatewayOnline).map(({ groundTruth, ...sample }) => sample);
      if (b.history !== undefined && (!Array.isArray(b.history) || b.history.length > 8 || b.history.some((x: any) => !x || !['user','assistant'].includes(x.role) || typeof x.content !== 'string' || x.content.length > 2000))) throw new Error('Lịch sử trò chuyện không hợp lệ');
      if (deepSeekKey) {
        try { return json(200, { answer: await askDeepSeek(deepSeekKey, b.question, scopedAdvice, visible, engine.hour, (b.history || []) as ChatTurn[]), mode: 'deepseek', sourceType: 'synthetic', runId: engine.runId }); }
        catch { return json(503, { error: 'Không kết nối được DeepSeek. Kiểm tra cấu hình server và thử lại.' }); }
      }
      return json(200, { answer: answerLabQuestion(b.question, scopedAdvice, visible, engine.hour), mode: 'rule_based', sourceType: 'synthetic', runId: engine.runId });
    }
    if (standalone && req.url === '/api/agents/location') {
      const site = b === null ? undefined : validateWeatherSite(b);
      const temporary = weatherFile + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(site ?? null), { mode: 0o600 });
      fs.renameSync(temporary, weatherFile);
      weatherSite = site;
      schedule.invalidate();
    }
    else if (req.url === '/api/reset') {
      reset(b);
      if (standalone) startStandalone();
    }
    else if (req.url === '/api/step') { if (!Number.isInteger(b.count) || b.count < 1 || b.count > 168) throw new Error('count phải từ 1 đến 168'); step(b.count); }
    else if (req.url === '/api/test-reading') {
      if (!engine.config.nodes.some(node => node.id === b.nodeId) || !b.values || typeof b.values !== 'object' || Array.isArray(b.values)) throw new Error('Chọn node và số đo để thử.');
      const bounds: Record<string, [number, number]> = {
        soil_moisture: [0, 100], soil_temp: [-55, 125], air_temp: [-55, 125],
        air_humidity: [0, 100], lux: [0, 200000],
      };
      let soilProbe: SoilProbeInput | undefined;
      if (standalone) {
        delete bounds.lux;
        delete bounds.soil_moisture;
        const { adc, calibration = 'simulated' } = b.soilProbe ?? {};
        if ((adc !== undefined && (!Number.isInteger(adc) || adc < 0 || adc > 4095)) ||
          !['simulated', 'bench', 'none'].includes(calibration)) throw new Error('ADC hoặc chế độ hiệu chuẩn không hợp lệ.');
        soilProbe = { adc, calibration };
      }
      const values: Partial<Sample['observations']> = {};
      for (const [key, value] of Object.entries(b.values)) {
        const limit = Object.hasOwn(bounds, key) ? bounds[key] : undefined;
        if (!limit || typeof value !== 'number' || !Number.isFinite(value) || value < limit[0] || value > limit[1]) throw new Error('Số đo ngoài phạm vi.');
        Object.assign(values, { [key]: value });
      }
      if (!Object.keys(values).length && soilProbe?.adc === undefined && (!soilProbe || soilProbe.calibration === 'simulated')) throw new Error('Nhập ít nhất một số đo.');
      step(1, { nodeId: b.nodeId, values, soilProbe });
    }
    else if (req.url === '/api/run') {
      if (typeof b.running !== 'boolean' || !Number.isInteger(b.cadenceMs) || b.cadenceMs < 250 || b.cadenceMs > 60000) throw new Error('Nhịp chạy không hợp lệ');
      running = b.running;
      cadenceMs = b.cadenceMs;
      nextTick = Date.now() + cadenceMs;
    }
    else if (req.url === '/api/cloud') {
      if (typeof b.enabled !== 'boolean') throw new Error('enabled phải là boolean');
      if (standalone && !standaloneCloud && b.enabled) throw new Error('Standalone chưa được cấu hình gửi cloud.');
      cloud.enable(b.enabled);
    }
    else if (req.url === '/api/actions/irrigate') {
      if (!engine.config.nodes.some(n => n.id === b.nodeId) || typeof b.mm !== 'number' || !Number.isFinite(b.mm) || b.mm <= 0 || b.mm > 50) throw new Error('Cần nodeId hợp lệ và lượng tưới 0–50 mm');
      const event = { id: 'action_' + randomUUID(), kind: 'irrigation' as const, nodeId: b.nodeId, atHour: engine.hour, durationHours: engine.config.stepMinutes / 60, value: b.mm };
      if (engine.config.events.length >= 1000) throw new Error('Đã đạt giới hạn 1.000 sự kiện');
      engine.config.events.push(event);
      fs.appendFileSync(path.join(dataDir, `${engine.runId}.actions.jsonl`), JSON.stringify(event) + '\n');
      // Keep a complete replay manifest locally; cloud samples carry the interventions separately.
      manifest.actions ||= [];
      (manifest.actions as unknown[]).push(event);
      fs.writeFileSync(path.join(dataDir, `${engine.runId}.manifest.json`), JSON.stringify(manifest, null, 2));
    } else return json(404, { error: 'Không có endpoint' });
    return json(200, publicState());
  } catch (e) { return json(400, { error: e instanceof Error ? e.message : 'Yêu cầu không hợp lệ' }); }
});
setInterval(async () => {
  if (busy) return; busy = true;
  try {
    if (running && Date.now() >= nextTick) { step(1); nextTick = Date.now() + cadenceMs; }
    await cloud.flush(new Set(latest.filter(s => !s.groundTruth.gatewayOnline).map(s => s.gatewayId)));
  } catch (e) { error = e instanceof Error ? e.message : 'Lỗi mô phỏng'; running = false; }
  finally { busy = false; }
}, 250);
if (standalone) {
  startStandalone();
  void checkSchedule();
  setInterval(() => void checkSchedule(), 1000);
}
const bind = standalone
  ? (process.argv.includes('--container') ? '0.0.0.0' : '127.0.0.1')
  : process.env.FARMOS_LAB_BIND || '127.0.0.1';
server.listen(port, bind, () => console.log(`FarmOS Simulation Lab: http://127.0.0.1:${port} (${standalone ? 'standalone' : 'cloud paused'})`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
