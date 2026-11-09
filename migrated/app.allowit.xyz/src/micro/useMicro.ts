import {isStellarNetwork} from '@allowit/engine/stellar/runtime';
import {STELLAR_NETWORKS} from '@allowit/engine/stellar/stellar-wallet';
import {checkedRecipientRevision, recipientTokenAccount} from '../native-vault/native-recipient';
import {parseOwnerRuns} from '../runtime/run-contract';
import {NETWORKS,availableNetworks,isTempoNetwork,savedNetwork,type Network,type NetworkConfig} from '../wallet/networks';
import {onPref,writePref} from '../shared-prefs';
import {useEffect,useRef,useState} from 'react';
import useApp from '../useApp';
import useLocalSession from '../useLocalSession';
import {request,ApiError} from '../api';
import {signAllocation,type AllocationIntent} from '../wallet/allocation';
import {signTransfer,type TransferIntent} from '../wallet/transfer';
import {WalletOutcomeUnknown} from '../wallet/wallet';
import type {MicroController,MicroPolicy,PolicyRequest,PolicyRevocation,TxProgress} from './micro-contracts';
import {checkedChoice,checkGeneratedAllowlist,generateBody,handoffReady,isStellarPolicy,hasDelegatedAuthority,delegatedNetworks,isAllowanceWallet,isAuthorization,isOwnerWallet,isContractWallet,localLegacyRuntime,parseRuntimeConfig,requiresDelegatedWallet,revocable,supports,type RuntimeConfig} from '../runtime/runtime';
import useContractSetup from '../runtime/useContractSetup';
import useOwnerAuthorization from '../runtime/useOwnerAuthorization';
import {revocationResolved,revokePolicyBatch} from '../policy/revoke-policy-batch';
import {simulatesAnswers} from '../request-status';
import {allocationKey,createTxRecovery,transferKey,UNKNOWN_OUTCOME} from '../wallet/tx-recovery';
import {browserServiceApprovals} from '../runtime/service-approvals';
import {policyAllowlist} from '../runtime/runtime';
/** How long one check keeps asking for finality before it stops and leaves the transaction pending. */
const FINALIZE_WINDOW_MS=60000;
type Result={policies:MicroPolicy[];selectedId?:string;intent?:AllocationIntent;harnessPrompt?:string;skill?:string;transferIntent?:TransferIntent};
/** The workspace for one chain. A Tempo workspace drafts policies with the same generator and funds them in Tempo vaults. */
export default function useMicro(chain:'solana'|'tempo'|'stellar'='solana'):MicroController{
 const tempo=chain==='tempo',stellar=chain==='stellar';
 const [network,changeNetwork]=useState<Network>(()=>tempo?'tempo:testnet':stellar?'stellar:testnet':savedNetwork());const [networks,setNetworks]=useState<NetworkConfig[]>(()=>tempo?[{id:'tempo:testnet',label:'Testnet',mint:'',allocationEnabled:false}]:stellar?[{id:'stellar:testnet',label:'Testnet',mint:'',allocationEnabled:false}]:NETWORKS);
 const networkOptionsRef=useRef<NetworkConfig[]>(availableNetworks(NETWORKS));
 // Normalize old preferences on entry and across tabs. Existing policies retain their own network configuration.
 useEffect(()=>{
  if(tempo||stellar)return;
  const restore=(value:string|null)=>{const options=networkOptionsRef.current;const n=options.find(option=>option.id===value)?.id??savedNetwork();if(options.length===1&&value!==n)writePref('allowit.network',n);if(!lock.current)changeNetwork(n);};
  restore(null);return onPref('allowit.network',restore);
 },[]);
 useEffect(()=>{
  if(stellar){request<{network?:unknown}>('native/config?network=stellar:testnet').then(v=>{if(isStellarNetwork(v.network)){const id=v.network;changeNetwork(id);setNetworks([{id,label:STELLAR_NETWORKS[id].label,mint:'',allocationEnabled:false}]);}}).catch(()=>setError('Stellar settings could not be loaded. Reload the page to retry.'));return;}
  if(tempo){request<{network?:unknown}>('tempo/config').then(v=>{if(isTempoNetwork(String(v.network))){const id=v.network as Network;changeNetwork(id);setNetworks([{id,label:id==='tempo:localnet'?'Localnet':'Testnet',mint:'',allocationEnabled:false}]);}}).catch(()=>setError('Tempo settings could not be loaded. Reload the page to retry.'));return;}
  request<{networks:NetworkConfig[]}>('networks').then(v=>setNetworks(v.networks)).catch(()=>setError('Network settings could not be loaded. Reload the page to retry.'));
 },[]);
 // The local legacy fixture without the route (404) keeps generation outside the public delegated networks. Hosted builds require the registry. Local dev's
 // anonymous simulation has no wallet runtime and never asks. Any other failure, including a malformed registry,
 // blocks new policies until it loads; no wallet is chosen from a profile name in its place.
 const [runtimeConfig,setRuntimeConfig]=useState<{owner:string;network:Network;value:RuntimeConfig|'unavailable';failed?:boolean}|null>(null);
 const appAuth=useApp(),localAuth=useLocalSession(network==='local:dev');
 // Each chain shows only its own session; a Solana session never opens the Tempo workspace or the reverse.
 const sessionChain=appAuth.session?.network==='tempo'?'tempo':appAuth.session?.network==='stellar'?'stellar':'solana';
 const walletAuth=appAuth.session&&sessionChain!==chain?{...appAuth,session:null}:appAuth;
 const auth=network==='local:dev'?{...walletAuth,...localAuth,wallets:[]}:walletAuth;const api=<T,>(path:string,body?:unknown)=>request<T>(network==='local:dev'?`local/${path}`:path,body);const owner=auth.session?.address??'';const ownerRef=useRef(owner);ownerRef.current=owner;
 // The registry requires a wallet session. Never retain another owner's response.
 useEffect(()=>{setRuntimeConfig(null);if(network==='local:dev'||tempo){setRuntimeConfig({owner,network,value:'unavailable'});return;}if(auth.loading||!owner)return;let live=true;request<unknown>(`micro/runtime?network=${encodeURIComponent(network)}`).then(v=>{if(live)setRuntimeConfig({owner,network,value:parseRuntimeConfig(v)});}).catch(e=>{if(live)setRuntimeConfig({owner,network,value:'unavailable',...(e instanceof ApiError&&e.status===404&&!requiresDelegatedWallet(network)&&localLegacyRuntime(import.meta.env.DEV,location.hostname)?{}:{failed:true})});});return()=>{live=false;};},[network,owner,auth.loading]);
 const [data,setData]=useState<{owner:string;policies:MicroPolicy[]}>({owner:'',policies:[]});const [selectedId,setSelectedId]=useState<string|null>(null);const [loading,setLoading]=useState(false);const [busy,setBusy]=useState<string|null>(null);const [error,setError]=useState<string|null>(null);const [errorCode,setErrorCode]=useState('');const [renameError,setRenameError]=useState<string|null>(null);const [handoff,setHandoff]=useState<{id:string;text:string;skill:string}|null>(null);const lock=useRef(false),mounted=useRef(true),responseVersion=useRef(0);
 const policies=data.owner===owner?data.policies:[];const selected=policies.find(p=>p.id===selectedId)??null;
 const [revocation,setRevocation]=useState<PolicyRevocation|null>(null);
 const revocationScope=useRef({owner,generation:0});
 if(revocationScope.current.owner!==owner)revocationScope.current={owner,generation:revocationScope.current.generation+1};
 useEffect(()=>{setRevocation(null);},[owner]);
 const current=(o:string)=>mounted.current&&ownerRef.current===o;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 const apply=(v:Result,o:string)=>{if(!current(o))return;setData({owner:o,policies:v.policies});if(v.selectedId)setSelectedId(v.selectedId);};
 async function load(o:string){const version=++responseVersion.current;const r=await api<Result>('micro/policies');if(version===responseVersion.current)apply(r,o);void loadRuns(o).catch(()=>{});}
 // Owner-session runs for the selected policy. A server without the route keeps the policy's own request list.
 const [runs,setRuns]=useState<{owner:string;policyId:string;requests:PolicyRequest[]}|null>(null);
 const selectedRef=useRef<string|null>(null);selectedRef.current=selectedId;
 // A 404 for a policy's runs means the server keeps them only in the policy itself; it is not asked again.
 const runsUnsupported=useRef(new Set<string>());
 async function loadRuns(o:string){
  const policyId=selectedRef.current;if(!policyId||network==='local:dev'||runsUnsupported.current.has(policyId))return;
  let v:{requests?:unknown};
  try{v=await api<{requests?:unknown}>(`micro/runs?id=${encodeURIComponent(policyId)}`);}
  catch(e){if(e instanceof ApiError&&e.status===404){runsUnsupported.current.add(policyId);if(current(o)&&selectedRef.current===policyId)setRuns(null);}throw e;}
  if(!current(o)||selectedRef.current!==policyId)return;
  // Each run must belong to this policy; anything else is dropped rather than shown under it.
  try{const requests=parseOwnerRuns(v.requests,policyId);setRuns({owner:o,policyId,requests});}
  catch(e){setError('The policy run list could not be read. Saved payment and setup proofs remain unchanged.');throw e;}
 }
 useEffect(()=>{setRuns(null);if(owner&&selectedId)void loadRuns(owner).catch(()=>{});},[owner,selectedId]);
 useEffect(()=>{if(!owner)return;const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!lock.current)void load(owner).catch(()=>{});},5000);return()=>clearInterval(timer);},[owner]);
 useEffect(()=>{let active=true;setSelectedId(null);setHandoff(null);setError(null);setRenameError(null);if(!owner){setData({owner:'',policies:[]});setLoading(false);return;}setLoading(true);load(owner).catch(e=>active&&current(owner)&&setError(e.message)).finally(()=>active&&current(owner)&&setLoading(false));return()=>{active=false;};},[owner]);
 async function run(name:string,fn:(o:string)=>Promise<void>):Promise<boolean>{if(lock.current||!owner)return false;lock.current=true;const o=owner;setBusy(name);setError(null);setErrorCode('');setRenameError(null);try{await fn(o);return current(o);}catch(e){if(current(o)){const message=e instanceof Error?e.message:'The request failed. Please retry.';if(name==='rename')setRenameError(message);else{setError(message);setErrorCode(e instanceof ApiError?e.code:'');}if(e instanceof ApiError&&e.status===401)void auth.refresh();}return false;}finally{lock.current=false;if(mounted.current)setBusy(null);}}
 async function mutate(path:string,body:unknown,o:string){const version=++responseVersion.current;const v=await api<Result>(path,body);if(version===responseVersion.current)apply(v,o);return v;}
 const identity=()=>{if(!selected)throw new Error('Select a policy first.');return {id:selected.id,revision:selected.revision};};
 // A wallet that returns has already broadcast the transaction. From then on the action keeps its signature and
 // identity: confirmation is retried with that signature and never signed again. No HTTP status and no elapsed time
 // is treated as proof that it failed; only the gateway positively resolving the same transaction clears it.
 const recoveryMemory=useRef(new Map<string,string>());const recovery=useRef(createTxRecovery(recoveryMemory.current)).current;
 const [tx,setTx]=useState<{owner:string;items:Record<string,TxProgress>}>({owner:'',items:{}});
 const track=(o:string,key:string,next:TxProgress|null)=>{if(!current(o))return;setTx(prev=>{const items=prev.owner===o?{...prev.items}:{};if(next)items[key]=next;else delete items[key];return {owner:o,items};});};
 /** Confirms one broadcast transaction. Returns true once the gateway records it; false when the check ends still pending. */
 async function finalize(storage:string,signature:string,confirm:()=>Promise<unknown>,o:string):Promise<boolean>{
  const started=Date.now();let message='';
  for(let attempt=0;;attempt++){
   if(!current(o))return false;
   track(o,storage,{phase:'finalizing',signature,checking:true,message});
   try{await confirm();recovery.resolve(storage);track(o,storage,null);return true;}
   catch(e){
    // 409: not finalized yet. 0, 429 and 5xx: the check did not complete. Both keep checking within the window.
    // Any other status is shown, but the signature stays: an HTTP failure says nothing about the transaction.
    const retry=e instanceof ApiError&&(e.status===409||e.status===0||e.status===429||e.status>=500);
    message=e instanceof Error?e.message:'';
    if(!retry){track(o,storage,{phase:'finalizing',signature,checking:false,message});throw e;}
    await load(o).catch(()=>{});
    if(Date.now()-started>=FINALIZE_WINDOW_MS){track(o,storage,{phase:'finalizing',signature,checking:false,message});return false;}
    await new Promise(resolve=>setTimeout(resolve,Math.min(2000+attempt*1000,6000)));
   }
  }
 }
 /** Signs once. A returned signature is saved before anything else, even if the account changed while signing. */
 async function sign(o:string,storage:string,fn:()=>Promise<string>):Promise<string>{
  track(o,storage,{phase:'signing',checking:false});
  let signature:string;
  try{signature=await fn();}
  catch(e){if(e instanceof WalletOutcomeUnknown){recovery.markUnknown(storage);track(o,storage,{phase:'unknown',checking:false});}else track(o,storage,null);throw e;}
  recovery.remember(storage,signature);
  return signature;
 }
 async function allocation(kind:'approve'|'cancel',amount='',token='USDC',recheck=false){
 await run(kind,async o=>{
  const id=identity();
  // Allowance approval and revocation exist only for an owner wallet on the allowance path. A contract wallet or a budget
  // authorization never falls back to them. A recheck only confirms a transaction already signed, so it stays available
  // whatever the current capabilities say.
  if(!selected||hasDelegatedAuthority(selected)||!isOwnerWallet(selected)||(!recheck&&!isAllowanceWallet(selected))||(!recheck&&(kind==='approve'?!supports(selected,'fund'):!supports(selected,'revoke')&&selected.status!=='draft')))throw new Error('This policy’s wallet does not support this action.');
  const key=allocationKey(o,id.id,kind);let signature=recovery.signature(key);
  if(!signature){
   if(recovery.unknown(key)){
    // Only the gateway reporting this policy cancelled, with no wallet action, resolves an unknown revocation.
    if(kind==='cancel'&&await revocationResolved((path,body)=>mutate(path,body,o),id)){recovery.resolve(key);track(o,key,null);return;}
    throw new Error(UNKNOWN_OUTCOME);
   }
   if(recheck)return;
   const v=await mutate(`micro/allocation/${kind==='approve'?'prepare':'cancel'}`,{...id,amount,token},o);setHandoff(null);if(!current(o))return;const intent=v.intent;if(!intent)throw new Error('The server did not return an allowance request.');if(intent.noTransaction){if(kind==='approve'){const h=await mutate('micro/handoff',id,o);if(current(o)&&h.harnessPrompt)setHandoff({id:id.id,text:h.harnessPrompt,skill:h.skill??''});}return;}
   const config=selected?{id:selected.network,label:selected.network,mint:selected.mint||networks.find(n=>n.id===selected.network)?.mint||'',allocationEnabled:!!selected.mint||!!networks.find(n=>n.id===selected.network)?.allocationEnabled}:undefined;
   signature=await sign(o,key,()=>signAllocation(intent,o,config));
  }
  // The server checks exact instructions, owner, cap, memo and finalized chain state.
  await finalize(key,signature,()=>mutate('micro/allocation/confirm',{...id,signature},o),o);
 }).then(async ok=>{if(!ok&&ownerRef.current===owner)await load(owner).catch(()=>{});});
 }
 /** Revokes an Allowit allowance that no live policy in this workspace holds, so this draft can be approved. */
 async function releaseAllowance(){
 await run('release',async o=>{
  const id=identity();
  if(!selected||hasDelegatedAuthority(selected)||!isOwnerWallet(selected)||!isAllowanceWallet(selected)||selected.status!=='draft')throw new Error('This policy’s wallet does not support this action.');
  const key=allocationKey(o,id.id,'release');let signature=recovery.signature(key);
  if(!signature){
   if(recovery.unknown(key))throw new Error(UNKNOWN_OUTCOME);
   const v=await mutate('micro/allocation/release',id,o);if(!current(o))return;const intent=v.intent;if(!intent)throw new Error('The server did not return an allowance request.');if(intent.noTransaction)return;
   if(intent.kind!=='revoke'||!intent.release)throw new Error('The server returned a different allowance request. Nothing was signed.');
   const config={id:selected.network,label:selected.network,mint:selected.mint||networks.find(n=>n.id===selected.network)?.mint||'',allocationEnabled:!!selected.mint||!!networks.find(n=>n.id===selected.network)?.allocationEnabled};
   signature=await sign(o,key,()=>signAllocation(intent,o,config));
  }
  await finalize(key,signature,()=>mutate('micro/allocation/confirm',{...id,signature},o),o);
 }).then(async ok=>{if(!ok&&ownerRef.current===owner)await load(owner).catch(()=>{});});
 }
 async function execute(requestId:string){
 await run('execute',async o=>{
  const policy=selected;if(!policy)throw new Error('Select a policy first.');
  // An owner-signed transfer is the owner wallet's settlement only. A contract-wallet run is never settled by a direct transfer.
  if(hasDelegatedAuthority(policy)||!isOwnerWallet(policy))throw new Error('This policy’s wallet settles its own runs. No transfer is needed from your wallet.');
  const q=policy.requests.find(r=>r.id===requestId);if(!q?.recipient)throw new Error('This request needs a recipient.');
  const id={id:policy.id,revision:policy.revision,requestId};const key=transferKey(o,policy.id,requestId);let signature=recovery.signature(key)||q.signature||'';
  // A saved signature is only checked again. No new transfer is prepared under a budget authorization on this page.
  if(!signature&&isAuthorization(policy))throw new Error('This page does not prepare transfers for a budget authorization policy. Nothing was signed or sent.');
  if(!signature){
   const v=await mutate('micro/requests/prepare',id,o);if(!current(o))return;
   const updated=v.policies.find(p=>p.id===policy.id)?.requests.find(r=>r.id===requestId);
   // The gateway resolves an expired reservation from chain history, which is positive evidence either way.
   if(updated?.status==='settled'||updated?.status==='denied'){recovery.resolve(key);track(o,key,null);return;}
   if(recovery.unknown(key))throw new Error(UNKNOWN_OUTCOME);
   if(!v.transferIntent)throw new Error('No payment request was returned.');
   const intent=v.transferIntent;
   signature=await sign(o,key,()=>signTransfer(intent,{owner:o,network:policy.network,mint:policy.mint,recipient:q.recipient!,amount:q.amount}));
  }
  await finalize(key,signature,()=>mutate('micro/requests/confirm',{...id,signature},o),o);
 }).then(async ok=>{if(!ok&&ownerRef.current===owner)await load(owner).catch(()=>{});});
 }
 async function revokeAll(beforeCancel?:(isCurrent:()=>boolean)=>Promise<void>){
  if(loading||auth.loading||auth.busy||(!beforeCancel&&!policies.some(p=>p.status!=='cancelled'&&revocable(p))))return false;
  const generation=revocationScope.current.generation;
  return run('revoke-all',async o=>{
   const isCurrent=()=>current(o)&&revocationScope.current.generation===generation;
   setRevocation(null);
   setHandoff(null);
   try{
    if(beforeCancel){await beforeCancel(isCurrent);if(!isCurrent())throw new Error('The wallet or workspace changed.');}
    await revokePolicyBatch({owner:o,policies:policies.filter(revocable),networks,isCurrent,recovery,sign:signAllocation,progress:setRevocation,
     send:async(path,body)=>{
      if(!isCurrent())throw new Error('The wallet or workspace changed.');
      const version=++responseVersion.current;
      const result=await api<Result>(path,body);
      if(!isCurrent())throw new Error('The wallet or workspace changed.');
      if(version===responseVersion.current)apply(result,o);
      return result;
     },
    });
   }catch(e){
    if(!isCurrent())return;
    await load(o).catch(()=>{});
    if(isCurrent())throw e;
   }
  });
 }
 const txProgress=(kind:'request'|'allocation',policyId:string,id:string):TxProgress|null=>{
  if(!owner)return null;
  const key=kind==='request'?transferKey(owner,policyId,id):allocationKey(owner,policyId,id as 'approve'|'cancel');
  const live=tx.owner===owner?tx.items[key]:undefined;if(live)return live;
  // After a reload the signature, or the unknown outcome, survives in this tab; the next check reuses it.
  const signature=recovery.signature(key);
  if(signature)return {phase:'finalizing',signature,checking:false};
  return recovery.unknown(key)?{phase:'unknown',checking:false}:null;
 };
 const setup=useContractSetup({owner,policy:selected&&isStellarPolicy(selected)?null:selected,run,current,reload:load,send:o=>(path,body)=>mutate(path,body,o)});
 // Authorization replies may carry no policy list; one is applied only when present.
 const authorization=useOwnerAuthorization({owner,policy:selected,run,current,reload:load,send:o=>async(path,body)=>{const version=++responseVersion.current;const v=await api<Record<string,unknown>>(path,body);if(version===responseVersion.current&&Array.isArray(v?.policies))apply(v as unknown as Result,o);return v;}});
 const runtime=runtimeConfig?.owner===owner&&runtimeConfig.network===network?runtimeConfig.value:null;
 networkOptionsRef.current=availableNetworks(networks,delegatedNetworks(runtime));
 return {revokeAll,authorization,runtimeConfig:runtime,runtimeConfigFailed:runtimeConfig?.owner===owner&&runtimeConfig.network===network&&!!runtimeConfig.failed,runs:runs&&runs.owner===owner&&runs.policyId===selected?.id?{policyId:runs.policyId,requests:runs.requests}:null,setup,
 requestDetail:async(policyId,requestId)=>{
  const o=owner;if(!o||network==='local:dev')return null;
  const v=await api<{request?:PolicyRequest}>(`micro/runs?id=${encodeURIComponent(policyId)}&requestId=${encodeURIComponent(requestId)}`);
  // Applied only for the owner, policy and request that asked.
  if(!current(o)||!v.request||v.request.id!==requestId||(v.request.policyId!==undefined&&v.request.policyId!==policyId))return null;
  return v.request;
 },revocation:revocation?.owner===owner?revocation:null,network,networks,setNetwork:n=>{if(!tempo&&!lock.current&&availableNetworks(networks,delegatedNetworks(runtimeConfig?.owner===owner?runtimeConfig.value:null)).some(v=>v.id===n)){changeNetwork(n);writePref(stellar?'allowit.stellar.network':'allowit.network',n);}},auth,policiesLoaded:data.owner===owner&&!!owner,policies,selected,loading,busy,error,renameError,harnessPrompt:handoff?.id===selected?.id?handoff?.text??null:null,skill:handoff?.id===selected?.id?handoff?.skill??null:null,
 setRecipient:recipient=>run('recipient',async o=>{
  if(!selected||selected.network!=='solana:devnet'||selected.status!=='draft'||selected.nativeExecution)throw new Error('Save a recipient only on an unbound Devnet draft.');
  recipientTokenAccount(recipient,selected.mint);
  const before=selected,version=++responseVersion.current;
  setHandoff(null);
  const result=await request<Result>('micro/recipient',{id:before.id,revision:before.revision,sourceHash:before.sourceHash,recipient},{expectedOwner:auth.session!.network+':'+o});
  const next=checkedRecipientRevision(before,result.policies?.find(p=>p.id===before.id),recipient);
  if(version===responseVersion.current&&current(o))apply({...result,selectedId:next.id},o);
 }),
 setNativeX402Service:nativeServiceId=>run('native-service',async o=>{
  if(!selected||selected.network!=='solana:devnet'||selected.status!=='draft'||selected.nativeExecution)throw new Error('Save a native service only on an unbound Devnet draft.');
  if(nativeServiceId!==''&&!/^[a-z0-9][a-z0-9._/-]{0,63}$/.test(nativeServiceId))throw new Error('Choose a trusted service advertised by this Devnet server.');
  const before=selected,version=++responseVersion.current;
  setHandoff(null);
  const result=await request<Result>('micro/native-service',{id:before.id,revision:before.revision,sourceHash:before.sourceHash,nativeServiceId},{expectedOwner:auth.session!.network+':'+o});
  if(version===responseVersion.current&&current(o))apply({...result,selectedId:before.id},o);
 }),
 setFunding:amount=>run('funding',async o=>{
  if(!selected||hasDelegatedAuthority(selected)||selected.network!=='solana:devnet'||selected.status!=='draft'||selected.allocation||selected.approvalPending||selected.nativeExecution)throw new Error('Set funding only on an unbound Devnet draft.');
  if(!/^(0|[1-9]\d{0,6})(\.\d{1,6})?$/.test(amount)||!/[1-9]/.test(amount))throw new Error('Enter a positive USDC amount with at most six decimal places.');
  const before=selected,version=++responseVersion.current;
  setHandoff(null);
  const result=await request<Result>('micro/funding',{id:before.id,revision:before.revision,amount,token:'USDC'},{expectedOwner:auth.session!.network+':'+o});
  const next=result.policies?.find(p=>p.id===before.id);
  if(!next?.fundingRequest||next.fundingRequest.token!=='USDC'||next.sourceHash!==before.sourceHash||next.code!==before.code)throw new Error('The server returned a different policy. Refresh before setup.');
  if(version===responseVersion.current&&current(o))apply({...result,selectedId:before.id},o);
 }),
 configurePreference:settings=>run('preference',async o=>{if(selected?.delegatedExecution!==undefined)throw new Error('This source is bound to a wallet allowance. Fork it before changing rules.');setHandoff(null);await mutate('micro/preference',{...identity(),preference:settings},o);}),
 setWhitelist:entries=>run('whitelist',async o=>{if(runtime==='unavailable'||!runtime?.features.policyWhitelist)throw new Error('Service whitelist editing is unavailable. Existing policy rules still apply.');setHandoff(null);await mutate('micro/whitelist',{...identity(),whitelist:entries},o);}),
 // One action: the fork reply names the new draft, which carries the same source and step IDs, so the edit applies there.
 forkPreference:settings=>run('fork',async o=>{if(selected&&(policyAllowlist(selected)!==null||!supports(selected,'fork')))throw new Error('This policy’s wallet does not support forks. Start a new draft instead.');setHandoff(null);const v=await mutate('micro/fork',identity(),o);const fork=v.policies?.find(p=>p.id===v.selectedId);if(!fork)throw new Error('The fork was not returned. Refresh and edit the new draft.');await mutate('micro/preference',{id:fork.id,revision:fork.revision,preference:settings},o);}),
 rename:title=>run('rename',async o=>{if(selected&&!supports(selected,'rename'))throw new Error('This policy’s wallet does not support renaming.');await mutate('micro/rename',{...identity(),title},o);}),
 // The Local dev simulation never reaches a wallet owner: it requires the local:dev network, a local_* owner and a local:dev policy.
 answerLocal:async(requestId,approved)=>{if(!selected||!simulatesAnswers(network,owner,selected.network))throw new Error('Simulated answers are available only in Local dev.');await run('answer',async o=>{await mutate('micro/requests/answer',{...identity(),requestId,inputKey:selected.requests.find(q=>q.id===requestId)?.inputKey,approved},o);});},
 feedback:async(requestId,feedback)=>{await run('feedback',async o=>{await mutate('micro/requests/feedback',{...identity(),requestId,feedback},o);});},
 execute,migrate:async()=>{await run('migrate',async o=>{await mutate('micro/migrate',identity(),o);});},
 runExternal:(name,work)=>run(name,async o=>{await work(()=>current(o));}),select:id=>{if(!lock.current&&!busy){setSelectedId(id);setHandoff(null);setError(null);setRenameError(null);}},dismissError:()=>{setError(null);setErrorCode('');},errorCode,releaseAllowance,refresh:async()=>{await run('refresh',load);},
 generate:(prompt,choice,stellarInstallationId)=>run('generate',async o=>{
  setHandoff(null);
  const knownIds=new Set(policies.map(p=>p.id));
  const create=async(body:ReturnType<typeof generateBody>)=>{
   const result=await mutate('micro/generate',{...body,...(stellar&&stellarInstallationId?{stellarInstallationId}:{})},o);
   // Some server revisions return the new list without selectedId. Select only an unambiguous newly created policy.
   if(!result.selectedId&&current(o)){
    const fresh=result.policies.filter(p=>!knownIds.has(p.id));
    if(fresh.length===1)setSelectedId(fresh[0].id);
   }
  };
  // Local dev sends the original body: no runtime, no wallet choice and nothing to sign.
  if(network==='local:dev'||tempo){await create(generateBody(network,prompt));return;}
  const failed=runtimeConfig?.owner===owner&&runtimeConfig.network===network&&!!runtimeConfig.failed;
  if(!runtime||failed)throw new Error('Wallet options could not be loaded, so no policy was created. Reload the page and retry.');
  if(runtime==='unavailable'){if(choice||requiresDelegatedWallet(network))throw new Error('Wallet options are not loaded. Reload the page and retry.');await create(generateBody(network,prompt));return;}
  if(!choice)throw new Error('Choose a wallet and, for a provider wallet, its service first.');
  const checked=checkedChoice(runtime,network,choice);
  if(!checked.operation?.serviceIds){await create(generateBody(network,prompt,checked));return;}
  // Retain the owner's selection independently of the server, including a durable rejection of substituted drafts.
  const version=++responseVersion.current;const v=await api<Result>('micro/generate',generateBody(network,prompt,checked));
  const fresh=Array.isArray(v?.policies)?v.policies.filter(p=>!knownIds.has(p.id)):[];
  // Older servers omit selectedId. Identify exactly one new policy before validating the owner's service selection.
  const generated=Array.isArray(v?.policies)?(v.selectedId?v.policies.find(p=>p.id===v.selectedId):fresh.length===1?fresh[0]:undefined):undefined;
  try{checkGeneratedAllowlist(checked,generated);}
  catch(e){if(generated&&/^[0-9a-f]{64}$/.test(generated.id))browserServiceApprovals.remember(o,generated.id,checked.operation.serviceIds,true);throw e;}
  browserServiceApprovals.remember(o,generated!.id,checked.operation.serviceIds,false);
  if(version===responseVersion.current)apply({...v,selectedId:generated!.id},o);
 }),
 revise:prompt=>run('revise',async o=>{if(selected&&(selected.delegatedExecution!==undefined||policyAllowlist(selected)!==null||!supports(selected,'revise')))throw new Error('This policy’s wallet does not support revisions. Start a new draft instead.');setHandoff(null);await mutate('micro/revise',{...identity(),prompt},o);}),
 fork:async()=>{await run('fork',async o=>{if(selected&&(policyAllowlist(selected)!==null||!supports(selected,'fork')))throw new Error('This policy’s wallet does not support forks. Start a new draft instead.');setHandoff(null);await mutate('micro/fork',identity(),o);});},approve:(amount,token)=>allocation('approve',amount,token),cancel:()=>selected&&isContractWallet(selected)?setup.discard():allocation('cancel'),recheckAllocation:kind=>allocation(kind,'','USDC',true),txProgress,
 handoff:async()=>{await run('handoff',async o=>{const id=identity();if(selected&&!handoffReady(selected,isAuthorization(selected)?authorization.view(selected.id):setup.view(selected.id),o))throw new Error(isAuthorization(selected)?'This policy’s budget authorization is not verified, so no agent skill was created.':'This policy’s setup is not finalized, so no agent skill was created.');const v=await mutate('micro/handoff',id,o);if(current(o)&&v.harnessPrompt)setHandoff({id:id.id,text:v.harnessPrompt,skill:v.skill??''});});},
 };
}
