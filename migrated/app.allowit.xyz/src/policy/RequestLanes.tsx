import {stellarTransfer, stellarReceiptHeight} from '@allowit/engine/stellar/receipt';
import {isStellarNetwork} from '@allowit/engine/stellar/runtime';
import {useEffect, useRef, useState} from 'react';
import {ExternalLink} from 'lucide-react';
import type {FundingAsset, PaymentAsset, PolicyRequest} from '../micro/micro-contracts';
import {receiptFinalized, scaled, type OperationReceipt, type ReceiptAction} from '../paysh/paysh-units';
import {responsePreview, type Lane, type Lanes} from '../runtime/request-lanes';
import {explorerUrl} from '../wallet/runtime-network';
import AccountIdentity from '../wallet/AccountIdentity';
import {shortSignature} from '../request-status';

/**
 * The shared run record: policy decision, payment and delivery as separate labelled lanes, the finalized receipts,
 * any unverified transaction and the delivered response as text. Used for every wallet kind; nothing here acts.
 */

const CLUSTER: Record<string, string> = {'solana:testnet': '?cluster=testnet', 'solana:devnet': '?cluster=devnet', 'solana:mainnet': ''};
export const explorerTx = (network: string, signature: string) => (isStellarNetwork(network) ? explorerUrl('tx',signature,network) : network in CLUSTER ? `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${CLUSTER[network]}` : null);

/** The policy's stored assets. Receipt amounts are shown only in them; no token is guessed from a field name or network. */
export interface ReceiptAssets {payment: PaymentAsset | null; funding: FundingAsset | null}

const amount = (units: string, asset: {symbol: string; decimals: number} | null, unit: string) => (asset ? `${scaled(units, asset.decimals)} ${asset.symbol}` : `${units} ${unit}`);
/** Swap input is in the funding asset; swap output and payment are in the configured payment token. */
export function receiptText(r: OperationReceipt, assets: ReceiptAssets) {
  const transfer=stellarTransfer(r);
  if(transfer)return `Transfer ${amount(transfer.units,assets.payment,'base units')} to ${transfer.recipient}`;
  const action=r.action as ReceiptAction;
  return action.type === 'swap'
    ? `Swap ${amount(action.amountInLamports, assets.funding, 'lamports')} for at least ${amount(action.minOutUsdc, assets.payment, 'base units of an unreported token')}`
    : `Pay ${amount(action.amountUsdc, assets.payment, 'base units of an unreported token')}`;
}

/** The rendered receipt line. A Stellar recipient is shown as an account; receiptText stays the plain-text form. */
function ReceiptSummary({receipt: r, assets, network}: {receipt: OperationReceipt; assets: ReceiptAssets; network: string}) {
  const transfer=stellarTransfer(r);
  if (!transfer) return <>{receiptText(r, assets)}</>;
  return <>Transfer {amount(transfer.units, assets.payment, 'base units')} to <AccountIdentity address={transfer.recipient} network={network} label="Recipient"/></>;
}

function LaneValue({lane}: {lane: Lane}) {
  return <dd className="lane-value" data-tone={lane.tone}>{lane.label}</dd>;
}

export function TxLink({network, signature}: {network: string; signature: string}) {
  const href = explorerTx(network, signature);
  return href ? (
    <a className="lane-link" href={href} target="_blank" rel="noreferrer">
      Explorer <ExternalLink size={12} aria-hidden="true" />
    </a>
  ) : null;
}

type Detail = {key: string; value: unknown; has: boolean} | {key: string; error: string};

