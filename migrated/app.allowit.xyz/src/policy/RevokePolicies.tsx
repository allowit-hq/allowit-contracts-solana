import {useEffect,useId,useRef,useState} from 'react';
import type {MicroController} from '../micro/micro-contracts';
import {delegatedNetworks,hasDelegatedAuthority,revocable} from '../runtime/runtime';
import type {DelegateWorkspace} from '../delegate/useDelegateWorkspace';
import {DelegateRecovery,DelegateWalletRecovery} from '../delegate/DelegateSections';
import {request} from '../api';
import {bindSelectedPolicy,hasNativeAttachment,loadNativeSupport,sessionOwner} from '../native-vault/native-bound';
import {createNativeOwnerContext} from '../native-vault/native-owner-context';
import {returnNativeBatch,returnSummary as refundSummary,type ReturnProgress as Returns} from '../native-vault/native-return';
import {totalRemaining} from '../native-vault/native-withdraw';
import {nativeVaultChanged} from '../native-vault/native-vault-list';
import './revoke-policies.css';

/** `onRevoke` removes confirmed closed policies from this device's list. Server history remains available. */
/** `returned` holds native policies whose USDC is already back; they have nothing left to revoke. */
export default function RevokePolicies({c,delegated,onRevoke,returned}:{c:MicroController;delegated?:DelegateWorkspace;onRevoke?:(ids:string[])=>void;returned?:ReadonlySet<string>}){
 const owner=c.auth.session?.address??'';
 const [open,setOpen]=useState(false),[started,setStarted]=useState(false);
 const [stopping,setStopping]=useState(false),[stopConfirmed,setStopConfirmed]=useState(false),[stopError,setStopError]=useState(''),[stopOnlyCompleted,setStopOnlyCompleted]=useState(false);
 const [returns,setReturns]=useState<Returns|null>(null),[finished,setFinished]=useState(false);
 const [reviewReady,setReviewReady]=useState(false),[barrierFailures,setBarrierFailures]=useState<{grantId?:string;message:string;reviewId?:string;signature?:string}[]>([]),[recoveryError,setRecoveryError]=useState('');
 const [stopGrantIds,setStopGrantIds]=useState<string[]>([]);
 const [stoppedWork,setStoppedWork]=useState<ReadonlySet<string>|null>(null);
 const [accountChecks,setAccountChecks]=useState<Record<string,{complete:boolean;pending:boolean;allowancePresent:boolean}>>({});
 const [stopPolicyIds,setStopPolicyIds]=useState<string[]>([]);
 // Remaining USDC across native vaults, read when the dialog opens. Unreadable vaults are counted separately, never guessed.
 const [remainingFunds,setRemainingFunds]=useState<{total:string;unread:number}|null>(null);
 const sessionScope=c.auth.session?sessionOwner(c.auth.session):'';
 const scopeRef=useRef(sessionScope);scopeRef.current=sessionScope;
 const openRef=useRef(open);openRef.current=open;
 const trigger=useRef<HTMLButtonElement>(null),dialog=useRef<HTMLDialogElement>(null);
 const submitting=useRef(false);
 const mounted=useRef(true);
 const id=useId();
 const native=c.policies.filter(p=>hasNativeAttachment(p)&&!returned?.has(p.id));
 const remaining=c.policies.filter(p=>p.status!=='cancelled'&&revocable(p));
 // A contract wallet has no allowance to revoke here; it is listed, never acted on.
 const excluded=c.policies.filter(p=>p.status!=='cancelled'&&!hasNativeAttachment(p)&&!hasDelegatedAuthority(p)&&!revocable(p)).length;
 const retained=delegated?.retained??[];
 const recoveryNetworks=delegated?.owner?[...new Set([...retained.map(g=>g.displayNetwork),...c.policies.filter(hasDelegatedAuthority).map(p=>p.network),...delegatedNetworks(c.runtimeConfig)].filter(network=>network==='solana:mainnet'||network==='solana:devnet'))]:[];
 const accountOutstanding=recoveryNetworks.some(network=>!accountChecks[network]?.complete);
 const delegatedOutstanding=!!delegated&&(accountOutstanding||retained.length>0||!!delegated.error||!delegated.loaded&&c.policies.some(hasDelegatedAuthority));
 const recoveryKey=JSON.stringify(retained.map(g=>[g.id,g.status,delegated?.reviews[g.id]?.preparation.preparationId,delegated?.proof(g,'revoke')?.proof.signature]));
 const liveBarrierFailures=barrierFailures.filter(failure=>!failure.grantId||retained.some(g=>g.id===failure.grantId&&!(delegated?.reviews[g.id]?.action==='revoke'&&delegated.reviews[g.id]?.preparation.preparationId!==failure.reviewId)&&!(delegated?.proof(g,'revoke')&&delegated.proof(g,'revoke')?.proof.signature!==failure.signature)));
 const visibleError=[...liveBarrierFailures.map(failure=>failure.message),stopError,recoveryError].filter(Boolean).join(' · ');
 const delegatedDone=delegated?.roots.filter(g=>stopGrantIds.includes(g.id)&&g.status==='revoked').length??0;
 const delegatedTotal=delegatedDone+retained.length;
 const legacyRemaining=remaining.filter(p=>!hasDelegatedAuthority(p));
 const legacyWork=legacyRemaining.filter(p=>!hasNativeAttachment(p));
 const workKeys=[...legacyWork.map(p=>`legacy:${p.id}:${p.revision}`),...native.map(p=>`native:${p.id}:${p.revision}`),...retained.map(g=>`grant:${g.id}`),...c.policies.filter(hasDelegatedAuthority).map(p=>`policy:${p.id}:${p.revision}`),...recoveryNetworks.map(network=>`allowance:${network}`)];
 const addedWork=!!stoppedWork&&workKeys.some(key=>!stoppedWork.has(key));
 const canReview=reviewReady&&!addedWork;
 const completed=finished&&!delegatedOutstanding&&!visibleError&&!addedWork&&!legacyWork.length;
 const scopeCount=legacyRemaining.length+retained.length;
 const state=c.revocation?.owner===owner?c.revocation:null;
 const running=stopping||c.busy==='revoke-all'||!!delegated?.pending;
 const blocked=stopping||!!c.busy||!!c.auth.busy||c.loading||c.auth.loading;
 const result=started?state:null;
 const scopeNetworks=[...legacyRemaining.map(p=>p.network),...retained.map(g=>g.displayNetwork),...recoveryNetworks.filter(network=>!retained.some(g=>g.displayNetwork===network))];
 const networks=[...new Set(scopeNetworks)].map(network=>({
  name:c.networks.find(n=>n.id===network)?.label??network,
  count:scopeNetworks.filter(value=>value===network).length,
 }));
 const local=owner.startsWith('local_');
 useEffect(()=>{setOpen(false);setStarted(false);setStopping(false);setStopConfirmed(false);setStopError('');setStopOnlyCompleted(false);setReturns(null);setFinished(false);setReviewReady(false);setBarrierFailures([]);setRecoveryError('');setStopGrantIds([]);setStoppedWork(null);setAccountChecks({});setStopPolicyIds([]);submitting.current=false;},[sessionScope]);
 useEffect(()=>{if(completed&&stopPolicyIds.length)onRevoke?.(stopPolicyIds);},[completed,stopPolicyIds]);
 useEffect(()=>setRecoveryError(''),[recoveryKey]);
 useEffect(()=>{
  const element=dialog.current;
  if(open&&!element?.open)element?.showModal();
  else if(!open&&element?.open)element.close();
 },[open]);
 useEffect(()=>{mounted.current=true;const element=dialog.current;return()=>{mounted.current=false;element?.close();};},[]);
 useEffect(()=>{
  const session=c.auth.session;
  if(!open||!native.length||!session){setRemainingFunds(null);return;}
  let live=true;
  void (async()=>{
   const balances:(string|null)[]=[];
   try{
    const support=await loadNativeSupport();
    for(const policy of native){
     if(!live)return;
     try{
      const attachment=await bindSelectedPolicy(policy,session,support.config);
      const ctx=createNativeOwnerContext(support.config,attachment,session,()=>live);
      const reply=await ctx.api.state(attachment.policy,attachment.executionBinding.owner);
      balances.push(reply.state?.balance??'0');
     }catch{balances.push(null);}
    }
   }catch{native.forEach(()=>balances.push(null));}
   if(live)setRemainingFunds({total:totalRemaining(balances),unread:balances.filter(b=>b===null).length});
  })();
  return()=>{live=false;};
  // Read once per opening; the list itself refreshes separately.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[open,sessionScope]);
 const close=()=>{if(!running&&!submitting.current)setOpen(false);};
 const closed=()=>{
  setOpen(false);
  const target=trigger.current;
  if(target?.isConnected&&!target.disabled)target.focus();
  else document.getElementById('main')?.focus();
 };
 const submit=async()=>{
  if(submitting.current||blocked||(!remaining.length&&!native.length&&!delegatedOutstanding))return;
  submitting.current=true;
  setStarted(true);setStopError('');setRecoveryError('');setBarrierFailures([]);setFinished(false);setStopping(true);
  setStoppedWork(new Set(workKeys));setReviewReady(false);
  setStopPolicyIds(c.policies.filter(hasDelegatedAuthority).map(p=>p.id));
  setStopGrantIds(previous=>[...new Set([...previous,...retained.map(g=>g.id)])]);
  const scope=sessionScope,session=c.auth.session;
  const active=()=>mounted.current&&scopeRef.current===scope;
  const barrierErrors:string[]=[];
  const rememberBarriers=()=>setBarrierFailures(barrierErrors.map(message=>{const grant=retained.find(g=>message.startsWith(`${g.id}: `));return {grantId:grant?.id,message,reviewId:grant?delegated?.reviews[grant.id]?.preparation.preparationId:undefined,signature:grant?delegated?.proof(grant,'revoke')?.proof.signature:undefined};}));
  try{
   const ok=await c.revokeAll(async controllerCurrent=>{
    const current=()=>active()&&controllerCurrent();
    const assertCurrent=()=>{if(!current())throw new Error('The wallet or workspace changed. Review the remaining returns before retrying.');};
    // Admission barriers for every profile precede every wallet cleanup prompt.
    // An unavailable chain must not prevent later owner grants from being stopped.
    const afterStops:Array<()=>Promise<void>>=[];
    if(delegatedOutstanding&&delegated){const outcome=await delegated.stopAllWithin(current,afterStops);barrierErrors.push(...outcome.failures);}
    let nativeStopped=false;
    if(native.length){
     if(!scope||!session)throw new Error('Sign in with the native policy owner.');
     try{
     const reply=await request<{stopped:boolean;revocationStarted:boolean;policyIds:string[]}>('native/stop-all',{}, {expectedOwner:scope});
     assertCurrent();
     if(reply.stopped!==true||reply.revocationStarted!==true||!Array.isArray(reply.policyIds)||reply.policyIds.some(id=>typeof id!=='string'||!/^[0-9a-f]{64}$/.test(id))||native.some(p=>!reply.policyIds.includes(p.nativeExecution!.policyId)))throw new Error('The server did not confirm every native spending barrier. Retry and check the policy cards.');
     setStopConfirmed(true);
     nativeStopped=true;
     }catch(error){barrierErrors.push(error instanceof Error?error.message:'Native server admission could not be confirmed.');}
    }
    // This existing endpoint clears each legacy capability before its RPC preparation.
    // Keep its original pending transaction/recovery protocol; no signature is requested here.
    if(delegatedOutstanding)for(const policy of remaining.filter(p=>!hasNativeAttachment(p))){
     assertCurrent();
     try{await request(c.network==='local:dev'?'local/micro/allocation/cancel':'micro/allocation/cancel',{id:policy.id,revision:policy.revision},{expectedOwner:scope});}
     catch(error){barrierErrors.push(error instanceof Error?error.message:`The stop for ${policy.title} could not be confirmed.`);}
    }
    // Proof archival may wait for another tab's wallet. Every server stop request has already been attempted.
    for(const finish of afterStops){assertCurrent();try{await finish();}catch(error){barrierErrors.push(error instanceof Error?error.message:'The retained proof could not be archived.');}}
    rememberBarriers();
    assertCurrent();setReviewReady(true);
    if(native.length&&!nativeStopped)throw new Error(barrierErrors.join(' · '));
    if(native.length&&nativeStopped){
     if(!session)throw new Error('Reconnect the native policy owner before returning funds.');
     await c.refresh();assertCurrent();
     const support=await loadNativeSupport();assertCurrent();
     if(!support.revokeAndReturnFunds)throw new Error('Server spending is stopped. Returning USDC is unavailable on this server; check the vaults on their policy cards.');
     await returnNativeBatch(native,{current,progress:setReturns,afterEach:()=>c.refresh(),open:async policy=>{
      const attachment=await bindSelectedPolicy(policy,session,support.config);assertCurrent();
      if(attachment.policy.id!==policy.nativeExecution!.policyId)throw new Error('The native vault binding changed. Check the original policy card.');
      return createNativeOwnerContext(support.config,attachment,session,current);
     }});
    }
    assertCurrent();setStopping(false);
    onRevoke?.(c.policies.filter(p=>!hasNativeAttachment(p)&&!hasDelegatedAuthority(p)&&(p.status==='cancelled'||revocable(p))).map(p=>p.id));
   });
   if(active()&&ok){setFinished(true);setStopOnlyCompleted(!remaining.length);}
  }catch(error){if(active()){const message=error instanceof Error?error.message:'The revocation could not finish.';if(message!==barrierErrors.join(' · '))setStopError(message);}}
  // Some vaults may have returned their funds even if a later one failed.
  finally{if(native.length)nativeVaultChanged();if(active()){setStopping(false);submitting.current=false;}}
 };
 return <div className="revoke-policies">
   <button ref={trigger} type="button" className="revoke-policies-trigger" disabled={blocked||(!remaining.length&&!native.length&&!delegatedOutstanding&&!recoveryNetworks.length)} onClick={()=>{setAccountChecks({});if(!canReview||completed||addedWork){setStarted(false);setStopConfirmed(false);setStopError('');setStopOnlyCompleted(false);setFinished(false);setReturns(null);setReviewReady(false);setBarrierFailures([]);setRecoveryError('');setStopGrantIds([]);setStoppedWork(null);setStopPolicyIds([]);}setOpen(true);}}>
   Stop all policies
  </button>
  {!open&&(state?.message||finished||reviewReady)?<p className="small muted" role="status">{delegatedOutstanding?'Wallet allowances still need checking. Reopen Stop all policies to continue.':completed&&returns?refundSummary(returns):native.length?'Check the policy cards for completed USDC returns.':completed?'Policy cancellation finished.':visibleError||state?.message}</p>:null}
  <dialog ref={dialog} className="revoke-policies-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`}
   onClose={closed} onCancel={event=>{event.preventDefault();close();}}
   onClick={event=>{
    if(event.target!==event.currentTarget)return;
    const bounds=event.currentTarget.getBoundingClientRect();
    if(event.clientX<bounds.left||event.clientX>bounds.right||event.clientY<bounds.top||event.clientY>bounds.bottom)close();
   }}>
   <h2 id={`${id}-title`}>Stop all policies?</h2>
   <p id={`${id}-description`}>{native.length?'Stop agent spending, return each native vault’s remaining USDC to your wallet, and close those vaults. Your wallet confirms each vault separately. Policy history stays available.':delegatedOutstanding?'Stop requests for every retained allowance, then review each token revocation. Tokens remain in your wallet. Policy history stays available.':'Revoke every remaining policy in this workspace, including drafts. Policy history stays available.'}</p>
   <div className="revoke-policies-scope">
    <span className="small muted">{local?'Local workspace':'Wallet'}</span>
    {!local?<span className="mono">{owner}</span>:null}
    {!running&&!completed?<>
     <strong>{retained.length?`${legacyRemaining.length} policies · ${retained.length} retained allowances to check`:delegatedOutstanding?'Retained allowances still need checking':`${scopeCount} ${scopeCount===1?'policy':'policies'} to revoke`}</strong>
     <p className="small muted">{networks.map(n=>`${n.name}: ${n.count}`).join(' · ')}</p>
     {excluded?<p className="small muted">{excluded} {excluded===1?'policy is':'policies are'} not included: {excluded===1?'its wallet does':'their wallets do'} not support revocation here.</p>:null}
    </>:null}
   </div>
   {delegatedOutstanding&&delegated?<><p className="small">{retained.length} retained {retained.length===1?'grant':'grants'} to check, including earlier revisions and policies outside this list. Sign a token revocation only when an allowance remains. Stopped requests alone do not prove an allowance is revoked.</p><DelegateRecovery workspace={delegated} policies={c.policies} all guided accountRecovery reviewReady={canReview} startReview={()=>void submit()} disabled={blocked} raise={setRecoveryError}/></>:null}
   {open&&delegated?recoveryNetworks.map(network=><div className="delegate-question" key={`${sessionScope}:${network}`}><h3>{network==='solana:mainnet'?'Mainnet':'Devnet'} wallet allowance</h3><DelegateWalletRecovery workspace={delegated} network={network} disabled={blocked||!canReview} onStatusChange={snapshot=>{
    if(!openRef.current||scopeRef.current!==sessionScope)return;
    setAccountChecks(previous=>{const old=previous[network];if(snapshot&&old&&old.complete===snapshot.complete&&old.pending===snapshot.pending&&old.allowancePresent===snapshot.allowancePresent)return previous;if(!snapshot){if(!old)return previous;const next={...previous};delete next[network];return next;}return {...previous,[network]:snapshot};});
   }}/></div>):null}
   {native.length?<div className="revoke-policies-scope">
     <strong>{returns?`${returns.returned} of ${returns.total} vault returns finalized`:`${native.length} native ${native.length===1?'vault':'vaults'}`}</strong>
     {!finished?<p className="small" role="status">{remainingFunds?`Remaining to return: ${remainingFunds.total} USDC${remainingFunds.unread?` · ${remainingFunds.unread} ${remainingFunds.unread===1?'vault':'vaults'} could not be read`:''}`:'Reading vault balances…'}</p>:null}
     <p className="small muted">{returns?.currentTitle?`${returns.phase==='signing'?'Confirm in your wallet':returns.phase==='checking'?'Waiting for finality':'Returning USDC'}: ${returns.currentTitle}`:stopConfirmed?'Server spending is stopped. Returns are complete only after their transactions finalize.':'Server spending stops before the first wallet confirmation.'}</p>
    {native.map(policy=><button key={policy.id} type="button" className="link-btn" disabled={running} onClick={()=>{setOpen(false);c.select(policy.id);}}>Review native vault: {policy.title}</button>)}
   </div>:null}
    {visibleError?<p className="field-error" role="alert">{visibleError}</p>:null}
    <p className="small muted">{local?'No wallet signature is needed. This does not affect policies in your wallet workspace.':native.length?'Each native transaction returns the actual remaining USDC to your wallet. If you decline, spending stays stopped and the unfinished return remains available. Legacy allowance revocations may also need a signature.':'Your wallet may ask for a signature on each policy’s network to revoke its allowance. Return remaining funds from each policy’s Stop section.'}</p>
   {running?<div className="revoke-policies-progress" role="status" aria-live="polite">
     <p>{stopping?(returns?'Returning remaining USDC…':'Stopping new requests…'):delegated?.pending?`${delegatedDone} of ${delegatedTotal} retained allowances revoked`:`${state?.completed??0} of ${state?.total??remaining.length} ${native.length?'server policy cancellations completed':'policies revoked'}`}</p>
    <p className="small muted">{delegated?.pending?delegated.pending==='sign'?'Confirm the reviewed token revocation in your wallet.':'Checking the retained token allowance…':state?.currentTitle?`Revoking “${state.currentTitle}”…`:'Preparing revocations…'}</p>
     <progress value={delegated?.pending?delegatedDone:stopping?(returns?.returned??0)+(returns?.unused??0):state?.completed??0} max={Math.max(1,delegated?.pending?delegatedTotal:stopping?native.length:state?.total??remaining.length)} aria-label={delegated?.pending?'Retained allowances revoked':stopping?(native.length?'Vault returns':'Stopping new requests'):native.length?'Server policy cancellations':'Policies revoked'} />
    </div>:delegatedOutstanding&&started?<p className="small" role="status">{delegatedTotal?`${delegatedDone} of ${delegatedTotal} retained allowances revoked. Continue with the wallet allowance checks above.`:'Check the wallet allowance above, including permissions without a saved policy.'}</p>:completed&&returns?<p className="revoke-policies-success" role="status">{refundSummary(returns)} Policy cancellation finished.</p>:completed&&(!native.length||stopOnlyCompleted)?<p className="revoke-policies-success" role="status">Policy cancellation finished.</p>:result?.message&&(result.status==='failed'||!visibleError&&!delegatedOutstanding&&result.status!=='completed')?<p className={result.status==='failed'?'field-error':'revoke-policies-success'} role={result.status==='failed'?'alert':'status'}>{result.message}</p>:null}
    {!running&&started&&!completed&&!visibleError&&c.error&&c.error!==result?.message?<p className="field-error" role="alert">{c.error}</p>:null}
   {!running&&result?.walletRequired?<div className="revoke-policies-reconnect">
    {c.auth.wallets.length?<>
     <p className="small muted">Reconnect using the wallet address shown above, then choose Retry remaining policies.</p>
     <div className="btn-row">{c.auth.wallets.map(wallet=><button key={wallet.name} type="button" className="btn" disabled={blocked} onClick={()=>void c.auth.signIn(wallet.name)}>Reconnect {wallet.name}</button>)}</div>
    </>:<p className="small muted">In Chrome, allow your wallet extension to access this site and reload the page. If the extension is unavailable, open this site in Phantom or Solflare’s browser.</p>}
    {c.auth.error?<p className="field-error" role="alert">{c.auth.error}</p>:null}
    {c.auth.notice?<p className="small muted" role="status">{c.auth.notice}</p>:null}
   </div>:null}
   <div className="btn-row revoke-policies-actions">
    <button type="button" className="btn" autoFocus disabled={running} onClick={close}>{started?'Close':'Keep policies'}</button>
     {!completed&&(!canReview||!delegatedOutstanding||!!visibleError)?<button type="button" className="btn btn-primary btn-danger" disabled={blocked||(!remaining.length&&!native.length&&!delegatedOutstanding)} onClick={()=>void submit()}>
     {stopping?'Stopping…':running?'Revoking…':addedWork?'Stop all policies':result?.status==='failed'||canReview?'Retry remaining policies':'Stop all policies'}
    </button>:null}
   </div>
  </dialog>
 </div>;
}
