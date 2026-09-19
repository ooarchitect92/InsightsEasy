import {randomUUID} from 'node:crypto';
import {canonical, hash, requireThat, type Scope} from '../../packages/domain/core.ts';
import {scopeFields, type Transaction, type Store, type Entity} from './store.ts';
import {eventOwners, type Owner} from './registry.ts';
import {signEvent, type Event, type KeyRing, type SignedEvent} from './authentication.ts';
export async function emit(tx:Transaction,owner:Owner,ring:KeyRing,scope:Scope,type:string,resourceId:string,category?:'touch'|'lead',correlationId=resourceId) {
  requireThat(eventOwners[type]===owner,'EVENT_OWNERSHIP_DENIED','Service does not own this event type.',500);
  const event:Event={v:2,id:randomUUID(),type,producer:owner,keyId:ring.keyId,...scopeFields(scope),environment:scope.environment as 'sandbox'|'production',
    resourceId,correlationId,occurredAt:new Date().toISOString(),...(category?{category}:{})};
  // Sign before commit so publication can resume even after a signing-key rotation.
  await tx.insert('outbox',{_id:event.id,...scopeFields(scope),signed:signEvent(event,ring),state:'pending',leaseUntil:0,attempts:0,createdAt:event.occurredAt});
  return event.id;
}
export async function publishOutbox(store:Store,publish:(event:SignedEvent)=>Promise<void>,now=Date.now()):Promise<number> {
  let count=0;
  for(const row of await store.find('outbox',{state:{$ne:'published'},leaseUntil:{$lte:now}},{limit:100})) {
    const token=randomUUID();
    const claimed=await store.atomic(async tx=>{
      const current=await tx.get('outbox',row._id);
      if(!current||current.state==='published'||Number(current.leaseUntil)>now)return null;
      await tx.put('outbox',{...current,state:'publishing',claimToken:token,leaseUntil:now+15000,attempts:Number(current.attempts)+1});return current;
    });
    if(!claimed)continue;
    try {
      await publish(claimed.signed as SignedEvent);
      await store.atomic(async tx=>{const latest=await tx.get('outbox',row._id);if(latest?.claimToken===token)
        await tx.put('outbox',{...latest,state:'published',publishedAt:new Date().toISOString(),leaseUntil:0});});count++;
    }catch{
      await store.atomic(async tx=>{const latest=await tx.get('outbox',row._id);if(latest?.claimToken===token)
        await tx.put('outbox',{...latest,state:'pending',leaseUntil:Date.now()+2000,errorCode:'PUBLICATION_UNAVAILABLE'});});
    }
  }
  return count;
}
export async function recordProcessed(tx:Transaction,event:Event,result:Entity):Promise<void> {
  await tx.insert('processed',{_id:event.id,eventHash:hash(canonical(event)),result,createdAt:new Date().toISOString()});
}
