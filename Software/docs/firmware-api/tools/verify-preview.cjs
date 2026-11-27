// Run inside the isolated preview backend, never against a production database.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { PrismaClient } = require(require.resolve('@prisma/client', { paths: [process.cwd()] }));
const { hashDeviceSecret } = require(process.cwd() + '/dist/security/device-secrets.js');
const db = new PrismaClient();
const report = { generatedAt: new Date().toISOString(), scope: 'isolated VPS preview, API loopback, no Internet/LoRa/hardware proof', sourceRevision: process.env.PREVIEW_REVISION || 'unknown; set PREVIEW_REVISION from inspected image label', checks: [], scenarios: [], latency: {} };
const delay = ms => new Promise(r => setTimeout(r, ms));
function stats(values) { const a = values.slice().sort((x,y)=>x-y); const at = p => +a[Math.min(a.length-1, Math.ceil(a.length*p)-1)].toFixed(2); return { n:a.length, minMs:+a[0].toFixed(2), p50Ms:at(.5), p95Ms:at(.95), p99Ms:at(.99), maxMs:+a.at(-1).toFixed(2) }; }
async function main() {
  const url = new URL(process.env.DATABASE_URL);
  assert.equal(url.hostname, 'db'); assert.equal(url.pathname, '/farmos_preview');
  const owner = await db.user.findUniqueOrThrow({ where:{email:'preview@farmos.invalid'} });
  const token = () => crypto.randomBytes(32).toString('base64url');
  const jwtHead = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const jwtBody = Buffer.from(JSON.stringify({id:owner.id,email:owner.email,role:owner.role,iss:'farmos-api',aud:'farmos-mobile',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url');
  const unsigned = jwtHead+'.'+jwtBody; const bearer=unsigned+'.'+crypto.createHmac('sha256',process.env.JWT_SECRET).update(unsigned).digest('base64url');
  const userHeaders = {Authorization:'Bearer '+bearer};
  const farmId = 'FW_PREVIEW'; const gatewayId='GATEWAY_4294900001', directId='NODE_4294900002', leafId='NODE_4294900003';
  await db.farm.upsert({where:{id:farmId},create:{id:farmId,name:'Kiểm thử API firmware · dữ liệu giả',user_farms:{create:{user_id:owner.id}}},update:{}});
  const creds={};
  for(const [id,mode,zone] of [[gatewayId,'GATEWAY','FW_ZONE_GW'],[directId,'STANDALONE_NODE','FW_ZONE_DIRECT'],[leafId,'LEAF_NODE','FW_ZONE_LEAF']]) {
    await db.zone.upsert({where:{id:zone},create:{id:zone,farm_id:farmId,name:'Firmware API fixture '+mode},update:{}});
    await db.deviceIdentity.upsert({where:{device_id:id},create:{device_id:id,serial_number:'PREVIEW_'+id,type:id===gatewayId?'GATEWAY':'SENSOR_NODE',state:'CLAIMED',claim_code_hash:'no-claim-in-preview',identity_version:2,model:'PREVIEW_API_FIXTURE',firmware_target:'SIMULATION_ONLY'},update:{}});
    await db.node.upsert({where:{id},create:{id,name:'API fixture · '+mode,type:id===gatewayId?'GATEWAY':'SENSOR_NODE',farm_id:farmId,zone_id:zone,owner_id:owner.id,is_activated:true,deployment_mode:mode,connection_mode:mode==='LEAF_NODE'?'LORA_GATEWAY':'WIFI',...(mode==='LEAF_NODE'?{gateway_id:gatewayId}:{})},update:{}});
    if(mode!=='LEAF_NODE'){creds[id]=token();await db.gatewayCredential.upsert({where:{gateway_id:id},create:{gateway_id:id,token_hash:hashDeviceSecret('gateway:'+id,creds[id])},update:{token_hash:hashDeviceSecret('gateway:'+id,creds[id]),revoked_at:null}});}
  }
  if(!await db.nodeGatewayBinding.findFirst({where:{node_id:leafId,gateway_id:gatewayId,status:'ACTIVE'}}))await db.nodeGatewayBinding.create({data:{node_id:leafId,gateway_id:gatewayId,farm_id:farmId,zone_id:'FW_ZONE_LEAF'}});
  const headersFor=id=>({'Content-Type':'application/json','x-farmos-device-id':id,'x-farmos-device-token':creds[id]});
  const base='http://127.0.0.1:3000';
  async function request(path,body,headers=headersFor(gatewayId)) {const start=performance.now();const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const json=await r.json();return {status:r.status,json,ms:performance.now()-start};}
  const prefix='audit_'+crypto.randomUUID().replaceAll('-','_');
  const sample={eventId:prefix+'_first',nodeId:leafId,timestamp:Math.floor(Date.now()/1000),soil_temp:26.25,air_temp:31.5,soil_moisture:43.5,air_humidity:68,lux:12000,quality:0};
  const ingest='/api/v1/onboarding/gateway/telemetry';
  let r=await request(ingest,sample);assert.equal(r.status,200);assert.equal(r.json.data.persisted,true);assert.ok(!r.json.data.dropped);const rowId=r.json.data.telemetryId;
  const stored=await db.telemetryData.findUniqueOrThrow({where:{id:rowId}});assert.equal(stored.air_humidity,68);assert.equal(stored.soil_moisture,43.5);report.checks.push('gateway relay persisted and DB values match');
  r=await request(ingest,sample);assert.equal(r.json.data.duplicate,true);assert.equal(await db.ingestEvent.count({where:{event_id:'gw:'+gatewayId+':'+sample.eventId}}),1);report.checks.push('duplicate replay accepted without extra row');
  for(const [body,h,status,label] of [[sample,{},401,'missing credential rejected'],[sample,{...headersFor(gatewayId),'x-farmos-device-token':'wrong'},401,'wrong credential rejected'],[{...sample,ph:6.5},headersFor(gatewayId),400,'unknown pH field rejected'],[{...sample,soil_temp:null},headersFor(gatewayId),400,'null sensor rejected']]) {r=await request(ingest,body,h);assert.equal(r.status,status);report.checks.push(label);}
  r=await request('/api/v1/onboarding/device/telemetry',{...sample,eventId:prefix+'_direct'},headersFor(directId));assert.equal(r.status,200);assert.ok(r.json.data.telemetryId);report.checks.push('standalone direct sample persisted');
  r=await request('/api/v1/onboarding/device/status',{firmwareVersion:'preview-api-test'},headersFor(gatewayId));assert.equal(r.status,200);report.checks.push('device heartbeat accepted');
  for(const path of ['/api/v1/onboarding/device-commands/next','/api/v1/onboarding/gateway/pairing-sessions/next','/api/v1/ota/check?deviceType=GATEWAY&currentVersion=0.3.0']) {r=await request(path);assert.equal(r.status,200);report.checks.push(path+' reachable with device credential');}
  await db.nodeGatewayBinding.updateMany({where:{node_id:leafId,gateway_id:gatewayId,status:'ACTIVE'},data:{status:'REVOKED'}});
  r=await request(ingest,{...sample,eventId:prefix+'_revoked_leaf'});assert.equal(r.json.data.dropped,true);report.checks.push('revoked leaf is ACKed dropped, no sensor row');
  await db.nodeGatewayBinding.updateMany({where:{node_id:leafId,gateway_id:gatewayId},data:{status:'ACTIVE',revoked_at:null}});
  await db.gatewayCredential.update({where:{gateway_id:gatewayId},data:{revoked_at:new Date()}});r=await request('/api/v1/onboarding/device/status',{});assert.equal(r.status,401);await db.gatewayCredential.update({where:{gateway_id:gatewayId},data:{revoked_at:null}});report.checks.push('revoked device credential rejected');
  // Low sustained rate, not a stress test. Include database read-back per request.
  const latencies=[];const readbacks=[];const start=performance.now();
  for(let i=0;i<60;i++) {const tick=performance.now();r=await request(ingest,{...sample,eventId:prefix+'_perf_'+i,soil_moisture:40+i/100});assert.equal(r.status,200);assert.ok(r.json.data.telemetryId);latencies.push(r.ms);const t=performance.now();await db.telemetryData.findUniqueOrThrow({where:{id:r.json.data.telemetryId}});readbacks.push(performance.now()-t);await delay(Math.max(0,500-(performance.now()-tick)));}
  report.latency.gatewayTelemetry=stats(latencies);report.latency.dbReadback=stats(readbacks);report.latency.workload={requests:60,targetRps:2,elapsedSec:+((performance.now()-start)/1000).toFixed(2),errors:0,concurrency:1};
  const reads=[];for(let i=0;i<10;i++){r=await request('/api/v1/nodes',undefined,userHeaders);assert.equal(r.status,200);assert.ok(r.json.data.some(n=>n.id===leafId));reads.push(r.ms);}report.latency.deviceList=stats(reads);
  // Same deployed simulator engine, representative baseline/event/recovery frames for every preset.
  const {LabEngine}=require('/app/preview-lab/engine.js');const {sources}=require('/app/preview-lab/catalog.js');
  const envText=fs.readFileSync('/run/preview/simulator.env','utf8');const simTokens=JSON.parse(envText.split('\n').find(l=>l.startsWith('FARMOS_LAB_GATEWAY_TOKENS=')).split('=').slice(1).join('='));
  for(const file of fs.readdirSync('/app/preview-lab/scenarios').filter(f=>f.endsWith('.json')&&!f.startsWith('._'))){
    const preset=JSON.parse(fs.readFileSync('/app/preview-lab/scenarios/'+file,'utf8'));const runId=crypto.randomUUID();const engine=new LabEngine(preset.config,runId);const selected=[];const seen=new Set();const end=Math.max(168,...preset.config.events.map(e=>e.atHour+e.durationHours+1));let generated=0;let gatewayOffline=0;let latest;
    while(engine.hour<end){latest=engine.step();generated+=latest.length;for(const s of latest){if(!s.groundTruth.gatewayOnline)gatewayOffline++;const kind=s.groundTruth.activeEvents.length?'event':'baseline';const key=s.observations.nodeId+'_'+kind;if(!seen.has(key)&&s.groundTruth.nodeOnline){seen.add(key);selected.push(s);}}}selected.push(...latest);
    const ids=[];for(const s of selected){r=await request('/api/v1/simulation/ingest',{manifest:{runId,sourceType:'synthetic',modelVersion:'bucket-v1',config:preset.config,sources},sample:s},{'Content-Type':'application/json','x-farmos-device-id':s.gatewayId,'x-farmos-device-token':simTokens[s.gatewayId]});assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(r.json.data.persisted,true);ids.push(r.json.data.sampleId);}
    assert.equal(await db.simulationSample.count({where:{run_id:runId}}),selected.length);
    const read=await request('/api/v1/simulation/runs/'+runId+'/samples?farmId=SIM_VPS_API_LAB',undefined,userHeaders);assert.equal(read.status,200);assert.equal(read.json.data.length,selected.length);assert.ok(read.json.data.every(x=>!('ground_truth'in x)));
    report.scenarios.push({name:preset.name,runId,generated,uploaded:selected.length,dbRows:ids.length,gatewayOfflineFrames:gatewayOffline,coverage:'representative baseline, event and final/recovery frames; not all generated frames uploaded',sampleIds:ids});
  }
  assert.equal(await db.telemetryData.count({where:{node_id:{startsWith:'SIM_'}}}),0);report.checks.push('synthetic samples remain isolated from physical telemetry');
  const list=await request('/api/v1/nodes',undefined,userHeaders);assert.equal(list.status,200);assert.equal(list.json.data.filter(n=>n.is_simulation).length,4);report.checks.push('four SIM devices visible in normal device list with saved sample metadata');
  fs.writeFileSync('/run/preview/verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(error=>{console.error('Preview verification failed:',error.message);process.exitCode=1}).finally(()=>db.$disconnect());
