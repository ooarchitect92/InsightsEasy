import { z } from 'zod';
export const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const name = z.string().trim().min(1).max(100);
export const date = z.string().datetime({offset:true}).transform(s => new Date(s).toISOString());
export const consentState = z.enum(['unknown','granted','denied']);
export const consent = z.object({service:consentState,analytics:consentState,advertising:consentState}).strict();
export const evidence = z.object({noticeVersion:z.string().min(1).max(80),reference:z.string().min(1).max(256)}).strict();
export const role = z.enum(['owner','operator','analyst','viewer']);
export const credentials = z.object({email:z.string().email().max(254).transform(s=>s.toLowerCase()),password:z.string().min(12).max(128)}).strict();
export const registration = credentials.extend({businessName:name}).strict();
export const workspaceInput = z.object({name,timezone:z.string().max(80).default('UTC'),currency:z.enum(['USD','INR','EUR','GBP','CAD','AUD','JPY','KWD']).default('USD')}).strict();
export const connectionInput = z.object({
  name,provider:z.enum(['signed_webhook','web_collector','simulator_crm','simulator_ads']),
  allowedOrigin:z.string().url().max(512).optional(),crmDestinationId:id.optional(),
  failureMode:z.enum(['normal','reject','timeout_after_commit','throttle_once']).default('normal'),
}).strict();
export const acquisition = z.object({
  url:z.string().url().max(2048),referrer:z.string().url().max(2048).optional(),
  utmSource:z.string().max(100).optional(),utmMedium:z.string().max(100).optional(),utmCampaign:z.string().max(100).optional(),
  clickId:z.object({type:z.enum(['gclid','gbraid','wbraid','fbclid']),value:z.string().max(256)}).strict().optional(),
}).strict();
export const touchEvent = z.object({kind:z.literal('touch'),eventId:id,occurredAt:date,visitorId:id,
  analyticsConsent:z.literal(true),acquisition}).strict();
export const leadEvent = z.object({kind:z.literal('lead'),eventId:id,occurredAt:date,externalLeadKey:id,
  sourceVersion:z.number().int().min(1).max(2147483647),fullName:name,email:z.string().email().max(254),
  touchLink:z.object({sourceId:id,visitorId:id}).strict().optional(),consent,evidence}).strict();
export const inboundEvent = z.discriminatedUnion('kind',[touchEvent,leadEvent]);
export const stageInput = z.object({stage:z.enum(['new','contacted','qualified','disqualified','opportunity','won','lost']),
  reason:z.string().trim().min(3).max(300),expectedVersion:z.number().int().positive()}).strict();
export const consentInput = z.object({consent,evidence,expectedVersion:z.number().int().positive()}).strict();
export const revenueInput = z.object({kind:z.enum(['sale','refund']),businessKey:id,leadId:id,currency:z.enum(['USD','INR','EUR','GBP','CAD','AUD','JPY','KWD']),
  amount:z.string().max(32),occurredAt:date,originalSaleId:id.optional(),sourceReference:z.string().trim().min(1).max(256)}).strict();
export const reportInput = z.object({name,model:z.enum(['first_touch','last_touch','linear']),from:date,to:date,
  lookbackDays:z.number().int().min(1).max(365).default(30)}).strict().refine(x=>x.from<x.to,'from must precede to');
export const activationInput = z.object({revenueId:id,destinationId:id}).strict();
export const activateInput = activationInput.extend({previewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const memberInput = z.object({email:z.string().email().max(254).transform(s=>s.toLowerCase()),role}).strict();
export const envelope = z.object({id,type:z.enum(['receipt.accepted.v1','lead.changed.v1','revenue.recorded.v1','action.completed.v1','report.completed.v1']),
  schemaVersion:z.literal(1),organizationId:id,workspaceId:id,environment:z.enum(['sandbox','production']),resourceId:id,
  correlationId:id}).strict();
export const command = z.object({id,workspaceId:id,organizationId:id,environment:z.enum(['sandbox','production']),generation:z.number().int().positive()}).strict();
export type InboundEvent = z.infer<typeof inboundEvent>;
export type ConnectionInput = z.infer<typeof connectionInput>;
export type RevenueInput = z.infer<typeof revenueInput>;
export type ReportRequest = z.infer<typeof reportInput>;
export type Envelope = z.infer<typeof envelope>;
