import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {createHarness} from './harness.ts';
import {dispatchActions,executeAction,recoverActions,type ActionMessage} from '../../services/shared/actions.ts';
import {dispatchReports,recoverReports} from '../../services/reporting/handler.ts';
import {verifyEvent} from '../../services/shared/authentication.ts';
import type {Entity} from '../../services/shared/store.ts';

test('durable handoffs and lost-worker recovery (real HTTP with isolated test stores)',async t=>{
 const h=await createHarness();try{
  const a=await h.register('Recovery fixture');
  const crm=(await a.call(a.path('/connections'),'POST',{name:'CRM',provider:'simulator_crm'})).connection;
  const source=(await a.call(a.path('/connections'),'POST',{name:'Source',provider:'signed_webhook',crmDestinationId:crm._id})).connection;
  const event=(key:string)=>({kind:'lead',eventId:randomUUID(),occurredAt:h.now().toISOString(),externalLeadKey:key,sourceVersion:1,fullName:'Synthetic Person',email:'synthetic@example.com',
    consent:{service:'granted',analytics:'granted',advertising:'granted'},evidence:{noticeVersion:'fixture',reference:'synthetic signed-source assertion'}});
  const first=await a.call(a.path('/connections/'+source._id+'/test-events'),'POST',event('first'));
  await t.test('lost receipt acknowledgement retries without another canonical effect',async()=>{
   const row=await h.stores.connections.get('receipts',first.receiptId),outbox=await h.stores.connections.get('outbox',row!.eventId),signed=verifyEvent(outbox!.signed,h.settings.crm.keyRing.publicKeys);
   const original=h.dependencies.crm.call;let once=true;
   h.dependencies.crm.call=async(...args)=>{const result=await original(...args);if(args[1]==='acknowledgeReceipt'&&once){once=false;throw new Error('ACK response lost after commit');}return result;};
   try{await assert.rejects(h.crm.consume(signed),/ACK response lost/);await h.crm.consume(signed);}finally{h.dependencies.crm.call=original;}
   assert.equal((await h.stores.crm.find('leads')).length,1);assert.equal((await h.stores.crm.find('actions')).length,1);
   assert.equal((await h.stores.connections.get('receipts',first.receiptId))!.state,'processed');
  });
  const applied=await a.call(a.path('/jobs/'+first.receiptId)),leadId=String(applied.resourceId),actionId=String(applied.actionId);
  await t.test('unrouted or lost RabbitMQ dispatch recovers from the intent lease',async()=>{
   await dispatchActions(h.dependencies.crm,async()=>{throw new Error('mandatory route unavailable');});
   assert.equal((await h.stores.crm.get('actions',actionId))!.state,'dispatched');
   h.advance(21000);await recoverActions(h.dependencies.crm);assert.equal((await h.stores.crm.get('actions',actionId))!.state,'ready');
   await h.drain();assert.equal((await h.stores.crm.get('actions',actionId))!.state,'verified');
  });
  await t.test('a stale dispatch generation never starts another external effect',async()=>{
   const action=(await h.stores.crm.get('actions',actionId))!;
   const message={id:actionId,generation:Number(action.dispatchGeneration)-1,organizationId:action.organizationId,workspaceId:action.workspaceId,environment:action.environment};
   await executeAction(h.dependencies.crm,message,h.crm.check);assert.equal((await h.stores.simulator.find('effects',{_id:actionId})).length,1);
   assert.equal((await h.stores.crm.get('actions',actionId))!.attemptCount,1);
  });
  await t.test('forged command tenant is rejected before a write',async()=>{
   const action=(await h.stores.crm.get('actions',actionId))!;
   await assert.rejects(executeAction(h.dependencies.crm,{id:actionId,generation:action.dispatchGeneration,organizationId:action.organizationId,workspaceId:'other',environment:'sandbox'},h.crm.check),/scope/);
  });
  await t.test('worker dies after provider write: expired claim becomes unknown, then read-back finds one effect',async()=>{
   const admitted=await a.call(a.path('/connections/'+source._id+'/test-events'),'POST',event('crash-after-write'));await h.drain(false,false);
   const receipt=await a.call(a.path('/jobs/'+admitted.receiptId)),target=String(receipt.actionId),store=h.stores.crm;
   const original=store.atomic.bind(store);let injected=false;
   store.atomic=async work=>{const row=await store.get('actions',target);if(!injected&&row?.state==='executing'&&row.networkStarted){injected=true;throw new Error('worker lost before result commit');}return original(work);};
   try{await dispatchActions(h.dependencies.crm,async m=>executeAction(h.dependencies.crm,m,h.crm.check));}finally{store.atomic=original;}
   assert(injected);assert.equal((await store.get('actions',target))!.state,'executing');assert.equal((await h.stores.simulator.find('effects',{_id:target})).length,1);
   h.advance(91000);await h.drain();assert.equal((await store.get('actions',target))!.state,'verified');assert.equal((await store.get('actions',target))!.attemptCount,1);
  });
  const sale=await a.call(a.path('/revenue-events'),'POST',{kind:'sale',businessKey:'recovery-sale',leadId,currency:'USD',amount:'1000.00',occurredAt:h.now().toISOString(),sourceReference:'synthetic'});
  const request={name:'Recovered report',model:'linear',from:new Date(h.now().getTime()-86400000).toISOString(),to:new Date(h.now().getTime()+86400000).toISOString(),lookbackDays:30};
  await t.test('a missing BullMQ job is reconstructed from the report ledger',async()=>{
   const operation=await a.call(a.path('/reports'),'POST',request);const messages:ActionMessage[]=[];
   await dispatchReports(h.dependencies.reporting,async m=>{messages.push(m);});assert.equal(messages.length,1);
   h.advance(21000);await recoverReports(h.dependencies.reporting);await h.drain();
   assert.equal((await a.call(a.path('/jobs/'+operation.operationId))).state,'completed');
   await h.reporting.run(messages[0]!);assert.equal((await h.stores.reporting.find('reports',{_id:operation.operationId})).length,1);
  });
  await t.test('concurrent refunds respect the original sale balance',async()=>{
   const create=(key:string)=>a.request(a.path('/revenue-events'),'POST',{kind:'refund',businessKey:key,leadId,originalSaleId:sale.id,currency:'USD',amount:'600.00',occurredAt:h.now().toISOString(),sourceReference:'synthetic'});
   const responses=await Promise.all([create('refund-a'),create('refund-b')]);assert.deepEqual(responses.map(r=>r.status).sort(),[201,422]);
   assert.equal((await h.stores.reporting.get('revenue',sale.id))!.refundedMinor,'60000');
  });
  await t.test('a cache outage or corrupted value cannot alter an authorized report',async()=>{
   const operation=await a.call(a.path('/reports'),'POST',request);await h.drain();let mode='corrupt';
   h.settings.reporting.cache={get:async()=>{if(mode==='fail')throw new Error('cache offline');return '{"currencies":[]}';},set:async()=>{}};
   for(mode of ['corrupt','fail']){const result=await a.call(a.path('/reports/'+operation.operationId));assert.equal((result.result.currencies as Entity[])[0]!.observedMinor,'40000');}
  });
 }finally{await h.close();}
});
