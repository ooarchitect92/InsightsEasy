import {generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {serviceNames,owners,type Owner,type Service} from '../../services/shared/registry.ts';
import {rpcClient,createRpcServer} from '../../services/shared/rpc.ts';
import type {Settings,Dependencies,Handler} from '../../services/shared/context.ts';
import {verifyEvent,type SignedEvent} from '../../services/shared/authentication.ts';
import {publishOutbox} from '../../services/shared/events.ts';
import {dispatchActions,executeAction,recoverActions,type Check} from '../../services/shared/actions.ts';
import {identityService} from '../../services/identity/handler.ts';
import {connectionsService} from '../../services/connections/handler.ts';
import {journeyService} from '../../services/journeys/handler.ts';
import {crmService} from '../../services/crm/handler.ts';
import {reportingService,dispatchReports,recoverReports} from '../../services/reporting/handler.ts';
import {activationService} from '../../services/activation/handler.ts';
import {createGateway} from '../../services/gateway/main.ts';
import {createSimulator} from '../../services/simulator/main.ts';
import {MemoryStore} from './memory-store.ts';
import type {Entity} from '../../services/shared/store.ts';
export async function createHarness(gatewayPort=0,publicOrigin='http://localhost:3000') {
  let offset=0;const now=()=>new Date(Date.now()+offset);
  const keys=Object.fromEntries(serviceNames.map(service=>[service,generateKeyPairSync('ed25519',{
    privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}})]));
  const publicKeys=Object.fromEntries(serviceNames.map(service=>[service+':test-v1',keys[service]!.publicKey]));
  const origins=Object.fromEntries(owners.map(o=>[o,'http://127.0.0.1:0'])) as Record<Owner,string>;
  const simulatorToken=randomBytes(32).toString('hex');
  const settings={} as Record<Service,Settings>,stores={} as Record<Owner,MemoryStore>,dependencies={} as Record<Owner,Dependencies>;
  for(const service of serviceNames)settings[service]={service,environment:'sandbox',publicOrigin,encryptionKey:randomBytes(32),simulatorToken,simulatorOrigin:'',
    keyRing:{keyId:'test-v1',privateKey:keys[service]!.privateKey,publicKeys},origins,port:0,rpcTimeoutMs:3000};
  for(const owner of owners){stores[owner]=new MemoryStore(owner);dependencies[owner]={store:stores[owner],settings:settings[owner],call:rpcClient(settings[owner]),now};}
  const journey=journeyService(dependencies.journeys),crm=crmService(dependencies.crm),reporting=reportingService(dependencies.reporting),activation=activationService(dependencies.activation);
  const handlers:Partial<Record<Owner,Handler>>={identity:identityService(dependencies.identity),connections:connectionsService(dependencies.connections),
    journeys:journey.handler,crm:crm.handler,reporting:reporting.handler,activation:activation.handler};
  const apps:FastifyInstance[]=[];
  const simulator=await createSimulator(settings.simulator,stores.simulator);await simulator.listen({host:'127.0.0.1',port:0});apps.push(simulator);
  origins.simulator=simulator.listeningOrigin;
  for(const service of serviceNames)settings[service].simulatorOrigin=origins.simulator;
  for(const owner of owners.filter(o=>o!=='simulator')){const app=createRpcServer(settings[owner],stores[owner],handlers[owner]!);
    await app.listen({host:'127.0.0.1',port:0});origins[owner]=app.listeningOrigin;apps.push(app);}
  const gateway=await createGateway(settings.gateway,rpcClient(settings.gateway));await gateway.listen({host:'127.0.0.1',port:gatewayPort});apps.push(gateway);
  const messages:SignedEvent[]=[];
  async function drain(execute=true,runTasks=true) {
    for(const owner of ['connections','journeys','crm','reporting','activation'] as const)
      await publishOutbox(stores[owner],async e=>{messages.push(e);},now().getTime());
    while(messages.length){const event=verifyEvent(messages.shift()!,publicKeys);if(event.type==='receipt.accepted.v2'){
      if(event.category==='touch')await journey.consume(event);else await crm.consume(event);}}
    if(execute)for(const [owner,check] of [['crm',crm.check],['activation',activation.check]] as [Owner,Check][]){
      await recoverActions(dependencies[owner]);await dispatchActions(dependencies[owner],m=>executeAction(dependencies[owner],m,check));}
    if(runTasks){await recoverReports(dependencies.reporting);await dispatchReports(dependencies.reporting,m=>reporting.run(m));}
  }
  async function request(path:string,method='GET',body?:unknown,cookie='',key:string=randomUUID(),origin=publicOrigin) {
    return fetch(gateway.listeningOrigin+path,{method,headers:{...(cookie?{cookie}:{}),origin,'idempotency-key':key,...(body!==undefined?{'content-type':'application/json'}:{})},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})});
  }
  async function register(label:string) {
    const email=randomUUID()+'@example.com',response=await request('/v1/auth/register','POST',{email,password:'test-password-'+randomUUID(),businessName:label});
    if(!response.ok)throw new Error(`register ${response.status}: ${await response.text()}`);
    const cookie=response.headers.get('set-cookie')!.split(';')[0]!;
    const me=await (await request('/v1/me','GET',undefined,cookie)).json() as Entity,workspace=(me.workspaces as Entity[])[0]!._id;
    return {email,cookie,workspace,userId:me.user.id as string,path:(suffix:string)=>`/v1/workspaces/${workspace}${suffix}`,
      request:(path:string,method='GET',body?:unknown,key?:string)=>request(path,method,body,cookie,key),
      call:async(path:string,method='GET',body?:unknown,key?:string)=>{
        const r=await request(path,method,body,cookie,key);const value=await r.json() as Entity;
        if(!r.ok)throw new Error(`${method} ${path} ${r.status}: ${JSON.stringify(value)}`);return value;
      }};
  }
  return {settings,stores,dependencies,origins,gateway,simulator,messages,journey,crm,reporting,activation,now,
    advance:(ms:number)=>{offset+=ms;},drain,request,register,close:async()=>{await Promise.all(apps.map(app=>app.close()));}};
}
