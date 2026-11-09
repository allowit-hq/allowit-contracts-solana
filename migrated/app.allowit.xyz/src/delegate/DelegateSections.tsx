import {useEffect,useId,useState} from 'react';
import {Section,Spinner} from '../shell/Shell';
import {maskSecrets} from '../policy/mask-secrets';
import {Check,Copy} from 'lucide-react';
import {rootAgentPrompt} from './delegate-root-access';
import SpendingSetupHead from '../policy/SpendingSetup';
import type {MicroPolicy} from '../micro/micro-contracts';
import {displayDelegateAmount,parseDelegateAmount,type DelegateEvaluation,type DelegateGrant,type DelegatePendingRequest} from './delegate-contracts';
import {delegateBelongsTo,delegateStatus,delegateTerminal} from './delegate-bound';
import {usesPolicyAccount} from './delegate-wallet-intent';
import type {DelegateWorkspace} from './useDelegateWorkspace';
import DelegateAllowanceRecovery from './DelegateAllowanceRecovery';
import {sourceLimit,sourceRecipient} from '../native-vault/native-recipient';
import './delegate.css';
import '../native-vault/native-flow.css';

const amount=(value:string)=>{try{return displayDelegateAmount(value);}catch{return 'Unavailable';}};
const short=(value:string)=>value.length>24?`${value.slice(0,10)}…${value.slice(-8)}`:value;
type Props={workspace:DelegateWorkspace;policy:MicroPolicy;raise:(message:string)=>void};
export function DelegateWalletRecovery({workspace:w,network,disabled=false,onCompleted,onStatusChange,expectedDelegate}:{workspace:DelegateWorkspace;network:string;disabled?:boolean;expectedDelegate?:string;onCompleted?:()=>void;onStatusChange?:(state:{complete:boolean;pending:boolean;allowancePresent:boolean}|null)=>void}){
 if(!w.owner||!['solana:mainnet','solana:devnet'].includes(network))return null;
 return <DelegateAllowanceRecovery owner={w.owner} principal={w.principal} network={network} disabled={disabled||w.busy} expectedDelegate={expectedDelegate} run={w.runAllowance} onChanged={w.allowanceChanged} onCompleted={onCompleted} onStatusChange={onStatusChange}/>;
}
const perform=(work:Promise<unknown>,raise:(message:string)=>void)=>{void work.catch(error=>raise(error instanceof Error?error.message:'The allowance operation could not finish.'));};
export function delegateUsageFraction(grant:DelegateGrant|null){if(!grant)return undefined;const cap=BigInt(grant.budgetUnits),spent=BigInt(grant.spentUnits);return cap>0n?Number((spent>cap?cap:spent)*1_000_000n/cap)/1_000_000:0;}

function AgentPrompt({content,isCurrent,disabled}:{content:string;isCurrent:()=>boolean;disabled:boolean}){
 const [copy,setCopy]=useState<'idle'|'done'|'failed'>('idle'),[reveal,setReveal]=useState(false);
 useEffect(()=>{setCopy('idle');setReveal(false);},[content]);
 useEffect(()=>{if(copy!=='done')return;const timer=setTimeout(()=>setCopy('idle'),2000);return()=>clearTimeout(timer);},[copy]);
 const doCopy=async()=>{if(disabled||!isCurrent())return;try{await navigator.clipboard.writeText(content);if(isCurrent())setCopy('done');}catch{if(isCurrent())setCopy('failed');}};
 return <div className="field" data-testid="delegate-root-prompt"><label htmlFor="delegate-root-prompt">Agent prompt</label>
  <textarea id="delegate-root-prompt" className="mono harness-textarea" readOnly value={reveal?content:maskSecrets(content)} onFocus={event=>event.currentTarget.select()}/>
  <div className="btn-row"><button type="button" className="btn" disabled={disabled} onClick={()=>void doCopy()}>{copy==='done'?<Check size={16} aria-hidden="true"/>:<Copy size={16} aria-hidden="true"/>}{copy==='done'?'Copied':'Copy prompt'}</button>
   <button type="button" className="btn btn-quiet" disabled={disabled} aria-pressed={reveal} onClick={()=>{if(isCurrent())setReveal(value=>!value);}}>{reveal?'Hide access token':'Show access token'}</button>
   <span className="small" role="status">{copy==='failed'?'Copy failed. Show the access token and copy the text above.':copy==='done'?'Prompt copied with its access token.':''}</span></div>
 </div>;
}

