import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {Check, CircleAlert, Copy, Download, ExternalLink, X} from 'lucide-react';
import {isAddress, zeroAddress, type Address} from 'viem';
import {Section, Spinner} from '../shell/Shell';
import SkillFile from '../policy/SkillFile';
import SpendingSetupHead from '../policy/SpendingSetup';
import type {MicroPolicy} from '../micro/micro-contracts';
import {TempoAPI, TempoLifecycle, pendingTempoRecord, tempoChannel, tempoStore, type TempoCustodyState, type TempoExecutionSnapshot, type TempoRecord} from './tempo-api';
import {bytes32, sameAddress, tempoDecimal, tempoUnits, type TempoConfig, type TempoMethod, type TempoOwnerInput, type TempoPolicy} from './tempo-contracts';
import {TEMPO_METHOD_LABEL, tempoActivity, tempoRecordStatus, tempoTransactionLink} from './tempo-view';
import {answerTempoInput, checkTempoWallet, sendTempoTransaction, type TempoProvider} from './tempo-wallet';
import {rememberedWallet, useEvmWallets} from './evm-wallets';
import {buildTempoSkill} from './tempo-skill';
import {tempoManagedReady, TEMPO_MANAGED_UNAVAILABLE} from './tempo-managed';
import TempoPurchaseDetails from './TempoPurchaseDetails';
import {sectionTitle} from '../policy/policy-sections';
import RevokeDialog, {type RevokeCopy, type RevokeRun} from '../policy/RevokeDialog';
import AccountIdentity from '../wallet/AccountIdentity';
import {compactAddress} from '../wallet/account-identity';
import './tempo.css';

/** Custody and immutable source are independent: source failure never hides an owner's funded vault. */
export interface TempoVault extends TempoCustodyState {policy: TempoPolicy; draftId: string | null; stateError: string}
export interface TempoWorkspace {
  config: TempoConfig | null;
  loaded: boolean;
  /** Every owned vault must have a checked binding before a draft can be treated as unbound. */
  settled: boolean;
  vaults: readonly TempoVault[];
  error: string;
  vaultFor: (draftId: string) => TempoVault | null;
  recoveryVaults: (draftIds: ReadonlySet<string>) => TempoVault[];
  reload: () => Promise<void>;
  /** Pause background reads while an owner request is signed or reconciled. */
  beginOperation: () => () => void;
  provider: TempoProvider | undefined;
  api: TempoAPI | null;
  owner: Address | null;
}
const TempoContext = createContext<TempoWorkspace | null>(null);
export const useTempoWorkspaceContext = () => useContext(TempoContext);
export function TempoWorkspaceProvider({value, children}: {value: TempoWorkspace | null; children: ReactNode}) {
  return <TempoContext.Provider value={value}>{children}</TempoContext.Provider>;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request could not be completed.';

export function useTempoWorkspace(owner: string, enabled: boolean): TempoWorkspace {
  const wallets = useEvmWallets();
  const provider = wallets.find(w => w.id === rememberedWallet())?.provider ?? window.ethereum;
  const [config, setConfig] = useState<TempoConfig | null>(null);
  const [vaults, setVaults] = useState<{scope: string; list: TempoVault[]}>({scope: '', list: []});
  const [failure, setFailure] = useState<{scope: string; text: string}>({scope: '', text: ''});
  const address = enabled && isAddress(owner) ? owner : null;
  const scope = config && address ? `${config.chainId}:${address.toLowerCase()}:${config.factory.toLowerCase()}` : '';
  const scopeRef = useRef(scope), generation = useRef(0), operations = useRef(0), mounted = useRef(true), retained = useRef(vaults);
  scopeRef.current = scope; retained.current = vaults;
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; ++generation.current;};}, []);
  useEffect(() => {
    if (!enabled) {setConfig(null); return;}
    let live = true;
    TempoAPI.config().then(c => {if (live) setConfig(c);}, e => {if (live) setFailure({scope: '', text: errorText(e)});});
    return () => {live = false;};
  }, [enabled]);
  const api = useMemo(() => config && address ? new TempoAPI(config, address) : null, [config, address]);
  const reload = useCallback(async () => {
    if (!config || !address || !scope || scope !== scopeRef.current) return;
    const readGeneration = ++generation.current;
    const current = () => mounted.current && readGeneration === generation.current && scope === scopeRef.current;
    try {
      const reader = new TempoAPI(config, address), policies = await reader.policies();
      if (!current()) return;
      const list: TempoVault[] = [];
      for (const policy of policies) {
        try {
          const reply = await reader.custodyState(policy);
          if (!current()) return;
          list.push({...reply, policy, draftId: reply.boundExecutionPolicyId, stateError: ''});
        } catch (e) {
          if (!current()) return;
          const previous = retained.current.scope === scope ? retained.current.list.find(v => v.policy.id === policy.id) : undefined;
          if (previous) list.push({...previous, policy, stateError: errorText(e)});
          else list.push({policy, draftId: null, state: null, operations: [], pendingInputs: [], executionPolicy: null,
            boundExecutionPolicyId: null, boundSnapshot: null, sourceError: '', activityError: '', inputError: '', stateError: errorText(e)});
        }
      }
      if (current()) {setVaults({scope, list}); setFailure({scope, text: ''});}
    } catch (e) {
      if (current()) {
        const text = errorText(e);
        setFailure({scope, text});
        setVaults(previous => previous.scope === scope ? {...previous, list: previous.list.map(v => ({...v, stateError: text}))} : previous);
      }
      throw e;
    }
  }, [config, address, scope]);
  useEffect(() => {
    ++generation.current;
    if (!scope) return;
    let checking = false;
    const update = async () => {
      if (checking || document.hidden || operations.current) return;
      checking = true;
      try {await reload();} catch {/* The scoped read records the error. */}
      finally {checking = false;}
    };
    void update();
    const timer = setInterval(() => void update(), 10000), visible = () => {if (!document.hidden) void update();};
    document.addEventListener('visibilitychange', visible);
    return () => {++generation.current; clearInterval(timer); document.removeEventListener('visibilitychange', visible);};
  }, [scope, reload]);
  const beginOperation = useCallback(() => {
    ++operations.current; ++generation.current;
    let released = false;
    return () => {if (!released) {released = true; --operations.current;}};
  }, []);
  const list = scope && vaults.scope === scope ? vaults.list : [];
  const primary = (draftId: string) => {const bound = list.filter(v => v.draftId === draftId); return bound.find(v => v.state) ?? bound.at(-1) ?? null;};
  return {
    config, error: failure.scope === scope || (!config && failure.scope === '') ? failure.text : '', provider, api, owner: address,
    reload, beginOperation, loaded: !!scope && vaults.scope === scope,
    settled: !!scope && vaults.scope === scope && !(failure.scope === scope && failure.text)
      && list.every(v => !v.stateError && v.draftId !== null && v.boundSnapshot !== null), vaults: list,
    vaultFor: primary,
    recoveryVaults: draftIds => list.filter(v => v.draftId === null || !draftIds.has(v.draftId) || primary(v.draftId)?.policy.id !== v.policy.id),
  };
}

