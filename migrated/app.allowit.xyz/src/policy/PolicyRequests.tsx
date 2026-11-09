import {isStellarPublicNetwork} from '@allowit/engine/stellar/runtime';
import {useEffect, useRef, useState} from 'react';
import {LoaderCircle} from 'lucide-react';
import type {MicroController, MicroPolicy, PolicyRequest, ExecutionPlan, ExecutionCall} from '../micro/micro-contracts';
import {phaseLabel, requestPhase, shortSignature, simulatesAnswers, type RequestPhase} from '../request-status';
import {useOwnerInboxContext} from '../owner/OwnerApprovalInbox';
import type {OwnerRequestRef} from '../owner/owner-requests';
import ProviderFeedback from './ProviderFeedback';
import RequestLanes, {type ReceiptAssets} from './RequestLanes';
import {laneSummary, ownerReference, requestLanes, usesLanes, type Lanes} from '../runtime/request-lanes';
import {fundingPath, isOwnerWallet, runtimeOf} from '../runtime/runtime';

/**
 * Requests an agent made under this policy that need, or have had, the owner's attention.
 * Each row is a real request from the server. A wallet owner answers a question only in the shared owner inbox, with a
 * signed Yes or No for that one question; Local dev records a wallet-free simulated answer instead. Answering only
 * continues the policy check. A request that passes still waits for the owner's wallet to confirm the transfer, and a
 * signature is shown only once the server reports one.
 *
 * Status vocabulary follows request-status.ts. A passed transfer waits for the wallet and no transfer
 * has been sent. Once the wallet returns it has signed and broadcast the transfer, so the row switches
 * to finalizing at once with the signature and never again claims nothing has moved; checking again
 * reuses that signature. Only a finalized transfer counts as spent. ORDER is exhaustive over the status
 * union on purpose: adding a status fails the build until it is placed.
 *
 * Coordinator runs, and every run of a contract-wallet policy, read as three lanes instead (RequestLanes): the policy
 * decision, payment and delivery stay separate, and none of them opens the owner's wallet. A question opens the shared
 * inbox only through the server's explicit owner reference for this exact policy and request.
 *
 * Provider feedback appears only when the server sends a provider candidate and grants feedbackEligible.
 * The reason and status never grant it, and a waiting request never shows it. The server determines
 * eligibility for the current policy lifecycle. The saved value is never optimistic.
 *
 * Once the policy stops (cancelling or cancelled), the server refuses answers and wallet transfers.
 * Waiting questions and unsent transfers then read as no longer available, with the original prompt
 * kept for the record. They were never denied. A transfer the wallet may already have sent still confirms.
 */

interface Props {
  c: MicroController;
  policy: MicroPolicy;
  requests: readonly PolicyRequest[];
  raise: (message: string) => void;
  net: string;
  token: (symbol: string) => string;
  when: (iso: string) => string;
  /** Direct legacy mutations still use the controller's selected policy. */
  controlsAvailable?: boolean;
}

const ORDER: Record<PolicyRequest['status'], number> = {
  evaluating: 1, awaiting_input: 0, ready: 1, submitted: 2, settled: 3, recorded: 3, denied: 3,
  owner_approved: 1, approved: 1, preparing: 2, signed: 2, confirmed: 2, delivering: 2, settlement_unknown: 0, unknown: 0, delivered: 3, failed: 3, expired: 3,
};

function ExecutionDetails({plan,budget}: {plan:ExecutionPlan;budget:string}) {
 const call=(c:ExecutionCall,i:number,phase:string)=><li key={`${phase}-${i}`}>
   <p><span className="muted">Call {i+1}, {phase.toLowerCase()}</span> · <code>{c.method}</code> · {c.maxCostUSDC === '0' ? 'No additional budget' : `Up to ${c.maxCostUSDC} USDC additional`}</p>
   <p className="mono small">Contract: {c.contract}</p>
   <pre className="mono small">{JSON.stringify(c.args,null,2)}</pre>
 </li>;
 return <div className="execution-details">
  <p>{plan.rail==='solana'?'Solana':'Stellar'} · No funds move</p>
  <p className="small muted">Budget charge: {budget} USDC at fixed test rates</p>
  {plan.memo?<p>Memo: {plan.memo}</p>:null}
  {plan.data?<details><summary>Attached data (base64)</summary><pre className="mono small">{plan.data}</pre></details>:null}
  {(plan.before?.length||plan.after?.length)?<ol>{plan.before?.map((c,i)=>call(c,i,'Before transfer'))}{plan.after?.map((c,i)=>call(c,i,'After transfer'))}</ol>:null}
 </div>;
}

