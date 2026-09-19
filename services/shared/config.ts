import {createProviderExecutor} from '../../packages/providers/adapters.ts';
import {fileBindings} from '../../packages/providers/vault.ts';
import {readFileSync} from 'node:fs';
import {createPrivateKey,createPublicKey} from 'node:crypto';
import {z} from 'zod';
import {requireThat} from '../../packages/domain/core.ts';
import {owners,ports,type Service,type Owner} from './registry.ts';
import type {Settings} from './context.ts';
const keySchema=z.object({keyId:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),privateKey:z.string().min(50),publicKeys:z.record(z.string(),z.string().min(50))}).strict();
export function loadSettings(service:Service):Settings {
  const required=(name:string)=>{const v=process.env[name];requireThat(v,'CONFIGURATION',`${name} must be configured.`,500);return v;};
  const environment=z.enum(['sandbox','production']).parse(process.env.APP_ENV??'sandbox');
  const publicOrigin=new URL(process.env.PUBLIC_ORIGIN??'http://localhost:3000').origin;
  const keyRing=keySchema.parse(JSON.parse(readFileSync(required('SERVICE_KEY_FILE'),'utf8')));
  requireThat(createPrivateKey(keyRing.privateKey).asymmetricKeyType==='ed25519','CONFIGURATION','Service identity must use Ed25519.',500);
  const expected=createPublicKey(createPrivateKey(keyRing.privateKey)).export({format:'pem',type:'spki'}).toString();
  requireThat(keyRing.publicKeys[`${service}:${keyRing.keyId}`]===expected,'CONFIGURATION','Service signing identity does not match the trust bundle.',500);
  const origins=Object.fromEntries(owners.map(owner=>[owner,process.env[owner.toUpperCase()+'_ORIGIN']??`http://${owner}:${ports[owner]}`])) as Record<Owner,string>;
  for(const origin of Object.values(origins)){const parsed=new URL(origin);requireThat(['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password&&parsed.origin===origin,'CONFIGURATION','Internal origins must be exact origins without credentials.',500);}
  const encryptionKey=service==='connections'?Buffer.from(required('ENCRYPTION_KEY'),'base64'):Buffer.alloc(0);
  if(service==='connections')requireThat(encryptionKey.length===32,'CONFIGURATION','Connection encryption key must be 32 bytes.',500);
  const tls=process.env.TLS_KEY_FILE&&process.env.TLS_CERT_FILE?{key:readFileSync(process.env.TLS_KEY_FILE),cert:readFileSync(process.env.TLS_CERT_FILE)}:undefined;
  if(environment==='production'){
    requireThat(publicOrigin.startsWith('https://')&&owners.filter(owner=>owner!=='simulator').every(owner=>origins[owner].startsWith('https://'))&&tls,
      'CONFIGURATION','Production requires HTTPS public/internal origins and service TLS certificates.',500);
    requireThat(service!=='simulator','CONFIGURATION','The simulator cannot start in production.',500);
  }
  return {service,environment,publicOrigin,keyRing,encryptionKey,origins,port:Number(process.env.PORT??ports[service]),
    rpcTimeoutMs:Number(process.env.RPC_TIMEOUT_MS??(service==='gateway'?20000:7000)),
    ...((service==='crm'||service==='activation')&&process.env.PROCESS_ROLE==='actions'&&process.env.PROVIDER_BINDINGS_FILE?
      {providerExecutor:createProviderExecutor(fileBindings(process.env.PROVIDER_BINDINGS_FILE))}:{}),
    simulatorOrigin:process.env.SIMULATOR_ORIGIN??origins.simulator,simulatorToken:process.env.SIMULATOR_TOKEN??'',...(tls?{tls}:{})};
}
