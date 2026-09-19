export type Row={_id?:string;[key:string]:unknown};
export const obj=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
export const rows=(v:unknown):Row[]=>Array.isArray(v)?v.map(obj):[];
export const text=(v:unknown):string=>v===null||v===undefined?'—':String(v);
export class ApiError extends Error{constructor(public status:number,public code:string,message:string){super(message);}}
// Retry identity survives an ambiguous network failure during this page session, not in browser storage.
const pending=new Map<string,{key:string;createdAt:number}>();
export async function api(path:string,method='GET',body?:unknown,signal?:AbortSignal):Promise<Row>{
 const headers:Record<string,string>={},serialized=body===undefined?undefined:JSON.stringify(body);
 if(serialized!==undefined)headers['content-type']='application/json';
 let fingerprint:string|undefined;
 if(!['GET','HEAD'].includes(method)){
  const bytes=new TextEncoder().encode(method+' '+path+' '+(serialized??''));
  fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('');
  for(const [id,item] of pending)if(Date.now()-item.createdAt>1800000)pending.delete(id);
  const existing=pending.get(fingerprint);
  if(!existing&&pending.size>=256)throw new ApiError(429,'PENDING_OPERATION_LIMIT','Too many unresolved operations. Reconcile existing work before retrying.');
  const intent=existing??{key:crypto.randomUUID(),createdAt:Date.now()};pending.set(fingerprint,intent);headers['idempotency-key']=intent.key;
 }
 const response=await fetch('/api'+path,{method,headers,credentials:'same-origin',cache:'no-store',...(serialized===undefined?{}:{body:serialized}),signal});
 const value=obj(await response.json());
 if(fingerprint&&(response.ok||(response.status>=400&&response.status<500&&response.status!==429)))pending.delete(fingerprint);
 if(!response.ok)throw new ApiError(response.status,text(value.code),text(value.detail??value.message??value.code));
 return value;
}
