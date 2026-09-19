import test from 'node:test';
import assert from 'node:assert/strict';
import {providerHttp} from '../../packages/providers/http.ts';

test('provider transport enforces its host boundary before making a network request',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{}');});
  await assert.rejects(()=>providerHttp('https://127.0.0.1/admin',{}),/registered HTTPS/);assert.equal(calls,0);
});
test('provider transport uses no redirects or ambient cookies and enforces declared response limits',async t=>{
  t.mock.method(globalThis,'fetch',async(url:URL,init:RequestInit)=>{
    assert.equal(url.hostname,'graph.facebook.com');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');assert(init.signal);
    return new Response('{}',{status:200,headers:{'content-length':'1048577'}});
  });
  await assert.rejects(()=>providerHttp('https://graph.facebook.com/v24.0/123/events',{method:'POST'}),/exceeds 1 MiB/);
});
test('provider transport bounds a streamed body even without Content-Length',async t=>{
  let cancelled=false;const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new Uint8Array(1048577));},cancel(){cancelled=true;}});
  t.mock.method(globalThis,'fetch',async()=>new Response(stream));
  await assert.rejects(()=>providerHttp('https://datamanager.googleapis.com/v1/events:ingest',{}),/exceeds 1 MiB/);assert.equal(cancelled,true);
});
test('provider transport rejects malformed JSON without reflecting provider payload text',async t=>{
  t.mock.method(globalThis,'fetch',async()=>new Response('sensitive-token-value-in-provider-body',{status:200}));
  await assert.rejects(()=>providerHttp('https://datamanager.googleapis.com/v1/events:ingest',{}),error=>{
    assert(error instanceof Error);assert(!error.message.includes('sensitive-token'));return true;
  });
});
