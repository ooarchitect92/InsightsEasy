/** Explicit external-provider fixture, isolated from all business databases. */
import Fastify from 'fastify';
import {z} from 'zod';
import {canonical,hash,requireThat,DomainError,stableId} from '../../packages/domain/core.ts';
import {id} from '../../packages/contracts/index.ts';
import type {Store} from '../shared/store.ts';
import type {Settings} from '../shared/context.ts';
import {loadSettings} from '../shared/config.ts';
import {MongoStore} from '../shared/store.ts';
export async function createSimulator(settings:Settings,store:Store) {
  requireThat(settings.environment==='sandbox','SANDBOX_ONLY','Simulator is restricted to sandbox.',500);
  const app=Fastify({bodyLimit:32768,logger:false});
  app.addHook('onRequest',async req=>{if(!req.url.startsWith('/health/'))requireThat(settings.simulatorToken&&req.headers.authorization===`Bearer ${settings.simulatorToken}`,'UNAUTHORIZED','Unauthorized.',401);});
  app.setErrorHandler((e,_req,reply)=>reply.status(e instanceof DomainError?e.status:e instanceof z.ZodError?400:500).send({code:e instanceof DomainError?e.code:'SIMULATOR_REQUEST_FAILED'}));
  app.get('/health/live',async()=>({status:'live'}));app.get('/health/ready',async()=>{await store.ready();return {status:'ready'};});
  const schema=z.object({effectId:id,remoteKey:z.string().min(1).max(512),kind:z.enum(['crm.upsert','ads.purchase','ads.refund']),version:z.number().int().positive(),
    payload:z.record(z.string(),z.unknown()),failureMode:z.enum(['normal','reject','timeout_after_commit','throttle_once'])}).strict();
  app.post('/effects',async(req,reply)=>{
    const input=schema.parse(req.body);requireThat(req.headers['idempotency-key']===input.effectId,'INVALID_KEY','Stable effect key is required.',400);
    if(input.failureMode==='reject')return reply.status(422).send({code:'SIMULATED_VALIDATION_ERROR'});
    if(input.failureMode==='throttle_once'){
      const count=await store.atomic(async tx=>{const prior=await tx.get('throttles',input.effectId),count=Number(prior?.count??0)+1;await tx.put('throttles',{_id:input.effectId,count});return count;});
      if(count===1)return reply.header('retry-after','1').status(429).send({code:'SIMULATED_RATE_LIMIT'});
    }
    const payloadHash=hash(canonical({kind:input.kind,version:input.version,payload:input.payload,remoteKey:input.remoteKey}));
    const receipt=await store.atomic(async tx=>{
      const existing=await tx.get('effects',input.effectId);if(existing){requireThat(existing.payloadHash===payloadHash,'IDEMPOTENCY_CONFLICT','Effect content changed.',409);return existing.receipt;}
      const remoteId=stableId(input.remoteKey,input.kind==='crm.upsert'?'contact':input.effectId);
      if(input.kind==='crm.upsert'){
        const fields=z.object({fullName:z.string().min(1),email:z.string().email(),stage:z.string()}).strict().parse(input.payload);
        const prior=await tx.get('objects',remoteId);requireThat(!prior||Number(prior.version)<=input.version,'STALE_PROVIDER_VERSION','Older upsert cannot replace a newer contact.',409);
        await tx.put('objects',{_id:remoteId,fields,version:input.version,createdAt:prior?.createdAt??new Date().toISOString()});
      }else{
        const fields=z.object({businessEventId:id,leadId:id,kind:z.enum(['sale','refund']),currency:z.string().length(3),amountMinor:z.string().regex(/^[0-9]+$/),occurredAt:z.string(),correctionOf:id.nullable()}).strict().parse(input.payload);
        if(input.kind==='ads.refund')requireThat(fields.correctionOf&&await tx.get('effects',fields.correctionOf),'ORIGINAL_EFFECT_MISSING','Original purchase is required.');
        await tx.insert('objects',{_id:remoteId,fields,version:input.version});
      }
      const receipt={effectId:input.effectId,remoteId,payloadHash,status:'verified',evidenceClass:'simulator'};
      await tx.insert('effects',{_id:input.effectId,payloadHash,receipt,createdAt:new Date().toISOString()});return receipt;
    });
    if(input.failureMode==='timeout_after_commit'){reply.hijack();req.raw.socket.destroy();return;}
    return reply.status(201).send(receipt);
  });
  app.get<{Params:{id:string}}>('/effects/:id',async(req,reply)=>{const row=await store.get('effects',id.parse(req.params.id));return row?row.receipt:reply.status(404).send({code:'AUTHORITATIVELY_ABSENT'});});
  return app;
}
if(process.env.NO_AUTOSTART!=='true') {
  const settings=loadSettings('simulator'),store=new MongoStore('simulator',process.env.MONGO_URL!,process.env.MONGO_DATABASE??'insightseasy_simulator');
  await store.initialize(process.env.RUN_MIGRATIONS==='true');const app=await createSimulator(settings,store);await app.listen({host:'0.0.0.0',port:settings.port});
  const stop=async()=>{await app.close();await store.close();};process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
}
