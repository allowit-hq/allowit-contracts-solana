import type {AgentPolicy,LocalWorkspace} from './storage';

const signature=(p:AgentPolicy)=>JSON.stringify([p.name,p.instructions,p.budget,p.perAction,p.reviewAbove,p.reserve,[...p.assets].sort(),[...p.tools].sort(),p.services,p.network??'solana:devnet',p.actions,p.recipients,p.expiresAt,p.binding]);

/** Owner-requested cleanup: no messages, custom settings or historical references are discarded. */
export function removeEmptyItems(workspace:LocalWorkspace,defaults:AgentPolicy){
 const conversations=workspace.conversations.filter(chat=>chat.messages.length>0);
 const referenced=new Set<string>();
 for(const chat of conversations){
  if(chat.policyId)referenced.add(chat.policyId);
  for(const message of chat.messages)if(message.policyRef)referenced.add(message.policyRef.policyId);
 }
 for(const policy of workspace.policies){
  if(policy.parentPolicyId)referenced.add(policy.parentPolicyId);
  for(const note of policy.notes)if(note.policyRef)referenced.add(note.policyRef.policyId);
 }
 const empty=workspace.policies.filter(policy=>!policy.notes.length&&policy.versions.every(version=>signature(version.value)===signature(defaults)));
 // Prefer an in-use policy, then the default, then a configured copy as the survivor.
 const keep=empty.find(p=>referenced.has(p.id))??empty.find(p=>p.id===workspace.defaultPolicyId)
  ??empty.find(p=>p.versions.at(-1)?.value.configured)??empty[0];
 const removable=new Set(empty.filter(p=>p!==keep&&!referenced.has(p.id)).map(p=>p.id));
 const policies=workspace.policies.filter(p=>!removable.has(p.id));
 const cleaned={...workspace,conversations,policies,defaultPolicyId:workspace.defaultPolicyId&&removable.has(workspace.defaultPolicyId)?keep?.id:workspace.defaultPolicyId};
 return {workspace:cleaned,removedChats:workspace.conversations.length-conversations.length,removedPolicies:removable.size};
}
