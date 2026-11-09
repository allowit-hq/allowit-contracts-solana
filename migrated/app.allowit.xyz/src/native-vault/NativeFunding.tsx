import {useEffect, useRef, useState} from 'react';
import {CircleAlert, Clock, ExternalLink, RefreshCw} from 'lucide-react';
import type {MicroController, MicroPolicy} from '../micro/micro-contracts';
import type {Session} from '../contracts';
import {Section, Spinner} from '../shell/Shell';
import {hasDelegatedAuthority, NATIVE_VAULT_PROFILE, nativeSetupPaused} from '../runtime/runtime';
import NativeRecipientEditor from './NativeRecipientEditor';
import NativeFundingEditor from './NativeFundingEditor';
import SkillFile from '../policy/SkillFile';
import SpendingSetupHead from '../policy/SpendingSetup';
import NativeHarnessPrompt from './NativeHarnessPrompt';
import {sectionTitle} from '../policy/policy-sections';
import {actionLabel} from '../policy/policy-actions';
import {type PreparationStatus, type StateReply} from './native-api';
import {BoundNativeAPI, bindSelectedPolicy, findAttachment, hasNativeAttachment, issueAgent, loadAgents, loadNativeSupport, nativeStatus, FORMER_EXECUTOR_UNLISTED, sessionOwner, type NativeAgent, type NativeAttachment} from './native-bound';
import {createNativeOwnerContext, type NativeOwnerContext} from './native-owner-context';
import {decimal, finalizedSlot, settledOperation, type NativeConfig, type Operation} from './native-contracts';
import {admission, pendingOf, vaultPhase} from './native-vault';
import {sourceRecipient} from './native-recipient';
import {checkWithdraw} from './native-withdraw';
import NativeRevokeDialog, {type RevokeRun} from './NativeRevokeDialog';
import {nativeVaultChanged, signedOperations} from './native-vault-list';
import {drawAttention} from '../shell/attention';
import {selectedNativeX402Service} from './native-x402';
import {sourceWhitelist} from '../paysh/source-whitelist';
import AccountIdentity from '../wallet/AccountIdentity';
import './native-flow.css';

