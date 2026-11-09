import {LoaderCircle} from 'lucide-react';
import type {MicroController, MicroPolicy} from '../micro/micro-contracts';
import type {ChainConfig} from '../paysh/paysh-contracts';
import {isPayshNetwork} from '../paysh/paysh-contracts';
import {scaled} from '../paysh/paysh-units';
import {depositOf} from '../runtime/deposit';
import {contractSetupPaused,EXECUTION_AUTHORITY, newSetupAllowed, runtimeOf, WALLET_MEANING} from '../runtime/runtime';
import {shortSignature} from '../request-status';
import {TxLink} from './RequestLanes';

/**
 * Contract-wallet funding inside the policy's own Funding step: prepare, review the exact chain terms decoded from the
 * prepared bytes, sign once, then reconcile. A saved signed setup is shown before anything else, and only the same
 * signed bytes can be sent again. The deposit is fixed when the policy is generated.
 */

function duration(seconds: string) {
  const n = BigInt(seconds);
  if (n % 86_400n === 0n) return n === 86_400n ? '1 day' : `${n / 86_400n} days`;
  if (n % 3600n === 0n) return n === 3600n ? '1 hour' : `${n / 3600n} hours`;
  return `${n} seconds`;
}
function expiry(timestamp: string) {
  const ms = Number(timestamp) * 1000;
  return Number.isSafeInteger(ms) && Math.abs(ms) <= 8.64e15 ? `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC` : timestamp;
}

type Asset = {symbol: string; decimals: number};
const inAsset = (units: string, asset: Asset) => `${scaled(units, asset.decimals)} ${asset.symbol}`;

/**
 * Every hard limit the setup transaction stores, decoded from its exact Config bytes. Lamport fields are shown in the
 * policy's funding asset and token fields in its configured payment token, as the runtime states them.
 */
export function ChainTerms({config: c, funding, payment}: {config: ChainConfig; funding: Asset; payment: Asset}) {
  const period = duration(c.periodSeconds);
  return (
    <dl className="facts chain-terms">
      <div><dt>Deposit</dt><dd>{inAsset(c.allocationLamports, funding)}</dd></div>
      <div><dt>Service fee</dt><dd>{inAsset(c.serviceFeeLamports, funding)} per executed payment or swap</dd></div>
      <div><dt>Fees per {period}</dt><dd>at most {inAsset(c.maxFeeLamportsPerPeriod, funding)}</dd></div>
      <div><dt>Spent per {period}</dt><dd>at most {inAsset(c.maxSolDebitsPerPeriod, funding)}, swaps and fees together</dd></div>
      <div><dt>Swap input</dt><dd>at most {inAsset(c.maxSwapLamportsPerCall, funding)} per call, {inAsset(c.maxSwapLamportsPerPeriod, funding)} per {period}, {inAsset(c.maxTotalSwapLamports, funding)} in total</dd></div>
      <div><dt>Minimum swap output</dt><dd>{inAsset(c.minUsdcPerSol, payment)} per 1 {funding.symbol}</dd></div>
      <div><dt>Pool fee</dt><dd>at most {Number(c.maxPoolFeeBps) / 100}%</dd></div>
      <div><dt>Paid per {period}</dt><dd>at most {inAsset(c.maxUsdcPerPeriod, payment)}</dd></div>
      <div><dt>Approval lifetime</dt><dd>each approval expires after {c.maxAgeSeconds} seconds or {c.maxAgeSlots} slots</dd></div>
      <div><dt>Policy expires</dt><dd>{expiry(c.policyExpiresTimestamp)}</dd></div>
    </dl>
  );
}

