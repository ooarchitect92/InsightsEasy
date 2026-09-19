import {sign,verify,createPrivateKey,createPublicKey} from 'node:crypto';
import {z} from 'zod';
import {canonical,requireThat} from '../../packages/domain/core.ts';
import type {KeyRing} from './authentication.ts';
import type {Owner} from './registry.ts';
import type {ActionMessage} from './actions.ts';
export const messageSchema=z.object({id:z.string().min(1).max(128),generation:z.number().int().positive(),
  organizationId:z.string().min(1).max(128),workspaceId:z.string().min(1).max(128),environment:z.enum(['sandbox','production'])}).strict();
const envelope=z.object({v:z.literal(1),owner:z.enum(['crm','activation','reporting']),keyId:z.string().max(80),
  message:messageSchema,signature:z.string().max(128)}).strict();
export function signDispatch(owner:Owner,message:ActionMessage,ring:KeyRing) {
  const body={v:1 as const,owner,keyId:ring.keyId,message:messageSchema.parse(message)};
  return {...body,signature:sign(null,Buffer.from(canonical(body)),createPrivateKey(ring.privateKey)).toString('base64url')};
}
export function verifyDispatch(raw:unknown,owner:Owner,keys:Record<string,string>):ActionMessage {
  const parsed=envelope.parse(raw),{signature,...body}=parsed,key=keys[`${parsed.owner}:${parsed.keyId}`];
  requireThat(key&&parsed.owner===owner,'COMMAND_AUTH_INVALID','Command owner is invalid.',403);
  requireThat(verify(null,Buffer.from(canonical(body)),createPublicKey(key),Buffer.from(signature,'base64url')),
    'COMMAND_AUTH_INVALID','Command signature is invalid.',403);
  // Generation and business deadline are checked against authoritative state, not broker delivery time.
  return parsed.message;
}
