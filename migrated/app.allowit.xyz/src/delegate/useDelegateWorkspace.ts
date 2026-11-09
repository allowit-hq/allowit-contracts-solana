import {useCallback,useEffect,useRef,useState} from 'react';
import {ApiError,request} from '../api';
import {withAllowanceSigningLock} from './allowance-coordination';
import {readAllowanceRecovery} from './allowance-recovery';
import type {MicroController,MicroPolicy} from '../micro/micro-contracts';
import {delegatedNetworks,hasDelegatedAuthority} from '../runtime/runtime';
import {archiveExpiredDelegateProof,delegateProofArchived,checkDelegateProofNotArchived,checkDelegateProofStorage,projectDelegatePreparation,readDelegateProof,retainDelegateProof,saveDelegateProof,type SavedDelegateProof} from './delegate-proof';
import {checkedDelegateConfig,checkedDelegateTransaction,checkedReturnTransaction,signDelegateOwner,signDelegateReturn,verifyDelegateGrant} from './delegate-wallet-intent';
import {delegateGrantConfig,delegatePolicyKey,delegatePolicyView,delegateTerminal} from './delegate-bound';
import {delegateUnits,type DelegateConfig,type DelegateEvaluation,type DelegateGrant,type DelegatePendingRequest,type DelegatePreparation,type DelegateRequestInbox,type DelegateRequestReason,type DelegateReturnPreparation,type DelegateSubmissionResult} from './delegate-contracts';
import {checkedDelegateInbox} from './delegate-owner-requests';

import {delegateLoadFailure,emptyDelegateState,type DelegateWorkspaceState} from './delegate-workspace-state';
import useDelegateRootPrompt from './useDelegateRootPrompt';
import {isDelegateAllowanceConflict,readDelegateAllowanceConflict,type DelegateAllowanceConflict,type DelegateConflictNotice} from './delegate-conflict';
import {reconcileSavedApproval,type ApprovalOutcome,type ApprovalRetryBudget} from './delegate-approval-reconciliation';


export interface DelegateReview {grantId:string;action:'approve'|'revoke';preparation:DelegatePreparation}
export interface DelegateStopOutcome {failures:string[];unresolvedGrantIds:string[]}
/** A return can only land once: it closes the policy account. A signed packet is kept only to check it again. */
export interface DelegateReturnReview {grantId:string;preparation:DelegateReturnPreparation;signedTransactionBase64?:string}
type List={grants:DelegateGrant[];config?:DelegateConfig;recoveryAvailable?:boolean};
type NetworkState=DelegateWorkspaceState&{configNetwork?:string};
const proofKey=(g:DelegateGrant,a:'approve'|'revoke')=>`${g.owner}:${g.network}:${g.id}:${g.commitmentHash}:${a}`;
const complete=(g:DelegateGrant,owner:string)=>g&&g.owner===owner&&typeof g.id==='string'&&typeof g.policyId==='string'&&typeof g.source==='string'&&typeof g.intent==='string'&&Array.isArray(g.children)&&Array.isArray(g.receipts)&&['draft','prepared','activation_pending','active','revocation_pending','revoked','failed'].includes(g.status);
const hasSavedAuthority=(owner:string)=>{try{for(let i=0;i<localStorage.length;i++)if(localStorage.key(i)?.startsWith(`allowit.delegate.proof.v1:${owner}:`))return true;}catch{/* An advertised/bound profile still fails closed. */}return false;};

