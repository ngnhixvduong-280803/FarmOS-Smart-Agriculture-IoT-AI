import { cropCoefficient, crops, soils } from './catalog.js';
import type { Advice } from './advisor.js';
import type { Sample } from './engine.js';
import type { ForecastHour, NodeWeather } from './standalone-weather.js';

const round = (value: number) => Math.round(value * 100) / 100;

export function deviceHealth(running: boolean, cadenceMs: number, packetPresent: boolean, lastReceivedAt: number | null, now = Date.now()) {
  const ageMs = lastReceivedAt === null ? null : Math.max(0, now - lastReceivedAt);
  const status = !running ? 'paused' : !packetPresent ? 'offline'
    : ageMs === null || ageMs > cadenceMs * 3 ? 'stale' : 'online';
  return { status, ageMs, lastReceivedAt, cadenceMs, source: 'simulated_telemetry', firmwareVersion: null };
}

export class IrrigationFollowup {
  private baseline?: { moisture: number; hour: number };
  private attempt?: {
    hour: number; requestedMm: number; before: number | null;
    after: number | null; afterHour: number | null;
  };

  record(hour: number, stepHours: number, requestedMm: number | undefined, moisture: number | undefined) {
    if (requestedMm !== undefined) {
      const before = this.baseline && Math.abs(hour - stepHours - this.baseline.hour) < 1e-6
        ? this.baseline.moisture : null;
      this.attempt = { hour, requestedMm, before, after: null, afterHour: null };
    }
    if (this.attempt && this.attempt.afterHour === null && moisture !== undefined &&
        hour >= this.attempt.hour && hour - this.attempt.hour <= 6) {
      this.attempt.after = moisture;
      this.attempt.afterHour = hour;
    }
    this.baseline = moisture === undefined ? undefined : { moisture, hour };
  }

  report(hour: number) {
    const attempt = this.attempt;
    if (!attempt) return { status: 'no_attempt' as const };
    const deltaVwc = attempt.before === null || attempt.after === null ? null : round(attempt.after - attempt.before);
    const status = deltaVwc !== null ? 'compared' : (attempt.before === null || hour - attempt.hour > 6) ? 'insufficient' : 'waiting';
    return { ...attempt, status, deltaVwc, deliveredMm: null, source: 'simulated_command_and_vwc' };
  }
}

function waterModel(context: Sample['context'] | undefined, advice: Advice | undefined) {
  if (!context || advice?.moisture === undefined || advice.threshold === undefined || advice.action === 'check_sensor') return;
  const crop = crops.find(item => item.id === context.cropId);
  const soil = soils.find(item => item.id === context.soilId);
  if (!crop || !soil) return;
  const initialVwc = advice.moisture;
  const depth = crop.rootM * 1000;
  const threshold = advice.threshold;
  const dose = Math.min(20, Math.max(0, Math.ceil((soil.fc * 100 - initialVwc) * depth / 90)));
  const project = (hours: ForecastHour[], delayHours: number | null, includeRain: boolean) => {
    let water = initialVwc * depth / 100;
    return hours.map((hour, index) => {
      const kc = cropCoefficient(crop, context.ageDays + index / 24);
      water += (includeRain ? hour.rainMm : 0) + (delayHours === index ? dose * 0.9 : 0);
      const et = Math.min(hour.et0Mm * kc, Math.max(0, water - soil.wp * depth));
      water = Math.min(soil.saturation * depth, water - et);
      water -= Math.min(soil.drainageMmDay / 24, Math.max(0, water - soil.fc * depth));
      return water * 100 / depth;
    });
  };
  return { project, dose, initialVwc, threshold, wetThreshold: soil.fc * 100 + 2, areaM2: context.areaM2 };
}

export function irrigationSchedule(context: Sample['context'] | undefined, advice: Advice | undefined, weather: NodeWeather) {
  const model = waterModel(context, advice);
  if (!model) return { status: 'soil_unavailable' as const };
  if (weather.status !== 'ready' || weather.hours.length < 24) return { status: 'weather_unavailable' as const };
  const hours = weather.hours.slice(0, 24);
  const delays: Array<number | null> = model.dose > 0 ? [null, 0, 6, 12] : [null];
  const simulate = (delayHours: number | null, includeRain: boolean) => {
    const values = model.project(hours, delayHours, includeRain);
    const dryHours = values.filter(value => value < model.threshold).length;
    const wetHours = values.filter(value => value > model.wetThreshold).length;
    const mm = delayHours === null ? 0 : model.dose;
    return { delayHours, mm, liters: round(mm * model.areaM2), dryHours, wetHours,
      finalVwc: round(values[values.length - 1]), score: dryHours + 2 * wetHours + mm / 8 };
  };
  const options = delays.map(delay => simulate(delay, true)).sort((a, b) => a.score - b.score);
  const dryWeatherOptions = delays.map(delay => simulate(delay, false)).sort((a, b) => a.score - b.score);
  return {
    status: 'ready' as const, source: 'synthetic_vwc_and_weather_scenario', startsAt: hours[0].endAt - 3600_000,
    selected: options[0], withoutRain: dryWeatherOptions[0], options,
    rainSensitive: options[0].delayHours !== dryWeatherOptions[0].delayHours,
  };
}

export function weeklyForecast(context: Sample['context'] | undefined, advice: Advice | undefined, weather: NodeWeather) {
  const model = waterModel(context, advice);
  if (!model) return { status: 'soil_unavailable' as const };
  if (weather.status !== 'ready' || weather.hours.length < 168) return { status: 'weather_unavailable' as const };
  const hours = weather.hours.slice(0, 168);
  const withRain = model.project(hours, null, true);
  const withoutRain = model.project(hours, null, false);
  const startsAt = hours[0].endAt - 3600_000;
  const firstBelow = (values: number[]) => {
    if (model.initialVwc < model.threshold) return startsAt;
    const index = values.findIndex(value => value < model.threshold);
    return index < 0 ? null : hours[index].endAt;
  };
  const days = Array.from({ length: 7 }, (_, index) => {
    const start = index * 24;
    const end = start + 24;
    const wet = withRain.slice(start, end), dry = withoutRain.slice(start, end);
    return {
      day: index + 1, startsAt: hours[start].endAt - 3600_000, endsAt: hours[end - 1].endAt,
      rainMm: round(hours.slice(start, end).reduce((total, hour) => total + hour.rainMm, 0)),
      vwcWithRain: round(wet[23]), vwcWithoutRain: round(dry[23]),
      dryHoursWithRain: wet.filter(value => value < model.threshold).length,
      dryHoursWithoutRain: dry.filter(value => value < model.threshold).length,
    };
  });
  return { status: 'ready' as const, source: 'synthetic_vwc_and_weather_scenario', weatherFetchedAt: weather.fetchedAt,
    threshold: round(model.threshold), days,
    firstBelowWithRain: firstBelow(withRain), firstBelowWithoutRain: firstBelow(withoutRain),
    trajectory: [
      { at: startsAt, withRain: round(model.initialVwc), withoutRain: round(model.initialVwc) },
      ...hours.map((hour, index) => ({
        at: hour.endAt, withRain: round(withRain[index]), withoutRain: round(withoutRain[index]),
      })),
    ],
  };
}
