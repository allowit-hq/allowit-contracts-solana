import type {AgentPolicy,Conversation,LocalWorkspace,Message} from './storage';

export type PolicyReference={policyId:string;version:number};
export type PolicyVersion={version:number;createdAt:string;value:AgentPolicy};
export type PolicyRecord={id:string;createdAt:string;versions:PolicyVersion[];notes:Message[];sourceConversationId?:string;parentPolicyId?:string};
export const latestVersion=(policy:PolicyRecord)=>policy.versions[policy.versions.length-1];
export const findPolicy=(workspace:LocalWorkspace,id?:string|null)=>workspace.policies.find(policy=>policy.id===id);
export function resolvePolicy(workspace:LocalWorkspace,reference:PolicyReference){
 return findPolicy(workspace,reference.policyId)?.versions.find(version=>version.version===reference.version);
}
export function createPolicy(value:AgentPolicy,id:string=crypto.randomUUID(),now=new Date().toISOString()):PolicyRecord{
 return {id,createdAt:now,versions:[{version:1,createdAt:now,value:structuredClone(value)}],notes:[]};
}
export function revisePolicy(record:PolicyRecord,value:AgentPolicy,now=new Date().toISOString()):PolicyRecord{
 return {...record,versions:[...record.versions,{version:latestVersion(record).version+1,createdAt:now,value:structuredClone(value)}]};
}

export function deletePolicyFromWorkspace(workspace:LocalWorkspace,id:string):LocalWorkspace{
 return {...workspace,
  policies:workspace.policies.filter(p=>p.id!==id).map(p=>p.parentPolicyId===id?{...p,parentPolicyId:undefined}:p),
  defaultPolicyId:workspace.defaultPolicyId===id?undefined:workspace.defaultPolicyId,
  // A different policy must be chosen explicitly before another message is sent.
  conversations:workspace.conversations.map(c=>c.policyId===id?{...c,policyId:undefined}:c),
 };
}

export type LegacyMessage=Omit<Message,'policyRef'>&{policy:AgentPolicy};
export type LegacyConversation=Omit<Conversation,'policyId'|'messages'>&{messages:LegacyMessage[];kind?:'policy'|'agent';policy?:AgentPolicy;revision?:number;parentId?:string};
export type LegacyWorkspace={version:1;policy:AgentPolicy;conversations:LegacyConversation[];agentModel?:string};
// Stable field order prevents object insertion order from creating duplicate records.
function signature(p:AgentPolicy){return p.kind&&p.kind!=='agent'?JSON.stringify(p):JSON.stringify([p.name,p.instructions,p.budget,p.perAction,p.reviewAbove,p.reserve,p.assets,p.tools,p.services,p.configured,p.network??'solana:devnet',p.actions,p.recipients,p.expiresAt,p.binding,p.kind]);}

/** Move old per-chat state into the registry. Never discard notes, files or snapshots. */
export function migratePolicies(old:LegacyWorkspace,now=new Date().toISOString()):LocalWorkspace{
 const policies:PolicyRecord[]=[];
 const conversations:Conversation[]=[];
 const currentBySignature=new Map<string,PolicyRecord>();
 const makeRecord=(id:string,value:AgentPolicy,messages:LegacyMessage[],createdAt:string)=>{
  const record:PolicyRecord={id,createdAt,versions:[],notes:[]};
  const remember=(snapshot:AgentPolicy,at:string)=>{
   const previous=record.versions.at(-1);
   if(!previous||signature(previous.value)!==signature(snapshot))record.versions.push({version:record.versions.length+1,createdAt:at,value:structuredClone(snapshot)});
   return {policyId:id,version:latestVersion(record).version};
  };
  const mapped=messages.map(({policy,...message})=>({...message,policyRef:remember(policy??value,message.createdAt)}));
  remember(value,now);
  policies.push(record);
  currentBySignature.set(signature(value),record);
  return {record,mapped};
 };
 // Policy conversations become notes under their policy, not agent chats.
 for(const chat of old.conversations.filter(c=>c.kind==='policy')){
  const {record,mapped}=makeRecord(`policy-${chat.id}`,chat.policy??old.policy,chat.messages,chat.createdAt);
  record.notes=mapped;
  record.sourceConversationId=chat.id;
  if(chat.parentId)record.parentPolicyId=`policy-${chat.parentId}`;
 }
 let defaultRecord=currentBySignature.get(signature(old.policy));
 if(!defaultRecord)defaultRecord=makeRecord('policy-default',old.policy,[],now).record;
 for(const chat of old.conversations.filter(c=>c.kind!=='policy')){
  const value=chat.policy??old.policy;
  let record=currentBySignature.get(signature(value));
  let messages:Message[];
  if(!record){const made=makeRecord(`policy-${chat.id}`,value,chat.messages,chat.createdAt);record=made.record;messages=made.mapped;}
  else{
   // Add historical snapshots before the current revision so current state never rolls back.
   messages=chat.messages.map(({policy,...message})=>{
    const snapshot=policy??value;
    let revision=record!.versions.find(v=>signature(v.value)===signature(snapshot));
    if(!revision){
     record!.versions.push({version:latestVersion(record!).version+1,createdAt:message.createdAt,value:structuredClone(snapshot)});
     revision=latestVersion(record!);
     record!.versions.push({version:revision.version+1,createdAt:now,value:structuredClone(value)});
    }
    return {...message,policyRef:{policyId:record!.id,version:revision.version}};
   });
  }
  conversations.push({id:chat.id,title:chat.title,createdAt:chat.createdAt,messages,policyId:record.id});
 }
 return {version:2,policies,defaultPolicyId:defaultRecord.id,conversations,agentModel:old.agentModel};
}