/** Public binding facts beside the existing certificate/source, never another policy editor. */
function GrantFacts({grant}:{grant:DelegateGrant}){return <dl className="facts delegate-facts">
 <div><dt>Source token account</dt><dd className="mono">{grant.sourceAccount}</dd></div>
 <div><dt>Delegate</dt><dd className="mono">{grant.delegate}</dd></div>
 <div><dt>Network</dt><dd>{grant.displayNetwork}<span className="small muted delegate-resource">{grant.network}</span></dd></div>
 <div><dt>Revision</dt><dd>{grant.revision} · <span className="mono" title={grant.sourceHash}>{short(grant.sourceHash)}</span></dd></div>
 <div><dt>Grant commitment</dt><dd className="mono">{grant.commitmentHash}</dd></div>
 <div><dt>Expires</dt><dd>{new Date(grant.expiresAt*1000).toLocaleString(undefined,{timeZoneName:'short'})}</dd></div>
 </dl>;}

/** An exact saved proof always wins over a fresh wallet prompt, including after an outage or reload. */
export function DelegateOwnerReview({workspace:w,grant,action,raise,compact=false}:{workspace:DelegateWorkspace;grant:DelegateGrant;action:'approve'|'revoke';raise:(message:string)=>void;compact?:boolean}){
 const [reviewed,setReviewed]=useState(false),review=w.reviews[grant.id],saved=w.proof(grant,action),error=w.proofError(grant,action)??(action==='approve'&&grant.approvalStatus==='unknown'?grant.reason??'The original approval history is unavailable. Restore it before continuing.':null);
 const compactApproval=compact&&action==='approve';
 useEffect(()=>setReviewed(false),[grant.id,review?.preparation.preparationId,action]);
 if(saved)return <div className="stack" data-testid={`delegate-proof-${action}`}>
  <p className="small">{action==='approve'?'Signed approval saved on this device. Only these exact signed bytes are checked; no new wallet signature is needed.':'Signed revocation saved on this device. Check the exact same signed bytes; no new wallet signature is needed.'}</p>
  <p className="mono small" title={saved.proof.signature}>{short(saved.proof.signature)}</p>
  {action==='approve'?<>
   <p className={`small${w.approvalReconciliation?.status==='failed'||w.approvalReconciliation?.status==='unavailable'?' field-error':''}`} role={w.approvalReconciliation?.status==='failed'||w.approvalReconciliation?.status==='unavailable'?'alert':'status'}>{w.approvalReconciliation?.grantId===grant.id?w.approvalReconciliation.message:'Checking the saved approval automatically. No new wallet signature is needed.'}</p>
   {grant.status==='failed'&&grant.approvalRequired?<button type="button" className="btn btn-primary" disabled={w.busy||!w.paymentReady} data-testid="delegate-prepare-approve" onClick={()=>perform(w.prepare(grant,'approve'),raise)}>Review approval</button>:null}
  </>:<button type="button" className="btn" disabled={w.busy} onClick={()=>perform(w.check(grant,action),raise)}>Check saved revocation</button>}
  {action==='approve'&&!w.paymentReady?<button type="button" className="link-btn small" disabled={w.busy} onClick={()=>perform(w.prepare(grant,'revoke'),raise)}>Stop requests and check allowance lifecycle</button>:null}
  {action==='revoke'?<DelegateWalletRecovery workspace={w} network={grant.displayNetwork}/>:null}
 </div>;
 if(error){
  const stop=action==='revoke'||!w.paymentReady||grant.approvalStatus==='unknown',label=stop?'Stop requests and check allowance':'Check original approval with server';
  return <div className="stack"><p className="small field-error" role="alert">{error} The original proof remains retained. Use {label} to check the original policy{stop?' and stop agents':''}{['solana:mainnet','solana:devnet'].includes(grant.displayNetwork)?', or Review and revoke wallet allowance below to review the account.':'.'}</p><div className="btn-row"><button type="button" className="btn" disabled={w.busy} onClick={()=>perform(w.prepare(grant,stop?'revoke':action),raise)}>{label}</button></div><DelegateWalletRecovery workspace={w} network={grant.displayNetwork}/></div>;
 }
 if(!review||review.action!==action)return <div className="stack"><button type="button" className="btn btn-primary" disabled={w.busy||(action==='approve'&&!w.paymentReady)} data-testid={`delegate-prepare-${action}`} onClick={()=>perform(w.prepare(grant,action),raise)}> {w.pending==='prepare'?<Spinner/>:null}{action==='approve'?compactApproval?'Approve and sign once':'Review approval':grant.status==='revocation_pending'?'Review revocation':'Stop requests and review revocation'}</button>{action==='revoke'&&!w.paymentReady?<DelegateWalletRecovery workspace={w} network={grant.displayNetwork}/>:null}</div>;
 const baseFeeLamports=new Set([grant.owner,review.preparation.feePayer,...(review.preparation.memoSigner?[review.preparation.memoSigner]:[])]).size*5_000;
 return <div className="stack" data-testid="delegate-owner-review">
  {!compactApproval?<><p className="small">{action==='approve'?usesPolicyAccount(grant)?`Move ${amount(grant.budgetUnits)} USDC from your main USDC account to this policy's token account and allow this delegate to spend up to ${amount(grant.budgetUnits)} USDC from it.`:`Allow this delegate to spend up to ${amount(grant.budgetUnits)} USDC from this account. No tokens move in this setup transaction.`:'Remove the token delegate from this account. Previously signed payments may still settle; their reservations remain recorded.'}</p>
  <dl className="facts"><div><dt>Network fee payer</dt><dd className="mono">{review.preparation.feePayer}</dd></div><div><dt>Base network fee estimate</dt><dd>{baseFeeLamports/1_000_000_000} SOL</dd></div><div><dt>Memo</dt><dd className="mono">{review.preparation.memo}</dd></div></dl>
  {review.preparation.memoSigner?<p className="small">Additional signature: 0.000005 SOL included in the estimate.</p>:null}
  <label className="delegate-check"><input type="checkbox" checked={reviewed} disabled={w.busy} onChange={e=>setReviewed(e.target.checked)} data-testid="delegate-review-checkbox"/><span>I reviewed this exact policy source, network, account, delegate and {action==='approve'?'shared allowance':'revocation'}.</span></label></>:null}
  <button type="button" className="btn btn-primary" disabled={w.busy||(!compactApproval&&!reviewed)||(action==='approve'&&!w.paymentReady)} data-testid={`delegate-sign-${action}`} onClick={()=>perform(w.sign(grant),raise)}>{w.pending==='sign'?<Spinner/>:null}{w.pending==='sign'?'Waiting for wallet…':action==='approve'?compactApproval?'Approve and sign once':'Sign approval once':'Sign revocation'}</button>
 </div>;
}

