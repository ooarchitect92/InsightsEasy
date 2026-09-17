import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonical,hash,requireThat,safeUrl,verifySignature,scoped,stableId,type Scope} from '../../packages/domain/core.ts';
import {seal,unseal} from '../../packages/runtime/crypto.ts';
import * as dto from '../../packages/contracts/index.ts';
import {audit,scopeFields,idempotent,owned,page,rowScope,type Entity} from '../shared/store.ts';
import {allow,authorize,interactiveInput,keyOf,scopeSchema,type Dependencies,type Handler} from '../shared/context.ts';
import {eventSchema,verifyActorAuthority,type Event} from '../shared/authentication.ts';
import {emit} from '../shared/events.ts';
export const catalog=[
  {id:'signed_webhook',name:'Signed server events',kind:'source',state:'native_contract',operations:['lead','touch']},
  {id:'web_collector',name:'First-party collector',kind:'source',state:'native_contract',operations:['touch']},
  {id:'simulator_crm',name:'CRM simulator',kind:'destination',state:'synthetic_only',operations:['upsert','read_back']},
  {id:'simulator_ads',name:'Conversion simulator',kind:'destination',state:'synthetic_only',operations:['purchase','refund','read_back']},
  {id:'meta',name:'Meta',kind:'destination',state:'not_certified',operations:[]},
  {id:'google',name:'Google',kind:'destination',state:'not_certified',operations:[]},
  {id:'zoho',name:'Zoho CRM',kind:'destination',state:'not_certified',operations:[]},
];
export function publicConnection(row:Entity):Entity {const {sealedSecret:_,authority:_authority,...safe}=row;void _;void _authority;return safe as Entity;}
export function connectionsService(d:Dependencies):Handler {
  const {store}=d;
  const secretContext=(s:Scope,id:string)=>`${s.organizationId}:${s.workspaceId}:${s.environment}:connection:${id}`;
  async function rate(sourceId:string) {
    const slot=Math.floor(d.now().getTime()/60000),id=stableId(sourceId,String(slot));
    await store.atomic(async tx=>{const prior=await tx.get('rateLimits',id),count=Number(prior?.count??0)+1;
      requireThat(count<=1000,'SOURCE_RATE_LIMIT','Source minute quota exceeded.',429);
      await tx.put('rateLimits',{_id:id,count,expiresAtDate:new Date((slot+2)*60000)});});
  }
  async function admit(source:Entity,event:dto.InboundEvent) {
    requireThat(source.enabled&&['signed_webhook','web_collector'].includes(String(source.provider)),'SOURCE_UNAVAILABLE','Source is unavailable.',404);
    const scope=rowScope(source);
    requireThat(source.environment===d.settings.environment,'SOURCE_UNAVAILABLE','Source is unavailable.',404);
    requireThat(source.provider!=='web_collector'||event.kind==='touch','UNSUPPORTED_EVENT','Public collection cannot create leads or revenue.',403);
    requireThat(new Date(event.occurredAt).getTime()<=d.now().getTime()+300000,'FUTURE_EVENT','Occurrence time is too far in the future.');
    const payload=structuredClone(event);
    if(payload.kind==='touch') {
      payload.acquisition.url=safeUrl(payload.acquisition.url);
      if(payload.acquisition.referrer)payload.acquisition.referrer=safeUrl(payload.acquisition.referrer);
      if(source.provider==='web_collector')requireThat(new URL(payload.acquisition.url).origin===source.allowedOrigin,'ORIGIN_MISMATCH','Page does not belong to this source.',403);
    }
    return idempotent(store,scope,'source.event:'+source._id,event.eventId,payload,async tx=>{
      const current=await owned(tx,'connections',source._id,scope);requireThat(current.enabled,'SOURCE_DISABLED','Source was disabled.',403);
      if(payload.kind==='lead'&&payload.touchLink){const touchSource=await owned(tx,'connections',payload.touchLink.sourceId,scope);
        requireThat(['signed_webhook','web_collector'].includes(String(touchSource.provider)),'INVALID_IDENTITY_LINK','Touch source must be a collector.');}
      const id='receipt_'+randomUUID();
      const eventId=await emit(tx,'connections',d.settings.keyRing,scope,'receipt.accepted.v2',id,payload.kind);
      await tx.insert('receipts',{_id:id,...scopeFields(scope),sourceId:source._id,payload,payloadHash:hash(canonical(payload)),eventId,
        sourceEventId:payload.eventId,state:'pending',createdBy:source.createdBy,authority:scope.authority,createdAt:d.now().toISOString()});
      await audit(tx,scope,'event.durably.accepted',id);
      return {operationId:id,receiptId:id,admissionState:'durably_accepted',processingState:'pending',statusUrl:`/v1/workspaces/${scope.workspaceId}/jobs/${id}`};
    });
  }
  async function eventReceipt(event:Event,caller:string) {
    requireThat(event.producer==='connections'&&event.type==='receipt.accepted.v2','EVENT_MISMATCH','Unexpected event.',403);
    const record=await store.get('outbox',event.id),receipt=await store.get('receipts',event.resourceId);
    requireThat(record&&canonical(record.signed.event)===canonical(event)&&receipt&&receipt.eventId===event.id,'EVENT_MISMATCH','Receipt does not match the committed event.',403);
    requireThat((receipt.payload.kind==='lead'&&caller==='crm')||(receipt.payload.kind==='touch'&&caller==='journeys'),'EVENT_OWNER_MISMATCH','Caller does not own this receipt projection.',403);
    return receipt;
  }
  return async(r,caller)=>{
    if(r.operation==='connectionState') {
      allow(caller,'crm','journeys','reporting','activation');
      const input=z.object({scope:scopeSchema,id:dto.id}).strict().parse(r.input);
      verifyActorAuthority(input.scope,d.settings.keyRing.publicKeys);
      return publicConnection(await owned(store,'connections',input.id,input.scope));
    }
    if(r.operation==='readEventReceipt') {
      allow(caller,'crm','journeys');const input=z.object({event:eventSchema}).strict().parse(r.input);
      const receipt=await eventReceipt(input.event,caller),source=await owned(store,'connections',String(receipt.sourceId),rowScope(receipt));
      return {receipt,source:publicConnection(source)};
    }
    if(r.operation==='acknowledgeReceipt') {
      allow(caller,'crm','journeys');
      const input=z.object({event:eventSchema,result:z.object({state:z.enum(['processed','quarantined','ignored_stale_or_duplicate']),resourceId:dto.id.optional(),actionId:dto.id.optional(),errorCode:z.string().max(100).optional()}).strict()}).strict().parse(r.input);
      const receipt=await eventReceipt(input.event,caller);
      return store.atomic(async tx=>{
        const current=await tx.get('receipts',receipt._id);requireThat(current,'NOT_FOUND','Receipt not found.',404);
        const resultHash=hash(canonical(input.result));
        requireThat(!current.resultHash||current.resultHash===resultHash,'RECEIPT_RESULT_CONFLICT','A receipt already has another terminal result.',409);
        await tx.put('receipts',{...current,...input.result,resultHash,processedAt:d.now().toISOString()});return {acknowledged:true};
      });
    }
    if(r.operation==='ingest') {
      allow(caller,'gateway');
      const input=z.object({sourceId:dto.id,mode:z.enum(['signed','collector']),raw:z.string().max(45000),
        origin:z.string().max(512).optional(),timestamp:z.string().max(30).optional(),signature:z.string().max(100).optional()}).strict().parse(r.input);
      const source=await store.get('connections',input.sourceId);requireThat(source&&source.enabled,'SOURCE_UNAVAILABLE','Source is unavailable.',404);
      const raw=Buffer.from(input.raw,'base64');requireThat(raw.byteLength<=32768,'REQUEST_TOO_LARGE','Event exceeds the payload limit.',413);
      await rate(source._id);
      if(input.mode==='signed'){
        requireThat(source.provider==='signed_webhook','SOURCE_UNAVAILABLE','Signed source is unavailable.',404);
        const secret=unseal(String(source.sealedSecret),d.settings.encryptionKey,secretContext(rowScope(source),source._id));
        requireThat(verifySignature(secret,input.timestamp??'',raw,input.signature??'',Math.floor(d.now().getTime()/1000)),
          'INVALID_SIGNATURE','Webhook signature is invalid.',401);
      }else requireThat(source.provider==='web_collector'&&input.origin===source.allowedOrigin,'ORIGIN_DENIED','Collector origin is not permitted.',403);
      const payload=dto.inboundEvent.parse(JSON.parse(raw.toString('utf8')));return admit(source,payload);
    }
    if(r.operation==='collectorConfiguration') {
      allow(caller,'gateway');const input=z.object({sourceId:dto.id,origin:z.string().max(512)}).strict().parse(r.input);
      const source=await store.get('connections',input.sourceId);
      requireThat(source?.enabled&&source.provider==='web_collector'&&source.allowedOrigin===input.origin,'ORIGIN_DENIED','Collector origin is not permitted.',403);
      return {origin:source.allowedOrigin};
    }
    const input=interactiveInput.parse(r.input),write=['create','setEnabled','testEvent'].includes(r.operation);
    const scope=await authorize(d,r,caller,input.workspaceId,write?'sources:write':'sources:read');
    if(r.operation==='catalog')return {items:catalog};
    if(r.operation==='list') {const result=await page(store,'connections',scope,{},input.cursor);return {...result,items:result.items.map(publicConnection)};}
    if(r.operation==='receipts') {const result=await page(store,'receipts',scope,{},input.cursor);return {...result,items:result.items.map(({payload:_,...row})=>{void _;return row;})};}
    if(r.operation==='job') {const row=await owned(store,'receipts',dto.id.parse(input.id),scope);delete row.payload;return row;}
    if(r.operation==='overview')return {pendingReceipts:(await store.find('receipts',scoped(scope,{state:'pending'}),{limit:10001})).length};
    if(r.operation==='create') {
      const body=dto.connectionInput.parse(input.body);
      requireThat(!body.provider.startsWith('simulator')||scope.environment==='sandbox','LIVE_CAPABILITY_UNAVAILABLE','Simulators cannot be enabled in production.');
      requireThat(body.provider.startsWith('simulator')||body.failureMode==='normal','INVALID_TEST_MODE','Failure injection is restricted to simulators.');
      if(body.provider==='web_collector') {
        requireThat(body.allowedOrigin,'ORIGIN_REQUIRED','A website origin is required.');const url=new URL(body.allowedOrigin);
        requireThat(url.origin===body.allowedOrigin&&['http:','https:'].includes(url.protocol),'INVALID_ORIGIN','Use an exact HTTP(S) origin.');
        requireThat(scope.environment==='sandbox'||url.protocol==='https:','HTTPS_REQUIRED','Production collection requires HTTPS.');
      }
      requireThat(!body.crmDestinationId||body.provider==='signed_webhook','INVALID_BINDING','Only signed lead sources can configure automatic CRM delivery.');
      const result=await idempotent(store,scope,'connection.create',keyOf(input.key),body,async tx=>{
        if(body.crmDestinationId){const destination=await owned(tx,'connections',body.crmDestinationId,scope);
          requireThat(destination.provider==='simulator_crm'&&destination.enabled,'INVALID_DESTINATION','Select an enabled CRM destination.');}
        const id=randomUUID(),secret=randomBytes(32).toString('base64url');
        await tx.insert('connections',{_id:id,...scopeFields(scope),...body,enabled:true,version:1,createdBy:scope.actorId,authority:scope.authority,createdAt:d.now().toISOString(),
          capabilityVersion:'five-core-v2',mappingVersion:'canonical-contact-v1',...(body.provider==='signed_webhook'?{sealedSecret:seal(secret,d.settings.encryptionKey,secretContext(scope,id))}:{})});
        await audit(tx,scope,'connection.created',id,{provider:body.provider});return {id};
      });
      const row=await owned(store,'connections',result.id,scope);
      return {connection:publicConnection(row),...(row.sealedSecret?{signingSecret:unseal(String(row.sealedSecret),d.settings.encryptionKey,secretContext(scope,row._id))}:{})};
    }
    if(r.operation==='setEnabled') {
      const id=dto.id.parse(input.id),body=z.object({enabled:z.boolean(),expectedVersion:z.number().int().positive()}).strict().parse(input.body);
      return idempotent(store,scope,'connection.enabled:'+id,keyOf(input.key),body,async tx=>{
        const old=await owned(store,'connections',id,scope);requireThat(old.version===body.expectedVersion,'STATE_CONFLICT','Refresh the connection.',409);
        await tx.put('connections',{...old,enabled:body.enabled,version:Number(old.version)+1});
        await audit(tx,scope,'connection.enabled.changed',id,{enabled:body.enabled});return {updated:true,version:Number(old.version)+1};
      });
    }
    if(r.operation==='testEvent') {
      requireThat(scope.environment==='sandbox','TEST_MODE_ONLY','Synthetic entry is restricted to sandbox.',403);
      return admit(await owned(store,'connections',dto.id.parse(input.id),scope),dto.inboundEvent.parse(input.body));
    }
    throw new Error('Unknown connections operation');
  };
}
