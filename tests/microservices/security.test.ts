import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {createHarness} from './harness.ts';
import {MemoryStore} from './memory-store.ts';
import {issueServiceToken,verifyServiceToken,consumeNonce,signEvent,verifyEvent,type Event,type KeyRing} from '../../services/shared/authentication.ts';
import {signDispatch,verifyDispatch} from '../../services/shared/dispatch-signature.ts';
import {idempotent} from '../../services/shared/store.ts';
import {publishOutbox} from '../../services/shared/events.ts';
import {canonical,hash,type Scope} from '../../packages/domain/core.ts';
function ring(owner='crm'):KeyRing {const keys=generateKeyPairSync('ed25519',{privateKeyEncoding:{format:'pem',type:'pkcs8'},publicKeyEncoding:{format:'pem',type:'spki'}});
  return {keyId:'test',privateKey:keys.privateKey,publicKeys:{[owner+':test']:keys.publicKey}};}
const scope:Scope={organizationId:'org',workspaceId:'workspace',environment:'sandbox',actorId:'actor',role:'owner'};
for(const mutation of ['body','audience','expiry','signature','issuer'] as const)test('RPC signature rejects '+mutation,()=>{
  const key=ring(),body=Buffer.from('{}'),token=issueServiceToken('crm','identity',body,key,1000);
  assert.throws(()=>verifyServiceToken(mutation==='signature'?token.slice(0,-10)+'invalidsig':token,
    mutation==='audience'?'reporting':'identity',mutation==='body'?Buffer.from('{"tampered":true}'):body,
    mutation==='issuer'?ring('activation').publicKeys:key.publicKeys,mutation==='expiry'?1031:1001));
});
test('RPC nonce cannot be consumed twice',async()=>{const key=ring(),raw=Buffer.from('{}'),token=issueServiceToken('crm','identity',raw,key);
  const claims=verifyServiceToken(token,'identity',raw,key.publicKeys),store=new MemoryStore('identity');await consumeNonce(store,claims);
  await assert.rejects(consumeNonce(store,claims),/already consumed/);});
