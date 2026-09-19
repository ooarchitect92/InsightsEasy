import {issueActorAuthority,verifyActorAuthority} from '../shared/authentication.ts';
import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash,stableId,requireThat,permits,type Scope,type Permission} from '../../packages/domain/core.ts';
import {passwordHash,passwordMatches} from '../../packages/runtime/crypto.ts';
import * as dto from '../../packages/contracts/index.ts';
import {audit,scopeFields,idempotent,owned,page,type Entity} from '../shared/store.ts';
import {allow,interactiveInput,keyOf,scopeSchema,type Dependencies,type Handler} from '../shared/context.ts';
const permissionSchema=z.enum(['sources:read','sources:write','leads:read','leads:write','revenue:read','revenue:write',
  'reports:read','reports:write','actions:read','actions:write','members:write']);

export function identityService(d:Dependencies):Handler {
  const {store}=d;
  async function limit(key:string,max=20) {
    const minute=Math.floor(d.now().getTime()/60000),id=stableId(key,String(minute));
    await store.atomic(async tx=>{const old=await tx.get('rateLimits',id),count=Number(old?.count??0)+1;
      requireThat(count<=max,'RATE_LIMITED','Too many attempts; retry after this minute.',429);
      await tx.put('rateLimits',{_id:id,count,expiresAtDate:new Date((minute+2)*60000)});});
  }
  async function identity(token:string|undefined):Promise<Entity> {
    requireThat(token&&/^[A-Za-z0-9_-]{43}$/.test(token),'AUTHENTICATION_REQUIRED','Sign in to continue.',401);
    const session=await store.get('sessions',hash(token));
    requireThat(session&&String(session.expiresAt)>d.now().toISOString(),'AUTHENTICATION_REQUIRED','Session expired or revoked.',401);
    const user=await store.get('users',String(session.userId));
    requireThat(user&&!user.disabled,'AUTHENTICATION_REQUIRED','Session expired or revoked.',401);
    return user;
  }
  async function context(userId:string,workspaceId:string,permission:Permission) {
    const user=await store.get('users',userId);
    requireThat(user&&!user.disabled,'AUTHENTICATION_REQUIRED','Account is unavailable.',401);
    const workspace=await store.get('workspaces',workspaceId);
    const members=await store.find('memberships',{workspaceId,userId,active:true,environment:d.settings.environment},{limit:1});
    const member=members[0];
    requireThat(workspace&&member&&workspace.organizationId===member.organizationId&&workspace.environment===d.settings.environment,
      'NOT_FOUND','Workspace was not found.',404);
    requireThat(permits(String(member.role),permission),'POLICY_DENIED','Current permissions do not allow this operation.',403);
    const scope={organizationId:String(workspace.organizationId),workspaceId,environment:d.settings.environment,
      actorId:userId,role:member.role as Scope['role'],policyVersion:Number(workspace.policyVersion)};
    return {...scope,authority:issueActorAuthority(scope,d.settings.keyRing)};
  }
  async function openSession(user:Entity) {
    const token=randomBytes(32).toString('base64url'),expiresAtDate=new Date(d.now().getTime()+8*3600000);
    await store.insert('sessions',{_id:hash(token),userId:user._id,expiresAt:expiresAtDate.toISOString(),expiresAtDate});
    return {sessionToken:token};
  }
  return async(r,caller)=>{
    if(r.operation==='authorizeActor') {
      allow(caller,'crm','reporting','activation','journeys','connections');
      const input=z.object({scope:scopeSchema,permission:permissionSchema}).strict().parse(r.input);
      verifyActorAuthority(input.scope,d.settings.keyRing.publicKeys);
      const actual=await context(input.scope.actorId,input.scope.workspaceId,input.permission);
      requireThat(actual.organizationId===input.scope.organizationId&&actual.environment===input.scope.environment,
        'NOT_FOUND','Workspace was not found.',404);return actual;
    }
    if(r.operation==='authorize') {
      allow(caller,'gateway','connections','journeys','crm','reporting','activation');
      const input=z.object({workspaceId:dto.id,permission:permissionSchema}).strict().parse(r.input);
      const user=await identity(r.context.sessionToken);
      return context(user._id,input.workspaceId,input.permission);
    }
    allow(caller,'gateway');
    if(r.operation==='meta')return {environment:d.settings.environment,signupEnabled:d.settings.environment==='sandbox',
      architecture:'domain-microservices-v2',liveProvidersEnabled:false};
    if(r.operation==='register') {
      requireThat(d.settings.environment==='sandbox','REGISTRATION_GATED','Production owners require verified provisioning.',403);
      const input=z.object({key:dto.id,body:dto.registration}).strict().parse(r.input);
      await limit('register',30);
      const email=input.body.email,encoded=await passwordHash(input.body.password);
      const userId=stableId('identity',email),orgId=stableId('organization',email),workspaceId=stableId('first-workspace',email);
      const scope:Scope={actorId:userId,organizationId:orgId,workspaceId,environment:d.settings.environment,role:'owner'};
      // Hash password input for request identity; no raw password is stored in idempotency records.
      await idempotent(store,scope,'account.register',input.key,{email,passwordHash:hash(input.body.password),businessName:input.body.businessName},async tx=>{
        requireThat(!await tx.get('users',userId),'ACCOUNT_CONFLICT','This account cannot be created.',409);
        await tx.insert('users',{_id:userId,email,passwordHash:encoded,verified:false,homeOrganizationId:orgId,createdAt:d.now().toISOString()});
        await tx.insert('organizations',{_id:orgId,name:input.body.businessName,createdAt:d.now().toISOString()});
        await tx.insert('workspaces',{_id:workspaceId,...scopeFields(scope),name:input.body.businessName,timezone:'UTC',currency:'USD',policyVersion:1,createdAt:d.now().toISOString()});
        await tx.insert('memberships',{_id:stableId(workspaceId,userId),...scopeFields(scope),userId,role:'owner',active:true,createdAt:d.now().toISOString()});
        await audit(tx,scope,'workspace.created',workspaceId);return {userId,workspaceId};
      });
      return openSession((await store.get('users',userId))!);
    }
    if(r.operation==='login') {
      const input=dto.credentials.parse(r.input);await limit('login:'+hash(input.email));
      const user=(await store.find('users',{email:input.email},{limit:1}))[0];
      const dummy='scrypt-v1$00000000000000000000000000000000$'+'0'.repeat(128);
      const matches=await passwordMatches(input.password,String(user?.passwordHash??dummy));
      requireThat(user&&matches&&!user.disabled,'AUTHENTICATION_REQUIRED','Email or password is incorrect.',401);
      requireThat(d.settings.environment==='sandbox'||user.verified,'IDENTITY_NOT_VERIFIED','Identity verification is required.',403);
      return openSession(user);
    }
    if(r.operation==='logout') {if(r.context.sessionToken)await store.remove('sessions',hash(r.context.sessionToken));return {signedOut:true};}
    const user=await identity(r.context.sessionToken);
    if(r.operation==='me') {
      const memberships=await store.find('memberships',{userId:user._id,environment:d.settings.environment,active:true},{limit:1001});
      requireThat(memberships.length<=1000,'WORKSPACE_LIMIT','Account workspace list exceeds the configured limit.',422);
      const workspaces=[];
      for(const m of memberships){const workspace=await store.get('workspaces',String(m.workspaceId));if(workspace)
        workspaces.push({...workspace,role:m.role});}
      return {user:{id:user._id,email:user.email},workspaces};
    }
    if(r.operation==='createWorkspace') {
      const input=z.object({key:dto.id,body:dto.workspaceInput}).strict().parse(r.input);
      requireThat(Intl.supportedValuesOf('timeZone').includes(input.body.timezone)||input.body.timezone==='UTC','INVALID_TIMEZONE','Use an IANA time zone.');
      const own=await store.find('memberships',{userId:user._id,organizationId:user.homeOrganizationId,role:'owner',active:true},{limit:1});
      requireThat(own.length,'POLICY_DENIED','Organization ownership is required.',403);
      const scope:Scope={organizationId:String(user.homeOrganizationId),workspaceId:'organization',environment:d.settings.environment,actorId:user._id,role:'owner'};
      return idempotent(store,scope,'workspace.create',input.key,input.body,async tx=>{
        const id=randomUUID(),specific={...scope,workspaceId:id};
        await tx.insert('workspaces',{_id:id,...scopeFields(specific),...input.body,policyVersion:1,createdAt:d.now().toISOString()});
        await tx.insert('memberships',{_id:stableId(id,user._id),...scopeFields(specific),userId:user._id,role:'owner',active:true,createdAt:d.now().toISOString()});
        await audit(tx,specific,'workspace.created',id);return {id};
      });
    }
    const input=interactiveInput.parse(r.input),scope=await context(user._id,input.workspaceId,'members:write');
    if(r.operation==='members')return page(store,'memberships',scope,{},input.cursor);
    if(r.operation==='changeMember') {
      const body=dto.memberInput.extend({active:z.boolean().default(true)}).strict().parse(input.body);
      return idempotent(store,scope,'membership.change',keyOf(input.key),body,async tx=>{
        const target=(await tx.find('users',{email:body.email},{limit:1}))[0];
        requireThat(target&&(d.settings.environment==='sandbox'||target.verified),'NOT_FOUND','A verified existing account is required.',404);
        const id=stableId(scope.workspaceId,target._id),prior=await tx.get('memberships',id);
        if(prior?.role==='owner'&&(!body.active||body.role!=='owner')) {
          const owners=await tx.find('memberships',{workspaceId:scope.workspaceId,role:'owner',active:true},{limit:2});
          requireThat(owners.length>1,'LAST_OWNER','The workspace must retain an active owner.',409);
        }
        // The workspace write serializes concurrent owner changes; it prevents last-owner write skew.
        const workspace=await owned(tx,'workspaces',scope.workspaceId,scope);
        await tx.put('workspaces',{...workspace,policyVersion:Number(workspace.policyVersion)+1});
        await tx.put('memberships',{_id:id,...scopeFields(scope),userId:target._id,role:body.role,active:body.active,createdAt:prior?.createdAt??d.now().toISOString()});
        await audit(tx,scope,'membership.changed',target._id,{role:body.role,active:body.active});return {updated:true};
      });
    }
    throw new Error('Unknown identity operation');
  };
}
