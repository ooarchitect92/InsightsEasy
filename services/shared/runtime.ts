import Fastify from 'fastify';
import {requireThat} from '../../packages/domain/core.ts';
import {loadSettings} from './config.ts';
import {MongoStore} from './store.ts';
import {rpcClient,createRpcServer} from './rpc.ts';
import {publishOutbox} from './events.ts';
import {dispatchActions,executeAction,recoverActions,type Check,type ActionMessage} from './actions.ts';
import {kafkaPublisher,kafkaProjector,rabbitLane,reportQueue,disposableCache,safeLog} from './brokers.ts';
import type {Owner} from './registry.ts';
import type {Dependencies,Handler} from './context.ts';
import type {Event} from './authentication.ts';
export type Hooks={handler:Handler;consume?:(event:Event)=>Promise<void>;check?:Check;run?:(message:ActionMessage)=>Promise<void>;
  dispatch?:(enqueue:(message:ActionMessage)=>Promise<void>)=>Promise<void>;recover?:()=>Promise<void>};
export async function startOwner(owner:Owner,factory:(dependencies:Dependencies)=>Hooks) {
  const settings=loadSettings(owner),role=process.env.PROCESS_ROLE??'api';
  requireThat(['api','controller','projector','actions','tasks','migrate'].includes(role),'CONFIGURATION','Unknown process role.',500);
  const store=new MongoStore(owner,process.env.MONGO_URL!,process.env.MONGO_DATABASE??`insightseasy_${owner}`);
  await store.initialize(role==='migrate');if(role==='migrate'){await store.close();return;}
  const closers:(()=>Promise<unknown>)[]=[()=>store.close()];let healthy=true,stopping=false;
  if(owner==='reporting'&&role==='api'&&process.env.CACHE_REDIS_URL){const cache=disposableCache();settings.cache=cache;closers.push(()=>cache.close());}
  const d:Dependencies={store,settings,call:rpcClient(settings),now:()=>new Date()},hooks=factory(d);
  let tick:(()=>Promise<void>)|undefined;let active:Promise<void>|undefined;const readyChecks:(()=>boolean)[]=[];
  if(role==='api'){
    const server=createRpcServer(settings,store,hooks.handler);await server.listen({host:'0.0.0.0',port:settings.port});closers.push(()=>server.close());
  }else{
    if(role==='controller'){
      const publisher=await kafkaPublisher(d);closers.push(()=>publisher.close());readyChecks.push(publisher.ready);
      const rabbit=hooks.check?await rabbitLane(d):undefined;if(rabbit){closers.push(()=>rabbit.close());readyChecks.push(rabbit.ready);}
      const queue=hooks.dispatch?await reportQueue(d):undefined;if(queue){closers.push(()=>queue.close());readyChecks.push(queue.ready);}
      tick=async()=>{await publishOutbox(store,publisher.publish);if(rabbit){await recoverActions(d);await dispatchActions(d,rabbit.publish);}
        if(queue){await hooks.recover!();await hooks.dispatch!(queue.enqueue);}};
    }else if(role==='projector'){
      requireThat(hooks.consume,'CONFIGURATION','This owner has no event consumer.',500);const consumer=await kafkaProjector(d,hooks.consume);
      closers.push(()=>consumer.close());readyChecks.push(consumer.ready);
    }else if(role==='actions'){
      requireThat(hooks.check,'CONFIGURATION','This owner has no action executor.',500);const lane=await rabbitLane(d);
      await lane.consume(m=>executeAction(d,m,hooks.check!));closers.push(()=>lane.close());readyChecks.push(lane.ready);
    }else if(role==='tasks'){
      requireThat(hooks.run,'CONFIGURATION','This owner has no task executor.',500);const queue=await reportQueue(d,hooks.run);
      closers.push(()=>queue.close());readyChecks.push(queue.ready);
    }
    const health=Fastify({logger:false,...(settings.tls?{https:settings.tls}:{})});
    health.get('/health/live',async()=>({status:'live',owner,role}));
    health.get('/health/ready',async(_req,reply)=>{try{await store.ready();if(stopping||!healthy||readyChecks.some(check=>!check()))throw new Error('not ready');
      return {status:'ready',owner,role};}catch{return reply.code(503).send({status:'not_ready',owner,role});}});
    await health.listen({host:'0.0.0.0',port:settings.port});closers.push(()=>health.close());
  }
  const timer=tick?setInterval(()=>{if(stopping||active)return;active=tick!().then(()=>{healthy=true;}).catch(()=>{healthy=false;safeLog(owner,'controller.delayed');}).finally(()=>{active=undefined;});},1000):undefined;
  let unhealthySince=0;
  const watchdog=role==='api'?undefined:setInterval(()=>{
    if(!healthy||readyChecks.some(check=>!check())){unhealthySince||=Date.now();
      if(Date.now()-unhealthySince>60000){safeLog(owner,'dependency_restart');void stop().finally(()=>process.exit(1));}
    }else unhealthySince=0;
  },5000);
  let closed=false;
  const stop=async()=>{if(closed)return;closed=true;stopping=true;if(timer)clearInterval(timer);if(watchdog)clearInterval(watchdog);
    // Kubernetes termination grace exceeds this bound. Expired claims are recovered after a forced termination.
    const force=setTimeout(()=>process.exit(1),45000);force.unref();await active;
    for(const close of closers.reverse())await close().catch(()=>{});clearTimeout(force);};
  process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());safeLog(owner,'started.'+role);
}
