/** Runtime-only backend address: promote one web image without baking a tenant/environment URL into it. */
export const dynamic='force-dynamic';
export const runtime='nodejs';
type Context={params:Promise<{path:string[]}>};
class BodyLimit extends Error {}
async function bounded(stream:ReadableStream<Uint8Array>|null,limit:number):Promise<Uint8Array<ArrayBuffer>>{
 if(!stream)return new Uint8Array(0);const reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
  if(size>limit){await reader.cancel();throw new BodyLimit('Body exceeds limit');}chunks.push(value);}
 }finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
async function proxy(request:Request,context:Context):Promise<Response>{
 const error=(status:number,code:string)=>Response.json({code,message:code==='PAYLOAD_TOO_LARGE'?'Request exceeds the gateway size limit.':'Gateway request could not be completed.'},{status,headers:{'cache-control':'private, no-store'}});
 try{
  let {path}=await context.params;if(path[0]==='ingest')path=path.slice(1);
  if(path[0]!=='v1'||path.length>12||path.some(segment=>!(/^[A-Za-z0-9_:-]{1,128}$/).test(segment)))return error(404,'NOT_FOUND');
  const origin=process.env.GATEWAY_ORIGIN??'http://gateway:4000',target=new URL(origin);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.origin!==origin)return error(503,'GATEWAY_CONFIGURATION');
  const query=new URL(request.url).search;if(query.length>4096)return error(400,'INVALID_QUERY');
  target.pathname='/'+path.map(encodeURIComponent).join('/');target.search=query;
  const headers=new Headers();
  for(const name of ['cookie','origin','content-type','accept','idempotency-key','x-insights-timestamp','x-insights-signature','x-hub-signature-256','access-control-request-method','access-control-request-headers']){
   const value=request.headers.get(name);if(value!==null)headers.set(name,value);
  }
  const mutating=!['GET','HEAD'].includes(request.method),size=Number(request.headers.get('content-length')??0);
  if(!Number.isFinite(size)||size>262144)return error(413,'PAYLOAD_TOO_LARGE');
  const body=mutating?await bounded(request.body,262144):undefined;
  const upstream=await fetch(target,{method:request.method,headers,...(body?{body}:{}),redirect:'manual',cache:'no-store',credentials:'omit',signal:AbortSignal.any([request.signal,AbortSignal.timeout(30000)])});
  const responseHeaders=new Headers({'cache-control':'private, no-store, max-age=0'});
  for(const name of ['content-type','content-disposition','x-request-id','retry-after','access-control-allow-origin','access-control-allow-methods','access-control-allow-headers','access-control-allow-credentials','vary']){
   const value=upstream.headers.get(name);if(value!==null)responseHeaders.set(name,value);
  }
  for(const value of upstream.headers.getSetCookie())responseHeaders.append('set-cookie',value);
  const location=upstream.headers.get('location');if(location?.startsWith('/v1/'))responseHeaders.set('location','/api'+location);
  const empty=request.method==='HEAD'||[204,205,304].includes(upstream.status);
  const bytes=empty?null:await bounded(upstream.body,8388608);
  return new Response(bytes,{status:upstream.status,headers:responseHeaders});
 }catch(e){return error(e instanceof BodyLimit?413:503,e instanceof BodyLimit?'PAYLOAD_TOO_LARGE':'DEPENDENCY_UNAVAILABLE');}
}
export {proxy as GET,proxy as POST,proxy as PUT,proxy as PATCH,proxy as DELETE,proxy as HEAD,proxy as OPTIONS};