export function DelegateBudget({workspace:w,policy,raise,unsaved=false}:Props&{unsaved?:boolean}){
 const formId=useId();
 const [funding,setFunding]=useState(policy.fundingRequest?.amount??'');const v=w.view(policy),g=v.grant;
 useEffect(()=>setFunding(policy.fundingRequest?.amount??''),[policy.id,policy.revision,policy.fundingRequest?.amount]);
 const requested=policy.fundingRequest?.amount??funding;
 const network=g?.displayNetwork??policy.network;
 const networkName=network==='solana:mainnet'?'Solana Mainnet':network==='solana:devnet'?'Solana Devnet':network==='solana:testnet'?'Solana Testnet':'Solana Localnet';
 const tokenName=network==='solana:mainnet'?'USDC':'test USDC';
 const step=v.ready?2:1;
 let recipient:string|undefined,daily:bigint|null=null,actionLimit:bigint|null=null;
 try{recipient=sourceRecipient(policy,undefined,true);}catch{/* An unreadable projection cannot supply a recipient fact. */}
 try{daily=sourceLimit(policy,'set_cap_per_day');}catch{/* Keep the source rule authoritative. */}
 try{actionLimit=sourceLimit(policy,'cap_per_transaction');}catch{/* Keep the source rule authoritative. */}
 const review=g&&w.reviews[g.id]?.action==='approve'?w.reviews[g.id]:null;
 const facts=<dl className="facts">
  <div><dt>Funding</dt><dd>{g?amount(g.budgetUnits):requested||'Not set'} {tokenName}{!g&&policy.fundingRequest?<span className="native-fact-note"> · requested</span>:null}</dd></div>
  <div><dt>{recipient?'Recipient wallet':'Recipient'}</dt><dd className={recipient?'mono':undefined}>{recipient??'Chosen by the service within this policy'}</dd></div>
  <div><dt>Daily limit (UTC day)</dt><dd>{daily!==null?`${amount(daily.toString())} ${tokenName}`:'Checked against this policy'}</dd></div>
  <div><dt>Action limit</dt><dd>{actionLimit!==null?`${amount(actionLimit.toString())} ${tokenName}`:'Checked against this policy'}</dd></div>
  <div><dt>Wallet status</dt><dd role="status" data-testid="delegate-status">{g?delegateStatus(g):'Draft'}</dd></div>
 </dl>;
 return <Section id="p-approve" title="Funding">
  <SpendingSetupHead intro="Set up spending for this policy." network={`${networkName} · ${tokenName}`} currentStep={step}/>
  {!w.loaded?<p className="small" role="status">Checking saved funding…</p>:null}
  {w.error?<p className="small field-error" role="alert">{w.error}</p>:null}
  {v.error?<p className="small field-error" role="alert">{v.error}</p>:null}
  {w.notice?<p className="small" role="status">{w.notice}</p>:null}
  {!w.paymentReady?<p className="small muted">{w.config?.reason??'New approvals and payments are unavailable. Retained allowances can still be checked and revoked.'}</p>:null}
  <div className="native-review"><h3>{v.ready?'Spending setup':'Review before signing'}</h3>
  {g?facts:v.editable?<form id={formId} className="form" onSubmit={e=>{e.preventDefault();try{perform(w.create(policy,parseDelegateAmount(requested)),raise);}catch(error){raise(error instanceof Error?error.message:'Check the funding amount.');}}}>
   {!policy.fundingRequest?<div className="field"><label htmlFor="delegate-funding">Funding amount, {tokenName}</label><input id="delegate-funding" inputMode="decimal" autoComplete="off" value={funding} onChange={e=>setFunding(e.target.value)} disabled={w.busy||!w.paymentReady} required/></div>:null}
   {facts}
   {unsaved?<p className="small">Save or discard workflow changes before signing.</p>:null}
  </form>:facts}
  </div>
  <p className="small muted">{!g||usesPolicyAccount(g)?"Approve once from your wallet. The budget moves to this policy's own token account, which you own. Only payments that pass the policy can spend it.":'Approve policy-checked spending once from your wallet. Tokens stay in your wallet until a payment passes the policy.'}</p>
  <details className="native-details"><summary>Setup details and policy binding</summary>
   {g?<GrantFacts grant={g}/>:<dl className="facts"><div><dt>Policy binding</dt><dd className="mono">Revision {policy.revision} · {policy.sourceHash}</dd></div></dl>}
   {g&&w.proof(g,'approve')?<dl className="facts"><div><dt>Setup transaction</dt><dd className="mono">{w.proof(g,'approve')!.proof.signature}</dd></div></dl>:null}
   {review&&g?<dl className="facts"><div><dt>Network fee payer</dt><dd className="mono">{review.preparation.feePayer}</dd></div><div><dt>Base network fee estimate</dt><dd>{new Set([g.owner,review.preparation.feePayer,...(review.preparation.memoSigner?[review.preparation.memoSigner]:[])]).size*5000/1_000_000_000} SOL</dd></div><div><dt>Memo</dt><dd className="mono">{review.preparation.memo}</dd></div></dl>:null}
   <p className="small muted">Your wallet approval sets the total spending limit. Each payment must also pass the rules in this policy.</p>
  </details>
  <details className="native-details"><summary>Need help with Phantom?</summary><p className="small">{network==='solana:mainnet'?'Choose Solana Mainnet in Phantom before approving.':network==='solana:devnet'?'Enable Testnet Mode in Phantom, then choose Solana Devnet before approving.':'Use the Solana network shown for this policy in your wallet.'} <a href="https://help.phantom.com/articles/use-testnets-in-phantom-5997313271699" target="_blank" rel="noreferrer">Phantom instructions</a></p></details>
  <div className="btn-row native-signing-actions">
   {!g&&v.editable?<button type="submit" form={formId} className="btn btn-primary" disabled={w.busy||!w.paymentReady||!requested||unsaved} data-testid="delegate-save-budget">{w.pending==='create'?<Spinner/>:null}Approve and sign once</button>:null}
   {g&&!v.error&&(['draft','prepared','activation_pending'].includes(g.status)||g.status==='failed'&&!!w.proof(g,'approve'))?<DelegateOwnerReview workspace={w} grant={g} action="approve" raise={raise} compact/>:null}
  </div>
 </Section>;
}

