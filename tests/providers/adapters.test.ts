import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createProviderExecutor,normalizedEmailHash} from '../../packages/providers/adapters.ts';
import {approvedProviderUrl,retryDelay,type HttpTransport} from '../../packages/providers/http.ts';
import {fileBindings,resolveBinding,tokenVault} from '../../packages/providers/vault.ts';
import {DomainError,hash,canonical} from '../../packages/domain/core.ts';
import {providerConfig} from '../../packages/providers/contracts.ts';
import {fixture,now,reply,fields,remote} from './fixtures.ts';
type MetaRequest={data:{event_id:string;action_source:string;custom_data:{value:number}}[];test_event_code:string};
type GoogleRequest={validateOnly:boolean;encoding:string;events:{transactionId:string;consent:{adPersonalization:string;adUserData:string}}[];destinations:{operatingAccount:{accountType:string;accountId:string};productDestinationId:string}[]};

test('provider contracts reject unsupported capabilities and ambiguous mappings',()=>{
  const {destination}=fixture('zoho');const config=destination.providerConfig;
  assert.equal(providerConfig.safeParse({...config,apiUrl:'http://127.0.0.1'}).success,false);
  assert.equal(providerConfig.safeParse({...config,externalKeyField:'Email'}).success,false);
  assert.equal(providerConfig.safeParse({...config,defaults:{Last_Name:'overwrite'}}).success,false);
});
test('Google-specific email normalization is not applied to other providers or domains',()=>{
  assert.equal(normalizedEmailHash('First.Last+Offer@GMAIL.COM','google'),hash('firstlast@gmail.com'));
  assert.equal(normalizedEmailHash('First.Last+Offer@example.com','google'),hash('first.last+offer@example.com'));
  assert.equal(normalizedEmailHash('First.Last+Offer@gmail.com','meta'),hash('first.last+offer@gmail.com'));
  assert.throws(()=>normalizedEmailHash('not-an-email','google'));
});
test('fixed HTTPS egress and bounded Retry-After parsing',()=>{
  assert.equal(approvedProviderUrl('https://sandbox.zohoapis.in/crm/v8/Leads').hostname,'sandbox.zohoapis.in');
  for(const url of ['http://graph.facebook.com','https://graph.facebook.com.evil.test','https://127.0.0.1','https://user:secret@graph.facebook.com','https://graph.facebook.com:444','https://graph.facebook.com/#fragment'])assert.throws(()=>approvedProviderUrl(url));
  assert.equal(retryDelay(new Headers({'retry-after':'999999'})),3600000);assert.equal(retryDelay(new Headers({'retry-after':'-1'})),1000);
  assert.equal(retryDelay(new Headers({'retry-after':new Date(now+7000).toUTCString()}),now),7000);
});
test('credential lookup binds owner, workspace, environment, destination, provider, config and approval',()=>{
  const {action,destination,binding}=fixture('meta');assert.equal(resolveBinding(()=>[binding],action,destination,now).credentialRef,'cred_one');
  for(const changed of [{workspaceId:'another'}, {organizationId:'another'}, {environment:'production' as const},{destinationId:'another'}])
    assert.throws(()=>resolveBinding(()=>[binding],{...action,...changed},destination,now));
  assert.throws(()=>resolveBinding(()=>[binding,binding],action,destination,now));
  assert.throws(()=>resolveBinding(()=>[{...binding,configHash:'a'.repeat(64)}],action,destination,now));
  assert.throws(()=>resolveBinding(()=>[{...binding,approval:{...binding.approval,expiresAt:new Date(now-1).toISOString()}}],action,destination,now));
});
test('credential file rejects world access and reloads changed binding data',()=>{
  const dir=mkdtempSync(join(tmpdir(),'provider-bindings-')),path=join(dir,'bindings.json'),f=fixture('meta');
  try {writeFileSync(path,JSON.stringify({bindings:[f.binding]}),{mode:0o600});const load=fileBindings(path);assert.equal(load().length,1);
    chmodSync(path,0o644);if(process.platform!=='win32')assert.throws(load);
    chmodSync(path,0o600);writeFileSync(path,JSON.stringify({bindings:[]}));assert.equal(load().length,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('OAuth refresh coalesces, reuses unexpired token and refuses a rotated refresh token without persistence',async()=>{
  const {binding,destination}=fixture('zoho');binding.expiresAt=new Date(now-1).toISOString();binding.oauth={clientId:'test-client',clientSecret:'test-client-secret',refreshToken:'test-refresh'};
  let calls=0;const http:HttpTransport=async(url,init)=>{calls++;assert.equal(url,'https://accounts.zoho.in/oauth/v2/token');assert.equal(new URLSearchParams(String(init.body)).get('refresh_token'),'test-refresh');await new Promise(r=>setTimeout(r,5));return reply(200,{access_token:'new-test-token',expires_in:3600});};
  const vault=tokenVault(http);assert.deepEqual(await Promise.all([vault(binding,destination,now),vault(binding,destination,now)]),['new-test-token','new-test-token']);
  assert.equal(await vault(binding,destination,now+5000),'new-test-token');assert.equal(calls,1);
  await vault(binding,destination,now+3600000);assert.equal(calls,2);
  await assert.rejects(()=>tokenVault(async()=>reply(200,{access_token:'another-token',expires_in:3600,refresh_token:'rotated-token'}))(binding,destination,now),/Persist rotated/);
});
test('Meta server event has stable identity, hashed email, safe value and explicit test mode',async()=>{
  const f=fixture('meta');let sent:MetaRequest|undefined,checks=0;
  const execute=createProviderExecutor(()=>[f.binding],async(url,init)=>{assert.equal(url,'https://graph.facebook.com/v24.0/123456/events');sent=JSON.parse(String(init.body));return reply(200,{events_received:1,fbtrace_id:'trace-1'});},()=>now);
  const out=await execute(f.action,f.destination,'write',async()=>{checks++;});
  assert.equal(checks,1);assert.equal(out.state,'accepted_unverified');assert.equal(out.receipt?.evidenceClass,'provider_test');
  assert.equal(sent!.data[0].event_id,f.action._id);assert.equal(sent!.data[0].custom_data.value,1000);assert.equal(sent!.test_event_code,'TEST_fixture');
  assert(!JSON.stringify(sent).includes('synthetic@example.com'));assert.equal(sent!.data[0].action_source,'system_generated');
});
test('Meta production approval, test/live distinction and refund support fail closed',async()=>{
  let calls=0;const f=fixture('meta','production'),execute=createProviderExecutor(()=>[f.binding],async()=>{calls++;return reply();},()=>now);
  f.binding.approval.allowExternalEffects=false;assert.equal((await execute(f.action,f.destination,'write')).state,'rejected');
  f.binding.approval.allowExternalEffects=true;
  assert.equal((await execute({...f.action,kind:'ads.refund'},f.destination,'write')).reason,'UNSUPPORTED_CORRECTION');
  const c=providerConfig.parse({...f.destination.providerConfig,testEventCode:'TEST_bad'});f.destination.providerConfig=c;f.binding.configHash=hash(canonical(c));
  assert.equal((await execute(f.action,f.destination,'write')).reason,'META_TEST_LIVE_MISMATCH');assert.equal(calls,0);
});
test('Meta malformed acknowledgement and network timeout remain unknown with no automatic resend',async()=>{
  const f=fixture('meta');let count=0;
  for(const http of [async()=>reply(200,{}),async()=>{throw new Error('timeout with secret should not leak');}]){
    const execute=createProviderExecutor(()=>[f.binding],async()=>{count++;return http();},()=>now);
    const result=await execute(f.action,f.destination,'write');assert.equal(result.state,'outcome_unknown');
    assert(!JSON.stringify(result).includes('secret'));assert.equal((await execute(f.action,f.destination,'inspect')).state,'review_required');
  }assert.equal(count,2);
});
test('oversized provider money and pre-send consent withdrawal send no event',async()=>{
  const f=fixture('meta');let calls=0;const execute=createProviderExecutor(()=>[f.binding],async()=>{calls++;return reply();},()=>now);
  const out=await execute({...f.action,payload:{...f.action.payload,amountMinor:'9007199254740991999999999'}},f.destination,'write');assert.equal(out.state,'rejected');
  assert.equal((await execute(f.action,f.destination,'write',async()=>{throw new DomainError('ACTION_SUPPRESSED','Withdrawn',403);})).state,'suppressed');assert.equal(calls,0);
});
test('Google sandbox validates only and preserves separate consent fields',async()=>{
  const f=fixture('google');let request:GoogleRequest|undefined;
  const execute=createProviderExecutor(()=>[f.binding],async(url,init)=>{assert(url.endsWith('/v1/events:ingest'));request=JSON.parse(String(init.body));return reply(200,{});},()=>now);
  f.binding.approval.allowExternalEffects=false;const result=await execute(f.action,f.destination,'write');
  assert.equal(result.state,'validation_passed');assert.equal(result.receipt?.evidenceClass,'provider_validation');assert.equal(request!.validateOnly,true);
  assert.equal(request!.events[0]!.transactionId,hash(f.action._id));assert.equal(request!.events[0]!.transactionId.length,64);assert.equal(request!.encoding,'HEX');assert.equal(request!.events[0].consent.adPersonalization,'CONSENT_DENIED');assert.equal(request!.events[0].consent.adUserData,'CONSENT_GRANTED');
  assert.equal(request!.destinations[0].operatingAccount.accountType,'GOOGLE_ADS');
});
test('Google unknown personalization is not silently converted to consent',async()=>{
  const f=fixture('google');let count=0;f.action.payload.googleConsent={adUserData:'granted',adPersonalization:'unknown'};
  const execute=createProviderExecutor(()=>[f.binding],async()=>{count++;return reply();},()=>now);
  assert.equal((await execute(f.action,f.destination,'write')).state,'rejected');assert.equal(count,0);
});
test('Google live response persists a request ID and inspects the exact destination before processed',async()=>{
  const f=fixture('google','production');let sent:GoogleRequest|undefined;let count=0;
  const execute=createProviderExecutor(()=>[f.binding],async(url,init)=>{
    count++;if(init.method==='POST'){sent=JSON.parse(String(init.body));return reply(200,{requestId:'req-live'});}
    assert.equal(new URL(url).searchParams.get('requestId'),'req-live');return reply(200,{requestStatusPerDestination:[{
      destination:sent!.destinations[0],requestStatus:'SUCCESS',eventsIngestionStatus:{recordCount:'1'}}]});
  },()=>now);
  const accepted=await execute(f.action,f.destination,'write');assert.equal(accepted.state,'provider_processing');assert.equal(sent!.validateOnly,false);
  const done=await execute({...f.action,receipt:accepted.receipt},f.destination,'inspect');assert.equal(done.state,'processed');assert.equal(done.receipt?.status,'processed');assert.equal(count,2);
  assert.equal(done.receipt?.evidenceClass,'provider_response');
});
test('Google missing or mismatched evidence, account mismatch and partial success do not verify delivery',async()=>{
  const f=fixture('google','production');let count=0;
  const execute=createProviderExecutor(()=>[f.binding],async()=>{count++;return reply(200,{});},()=>now);
  assert.equal((await execute(f.action,f.destination,'write')).state,'outcome_unknown');
  assert.equal((await execute(f.action,f.destination,'inspect')).reason,'GOOGLE_REQUEST_ID_MISSING_NO_BLIND_RETRY');assert.equal(count,1);
  const accepted=await createProviderExecutor(()=>[f.binding],async()=>reply(200,{requestId:'rid'}),()=>now)(f.action,f.destination,'write');
  for(const [status,account] of [['SUCCESS','wrong'],['PARTIAL_SUCCESS','1234567890']]){
    const out=await createProviderExecutor(()=>[f.binding],async()=>reply(200,{requestStatusPerDestination:[{destination:{operatingAccount:{accountType:'GOOGLE_ADS',accountId:account},productDestinationId:'987654321'},requestStatus:status,eventsIngestionStatus:{recordCount:'1'}}]}),()=>now)({...f.action,receipt:accepted.receipt},f.destination,'inspect');
    assert.notEqual(out.state,'processed');assert.notEqual(out.state,'verified');
  }
  const invalid=await execute({...f.action,receipt:{...accepted.receipt,effectId:'someone-else'}},f.destination,'inspect');assert.notEqual(invalid.state,'processed');assert.equal(count,1);
});
test('Zoho performs metadata-validated stable-key upsert then independent exact read-back',async()=>{
  const f=fixture('zoho');let writes=0;let exists=false;
  const execute=createProviderExecutor(()=>[f.binding],async(url,init)=>{
    if(url.includes('/settings/fields'))return reply(200,{fields:fields()});
    if(init.method==='POST'){
      const body=JSON.parse(String(init.body));assert.deepEqual(body.duplicate_check_fields,['Platform_Key']);assert.deepEqual(body.trigger,[]);
      assert.equal(body.data[0].Platform_Key,f.action.remoteKey);writes++;exists=true;return reply(201,{data:[{status:'success',code:'SUCCESS',details:{id:'123456789'}}]});}
    return exists?reply(200,{data:[remote(f.action)]}):reply(204);
  },()=>now);
  const first=await execute(f.action,f.destination,'write');assert.equal(first.state,'provider_processing');assert.equal(first.receipt?.remoteId,'123456789');
  const final=await execute({...f.action,receipt:first.receipt},f.destination,'inspect');assert.equal(final.state,'verified');assert.equal(writes,1);
  assert.equal((await execute(f.action,f.destination,'write')).state,'verified');assert.equal(writes,1);
});
test('Zoho invalid metadata, missing required fields and secondary unique mappings block before upsert',async()=>{
  const f=fixture('zoho');let writes=0;
  const variations=[
    ()=>fields().map(v=>v.api_name==='Platform_Key'?{...v,unique:{}}:v),
    ()=>fields().map(v=>v.api_name==='Platform_Version'?{...v,data_type:'text'}:v),
    ()=>fields().map(v=>v.api_name==='Last_Name'?{...v,field_read_only:true}:v),
    ()=>fields().map(v=>v.api_name==='Email'?{...v,custom_field:true,unique:{case_sensitive:false}}:v),
    ()=>[...fields(),{...fields()[0]!,api_name:'Required_Extra',system_mandatory:true}],
  ];
  for(const variant of variations){const execute=createProviderExecutor(()=>[f.binding],async(url,init)=>{
    if(init.method==='POST')writes++;return url.includes('/settings/fields')?reply(200,{fields:variant()}):reply(204);
  },()=>now);assert.equal((await execute(f.action,f.destination,'write')).state,'rejected');}
  assert.equal(writes,0);
});
test('Zoho stale external version is not overwritten, and conditional writes preserve Modified_Time',async()=>{
  const f=fixture('zoho');let posted=false;
  const older={...remote(f.action),Platform_Version:1};f.action.version=2;
  const execute=createProviderExecutor(()=>[f.binding],async(url,init)=>{
    if(url.includes('/settings/fields'))return reply(200,{fields:fields()});
    if(init.method==='POST'){posted=true;assert.equal(new Headers(init.headers).get('if-unmodified-since'),older.Modified_Time);return reply(412,{code:'ALREADY_MODIFIED'});}
    return reply(200,{data:[older]});
  },()=>now);
  assert.equal((await execute(f.action,f.destination,'write')).state,'rejected');assert.equal(posted,true);
  const conflict=createProviderExecutor(()=>[f.binding],async()=>reply(200,{data:[{...remote(f.action),Platform_Version:3}]}),()=>now);
  assert.equal((await conflict(f.action,f.destination,'write')).state,'review_required');
});
test('Zoho partial or malformed response and delayed indexing preserve ambiguity correctly',async()=>{
  const f=fixture('zoho');for(const response of [reply(207,{data:[{code:'INVALID_DATA',status:'error'}]}),reply(200,{data:[{code:'SUCCESS',status:'success',details:{}}]})]){
    let writes=0;const execute=createProviderExecutor(()=>[f.binding],async(url,init)=>{
      if(init.method==='POST'){writes++;return response;}return url.includes('/settings/fields')?reply(200,{fields:fields()}):reply(204);
    },()=>now);
    assert.equal((await execute(f.action,f.destination,'write')).state,response.status===207?'rejected':'outcome_unknown');
    assert.equal((await execute(f.action,f.destination,'inspect')).state,'outcome_unknown');assert.equal(writes,1);
  }
});
test('Zoho current permission is rechecked after metadata reads and before the mutation',async()=>{
  const f=fixture('zoho');let reads=0,writes=0;
  const execute=createProviderExecutor(()=>[f.binding],async(url,init)=>{
    if(init.method==='POST')writes++;else reads++;return url.includes('/settings/fields')?reply(200,{fields:fields()}):reply(204);
  },()=>now);
  const out=await execute(f.action,f.destination,'write',async()=>{assert.equal(reads,2);throw new DomainError('ACTION_SUPPRESSED','Consent withdrawn',403);});
  assert.equal(out.state,'suppressed');assert.equal(writes,0);
});
test('a failed pre-write lookup is a confirmed non-write rather than an invented unknown effect',async()=>{
  const f=fixture('zoho');let writes=0;
  const execute=createProviderExecutor(()=>[f.binding],async(_url,init)=>{if(init.method==='POST')writes++;throw new Error('lookup unavailable');},()=>now);
  const result=await execute(f.action,f.destination,'write');assert.equal(result.state,'rejected');assert.equal(result.reason,'PROVIDER_PREWRITE_UNAVAILABLE');assert.equal(writes,0);
});