type Context = NativeOwnerContext;
interface View {key: string; loading: boolean; setupReady: boolean; formerExecutorReady: boolean; recipientAnyWallet: boolean; ownerContinuations: boolean; purchaseHistory: boolean; revokeAndReturnFunds: boolean; config: NativeConfig | null; attachment: NativeAttachment | null; reply: StateReply | null; records: Operation[]; retrySetup: string | null; retryRevoke: string | null; returnPreparation: PreparationStatus | null; error: string; readError: string; busy: string; skill: string}
const empty = (key: string): View => ({key, loading: true, setupReady: false, formerExecutorReady: false, recipientAnyWallet: false, ownerContinuations: false, purchaseHistory: false, revokeAndReturnFunds: false, config: null, attachment: null, reply: null, records: [], retrySetup: null, retryRevoke: null, returnPreparation: null, error: '', readError: '', busy: '', skill: ''});
const message = (error: unknown) => error instanceof Error ? error.message : 'The native vault could not be checked. Its original proofs are retained.';
/** A Devnet policy funds a native vault: an attached one, or a new unfunded owner-wallet draft. */
export function nativeCandidate(policy: MicroPolicy): boolean {
  return policy.network === 'solana:devnet' && policy.language !== 'legacy' && (hasNativeAttachment(policy)
    || (!hasDelegatedAuthority(policy) && (!policy.runtime || policy.runtime.wallet?.profile === NATIVE_VAULT_PROFILE) && !policy.allocation && !policy.approvalPending && !(policy as MicroPolicy & {pending?: unknown}).pending));
}
export function useNativeFunding(c: MicroController, policy: MicroPolicy, enabled: boolean) {
  const session = c.auth.session;
  const key = enabled && session ? [sessionOwner(session), policy.id, policy.revision, policy.sourceHash, policy.network, policy.mint, policy.limit, policy.token, policy.fundingRequest?.amount ?? '', policy.fundingRequest?.token ?? ''].join('|') : '';
  const live = useRef(key); live.current = key;
  const [view, setView] = useState<View>(() => empty(key));
  const context = useRef<Context | null>(null);
  const busy = useRef(false);
  const observation = useRef(0);
  const generation = useRef(0);
  const current = () => !!key && live.current === key;
  const update = (patch: Partial<View>) => {if (current()) setView(v => ({...(v.key === key ? v : empty(key)), ...patch}));};
  const makeContext = (config: NativeConfig, attachment: NativeAttachment, auth: Session): Context => {
    const epoch = generation.current;
    const scopeCurrent = () => current() && generation.current === epoch;
    return createNativeOwnerContext(config, attachment, auth, scopeCurrent);
  };
  const read = async (ctx: Context) => {
    if (!ctx.current()) return false;
    const sequence = ++observation.current;
    const observing = () => ctx.current() && sequence === observation.current;
    try {
    // Status checks only import/reconcile exact saved proofs. They cannot prepare,
    // rebroadcast or open the wallet, even when the original submit reply was lost.
    const retained = await ctx.journal.entries();
    if (!observing()) return false;
    // Keep recovery visible and replacement setup hidden if reconciliation fails.
    // These local records never establish finality or grant agent access.
    update({records: retained, attachment: ctx.attachment, config: ctx.config});
    if (!await ctx.lifecycle.recoverPending(ctx.attachment.policy, ctx.attachment.executionBinding.owner, observing, retained)) return false;
    const [reply, records] = await Promise.all([ctx.api.state(ctx.attachment.policy, ctx.attachment.executionBinding.owner, true), ctx.journal.entries()]);
    const retry = async (method: 'deploy' | 'revoke') => {
      try {const status = await ctx.lifecycle.preparationStatus(ctx.attachment.policy, ctx.attachment.executionBinding.owner, method); return status?.blockhashExpired === true && status.retryPreparationAllowed === true ? status.id : null;}
      catch {return null;} // No authoritative expiry means no replacement preparation.
    };
    const [retrySetup, retryRevoke, returnPreparation] = await Promise.all([retry('deploy'), retry('revoke'), ctx.lifecycle.preparationStatus(ctx.attachment.policy, ctx.attachment.executionBinding.owner, 'close').catch(() => null)]);
    if (!ctx.current() || sequence !== observation.current) return false;
    update({reply, records, retrySetup, retryRevoke, returnPreparation, attachment: ctx.attachment, config: ctx.config, loading: false, readError: ''});
    return true;
    } catch (error) {if (!ctx.current() || sequence !== observation.current) return false; throw error;}
  };
  useEffect(() => {
    const epoch = ++generation.current; live.current = key;
    context.current = null; busy.current = false; observation.current++; setView(empty(key));
    if (!key || !session) return;
    let cancelled = false, initializing = true, polling = false;
    const valid = () => !cancelled && current() && generation.current === epoch;
    void (async () => {
      try {
        const {config, setupReady, formerExecutorReady, recipientAnyWallet, ownerContinuations, purchaseHistory, revokeAndReturnFunds} = await loadNativeSupport();
        if (!valid()) return;
        update({config, setupReady, formerExecutorReady, recipientAnyWallet, ownerContinuations, purchaseHistory, revokeAndReturnFunds});
        if (await findAttachment(policy, session)) {
          if (!valid()) return;
          const attachment = await bindSelectedPolicy(policy, session, config);
          if (!valid()) return;
          const ctx = makeContext(config, attachment, session);
          context.current = ctx;
          await read(ctx);
        } else {
          if (!valid()) return;
          update({loading: false, ...(!setupReady ? {error: 'Autonomous Devnet setup is unavailable. The co-signing authority is not ready; no owner-signed allowance was substituted.'} : {})});
        }
      } catch (error) {if (valid()) update({error: message(error), readError: message(error), loading: false});}
      finally {initializing = false;}
    })();
    const timer = setInterval(() => {
      const ctx = context.current;
      if (valid() && ctx && !initializing && !polling && !busy.current && document.visibilityState === 'visible') {
        polling = true;
        void read(ctx).then(applied => {if (valid() && applied) update({error: ''});})
          .catch(error => {if (valid()) update({error: message(error), readError: message(error)});})
          .finally(() => {polling = false;});
      }
    }, 5000);
    return () => {cancelled = true; clearInterval(timer); if (generation.current === epoch) {generation.current++; live.current = '';}};
    // Every captured operation is bound to this immutable owner/policy snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  /** True only when the action finished without an error. */
  const perform = async (label: string, action: (active: () => boolean) => Promise<void>): Promise<boolean> => {
    if (!current() || busy.current || c.busy) return false;
    const epoch = generation.current;
    const active = () => current() && generation.current === epoch;
    busy.current = true; observation.current++; update({busy: label, error: ''});
    try {await action(active); return active();} catch (error) {
      // Revoke preparation may already have closed server admission even when the wallet declined.
      const ctx = context.current;
      if (ctx && active()) {try {await read(ctx);} catch (readFailure) {if (active()) update({readError: message(readFailure)});}}
      if (active()) update({error: message(error)});
      return false;
    }
    finally {if (active()) {busy.current = false; update({busy: ''});}}
  };
  const setup = (retryPreparationOf?: string, agent?: NativeAgent) => perform('setup', async active => {
    if (!session || !active()) return;
    if(nativeSetupPaused(policy.network))throw new Error('New contract setup is temporarily paused. Existing signed proofs and owner revocation remain available.');
    if (!view.setupReady) throw new Error('New setup is unavailable. Existing native proofs and owner revoke remain recoverable.');
    let ctx = context.current;
    if (!ctx) {
      const config = view.key === key ? view.config : null;
      if (!config) throw new Error('The native Devnet deployment is unavailable. No allowance fallback is used.');
      const service = selectedNativeX402Service(policy, config);
      const recipient = sourceRecipient(policy, service, true);
      if (!recipient && !view.recipientAnyWallet) throw new Error('Agent-selected recipients are unavailable on this deployment. Check vault status to retry.');
      if (!policy.fundingRequest) throw new Error('Save a funding amount above to continue.');
      // The vault names the agent's own key as executor; Allowit never holds a key that can spend from it.
      if (!agent?.publicKey) throw new Error('Connect your agent first.');
      const attachment = await bindSelectedPolicy(policy, session, config, recipient ? 'wallet' : 'any-wallet', undefined, agent);
      if (!active()) return;
      ctx = makeContext(config, attachment, session); context.current = ctx; update({attachment});
      await c.refresh(); // Refresh the server attachment marker before any owner signature or legacy navigation action.
      await read(ctx);
    }
    await ctx.lifecycle.submit(ctx.attachment.policy, session.address, 'deploy', {amount: ctx.attachment.initialFunding.amount, ...(ctx.attachment.recipientBinding ? {recipientWallet: ctx.attachment.recipientBinding.wallet} : {}), ...(retryPreparationOf ? {retryPreparationOf} : {})}, undefined, phase => {if (active()) update({busy: phase});});
    const records = await ctx.journal.entries();
    if (active()) update({records});
    await read(ctx);
  });
  const refresh = () => perform('checking', async active => {
    const ctx = context.current;
    if (ctx) {
      await read(ctx);
    } else {
      const {config, setupReady, formerExecutorReady, recipientAnyWallet, ownerContinuations, purchaseHistory, revokeAndReturnFunds} = await loadNativeSupport();
      if (!session || !active()) return;
      update({config, setupReady, formerExecutorReady, recipientAnyWallet, ownerContinuations, purchaseHistory, revokeAndReturnFunds, loading: false, readError: '', error: setupReady ? '' : 'New setup is unavailable while the co-signing authority is not ready.'});
      if (await findAttachment(policy, session)) {
        if (!active()) return;
        const attachment = await bindSelectedPolicy(policy, session, config);
        if (!active()) return;
        const next = makeContext(config, attachment, session); context.current = next; await read(next);
      }
    }
  });
  const recover = (id: string) => perform('recovering', async () => {
    const ctx = context.current;
    if (!ctx) throw new Error('Load the original bound vault first.');
    await ctx.lifecycle.replay(id, ctx.attachment.policy, ctx.attachment.executionBinding.owner);
    await read(ctx);
  });
  const revoke = (retryPreparationOf?: string) => perform('revoke', async active => {
    const ctx = context.current;
    if (!ctx) throw new Error('Load the original bound vault first.');
    await ctx.lifecycle.submit(ctx.attachment.policy, ctx.attachment.executionBinding.owner, 'revoke', retryPreparationOf ? {retryPreparationOf} : {}, undefined, phase => {if (active()) update({busy: phase});});
    const records = await ctx.journal.entries();
    if (active()) update({records});
    await read(ctx);
  });
  const returnFunds = (additionalOwnerOperation = false) => perform('returning', async active => {
    const ctx = context.current;
    if (!ctx) throw new Error('Load the original bound vault first.');
    if (!view.revokeAndReturnFunds) throw new Error('Revoke and return is unavailable on this deployment. Stop spending separately or check again later.');
    await read(ctx);
    if (!active()) return;
    const reply = await ctx.api.state(ctx.attachment.policy, ctx.attachment.executionBinding.owner, true);
    const records = await ctx.journal.entries();
    if (nativeStatus(reply, records) === 'Funds returned') return;
    if (!reply.state) throw new Error('The current vault could not be read. Recover its original setup or return before continuing.');
    const preparation = await ctx.lifecycle.preparationStatus(ctx.attachment.policy, ctx.attachment.executionBinding.owner, 'close').catch(() => null);
    const retained = preparation ? [{id: preparation.id, method: 'close' as const, amount: null, instanceSlot: reply.state.instanceSlot, status: preparation, absent: false}] : [];
    const allowed = admission('close', pendingOf(records, retained, reply.state, reply.operations), retained);
    if (!allowed.ok) throw new Error('Recover the original ' + allowed.blocker.method + ' operation before returning USDC.');
    if (allowed.mode === 'additional' && !additionalOwnerOperation) throw new Error('The original return is expired. Choose the explicit retry to request a new wallet confirmation.');
    await ctx.lifecycle.submit(ctx.attachment.policy, ctx.attachment.executionBinding.owner, 'close', {instanceSlot: reply.state.instanceSlot, ...(additionalOwnerOperation ? {additionalOwnerOperation: true} : {})}, undefined, phase => {if (active()) update({busy: phase});});
    await read(ctx);
  });
  /** Returns part of the vault balance to the owner wallet. Spending continues within the policy on what remains. */
  const withdraw = (amount: string) => perform('withdrawing', async active => {
    const ctx = context.current;
    if (!ctx) throw new Error('Load the original bound vault first.');
    const reply = await ctx.api.state(ctx.attachment.policy, ctx.attachment.executionBinding.owner, true);
    const records = await ctx.journal.entries();
    if (!active()) return;
    if (!reply.state) throw new Error('The current vault could not be read. Recover its original setup before withdrawing.');
    const checked = checkWithdraw(amount, reply.state.balance);
    if (!checked.ok) throw new Error(checked.error);
    const allowed = admission('withdraw', pendingOf(records, [], reply.state, reply.operations), []);
    if (!allowed.ok) throw new Error('Recover the original ' + allowed.blocker.method + ' operation before withdrawing USDC.');
    await ctx.lifecycle.submit(ctx.attachment.policy, ctx.attachment.executionBinding.owner, 'withdraw', {amount: checked.amount, ...(allowed.mode === 'additional' ? {additionalOwnerOperation: true} : {})}, undefined, phase => {if (active()) update({busy: phase});});
    await read(ctx);
  });
  const exportSkill = () => perform('exporting', async active => {
    const ctx = context.current;
    if (!ctx) throw new Error('Load the original bound vault first.');
    const reply = await ctx.api.state(ctx.attachment.policy, ctx.attachment.executionBinding.owner);
    if (nativeStatus(reply) !== 'Ready') throw new Error('Wait for the exact setup transaction to finalize before exporting agent access.');
    const exported = await ctx.api.export(ctx.attachment.policy, ctx.attachment.executionBinding.owner);
    if (active()) update({skill: exported.skill, reply});
  });
  const shown = view.key === key ? view : empty(key);
  // An agent-held vault needs co-signing; a vault with the former server executor needs the backend's managed spending.
  const vaultReady = shown.attachment && !shown.attachment.executor ? shown.formerExecutorReady : shown.setupReady;
  const checkedStatus = shown.loading ? 'Checking vault' : shown.readError ? 'Vault check failed' : shown.attachment ? nativeStatus(shown.reply, shown.records) : 'Draft';
  const status = policy.nativeExecution?.revocationStarted && checkedStatus === 'Ready' ? 'Revoke pending' : checkedStatus === 'Ready' && !vaultReady ? 'Managed spending unavailable' : checkedStatus;
  // The policy card mirrors this page: its status, its funding, and leaving the list once the funds are back.
  const pageStatus = shown.reply ? nativeStatus(shown.reply, shown.records) : null, funding = shown.attachment?.initialFunding.amount ?? null, hasVault = !!shown.reply?.state;
  const balance = shown.reply?.state ? decimal(shown.reply.state.balance) : null;
  const phase = shown.reply ? vaultPhase(shown.reply.state, shown.records, signedOperations(shown.reply.operations)).phase : null;
  useEffect(() => {if (pageStatus && phase) nativeVaultChanged({policyId: policy.id, view: {status: pageStatus, phase, funding, balance, hasVault}});}, [policy.id, pageStatus, phase, funding, balance, hasVault]);
  return {...shown, vaultReady, enabled, status, ready: status === 'Ready', phase, current, setup, refresh, recover, revoke, returnFunds, withdraw, exportSkill};
}
export type NativeFundingModel = ReturnType<typeof useNativeFunding>;

/** Why the bound vault cannot spend here. A former-executor vault needs the former executor's key in native/config even for owner actions. */
export function nativeVaultNote(m: Pick<NativeFundingModel, 'attachment' | 'config' | 'vaultReady'>): string | null {
  if (!m.attachment) return null;
  if (!m.attachment.executor && m.config && !m.config.executor) return FORMER_EXECUTOR_UNLISTED;
  if (m.vaultReady) return null;
  return m.attachment.executor ? 'Co-signing and new setup are unavailable. The original vault can still be checked and revoked by its owner.' : 'This vault was set up with the former server executor, and this server no longer spends for it. Its owner can still check it, revoke it and return its funds.';
}

/** Navigation and the page offer the same recovery section; ordinary revocation starts from the policy card. */
export function nativeStopSectionVisible(m: Pick<NativeFundingModel, 'reply' | 'records' | 'returnPreparation' | 'revokeAndReturnFunds'>): boolean {
  const ops = m.reply?.operations ?? [];
  const retained = m.returnPreparation ? [{id: m.returnPreparation.id, method: 'close' as const, amount: null, instanceSlot: m.reply?.state?.instanceSlot ?? null, status: m.returnPreparation, absent: false}] : [];
  const pending = pendingOf(m.records, retained, m.reply?.state, ops), allowed = admission('close', pending, retained);
  return !!(pending.some(record => record.method === 'close' && record.signed) || m.returnPreparation
    || (allowed.ok && allowed.mode === 'additional') || nativeStatus(m.reply, m.records) === 'Funds returned'
    || (!m.revokeAndReturnFunds && (m.reply?.state || ops.some(op => op.method === 'close') || m.records.some(record => record.method === 'close'))));
}

/** `revokeRequested` comes from the policy's close button in the list: it opens the revoke dialog once the vault is read. */
export default function NativeFunding({model: m, policy, unsaved, unsavedIds = [], controller, revokeRequested = false, revokeKnown = false, revokeHandled}: {controller: MicroController; model: NativeFundingModel; policy: MicroPolicy; unsaved: boolean; unsavedIds?: readonly string[]; revokeRequested?: boolean; revokeKnown?: boolean; revokeHandled?: () => void}) {
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revokeRun, setRevokeRun] = useState<RevokeRun | null>(null);
  // What a click on Approve could not do yet, shown beside the button when there is nowhere on the page to point at.
  const [approveNote, setApproveNote] = useState('');
  // The skill is generated as soon as the vault is ready. Export reuses the vault's one report token, so repeating it is safe;
  // it runs once per policy view, and only a failed export offers a retry.
  const [skillFailed, setSkillFailed] = useState(false);
  const skillTried = useRef('');
  // The owner's agents: each registered only its own public key. A new vault waits for one.
  const session = controller.auth.session;
  const [agents, setAgents] = useState<NativeAgent[]>([]);
  const [agentCopied, setAgentCopied] = useState(false);
  const agent = [...agents].reverse().find(a => a.publicKey && a.network === policy.network) ?? null;
  const awaitingAgent = !m.loading && !m.attachment && !!m.config && !agent;
  useEffect(() => {
    if (!awaitingAgent) return;
    let live = true;
    const load = () => {if (session) void loadAgents(session).then(list => {if (live && m.current()) setAgents(list);}, () => {});};
    void load();
    const timer = setInterval(() => {if (document.visibilityState === 'visible') void load();}, 3000);
    return () => {live = false; clearInterval(timer);};
  }, [awaitingAgent, session]);
  const agentKey = m.attachment?.executor ?? agent?.publicKey ?? '';
  /** Issues one agent capability and copies the two commands the agent runs on its own device. */
  // The clipboard write starts inside the click (Safari requires that) and receives the commands once the capability arrives.
  const connectAgent = async () => {
    if (!session) return;
    try {
      const commands = issueAgent('Agent', session).then(({token}) => {
        if (!m.current()) throw new Error('The selected policy or signed-in owner changed. Connect the agent from the current policy.');
        // The CLI keeps the agent key only in a private (0700) directory; setup runs only after the key exists.
        return `mkdir -p allowit-agent && chmod 700 allowit-agent && cd allowit-agent \\\n  && allowit wallet generate --network solana:devnet --output agent-key.json > agent-public.json \\\n  && ALLOWIT_URL=${location.origin} ALLOWIT_ACCOUNT_TOKEN=${token} allowit setup --input-file agent-public.json`;
      });
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) await navigator.clipboard.write([new ClipboardItem({'text/plain': commands.then(text => new Blob([text], {type: 'text/plain'}))})]);
      else await navigator.clipboard.writeText(await commands);
      await commands;
      setAgentCopied(true);
    } catch (error) {setApproveNote(message(error));}
  };
  useEffect(() => {
    const tryKey = policy.id + ':' + policy.revision;
    if (!m.ready || m.skill || m.busy || controller.busy || skillTried.current === tryKey) return;
    skillTried.current = tryKey;
    void m.exportSkill().then(ok => setSkillFailed(!ok));
  }, [m.ready, m.skill, m.busy, controller.busy, policy.id, policy.revision]);
  const disabled = !!m.busy || m.loading || unsaved || !!controller.busy;
  const x402Service = m.attachment?.x402Service ?? selectedNativeX402Service(policy, m.config);
  const staleNativeService = !m.attachment && sourceWhitelist(policy.code).length > 0 && !x402Service;
  let recipientWallet = m.attachment?.recipientBinding?.wallet;
  let recipientProblem = '';
  if (!m.attachment) {try {recipientWallet = sourceRecipient(policy, x402Service, true);} catch (error) {recipientProblem = message(error);}}
  const needsDynamicRecipient = !m.attachment && !x402Service && !recipientWallet && !recipientProblem;
  // Each blocker says what is missing; `target` finds the block that fixes it and `hint` is shown there.
  const whitelist = () => document.getElementById('p-whitelist')?.closest('section');
  const unsavedTarget = () => {
    const id = unsavedIds[0];
    return !id ? null : id === 'native-x402-service' ? whitelist() : document.querySelector(`[data-step-id="${CSS.escape(id)}"]`);
  };
  const setupBlockers: {reason: string; target?: () => Element | null | undefined; hint?: string}[] = [
    ...(nativeSetupPaused(policy.network)?[{reason:'New contract setup is temporarily paused. Existing signed proofs and owner revocation remain available.'}]:[]),
    ...(m.loading ? [{reason: 'Checking the saved deployment and vault.'}] : []),
    ...(unsaved ? [{reason: 'Save or discard workflow changes before binding this policy.', target: unsavedTarget, hint: 'Save or discard this change first.'}] : []),
    ...(controller.busy ? [{reason: 'Another policy action is in progress.'}] : []),
    ...(!m.loading && !m.config ? [{reason: 'The Devnet deployment configuration could not be loaded. Check vault status to retry.'}] : []),
    ...(!m.loading && m.config && !m.setupReady ? [{reason: 'New setup is unavailable while the co-signing authority is not ready.'}] : []),
    ...(awaitingAgent ? [{reason: 'Connect your agent first.', target: () => document.getElementById('native-agent-connect'), hint: 'Copy the commands and run them where your agent works.'}] : []),
    ...(staleNativeService ? [{reason: 'The saved native x402 service is no longer advertised. Remove it or choose a current service before setup.', target: whitelist, hint: 'Choose a current service and save it.'}] : []),
    ...(recipientProblem ? [{reason: recipientProblem}] : []),
    ...(!m.loading && needsDynamicRecipient && !m.recipientAnyWallet ? [{reason: 'Agent-selected recipients are unavailable on this deployment. Check vault status to retry.'}] : []),
    ...(!m.loading && !m.attachment && !policy.fundingRequest ? [{reason: 'Save a funding amount above to continue.', target: () => document.getElementById('native-funding-amount'), hint: 'Enter the USDC to deposit, then save it.'}] : []),
    ...(!m.loading && policy.workflow.some(node => node.kind === 'preference') && !m.ownerContinuations ? [{reason: 'This deployment cannot yet resume Ask me questions for autonomous purchases. Your questions remain unchanged.'}] : []),
    ...(!m.loading && policy.workflow.some(node => node.name === 'cap_purchase_tiers') && !m.purchaseHistory ? [{reason: 'This deployment cannot yet enforce the saved purchase tiers for autonomous purchases. Your tiers remain unchanged.'}] : []),
    ...(policy.status === 'cancelled' || policy.status === 'cancelling' ? [{reason: 'This policy is cancelled. Fork a new draft to set up another vault.'}] : []),
  ];
  const point = (blocker: (typeof setupBlockers)[number]) => drawAttention(blocker.target?.(), blocker.hint ?? blocker.reason);
  // Approve stays clickable: while something is missing it points at the first block that fixes it.
  const approve = () => {
    if (!setupBlockers.length) {setApproveNote(''); void m.setup(m.retrySetup ?? undefined, agent ?? undefined); return;}
    const actionable = setupBlockers.find(blocker => blocker.target);
    if (actionable && point(actionable)) setApproveNote('');
    else setApproveNote(setupBlockers[0].reason);
  };
  const pending = m.records.filter(r => !settledOperation(r) && r.status !== 'failed');
  const ops = m.reply?.operations ?? [];
  const confirmedPayments = new Set(ops.filter(op => op.method === 'execute' && settledOperation(op)).map(op => op.id)).size;
  const fundsReturned = nativeStatus(m.reply, m.records) === 'Funds returned';
  const closeRetained = m.returnPreparation ? [{id: m.returnPreparation.id, method: 'close' as const, amount: null, instanceSlot: m.reply?.state?.instanceSlot ?? null, status: m.returnPreparation, absent: false}] : [];
  const ownerPending = pendingOf(m.records, closeRetained, m.reply?.state, ops);
  const returnAdmission = admission('close', ownerPending, closeRetained);
  const closePending = ownerPending.find(record => record.method === 'close' && record.signed);
  const closeAttempted = !!m.returnPreparation || ops.some(op => op.method === 'close') || m.records.some(record => record.method === 'close');
  const closedId = fundsReturned ? vaultPhase(m.reply?.state, m.records, ops).closedBy : null;
  const closedBy = closedId ? ops.find(op => op.id === closedId) : null;
  const deployment = ops.find(op => op.method === 'deploy' && settledOperation(op) && m.reply?.state && finalizedSlot(op.finalizedSlot) === BigInt(m.reply.state.instanceSlot));
  const link = (signature: string) => 'https://explorer.solana.com/tx/' + encodeURIComponent(signature) + '?cluster=devnet';
  // The page reports revoke only while something is in flight; otherwise revoke opens from the policy's close button.
  const revokeNotice = closePending ? 'USDC return is waiting for Devnet. Check it again below; no returned funds are claimed until it settles.'
    : m.returnPreparation ? (m.reply?.revocationStarted || policy.nativeExecution?.revocationStarted ? 'Spending is stopped on the server. ' : '') + 'The USDC return still needs your wallet confirmation; funds remain in the vault.'
    : returnAdmission.ok && returnAdmission.mode === 'additional' ? 'The original return transaction is verified expired. Retrying requests a new wallet confirmation and keeps the original proof.'
    : '';
  useEffect(() => {
    if (!revokeRequested) return;
    // A known vault opens its dialog at once; the balance and actions fill in when the read finishes.
    if (revokeKnown) {revokeHandled?.(); setRevokeOpen(true); return;}
    if (m.loading) return;
    revokeHandled?.();
    if (m.revokeAndReturnFunds && m.reply?.state) setRevokeOpen(true);
    // A draft whose setup never created a vault discards like any draft; the server stops its native authority first.
    else if (policy.status === 'draft' && !m.reply?.state && m.phase === 'draft') void controller.cancel();
    else document.getElementById('p-cancel')?.scrollIntoView({block: 'start', behavior: 'smooth'});
  }, [revokeRequested, revokeKnown, m.loading, m.revokeAndReturnFunds, !!m.reply?.state, m.phase]);
  // Opened before the read, the dialog steps aside if the vault turns out to have nothing it can do.
  useEffect(() => {
    if (!revokeOpen || revokeRun || m.loading || (m.revokeAndReturnFunds && m.reply?.state)) return;
    setRevokeOpen(false);
    document.getElementById('p-cancel')?.scrollIntoView({block: 'start', behavior: 'smooth'});
  }, [revokeOpen, revokeRun, m.loading, m.revokeAndReturnFunds, !!m.reply?.state]);
  // The deposit stays editable until setup starts; a bound vault reports the funding it was created with.
  const fundingEditable = !m.loading && !m.attachment && !policy.nativeExecution && policy.status === 'draft' && !pending.length && !closeAttempted;
  // History appears once there is something in it: a vault operation or an owner question.
  const choosingRecipient = !m.attachment && !x402Service && !recipientWallet && !recipientProblem && policy.status === 'draft';
  const agentChoosesRecipient = m.attachment ? m.attachment.recipientMode === 'any-wallet' : !x402Service && !recipientWallet && !recipientProblem;
  const currentStep = fundsReturned ? undefined : m.ready ? 2 : m.reply?.state ? undefined : 1;
  const vaultNote = nativeVaultNote(m), unlisted = vaultNote === FORMER_EXECUTOR_UNLISTED;
  return <>
    <Section id="p-approve" title={sectionTitle('p-approve')}>
      <SpendingSetupHead intro={fundsReturned ? 'This vault is closed. Policy history is preserved.' : 'Set up spending for this policy.'} network="Solana Devnet · test USDC" currentStep={currentStep} />
      {choosingRecipient ? <details className="native-details"><summary>Limit to one wallet (optional)</summary><NativeRecipientEditor key={policy.id + ':' + policy.revision} c={controller} policy={policy} blocked={disabled || !!controller.busy} /></details> : null}
      <div className="native-review">
      <h3>{m.reply?.state || fundsReturned ? 'Spending setup' : 'Review before signing'}</h3>
      <dl className="facts">
        <div><dt>Funding</dt><dd>{m.attachment ? m.attachment.initialFunding.amount + ' USDC' : fundingEditable ? <NativeFundingEditor key={policy.id + ':' + policy.revision} c={controller} policy={policy} blocked={disabled} /> : policy.fundingRequest ? <>{policy.fundingRequest.amount + ' ' + policy.fundingRequest.token} <span className="native-fact-note">requested</span></> : <span className="native-fact-note">Server-validated funding required</span>}</dd></div>
        {x402Service ? <div><dt>x402 service</dt><dd>{x402Service.name} · <span className="mono">{x402Service.id}</span></dd></div> : null}
        {recipientWallet ? <div><dt>Recipient wallet</dt><dd className="mono"><AccountIdentity address={recipientWallet} network={policy.network} label="Recipient wallet" /></dd></div> : agentChoosesRecipient ? <div><dt>Recipient</dt><dd>Agent chooses within this policy</dd></div> : null}
        {agentKey ? <div><dt>Agent</dt><dd><AccountIdentity address={agentKey} network={policy.network} label="Agent" /> <span className="native-fact-note">· key stays on the agent’s device</span></dd></div>
          : !m.attachment ? <div><dt>Agent</dt><dd><button type="button" className="link-btn" id="native-agent-connect" disabled={disabled} onClick={() => void connectAgent()}>Connect agent</button>{agentCopied ? <span className="native-fact-note"> · commands copied, waiting for the agent</span> : null}</dd></div> : null}
        <div><dt>Daily vault ceiling (UTC day)</dt><dd>{m.attachment ? m.attachment.policy.dailyLimit + ' USDC' : <span className="native-fact-note">Verified from the selected policy at setup</span>}</dd></div>
        <div><dt>Action limit</dt><dd>{m.attachment ? <>{m.attachment.policy.actionLimit + ' ' + policy.token} <span className="native-fact-note">· effective ceiling, no greater than the source rule</span></> : <span className="native-fact-note">Verified from the selected policy at setup</span>}</dd></div>
        <div><dt>Vault status</dt><dd role="status"><span className="native-fact-status">{m.status}</span></dd></div>
        {m.reply?.state ? <div><dt>Vault balance</dt><dd>{decimal(m.reply.state.balance)} USDC</dd></div> : null}
        {deployment?.signature ? <div><dt>Setup transaction</dt><dd><a href={link(deployment.signature)} target="_blank" rel="noreferrer">Finalized on Devnet</a></dd></div> : null}
      </dl>
      </div>
      {!m.reply?.state && !closeAttempted && !fundsReturned ? <p className="small muted native-signing-note">{m.attachment && !m.attachment.executor ? 'Your setup transaction creates and funds this vault under the former server executor saved with it, as shown in the setup details.' : 'Your setup transaction creates and funds a vault, then authorizes your agent’s own key under this policy. Allowit holds no key that can spend from it.'} Later approved payments do not need another owner transaction signature. Network fees and account storage are paid in test SOL.</p> : null}
      <details className="native-details">
        <summary>Setup details and policy binding</summary>
        <dl className="facts">
          <div><dt>Policy binding</dt><dd className="mono">Revision {policy.revision} · {policy.sourceHash}</dd></div>
          {m.attachment?.recipientBinding ? <div><dt>USDC account</dt><dd><details><summary>Resolved automatically</summary><AccountIdentity address={m.attachment.recipientBinding.tokenAccount} network={policy.network} label="USDC account" /></details></dd></div> : agentChoosesRecipient ? <div><dt>Recipient mode</dt><dd>Wallet selected for each payment</dd></div> : m.attachment ? <div><dt>Recipient mode</dt><dd>Original token-account policy · unchanged</dd></div> : null}
        </dl>
        <p className="small muted">The Rust policy evaluator enforces this revision’s source, recipient and service rules before issuing execution authority. The fixed on-chain programs enforce the vault and signed limits; they do not compile your policy source.</p>
        {agentChoosesRecipient ? <p className="small muted">The agent supplies a recipient wallet for each payment. The server resolves its Devnet USDC account and checks every policy rule before spending.</p> : !m.attachment || m.attachment.recipientBinding ? <p className="small muted">The recipient’s Devnet USDC account is resolved automatically and, if missing, created in the same setup transaction. No separate recipient-account signature is needed.</p> : <p className="small muted">This existing policy names an exact token account. Its destination is unchanged. Fork a new policy to use an ordinary recipient wallet address.</p>}
        <p className="small muted">Signing in is a separate message signature. A finalized token transfer is not proof that QuickNode or another provider delivered a paid API response. Delivery is not attested by this flow.</p>
      </details>
      <details className="native-details">
        <summary>Need help with Phantom?</summary>
        <p className="small">Enable Testnet Mode in Phantom: profile avatar → Settings → Developer Settings → Testnet Mode, then choose Solana Devnet. This page cannot read that toggle; it checks the account and chain before signing. <a href="https://help.phantom.com/articles/use-testnets-in-phantom-5997313271699" target="_blank" rel="noreferrer">Phantom instructions</a></p>
      </details>
      {!fundsReturned && (m.reply?.revocationStarted || policy.nativeExecution?.revocationStarted) ? <p className="small muted">Spending stopped on the server; {m.status === 'Revoked' ? 'the owner revoke is finalized on chain.' : 'wallet confirmation or finality is pending. A previously signed or broadcast transfer may still settle before on-chain revocation finalizes.'}</p> : null}
      {m.reply?.allowedServices.length ? <dl className="facts">{m.reply.allowedServices.map(service => <div key={service.id}><dt>{service.id}</dt><dd className="mono">Only recipient <AccountIdentity address={service.recipient} network={policy.network} label="Service recipient" /></dd></div>)}</dl> : null}
      {m.error && !(unlisted && m.error === FORMER_EXECUTOR_UNLISTED) ? <p className="error-line" role="alert">{m.error}</p> : null}
      {vaultNote ? <p className={unlisted ? 'error-line' : 'small muted'} role={unlisted ? 'alert' : undefined}>{vaultNote}</p> : null}
      {!m.reply?.state && !fundsReturned && setupBlockers.length ? <div id="native-setup-blockers" className="small native-setup-blockers"><p>Before setup:</p><ul>{setupBlockers.map(blocker => <li key={blocker.reason}>{blocker.target ? <button type="button" className="link-btn" onClick={() => {if (!point(blocker)) setApproveNote(blocker.reason);}}>{blocker.reason}</button> : blocker.reason}</li>)}</ul></div> : unsaved ? <p className="small muted">Save or discard workflow changes before binding this policy.</p> : null}
      <div className="btn-row native-signing-actions">
        {!m.reply?.state && !fundsReturned && !closeAttempted && !pending.length ? <button className="btn btn-primary" disabled={nativeSetupPaused(policy.network)||!!m.busy || !!controller.busy} aria-describedby={setupBlockers.length ? 'native-setup-blockers' : undefined} onClick={approve}>{m.busy ? <Spinner /> : null}{m.retrySetup ? 'Retry expired unsigned setup' : 'Approve and sign once'}</button> : null}
        <button className="btn" disabled={!!m.busy || m.loading || !!controller.busy} onClick={() => void m.refresh()}>Check vault status</button>
      </div>
      {approveNote && setupBlockers.length ? <p className="small native-approve-note" role="status">{approveNote}</p> : null}
      {pending.map(record => <PendingProof key={record.id} record={record} expired={record.blockhashExpired === true || ops.some(op => op.id === record.id && op.blockhashExpired === true)}
        checking={m.busy === 'recovering'} disabled={disabled} link={link} onCheck={() => void m.recover(record.id)} />)}
    </Section>
    {/* Agent access exists only once the vault is approved, so the section waits for it. */}
    {m.ready ? <Section id="p-handoff" title={sectionTitle('p-handoff')}>
      {m.skill ? <><SkillFile content={m.skill} disabled={disabled} isCurrent={m.current} /><NativeHarnessPrompt key={m.key} skill={m.skill} disabled={disabled} isCurrent={m.current} /></> : skillFailed && m.busy !== 'exporting' ? <div className="btn-row"><button className="btn" disabled={disabled} onClick={() => void m.exportSkill().then(ok => setSkillFailed(!ok))}>Try again</button></div> : <p className="small" role="status"><Spinner /> Preparing agent skill…</p>}<p className="small muted">{m.attachment?.executor ? null : 'The exported capability uses the managed server executor. No private key or local executor wallet is needed. '}Keep the capability private.</p>
    </Section> : null}
    {confirmedPayments > 0 ? <Section id="p-usage" title={sectionTitle('p-usage')}><dl className="facts"><div><dt>Confirmed agent payments</dt><dd>{confirmedPayments}</dd></div></dl><p className="small muted">Finalized agent payments from this vault’s recorded history.</p></Section> : null}
    {nativeStopSectionVisible(m) ? <Section id="p-cancel" title={sectionTitle('p-cancel')}>
      {fundsReturned ? <><p role="status">Funds returned</p><p className="small muted">Remaining USDC was returned to the owner wallet and the vault was closed. Policy history is preserved.</p>{closedBy?.signature ? <a className="small" href={link(closedBy.signature)} target="_blank" rel="noreferrer">Finalized return transaction</a> : null}</> : m.revokeAndReturnFunds ? <>
        <p className="small" role="status">{revokeNotice}</p>
        {m.reply?.state ? <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => setRevokeOpen(true)}>Continue revoke…</button> : null}
      </> : <><p className="small muted">A successful revoke preparation stops new managed signing. Finalized revocation leaves any remaining USDC in the vault. Returning funds is not available on this deployment.</p><button className="btn" disabled={disabled || m.status === 'Revoked' || !m.reply?.state} onClick={() => void m.revoke(m.retryRevoke ?? undefined)}>{m.busy === 'revoke' ? <Spinner /> : null}{m.retryRevoke ? 'Retry expired unsigned revoke' : 'Revoke vault'}</button></>}
    </Section> : null}
    {revokeOpen || (m.revokeAndReturnFunds && m.reply?.state) ? <NativeRevokeDialog open={revokeOpen} onClose={() => setRevokeOpen(false)} m={m} disabled={disabled} reading={m.loading} returnAdmission={returnAdmission}
      run={revokeRun} setRun={setRevokeRun} onFinished={returned => {setRevokeOpen(false); if (returned) controller.select(null);}}
      returnLabel={returnAdmission.ok && returnAdmission.mode === 'additional' ? 'Retry expired USDC return' : m.returnPreparation ? 'Continue USDC return' : m.reply?.state?.approved === false ? 'Return remaining USDC' : 'Close and return all USDC'} /> : null}
  </>;
}

