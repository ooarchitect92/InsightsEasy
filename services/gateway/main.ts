import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DomainError,requireThat} from '../../packages/domain/core.ts';
import {id} from '../../packages/contracts/index.ts';
import type {Entity} from '../shared/store.ts';
import type {Call,Settings} from '../shared/context.ts';
import type {Owner} from '../shared/registry.ts';
import {rpcClient} from '../shared/rpc.ts';
import {loadSettings} from '../shared/config.ts';

export const routes:readonly [string,string,Owner,string,number?][]=[
  ['GET','catalog','connections','catalog'],['GET','connections','connections','list'],
  ['POST','connections','connections','create',201],['PATCH','connections/:id','connections','setEnabled'],
  ['POST','connections/:id/test-events','connections','testEvent',202],['GET','receipts','connections','receipts'],
  ['GET','touches','journeys','list'],['GET','leads','crm','list'],['GET','leads/:id','crm','details'],
  ['POST','leads/:id/stages','crm','changeStage'],['POST','leads/:id/consent','crm','changeConsent'],
  ['POST','leads/:id/deliver','crm','deliver',202],['GET','revenue-events','reporting','revenue'],
  ['POST','revenue-events','reporting','recordRevenue',201],['GET','reports','reporting','reports'],
  ['POST','reports','reporting','requestReport',202],['GET','reports/:id','reporting','report'],
  ['GET','tasks','reporting','tasks'],['POST','conversion-intents/preview','activation','preview'],
  ['POST','conversion-intents/activate','activation','activate',202],
  ['GET','members','identity','members'],['POST','members','identity','changeMember'],
];
export async function createGateway(settings:Settings,call:Call) {
  const app=Fastify({bodyLimit:32768,logger:false,trustProxy:false,requestTimeout:20000,...(settings.tls?{https:settings.tls}:{})});
  await app.register(cookie);await app.register(helmet,{contentSecurityPolicy:false});
  const publicValue=(value:unknown):unknown=>Array.isArray(value)?value.map(publicValue):value&&typeof value==='object'?
    Object.fromEntries(Object.entries(value).filter(([key])=>!['authority','claimToken'].includes(key)).map(([key,item])=>[key,publicValue(item)])):value;
  app.addHook('preSerialization',async(_req,_reply,payload)=>publicValue(payload));
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
  const parse=(raw:unknown):unknown=>raw===undefined?{}:JSON.parse((raw as Buffer).toString('utf8'));
  const context=(req:{cookies:Record<string,string|undefined>})=>({sessionToken:req.cookies.ie_session});
  app.addHook('onRequest',async(req,reply)=>{
    reply.header('cache-control','no-store').header('x-request-id',randomUUID());
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!/^\/v1\/(collect|ingest)\//.test(req.url))
      requireThat(req.headers.origin===settings.publicOrigin,'CSRF_ORIGIN_DENIED','Request origin is not permitted.',403);
  });
  app.setErrorHandler((error,_req,reply)=>{
    if(error instanceof DomainError)return reply.status(error.status).send({code:error.code,detail:error.message});
    if(error instanceof z.ZodError||error instanceof SyntaxError)return reply.status(400).send({code:'INVALID_ARGUMENT',detail:'Input does not match the operation contract.'});
    const oversized=typeof error==='object'&&error!==null&&'statusCode'in error&&error.statusCode===413;
    return reply.status(oversized?413:503).send({code:oversized?'REQUEST_TOO_LARGE':'SERVICE_UNAVAILABLE',detail:'The operation did not complete. Retry with the same idempotency key.'});
  });
  app.get('/health/live',async()=>({status:'live',service:'gateway'}));
  app.get('/health/ready',async()=>({status:'routing_ready',service:'gateway',meaning:'Individual services report their own readiness.'}));
  app.get('/v1/meta',async()=>call('identity','meta',{}));
  app.get('/v1/me',async req=>call('identity','me',{},context(req)));
  for(const operation of ['login','register'] as const)app.post('/v1/auth/'+operation,async(req,reply)=>{
    const result=await call('identity',operation,operation==='register'?{key:req.headers['idempotency-key'],body:parse(req.body)}:parse(req.body));
    reply.setCookie('ie_session',String(result.sessionToken),{path:'/',httpOnly:true,sameSite:'strict',secure:settings.publicOrigin.startsWith('https://'),maxAge:8*3600});
    return reply.status(operation==='register'?201:200).send({authenticated:true});
  });
  app.post('/v1/auth/logout',async(req,reply)=>{await call('identity','logout',{},context(req));reply.clearCookie('ie_session',{path:'/'});return {signedOut:true};});
  app.post('/v1/workspaces',async(req,reply)=>reply.status(201).send(await call('identity','createWorkspace',{key:req.headers['idempotency-key'],body:parse(req.body)},context(req))));
  for(const [method,path,owner,operation,status=200] of routes) {
    app.route({method:method as 'GET'|'POST'|'PATCH',url:'/v1/workspaces/:w/'+path,handler:async(req,reply)=>{
      const p=req.params as Record<string,string>,q=z.object({cursor:id.optional()}).strict().parse(req.query);
      const input={workspaceId:id.parse(p.w),...(p.id?{id:id.parse(p.id)}:{}),...(req.headers['idempotency-key']?{key:req.headers['idempotency-key']}:{}),
        ...(!['GET','HEAD'].includes(method)?{body:parse(req.body)}:{}),...(q.cursor?{cursor:q.cursor}:{})};
      return reply.status(status).send(await call(owner,operation,input,context(req)));
    }});
  }
  app.get<{Params:{w:string;id:string}}>('/v1/workspaces/:w/reports/:id/csv',async(req,reply)=>{
    const result=await call('reporting','csv',{workspaceId:id.parse(req.params.w),id:id.parse(req.params.id)},context(req));
    return reply.header('content-disposition',`attachment; filename="${id.parse(req.params.id)}.csv"`).type('text/csv; charset=utf-8').send(result.csv);
  });
  app.get<{Params:{w:string}}>('/v1/workspaces/:w/actions',async req=>{
    const query=z.object({cursor:id.optional()}).strict().parse(req.query),input={workspaceId:id.parse(req.params.w),...query};
    const [crm,activation]=await Promise.all([call('crm','actions',input,context(req)),call('activation','actions',input,context(req))]);
    const all=[...(crm.items as Entity[]),...(activation.items as Entity[])].sort((a,b)=>a._id.localeCompare(b._id));
    const items=all.slice(0,100),hasMore=all.length>100||crm.hasMore||activation.hasMore;
    return {items,hasMore,nextCursor:hasMore?items.at(-1)?._id:null,limit:100};
  });
  for(const kind of ['jobs','actions'] as const)app.get<{Params:{w:string;id:string}}>('/v1/workspaces/:w/'+kind+'/:id',async req=>{
    const value=id.parse(req.params.id),owner:Owner|undefined=value.startsWith('receipt_')?'connections':value.startsWith('report_')?'reporting':
      value.startsWith('crm_')?'crm':value.startsWith('activation_')?'activation':undefined;
    requireThat(owner&&(kind==='jobs'||owner==='crm'||owner==='activation'),'NOT_FOUND','Operation was not found.',404);
    return call(owner,kind==='jobs'?'job':'action',{workspaceId:id.parse(req.params.w),id:value},context(req));
  });
  app.post<{Params:{w:string;id:string}}>('/v1/workspaces/:w/actions/:id/recover',async(req,reply)=>{
    const value=id.parse(req.params.id),owner=value.startsWith('crm_')?'crm':value.startsWith('activation_')?'activation':undefined;
    requireThat(owner,'NOT_FOUND','Action was not found.',404);
    return reply.status(202).send(await call(owner,'recoverAction',{workspaceId:id.parse(req.params.w),id:value,key:req.headers['idempotency-key'],body:parse(req.body)},context(req)));
  });
  app.get<{Params:{w:string}}>('/v1/workspaces/:w/overview',async req=>{
    const workspaceId=id.parse(req.params.w),ctx=context(req),scope=await call('identity','authorize',{workspaceId,permission:'reports:read'},ctx);
    const requested:Owner[]=scope.role==='viewer'?['reporting']:['connections','journeys','crm','reporting','activation'];
    const results=await Promise.allSettled(requested.map(owner=>call(owner,'overview',{workspaceId},ctx)));
    const counts:Record<string,number>={},services:Record<string,string>={};
    results.forEach((result,i)=>{const owner=requested[i]!;if(result.status==='fulfilled'){
      services[owner]='available';for(const [key,value] of Object.entries(result.value))if(typeof value==='number')counts[key==='pendingReceipts'?'receipts':key]=value;
    }else services[owner]='unavailable';});
    return {counts,services,partial:Object.values(services).includes('unavailable'),countLimit:10001,environment:settings.environment,
      dataAsOf:new Date().toISOString(),policyVersion:scope.policyVersion};
  });
  app.options<{Params:{sourceId:string}}>('/v1/collect/:sourceId',async(req,reply)=>{
    const result=await call('connections','collectorConfiguration',{sourceId:id.parse(req.params.sourceId),origin:req.headers.origin??''});
    return reply.header('access-control-allow-origin',String(result.origin)).header('vary','Origin')
      .header('access-control-allow-methods','POST, OPTIONS').header('access-control-allow-headers','content-type').header('access-control-max-age','600').status(204).send();
  });
  for(const mode of ['ingest','collect'] as const)app.post<{Params:{sourceId:string};Body:Buffer}>('/v1/'+mode+'/:sourceId',async(req,reply)=>{
    requireThat(Buffer.isBuffer(req.body),'CONTENT_TYPE_REQUIRED','Use application/json.',415);
    const input={sourceId:id.parse(req.params.sourceId),mode:mode==='ingest'?'signed':'collector',raw:req.body.toString('base64'),
      ...(req.headers.origin?{origin:req.headers.origin}:{}),...(req.headers['x-insights-timestamp']?{timestamp:req.headers['x-insights-timestamp']}:{}),
      ...(req.headers['x-insights-signature']?{signature:req.headers['x-insights-signature']}:{})};
    const result=await call('connections','ingest',input);
    if(mode==='collect')reply.header('access-control-allow-origin',req.headers.origin??'').header('vary','Origin');
    return reply.status(202).send(result);
  });
  return app;
}
if(process.env.NO_AUTOSTART!=='true') {
  const settings=loadSettings('gateway'),app=await createGateway(settings,rpcClient(settings));
  await app.listen({host:'0.0.0.0',port:settings.port});
  const stop=()=>void app.close();process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
