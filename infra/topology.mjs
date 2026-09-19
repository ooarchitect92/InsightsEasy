/** Single application topology for generated local and Kubernetes manifests. No credentials live here. */
export const owners=['identity','connections','journeys','crm','reporting','activation','simulator'];
export const ports={identity:4010,connections:4011,journeys:4012,crm:4013,reporting:4014,activation:4015,simulator:4050,gateway:4000,web:3000};
export const controllers=['connections','journeys','crm','reporting','activation'];
export const workloads=[...owners.map(owner=>({name:owner,owner,role:'api'})),{name:'gateway',owner:'gateway',role:'api'},
 ...controllers.map(owner=>({name:owner+'-controller',owner,role:'controller'})),
 ...['journeys','crm'].map(owner=>({name:owner+'-projector',owner,role:'projector'})),
 ...['crm','activation'].map(owner=>({name:owner+'-actions',owner,role:'actions'})),
 {name:'reporting-tasks',owner:'reporting',role:'tasks'}];
const healthy=name=>({[name]:{condition:'service_healthy'}});
const complete=name=>({[name]:{condition:'service_completed_successfully'}});
function application(owner,role='api'){
 const dependencies=role==='migrate'?complete('mongo-init'):owner==='gateway'?healthy('identity'):complete(owner+'-migrate');
 if(['controller','projector'].includes(role))Object.assign(dependencies,complete('kafka-init'));
 if(role==='actions'||(role==='controller'&&['crm','activation'].includes(owner)))Object.assign(dependencies,healthy('rabbitmq'));
 if((role==='controller'||role==='tasks')&&owner==='reporting')Object.assign(dependencies,healthy('redis-queue'));
 if(owner==='reporting'&&role==='api')Object.assign(dependencies,healthy('redis-cache'));
 return {image:`insightseasy-${owner}:local`,build:{context:'.',target:'service',args:{SERVICE:owner}},init:true,
  restart:role==='migrate'?'no':'unless-stopped',env_file:[`.local/${owner}.env`],environment:{PROCESS_ROLE:role},
  volumes:[`./.local/keys/${owner}.json:/run/identity/service.json:ro`],stop_grace_period:'50s',
  security_opt:['no-new-privileges:true'],cap_drop:['ALL'],mem_limit:'512m',cpus:1,networks:['backend'],depends_on:dependencies,
  ...(role==='migrate'?{}:{healthcheck:{test:['CMD','node','-e',`fetch('http://127.0.0.1:${ports[owner]}/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],interval:'5s',timeout:'5s',start_period:'20s',retries:60}})};
}
export function composeManifest(){
 const services={
  mongo:{image:'mongo:8.0.15',entrypoint:['bash','-ec','cp /bootstrap/mongo-key /tmp/replica-key; chmod 400 /tmp/replica-key; chown mongodb:mongodb /tmp/replica-key; exec docker-entrypoint.sh mongod --replSet rs0 --bind_ip_all --keyFile /tmp/replica-key'],
   environment:{MONGO_INITDB_ROOT_USERNAME:'operator',MONGO_INITDB_ROOT_PASSWORD:'${MONGO_ROOT_PASSWORD:?Run npm run setup}'},
   volumes:['mongo-data:/data/db','./.local/mongo-key:/bootstrap/mongo-key:ro'],networks:['backend'],
   healthcheck:{test:['CMD','mongosh','--quiet','--eval','quit(db.adminCommand({ping:1}).ok ? 0 : 1)'],interval:'5s',timeout:'5s',retries:60}},
  'mongo-init':{image:'mongo:8.0.15',depends_on:healthy('mongo'),restart:'no',environment:{MONGO_ROOT_PASSWORD:'${MONGO_ROOT_PASSWORD}'},
   entrypoint:['bash','-ec'],command:['exec mongosh --host mongo --username operator --password "$$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --quiet /bootstrap/init.js'],
   volumes:['./infra/compose/mongo-init.js:/bootstrap/init.js:ro','./.local/mongo-users.json:/bootstrap/users.json:ro'],networks:['backend']},
  kafka:{image:'apache/kafka:4.2.0',user:'0:0',environment:{CLUSTER_ID:'MkU3OEVBNTcwNTJENDM2Qk',KAFKA_NODE_ID:'1',KAFKA_PROCESS_ROLES:'broker,controller',
   KAFKA_LISTENERS:'PLAINTEXT://:9092,CONTROLLER://:9093',KAFKA_ADVERTISED_LISTENERS:'PLAINTEXT://kafka:9092',KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:'CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT',
   KAFKA_CONTROLLER_LISTENER_NAMES:'CONTROLLER',KAFKA_INTER_BROKER_LISTENER_NAME:'PLAINTEXT',KAFKA_CONTROLLER_QUORUM_VOTERS:'1@kafka:9093',
   KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR:'1',KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR:'1',KAFKA_TRANSACTION_STATE_LOG_MIN_ISR:'1',KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS:'0',
   KAFKA_LOG_DIRS:'/tmp/kraft-combined-logs',KAFKA_HEAP_OPTS:'-Xms256m -Xmx512m',KAFKA_AUTO_CREATE_TOPICS_ENABLE:'false'},
   volumes:['kafka-data:/tmp/kraft-combined-logs'],networks:['backend'],
   healthcheck:{test:['CMD-SHELL','/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092 >/dev/null 2>&1'],interval:'10s',timeout:'10s',retries:40,start_period:'20s'}},
  'kafka-init':{image:'apache/kafka:4.2.0',depends_on:healthy('kafka'),restart:'no',entrypoint:['bash','-ec'],
   command:['for topic in insightseasy.ingress.v2 insightseasy.facts.v2; do /opt/kafka/bin/kafka-topics.sh --bootstrap-server kafka:9092 --create --if-not-exists --topic "$$topic" --partitions 3 --replication-factor 1; done'],networks:['backend']},
  rabbitmq:{image:'rabbitmq:4.3.5-management',hostname:'rabbitmq',networks:['backend'],
   volumes:['rabbit-data:/var/lib/rabbitmq','./infra/compose/rabbitmq.conf:/etc/rabbitmq/rabbitmq.conf:ro','./.local/rabbit-definitions.json:/etc/rabbitmq/definitions.json:ro'],
   healthcheck:{test:['CMD','rabbitmq-diagnostics','-q','ping'],interval:'5s',timeout:'5s',retries:60}},
 };
 for(const kind of ['queue','cache'])services['redis-'+kind]={image:'redis:7.4.6',
  command:['redis-server','--requirepass',`\${${kind.toUpperCase()}_REDIS_PASSWORD:?Run npm run setup}`,'--appendonly',kind==='queue'?'yes':'no','--maxmemory',kind==='queue'?'256mb':'128mb','--maxmemory-policy',kind==='queue'?'noeviction':'allkeys-lru'],
  environment:{REDISCLI_AUTH:`\${${kind.toUpperCase()}_REDIS_PASSWORD:?Run npm run setup}`},networks:['backend'],
  ...(kind==='queue'?{volumes:['redis-queue-data:/data']}:{}),healthcheck:{test:['CMD','redis-cli','ping'],interval:'5s',timeout:'3s',retries:60}};
 for(const owner of owners)services[owner+'-migrate']=application(owner,'migrate');
 for(const work of workloads)services[work.name]=application(work.owner,work.role);
 services.gateway.ports=['127.0.0.1:4000:4000'];
 services.web={image:'insightseasy-web:local',build:{context:'.',target:'web'},init:true,restart:'unless-stopped',ports:['127.0.0.1:3000:3000'],
  depends_on:healthy('gateway'),networks:['backend'],mem_limit:'512m',security_opt:['no-new-privileges:true'],cap_drop:['ALL'],
  healthcheck:{test:['CMD','node','-e',"fetch('http://127.0.0.1:3000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],interval:'5s',timeout:'5s',retries:60}};
 return {name:'insightseasy-microservices',services,networks:{backend:{internal:true}},volumes:{'mongo-data':{},'kafka-data':{},'rabbit-data':{},'redis-queue-data':{}}};
}