export function DelegateAccess({workspace:w,policy}:Props){
 const v=w.view(policy),g=v.grant;
 if(!g||!v.ready)return null;
 const root=w.rootPrompt?.status==='ready'&&w.rootPrompt.grantId===g.id?w.rootPrompt:null;
 return <Section id="p-handoff" title="Agent access">
  <><p className="small muted">Copy this prompt and send it to your agent.</p>
   {root?.token?<AgentPrompt content={rootAgentPrompt(g,root.token,location.origin)} disabled={w.busy} isCurrent={w.rootPromptCurrent}/>:w.rootPrompt?.status==='error'?<div className="stack"><p className="small field-error" role="alert">{w.rootPrompt.error}</p><button type="button" className="btn" disabled={w.busy} onClick={()=>void w.retryRootPrompt()}>Retry agent prompt</button></div>:<p className="small" role="status">Preparing agent prompt…</p>}
  </>
 </Section>;
}

function Question({workspace:w,q,e,raise}:{workspace:DelegateWorkspace;q:DelegatePendingRequest;e:DelegateEvaluation;raise:(message:string)=>void}){
 const [reviewed,setReviewed]=useState(false);
 const reviewHint=useId(),unavailable=w.answerUnavailableReason(q);
 const grant=w.roots.find(root=>delegateBelongsTo(w.grants,q.grantId,root.id))??w.grants.find(grant=>grant.id===q.grantId);
 return <article className="owner-card stack" tabIndex={-1} aria-label={`Question for request ${q.requestId}`}>
  <div className="owner-card-top"><span className="owner-chip" data-tone="wait">Needs your answer</span><span className="small">{amount(q.amountUnits)} USDC</span></div>
  <p className="small owner-who">{grant?.title??grant?.policyId??'Retained policy'}{grant?<span className="muted"> · revision {grant.revision} · {grant.displayNetwork}</span>:null}</p>
  <h3 className="owner-question">{e.decision.prompt??e.decision.question??'Waiting for verified policy evidence.'}</h3>
  <p className="small">{q.serviceUrl}</p>
  <details className="owner-details"><summary className="small">Request details</summary><dl className="facts"><div><dt>Request</dt><dd className="mono">{q.requestId}</dd></div><div><dt>Action hash</dt><dd className="mono">{q.actionHash}</dd></div><div><dt>Context hash</dt><dd className="mono">{e.contextHash}</dd></div></dl><pre className="mono delegate-context">{JSON.stringify(e.context,null,2)}</pre></details>
  {e.decision.input_key?<><p className="small muted">This answer applies only to this action, policy revision and context. Request content is a claim.</p><label className="delegate-check"><input type="checkbox" checked={reviewed} disabled={w.busy} onChange={event=>setReviewed(event.target.checked)} aria-describedby={reviewHint} data-testid="delegate-question-review"/><span>I reviewed this exact request and runtime context.</span></label><p className="small muted" id={reviewHint}>{unavailable??(!reviewed?'Review this request and check the box to enable an answer.':null)}</p><div className="btn-row"><button type="button" className="btn btn-primary" disabled={w.busy||!!unavailable||!reviewed} onClick={()=>perform(w.answer(q,e,true),raise)}>Approve this request</button><button type="button" className="btn" disabled={w.busy||!reviewed} onClick={()=>perform(w.answer(q,e,false),raise)}>Deny this request</button></div></>:<p className="small muted">Verified evidence is unavailable. This view cannot override the policy.</p>}
 </article>;
}
const delegateQuestions=(w:DelegateWorkspace)=>w.requests.flatMap(q=>q.evaluations.filter(e=>e.decision.outcome==='awaiting_input'&&!e.answer).map(e=>({q,e})));
export const delegatePendingCount=(w:DelegateWorkspace)=>delegateQuestions(w).length;
export const delegateAnsweredCount=(w:DelegateWorkspace)=>w.answeredRequests.reduce((count,q)=>count+q.evaluations.length,0);
/** One owner-wide inbox, including retained grants outside the selected policy. */
export function DelegatePendingRequests({workspace:w,raise}:{workspace:DelegateWorkspace;raise:(message:string)=>void}){
 const questions=delegateQuestions(w);
 return <>{w.notice?<p className="small owner-note" role="status">{w.notice}</p>:null}{questions.length?<ol className="owner-list">{questions.map(({q,e})=><li key={`${q.requestId}:${e.grantId}:${e.contextHash}:${e.decision.input_key}`}><Question workspace={w} q={q} e={e} raise={raise}/></li>)}</ol>:null}</>;
}
function SavedQuestion({workspace:w,q,e,closed=false}:{workspace:DelegateWorkspace;q:DelegatePendingRequest;e:DelegateEvaluation;closed?:boolean}){
 const grant=w.roots.find(root=>delegateBelongsTo(w.grants,q.grantId,root.id))??w.grants.find(grant=>grant.id===q.grantId);
 const explanation=e.continuation?.reason??q.reason?.reason;
 return <article className="owner-card stack" aria-label={`${closed?'Closed':'Answered'} request ${q.requestId}`}>
  <div className="owner-card-top"><span className="owner-chip" data-tone="done">{closed?'Closed':`Answered ${e.answer?.approved?'Yes':'No'}`}</span><span className="small">{amount(q.amountUnits)} USDC</span></div>
  <p className="small owner-who">{grant?.title??grant?.policyId??'Retained policy'}{grant?<span className="muted"> · revision {grant.revision} · {grant.displayNetwork}</span>:null}</p>
  <h3 className="owner-question">{e.decision.prompt??e.decision.question??'Waiting for verified policy evidence.'}</h3>
  <p className="small">{q.serviceUrl}</p>
  {e.answer?<p className="small">Your answer was saved.</p>:null}
  {explanation?<p className="small muted">{explanation}</p>:null}
  <p className="small muted">Payment status: {q.paymentStatus??'unavailable'} · {q.signed?'Signed':'Not signed'}</p>
  <details className="owner-details"><summary className="small">Request details</summary><dl className="facts"><div><dt>Request</dt><dd className="mono">{q.requestId}</dd></div><div><dt>Action hash</dt><dd className="mono">{q.actionHash}</dd></div><div><dt>Context hash</dt><dd className="mono">{e.contextHash}</dd></div></dl><pre className="mono delegate-context">{JSON.stringify(e.context,null,2)}</pre></details>
 </article>;
}
export function DelegateAnsweredRequests({workspace:w}:{workspace:DelegateWorkspace}){
 return w.answeredRequests.length?<ol className="owner-list">{w.answeredRequests.flatMap(q=>q.evaluations.map(e=><li key={`${q.requestId}:${e.grantId}:${e.contextHash}:${e.decision.input_key}`}><SavedQuestion workspace={w} q={q} e={e}/></li>))}</ol>:null;
}
export function DelegateRequestHistory({workspace:w}:{workspace:DelegateWorkspace}){
 const roots=w.roots.filter(root=>root.receipts.length>0);
 return <>{w.closedRequests.length?<ol className="owner-list">{w.closedRequests.flatMap(q=>q.evaluations.map(e=><li key={`${q.requestId}:${e.grantId}:${e.contextHash}:${e.decision.input_key}`}><SavedQuestion workspace={w} q={q} e={e} closed/></li>))}</ol>:null}{roots.length?<div className="stack">{roots.map(root=><article className="owner-card" key={root.id}>
  <h3 className="owner-question">{root.title??root.policyId}</h3><p className="small muted">Revision {root.revision} · {root.displayNetwork}</p>
  <div className="delegate-table-wrap"><table className="delegate-table"><thead><tr><th>USDC</th><th>Status</th><th>Receipt</th></tr></thead><tbody>{root.receipts.map(receipt=><tr key={receipt.id}><td>{amount(receipt.amountUnits)}</td><td>{receipt.status}</td><td className="mono" title={receipt.signature??receipt.id}>{short(receipt.signature??receipt.id)}</td></tr>)}</tbody></table></div>
 </article>)}</div>:null}</>;
}
export function DelegateUsage({workspace:w,policy}:Omit<Props,'raise'>){const g=w.view(policy).grant;if(!g||delegateTerminal(g)||BigInt(g.spentUnits)===0n)return null;return <Section id="p-usage" title="Usage"><div className="stack">
 <p>{amount(g.spentUnits)} of {amount(g.budgetUnits)} USDC settled</p>
 <div className="meter" role="img" aria-label={`${amount(g.spentUnits)} of ${amount(g.budgetUnits)} USDC settled`}><span className="meter-fill" style={{width:`${(delegateUsageFraction(g)??0)*100}%`}}/></div>
 <dl className="facts"><div><dt>Remaining</dt><dd>{amount(g.remainingUnits)} USDC</dd></div><div><dt>Reserved</dt><dd>{amount(g.reservedUnits)} USDC</dd></div></dl>
 </div></Section>;}