/** Mounted once per workspace, above policy selection. Capabilities stay in RAM; only exact signed public proofs persist. */
export default function useDelegateWorkspace(c:MicroController,raise:(message:string)=>void){
 const owner=c.auth.session?.network==='tempo'||c.auth.session?.network==='stellar'||c.auth.session?.network==='local:dev'?'':c.auth.session?.address??'';
 const principal=owner&&c.auth.session?`${c.auth.session.network}:${owner}`:'';
 const sessionKey=JSON.stringify([principal,c.auth.session?.expiresAt??'']);
 const selection=delegatePolicyKey(c.selected);
 // A saved policy owns its network. The header preference applies only when creating another policy.
 const configNetwork=c.selected&&hasDelegatedAuthority(c.selected)?c.selected.network:c.network;
 const refreshKey=JSON.stringify([sessionKey,configNetwork]);
 const identity=useRef({sessionKey,selection,configNetwork,generation:0});
 if(identity.current.sessionKey!==sessionKey||identity.current.configNetwork!==configNetwork)identity.current={sessionKey,selection,configNetwork,generation:identity.current.generation+1};
 else identity.current.selection=selection;
 const mounted=useRef(true),localLock=useRef(false),requestVersion=useRef(0);
 const refreshInFlight=useRef(new Map<string,Promise<void>>());
 const authorityExpected=useRef(false),knownPrincipals=useRef(new Set<string>());
 authorityExpected.current=c.policies.some(hasDelegatedAuthority)||delegatedNetworks(c.runtimeConfig).length>0;
 const [data,setData]=useState<NetworkState>(()=>emptyDelegateState(''));
 const [pending,setPending]=useState<string|null>(null),[notice,setNotice]=useState('');
 const [reviews,setReviews]=useState<Record<string,DelegateReview>>({});
 const [returns,setReturns]=useState<Record<string,DelegateReturnReview>>({});
 const [conflictState,setConflictState]=useState<{sessionKey:string;notice:DelegateConflictNotice}|null>(null);
 const [stopConflictState,setStopConflictState]=useState<{sessionKey:string;items:Record<string,DelegateAllowanceConflict>}>({sessionKey:'',items:{}});
 const allowanceConflict=conflictState?.sessionKey===sessionKey?conflictState.notice:null;
 const stopConflicts=stopConflictState.sessionKey===sessionKey?stopConflictState.items:{};
 const [capability,setCapability]=useState<{sessionKey:string;selection:string;generation:number;grantId:string;childId:string;token:string}|null>(null);
 const [approvalState,setApprovalState]=useState<(ApprovalOutcome&{key:string;grantId:string})|null>(null);
 const approvalBudgets=useRef(new Map<string,ApprovalRetryBudget>());
 // Survives selection and account loss. A returned signature is saved under its ORIGINAL grant even after the view changes.
 const proofMemory=useRef(new Map<string,SavedDelegateProof>());
 const proofErrors=useRef(new Map<string,string>());
 const [,renderProofs]=useState(0);
 const active=data.sessionKey===sessionKey?data:null;
 const currentConfig=active?.configNetwork===configNetwork;
 const grants=active?.grants??[],config=currentConfig?active?.config??null:null,loaded=active?.loaded??!owner,paymentReady=currentConfig&&active?.paymentReady===true;
 const latestGrants=useRef(grants);latestGrants.current=grants;
 const current=(scope:{sessionKey:string;selection?:string;generation:number})=>mounted.current&&identity.current.sessionKey===scope.sessionKey&&identity.current.generation===scope.generation&&(scope.selection===undefined||identity.current.selection===scope.selection);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{setCapability(null);setReviews({});setReturns({});setNotice('');},[sessionKey,selection,configNetwork]);
 const refreshOnce=useCallback(async()=>{
  if(!owner)return;
  const scope={sessionKey,generation:identity.current.generation},version=++requestVersion.current;
  const [publicConfig,list,questions]=await Promise.all([
   request<DelegateConfig>(`delegate/config?network=${encodeURIComponent(configNetwork)}&compact=1`).then(value=>checkedDelegateConfig(value,configNetwork)).catch(()=>null),
   request<List>(`delegate/grants?network=${encodeURIComponent(configNetwork)}`,undefined,{expectedOwner:principal}).catch(error=>{if(error instanceof ApiError&&error.status===404&&!authorityExpected.current&&!knownPrincipals.current.has(principal)&&!hasSavedAuthority(owner))return {grants:[]} as List;throw error;}),
   request<DelegateRequestInbox>('delegate/requests',undefined,{expectedOwner:principal}).then(checkedDelegateInbox).then(value=>({value,error:null}),error=>({value:null,error:error instanceof Error?error.message:'Owner questions could not be loaded.'})),
  ]);
  if(!Array.isArray(list.grants)||list.grants.some(g=>!complete(g,owner)))throw new Error('The retained grant list is incomplete or belongs to another owner. Existing authority must be checked before policies can be hidden.');
  let nextConfig=publicConfig;
  if(!nextConfig&&list.config)try{nextConfig=checkedDelegateConfig(list.config,configNetwork);}catch{/* A different deployment never supplies this selection's readiness. */}
  for(const grant of list.grants){
   await verifyDelegateGrant(delegateGrantConfig(grant,nextConfig),grant,owner);
   for(const value of [grant.budgetUnits,grant.remainingUnits,grant.reservedUnits,grant.spentUnits])delegateUnits(value);
   for(const action of ['approve','revoke'] as const){
    const key=proofKey(grant,action);
    try{const saved=readDelegateProof(delegateGrantConfig(grant,nextConfig),grant,action,principal);if(saved&&!proofMemory.current.has(key))proofMemory.current.set(key,saved);proofErrors.current.delete(key);}
    catch(error){proofErrors.current.set(key,error instanceof Error?error.message:'The saved proof could not be read.');}
   }
  }
  if(!current(scope)||version!==requestVersion.current)return;
  if(list.grants.length)knownPrincipals.current.add(principal);
  setData({sessionKey,configNetwork,grants:list.grants,config:nextConfig,paymentReady:publicConfig?.ready===true,loaded:true,error:null,requests:questions.value?.requests??[],answeredRequests:questions.value?.answeredRequests??[],closedRequests:questions.value?.closedRequests??[],requestError:questions.error});
 },[owner,principal,sessionKey,configNetwork]);
 const refresh=useCallback(async()=>{
  const prior=refreshInFlight.current.get(refreshKey);if(prior)return prior;
  const work=refreshOnce();refreshInFlight.current.set(refreshKey,work);
  try{await work;}finally{if(refreshInFlight.current.get(refreshKey)===work)refreshInFlight.current.delete(refreshKey);}
 },[refreshOnce,refreshKey]);
 useEffect(()=>{if(!owner)return;let live=true;void refresh().catch(error=>{if(live)setData(previous=>delegateLoadFailure(previous,sessionKey,error instanceof Error?error.message:'Retained grants could not be read.',true));});const timer=setInterval(()=>{if(document.visibilityState==='visible'&&!localLock.current)void refresh().catch(error=>{if(live)setData(previous=>delegateLoadFailure(previous,sessionKey,error instanceof Error?error.message:'Grant status could not be refreshed.'));});},5000);return()=>{live=false;clearInterval(timer);};},[refresh,owner,sessionKey]);
 const update=(grant:DelegateGrant,nextConfig?:DelegateConfig)=>{
  if(!complete(grant,owner))throw new Error('The grant response differs from this owner.');
  requestVersion.current++;
  setData(previous=>previous.sessionKey===sessionKey?{...previous,grants:[...previous.grants.filter(g=>g.id!==grant.id),{...grant,...(nextConfig?{config:nextConfig}:{})}]}:previous);
 };
 async function run(name:string,work:(current:()=>boolean)=>Promise<void>,selectionBound=false){
  if(localLock.current||!owner||!c.runExternal)return false;
  localLock.current=true;requestVersion.current++;const scope={sessionKey,generation:identity.current.generation,...(selectionBound?{selection}: {})};setPending(name);setNotice('');
  try{return await c.runExternal(`delegate:${name}`,async controllerCurrent=>{const live=()=>controllerCurrent()&&current(scope);if(!live())throw new Error('The owner or policy snapshot changed.');await work(live);});}
  catch(error){if(current(scope))raise(error instanceof Error?error.message:'The delegated operation could not finish.');return false;}
  finally{localLock.current=false;if(mounted.current)setPending(null);}
 }
 async function runAllowance(name:string,work:(current:()=>boolean)=>Promise<void>){
  if(name!=='allowance-observe')return run(`allowance:${name}`,work);
  if(!owner)return false;
  const scope={sessionKey,generation:identity.current.generation};
  try{if(!current(scope))return false;await work(()=>current(scope));return true;}catch{return false;}
 }
 async function allowanceChanged(){
  const earlier=refreshInFlight.current.get(refreshKey);
  if(earlier)await earlier.catch(()=>{});
  await refresh();
 }
 const grantReady=(grant:DelegateGrant)=>{
  const cfg=delegateGrantConfig(grant,grant.displayNetwork===configNetwork?config:null);
  if(!cfg.ready)return false;
  if(grant.displayNetwork===configNetwork&&(!paymentReady||!config||config.network!==grant.network||config.genesisHash!==grant.genesisHash||config.mint!==grant.mint))return false;
  try{checkedDelegateConfig(cfg,grant.displayNetwork);return cfg.network===grant.network&&cfg.genesisHash===grant.genesisHash&&cfg.mint===grant.mint&&cfg.delegate===grant.delegate;}catch{return false;}
 };
 const view=(policy:MicroPolicy)=>{
  const retained=delegatePolicyView(policy,owner,grants,loaded,false);
  return delegatePolicyView(policy,owner,grants,loaded,retained.grant?grantReady(retained.grant):paymentReady&&config?.displayNetwork===policy.network);
 };
 const proof=(grant:DelegateGrant,action:'approve'|'revoke')=>proofMemory.current.get(proofKey(grant,action))??null;
 const proofError=(grant:DelegateGrant,action:'approve'|'revoke')=>proofErrors.current.get(proofKey(grant,action))??null;
 function clearStopConflict(grantId:string){
  setStopConflictState(previous=>{if(previous.sessionKey!==sessionKey||!previous.items[grantId])return previous;const items={...previous.items};delete items[grantId];return {sessionKey,items};});
 }
 async function allowanceRequest<T>(path:string,body:unknown,policyId:string,grant:DelegateGrant|null,action:'approve'|'revoke',live:()=>boolean):Promise<T>{
  try{return await request<T>(path,body,{expectedOwner:principal});}
  catch(error){
   if(live()&&isDelegateAllowanceConflict(error)){
    let details=readDelegateAllowanceConflict(error,owner);
    const expected=grant??config;
    if(details&&(!expected||details.network!==expected.network||details.genesisHash!==expected.genesisHash||details.mint!==expected.mint||(grant&&details.sourceAccount!==grant.sourceAccount)))details=null;
    if(action==='revoke'){
     if(details)setStopConflictState(previous=>({sessionKey,items:{...(previous.sessionKey===sessionKey?previous.items:{}),[grant!.id]:details!}}));
    }else{setConflictState({sessionKey,notice:{policyId,message:error.message,details}});await refresh().catch(()=>{});}
   }
   throw error;
  }
 }
 async function create(policy:MicroPolicy,budgetUnits:string){
  if(!view(policy).editable||!paymentReady||!config?.ready||config.displayNetwork!==policy.network||config.mint!==policy.mint)throw new Error('This exact policy has no available delegated funding configuration.');
  delegateUnits(budgetUnits);if(BigInt(budgetUnits)===0n)throw new Error('Enter a positive shared budget.');
  const ok=await run('create',async live=>{
   const result=await allowanceRequest<{grant:DelegateGrant;config?:DelegateConfig}>('delegate/grants',{policyId:policy.id,revision:policy.revision,network:config.network,budgetUnits},policy.id,null,'approve',live);
   const g=result.grant;
   if(g.policyId!==policy.id||g.revision!==policy.revision||g.source!==policy.code||g.intent!==policy.originalIntent||g.sourceHash!==policy.sourceHash||g.irHash!==policy.irHash||g.displayNetwork!==policy.network||g.mint!==policy.mint||g.budgetUnits!==budgetUnits)throw new Error('The grant differs from this policy snapshot. Nothing was signed.');
   await verifyDelegateGrant(result.config??delegateGrantConfig(g,config),g,owner);
   if(!live())return;update(g,result.config);setNotice('Funding setup saved. Review the wallet approval before signing.');
  },true);
  if(ok)await c.refresh();
 }
 async function prepareInternal(grant:DelegateGrant,action:'approve'|'revoke',live:()=>boolean,afterStops?:Array<()=>Promise<void>>):Promise<boolean>{
  if(action==='revoke'){rootPrompt.invalidate();setReviews(previous=>{const next={...previous};delete next[grant.id];return next;});}
  if(action==='approve'&&!grantReady(grant))throw new Error('New approvals are unavailable. Existing allowance recovery remains available.');
  const v=await allowanceRequest<DelegatePreparation&{config?:DelegateConfig;grant?:DelegateGrant;offchainStopped?:boolean;pending?:boolean;cleanupPending?:boolean;allowanceAbsent?:boolean;reason?:string}>(action==='approve'?'delegate/prepare':'delegate/revoke',{grantId:grant.id},grant.policyId,grant,action,live);
  if(!live())return false;
  const cfg=v.config??delegateGrantConfig(grant,config);
  if(v.grant){await verifyDelegateGrant(cfg,v.grant,owner);if(v.grant.id!==grant.id||v.grant.commitmentHash!==grant.commitmentHash)throw new Error('The retained grant commitment changed.');if(!live())return false;update(v.grant,v.config);}
  if(!v.transactionBase64){
   clearStopConflict(grant.id);
   const resolved=!!v.grant&&delegateTerminal(v.grant)&&v.pending!==true&&v.cleanupPending!==true;
   setReviews(previous=>{const next={...previous};delete next[grant.id];return next;});
   setNotice(resolved?(v.allowanceAbsent===true?'No token allowance remains. No additional wallet signature is needed. Earlier signed payments remain recorded.':'Token allowance revoked. Earlier signed payment reservations remain recorded.'):typeof v.reason==='string'&&v.reason.trim()?v.reason:'The original transaction is still being checked. Retained proofs remain unchanged.');return resolved;
  }
  await verifyDelegateGrant(cfg,grant,owner);checkedDelegateTransaction(cfg,grant,owner,action,v);
  const finish=async()=>{
   const key=proofKey(grant,action),remembered=proofMemory.current.get(key);
   const archived=await archiveExpiredDelegateProof(cfg,grant,v,action);
   if(remembered&&proofMemory.current.get(key)===remembered
    &&remembered.preparation.preparationId===v.supersedes?.preparationId
    &&remembered.preparation.lastValidBlockHeight===v.supersedes.lastValidBlockHeight
    &&(v.supersedes.signature===undefined||remembered.proof.signature===v.supersedes.signature)
    &&(archived||delegateProofArchived(cfg,grant,v,action,remembered)))proofMemory.current.delete(key);
   if(!live())return;
   const retained=readDelegateProof(cfg,grant,action,principal);if(retained)proofMemory.current.set(key,retained);proofErrors.current.delete(key);clearStopConflict(grant.id);
   update(v.grant??grant,cfg);setReviews(previous=>({...previous,[grant.id]:{grantId:grant.id,action,preparation:projectDelegatePreparation(v)}}));
   if(action==='revoke'&&!afterStops)setNotice('New requests are stopped. Review and sign the token allowance revocation.');
  };
  if(afterStops)afterStops.push(async()=>{try{await finish();}catch(error){throw new Error(`${grant.id}: ${error instanceof Error?error.message:'The retained proof could not be archived'}`);}});else await finish();
  return false;
 }
 async function prepare(grant:DelegateGrant,action:'approve'|'revoke'){
  if(action==='approve'){
   const p=c.policies.find(p=>p.id===grant.policyId),v=p?view(p):null;
   if(!p||!v||v.error||v.grant?.id!==grant.id||!hasDelegatedAuthority(p)||c.selected?.id!==p.id)throw new Error('Only the exact selected, durably bound policy can approve this grant.');
  }
  return run('prepare',async live=>{await prepareInternal(grant,action,live);},action==='approve');
 }
 async function submitInternal(grant:DelegateGrant,value:SavedDelegateProof,live:()=>boolean){
  if(value.proof.operation==='approve'&&(!grantReady(grant)||!['draft','prepared','activation_pending'].includes(grant.status)))throw new Error('New approvals are unavailable or this grant is stopped. Keep the original proof and check its server lifecycle; revocation remains available.');
  // Persist BEFORE any network submission, including retries after a storage failure.
  await retainDelegateProof(delegateGrantConfig(grant,config),grant,value);
  if(!live())return;
  const result=await request<DelegateSubmissionResult>(value.proof.operation==='approve'?'delegate/activate':'delegate/revoke-submit',{grantId:grant.id,preparationId:value.proof.preparationId,signedTransactionBase64:value.proof.signedTransactionBase64},{expectedOwner:principal});
  await verifyDelegateGrant(result.config??delegateGrantConfig(result.grant,config),result.grant,owner);
  if(result.grant.id!==grant.id||result.grant.commitmentHash!==grant.commitmentHash)throw new Error('The confirmation returned a different allowance.');
  if(!live())return;
  const observed=latestGrants.current.find(g=>g.id===grant.id);
  if(value.proof.operation==='approve'&&observed&&!['draft','prepared','activation_pending'].includes(observed.status))return {...result,grant:observed};
  if(value.proof.operation==='approve'&&result.approvalRequired===true)result.grant={...result.grant,approvalRequired:true,approvalStatus:result.approvalStatus,reason:result.reason,code:result.code};
  update(result.grant,result.config);
  if(result.grant.status==='active'||result.grant.status==='revoked')setReviews(previous=>{const next={...previous};delete next[grant.id];return next;});
  setNotice(result.grant.status==='active'?'Shared allowance active. Agent requests still pass this policy.':result.grant.status==='revoked'?'Grant closed. Earlier signed payments retain their settlement status.':result.grant.status==='failed'?'':'Signed transaction retained. Confirmation is being checked automatically.');
  return result;
 }
 async function sign(grant:DelegateGrant){
  const review=reviews[grant.id];if(!review||proof(grant,review.action)||proofError(grant,review.action))return;
  if(review.action==='revoke'&&stopConflicts[grant.id])throw new Error('The source allowance changed. Check the current allowance before signing its revocation.');
  const cfg=delegateGrantConfig(grant,config);
  if(review.action==='approve'&&(!grantReady(grant)||!c.selected||view(c.selected).error||view(c.selected).grant?.id!==grant.id))throw new Error('The selected policy or funding configuration changed.');
  return run('sign',async live=>{
   const value=await withAllowanceSigningLock(grant.displayNetwork,owner,async()=>{
   if(!live())return;
   if(readAllowanceRecovery(owner,grant.displayNetwork,grant.sourceAccount,principal))throw new Error('A signed account revocation remains saved. Check its exact transaction before signing another allowance change.');
   const saved=readDelegateProof(cfg,grant,review.action,principal);
   if(saved){proofMemory.current.set(proofKey(grant,review.action),saved);renderProofs(n=>n+1);throw new Error('An original signed proof is already saved. Check that exact transaction.');}
   checkDelegateProofNotArchived(grant,review.action,review.preparation.preparationId);
   checkDelegateProofStorage();
   const value:SavedDelegateProof={preparation:review.preparation,proof:await signDelegateOwner(cfg,grant,owner,review.action,review.preparation,live),scope:{principal,policyId:grant.policyId,revision:grant.revision,sourceHash:grant.sourceHash,irHash:grant.irHash,commitmentHash:grant.commitmentHash}};
   proofMemory.current.set(proofKey(grant,review.action),value);renderProofs(n=>n+1);
   saveDelegateProof(grant,value);
   if(!live())throw new Error('The session or policy changed. The original signed proof is retained; it was not submitted.');
   return value;
   });
   if(value&&live())await submitInternal(grant,value,live);
  },review.action==='approve');
 }
 const returned=(grant:DelegateGrant,value:{grant?:DelegateGrant;config?:DelegateConfig}|null,pending:boolean)=>{
  if(value?.grant)update(value.grant,value.config);
  setReturns(previous=>{if(pending)return previous;const next={...previous};delete next[grant.id];return next;});
  setNotice(pending?'Return submitted. Check it again in a moment.':'USDC returned to your main USDC account. The policy token account is closed.');
 };
 async function checkedReturnResult(grant:DelegateGrant,value:{grant?:DelegateGrant;config?:DelegateConfig}){
  if(!value.grant)throw new Error('The return response omitted its grant.');
  await verifyDelegateGrant(value.config??delegateGrantConfig(value.grant,config),value.grant,owner);
  if(value.grant.id!==grant.id||value.grant.commitmentHash!==grant.commitmentHash)throw new Error('The return response belongs to another allowance.');
 }
 /** Prepare the owner-only return of a revoked policy account's remaining USDC. */
 const prepareReturn=(grant:DelegateGrant)=>run('return',async live=>{
  const v=await request<Partial<DelegateReturnPreparation>&{grant?:DelegateGrant;config?:DelegateConfig;returned?:boolean}>('delegate/return',{grantId:grant.id},{expectedOwner:principal});
  await checkedReturnResult(grant,v);
  if(!live())return;
  if(v.returned===true){returned(grant,v,false);return;}
  const cfg=v.config??delegateGrantConfig(grant,config),preparation=v as DelegateReturnPreparation;
  checkedReturnTransaction(cfg,v.grant??grant,owner,preparation,proof(grant,'approve')?.preparation.feePayer);
  update(v.grant??grant,v.config);setReturns(previous=>({...previous,[grant.id]:{grantId:grant.id,preparation}}));
 });
 const submitReturn=async(grant:DelegateGrant,review:DelegateReturnReview,signedTransactionBase64:string,live:()=>boolean)=>{
  const result=await request<{grant?:DelegateGrant;config?:DelegateConfig;returned?:boolean;pending?:boolean}>('delegate/return-submit',{grantId:grant.id,preparationId:review.preparation.preparationId,signedTransactionBase64},{expectedOwner:principal});
  await checkedReturnResult(grant,result);
  if(live())returned(grant,result,result.returned!==true);
 };
 const signReturn=(grant:DelegateGrant)=>{
  const review=returns[grant.id];if(!review)return Promise.resolve(false);
  return run('sign-return',async live=>{
   const signed=review.signedTransactionBase64??(await signDelegateReturn(delegateGrantConfig(grant,config),grant,owner,review.preparation,live,proof(grant,'approve')?.preparation.feePayer)).signedTransactionBase64;
   setReturns(previous=>({...previous,[grant.id]:{...review,signedTransactionBase64:signed}}));
   if(!live())throw new Error('The session or policy changed. The signed return was not submitted.');
   await submitReturn(grant,review,signed,live);
  });
 };
 const check=(grant:DelegateGrant,action:'approve'|'revoke')=>run('check',async live=>{const value=proof(grant,action);if(!value)throw new Error('The original signed proof is unavailable on this device. Check the retained grant with the server.');await submitInternal(grant,value,live);});
 // New delegated child grants are retired: each would spend with a server-derived key. New agents use native vaults.
 const answerUnavailableReason=(q:DelegatePendingRequest)=>{
  let id:string|null=q.grantId;const seen=new Set<string>();
  while(id&&!seen.has(id)){seen.add(id);const g=grants.find(grant=>grant.id===id);if(!g)return 'This grant is unavailable. Refresh requests before answering.';if(g.status!=='active')return 'Agent access is stopped for this request.';if(g.expiresAt*1000<=Date.now())return 'This grant has expired.';if(!grantReady(g))return 'Payment setup is unavailable. Refresh its status before approving.';id=g.parentGrantId;}
  return id===null&&seen.size>0?null:'The grant path could not be verified.';
 };
 const canAnswer=(q:DelegatePendingRequest)=>answerUnavailableReason(q)===null;
 const answer=(q:DelegatePendingRequest,e:DelegateEvaluation,approved:boolean)=>run('answer',async live=>{
  if(!e.decision.input_key||e.decision.outcome!=='awaiting_input'||e.answer||approved&&!canAnswer(q))throw new Error('This question cannot admit a payment now.');
  try{
   const result=await request<{answerSaved?:boolean;continuation?:DelegateRequestReason}>('delegate/answer',{grantId:q.grantId,requestId:q.requestId,evaluationGrantId:e.grantId,actionHash:q.actionHash,contextHash:e.contextHash,inputKey:e.decision.input_key,approved},{expectedOwner:principal});
   if(live()&&result.answerSaved)setNotice(result.continuation?.status==='blocked'?`Your answer was saved. ${result.continuation.reason}`:'Your answer was saved.');
  }finally{
   // An answer may already be durable even when its continuation or HTTP response fails.
   const earlierRefresh=refreshInFlight.current.get(refreshKey);
   if(earlierRefresh)await earlierRefresh.catch(()=>{});
   if(live())await refresh().catch(error=>{if(live())setData(previous=>previous.sessionKey===sessionKey?{...previous,requestError:error instanceof Error?error.message:'Owner questions could not be refreshed.'}:previous);});
  }
 },true);
 const roots=grants.filter(g=>g.parentGrantId===null);
 const retained=roots.filter(g=>!delegateTerminal(g));
 /** Called only inside useMicro's already-held Stop all lock; no nested run can skip these barriers. */
 async function stopAllWithin(controllerCurrent:()=>boolean,deferredCleanup?:Array<()=>Promise<void>>):Promise<DelegateStopOutcome>{
  rootPrompt.invalidate();
  requestVersion.current++;
  const scope={sessionKey,generation:identity.current.generation},live=()=>controllerCurrent()&&current(scope);
  const unresolved=new Set(retained.map(grant=>grant.id));
  if(!loaded)return {failures:['Every retained delegated grant must be read before its stop can be confirmed.'],unresolvedGrantIds:[...unresolved]};
  const failures:string[]=active?.error?[active.error]:[];
  const afterStops=deferredCleanup??[];
  for(const grant of retained){if(!live()){failures.push('The owner session changed during Stop all.');break;}try{if(await prepareInternal(grant,'revoke',live,afterStops)&&live())unresolved.delete(grant.id);}catch(error){failures.push(`${grant.id}: ${error instanceof Error?error.message:'Stop could not be confirmed'}`);}}
  // A cross-profile caller runs cleanup only after every server admission barrier.
  if(!deferredCleanup)for(const finish of afterStops){try{await finish();}catch(error){failures.push(error instanceof Error?error.message:'The retained proof could not be archived');}}
  if(live())setNotice(unresolved.size||failures.length?'Retained grants still need checking. Keep their original proofs and review the status below.':'Retained grants are stopped. Earlier signed payments remain recorded.');
  return {failures,unresolvedGrantIds:[...unresolved]};
 }
 const selectedView=c.selected?view(c.selected):null;
 const approvalGrant=selectedView&&!selectedView.error&&selectedView.grant?.parentGrantId===null?selectedView.grant:null;
 const savedApproval=approvalGrant?proof(approvalGrant,'approve'):null;
 const approvalKey=approvalGrant&&savedApproval?JSON.stringify([sessionKey,selection,approvalGrant.id,approvalGrant.commitmentHash,savedApproval.preparation.preparationId,savedApproval.proof.signature]):'';
 const approvalAvailable=approvalGrant?grantReady(approvalGrant)&&approvalGrant.approvalStatus!=='unknown':false;
 const approvalInput=useRef({key:approvalKey,grant:approvalGrant,ready:approvalAvailable,controller:c});
 approvalInput.current={key:approvalKey,grant:approvalGrant,ready:approvalAvailable,controller:c};
 useEffect(()=>{
  if(!approvalKey||!approvalGrant||!savedApproval||!['draft','prepared','activation_pending'].includes(approvalGrant.status))return;
  let attached=true;
  const scope={sessionKey,selection,generation:identity.current.generation};
  // An exact response may still reconcile the same mounted scope after StrictMode effect replay.
  const sameScope=()=>current(scope)&&approvalInput.current.key===approvalKey;
  let budget=approvalBudgets.current.get(approvalKey);if(!budget){budget={attempts:0};approvalBudgets.current.set(approvalKey,budget);}
  void reconcileSavedApproval({proof:savedApproval,budget,isCurrent:()=>attached&&sameScope(),onState:state=>setApprovalState({...state,key:approvalKey,grantId:approvalGrant.id}),submit:async value=>{
   const input=approvalInput.current,g=input.grant;
   if(!sameScope()||!g)return {status:'deferred',message:''};
   if(g.status==='active')return {status:'active',message:'Shared allowance active. Agent requests still pass this policy.'};
   if(!['draft','prepared','activation_pending'].includes(g.status))return {status:'failed',message:g.reason??'The original approval is no longer pending. Its signed proof is retained. Nothing new was signed.'};
   if(!input.ready)return {status:'unavailable',message:'Approval checking is unavailable for this payment configuration. The original signed proof is retained; wallet status continues to refresh automatically.'};
   if(localLock.current||!input.controller.runExternal)return {status:'deferred',message:''};
   let outcome:ApprovalOutcome={status:'deferred',message:''},failure:unknown;
   localLock.current=true;
   try{
    await input.controller.runExternal('delegate:check',async controllerCurrent=>{
     const live=()=>controllerCurrent()&&sameScope()&&approvalInput.current.ready;
     if(!live())return;
     requestVersion.current++;
     try{
      const result=await submitInternal(g,value,live);if(!result)return;
      outcome=result.grant.status==='active'?{status:'active',message:'Shared allowance active. Agent requests still pass this policy.'}
       :result.grant.status==='failed'||result.approvalRequired===true?{status:'failed',message:result.reason??result.grant.reason??'The original approval could not complete. Its signed proof is retained. Nothing new was signed.'}
       :{status:'pending',message:result.reason??'Waiting for the original approval to be confirmed. No new wallet signature is needed.'};
     }catch(error){failure=error;}
    });
   }finally{localLock.current=false;}
   if(failure)throw failure;
   // Refresh the durable policy only after releasing the controller's owner-operation lock.
   if(outcome.status==='active'&&sameScope())await approvalInput.current.controller.refresh().catch(()=>{});
   return outcome;
  }});
  return()=>{attached=false;};
 // Identity is scalar; refreshed grant objects cannot reset the proof's bounded retry budget.
 },[approvalKey,approvalAvailable]);
 const approvalReconciliation=approvalGrant?.status==='active'?null:approvalGrant?.approvalStatus==='unknown'
  ?{grantId:approvalGrant.id,status:'unavailable' as const,message:approvalGrant.reason??'The original approval history is unavailable. Restore it before continuing.'}:approvalGrant&&savedApproval&&approvalGrant.status==='failed'
  ?{grantId:approvalGrant.id,status:'failed' as const,message:approvalGrant.reason??'The original approval could not complete. Its signed proof is retained. Nothing new was signed.'}
  :approvalState?.key===approvalKey?approvalState:null;
 const promptGrant=selectedView?.ready&&selectedView.grant?.parentGrantId===null?selectedView.grant:null;
 const promptScope={sessionKey,selection,generation:identity.current.generation};
 const promptKey=promptGrant?JSON.stringify([sessionKey,selection,c.network,identity.current.generation,promptGrant.id,promptGrant.commitmentHash]):'';
 const rootPrompt=useDelegateRootPrompt({key:promptKey,grant:promptGrant,config:promptGrant?delegateGrantConfig(promptGrant,config):null,principal,isCurrent:()=>!!promptGrant&&current(promptScope)&&grantReady(promptGrant)&&promptGrant.status==='active'&&promptGrant.expiresAt*1000>Date.now()});
 return {owner,principal,config,grants,roots,retained,loaded,paymentReady,allowanceConflict,dismissAllowanceConflict:()=>setConflictState(null),stopConflicts,error:active?.error??null,requestError:active?.requestError??null,requests:active?.requests??[],answeredRequests:active?.answeredRequests??[],closedRequests:active?.closedRequests??[],pending,busy:!!pending||!!c.busy||!!c.auth.busy,notice,reviews,returns,prepareReturn,signReturn,view,proof,proofError,create,prepare,sign,check,answer,canAnswer,answerUnavailableReason,stopAllWithin,runAllowance,allowanceChanged,refresh:()=>run('refresh',async()=>{await refresh();}),approvalReconciliation,capability:capability?.sessionKey===sessionKey&&capability.selection===selection?capability:null,capabilityCurrent:()=>!!capability&&current(capability),hideCapability:()=>setCapability(null),rootPrompt:rootPrompt.prompt,rootPromptCurrent:rootPrompt.isCurrent,retryRootPrompt:rootPrompt.retry};
}
export type DelegateWorkspace=ReturnType<typeof useDelegateWorkspace>;
