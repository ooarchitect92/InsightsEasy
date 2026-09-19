import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
const files=readdirSync('tests/microservices').filter(f=>f.endsWith('.test.ts')).map(f=>'tests/microservices/'+f);
const result=spawnSync(process.execPath,['--experimental-strip-types','--test','--test-concurrency=1',...files],{stdio:'inherit',env:{...process.env,NO_AUTOSTART:'true'}});
process.exit(result.status??1);
