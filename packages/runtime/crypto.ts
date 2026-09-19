import { randomBytes, createCipheriv, createDecipheriv, scrypt, timingSafeEqual } from 'node:crypto';
import { requireThat } from '../domain/core.ts';
const derive = (password:string,salt:string):Promise<Buffer> => new Promise((resolve,reject)=>scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
export async function passwordHash(password: string): Promise<string> {
  requireThat(password.length >= 12 && password.length <= 128, 'INVALID_PASSWORD', 'Use a password of 12–128 characters.', 400);
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt-v1$${salt}$${key.toString('hex')}`;
}
export async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const [version, salt, digest] = encoded.split('$');
  if (version !== 'scrypt-v1' || !salt || !digest || password.length > 128) return false;
  const key = await derive(password, salt);
  const expected = Buffer.from(digest, 'hex');
  return expected.length === key.length && timingSafeEqual(expected, key);
}
export function seal(secret: string, key: Buffer, context: string): string {
  requireThat(key.length === 32, 'KEY_CONFIGURATION', 'Encryption key must contain 32 bytes.', 500);
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
}
export function unseal(value: string, key: Buffer, context: string): string {
  const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64url'));
  requireThat(iv && tag && data, 'INVALID_SECRET', 'Credential cannot be resolved.', 500);
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(Buffer.from(context)); decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
