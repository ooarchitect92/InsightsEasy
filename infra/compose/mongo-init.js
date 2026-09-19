// Executed by mongosh with an authenticated bootstrap operator. No application receives these credentials.
try { rs.status(); } catch { rs.initiate({_id:'rs0',members:[{_id:0,host:'mongo:27017'}]}); }
let ready=false;
for(let attempt=0;attempt<60;attempt++){if(db.hello().isWritablePrimary){ready=true;break;}sleep(1000);}
if(!ready)throw new Error('Replica set did not become writable');
// mongosh provides a CommonJS module loader for its runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const entries=JSON.parse(require('fs').readFileSync('/bootstrap/users.json','utf8'));
for(const entry of entries){const target=db.getSiblingDB(entry.database);
 if(!target.getUser(entry.owner))target.createUser({user:entry.owner,pwd:entry.password,roles:[{role:'readWrite',db:entry.database}]});}
