import {randomUUID} from 'node:crypto';
import {canonical,hash,requireThat,preflight,scoped,type Scope,type ConsentState} from '../../packages/domain/core.ts';
import * as dto from '../../packages/contracts/index.ts';
import {audit,idempotent,owned,page,scopeFields,type Entity} from '../shared/store.ts';
import {authorize,currentActor,interactiveInput,keyOf,type Dependencies,type Handler} from '../shared/context.ts';
import {createAction,requestActionRecovery,actionRecoveryReplay,type Check} from '../shared/actions.ts';
export function activationService(d:Dependencies):{handler:Handler;check:Check} {
  async function material(scope:Scope,input:{revenueId:string;destinationId:string}) {
    const [actor,revenue,destination]=await Promise.all([currentActor(d,scope,'actions:write'),
      d.call('reporting','revenueState',{scope,id:input.revenueId}),d.call('connections','connectionState',{scope,id:input.destinationId})]);
    const person=await d.call('crm','leadState',{scope,id:revenue.leadId,purpose:'activation'}),lead=person.lead as Entity,consent=person.consent as Entity;
    const source=await d.call('connections','connectionState',{scope,id:lead.sourceId});
    const reasons=preflight({environment:scope.environment,enabled:Boolean(destination.enabled),sourceEnabled:Boolean(source.enabled),role:actor.role,
      consent:consent.consent.advertising as ConsentState,capability:['simulator_ads','meta','google'].includes(String(destination.provider)),productionCapable:['meta','google'].includes(String(destination.provider)),currentVersion:1,requestedVersion:1,
      deadline:new Date(d.now().getTime()+600000).toISOString()},d.now().getTime());
    const native=['meta','google'].includes(String(destination.provider));
    if(native&&revenue.kind==='refund')reasons.push('UNSUPPORTED_PROVIDER_CORRECTION');
    if(native&&revenue.kind==='sale'&&BigInt(String(revenue.refundedMinor??'0'))>0n)reasons.push('KNOWN_REFUND_REQUIRES_UNSUPPORTED_CORRECTION');
    if(destination.provider==='google'&&(consent.googleConsent?.adUserData!=='granted'||!['granted','denied'].includes(String(consent.googleConsent?.adPersonalization))))reasons.push('GOOGLE_CONSENT_NOT_EXPLICIT');
    let correctionOf:string|null=null;
    if(revenue.kind==='refund'){
      const original=(await d.store.find('actions',scoped(scope,{kind:'ads.purchase',businessId:revenue.originalSaleId,destinationId:destination._id,state:'verified'}),{limit:1}))[0];
      if(!original)reasons.push('ORIGINAL_PURCHASE_NOT_VERIFIED');else correctionOf=original._id;
    }
    const payload={businessEventId:revenue._id,leadId:lead._id,kind:revenue.kind,currency:revenue.currency,
      amountMinor:revenue.amountMinor,occurredAt:revenue.occurredAt,correctionOf,
      ...(native?{identifiers:person.identifiers,...(destination.provider==='google'?{googleConsent:consent.googleConsent??null}:{})}:{})};
    return {revenueId:revenue._id,destinationId:destination._id,destinationVersion:destination.version,sourceId:source._id,
      sourceVersion:source.version,provider:destination.provider,leadId:lead._id,leadVersion:lead.version,consentVersion:consent.version,policyVersion:actor.policyVersion,
      actorId:scope.actorId,...(native?{refundedMinor:String(revenue.refundedMinor??'0')}:{}),eligible:reasons.length===0,reasons,payload,kind:revenue.kind==='sale'?'ads.purchase' as const:'ads.refund' as const};
  }
  const check:Check=async(action,scope)=>{
    const current=await material(scope,{revenueId:String(action.businessId),destinationId:String(action.destinationId)});
    const reasons=[...current.reasons];
    if(action.destinationVersion!==current.destinationVersion)reasons.push('DESTINATION_VERSION_CHANGED');
    if(action.approvalMaterialHash!==hash(canonical(current)))reasons.push('APPROVED_MATERIAL_CHANGED');
    if(String(action.deadline)<=d.now().toISOString())reasons.push('DEADLINE_EXCEEDED');
    const destination=await d.call('connections','connectionState',{scope,id:action.destinationId});
    return {destination,reasons};
  };
  const handler:Handler=async(r,caller)=>{
    const input=interactiveInput.parse(r.input),write=['preview','activate','recoverAction'].includes(r.operation);
    const scope=await authorize(d,r,caller,input.workspaceId,write?'actions:write':'actions:read');
    if(r.operation==='preview'){
      const body=dto.activationInput.parse(input.body),current=await material(scope,body),materialHash=hash(canonical(current));
      const createdAt=d.now().toISOString(),expiresAt=new Date(d.now().getTime()+600000).toISOString();
      const previewHash=hash(canonical({materialHash,actorId:scope.actorId,createdAt,nonce:randomUUID()}));
      await d.store.atomic(async tx=>{
        await tx.insert('previews',{_id:previewHash,...scopeFields(scope),actorId:scope.actorId,input:body,materialHash,material:current,createdAt,expiresAt});
        await audit(tx,scope,'activation.previewed',previewHash,{eligible:current.eligible});
      });
      return {...current,payload:{businessEventId:current.payload.businessEventId,kind:current.payload.kind,currency:current.payload.currency,amountMinor:current.payload.amountMinor,occurredAt:current.payload.occurredAt,correctionOf:current.payload.correctionOf},previewHash,expiresAt,evidenceClass:current.provider==='simulator_ads'?'simulator':'provider_adapter_not_certified',meaning:'Eligibility preview only; no external effect was performed.'};
    }
    if(r.operation==='activate'){
      const body=dto.activateInput.parse(input.body),preview=await owned(d.store,'previews',body.previewHash,scope);
      requireThat(preview.actorId===scope.actorId&&String(preview.expiresAt)>d.now().toISOString(),'PREVIEW_EXPIRED','Generate a fresh preview for this actor.',403);
      requireThat(canonical(preview.input)===canonical({revenueId:body.revenueId,destinationId:body.destinationId}),'PREVIEW_MISMATCH','Preview does not authorize this input.',409);
      const current=await material(scope,body);
      requireThat(current.eligible,'ACTIVATION_INELIGIBLE','Current policy does not permit this activation.',403);
      requireThat(hash(canonical(current))===preview.materialHash,'PREVIEW_STALE','Material state changed; generate a fresh preview.',409);
      return idempotent(d.store,scope,'activation.request',keyOf(input.key),body,async tx=>{
        const action=await createAction(d,tx,scope,{kind:current.kind,leadId:String(current.leadId),sourceId:String(current.sourceId),destinationId:body.destinationId,
          destinationVersion:Number(current.destinationVersion),version:1,businessId:body.revenueId,payload:current.payload});
        if(!action.approvalMaterialHash)await tx.put('actions',{...action,approvalMaterialHash:preview.materialHash,previewId:preview._id});
        await audit(tx,scope,'activation.requested',action._id);return {operationId:action._id,state:action.state};
      });
    }
    if(r.operation==='recoverAction'){
      const id=dto.id.parse(input.id),body=dto.actionRecoveryInput.parse(input.body),action=await owned(d.store,'actions',id,scope);
      const replay=await actionRecoveryReplay(d,scope,id,keyOf(input.key),body);if(replay)return replay;
      let approvalHash:string|undefined;
      if(body.mode==='retry'){
        requireThat(body.previewHash,'RECOVERY_PREVIEW_REQUIRED','A fresh conversion preview is required before retry.',403);
        const preview=await owned(d.store,'previews',body.previewHash,scope);
        requireThat(preview.actorId===scope.actorId&&String(preview.expiresAt)>d.now().toISOString()&&String(preview.createdAt)>=String(action.updatedAt??action.createdAt),'PREVIEW_EXPIRED','Generate a fresh preview after the failed attempt.',403);
        const input={revenueId:String(action.businessId),destinationId:String(action.destinationId)},current=await material(scope,input);
        requireThat(current.eligible&&canonical(preview.input)===canonical(input)&&preview.materialHash===hash(canonical(current)),
          'PREVIEW_STALE','The current conversion eligibility or preview has changed.',409);
        requireThat(canonical(action.payload)===canonical(current.payload)&&action.destinationVersion===current.destinationVersion,
          'RECOVERY_PAYLOAD_CHANGED','Recovery cannot change an existing business effect or destination.',409);
        approvalHash=String(preview.materialHash);
      }
      return requestActionRecovery(d,scope,id,keyOf(input.key),body,check,approvalHash);
    }
    if(r.operation==='actions') {const result=await page(d.store,'actions',scope,{},input.cursor);for(const a of result.items){delete a.payload;delete a.inputHash;delete a.approvalMaterialHash;}return result;}
    if(r.operation==='overview')return {actions:(await d.store.find('actions',scoped(scope,{state:{$in:['ready','dispatched','executing','outcome_unknown','provider_processing']}}),{limit:10001})).length};
    if(r.operation==='action'||r.operation==='job'){
      const id=dto.id.parse(input.id),action=await owned(d.store,'actions',id,scope);delete action.payload;delete action.inputHash;delete action.approvalMaterialHash;
      return r.operation==='job'?action:{action,attempts:await page(d.store,'attempts',scope,{actionId:id})};
    }
    throw new Error('Unknown activation operation');
  };
  return {handler,check};
}
