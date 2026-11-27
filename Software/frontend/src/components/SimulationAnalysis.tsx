import { useEffect, useState } from 'react';
import { CircleAlert, CloudRain, Droplets, Sprout } from 'lucide-react';

interface NodeAnalysis {
  nodeId: string;
  crop: string;
  soil: string;
  samples: number;
  threshold?: number;
  usable?: boolean;
  qualityReason?: string;
  sensors?: { field: string; current: number | null; average: number | null; count: number }[];
  tomorrowPlan?: NodeAnalysis['irrigationPlan'];
  wetEpisodes?: number;
  irrigationResponse?: { mm: number; before: number; after: number; loss?: number; status: string };
  rapidDrying?: { drop: number; typicalDrop: number };
  wetNow?: { hours: number; threshold: number };
  moisture?: number;
  recommendation: string;
  soilRecommendation?: string;
  weatherUnavailable?: boolean;
  weatherLocationMissing?: boolean;
  agentSnapshot?: {
    generatedAt: number; quality: string;
    moisture?: { current: number | null; forecast: { horizonHours: number; moisture: number } | null };
    irrigation: { action: string; reason: string };
    deviceHealth: { status: string };
    ambient: { dewPointC: number } | null;
    weather: { status: string; rainMm24h?: number; maxRainProbability?: number };
    irrigationFollowup: { status: string; before?: number; after?: number; requestedMm?: number };
    forecastSchedule: {
      lastCheck: { checkedAt: number; updated: boolean } | null;
      plan24h: { calculatedAt: number; result: { status: string; selected?: { delayHours: number | null; mm: number; liters: number }; startsAt?: number } } | null;
      weekly: { calculatedAt: number; forecast: {
        status: string; threshold?: number; firstBelowWithRain?: number | null; firstBelowWithoutRain?: number | null;
        trajectory?: { at: number; withRain: number; withoutRain: number }[];
      } } | null;
    };
  };
  irrigationPlan?: {
    reason: string; unresolved: boolean; rainMm: number; startsAt: number; fetchedAt: number;
    options: { delay: number | null; mm: number; dryHours: number; wetHours: number; trajectory: number[] }[];
  };
  models?: { horizon: number; testCount: number; candidates: { name: string; mae: number; forecast: number }[] };
}
interface FarmAnalysis { id: string; name: string; nodes: NodeAnalysis[] }

const cropNames: Record<string, string> = { chilli: 'Ớt', tomato: 'Cà chua', 'mustard-greens': 'Cải xanh' };
const soilNames: Record<string, string> = { silt: 'Đất thịt bụi', 'loamy-sand': 'Đất cát pha', 'silty-clay': 'Đất sét pha bụi' };
const amount = (value: number) => value.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
const scheduleTime = (timestamp: number) => new Date(timestamp).toLocaleString('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
});

const sensorLabels: Record<string, [string, string]> = {
  soil_moisture: ['Độ ẩm đất', '%'], soil_temp: ['Nhiệt độ đất', '°C'],
  air_temp: ['Nhiệt độ không khí', '°C'], air_humidity: ['Độ ẩm không khí', '%'], lux: ['Ánh sáng', 'lux'],
};
const showReading = (value: number | null, unit: string) => value === null ? 'Chưa có số đo' : amount(value) + ' ' + unit;

