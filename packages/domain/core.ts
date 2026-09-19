/** Pure deterministic domain rules. No broker, database, framework or network dependency. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 422) {
    super(message); this.name = 'DomainError'; this.code = code; this.status = status;
  }
}
export function requireThat(condition: unknown, code: string, message: string, status = 422): asserts condition {
  if (!condition) throw new DomainError(code, message, status);
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireThat(Number.isFinite(value), 'INVALID_NUMBER', 'Non-finite numbers are not supported.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  requireThat(typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype,
    'INVALID_VALUE', 'Only JSON values are supported.');
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}
export const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const stableId = (...parts: string[]): string => hash(JSON.stringify(parts));
export function assertReplay(expectedHash: string, input: unknown): void {
  requireThat(expectedHash === hash(canonical(input)), 'IDEMPOTENCY_CONFLICT',
    'The same identity was already used with different data.', 409);
}
/** Our signed-webhook protocol, not a Meta/Google signature implementation. */
export function signature(secret: string, timestamp: string, raw: Buffer): string {
  return 'v1=' + createHmac('sha256', secret).update(timestamp + '.').update(raw).digest('hex');
}
export function verifySignature(secret: string, timestamp: string, raw: Buffer, supplied: string,
  nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!/^[1-9][0-9]{9,10}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/.test(supplied)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  return timingSafeEqual(Buffer.from(signature(secret, timestamp, raw)), Buffer.from(supplied));
}

export type Role = 'owner' | 'operator' | 'analyst' | 'viewer';
export type Permission = 'sources:read' | 'sources:write' | 'leads:read' | 'leads:write' |
  'revenue:read' | 'revenue:write' | 'reports:read' | 'reports:write' | 'actions:read' | 'actions:write' | 'members:write';
const permissions: Record<Role, readonly Permission[]> = {
  owner: ['sources:read','sources:write','leads:read','leads:write','revenue:read','revenue:write',
    'reports:read','reports:write','actions:read','actions:write','members:write'],
  operator: ['sources:read','sources:write','leads:read','leads:write','revenue:read','revenue:write',
    'reports:read','reports:write','actions:read','actions:write'],
  analyst: ['sources:read','leads:read','revenue:read','reports:read','reports:write','actions:read'],
  viewer: ['reports:read'],
};
export const permits = (role: string, permission: Permission): boolean =>
  Object.hasOwn(permissions, role) && permissions[role as Role].includes(permission);
export type Scope = { organizationId: string; workspaceId: string; environment: string; actorId: string; role: Role; authority?: string };
export function scoped(scope: Pick<Scope, 'organizationId' | 'workspaceId' | 'environment'>,
  filter: Record<string, unknown> = {}): Record<string, unknown> {
  requireThat(scope.organizationId && scope.workspaceId && scope.environment,
    'SCOPE_REQUIRED', 'An authenticated workspace scope is required.', 403);
  return { ...filter, organizationId: scope.organizationId, workspaceId: scope.workspaceId, environment: scope.environment };
}
export type ConsentState = 'unknown' | 'granted' | 'denied';
export type Purpose = 'service' | 'analytics' | 'advertising';
export type Consent = Record<Purpose, ConsentState>;
export const unknownConsent = (): Consent => ({ service: 'unknown', analytics: 'unknown', advertising: 'unknown' });
export type Preflight = {
  environment: string; enabled: boolean; sourceEnabled: boolean; role: string; consent: ConsentState;
  capability: boolean; currentVersion: number; requestedVersion: number; deadline: string;
};
export function preflight(p: Preflight, now = Date.now()): string[] {
  const reasons: string[] = [];
  if (p.environment !== 'sandbox') reasons.push('PROVIDER_NOT_CERTIFIED_FOR_LIVE');
  if (!p.capability) reasons.push('UNSUPPORTED_CAPABILITY');
  if (!p.enabled) reasons.push('DESTINATION_DISABLED');
  if (!p.sourceEnabled) reasons.push('SOURCE_DISABLED');
  if (!permits(p.role, 'actions:write')) reasons.push('ACTOR_PERMISSION_REVOKED');
  if (p.consent !== 'granted') reasons.push('PURPOSE_NOT_GRANTED');
  if (p.currentVersion !== p.requestedVersion) reasons.push('STALE_PAYLOAD_VERSION');
  if (new Date(p.deadline).getTime() <= now) reasons.push('DEADLINE_EXCEEDED');
  return reasons;
}