/** Read-only operation history in Requests. It never initializes funding, signs, or submits a transaction. */
export function NativeRequestHistory({policy,session}:{policy:MicroPolicy;session:Session}){
  const key=JSON.stringify([sessionOwner(session),session.expiresAt,policy.id,policy.revision,policy.sourceHash,policy.nativeExecution]);
  const live=useRef(key);live.current=key;
  const [state,setState]=useState<{key:string;loading:boolean;operations:StateReply['operations'];error:string|null}>(()=>({key,loading:true,operations:[],error:null}));
  useEffect(()=>{
    let active=true,running=false;
    const current=()=>active&&live.current===key;
    const read=async()=>{
      if(running)return;running=true;
      try{
        const {config}=await loadNativeSupport();
        if(!current())return;
        const attachment=await bindSelectedPolicy(policy,session,config);
        if(!current())return;
        const reply=await new BoundNativeAPI(config,attachment,session,current).state(attachment.policy,attachment.executionBinding.owner,true);
        if(current())setState({key,loading:false,operations:reply.operations,error:null});
      }catch(error){if(current())setState(previous=>({key,loading:false,operations:previous.key===key?previous.operations:[],error:message(error)}));}
      finally{running=false;}
    };
    void read();
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void read();},5000);
    return()=>{active=false;window.clearInterval(timer);};
  },[key]);
  const view=state.key===key?state:{loading:true,operations:[],error:null};
  return <article className="owner-card"><h3 className="owner-question">{policy.title}</h3><p className="small muted">Revision {policy.revision} · {policy.network}</p>
    {view.loading?<p className="small muted" role="status">Loading history…</p>:null}
    {view.error?<p className="small owner-note" data-tone="bad" role="alert">{view.error}</p>:null}
    {view.operations.length?<ul className="activity-list">{view.operations.map(op=><li key={op.id}><span>{actionLabel(op.method)} · {settledOperation(op)?'Confirmed':op.status==='failed'?'Failed':'Not confirmed'}</span>{op.method==='execute'?<span className="small muted"> · Resource delivery not attested</span>:null}{op.signature?<> · <a href={'https://explorer.solana.com/tx/'+encodeURIComponent(op.signature)+'?cluster=devnet'} target="_blank" rel="noreferrer">Transaction</a></>:null}</li>)}</ul>:!view.loading&&!view.error?<p className="small muted">No recorded operations.</p>:null}
  </article>;
}