function GardenNode({ node }: { node: NodeAnalysis }) {
  if (node.agentSnapshot) return <AgentGardenNode node={node} />;
  const plan = node.irrigationPlan;
  const best = plan?.options[0];
  const tomorrow = node.tomorrowPlan;
  const tomorrowBest = tomorrow?.options[0];
  const wait = plan?.options.find(option => option.delay === null);
  const needsWater = node.moisture !== undefined && node.threshold !== undefined && node.moisture < node.threshold;
  const alert = (!plan && node.recommendation.startsWith('Tạm giữ'));
  const watering = best && best.delay !== null && !alert && !plan?.unresolved;
  const title = alert ? 'Kiểm tra cảm biến'
    : plan?.unresolved ? 'Chưa đủ căn cứ để chốt lịch tưới'
      : needsWater ? 'Đất đang khô · cần kiểm tra' : watering ? 'Lịch tưới đề xuất' : plan ? 'Chưa cần lên lịch tưới' : node.weatherUnavailable ? 'Chờ dự báo thời tiết' : 'Theo dõi độ ẩm';
  const tone = alert ? 'bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100'
    : watering ? 'bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100'
      : 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-100';
  const Icon = alert ? CircleAlert : watering ? Droplets : CloudRain;

  return <div className="py-4 first:pt-0 last:pb-0">
    <div className="mb-2.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <h4 className="text-base font-semibold">{cropNames[node.crop] ?? node.crop}</h4>
      <span className="text-sm text-slate-500 dark:text-slate-400">{soilNames[node.soil] ?? node.soil}</span>
    </div>
    <div className={`flex items-start gap-3 rounded-lg px-4 py-3 ${tone}`}>
      <Icon aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        <p className="font-semibold">{title}</p>
        {watering && plan && <p className="mt-0.5 text-sm">
          {scheduleTime(plan.startsAt + (best.delay ?? 0) * 3600_000)} · {amount(best.mm)} lít nước/m²
        </p>}
        <p className="mt-1 text-sm leading-relaxed">
          {alert ? (node.qualityReason ?? 'Số đo mới chưa đủ tin cậy để lên lịch tưới.')
            : plan?.unresolved ? 'Các lịch hệ thống tính vẫn chưa đưa độ ẩm về mức tham chiếu. Lịch này cần được tính lại khi có số đo mới.'
            : watering && wait ? `Nếu chờ, đất có thể thiếu ẩm ${wait.dryHours} giờ. Lịch này còn ${best.dryHours} giờ thiếu ẩm.`
            : plan && best ? (best.dryHours > 0
              ? `Nếu chờ, dự báo vẫn còn ${best.dryHours} giờ thiếu ẩm. Theo dõi lại độ ẩm trước khi quyết định.`
              : best.wetHours > 0 ? 'Đất có thể còn ẩm cao. Theo dõi đất và kiểm tra thoát nước.'
                : 'Đất dự kiến giữ đủ ẩm trong 24 giờ tới nếu chờ.')
            : node.weatherLocationMissing ? 'Kiểm tra đất và nguồn nước. Thêm vị trí vườn trên bản đồ để hệ thống xem dự báo mưa và tính lịch tưới.' : node.weatherUnavailable ? 'Kiểm tra đất và nguồn nước. Hệ thống đang chờ dự báo mưa để tính lịch tưới.' : node.recommendation}
        </p>
      </div>
    </div>
    <p className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600 dark:text-slate-300">
      {node.moisture !== undefined && <span>Độ ẩm đất <strong className="tabular-nums">{amount(node.moisture)}%</strong>{needsWater && node.usable !== false && ' · dưới ngưỡng tham chiếu'}</span>}
      {plan && <span>Mưa dự báo 24 giờ <strong className="tabular-nums">{amount(plan.rainMm)} mm</strong></span>}
    </p>
    {node.soilRecommendation && <p className="mt-2 flex gap-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">
      <Sprout aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
      <span><strong>Kiểm tra thoát nước.</strong> {node.wetEpisodes ?? 'Nhiều'} đợt đất ẩm cao kéo dài. Thử làm luống cao ở một phần nhỏ rồi so độ ẩm sau mưa.</span>
    </p>}
    <div className="my-4 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <h5 className="font-semibold">Lịch tưới ngày mai</h5>
      <p className="mt-1 text-sm">{!tomorrow || !tomorrowBest ? (node.weatherLocationMissing ? 'Thêm vị trí vườn trên bản đồ để tính lịch.' : node.weatherUnavailable ? 'Chờ dự báo thời tiết để tính lịch.' : 'Chưa đủ số đo tin cậy để tính lịch.')
        : tomorrow.unresolved ? 'Hệ thống chưa chốt lịch tưới ngày mai. Kế hoạch sẽ cập nhật theo số đo và dự báo mới.'
          : tomorrowBest.delay === null ? 'Chưa cần lên lịch tưới.'
            : `Dự kiến tưới lúc ${scheduleTime(tomorrow.startsAt + tomorrowBest.delay * 3600_000)} · ${amount(tomorrowBest.mm)} lít/m².`}</p>
      {tomorrow && <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Mưa dự báo {amount(tomorrow.rainMm)} mm. Ước tính với giả định hôm nay chưa tưới.</p>}
    </div>
    {node.sensors?.length ? <dl className="my-4 grid grid-cols-2 gap-x-5 gap-y-4 border-y border-slate-200 py-4 dark:border-slate-700 sm:grid-cols-4">
      {node.sensors.filter(sensor => sensor.field !== 'lux').map(sensor => {
        const [label, unit] = sensorLabels[sensor.field] ?? [sensor.field, ''];
        return <div key={sensor.field}>
          <dt className="text-sm text-slate-500 dark:text-slate-400">{label}</dt>
          <dd className="mt-1 text-xl font-semibold tabular-nums">{showReading(sensor.current, unit)}</dd>
        </div>;
      })}
    </dl> : null}
    <details className="mt-2">
      <summary className="w-fit cursor-pointer rounded px-1 py-1 text-sm font-medium text-emerald-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 dark:text-emerald-300">Xem chi tiết phân tích</summary>
    {node.sensors && <div className="mt-5 overflow-x-auto">
      <h5 className="mb-2 font-semibold">Số đo trong vườn</h5>
      {node.usable === false && <p className="mb-2 text-sm text-amber-800 dark:text-amber-200">Kiểm tra cảm biến trước khi dùng các số đo bên dưới.</p>}
      <table className="w-full text-left text-sm tabular-nums">
        <thead><tr><th scope="col" className="py-2">Cảm biến</th><th scope="col" className="p-2">Mới nhất</th><th scope="col" className="p-2">Trung bình 24 giờ</th></tr></thead>
        <tbody>{node.sensors.filter(sensor => sensor.field !== 'lux').map(sensor => {
          const [label, unit] = sensorLabels[sensor.field] ?? [sensor.field, ''];
          return <tr key={sensor.field} className="border-t border-slate-200 dark:border-slate-700">
            <th scope="row" className="py-2 font-medium">{label}</th>
            <td className="p-2">{showReading(sensor.current, unit)}</td>
            <td className="p-2">{showReading(sensor.average, unit)} <span className="text-xs text-slate-500">({sensor.count}/24 mẫu)</span></td>
          </tr>;
        })}</tbody>
      </table>
      <p className="mt-1 text-xs text-slate-500">24 giờ theo đồng hồ mô phỏng.</p>
    </div>}
    {node.irrigationResponse && <div className="mb-3 rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-700">
      <p className="font-semibold">{({
        no_response: 'Sau lệnh tưới mô phỏng, độ ẩm chưa tăng rõ',
        rapid_loss: 'Đất mất ẩm nhanh sau tưới',
        wet: 'Đất ẩm cao kéo dài sau tưới',
        responded: 'Đất đã ẩm lên sau tưới',
      } as Record<string, string>)[node.irrigationResponse.status]}</p>
      <p className="mt-1">Lệnh tưới mô phỏng gần nhất: {amount(node.irrigationResponse.mm)} lít/m². Độ ẩm từ {amount(node.irrigationResponse.before)}% lên mức đo {amount(node.irrigationResponse.after)}% sau một giờ mô phỏng.</p>
      {node.irrigationResponse.status === 'no_response' && <p>Kiểm tra bồn, van và đầu tưới trước khi thử lại.</p>}
      {node.irrigationResponse.status === 'rapid_loss' && <p>Sau 6 giờ, đất mất {amount(node.irrigationResponse.loss ?? 0)} điểm phần trăm độ ẩm. Kiểm tra nước chảy tràn và so độ ẩm ở các luống.</p>}
      {node.irrigationResponse.status === 'wet' && <p>Kiểm tra nước đọng và đường thoát nước.</p>}
    </div>}
    {(node.rapidDrying || node.wetNow) && <div className="mb-3 space-y-2 rounded-lg bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
      {node.rapidDrying && <p><strong>Đất khô nhanh hơn thường lệ.</strong> Trong 6 giờ mô phỏng, độ ẩm giảm {amount(node.rapidDrying.drop)} điểm phần trăm, thường giảm khoảng {amount(node.rapidDrying.typicalDrop)} điểm. Hãy kiểm tra xem nước có chảy tràn hoặc luống bị khô không đều. Chỉ số này chưa xác định được nước rò ở đâu.</p>}
      {node.wetNow && <p><strong>{node.wetNow.hours >= 12 ? 'Đất ẩm cao kéo dài, có nguy cơ úng.' : 'Đất đang ẩm cao.'}</strong> Độ ẩm vượt mốc {amount(node.wetNow.threshold)}% trong {node.wetNow.hours} giờ mô phỏng liên tiếp. Kiểm tra nước đọng trên luống và lối thoát nước.</p>}
    </div>}
      <div className="mt-2 space-y-2 text-sm">
        <p>Mã thiết bị {node.nodeId} · {node.samples.toLocaleString('vi-VN')} mẫu theo giờ</p>
        {plan && <>
          <p>Hệ thống tính trước điều gì có thể xảy ra nếu chờ hoặc tưới vào các giờ khác nhau. Bảng dưới là kết quả mô phỏng theo dự báo mưa Open-Meteo.</p>
          <div className="overflow-x-auto"><table className="w-full min-w-[24rem] text-left tabular-nums">
            <thead><tr>{['Nếu chọn', 'Nước tưới (lít/m²)', 'Đất thiếu ẩm (giờ)', 'Đất ẩm cao (giờ)'].map(label => <th scope="col" className="p-2" key={label}>{label}</th>)}</tr></thead>
            <tbody>{plan.options.map(option => <tr key={option.delay ?? 'wait'} className="border-t border-slate-200 dark:border-slate-700">
              <td className="p-2">{option.delay === null ? 'Chờ, chưa tưới' : 'Tưới lúc ' + scheduleTime(plan.startsAt + option.delay * 3600_000)}</td>
              <td className="p-2">{option.mm}</td><td className="p-2">{option.dryHours}</td><td className="p-2">{option.wetHours}</td>
            </tr>)}</tbody>
          </table></div>
        </>}
        {node.models && <details><summary className="cursor-pointer">Xem số liệu kiểm thử mô hình</summary><ul className="list-disc pl-5">
          {node.models.candidates.map(model => <li key={model.name}>
            {model.name} · {amount(model.forecast)}% VWC sau {node.models?.horizon} giờ · MAE {model.mae.toFixed(2)} trên {node.models?.testCount} mẫu
          </li>)}
        </ul></details>}
      </div>
    </details>
  </div>;
}

