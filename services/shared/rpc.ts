import Fastify from 'fastify';
import {DomainError, requireThat} from '../../packages/domain/core.ts';
import {issueServiceToken, verifyServiceToken, consumeNonce} from './authentication.ts';
import {rpcRequestSchema, type Handler, type Settings, type Call, type RpcRequest} from './context.ts';
import type {Store,Entity} from './store.ts';
import type {Owner} from './registry.ts';

export async function boundedResponse(response:Response,maxBytes=4*1024*1024):Promise<Buffer> {
  requireThat(response.body,'EMPTY_RESPONSE','Dependency returned an empty response.',502);
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    requireThat(size<=maxBytes,'RESPONSE_TOO_LARGE','Dependency response exceeds its contract.',502);chunks.push(value);}}
  catch(e){await reader.cancel();throw e;}finally{reader.releaseLock();}
  return Buffer.concat(chunks);
}
/** No automatic mutation retries. Durable idempotency/worker ledgers own retry decisions. */
export function rpcClient(settings:Settings,transport:typeof fetch=fetch):Call {
  const failures=new Map<Owner,{count:number;retryAt:number}>();
  return async(target,operation,input,context={})=>{
    const state=failures.get(target);
    requireThat(!state || Date.now()>=state.retryAt,'SERVICE_CIRCUIT_OPEN','Dependency is recovering; retry with the same operation key.',503);
    const raw=Buffer.from(JSON.stringify({v:1,operation,input,context} satisfies RpcRequest));
    requireThat(raw.byteLength<=4*1024*1024,'REQUEST_TOO_LARGE','Internal request exceeds its contract.',413);
    const token=issueServiceToken(settings.service,target,raw,settings.keyRing);
    try {
      const response=await transport(settings.origins[target]+'/rpc',{method:'POST',body:raw,
        headers:{'content-type':'application/json',authorization:`Service ${token}`},redirect:'error',
        signal:AbortSignal.timeout(settings.rpcTimeoutMs)});
      const body=JSON.parse((await boundedResponse(response)).toString('utf8')) as Entity;
      if(!response.ok)throw new DomainError(String(body.code??'DEPENDENCY_REJECTED'),String(body.detail??'Dependency rejected the operation.'),response.status);
      failures.delete(target);return body;
    }catch(error){
      if(!(error instanceof DomainError)||error.status>=500){
        const count=(state?.count??0)+1;failures.set(target,{count,retryAt:count>=5?Date.now()+5000:0});
        throw new DomainError('DEPENDENCY_UNAVAILABLE','A required service is unavailable. No successful result is assumed.',503);
      }
      throw error;
    }
  };
}
export function createRpcServer(settings:Settings,store:Store,handler:Handler) {
  const app=Fastify({bodyLimit:4*1024*1024,logger:false,trustProxy:false,requestTimeout:10000,...(settings.tls?{https:settings.tls}:{})});
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json',{parseAs:'buffer'},(_req,body,done)=>done(null,body));
  app.addHook('onRequest',async(_req,reply)=>{reply.header('cache-control','no-store');});
  app.get('/health/live',async()=>({status:'live',service:settings.service}));
  app.get('/health/ready',async(_req,reply)=>{try{await store.ready();return {status:'ready',service:settings.service};}
    catch{return reply.status(503).send({status:'not_ready',service:settings.service});}});
  app.post('/rpc',async(req,reply)=>{
    // Duplicate authorization headers are rejected rather than ambiguously normalized.
    requireThat(req.raw.rawHeaders.filter((_,i,a)=>i%2===0&&a[i]?.toLowerCase()==='authorization').length===1,
      'SERVICE_AUTH_REQUIRED','One service authorization header is required.',401);
    const raw=req.body as Buffer;
    requireThat(Buffer.isBuffer(raw),'INVALID_BODY','JSON bytes are required.',400);
    const authorization=req.headers.authorization??'';
    requireThat(authorization.startsWith('Service '),'SERVICE_AUTH_REQUIRED','Service authentication is required.',401);
    let claims;
    try{claims=verifyServiceToken(authorization.slice(8),settings.service,raw,settings.keyRing.publicKeys);}
    catch(e){if(e instanceof DomainError)throw e;throw new DomainError('SERVICE_AUTH_INVALID','Service authentication is invalid.',401);}
    const parsed=rpcRequestSchema.parse(JSON.parse(raw.toString('utf8')));
    // Domain services may introspect a gateway-forwarded session only at identity.authorize.
    // This exception never permits impersonating the gateway at another domain or login/membership route.
    const introspection=settings.service==='identity'&&parsed.operation==='authorize'&&
      ['connections','journeys','crm','reporting','activation'].includes(claims.issuer);
    requireThat(!parsed.context.sessionToken || claims.issuer==='gateway'||introspection,
      'SESSION_DELEGATION_DENIED','Caller cannot delegate a browser session.',403);
    await consumeNonce(store,claims);
    const result=await handler(parsed,claims.issuer);
    return reply.send(result??{});
  });
  app.setErrorHandler((error,_req,reply)=>{
    if(error instanceof DomainError)return reply.status(error.status).send({code:error.code,detail:error.message});
    if((error instanceof Error&&error.name==='ZodError')||error instanceof SyntaxError)return reply.status(400).send({code:'INVALID_ARGUMENT',detail:'Request does not match the operation contract.'});
    const status=typeof error==='object'&&error!==null&&'statusCode'in error&&error.statusCode===413?413:500;
    return reply.status(status).send({code:status===413?'REQUEST_TOO_LARGE':'INTERNAL_ERROR',detail:'The operation did not complete. Retry only with the same idempotency key.'});
  });
  return app;
}
