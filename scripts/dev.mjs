import {spawnSync} from 'node:child_process';
const r=spawnSync('docker',['compose','up','--build','--wait'],{stdio:'inherit',shell:process.platform==='win32'});process.exit(r.status??1);
