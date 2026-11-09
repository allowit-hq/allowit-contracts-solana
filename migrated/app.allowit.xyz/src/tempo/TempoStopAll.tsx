import {useEffect, useRef, useState} from 'react';
import {ExternalLink, X} from 'lucide-react';
import type {Hex} from 'viem';
import {Spinner} from '../shell/Shell';
import {TempoLifecycle, pendingTempoRecord, tempoChannel, tempoStore, type TempoRecord, type TempoStore} from './tempo-api';
import {checkedTempoPolicy, sameAddress, tempoDecimal, type TempoPolicy, type TempoState, type TempoTransaction} from './tempo-contracts';
import {checkTempoWallet, sendTempoTransaction} from './tempo-wallet';
import {TEMPO_METHOD_LABEL, tempoRecordStatus, tempoTransactionLink} from './tempo-view';
import type {TempoVault, TempoWorkspace} from './TempoVault';
import AccountIdentity from '../wallet/AccountIdentity';
import '../policy/revoke-policies.css';
import './tempo.css';
import '../policy/revoke-policies.css';

type StopMethod = 'revoke' | 'withdraw';
type Channel = 'spending' | StopMethod;
const channels: readonly Channel[] = ['spending', 'revoke', 'withdraw'];
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';
const changed = () => Object.assign(new Error('The selected owner or Tempo network changed. Keep every original request for recovery.'), {beforeSend: true});
const ensureCurrent = (current: () => boolean) => {if (!current()) throw changed();};
const stopMethod = (state: TempoState | null): StopMethod | null => state && BigInt(state.balance) > 0n ? 'withdraw' : state && !state.revoked && state.approved !== false ? 'revoke' : null;

export interface TempoStopRow {
  vault: TempoVault;
  method: StopMethod | null;
  records: TempoRecord[];
  journalErrors: Partial<Record<Channel, string>>;
  error: string;
  result?: string;
}
/** Injection keeps transaction/recovery tests independent of a browser wallet or durable storage implementation. */
export interface TempoStopDependencies {
  store?: (policy: TempoPolicy, channel: Channel) => TempoStore;
  send?: (transaction: TempoTransaction, beforeSend: () => void) => Promise<Hex>;
  checkWallet?: () => Promise<void>;
  wait?: () => Promise<void>;
  receiptAttempts?: number;
}
function storeFor(workspace: TempoWorkspace, policy: TempoPolicy, channel: Channel, deps: TempoStopDependencies) {
  if (!workspace.config || !workspace.owner) throw new Error('Connect the Tempo vault owner to continue.');
  return deps.store?.(policy, channel) ?? tempoStore(workspace.config, workspace.owner, policy, channel);
}
async function readRecords(workspace: TempoWorkspace, policy: TempoPolicy, deps: TempoStopDependencies) {
  const journalErrors: TempoStopRow['journalErrors'] = {};
  const results = await Promise.all(channels.map(async channel => {
    try {
      const store = storeFor(workspace, policy, channel, deps);
      // Read latest as well as history: a damaged latest marker must never permit a replacement send.
      const [entries, latest] = await Promise.all([store.entries(channel), store.read()]);
      return [...entries, ...(latest && !entries.some(record => record.id === latest.id) ? [latest] : [])];
    } catch (error) {journalErrors[channel] = errorText(error); return [];}
  }));
  return {records: [...new Map(results.flat().map(record => [record.id, record])).values()], journalErrors};
}
function originalFor(row: TempoStopRow): TempoRecord | null {
  const records = row.records.filter(record => tempoChannel(record.method) === row.method && pendingTempoRecord(record));
  return records.length === 1 ? records[0] : null;
}
export function tempoStopBlocker(row: TempoStopRow): string {
  if (row.error) return row.error;
  if (!row.method) return '';
  if (row.journalErrors[row.method]) return row.journalErrors[row.method]!;
  const records = row.records.filter(record => tempoChannel(record.method) === row.method && pendingTempoRecord(record));
  if (!records.length) return '';
  const original = originalFor(row);
  if (!original || original.transactionHash || original.operation?.transactionHash || (original.operation && original.operation.status !== 'prepared') || !['preparing', 'prepared', 'declined'].includes(original.phase)
    || original.method !== row.method || Object.keys(original.options).length) return 'Check the unresolved original request before authorizing this vault again.';
  return '';
}

