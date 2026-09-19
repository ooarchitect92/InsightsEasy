/** Actual signed service HTTP + actual provider adapters, synthetic protocol responses and memory stores. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHarness} from '../microservices/harness.ts';
import {hash,canonical,signature} from '../../packages/domain/core.ts';
import {createProviderExecutor} from '../../packages/providers/adapters.ts';
import type {ProviderBinding} from '../../packages/providers/vault.ts';
import type {ProviderConfig,ProviderId} from '../../packages/providers/contracts.ts';
import type {HttpTransport} from '../../packages/providers/http.ts';
import type {Entity} from '../../services/shared/store.ts';
import {configs,fields,reply} from './fixtures.ts';

test('source, journey, native CRM adapter, exact report and native activation use the five authenticated services',async t=>{
  const h=await createHarness();const bindings:ProviderBinding[]=[];let crmRecord:Entity|null=null,zohoWrites=0,metaWrites=0,googleValidations=0;
  try{
    const a=await h.register('Provider fixture owner'),other=await h.register('Other workspace');
    const create=async(provider:ProviderId,name:string)=>{
      const config=structuredClone(configs[provider]),credentialRef='fixture_'+randomUUID();
      const connection=(await a.call(a.path('/connections'),'POST',{name,provider,providerConfig:config,credentialRef})).connection as Entity;
      assert.equal(connection.providerConfigHash,hash(canonical(config)));
      bindings.push({credentialRef,connectionId:connection._id,organizationId:connection.organizationId,workspaceId:a.workspace,environment:'sandbox',provider,
        configHash:connection.providerConfigHash,accessToken:'synthetic-protocol-token-no-provider-access',expiresAt:new Date(h.now().getTime()+3600000).toISOString(),
        approval:{reference:'INTERNAL_PROTOCOL_FIXTURE',expiresAt:new Date(h.now().getTime()+86400000).toISOString(),allowExternalEffects:true}});
      return connection;
    };
    const zoho=await create('zoho','Zoho fixture'),meta=await create('meta','Meta fixture'),google=await create('google','Google fixture');
    const protocol:HttpTransport=async(url,init)=>{
      if(url.includes('zohoapis')){
        if(url.includes('settings/fields'))return reply(200,{fields:fields()});
        if(init.method==='POST'){zohoWrites++;const data=JSON.parse(String(init.body)) as {data:Entity[]};crmRecord={...data.data[0]!,id:'777888999',Modified_Time:h.now().toISOString()};return reply(200,{data:[{status:'success',code:'SUCCESS',details:{id:crmRecord.id}}]});}
        return crmRecord?reply(200,{data:[crmRecord]}):reply(204);
      }
      if(url.includes('graph.facebook.com')){metaWrites++;assert(!String(init.body).includes('fixture@example.com'));return reply(200,{events_received:1,fbtrace_id:'fixture-trace'});}
      assert(url.includes('datamanager.googleapis.com'));googleValidations++;assert.equal((JSON.parse(String(init.body)) as {validateOnly:boolean}).validateOnly,true);return reply(200,{});
    };
    const executor=createProviderExecutor(()=>bindings,protocol,()=>h.now().getTime());h.settings.crm.providerExecutor=executor;h.settings.activation.providerExecutor=executor;
    const signedSource=await a.call(a.path('/connections'),'POST',{name:'Signed input',provider:'signed_webhook',crmDestinationId:zoho._id});
    const website=(await a.call(a.path('/connections'),'POST',{name:'Owned website',provider:'web_collector',allowedOrigin:'https://fixture.example'})).connection as Entity;
    for(const channel of ['search','email']){
      const r=await h.request('/v1/collect/'+website._id,'POST',{kind:'touch',eventId:randomUUID(),occurredAt:new Date(h.now().getTime()-3600000).toISOString(),visitorId:'visitor-fixture',analyticsConsent:true,acquisition:{url:'https://fixture.example/',utmSource:channel}},'',randomUUID(),'https://fixture.example');assert.equal(r.status,202);
    }
    const input={kind:'lead',eventId:randomUUID(),occurredAt:h.now().toISOString(),externalLeadKey:'provider-fixture-customer',sourceVersion:1,fullName:'Provider Fixture',email:'fixture@example.com',
      touchLink:{sourceId:website._id,visitorId:'visitor-fixture'},consent:{service:'granted',analytics:'granted',advertising:'granted'},
      evidence:{noticeVersion:'fixture-v1',reference:'synthetic consent fixture'}};
    const raw=Buffer.from(JSON.stringify(input)),timestamp=String(Math.floor(h.now().getTime()/1000));
    const r=await fetch(h.gateway.listeningOrigin+'/v1/ingest/'+signedSource.connection._id,{method:'POST',headers:{'content-type':'application/json','x-insights-timestamp':timestamp,'x-insights-signature':signature(signedSource.signingSecret,timestamp,raw)},body:raw});
    assert.equal(r.status,202);const receipt=await r.json() as Entity;await h.drain();const processed=await a.call(a.path('/jobs/'+receipt.receiptId)),leadId=String(processed.resourceId);
    await t.test('Zoho receipt is not verified until a separate exact read-back',async()=>{
      assert.equal((await a.call(a.path('/jobs/'+processed.actionId))).state,'provider_processing');h.advance(3000);await h.drain();
      const result=await a.call(a.path('/jobs/'+processed.actionId));assert.equal(result.state,'verified');assert.equal(result.receipt.evidenceClass,'provider_test');assert.equal(zohoWrites,1);
      assert.equal((await other.request(other.path('/jobs/'+processed.actionId))).status,404);
    });
    const saleId=String((await a.call(a.path('/revenue-events'),'POST',{kind:'sale',businessKey:'provider-order',leadId,currency:'USD',amount:'1000.00',occurredAt:h.now().toISOString(),sourceReference:'synthetic finance'})).id);
    const refundId=String((await a.call(a.path('/revenue-events'),'POST',{kind:'refund',businessKey:'provider-refund',leadId,currency:'USD',amount:'200.00',occurredAt:h.now().toISOString(),originalSaleId:saleId,sourceReference:'synthetic finance'})).id);
    await t.test('all five services retain exact report and provenance behavior with native destinations',async()=>{
      const op=await a.call(a.path('/reports'),'POST',{name:'Native adapter fixture report',model:'linear',from:new Date(h.now().getTime()-86400000).toISOString(),to:new Date(h.now().getTime()+86400000).toISOString(),lookbackDays:30});await h.drain();
      const report=await a.call(a.path('/reports/'+op.operationId));assert.equal(report.result.currencies[0].observedMinor,'80000');assert.deepEqual(report.result.rows.map((row:Entity)=>row.amountMinor),['40000','40000']);
    });
    await t.test('native refund limitations are visible at preview and cannot queue an unsupported reversal',async()=>{
      for(const destination of [meta,google]){const body={revenueId:refundId,destinationId:destination._id},p=await a.call(a.path('/conversion-intents/preview'),'POST',body);
        assert.equal(p.eligible,false);assert(p.reasons.includes('UNSUPPORTED_PROVIDER_CORRECTION'));
        assert.equal((await a.request(a.path('/conversion-intents/activate'),'POST',{...body,previewHash:p.previewHash})).status,403);}
    });
    await t.test('a known refund blocks native purchase delivery that cannot be corrected',async()=>{
      const p=await a.call(a.path('/conversion-intents/preview'),'POST',{revenueId:saleId,destinationId:meta._id});
      assert.equal(p.eligible,false);assert(p.reasons.includes('KNOWN_REFUND_REQUIRES_UNSUPPORTED_CORRECTION'));
    });
    const nativeSaleId=String((await a.call(a.path('/revenue-events'),'POST',{kind:'sale',businessKey:'unrefunded-order',leadId,currency:'USD',amount:'1000.00',occurredAt:h.now().toISOString(),sourceReference:'synthetic finance'})).id);
    await t.test('Meta private hashed data stays out of preview and API acceptance does not become verified',async()=>{
      const body={revenueId:nativeSaleId,destinationId:meta._id},p=await a.call(a.path('/conversion-intents/preview'),'POST',body);
      assert.equal(p.eligible,true);assert(!JSON.stringify(p).includes(hash('fixture@example.com')));
      const op=await a.call(a.path('/conversion-intents/activate'),'POST',{...body,previewHash:p.previewHash});await h.drain();
      const result=await a.call(a.path('/jobs/'+op.operationId));assert.equal(result.state,'accepted_unverified');assert.equal(metaWrites,1);
      assert.equal(await h.stores.activation.get('usage',String(op.operationId)),null);
    });
    await t.test('Google explicit consent requires evidence and validation alone is not live conversion delivery',async()=>{
      const body={revenueId:nativeSaleId,destinationId:google._id},blocked=await a.call(a.path('/conversion-intents/preview'),'POST',body);assert(blocked.reasons.includes('GOOGLE_CONSENT_NOT_EXPLICIT'));
      const lead=await a.call(a.path('/leads/'+leadId));
      await a.call(a.path('/leads/'+leadId+'/consent'),'POST',{expectedVersion:lead.consent.version,consent:{service:'granted',analytics:'granted',advertising:'granted'},
        googleConsent:{adUserData:'granted',adPersonalization:'denied'},evidence:{noticeVersion:'provider-fixture-v2',reference:'explicit google consent fixture'}});
      const p=await a.call(a.path('/conversion-intents/preview'),'POST',body);assert.equal(p.eligible,true);
      const op=await a.call(a.path('/conversion-intents/activate'),'POST',{...body,previewHash:p.previewHash});await h.drain();
      const result=await a.call(a.path('/jobs/'+op.operationId));assert.equal(result.state,'validation_passed');assert.equal(googleValidations,1);assert.equal(await h.stores.activation.get('usage',String(op.operationId)),null);
    });
  }finally{await h.close();}
});
test('unresolved native CRM write blocks a later version instead of permitting a stale write race',async()=>{
  const h=await createHarness();try{
    const a=await h.register('Version owner');const config=configs.zoho;
    const destination=(await a.call(a.path('/connections'),'POST',{name:'Zoho ambiguity',provider:'zoho',credentialRef:'fixture_cred',providerConfig:config})).connection as Entity;
    const binding:ProviderBinding={credentialRef:'fixture_cred',connectionId:destination._id,organizationId:destination.organizationId,workspaceId:a.workspace,environment:'sandbox',provider:'zoho',configHash:destination.providerConfigHash,
      accessToken:'synthetic-not-a-provider-token',expiresAt:new Date(h.now().getTime()+3600000).toISOString(),approval:{reference:'fixture',expiresAt:new Date(h.now().getTime()+86400000).toISOString(),allowExternalEffects:true}};
    let writes=0;h.settings.crm.providerExecutor=createProviderExecutor(()=>[binding],async(url,init)=>{
      if(init.method==='POST'){writes++;throw new Error('Provider accepted, response lost');}return url.includes('settings/fields')?reply(200,{fields:fields()}):reply(204);
    },()=>h.now().getTime());
    const source=(await a.call(a.path('/connections'),'POST',{name:'Signed source',provider:'signed_webhook',crmDestinationId:destination._id})).connection as Entity;
    const input={kind:'lead',eventId:randomUUID(),occurredAt:h.now().toISOString(),externalLeadKey:'versioned-customer',sourceVersion:1,fullName:'Version One',email:'version@example.com',
      consent:{service:'granted',analytics:'granted',advertising:'unknown'},evidence:{noticeVersion:'v1',reference:'fixture'}};
    const first=await a.call(a.path('/connections/'+source._id+'/test-events'),'POST',input);await h.drain();
    const firstDone=await a.call(a.path('/jobs/'+first.receiptId));assert.equal((await a.call(a.path('/jobs/'+firstDone.actionId))).state,'outcome_unknown');
    const second=await a.call(a.path('/connections/'+source._id+'/test-events'),'POST',{...input,eventId:randomUUID(),sourceVersion:2,fullName:'Version Two'});await h.drain();
    const secondDone=await a.call(a.path('/jobs/'+second.receiptId)),secondAction=await a.call(a.path('/jobs/'+secondDone.actionId));
    assert.equal(writes,1);assert.equal(secondAction.state,'ready');assert(secondAction.reasons.includes('PREVIOUS_CRM_EFFECT_UNRESOLVED'));
    h.advance(16000);await h.drain();assert.equal(writes,1);
  }finally{await h.close();}
});
test('a missing or cross-workspace worker credential never falls back to a simulator',async()=>{
  const h=await createHarness();try{
    const a=await h.register('Missing credential owner');
    const dest=(await a.call(a.path('/connections'),'POST',{name:'Real Zoho destination',provider:'zoho',credentialRef:'missing',providerConfig:configs.zoho as ProviderConfig})).connection as Entity;
    const source=(await a.call(a.path('/connections'),'POST',{name:'Signed source',provider:'signed_webhook',crmDestinationId:dest._id})).connection as Entity;
    const receipt=await a.call(a.path('/connections/'+source._id+'/test-events'),'POST',{kind:'lead',eventId:randomUUID(),occurredAt:h.now().toISOString(),externalLeadKey:'new',sourceVersion:1,fullName:'Missing Credential',email:'missing@example.com',
      consent:{service:'granted',analytics:'granted',advertising:'unknown'},evidence:{noticeVersion:'v1',reference:'fixture'}});
    await h.drain();const accepted=await a.call(a.path('/jobs/'+receipt.receiptId)),action=await a.call(a.path('/jobs/'+accepted.actionId));
    assert.equal(action.state,'rejected');assert(action.reasons.includes('PROVIDER_WORKER_CREDENTIALS_NOT_CONFIGURED'));assert.equal((await h.stores.simulator.find('effects',{})).length,0);
  }finally{await h.close();}
});
