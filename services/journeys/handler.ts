import {z} from 'zod';
import {canonical,hash,requireThat,classifyAcquisition,scoped,type Scope} from '../../packages/domain/core.ts';
import * as dto from '../../packages/contracts/index.ts';
import {page,scopeFields,rowScope,type Entity} from '../shared/store.ts';
import {allow,authorize,currentActor,interactiveInput,scopeSchema,type Dependencies,type Handler} from '../shared/context.ts';
import {recordProcessed,emit} from '../shared/events.ts';
import {type Event} from '../shared/authentication.ts';
export function journeyService(d:Dependencies):{handler:Handler;consume:(event:Event)=>Promise<void>} {
  async function consume(event:Event) {
    requireThat(event.type==='receipt.accepted.v2'&&event.producer==='connections'&&event.category==='touch','EVENT_MISMATCH','Journey projector accepts only touch receipts.',403);
    const bundle=await d.call('connections','readEventReceipt',{event}),receipt=bundle.receipt as Entity,source=bundle.source as Entity;
    const scope:Scope={...rowScope(receipt),actorId:String(source.createdBy),role:'owner'};
    const result=await d.store.atomic(async tx=>{
      const prior=await tx.get('processed',event.id);
      if(prior){requireThat(prior.eventHash===hash(canonical(event)),'EVENT_CONFLICT','Event identity has changed.',409);return prior.result as Entity;}
      const payload=dto.touchEvent.parse(receipt.payload);
      const result:Entity=source.enabled?{_id:receipt._id,state:'processed',resourceId:receipt._id}:{_id:receipt._id,state:'quarantined',errorCode:'SOURCE_DISABLED'};
      if(source.enabled){await tx.insert('touches',{_id:receipt._id,...scopeFields(scope),sourceId:source._id,visitorId:payload.visitorId,
        occurredAt:payload.occurredAt,acquisition:payload.acquisition,channel:classifyAcquisition(payload.acquisition),permitted:true,
        provenance:source.provider==='web_collector'?'public_browser_assertion':'signed_server_assertion',createdAt:d.now().toISOString()});
        await emit(tx,'journeys',d.settings.keyRing,scope,'touch.recorded.v2',receipt._id,undefined,event.id);}
      await recordProcessed(tx,event,result);return result;
    });
    const {_id:_,...ack}=result;void _;
    // This remote acknowledgement is after the local commit. Redelivery repeats only the acknowledgement.
    await d.call('connections','acknowledgeReceipt',{event,result:ack});
  }
  const handler:Handler=async(r,caller)=>{
    if(r.operation==='snapshot') {
      allow(caller,'reporting','crm');
      const input=z.object({scope:scopeSchema,pairs:z.array(z.object({sourceId:dto.id,visitorId:dto.id}).strict()).max(1000),
        from:dto.date,to:dto.date,capturedAt:dto.date}).strict().parse(r.input);
      await currentActor(d,input.scope,caller==='reporting'?'reports:read':'leads:read');
      const touches=input.pairs.length?await d.store.find('touches',scoped(input.scope,{$or:input.pairs,occurredAt:{$gte:input.from,$lt:input.to},createdAt:{$lte:input.capturedAt}}),
        {limit:10001,sort:{occurredAt:1,_id:1}}):[];
      requireThat(touches.length<=10000,'QUERY_TOO_LARGE','Snapshot exceeds 10,000 touches; narrow its period.');
      return {items:touches.map(t=>({id:t._id,sourceId:t.sourceId,visitorId:t.visitorId,occurredAt:t.occurredAt,channel:t.channel,permitted:t.permitted})),
        capturedAt:input.capturedAt,readAt:d.now().toISOString(),count:touches.length,coverage:'Observed, durably projected touches received by capture cutoff; not unobserved traffic.'};
    }
    const input=interactiveInput.parse(r.input),scope=await authorize(d,r,caller,input.workspaceId,'leads:read');
    if(r.operation==='list')return page(d.store,'touches',scope,{},input.cursor);
    if(r.operation==='overview')return {touches:(await d.store.find('touches',scoped(scope),{limit:10001})).length};
    throw new Error('Unknown journey operation');
  };
  return {handler,consume};
}