/** Review is read-only. A source failure never hides otherwise verified owner custody. */
export async function reviewTempoStopAll(workspace: TempoWorkspace, current: () => boolean = () => true, deps: TempoStopDependencies = {}): Promise<TempoStopRow[]> {
  if (!workspace.config || !workspace.api || !workspace.owner || !workspace.loaded) throw new Error('Refresh your Tempo vaults before reviewing this action.');
  const {config, owner, api} = workspace;
  const owned = [...new Map(workspace.vaults.filter(vault => sameAddress(vault.policy.owner, owner)).map(vault => [vault.policy.id, vault])).values()];
  const rows = await Promise.all(owned.map(async retained => {
    ensureCurrent(current);
    checkedTempoPolicy(retained.policy, config, owner);
    const journal = await readRecords(workspace, retained.policy, deps);
    ensureCurrent(current);
    let vault = retained, error = '';
    try {
      const custody = await api.custodyState(retained.policy);
      vault = {...custody, policy: retained.policy, draftId: custody.boundExecutionPolicyId, stateError: ''};
    } catch (failure) {error = errorText(failure); vault = {...retained, stateError: error};}
    ensureCurrent(current);
    return {vault, method: error ? null : stopMethod(vault.state), records: journal.records.filter(pendingTempoRecord), journalErrors: journal.journalErrors, error};
  }));
  return rows.filter(row => row.method || row.error || row.records.length || Object.keys(row.journalErrors).length);
}

function lifecycle(workspace: TempoWorkspace, policy: TempoPolicy, channel: Channel, current: () => boolean, deps: TempoStopDependencies) {
  const {config, api, provider} = workspace;
  if (!config || !api) throw new Error('Refresh your Tempo settings to continue.');
  return new TempoLifecycle(api, policy, storeFor(workspace, policy, channel, deps), async transaction => {
    const beforeSend = () => ensureCurrent(current);
    beforeSend();
    if (deps.send) return deps.send(transaction, beforeSend);
    if (!provider) throw Object.assign(new Error('Connect your Tempo wallet to continue.'), {beforeSend: true});
    return sendTempoTransaction(provider, config, transaction, beforeSend);
  });
}
function updateRecord(row: TempoStopRow, record: TempoRecord): TempoStopRow {
  return {...row, records: [...row.records.filter(saved => saved.id !== record.id), record]};
}
/** Exact original identity only. This path cannot prepare a request, sign, or send a transaction. */
export async function recoverTempoStopRecord(workspace: TempoWorkspace, row: TempoStopRow, record: TempoRecord, current: () => boolean = () => true, deps: TempoStopDependencies = {}): Promise<TempoStopRow> {
  ensureCurrent(current);
  const active = lifecycle(workspace, row.vault.policy, tempoChannel(record.method) as Channel, current,
    {...deps, send: async () => {throw new Error('A status check cannot send a transaction.');}});
  const recovered = await active.recover(record.id);
  ensureCurrent(current);
  if (!recovered) throw new Error('The original request is unavailable. Keep its identity before authorizing another transaction.');
  return {...updateRecord(row, recovered), result: `${TEMPO_METHOD_LABEL[recovered.method]} · ${tempoRecordStatus(recovered)}. No new transaction was sent.`};
}

