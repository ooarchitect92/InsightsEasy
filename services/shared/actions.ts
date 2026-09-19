import type {ProviderAction,ProviderDestination,ProviderOutcome,ProviderReceipt} from '../../packages/providers/contracts.ts';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DomainError,assertReplay,canonical,hash,requireThat,stableId,type Scope} from '../../packages/domain/core.ts';
import {actionRecoveryInput} from '../../packages/contracts/index.ts';
import {audit,idempotent,owned,rowScope,scopeFields,type Transaction,type Entity} from './store.ts';
import {codeOf,isUnavailable,type Dependencies} from './context.ts';
import {emit} from './events.ts';
import {boundedResponse} from './rpc.ts';
export type ActionOwner='crm'|'activation';
export type NewAction={kind:'crm.upsert'|'ads.purchase'|'ads.refund';leadId:string;sourceId:string;destinationId:string;
  destinationVersion?:number;version:number;businessId:string;payload:Record<string,unknown>};
export async function createAction(d:Dependencies,tx:Transaction,scope:Scope,input:NewAction):Promise<Entity> {
  const owner=d.store.owner as ActionOwner;
  requireThat((owner==='crm'&&input.kind==='crm.upsert')||(owner==='activation'&&input.kind.startsWith('ads.')),
    'ACTION_OWNERSHIP_DENIED','Service does not own this action.',403);
  const id=owner+'_'+stableId(scope.organizationId,scope.workspaceId,scope.environment,input.kind,input.businessId,input.destinationId,String(input.version));
  const inputHash=hash(canonical(input)),previous=await tx.get('actions',id);
  if(previous){requireThat(previous.inputHash===inputHash,'ACTION_CONFLICT','Existing business effect has different content.',409);return previous;}
  const action:Entity={_id:id,...scopeFields(scope),...input,inputHash,actorId:scope.actorId,authority:scope.authority,state:'ready',attemptCount:0,inspectCount:0,
    preflightCount:0,dispatchGeneration:0,nextDispatchAt:0,leaseUntil:0,createdAt:d.now().toISOString(),deadline:new Date(d.now().getTime()+86400000).toISOString(),
    remoteKey:stableId(scope.organizationId,scope.workspaceId,scope.environment,input.destinationId,input.leadId)};
  await tx.insert('actions',action);return action;
}
export type Check = (action:Entity,scope:Scope)=>Promise<{destination:Entity;reasons:string[]}>;
const receiptSchema=z.object({effectId:z.string(),remoteId:z.string(),payloadHash:z.string(),status:z.literal('verified'),evidenceClass:z.literal('simulator')}).strict();
type Outcome=Omit<ProviderOutcome,'receipt'>&{receipt?:z.infer<typeof receiptSchema>|ProviderReceipt};
const expectedHash=(action:Entity)=>hash(canonical({kind:action.kind,version:action.version,payload:action.payload,remoteKey:action.remoteKey}));
async function inspect(d:Dependencies,action:Entity):Promise<Outcome> {
  const response=await fetch(`${d.settings.simulatorOrigin}/effects/${encodeURIComponent(action._id)}`,{
    headers:{authorization:`Bearer ${d.settings.simulatorToken}`},redirect:'error',signal:AbortSignal.timeout(3000)});
  if(response.status===404)return {state:'ready',reason:'SIMULATOR_CONFIRMED_ABSENT',retryMs:2000};
  if(!response.ok)return {state:'outcome_unknown',reason:'READBACK_UNAVAILABLE',retryMs:5000};
  const receipt=receiptSchema.parse(JSON.parse((await boundedResponse(response,65536)).toString('utf8')));
  requireThat(receipt.effectId===action._id&&receipt.payloadHash===expectedHash(action),'PROVIDER_REFERENCE_MISMATCH','Provider returned an unexpected effect.',502);
  return {state:'verified',receipt};
}
async function perform(d:Dependencies,action:Entity,destination:Entity,mode:'write'|'inspect',beforeWrite:()=>Promise<void>):Promise<Outcome> {
  if(['zoho','meta','google'].includes(String(destination.provider))){
    if(!d.settings.providerExecutor)return {state:'rejected',reason:'PROVIDER_WORKER_CREDENTIALS_NOT_CONFIGURED'};
    return d.settings.providerExecutor(action as unknown as ProviderAction,destination as unknown as ProviderDestination,mode,beforeWrite);
  }
  try {
    requireThat(d.settings.environment==='sandbox'&&String(destination.provider).startsWith('simulator'),'PROVIDER_NOT_CERTIFIED','This adapter is synthetic only.',403);
    if(mode==='inspect')return await inspect(d,action);
    await beforeWrite();
    const response=await fetch(`${d.settings.simulatorOrigin}/effects`,{method:'POST',
      headers:{authorization:`Bearer ${d.settings.simulatorToken}`,'content-type':'application/json','idempotency-key':action._id},
      body:JSON.stringify({effectId:action._id,remoteKey:action.remoteKey,kind:action.kind,version:action.version,payload:action.payload,failureMode:destination.failureMode}),
      redirect:'error',signal:AbortSignal.timeout(3000)});
    if(response.status===429){const delay=Number(response.headers.get('retry-after')??2);
      return {state:'ready',reason:'PROVIDER_THROTTLED',retryMs:1000*Math.min(60,Math.max(1,Number.isFinite(delay)?delay:2))};}
    if([400,401,403,409,422].includes(response.status))return {state:'rejected',reason:`PROVIDER_REJECTED_${response.status}`};
    if(!response.ok)return {state:'outcome_unknown',reason:'WRITE_RESULT_AMBIGUOUS',retryMs:5000};
    await boundedResponse(response,65536);
    return await inspect(d,action);
  } catch(error) {
    if(error instanceof DomainError&&error.code==='ACTION_SUPPRESSED')return {state:'suppressed',reason:'ACTION_SUPPRESSED'};
    return {state:'outcome_unknown',reason:'WRITE_OR_READBACK_AMBIGUOUS',retryMs:5000};
  }
}
export type ActionMessage={id:string;generation:number;organizationId:string;workspaceId:string;environment:string};
export async function executeAction(d:Dependencies,message:ActionMessage,check:Check):Promise<void> {
  const claimToken=randomUUID(),attemptId=randomUUID(),now=d.now().getTime();
  const opened=await d.store.atomic(async tx=>{
    const action=await tx.get('actions',message.id);
    requireThat(action&&action.organizationId===message.organizationId&&action.workspaceId===message.workspaceId&&action.environment===message.environment,
      'FORGED_BROKER_CONTEXT','Command scope does not match its durable intent.',403);
    if(action.dispatchGeneration!==message.generation||!['ready','dispatched','outcome_unknown','provider_processing'].includes(String(action.state)))return null;
    const mode=([action.state,action.resumeState].some(s=>['outcome_unknown','provider_processing'].includes(String(s))))?'inspect':'write';
    if(d.store.owner==='crm'&&mode==='write'){
      const lock=await tx.get('effectLocks',String(action.remoteKey));
      if(lock&&lock.actionId!==action._id){
        const other=await tx.get('actions',String(lock.actionId));
        if(other&&!['verified','rejected','suppressed'].includes(String(other.state))){
          await tx.put('actions',{...action,state:'ready',nextDispatchAt:now+5000,reasons:['PREVIOUS_CRM_EFFECT_UNRESOLVED']});return null;
        }
      }
      await tx.put('effectLocks',{_id:String(action.remoteKey),...scopeFields(rowScope(action)),actionId:action._id});
    }
    if((mode==='write'&&Number(action.attemptCount)>=Math.min(20,Number(action.writeLimit??5)))||(mode==='inspect'&&Number(action.inspectCount)>=Math.min(40,Number(action.inspectLimit??10)))||String(mode==='inspect'?(action.inspectionDeadline??action.deadline):action.deadline)<=d.now().toISOString()) {
      await tx.put('actions',{...action,state:'review_required',reasons:['EXECUTION_LIMIT']});return null;
    }
    await tx.put('actions',{...action,state:'executing',claimToken,networkStarted:false,leaseUntil:now+90000,preflightCount:Number(action.preflightCount)+1});
    await tx.insert('attempts',{_id:attemptId,...scopeFields(rowScope(action)),actionId:action._id,mode,claimToken,state:'checking',createdAt:d.now().toISOString()});
    return {action,mode:mode as 'write'|'inspect'};
  });
  if(!opened)return;
  const {action,mode}=opened,scope=rowScope(action);
  let destination:Entity;
  try {
    if(mode==='inspect') {
      // Read-only reconciliation of a previously attempted effect is allowed after user withdrawal.
      destination=await d.call('connections','connectionState',{scope,id:action.destinationId});
      requireThat((d.settings.environment==='sandbox'&&String(destination.provider).startsWith('simulator'))||['zoho','meta','google'].includes(String(destination.provider)),'RECONCILIATION_UNAVAILABLE','Reconciliation capability is unavailable.',403);
    }else{
      const checked=await check(action,scope);destination=checked.destination;
      requireThat(!checked.reasons.length,'ACTION_SUPPRESSED',checked.reasons.join(', '),403);
    }
  }catch(error){
    const unavailable=isUnavailable(error),reason=codeOf(error);
    await d.store.atomic(async tx=>{const current=await tx.get('actions',action._id);if(current?.claimToken!==claimToken||current.state!=='executing')return;
      const state=unavailable&&Number(current.preflightCount)<Math.min(80,Number(current.preflightLimit??20))?'ready':(mode==='inspect'?'review_required':'suppressed');
      const next={...current,state,reasons:[reason],nextDispatchAt:d.now().getTime()+5000,leaseUntil:0,claimToken:null,
        ...(mode==='inspect'&&unavailable&&Number(current.preflightCount)<Math.min(80,Number(current.preflightLimit??20))?{state:'outcome_unknown'}:{})};
      await tx.put('actions',next);
      const attempt=await tx.get('attempts',attemptId);await tx.put('attempts',{...attempt!,state:next.state,reason,completedAt:d.now().toISOString()});
      await audit(tx,scope,'action.preflight.stopped',action._id,{reason,state:next.state});});return;
  }
  // Local state is rechecked immediately before starting the external effect. A later withdrawal cannot undo an in-flight HTTP request.
  const allowed=await d.store.atomic(async tx=>{
    const current=await tx.get('actions',action._id);if(current?.claimToken!==claimToken||current.state!=='executing')return false;
    if(mode==='write'&&d.store.owner==='crm') {
      const consent=await owned(tx,'consents',String(action.leadId),scope),lead=await owned(tx,'leads',String(action.leadId),scope);
      if(consent.consent.service!=='granted'||lead.version!==action.version) {
        await tx.put('actions',{...current,state:'suppressed',claimToken:null,reasons:['LOCAL_POLICY_CHANGED']});
        const attempt=await tx.get('attempts',attemptId);await tx.put('attempts',{...attempt!,state:'suppressed',reason:'LOCAL_POLICY_CHANGED'});return false;
      }
    }
    await tx.put('actions',{...current,networkStarted:true,...(mode==='write'?{attemptCount:Number(current.attemptCount)+1}:{inspectCount:Number(current.inspectCount)+1})});
    const attempt=await tx.get('attempts',attemptId);await tx.put('attempts',{...attempt!,state:'executing'});return true;
  });
  if(!allowed)return;
  const result=await perform(d,action,destination!,mode,async()=>{
    const latest=await check(action,scope);
    requireThat(!latest.reasons.length,'ACTION_SUPPRESSED',latest.reasons.join(', '),403);
    const current=await d.store.get('actions',action._id);
    requireThat(current?.claimToken===claimToken&&current.state==='executing','ACTION_SUPPRESSED','The execution claim is no longer current.',403);
  });
  await d.store.atomic(async tx=>{
    const current=await tx.get('actions',action._id);
    if(current?.claimToken!==claimToken||current.state!=='executing')return; // Fenced stale completion; recovery owns reconciliation.
    if(result.state==='ready'&&(Number(current.attemptCount)>=Math.min(20,Number(current.writeLimit??5))||String(current.deadline)<=d.now().toISOString())){result.state='review_required';result.reason='EXECUTION_LIMIT';}
    const attempt=await tx.get('attempts',attemptId);
    await tx.put('attempts',{...attempt!,state:result.state,reason:result.reason??null,receipt:result.receipt??null,completedAt:d.now().toISOString()});
    await tx.put('actions',{...current,state:result.state,resumeState:null,claimToken:null,networkStarted:false,leaseUntil:0,
      reasons:result.reason?[result.reason]:[],receipt:result.receipt??current.receipt??null,nextDispatchAt:d.now().getTime()+(result.retryMs??5000),updatedAt:d.now().toISOString()});
    if(result.state==='verified'){
      if(!await tx.get('usage',action._id))await tx.insert('usage',{_id:action._id,...scopeFields(scope),operationId:action._id,unit:result.receipt?.evidenceClass==='simulator'?'verified_synthetic_effect':'verified_provider_effect',quantity:1,createdAt:d.now().toISOString()});
      await emit(tx,d.store.owner,d.settings.keyRing,scope,`${d.store.owner}.action.completed.v2`,action._id);
      await audit(tx,scope,'action.verified',action._id,{evidenceClass:result.receipt?.evidenceClass??'unknown'});
    }
  });
}
export async function dispatchActions(d:Dependencies,publish:(m:ActionMessage)=>Promise<void>):Promise<void> {
  const now=d.now().getTime();
  for(const item of await d.store.find('actions',{state:{$in:['ready','outcome_unknown','provider_processing']},nextDispatchAt:{$lte:now}},{limit:50})){
    const next=await d.store.atomic(async tx=>{
      const row=await tx.get('actions',item._id);
      if(!row||!['ready','outcome_unknown','provider_processing'].includes(String(row.state))||Number(row.nextDispatchAt)>now)return null;
      const generation=Number(row.dispatchGeneration)+1;
      await tx.put('actions',{...row,state:'dispatched',resumeState:row.state,dispatchGeneration:generation,leaseUntil:now+20000});
      return {id:row._id,generation,...scopeFields(rowScope(row))};
    });
    if(next)try{await publish(next);}catch{/* A publish/confirm failure is repaired from the dispatch lease, not treated as completion. */}
  }
}
export async function recoverActions(d:Dependencies):Promise<void> {
  const now=d.now().getTime();
  for(const item of await d.store.find('actions',{state:{$in:['dispatched','executing']},leaseUntil:{$lte:now}},{limit:100})){
    await d.store.atomic(async tx=>{
      const row=await tx.get('actions',item._id);
      if(!row||!['dispatched','executing'].includes(String(row.state))||Number(row.leaseUntil)>now)return;
      const state=row.state==='executing'?(row.networkStarted?'outcome_unknown':(['outcome_unknown','provider_processing'].includes(String(row.resumeState))?row.resumeState:'ready')):(row.resumeState??'ready');
      await tx.put('actions',{...row,state,claimToken:null,leaseUntil:0,nextDispatchAt:now,reasons:['EXPIRED_CLAIM_RECOVERED']});
      const attempts=await tx.find('attempts',{actionId:row._id,state:{$in:['checking','executing']}},{limit:100});
      for(const attempt of attempts)await tx.put('attempts',{...attempt,state:row.networkStarted?'outcome_unknown':'interrupted_before_send',reason:'WORKER_CLAIM_EXPIRED'});
    });
  }
}

