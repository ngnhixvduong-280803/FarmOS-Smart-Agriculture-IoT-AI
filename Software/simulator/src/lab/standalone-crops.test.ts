import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crops, defaultConfig, soils, standalonePresets } from './catalog.js';
import { validateConfig } from './engine.js';

test('standalone presets retain each crop profile and use a soil-specific dry starting point', () => {
  const identity = { id: 'SIM_NODE_TEST', gatewayId: 'SIM_NODE_TEST', zoneId: 'SIM_ZONE_TEST' };
  for (const profile of defaultConfig().nodes) {
    const presets = standalonePresets(identity, profile.cropId);
    for (const preset of presets) {
      assert.equal(validateConfig(preset.config).nodes.length, 1);
      assert.equal(preset.config.nodes[0].cropId, profile.cropId);
      assert.equal(preset.config.nodes[0].id, identity.id);
    }
    assert.deepEqual(presets[0].config.nodes[0], { ...profile, ...identity });
    const dry = presets[1].config.nodes[0];
    const crop = crops.find(item => item.id === dry.cropId)!;
    const soil = soils.find(item => item.id === dry.soilId)!;
    assert.ok(dry.initialVwc >= soil.wp && dry.initialVwc < soil.fc - crop.depletionP * (soil.fc - soil.wp));
  }
  assert.throws(() => standalonePresets(identity, 'unknown'));
});