/** Loads the response with the owner session when opened. Applied only while the same policy and request are shown. */
function ResponseDetail({request, policyId, load}: {request: PolicyRequest; policyId: string; load: (policyId: string, requestId: string) => Promise<PolicyRequest | null>}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const key = `${policyId}|${request.id}`;
  const keyRef = useRef(key);
  keyRef.current = key;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;};
  }, []);
  const asked = useRef<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setDetail(null);
    asked.current = null;
  }, [key]);
  const inline = request.delivery && 'response' in request.delivery ? {key, value: request.delivery.response, has: true} : null;
  const shown = inline ?? (detail && detail.key === key ? detail : null);
  const open = () => {
    if (inline || asked.current === key) return;
    const k = key, requestId = request.id;
    asked.current = k;
    const apply = (d: Detail) => {if (mounted.current && keyRef.current === k) setDetail(d);};
    load(policyId, requestId).then(
      r => apply(r?.delivery && 'response' in r.delivery ? {key: k, value: r.delivery.response, has: true} : {key: k, value: null, has: false}),
      e => {
        if (asked.current === k) asked.current = null;
        apply({key: k, error: e instanceof Error ? e.message : 'The response could not be loaded.'});
      },
    );
  };
  const preview = shown && 'value' in shown && shown.has ? responsePreview(shown.value) : null;
  return (
    <details className="lane-response" onToggle={e => {if (e.currentTarget.open) open();}}>
      <summary>Response</summary>
      {!shown ? <p className="small muted" role="status">Loading the response…</p>
        : 'error' in shown ? <p className="small" role="status">{shown.error}</p>
        : !preview ? <p className="small muted">No response was reported.</p>
        : <>
          <pre className="mono lane-response-body" tabIndex={0} aria-label="Response">{preview.text}</pre>
          {preview.truncated ? <p className="small muted">Showing {preview.text.length} of {preview.total} characters.</p> : null}
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => navigator.clipboard?.writeText(preview.text).then(() => {setCopied(true); setTimeout(() => setCopied(false), 2000);}, () => setCopied(false))}>
              {copied ? 'Copied' : 'Copy response'}
            </button>
          </div>
        </>}
    </details>
  );
}

export default function RequestLanes({request, lanes, contractWallet, network, policyId, load, testNetwork, assets}: {request: PolicyRequest; lanes: Lanes; contractWallet: boolean; network: string; policyId: string; load: (policyId: string, requestId: string) => Promise<PolicyRequest | null>; testNetwork: boolean; assets: ReceiptAssets}) {
  const count = lanes.receipts.length + lanes.unverified.length;
  return (
    <div className="lanes">
      <dl className="facts request-lanes">
        <div><dt>Policy</dt><LaneValue lane={lanes.decision} /></div>
        <div><dt>Payment</dt><LaneValue lane={lanes.payment} /></div>
        {lanes.delivery ? <div><dt>Delivery</dt><LaneValue lane={lanes.delivery} /></div> : null}
      </dl>
      {lanes.unresolved ? <p className="small" role="status">Payment may have been sent. Do not retry or create a replacement payment. No refund is reported.</p> : null}
      {lanes.unreadable ? <p className="small muted">Part of this run’s status could not be read, so it is not shown as complete.</p> : null}
      {contractWallet && request.status === 'owner_approved' ? <p className="small muted">Your Yes queued one full re-check with only this question answered. If it passes, the agent pays within the signed quote without another signature from you.</p> : null}
      {contractWallet && request.status === 'expired' && !count ? <p className="small muted">The answer-and-start deadline passed before the agent started. Expiry is not a No.</p> : null}
      {count ? (
        <details className="lane-receipts">
          <summary>{count} {count === 1 ? 'transaction' : 'transactions'}</summary>
          <ol>
            {lanes.receipts.map(r => (
              <li key={`${r.signature}:${r.invocationIndex}`}>
                <span className="small"><ReceiptSummary receipt={r} assets={assets} network={network} />. {receiptFinalized(r) ? <>Finalized at {stellarReceiptHeight(r)?.label??'slot'} <span className="mono">{stellarReceiptHeight(r)?.value??('finalizedSlot' in r?r.finalizedSlot:undefined)}</span>.</> : 'Not finalized.'}</span>{' '}
                <span className="mono" title={r.signature}>{shortSignature(r.signature)}</span> <TxLink network={network} signature={r.signature} />
              </li>
            ))}
            {lanes.unverified.map(s => (
              <li key={s}>
                <span className="small">Unverified transaction</span> <span className="mono" title={s}>{shortSignature(s)}</span> <TxLink network={network} signature={s} />
              </li>
            ))}
          </ol>
          {testNetwork ? <p className="small muted">Test network assets have no value.{assets.payment ? ` ${assets.payment.symbol} is the configured test token, not USDC.` : ''}</p> : null}
        </details>
      ) : null}
      {lanes.delivery && request.delivery?.status === 'delivered' ? <ResponseDetail request={request} policyId={policyId} load={load} /> : null}
    </div>
  );
}