/** After revocation, only the owner can move a policy account's USDC: return it and close the account. */
function DelegateReturn({workspace:w,grant:g,raise}:{workspace:DelegateWorkspace;grant:DelegateGrant;raise:(message:string)=>void}){
 const review=w.returns[g.id];
 return <Section id="p-cancel" title="Stop access">
  <>
   <p className="small">Return the remaining USDC to your main USDC account and close this policy's token account.</p>
   {review?<><dl className="facts"><div><dt>Return balance</dt><dd>{amount(review.preparation.returnUnits)} USDC</dd></div><div><dt>Return to</dt><dd className="mono">{review.preparation.fundingAccount}</dd></div></dl>
    <button type="button" className="btn btn-primary" disabled={w.busy} data-testid="delegate-sign-return" onClick={()=>perform(w.signReturn(g),raise)}>{w.pending==='sign-return'?<Spinner/>:null}{w.pending==='sign-return'?'Waiting for wallet…':review.signedTransactionBase64?'Check return':'Sign return'}</button></>
   :<button type="button" className="btn btn-primary" disabled={w.busy} data-testid="delegate-prepare-return" onClick={()=>perform(w.prepareReturn(g),raise)}>{w.pending==='return'?<Spinner/>:null}Return funds</button>}
  </>
 </Section>;
}

