import type {MicroPolicy} from '../micro/micro-contracts';
import {Section} from '../shell/Shell';
import {useOwnerInboxContext} from '../owner/OwnerApprovalInbox';
import {nativePurchase, nativePurchaseSummary, refKey} from '../owner/owner-requests';

const shortAddress=(s:string)=>s.length>14?`${s.slice(0,6)}…${s.slice(-6)}`:s;

/** This vault's owner questions. They are shown only with questions to answer, or with an error reading them. */
export function useNativeOwnerQuestions(policy:MicroPolicy,vaultId:string|undefined) {
  const inbox=useOwnerInboxContext();
  const items=inbox&&vaultId?inbox.items.filter(item=>item.kind==='native'&&item.policyId===vaultId&&item.scope.executionPolicyId===policy.id):[];
  return {inbox,items,shown:!!inbox&&!!vaultId&&(!!inbox.error||(inbox.loaded&&items.length>0))};
}

/** The existing authenticated inbox opens over this same policy, with its original purchase and signed-answer recovery. */
export default function NativeOwnerQuestions({policy,vaultId,stopped}:{policy:MicroPolicy;vaultId:string;stopped:boolean}) {
  const {inbox,items,shown}=useNativeOwnerQuestions(policy,vaultId);
  if(!inbox||!shown)return null;
  return <Section id="p-owner-questions" title="Owner questions">
    <p className="small muted">Automatic policy passes do not open your wallet. An Ask me result pauses only that purchase for an authenticated answer. Approving signs a message, not a token transfer; other questions and all spending limits still apply.</p>
    {stopped?<p className="small muted">New execution is stopped. An answer cannot bypass revocation.</p>:null}
    {inbox.error?<p className="error-line" role="alert">{inbox.error}</p>:null}
    {items.length?<ul className="activity-list">{items.map(item=>{
      const purchase=nativePurchase(item);
      const exact=item.scope.revision===policy.revision&&item.scope.sourceHash===policy.sourceHash;
      const summary=nativePurchaseSummary(item);
      return <li key={refKey(item)}><p><strong>{purchase?.amount} Devnet USDC</strong> to <span className="mono">{shortAddress(purchase?.recipient??'')}</span>{summary?.task?` · ${summary.task}`:''}</p><p className="small muted">{item.question}</p><p className="small muted">{purchase?.action} · request <span className="mono">{shortAddress(item.requestId)}</span>{item.questionNumber?` · question ${item.questionNumber}`:''} · {inbox.statusOf(item)}</p>
        {!exact?<p className="small muted">This question belongs to a different saved revision. It cannot authorize the current policy.</p>:null}
        <button type="button" className="btn btn-sm" onClick={e=>inbox.openAt(item,e.currentTarget)}>Review original purchase</button>
      </li>;
    })}</ul>:null}
  </Section>;
}
