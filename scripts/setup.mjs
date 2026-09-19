import {mkdirSync,existsSync,writeFileSync,chmodSync} from 'node:fs';
import {generateKeyPairSync,randomBytes,createHash} from 'node:crypto';
const owners=['identity','connections','journeys','crm','reporting','activation','simulator'],services=[...owners,'gateway'];
const ports={identity:4010,connections:4011,journeys:4012,crm:4013,reporting:4014,activation:4015,simulator:4050,gateway:4000};
if(existsSync('.local/setup.json')||existsSync('.env'))throw new Error('Existing local configuration found. Preserve its keys and data. Use a separate clean directory for a fresh sandbox.');
mkdirSync('.local/keys',{recursive:true});
const secret=()=>randomBytes(32).toString('hex');
const mongoRoot=secret(),rabbitRoot=secret(),queuePassword=secret(),cachePassword=secret(),simulatorToken=secret(),encryption=randomBytes(32).toString('base64');
const dbPasswords=Object.fromEntries(owners.map(x=>[x,secret()])),rabbitPasswords={crm:secret(),activation:secret()};
const keys=Object.fromEntries(services.map(x=>[x,generateKeyPairSync('ed25519',{privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}})]));
const publicKeys=Object.fromEntries(services.map(x=>[x+':sandbox-v2',keys[x].publicKey]));
const write=(p,s)=>{writeFileSync(p,s,{mode:0o600});};
// Local bind-mounted service key files are readable by nonroot containers. Restrict host folder permissions; never commit it.
chmodSync('.local',0o700);
for(const service of services){write(`.local/keys/${service}.json`,JSON.stringify({keyId:'sandbox-v2',privateKey:keys[service].privateKey,publicKeys},null,2));chmodSync(`.local/keys/${service}.json`,0o644);
 const env={APP_ENV:'sandbox',PUBLIC_ORIGIN:process.env.PUBLIC_ORIGIN??'http://localhost:3000',PORT:ports[service],SERVICE_KEY_FILE:'/run/identity/service.json'};
 for(const owner of owners)env[owner.toUpperCase()+'_ORIGIN']=`http://${owner}:${ports[owner]}`;
 if(service!=='gateway'){env.MONGO_DATABASE=`insightseasy_${service}`;env.MONGO_URL=`mongodb://${service}:${dbPasswords[service]}@mongo:27017/${env.MONGO_DATABASE}?authSource=${env.MONGO_DATABASE}&replicaSet=rs0`;
  if(service!=='simulator')env.KAFKA_BROKERS='kafka:9092';}
 if(service==='connections')env.ENCRYPTION_KEY=encryption;
 if(['crm','activation','simulator'].includes(service))env.SIMULATOR_TOKEN=simulatorToken;
 if(['crm','activation'].includes(service))env.RABBITMQ_URL=`amqp://${service}:${rabbitPasswords[service]}@rabbitmq:5672/${encodeURIComponent('sandbox-'+service)}`;
 if(service==='reporting'){env.QUEUE_REDIS_URL=`redis://:${queuePassword}@redis-queue:6379`;env.CACHE_REDIS_URL=`redis://:${cachePassword}@redis-cache:6379`;}
 write(`.local/${service}.env`,Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');}
write('.local/mongo-users.json',JSON.stringify(owners.map(owner=>({owner,password:dbPasswords[owner],database:`insightseasy_${owner}`}))));chmodSync('.local/mongo-users.json',0o644);
write('.local/mongo-key',randomBytes(96).toString('base64'));chmodSync('.local/mongo-key',0o644);
// RabbitMQ salt+SHA256 password hashes are only for this generated private sandbox configuration.
const rabbitHash=p=>{const salt=randomBytes(4);return Buffer.concat([salt,createHash('sha256').update(Buffer.concat([salt,Buffer.from(p)])).digest()]).toString('base64');};
const definitions={users:[{name:'operator',password_hash:rabbitHash(rabbitRoot),hashing_algorithm:'rabbit_password_hashing_sha256',tags:['administrator']},
 ...Object.entries(rabbitPasswords).map(([name,password])=>({name,password_hash:rabbitHash(password),hashing_algorithm:'rabbit_password_hashing_sha256',tags:[]}))],
 vhosts:[{name:'sandbox-crm'},{name:'sandbox-activation'}],permissions:[]};
for(const owner of ['crm','activation']){definitions.permissions.push({user:owner,vhost:'sandbox-'+owner,configure:'.*',write:'.*',read:'.*'});definitions.permissions.push({user:'operator',vhost:'sandbox-'+owner,configure:'.*',write:'.*',read:'.*'});}
write('.local/rabbit-definitions.json',JSON.stringify(definitions));chmodSync('.local/rabbit-definitions.json',0o644);
write('.env',`MONGO_ROOT_PASSWORD=${mongoRoot}\nRABBITMQ_OPERATOR_PASSWORD=${rabbitRoot}\nQUEUE_REDIS_PASSWORD=${queuePassword}\nCACHE_REDIS_PASSWORD=${cachePassword}\n`);
write('.local/setup.json',JSON.stringify({version:2,environment:'sandbox',owners,createdAt:new Date().toISOString(),providers:'simulators only'},null,2));
console.log('Generated separate service identities and owner credentials in ignored .local/. No secret has been printed.');
console.log('Run: docker compose up -d --build --wait');