export function DelegateStop({workspace:w,policy,raise,requested=false,handled}:Props&{requested?:boolean;handled?:()=>void}){
 const [open,setOpen]=useState(false),g=w.view(policy).grant;
 useEffect(()=>{if(requested){setOpen(true);handled?.();}},[requested,handled]);
 if(g&&g.status==='revoked'&&g.returned!==true&&usesPolicyAccount(g))return <DelegateReturn workspace={w} grant={g} raise={raise}/>;
 if(!g||delegateTerminal(g))return null;
 const recovery=w.proof(g,'approve')||w.proof(g,'revoke')||w.proofError(g,'approve')||w.proofError(g,'revoke');
 if(['draft','prepared'].includes(g.status)&&!requested&&!open&&!recovery)return null;
 return <Section id="p-cancel" title="Stop access">
  <>
   <p className="small">Stop requests from all agents, then revoke the root token allowance. Previously signed payments may still settle.</p>
    {requested||open||g.status==='revocation_pending'||w.reviews[g.id]?.action==='revoke'||w.proof(g,'revoke')?<><GrantFacts grant={g}/><dl className="facts"><div><dt>Agent requests</dt><dd>{g.status==='revocation_pending'?'Stopped':'Not yet stopped'}</dd></div></dl><DelegateOwnerReview workspace={w} grant={g} action="revoke" raise={raise}/></>:<button type="button" className="btn" disabled={w.busy} onClick={()=>setOpen(true)} data-testid="delegate-stop">Stop agent access</button>}
  </>
 </Section>;
}

