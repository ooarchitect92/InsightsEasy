import {DomainError,requireThat} from '../domain/core.ts';

export type HttpReply={status:number;body:unknown;headers:Headers};
export type HttpTransport=(url:string,init:RequestInit)=>Promise<HttpReply>;
const regions=['com','in','eu','com.au','jp','ca','com.cn','sa'];
const hosts=new Set(['graph.facebook.com','datamanager.googleapis.com','oauth2.googleapis.com',
  ...regions.flatMap(region=>[`www.zohoapis.${region}`,`sandbox.zohoapis.${region}`,`accounts.zoho.${region}`])]);
export function approvedProviderUrl(value:string):URL {
  const u=new URL(value);
  requireThat(u.protocol==='https:'&&hosts.has(u.hostname)&&(!u.port||u.port==='443')&&!u.username&&!u.password&&!u.hash,
    'PROVIDER_EGRESS_DENIED','Provider requests must use a registered HTTPS endpoint.',403);
  return u;
}
/** All real-provider requests use fixed hosts, no redirects, no ambient cookie/credential forwarding. */
export const providerHttp:HttpTransport=async(url,init)=>{
  const u=approvedProviderUrl(url),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
  try {
    const response=await fetch(u,{...init,redirect:'error',credentials:'omit',signal:controller.signal});
    requireThat(Number(response.headers.get('content-length')??0)<=1048576,'PROVIDER_RESPONSE_TOO_LARGE','Provider response exceeds 1 MiB.',502);
    const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
    if(reader)try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
      requireThat(size<=1048576,'PROVIDER_RESPONSE_TOO_LARGE','Provider response exceeds 1 MiB.',502);chunks.push(value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    const text=Buffer.concat(chunks).toString('utf8');let body:unknown={};
    if(text)try{body=JSON.parse(text);}catch{throw new DomainError('PROVIDER_INVALID_RESPONSE','Provider returned a non-JSON response.',502);}
    return {status:response.status,body,headers:response.headers};
  }finally{clearTimeout(timer);}
};
export function retryDelay(headers:Headers,now=Date.now()):number {
  const raw=headers.get('retry-after');if(!raw)return 5000;
  const seconds=Number(raw),date=Date.parse(raw);
  const ms=Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?date-now:5000;
  return Math.min(3600000,Math.max(1000,ms));
}
export const safeProviderCode=(code:unknown)=>typeof code==='string'&&/^[A-Z0-9_]{1,100}$/.test(code)?code:'PROVIDER_ERROR';
