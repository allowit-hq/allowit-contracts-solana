import type {AgentPolicy} from './storage';
import type {PolicyRecord,PolicyReference} from './policies';

export const normalizePolicyName=(name:string)=>name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();
export const policyNameError=(name:string,otherNames:readonly string[])=>otherNames.some(other=>normalizePolicyName(other)===normalizePolicyName(name))?'A policy with this name already exists. Choose a different name.':null;
export function uniquePolicyName(base:string,names:readonly string[]){
 const used=new Set(names.map(normalizePolicyName));
 const clean=base.trim().replace(/\s+/gu,' ').slice(0,80)||'Untitled policy';
 if(!used.has(normalizePolicyName(clean)))return clean;
 for(let i=2;;i++){
  const suffix=` (${i})`,candidate=clean.slice(0,80-suffix.length)+suffix;
  if(!used.has(normalizePolicyName(candidate)))return candidate;
 }
}

type ReferenceMessage={policyRef?:PolicyReference};
type NamedPolicy=Omit<PolicyRecord,'notes'>&{notes:ReferenceMessage[]};
type NamedWorkspace={policies:NamedPolicy[];defaultPolicyId?:string;conversations:{policyId?:string;messages:ReferenceMessage[]}[]};
const valueKey=(p:AgentPolicy)=>[normalizePolicyName(p.name),p.instructions,p.budget,p.perAction,p.reviewAbove,p.reserve,[...p.assets].sort(),[...p.tools].sort(),p.services,p.configured,p.network??'solana:devnet',p.actions,p.recipients,p.expiresAt,p.binding];

/** Works on both live and stored workspaces; attachment bytes remain untouched. */
export function repairPolicyNames<T extends NamedWorkspace>(source:T,now=new Date().toISOString()){
 const aliases=new Map<string,string>(),equivalent=new Map<string,string>();
 const ordered=[...source.policies].sort((a,b)=>Number(b.id===source.defaultPolicyId)-Number(a.id===source.defaultPolicyId));
 for(const policy of ordered){
  if(policy.notes.length)continue;
  const signature=JSON.stringify([policy.parentPolicyId,policy.versions.map(v=>[v.version,valueKey(v.value)])]);
  const existing=equivalent.get(signature);
  if(existing)aliases.set(policy.id,existing);else equivalent.set(signature,policy.id);
 }
 const resolve=(id:string|undefined)=>id===undefined?undefined:aliases.get(id)??id;
 const message=<M extends ReferenceMessage>(m:M):M=>m.policyRef&&aliases.has(m.policyRef.policyId)?{...m,policyRef:{...m.policyRef,policyId:resolve(m.policyRef.policyId)!}}:m;
 const reserved=source.policies.map(p=>p.versions.at(-1)!.value.name),seen=new Set<string>();
 let renamed=0;
 const policies=source.policies.filter(p=>!aliases.has(p.id)).map(policy=>{
  const latest=policy.versions.at(-1)!;
  let versions=policy.versions;
  if(seen.has(normalizePolicyName(latest.value.name))){
   const name=uniquePolicyName(latest.value.name,reserved);reserved.push(name);
   versions=[...versions,{version:latest.version+1,createdAt:now,value:{...latest.value,name}}];renamed++;
  }
  seen.add(normalizePolicyName(versions.at(-1)!.value.name));
  return {...policy,versions,parentPolicyId:resolve(policy.parentPolicyId),notes:policy.notes.map(message)};
 });
 const changed=aliases.size>0||renamed>0;
 const workspace:T=changed?{...source,policies,defaultPolicyId:resolve(source.defaultPolicyId),conversations:source.conversations.map(c=>({...c,policyId:resolve(c.policyId),messages:c.messages.map(message)}))}:source;
 return {workspace,changed,merged:aliases.size,renamed};
}
