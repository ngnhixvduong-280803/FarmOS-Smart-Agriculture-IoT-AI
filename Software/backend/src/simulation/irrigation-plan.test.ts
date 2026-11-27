import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareIrrigation, type GardenWeather } from './irrigation-plan';

function weather(mm: number, rainHour: number): GardenWeather {
  return {
    fetchedAt: 0,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      endAt: (hour + 1) * 3600_000, rain: hour === rainHour ? mm : 0, et0: 0.18,
    })),
  };
}

for (const [soil, crop, moisture, rain] of [
  ['silt', 'mustard-greens', 26.5, 12],
  ['silty-clay', 'tomato', 30, 12],
] as const) {
  test(`${crop}: irrigation depends on rain timing and simulated soil moisture`, () => {
    const history = [{ hour: 0, moisture, temperature: 27 }];
    const dry = compareIrrigation(soil, crop, 18, history, weather(0, 0))!;
    const early = compareIrrigation(soil, crop, 18, history, weather(rain, 0))!;
    const late = compareIrrigation(soil, crop, 18, history, weather(rain, 18))!;
    assert.equal(dry.options[0].delay, 0);
    assert.equal(early.options[0].delay, null);
    assert.match(early.reason, /Hoãn tưới/);
    assert.equal(late.options[0].delay, 0);
  });
}

test('all options remaining dry produce an unresolved warning', () => {
  const result = compareIrrigation('silt', 'mustard-greens', 18,
    [{ hour: 0, moisture: 15, temperature: 27 }], weather(0, 0))!;
  assert.equal(result.unresolved, true);
  assert.match(result.reason, /chưa khắc phục/);
});