const PROOF_LABEL: Record<string, string> = {deploy: 'Setup', fund: 'Deposit', withdraw: 'Withdrawal', close: 'Return', revoke: 'Revoke', execute: 'Agent payment', tune: 'Policy update', tune_action: 'Policy update'};

/**
 * A signed owner transaction whose result is not final yet. Nothing new is signed for it, so it cannot run twice;
 * checking again only asks Devnet about this exact transaction.
 */
function PendingProof({record, expired, checking, disabled, link, onCheck}: {record: Operation; expired: boolean; checking: boolean; disabled: boolean; link: (signature: string) => string; onCheck: () => void}) {
  const label = PROOF_LABEL[record.method] ?? 'Transaction';
  return <div className="native-pending" data-tone={expired ? 'expired' : 'waiting'} role="status">
    <div className="native-pending-head">
      <span className="native-pending-mark" aria-hidden="true">{expired ? <CircleAlert size={16} /> : <Clock size={16} />}</span>
      <p className="native-pending-title">{expired ? `${label} expired` : `${label} is waiting for Devnet`}</p>
    </div>
    <p className="native-pending-text">{expired
      ? 'Devnet never accepted this transaction, and it can no longer land. Nothing moved.'
      : 'Your wallet signed it, but Devnet has not confirmed it yet. Nothing new is signed until it settles, so it cannot run twice.'}</p>
    <div className="native-pending-actions">
      <button type="button" className="btn" aria-label={`Check ${label.toLowerCase()} again`} disabled={disabled} onClick={onCheck}>{checking ? <Spinner /> : <RefreshCw size={14} aria-hidden="true" />}{checking ? 'Checking…' : 'Check again'}</button>
      {record.signature ? <a className="small" href={link(record.signature)} target="_blank" rel="noreferrer">View transaction<ExternalLink size={12} aria-hidden="true" /></a> : null}
    </div>
    <details className="native-pending-details"><summary>Details</summary><dl className="facts">
      <div><dt>Request</dt><dd className="mono">{record.id}</dd></div>
      {record.signedAt ? <div><dt>Signed</dt><dd>{new Date(record.signedAt).toLocaleString()}</dd></div> : null}
    </dl></details>
  </div>;
}