/** Explicit supported currency table; unsupported currencies fail rather than assume two decimals. */
export const currencyExponent = { USD: 2, INR: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, JPY: 0, KWD: 3 } as const;
export type Currency = keyof typeof currencyExponent;
export function toMinor(amount: string, currency: string): bigint {
  requireThat(Object.hasOwn(currencyExponent, currency), 'UNSUPPORTED_CURRENCY', 'Currency is not configured.');
  const exponent = currencyExponent[currency as Currency];
  requireThat(/^(0|[1-9][0-9]{0,14})(\.[0-9]+)?$/.test(amount), 'INVALID_AMOUNT', 'Use an unsigned decimal string.');
  const [integer, fraction = ''] = amount.split('.');
  requireThat(fraction.length <= exponent, 'INVALID_PRECISION', 'Amount exceeds the currency precision.');
  return BigInt(integer!) * (10n ** BigInt(exponent)) + BigInt(fraction.padEnd(exponent, '0') || '0');
}
export function formatMinor(amount: bigint, currency: Currency): string {
  const exponent = currencyExponent[currency];
  const sign = amount < 0n ? '-' : ''; const value = amount < 0n ? -amount : amount;
  if (!exponent) return sign + value.toString();
  const s = value.toString().padStart(exponent + 1, '0');
  return sign + s.slice(0, -exponent) + '.' + s.slice(-exponent);
}
export type Model = 'first_touch' | 'last_touch' | 'linear';
export type Touch = { id: string; sourceId: string; visitorId: string; occurredAt: string; channel: string; permitted: boolean };
export type Sale = { id: string; leadId: string; currency: Currency; amountMinor: string; refundedMinor: string; occurredAt: string };
export type JourneyLead = { id: string; touchSourceId?: string; visitorId?: string; analytics: ConsentState };
export type ReportInput = {
  sales: Sale[]; leads: JourneyLead[]; touches: Touch[]; model: Model; lookbackDays: number;
  from: string; to: string; capturedAt: string;
};
export type Credit = { saleId: string; leadId: string; touchId: string | null; channel: string; currency: Currency; amountMinor: string };
export function allocate(amount: bigint, touches: Touch[], model: Model): { touch: Touch; value: bigint }[] {
  requireThat(amount >= 0n, 'NEGATIVE_NET_REVENUE', 'Refunds cannot exceed the sale.');
  const sorted = [...touches].sort((a,b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  if (!sorted.length) return [];
  if (model === 'first_touch') return [{touch: sorted[0]!, value: amount}];
  if (model === 'last_touch') return [{touch: sorted[sorted.length-1]!, value: amount}];
  requireThat(model === 'linear', 'UNSUPPORTED_MODEL', 'Attribution model is not supported.');
  const count = BigInt(sorted.length); const base = amount / count; const remainder = amount % count;
  return sorted.map((touch, i) => ({touch, value: base + (BigInt(i) < remainder ? 1n : 0n)}));
}
export function buildReport(input: ReportInput) {
  requireThat(input.lookbackDays >= 1 && input.lookbackDays <= 365, 'INVALID_WINDOW', 'Lookback must be 1–365 days.');
  const rows: Credit[] = [];
  const totals: Record<string, {observed: bigint; eligible: bigint; excluded: bigint; attributed: bigint; unattributed: bigint}> = {};
  const exclusions: {saleId: string; reason: string}[] = [];
  const leads = new Map(input.leads.map(l => [l.id, l]));
  for (const sale of input.sales) {
    if (sale.occurredAt < input.from || sale.occurredAt >= input.to) continue;
    const net = BigInt(sale.amountMinor) - BigInt(sale.refundedMinor);
    requireThat(net >= 0n, 'NEGATIVE_NET_REVENUE', 'Refund totals are inconsistent.');
    const total = totals[sale.currency] ??= { observed: 0n, eligible: 0n, excluded: 0n, attributed: 0n, unattributed: 0n };
    total.observed += net;
    const lead = leads.get(sale.leadId);
    if (!lead || lead.analytics !== 'granted') {
      total.excluded += net; exclusions.push({saleId: sale.id, reason: 'ANALYTICS_PURPOSE_NOT_GRANTED'}); continue;
    }
    total.eligible += net;
    const since = new Date(new Date(sale.occurredAt).getTime() - input.lookbackDays * 86400000).toISOString();
    const touches = input.touches.filter(t => t.sourceId === lead.touchSourceId && t.visitorId === lead.visitorId &&
      t.permitted && t.occurredAt >= since && t.occurredAt <= sale.occurredAt);
    const credits = allocate(net, touches, input.model);
    if (!credits.length) {
      total.unattributed += net;
      rows.push({saleId: sale.id, leadId: sale.leadId, touchId: null, channel: 'unattributed', currency: sale.currency, amountMinor: net.toString()});
    } else for (const {touch, value} of credits) {
      total.attributed += value;
      rows.push({saleId: sale.id, leadId: sale.leadId, touchId: touch.id, channel: touch.channel, currency: sale.currency, amountMinor: value.toString()});
    }
  }
  const currencies = Object.entries(totals).map(([currency, t]) => {
    requireThat(t.eligible === t.attributed + t.unattributed && t.observed === t.eligible + t.excluded,
      'RECONCILIATION_FAILED', 'Credit conservation failed.');
    return {currency, observedMinor: t.observed.toString(), eligibleMinor: t.eligible.toString(), excludedMinor: t.excluded.toString(),
      attributedMinor: t.attributed.toString(), unattributedMinor: t.unattributed.toString(), discrepancyMinor: '0'};
  });
  return {model: input.model, metricVersion: 'sales-cohort-net-v1', identityVersion: 'explicit-source-link-v1',
    roundingPolicy: 'equal-minor-units-residual-earliest-touch-v1', outcomeBasis: 'sales cohort, refunds known at snapshot',
    dataAsOf: input.capturedAt, from: input.from, to: input.to, lookbackDays: input.lookbackDays,
    currencies, rows, exclusions, reconciled: true, caveat: 'Allocated credit is not causal lift. Currencies are never added together.'};
}
export function safeUrl(value: string): string {
  let url: URL; try { url = new URL(value); } catch { throw new DomainError('INVALID_URL', 'Use an absolute HTTP(S) URL.'); }
  requireThat(['https:', 'http:'].includes(url.protocol) && !url.username && !url.password,
    'INVALID_URL', 'Only credential-free HTTP(S) URLs are supported.');
  return url.origin + url.pathname; // Deliberately discard arbitrary query and fragment data.
}
export function classifyAcquisition(acquisition: {utmSource?: string; utmMedium?: string; referrer?: string}): string {
  if (acquisition.utmSource) return acquisition.utmSource;
  if (!acquisition.referrer) return 'direct_or_unknown';
  const host = new URL(acquisition.referrer).hostname.toLowerCase();
  if (/(^|\.)google\.[a-z.]+$/.test(host) || host === 'www.bing.com' || host === 'duckduckgo.com') return 'organic_search';
  return 'referral';
}
export const csvCell = (value: string): string => '"' + (/^[=+\-@\t\r\n]/.test(value) ? "'" + value : value).replaceAll('"','""') + '"';
