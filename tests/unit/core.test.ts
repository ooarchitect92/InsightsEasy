import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, hash, assertReplay, signature, verifySignature, scoped, permits, preflight, toMinor,
  formatMinor, allocate, buildReport, safeUrl, classifyAcquisition, csvCell, type Touch, type ReportInput } from '../../packages/domain/core.ts';
import { seal, unseal, passwordHash, passwordMatches } from '../../packages/runtime/crypto.ts';
const touches: Touch[] = [
  {id:'a',sourceId:'s',visitorId:'v',occurredAt:'2026-09-01T00:00:00.000Z',channel:'organic_search',permitted:true},
  {id:'b',sourceId:'s',visitorId:'v',occurredAt:'2026-09-02T00:00:00.000Z',channel:'campaign',permitted:true},
];
const input: ReportInput = {model:'linear',lookbackDays:30,from:'2026-09-01T00:00:00.000Z',to:'2026-10-01T00:00:00.000Z',capturedAt:'2026-09-17T00:00:00.000Z',
  sales:[{id:'sale',leadId:'lead',currency:'USD',amountMinor:'100000',refundedMinor:'20000',occurredAt:'2026-09-03T00:00:00.000Z'}],
  leads:[{id:'lead',touchSourceId:'s',visitorId:'v',analytics:'granted'}],touches};
