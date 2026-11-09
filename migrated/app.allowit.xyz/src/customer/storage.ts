import {migratePolicies,revisePolicy,latestVersion,type PolicyRecord,type PolicyReference,type LegacyWorkspace,type LegacyMessage,type LegacyConversation} from './policies';
import {removeEmptyItems} from './workspace-cleanup';
import {normalizePolicyName,repairPolicyNames} from './policy-names';
import {restrictionErrors,type PolicyBinding,type PolicyCompilation} from './policy-terms';
export type Attachment = {id:string; name:string; type:string; size:number; blob:Blob};
export type Message = {id:string; text:string; attachments:Attachment[]; createdAt:string; status:'draft'|'sent'; role?:'user'|'assistant'; model?:string; policyRef?:PolicyReference};
export type Conversation = {id:string; title:string; createdAt:string; messages:Message[];policyId?:string;pinned?:boolean};
export type AgentPolicy = {name:string; instructions:string; budget:number; perAction:number; reviewAbove:number; reserve:number; assets:string[]; tools:string[]; services:string; configured:boolean;network?:string;actions?:string[];recipients?:string;expiresAt?:string;expiryHours?:24|72|168;compiled?:PolicyCompilation;binding?:PolicyBinding;kind?:string};
export type LocalWorkspace = {version:2; storageRevision?:number; policies:PolicyRecord[]; defaultPolicyId?:string; conversations:Conversation[];agentModel?:string};
const solanaNetworks=new Set(['solana:devnet','solana:testnet']);
export function supportedWorkspace(value:LocalWorkspace):LocalWorkspace {
 return {...value,policies:value.policies.map(record=>{
  const p=latestVersion(record).value;
  // Preserve unsupported records as data instead of converting them into another policy.
  if(p.kind&&p.kind!=='agent')return record;
  if(solanaNetworks.has(p.network??'solana:devnet')&&p.assets.length===1&&p.assets[0]==='USDC')return record;
  return revisePolicy(record,{...p,network:solanaNetworks.has(p.network??'solana:devnet')?p.network:'solana:devnet',assets:['USDC'],configured:false,compiled:undefined});
 })};
}
export const initialPolicy:AgentPolicy = {name:'My agent',instructions:'',budget:100,perAction:10,reviewAbove:5,reserve:0,assets:['USDC'],tools:['Read attached files','Search the web'],services:'',configured:false,network:'solana:devnet'};
export function emptyWorkspace():LocalWorkspace{return {version:2,policies:[],conversations:[]};}
export function validatePolicy(p:AgentPolicy):string|null {
 if(p.kind&&p.kind!=='agent')return 'This policy type is not available.';
 if(!solanaNetworks.has(p.network??'solana:devnet'))return 'Choose a Solana network for this policy.';
 if(!p.name.trim()||p.name.length>80)return 'Give your agent a name of 1–80 characters.';
 if(p.instructions.length>8000)return 'Keep instructions under 8,000 characters.';
 if([p.budget,p.perAction,p.reviewAbove,p.reserve].some(v=>!Number.isFinite(v)||v<0||v>1_000_000||Number(v.toFixed(6))!==v))return 'Use amounts from 0 to 1,000,000 USDC, with at most six decimal places.';
 if(p.budget<=0||p.perAction<=0||p.perAction>p.budget)return 'The per-action limit must be positive and fit within the total budget.';
 if(p.reviewAbove>p.perAction)return 'The approval threshold cannot exceed the per-action limit.';
 if(p.assets.length!==1||p.assets[0]!=='USDC')return 'The current policy runtime supports only USDC. Remove unsupported assets before saving.';
 const restrictionError=Object.values(restrictionErrors(p))[0];
 if(restrictionError)return restrictionError;
 if(p.expiresAt&&!Number.isFinite(new Date(p.expiresAt).getTime()))return 'Choose a valid policy expiry.';
 return null;
}
export function checkFiles(files:File[],existing:Attachment[]):string|null {
 if(files.length+existing.length>5)return 'Attach up to 5 files per message.';
 if(files.some(f=>f.size>10*1024*1024))return 'Each file must be 10 MB or smaller.';
 if(files.reduce((sum,f)=>sum+f.size,0)+existing.reduce((sum,f)=>sum+f.size,0)>25*1024*1024)return 'Keep attachments under 25 MB per message.';
 return null;
}
type StoredAttachment=Omit<Attachment,'blob'>&{bytes:ArrayBuffer;blob?:never};
type StoredMessage=Omit<Message,'attachments'>&{attachments:Array<Attachment|StoredAttachment>};
type StoredWorkspace=Omit<LocalWorkspace,'conversations'|'policies'>&{conversations:Array<Omit<Conversation,'messages'>&{messages:StoredMessage[]}>;policies:Array<Omit<PolicyRecord,'notes'>&{notes:StoredMessage[]}>};
type StoredLegacyWorkspace=Omit<LegacyWorkspace,'conversations'>&{conversations:Array<Omit<LegacyConversation,'messages'>&{messages:Array<Omit<LegacyMessage,'attachments'>&{attachments:Array<Attachment|StoredAttachment>}>}>};
// ArrayBuffers persist on WebKit builds that abort IndexedDB writes containing Blobs.
// Cache immutable bytes so changing a model or message does not reread every file.
const attachmentBytes=new WeakMap<Blob,Promise<ArrayBuffer>>();
async function storeAttachments(value:LocalWorkspace):Promise<StoredWorkspace>{
 const message=async(message:Message):Promise<StoredMessage>=>({...message,attachments:await Promise.all(message.attachments.map(async({blob,...metadata})=>{
  let bytes=attachmentBytes.get(blob);if(!bytes){bytes=blob.arrayBuffer();attachmentBytes.set(blob,bytes);}
  return {...metadata,bytes:await bytes};
 }))});
 return {...value,conversations:await Promise.all(value.conversations.map(async c=>({...c,messages:await Promise.all(c.messages.map(message))}))),policies:await Promise.all(value.policies.map(async p=>({...p,notes:await Promise.all(p.notes.map(message))})))};
}
function restoreMessage<T extends StoredMessage>(message:T):Omit<T,'attachments'>&{attachments:Attachment[]}{
 return {...message,attachments:message.attachments.map(attachment=>{
  if(attachment.blob instanceof Blob)return attachment as Attachment; // Existing device data.
  const {bytes,...metadata}=attachment as StoredAttachment;
  if(!(bytes instanceof ArrayBuffer))throw new Error('A saved attachment could not be read.');
  const blob=new Blob([bytes],{type:metadata.type});attachmentBytes.set(blob,Promise.resolve(bytes));
  return {...metadata,blob};
 })};
}
function restoreAttachments(value:StoredWorkspace|StoredLegacyWorkspace):LocalWorkspace{
 if(value.version===1)return {...migratePolicies({...value,conversations:value.conversations.map(c=>({...c,messages:c.messages.map(restoreMessage)}))}),storageRevision:(value as StoredLegacyWorkspace&{storageRevision?:number}).storageRevision};
 return {...value,conversations:value.conversations.map(c=>({...c,messages:c.messages.map(restoreMessage)})),policies:value.policies.map(p=>({...p,notes:p.notes.map(restoreMessage)}))};
}
function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
 const req=indexedDB.open('allowit-customer',1);
 req.onupgradeneeded=()=>req.result.createObjectStore('workspaces');
 req.onerror=()=>reject(new Error('Device storage is unavailable. Enable browser storage and reload.'));
 req.onblocked=()=>reject(new Error('Close other Allowit tabs and reload to update device storage.'));
 req.onsuccess=()=>resolve(req.result);
});}
export async function loadWorkspace(key:string,onCleanup?:(chats:number,policies:number)=>void):Promise<LocalWorkspace>{
 const db=await database();
 try{return await new Promise((resolve,reject)=>{
  // This is a one-time local maintenance request, never a production data migration.
  const cleanup=import.meta.env.DEV&&!key.includes(':before-')&&!key.startsWith('maintenance:');
  const repairNames=!key.startsWith('backup:')&&!key.startsWith('maintenance:');
  const tx=db.transaction('workspaces',cleanup||repairNames?'readwrite':'readonly');
  const store=tx.objectStore('workspaces');
  const markerKey=`maintenance:empty-items-20260929:${key}`;
  const marker=cleanup?store.get(markerKey):undefined;
  const namesBackupKey=`backup:before-unique-policy-names:${key}`;
  const namesBackup=repairNames?store.get(namesBackupKey):undefined;
  const supportBackupKey=`backup:before-supported-policy-settings:${key}`;
  const supportBackup=repairNames?store.get(supportBackupKey):undefined;
  const req=store.get(key);
  let result:LocalWorkspace,removedChats=0,removedPolicies=0;
  tx.onerror=tx.onabort=()=>reject(new Error('Your saved workspace could not be read. Reload to retry.'));
  req.onsuccess=()=>{
   let v=req.result as StoredWorkspace|StoredLegacyWorkspace|undefined;
   const originalRevision=v?.version===2?(v.storageRevision??0):0;let changed=false;
   if(v&&(!Array.isArray(v.conversations)||(v.version===1?!v.policy:v.version!==2||!Array.isArray(v.policies)||v.policies.some(p=>!p.versions?.length||!Array.isArray(p.notes))))){reject(new Error('This saved workspace has an unsupported format.'));tx.abort();return;}
   try{
    if(repairNames&&v?.version===2){
     const repaired=repairPolicyNames(v);
     if(repaired.changed){
      if(!namesBackup?.result)store.put(v,namesBackupKey);
      v=repaired.workspace;changed=true;store.put(v,key);
     }
    }
    const restored=v?restoreAttachments(v):emptyWorkspace();
    result=supportedWorkspace(restored);
    if(repairNames&&v?.version===2&&result.policies.some((policy,index)=>policy.versions.length!==restored.policies[index].versions.length)){
     if(!supportBackup?.result)store.put(v,supportBackupKey);
     v={...v,policies:v.policies.map((policy,index)=>({...policy,versions:result.policies[index].versions}))};
     changed=true;store.put(v,key);
    }
    if(repairNames&&v?.version===1)result=repairPolicyNames(result).workspace;
    if(cleanup&&!marker?.result&&(!v||v.version===2)){
     const cleaned=removeEmptyItems(result,initialPolicy);
     removedChats=cleaned.removedChats;removedPolicies=cleaned.removedPolicies;
     if(v?.version===2&&(removedChats||removedPolicies)){
      // Backup and removal commit together. Preserve attachment bytes without re-encoding.
      store.put(v,`backup:before-empty-cleanup-20260929:${key}`);
      const chatIds=new Set(cleaned.workspace.conversations.map(c=>c.id));
      const policyIds=new Set(cleaned.workspace.policies.map(p=>p.id));
      v={...v,conversations:v.conversations.filter(c=>chatIds.has(c.id)),policies:v.policies.filter(p=>policyIds.has(p.id)),defaultPolicyId:cleaned.workspace.defaultPolicyId};
      changed=true;store.put(v,key);
      result=cleaned.workspace;
     }
     store.put({completedAt:new Date().toISOString(),removedChats,removedPolicies},markerKey);
    }
    if(changed&&v?.version===2){
     if(!Number.isSafeInteger(originalRevision)||originalRevision<0||!Number.isSafeInteger(originalRevision+1))throw new Error('The saved workspace revision is invalid. Export your chats before continuing.');
     // Maintenance is a durable writer too. Its single atomic revision bump
     // stops an older tab from restoring state from before these repairs.
     v={...v,storageRevision:originalRevision+1};result={...result,storageRevision:originalRevision+1};store.put(v,key);
    }
   }catch(error){reject(error);tx.abort();}
  };
  tx.oncomplete=()=>{if(removedChats||removedPolicies)onCleanup?.(removedChats,removedPolicies);resolve(result);};
 });}finally{db.close();}
}
export class WorkspaceConflictError extends Error {
 constructor(){super("Another tab saved changes to this workspace. Your draft is kept. Review the latest changes and retry.");this.name="WorkspaceConflictError";}
}
// Persist the exact registration before contacting the server. A small, separate
// entry survives failure of the much larger workspace/attachment write.
export type PolicyRecovery={token:string;version:number;value:AgentPolicy;previous?:PolicyBinding};
const recoveryKey=(owner:string,id:string)=>`pending-policy:${JSON.stringify([owner,id])}`;
export async function loadPolicyRecovery(owner:string,id:string):Promise<PolicyRecovery|undefined>{
 const db=await database();
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction('workspaces','readonly'),request=tx.objectStore('workspaces').get(recoveryKey(owner,id));
  tx.oncomplete=()=>resolve(request.result);tx.onerror=tx.onabort=()=>reject(new Error('The saved policy recovery could not be read. Retry before continuing.'));
 });}finally{db.close();}
}
export async function preparePolicyRecovery(owner:string,id:string,workspace:LocalWorkspace,value:AgentPolicy):Promise<PolicyRecovery>{
 const record=workspace.policies.find(p=>p.id===id);
 if(!record)throw new WorkspaceConflictError();
 const current=latestVersion(record),entry:PolicyRecovery={token:crypto.randomUUID(),version:current.version+1,value:structuredClone(value),previous:current.value.binding};
 const db=await database();
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction('workspaces','readwrite'),store=tx.objectStore('workspaces');
  const saved=store.get(owner),pending=store.get(recoveryKey(owner,id));let failure:Error|undefined;
  pending.onsuccess=()=>{
   if(pending.result||(saved.result?.storageRevision??0)!==(workspace.storageRevision??0)){failure=new WorkspaceConflictError();tx.abort();return;}
   const actual=saved.result?.policies?.find((p:PolicyRecord)=>p.id===id);
   if(!actual||latestVersion(actual).version!==current.version){failure=new WorkspaceConflictError();tx.abort();return;}
   store.put(entry,recoveryKey(owner,id));
  };
  tx.oncomplete=()=>resolve(entry);tx.onerror=tx.onabort=()=>reject(failure??new Error('Could not save policy recovery on this device. The server policy was not changed. Free storage and retry.'));
 });}finally{db.close();}
}
export async function clearPolicyRecovery(owner:string,id:string,token:string):Promise<void>{
 const db=await database();
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction('workspaces','readwrite'),store=tx.objectStore('workspaces'),request=store.get(recoveryKey(owner,id));
  request.onsuccess=()=>{if(request.result?.token===token)store.delete(recoveryKey(owner,id));};
  tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(new Error('The recovered policy reference could not be cleared. Retry before continuing.'));
 });}finally{db.close();}
}
export async function saveWorkspace(key:string,value:LocalWorkspace):Promise<LocalWorkspace>{
 const names=new Set<string>();
 for(const policy of value.policies){
  const name=normalizePolicyName(latestVersion(policy).value.name);
  if(names.has(name))throw new Error('A policy with this name already exists. Choose a different name.');
  names.add(name);
 }
 const stored=await storeAttachments(value);
 const db=await database();
 try{return await new Promise<LocalWorkspace>((resolve,reject)=>{
  const tx=db.transaction('workspaces','readwrite');
  const store=tx.objectStore('workspaces');
  const previous=store.get(key);
  let failure:Error|undefined,revision=0;
  previous.onsuccess=()=>{
   const expected=value.storageRevision??0,current=previous.result?.storageRevision??0;
   if(!Number.isSafeInteger(expected)||expected<0||!Number.isSafeInteger(current)||current<0||current!==expected){failure=new WorkspaceConflictError();tx.abort();return;}
   revision=current+1;
   if(!Number.isSafeInteger(revision)){failure=new Error('The saved workspace revision is invalid. Export your chats before continuing.');tx.abort();return;}
   if(previous.result?.version===1)store.put(previous.result,`backup:before-policy-registry:${key}`);
   store.put({...stored,storageRevision:revision},key);
  };
  tx.oncomplete=()=>resolve({...value,storageRevision:revision});
  tx.onerror=tx.onabort=()=>reject(failure??new Error('Could not save on this device. Storage may be full; remove older files or export your chats. Your current draft is still here.'));
 });}finally{db.close();}
}
