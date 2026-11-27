// Run from the repository root against an SSH-forwarded isolated preview.
const fs=require('node:fs'), assert=require('node:assert/strict');
const {io}=require(require.resolve('socket.io-client',{paths:[process.cwd()+'/frontend']}));
(async()=>{
 const origin='http://127.0.0.1:4081';
 const login=JSON.parse(fs.readFileSync('.local-backups/api-preview/credentials.json','utf8'));
 const device=JSON.parse(fs.readFileSync('.local-backups/api-preview/fixture-token.json','utf8'));
 assert.equal(device.deviceId,'NODE_4294900002');
 const post=async(path,body,headers={})=>{const r=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});assert.equal(r.status,200,path);return r.json()};
 const signed=await post('/api/v1/auth/login',login);
 const session=await post('/api/v1/auth/mobile/session',{accessToken:signed.data.token});
 const socket=io(origin,{transports:['websocket'],auth:{token:session.data.accessToken},reconnection:false});
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Socket connection timeout')),10000);socket.once('connect',()=>{clearTimeout(timer);resolve()});socket.once('connect_error',e=>{clearTimeout(timer);reject(e)})});
  const started=performance.now();const moisture=47.25;
  const eventPromise=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Telemetry event timeout')),10000);socket.on('telemetry:update',event=>{if(event.nodeId===device.deviceId&&event.soil_moisture===moisture){clearTimeout(timer);resolve({event,ms:performance.now()-started})}})});
  const ack=await post('/api/v1/onboarding/device/telemetry',{eventId:'ws_check_'+crypto.randomUUID().replaceAll('-','_'),timestamp:Math.floor(Date.now()/1000),soil_temp:26.25,air_temp:31.75,air_humidity:69.5,soil_moisture:moisture,lux:12345,quality:0},{'x-farmos-device-id':device.deviceId,'x-farmos-device-token':device.deviceToken});
  assert.equal(ack.data.persisted,true);
  const {event,ms}=await eventPromise;for(const [key,value]of Object.entries({soil_temp:26.25,air_temp:31.75,air_humidity:69.5,soil_moisture:moisture,lux:12345}))assert.equal(event[key],value);
  const result={sourceRevision:'4fd7cb5',path:'Mac → SSH → VPS direct-device HTTP ingest → authenticated Socket.IO farm room → Mac',samples:1,observedMs:+ms.toFixed(2),allFiveSensorFields:true,telemetryId:ack.data.telemetryId};
  const file='docs/firmware-api/verification.json';const report=JSON.parse(fs.readFileSync(file));report.realtime=result;fs.writeFileSync(file,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(result));
 }finally{socket.disconnect()}
})().catch(e=>{console.error('Realtime verification failed:',e.message);process.exitCode=1});
