import {z} from 'zod';
import {DomainError, requireThat, type Scope, type Permission} from '../../packages/domain/core.ts';
import {role,id} from '../../packages/contracts/index.ts';
import type {Service, Owner} from './registry.ts';
import {verifyActorAuthority,type KeyRing} from './authentication.ts';
import type {Store, Entity} from './store.ts';
export const scopeSchema=z.object({organizationId:id,workspaceId:id,environment:z.enum(['sandbox','production']),actorId:id,role,authority:z.string().max(4096).optional(),policyVersion:z.number().int().positive().optional()}).strict();
export const rpcRequestSchema=z.object({v:z.literal(1),operation:z.string().regex(/^[a-z][a-zA-Z.]{1,80}$/),
  input:z.unknown(),context:z.object({sessionToken:z.string().max(128).optional()}).strict().default({})}).strict();
export type RpcRequest=z.infer<typeof rpcRequestSchema>;
export type Call = (target:Owner,operation:string,input:unknown,context?:RpcRequest['context'])=>Promise<Entity>;
export type Settings={environment:'sandbox'|'production';publicOrigin:string;encryptionKey:Buffer;simulatorOrigin:string;
  simulatorToken:string;keyRing:KeyRing;service:Service;port:number;origins:Record<Owner,string>;rpcTimeoutMs:number;tls?:{key:Buffer;cert:Buffer};
  cache?:{get:(key:string)=>Promise<string|null>;set:(key:string,value:string)=>Promise<void>}};
export interface Dependencies {store:Store;call:Call;settings:Settings;now:()=>Date;}
export type Handler=(request:RpcRequest,caller:Service)=>Promise<unknown>;
export function allow(caller:Service,...allowed:Service[]):void {
  requireThat(allowed.includes(caller),'SERVICE_OPERATION_DENIED','Caller is not permitted for this service operation.',403);
}
export function inputObject(value:unknown):Record<string,unknown> {
  return z.record(z.string(),z.unknown()).parse(value);
}
export async function authorize(d:Dependencies,r:RpcRequest,caller:Service,workspaceId:string,permission:Permission):Promise<Scope & {policyVersion:number}> {
  allow(caller,'gateway');
  return await d.call('identity','authorize',{workspaceId,permission},{sessionToken:r.context.sessionToken}) as Scope & {policyVersion:number} & Entity;
}
export async function currentActor(d:Dependencies,scope:Scope,permission:Permission):Promise<Scope & {policyVersion:number}> {
  verifyActorAuthority(scope,d.settings.keyRing.publicKeys);
  return await d.call('identity','authorizeActor',{scope,permission}) as Scope & {policyVersion:number} & Entity;
}
export function codeOf(e:unknown):string {return e instanceof DomainError?e.code:'DEPENDENCY_UNAVAILABLE';}
export function isUnavailable(e:unknown):boolean {return !(e instanceof DomainError)||e.status>=500||e.status===429;}
export const interactiveInput=z.object({workspaceId:id,id:id.optional(),key:id.optional(),body:z.unknown().optional(),
  cursor:id.optional()}).strict();
export function keyOf(key:string|undefined):string {requireThat(key,'IDEMPOTENCY_KEY_REQUIRED','Idempotency-Key is required.',400);return key;}
