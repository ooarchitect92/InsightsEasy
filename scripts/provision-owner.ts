import {randomUUID} from 'node:crypto';
import {stableId,requireThat,type Scope} from '../packages/domain/core.ts';
import {passwordHash} from '../packages/runtime/crypto.ts';
import {credentials,name} from '../packages/contracts/index.ts';
import {MongoStore,scopeFields,audit} from '../services/shared/store.ts';
const [email,businessName,evidenceReference]=process.argv.slice(2);
requireThat(email&&businessName&&evidenceReference,'USAGE','Provide email, business name and actual verification evidence reference. Pipe the password via stdin.',400);
requireThat(process.env.OPERATOR_VERIFICATION_APPROVED==='true','APPROVAL_REQUIRED','Verified provisioning needs an approved operator decision.',403);
let password='';for await(const chunk of process.stdin){password+=String(chunk);requireThat(password.length<=512,'INVALID_PASSWORD','Password input exceeds limit.',400);}
const input=credentials.parse({email,password:password.trimEnd()});name.parse(businessName);
const environment=process.env.APP_ENV??'sandbox';requireThat(['sandbox','production'].includes(environment),'CONFIGURATION','Unknown environment.',500);
const store=new MongoStore('identity',process.env.MONGO_URL!,process.env.MONGO_DATABASE??'insightseasy_identity');await store.initialize();
try{const userId=stableId('identity',input.email),orgId=stableId('organization',input.email),workspaceId=randomUUID(),encoded=await passwordHash(input.password);
 const scope:Scope={organizationId:orgId,workspaceId,environment,actorId:'approved-operator',role:'owner'};
 await store.atomic(async tx=>{requireThat(!await tx.get('users',userId),'ALREADY_EXISTS','Do not overwrite an existing identity.',409);
  await tx.insert('users',{_id:userId,email:input.email,passwordHash:encoded,verified:true,verificationEvidence:evidenceReference,verifiedAt:new Date().toISOString(),homeOrganizationId:orgId});
  await tx.insert('organizations',{_id:orgId,name:businessName});await tx.insert('workspaces',{_id:workspaceId,...scopeFields(scope),name:businessName,timezone:'UTC',currency:'USD',policyVersion:1});
  await tx.insert('memberships',{_id:stableId(workspaceId,userId),...scopeFields(scope),userId,role:'owner',active:true});await audit(tx,scope,'identity.operator_provisioned',userId,{evidenceReference});});
 console.log(JSON.stringify({userId,workspaceId,environment,provisioned:true}));
}finally{await store.close();}