test('canonical hashing ignores object order but not array order',()=>{assert.equal(canonical({z:1,a:2}),canonical({a:2,z:1}));assert.notEqual(canonical([1,2]),canonical([2,1]));});
test('canonical rejects undefined and nonfinite numbers',()=>{assert.throws(()=>canonical({a:undefined}));assert.throws(()=>canonical(Infinity));});
test('same-key changed-payload conflict',()=>{assert.doesNotThrow(()=>assertReplay(hash(canonical({a:1})),{a:1}));assert.throws(()=>assertReplay(hash(canonical({a:1})),{a:2}),/different data/);});
test('HMAC verifies original bytes only',()=>{const b=Buffer.from('{ "x":1}');const t='1790000000';const sig=signature('secret',t,b);assert.equal(verifySignature('secret',t,b,sig,1790000000),true);assert.equal(verifySignature('secret',t,Buffer.from('{"x":1}'),sig,1790000000),false);});
test('HMAC rejects stale, malformed and uppercase digests',()=>{const b=Buffer.from('{}');const t='1790000000';const sig=signature('secret',t,b);assert.equal(verifySignature('secret',t,b,sig,1790000400),false);assert.equal(verifySignature('secret',t,b,'bad',1790000000),false);assert.equal(verifySignature('secret',t,b,sig.toUpperCase(),1790000000),false);});
test('request filters cannot override tenant',()=>assert.deepEqual(scoped({organizationId:'o',workspaceId:'a',environment:'sandbox'},{workspaceId:'b',environment:'production',_id:'x'}),{organizationId:'o',workspaceId:'a',environment:'sandbox',_id:'x'}));
test('missing scope fails closed',()=>assert.throws(()=>scoped({organizationId:'o',workspaceId:'',environment:'sandbox'})));
test('viewer and invalid roles cannot execute or grant',()=>{assert.equal(permits('viewer','reports:read'),true);for(const role of ['viewer','__proto__','administrator'])assert.equal(permits(role,'actions:write'),false);});
test('purpose denial and disabled connection block preflight',()=>{const reasons=preflight({environment:'sandbox',enabled:false,sourceEnabled:true,role:'owner',consent:'unknown',capability:true,currentVersion:1,requestedVersion:1,deadline:'2099-01-01T00:00:00Z'});assert.ok(reasons.includes('DESTINATION_DISABLED'));assert.ok(reasons.includes('PURPOSE_NOT_GRANTED'));});
test('production simulator cannot pass preflight',()=>assert.ok(preflight({environment:'production',enabled:true,sourceEnabled:true,role:'owner',consent:'granted',capability:true,currentVersion:1,requestedVersion:1,deadline:'2099-01-01T00:00:00Z'}).includes('PROVIDER_NOT_CERTIFIED_FOR_LIVE')));
test('revocation and stale payload block queued work',()=>{const reasons=preflight({environment:'sandbox',enabled:true,sourceEnabled:false,role:'viewer',consent:'granted',capability:true,currentVersion:2,requestedVersion:1,deadline:'2099-01-01T00:00:00Z'});assert.ok(reasons.includes('ACTOR_PERMISSION_REVOKED'));assert.ok(reasons.includes('STALE_PAYLOAD_VERSION'));assert.ok(reasons.includes('SOURCE_DISABLED'));});
test('currency precision is explicit',()=>{assert.equal(toMinor('12.34','USD'),1234n);assert.equal(toMinor('12','JPY'),12n);assert.equal(toMinor('1.234','KWD'),1234n);assert.throws(()=>toMinor('1.1','JPY'));assert.throws(()=>toMinor('1','XYZ'));assert.throws(()=>toMinor('-1','USD'));assert.equal(formatMinor(1n,'USD'),'0.01');});
test('large money does not use floating point',()=>assert.equal(toMinor('999999999999999.99','USD'),99999999999999999n));
test('1000 sale minus 200 refund yields two 400 credits',()=>{const r=buildReport(input);assert.deepEqual(r.rows.map(x=>x.amountMinor),['40000','40000']);assert.equal(r.currencies[0]!.eligibleMinor,'80000');assert.equal(r.currencies[0]!.discrepancyMinor,'0');});
test('credit conserves integer pennies for 1000 generated cases',()=>{for(let i=0;i<1000;i++){const n=BigInt(i*1237);const r=allocate(n,[...touches,{...touches[1]!,id:'c'}],'linear');assert.equal(r.reduce((a,b)=>a+b.value,0n),n);}});
test('first/last touch are deterministic under reordered input',()=>{assert.equal(allocate(9n,[...touches].reverse(),'first_touch')[0]!.touch.id,'a');assert.equal(allocate(9n,touches,'last_touch')[0]!.touch.id,'b');});
test('unknown analytics is excluded, not zero revenue',()=>{const r=buildReport({...input,leads:[{id:'lead',analytics:'unknown'}]});assert.equal(r.currencies[0]!.observedMinor,'80000');assert.equal(r.currencies[0]!.excludedMinor,'80000');assert.equal(r.rows.length,0);});
test('zero eligible touches produce unattributed revenue',()=>{const r=buildReport({...input,touches:[]});assert.equal(r.currencies[0]!.unattributedMinor,'80000');assert.equal(r.rows[0]!.touchId,null);});
test('post-conversion and unconsented touches excluded',()=>{const r=buildReport({...input,touches:touches.map(t=>({...t,occurredAt:'2026-10-02T00:00:00.000Z'}))});assert.equal(r.rows[0]!.channel,'unattributed');});
test('visitor collisions across sources do not link',()=>{const r=buildReport({...input,touches:touches.map(t=>({...t,sourceId:'another-source'}))});assert.equal(r.rows[0]!.channel,'unattributed');});
test('refund larger than sale is rejected',()=>assert.throws(()=>buildReport({...input,sales:input.sales.map(s=>({...s,refundedMinor:'100001'}))})));
test('currencies are not summed across rows',()=>{const r=buildReport({...input,sales:[...input.sales,{...input.sales[0]!,id:'inr',currency:'INR'}]});assert.equal(r.currencies.length,2);assert.ok(r.currencies.every(c=>c.eligibleMinor==='80000'));});
test('URLs discard query and fragment and disallow unsafe protocols',()=>{assert.equal(safeUrl('https://example.org/x?password=secret#token'),'https://example.org/x');assert.throws(()=>safeUrl('file:///etc/passwd'));assert.throws(()=>safeUrl('https://user:pass@example.org'));});
test('missing keyword and campaign remain unknown',()=>{assert.equal(classifyAcquisition({}),'direct_or_unknown');assert.equal(classifyAcquisition({referrer:'https://www.google.com/search'}),'organic_search');});
test('CSV neutralizes spreadsheet formulas',()=>assert.equal(csvCell('=HYPERLINK("evil")'),'"\'=HYPERLINK(""evil"")"'));
test('encrypted secrets are bound to workspace context',()=>{const key=Buffer.alloc(32,7);const encrypted=seal('secret',key,'workspace-a');assert.equal(unseal(encrypted,key,'workspace-a'),'secret');assert.throws(()=>unseal(encrypted,key,'workspace-b'));});
test('passwords use salted scrypt and verification',async()=>{const a=await passwordHash('test-password-1234');const b=await passwordHash('test-password-1234');assert.notEqual(a,b);assert.equal(await passwordMatches('test-password-1234',a),true);assert.equal(await passwordMatches('wrong-password',a),false);});
