/** Deployment and data ownership are explicit; product scope remains exactly five. */
export const owners = ['identity', 'connections', 'journeys', 'crm', 'reporting', 'activation', 'simulator'] as const;
export type Owner = typeof owners[number];
export type Service = Owner | 'gateway';
export const serviceNames: readonly Service[] = [...owners, 'gateway'];
export const ports: Record<Service, number> = {
  gateway: 4000, identity: 4010, connections: 4011, journeys: 4012,
  crm: 4013, reporting: 4014, activation: 4015, simulator: 4050,
};
const infrastructure = ['requestKeys', 'audit', 'outbox', 'processed', 'transportFailures', 'rpcNonces'];
export const collections: Record<Owner, readonly string[]> = {
  identity: [...infrastructure, 'users', 'sessions', 'organizations', 'workspaces', 'memberships', 'rateLimits'],
  connections: [...infrastructure, 'connections', 'receipts', 'rateLimits'],
  journeys: [...infrastructure, 'touches'],
  crm: [...infrastructure, 'leads', 'stages', 'consents', 'consentHistory', 'actions', 'attempts', 'usage'],
  reporting: [...infrastructure, 'revenue', 'tasks', 'reports', 'usage'],
  activation: [...infrastructure, 'previews', 'actions', 'attempts', 'usage'],
  simulator: [...infrastructure, 'effects', 'objects', 'throttles'],
};
export const eventOwners: Record<string, Owner> = {
  'receipt.accepted.v2': 'connections', 'touch.recorded.v2': 'journeys',
  'lead.changed.v2': 'crm', 'consent.changed.v2': 'crm',
  'revenue.recorded.v2': 'reporting', 'report.completed.v2': 'reporting',
  'crm.action.completed.v2': 'crm', 'activation.action.completed.v2': 'activation',
};
export function eventTopic(type: string): string {
  return type === 'receipt.accepted.v2' ? 'insightseasy.ingress.v2' : 'insightseasy.facts.v2';
}
export const featureServices = ['connections', 'journeys', 'crm', 'reporting', 'activation'] as const;
