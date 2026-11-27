import test from 'node:test';
import assert from 'node:assert/strict';
import {selectedFactoryReleaseId,visibleFactoryVersions} from '../src/firmwareSelection.ts';
const plain={id:'plain',version:'0.2.11',deviceType:'GATEWAY',firmwareTarget:'S3',flashStatus:'ACTIVE',factoryReady:true};
const secure={...plain,id:'secure',version:'0.2.11-secure'};
test('USB catalog exposes only ordinary active factory releases',()=>{
 assert.deepEqual(visibleFactoryVersions([plain,secure]),[plain]);
 assert.deepEqual(visibleFactoryVersions([secure]),[]);
 assert.deepEqual(visibleFactoryVersions([{...plain,flashStatus:'PAUSED'},{...plain,factoryReady:false}]),[]);
});
test('preserve selected firmware and reject retired secure variants',()=>{
 assert.equal(selectedFactoryReleaseId([plain,secure],'plain'),'plain');
 assert.throws(()=>selectedFactoryReleaseId([plain,secure],'secure'));
 assert.throws(()=>selectedFactoryReleaseId([plain],'missing'));
});
