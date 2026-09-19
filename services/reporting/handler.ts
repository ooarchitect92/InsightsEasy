import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonical,hash,requireThat,toMinor,stableId,assertReplay,scoped,buildReport,csvCell,formatMinor,
  type Scope,type ReportInput,type Currency,type JourneyLead,type Touch} from '../../packages/domain/core.ts';
import * as dto from '../../packages/contracts/index.ts';
import {audit,idempotent,owned,page,rowScope,scopeFields,type Entity} from '../shared/store.ts';
import {allow,authorize,currentActor,interactiveInput,keyOf,scopeSchema,codeOf,isUnavailable,type Dependencies,type Handler} from '../shared/context.ts';
import {emit} from '../shared/events.ts';
import type {ActionMessage} from '../shared/actions.ts';
export function reportCsv(result:ReturnType<typeof buildReport>):string {
  return [['sale_id','lead_id','touch_id','channel','currency','amount','model','data_as_of'].map(csvCell).join(','),
    ...result.rows.map(row=>[row.saleId,row.leadId,row.touchId??'',row.channel,row.currency,
      formatMinor(BigInt(row.amountMinor),row.currency),result.model,result.dataAsOf].map(csvCell).join(','))].join('\r\n')+'\r\n';
}
export function reportingService(d:Dependencies):{handler:Handler;run:(message:ActionMessage)=>Promise<void>} {
  async function record(scope:Scope,key:string,input:dto.RevenueInput) {
    const amount=toMinor(input.amount,input.currency);
    requireThat(amount>0n,'INVALID_AMOUNT','Values must be positive.');
    requireThat(new Date(input.occurredAt).getTime()<=d.now().getTime()+300000,'FUTURE_EVENT','Financial occurrence time is too far in the future.');
    requireThat(input.kind==='refund'?Boolean(input.originalSaleId):!input.originalSaleId,'INVALID_ORIGINAL_REFERENCE','Only a refund must reference an original sale.');
    await d.call('crm','leadState',{scope,id:input.leadId,purpose:'revenue'});
    return idempotent(d.store,scope,'revenue.record',key,input,async tx=>{
      const id='revenue_'+stableId(scope.organizationId,scope.workspaceId,scope.environment,input.businessKey);
      const previous=await tx.get('revenue',id);
      if(previous){assertReplay(String(previous.inputHash),input);return {id,state:'recorded',duplicate:true};}
      if(input.kind==='refund'){
        const sale=await owned(tx,'revenue',input.originalSaleId!,scope);
        requireThat(sale.kind==='sale'&&sale.leadId===input.leadId&&sale.currency===input.currency,'INVALID_REFUND_REFERENCE','Refund must match its original sale, lead and currency.');
        requireThat(input.occurredAt>=String(sale.occurredAt),'INVALID_REFUND_TIME','Refund cannot precede the sale.');
        const refunded=BigInt(String(sale.refundedMinor))+amount;
        requireThat(refunded<=BigInt(String(sale.amountMinor)),'REFUND_EXCEEDS_SALE','Cumulative refunds cannot exceed the sale.');
        // Updating the original sale in the same transaction serializes concurrent refunds.
        await tx.put('revenue',{...sale,refundedMinor:refunded.toString(),refundVersion:Number(sale.refundVersion)+1});
      }
      await tx.insert('revenue',{_id:id,...scopeFields(scope),...input,amountMinor:amount.toString(),
        ...(input.kind==='sale'?{refundedMinor:'0',refundVersion:0}:{}),version:1,inputHash:hash(canonical(input)),
        sourceAuthority:'authorized_operator_assertion',createdAt:d.now().toISOString(),createdBy:scope.actorId});
      await audit(tx,scope,'revenue.recorded',id,{kind:input.kind});await emit(tx,'reporting',d.settings.keyRing,scope,'revenue.recorded.v2',id);
      return {id,state:'recorded',duplicate:false};
    });
  }
  async function capture(task:Entity,scope:Scope) {
    const request=dto.reportInput.parse(task.request),capturedAt=d.now().toISOString();
    const financial=await d.store.atomic(async tx=>{
      const sales=await tx.find('revenue',scoped(scope,{kind:'sale',occurredAt:{$gte:request.from,$lt:request.to},createdAt:{$lte:capturedAt}}),{limit:1001});
      requireThat(sales.length<=1000,'QUERY_TOO_LARGE','This release supports 1,000 sales per report; narrow the period.');
      const ids=sales.map(s=>s._id);
      const refunds=ids.length?await tx.find('revenue',scoped(scope,{kind:'refund',originalSaleId:{$in:ids},createdAt:{$lte:capturedAt}}),{limit:10001}):[];
      requireThat(refunds.length<=10000,'QUERY_TOO_LARGE','Too many adjustments for this report; narrow the period.');
      // Recompute refunds from immutable facts at the capture cutoff; do not use a later mutable sale balance.
      const amounts=new Map<string,bigint>();for(const refund of refunds)amounts.set(String(refund.originalSaleId),(amounts.get(String(refund.originalSaleId))??0n)+BigInt(String(refund.amountMinor)));
      return {sales:sales.map(s=>({id:s._id,leadId:String(s.leadId),currency:s.currency as Currency,amountMinor:String(s.amountMinor),
        refundedMinor:(amounts.get(s._id)??0n).toString(),occurredAt:String(s.occurredAt)})),refundIds:refunds.map(r=>r._id).sort()};
    });
    const ids=[...new Set(financial.sales.map(s=>s.leadId))];
    const people=await d.call('crm','reportManifest',{scope,ids});
    const leads=people.leads as JourneyLead[];
    const pairs=leads.filter(l=>l.touchSourceId&&l.visitorId).map(l=>({sourceId:l.touchSourceId!,visitorId:l.visitorId!}));
    const journey=await d.call('journeys','snapshot',{scope,pairs,
      from:new Date(new Date(request.from).getTime()-request.lookbackDays*86400000).toISOString(),to:request.to,capturedAt});
    const input:ReportInput={model:request.model,lookbackDays:request.lookbackDays,from:request.from,to:request.to,capturedAt,
      sales:financial.sales,leads,touches:journey.items as Touch[]};
    return {input,leadIds:ids,policyDigest:String(people.policyDigest),manifest:{version:2,inputHash:hash(canonical(input)),
      financialHash:hash(canonical(financial)),refundIds:financial.refundIds,financialCutoff:capturedAt,crmReadAt:people.capturedAt,
      journeysReadAt:journey.readAt,scope:scopeFields(scope),consistency:'Versioned per-owner manifests; not a globally atomic cross-database snapshot.',
      coverage:journey.coverage}};
  }
  async function permitted(task:Entity,scope:Scope,permission:'reports:read'|'reports:write') {
    const actor=await currentActor(d,scope,permission);
    requireThat(Number(actor.policyVersion)===Number(task.policyVersion),'POLICY_CHANGED','Workspace policy changed; generate a new report.',403);
    if(task.leadIds){const current=await d.call('crm','reportManifest',{scope,ids:task.leadIds});
      requireThat(current.policyDigest===task.policyDigest,'POLICY_CHANGED','Identity or consent changed; generate a new report.',403);}
  }
  async function run(message:ActionMessage) {
    const token=randomUUID();
    const task=await d.store.atomic(async tx=>{
      const row=await tx.get('tasks',message.id);
      requireThat(row&&row.organizationId===message.organizationId&&row.workspaceId===message.workspaceId&&row.environment===message.environment,
        'FORGED_BROKER_CONTEXT','Task context does not match its durable record.',403);
      if(row.dispatchGeneration!==message.generation||!['pending','dispatched'].includes(String(row.state)))return null;
      if(Number(row.attemptCount)>=3){await tx.put('tasks',{...row,state:'failed',errorCode:'ATTEMPT_LIMIT'});return null;}
      await tx.put('tasks',{...row,state:'executing',claimToken:token,leaseUntil:d.now().getTime()+90000,attemptCount:Number(row.attemptCount)+1});
      return row;
    });
    if(!task)return;
    const scope=rowScope(task);
    try {
      await permitted(task,scope,'reports:write');
      const snapshot=task.input?{input:task.input as ReportInput,leadIds:task.leadIds,policyDigest:task.policyDigest,manifest:task.manifest}:await capture(task,scope);
      const saved=await d.store.atomic(async tx=>{const current=await tx.get('tasks',task._id);if(current?.claimToken!==token||current.state!=='executing')return false;
        await tx.put('tasks',{...current,...snapshot});return true;});
      if(!saved)return;
      await permitted({...task,...snapshot},scope,'reports:write');
      const result={...buildReport(snapshot.input),manifest:snapshot.manifest};
      await d.store.atomic(async tx=>{
        const current=await tx.get('tasks',task._id);if(current?.claimToken!==token||current.state!=='executing')return;
        if(!await tx.get('reports',task._id))await tx.insert('reports',{_id:task._id,...scopeFields(scope),name:task.name,result,
          leadIds:snapshot.leadIds,policyDigest:snapshot.policyDigest,policyVersion:task.policyVersion,manifest:snapshot.manifest,
          capturedAt:snapshot.input.capturedAt,createdBy:scope.actorId,createdAt:d.now().toISOString()});
        await tx.put('tasks',{...current,state:'completed',resultId:task._id,claimToken:null,leaseUntil:0,completedAt:d.now().toISOString()});
        await emit(tx,'reporting',d.settings.keyRing,scope,'report.completed.v2',task._id);await audit(tx,scope,'report.completed',task._id);
      });
    } catch(error) {
      await d.store.atomic(async tx=>{const current=await tx.get('tasks',task._id);if(current?.claimToken!==token||current.state!=='executing')return;
        const state=isUnavailable(error)&&Number(current.attemptCount)<3?'pending':(codeOf(error)==='POLICY_CHANGED'||(!isUnavailable(error)&&'status'in Object(error)&&Object(error).status===403)?'blocked_policy_changed':'failed');
        await tx.put('tasks',{...current,state,claimToken:null,leaseUntil:0,nextDispatchAt:d.now().getTime()+3000,errorCode:codeOf(error)});});
    }
  }
  const handler:Handler=async(r,caller)=>{
    if(r.operation==='revenueState') {
      allow(caller,'activation');const input=z.object({scope:scopeSchema,id:dto.id}).strict().parse(r.input);
      await currentActor(d,input.scope,'actions:write');return owned(d.store,'revenue',input.id,input.scope);
    }
    const input=interactiveInput.parse(r.input);
    const permission=r.operation==='recordRevenue'?'revenue:write':r.operation==='revenue'?'revenue:read':r.operation==='requestReport'?'reports:write':'reports:read';
    const scope=await authorize(d,r,caller,input.workspaceId,permission);
    if(r.operation==='recordRevenue')return record(scope,keyOf(input.key),dto.revenueInput.parse(input.body));
    if(r.operation==='revenue')return page(d.store,'revenue',scope,{},input.cursor);
    if(r.operation==='reports'){const result=await page(d.store,'reports',scope,{},input.cursor);for(const row of result.items){delete row.result;delete row.leadIds;delete row.policyDigest;}return result;}
    if(r.operation==='tasks'){const result=await page(d.store,'tasks',scope,{},input.cursor);for(const row of result.items){delete row.input;delete row.request;delete row.leadIds;delete row.policyDigest;}return result;}
    if(r.operation==='overview')return {reports:(await d.store.find('reports',scoped(scope),{limit:10001})).length,
      ...(scope.role==='viewer'?{}:{revenue:(await d.store.find('revenue',scoped(scope),{limit:10001})).length})};
    if(r.operation==='requestReport') {
      const body=dto.reportInput.parse(input.body);
      requireThat(new Date(body.to).getTime()-new Date(body.from).getTime()<=366*86400000,'QUERY_TOO_LARGE','Choose at most 366 days per snapshot.');
      return idempotent(d.store,scope,'report.request',keyOf(input.key),body,async tx=>{
        const id='report_'+randomUUID();
        await tx.insert('tasks',{_id:id,...scopeFields(scope),name:body.name,request:body,policyVersion:scope.policyVersion,
          kind:'report.build',actorId:scope.actorId,authority:scope.authority,state:'pending',dispatchGeneration:0,attemptCount:0,nextDispatchAt:0,leaseUntil:0,createdAt:d.now().toISOString()});
        await audit(tx,scope,'report.requested',id);return {operationId:id,state:'pending'};
      });
    }
    const id=dto.id.parse(input.id);
    if(r.operation==='job'){const task=await owned(d.store,'tasks',id,scope);delete task.input;delete task.request;delete task.leadIds;delete task.policyDigest;return task;}
    if(r.operation==='report'||r.operation==='csv'){
      const report=await owned(d.store,'reports',id,scope);await permitted(report,scope,'reports:read');
      if(d.settings.cache){
        const resultHash=hash(canonical(report.result)),key='report:'+stableId(scope.organizationId,scope.workspaceId,scope.environment,id,resultHash);
        try{const cached=await d.settings.cache.get(key);
          if(cached&&hash(canonical(JSON.parse(cached)))===resultHash)report.result=JSON.parse(cached);
          else await d.settings.cache.set(key,JSON.stringify(report.result));
        }catch{/* A cache outage never grants access, loses a report, or changes its authoritative output. */}
      }
      return r.operation==='report'?report:{csv:reportCsv(report.result as ReturnType<typeof buildReport>),filename:`${id}.csv`};
    }
    throw new Error('Unknown reporting operation');
  };
  return {handler,run};
}
export async function dispatchReports(d:Dependencies,enqueue:(m:ActionMessage)=>Promise<void>):Promise<void> {
  const now=d.now().getTime();
  for(const item of await d.store.find('tasks',{state:'pending',nextDispatchAt:{$lte:now}},{limit:50})){
    const msg=await d.store.atomic(async tx=>{const row=await tx.get('tasks',item._id);if(!row||row.state!=='pending'||Number(row.nextDispatchAt)>now)return null;
      const generation=Number(row.dispatchGeneration)+1;await tx.put('tasks',{...row,state:'dispatched',dispatchGeneration:generation,leaseUntil:now+20000});
      return {id:row._id,generation,...scopeFields(rowScope(row))};});
    if(msg)try{await enqueue(msg);}catch{/* Queue Redis is recoverable dispatch state, not business truth. */}
  }
}
export async function recoverReports(d:Dependencies):Promise<void> {
  const now=d.now().getTime();
  for(const item of await d.store.find('tasks',{state:{$in:['dispatched','executing']},leaseUntil:{$lte:now}},{limit:100}))
    await d.store.atomic(async tx=>{const row=await tx.get('tasks',item._id);if(row&&['dispatched','executing'].includes(String(row.state))&&Number(row.leaseUntil)<=now)
      await tx.put('tasks',{...row,state:'pending',claimToken:null,leaseUntil:0,nextDispatchAt:now,errorCode:'EXPIRED_CLAIM_RECOVERED'});});
}