/** The caller obtains explicit aggregate consent. Each reviewed vault uses at most one owner transaction. */
export async function runTempoStopAll(workspace: TempoWorkspace, reviewed: readonly TempoStopRow[], current: () => boolean = () => true,
  progress: (rows: TempoStopRow[], message: string) => void = () => {}, deps: TempoStopDependencies = {}): Promise<TempoStopRow[]> {
  if (!workspace.config || !workspace.api || !workspace.owner) throw new Error('Connect the Tempo vault owner to continue.');
  const {config, api, owner, provider} = workspace;
  let rows: TempoStopRow[] = reviewed.map(row => ({...row, result: undefined}));
  for (let index = 0; index < rows.length; index++) {
    ensureCurrent(current);
    let row = rows[index];
    if (!row.method || tempoStopBlocker(row)) continue;
    const method = row.method, original = originalFor(row), active = lifecycle(workspace, row.vault.policy, method, current, deps);
    let declined = false;
    try {
      checkedTempoPolicy(row.vault.policy, config, owner);
      if (deps.checkWallet) await deps.checkWallet();
      else {
        if (!provider) throw new Error('Connect your Tempo wallet to continue.');
        await checkTempoWallet(provider, config, owner);
      }
      ensureCurrent(current);
      const fresh = await api.custodyState(row.vault.policy);
      ensureCurrent(current);
      row = {...row, vault: {...fresh, policy: row.vault.policy, draftId: fresh.boundExecutionPolicyId, stateError: ''}};
      const nextMethod = stopMethod(fresh.state);
      if (!nextMethod) {row = {...row, method: null, result: 'No transaction needed. Agent access is stopped and no funds remain.'};}
      else {
        if (nextMethod !== method) throw new Error('The remaining balance changed the required action. Review this vault again before signing.');
        const journal = await readRecords(workspace, row.vault.policy, deps);
        ensureCurrent(current);
        const unresolved = journal.records.filter(record => tempoChannel(record.method) === method && pendingTempoRecord(record));
        if (journal.journalErrors[method]) throw new Error(journal.journalErrors[method]);
        if (unresolved.length !== (original ? 1 : 0) || (original && unresolved[0]?.id !== original.id)) throw new Error('The saved requests changed. Review their original status before signing.');
        const refreshed = {...row, records: journal.records};
        if (tempoStopBlocker(refreshed)) throw new Error(tempoStopBlocker(refreshed));
        let record = await active.submit(method, {}, message => progress(rows, `Vault ${index + 1} of ${rows.length}: ${message}`), original?.id);
        row = updateRecord(row, record); rows[index] = row; progress([...rows], 'Waiting for the verified transaction receipt…');
        for (let attempt = 0; attempt < (deps.receiptAttempts ?? 15) && record.transactionHash && pendingTempoRecord(record); attempt++) {
          await (deps.wait?.() ?? new Promise(resolve => setTimeout(resolve, 2000)));
          ensureCurrent(current);
          try {record = await active.recover(record.id) ?? record;} catch {break;}
          ensureCurrent(current);
          row = updateRecord(row, record); rows[index] = row; progress([...rows], 'Waiting for the verified transaction receipt…');
        }
        const status = tempoRecordStatus(record);
        row = {...row, result: status === 'Confirmed' ? method === 'withdraw' ? 'Confirmed · agent access stopped and remaining funds returned.' : 'Confirmed · agent access stopped.'
          : status === 'Failed on chain' ? 'The transaction failed on chain. Review this vault before trying again.' : 'Not confirmed. Check the original request before authorizing this vault again.'};
      }
    } catch (failure) {
      if (!current()) throw failure;
      // Preserve every original even if the wallet response, receipt, or a later storage write failed.
      const journal = await readRecords(workspace, row.vault.policy, deps);
      row = {...row, records: journal.records, journalErrors: journal.journalErrors, result: errorText(failure)};
      declined = (failure as {code?: number})?.code === 4001 || (failure as {cause?: {code?: number}})?.cause?.code === 4001;
    }
    rows[index] = row;
    progress([...rows], row.result ?? 'Checking the remaining vaults…');
    if (declined) {
      rows = rows.map((remaining, position) => position > index && remaining.method && !tempoStopBlocker(remaining) ? {...remaining, result: 'Not requested. The wallet confirmation sequence was cancelled.'} : remaining);
      break;
    }
  }
  return rows;
}