test('signed command owner, payload and generation are integrity protected',()=>{
  const key=ring(),message={id:'crm_test',generation:1,...scope},wire=signDispatch('crm',{id:message.id,generation:message.generation,organizationId:scope.organizationId,workspaceId:scope.workspaceId,environment:scope.environment},key);
  assert.equal(verifyDispatch(wire,'crm',key.publicKeys).id,'crm_test');
  assert.throws(()=>verifyDispatch(wire,'activation',key.publicKeys));assert.throws(()=>verifyDispatch({...wire,message:{...wire.message,generation:2}},'crm',key.publicKeys));
});
test('a signed event cannot claim a different producer-owned fact',()=>{
  const key=ring(),event:Event={v:2,id:randomUUID(),type:'lead.changed.v2',producer:'crm',keyId:'test',organizationId:'org',workspaceId:'workspace',environment:'sandbox',resourceId:'lead',correlationId:'lead',occurredAt:new Date().toISOString()};
  assert.equal(verifyEvent(signEvent(event,key),key.publicKeys).producer,'crm');
  assert.throws(()=>verifyEvent(signEvent({...event,type:'revenue.recorded.v2'},key),key.publicKeys));
});
test('owner repositories reject another owner collection',async()=>{
  const store=new MemoryStore('connections');await assert.rejects(store.find('leads'),/does not own/);
  await assert.rejects(store.atomic(tx=>tx.insert('revenue',{_id:'forbidden'})),/does not own/);
});
test('local transaction rollback does not leave a partial outbox or business mutation',async()=>{
  const store=new MemoryStore('connections');await assert.rejects(store.atomic(async tx=>{await tx.insert('receipts',{_id:'receipt'});throw new Error('injected');}));
  assert.equal(await store.get('receipts','receipt'),null);
});
test('concurrent equal requests share the same committed response',async()=>{
  const store=new MemoryStore('connections');let executions=0;
  const work=()=>idempotent(store,scope,'test','same-key',{field:'same'},async tx=>{executions++;await tx.insert('receipts',{_id:'one'});return {id:'one'};});
  const outputs=await Promise.all(Array.from({length:20},work));assert.equal(executions,1);assert(outputs.every(x=>x.id==='one'));
  await assert.rejects(idempotent(store,scope,'test','same-key',{field:'changed'},async()=>({id:'wrong'})),/different|conflict/i);
});
test('outbox publish ambiguity republishes the same signed event identity',async()=>{
  const store=new MemoryStore('crm'),key=ring(),event:Event={v:2,id:randomUUID(),type:'lead.changed.v2',producer:'crm',keyId:'test',organizationId:'org',workspaceId:'workspace',environment:'sandbox',resourceId:'lead',correlationId:'lead',occurredAt:new Date().toISOString()};
  await store.insert('outbox',{_id:event.id,signed:signEvent(event,key),state:'pending',leaseUntil:0,attempts:0});const sent:string[]=[];
  await publishOutbox(store,async signed=>{sent.push(signed.event.id);throw new Error('lost confirmation');});
  await publishOutbox(store,async signed=>{sent.push(signed.event.id);},Date.now()+3000);
  assert.deepEqual(sent,[event.id,event.id]);assert.equal((await store.get('outbox',event.id))!.state,'published');
});
test('real HTTP permissions and browser delegation are narrowly scoped',async t=>{
  const h=await createHarness();try{const owner=await h.register('Boundary owner'),viewer=await h.register('Boundary viewer'),token=owner.cookie.split('=')[1]!;
    await t.test('a domain can introspect but cannot log in or alter membership as the gateway',async()=>{
      const ctx={sessionToken:token};assert.equal((await h.dependencies.connections.call('identity','authorize',{workspaceId:owner.workspace,permission:'sources:read'},ctx)).actorId,owner.userId);
      await assert.rejects(h.dependencies.connections.call('identity','me',{},ctx),/cannot delegate/);
      await assert.rejects(h.dependencies.connections.call('crm','list',{workspaceId:owner.workspace},ctx),/cannot delegate/);
    });
    await t.test('a service cannot invent a background actor from known tenant identifiers',async()=>{
      await assert.rejects(h.dependencies.reporting.call('identity','authorizeActor',{scope:{organizationId:owner.workspace,workspaceId:owner.workspace,actorId:owner.userId,role:'owner',environment:'sandbox'},permission:'reports:read'}),/delegation/i);
    });
    await t.test('service authentication is mandatory and replay is rejected over HTTP',async()=>{
      const raw=Buffer.from(JSON.stringify({v:1,operation:'meta',input:{},context:{}}));const url=h.origins.identity+'/rpc';
      assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:raw})).status,401);
      const signed=issueServiceToken('gateway','identity',raw,h.settings.gateway.keyRing);const headers={'content-type':'application/json',authorization:'Service '+signed};
      assert.equal((await fetch(url,{method:'POST',headers,body:raw})).status,200);assert.equal((await fetch(url,{method:'POST',headers,body:raw})).status,409);
    });
    await t.test('viewer access denies mutation and sensitive lead reads',async()=>{
      await owner.call(owner.path('/members'),'POST',{email:viewer.email,role:'viewer'});
      assert.equal((await viewer.request(owner.path('/connections'),'POST',{provider:'signed_webhook',name:'forbidden'})).status,403);
      assert.equal((await viewer.request(owner.path('/leads'))).status,403);
      assert.equal((await viewer.request(owner.path('/reports'))).status,200);
    });
    await t.test('current revocation invalidates already-open user sessions for this workspace',async()=>{
      await owner.call(owner.path('/members'),'POST',{email:viewer.email,role:'viewer',active:false});
      assert.equal((await viewer.request(owner.path('/reports'))).status,404);
    });
    await t.test('last owner cannot remove their own last ownership',async()=>{
      assert.equal((await owner.request(owner.path('/members'),'POST',{email:owner.email,role:'viewer'})).status,409);
    });
    await t.test('unapproved Origin and public financial event are denied',async()=>{
      assert.equal((await h.request(owner.path('/connections'),'POST',{name:'CSRF',provider:'signed_webhook'},owner.cookie,randomUUID(),'https://hostile.example')).status,403);
      const source=(await owner.call(owner.path('/connections'),'POST',{name:'public',provider:'web_collector',allowedOrigin:'https://customer.example'})).connection;
      const r=await fetch(h.gateway.listeningOrigin+'/v1/collect/'+source._id,{method:'POST',headers:{'content-type':'application/json',origin:'https://customer.example'},body:JSON.stringify({kind:'sale',amount:'1000'})});
      assert.notEqual(r.status,202);
    });
    await t.test('request signatures reject modified payload bytes',async()=>{
      const source=await owner.call(owner.path('/connections'),'POST',{name:'signed',provider:'signed_webhook'});
      const quotaBefore=await h.stores.connections.find('rateLimits');
      const r=await fetch(h.gateway.listeningOrigin+'/v1/ingest/'+source.connection._id,{method:'POST',headers:{'content-type':'application/json','x-insights-timestamp':String(Math.floor(Date.now()/1000)),'x-insights-signature':'0'.repeat(64)},body:'{}'});
      assert.equal(r.status,401);
      assert.deepEqual(await h.stores.connections.find('rateLimits'),quotaBefore,'Invalid signatures cannot consume the authenticated source quota');
    });
    await t.test('response hashes use deterministic canonical JSON',()=>assert.equal(hash(canonical({b:2,a:1})),hash(canonical({a:1,b:2}))));
  }finally{await h.close();}
});
