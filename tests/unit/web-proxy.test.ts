import test from 'node:test';import assert from 'node:assert/strict';
import {GET,POST} from '../../apps/web/app/api/[...path]/route.ts';
const context=(path:string[])=>({params:Promise.resolve({path})});
test('frontend proxy resolves its configured gateway at runtime and never accepts a client-selected host',async t=>{
 const previous=process.env.GATEWAY_ORIGIN;process.env.GATEWAY_ORIGIN='https://gateway.example';t.after(()=>{if(previous===undefined)delete process.env.GATEWAY_ORIGIN;else process.env.GATEWAY_ORIGIN=previous;});
 let calls=0;t.mock.method(globalThis,'fetch',async(url:URL,init:RequestInit)=>{calls++;assert.equal(url.href,'https://gateway.example/v1/me');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');return new Response('{"user":"fixture"}',{headers:{'content-type':'application/json'}});});
 const response=await GET(new Request('https://public.example/api/v1/me'),context(['v1','me']));assert.equal(response.status,200);assert.equal(calls,1);assert(response.headers.get('cache-control')?.includes('no-store'));
 assert.equal((await GET(new Request('https://public.example/api/test'),context(['https:','evil.example']))).status,404);assert.equal(calls,1);
});
test('frontend proxy preserves raw signed bytes and forwards cookie changes',async t=>{
 const bytes='{ "signed":true }';t.mock.method(globalThis,'fetch',async(_url:URL,init:RequestInit)=>{
  assert.equal(new TextDecoder().decode(init.body as Uint8Array),bytes);assert.equal(new Headers(init.headers).get('x-hub-signature-256'),'sha256=fixture');
  return new Response('{}',{status:202,headers:{'set-cookie':'session=fixture; HttpOnly; SameSite=Lax'}});
 });
 const response=await POST(new Request('https://public.example/api/ingest/v1/ingest/source',{method:'POST',body:bytes,headers:{'content-type':'application/json','x-hub-signature-256':'sha256=fixture'}}),context(['ingest','v1','ingest','source']));
 assert.equal(response.status,202);assert(response.headers.get('set-cookie')?.includes('HttpOnly'));
});
test('oversized browser requests fail before contacting the gateway',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{}');});
 const response=await POST(new Request('https://public.example/api/v1/events',{method:'POST',body:'x'.repeat(262145)}),context(['v1','events']));
 assert.equal(response.status,413);assert.equal(calls,0);
});
