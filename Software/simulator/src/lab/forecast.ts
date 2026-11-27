export interface MoisturePoint {
  timestamp: number;
  moisture: number;
}

export function forecastMoisture(points: MoisturePoint[], saturation: number) {
  if (points.length < 6) return undefined;
  const latest = points[points.length - 1];
  const spanHours = (latest.timestamp - points[0].timestamp) / 3600;
  if (spanHours < 5) return undefined;

  const hours = points.map(point => (point.timestamp - latest.timestamp) / 3600);
  const meanHour = hours.reduce((sum, hour) => sum + hour, 0) / points.length;
  const meanMoisture = points.reduce((sum, point) => sum + point.moisture, 0) / points.length;
  const variance = hours.reduce((sum, hour) => sum + (hour - meanHour) ** 2, 0);
  const covariance = points.reduce((sum, point, index) =>
    sum + (hours[index] - meanHour) * (point.moisture - meanMoisture), 0);
  const slopePerHour = covariance / variance;
  const horizonHours = 6;
  const prediction = meanMoisture + slopePerHour * (horizonHours - meanHour);
  return {
    method: 'rolling_linear_regression',
    horizonHours,
    moisture: Math.max(0, Math.min(saturation, prediction)),
    slopePerHour,
    sampleCount: points.length,
    observedAt: latest.timestamp,
  } as const;
}
