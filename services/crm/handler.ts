import {normalizedEmailHash} from '../../packages/providers/adapters.ts';
import {unknownGoogleConsent} from '../../packages/providers/contracts.ts';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonical,hash,requireThat,stableId,scoped,preflight,type Scope,type ConsentState} from '../../packages/domain/core.ts';
import * as dto from '../../packages/contracts/index.ts';
import {audit,idempotent,owned,page,rowScope,scopeFields,type Entity} from '../shared/store.ts';
import {allow,authorize,currentActor,interactiveInput,keyOf,scopeSchema,type Dependencies,type Handler} from '../shared/context.ts';
import {createAction,requestActionRecovery,type Check} from '../shared/actions.ts';
import {emit,recordProcessed} from '../shared/events.ts';
import type {Event} from '../shared/authentication.ts';

export function crmService(d:Dependencies):{handler:Handler;consume:(event:Event)=>Promise<void>;check:Check} {
  async function consume(event:Event) {
    requireThat(event.type==='receipt.accepted.v2'&&event.producer==='connections'&&event.category==='lead','EVENT_MISMATCH','CRM projector accepts only lead receipts.',403);
    const bundle=await d.call('connections','readEventReceipt',{event}),receipt=bundle.receipt as Entity,source=bundle.source as Entity;
    const scope:Scope={...rowScope(receipt),actorId:String(source.createdBy),role:'owner'};
    const payload=dto.leadEvent.parse(receipt.payload);
    const destination=source.crmDestinationId?await d.call('connections','connectionState',{scope,id:source.crmDestinationId}):null;
    const result=await d.store.atomic(async tx=>{
      const prior=await tx.get('processed',event.id);
      if(prior){requireThat(prior.eventHash===hash(canonical(event)),'EVENT_CONFLICT','Event content changed.',409);return prior.result as Entity;}
      const leadId='lead_'+stableId(scope.organizationId,scope.workspaceId,scope.environment,source._id,payload.externalLeadKey);
      const old=await tx.get('leads',leadId);
      const sourceHash=hash(canonical({fullName:payload.fullName,email:payload.email,sourceVersion:payload.sourceVersion,touchLink:payload.touchLink??null}));
      let errorCode:string|undefined;
      if(!source.enabled)errorCode='SOURCE_DISABLED';
      if(old&&old.sourceVersion===payload.sourceVersion&&old.sourceHash!==sourceHash)errorCode='SOURCE_VERSION_CONFLICT';
      if(old?.visitorId&&payload.touchLink&&(old.visitorId!==payload.touchLink.visitorId||old.touchSourceId!==payload.touchLink.sourceId))errorCode='IDENTITY_LINK_CONFLICT';
      let result:Entity={_id:receipt._id,state:'processed',resourceId:leadId};
      if(errorCode)result={_id:receipt._id,state:'quarantined',errorCode};
      else if(old&&payload.sourceVersion<=Number(old.sourceVersion))result.state='ignored_stale_or_duplicate';
      else {
        const version=Number(old?.version??0)+1;
        const lead:Entity={...(old??{}),_id:leadId,...scopeFields(scope),fullName:payload.fullName,email:payload.email,sourceId:source._id,
          externalLeadKey:payload.externalLeadKey,sourceVersion:payload.sourceVersion,sourceHash,version,stage:old?.stage??'new',
          createdBy:source.createdBy,createdAt:old?.createdAt??d.now().toISOString(),lastReceiptId:receipt._id,updatedAt:d.now().toISOString(),
          identityBasis:'Signed source-bound external key; no email merging',...(payload.touchLink?{touchSourceId:payload.touchLink.sourceId,visitorId:payload.touchLink.visitorId}:{})};
        await tx.put('leads',lead);
        // A repeated/imported lead never overwrites an explicit withdrawal or other recorded preference change.
        if(!await tx.get('consents',leadId)){
          await tx.insert('consents',{_id:leadId,...scopeFields(scope),consent:payload.consent,googleConsent:payload.googleConsent??unknownGoogleConsent,evidence:payload.evidence,version:1,createdAt:d.now().toISOString(),provenance:'signed_source_assertion'});
          await tx.insert('consentHistory',{_id:randomUUID(),...scopeFields(scope),leadId,version:1,consent:payload.consent,googleConsent:payload.googleConsent??unknownGoogleConsent,evidence:payload.evidence,actorId:scope.actorId,createdAt:d.now().toISOString()});
        }
        if(!old)await tx.insert('stages',{_id:randomUUID(),...scopeFields(scope),leadId,version,stage:'new',reason:'Signed source admission',actorId:scope.actorId,occurredAt:payload.occurredAt,createdAt:d.now().toISOString()});
        if(source.crmDestinationId){const action=await createAction(d,tx,scope,{kind:'crm.upsert',leadId,sourceId:source._id,destinationId:String(source.crmDestinationId),destinationVersion:Number(destination!.version),
          version,businessId:leadId,payload:{fullName:payload.fullName,email:payload.email,stage:lead.stage}});result.actionId=action._id;}
        await emit(tx,'crm',d.settings.keyRing,scope,'lead.changed.v2',leadId,undefined,event.id);
      }
      await recordProcessed(tx,event,result);return result;
    });
    const {_id:_,...ack}=result;void _;await d.call('connections','acknowledgeReceipt',{event,result:ack});
  }
  async function manifest(scope:Scope,ids:string[]) {
    await currentActor(d,scope,'reports:read');
    return d.store.atomic(async tx=>{
      const leads=[],policies=[];
      for(const id of [...new Set(ids)].sort()){
        const lead=await owned(tx,'leads',id,scope),consent=await owned(tx,'consents',id,scope);
        leads.push({id:lead._id,...(lead.touchSourceId&&lead.visitorId?{touchSourceId:String(lead.touchSourceId),visitorId:String(lead.visitorId)}:{}),analytics:consent.consent.analytics});
        policies.push({id:lead._id,leadVersion:lead.version,consentVersion:consent.version,analytics:consent.consent.analytics});
      }
      return {leads,policies,policyDigest:hash(canonical(policies)),capturedAt:d.now().toISOString()};
    });
  }
  const check:Check=async(action,scope)=>{
    const [actor,source,destination,lead,consent]=await Promise.all([
      currentActor(d,scope,'actions:write'),d.call('connections','connectionState',{scope,id:action.sourceId}),
      d.call('connections','connectionState',{scope,id:action.destinationId}),owned(d.store,'leads',String(action.leadId),scope),owned(d.store,'consents',String(action.leadId),scope),
    ]);
    const reasons=preflight({environment:scope.environment,enabled:Boolean(destination.enabled),sourceEnabled:Boolean(source.enabled),role:actor.role,
      consent:consent.consent.service as ConsentState,capability:['simulator_crm','zoho'].includes(String(destination.provider)),productionCapable:destination.provider==='zoho',currentVersion:Number(lead.version),requestedVersion:Number(action.version),deadline:String(action.deadline)},d.now().getTime());
    if(action.destinationVersion&&action.destinationVersion!==destination.version)reasons.push('DESTINATION_VERSION_CHANGED');
    return {destination,reasons};
  };
  const handler:Handler=async(r,caller)=>{
    if(r.operation==='leadState') {
      allow(caller,'reporting','activation');
      const input=z.object({scope:scopeSchema,id:dto.id,purpose:z.enum(['revenue','report','activation'])}).strict().parse(r.input);
      const permission=caller==='activation'?'actions:write':input.purpose==='revenue'?'revenue:write':'reports:read';
      await currentActor(d,input.scope,permission);
      const lead=await owned(d.store,'leads',input.id,input.scope),consent=await owned(d.store,'consents',input.id,input.scope);
      const identifiers=input.purpose==='activation'&&consent.consent.advertising==='granted'?{metaEmailSha256:normalizedEmailHash(String(lead.email),'meta'),
        ...(consent.googleConsent?.adUserData==='granted'?{googleEmailSha256:normalizedEmailHash(String(lead.email),'google')}:{})}:{};
      return {identifiers,lead:{_id:lead._id,sourceId:lead.sourceId,version:lead.version,...(lead.touchSourceId?{touchSourceId:lead.touchSourceId,visitorId:lead.visitorId}:{})},consent};
    }
    if(r.operation==='reportManifest') {
      allow(caller,'reporting');const input=z.object({scope:scopeSchema,ids:z.array(dto.id).max(1000)}).strict().parse(r.input);
      return manifest(input.scope,input.ids);
    }
    const input=interactiveInput.parse(r.input);
    const permission=['changeStage','changeConsent'].includes(r.operation)?'leads:write':['deliver','recoverAction'].includes(r.operation)?'actions:write':
      ['actions','action','job'].includes(r.operation)?'actions:read':'leads:read';
    const scope=await authorize(d,r,caller,input.workspaceId,permission);
    if(r.operation==='list') {const result=await page(d.store,'leads',scope,{},input.cursor);if(scope.role==='analyst')for(const item of result.items){delete item.email;delete item.fullName;}return result;}
    if(r.operation==='overview')return {leads:(await d.store.find('leads',scoped(scope),{limit:10001})).length};
    if(r.operation==='actions'){const result=await page(d.store,'actions',scope,{},input.cursor);for(const a of result.items){delete a.payload;delete a.inputHash;}return result;}
    const id=dto.id.parse(input.id);
    if(r.operation==='recoverAction'){const body=dto.actionRecoveryInput.parse(input.body);requireThat(!body.previewHash,'INVALID_ARGUMENT','CRM recovery does not use conversion previews.');
      return requestActionRecovery(d,scope,id,keyOf(input.key),body,check);}
    if(r.operation==='action'||r.operation==='job'){
      const action=await owned(d.store,'actions',id,scope);delete action.payload;delete action.inputHash;
      return r.operation==='job'?action:{action,attempts:await page(d.store,'attempts',scope,{actionId:id})};
    }
    const lead=await owned(d.store,'leads',id,scope);
    if(r.operation==='details') {
      const consent=await owned(d.store,'consents',id,scope),stages=await page(d.store,'stages',scope,{leadId:id}),actions=await page(d.store,'actions',scope,{leadId:id});
      for(const a of actions.items){delete a.payload;delete a.inputHash;}
      if(scope.role==='analyst'){delete lead.email;delete lead.fullName;}
      const touches=lead.touchSourceId&&lead.visitorId?await d.call('journeys','snapshot',{scope,pairs:[{sourceId:lead.touchSourceId,visitorId:lead.visitorId}],
        from:'1970-01-01T00:00:00.000Z',to:d.now().toISOString(),capturedAt:d.now().toISOString()}):{items:[],count:0};
      return {lead,consent,stages,actions,touches};
    }
    if(r.operation==='changeConsent') {
      const body=dto.consentInput.parse(input.body);
      return idempotent(d.store,scope,'consent.change:'+id,keyOf(input.key),body,async tx=>{
        const current=await owned(tx,'consents',id,scope);requireThat(current.version===body.expectedVersion,'STATE_CONFLICT','Refresh the current preferences.',409);
        const version=Number(current.version)+1;
        await tx.put('consents',{...current,consent:body.consent,googleConsent:body.googleConsent??current.googleConsent??unknownGoogleConsent,evidence:body.evidence,version,updatedAt:d.now().toISOString()});
        await tx.insert('consentHistory',{_id:randomUUID(),...scopeFields(scope),leadId:id,version,previousConsent:current.consent,consent:body.consent,googleConsent:body.googleConsent??current.googleConsent??unknownGoogleConsent,evidence:body.evidence,actorId:scope.actorId,createdAt:d.now().toISOString()});
        await audit(tx,scope,'consent.changed',id,{version});await emit(tx,'crm',d.settings.keyRing,scope,'consent.changed.v2',id);return {id,version};
      });
    }
    if(r.operation==='changeStage') {
      const body=dto.stageInput.parse(input.body),source=await d.call('connections','connectionState',{scope,id:lead.sourceId});
      const destination=source.crmDestinationId?await d.call('connections','connectionState',{scope,id:source.crmDestinationId}):null;
      return idempotent(d.store,scope,'lead.stage:'+id,keyOf(input.key),body,async tx=>{
        const current=await owned(tx,'leads',id,scope);requireThat(current.version===body.expectedVersion,'STATE_CONFLICT','Refresh the lead.',409);
        const version=Number(current.version)+1;
        await tx.put('leads',{...current,stage:body.stage,version,updatedAt:d.now().toISOString()});
        await tx.insert('stages',{_id:randomUUID(),...scopeFields(scope),leadId:id,version,stage:body.stage,reason:body.reason,actorId:scope.actorId,occurredAt:d.now().toISOString(),createdAt:d.now().toISOString()});
        if(source.crmDestinationId)await createAction(d,tx,scope,{kind:'crm.upsert',leadId:id,sourceId:String(source._id),destinationId:String(source.crmDestinationId),destinationVersion:Number(destination!.version),version,businessId:id,
          payload:{fullName:current.fullName,email:current.email,stage:body.stage}});
        await audit(tx,scope,'lead.stage.changed',id,{stage:body.stage});await emit(tx,'crm',d.settings.keyRing,scope,'lead.changed.v2',id);return {id,version};
      });
    }
    if(r.operation==='deliver') {
      const body=z.object({destinationId:dto.id}).strict().parse(input.body),destination=await d.call('connections','connectionState',{scope,id:body.destinationId});
      requireThat(destination.enabled&&['simulator_crm','zoho'].includes(String(destination.provider)),'INVALID_DESTINATION','Select an enabled CRM destination.');
      return idempotent(d.store,scope,'lead.deliver:'+id,keyOf(input.key),body,async tx=>{
        const current=await owned(tx,'leads',id,scope),action=await createAction(d,tx,scope,{kind:'crm.upsert',leadId:id,sourceId:String(current.sourceId),destinationId:body.destinationId,destinationVersion:Number(destination.version),
          version:Number(current.version),businessId:id,payload:{fullName:current.fullName,email:current.email,stage:current.stage}});
        await audit(tx,scope,'crm.delivery.requested',action._id);return {operationId:action._id,state:action.state};
      });
    }
    throw new Error('Unknown CRM operation');
  };
  return {handler,consume,check};
}
