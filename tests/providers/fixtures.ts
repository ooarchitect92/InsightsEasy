/** Synthetic provider protocol fixtures. These are not responses from authorized provider accounts. */
import {hash,canonical} from '../../packages/domain/core.ts';
import {providerConfig,stages,type ProviderAction,type ProviderDestination,type ProviderId} from '../../packages/providers/contracts.ts';
import type {ProviderBinding} from '../../packages/providers/vault.ts';
import type {HttpReply} from '../../packages/providers/http.ts';
export const now=Date.parse('2026-09-18T00:00:00.000Z');
export const configs={
  zoho:providerConfig.parse({provider:'zoho',region:'in',module:'Leads',externalKeyField:'Platform_Key',versionField:'Platform_Version',
    fieldMap:{fullName:'Last_Name',email:'Email',stage:'Lead_Status'},stageMap:Object.fromEntries(stages.map(v=>[v,v])),defaults:{Company:'Fixture Ltd'}}),
  meta:providerConfig.parse({provider:'meta',graphVersion:'v24.0',datasetId:'123456',actionSource:'system_generated',testEventCode:'TEST_fixture'}),
  google:providerConfig.parse({provider:'google',apiVersion:'v1',accountId:'1234567890',conversionActionId:'987654321'}),
} as const;
export function fixture(provider:ProviderId,environment:'sandbox'|'production'='sandbox'){
  const config=structuredClone(configs[provider]);if(environment==='production'&&config.provider==='meta')delete config.testEventCode;
  const destination:ProviderDestination={_id:'destination_one',provider,credentialRef:'cred_one',providerConfig:config};
  const action:ProviderAction={_id:'intent_one',organizationId:'org_one',workspaceId:'workspace_one',environment,destinationId:destination._id,
    kind:provider==='zoho'?'crm.upsert':'ads.purchase',version:1,remoteKey:hash('customer key'),payload:provider==='zoho'?{
      fullName:'Synthetic Person',email:'synthetic@example.com',stage:'new',
    }:{businessEventId:'sale_one',leadId:'lead_one',currency:'USD',amountMinor:'100000',occurredAt:new Date(now-3600000).toISOString(),
      identifiers:{metaEmailSha256:hash('synthetic@example.com'),googleEmailSha256:hash('synthetic@example.com')},
      googleConsent:{adUserData:'granted',adPersonalization:'denied'}}};
  const binding:ProviderBinding={credentialRef:destination.credentialRef,connectionId:destination._id,organizationId:action.organizationId,
    workspaceId:action.workspaceId,environment,provider,configHash:hash(canonical(config)),
    accessToken:'synthetic-test-token-not-a-real-credential',expiresAt:new Date(now+3600000).toISOString(),
    approval:{reference:'synthetic internal fixture ONLY',expiresAt:new Date(now+86400000).toISOString(),allowExternalEffects:true}};
  return {action,destination,binding};
}
export function reply(status=200,body:unknown={},headers:Record<string,string>={}):HttpReply{return {status,body,headers:new Headers(headers)};}
export function fields(){return ['Platform_Key','Platform_Version','Last_Name','Email','Lead_Status','Company'].map(api_name=>({api_name,
  data_type:api_name==='Platform_Version'?'integer':api_name==='Lead_Status'?'picklist':'text',
  custom_field:api_name.startsWith('Platform_'),unique:api_name==='Platform_Key'?{case_sensitive:false}:{},system_mandatory:api_name==='Last_Name',
  read_only:false,field_read_only:false,operation_type:{api_create:true,api_update:true},length:255,
  ...(api_name==='Lead_Status'?{pick_list_values:stages.map(actual_value=>({actual_value}))}:{}),
}));}
export function remote(action:ProviderAction){return {id:'123456789',Platform_Key:action.remoteKey,Platform_Version:action.version,
  Last_Name:action.payload.fullName,Email:action.payload.email,Lead_Status:action.payload.stage,Company:'Fixture Ltd',Modified_Time:'2026-09-17T12:00:00+05:30'};}