export type TempoPhase = 'Checking vault' | 'Draft' | 'Setup pending' | 'Ready' | 'Stopped' | 'Funds returned';
export function tempoPhase(vault: TempoVault | null, loaded = true): TempoPhase {
  if (!loaded || vault?.stateError) return 'Checking vault';
  if (!vault) return 'Draft';
  if (!vault.state) return 'Setup pending';
  if ((vault.state.revoked || vault.state.approved === false) && vault.state.balance === '0'
    && vault.operations.some(op => op.method === 'withdraw' && op.status === 'settled')) return 'Funds returned';
  return vault.state.revoked || vault.state.approved === false ? 'Stopped' : 'Ready';
}
type Action = 'deploy' | 'fund' | 'revoke' | 'withdraw';
const TITLES: Record<Action, string> = {deploy: 'Review funding', fund: 'Add funds', revoke: 'Stop spending', withdraw: 'Stop and return funds'};
const exact = (value: string) => tempoDecimal(tempoUnits(value.trim()));
/** A newer editor revision cannot stand in for the immutable source that the vault actually uses. */
export function sameTempoDraft(draft: MicroPolicy, snapshot: TempoExecutionSnapshot | null): boolean {
  try {return !!snapshot && snapshot.policyId === draft.id && snapshot.revision === draft.revision && snapshot.code === draft.code
    && bytes32(snapshot.sourceHash) === bytes32(draft.sourceHash) && snapshot.originalIntent === (draft.originalIntent ?? '');}
  catch {return false;}
}

/** Main's source and workflow remain shared; funding adds a separate native custody mandate. */
/** `revokeRequested` comes from the policy's close button in the list: it opens the shared revoke dialog. */
export function TempoFunding({draft, workspace, raise, unsaved = false, revokeRequested = false, revokeHandled}: {draft: MicroPolicy; workspace: TempoWorkspace; raise: (m: string) => void; unsaved?: boolean; revokeRequested?: boolean; revokeHandled?: () => void}) {
  const {config, api, owner} = workspace, vault = workspace.vaultFor(draft.id);
  const suggested = draft.fundingRequest?.amount || draft.limit || '';
  const [total, setTotal] = useState(suggested);
  const [busy, setBusy] = useState(false), [newPolicyId, setNewPolicyId] = useState<string | null>(null);
  const inFlight = useRef(false), scopeRef = useRef('');
  const scope = `${config?.chainId}:${owner?.toLowerCase()}:${draft.id}:${draft.revision}:${draft.sourceHash}`;
  scopeRef.current = scope;
  const token = config?.tokenSymbol ?? 'tokens', network = config?.network === 'tempo:localnet' ? 'Tempo Localnet' : 'Tempo Testnet';
  async function createVault() {
    if (inFlight.current || blockers.length) return;
    if (!config || !tempoManagedReady(config)) {raise(TEMPO_MANAGED_UNAVAILABLE); return;}
    inFlight.current = true; setBusy(true);
    const startingScope = scope, release = workspace.beginOperation();
    try {
      const t = exact(total);
      if (tempoUnits(t) <= 0n) throw new Error('Enter an amount greater than zero.');
      if (draft.fundingRequest?.amount && tempoUnits(t) > tempoUnits(draft.fundingRequest.amount)) throw new Error('The funding amount exceeds the budget in the reviewed policy. Adjust the policy before increasing it.');
      if (!api || !workspace.provider || !owner) throw new Error('Connect your Tempo wallet to continue.');
      await checkTempoWallet(workspace.provider, api.config, owner);
      if (startingScope !== scopeRef.current) return;
      const generated = await api.generate({totalLimit: draft.fundingRequest?.amount ?? t, executionPolicyId: draft.id, expectedRevision: draft.revision, expectedSourceHash: draft.sourceHash});
      if (startingScope !== scopeRef.current) return;
      const binding = generated.executionPolicy ? JSON.parse(generated.executionPolicy.bindingJson) as TempoExecutionSnapshot : null;
      if (!sameTempoDraft(draft, binding)) throw new Error('The vault snapshot changed the policy you reviewed. Refresh before funding.');
      if (tempoUnits(t) > tempoUnits(generated.policy.totalLimit)) throw new Error('The deposit exceeds the reviewed policy budget.');
      setNewPolicyId(generated.policy.id); await workspace.reload();
    } catch (e) {if (startingScope === scopeRef.current) raise(errorText(e));}
    finally {release(); inFlight.current = false; if (startingScope === scopeRef.current) setBusy(false);}
  }
  if (config && workspace.loaded && vault) return <TempoVaultPanel vault={vault} draft={draft} workspace={workspace} raise={raise} revokeRequested={revokeRequested} revokeHandled={revokeHandled} openDeployment={newPolicyId === vault.policy.id} initialAmount={newPolicyId === vault.policy.id ? total : undefined} />;
  // Like Solana, the funding layout and its Approve action always show; whatever stops setup is listed above the action.
  const deployment = !config || config.sourceDerivedFunding !== true || !tempoManagedReady(config);
  const blockers = [
    ...(!config ? [workspace.error || 'Loading Tempo settings…'] : []),
    ...(config && !workspace.loaded ? [workspace.error || 'Checking your Tempo vaults…'] : []),
    ...(config && config.sourceDerivedFunding !== true ? ['Funding from reviewed rules is unavailable on this deployment. Existing vaults can still be checked, stopped and returned.'] : []),
    ...(config && config.sourceDerivedFunding === true && !tempoManagedReady(config) ? [`${TEMPO_MANAGED_UNAVAILABLE} Funding a new policy is paused.`] : []),
    ...(draft.status !== 'draft' ? ['This policy is stopped. Fork it to review and fund a new draft.'] : []),
    ...(unsaved ? ['Save or discard rule changes before funding.'] : []),
    ...(config && workspace.loaded && !workspace.settled ? ['The binding of every owned vault must be checked before funding another draft.'] : [])];
  const check = () => deployment ? window.location.reload() : void workspace.reload().catch(e => raise(errorText(e)));
  return <Section id="p-approve" title={sectionTitle('p-approve')}>
    <SpendingSetupHead intro="Set up spending for this policy." network={`${network} · ${token}`} currentStep={1} />
    <form className="form tempo-setup-form" onSubmit={event => {event.preventDefault(); void createVault();}} noValidate>
      <div className="native-review">
        <h3>Review before signing</h3>
        <dl className="facts">
          <div><dt>Funding</dt><dd>{draft.fundingRequest ? <>{draft.fundingRequest.amount} {token} <span className="native-fact-note">requested</span></> : <span className="native-fact-note">Choose the amount below</span>}</dd></div>
          <div><dt>Recipient</dt><dd>Recipients from reviewed rules</dd></div>
          <div><dt>Daily vault ceiling</dt><dd><span className="native-fact-note">Verified from the selected policy at setup</span></dd></div>
          <div><dt>Action limit</dt><dd><span className="native-fact-note">Verified from the selected policy at setup</span></dd></div>
          <div><dt>Vault status</dt><dd role="status"><span className="native-fact-status">Not funded</span></dd></div>
        </dl>
      </div>
      <div className="field"><label htmlFor="tempo-total">Amount to fund</label><input id="tempo-total" className="num" inputMode="decimal" value={total} disabled={busy || unsaved} onChange={event => setTotal(event.target.value)} /><span className="field-hint">{token}{draft.fundingRequest ? ` · Requested: ${draft.fundingRequest.amount} ${token}` : ''}</span></div>
      <p className="small muted native-signing-note">Two wallet transactions: approve the exact token amount, then create and fund the vault. An approval alone does not fund the vault. Later approved payments do not need another owner transaction signature.</p>
      <details className="native-details">
        <summary>Setup details and policy binding</summary>
        <dl className="facts"><div><dt>Policy binding</dt><dd className="mono tempo-wrap">Revision {draft.revision} · {draft.sourceHash}</dd></div></dl>
        <p className="small muted">Every payment is checked against the exact Rust policy. You review the final vault ceilings before signing; they can narrow these rules. Signing in is a separate message signature. Network fees are separate.</p>
      </details>
      {blockers.length ? <div className="small native-setup-blockers" role="status"><p>Before setup:</p><ul>{blockers.map(reason => <li key={reason}>{reason}</li>)}</ul></div> : null}
      <div className="btn-row native-signing-actions">
        <button type="submit" className="btn btn-primary" disabled={busy || blockers.length > 0 || !total}>{busy ? <Spinner /> : null}Review and sign</button>
        <button type="button" className="btn" disabled={busy} onClick={check}>Check vault status</button>
      </div>
    </form>
  </Section>;
}

