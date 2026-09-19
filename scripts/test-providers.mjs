import {spawnSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
const files=readdirSync('tests/providers').filter(f=>f.endsWith('.test.ts')).sort().map(f=>'tests/providers/'+f);
if(!files.length)throw new Error('Provider tests are required.');
const result=spawnSync(process.execPath,['--experimental-strip-types','--test','--test-concurrency=1',...files],{stdio:'inherit',env:{...process.env,NO_AUTOSTART:'true'}});
process.exit(result.status??1);
