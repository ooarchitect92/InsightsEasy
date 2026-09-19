import {readFileSync} from 'node:fs';import {createHmac} from 'node:crypto';
const [endpoint,path]=process.argv.slice(2);const secret=process.env.INSIGHTS_SOURCE_SECRET;
if(!endpoint||!path||!secret)throw new Error('Usage: INSIGHTS_SOURCE_SECRET=<secret> node scripts/signed-event.mjs <ingest URL including source ID> <event.json>');
const raw=readFileSync(path);if(raw.length>32768)throw new Error('Maximum event size is 32 KiB.');
const timestamp=String(Math.floor(Date.now()/1000));const signature='v1='+createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex');
const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json','x-insights-timestamp':timestamp,'x-insights-signature':signature},body:raw,redirect:'error',signal:AbortSignal.timeout(10000)});
console.log(response.status,await response.text());if(!response.ok)process.exitCode=1;
