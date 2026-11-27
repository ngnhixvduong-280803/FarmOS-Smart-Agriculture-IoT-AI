import type { Sample } from './engine.js';

export interface SoilProbeInput {
  adc?: number;
  calibration?: 'simulated' | 'bench' | 'none';
}

export function standaloneTelemetry(sample: Sample, input: SoilProbeInput = {}) {
  if (!sample.groundTruth.nodeOnline) return null;

  const frame = sample.observations;
  const calibration = input.calibration ?? 'simulated';
  // Synthetic endpoints for regular runs, firmware's temporary values for bench runs.
  const dry = calibration === 'bench' ? 0 : 300;
  const wet = calibration === 'bench' ? 1280 : 1500;
  const adc = input.adc ?? Math.round(dry + (wet - dry) * frame.soil_moisture / 100);
  const span = wet - dry;
  const delta = Math.min(span, Math.max(0, adc - dry));
  const moisture = Math.floor((delta * 10000 + Math.floor(span / 2)) / span) / 100;
  const bootId = Number.parseInt(sample.runId.slice(0, 8), 16);
  const centi = (value: number) => Math.round(value * 100) / 100;

  return {
    adc,
    calibration,
    vwcLinked: input.adc === undefined && calibration === 'simulated',
    payload: {
      eventId: `${frame.nodeId}-${bootId}-${sample.sequence}`,
      nodeId: frame.nodeId,
      quality: calibration === 'bench' ? 1 : 0,
      soil_temp: centi(frame.soil_temp),
      air_temp: centi(frame.air_temp),
      air_humidity: centi(frame.air_humidity),
      ...(calibration === 'none' ? {} : { soil_moisture: moisture }),
    },
  };
}
