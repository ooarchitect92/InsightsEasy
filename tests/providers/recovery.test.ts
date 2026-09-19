import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createHarness} from '../microservices/harness.ts';
import {configs,fields,reply} from './fixtures.ts';
import {createProviderExecutor} from '../../packages/providers/adapters.ts';
import type {ProviderBinding} from '../../packages/providers/vault.ts';
import type {Entity} from '../../services/shared/store.ts';

test('controlled recovery retries only confirmed failures, preserves counters, and is idempotent',async()=>{
  const h=await createHarness();try{
    const a=await h.register('Recovery owner'),b=await h.register('Other tenant');
    const destination=(await a.call(a.path('/connections'),'POST',{name:'Zoho native',provider:'zoho',credentialRef:'fixture',providerConfig:configs.zoho})).connection as Entity;
    const source=(await a.call(a.path('/connections'),'POST',{name:'Input',provider:'signed_webhook',crmDestinationId:destination._id})).connection as Entity;
    const received=await a.call(a.path('/connections/'+source._id+'/test-events'),'POST',{kind:'lead',eventId:randomUUID(),externalLeadKey:'recover-one',sourceVersion:1,fullName:'Recovery Fixture',email:'recover@example.com',occurredAt:h.now().toISOString(),consent:{service:'granted',analytics:'granted',advertising:'granted'},evidence:{noticeVersion:'test-v1',reference:'fixture'}});
    await h.drain();const applied=await a.call(a.path('/jobs/'+received.receiptId));let action=await a.call(a.path('/jobs/'+applied.actionId));assert.equal(action.state,'rejected');const firstAttempts=Number(action.attemptCount);
    const binding:ProviderBinding={credentialRef:'fixture',connectionId:destination._id,organizationId:destination.organizationId,workspaceId:a.workspace,environment:'sandbox',provider:'zoho',configHash:destination.providerConfigHash,
      accessToken:'not-a-real-provider-token',expiresAt:new Date(h.now().getTime()+3600000).toISOString(),approval:{reference:'protocol fixture',expiresAt:new Date(h.now().getTime()+3600000).toISOString(),allowExternalEffects:true}};
    let writes=0,record:Entity|null=null;
    h.settings.crm.providerExecutor=createProviderExecutor(()=>[binding],async(url,init)=>{
      if(url.includes('/settings/fields'))return reply(200,{fields:fields()});
      if(init.method==='POST'){writes++;record={...(JSON.parse(String(init.body)) as {data:Entity[]}).data[0]!,id:'456789',Modified_Time:h.now().toISOString()};return reply(200,{data:[{code:'SUCCESS',status:'success',details:{id:'456789'}}]});}
      return record?reply(200,{data:[record]}):reply(204);
    },()=>h.now().getTime());
    const body={mode:'retry',expectedDispatchGeneration:action.dispatchGeneration,reason:'Server credential was provisioned'},key=randomUUID(),path=a.path('/actions/'+action._id+'/recover');
    assert.equal((await b.request(b.path('/actions/'+action._id+'/recover'),'POST',body)).status,404);
    const restored=await a.call(path,'POST',body,key);assert.equal(restored.operationId,action._id);assert.equal(restored.recoveryCount,1);
    assert.deepEqual(await a.call(path,'POST',body,key),restored);
    assert.equal((await a.request(path,'POST',{...body,reason:'Changed request under same key'},key)).status,409);
    await h.drain();h.advance(3000);await h.drain();action=await a.call(a.path('/jobs/'+action._id));
    assert.equal(action.state,'verified');assert.equal(action.attemptCount,firstAttempts+1);assert.equal(writes,1);
    assert.deepEqual(await a.call(path,'POST',body,key),restored);assert.equal((await a.request(path,'POST',{...body,expectedDispatchGeneration:action.dispatchGeneration})).status,409);
    const audit=await h.stores.crm.find('audit',{event:'action.recovery.requested',targetId:action._id});assert.equal(audit.length,1);
  }finally{await h.close();}
});
test('unknown writes refuse retry and manual reconciliation cannot force an external resend',async()=>{
  const h=await createHarness();try{
    const a=await h.register('Unknown outcome owner');
    const destination=(await a.call(a.path('/connections'),'POST',{name:'Zoho unknown',provider:'zoho',credentialRef:'fixture',providerConfig:configs.zoho})).connection as Entity;
    const source=(await a.call(a.path('/connections'),'POST',{name:'Input',provider:'signed_webhook',crmDestinationId:destination._id})).connection as Entity;
    const binding:ProviderBinding={credentialRef:'fixture',connectionId:destination._id,organizationId:destination.organizationId,workspaceId:a.workspace,environment:'sandbox',provider:'zoho',configHash:destination.providerConfigHash,
      accessToken:'not-a-real-provider-token',expiresAt:new Date(h.now().getTime()+3600000).toISOString(),approval:{reference:'protocol fixture',expiresAt:new Date(h.now().getTime()+3600000).toISOString(),allowExternalEffects:true}};
    let writes=0;h.settings.crm.providerExecutor=createProviderExecutor(()=>[binding],async(url,init)=>{
      if(init.method==='POST'){writes++;throw new Error('response lost');}return url.includes('/settings/fields')?reply(200,{fields:fields()}):reply(204);
    },()=>h.now().getTime());
    const receipt=await a.call(a.path('/connections/'+source._id+'/test-events'),'POST',{kind:'lead',eventId:randomUUID(),externalLeadKey:'unknown',sourceVersion:1,fullName:'Unknown Fixture',email:'unknown@example.com',occurredAt:h.now().toISOString(),consent:{service:'granted',analytics:'granted',advertising:'unknown'},evidence:{noticeVersion:'v1',reference:'fixture'}});
    await h.drain();const applied=await a.call(a.path('/jobs/'+receipt.receiptId));let action=await a.call(a.path('/jobs/'+applied.actionId));assert.equal(action.state,'outcome_unknown');
    const path=a.path('/actions/'+action._id+'/recover');
    assert.equal((await a.request(path,'POST',{mode:'retry',reason:'Try again regardless',expectedDispatchGeneration:action.dispatchGeneration})).status,409);
    for(let i=0;i<3;i++){
      await a.call(path,'POST',{mode:'reconcile',reason:'Inspect provider evidence',expectedDispatchGeneration:action.dispatchGeneration});await h.drain();
      action=await a.call(a.path('/jobs/'+action._id));assert.equal(action.state,'outcome_unknown');assert.equal(writes,1);
    }
    assert.equal((await a.request(path,'POST',{mode:'reconcile',reason:'No unlimited recovery',expectedDispatchGeneration:action.dispatchGeneration})).status,409);
  }finally{await h.close();}
});
test('activation recovery requires a current explicit preview; successful acceptance is never resent',async()=>{
  const h=await createHarness();try{
    const a=await h.register('Activation recovery owner');
    const destination=(await a.call(a.path('/connections'),'POST',{name:'Meta native',provider:'meta',credentialRef:'fixture-meta',providerConfig:configs.meta})).connection as Entity;
    const source=(await a.call(a.path('/connections'),'POST',{name:'Input',provider:'signed_webhook'})).connection as Entity;
    const received=await a.call(a.path('/connections/'+source._id+'/test-events'),'POST',{kind:'lead',eventId:randomUUID(),externalLeadKey:'meta-recover',sourceVersion:1,fullName:'Meta Fixture',email:'meta@example.com',occurredAt:h.now().toISOString(),consent:{service:'granted',analytics:'granted',advertising:'granted'},evidence:{noticeVersion:'v1',reference:'fixture'}});
    await h.drain();const applied=await a.call(a.path('/jobs/'+received.receiptId));
    const sale=await a.call(a.path('/revenue-events'),'POST',{kind:'sale',businessKey:'meta-recovery-sale',leadId:applied.resourceId,currency:'USD',amount:'100.00',occurredAt:h.now().toISOString(),sourceReference:'synthetic finance'});
    const material={revenueId:sale.id,destinationId:destination._id},p=await a.call(a.path('/conversion-intents/preview'),'POST',material);
    const op=await a.call(a.path('/conversion-intents/activate'),'POST',{...material,previewHash:p.previewHash});await h.drain();let action=await a.call(a.path('/jobs/'+op.operationId));assert.equal(action.state,'rejected');
    const path=a.path('/actions/'+action._id+'/recover'),body={mode:'retry',expectedDispatchGeneration:action.dispatchGeneration,reason:'Authorized credential is now provisioned'};
    assert.equal((await a.request(path,'POST',body)).status,403);
    assert.equal((await a.request(path,'POST',{...body,previewHash:p.previewHash})).status,403);
    const binding:ProviderBinding={credentialRef:'fixture-meta',connectionId:destination._id,organizationId:destination.organizationId,workspaceId:a.workspace,environment:'sandbox',provider:'meta',configHash:destination.providerConfigHash,
      accessToken:'not-a-real-provider-token',expiresAt:new Date(h.now().getTime()+3600000).toISOString(),approval:{reference:'fixture approval',expiresAt:new Date(h.now().getTime()+3600000).toISOString(),allowExternalEffects:true}};
    let writes=0;h.settings.activation.providerExecutor=createProviderExecutor(()=>[binding],async()=>{writes++;return reply(200,{events_received:1});},()=>h.now().getTime());
    const preview=await a.call(a.path('/conversion-intents/preview'),'POST',material),key=randomUUID(),input={...body,previewHash:preview.previewHash};
    const result=await a.call(path,'POST',input,key);await h.drain();action=await a.call(a.path('/jobs/'+op.operationId));
    assert.equal(action.state,'accepted_unverified');assert.equal(writes,1);assert.deepEqual(await a.call(path,'POST',input,key),result);
    const fresh=await a.call(a.path('/conversion-intents/preview'),'POST',material);
    assert.equal((await a.request(path,'POST',{...body,previewHash:fresh.previewHash,expectedDispatchGeneration:action.dispatchGeneration})).status,409);assert.equal(writes,1);
  }finally{await h.close();}
});