/** Called only after current action authorization; returning a prior receipt performs no new effect. */
export async function actionRecoveryReplay(d:Dependencies,scope:Scope,id:string,key:string,input:unknown):Promise<Entity|null> {
  requireThat(/^[A-Za-z0-9_-]{1,128}$/.test(key),'IDEMPOTENCY_KEY_REQUIRED','A stable Idempotency-Key is required.',400);
  const action=await owned(d.store,'actions',id,scope);
  requireThat(action.actorId===scope.actorId,'RECOVERY_ACTOR_MISMATCH','Recovery requires the original authorized actor.',403);
  const prior=await d.store.get('requestKeys',stableId(scope.organizationId,scope.workspaceId,scope.environment,'action.recover:'+id,key));
  if(!prior)return null;assertReplay(String(prior.inputHash),input);return prior.response as Entity;
}
/** User-requested recovery keeps business identity/counters. Unknown writes can ONLY be inspected. */
export async function requestActionRecovery(d:Dependencies,scope:Scope,id:string,key:string,input:unknown,check:Check,renewedApprovalHash?:string) {
  const body=actionRecoveryInput.parse(input),replay=await actionRecoveryReplay(d,scope,id,key,body);if(replay)return replay;
  const initial=await owned(d.store,'actions',id,scope);
  requireThat(initial.actorId===scope.actorId,'RECOVERY_ACTOR_MISMATCH','Recovery requires the original authorized actor.',403);
  if(body.mode==='retry'){
    requireThat(['rejected','suppressed'].includes(String(initial.state)),'AMBIGUOUS_WRITE_RETRY_DENIED','Only a confirmed rejection or unstarted suppression can be retried. Reconcile unknown writes.',409);
    const current=await check({...initial,...(renewedApprovalHash?{approvalMaterialHash:renewedApprovalHash}:{})},scope);
    requireThat(!current.reasons.length,'RECOVERY_POLICY_DENIED',current.reasons.join(', '),403);
  }else requireThat(['outcome_unknown','provider_processing','review_required'].includes(String(initial.state)),'RECOVERY_STATE_CONFLICT','Only unresolved attempts can be reconciled.',409);
  return idempotent(d.store,scope,'action.recover:'+id,key,body,async tx=>{
    const action=await owned(tx,'actions',id,scope);
    requireThat(action.state===initial.state&&action.dispatchGeneration===body.expectedDispatchGeneration,'RECOVERY_STATE_CONFLICT','The action changed; refresh its state before recovery.',409);
    const recoveryCount=Number(action.recoveryCount??0)+1;
    requireThat(recoveryCount<=3,'RECOVERY_LIMIT','Manual recovery limit reached; use the incident review procedure.',409);
    const state=body.mode==='retry'?'ready':'outcome_unknown';
    await tx.put('actions',{...action,state,resumeState:null,claimToken:null,networkStarted:false,leaseUntil:0,nextDispatchAt:d.now().getTime(),
      dispatchGeneration:Number(action.dispatchGeneration)+1,recoveryCount,writeLimit:5+5*recoveryCount,inspectLimit:10+10*recoveryCount,preflightLimit:20+20*recoveryCount,
      ...(body.mode==='reconcile'?{inspectionDeadline:new Date(d.now().getTime()+3600000).toISOString()}:{}),
      ...(renewedApprovalHash?{approvalMaterialHash:renewedApprovalHash,previewId:body.previewHash}:{}),
      reasons:['USER_REQUESTED_'+body.mode.toUpperCase()],updatedAt:d.now().toISOString()});
    await audit(tx,scope,'action.recovery.requested',id,{mode:body.mode,reason:body.reason,previousState:action.state,recoveryCount,previewId:body.previewHash??null});
    return {operationId:id,state,recoveryCount,meaning:'Recovery queued; this is not a completed provider effect.'};
  });
}
