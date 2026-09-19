import {MongoClient, MongoServerError, type ClientSession, type Document, type Filter} from 'mongodb';
import {randomUUID} from 'node:crypto';
import {assertReplay, canonical, hash, requireThat, scoped, stableId, type Scope} from '../../packages/domain/core.ts';
import {collections, type Owner} from './registry.ts';

export type Entity = Document & {_id: string};
export type Query = Record<string, unknown>;
export type FindOptions = {limit?: number; sort?: Record<string, 1 | -1>};
export interface Transaction {
  get(name: string, id: string): Promise<Entity | null>;
  find(name: string, query?: Query, options?: FindOptions): Promise<Entity[]>;
  insert(name: string, value: Entity): Promise<void>;
  put(name: string, value: Entity): Promise<void>;
  remove(name: string, id: string): Promise<void>;
}
export interface Store extends Transaction {
  readonly owner: Owner;
  atomic<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  ready(): Promise<void>;
  close(): Promise<void>;
}
export function assertCollection(owner: Owner, name: string): void {
  requireThat(collections[owner].includes(name), 'DATA_OWNERSHIP_DENIED',
    `${owner} does not own this collection.`, 403);
}
export const scopeFields = (s: Scope) => ({organizationId:s.organizationId, workspaceId:s.workspaceId, environment:s.environment});
export const rowScope = (r: Entity): Scope => ({organizationId:String(r.organizationId), workspaceId:String(r.workspaceId),
  environment:String(r.environment), actorId:String(r.actorId ?? r.createdBy ?? 'system'), role:'owner',...(typeof r.authority==='string'?{authority:r.authority}:{})});
export function belongs(row: Entity, scope: Scope): boolean {
  return row.organizationId === scope.organizationId && row.workspaceId === scope.workspaceId && row.environment === scope.environment;
}
export async function owned(tx: Transaction, name: string, id: string, scope: Scope): Promise<Entity> {
  const value = await tx.get(name, id);
  requireThat(value && belongs(value, scope), 'NOT_FOUND', 'Resource was not found.', 404);
  return value;
}
export async function page(tx: Transaction, name: string, scope: Scope, query: Query = {}, cursor?: string) {
  // Keyset pagination uses the stable unique id. New insertions require a refreshed traversal.
  const filter = scoped(scope, {...query, ...(cursor ? {_id:{$gt:cursor}} : {})});
  const found = await tx.find(name, filter, {limit:101, sort:{_id:1}});
  const hasMore = found.length > 100;
  const items = found.slice(0,100);
  return {items, hasMore, nextCursor:hasMore ? items.at(-1)!._id : null, limit:100,
    coverage:'Keyset page of operational records; reports use separately captured immutable manifests.'};
}
export async function idempotent<T>(store: Store, scope: Scope, operation: string, key: string, input: unknown,
  work: (tx: Transaction) => Promise<T>): Promise<T> {
  requireThat(/^[A-Za-z0-9_-]{1,128}$/.test(key), 'IDEMPOTENCY_KEY_REQUIRED', 'A stable Idempotency-Key is required.', 400);
  const id = stableId(scope.organizationId,scope.workspaceId,scope.environment,operation,key);
  return store.atomic(async tx => {
    const prior = await tx.get('requestKeys',id);
    if (prior) { assertReplay(String(prior.inputHash),input); return prior.response as T; }
    const response = await work(tx);
    await tx.insert('requestKeys',{_id:id,...scopeFields(scope),operation,inputHash:hash(canonical(input)),response,createdAt:new Date().toISOString()});
    return response;
  });
}
export async function audit(tx: Transaction, scope: Scope, event: string, targetId: string, detail: Query = {}): Promise<void> {
  await tx.insert('audit',{_id:randomUUID(),...scopeFields(scope),actorId:scope.actorId,event,targetId,detail,createdAt:new Date().toISOString()});
}

