import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { askDeepSeek } from './deepseek.js';

test('DeepSeek request uses server key and only supplied simulation data', async () => {
 let payload = '';
 const mock: typeof fetch = async (_url, options) => {
   assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-key');
   payload = String(options?.body);
   return new Response(JSON.stringify({choices:[{message:{content:'Trả lời kiểm thử'}}]}), {status:200});
 };
 assert.equal(await askDeepSeek('test-key','Có cảnh báo không?',[],[],2,[],mock),'Trả lời kiểm thử');
 assert.match(payload,/synthetic/);
 assert.doesNotMatch(payload,/test-key|groundTruth/);
});
test('DeepSeek failures do not expose server response', async () => {
 const mock: typeof fetch = async () => new Response('private upstream detail', {status:401});
 await assert.rejects(askDeepSeek('test-key','hỏi',[],[],0,[],mock), /HTTP 401/);
});