const Spinner = () => <LoaderCircle className="spin" size={16} aria-hidden="true" />;
const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-4)}`;

export default function ContractFunding({c, policy, unsaved}: {c: MicroController; policy: MicroPolicy; unsaved: boolean}) {
  const r = runtimeOf(policy);
  const view = c.setup.view(policy.id);
  const busy = Boolean(c.busy) || Boolean(c.auth.busy);
  const deposit = depositOf(policy);
  const typed = r.state === 'typed' ? r.runtime : null;
  const canFund = !!typed && r.capabilities.fund && isPayshNetwork(policy.network) && 'units' in deposit;
  const networkLabel = policy.network === 'solana:localnet' ? 'Local Solana' : 'Testnet';
  const funding = typed?.fundingAsset ?? null;
  const payment = typed?.paymentAsset ?? null;
  return (
    <div className="stack contract-funding">
      {contractSetupPaused(policy.network)?<p className="small" role="status">New contract setup is temporarily paused. Existing signed proofs can still be checked and recovered.</p>:null}
      <p className="small">{WALLET_MEANING['contract-wallet']} You pay the network fee for this one transaction.</p>
      <p className="small muted">{EXECUTION_AUTHORITY}</p>
      {payment && funding ? <p className="small muted">{funding.symbol} and {payment.symbol} have no value. {payment.symbol} is the configured test token, not USDC.</p> : null}
      {funding && 'units' in deposit ? (
        <dl className="facts">
          <div><dt>Deposit</dt><dd>{inAsset(deposit.units.toString(), funding)}</dd></div>
        </dl>
      ) : null}
      {'error' in deposit ? <p className="small gate" role="status">{deposit.error}</p> : !canFund ? <p className="small gate" role="status">This policy’s wallet cannot be funded here.</p> : null}
      {c.setup.notice ? <p className="small" role="status">{c.setup.notice}</p> : null}
      {!view || view.phase === 'reading' ? (
        <p className="small muted" role="status">Checking this device for a signed setup…</p>
      ) : view.phase === 'unreadable' ? (
        <p className="small" role="alert">{view.message}</p>
      ) : view.phase === 'idle' && !newSetupAllowed(policy) ? (
        <>
          <p className="small" role="status">{policy.status === 'active' && !typed?.setup ? 'The server reports this policy active. This device has no original signed proof. Refresh its status; nothing new can be prepared or signed here.' : policy.status !== 'draft' || typed?.setup?.signature || typed?.setup?.state?.signature || [typed?.setup?.status, typed?.setup?.state?.status].some(v => v !== undefined && v !== 'draft' && v !== 'prepared') ? 'This policy already has a setup or has ended. This device has no original signed proof. Nothing new can be prepared or signed here.' : 'This policy’s wallet cannot prepare a setup here. Refresh its status to check the available actions.'}</p>
          <button type="button" className="btn" disabled={busy} onClick={() => void c.refresh()}>Refresh policy status</button>
        </>
      ) : view.phase === 'idle' ? (
        <>
          <p className="small">Setup creates the policy’s account and token accounts on {networkLabel} and moves the deposit into it. You review the exact terms before your wallet opens.</p>
          {unsaved ? <p className="small" role="status">Save preference changes before funding.</p> : null}
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy || !canFund || unsaved} onClick={() => void c.setup.prepare()}>
              {c.busy === 'setup' ? <Spinner /> : null}
              {c.busy === 'setup' ? 'Preparing…' : 'Prepare deployment'}
            </button>
          </div>
        </>
      ) : view.phase === 'prepared' && funding && payment ? (
        <>
          <p className="small">
            Checked before your wallet opens. You sign one {networkLabel} transaction that creates the policy’s two token accounts, initializes the policy with these terms and moves <strong>{inAsset(view.setup.draft.policy.allocationLamports, funding)}</strong> into its SOL account <span className="mono" title={view.setup.prepared.accounts.solCustody}>{shortSignature(view.setup.prepared.accounts.solCustody)}</span>. Nothing else.
          </p>
          <ChainTerms config={view.setup.prepared.config} funding={funding} payment={payment} />
          <p className="small muted">Each call pays at most {inAsset(view.setup.draft.policy.maxPaymentUsdc, payment)}{view.setup.draft.policy.preferenceThresholdBps > 0 ? `, and the host evaluator must score it at least ${view.setup.draft.policy.preferenceThresholdBps / 100} out of 100. That check is not stored on chain and cannot raise any limit` : ''}.</p>
          {/* The signed instance ID is the hash of this policy's source approval. */}
          <dl className="facts">
            <div><dt>Policy instance</dt><dd className="mono" title={view.setup.draft.policy.id}>{short(view.setup.draft.policy.id)}</dd></div>
            <div><dt>Source</dt><dd>Revision {view.setup.binding.revision} · <span className="mono" title={view.setup.binding.sourceHash}>{short(view.setup.binding.sourceHash)}</span></dd></div>
            {/* The exact services this transaction signs, already checked against the Config's allowlist root. */}
            {view.setup.draft.policy.allowedServiceIds ? <div><dt>Allowed services</dt><dd><ul className="prepared-services" aria-label="Allowed services in this setup">{view.setup.draft.policy.allowedServiceIds.map(id => <li key={id}>{id}</li>)}</ul></dd></div> : null}
          </dl>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={contractSetupPaused(policy.network)||busy || unsaved} onClick={() => void c.setup.sign()}>
              {c.busy === 'setup' ? <Spinner /> : null}
              {c.busy === 'setup' ? 'Waiting for your wallet…' : `Sign and deposit ${inAsset(view.setup.draft.policy.allocationLamports, funding)}`}
            </button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={c.setup.back}>Back</button>
          </div>
        </>
      ) : view.phase === 'signing' ? (
        <p className="small" role="status"><Spinner /> Approve the transaction in your wallet. It signs only; Allowit saves the signed transaction before sending it.</p>
      ) : view.phase === 'confirming' ? (
        <p className="small" role="status"><Spinner /> Waiting for {networkLabel} finality, up to 60 seconds. Signature <span className="mono" title={view.proof.signature}>{shortSignature(view.proof.signature)}</span>.</p>
      ) : view.phase === 'signed' ? (
        <>
          <p className="small" role="status">
            {view.unconfirmed ? <>The submit result is unconfirmed: {view.unconfirmed.replace(/\.$/, '')}. </> : null}
            <strong>Signed setup saved on this device.</strong> It is never replaced; only the same bytes can be sent again.
          </p>
          <p className="small">Signature <span className="mono" title={view.proof.signature}>{shortSignature(view.proof.signature)}</span> <TxLink network={policy.network} signature={view.proof.signature} /></p>
          {view.context ? (
            <div className="btn-row">
              <button type="button" className="btn" disabled={busy} onClick={() => void c.setup.check()}>
                {c.busy === 'setup-check' ? <Spinner /> : null}
                {c.busy === 'setup-check' ? 'Checking…' : 'Check again'}
              </button>
              <button type="button" className="btn btn-quiet" disabled={busy} onClick={() => void c.setup.resend()}>
                {c.busy === 'setup-resend' ? <Spinner /> : null}
                Send the same transaction again
              </button>
            </div>
          ) : <p className="small muted">This device did not keep the reviewed terms for this setup, so it cannot be checked or sent from here. Nothing new can be prepared while it is saved.</p>}
        </>
      ) : view.phase === 'finalized' ? (
        <>
        <p className="small" role="status">{view.state.chain?.finalizedSlot && BigInt(view.state.chain.finalizedSlot) > 0n ? 'Deployed and funded.' : 'The setup reply has no finalized slot. Check again; the original signed proof stays saved.'} <TxLink network={policy.network} signature={view.proof.signature} />{view.state.chain?.balanceLamports !== undefined && funding ? ` At this check the policy’s SOL account held ${inAsset(view.state.chain.balanceLamports, funding)}.` : ''}</p>
        {!(view.state.chain?.finalizedSlot && BigInt(view.state.chain.finalizedSlot) > 0n) ? <button type="button" className="btn" disabled={busy} onClick={() => void c.setup.check()}>Check again</button> : null}
        </>
      ) : view.phase === 'absent' ? (
        <p className="small" role="status">This setup expired without deployment. The original signed proof stays saved on this device. Start a new draft to try again.</p>
      ) : (
        <p className="small gate" role="status">This policy’s runtime does not state its assets, so it cannot be funded here.</p>
      )}
    </div>
  );
}