/** One client, one database and one owner credential per deployed service/worker. */
export class MongoStore implements Store {
  readonly owner: Owner;
  readonly client: MongoClient;
  private readonly database: ReturnType<MongoClient['db']>;
  constructor(owner: Owner, url: string, database: string) {
    this.owner = owner;
    this.client = new MongoClient(url,{appName:`InsightsEasy/${owner}`,serverSelectionTimeoutMS:4000,maxPoolSize:20});
    this.database = this.client.db(database);
  }
  private access(session?: ClientSession): Transaction {
    const col = (name: string) => {assertCollection(this.owner,name);return this.database.collection<Entity>(name);};
    return {
      get: (name,id) => col(name).findOne({_id:id},{session}),
      find: (name,query={},options={}) => col(name).find(query as Filter<Entity>,{session})
        .sort(options.sort ?? {_id:1}).limit(options.limit ?? 10001).toArray(),
      insert: async (name,value) => {await col(name).insertOne(value,{session});},
      put: async (name,value) => {await col(name).replaceOne({_id:value._id},value,{upsert:true,session});},
      remove: async (name,id) => {await col(name).deleteOne({_id:id},{session});},
    };
  }
  get(name: string,id: string) {return this.access().get(name,id);}
  find(name: string,query: Query={},options: FindOptions={}) {return this.access().find(name,query,options);}
  insert(name: string,value: Entity) {return this.access().insert(name,value);}
  put(name: string,value: Entity) {return this.access().put(name,value);}
  remove(name: string,id: string) {return this.access().remove(name,id);}
  async atomic<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let retry=0;retry<5;retry++) {
      const session=this.client.startSession();
      try {
        return await session.withTransaction(() => work(this.access(session)),{
          readConcern:{level:'snapshot'},writeConcern:{w:'majority',j:true},readPreference:'primary',maxCommitTimeMS:5000,
        }) as T;
      } catch (e) {
        // A duplicate aborts the transaction. Retry from a new session, never continue in the aborted one.
        if (!(e instanceof MongoServerError && e.code===11000 && retry<4)) throw e;
      } finally {await session.endSession();}
    }
    throw new Error('Transaction retry budget exhausted');
  }
  async ready(): Promise<void> {await this.database.command({ping:1});}
  async close(): Promise<void> {await this.client.close();}
  async initialize(createIndexes=false): Promise<void> {
    await this.client.connect();
    const hello=await this.database.command({hello:1});
    requireThat(hello.setName || hello.msg==='isdbgrid','REPLICA_SET_REQUIRED','MongoDB must support transactions.',500);
    if (!createIndexes) return;
    for (const name of collections[this.owner]) {
      await this.database.collection(name).createIndex({organizationId:1,workspaceId:1,environment:1,_id:1});
    }
    await this.database.collection('rpcNonces').createIndex({expiresAtDate:1},{expireAfterSeconds:0});
    await this.database.collection('outbox').createIndex({state:1,leaseUntil:1});
    if (this.owner==='identity'||this.owner==='connections')
      await this.database.collection('rateLimits').createIndex({expiresAtDate:1},{expireAfterSeconds:0});
    if (this.owner==='identity') {
      await this.database.collection('users').createIndex({email:1},{unique:true});
      await this.database.collection('memberships').createIndex({workspaceId:1,environment:1,userId:1},{unique:true});
      await this.database.collection('sessions').createIndex({expiresAtDate:1},{expireAfterSeconds:0});
    }
    if (this.owner==='crm' || this.owner==='activation')
      await this.database.collection('actions').createIndex({state:1,nextDispatchAt:1,leaseUntil:1});
    if (this.owner==='reporting')
      await this.database.collection('tasks').createIndex({state:1,nextDispatchAt:1,leaseUntil:1});
    if (this.owner==='journeys')
      await this.database.collection('touches').createIndex({workspaceId:1,sourceId:1,visitorId:1,occurredAt:1});
  }
}