/** All-owner recovery includes old revisions, missing policies and stopped-but-not-yet-revoked roots. */
export function DelegateRecovery({workspace:w,policies,raise,all=false,guided=false,reviewReady=true,startReview,disabled=false,accountRecovery=false}:{workspace:DelegateWorkspace;policies:MicroPolicy[];raise:(message:string)=>void;all?:boolean;guided?:boolean;reviewReady?:boolean;startReview?:()=>void;disabled?:boolean;accountRecovery?:boolean}){
 const [guidedGrantId,setGuidedGrantId]=useState<string|null>(null),[reviewGrantId,setReviewGrantId]=useState<string|null>(null);
 const roots=w.roots.filter(g=>!delegateTerminal(g)&&(all||!policies.some(p=>p.id===g.policyId&&p.revision===g.revision&&p.delegatedExecution?.grantId===g.id)));
 // Redirect attention only to the exact verified retained root for this token account.
 const conflicts=Object.values(w.stopConflicts??{});
 const blocking=conflicts.flatMap(conflict=>roots.filter(g=>g.id===conflict.blockingGrantId&&g.owner===conflict.owner&&g.network===conflict.network&&g.genesisHash===conflict.genesisHash&&g.mint===conflict.mint&&g.sourceAccount===conflict.sourceAccount&&g.delegate===conflict.currentDelegate));
 const next=roots.find(g=>g.id===reviewGrantId)??blocking[0]??roots.find(g=>g.id===guidedGrantId)??roots[0];
 useEffect(()=>setGuidedGrantId(next?.id??null),[next?.id]);
 const nextConflict=next?w.stopConflicts?.[next.id]:undefined;
 const others=roots.filter(g=>g.id!==next?.id);
 if(!roots.length&&!w.error)return null;
 return <div className="section delegate-recovery" data-testid="delegate-recovery"><h2 className="section-title">Retained wallet allowances</h2>
  {w.error?<p className="small field-error" role="alert">{w.error} Existing authority remains unresolved.</p>:null}
  <p className="small muted">These grants stay visible until the token allowance is revoked and any earlier approval barrier is resolved. Their source snapshots cannot be replaced by a newer policy.</p>
  {guided&&next?<div className="delegate-question" key={next.id}>
   <h3>{next.title??next.policyId} · revision {next.revision} · {delegateStatus(next)}</h3>
   <p className="small" role="status">Next allowance to check · {next.displayNetwork} · {roots.length} remaining. Each wallet action needs your review.</p>
   <p className="small mono">{next.id}</p><GrantFacts grant={next}/>
   {conflicts.filter(conflict=>!blocking.some(g=>g.owner===conflict.owner&&g.network===conflict.network&&g.genesisHash===conflict.genesisHash&&g.mint===conflict.mint&&g.sourceAccount===conflict.sourceAccount&&g.delegate===conflict.currentDelegate)).map((conflict,index)=><p key={index} className="small field-error" role="alert">A different token delegate remains on {conflict.sourceAccount}. Its retained grant could not be verified. Check the original allowance before signing; stopping requests alone does not revoke it.</p>)}
   {accountRecovery&&['solana:mainnet','solana:devnet'].includes(next.displayNetwork)?<p className="small muted">Review this network's wallet allowance below. Earlier policy records remain until their revocation is confirmed.</p>:reviewReady?nextConflict&&!w.proof(next,'revoke')?<button type="button" className="btn" disabled={disabled||w.busy} onClick={()=>perform(w.prepare(next,'revoke'),raise)}>Stop requests and check original allowance</button>:<DelegateOwnerReview workspace={w} grant={next} action="revoke" raise={raise}/>:<button type="button" className="btn btn-primary" disabled={disabled||w.busy} onClick={startReview}>Stop requests and review revocation</button>}
   {others.length?<div className="btn-row">{others.map(g=><button key={g.id} type="button" className="btn" disabled={disabled||w.busy} onClick={()=>setReviewGrantId(g.id)}>Review another allowance: {g.title??g.policyId} · revision {g.revision} · {g.displayNetwork}</button>)}</div>:null}
  </div>:null}
  {(guided?others:roots).map(g=><details key={g.id} className="delegate-question"><summary>{g.title??g.policyId} · revision {g.revision} · {delegateStatus(g)}</summary><p className="small mono">{g.id}</p><GrantFacts grant={g}/>{guided?<p className="small muted">Choose Review another allowance to check this one. Its exact saved proof stays available.</p>:<DelegateOwnerReview workspace={w} grant={g} action="revoke" raise={raise}/>}</details>)}
 </div>;
}
