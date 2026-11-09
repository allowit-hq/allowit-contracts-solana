import {useEffect,useId,useRef,useState} from 'react';
import {observeAllowance,resetAllowanceObservation,withAllowanceSigningLock} from './allowance-coordination';
import {displayDelegateAmount} from './delegate-contracts';
import {
 allowanceRecoveryComplete,archiveResolvedAllowanceRecovery,checkAllowance,inspectAllowance,
 prepareAllowance,readAllowanceRecovery,saveAllowanceRecovery,signAllowance,submitAllowance,
 type AllowanceRecoveryView,type SavedAllowanceRecovery,
} from './allowance-recovery';

export interface AllowanceRecoveryStatus {complete:boolean;pending:boolean;allowancePresent:boolean}
export interface DelegateAllowanceRecoveryProps {
 owner:string;principal:string;network:string;disabled?:boolean;expectedDelegate?:string;
 run:(name:string,work:(current:()=>boolean)=>Promise<void>)=>Promise<boolean>;
 onChanged:()=>Promise<unknown>;onCompleted?:()=>void;
 onStatusChange?:(status:AllowanceRecoveryStatus|null)=>void;
}
const message=(error:unknown)=>error instanceof Error&&error.message?error.message:'The wallet allowance could not be checked.';

/** Account-level recovery never loads, removes or replaces an older grant's signed proof. */
export default function DelegateAllowanceRecovery({owner,principal,network,disabled=false,expectedDelegate,run,onChanged,onCompleted,onStatusChange}:DelegateAllowanceRecoveryProps){
 const scope=`${principal}|${owner}|${network}`;
 const identity=useRef({scope,generation:0});
 if(identity.current.scope!==scope)identity.current={scope,generation:identity.current.generation+1};
 const mounted=useRef(true),acting=useRef(false),actionVersion=useRef(0),memory=useRef(new Map<string,SavedAllowanceRecovery>());
 const panel=useRef<HTMLDivElement>(null),automatic=useRef<{key:string;until:number;attempts:number;paused:boolean}|null>(null);
 const callbacks=useRef({onChanged,onCompleted,onStatusChange});callbacks.current={onChanged,onCompleted,onStatusChange};
 const [state,setState]=useState<{scope:string;view:AllowanceRecoveryView|null}>({scope,view:null});
 const [savedState,setSavedState]=useState<{scope:string;value:SavedAllowanceRecovery|null}>({scope,value:null});
 const [error,setError]=useState(''),[proofError,setProofError]=useState(''),[pending,setPending]=useState(false),[reviewed,setReviewed]=useState(false);
 const [warning,setWarning]=useState('');
 const view=state.scope===scope?state.view:null,saved=savedState.scope===scope?savedState.value:null;
 const complete=!!view&&allowanceRecoveryComplete(view);
 const id=useId();
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;callbacks.current.onStatusChange?.(null);};},[]);
 useEffect(()=>{setState({scope,view:null});setSavedState({scope,value:null});setError('');setProofError('');setWarning('');setReviewed(false);setPending(false);callbacks.current.onStatusChange?.(null);},[scope]);
 useEffect(()=>setReviewed(false),[scope,view?.currentDelegate,view?.preparation?.preparationId]);
 useEffect(()=>{
  callbacks.current.onStatusChange?.(view?{complete,pending:pending||!complete,allowancePresent:view.currentDelegate!==null}:null);
 },[scope,view,complete,pending]);
 const completedScope=useRef('');
 useEffect(()=>{
  if(complete&&completedScope.current!==scope){completedScope.current=scope;callbacks.current.onCompleted?.();}
  else if(!complete&&completedScope.current===scope)completedScope.current='';
 },[complete,scope]);
 const localCurrent=(captured:{scope:string;generation:number})=>mounted.current&&identity.current.scope===captured.scope&&identity.current.generation===captured.generation;
 async function perform(name:string,work:(current:()=>boolean)=>Promise<void>){
  if(acting.current||disabled||!owner||!principal||!['solana:mainnet','solana:devnet'].includes(network))return;
  const background=name==='observe',version=background?actionVersion.current:++actionVersion.current;
  const captured={...identity.current};
  if(!background){acting.current=true;setPending(true);setError('');}
  try{
   await run(`allowance-${name}`,async parentCurrent=>{
    const current=()=>localCurrent(captured)&&parentCurrent()&&version===actionVersion.current;
    if(!current())return;
    try{
     await work(current);
    }catch(failure){if(name!=='observe'){if(current())setError(message(failure));throw failure;}}
   });
  }catch(failure){if(!background&&localCurrent(captured))setError(message(failure));}
  finally{if(!background){acting.current=false;if(localCurrent(captured))setPending(false);}}
 }
 function retained(next:AllowanceRecoveryView):SavedAllowanceRecovery|null {
  const remembered=memory.current.get(scope);
  if(remembered)return remembered;
  return readAllowanceRecovery(owner,network,next.sourceAccount,principal);
 }
 async function refreshWorkspace(current:()=>boolean){
  if(!current())return;
  try{await callbacks.current.onChanged();if(current())setWarning('');}
  catch{if(current())setWarning('The policy list could not be refreshed. The wallet allowance status above remains available; reload the policy list when ready.');}
 }
 async function accept(next:AllowanceRecoveryView,current:()=>boolean):Promise<SavedAllowanceRecovery|null> {
  if(!current())return null;
  setState({scope,view:next});
  let original:SavedAllowanceRecovery|null=null;
  try{
   original=retained(next);
   const archived=original&&await archiveResolvedAllowanceRecovery(original,next);
   if(!current())return null;
   if(archived){memory.current.delete(scope);original=null;}
   setProofError('');
  }catch(failure){if(!current())return null;setProofError(message(failure));}
  if(original)memory.current.set(scope,original);
  setSavedState({scope,value:original});
  return original;
 }
 async function reconcile(next:AllowanceRecoveryView,current:()=>boolean,preparationId?:string):Promise<AllowanceRecoveryView> {
  let latest=next;
  for(let attempt=0;attempt<6&&current()&&!allowanceRecoveryComplete(latest);attempt++){
   if(attempt>0)await new Promise(resolve=>setTimeout(resolve,1500));
   if(!current())break;
   latest=await checkAllowance(owner,network,principal,preparationId??latest.preparation?.preparationId);
   if(!current())break;
   await accept(latest,current);
   if(latest.preparationStatus==='expired'||latest.preparationStatus==='failed'||latest.status==='changed')break;
  }
  if(current())await refreshWorkspace(current);
  return latest;
 }
 const inspect=()=>perform('inspect',async current=>{
  let next=await inspectAllowance(owner,network,principal);
  if(!current())return;
  const original=await accept(next,current);
  if(original||next.preparation||next.currentDelegate===null){
   next=await checkAllowance(owner,network,principal,original?.preparation.preparationId??next.preparation?.preparationId);
   if(!current())return;
   await accept(next,current);await refreshWorkspace(current);
  }
 });
 const check=(background=false)=>{
  if(!background)resetAllowanceObservation(automaticKey);
  if(!background&&automatic.current)automatic.current={...automatic.current,until:Date.now()+180_000,attempts:0,paused:false};
  return perform(background?'observe':'check',async current=>{
   try{
    const read=()=>checkAllowance(owner,network,principal,saved?.preparation.preparationId??view?.preparation?.preparationId);
    const next=await (background?observeAllowance(automaticKey,read):read());
    if(!current())return;
    await accept(next,current);
    if(background)await refreshWorkspace(current);
    else await reconcile(next,current,saved?.preparation.preparationId??next.preparation?.preparationId);
   }catch(failure){
    if(background&&current()&&automatic.current){
     automatic.current.paused=true;
     setWarning('Automatic status checks have paused. Use Check allowance status to continue; no new signature is needed.');
    }
    throw failure;
   }
  });
 };
 const automaticCheck=useRef<()=>Promise<void>>(async()=>{});automaticCheck.current=()=>check(true);
 const needsAutomaticCheck=!!view&&!complete&&(view.status==='submitted'||(view.currentDelegate===null&&view.cleanupPending))
  &&!(view.currentDelegate!==null&&(['expired','failed','changed'].includes(view.status)||['expired','failed'].includes(view.preparationStatus??'')));
 const automaticKey=`${scope}|${saved?.preparation.preparationId??view?.preparation?.preparationId??''}|${saved?.signature??view?.signature??''}`;
 function resetTracking(proof:SavedAllowanceRecovery){resetAllowanceObservation(automaticKey);resetAllowanceObservation(`${scope}|${proof.preparation.preparationId}|${proof.signature}`);automatic.current=null;}
 useEffect(()=>{
  if(!needsAutomaticCheck||disabled||pending)return;
  if(automatic.current?.key!==automaticKey)automatic.current={key:automaticKey,until:Date.now()+180_000,attempts:0,paused:false};
  if(automatic.current.paused)return;
  let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;
  const tick=async()=>{
   if(cancelled||!mounted.current||identity.current.scope!==scope)return;
   const budget=automatic.current;
   if(!budget||budget.key!==automaticKey||budget.paused)return;
   if(budget.attempts>=36||Date.now()>=budget.until){
    budget.paused=true;setWarning('Automatic status checks have paused. Use Check allowance status to continue; no new signature is needed.');return;
   }
   if(document.visibilityState==='visible'&&panel.current?.getClientRects().length&&!acting.current){
    budget.attempts++;
    await automaticCheck.current();
   }
   if(!cancelled&&!budget.paused)timer=setTimeout(()=>void tick(),5000);
  };
  timer=setTimeout(()=>void tick(),5000);
  return()=>{cancelled=true;if(timer)clearTimeout(timer);};
 },[scope,automaticKey,needsAutomaticCheck,disabled,pending]);
 const submitSaved=()=>perform('submit',async current=>{
  if(!saved)throw new Error('No signed revocation is saved on this device. Check server status.');
  const checked=await checkAllowance(owner,network,principal,saved.preparation.preparationId);
  if(!current())return;
  const original=await accept(checked,current);
  if(!original){await refreshWorkspace(current);return;}
  if(checked.currentDelegate!==original.preparation.currentDelegate || ['confirmed','expired','failed'].includes(checked.preparationStatus??'')){
   await reconcile(checked,current,original.preparation.preparationId);return;
  }
  const next=await submitAllowance(original);
  resetTracking(original);
  if(!current())return;
  await accept(next,current);await reconcile(next,current,original.preparation.preparationId);
 });
 const sign=()=>perform('sign',async current=>{
  if(!view||!view.currentDelegate||!reviewed||proofError)throw new Error('Review the current wallet allowance before signing.');
  const result=await withAllowanceSigningLock(network,owner,async()=>{
   if(!current())return null;
   const original=retained(view);
   if(original)throw new Error('A signed revocation is already saved. Check or submit that exact transaction.');
   const next=await prepareAllowance(view,principal);
   if(!current())return;
   setState({scope,view:next});
   const concurrent=retained(next);
   await refreshWorkspace(current);
   if(!current())return;
   if(concurrent)throw new Error('A signed revocation is already saved. Check its exact transaction.');
   if(allowanceRecoveryComplete(next)||next.currentDelegate===null)return {next,value:null};
   if(next.sourceAccount!==view.sourceAccount||next.currentDelegate!==view.currentDelegate
    || next.preparationStatus!=='prepared'||!next.preparation||next.preparation.currentDelegate!==view.currentDelegate){
    setReviewed(false);throw new Error('The allowance changed. Review the current account and delegate before signing.');
   }
   const value=await signAllowance(next.preparation,principal,current);
   // A wallet reply belongs to its original scope even if its view or session has since changed.
   memory.current.set(scope,value);
   if(current())setSavedState({scope,value});
   try{saveAllowanceRecovery(value);}catch(failure){
    if(current())setProofError(`${message(failure)} Keep this page open to retain the exact signed transaction.`);
    throw failure;
   }
   return {next,value};
  });
  if(!result)return;
  const {next,value}=result;
  if(!current()){
   if(value)throw new Error('The owner or network changed. The exact signed revocation is saved; it was not submitted.');
   return;
  }
  if(!value){await accept(next,current);await reconcile(next,current,next.preparation?.preparationId);return;}
  resetTracking(value);
  const submitted=await submitAllowance(value);
  resetTracking(value);
  if(!current())return;
  await accept(submitted,current);await reconcile(submitted,current,value.preparation.preparationId);
 });
 if(!owner||!principal||!['solana:mainnet','solana:devnet'].includes(network))return null;
 const blocked=disabled||pending;
 const submitted=view?.preparationStatus==='submitted'||view?.status==='submitted';
 const changedLivePreparation=view?.preparationStatus==='prepared'&&view.preparation?.currentDelegate!==view.currentDelegate;
 const canSign=!!view?.currentDelegate&&!saved&&!proofError&&!submitted
  &&!changedLivePreparation;
 return <div ref={panel} className="stack" data-testid="delegate-allowance-recovery">
  {!view?<button type="button" className="btn" disabled={blocked} onClick={()=>void inspect()}>{pending?'Checking allowance…':'Review and revoke wallet allowance'}</button>:<>
   <dl className="facts">
    <div><dt>Network</dt><dd>{view.displayNetwork==='solana:mainnet'?'Solana Mainnet':'Solana Devnet'}</dd></div>
    <div><dt>Source token account</dt><dd className="mono">{view.sourceAccount}</dd></div>
    <div><dt>Current delegate</dt><dd className={view.currentDelegate?'mono':undefined}>{view.currentDelegate??'No token allowance remains'}</dd></div>
    <div><dt>Agent requests</dt><dd>{view.stoppedGrantIds.length?`Stopped for ${view.stoppedGrantIds.length} retained ${view.stoppedGrantIds.length===1?'policy':'policies'}`:'Stop not yet confirmed'}</dd></div>
    <div><dt>Wallet balance</dt><dd>{displayDelegateAmount(view.balanceUnits)} USDC</dd></div>
    <div><dt>Remaining allowance</dt><dd>{displayDelegateAmount(view.delegatedUnits)} USDC</dd></div>
    {view.preparation||view.currentDelegate?<div><dt>Base network fee estimate</dt><dd>{(view.preparation?.feeLamports??10_000)/1_000_000_000} SOL</dd></div>:null}
   </dl>
   {view.currentDelegate?<p className="small">Remove the current spending permission from this USDC account, including an allowance created by another app. This stops every policy using that allowance. Tokens remain in your wallet.</p>:null}
   {expectedDelegate&&view.currentDelegate&&view.currentDelegate!==expectedDelegate?<p className="small field-error" role="status">The current delegate differs from the earlier policy. Review the address above before revoking it.</p>:null}
   {view.reason?<p className="small" role="status">{view.reason}</p>:null}
   {complete?<p className="small" role="status">The wallet allowance is closed. Your tokens remain in your wallet. Return to your new policy when ready.</p>:view.cleanupPending||view.pendingGrantIds.length?<p className="small" role="status">Owner transactions still need confirmation. These policies stay listed until each transaction confirms or fails.</p>:null}
   {saved?<><p className="small" role="status">{saved.preparation.currentDelegate!==view?.currentDelegate?'The saved revocation was signed for the earlier delegate. Use Check allowance status. This app will not submit it after the delegate changes. After its outcome is verified, check again to review the current delegate.':'The exact signed revocation is saved. Check or submit the same transaction; no new signature is needed.'}</p><p className="small mono tempo-wrap">{saved.signature}</p></>:null}
   {canSign?<label className="delegate-check"><input id={`${id}-review`} type="checkbox" checked={reviewed} disabled={blocked} onChange={event=>setReviewed(event.target.checked)}/><span>I reviewed this network, account and delegate and want to remove this spending permission.</span></label>:null}
   <div className="btn-row">
    {canSign?<button type="button" className="btn btn-primary" disabled={blocked||!reviewed} onClick={()=>void sign()}>{pending?'Waiting for wallet…':'Sign revocation'}</button>:null}
    {saved&&view.currentDelegate===saved.preparation.currentDelegate&&!['confirmed','expired','failed'].includes(view.preparationStatus??'')?<button type="button" className="btn btn-primary" disabled={blocked} onClick={()=>void submitSaved()}>Submit saved revocation</button>:null}
    <button type="button" className="btn" disabled={blocked} onClick={()=>void check()}>{pending?'Checking…':'Check allowance status'}</button>
   </div>
  </>}
  {proofError?<p className="small field-error" role="alert">{proofError}</p>:null}
  {warning?<p className="small field-error" role="status">{warning}</p>:null}
  {error?<p className="small field-error" role="alert">{error}</p>:null}
 </div>;
}