/** A request the stopped policy can no longer answer or send: kept for the record, never shown as denied. */
function StoppedNote({request: r}: {request: PolicyRequest}) {
  return r.status === 'awaiting_input' || (r.status === 'denied' && r.prompt) ? (
    <>
      {r.prompt ? <q className="request-prompt">{r.prompt}</q> : null}
      <p className="small muted">This policy stopped before you answered, so this request can no longer be approved or denied. No transfer was sent.</p>
    </>
  ) : (
    <p className="small muted">This request passed the policy, but the policy stopped before a transfer was sent. It cannot start under this policy.</p>
  );
}

export default function PolicyRequests({c, policy, requests, raise, net, token, when, controlsAvailable = true}: Props) {
  const inbox = useOwnerInboxContext();
  const ownerWallet = isOwnerWallet(policy);
  const runtime = runtimeOf(policy);
  // This page prepares no transfer under a budget authorization: native execution is not available here. A saved signature
  // from an earlier transfer is still checked.
  const authorization = fundingPath(policy) === 'authorization';
  // Receipt amounts use only the assets stored with the policy's runtime.
  const assets: ReceiptAssets = runtime.state === 'typed' ? {payment: runtime.runtime.paymentAsset, funding: runtime.runtime.fundingAsset} : {payment: null, funding: null};
  const ref =(r: PolicyRequest): OwnerRequestRef | null => ownerReference(r, policy.id, ownerWallet);
  // Lanes for coordinator runs and for every run of a wallet that is not the owner wallet.
  const lanesOf = new Map<string, Lanes>(requests.filter(r => !ownerWallet || usesLanes(r)).map(r => [r.id, requestLanes(r)]));
  const [pending, setPending] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = async (id: string, fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(id);
    try {
      await fn();
    } catch (e) {
      raise(e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.');
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(null);
    }
  };
  const blocked = !controlsAvailable || pending !== null || Boolean(c.busy) || Boolean(c.auth.busy);
  const actionable = policy.status === 'active';
  // Wallet-free simulated answers: only a local:dev policy in the anonymous local_* workspace. Every other question is
  // answered with a signed owner decision in the shared inbox.
  const local = simulatesAnswers(c.network, c.auth.session?.address, policy.network);
  // A status this client does not know sorts first, with the rows that need attention.
  const order = (r: PolicyRequest) => ORDER[r.status] ?? 0;
  const sorted = [...requests].sort((a, b) => order(a) - order(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const progress = (r: PolicyRequest) => c.txProgress('request', policy.id, r.id);
  const phases = new Map<string, RequestPhase>(requests.map(r => [r.id, lanesOf.has(r.id) ? 'coordinated' : requestPhase(r, progress(r))]));
  const count = (...p: RequestPhase[]) => requests.filter(r => p.includes(phases.get(r.id)!)).length;
  const open = count('answer') + requests.filter(r => lanesOf.get(r.id)?.decision.tone === 'owner').length;
  const unresolved = requests.filter(r => lanesOf.get(r.id)?.unresolved).length;
  // Under a budget authorization an allowed request is not prepared for the wallet on this page.
  const ready = authorization ? count('uncertain', 'signing') : count('wallet', 'uncertain', 'signing');
  const held = authorization ? count('wallet') : 0;
  const submitted = count('finalizing');
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  // A waiting question or an unsent transfer on a stopped policy: kept for the record, not denied.
  // The server closes them as POLICY_REVOKED when cancellation completes; before that they are still waiting or ready.
  const closed = (r: PolicyRequest) => !actionable && (r.status === 'awaiting_input' || phases.get(r.id) === 'wallet' || (r.status === 'denied' && r.decisionCode === 'POLICY_REVOKED'));
  const unavailable = requests.filter(closed).length;
  const confirming = `${plural(submitted, 'transfer is', 'transfers are')} waiting for ${net} to finalize.`;
  const headline = !actionable
    ? unavailable > 0
      ? `This policy stopped, so ${plural(unavailable, 'open request', 'open requests')} can no longer be answered or sent to your wallet.${submitted > 0 ? ` ${confirming}` : ''}`
      : submitted > 0
        ? confirming
        : `${plural(requests.length, 'request', 'requests')} under this policy.`
    : open > 0
      ? `${plural(open, 'request needs', 'requests need')} your answer.`
      : unresolved > 0
        ? `${plural(unresolved, 'payment is', 'payments are')} unresolved.`
      : ready > 0
        ? `${plural(ready, 'transfer is', 'transfers are')} ready for your wallet.`
      : held > 0
        ? `${plural(held, 'allowed request is', 'allowed requests are')} not prepared on this page.`
        : submitted > 0
          ? confirming
          : `${plural(requests.length, 'request', 'requests')} under this policy.`;

  return (
    <div className="stack">
      <p>{headline}</p>
      <ol className="requests">
        {sorted.map(r => {
          const isPending = (k: string) => pending === `${k}:${r.id}`;
          const phase = phases.get(r.id)!;
          const tx = progress(r);
          const signature = tx?.signature || r.signature || '';
          const checking = tx?.phase === 'finalizing' && tx.checking;
          const where = [r.action, r.merchant ? `at ${r.merchant}` : '', r.recipient ? `to ${r.recipient}` : ''].filter(Boolean).join(' ');
          const lanes = lanesOf.get(r.id);
          const summary = lanes ? laneSummary(lanes) : null;
          const owned = ref(r);
          const shut = closed(r);
          if (lanes && summary) return (
            <li className={`request request-${shut ? 'closed' : r.status} request-lanes-row`} key={r.id} data-request-id={r.id} data-tone={summary.tone} tabIndex={-1}>
              <div className="request-top">
                <span className="request-amount num">{r.amount} {token(r.token)}</span>
                <span className="request-status" role="status">{shut ? 'No longer available' : summary.label}</span>
                <span className="request-when num">{when(r.createdAt)}</span>
              </div>
              {where ? <span className="request-where small">{where}</span> : null}
              <RequestLanes request={r} lanes={lanes} contractWallet={!ownerWallet} network={policy.network} policyId={policy.id} load={c.requestDetail} testNetwork={policy.network !== 'solana:mainnet' && !isStellarPublicNetwork(policy.network)} assets={assets} />
              {shut ? <StoppedNote request={r} /> : r.status === 'awaiting_input' ? (
                <>
                  {r.prompt ? <q className="request-prompt">{r.prompt}</q> : null}
                  {r.expiresAt && !Number.isNaN(Date.parse(r.expiresAt)) ? <span className="small muted">{ownerWallet ? `Open until ${when(r.expiresAt)}.` : `Answer and start by ${when(r.expiresAt)}. Expiry is not a No.`}</span> : null}
                  {owned ? (
                    <>
                      {!inbox?.statusOf(owned) ? <p className="small muted">This request is not in your owner list yet. Refresh Requests to check again.</p> : null}
                      <p className="small muted">{inbox?.statusOf(owned) ? `${inbox.statusOf(owned)}. ` : ''}{ownerWallet ? 'Answer with a wallet signature under Requests. Yes approves this request only; a transfer still needs your wallet.' : 'Yes queues one full re-check with only this question answered. If it passes, the agent pays within the signed quote without another signature from you. The answer itself moves no funds.'}</p>
                      <div className="btn-row">
                        <button type="button" className="btn btn-primary" disabled={!inbox?.owner || !actionable || !inbox.statusOf(owned)} onClick={e => inbox?.openAt(owned, e.currentTarget)}>
                          Review and answer
                        </button>
                      </div>
                    </>
                  ) : <p className="small muted">This question is not linked to an owner request yet. It appears under Requests in the header when it can be answered.</p>}
                </>
              ) : null}
              {r.status === 'denied' && r.reason && !shut ? <p className="small request-reason">{r.reason}</p> : null}
            </li>
          );
          return (
            <li className={`request request-${shut ? 'closed' : r.status}`} key={r.id} data-request-id={r.id} tabIndex={-1}>
              <div className="request-top">
                <span className="request-amount num">
                  {r.execution ? `${r.execution.quantity} ${r.execution.asset}` : `${r.amount} ${token(r.token)}`}
                </span>
                <span className="request-status" role="status">{shut ? 'No longer available' : authorization && phase === 'wallet' ? 'Allowed · not prepared here' : phaseLabel(phase, net)}</span>
                <span className="request-when num">{when(r.createdAt)}</span>
              </div>
              {r.execution ? <div className="request-where small"><span>{r.action}{r.merchant?` · ${r.merchant}`:''}</span><p className="mono">To {r.recipient}</p></div> : where ? <span className="request-where small">{where}</span> : null}
              {r.execution?<ExecutionDetails plan={r.execution} budget={r.amount}/>:null}
              {!shut && (phase === 'answer' || phase === 'wallet' || phase === 'uncertain' || phase === 'passed') && r.expiresAt && !Number.isNaN(Date.parse(r.expiresAt)) ? (
                <span className="small muted">Open until {when(r.expiresAt)}.</span>
              ) : null}

              {shut ? <StoppedNote request={r} /> : null}

              {!shut && r.status === 'awaiting_input' ? (
                <>
                  {r.prompt ? <q className="request-prompt">{r.prompt}</q> : null}
                  {policy.network === 'local:dev' ? (
                    local ? (
                      <>
                        <p className="small muted">
                          {r.execution ? 'Approval continues the checks for this action and its calls.' : 'Approval continues the policy check.'} Local dev records your answer as a simulation, with no wallet signature. No funds move.
                        </p>
                        <div className="btn-row">
                          <button type="button" className="btn btn-primary" disabled={blocked || !actionable} onClick={() => run(`approve:${r.id}`, () => c.answerLocal(r.id, true))}>
                            {isPending('approve') ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
                            {isPending('approve') ? 'Approving…' : 'Approve request'}
                          </button>
                          <button type="button" className="btn" disabled={blocked || !actionable} onClick={() => run(`decline:${r.id}`, () => c.answerLocal(r.id, false))}>
                            {isPending('decline') ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
                            {isPending('decline') ? 'Denying…' : 'Deny'}
                          </button>
                        </div>
                      </>
                    ) : (
                      <p className="small muted">Open this request in the Local dev workspace where the policy was created to answer it.</p>
                    )
                  ) : (
                    <>
                      <p className="small muted">
                        {owned && inbox?.statusOf(owned) ? `${inbox.statusOf(owned)}. ` : ''}Answer with a wallet signature under Requests. Yes approves this request only; a transfer still needs your wallet.
                      </p>
                      <div className="btn-row">
                        {/* The same global item as the header inbox, by this row's own policy and request IDs. */}
                        <button type="button" className="btn btn-primary" disabled={!inbox?.owner || !actionable || !owned} onClick={e => owned && inbox?.openAt(owned, e.currentTarget)}>
                          Review and answer
                        </button>
                      </div>
                    </>
                  )}
                </>
              ) : null}

              {shut ? null : phase === 'wallet' && authorization ? (
                <p className="small muted">This page does not prepare transfers for a budget authorization policy. Nothing is signed or sent from here.</p>
              ) : phase === 'wallet' || phase === 'uncertain' || phase === 'signing' ? (
                <>
                  <p className="small muted">
                    {phase === 'uncertain' ? '' : `${r.reason || 'This request is allowed by the policy.'} `}
                    {phase === 'uncertain'
                      ? `Your wallet returned without a signature, so this transfer may have been sent. Check your wallet activity. No new signature is requested while the outcome is unknown; checking again asks ${net} through Allowit and never opens your wallet.`
                      : `No transfer has been sent. Your wallet will ask you to confirm the ${net} transfer.`}
                  </p>
                  <div className="btn-row">
                    <button type="button" className={`btn${phase === 'uncertain' ? '' : ' btn-primary'}`} disabled={blocked || !actionable} onClick={() => run(`execute:${r.id}`, () => c.execute(r.id))}>
                      {phase === 'signing' ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
                      {phase === 'signing' ? 'Opening wallet…' : phase === 'uncertain' ? 'Check again' : 'Review in wallet'}
                    </button>
                  </div>
                </>
              ) : null}

              {phase === 'finalizing' ? (
                <>
                  <p className="small muted">
                    Your wallet signed and sent this transfer. {net} has not finalized it yet, so it may or may not go through.
                    {signature ? (
                      <>
                        {' '}
                        Signature <span className="mono request-signature" title={signature}>{shortSignature(signature)}</span>.
                      </>
                    ) : null}
                  </p>
                  {tx && !tx.checking && tx.message ? <p className="small muted">{tx.message}</p> : null}
                  <div className="btn-row">
                    <button type="button" className="btn" disabled={blocked || !signature} onClick={() => run(`execute:${r.id}`, () => c.execute(r.id))}>
                      {checking ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}
                      {checking ? 'Checking…' : 'Check again'}
                    </button>
                  </div>
                </>
              ) : null}

              {r.status === 'settled' ? (
                <dl className="facts request-facts">
                  <div>
                    <dt>Network</dt>
                    <dd>{net}</dd>
                  </div>
                  <div>
                    <dt>Signature</dt>
                    <dd>{r.signature || 'Not reported'}</dd>
                  </div>
                </dl>
              ) : null}

              {phase === 'passed' ? (
                <p className="small muted">{r.reason || 'This check is allowed by the policy.'} A check on its own does not transfer funds.</p>
              ) : null}
              {r.status === 'denied' && !shut ? <p className="small request-reason">{r.reason || 'The request is denied by this policy.'}</p> : null}
              {r.providerCandidate && r.feedbackEligible === true && r.status !== 'awaiting_input' ? (
                <ProviderFeedback
                  provider={{id: r.providerCandidate.providerId, name: r.providerCandidate.name}}
                  value={r.providerFeedback?.value}
                  disabled={blocked}
                  pending={isPending('feedback')}
                  onFeedback={v => run(`feedback:${r.id}`, () => c.feedback(r.id, v))}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