function AgentGardenNode({ node }: { node: NodeAnalysis }) {
  const agent = node.agentSnapshot!;
  const schedule = agent.forecastSchedule;
  const weekly = schedule.weekly?.forecast;
  const points = weekly?.trajectory ?? [];
  const usable = agent.quality === 'ready' && node.usable !== false && agent.deviceHealth.status === 'online';
  const values = points.flatMap(point => [point.withRain, point.withoutRain]);
  const low = Math.floor(Math.min(weekly?.threshold ?? 0, ...values) - 2);
  const high = Math.ceil(Math.max(weekly?.threshold ?? 0, ...values) + 2);
  const x = (index: number) => 45 + index * 510 / Math.max(points.length - 1, 1);
  const y = (value: number) => 165 - (value - low) * 135 / Math.max(high - low, 1);
  const plan = usable ? schedule.plan24h?.result : undefined;
  const action = usable ? agent.irrigation.reason : 'Kiểm tra kết nối và cảm biến trước khi quyết định tưới.';
  const title = !usable ? 'Cần kiểm tra cảm biến'
    : agent.irrigation.action === 'inspect_dry_soil' ? 'Đất đang khô · cần kiểm tra'
      : agent.irrigation.action === 'consider_waiting_for_rain' ? 'Có thể chờ mưa' : 'Tiếp tục theo dõi';
  const soilReading = node.sensors?.find(sensor => sensor.field === 'soil_moisture')?.current;
  const threshold = weekly?.threshold ?? node.threshold;
  const start = points[0];
  const end = points[points.length - 1];
  const firstRainRecovery = weekly?.threshold === undefined ? undefined
    : points.find((point, index) => index > 0 && point.withRain >= weekly.threshold! && points[index - 1].withRain < weekly.threshold!);
  const waterTime = plan?.startsAt !== undefined && plan.selected?.delayHours != null
    ? scheduleTime(plan.startsAt + plan.selected.delayHours * 3600_000) : undefined;
  const planReady = plan?.status === 'ready' && plan.selected;
  return <div className="space-y-4 py-3">
    <p className="text-sm text-slate-500">{cropNames[node.crop] ?? node.crop} · {soilNames[node.soil] ?? node.soil}</p>
    <div className="rounded-lg bg-emerald-50 p-4 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100">
      <h4 className="font-semibold">{title}</h4>
      <p className="mt-1 text-sm leading-relaxed">{!usable ? action
        : !planReady ? `${action} Hiện chưa đủ dữ liệu để chốt kế hoạch tưới trong 24 giờ tới.`
        : plan.selected!.delayHours === null ? (agent.irrigation.action === 'inspect_dry_soil'
          ? 'Đất đang dưới ngưỡng tham chiếu. Hãy kiểm tra độ ẩm tại luống trước khi quyết định tưới.'
          : 'Trong 24 giờ tới, bạn có thể tiếp tục theo dõi và kiểm tra đất trước khi tưới.')
        : waterTime ? `Hãy kiểm tra đất và nguồn nước. Nếu đất khô, kế hoạch mô phỏng đề xuất cân nhắc tưới ${amount(plan.selected!.mm)} lít/m² vào ${waterTime}.`
        : action}</p>
      {usable && soilReading != null && threshold !== undefined && <p className="mt-2 text-sm leading-relaxed">
        Độ ẩm đất hiện tại {amount(soilReading)}%, {soilReading < threshold ? 'thấp hơn' : 'cao hơn'} mốc tham chiếu {amount(threshold)}%.
      </p>}
      {usable && weekly?.status === 'ready' && start && <p className="mt-2 text-sm leading-relaxed">
        {weekly.threshold !== undefined && start.withoutRain < weekly.threshold
          ? 'Đất đã thấp hơn mốc tham chiếu ở đầu dự báo. Hãy kiểm tra đất tại luống.'
          : weekly.firstBelowWithoutRain == null
          ? 'Nếu không mưa và chưa tưới, mô hình dự báo đất chưa xuống dưới mốc tham chiếu trong 7 ngày tới.'
          : `Nếu không mưa và chưa tưới, đất có thể xuống dưới mốc tham chiếu từ ${scheduleTime(weekly.firstBelowWithoutRain)}. Hãy kiểm tra đất trước thời điểm đó.`}
      </p>}
      <p className="mt-2 text-sm">Hệ thống chỉ đưa ra đề xuất. Bạn quyết định việc tưới.</p>
    </div>
    <dl className="grid grid-cols-2 gap-4 border-y border-slate-200 py-4 dark:border-slate-700 sm:grid-cols-4">
      {node.sensors?.filter(sensor => sensor.field !== 'lux').map(sensor => {
        const [label, unit] = sensorLabels[sensor.field] ?? [sensor.field, ''];
        return <div key={sensor.field}><dt className="text-sm text-slate-500">{label}</dt>
          <dd className="text-lg font-semibold">{showReading(sensor.current, unit)}</dd></div>;
      })}
    </dl>
    <p className="text-sm text-slate-600 dark:text-slate-300">
      {agent.weather.status === 'ready' ? `Dự báo 24 giờ tới có ${amount(agent.weather.rainMm24h ?? 0)} mm mưa. Xác suất mưa cao nhất theo giờ ${amount(agent.weather.maxRainProbability ?? 0)}%.` : 'Chưa có dự báo thời tiết. Kiểm tra vị trí trong Lab.'}
    </p>
    <p className="text-sm">{usable && agent.moisture?.forecast
      ? `Dự báo ${agent.moisture.forecast.horizonHours} giờ mô phỏng tới, độ ẩm đất khoảng ${amount(agent.moisture.forecast.moisture)}%.`
      : 'Dự báo 6 giờ đang chờ đủ số đo tin cậy.'}</p>
    <p className="text-sm">{!plan ? 'Đang chờ số đo và thời tiết để cập nhật kế hoạch 24 giờ.'
      : plan.status !== 'ready' || !plan.selected ? 'Chưa đủ dữ liệu để tính kế hoạch 24 giờ.'
      : plan.selected.delayHours === null ? (agent.irrigation.action === 'inspect_dry_soil'
        ? 'Kế hoạch 24 giờ chưa đề xuất giờ tưới. Kiểm tra đất tại chỗ trước khi quyết định.'
        : 'Kế hoạch 24 giờ: theo dõi, chưa cần tưới theo mô hình.')
      : `Kế hoạch thử: cân nhắc tưới ${amount(plan.selected.mm)} lít/m² lúc ${scheduleTime((plan.startsAt ?? 0) + plan.selected.delayHours * 3600_000)}.`}</p>
    {usable && weekly?.status === 'ready' && points.length > 1 && <details>
      <summary className="cursor-pointer font-medium text-emerald-800 dark:text-emerald-300">Xem dự báo độ ẩm 7 ngày</summary>
      {schedule.weekly?.calculatedAt && <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Bản dự báo tính lúc {scheduleTime(schedule.weekly.calculatedAt)}, từ số đo {amount(points[0].withRain)}% tại thời điểm đó.</p>}
      <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">Biểu đồ cho biết đất có thể ẩm hay khô dần trong 7 ngày tới, với giả định chưa tưới. Mức càng thấp, đất càng khô.</p>
      {weekly.threshold !== undefined && <p className="mt-2 text-sm font-medium text-amber-800 dark:text-amber-200">Mốc cần chú ý là {amount(weekly.threshold)}% độ ẩm đất. Khi xuống dưới mốc này, hãy kiểm tra đất tại luống.</p>}
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-700 dark:text-slate-200" aria-label="Chú thích biểu đồ">
        <li><span className="mr-2 inline-block w-6 align-middle border-t-[3px] border-emerald-700" aria-hidden="true" />Có mưa theo dự báo</li>
        <li><span className="mr-2 inline-block w-6 align-middle border-t-[3px] border-dashed border-blue-700" aria-hidden="true" />Không có mưa</li>
        <li><span className="mr-2 inline-block w-6 align-middle border-t-2 border-dashed border-amber-700" aria-hidden="true" />Mốc cần kiểm tra đất</li>
      </ul>
      <p className="mt-3 text-sm font-medium">Độ ẩm đất (%)</p>
      <div className="mt-3 overflow-x-auto"><svg viewBox="0 0 580 205" role="img" aria-label="Dự báo độ ẩm đất 7 ngày có mưa và không mưa" className="w-full min-w-[30rem]">
        {[0, 1, 2, 3].map(i => <g key={i}><line x1="45" x2="555" y1={30 + 45 * i} y2={30 + 45 * i} stroke="#dce7df" /><text x="37" y={34 + 45 * i} textAnchor="end" fontSize="10" fill="#53655a">{amount(high - i * (high - low) / 3)}</text></g>)}
        {weekly.threshold !== undefined && <line x1="45" x2="555" y1={y(weekly.threshold)} y2={y(weekly.threshold)} stroke="#986020" strokeDasharray="5 4" />}
        <polyline points={points.map((point, i) => `${x(i)},${y(point.withRain)}`).join(' ')} fill="none" stroke="#177453" strokeWidth="2.5" />
        <polyline points={points.map((point, i) => `${x(i)},${y(point.withoutRain)}`).join(' ')} fill="none" stroke="#315f94" strokeWidth="2.5" strokeDasharray="7 4" />
        {points.map((point, i) => <text key={point.at} x={x(i)} y="190" textAnchor="middle" fontSize="10" fill="#53655a">{new Date(point.at).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit' })}</text>)}
      </svg></div>
      <div className="mt-4 space-y-3 rounded-lg bg-slate-50 p-4 text-sm leading-relaxed text-slate-800 dark:bg-slate-800 dark:text-slate-100">
        <h5 className="font-semibold">Biểu đồ này nói gì về vườn của bạn?</h5>
        {weekly.threshold !== undefined && <p>
          <strong>Ở đầu dự báo:</strong> Độ ẩm đất khoảng {amount(start.withRain)}%,
          {start.withRain < weekly.threshold ? ' đã thấp hơn' : ' đang bằng hoặc cao hơn'} mốc cần chú ý {amount(weekly.threshold)}%.
          {start.withRain < weekly.threshold ? ' Hãy kiểm tra đất tại luống.' : ' Tiếp tục theo dõi đất.'}
        </p>}
        <p><strong>Nếu không mưa và chưa tưới:</strong> Đến cuối kỳ dự báo, độ ẩm ước tính khoảng {amount(end.withoutRain)}%.
          {weekly.threshold !== undefined && (end.withoutRain < weekly.threshold ? ' Mức này thấp hơn mốc cần chú ý.' : ' Mức này vẫn bằng hoặc cao hơn mốc cần chú ý.')}
          {weekly.threshold !== undefined && start.withoutRain >= weekly.threshold && weekly.firstBelowWithoutRain != null
            && ` Đất có thể xuống dưới mốc từ ${scheduleTime(weekly.firstBelowWithoutRain)}.`}
        </p>
        <p><strong>Nếu mưa đúng như dự báo và chưa tưới:</strong> Đến cuối kỳ, độ ẩm ước tính khoảng {amount(end.withRain)}%.
          {firstRainRecovery && ` Tại các mốc trên biểu đồ, độ ẩm dự kiến trở lại trên mốc cần chú ý vào khoảng ${scheduleTime(firstRainRecovery.at)}.`}
          {weekly.threshold !== undefined && !firstRainRecovery && end.withRain < weekly.threshold && ' Độ ẩm cuối kỳ vẫn thấp hơn mốc cần chú ý.'}
          {weekly.threshold !== undefined && start.withRain >= weekly.threshold && weekly.firstBelowWithRain != null
            && ` Đất có thể xuống dưới mốc từ ${scheduleTime(weekly.firstBelowWithRain)}.`}
        </p>
        <p>Đây là dự báo khi chưa tưới. Hãy kiểm tra đất thực tế và xem kế hoạch tưới 24 giờ ở phía trên trước khi quyết định.</p>
      </div>
      <p className="mt-2 text-xs text-slate-500">Dự báo được tính lại khi điều kiện thay đổi đáng kể và vào lúc 06:00 mỗi ngày.</p>
    </details>}
    <details><summary className="cursor-pointer text-sm font-medium text-emerald-800 dark:text-emerald-300">Xem tình trạng hệ thống</summary>
      <p className="mt-2 text-sm">Thiết bị {agent.deviceHealth.status === 'online' ? 'đang gửi dữ liệu' : 'chưa có dữ liệu mới'} · Cập nhật {scheduleTime(agent.generatedAt)}</p>
      {schedule.lastCheck && <p className="text-sm">Lần kiểm tra kế hoạch gần nhất {scheduleTime(schedule.lastCheck.checkedAt)}.</p>}
      {agent.irrigationFollowup.status === 'compared' && <p className="text-sm">Sau yêu cầu tưới mô phỏng {agent.irrigationFollowup.requestedMm} mm, độ ẩm đổi từ {amount(agent.irrigationFollowup.before ?? 0)}% sang {amount(agent.irrigationFollowup.after ?? 0)}% VWC.</p>}
    </details>
  </div>;
}

export function SimulationAnalysis({ farmId }: { farmId?: string }) {
  const [farms, setFarms] = useState<FarmAnalysis[]>([]);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function refresh() {
      try {
        const endpoint = farmId ? '/api/v1/simulation/farm-analysis?farmId=' + encodeURIComponent(farmId) : '/api/v1/simulation/analysis';
        const response = await fetch(endpoint, { signal: controller.signal });
        if (!response.ok) throw new Error('Unavailable');
        const payload = await response.json();
        if (!stopped) { setFarms(farmId ? (payload.data ? [payload.data] : []) : payload.data); setError(false); }
      } catch { if (!stopped) setError(true); }
      if (!stopped) setLoading(false);
      if (!stopped) timer = setTimeout(refresh, 10_000);
    }
    void refresh();
    return () => { stopped = true; clearTimeout(timer); controller.abort(); };
  }, [farmId]);
  const sorted = [...farms].sort((a, b) => a.id.localeCompare(b.id));
  const active = sorted.find(farm => farm.id === selected) ?? sorted[0];
  const gardenName = (farm: FarmAnalysis) => /^SIM_AGENT_[ABC]$/.test(farm.id) ? 'Vườn ' + farm.id.slice(-1) : farm.name;
  return <section className="rounded-xl border border-slate-200 bg-white px-4 py-5 dark:border-slate-700 dark:bg-slate-900 sm:px-6">
    <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">Dữ liệu mô phỏng</p>
    {error && <p role="status" className="mb-3 text-sm text-amber-800 dark:text-amber-200">Chưa tải được số liệu mới. {farms.length > 0 && 'Các đề xuất bên dưới là kết quả lần trước.'}</p>}
    {loading && <p role="status" className="text-sm">Đang tải tình trạng các vườn…</p>}
    {!loading && !error && farms.length === 0 && <p className="text-sm">Chưa có vườn mô phỏng.</p>}
    {active && <>
      {sorted.length > 1 && <div className="mb-4 flex flex-wrap gap-2" aria-label="Chọn vườn">
        {sorted.map(farm => <button key={farm.id} type="button" aria-pressed={active.id === farm.id}
          onClick={() => setSelected(farm.id)}
          className={`rounded-lg border px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-600 ${active.id === farm.id ? 'border-emerald-700 bg-emerald-700 text-white' : 'border-slate-300 dark:border-slate-700'}`}>
          {gardenName(farm)}{farm.nodes.length === 1 && ' · ' + (cropNames[farm.nodes[0].crop] ?? farm.nodes[0].crop)}
        </button>)}
      </div>}
      <article key={active.id}>
        <h3 className="mb-2 text-xl font-semibold">{gardenName(active)}</h3>
        {active.nodes.length === 0 && <p className="text-sm">Đang chờ số đo từ thiết bị.</p>}
        <div className="divide-y divide-slate-200 dark:divide-slate-700">
          {[...active.nodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).map(node => <GardenNode key={node.nodeId} node={node} />)}
        </div>
      </article>
    </>}
  </section>;
}
