/** TEST ONLY. Production entrypoints import MongoStore and have no in-memory fallback. */
import {assertCollection,type Store,type Transaction,type Entity,type Query,type FindOptions} from '../../services/shared/store.ts';
import type {Owner} from '../../services/shared/registry.ts';
import {DomainError} from '../../packages/domain/core.ts';
type Tables=Map<string,Map<string,Entity>>;
function property(row:unknown,path:string):unknown {return path.split('.').reduce<unknown>((v,k)=>v&&typeof v==='object'?(v as Record<string,unknown>)[k]:undefined,row);}
function compare(a:unknown,b:unknown):number {return a===b?0:(a as string|number)>(b as string|number)?1:-1;}
function matches(row:Entity,query:Query):boolean {
  return Object.entries(query).every(([key,expected])=>{
    if(key==='$or')return (expected as Query[]).some(q=>matches(row,q));
    if(key==='$and')return (expected as Query[]).every(q=>matches(row,q));
    const actual=property(row,key);
    if(expected&&typeof expected==='object'&&!Array.isArray(expected))return Object.entries(expected).every(([op,v])=>{
      if(op==='$in')return (v as unknown[]).includes(actual);if(op==='$ne')return actual!==v;
      if(op==='$gt')return compare(actual,v)>0;if(op==='$gte')return compare(actual,v)>=0;
      if(op==='$lt')return compare(actual,v)<0;if(op==='$lte')return compare(actual,v)<=0;
      if(op==='$exists')return (actual!==undefined)===v;
      return JSON.stringify(actual)===JSON.stringify(expected);
    });
    return actual===expected;
  });
}
export class MemoryStore implements Store {
  readonly owner:Owner;
  private tables:Tables=new Map();
  private pending:Promise<unknown>=Promise.resolve();
  available=true;
  constructor(owner:Owner){this.owner=owner;}
  private access(tables:Tables):Transaction {
    const table=(name:string)=>{assertCollection(this.owner,name);let t=tables.get(name);if(!t){t=new Map();tables.set(name,t);}return t;};
    return {
      get:async(name,id)=>structuredClone(table(name).get(id)??null),
      find:async(name,query={},options={})=>[...table(name).values()].filter(row=>matches(row,query))
        .sort((a,b)=>{for(const [key,direction] of Object.entries(options.sort??{_id:1})){const c=compare(property(a,key),property(b,key));if(c)return c*direction;}return 0;})
        .slice(0,options.limit??10001).map(row=>structuredClone(row)),
      insert:async(name,row)=>{if(table(name).has(row._id))throw new DomainError('DUPLICATE_KEY','Duplicate fixture key.',409);table(name).set(row._id,structuredClone(row));},
      put:async(name,row)=>{table(name).set(row._id,structuredClone(row));},
      remove:async(name,id)=>{table(name).delete(id);},
    };
  }
  async atomic<T>(fn:(tx:Transaction)=>Promise<T>):Promise<T> {
    const operation=this.pending.then(async()=>{await this.ready();const working=structuredClone(this.tables),result=await fn(this.access(working));this.tables=working;return result;});
    this.pending=operation.catch(()=>{});return operation;
  }
  async get(name:string,id:string){await this.ready();return this.access(this.tables).get(name,id);}
  async find(name:string,query:Query={},options:FindOptions={}){await this.ready();return this.access(this.tables).find(name,query,options);}
  insert(name:string,row:Entity){return this.atomic(tx=>tx.insert(name,row));}
  put(name:string,row:Entity){return this.atomic(tx=>tx.put(name,row));}
  remove(name:string,id:string){return this.atomic(tx=>tx.remove(name,id));}
  async ready(){if(!this.available)throw new DomainError('STORE_UNAVAILABLE','Fixture store is unavailable.',503);}
  async close(){}
}
