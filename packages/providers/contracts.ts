import {z} from 'zod';

const field=z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/).refine(s=>!['__proto__','constructor','prototype','id'].includes(s));
export const providerId=z.enum(['zoho','meta','google']);
export type ProviderId=z.infer<typeof providerId>;
export const stages=['new','contacted','qualified','disqualified','opportunity','won','lost'] as const;
export const zohoRegion=z.enum(['com','in','eu','com.au','jp','ca','com.cn','sa']);
export const zohoConfig=z.object({
  provider:z.literal('zoho'),region:zohoRegion,module:z.literal('Leads'),
  externalKeyField:field,versionField:field,
  fieldMap:z.object({fullName:field,email:field,stage:field}).strict(),
  stageMap:z.record(z.enum(stages),z.string().trim().min(1).max(100)),
  defaults:z.record(field,z.union([z.string().max(1000),z.number().finite(),z.boolean()])).default({}),
}).strict().superRefine((c,ctx)=>{
  const fields=[c.externalKeyField,c.versionField,...Object.values(c.fieldMap)];
  if(new Set(fields).size!==fields.length)ctx.addIssue({code:'custom',message:'Every mapped field must be distinct.'});
  if(Object.keys(c.defaults).some(key=>fields.includes(key)))ctx.addIssue({code:'custom',message:'Defaults cannot overwrite identity or mapped fields.'});
});
export const metaConfig=z.object({provider:z.literal('meta'),graphVersion:z.string().regex(/^v\d{1,3}\.0$/),datasetId:z.string().regex(/^\d{1,30}$/),
  // This revision sends confirmed CRM/offline outcomes, not invented browser/device evidence.
  actionSource:z.literal('system_generated'),testEventCode:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
  maxEventAgeHours:z.number().int().min(1).max(168).default(168),
}).strict();
export const googleConfig=z.object({provider:z.literal('google'),apiVersion:z.literal('v1'),
  accountId:z.string().regex(/^\d{1,30}$/),conversionActionId:z.string().regex(/^\d{1,30}$/),
  loginAccountId:z.string().regex(/^\d{1,30}$/).optional(),
  maxEventAgeDays:z.number().int().min(1).max(90).default(90),
}).strict();
export const providerConfig=z.discriminatedUnion('provider',[zohoConfig,metaConfig,googleConfig]);
export type ProviderConfig=z.infer<typeof providerConfig>;
export const googleConsent=z.object({adUserData:z.enum(['unknown','granted','denied']),adPersonalization:z.enum(['unknown','granted','denied'])}).strict();
export const unknownGoogleConsent={adUserData:'unknown',adPersonalization:'unknown'} as const;
export const receiptSchema=z.object({provider:providerId,evidenceClass:z.enum(['provider_validation','provider_test','provider_response']),
  status:z.enum(['validated','api_accepted','processing','processed','readback_verified']),effectId:z.string().max(200),
  remoteId:z.string().max(300).optional(),requestId:z.string().max(300).optional(),payloadHash:z.string().length(64),
  warnings:z.array(z.string().max(120)).max(100).default([]),
}).strict();
export type ProviderReceipt=z.infer<typeof receiptSchema>;
export type ProviderOutcome={state:'ready'|'provider_processing'|'accepted_unverified'|'validation_passed'|'processed'|'verified'|'outcome_unknown'|'rejected'|'review_required'|'suppressed';
  reason?:string;receipt?:ProviderReceipt;retryMs?:number};
export interface ProviderAction {
  _id:string;organizationId:string;workspaceId:string;environment:'sandbox'|'production';destinationId:string;
  remoteKey:string;version:number;kind:'crm.upsert'|'ads.purchase'|'ads.refund';payload:Record<string,unknown>;
  receipt?:unknown;
}
export interface ProviderDestination {_id:string;provider:ProviderId;credentialRef:string;providerConfig:ProviderConfig;}
export type ProviderExecutor=(action:ProviderAction,destination:ProviderDestination,mode:'write'|'inspect',beforeWrite?:()=>Promise<void>)=>Promise<ProviderOutcome>;

export const providerManifest={
  zoho:{kind:'destination',state:'adapter_implemented_not_certified',operations:['Leads.upsert','Leads.readback'],auth:'server_pre_authorized_oauth',refunds:false},
  meta:{kind:'destination',state:'adapter_implemented_not_certified',operations:['offline.Purchase'],auth:'server_access_token',refunds:false},
  google:{kind:'destination',state:'adapter_implemented_not_certified',operations:['events.ingest','requestStatus.retrieve'],auth:'server_pre_authorized_oauth',refunds:false},
} as const;
