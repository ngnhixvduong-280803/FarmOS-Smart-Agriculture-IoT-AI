import type { Advice } from './advisor.js';
import type { Sample } from './engine.js';
import { irrigationSchedule, weeklyForecast } from './standalone-operations.js';
import type { ForecastHour, NodeWeather } from './standalone-weather.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
// 06:00 Vietnam time is 23:00 UTC on the preceding date.
export function scheduleSlots(now: number) {
  const daily = Math.floor((now - 23 * HOUR) / DAY) * DAY + 23 * HOUR;
  return { daily, hourly: Math.floor(now / HOUR) * HOUR };
}

type Input = {
  sampleId: string | null;
  context?: Sample['context'];
  advice?: Advice;
  weather: NodeWeather;
};
type Plan = ReturnType<typeof irrigationSchedule>;
type Week = ReturnType<typeof weeklyForecast>;

function weatherChanged(previous: ForecastHour[], current: ForecastHour[]) {
  const byEnd = new Map(previous.map(hour => [hour.endAt, hour]));
  let rain = 0;
  let et0 = 0;
  for (const hour of current) {
    const old = byEnd.get(hour.endAt);
    if (!old) continue;
    rain += Math.abs(hour.rainMm - old.rainMm);
    et0 += Math.abs(hour.et0Mm - old.et0Mm);
    if ((hour.rainProbability >= 60) !== (old.rainProbability >= 60) && Math.max(hour.rainMm, old.rainMm) >= 0.5) return true;
  }
  return rain >= 1 || et0 >= 0.5;
}

export class StandaloneSchedule {
  private week?: { slotAt: number; calculatedAt: number; sampleId: string | null; forecast: Week };
  private plan?: { calculatedAt: number; sampleId: string | null; result: Plan };
  private check?: { slotAt: number; checkedAt: number; sampleId: string | null; reason: string; updated: boolean };
  private anchor?: { moisture?: number; action?: Advice['action']; hours: ForecastHour[] };
  private changedAt = 0;
  private processedChange = 0;

  invalidate() {
    this.changedAt++;
    this.week = undefined;
  }

  requestPlanUpdate() {
    this.changedAt++;
  }

  observe(advice?: Advice) {
    if (!this.anchor) return;
    const moisture = advice?.moisture;
    if (this.anchor.action !== advice?.action ||
        (moisture !== undefined && this.anchor.moisture !== undefined &&
          Math.abs(moisture - this.anchor.moisture) >= 1)) {
      this.requestPlanUpdate();
    }
  }

  due(now: number) {
    return this.check?.slotAt !== scheduleSlots(now).hourly || this.changedAt !== this.processedChange;
  }

  tick(now: number, input: Input) {
    if (!this.due(now)) return;
    const { daily, hourly } = scheduleSlots(now);
    const forced = this.changedAt !== this.processedChange;
    this.processedChange = this.changedAt;
    const { sampleId, context, advice, weather } = input;
    const next = irrigationSchedule(context, advice, weather);
    const hours = weather.status === 'ready' ? weather.hours.slice(0, 24) : [];
    const baseline = this.anchor;
    const moisture = advice?.moisture;
    let reason = '';
    if (!this.plan || !baseline) reason = 'initial';
    else if (forced) reason = 'input_event';
    else if (this.plan.result.status !== next.status) reason = 'input_availability';
    else if (baseline.action !== advice?.action ||
             (moisture !== undefined && baseline.moisture !== undefined && Math.abs(moisture - baseline.moisture) >= 1)) reason = 'soil_changed';
    else if (weatherChanged(baseline.hours, hours)) reason = 'weather_changed';
    else if (this.plan.result.status === 'ready' && now >= this.plan.result.startsAt + 24 * HOUR) reason = 'plan_expired';
    else if (this.plan.result.status === 'ready' && this.plan.result.selected.delayHours !== null &&
      now > this.plan.result.startsAt + this.plan.result.selected.delayHours * HOUR) reason = 'planned_time_passed';

    if (this.week?.slotAt !== daily || this.week.forecast.status !== 'ready' || reason) {
      this.week = { slotAt: daily, calculatedAt: now, sampleId, forecast: weeklyForecast(context, advice, weather) };
    }
    if (reason) {
      this.plan = { calculatedAt: now, sampleId, result: next };
      this.anchor = { moisture, action: advice?.action, hours };
    }
    this.check = { slotAt: hourly, checkedAt: now, sampleId, reason: reason || 'unchanged', updated: Boolean(reason) };
    return this.snapshot();
  }

  snapshot() {
    return { weekly: this.week ?? null, plan24h: this.plan ?? null, lastCheck: this.check ?? null };
  }
}
