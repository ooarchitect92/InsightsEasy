import {Kafka,logLevel,type Producer,type Consumer,type KafkaConfig} from 'kafkajs';
import amqp,{type ChannelModel,type ConfirmChannel,type ConsumeMessage} from 'amqplib';
import {Queue,Worker} from 'bullmq';
import {Redis,type RedisOptions} from 'ioredis';
import {readFileSync} from 'node:fs';
import {requireThat,hash,canonical,DomainError} from '../../packages/domain/core.ts';
import {verifyEvent,type Event,type SignedEvent} from './authentication.ts';
import {eventTopic} from './registry.ts';
import {signDispatch,verifyDispatch} from './dispatch-signature.ts';
import type {Dependencies} from './context.ts';
import type {ActionMessage} from './actions.ts';
export const safeLog=(service:string,event:string,code?:string)=>console.log(JSON.stringify({time:new Date().toISOString(),service,event,...(code?{code}:{})}));
const codeOf=(error:unknown)=>error instanceof DomainError?error.code:'DEPENDENCY_UNAVAILABLE';
function required(name:string):string{const value=process.env[name];requireThat(value,'CONFIGURATION',`${name} must be configured.`,500);return value;}
export function kafkaConfig(owner:string):KafkaConfig {
  const ssl=process.env.KAFKA_TLS==='true';const mechanism=process.env.KAFKA_SASL_MECHANISM??'scram-sha-512';
  requireThat(['plain','scram-sha-256','scram-sha-512'].includes(mechanism),'CONFIGURATION','Unsupported Kafka authentication mechanism.',500);
  if(process.env.APP_ENV==='production')requireThat(ssl&&process.env.KAFKA_USERNAME&&process.env.KAFKA_PASSWORD,
    'CONFIGURATION','Production Kafka requires authenticated TLS.',500);
  return {clientId:`insightseasy-${owner}`,brokers:required('KAFKA_BROKERS').split(','),logLevel:logLevel.NOTHING,
    connectionTimeout:4000,requestTimeout:7000,retry:{retries:3,initialRetryTime:300},
    ...(ssl?{ssl:process.env.KAFKA_CA_FILE?{ca:[readFileSync(process.env.KAFKA_CA_FILE,'utf8')]}:true}:{}),
    ...(process.env.KAFKA_USERNAME?{sasl:{mechanism:mechanism as 'plain',username:required('KAFKA_USERNAME'),password:required('KAFKA_PASSWORD')}}:{})};
}
export async function quarantine(d:Dependencies,lane:string,raw:Buffer,error:unknown,extra:Record<string,unknown>={}) {
  const id=hash(Buffer.concat([Buffer.from(lane),raw]));
  await d.store.atomic(async tx=>{const old=await tx.get('transportFailures',id);
    await tx.put('transportFailures',{_id:id,lane,code:codeOf(error),attempts:Number(old?.attempts??0)+1,
      // Broker envelopes contain references, never contact data. Do not retain unsigned malformed bodies.
      ...extra,bodyHash:hash(raw),state:'quarantined',createdAt:old?.createdAt??d.now().toISOString(),updatedAt:d.now().toISOString()});});
  safeLog(d.store.owner,'transport.quarantined',codeOf(error));
}
export async function kafkaPublisher(d:Dependencies) {
  const producer:Producer=new Kafka(kafkaConfig(d.store.owner)).producer({allowAutoTopicCreation:false,idempotent:true,maxInFlightRequests:1});
  await producer.connect();let healthy=true;
  return {ready:()=>healthy,publish:async(signed:SignedEvent)=>{const event=verifyEvent(signed,d.settings.keyRing.publicKeys);
    requireThat(event.producer===d.store.owner,'EVENT_OWNERSHIP_DENIED','An owner cannot publish another service fact.',403);
    const raw=Buffer.from(canonical(signed));requireThat(raw.length<=65536,'ENVELOPE_TOO_LARGE','Event envelope exceeds 64 KiBi.',413);
    try{await producer.send({topic:eventTopic(event.type),acks:-1,messages:[{key:`${event.workspaceId}:${event.resourceId}`,value:raw}]});healthy=true;}
    catch(error){healthy=false;throw error;}},close:()=>producer.disconnect()};
}
export async function kafkaProjector(d:Dependencies,consume:(event:Event)=>Promise<void>) {
  const consumer:Consumer=new Kafka(kafkaConfig(d.store.owner)).consumer({groupId:`${d.settings.environment}-${d.store.owner}-v2`,allowAutoTopicCreation:false,
    sessionTimeout:30000,heartbeatInterval:3000,maxBytesPerPartition:65536});
  let healthy=false;
  consumer.on(consumer.events.CRASH,()=>{healthy=false;safeLog(d.store.owner,'consumer.crashed');});
  consumer.on(consumer.events.GROUP_JOIN,()=>{healthy=true;});
  consumer.on(consumer.events.DISCONNECT,()=>{healthy=false;});
  await consumer.connect();await consumer.subscribe({topic:'insightseasy.ingress.v2',fromBeginning:true});
  await consumer.run({autoCommit:false,partitionsConsumedConcurrently:1,eachMessage:async({topic,partition,message,heartbeat})=>{
    const raw=message.value??Buffer.alloc(0);let event:Event;
    try{requireThat(raw.length<=65536,'ENVELOPE_TOO_LARGE','Envelope exceeds its limit.',413);event=verifyEvent(JSON.parse(raw.toString('utf8')),d.settings.keyRing.publicKeys);}
    catch(error){await quarantine(d,'kafka',raw,error,{topic,partition,offset:message.offset});
      await consumer.commitOffsets([{topic,partition,offset:(BigInt(message.offset)+1n).toString()}]);return;}
    if(event.environment!==d.settings.environment){await quarantine(d,'kafka',raw,new DomainError('WRONG_ENVIRONMENT','Wrong environment.',403));}
    else if((d.store.owner==='crm'&&event.category==='lead')||(d.store.owner==='journeys'&&event.category==='touch')){
      // Each service commits its own state first. Remote receipt acknowledgement is retried independently by the same idempotent handler.
      try{await consume(event);}
      catch(error){const id=hash(Buffer.from(`${topic}:${partition}:${message.offset}`));const old=await d.store.get('transportFailures',id);
        const attempts=Number(old?.attempts??0)+1;await d.store.put('transportFailures',{_id:id,lane:'kafka',topic,partition,offset:message.offset,
          eventId:event.id,signed:JSON.parse(raw.toString('utf8')),attempts,state:attempts>=20?'quarantined':'retrying',code:codeOf(error),updatedAt:d.now().toISOString()});
        if(attempts<20){await heartbeat();throw error;}safeLog(d.store.owner,'consumer.retry_budget_exhausted',codeOf(error));}
    }
    // Serial partition processing never commits past an unfinished prior offset.
    await consumer.commitOffsets([{topic,partition,offset:(BigInt(message.offset)+1n).toString()}]);
  }});
  return {ready:()=>healthy,close:async()=>{await consumer.stop();await consumer.disconnect();}};
}
export async function rabbitLane(d:Dependencies) {
  const url=required('RABBITMQ_URL');if(d.settings.environment==='production')requireThat(url.startsWith('amqps://'),'CONFIGURATION','Production RabbitMQ requires TLS.',500);
  const connection:ChannelModel=await amqp.connect(url,{timeout:5000});let healthy=true;
  connection.on('error',()=>{healthy=false;safeLog(d.store.owner,'rabbit.connection_error');});
  connection.on('close',()=>{healthy=false;});
  const channel:ConfirmChannel=await connection.createConfirmChannel();channel.on('error',()=>{healthy=false;});channel.on('close',()=>{healthy=false;});
  const name=`${d.settings.environment}.${d.store.owner}.actions`,exchange=name+'.dispatch';
  await channel.assertExchange(exchange,'direct',{durable:true});await channel.assertExchange(name+'.dead','fanout',{durable:true});
  await channel.assertQueue(name+'.dead',{durable:true,arguments:{'x-queue-type':'quorum'}});await channel.bindQueue(name+'.dead',name+'.dead','');
  await channel.assertQueue(name,{durable:true,arguments:{'x-queue-type':'quorum','x-dead-letter-exchange':name+'.dead','x-delivery-limit':10}});
  await channel.bindQueue(name,exchange,'execute');await channel.prefetch(4);
  const returned=new Set<string>();channel.on('return',msg=>{returned.add(String(msg.properties.messageId));});
  let tag:string|undefined;const active=new Set<Promise<void>>();
  return {ready:()=>healthy,
    publish:async(message:ActionMessage)=>{
      const id=message.id+'-'+message.generation,raw=Buffer.from(canonical(signDispatch(d.store.owner,message,d.settings.keyRing)));
      requireThat(raw.length<=65536,'ENVELOPE_TOO_LARGE','Command exceeds its contract.',413);returned.delete(id);
      await new Promise<void>((resolve,reject)=>{channel.publish(exchange,'execute',raw,{persistent:true,mandatory:true,messageId:id,contentType:'application/json'},
        error=>{if(error)reject(error);else if(returned.delete(id))reject(new Error('UNROUTABLE_COMMAND'));else resolve();});});
    },
    consume:async(execute:(message:ActionMessage)=>Promise<void>)=>{const result=await channel.consume(name,(message:ConsumeMessage|null)=>{
      if(!message)return;
      const work=(async()=>{try{
        requireThat(message.content.length<=65536,'ENVELOPE_TOO_LARGE','Command exceeds its contract.',413);
        const value=verifyDispatch(JSON.parse(message.content.toString('utf8')),d.store.owner,d.settings.keyRing.publicKeys);
        await execute(value);channel.ack(message);
      }catch(error){
        // Persist the failure before parking the message. The durable intent scanner owns recovery; no immediate requeue loop.
        try{await quarantine(d,'rabbitmq',message.content,error);channel.nack(message,false,false);}
        catch{healthy=false;await channel.close().catch(()=>{});}
      }})();active.add(work);void work.finally(()=>active.delete(work));
    },{noAck:false});tag=result.consumerTag;},
    close:async()=>{if(tag)await channel.cancel(tag).catch(()=>{});await Promise.allSettled(active);await channel.close().catch(()=>{});await connection.close().catch(()=>{});}
  };
}
export function redisOptions(url:string,worker=false):RedisOptions {
  const u=new URL(url);requireThat(['redis:','rediss:'].includes(u.protocol),'CONFIGURATION','Use a Redis URL.',500);
  if(process.env.APP_ENV==='production')requireThat(u.protocol==='rediss:','CONFIGURATION','Production Redis requires TLS.',500);
  return {host:u.hostname,port:Number(u.port||6379),username:u.username?decodeURIComponent(u.username):undefined,
    password:u.password?decodeURIComponent(u.password):undefined,db:Number(u.pathname.slice(1)||0),maxRetriesPerRequest:worker?null:1,
    connectTimeout:4000,...(u.protocol==='rediss:'?{tls:{}}:{})};
}
export async function reportQueue(d:Dependencies,run?:(m:ActionMessage)=>Promise<void>) {
  const connection=redisOptions(required('QUEUE_REDIS_URL'),Boolean(run));
  const name=`${d.settings.environment}-reports-v2`,queue=new Queue(name,{connection});let healthy=true;
  queue.on('error',()=>{healthy=false;});await queue.waitUntilReady();
  const worker=run?new Worker(name,async job=>{const m=verifyDispatch(job.data,'reporting',d.settings.keyRing.publicKeys);await run(m);},
    {connection:redisOptions(required('QUEUE_REDIS_URL'),true),concurrency:2,lockDuration:120000,maxStalledCount:1}):undefined;
  worker?.on('error',()=>{healthy=false;safeLog('reporting','queue.error');});worker?.on('failed',()=>{safeLog('reporting','task.failed');});
  return {ready:()=>healthy,enqueue:async(m:ActionMessage)=>{await queue.add('build',signDispatch('reporting',m,d.settings.keyRing),{
    jobId:m.id+'-'+m.generation,attempts:1,removeOnComplete:{age:3600,count:1000},removeOnFail:{age:86400,count:1000}});healthy=true;},
    close:async()=>{await worker?.close();await queue.close();}};
}
export function disposableCache() {
  const client=new Redis({...redisOptions(required('CACHE_REDIS_URL')),maxRetriesPerRequest:1,lazyConnect:true,enableOfflineQueue:false});
  client.on('error',()=>{});void client.connect().catch(()=>{});
  return {get:(key:string)=>client.get(key),set:async(key:string,value:string)=>{await client.set(key,value,'EX',60);},close:()=>client.quit().catch(()=>{client.disconnect();})};
}
