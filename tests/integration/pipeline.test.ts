/** Destructive recovery tests ONLY for a dedicated disposable Compose sandbox with real databases/brokers. */
import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';import {signature} from '../../packages/domain/core.ts';
import type {Entity} from '../../services/shared/store.ts';
const api=process.env.API_ORIGIN??'http://localhost:4000',origin=process.env.PUBLIC_ORIGIN??'http://localhost:3000';
const compose=(...args:string[])=>execFileSync('docker',['compose',...args],{encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});
async function until<T>(read:()=>Promise<T>,accept:(value:T)=>boolean,description:string,timeout=90000){const deadline=Date.now()+timeout;let last:T;
 do{last=await read();if(accept(last))return last;await new Promise(r=>setTimeout(r,500));}while(Date.now()<deadline);throw new Error('Timed out: '+description);}
const database=(owner:string,expression:string):Entity=>JSON.parse(compose('exec','-T',owner,'node','--input-type=module','-e',
 `import {MongoClient} from 'mongodb'; const c=new MongoClient(process.env.MONGO_URL);await c.connect();try{const db=c.db(process.env.MONGO_DATABASE);const value=await (${expression});console.log(JSON.stringify(value));}finally{await c.close();}`));

test('real MongoDB, Kafka, RabbitMQ and Redis/BullMQ five-service acceptance',{timeout:300000},async t=>{
 assert.equal(process.env.TEST_DESTRUCTIVE,'dedicated-sandbox','Set TEST_DESTRUCTIVE=dedicated-sandbox only for a disposable generated test environment.');
 const running=compose('ps','--status','running','--services');for(const name of ['mongo','kafka','rabbitmq','redis-queue','redis-cache','gateway','crm-projector','reporting-tasks'])assert(running.split('\n').includes(name),`Required real service missing: ${name}`);
 let cookie='';
 async function request(path:string,method='GET',body?:unknown,key:string=randomUUID()){
  return fetch(api+path,{method,headers:{cookie,origin,'idempotency-key':key,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(25000)});
 }
 async function call(path:string,method='GET',body?:unknown,key?:string){const response=await request(path,method,body,key),value=await response.json() as Entity;
  assert(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(value)}`);return value;}
 assert.equal((await call('/v1/meta')).environment,'sandbox','Production is never a fault-injection target');
 const signup=await request('/v1/auth/register','POST',{email:randomUUID()+'@example.com',password:'Real-service-test-'+randomUUID(),businessName:'Dedicated integration fixture'});
 assert.equal(signup.status,201);cookie=signup.headers.get('set-cookie')!.split(';')[0]!;const me=await call('/v1/me'),w=String(me.workspaces[0]._id),path=(p:string)=>`/v1/workspaces/${w}${p}`;
 const connection=async(name:string,provider:string,extra:Record<string,unknown>={})=>call(path('/connections'),'POST',{name,provider,...extra});
 const crm=(await connection('CRM readback fixture','simulator_crm',{failureMode:'timeout_after_commit'})).connection;
 const sourceResult=await connection('Signed source','signed_webhook',{crmDestinationId:crm._id}),source=sourceResult.connection;
 const website=(await connection('Website','web_collector',{allowedOrigin:'https://customer.example'})).connection;
 const ads=(await connection('Ads fixture','simulator_ads')).connection;
 const now=()=>new Date().toISOString();
 const lead={kind:'lead',eventId:randomUUID(),occurredAt:now(),externalLeadKey:randomUUID(),sourceVersion:1,fullName:'Synthetic Customer',email:'synthetic@example.com',
  touchLink:{sourceId:website._id,visitorId:'real-stack-visitor'},consent:{service:'granted',analytics:'granted',advertising:'granted'},evidence:{noticeVersion:'test-v2',reference:'Synthetic integration evidence'}};
 async function signed(value:unknown,valid=true){const raw=Buffer.from(JSON.stringify(value)),timestamp=String(Math.floor(Date.now()/1000));return fetch(api+'/v1/ingest/'+source._id,{method:'POST',headers:{'content-type':'application/json','x-insights-timestamp':timestamp,
  'x-insights-signature':valid?signature(String(sourceResult.signingSecret),timestamp,raw):'0'.repeat(64)},body:raw});}
 await t.test('forged signature never admits a receipt',async()=>assert.equal((await signed(lead,false)).status,401));
 await t.test('MongoDB credentials cannot read another owner database',async()=>{
  const result=database('connections',`(async()=>{try{await c.db('insightseasy_crm').collection('leads').findOne({});return {denied:false};}catch(e){return {denied:e.code===13};}})()`);assert.equal(result.denied,true);
 });
 await t.test('collector events cross Kafka and retain the observed journey',async()=>{
  for(const [i,utmSource] of ['search','newsletter'].entries()){
   const response=await fetch(api+'/v1/collect/'+website._id,{method:'POST',headers:{origin:'https://customer.example','content-type':'application/json'},body:JSON.stringify({kind:'touch',eventId:randomUUID(),occurredAt:new Date(Date.now()-(3-i)*3600000).toISOString(),visitorId:'real-stack-visitor',analyticsConsent:true,acquisition:{url:'https://customer.example/landing',utmSource}})});assert.equal(response.status,202);}
  await until(()=>call(path('/touches')),x=>x.items.length===2,'two projected touches');
 });
 let receipt:Entity;
 await t.test('accepted intake survives a stopped CRM projector and duplicate requests',async()=>{
  compose('stop','crm-projector');try{const admitted=await signed(lead);assert.equal(admitted.status,202);receipt=await admitted.json() as Entity;
   assert.equal((await call(path('/jobs/'+receipt.receiptId))).state,'pending');assert.equal((await (await signed(lead)).json() as Entity).receiptId,receipt.receiptId);
  }finally{compose('start','crm-projector');}
 });
 const applied=await until(()=>call(path('/jobs/'+receipt!.receiptId)),x=>x.state==='processed','lead projection'),leadId=String(applied.resourceId),crmId=String(applied.actionId);
 await t.test('RabbitMQ write timeout resolves by read-back with exactly one external effect',async()=>{
  const job=await until(()=>call(path('/jobs/'+crmId)),x=>x.state==='verified','CRM read-back');assert.equal(job.attemptCount,1);assert(Number(job.inspectCount)>=1);
  assert.equal(database('simulator',`db.collection('effects').countDocuments({_id:${JSON.stringify(crmId)}})`),1);
 });
 await t.test('a foreign workspace request is rejected across service hops',async()=>assert.equal((await request('/v1/workspaces/unknown/leads/'+leadId)).status,404));
 const sale=await call(path('/revenue-events'),'POST',{kind:'sale',businessKey:randomUUID(),leadId,currency:'USD',amount:'1000.00',occurredAt:now(),sourceReference:'synthetic finance source'});
 const refundBody={kind:'refund',businessKey:randomUUID(),leadId,currency:'USD',amount:'200.00',occurredAt:now(),sourceReference:'synthetic finance source',originalSaleId:sale.id};
 const refund=await call(path('/revenue-events'),'POST',refundBody);
 await t.test('financial replay produces one immutable refund',async()=>assert.equal((await call(path('/revenue-events'),'POST',refundBody)).id,refund.id));
 const reportBody={name:'Real broker report',model:'linear',from:new Date(Date.now()-86400000).toISOString(),to:new Date(Date.now()+86400000).toISOString(),lookbackDays:30};
 let reportId:string;
 await t.test('queue Redis loss recovers an unfinished report from MongoDB',async()=>{
  compose('stop','reporting-tasks');try{reportId=String((await call(path('/reports'),'POST',reportBody)).operationId);
   await until(()=>call(path('/jobs/'+reportId)),x=>x.state==='dispatched','BullMQ dispatch');compose('exec','-T','redis-queue','redis-cli','FLUSHALL');
  }finally{compose('start','reporting-tasks');}
  await until(()=>call(path('/jobs/'+reportId)),x=>x.state==='completed','recovered report');
 });
 await t.test('the report conserves 800.00 as two 400.00 credits',async()=>{
  const report=await call(path('/reports/'+reportId!));assert.equal(report.result.currencies[0].observedMinor,'80000');assert.equal(report.result.currencies[0].discrepancyMinor,'0');
  assert.deepEqual(report.result.rows.map((x:Entity)=>x.amountMinor),['40000','40000']);
 });
 await t.test('cache eviction cannot lose or change the report',async()=>{
  const before=await call(path('/reports/'+reportId!));compose('exec','-T','redis-cache','redis-cli','FLUSHALL');const after=await call(path('/reports/'+reportId!));assert.deepEqual(after,before);
 });
 await t.test('purchase and linked correction complete through the activation command lane',async()=>{
  for(const revenueId of [sale.id,refund.id]){const preview=await call(path('/conversion-intents/preview'),'POST',{revenueId,destinationId:ads._id});assert.equal(preview.eligible,true);
   const action=await call(path('/conversion-intents/activate'),'POST',{revenueId,destinationId:ads._id,previewHash:preview.previewHash});
   await until(()=>call(path('/jobs/'+action.operationId)),x=>x.state==='verified','conversion verification');}
 });
 await t.test('queued activation rechecks a withdrawal before any provider write',async()=>{
  const sink=(await connection('Suppressed destination','simulator_ads')).connection;compose('stop','activation-actions');let actionId='';
  try{const preview=await call(path('/conversion-intents/preview'),'POST',{revenueId:sale.id,destinationId:sink._id});actionId=String((await call(path('/conversion-intents/activate'),'POST',{revenueId:sale.id,destinationId:sink._id,previewHash:preview.previewHash})).operationId);
   const current=await call(path('/leads/'+leadId));await call(path('/leads/'+leadId+'/consent'),'POST',{expectedVersion:current.consent.version,consent:{service:'granted',analytics:'granted',advertising:'denied'},evidence:{noticeVersion:'test-v3',reference:'Synthetic withdrawal'}});
  }finally{compose('start','activation-actions');}
  const job=await until(()=>call(path('/jobs/'+actionId)),x=>x.state==='suppressed','withdrawal suppression');assert.equal(job.attemptCount,0);
 });
});