/** Owner recovery stays discoverable even when no valid binding can associate a vault with a listed draft. */
export function TempoOwnerRecovery({workspace, draftIds, raise}: {workspace: TempoWorkspace; draftIds: ReadonlySet<string>; raise: (m: string) => void}) {
  const vaults = workspace.recoveryVaults(draftIds);
  return vaults.length ? <Section id="tempo-owner-recovery" title="Other Tempo vaults"><p className="small muted">These vaults belong to your wallet. Review each separately to check original requests, revoke access and withdraw remaining funds.</p>{vaults.map(vault => <details className="tempo-recovery-vault" key={vault.policy.id}><summary className="mono tempo-wrap" title={vault.policy.vault}>{'Vault ' + compactAddress(vault.policy.vault)}</summary><AccountIdentity address={vault.policy.vault} network={workspace.config?.network ?? ''} kind="contract" label="Vault" /><TempoVaultPanel vault={vault} workspace={workspace} raise={raise} /></details>)}</Section> : null;
}

function TempoVaultPanel({vault, draft, workspace, raise, openDeployment = false, initialAmount, revokeRequested = false, revokeHandled}: {vault: TempoVault; draft?: MicroPolicy; workspace: TempoWorkspace; raise: (m: string) => void; openDeployment?: boolean; initialAmount?: string; revokeRequested?: boolean; revokeHandled?: () => void}) {
  const {config, api, owner, provider} = workspace;
  const token = config?.tokenSymbol ?? 'tokens', network = config?.network === 'tempo:localnet' ? 'Tempo Localnet' : 'Tempo Testnet', accountNetwork = config?.network ?? '';
  const scope = config && owner ? `${config.chainId}:${owner.toLowerCase()}:${vault.policy.id}` : '';
  const scopeRef = useRef(scope), live = useRef(true);
  scopeRef.current = scope;
  const draftRef = useRef(draft), vaultRef = useRef(vault);
  draftRef.current = draft; vaultRef.current = vault;
  const [amount, setAmount] = useState(initialAmount ?? vault.policy.totalLimit), [review, setReview] = useState<Action | null>(null), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [records, setRecords] = useState<TempoRecord[]>([]), [record, setRecord] = useState<TempoRecord | null>(null);
  const [confirmedApproval, setConfirmedApproval] = useState<TempoRecord | null>(null);
  const [flowStep, setFlowStep] = useState<'review' | 'wallet' | 'result'>('review'), [flowRecord, setFlowRecord] = useState<TempoRecord | null>(null), [flowError, setFlowError] = useState(''), [walletStep, setWalletStep] = useState(''), [walletError, setWalletError] = useState('');
  const inFlight = useRef(false), dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLElement | null>(null), journalGeneration = useRef(0), autoOpened = useRef('');
  const state = vault.state, phase = tempoPhase(vault), ready = phase === 'Ready', custodyAvailable = !vault.stateError;
  const managedReady = !!config && tempoManagedReady(config, vault.policy, vault.managedExecution);
  const sourceMatches = !!draft && sameTempoDraft(draft, vault.boundSnapshot) && !!vault.executionPolicy && !vault.sourceError;
  const balance = state ? BigInt(state.balance) : 0n;
  const pending = records.some(r => tempoChannel(r.method) === 'spending' && pendingTempoRecord(r));
  const handoffPending = records.some(pendingTempoRecord), pendingRef = useRef(handoffPending), workspaceRef = useRef(workspace);
  pendingRef.current = handoffPending; workspaceRef.current = workspace;
  const [promptCopied, setPromptCopied] = useState(false);
  const emergencyPending = (method: 'revoke' | 'withdraw') => records.some(r => r.method === method && pendingTempoRecord(r));
  const activity = config ? tempoActivity(vault.policy, config, records, vault.operations) : [];
  const unanswered = (vault.pendingInputs ?? []).filter(input => !input.answered);
  // History and Usage appear once they have something to show, as on Solana.
  // The original owner request stays under Funding, as a pending Solana proof does, so it does not open History by itself.
  const historyShown = activity.length > 0 || unanswered.length > 0 || !!vault.activityError;
  const confirmedPayments = activity.filter(entry => entry.method === 'execute' && entry.status === 'Confirmed').length;
  const current = () => live.current && scopeRef.current === scope;
  const currentSource = () => !!draftRef.current && sameTempoDraft(draftRef.current, vaultRef.current.boundSnapshot)
    && !!vaultRef.current.executionPolicy && !vaultRef.current.sourceError;
  const currentHandoff = () => current() && currentSource() && !vaultRef.current.stateError
    && !workspaceRef.current.error && tempoPhase(vaultRef.current) === 'Ready' && !pendingRef.current
    && !!workspaceRef.current.config && tempoManagedReady(workspaceRef.current.config, vaultRef.current.policy, vaultRef.current.managedExecution);
  const handoff = useMemo(() => {
    if (!config || !managedReady || !sourceMatches || !ready || handoffPending || workspace.error || !vault.boundSnapshot) return null;
    try {return buildTempoSkill(config, vault.policy, vault.boundSnapshot, window.location.origin);} catch {return null;}
  }, [config, managedReady, sourceMatches, ready, handoffPending, workspace.error, vault.policy, vault.boundSnapshot]);
  useEffect(() => {setPromptCopied(false);}, [scope, handoff?.prompt]);
  useEffect(() => {if (!promptCopied) return; const timer = setTimeout(() => setPromptCopied(false), 2000); return () => clearTimeout(timer);}, [promptCopied]);
  function lifecycle(method: TempoMethod = 'fund') {
    return api && config && owner ? new TempoLifecycle(api, vault.policy, tempoStore(config, owner, vault.policy, tempoChannel(method)), async tx => {
      const beforeSend = () => {
        if (!current()) throw Object.assign(new Error('The selected owner or vault changed. Keep the original request for recovery.'), {beforeSend: true});
        if (tempoChannel(method) === 'spending' && (!workspaceRef.current.config || !tempoManagedReady(workspaceRef.current.config, vaultRef.current.policy, vaultRef.current.managedExecution))) throw Object.assign(new Error(TEMPO_MANAGED_UNAVAILABLE), {beforeSend: true});
        if (tempoChannel(method) === 'spending' && !currentSource()) throw Object.assign(new Error('The displayed policy changed. Review the vault’s exact source before signing.'), {beforeSend: true});
      };
      beforeSend();
      if (!provider) throw Object.assign(new Error('Connect your Tempo wallet to continue.'), {beforeSend: true});
      return sendTempoTransaction(provider, config, tx, beforeSend);
    }) : null;
  }
  async function readJournal() {
    if (!config || !owner || !current()) return;
    const generation = ++journalGeneration.current, journal = tempoStore(config, owner, vault.policy);
    const saved = await journal.entries(), latest = await journal.read();
    if (!current() || generation !== journalGeneration.current) return;
    setConfirmedApproval(latest && ['approve_deploy', 'approve_fund'].includes(latest.method) && tempoRecordStatus(latest) === 'Confirmed' ? latest : null);
    setRecords(saved); setRecord(previous => saved.find(r => r.id === previous?.id) ?? latest ?? saved.at(-1) ?? null);
  }
  useEffect(() => {live.current = true; return () => {live.current = false; ++journalGeneration.current;};}, []);
  useEffect(() => {
    ++journalGeneration.current; setRecord(null); setRecords([]); setConfirmedApproval(null); setReview(null); setConsent(false); setNotice(''); setWalletError(''); setFlowRecord(null); setFlowError('');
    void readJournal().catch(e => {if (current()) raise(errorText(e));});
    return () => {++journalGeneration.current;};
  }, [scope]);
  useEffect(() => {
    if (!provider?.on) return;
    const changed = () => {if (current()) {setWalletError('The wallet changed. Select the policy owner and Tempo network before signing.'); setConsent(false);}};
    const events = ['accountsChanged', 'chainChanged', 'disconnect'];
    for (const event of events) provider.on(event, changed);
    return () => {for (const event of events) provider.removeListener?.(event, changed);};
  }, [provider, scope]);
  function openReview(action: Action, trigger?: HTMLElement) {
    if (busy) return;
    if ((action === 'deploy' || action === 'fund') && !managedReady) {raise(TEMPO_MANAGED_UNAVAILABLE); return;}
    opener.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (confirmedApproval?.method === `approve_${action}`) setAmount(confirmedApproval.options.amount ?? '');
    setReview(action); setConsent(false); setFlowStep('review'); setFlowRecord(null); setFlowError(''); setWalletStep('');
  }
  function closeReview() {if (busy) return; setReview(null); requestAnimationFrame(() => {if (opener.current?.isConnected) opener.current.focus();});}
  useEffect(() => {if (openDeployment && managedReady && custodyAvailable && sourceMatches && !state && autoOpened.current !== scope) {autoOpened.current = scope; openReview('deploy');}}, [openDeployment, managedReady, sourceMatches, custodyAvailable, state, scope]);
  useEffect(() => {const d = dialog.current; if (!d) return; if (review && !d.open) d.showModal(); else if (!review && d.open) d.close();}, [review]);
  useEffect(() => {if (review) dialog.current?.querySelector<HTMLElement>(flowStep === 'review' ? 'input' : '.ca-dialog-heading h2')?.focus();}, [review, flowStep]);
  async function run(fn: () => Promise<void>) {
    if (inFlight.current || !current()) return;
    inFlight.current = true; setBusy(true); setNotice('');
    const release = workspace.beginOperation();
    try {await fn();} catch (e) {if (current()) {setNotice(''); raise(errorText(e));}}
    finally {if (current()) {try {await readJournal();} catch (e) {if (current()) raise(errorText(e));}} release(); inFlight.current = false; if (current()) setBusy(false);}
  }
  async function refresh() {await workspace.reload(); if (current()) await readJournal();}
  async function confirm(active: TempoLifecycle, initial: TempoRecord) {
    let result = initial;
    if (current()) {setFlowRecord(result); setRecord(result);}
    for (let attempt = 0; attempt < 15 && result.transactionHash && pendingTempoRecord(result) && current(); attempt++) {
      setWalletStep('Waiting for the verified transaction receipt…'); await new Promise(resolve => setTimeout(resolve, 2000));
      if (!current()) break;
      try {result = await active.recover(result.id) ?? result;} catch {break;}
      if (current()) {setFlowRecord(result); setRecord(result);}
    }
    return result;
  }
  async function perform() {
    const method = review, active = method ? lifecycle(method) : null;
    if (!method || !consent || !active || !config || !owner) return;
    await run(async () => {
      let baseline: TempoRecord | null = null, baselineRead = false;
      try {
        baseline = await active.store.read();
        baselineRead = true;
        if (!provider) throw new Error('Connect your Tempo wallet to continue.');
        await checkTempoWallet(provider, config, owner);
        if (!current()) return;
        setWalletError('');
        const spending = method === 'deploy' || method === 'fund';
        const snapshot = spending ? await api!.state(vault.policy) : await api!.custodyState(vault.policy);
        if (!current()) return;
        if (spending && !tempoManagedReady(config, vault.policy, snapshot.managedExecution)) throw new Error(TEMPO_MANAGED_UNAVAILABLE);
        if (spending && (!draft || !sameTempoDraft(draft, snapshot.boundSnapshot) || !snapshot.executionPolicy)) throw new Error('The displayed policy does not match this vault’s immutable snapshot. Refresh before funding.');
        if (method === 'deploy' && snapshot.state) throw new Error('This vault already exists. Refresh before continuing.');
        if (method !== 'deploy' && !snapshot.state) throw new Error('The vault could not be found. Refresh before continuing.');
        if (method === 'fund' && (snapshot.state?.revoked || snapshot.state?.approved === false)) throw new Error('Agent access is revoked. Remaining funds can be withdrawn.');
        const options = spending ? {amount: exact(amount)} : {};
        if (options.amount && tempoUnits(options.amount) <= 0n) throw new Error('Enter an amount greater than zero.');
        if (method === 'deploy' && tempoUnits(options.amount!) > tempoUnits(vault.policy.totalLimit)) throw new Error('The deposit exceeds the vault’s total budget.');
        setFlowStep('wallet'); setFlowError('');
        const progress = (prefix: string) => (message: string) => {if (current()) {setWalletStep(`${prefix}: ${message}`); setNotice(message);}};
        if (spending) {
          const retained = await active.store.read();
          const approved = retained?.method === `approve_${method}` && tempoRecordStatus(retained) === 'Confirmed' && retained.options.amount === options.amount;
          if (!current()) return;
          if (!approved) {
            const approval = await confirm(active, await active.submit(`approve_${method}` as 'approve_deploy' | 'approve_fund', options, progress('1 of 2 · Token approval')));
            if (!current()) return;
            if (tempoRecordStatus(approval) !== 'Confirmed') {setFlowStep('result'); setNotice('The token approval is not confirmed. Check its original status before the vault transaction.'); await refresh(); return;}
          }
        }
        if (!current()) return;
        const result = await confirm(active, await active.submit(method, options, progress(spending ? '2 of 2 · Vault transaction' : TITLES[method])));
        if (!current()) return;
        setRecord(result); setFlowRecord(result); setFlowStep('result'); setConsent(false);
        setNotice(tempoRecordStatus(result) === 'Confirmed' ? 'Transaction confirmed.' : tempoRecordStatus(result) === 'Failed on chain' ? 'The transaction failed on chain.' : 'The transaction is not confirmed. Check its original status before sending anything else.');
        await refresh();
      } catch (e) {
        const saved = await active.store.read().catch(() => null);
        // An earlier terminal receipt is history, not a result of this failed attempt.
        const attempted = saved && ((baselineRead && saved.id !== baseline?.id) || pendingTempoRecord(saved)) ? saved : null;
        if (current()) {setFlowRecord(attempted); setFlowStep('result'); setFlowError(errorText(e));}
        throw e;
      }
    });
  }
  // The shared revoke dialog. Tempo returns everything with withdrawRemaining(), which also stops spending; there is no partial withdrawal.
  const [revokeOpen, setRevokeOpen] = useState(false), [revokeRun, setRevokeRun] = useState<RevokeRun | null>(null);
  const [revokePhase, setRevokePhase] = useState(''), [revokeRecord, setRevokeRecord] = useState<TempoRecord | null>(null);
  useEffect(() => {if (revokeRequested) {revokeHandled?.(); setRevokeOpen(true);}}, [revokeRequested]);
  const shownBalance = state && custodyAvailable ? tempoDecimal(balance) : null;
  async function ownerStop(method: 'withdraw' | 'revoke') {
    const active = lifecycle(method);
    if (!active || !config || !owner || !api) return;
    const before = shownBalance, kind = method === 'withdraw' ? 'close' as const : 'revoke' as const;
    let ok = false, error = '';
    setRevokeRecord(null);
    setRevokeRun({method: kind, amount: null, before, ok: null, error: '', priorIds: [], priorFinal: []});
    await run(async () => {
      try {
        setRevokePhase('preparing');
        if (!provider) throw new Error('Connect your Tempo wallet to continue.');
        await checkTempoWallet(provider, config, owner);
        const snapshot = await api.custodyState(vault.policy);
        if (!current()) return;
        if (!snapshot.state) throw new Error('The vault could not be found. Refresh before continuing.');
        if (method === 'revoke' && (snapshot.state.revoked || snapshot.state.approved === false)) throw new Error('Agent spending is already stopped.');
        setRevokePhase('signing');
        const submitted = await active.submit(method, {}, message => {if (current()) setNotice(message);});
        if (!current()) return;
        setRevokePhase('sending');
        const result = await confirm(active, submitted);
        if (!current()) return;
        setRevokeRecord(result);
        ok = tempoRecordStatus(result) !== 'Failed on chain' && !!result.transactionHash;
        if (!ok) error = tempoRecordStatus(result) === 'Failed on chain' ? 'The transaction failed on chain.' : 'The transaction was not sent. Check its original status in History before sending anything else.';
        await refresh();
      } catch (e) {error = errorText(e);}
      finally {setRevokePhase('');}
    });
    if (current()) setRevokeRun({method: kind, amount: null, before, ok, error: ok ? '' : error || 'The action did not complete.', priorIds: [], priorFinal: []});
  }
  const revokeCopy: RevokeCopy = {
    token, network,
    returnText: `Stop agent spending and return all remaining ${token} to your wallet in one wallet transaction.`,
    stopText: `Revokes the vault’s spending approval. Remaining ${token} stays in the vault until you return it.`,
    returnedText: 'Everything left in the vault is back in your wallet, and agent spending is stopped.',
    keptUntil: 'until you return it',
    stopLabel: 'Revoke vault',
  };
  const revokeHash = revokeRecord?.transactionHash ?? null;
  const revokeOutcome = revokeRun && revokeRun.ok !== null ? {final: !!revokeRecord && tempoRecordStatus(revokeRecord) === 'Confirmed', expired: false, link: revokeHash && config ? tempoTransactionLink(revokeHash, config) ?? undefined : undefined} : undefined;
  const finishRevoke = () => {setRevokeRun(null); setRevokeOpen(false);};
  const closeRevoke = () => {if (busy || revokeRun?.ok === null) return; if (revokeRun) finishRevoke(); else setRevokeOpen(false);};
  async function recover() {
    const selected = record, active = selected ? lifecycle(selected.method) : null;
    if (!active || !selected) return;
    await run(async () => {
      const result = await active.recover(selected.id);
      if (!current()) return;
      setRecord(result); if (review) {setFlowRecord(result); setFlowStep('result');}
      setNotice(result && tempoRecordStatus(result) === 'Confirmed' ? 'The original transaction is confirmed.' : result && tempoRecordStatus(result) === 'Failed on chain' ? 'The original transaction failed.' : 'The original request is still unconfirmed. No new transaction was sent.');
      await refresh();
    });
  }
  async function resumeOriginal() {
    const selected = record, active = selected ? lifecycle(selected.method) : null;
    if (!active || !selected || !['prepared', 'preparing', 'declined'].includes(selected.phase)) return;
    await run(async () => {
      if (!provider || !owner || !config) throw new Error('Connect your Tempo wallet to continue.');
      await checkTempoWallet(provider, config, owner);
      if (!current()) return;
      if (tempoChannel(selected.method) === 'spending') {
        const snapshot = await api!.state(vault.policy);
        if (!tempoManagedReady(config, vault.policy, snapshot.managedExecution)) throw new Error(TEMPO_MANAGED_UNAVAILABLE);
        if (!draft || !sameTempoDraft(draft, snapshot.boundSnapshot)) throw new Error('Review the vault’s exact bound policy before approving this original spending request.');
      }
      if (!current()) return;
      const result = await active.submit(selected.method, selected.options, message => {if (current()) setNotice(message);}, selected.id);
      if (!current()) return;
      setRecord(result); setNotice(tempoRecordStatus(result) === 'Confirmed' ? 'The original transaction is confirmed.' : 'The original transaction is not confirmed. Check its status.');
      await refresh();
    });
  }
  async function exportCapability() {
    await run(async () => {
      if (!api || !draft || !ready || !config || !managedReady || !sourceMatches) throw new Error('Fund this exact policy before exporting its agent capability.');
      const snapshot = await api.state(vault.policy);
      if (!current()) return;
      if (!sameTempoDraft(draft, snapshot.boundSnapshot) || !snapshot.state || snapshot.state.revoked || snapshot.state.approved === false) throw new Error('Refresh this vault’s policy and access before exporting.');
      if (!tempoManagedReady(config, vault.policy, snapshot.managedExecution)) throw new Error(TEMPO_MANAGED_UNAVAILABLE);
      const bundle = await api.export(vault.policy, window.location.origin);
      if (!current()) return;
      if (!currentSource()) throw new Error('The displayed policy changed. Review its bound source before exporting.');
      if (bundle.policy.id !== vault.policy.id || !sameAddress(bundle.policy.owner, owner)) throw new Error('The agent capability belongs to another policy.');
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], {type: 'application/json'}));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = `allowit-tempo-${vault.policy.id}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  async function prepareHandoff(): Promise<ReturnType<typeof buildTempoSkill> | null> {
    let prepared: ReturnType<typeof buildTempoSkill> | null = null;
    await run(async () => {
      if (!api || !config || !owner || !currentHandoff()) throw new Error('Refresh this vault’s exact policy and access before sharing its instructions.');
      // Public instructions are read-only and never request private payment authority.
      const snapshot = await api.state(vault.policy);
      if (!current()) return;
      const saved = await tempoStore(config, owner, vault.policy).entries();
      if (!current()) return;
      if (!currentHandoff() || !draftRef.current || !sameTempoDraft(draftRef.current, snapshot.boundSnapshot)
        || !snapshot.executionPolicy || snapshot.sourceError || !snapshot.state || snapshot.state.revoked || snapshot.state.approved === false
        || !tempoManagedReady(config, vault.policy, snapshot.managedExecution) || saved.some(pendingTempoRecord)) {
        throw new Error('Refresh this vault’s exact policy and access before sharing its instructions.');
      }
      prepared = buildTempoSkill(config, vault.policy, snapshot.boundSnapshot!, window.location.origin);
    });
    return currentHandoff() ? prepared : null;
  }
  async function copyPrompt() {
    const instructions = await prepareHandoff();
    if (!instructions || !currentHandoff()) return;
    try {await navigator.clipboard.writeText(instructions.prompt); if (currentHandoff()) setPromptCopied(true);}
    catch {if (currentHandoff()) raise('Copy failed. Select the harness prompt and copy it.');}
  }
  async function answer(input: TempoOwnerInput, approved: boolean) {
    await run(async () => {
      if (!provider || !config || !sourceMatches) throw new Error('Review this vault’s exact policy and connect its owner before answering.');
      await answerTempoInput(provider, config, vault.policy, input, approved);
      if (!current()) return;
      setNotice('Your answer is recorded. The agent continues the same request; this message did not move funds.'); await refresh();
    });
  }
  if (!config || !owner) return null;
  const recordHash = record?.transactionHash ?? record?.operation?.transactionHash, recordLink = tempoTransactionLink(recordHash, config);
  const flowHash = flowRecord?.transactionHash ?? flowRecord?.operation?.transactionHash, flowLink = tempoTransactionLink(flowHash, config);
  const sourceWarning = vault.sourceError || (draft && !sameTempoDraft(draft, vault.boundSnapshot) ? 'The displayed policy differs from the immutable revision bound to this vault.' : !draft ? 'This recovery view does not display this vault’s bound policy.' : '');
  const approvalConfirmed = confirmedApproval?.method === `approve_${review}` && confirmedApproval.options.amount === amount;
  const setup = activity.find(entry => entry.method === 'deploy' && entry.status === 'Confirmed'), setupLink = tempoTransactionLink(setup?.transactionHash, config);
  const currentStep = phase === 'Funds returned' ? undefined : !state ? 1 : ready ? 2 : undefined;
  // Like a pending Solana proof, the original owner request stays in Funding, where its transaction was asked for.
  const original = record ? <>
    <details className="tempo-original" open={pendingTempoRecord(record)}><summary>Owner request · {tempoRecordStatus(record)}</summary><dl className="facts"><div><dt>Operation</dt><dd>{TEMPO_METHOD_LABEL[record.method]}</dd></div>{record.options.amount ? <div><dt>Amount</dt><dd>{record.options.amount} {token}</dd></div> : null}<div><dt>Status</dt><dd>{tempoRecordStatus(record)}</dd></div><div><dt>Request</dt><dd className="mono tempo-wrap">{record.id}</dd></div>{recordHash ? <div><dt>Transaction</dt><dd className="mono tempo-wrap">{recordHash}</dd></div> : null}{['Confirmed', 'Failed on chain'].includes(tempoRecordStatus(record)) && record.operation?.blockNumber != null ? <div><dt>Verified block</dt><dd className="mono">{String(record.operation.blockNumber)}</dd></div> : null}</dl>{recordLink ? <a className="small" href={recordLink} target="_blank" rel="noreferrer">View on Tempo Explorer</a> : null}<div className="btn-row"><button type="button" className="btn" disabled={busy} onClick={() => void recover()}>Check original status</button>{pendingTempoRecord(record) && ['prepared', 'preparing', 'declined'].includes(record.phase) ? <button type="button" className="btn" disabled={busy || (tempoChannel(record.method) === 'spending' && (!sourceMatches || !managedReady))} onClick={() => void resumeOriginal()}>Approve the original transaction</button> : null}{tempoRecordStatus(record) === 'Confirmed' && (record.method === 'approve_deploy' || record.method === 'approve_fund') ? <button type="button" className="btn" disabled={busy || !sourceMatches || !managedReady} onClick={event => {setAmount(record.options.amount ?? ''); openReview(record.method === 'approve_deploy' ? 'deploy' : 'fund', event.currentTarget);}}>Continue the vault transaction</button> : null}</div>{pendingTempoRecord(record) ? <p className="small muted">This request is unresolved. A status check uses its original identity and never sends another transaction.</p> : null}</details>
    {records.length > 1 ? <div className="field"><label htmlFor={`tempo-record-${vault.policy.id}`}>Saved transaction</label><select id={`tempo-record-${vault.policy.id}`} value={record?.id ?? ''} disabled={busy} onChange={event => setRecord(records.find(r => r.id === event.target.value) ?? null)}>{records.map(r => <option value={r.id} key={r.id}>{TEMPO_METHOD_LABEL[r.method]} · {tempoRecordStatus(r)} · {r.id.slice(0, 8)}</option>)}</select></div> : null}
  </> : null;
  return <div className="tempo-vault-panel">
    <Section id={draft ? 'p-approve' : `tempo-custody-${vault.policy.id}`} title={sectionTitle('p-approve')}>
      <SpendingSetupHead intro={phase === 'Funds returned' ? 'Funds were returned to your wallet. Policy history is preserved.' : 'Set up spending for this policy.'} network={`${network} · ${token}`} currentStep={currentStep} />
      {notice ? <p className="tempo-notice" role="status">{busy ? <Spinner /> : null}<span>{notice}</span></p> : null}
      {walletError ? <p className="tempo-notice" role="alert"><span>{walletError}</span></p> : null}
      {sourceWarning ? <p className="tempo-notice" role="alert"><span>{sourceWarning} Funding and agent export require its checked source. You can still recover requests, revoke access and withdraw.</span></p> : null}
      {vault.inputError ? <p className="tempo-notice" role="alert"><span>{vault.inputError}</span></p> : null}
      {vault.stateError ? <p className="tempo-notice" role="alert"><span>{vault.stateError} Refresh to verify the current balance and access.</span></p> : null}
      <div className="native-review">
        <h3>{state ? 'Spending setup' : 'Review before signing'}</h3>
        <dl className="facts">
          <div><dt>Funding</dt><dd>{vault.policy.totalLimit} {token} budget</dd></div>
          <div><dt>Recipient wallet</dt><dd className="mono tempo-wrap">{sameAddress(vault.policy.recipient, zeroAddress) ? 'Recipients from reviewed rules' : <AccountIdentity address={vault.policy.recipient} network={accountNetwork} label="Recipient wallet" />}</dd></div>
          <div><dt>Daily vault ceiling (UTC day)</dt><dd>{vault.policy.dailyLimit} {token}</dd></div>
          <div><dt>Action limit</dt><dd>{vault.policy.actionLimit} {token}</dd></div>
          <div><dt>Vault status</dt><dd role="status"><span className="native-fact-status tempo-vault-status">{!custodyAvailable ? 'Not verified' : state ? !ready ? phase === 'Funds returned' ? 'Funds returned' : 'Access revoked' : 'Active' : 'Not created'}</span></dd></div>
          <div><dt>Vault balance</dt><dd className="tempo-balance">{!custodyAvailable ? 'State unavailable' : state ? `${tempoDecimal(balance)} ${token}` : 'Not funded'}</dd></div>
          {setup?.transactionHash ? <div><dt>Setup transaction</dt><dd>{setupLink ? <a href={setupLink} target="_blank" rel="noreferrer">Confirmed on {network}</a> : <span className="mono tempo-wrap">{setup.transactionHash}</span>}</dd></div> : null}
        </dl>
      </div>
      {!state ? <p className="small muted native-signing-note">Two wallet transactions: approve the exact token amount, then create and fund the vault. An approval alone does not fund the vault. Later approved payments do not need another owner transaction signature.</p> : null}
      <details className="native-details">
        <summary>Setup details and policy binding</summary>
        <dl className="facts"><div><dt>Vault</dt><dd className="mono tempo-wrap"><AccountIdentity address={vault.policy.vault} network={accountNetwork} kind="contract" label="Vault" /></dd></div>{vault.boundSnapshot ? <div><dt>Policy binding</dt><dd className="mono tempo-wrap">Revision {vault.boundSnapshot.revision} · {vault.boundSnapshot.sourceHash}</dd></div> : null}</dl>
        <p className="small muted">Every payment is checked against the exact Rust policy. Vault ceilings can narrow these rules. Signing in is a separate message signature. Network fees are separate.</p>
      </details>
      <div className="btn-row native-signing-actions">{!state ? <button type="button" className="btn btn-primary" disabled={busy || pending || !custodyAvailable || !sourceMatches || !managedReady} onClick={event => openReview('deploy', event.currentTarget)}>Review and sign</button> : <button type="button" className="btn" disabled={busy || pending || !ready || !sourceMatches || !managedReady} onClick={event => openReview('fund', event.currentTarget)}>Add funds</button>}<button type="button" className="btn" disabled={busy} onClick={() => void run(refresh)}>Check vault status</button></div>
      {original}
    </Section>
    {draft ? <Section id="p-handoff" title={sectionTitle('p-handoff')}>{!managedReady ? <p className="small" role="status">{TEMPO_MANAGED_UNAVAILABLE}</p> : !ready || !sourceMatches ? <p className="small muted">Agent access is available after funding is confirmed and this exact policy revision is verified.</p> : handoff ? <><SkillFile key={`${scope}:${draft.revision}:${draft.sourceHash}`} content={handoff.skill} disabled={busy || pending} prepareContent={async () => (await prepareHandoff())?.skill ?? null} isCurrent={currentHandoff} /><div className="field"><label htmlFor={`tempo-harness-${vault.policy.id}`}>Harness prompt</label><textarea id={`tempo-harness-${vault.policy.id}`} className="mono harness-textarea" readOnly value={handoff.prompt} onFocus={event => event.currentTarget.select()} /><div className="btn-row"><button type="button" className="btn" disabled={busy || pending} onClick={() => void copyPrompt()}>{promptCopied ? <Check size={15} /> : <Copy size={15} />}<span>{promptCopied ? 'Copied' : 'Copy prompt'}</span></button></div><span className="small muted" role="status">{promptCopied ? 'Prompt copied to the clipboard.' : ''}</span></div></> : null}<div className="btn-row"><button type="button" className="btn" disabled={busy || handoffPending || !ready || !sourceMatches || !managedReady} onClick={() => void exportCapability()}><Download size={15} aria-hidden="true" />Export agent capability</button></div>{managedReady && ready && sourceMatches ? <p className="small muted">The exported capability uses the managed server executor. No private key or local executor wallet is needed. Keep the capability private.</p> : null}</Section> : null}
    {historyShown ? <Section id={draft ? 'p-requests' : `tempo-requests-${vault.policy.id}`} title={sectionTitle('p-requests')}>
    {unanswered.map(input => <Section key={input.requestId} id={`p-input-${input.requestId}`} title="Your answer is needed"><p>{input.question}</p><dl className="facts"><div><dt>Payment</dt><dd>{input.amount} {input.tokenSymbol}</dd></div><div><dt>Recipient</dt><dd className="mono"><AccountIdentity address={input.recipient} network={accountNetwork} label="Recipient" /></dd></div><div><dt>Action</dt><dd>{input.action}</dd></div><div><dt>Merchant</dt><dd>{input.merchant || 'Not supplied'}</dd></div><div><dt>Request</dt><dd className="mono">{input.requestId}</dd></div></dl><details><summary className="small">Context supplied by the agent</summary><pre className="tempo-source mono">{input.contextRaw}</pre></details><div className="btn-row"><button type="button" className="btn btn-primary" disabled={busy || !sourceMatches || !custodyAvailable} onClick={() => void answer(input, true)}>Approve this request</button><button type="button" className="btn" disabled={busy || !sourceMatches || !custodyAvailable} onClick={() => void answer(input, false)}>Deny this request</button></div><p className="small muted">You sign the exact payment, question and answer. No payment is sent by this signature.</p></Section>)}
      {vault.activityError ? <p className="tempo-notice" role="alert"><span>{vault.activityError}</span></p> : null}
      {/* The same one-line entries as Solana History. Like a pending Solana proof, an entry without a confirmed explorer link keeps its block, request and hash under Details; an MPP purchase keeps its report. */}
      {activity.length ? <ul className="activity-list tempo-activity">{activity.map(entry => {
        const url = tempoTransactionLink(entry.transactionHash, config);
        return <li data-status={entry.status === 'Confirmed' ? 'settled' : entry.status === 'Failed on chain' ? 'failed' : 'pending'} key={entry.id}>
          <span>{entry.purchase?.available ? 'MPP purchase' : TEMPO_METHOD_LABEL[entry.method]} · {entry.status}</span>
          {entry.method === 'execute' && !entry.purchase ? <span className="small muted"> · Resource delivery not attested</span> : null}
          {url ? <> · <a href={url} target="_blank" rel="noreferrer">Transaction</a></> : null}
          {entry.status === 'Confirmed' && url ? null : <details className="tempo-entry-details"><summary className="small">Details</summary><dl className="facts"><div><dt>Block</dt><dd className="mono">{entry.blockNumber !== null ? entry.blockNumber : 'No confirmed block'}</dd></div><div><dt>Request</dt><dd className="mono tempo-wrap">{entry.id}</dd></div>{entry.transactionHash ? <div><dt>Transaction</dt><dd className="mono tempo-wrap">{entry.transactionHash}</dd></div> : null}</dl></details>}
          {entry.purchase ? <TempoPurchaseDetails purchase={entry.purchase} /> : null}
        </li>;
      })}</ul> : <p className="small muted">No transactions have been recorded for this vault.</p>}
    </Section> : null}
    {state ? <>
    {confirmedPayments > 0 ? <Section id={draft ? 'p-usage' : `tempo-usage-${vault.policy.id}`} title={sectionTitle('p-usage')}>
      <dl className="facts"><div><dt>Confirmed agent payments</dt><dd>{confirmedPayments}</dd></div></dl>
      <p className="small muted">Confirmed agent payments from this vault’s recorded history.</p>
    </Section> : null}
    <Section id={draft ? 'p-cancel' : `tempo-stop-${vault.policy.id}`} title={sectionTitle('p-cancel')}>
      {phase === 'Funds returned' ? <><p role="status">Funds returned</p><p className="small muted">Remaining {token} was returned to the owner wallet and agent spending is stopped. Policy history is preserved.</p></> : <>
        {emergencyPending('withdraw') || emergencyPending('revoke') ? <p className="small" role="status">An original stop or return request is pending. Check its status in History before requesting another transaction.</p> : null}
        <button type="button" className="btn btn-primary" disabled={busy || !custodyAvailable} onClick={() => setRevokeOpen(true)}>Continue revoke…</button>
      </>}
    </Section>
    </> : null}
    {state ? <RevokeDialog open={revokeOpen} onOpen={() => {setRevokeRun(null); setRevokeRecord(null);}} onClosed={() => setRevokeOpen(false)} requestClose={closeRevoke}
      copy={revokeCopy} busy={busy} phase={revokePhase} reading={false} balance={shownBalance} run={revokeRun} outcome={revokeOutcome} vaultGone={balance === 0n}
      returnAll={{label: ready ? `Close and return all ${token}` : `Return remaining ${token}`, blocker: emergencyPending('withdraw') ? `Recover the original return before returning ${token}.` : undefined, disabled: busy || emergencyPending('withdraw') || !custodyAvailable || balance === 0n, spinning: busy && revokeRun?.method === 'close', run: () => void ownerStop('withdraw')}}
      stop={{disabled: busy || emergencyPending('revoke') || !custodyAvailable || !ready, spinning: busy && revokeRun?.method === 'revoke', run: () => void ownerStop('revoke')}}
      onDone={finishRevoke} onRetry={() => {setRevokeRun(null); setRevokeRecord(null);}} /> : null}
    <dialog className="ca-dialog tempo-dialog" ref={dialog} aria-labelledby={`tempo-dialog-title-${vault.policy.id}`} onClose={closeReview} onCancel={event => {if (busy) event.preventDefault();}}>{review ? <>
      <div className="ca-dialog-heading"><h2 id={`tempo-dialog-title-${vault.policy.id}`} tabIndex={-1}>{TITLES[review]}</h2><button type="button" className="ca-icon" aria-label="Close transaction review" disabled={busy} onClick={closeReview}><X size={20} /></button></div>
      {flowStep === 'review' ? <form className="form" onSubmit={event => {event.preventDefault(); void perform();}}>{review === 'deploy' || review === 'fund' ? <div className="field"><label htmlFor={`tempo-amount-${vault.policy.id}`}>Amount</label><input id={`tempo-amount-${vault.policy.id}`} className="num" value={amount} inputMode="decimal" readOnly={approvalConfirmed} required onChange={event => setAmount(event.target.value)} disabled={busy} /><span className="field-hint">{token}</span></div> : null}<dl className="facts"><div><dt>Network</dt><dd>{network}</dd></div>{review === 'withdraw' ? <><div><dt>Return balance</dt><dd>{custodyAvailable ? `${tempoDecimal(balance)} ${token}` : 'Refresh to verify'}<span className="tempo-review-note">All remaining funds; network fees are separate.</span></dd></div><div><dt>Return to</dt><dd className="mono tempo-wrap">{owner ? <AccountIdentity address={owner} network={accountNetwork} label="Return to" /> : null}</dd></div></> : null}{review === 'deploy' || review === 'fund' ? <div><dt>Deposit</dt><dd>{amount} {token}</dd></div> : null}{review === 'deploy' ? <><div><dt>Per payment</dt><dd>{vault.policy.actionLimit} {token}</dd></div><div><dt>Daily limit</dt><dd>{vault.policy.dailyLimit} {token}</dd></div><div><dt>Total budget</dt><dd>{vault.policy.totalLimit} {token}</dd></div></> : null}</dl><details className="native-details"><summary>Policy and transaction details</summary><dl className="facts"><div><dt>Vault</dt><dd className="mono tempo-wrap"><AccountIdentity address={vault.policy.vault} network={accountNetwork} kind="contract" label="Vault" /></dd></div>{vault.boundSnapshot ? <div><dt>Policy revision</dt><dd className="mono tempo-wrap">{vault.boundSnapshot.revision} · {vault.boundSnapshot.sourceHash}</dd></div> : null}</dl></details><p className="small muted">{review === 'deploy' || review === 'fund' ? approvalConfirmed ? `The exact ${amount} ${token} token approval is already confirmed. One wallet transaction and one transaction signature remain to fund the vault. The approved amount is unchanged.` : `Approve exactly ${amount || '…'} ${token} for this deposit, then approve the vault transaction. These are two separate wallet transactions and two transaction signatures. An approval alone does not fund the vault.` : review === 'withdraw' ? 'One wallet transaction returns every remaining token to your wallet and permanently revokes agent approval. Access stops when the receipt is confirmed.' : 'One wallet transaction permanently removes spending permission once confirmed. Remaining funds stay available to return.'}</p><label className="tempo-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} />I authorize these transactions on {network}.</label><div className="btn-row"><button type="button" className="btn" disabled={busy} onClick={closeReview}>Cancel</button><button className="btn btn-primary" disabled={busy || !consent || ((review === 'fund' || review === 'deploy') && (pending || !sourceMatches))}>Approve in wallet</button></div></form> : <div>
        {flowStep === 'wallet' ? <><div className="tempo-flow-status" role="status"><Spinner /><p>{walletStep || 'Preparing the exact transaction…'}</p></div><p className="small muted">Confirm the transaction in your connected wallet. Keep the original request while its receipt is checked.</p></> : <><div className="tempo-flow-status" role="status">{flowRecord && tempoRecordStatus(flowRecord) === 'Confirmed' ? <Check size={22} /> : <CircleAlert size={22} />}<p>{flowRecord ? `${TEMPO_METHOD_LABEL[flowRecord.method]} · ${tempoRecordStatus(flowRecord)}` : 'Transaction not completed'}</p></div>{flowError ? <p className="tempo-notice" role="alert"><span>{flowError}</span></p> : null}{flowRecord && pendingTempoRecord(flowRecord) ? <p className="small muted">{flowRecord.phase === 'declined' ? 'You declined in the wallet. The same request is saved for an explicit retry.' : ['preparing', 'prepared'].includes(flowRecord.phase) ? 'The original request is saved. Review it before asking your wallet again.' : 'This transaction is not confirmed. Check its original status before authorizing another transaction.'}</p> : null}</>}
        {flowRecord ? <dl className="facts"><div><dt>Request</dt><dd className="mono tempo-wrap">{flowRecord.id}</dd></div>{flowHash ? <div><dt>Transaction</dt><dd className="mono tempo-wrap">{flowHash}</dd></div> : null}{['Confirmed', 'Failed on chain'].includes(tempoRecordStatus(flowRecord)) && flowRecord.operation?.blockNumber != null ? <div><dt>Verified block</dt><dd className="mono">{String(flowRecord.operation.blockNumber)}</dd></div> : null}</dl> : null}{flowLink ? <a className="tempo-receipt-link small" href={flowLink} target="_blank" rel="noreferrer">View on Tempo Explorer<ExternalLink size={14} aria-hidden="true" /></a> : null}{flowStep === 'result' ? <div className="btn-row">{flowRecord && pendingTempoRecord(flowRecord) ? <button type="button" className="btn" disabled={busy} onClick={() => void recover()}>Check original status</button> : null}<button type="button" className="btn btn-primary" disabled={busy} onClick={closeReview}>Done</button></div> : null}
      </div>}
    </> : null}</dialog>
  </div>;
}
