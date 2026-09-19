import {readFileSync,statSync} from 'node:fs';
import {z} from 'zod';
import {canonical,hash,requireThat} from '../domain/core.ts';
import {providerId,type ProviderAction,type ProviderDestination} from './contracts.ts';
import {providerHttp,type HttpTransport} from './http.ts';
const key=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),secret=z.string().min(8).max(8192);
export const bindingSchema=z.object({credentialRef:key,connectionId:key,organizationId:key,workspaceId:key,
  environment:z.enum(['sandbox','production']),provider:providerId,configHash:z.string().regex(/^[a-f0-9]{64}$/),
  approval:z.object({reference:z.string().min(1).max(200),expiresAt:z.string().datetime(),allowExternalEffects:z.boolean()}).strict(),
  accessToken:secret.optional(),expiresAt:z.string().datetime().optional(),
  oauth:z.object({clientId:secret,clientSecret:secret,refreshToken:secret}).strict().optional(),
}).strict().refine(b=>Boolean(b.accessToken&&b.expiresAt)||Boolean(b.oauth),'Provide an expiring access token or server OAuth refresh credential.');
export type ProviderBinding=z.infer<typeof bindingSchema>;
export type BindingLoader=()=>ProviderBinding[];
export function fileBindings(path:string):BindingLoader {
  return ()=>{
    const stat=statSync(path);requireThat(stat.isFile()&&stat.size<=1048576,'CREDENTIAL_FILE_INVALID','Credential file must be a bounded regular file.',500);
    // Secret-volume group read is permitted; world access is never permitted.
    requireThat(process.platform==='win32'||(stat.mode&0o007)===0,'CREDENTIAL_FILE_PERMISSIONS','Credential file must not be world-accessible.',500);
    return z.object({bindings:z.array(bindingSchema).max(500)}).strict().parse(JSON.parse(readFileSync(path,'utf8'))).bindings;
  };
}
export function resolveBinding(loader:BindingLoader,action:ProviderAction,destination:ProviderDestination,now:number):ProviderBinding {
  const all=loader().filter(b=>b.credentialRef===destination.credentialRef);
  requireThat(all.length===1,'PROVIDER_CREDENTIAL_UNAVAILABLE','A unique server credential binding is required.',403);
  const b=bindingSchema.parse(all[0]);
  requireThat(b.connectionId===destination._id&&b.connectionId===action.destinationId&&b.organizationId===action.organizationId&&
    b.workspaceId===action.workspaceId&&b.environment===action.environment&&b.provider===destination.provider&&
    b.configHash===hash(canonical(destination.providerConfig)),'PROVIDER_CREDENTIAL_SCOPE_DENIED','Credential does not authorize this destination and configuration.',403);
  requireThat(Date.parse(b.approval.expiresAt)>now,'PROVIDER_APPROVAL_EXPIRED','Server-side provider approval has expired.',403);
  return b;
}
export function tokenVault(http:HttpTransport=providerHttp) {
  const inflight=new Map<string,Promise<string>>(),cache=new Map<string,{token:string;expiresAt:number}>();
  return async(b:ProviderBinding,destination:ProviderDestination,now:number):Promise<string>=>{
    if(b.accessToken&&b.expiresAt&&Date.parse(b.expiresAt)>now+30000)return b.accessToken;
    requireThat(b.oauth&&b.provider!=='meta','PROVIDER_REAUTHENTICATION_REQUIRED','Refresh or rotate the authorized provider credential.',403);
    const cacheKey=hash(canonical(b));
    for(const [key,value] of cache)if(value.expiresAt<=now+30000)cache.delete(key);
    const cached=cache.get(cacheKey);if(cached&&cached.expiresAt>now+30000)return cached.token;
    const previous=inflight.get(cacheKey);if(previous)return previous;
    requireThat(inflight.size<500,'PROVIDER_AUTH_CAPACITY','Provider authorization is busy.',503);
    const promise=(async()=>{
      const config=destination.providerConfig;
      const url=b.provider==='google'?'https://oauth2.googleapis.com/token':`https://accounts.zoho.${config.provider==='zoho'?config.region:'com'}/oauth/v2/token`;
      const response=await http(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({
        grant_type:'refresh_token',client_id:b.oauth!.clientId,client_secret:b.oauth!.clientSecret,refresh_token:b.oauth!.refreshToken,
      }).toString()});
      requireThat(response.status>=200&&response.status<300,'PROVIDER_REAUTHENTICATION_REQUIRED','Provider token refresh was not accepted.',403);
      const data=z.object({access_token:secret,expires_in:z.number().positive(),refresh_token:secret.optional()}).passthrough().safeParse(response.body);
      requireThat(data.success,'PROVIDER_REAUTHENTICATION_REQUIRED','Provider token response is incomplete.',403);
      // A rotating-refresh provider needs an atomic external secret-manager update, not a silent in-memory loss.
      requireThat(!data.data.refresh_token||data.data.refresh_token===b.oauth!.refreshToken,'PROVIDER_REFRESH_ROTATION_REQUIRED','Persist rotated refresh credentials through the secret manager before continuing.',403);
      if(cache.size>=500)cache.delete(cache.keys().next().value!);
      cache.set(cacheKey,{token:data.data.access_token,expiresAt:now+Math.min(data.data.expires_in,3600)*1000});
      return data.data.access_token;
    })();inflight.set(cacheKey,promise);
    try{return await promise;}finally{inflight.delete(cacheKey);}
  };
}
