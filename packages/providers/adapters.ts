/** Exact, deliberately bounded provider operations. Scope/evidence: docs/PROVIDERS.md. */
import {z} from 'zod';
import {DomainError,canonical,currencyExponent,formatMinor,hash,requireThat,type Currency} from '../domain/core.ts';
import {providerConfig,receiptSchema,type ProviderAction,type ProviderDestination,type ProviderExecutor,type ProviderOutcome,type ProviderReceipt} from './contracts.ts';
import {providerHttp,retryDelay,safeProviderCode,type HttpTransport,type HttpReply} from './http.ts';
import {resolveBinding,tokenVault,type BindingLoader,type ProviderBinding} from './vault.ts';

const row=z.record(z.string(),z.unknown());
const bodyRow=(reply:HttpReply)=>row.parse(reply.body);
const records=(reply:HttpReply):Record<string,unknown>[]=>z.object({data:z.array(row)}).passthrough().parse(reply.body).data;
const expectedHash=(a:ProviderAction)=>hash(canonical({kind:a.kind,version:a.version,payload:a.payload,remoteKey:a.remoteKey}));
const receipt=(a:ProviderAction,p:ProviderDestination,b:ProviderBinding,status:ProviderReceipt['status'],extra:Partial<ProviderReceipt>={}):ProviderReceipt=>receiptSchema.parse({
  provider:p.provider,evidenceClass:a.environment==='production'?'provider_response':p.provider==='google'?'provider_validation':'provider_test',
  status,effectId:a._id,payloadHash:expectedHash(a),...extra,
});
function errorResult(r:HttpReply,read=false):ProviderOutcome|undefined {
  if(r.status>=200&&r.status<300)return;
  if(r.status===429)return {state:read?'outcome_unknown':'ready',reason:'PROVIDER_THROTTLED',retryMs:retryDelay(r.headers)};
  if([400,401,403,404,409,412,422].includes(r.status))return {state:read?'review_required':'rejected',reason:`PROVIDER_HTTP_${r.status}`};
  return {state:'outcome_unknown',reason:'PROVIDER_RESULT_AMBIGUOUS',retryMs:5000};
}
export function normalizedEmailHash(email:string,provider:'meta'|'google'):string {
  const normalized=z.string().email().max(254).parse(email.trim().toLowerCase());
  const at=normalized.lastIndexOf('@');let local=normalized.slice(0,at);const domain=normalized.slice(at+1);
  if(provider==='google'&&['gmail.com','googlemail.com'].includes(domain))local=local.split('+')[0]!.replaceAll('.','');
  requireThat(local.length>0,'INVALID_PROVIDER_IDENTIFIER','Normalized identifier is empty.',422);
  return hash(`${local}@${domain}`);
}
function conversionAmount(a:ProviderAction):number {
  const currency=z.enum(Object.keys(currencyExponent) as [Currency,...Currency[]]).parse(a.payload.currency);
  const minor=z.string().regex(/^\d+$/).max(32).parse(a.payload.amountMinor),formatted=formatMinor(BigInt(minor),currency),value=Number(formatted);
  requireThat(Number.isSafeInteger(Math.round(value*10**currencyExponent[currency]))&&
    value.toFixed(currencyExponent[currency])===formatted,'PROVIDER_NUMERIC_RANGE','Amount cannot be represented safely in this provider JSON number.',422);
  return value;
}
function hashIdentifier(value:unknown):string{return z.string().regex(/^[a-f0-9]{64}$/).parse(value);}

