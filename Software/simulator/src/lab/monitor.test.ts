import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { LabMonitor, answerLabQuestion } from './monitor.js';
import type { Advice } from './advisor.js';

test('monitor records changes and recovery once, per node', () => {
 const m = new LabMonitor('run');
 const ok: Advice = { nodeId:'n1', action:'observe', reason:'ổn', sources:[] };
 const dry: Advice = { ...ok, action:'review_irrigation', reason:'khô' };
 assert.equal(m.update(1,[ok]).length,0);
 assert.equal(m.update(2,[dry])[0].title,'Cần xem xét tưới');
 assert.equal(m.update(3,[dry]).length,0);
 assert.equal(m.update(4,[ok])[0].title,'Đã trở lại mức theo dõi');
});
test('chat refuses unsupported topics and missing data', () => {
 assert.match(answerLabQuestion('độ ẩm?', [], [], 0), /Chưa có quan sát/);
 const data: Advice[] = [{nodeId:'SIM_NODE_01', action:'no_data', reason:'Không nhận dữ liệu', sources:[]}];
 assert.match(answerLabQuestion('pH bao nhiêu?', data, [], 1), /chưa đủ dữ liệu/);
 assert.match(answerLabQuestion('tình trạng SIM_NODE_01', data, [], 1), /Không nhận dữ liệu/);
});
