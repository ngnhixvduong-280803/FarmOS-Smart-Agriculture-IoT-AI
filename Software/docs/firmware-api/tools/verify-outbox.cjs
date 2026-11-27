// Local SSH-forwarded preview simulator only. Original simulator port4010 is untouched.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {defaultConfig}=require(process.cwd()+'/simulator/dist/lab/catalog.js');
const origin='http://127.0.0.1:4011';const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function state(){const r=await fetch(origin+'/api/state');assert.equal(r.status,200);return r.json()}
async function action(path,body){const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(body)});assert.equal(r.status,200,path);return r.json()}
async function drained(){for(let i=0;i<40;i++){const s=await state();if(s.cloud.depth===0)return s;await sleep(250)}throw Error('Preview outbox failed to drain within10seconds')}
(async()=>{
 let result;
 try{
  await action('/api/run',{running:false,cadenceMs:5000});const before=await drained();assert.equal(before.cloud.origin,'http://127.0.0.1:3000');assert.equal(before.cloud.configuredGateways.length,1);
  const config=defaultConfig();config.startAt=new Date().toISOString();config.stepMinutes=60;config.events=[{id:'audit_gateway_offline',kind:'gateway_offline',atHour:0,durationHours:1,value:0}];
  await action('/api/reset',config);await action('/api/cloud',{enabled:true});const first=await action('/api/step',{count:1});assert.equal(first.cloud.depth,3);await sleep(2500);const held=await state();assert.equal(held.cloud.depth,3);assert.equal(held.cloud.persisted,before.cloud.persisted);
  await action('/api/step',{count:1});const recovered=await drained();assert.equal(recovered.cloud.persisted-before.cloud.persisted,6);assert.equal(recovered.cloud.depth,0);
  result={runId:first.runId,offlineHoldMs:2500,queuedWhileOffline:3,ackedAfterRecovery:6,remaining:0,receipts:Object.fromEntries(Object.entries(recovered.cloud.receipts).map(([id,r])=>[id,{eventId:r.eventId,sampleId:r.sampleId}]))};
  const p='docs/firmware-api/verification.json';const report=JSON.parse(fs.readFileSync(p));report.outboxRecovery=result;fs.writeFileSync(p,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{
  const config=defaultConfig();config.startAt=new Date().toISOString();config.stepMinutes=1;
  await action('/api/reset',config);await action('/api/cloud',{enabled:true});await action('/api/run',{running:true,cadenceMs:5000});
 }
})().catch(e=>{console.error('Outbox verification failed:',e.message);process.exitCode=1});
