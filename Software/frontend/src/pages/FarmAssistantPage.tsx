import { fetchNodes } from '../services/api.service';
import type { NodeDevice } from '../types';
import { ChevronDown } from 'lucide-react';
import { SimulationAnalysis } from '../components/SimulationAnalysis';
import React, { useEffect, useState } from 'react';
type Farm = { id: string; name: string };
type Report = { summary: { irrigationCount: number; completed: number; failed: number; truncated: boolean }; generatedAt: string; nodesChecked: number; findings: { agent: string; level: string; title: string; detail: string; observedAt?: string }[]; limitations: string[] };
const readings = [
  ['soil_moisture', 'Độ ẩm đất', '%'],
  ['soil_temp', 'Nhiệt độ đất', '°C'],
  ['air_temp', 'Nhiệt độ không khí', '°C'],
  ['air_humidity', 'Độ ẩm không khí', '%'],
] as const;
const number = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });

function FarmReadings({ farmId }: { farmId: string }) {
  const [devices, setDevices] = useState<NodeDevice[]>();
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setFailed(false);
    fetchNodes().then(nodes => {
      if (active) setDevices(nodes.filter(node => (node.farm?.id ?? node.farm_id) === farmId && node.is_activated && !node.is_simulation));
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [farmId, revision]);
  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-semibold">Số đo mới nhất</h2>
      <button type="button" onClick={() => setRevision(value => value + 1)} className="rounded-lg px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950">Làm mới số đo</button>
    </div>
    {failed && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">Không tải được số đo mới. Bạn có thể thử làm mới.</p>}
    {!failed && !devices && <p role="status" className="text-sm text-slate-500">Đang tải thiết bị…</p>}
    {devices?.length === 0 && <p className="text-sm text-slate-500">Vườn này chưa có thiết bị.</p>}
    {devices?.map(device => <article key={device.id} className="rounded-2xl bg-white p-5 dark:bg-slate-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="break-words font-semibold">{device.name || (device.type === 'GATEWAY' ? 'Trạm kết nối' : 'Thiết bị đo')}</h3>
        <span className={device.online ? 'text-sm text-emerald-700 dark:text-emerald-300' : 'text-sm text-slate-500 dark:text-slate-400'}>{device.online ? 'Đang kết nối' : 'Mất kết nối'}</span>
      </div>
      {(device.zone || device.latest_telemetry) && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {[device.zone?.name, device.latest_telemetry && 'Đo lần cuối ' + new Date(device.latest_telemetry.timestamp).toLocaleString('vi-VN')].filter(Boolean).join(' · ')}
      </p>}
      {device.type !== 'GATEWAY' && <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-slate-200 pt-4 dark:border-slate-700 sm:grid-cols-4">
        {readings.map(([key, label, unit]) => {
          const value = device.latest_telemetry?.[key];
          return <div key={key}>
            <dt className="text-sm text-slate-600 dark:text-slate-400">{label}</dt>
            <dd className={value == null ? 'mt-1 text-sm text-slate-500' : 'mt-1 text-2xl font-semibold tabular-nums'}>
              {value == null ? 'Chưa có số đo' : number.format(value) + ' ' + unit}
            </dd>
          </div>;
        })}
      </dl>}
    </article>)}
  </section>;
}

export function FarmAssistantPage({ isActive, isAdmin }: { isActive: boolean; isAdmin: boolean }) {
  const [showSimulation, setShowSimulation] = useState(false);
  const [farms, setFarms] = useState<Farm[]>([]); const [farmId, setFarmId] = useState('');
  const [report, setReport] = useState<Report | null>(null); const [error, setError] = useState('');
  useEffect(() => { let active = true; fetch('/api/v1/farms', { credentials: 'include' }).then(async r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => { if (active) { setFarms(d.data); setFarmId((d.data as Farm[]).find(farm => !farm.id.startsWith('SIM_'))?.id ?? d.data[0]?.id ?? ''); } }).catch(() => active && setError('Không tải được danh sách trang trại.')); return () => { active = false; }; }, []);
  const simulation = farmId.startsWith('SIM_');
  const allSimulation = isAdmin && showSimulation;
  useEffect(() => { if (!isActive || !farmId || simulation || allSimulation) return; let active = true; setReport(null); setError(''); fetch(`/api/v1/farm-assistant/${encodeURIComponent(farmId)}`, { credentials: 'include' }).then(async r => { if (!r.ok) throw new Error(); return r.json(); }).then(d => active && setReport(d.data)).catch(() => active && setError('Không tải được báo cáo.')); return () => { active = false; }; }, [allSimulation, farmId, isActive, simulation]);
  return <main className="mx-auto max-w-5xl space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <h1 className="text-2xl font-semibold tracking-tight">{allSimulation ? 'Vườn mô phỏng' : 'Tình hình vườn'}</h1>
      {isAdmin && <button type="button" onClick={() => setShowSimulation(value => !value)} className="rounded-md px-2 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-950">{allSimulation ? 'Về trang trại' : 'Xem các vườn mô phỏng'}</button>}
    </header>
    {allSimulation ? (isActive && <SimulationAnalysis />) : <>
    <label className="flex flex-col gap-2 text-sm font-semibold sm:flex-row sm:items-center sm:gap-3">
    <span className="shrink-0">Trang trại</span>
    <span className="relative min-w-0 w-full sm:max-w-lg">
      <select className="w-full appearance-none rounded-lg border border-slate-300 bg-white py-2.5 pl-3 pr-10 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:ring-offset-2 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-offset-slate-950" value={farmId} onChange={e => setFarmId(e.target.value)}>
        {farms.some(farm => !farm.id.startsWith('SIM_')) && <optgroup label="Vườn đang quản lý">
          {farms.filter(farm => !farm.id.startsWith('SIM_')).map(farm => <option key={farm.id} value={farm.id}>{farm.name}</option>)}
        </optgroup>}
        {farms.some(farm => farm.id.startsWith('SIM_')) && <optgroup label="Vườn mô phỏng">
          {farms.filter(farm => farm.id.startsWith('SIM_')).map(farm => <option key={farm.id} value={farm.id}>
            {/^SIM_AGENT_[ABC]$/.test(farm.id) ? 'Vườn ' + farm.id.slice(-1) + ' (mô phỏng)' : farm.name}
          </option>)}
        </optgroup>}
      </select>
      <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
    </span>
  </label>
    {simulation ? (isActive && <SimulationAnalysis key={farmId} farmId={farmId} />) : <>
      {error && <p role="alert" className="text-red-600">{error}</p>}
      {!farmId && !error && <p className="text-sm text-slate-500">Chưa có trang trại để kiểm tra.</p>}
      {farmId && !report && !error && <p role="status" className="text-sm text-slate-500">Đang tải tình hình vườn…</p>}
      {isActive && farmId && <FarmReadings key={farmId} farmId={farmId} />}
      {report && <section className="space-y-4 rounded-2xl bg-white p-5 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Tưới và các việc cần chú ý</h2>
        <p className="text-sm text-slate-500">{report.nodesChecked ? report.nodesChecked + ' thiết bị đã kiểm tra' : 'Chưa có thiết bị để đánh giá'}</p>
        <div className="border-t border-slate-200 pt-4 text-sm dark:border-slate-700">
          <h3 className="font-semibold">Tưới trong 24 giờ qua</h3>
          <p className="mt-1">{report.summary.irrigationCount
            ? `${report.summary.truncated ? 'Ít nhất ' : ''}${report.summary.irrigationCount} lệnh · ${report.summary.completed} hoàn thành · ${report.summary.failed} chưa thành công`
            : 'Chưa có lệnh tưới.'}</p>
        </div>
        {report.findings.map((item, i) => <article key={i} className="border-t border-slate-200 pt-4 dark:border-slate-700">
          <h3 className="font-semibold">{item.title}</h3>
          <p className="mt-1 text-sm">{item.detail}</p>
          {item.observedAt && <p className="mt-1 text-xs text-slate-500">{new Date(item.observedAt).toLocaleString('vi-VN')}</p>}
        </article>)}
      </section>}
    </>}
    </>}
  </main>;
}
