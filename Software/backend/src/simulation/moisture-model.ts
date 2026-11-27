export interface Reading { hour: number; moisture: number; temperature: number }
const horizon = 6;

export function evaluateMoisture(readings: Reading[]) {
  const examples = [];
  const byHour = new Map(readings.map(reading => [reading.hour, reading]));
  function features(current: Reading) {
    const previous = byHour.get(current.hour - horizon);
    if (!previous) return undefined;
    return [(current.moisture - 25) / 20, (current.moisture - previous.moisture) / 10, (current.temperature - 25) / 15];
  }
  for (const current of readings) {
    const input = features(current);
    const future = byHour.get(current.hour + horizon);
    if (input && future) examples.push({ input, hour: current.hour, target: (future.moisture - current.moisture) / 10 });
  }
  const split = readings[Math.floor(readings.length * 0.75)]?.hour;
  const train = examples.filter(item => item.hour + horizon < split);
  const test = examples.filter(item => item.hour >= split);
  const latest = readings.at(-1);
  const input = latest && features(latest);
  if (train.length < 64 || test.length < 24 || !input || !latest) return undefined;

  const linear = [0, 0, 0, 0];
  const hidden = Array.from({ length: 8 }, (_, i) =>
    Array.from({ length: 4 }, (_, j) => Math.sin((i + 1) * (j + 1)) * 0.15));
  const output = [...hidden.map((_, i) => Math.cos(i) * 0.1), 0];
  const activate = (x: number[]) => hidden.map(unit => Math.tanh(unit.reduce((sum, weight, i) => sum + weight * x[i], 0)));
  const dot = (a: number[], b: number[]) => a.reduce((sum, weight, i) => sum + weight * b[i], 0);
  for (let epoch = 0; epoch < 24; epoch++) {
    for (const { input, target } of train) {
      const x = [...input, 1];
      const linearError = dot(linear, x) - target;
      linear.forEach((weight, i) => { linear[i] -= 0.006 * (linearError * x[i] + 0.01 * weight); });
      const values = activate(x);
      const error = dot(output, [...values, 1]) - target;
      hidden.forEach((unit, i) => {
        const gradient = error * output[i] * (1 - values[i] ** 2);
        unit.forEach((weight, j) => { unit[j] = weight - 0.006 * gradient * x[j]; });
      });
      output.forEach((weight, i) => { output[i] = weight - 0.006 * error * (values[i] ?? 1); });
    }
  }
  const candidates = [
    { name: 'Giữ nguyên', predict: (_x: number[]) => 0 },
    { name: 'Hồi quy Ridge', predict: (x: number[]) => dot(linear, [...x, 1]) },
    { name: 'Mạng nơ-ron MLP', predict: (x: number[]) => dot(output, [...activate([...x, 1]), 1]) },
  ].map(model => ({
    name: model.name,
    mae: test.reduce((sum, item) => sum + 10 * Math.abs(model.predict(item.input) - item.target), 0) / test.length,
    forecast: Math.max(0, Math.min(100, latest.moisture + 10 * model.predict(input))),
  }));
  // Held-out scores are reported for comparison, not used to choose a model.
  return { candidates, trainCount: train.length, testCount: test.length, horizon };
}