async function zoho(a:ProviderAction,p:ProviderDestination,b:ProviderBinding,token:string,http:HttpTransport,mode:'write'|'inspect',beforeWrite:()=>Promise<void>):Promise<ProviderOutcome> {
  const c=providerConfig.parse(p.providerConfig);requireThat(c.provider==='zoho'&&a.kind==='crm.upsert','UNSUPPORTED_CAPABILITY','Zoho adapter only supports mapped Leads upsert/read-back.',422);
  requireThat(b.approval.allowExternalEffects,'PROVIDER_EFFECT_NOT_APPROVED','External CRM writes require explicit server approval, including sandbox writes.',403);
  const base=`https://${a.environment==='sandbox'?'sandbox':'www'}.zohoapis.${c.region}/crm/v8`,headers={authorization:`Zoho-oauthtoken ${token}`};
  const data:Record<string,unknown>={...c.defaults,[c.externalKeyField]:a.remoteKey,[c.versionField]:a.version,
    [c.fieldMap.fullName]:z.string().min(1).max(100).parse(a.payload.fullName),
    [c.fieldMap.email]:z.string().email().parse(a.payload.email),[c.fieldMap.stage]:c.stageMap[z.enum(['new','contacted','qualified','disqualified','opportunity','won','lost']).parse(a.payload.stage)]};
  const remembered=receiptSchema.safeParse(a.receipt);
  const remoteId=remembered.success?remembered.data.remoteId:undefined;
  if(remoteId)requireThat(/^\d{1,30}$/.test(remoteId),'PROVIDER_REFERENCE_MISMATCH','Invalid saved CRM reference.',502);
  const url=remoteId?`${base}/Leads/${remoteId}`:`${base}/Leads/search?${new URLSearchParams({criteria:`(${c.externalKeyField}:equals:${a.remoteKey})`,per_page:'200'})}`;
  const found=await http(url,{headers});const readError=errorResult(found,true);if(readError&&found.status!==204)return readError;
  const candidates=found.status===204?[]:records(found).filter(r=>r[c.externalKeyField]===a.remoteKey);
  requireThat(candidates.length<=1,'PROVIDER_DUPLICATE_EXTERNAL_KEY','More than one CRM row matches the exact external key.',409);
  const current=candidates[0];
  if(mode==='inspect') {
    // Search indexing/remote processing may lag. Absence is NOT proof that a timed-out mutation did not happen.
    if(!current)return {state:'outcome_unknown',reason:'CRM_READBACK_NOT_YET_FOUND',retryMs:15000};
    if(Object.entries(data).every(([k,v])=>canonical(current[k]??null)===canonical(v)))
      return {state:'verified',receipt:receipt(a,p,b,'readback_verified',{remoteId:z.string().regex(/^\d{1,30}$/).parse(current.id)})};
    return {state:'review_required',reason:'CRM_READBACK_CONTENT_MISMATCH'};
  }
  if(current)requireThat(typeof current[c.versionField]==='number'&&Number.isSafeInteger(current[c.versionField])&&Number(current[c.versionField])>=1,'CRM_UNVERSIONED_EXTERNAL_ROW','Existing CRM row has no trusted version.',409);
  if(current&&Number(current[c.versionField])>=a.version) {
    if(Object.entries(data).every(([k,v])=>canonical(current[k]??null)===canonical(v)))
      return {state:'verified',receipt:receipt(a,p,b,'readback_verified',{remoteId:z.string().regex(/^\d{1,30}$/).parse(current.id)})};
    return {state:'review_required',reason:'CRM_NEWER_OR_CONFLICTING_VERSION'};
  }
  // Metadata is evaluated on the actual account. A user-defined stable key is mandatory; email is NOT the business identity.
  const meta=await http(`${base}/settings/fields?module=Leads`,{headers}),metaError=errorResult(meta,true);if(metaError)return {...metaError,state:'rejected',reason:'CRM_FIELD_DISCOVERY_FAILED'};
  const fields=z.object({fields:z.array(row)}).passthrough().parse(meta.body).fields;
  const byName=new Map(fields.map(f=>[String(f.api_name),f]));
  const keyField=byName.get(c.externalKeyField);
  requireThat(keyField?.unique&&typeof row.parse(keyField.unique).case_sensitive==='boolean'&&keyField.custom_field===true&&keyField.data_type==='text','CRM_UNIQUE_KEY_REQUIRED','External-key mapping must select an account-defined unique field.',422);
  for(const [field,value] of Object.entries(data)) {
    const f=byName.get(field);requireThat(f&&!f.read_only&&!f.field_read_only&&(!f.operation_type||(row.parse(f.operation_type).api_create!==false&&row.parse(f.operation_type).api_update!==false)),
      'CRM_FIELD_NOT_WRITABLE','A configured CRM field is unavailable or not writable.',422);
    requireThat(field===c.externalKeyField||!f.unique||typeof row.parse(f.unique).case_sensitive!=='boolean'||f.custom_field!==true,'CRM_UNSAFE_DUPLICATE_FIELD','Only the configured custom external key may be a mapped custom unique field.',422);
    if(typeof value==='string'&&typeof f.length==='number')requireThat(value.length<=f.length,'CRM_FIELD_TOO_LONG','Mapped field exceeds provider length.',422);
    if(f.data_type==='picklist'&&Array.isArray(f.pick_list_values))requireThat(f.pick_list_values.some(v=>row.parse(v).actual_value===value),
      'CRM_PICKLIST_MAPPING_INVALID','A mapped lifecycle value is not present in the CRM field.',422);
  }
  requireThat(byName.get(c.versionField)?.data_type==='integer','CRM_VERSION_FIELD_INVALID','CRM version field must be an integer.',422);
  for(const f of fields)if(f.system_mandatory===true)requireThat(data[String(f.api_name)]!==undefined,'CRM_REQUIRED_FIELD_MISSING','Required CRM field has no mapped value.',422);
  const conditional:Record<string,string>=current?{'If-Unmodified-Since':z.string().datetime({offset:true}).parse(current.Modified_Time)}:{};
  await beforeWrite();
  const response=await http(`${base}/Leads/upsert`,{method:'POST',headers:{...headers,...conditional,'content-type':'application/json'},body:JSON.stringify({
    data:[data],duplicate_check_fields:[c.externalKeyField],trigger:[],
    skip_feature_execution:[{name:'cadences',action:'insert'},{name:'cadences',action:'update'}],
    apply_feature_execution:[{name:'layout_rules'},{name:'criteria_validation_rule'}],
  })});
  const failure=errorResult(response);if(failure)return failure;
  const results=records(response);requireThat(results.length===1,'PROVIDER_RESPONSE_MISMATCH','Expected exactly one CRM result.',502);
  const result=results[0]!;
  if(result.status!=='success'||result.code!=='SUCCESS')return {state:'rejected',reason:safeProviderCode(result.code)};
  const createdId=z.string().regex(/^\d{1,30}$/).parse(row.parse(result.details).id);
  // Persist this reference before scheduling a separate read-back request.
  return {state:'provider_processing',receipt:receipt(a,p,b,'api_accepted',{remoteId:createdId}),retryMs:2000};
}
async function meta(a:ProviderAction,p:ProviderDestination,b:ProviderBinding,token:string,http:HttpTransport,mode:'write'|'inspect',now:number,beforeWrite:()=>Promise<void>):Promise<ProviderOutcome> {
  const c=providerConfig.parse(p.providerConfig);requireThat(c.provider==='meta'&&a.kind==='ads.purchase','UNSUPPORTED_CORRECTION','This Meta adapter does not expose a refund/reversal operation.',422);
  if(mode==='inspect')return {state:'review_required',reason:'META_NO_EVENT_READBACK_NO_BLIND_RETRY'};
  requireThat(b.approval.allowExternalEffects,'PROVIDER_EFFECT_NOT_APPROVED','Meta test/live events require an approved server binding.',403);
  requireThat(a.environment!=='sandbox'||c.testEventCode,'META_TEST_CODE_REQUIRED','Sandbox delivery requires a Meta test-event code.',422);
  requireThat(a.environment!=='production'||!c.testEventCode,'META_TEST_LIVE_MISMATCH','A test-event configuration cannot submit production conversions.',422);
  const time=Date.parse(z.string().datetime().parse(a.payload.occurredAt));
  requireThat(time<=now+60000&&now-time<=c.maxEventAgeHours*3600000,'PROVIDER_EVENT_AGE','Event is outside the configured Meta age window.',422);
  const identifiers=row.parse(a.payload.identifiers),email=hashIdentifier(identifiers.metaEmailSha256);
  await beforeWrite();
  const response=await http(`https://graph.facebook.com/${c.graphVersion}/${c.datasetId}/events`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({
    data:[{event_name:'Purchase',event_id:a._id,event_time:Math.floor(time/1000),action_source:c.actionSource,
      user_data:{em:[email],external_id:[hash(String(a.payload.leadId))]},
      custom_data:{currency:a.payload.currency,value:conversionAmount(a),order_id:a.payload.businessEventId}}],
    ...(c.testEventCode?{test_event_code:c.testEventCode}:{}),
  })});
  const failure=errorResult(response);if(failure)return failure;
  const result=bodyRow(response);
  if(result.error)return {state:'rejected',reason:'META_EVENT_REJECTED'};
  requireThat(result.events_received===1,'META_ACCEPTANCE_INCOMPLETE','Meta did not acknowledge exactly one event.',502);
  return {state:'accepted_unverified',reason:'API_ACCEPTANCE_IS_NOT_MATCH_OR_ATTRIBUTION',receipt:receipt(a,p,b,'api_accepted',{
    ...(typeof result.fbtrace_id==='string'?{requestId:result.fbtrace_id.slice(0,300)}:{}),
  })};
}
function googleDestination(c:Extract<ReturnType<typeof providerConfig.parse>,{provider:'google'}>) {
  return {reference:'conversion',operatingAccount:{accountType:'GOOGLE_ADS',accountId:c.accountId},productDestinationId:c.conversionActionId,
    ...(c.loginAccountId?{loginAccount:{accountType:'GOOGLE_ADS',accountId:c.loginAccountId}}:{})};
}
async function google(a:ProviderAction,p:ProviderDestination,b:ProviderBinding,token:string,http:HttpTransport,mode:'write'|'inspect',now:number,beforeWrite:()=>Promise<void>):Promise<ProviderOutcome> {
  const c=providerConfig.parse(p.providerConfig);requireThat(c.provider==='google'&&a.kind==='ads.purchase','UNSUPPORTED_CORRECTION','This Data Manager adapter does not implement event adjustments.',422);
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  if(mode==='inspect'){
    const previous=receiptSchema.safeParse(a.receipt);
    if(!previous.success||previous.data.provider!=='google'||!previous.data.requestId)return {state:'review_required',reason:'GOOGLE_REQUEST_ID_MISSING_NO_BLIND_RETRY'};
    const response=await http(`https://datamanager.googleapis.com/v1/requestStatus:retrieve?${new URLSearchParams({requestId:previous.data.requestId})}`,{headers});
    const failure=errorResult(response,true);if(failure)return failure;
    const statuses=z.object({requestStatusPerDestination:z.array(row)}).passthrough().parse(response.body).requestStatusPerDestination;
    requireThat(statuses.length===1,'PROVIDER_DESTINATION_MISMATCH','Status must describe exactly one configured destination.',502);
    const result=statuses[0]!,dest=row.parse(result.destination),account=row.parse(dest.operatingAccount);
    requireThat(account.accountType==='GOOGLE_ADS'&&account.accountId===c.accountId&&dest.productDestinationId===c.conversionActionId,
      'PROVIDER_DESTINATION_MISMATCH','Status belongs to another conversion destination.',502);
    const status=String(result.requestStatus);
    if(status==='SUCCESS'){
      const count=row.parse(result.eventsIngestionStatus).recordCount;
      requireThat(count==='1','GOOGLE_EVENT_COUNT_MISMATCH','Status must account for the single submitted event.',502);
      const warnings=result.warningInfo?z.array(row).parse(row.parse(result.warningInfo).warningCounts??[]).map(w=>safeProviderCode(w.reason)):[];
      return {state:'processed',receipt:{...previous.data,status:'processed',warnings}};
    }
    if(status==='FAILED'||status==='PARTIAL_SUCCESS')return {state:status==='PARTIAL_SUCCESS'?'review_required':'rejected',reason:'GOOGLE_'+status,receipt:previous.data};
    return {state:'provider_processing',reason:'GOOGLE_PROCESSING_NOT_COMPLETE',receipt:previous.data,retryMs:15000};
  }
  const time=Date.parse(z.string().datetime().parse(a.payload.occurredAt));
  requireThat(time<=now+60000&&now-time<=c.maxEventAgeDays*86400000,'PROVIDER_EVENT_AGE','Event is outside the configured Google age window.',422);
  const identifiers=row.parse(a.payload.identifiers),email=hashIdentifier(identifiers.googleEmailSha256);
  const consent=z.object({adUserData:z.literal('granted'),adPersonalization:z.enum(['granted','denied'])}).strict().parse(a.payload.googleConsent);
  const validateOnly=a.environment==='sandbox';
  requireThat(validateOnly||b.approval.allowExternalEffects,'PROVIDER_EFFECT_NOT_APPROVED','Live Google delivery requires an approved server binding.',403);
  await beforeWrite();
  const response=await http('https://datamanager.googleapis.com/v1/events:ingest',{method:'POST',headers,body:JSON.stringify({
    destinations:[googleDestination(c)],encoding:'HEX',validateOnly,
    events:[{destinationReferences:['conversion'],transactionId:hash(a._id),eventTimestamp:a.payload.occurredAt,
      currency:a.payload.currency,conversionValue:conversionAmount(a),
      userData:{userIdentifiers:[{emailAddress:email}]},
      consent:{adUserData:'CONSENT_GRANTED',adPersonalization:consent.adPersonalization==='granted'?'CONSENT_GRANTED':'CONSENT_DENIED'},
    }],
  })});
  const failure=errorResult(response);if(failure)return failure;const result=bodyRow(response);
  if(result.error)return {state:'rejected',reason:'GOOGLE_EVENT_REJECTED'};
  if(validateOnly)return {state:'validation_passed',reason:'VALIDATION_ONLY_NO_CONVERSION_UPLOADED',receipt:receipt(a,p,b,'validated')};
  const requestId=z.string().min(1).max(300).parse(result.requestId);
  return {state:'provider_processing',receipt:receipt(a,p,b,'processing',{requestId}),retryMs:15000};
}
export function createProviderExecutor(load:BindingLoader,http:HttpTransport=providerHttp,clock:()=>number=Date.now):ProviderExecutor {
  const token=tokenVault(http);
  return async(action,destination,mode,beforeWrite=async()=>{})=>{
    let mutationStarted=false;
    const effectHttp:HttpTransport=async(url,init)=>{
      if(init.method==='POST')mutationStarted=true;
      return http(url,init);
    };
    try {
      requireThat(destination.providerConfig.provider===destination.provider,'PROVIDER_CONFIG_MISMATCH','Provider configuration does not match the binding.',422);
      const binding=resolveBinding(load,action,destination,clock());
      if(action.receipt){const prior=receiptSchema.parse(action.receipt);
        requireThat(prior.provider===destination.provider&&prior.effectId===action._id&&prior.payloadHash===expectedHash(action),
          'PROVIDER_REFERENCE_MISMATCH','Saved provider evidence does not match this immutable action.',502);}
      const accessToken=await token(binding,destination,clock());
      if(destination.provider==='zoho')return await zoho(action,destination,binding,accessToken,effectHttp,mode,beforeWrite);
      if(destination.provider==='meta')return await meta(action,destination,binding,accessToken,effectHttp,mode,clock(),beforeWrite);
      return await google(action,destination,binding,accessToken,effectHttp,mode,clock(),beforeWrite);
    }catch(error){
      if(mutationStarted)return {state:'outcome_unknown',reason:'PROVIDER_IO_OR_RESPONSE_AMBIGUOUS',retryMs:10000};
      if(error instanceof DomainError&&error.status<500)return {state:error.code==='ACTION_SUPPRESSED'?'suppressed':'rejected',reason:error.code};
      if(error instanceof z.ZodError)return {state:mode==='inspect'?'review_required':'rejected',reason:'PROVIDER_CONTRACT_INVALID'};
      // Before the effect boundary a failed read/token/config lookup is a known non-write.
      return mode==='write'?{state:'rejected',reason:'PROVIDER_PREWRITE_UNAVAILABLE'}:
        {state:'outcome_unknown',reason:'PROVIDER_IO_OR_RESPONSE_AMBIGUOUS',retryMs:10000};
    }
  };
}