export function TempoStopAll({workspace, raise}: {workspace: TempoWorkspace; raise: (message: string) => void}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [consent, setConsent] = useState(false), [rows, setRows] = useState<TempoStopRow[]>([]);
  const [message, setMessage] = useState(''), [finished, setFinished] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null), trigger = useRef<HTMLButtonElement>(null), live = useRef(true), working = useRef(false), generation = useRef(0);
  const scope = workspace.config && workspace.owner ? `${JSON.stringify(workspace.config)}:${workspace.owner.toLowerCase()}` : '';
  const scopeRef = useRef(scope), providerRef = useRef(workspace.provider);
  scopeRef.current = scope; providerRef.current = workspace.provider;
  const token = workspace.config?.tokenSymbol ?? 'tokens', network = workspace.config?.network === 'tempo:localnet' ? 'Tempo Localnet' : 'Tempo Testnet';
  const owned = workspace.vaults.filter(vault => sameAddress(vault.policy.owner, workspace.owner));
  const eligible = rows.filter(row => row.method && !tempoStopBlocker(row));
  const total = rows.reduce((sum, row) => sum + (row.method === 'withdraw' && !tempoStopBlocker(row) && row.vault.state ? BigInt(row.vault.state.balance) : 0n), 0n);
  const hasRecovery = rows.some(row => row.records.some(pendingTempoRecord));
  useEffect(() => {live.current = true; return () => {live.current = false; ++generation.current;};}, []);
  useEffect(() => {++generation.current; setOpen(false); setRows([]); setConsent(false); setBusy(false); setFinished(false); setMessage('');}, [scope]);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal(); else if (!open && d.open) d.close();
    if (open) d.querySelector<HTMLElement>('h2')?.focus();
  }, [open]);
  useEffect(() => {
    const changedWallet = () => {++generation.current; setConsent(false); setMessage('The wallet changed. Refresh this review before authorizing any transaction.');};
    const events = ['accountsChanged', 'chainChanged', 'disconnect'];
    for (const event of events) workspace.provider?.on?.(event, changedWallet);
    return () => {for (const event of events) workspace.provider?.removeListener?.(event, changedWallet);};
  }, [workspace.provider]);
  function close() {
    if (working.current) return;
    ++generation.current; setOpen(false); setConsent(false);
    requestAnimationFrame(() => {if (trigger.current?.isConnected) trigger.current.focus();});
  }
  async function run(action: (current: () => boolean) => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(true);
    const ownGeneration = ++generation.current, ownScope = scope, ownProvider = workspace.provider;
    const current = () => live.current && scopeRef.current === ownScope && providerRef.current === ownProvider && generation.current === ownGeneration;
    const release = workspace.beginOperation();
    try {await action(current);} catch (error) {if (current()) {setMessage(errorText(error)); raise(errorText(error));}}
    finally {release(); working.current = false; if (live.current) setBusy(false);}
  }
  async function refresh() {
    setConsent(false); setFinished(false);
    await run(async current => {
      setMessage('Checking your Tempo vaults and original requests…');
      const next = await reviewTempoStopAll(workspace, current);
      if (current()) {setRows(next); setMessage(next.length ? '' : 'Agent access is stopped and no funds remain in the checked vaults.');}
    });
  }
  function show() {if (working.current) return; setOpen(true); setRows([]); void refresh();}
  async function perform() {
    if (!consent || finished || !eligible.length) return;
    const reviewed = rows;
    setConsent(false);
    await run(async current => {
      const result = await runTempoStopAll(workspace, reviewed, current, (next, text) => {if (current()) {setRows(next); setMessage(text);}});
      if (current()) {setRows(result); setFinished(true); setMessage('Review each vault’s result below. Unconfirmed requests keep their original identity.');}
      await workspace.reload();
    });
  }
  async function recover(row: TempoStopRow, record: TempoRecord) {
    setConsent(false); setFinished(true);
    await run(async current => {
      const result = await recoverTempoStopRecord(workspace, row, record, current);
      if (current()) {setRows(previous => previous.map(saved => saved.vault.policy.id === row.vault.policy.id ? result : saved)); setMessage(result.result ?? 'Original status checked.');}
      await workspace.reload();
    });
  }
  // The trigger matches Stop all policies on Solana: a quiet text action above the policy list.
  return <div className="revoke-policies">
    <button type="button" className="revoke-policies-trigger" ref={trigger} disabled={!workspace.loaded || !workspace.config || !workspace.api || !owned.length || busy} onClick={show}>Stop all policies</button>
    <dialog className="ca-dialog tempo-dialog" ref={dialog} aria-labelledby="tempo-stop-all-title" onClose={close} onCancel={event => {if (working.current) event.preventDefault(); else close();}}>{open ? <>
      <div className="ca-dialog-heading"><h2 id="tempo-stop-all-title" tabIndex={-1}>Stop all and return funds</h2><button type="button" className="ca-icon" aria-label="Close stop all review" disabled={busy} onClick={close}><X size={20} /></button></div>
      <p className="small muted">Agent access stops when the owner transaction confirms on Tempo. Funded vaults return all remaining tokens to your wallet and revoke approval in one transaction. Empty active vaults need one revocation transaction.</p>
      {workspace.error ? <p className="small gate" role="alert">{workspace.error} The vault list may be incomplete. Refresh before assuming every vault has been stopped.</p> : null}
      {message ? <p className="tempo-notice" role="status">{busy ? <Spinner /> : null}<span>{message}</span></p> : null}
      {rows.length ? <ol className="tempo-entries">{rows.map(row => <li className="tempo-recovery-vault" key={row.vault.policy.id}>
        <div className="small mono tempo-wrap">Vault <AccountIdentity address={row.vault.policy.vault} network={workspace.config?.network ?? ''} kind="contract" label="Vault" /></div>
        <p className="small">{row.method === 'withdraw' ? `Stop and return ${tempoDecimal(row.vault.state!.balance)} ${token}` : row.method === 'revoke' ? 'Stop agent access · empty vault' : row.error ? 'Vault state unavailable' : 'No new transaction needed'}{row.method ? ' · 1 owner transaction' : ''}</p>
        {row.vault.sourceError ? <p className="small muted">{row.vault.sourceError} Owner recovery remains available.</p> : null}
        {Object.entries(row.journalErrors).map(([channel, error]) => <p className="small gate" role="alert" key={channel}>{channel === 'spending' ? 'Spending' : channel === 'revoke' ? 'Revocation' : 'Withdrawal'} requests: {error}</p>)}
        {tempoStopBlocker(row) ? <p className="small gate" role="alert">{tempoStopBlocker(row)}</p> : null}
        {originalFor(row) && !tempoStopBlocker(row) ? <p className="small muted">Approves the original saved request shown below.</p> : null}
        {row.records.map(record => {
          const hash = record.transactionHash ?? record.operation?.transactionHash, url = tempoTransactionLink(hash, workspace.config!);
          return <div className="tempo-original" key={record.id}><p className="small">{TEMPO_METHOD_LABEL[record.method]} · {tempoRecordStatus(record)}</p><div className="small mono tempo-wrap">Request: {record.id}</div>{hash ? <div className="small mono tempo-wrap">{url ? <a href={url} target="_blank" rel="noreferrer">{hash}<ExternalLink size={12} aria-hidden="true" /></a> : hash}</div> : null}<div className="btn-row"><button type="button" className="btn" disabled={busy} onClick={() => void recover(row, record)}>Check original status</button></div></div>;
        })}
        {row.result ? <p className="small" role="status">{row.result}</p> : null}
      </li>)}</ol> : null}
      {!finished && rows.length ? <form onSubmit={event => {event.preventDefault(); void perform();}}>
        <dl className="facts"><div><dt>Network</dt><dd>{network}</dd></div><div><dt>Owner</dt><dd className="mono tempo-wrap">{workspace.owner ? <AccountIdentity address={workspace.owner} network={workspace.config?.network ?? ''} label="Owner" /> : null}</dd></div><div><dt>Wallet transactions</dt><dd>{eligible.length}, requested one at a time</dd></div><div><dt>Available to return</dt><dd>{tempoDecimal(total)} {token}<span className="tempo-review-note">Returns the remaining balance at execution. Network fees are separate.</span></dd></div></dl>
        {rows.length > eligible.length ? <p className="small muted">Vaults awaiting verification or original request recovery are skipped. Their saved requests are preserved.</p> : null}
        <label className="tempo-consent"><input type="checkbox" checked={consent} disabled={busy || !eligible.length} onChange={event => setConsent(event.target.checked)} />I authorize the {eligible.length} owner transaction{eligible.length === 1 ? '' : 's'} listed above on {network}.</label>
        <div className="btn-row"><button type="button" className="btn" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !consent || !eligible.length}>Approve in wallet</button></div>
      </form> : null}
      <div className="btn-row"><button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>Refresh review</button><button type="button" className="btn" disabled={busy} onClick={close}>{finished ? 'Done' : 'Close'}</button></div>
      {hasRecovery ? <p className="small muted">Checking an original status never asks your wallet to sign or sends a new transaction.</p> : null}
    </> : null}</dialog>
  </div>;
}
export default TempoStopAll;
