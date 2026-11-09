import {CircleAlert, LoaderCircle} from 'lucide-react';
import type {MicroController, MicroPolicy} from '../micro/micro-contracts';
import {WALLET_MEANING} from '../runtime/runtime';
import type {AuthorizationView, SavedProof} from '../runtime/useOwnerAuthorization';
import type {Commitment} from '../runtime/authorization-codec';
import TypedBudgets, {budgetDisplay} from './TypedBudgets';
import type {TypedView} from './typed-metadata';

/**
 * Funding for an owner-wallet policy whose runtime states budget authorization. The owner signs one message; nothing is
 * a transaction, a deposit or an allowance. Every fact shown comes from a commitment this browser checked against the
 * current policy. Ready needs the server-retained proof verified here; a proof saved only on this device is signed and
 * unconfirmed. Budget amounts are the definition's checked typed budgets, repeated once at the consent moment.
 */

const utc = new Intl.DateTimeFormat('en-GB', {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23'});
export const utcTime = (ms: number) => `${utc.format(new Date(ms))} UTC`;
export const shortValue = (v: string) => (v.length > 16 ? `${v.slice(0, 8)}…${v.slice(-4)}` : v);
const Spinner = () => <LoaderCircle className="spin" size={16} aria-hidden="true" />;
const NETWORK: Record<string, string> = {'solana:mainnet': 'Mainnet', 'solana:testnet': 'Testnet', 'solana:devnet': 'Devnet'};

/** The binding facts of one commitment, as checked. */
export function CommitmentFacts({c, expiresAt, signature}: {c: Commitment; expiresAt: number; signature?: string}) {
  return (
    <dl className="facts authorization-facts">
      <div><dt>Expires</dt><dd>{utcTime(expiresAt)}</dd></div>
      {signature ? <div><dt>Proof</dt><dd className="mono" title={signature}>{shortValue(signature)}</dd></div> : null}
      <div><dt>Policy instance</dt><dd className="mono" title={c.policyInstance}>{shortValue(c.policyInstance)}</dd></div>
      <div><dt>Source</dt><dd>Revision {c.revision} · <span className="mono" title={c.sourceHash}>{shortValue(c.sourceHash)}</span></dd></div>
      <div><dt>Network</dt><dd>{NETWORK[c.network] ?? c.network}</dd></div>
      <div><dt>Site</dt><dd className="mono">{c.origin}</dd></div>
    </dl>
  );
}

const problemCopy = (p: {kind: string; message: string}, what: string) =>
  p.kind === 'expired' ? `${what} expired. The original signed proof stays saved.` : p.kind === 'stale' ? `${what} belongs to an earlier revision or source. It stays saved and is never sent again.` : `${what} could not be verified here: ${p.message}.`;

function Saved({c, proofs}: {c: MicroController; proofs: SavedProof[]}) {
  if (!proofs.length) return null;
  const busy = Boolean(c.busy) || Boolean(c.auth.busy);
  return (
    <ul className="authorization-saved">
      {proofs.map(({entry, problem}) => (
        <li key={entry.requestId}>
          <p className="small">{problemCopy(problem ?? {kind: 'invalid', message: 'not current'}, `A signed authorization for revision ${entry.revision}`)}</p>
          <button type="button" className="btn" disabled={busy} onClick={() => void c.authorization.check(entry)}>{c.busy === 'authorization-check' ? <Spinner /> : null}Check its status</button>
        </li>
      ))}
    </ul>
  );
}

export default function BudgetAuthorization({c, policy, typed, view, unsaved}: {c: MicroController; policy: MicroPolicy; typed: TypedView; view: AuthorizationView | null; unsaved: boolean}) {
  const busy = Boolean(c.busy) || Boolean(c.auth.busy);
  const net = NETWORK[policy.network] ?? policy.network;
  const notice = c.authorization.notice;
  const lead = (
    <>
      <p className="small">{WALLET_MEANING['owner-wallet']}</p>
      <p className="small">Authorization signs one message with your wallet. It sends no transaction, pays no network fee and moves no funds. It fixes the budgets in the policy definition to this policy’s source, revision {policy.revision}, {net} and this site.</p>
    </>
  );
  return (
    <div className="stack budget-authorization">
      {notice ? <p className="small" role="status">{notice}</p> : null}
      {!view || view.phase === 'reading' ? (
        <>{lead}<p className="small muted" role="status">Checking this policy’s authorization…</p></>
      ) : view.phase === 'unreadable' ? (
        <>{lead}<p className="small" role="alert">{view.message}</p></>
      ) : view.phase === 'verified' ? (
        <>
          <p className="small" role="status"><strong>Budget authorized.</strong> Checked in this browser against the current policy, owner and site.</p>
          <CommitmentFacts c={view.facts.commitment} expiresAt={view.facts.expiresAt} signature={view.facts.signatureBase64} />
          <p className="small muted">Budgets as listed in the policy definition.</p>
        </>
      ) : view.phase === 'signing' ? (
        <p className="small" role="status"><Spinner /> Approve the message in your wallet. It signs only; Allowit saves the signed authorization before sending it.</p>
      ) : view.phase === 'signed' ? (
        <>
          <p className="small" role="status"><strong>Signed authorization saved on this device.</strong> Allowit has not confirmed it yet, so the agent skill stays unavailable.</p>
          {view.retained ? <p className="small" role="alert">{problemCopy(view.retained, 'The server’s saved authorization')}</p> : null}
          <CommitmentFacts c={view.facts.commitment} expiresAt={view.facts.expiresAt} signature={view.entry.signature} />
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void c.authorization.check(view.entry)}>{c.busy === 'authorization-check' ? <Spinner /> : null}{c.busy === 'authorization-check' ? 'Checking…' : 'Check again'}</button>
          </div>
          <p className="small muted">Checking uses the original request ID. It never opens your wallet or sends the authorization again.</p>
        </>
      ) : view.phase === 'prepared' ? (
        <>
          <h3 className="small authorization-heading">Budget to authorize, from the policy source, revision {view.prepared.revision}</h3>
          <TypedBudgets view={budgetDisplay(typed, policy.typedBudgetRequirements)} />
          <CommitmentFacts c={view.prepared.preparation.commitment} expiresAt={view.prepared.expiresAt} />
          {unsaved ? <p className="small" role="status">Save preference changes before authorizing.</p> : null}
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy || unsaved} onClick={() => void c.authorization.sign()}>{c.busy === 'authorization' ? <Spinner /> : null}{c.busy === 'authorization' ? 'Waiting for your wallet…' : 'Sign authorization'}</button>
            <button type="button" className="btn btn-quiet" disabled={busy} onClick={c.authorization.back}>Back</button>
          </div>
          <Saved c={c} proofs={view.saved} />
        </>
      ) : (
        <>
          {lead}
          {view.retained ? <p className="small" role="alert">{problemCopy(view.retained, 'The server’s saved authorization')} The agent skill stays unavailable.</p> : null}
          {view.blocked ? (
            <>
              <p className="small gate" role="status" id="authorization-gate"><CircleAlert size={14} aria-hidden="true" />This budget cannot be reviewed here, so it cannot be authorized.</p>
              <p className="small muted">{view.blocked.charAt(0).toUpperCase() + view.blocked.slice(1)}.</p>
            </>
          ) : <p className="small muted">You review the exact budget and expiry before your wallet opens.</p>}
          {unsaved ? <p className="small" role="status">Save preference changes before authorizing.</p> : null}
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy || unsaved || !!view.blocked} aria-describedby={view.blocked ? 'authorization-gate' : undefined} onClick={() => void c.authorization.prepare()}>{c.busy === 'authorization' ? <Spinner /> : null}{c.busy === 'authorization' ? 'Preparing…' : view.retained || view.saved.length ? 'Prepare a new authorization' : 'Prepare authorization'}</button>
          </div>
          <Saved c={c} proofs={view.saved} />
        </>
      )}
    </div>
  );
}
