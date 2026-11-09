import {useEffect, useRef, useState} from 'react';
import {LoaderCircle} from 'lucide-react';
import {confirmSetup, payshApi, PayshError} from '../paysh/paysh-api';
import {sol, type PayshDeployment, type SetupState} from '../paysh/paysh-contracts';
import type {IndexedSetupJournal} from '../paysh/setup-journal';
import type {LegacyRecord} from '../runtime/legacy-setup';
import {shortSignature} from '../request-status';
import {TxLink} from './RequestLanes';

/**
 * Earlier signed setups this owner has on this device that no listed policy accounts for. A plain section, not a
 * certificate: it shows the saved facts and checks their status through the original confirm route with the retained
 * draft only. Nothing signs, prepares, resends, archives, imports or migrates from here, and nothing is deleted except
 * an unsigned, never-prepared draft the owner removes explicitly.
 */

type Checked = {state: SetupState; at: Date} | {error: string};

const STATUS_WORD: Record<SetupState['status'], string> = {
  finalized: 'Finalized',
  absent: 'Expired without deployment',
  submitted: 'Submitted · not finalized',
  archived: 'Archived',
  draft: 'Not recorded by the server',
  preparing: 'Not recorded by the server',
  prepared: 'Not recorded by the server',
};

/** A 404 from this server says only that it cannot see the original journal; the proof is kept as it is. */
function checkError(e: unknown) {
  if (e instanceof PayshError && e.status === 404) return 'This server cannot see the original setup journal, so its status is unavailable here. The signed proof stays saved on this device, unchanged. Nothing was resent or recreated.';
  return `${e instanceof Error ? e.message : 'The status check failed.'} The signed transaction is still saved.`;
}

function Record({record, owner, deployment, busy, act, startDraft, journal, reload}: {
  record: LegacyRecord; owner: string; deployment: () => Promise<PayshDeployment>; busy: string | null;
  act: (name: string, fn: () => Promise<void>) => Promise<void>; startDraft: (prompt: string) => void;
  journal: IndexedSetupJournal; reload: () => void;
}) {
  const [checked, setChecked] = useState<Checked | null>(null);
  const [armed, setArmed] = useState(false);
  const policy = record.saved?.draft.policy ?? null;
  const proof = record.proof;
  const state = checked && 'state' in checked ? checked.state : null;
  const id = record.policyId;
  const check = () => act(`check:${id}`, async () => {
    if (!proof || !policy) return;
    try {
      setChecked({state: await confirmSetup(payshApi, proof, policy, await deployment()), at: new Date()});
    } catch (e) {
      setChecked({error: checkError(e)});
    }
  });
  // Unsigned and never prepared: only then can the device record go, and only after the journal is read again.
  const remove = () => act(`remove:${id}`, async () => {
    if (!record.saved || record.proof || record.saved.requestId) return;
    if (await journal.read(owner, id)) {reload(); return;}
    try {localStorage.removeItem(record.saved.storageKey);} catch {/* Kept. */}
    reload();
  });
  const pending = (name: string) => busy === `${name}:${id}`;
  const neverPrepared = !proof && !!record.saved && !record.saved.requestId;
  return (
    <li className="legacy-setup">
      <h3 className="legacy-title">{record.title || 'Earlier policy setup'}</h3>
      <dl className="facts">
        {policy ? <div><dt>Deposit</dt><dd>{sol(policy.allocationLamports)} Testnet SOL</dd></div> : null}
        {policy ? <div><dt>Service</dt><dd>{policy.serviceId}</dd></div> : null}
        <div><dt>Policy</dt><dd>{id}</dd></div>
        {proof ? <div><dt>Signature</dt><dd><span title={proof.signature}>{shortSignature(proof.signature)}</span> <TxLink network="solana:testnet" signature={proof.signature} /></dd></div> : null}
        {state ? <div><dt>Status</dt><dd>{STATUS_WORD[state.status]}</dd></div> : null}
      </dl>
      {proof ? (
        <p className="small">Signed setup saved on this device. It is kept exactly as signed and is never replaced or sent again from here.</p>
      ) : record.saved?.requestId ? (
        <p className="small muted">A setup was prepared for this draft in an earlier session. No signed setup is saved on this device.</p>
      ) : (
        <p className="small muted">Not signed. Nothing was sent.</p>
      )}
      {proof && !policy ? <p className="small muted">This device does not keep the reviewed terms for this setup, so its status cannot be checked here.</p> : null}
      {checked && 'error' in checked ? <p className="small" role="status">{checked.error}</p> : null}
      {checked && 'state' in checked ? <p className="small muted" role="status">Checked {checked.at.toLocaleTimeString()}.{state?.status === 'finalized' && state.chain?.balanceLamports !== undefined ? ` The policy account held ${sol(state.chain.balanceLamports)} Testnet SOL at this check.` : ''}</p> : null}
      <div className="btn-row">
        {proof && policy ? <button type="button" className="btn" disabled={!!busy} onClick={() => void check()}>{pending('check') ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : null}Check status</button> : null}
        {neverPrepared ? <button type="button" className="btn" disabled={!!busy} onClick={() => startDraft(record.saved!.draft.policy.originalIntent)}>Start a new draft from this request</button> : null}
        {neverPrepared ? (armed
          ? <><button type="button" className="btn btn-danger" disabled={!!busy} onClick={() => void remove()}>Confirm remove</button><button type="button" className="btn" onClick={() => setArmed(false)}>Keep</button></>
          : <button type="button" className="btn btn-quiet" disabled={!!busy} onClick={() => setArmed(true)}>Remove from this device</button>) : null}
      </div>
    </li>
  );
}

export default function LegacySetupRecovery({owner, records, error, journal, reload, startDraft}: {owner: string; records: LegacyRecord[]; error: string | null; journal: IndexedSetupJournal; reload: () => void; startDraft: (prompt: string) => void}) {
  const [busy, setBusy] = useState<string | null>(null);
  const deploymentRef = useRef<Promise<PayshDeployment> | null>(null);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  useEffect(() => {deploymentRef.current = null;}, [owner]);
  /** The earlier route's public deployment, read once, Testnet only. */
  const deployment = () => {
    deploymentRef.current ??= payshApi.config().then(c => {
      if (!c.enabled) throw new Error('The earlier setup service is not configured on this server.');
      return c.deployment;
    });
    deploymentRef.current.catch(() => {deploymentRef.current = null;});
    return deploymentRef.current;
  };
  const act = async (name: string, fn: () => Promise<void>) => {
    if (busy) return;
    const o = owner;
    setBusy(name);
    try {
      await fn();
    } finally {
      if (ownerRef.current === o) setBusy(null);
    }
  };
  useEffect(() => {document.title = 'Earlier setups – Allowit';}, []);
  return (
    <section className="section" aria-labelledby="legacy-setups-title">
      <h1 className="title" id="legacy-setups-title">Earlier setups on this device</h1>
      <p className="small muted">These setups were started on the earlier setup page and are not in your policy list. Checking a status reads the original setup record only; it never opens your wallet or sends anything. Testnet SOL and the test token have no value.</p>
      {error ? <p className="small" role="alert">{error}</p> : null}
      {records.length ? <ol className="legacy-setups">{records.map(r => <Record key={r.policyId} record={r} owner={owner} deployment={deployment} busy={busy} act={act} startDraft={startDraft} journal={journal} reload={reload} />)}</ol> : <p className="small muted">No earlier setups remain on this device.</p>}
    </section>
  );
}
