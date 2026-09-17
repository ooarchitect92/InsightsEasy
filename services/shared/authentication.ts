import {createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject} from 'node:crypto';
import {z} from 'zod';
import {canonical, hash, requireThat, type Scope} from '../../packages/domain/core.ts';
import {serviceNames, eventOwners, type Service} from './registry.ts';
import type {Store} from './store.ts';

export type KeyRing = {keyId:string; privateKey:string; publicKeys:Record<string,string>};
const names = z.enum(serviceNames as [Service,...Service[]]);
const claimsSchema=z.object({v:z.literal(1),issuer:names,audience:names,keyId:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  nonce:z.string().uuid(),issuedAt:z.number().int(),expiresAt:z.number().int(),bodyHash:z.string().regex(/^[a-f0-9]{64}$/),
  method:z.literal('POST'),path:z.literal('/rpc')}).strict();
export type Claims=z.infer<typeof claimsSchema>;
function privateKey(key:string):KeyObject {return createPrivateKey(key);}
function publicKey(key:string):KeyObject {return createPublicKey(key);}
export function issueServiceToken(issuer:Service,audience:Service,raw:Buffer,ring:KeyRing,now=Math.floor(Date.now()/1000)):string {
  const body:Claims={v:1,issuer,audience,keyId:ring.keyId,nonce:randomUUID(),issuedAt:now,expiresAt:now+30,
    bodyHash:hash(raw),method:'POST',path:'/rpc'};
  const payload=Buffer.from(canonical(body)).toString('base64url');
  return payload+'.'+sign(null,Buffer.from(payload),privateKey(ring.privateKey)).toString('base64url');
}
export function verifyServiceToken(token:string,audience:Service,raw:Buffer,keys:Record<string,string>,now=Math.floor(Date.now()/1000)):Claims {
  requireThat(token.length<=4096 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token),'SERVICE_AUTH_REQUIRED','Service authentication is required.',401);
  const [payload,signature]=token.split('.') as [string,string];
  const decoded=claimsSchema.safeParse(JSON.parse(Buffer.from(payload,'base64url').toString('utf8')));
  requireThat(decoded.success,'SERVICE_AUTH_INVALID','Service authentication is invalid.',401);
  const c=decoded.data;
  const key=keys[`${c.issuer}:${c.keyId}`];
  requireThat(key && c.audience===audience && c.bodyHash===hash(raw) && c.expiresAt>now && c.issuedAt<=now+5 &&
    c.expiresAt-c.issuedAt===30 && c.issuedAt>=now-35,
    'SERVICE_AUTH_INVALID','Service authentication is invalid or expired.',401);
  requireThat(verify(null,Buffer.from(payload),publicKey(key),Buffer.from(signature,'base64url')),
    'SERVICE_AUTH_INVALID','Service authentication is invalid.',401);
  return c;
}
export async function consumeNonce(store:Store,claims:Claims):Promise<void> {
  const id=`${claims.issuer}:${claims.nonce}`;
  await store.atomic(async tx=>{
    requireThat(!await tx.get('rpcNonces',id),'SERVICE_REPLAY_DENIED','Service request was already consumed.',409);
    await tx.insert('rpcNonces',{_id:id,expiresAtDate:new Date((claims.expiresAt+60)*1000)});
  });
}
export const eventSchema=z.object({v:z.literal(2),id:z.string().uuid(),type:z.string().max(80),producer:names,
  keyId:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),organizationId:z.string().min(1).max(128),workspaceId:z.string().min(1).max(128),
  environment:z.enum(['sandbox','production']),resourceId:z.string().min(1).max(128),correlationId:z.string().min(1).max(128),
  occurredAt:z.string().datetime(),category:z.enum(['lead','touch']).optional()}).strict();
export type Event=z.infer<typeof eventSchema>;
export type SignedEvent={event:Event;signature:string};
export function signEvent(event:Event,ring:KeyRing):SignedEvent {
  requireThat(event.keyId===ring.keyId,'KEY_VERSION_MISMATCH','Outbox event must use its recorded signing key.',500);
  return {event,signature:sign(null,Buffer.from(canonical(event)),privateKey(ring.privateKey)).toString('base64url')};
}
export function verifyEvent(value:unknown,keys:Record<string,string>):Event {
  const signed=z.object({event:eventSchema,signature:z.string().max(128)}).strict().parse(value);
  const e=signed.event, key=keys[`${e.producer}:${e.keyId}`];
  requireThat(key && eventOwners[e.type]===e.producer,'EVENT_AUTH_INVALID','Event producer does not own this fact.',403);
  requireThat(verify(null,Buffer.from(canonical(e)),publicKey(key),Buffer.from(signed.signature,'base64url')),
    'EVENT_AUTH_INVALID','Event signature is invalid.',403);
  return e;
}

/** Persisted, identity-signed delegation binds background work to the authenticated actor and tenant.
 * It is not a permission snapshot: every use still checks current membership, purpose and resource state.
 * It is kept in the owner's protected records, never put in queue messages or public responses. */
export function issueActorAuthority(scope:Scope,ring:KeyRing):string {
  const body={v:1,type:'actor-workspace-delegation',keyId:ring.keyId,actorId:scope.actorId,organizationId:scope.organizationId,
    workspaceId:scope.workspaceId,environment:scope.environment};
  const payload=Buffer.from(canonical(body)).toString('base64url');
  return payload+'.'+sign(null,Buffer.from(payload),privateKey(ring.privateKey)).toString('base64url');
}
export function verifyActorAuthority(scope:Scope,keys:Record<string,string>):void {
  requireThat(scope.authority&&scope.authority.length<=4096&&/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(scope.authority),
    'ACTOR_DELEGATION_REQUIRED','An authenticated actor delegation is required.',403);
  const [payload,signature]=scope.authority.split('.') as [string,string];
  const value=z.object({v:z.literal(1),type:z.literal('actor-workspace-delegation'),keyId:z.string().max(80),actorId:z.string(),organizationId:z.string(),workspaceId:z.string(),environment:z.string()}).strict().parse(JSON.parse(Buffer.from(payload,'base64url').toString('utf8')));
  const key=keys['identity:'+value.keyId];
  requireThat(key&&value.actorId===scope.actorId&&value.organizationId===scope.organizationId&&value.workspaceId===scope.workspaceId&&value.environment===scope.environment&&
    verify(null,Buffer.from(payload),publicKey(key),Buffer.from(signature,'base64url')),
    'ACTOR_DELEGATION_INVALID','Actor delegation is invalid for this scope.',403);
}
