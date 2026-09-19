import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHarness} from './harness.ts';
import {signature} from '../../packages/domain/core.ts';
import type {Entity} from '../../services/shared/store.ts';

test('five owner services complete the reference workflow through real authenticated HTTP (test stores, not brokers)',async t=>{
  const h=await createHarness();
  try {
    const a=await h.register('Owner A'),b=await h.register('Owner B');
    const create=async(name:string,provider:string,extra:Record<string,unknown>={})=>a.call(a.path('/connections'),'POST',{name,provider,...extra});
    const crm=(await create('CRM fixture','simulator_crm',{failureMode:'timeout_after_commit'})).connection as Entity;
    const sourceResult=await create('Signed source','signed_webhook',{crmDestinationId:crm._id}),source=sourceResult.connection as Entity;
    const website=(await create('Website','web_collector',{allowedOrigin:'https://customer.example'})).connection as Entity;
    const ads=(await create('Ads fixture','simulator_ads')).connection as Entity;
    const signed=async(event:unknown)=>{const raw=Buffer.from(JSON.stringify(event)),time=String(Math.floor(h.now().getTime()/1000));
      return fetch(h.gateway.listeningOrigin+'/v1/ingest/'+source._id,{method:'POST',headers:{'content-type':'application/json','x-insights-timestamp':time,
        'x-insights-signature':signature(String(sourceResult.signingSecret),time,raw)},body:raw});};
    await t.test('two consented touch events retain observed acquisition',async()=>{
      for(const [i,channel] of ['search','newsletter'].entries()){
        const event={kind:'touch',eventId:randomUUID(),occurredAt:new Date(h.now().getTime()-(3-i)*3600000).toISOString(),visitorId:'visitor-one',analyticsConsent:true,
          acquisition:{url:'https://customer.example/landing?token=must-disappear',utmSource:channel}};
        const response=await fetch(h.gateway.listeningOrigin+'/v1/collect/'+website._id,{method:'POST',headers:{origin:'https://customer.example','content-type':'application/json'},body:JSON.stringify(event)});
        assert.equal(response.status,202,await response.text());
      }
      await h.drain();const touches=await a.call(a.path('/touches'));assert.equal(touches.items.length,2);
      assert(touches.items.every((x:Entity)=>!x.acquisition.url.includes('token=')));
    });
    const input={kind:'lead',eventId:randomUUID(),occurredAt:h.now().toISOString(),externalLeadKey:'customer-one',sourceVersion:1,fullName:'Example Learner',email:'learner@example.com',
      touchLink:{sourceId:website._id,visitorId:'visitor-one'},consent:{service:'granted',analytics:'granted',advertising:'unknown'},evidence:{noticeVersion:'test-v1',reference:'synthetic consent fixture'}};
    const response=await signed(input);assert.equal(response.status,202);const receipt=await response.json() as Entity;
    await h.drain();const applied=await a.call(a.path('/jobs/'+receipt.receiptId)),leadId=String(applied.resourceId),actionId=String(applied.actionId);
    await t.test('CRM timeout after effect becomes unknown, then read-back verifies without another write',async()=>{
      const first=await a.call(a.path('/jobs/'+actionId));assert.equal(first.state,'outcome_unknown');assert.equal(first.attemptCount,1);
      h.advance(6000);await h.drain();const done=await a.call(a.path('/jobs/'+actionId));assert.equal(done.state,'verified');assert.equal(done.attemptCount,1);assert.equal(done.inspectCount,1);
      assert.equal((await h.stores.simulator.find('effects',{_id:actionId})).length,1);
      assert.equal((await h.stores.crm.find('usage',{_id:actionId})).length,1);
    });
    await t.test('duplicate source identity returns the same receipt; changed input conflicts',async()=>{
      const again=await signed(input);assert.equal((await again.json() as Entity).receiptId,receipt.receiptId);
      const changed=await signed({...input,fullName:'Changed'});assert.equal(changed.status,409);
    });
    await t.test('tenant and role boundaries survive service hops',async()=>{
      assert.equal((await b.request(a.path('/leads/'+leadId))).status,404);
      assert.equal((await b.request(b.path('/leads/'+leadId))).status,404);
      assert.equal((await b.request(b.path('/connections'),'POST',{name:'tamper',provider:'signed_webhook',workspaceId:a.workspace})).status,400);
    });
    const sale={kind:'sale',businessKey:'order-one',leadId,currency:'USD',amount:'1000.00',occurredAt:h.now().toISOString(),sourceReference:'synthetic finance authority'};
    const saleId=String((await a.call(a.path('/revenue-events'),'POST',sale)).id);
    const refund={kind:'refund',businessKey:'refund-one',leadId,currency:'USD',amount:'200.00',occurredAt:h.now().toISOString(),sourceReference:'synthetic finance authority',originalSaleId:saleId};
    const refundId=String((await a.call(a.path('/revenue-events'),'POST',refund)).id);
    await t.test('repeated sales and refunds preserve exact net revenue once',async()=>{
      assert.equal((await a.call(a.path('/revenue-events'),'POST',sale)).id,saleId);assert.equal((await a.call(a.path('/revenue-events'),'POST',refund)).id,refundId);
      assert.equal((await a.request(a.path('/revenue-events'),'POST',{...refund,businessKey:'oversized-refund',amount:'900.00'})).status,422);
      assert.equal((await h.stores.reporting.get('revenue',saleId))!.refundedMinor,'20000');
    });
    const reportRequest={name:'Linear fixture',model:'linear',from:new Date(h.now().getTime()-86400000).toISOString(),to:new Date(h.now().getTime()+86400000).toISOString(),lookbackDays:30};
    const reportId=String((await a.call(a.path('/reports'),'POST',reportRequest)).operationId);await h.drain();
    await t.test('immutable report and CSV reconcile 800.00 to two 400.00 credits',async()=>{
      const job=await a.call(a.path('/jobs/'+reportId));assert.equal(job.state,'completed',JSON.stringify(job));
      const report=await a.call(a.path('/reports/'+reportId));assert.equal(report.result.currencies[0].observedMinor,'80000');assert.equal(report.result.currencies[0].discrepancyMinor,'0');
      assert.deepEqual(report.result.rows.map((r:Entity)=>r.amountMinor),['40000','40000']);
      const csv=await a.request(a.path('/reports/'+reportId+'/csv'));assert.equal(csv.status,200);assert.equal((await csv.text()).split('400.00').length-1,2);
    });
    await t.test('unknown advertising consent blocks activation',async()=>{
      const p=await a.call(a.path('/conversion-intents/preview'),'POST',{revenueId:saleId,destinationId:ads._id});assert.equal(p.eligible,false);
      assert.equal((await a.request(a.path('/conversion-intents/activate'),'POST',{revenueId:saleId,destinationId:ads._id,previewHash:p.previewHash})).status,403);
    });
    async function consent(value:string){const state=await a.call(a.path('/leads/'+leadId));return a.call(a.path('/leads/'+leadId+'/consent'),'POST',{
      expectedVersion:state.consent.version,consent:{service:'granted',analytics:'granted',advertising:value},evidence:{noticeVersion:'test-v2',reference:'synthetic preference change'}});}
    await t.test('withdrawal while a conversion waits suppresses it before a write',async()=>{
      await consent('granted');const p=await a.call(a.path('/conversion-intents/preview'),'POST',{revenueId:saleId,destinationId:ads._id});assert.equal(p.eligible,true);
      const action=await a.call(a.path('/conversion-intents/activate'),'POST',{revenueId:saleId,destinationId:ads._id,previewHash:p.previewHash});
      await consent('denied');await h.drain();const state=await a.call(a.path('/jobs/'+action.operationId));assert.equal(state.state,'suppressed');assert.equal(state.attemptCount,0);
      assert.equal(await h.stores.simulator.get('effects',String(action.operationId)),null);
      assert.equal((await a.request(a.path('/reports/'+reportId))).status,403);
    });
    await t.test('eligible purchase and linked refund reach a distinct destination once',async()=>{
      await consent('granted');const sink=(await create('Second approved ads fixture','simulator_ads')).connection as Entity;
      for(const revenueId of [saleId,refundId]){
        const p=await a.call(a.path('/conversion-intents/preview'),'POST',{revenueId,destinationId:sink._id});assert.equal(p.eligible,true,JSON.stringify(p));
        const body={revenueId,destinationId:sink._id,previewHash:p.previewHash},action=await a.call(a.path('/conversion-intents/activate'),'POST',body);
        await h.drain();assert.equal((await a.call(a.path('/jobs/'+action.operationId))).state,'verified');
        assert.equal((await a.call(a.path('/conversion-intents/activate'),'POST',body)).operationId,action.operationId);
      }
    });
    await t.test('lifecycle changes are versioned and preserve opportunity/won/lost history',async()=>{
      let lead=(await a.call(a.path('/leads/'+leadId))).lead as Entity;const previous=lead.version;
      for(const stage of ['qualified','opportunity','won','lost']){
        await a.call(a.path('/leads/'+leadId+'/stages'),'POST',{stage,reason:'Human-reviewed fixture',expectedVersion:lead.version});lead=(await a.call(a.path('/leads/'+leadId))).lead as Entity;
      }
      assert.equal((await a.request(a.path('/leads/'+leadId+'/stages'),'POST',{stage:'new',reason:'Stale version',expectedVersion:previous})).status,409);
      assert.equal((await h.stores.crm.find('stages',{leadId})).length,5);
    });
    await t.test('reporting outage does not stop durable source intake',async()=>{
      h.stores.reporting.available=false;
      try{const accepted=await signed({...input,eventId:randomUUID(),externalLeadKey:'independent-two'});assert.equal(accepted.status,202);
        const overview=await a.call(a.path('/overview'));assert.equal(overview.partial,true);assert.equal(overview.services.reporting,'unavailable');}
      finally{h.stores.reporting.available=true;}
      await h.drain();
    });
    await t.test('a missing durable store returns failure, never successful admission',async()=>{
      h.stores.connections.available=false;
      try{assert.equal((await signed({...input,eventId:randomUUID()})).status,503);}finally{h.stores.connections.available=true;}
    });
  }finally{await h.close();}
});
