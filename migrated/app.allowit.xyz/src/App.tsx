import {isStellarNetwork, isStellarPublicNetwork} from '@allowit/engine/stellar/runtime';
import NetworkPicker from './wallet/NetworkPicker';
import {ChainSelect} from './wallet/ChainPicker';
import {AuthHeader, ComposerFrame, ErrorBanners, ErrorLine, PolicyNavFrame, Section, SkipLink, Spinner, ThemeSwitch, TopHeader, submitOnEnter, type Banner} from './shell/Shell';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {createPortal} from 'react-dom';
import {
  Check,
  GitFork,
  Network as NetworkIcon,
  Fingerprint,
  Signature,
  CircleAlert,
  Info,
  Copy,
  ExternalLink,
  LogOut,
  Smartphone,
  Wallet,
  Vault,
  History,
  ChevronRight,
  Search,
  X,
} from 'lucide-react';
import useMicro from './micro/useMicro';
import useDelegateWorkspace, {type DelegateWorkspace} from './delegate/useDelegateWorkspace';
import DelegateConflictDialog from './delegate/DelegateConflictDialog';
import {blockingDelegateGrant} from './delegate/delegate-conflict';
import {DelegateAccess, DelegateAnsweredRequests, DelegateBudget, DelegatePendingRequests, DelegateRequestHistory, DelegateRecovery, DelegateStop, DelegateUsage, delegateAnsweredCount, delegatePendingCount, delegateUsageFraction} from './delegate/DelegateSections';
import {displayDelegateAmount} from './delegate/delegate-contracts';
import {connectedDelegateCatalog} from './delegate/delegate-catalog';
import {delegateAperture,delegateTerminal} from './delegate/delegate-bound';
import PolicyDefinition from './policy/PolicyDefinition';
import ContractFunding from './policy/ContractFunding';
import NativeFunding, {NativeRequestHistory, nativeCandidate, nativeStopSectionVisible, useNativeFunding, type NativeFundingModel} from './native-vault/NativeFunding';
import {hasNativeAttachment} from './native-vault/native-bound';
import {selectedNativeX402Service} from './native-vault/native-x402';
import {decimal, settledOperation, type NativeX402Service} from './native-vault/native-contracts';
import BudgetAuthorization, {CommitmentFacts, shortValue} from './policy/BudgetAuthorization';
import {evaluateAuthorization, type AuthorizationView} from './runtime/useOwnerAuthorization';
import {admittedSentence, authorizationFigure} from './runtime/authorization';
import {useLegacySetups} from './runtime/useLegacySetups';
import {browserBindings} from './runtime/setup-bindings';
import {allowlistWallet, authorizationKey, EXECUTION_AUTHORITY, explicitChoice, fundingPath, hasDelegatedAuthority, delegatedNetworks, DELEGATED_PROFILE, handoffReady, isStellarPolicy, MAX_ALLOWLIST, MAX_SOURCE_WHITELIST, needsService, newSetupAllowed, NO_PICKS, policyAllowlist, requestRequired, resolvePicks, runtimeOf, walletChoices, walletUsable, WALLET_LABEL, WALLET_MEANING, type RuntimeConfig, type RuntimeOperation, type RuntimePicks, type RuntimeWallet} from './runtime/runtime';
import {STELLAR_PROFILES, stellarProfile} from '@allowit/engine/stellar/stellar-profiles';
import PolicyCertificate from './policy/PolicyCertificate';
import PolicyWorkflow from './policy/PolicyWorkflow';
import {useTypedMetadata} from './policy/useTypedMetadata';
import {currentPolicyRequest, workflowStatuses} from './workflow-status';
import {certificateAmount, allocationUsage} from './wallet/amount-format';
import PolicyRequests from './policy/PolicyRequests';
import StellarHistory from './vendors/stellar/StellarHistory';
import StellarHandoff from './vendors/stellar/StellarHandoff';
import {useStellarDeployment} from './vendors/stellar/useStellarDeployment';
import RequestReview from './policy/RequestReview';
import OwnerApprovalInbox, {OwnerInboxContext, useOwnerInbox} from './owner/OwnerApprovalInbox';
import {sessionSigner} from './owner/owner-signers';
import PolicyNavActions, {type CloseAction} from './policy/PolicyNavActions';
import {cancelControlShown, cancelOffered, closeBlocker} from './policy/policy-close';
import {discardable, leavesList, useNativeVaults, type NativeVaultView} from './native-vault/native-vault-list';
import RevokePolicies from './policy/RevokePolicies';
import TopNav from './TopNav';
import ListSelect from './ListSelect';
import WalletIcon from './wallet/WalletIcon';
import {isMobileBrowser, phantomBrowseUrl} from './wallet/phantom-link';
import {availableNetworks, isTempoNetwork, testnetLauncher} from './wallet/networks';
const StellarFunding = lazy(() => import('./vendors/stellar/StellarFunding'));
const StellarSignIn = lazy(() => import('./vendors/stellar/StellarSignIn'));
import TempoSignIn from './tempo/TempoSignIn';
import {tempoManagedReady} from './tempo/tempo-managed';
import {TempoFunding, TempoOwnerRecovery, TempoWorkspaceProvider, sameTempoDraft, tempoPhase, useTempoWorkspace, useTempoWorkspaceContext} from './tempo/TempoVault';
import type {Chain} from './shell/Shell';
import {readRequestLink, returnFocus, reviewFocus, type ReviewFocus} from './owner/request-link';
import DeploymentReview from './native-vault/DeploymentReview';
const StellarBrowserReview = lazy(() => import('./vendors/stellar/StellarBrowserReview'));
const AdkOwnerHandoff = lazy(() => import('./vendors/stellar/AdkOwnerHandoff'));
import {ADK_OWNER_FRAGMENT} from '@allowit/stellar/stellar-fragments';
import {STELLAR_OWNER_FRAGMENT,STELLAR_APPROVAL_FRAGMENT} from '@allowit/engine/stellar/stellar-fragments';
import StellarSigningBoundary from './vendors/stellar/StellarSigningBoundary';
import {DEPLOYMENT_FRAGMENT, parseDeploymentHandoff} from './native-vault/deployment-handoff';
import {MICRO_EXAMPLES, haltedStep, type MicroController, type MicroPolicy, type PolicyRequest, type UsageEvent} from './micro/micro-contracts';
import {composerScope, devnetResearchExample} from './micro/devnet-research-example';
import {needsOwner, requestPhase} from './request-status';
import {maskSecrets} from './policy/mask-secrets';
import SkillFile from './policy/SkillFile';
import {sectionTitle} from './policy/policy-sections';
import TempoStopAll from './tempo/TempoStopAll';
import {PAYSH_SERVICES, payshNetworks, type RegisteredCatalogService} from './paysh/paysh-catalog';
import {intentWhitelist, intentWhitelistNote} from './paysh/intent-services';
import {sameServiceIds} from './paysh/service-allowlist';
import {sourceWhitelist} from './paysh/source-whitelist';
import PayshCatalog, {type Availability} from './paysh/PayshCatalog';

// Earlier-setup recovery needs the Solana SDK; it loads only when the owner opens it.
const LegacySetupRecovery = lazy(() => import('./policy/LegacySetupRecovery'));

/* ---------------------------------------------------------------- helpers */

const PHANTOM_URL = 'https://phantom.com/download';
const TOKENS = ['USDC'];
const DECIMALS = 6;
/** Circle's Devnet USDC mint. Any other Devnet mint is a configured test token. */
const CIRCLE_DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

const shortAddr = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeFmt.format(d);
}
const amountFmt = new Intl.NumberFormat('en-US', {maximumFractionDigits: DECIMALS});
const num = (s: string) => {
  const n = Number(String(s).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};
const fmtAmount = (n: number) => amountFmt.format(n);

function parseAmount(raw: string): {value: string} | {error: string} {
  const s = raw.replace(/,/g, '').trim();
  if (!s) return {error: 'Enter an amount.'};
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) return {error: 'Enter a number, like 100 or 25.5.'};
  if ((m[2] ?? '').length > DECIMALS) return {error: `Use at most ${DECIMALS} decimal places.`};
  const n = Number(s);
  if (!(n > 0)) return {error: 'The amount must be more than zero.'};
  return {value: s.replace(/\.$/, '')};
}

const statusWord: Record<MicroPolicy['status'], string> = {
  draft: 'Draft',
  active: 'Active',
  cancelling: 'Cancelling',
  cancelled: 'Cancelled',
};

type Network = MicroController['network'];
type NetworkConfig = MicroController['networks'][number];

/** 'solana:devnet' → 'Devnet'. Prefers the configured label when the controller has one. */
function networkLabel(network: Network | string, networks?: NetworkConfig[]) {
  if(network==='local:dev')return 'Local dev';
  const known = networks?.find(n => n.id === network);
  if (known) return known.label;
  const tail = String(network).split(':').pop() || String(network);
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}
const isTestnet = (network: Network | string) => network === 'solana:testnet';
const isMainnet = (network: Network | string) => network === 'solana:mainnet';
/** Display name only. The Testnet token is a test issue, not Circle USDC; the value sent to the API is unchanged. */
const tokenName = (_network: Network | string, token: string) => token;

/** Enter submits the surrounding form; Shift+Enter inserts a new line. */
function useRun(c: MicroController, raise: (m: string) => void) {
  const [pending, setPending] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = useCallback(
    async <T,>(id: string, fn: () => Promise<T>): Promise<T | undefined> => {
      if (inFlight.current) return undefined;
      inFlight.current = true;
      setPending(id);
      try {
        return await fn();
      } catch (e) {
        raise(e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.');
        return undefined;
      } finally {
        inFlight.current = false;
        if (mounted.current) setPending(null);
      }
    },
    [raise],
  );
  const blocked = pending !== null || Boolean(c.busy) || Boolean(c.auth.busy);
  return {pending, run, blocked};
}

/* ---------------------------------------------------------------- primitives */

/** A native card shows the vault's funding, as its page does; before a read it says so instead of a number. */
const nativeFigure=(vault?:NativeVaultView)=>!vault?'Status unknown':!vault.hasVault?'No vault yet':undefined;

/**
 * Policy lifecycle only. A stopped or failed agent run leaves an active policy Ready; Stopped means the policy itself
 * ended. An active budget authorization policy stays pending until its authorization is verified.
 */
function policyState(policy:MicroPolicy, setup: Parameters<typeof handoffReady>[1]= null, owner = '', tempo: ReturnType<typeof useTempoWorkspaceContext> = null, vault?: NativeVaultView){
 if(isTempoNetwork(policy.network)){
  const vault=tempo?.vaultFor(policy.id)??null;
  if(!vault&&!tempo?.settled)return 'Checking vault';
  if(policy.status==='cancelled'&&!vault&&tempo?.settled)return 'Stopped';
  const phase=tempoPhase(vault,tempo?.loaded??false);
  if(phase==='Ready'&&(!vault?.executionPolicy||vault.sourceError||!sameTempoDraft(policy,vault.boundSnapshot)))return 'Setup pending';
  if(phase==='Ready'&&(!tempo?.config||!tempoManagedReady(tempo.config,vault!.policy,vault!.managedExecution)))return 'Managed payments unavailable';
  return phase;
 }
 // A native card follows its vault read, as the policy page does; an unread vault keeps the generic status.
 if(hasNativeAttachment(policy)){
  const revoking=!!policy.nativeExecution?.revocationStarted;
  if(!vault)return revoking?'Revoke pending':'Check native vault';
  if(discardable(vault))return 'Draft';
  return revoking&&vault.status==='Ready'?'Revoke pending':vault.status;
 }
 if(policy.status==='draft')return 'Draft';
 if(policy.status!=='active')return 'Stopped';
 if(fundingPath(policy)==='authorization'&&!handoffReady(policy,setup,owner))return 'Authorization pending';
 if(runtimeOf(policy).kind==='contract-wallet'&&!handoffReady(policy,setup,owner))return 'Setup pending';
 return 'Ready';
}

function SignIn({c, raise, errors, busy}: {c: MicroController; raise: (m: string) => void; errors: Banner[]; busy: boolean}) {
  const {pending, run, blocked} = useRun(c, raise);
  const auth = c.auth;
  const local = c.network === 'local:dev';
  const off = busy || blocked;
  const waiting = auth.wallets.find(w => w.name === pending)?.name;
  const opening = pending === 'local' || auth.busy === 'local';
  const mobile = isMobileBrowser(navigator.userAgent, navigator.maxTouchPoints);
  return (
    <section className="auth-card" aria-labelledby="si-title">
      <div className="auth-head">
        <h1 id="si-title" className="auth-title">
          {local ? 'Local dev' : 'Sign in with a Solana wallet'}
        </h1>
        <p className="auth-lede">
          {local
            ? 'Create policies and test agent requests without a wallet.'
            : 'Choose a wallet, then approve a message to prove you hold the address.'}
        </p>
      </div>
      {errors.length > 0 ? (
        <div className="auth-errors">
          <ErrorBanners errors={errors} />
        </div>
      ) : null}
      <div className="auth-network">
        <div className="auth-network-text">
          <span className="auth-network-label">Blockchain</span>
          <span className="auth-network-hint" id="si-chain-hint">
            Wallets for this chain are listed below.
          </span>
        </div>
        <ChainSelect chain="solana" disabled={off} describedBy="si-chain-hint" />
      </div>
      <div className="auth-network">
        <div className="auth-network-text">
          <span className="auth-network-label">Network</span>
          <span className="auth-network-hint" id="si-network-hint">
            New policies are created on this network.
          </span>
        </div>
        <NetworkSelect c={c} disabled={off} describedBy="si-network-hint" />
      </div>
      {local ? (
        <div className="auth-local">
          <button type="button" className="btn btn-primary auth-cta" disabled={off} onClick={() => run('local', () => auth.signIn(''))}>
            {opening ? <Spinner /> : null}
            {opening ? 'Opening…' : 'Open workspace'}
          </button>
        </div>
      ) : auth.wallets.length > 0 ? (
        <ul className="auth-wallets" aria-label="Wallets">
          {auth.wallets.map(w => (
            <li key={w.name}>
              <button
                type="button"
                className={`auth-wallet${pending === w.name ? ' is-waiting' : ''}`}
                disabled={off}
                onClick={() => run(w.name, () => auth.signIn(w.name))}
              >
                <span className="auth-wallet-icon">
                  <WalletIcon src={w.icon} />
                </span>
                <span className="auth-wallet-name">{pending === w.name ? `Waiting for ${w.name}…` : w.name}</span>
                <span className="auth-wallet-end" aria-hidden="true">
                  {pending === w.name ? <Spinner /> : <ChevronRight size={16} />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : mobile ? (
        // A phone browser has no wallet extension: open this page inside Phantom, where the wallet signs.
        <div className="auth-empty">
          <p className="auth-empty-title">
            <Smartphone size={16} aria-hidden="true" />
            Sign in from the Phantom app.
          </p>
          <p>This page opens in Phantom’s browser. Choose Phantom there and approve the message.</p>
          <a className="btn btn-primary auth-cta" href={phantomBrowseUrl(window.location.href, window.location.origin)}>
            Open in Phantom
          </a>
          <p className="muted">
            No Phantom yet?{' '}
            <a href={PHANTOM_URL} target="_blank" rel="noreferrer">
              Get Phantom <ExternalLink size={13} aria-hidden="true" className="inline-icon" />
            </a>
          </p>
        </div>
      ) : (
        <div className="auth-empty">
          <p className="auth-empty-title">
            <Wallet size={16} aria-hidden="true" />
            No wallet found in this browser.
          </p>
          <p>
            Install Phantom, then reload this page.{' '}
            <a href={PHANTOM_URL} target="_blank" rel="noreferrer">
              Get Phantom <ExternalLink size={13} aria-hidden="true" className="inline-icon" />
            </a>
          </p>
          <p className="with-icon muted">
            <Smartphone size={16} aria-hidden="true" />
            <span>On a phone, open this page in your wallet app’s browser.</span>
          </p>
        </div>
      )}
      {local || !availableNetworks(c.networks).some(n => n.id === 'local:dev') ? null : (
        // Same as choosing Local dev in the network picker above.
        <p className="auth-local-link small">
          <button type="button" className="link-btn" disabled={off} onClick={() => c.setNetwork('local:dev')}>
            Try Local dev without a wallet
          </button>
        </p>
      )}
      {local ? null : (
        <p className="auth-status" role="status">
          {waiting ? `Approve the message in ${waiting} to continue.` : ''}
        </p>
      )}
      <p className="auth-note">
        {local ? (
          'Nothing is signed and no funds move. Local policies stay separate from wallet policies.'
        ) : (
          <>
            <Signature size={14} aria-hidden="true" />
            <span>Message signature only. No transaction, no fee and no spending permission. Your wallet’s network setting is unchanged.</span>
          </>
        )}
      </p>
    </section>
  );
}

/* ---------------------------------------------------------------- composer */

const walletKey = (w: Pick<RuntimeWallet, 'kind' | 'profile'>) => `${w.kind}|${w.profile}`;

/**
 * The owner's request, service and runtime picks, kept only for the network and wallet they were made under. Another
 * network or wallet starts from nothing chosen; nothing carries over and nothing is filled from registry order.
 */
function useScopedPicks(scope: string) {
  const [state, setState] = useState<{scope: string; picks: RuntimePicks}>({scope: '', picks: NO_PICKS});
  const picks = state.scope === scope ? state.picks : NO_PICKS;
  const pick = (patch: Partial<RuntimePicks>) => setState({scope, picks: {...picks, ...patch}});
  // Leaving a scope forgets its picks, so returning to an earlier wallet or network also starts from nothing chosen.
  useEffect(() => setState(s => (s.scope === scope ? s : {scope: '', picks: NO_PICKS})), [scope]);
  return {picks, pick};
}

/**
 * The wallet the policy is compiled for, chosen before generation and fixed afterwards. Shown only when the server
 * offers more than one wallet on this network, or the wallet leaves a request or runtime to choose. The request, service
 * and runtime are explicit choices, never read from text, a function name or a profile name.
 */
function useRuntimeChoice(c: MicroController, network: string) {
  const choices = walletChoices(c.runtimeConfig, network).filter(w => !testnetLauncher() || w.kind === 'contract-wallet');
  const [picked, setPicked] = useState<string | null>(null);
  const wallet = choices.find(w => walletKey(w) === picked) ?? choices[0] ?? null;
  const config = c.runtimeConfig && c.runtimeConfig !== 'unavailable' ? c.runtimeConfig : null;
  const {picks, pick} = useScopedPicks(`${network}|${wallet ? walletKey(wallet) : ''}`);
  const choice = config && wallet ? explicitChoice(config, wallet, picks) : null;
  return {choices, wallet, setPicked, picks, pick, choice, config};
}

/** The wallet in words. The allowlist contract wallet is named apart from the single-service one. */
const walletName = (w: Pick<RuntimeWallet, 'kind' | 'profile'>) => stellarProfile(w.profile)?STELLAR_PROFILES[w.profile].label:w.profile === DELEGATED_PROFILE ? 'Wallet' : allowlistWallet(w) ? `${WALLET_LABEL[w.kind]}, service allowlist` : WALLET_LABEL[w.kind];

/** Whether a wallet leaves anything for the owner to choose besides itself. */
const hasRequestFields = (wallet: RuntimeWallet) => requestRequired(wallet) || wallet.sourceProfiles.length > 1;

/** The request kind in words, from the registry's explicit kind only. An entry without one is a provider call. */
const KIND_WORDS = {'execution-request': 'Native request, no service', 'curl-request': 'HTTP request, needs a registered service'} as const;
const operationFacts = (op: RuntimeOperation) => `${op.ingressKind ? KIND_WORDS[op.ingressKind] : 'Provider call'}. Settlement: ${op.settlement}. Delivery: ${op.delivery}.`;

/**
 * Request, service and policy runtime for one wallet, as the registry states them. Several options are radios or a list
 * with nothing preselected; one option is a stated fact. A request that needs a service and has none registered is the
 * only impossible case and the only red line here. Until a needed choice is made, a neutral line says what is missing.
 */
function RequestFields({id, config, wallet, picks, pick, disabled, network, intent = '', showFacts = true}: {id: string; config: RuntimeConfig; wallet: RuntimeWallet; picks: RuntimePicks; pick: (p: Partial<RuntimePicks>) => void; disabled: boolean; network: {id: string; label: string}; intent?: string; showFacts?: boolean}) {
  const r = resolvePicks(config, wallet, picks);
  // The allowlist follows the categories the request names (for example "finance tasks") until the owner edits the list
  // by hand. The owner still sees every preselected service before generating, and the wallet setup binds the final list.
  const edited = useRef(false);
  const suggestion = r.allowlist && r.operation && needsService(r.operation) ? intentWhitelist(intent, r.services, MAX_ALLOWLIST) : null;
  const suggested = suggestion?.ids.join(' ') ?? null;
  useEffect(() => {
    if (suggestion === null || edited.current || disabled || sameServiceIds(suggestion.ids, r.serviceIds)) return;
    pick({serviceIds: suggestion.ids});
    // Re-run only when the suggestion itself changes, not on every render's fresh arrays.
  }, [suggested, disabled]);
  const op = r.operation;
  const service = (s: {id: string; name?: string}) => s.name ?? s.id;
  const missing = r.operations.length > 1 && !op ? 'Choose the request this policy checks.'
    : op && needsService(op) && r.allowlist && r.services.length && !r.serviceIds.length ? 'Choose at least one service this policy may pay.'
    : op && needsService(op) && !r.allowlist && r.services.length > 1 && !r.serviceId ? 'Choose the service this request uses.'
      : wallet.sourceProfiles.length > 1 && !r.sourceProfile ? 'Choose the policy runtime.' : '';
  return (
    <>
      {r.operations.length > 1 ? (
        <fieldset className="runtime-choice runtime-request" disabled={disabled}>
          <legend className="small muted">Request</legend>
          <div className="runtime-requests">
            {r.operations.map((o, i) => (
              <div key={o.function} className="runtime-request-option">
                <label className="runtime-option">
                  <input type="radio" name={`${id}-request`} value={o.function} checked={picks.fn === o.function} onChange={() => pick({fn: o.function, serviceId: '', serviceIds: []})} aria-describedby={showFacts ? `${id}-request-${i}` : undefined} />
                  <span className="mono">{o.function}</span>
                </label>
                {showFacts ? <span className="small muted runtime-request-facts" id={`${id}-request-${i}`}>{operationFacts(o)}</span> : null}
              </div>
            ))}
          </div>
        </fieldset>
      ) : op && showFacts ? (
        <p className="small runtime-request-fact">Request: <span className="mono">{op.function}</span> <span className="muted">{operationFacts(op)}</span></p>
      ) : null}
      {op && needsService(op) ? (
        r.allowlist && r.services.length ? (
          <ServiceWhitelist services={r.services} selected={r.serviceIds} onChange={serviceIds => {edited.current = true; pick({serviceIds});}} network={network} disabled={disabled} note={suggestion && !edited.current ? intentWhitelistNote(suggestion, network.label, MAX_ALLOWLIST) : undefined} />
        ) : r.services.length > 1 ? (
          <div className="field">
            <label htmlFor={`${id}-service`} id={`${id}-service-label`} className="small">Service</label>
            <ListSelect id={`${id}-service`} value={r.serviceId} options={[{value: '', label: 'Choose a service'}, ...r.services.map(v => ({value: v.id, label: service(v)}))]} onChange={v => pick({serviceId: v})} labelledBy={`${id}-service-label`} disabled={disabled} />
          </div>
        ) : r.services.length === 1 ? <p className="small muted">Service: {service(r.services[0])}</p>
          : <p className="small gate" role="status">No service is registered for this request, so it cannot be used for a new policy.</p>
      ) : null}
      {wallet.sourceProfiles.length > 1 ? (
        <div className="field">
          <label htmlFor={`${id}-profile`} id={`${id}-profile-label`} className="small">Policy runtime</label>
          <ListSelect id={`${id}-profile`} value={r.sourceProfile} options={[{value: '', label: 'Choose a policy runtime'}, ...wallet.sourceProfiles.map(v => ({value: v, label: v}))]} onChange={v => pick({sourceProfile: v})} labelledBy={`${id}-profile-label`} disabled={disabled} />
        </div>
      ) : null}
      <p className="small muted" role="status">{missing}</p>
    </>
  );
}

/**
 * The policy's PaySH whitelist: the services it may pay, empty until the owner adds one. Listed services can be removed
 * here; the PaySH catalog opens over the page to add more, and only server-registered services can be added there.
 */
function ServiceWhitelist({services, selected, onChange, network, disabled, availability, max = MAX_ALLOWLIST, note, native = false, browseOnly = false}: {services: RegisteredCatalogService[]; selected: string[]; onChange: (ids: string[]) => void; network: {id: string; label: string}; disabled: boolean; availability?: Availability; max?: number; note?: string; native?: boolean; browseOnly?: boolean}) {
  const title = (id: string) => services.find(s => s.id === id)?.name ?? PAYSH_SERVICES.find(s => s.fqn === id)?.title;
  const shown = browseOnly ? services.map(service => service.id) : selected;
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const browseRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = dialogRef.current;
    if (!open || !d || d.open) return;
    d.showModal();
    // showModal focuses the first control; the catalog starts from its heading instead.
    d.querySelector<HTMLElement>('#wl-title')?.focus();
  }, [open]);
  const close = () => dialogRef.current?.close();
  return (
    <fieldset className="service-picker" disabled={disabled}>
      <legend className="small">{browseOnly ? 'Connected services' : 'PaySH whitelist'}</legend>
      <div className="service-picker-bar">
        <p className="small muted service-picker-hint">{browseOnly ? 'Each paid request must satisfy this policy.' : 'The policy pays only these services.'}</p>
        <span className="service-count num" role="status">{browseOnly ? `${services.length} connected` : <><span aria-hidden="true">{selected.length}/{max}</span><span className="sr-only">{selected.length} of {max} services selected</span></>}</span>
      </div>
      {note ? <p className="small muted service-intent-note" role="status">{note}</p> : null}
      {shown.length ? (
        <ul className="service-list" aria-label={browseOnly ? 'Connected services' : 'Services on the whitelist'}>
          {shown.map(id => (
            <li key={id} className={browseOnly ? 'service-option' : 'service-option is-on'}>
              <span className="service-name">{title(id) ?? <span className="mono">{id}</span>}</span>
              {browseOnly && services.find(service => service.id === id)?.maxAmount ? <span className="mono service-id">Up to {services.find(service => service.id === id)?.maxAmount} USDC / request</span> : title(id) ? <span className="mono service-id">{id}</span> : null}
              {browseOnly ? null : <button type="button" className="btn btn-quiet btn-sm service-remove" aria-label={`Remove ${id}`} onClick={() => onChange(selected.filter(v => v !== id))}>
                <X size={14} aria-hidden="true" />
              </button>}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="service-picker-browse">
        <button type="button" className="btn btn-sm" ref={browseRef} onClick={() => setOpen(true)}>
          <Search size={14} aria-hidden="true" />
          {selected.length ? 'Edit in the PaySH catalog' : 'Browse the PaySH catalog'}
        </button>
      </p>
      {/* Outside the form, so Enter in the catalog search never submits the policy. */}
      {open ? createPortal(
        <dialog ref={dialogRef} className="paysh-dialog" aria-labelledby="wl-title" onClose={() => {setOpen(false); browseRef.current?.focus();}}>
          <PayshCatalog registered={services} selected={selected} max={max} network={network.id} networkLabel={network.label} onChange={onChange} onDone={close} availability={availability} native={native} browseOnly={browseOnly} />
        </dialog>,
        document.body,
      ) : null}
    </fieldset>
  );
}

export function Composer({c, raise, seed}: {c: MicroController; raise: (m: string) => void; seed?: string}) {
  const {pending, run, blocked} = useRun(c, raise);
  const [text, setText] = useState(seed ?? '');
  const runtime = useRuntimeChoice(c, c.network);
  const deployment = useStellarDeployment(c, runtime.choice);
  const local = c.network === 'local:dev';
  const devnetExample = devnetResearchExample(c.network, c.auth.session);
  // Local dev never waits for wallet options. Elsewhere a failed registry blocks generation, and a loaded registry
  // needs a complete explicit choice.
  const loadingRuntime = !local && c.runtimeConfig === null;
  const runtimeBlocked = !local && (c.runtimeConfigFailed || (!!runtime.config && !runtime.choice));
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt) {
      setErr('Describe what the agent may do first.');
      document.getElementById('compose')?.focus();
      return;
    }
    setErr(null);
    // The typed text stays until the draft exists. On success the new draft is selected and this view unmounts.
    await run('generate', () => deployment.enabled ? c.generate(prompt, runtime.choice ?? undefined, deployment.selected) : c.generate(prompt, local ? undefined : runtime.choice ?? undefined));
  };
  return (
    <ComposerFrame
      examples={isTempoNetwork(c.network) ? MICRO_EXAMPLES.filter(ex => !ex.title.startsWith('Research')) : devnetExample ? [devnetExample, ...MICRO_EXAMPLES] : MICRO_EXAMPLES}
      text={text}
      setText={setText}
      onSubmit={submit}
      blocked={blocked}
      sendDisabled={loadingRuntime || runtimeBlocked || deployment.blocked}
      generating={pending === 'generate'}
      error={err}
      clearError={() => setErr(null)}
      cue={c.network === 'local:dev' || isMainnet(c.network) || isStellarPublicNetwork(c.network) ? (
        <p className="small muted network-cue">
          {c.network === 'local:dev' ? 'No wallet or funds needed.' : c.network.startsWith('stellar:') ? 'Mainnet uses real funds.' : runtime.wallet?.profile===DELEGATED_PROFILE?'Mainnet uses real USDC. Each policy has its own token account and allowance within the original Rust policy and budget.':'Mainnet uses real USDC. An approved policy can spend real funds after your wallet signs each transfer.'}
        </p>
      ) : null}
      fields={<>
        {!local && c.runtimeConfigFailed ? <p className="small gate" role="status">Wallet options could not be loaded, so no policy can be created. Reload the page to retry.</p> : null}
        {!local && runtime.config && !runtime.choices.length ? <p className="small gate" role="status">No wallet is available for new policies on this network.</p> : null}
        {deployment.enabled ? deployment.loading ? <p className="small muted" role="status">Loading wallet accounts…</p> : deployment.error ? <p className="small gate" role="status">Wallet accounts could not be loaded. Reload the page to retry.</p> : deployment.options.length>1 ? <label className="field">Wallet account<select value={deployment.selected} disabled={blocked} onChange={e=>deployment.pick(e.target.value)}><option value="">Choose a wallet account</option>{deployment.options.map(i=><option key={i.policyId} value={i.policyId}>{i.config.wallet} · {i.policyId.slice(-8)}</option>)}</select></label> : deployment.options.length===1 ? <p className="small muted">Wallet account: <code className="stellar-wallet-address">{deployment.options[0].config.wallet}</code></p> : <p className="small gate" role="status">Add an owner-authorized wallet account for this network.</p> : null}
        {!local && (runtime.choices.length > 1 || (runtime.wallet && hasRequestFields(runtime.wallet))) ? (
          <fieldset className="runtime-choice" aria-label="Wallet" disabled={blocked}>
            <div className="runtime-options">
              {runtime.choices.map(w => (
                <label key={walletKey(w)} className="runtime-option">
                  <input type="radio" name="runtime-wallet" value={walletKey(w)} checked={runtime.wallet ? walletKey(runtime.wallet) === walletKey(w) : false} onChange={() => runtime.setPicked(walletKey(w))} />
                  {w.kind === 'contract-wallet' ? <Vault size={14} aria-hidden="true" /> : <Wallet size={14} aria-hidden="true" />}
                  <span>{walletName(w)}</span>
                </label>
              ))}
            </div>
            {runtime.config && runtime.wallet ? <RequestFields key={walletKey(runtime.wallet)} id="runtime" intent={text} config={runtime.config} wallet={runtime.wallet} picks={runtime.picks} pick={runtime.pick} disabled={blocked} network={{id: c.network, label: networkLabel(c.network, c.networks)}} showFacts={false} /> : null}
          </fieldset>
        ) : null}
      </>}
    />
  );
}

/* ---------------------------------------------------------------- policy view */

function Transcript({turns}: {turns: MicroPolicy['turns']}) {
  if (turns.length === 0) return <p className="muted small">No conversation yet.</p>;
  return (
    <ol className="turns">
      {turns.map((t, i) => (
        <li className={`turn turn-${t.role}`} key={i}>
          <span className="turn-who">{t.role === 'user' ? 'You' : t.role === 'system' ? 'Policy history' : 'Allowit'}</span>
          <div className="turn-text">{t.role === 'assistant' ? <details><summary>Revision {t.revision} ready</summary><p>{t.text}</p></details> : <p>{t.text}</p>}</div>
          <span className="turn-rev num">revision {t.revision}</span>
        </li>
      ))}
    </ol>
  );
}

function ReviseForm({c, raise}: {c: MicroController; raise: (m: string) => void}) {
  const {pending, run, blocked} = useRun(c, raise);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const prompt = text.trim();
    if (!prompt) {
      setErr('Say what should change.');
      document.getElementById('revise')?.focus();
      return;
    }
    setErr(null);
    const ok = await run('revise', () => c.revise(prompt));
    if (ok) setText('');
  };
  return (
    <form className="form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor="revise">Ask for a change</label>
        <textarea
          id="revise"
          className="revise-textarea"
          rows={5}
          value={text}
          disabled={blocked}
          onChange={e => {
            setText(e.target.value);
            if (err) setErr(null);
          }}
          onKeyDown={submitOnEnter}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? 'revise-err' : undefined}
        />
        <ErrorLine id="revise-err" text={err} />
      </div>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary" disabled={blocked}>
          {pending === 'revise' ? <Spinner /> : null}
          {pending === 'revise' ? 'Revising…' : 'Revise'}
        </button>
      </div>
    </form>
  );
}

function ApproveForm({c, policy, raise,unsaved=false}: {c: MicroController; policy: MicroPolicy; raise: (m: string) => void;unsaved?:boolean}) {
  const {pending, run, blocked} = useRun(c, raise);
  // The wallet broadcasts when it returns, so a signed allowance shows as finalizing at once and is never signed twice.
  const tx = c.txProgress('allocation', policy.id, 'approve');
  const signed = tx?.phase === 'finalizing' ? tx : null;
  const [amount, setAmount] = useState(policy.fundingRequest?.amount ?? '');
  const [token, setToken] = useState(TOKENS[0]);
  const [err, setErr] = useState<string | null>(null);
  const net = networkLabel(policy.network, c.networks);
  const local = policy.network==='local:dev';
  const config = c.networks.find(n => n.id === policy.network);
  const canAllocate = Boolean(policy.mint || config?.allocationEnabled);
  const gate = canAllocate
    ? null
    : isTestnet(policy.network)
      ? 'Testnet approvals need a configured test token.'
      : `${net} approvals need a configured token.`;
  const tokenHint = local ? 'No funds move on Local dev.' : isMainnet(policy.network)
    ? 'USDC on Mainnet is real, Circle-issued USDC.'
    : isTestnet(policy.network)
      ? 'This Testnet token is not Circle USDC. USDC in policy code refers to this test token.'
      : (policy.mint || config?.mint) === CIRCLE_DEVNET_USDC
        ? 'Devnet USDC is Circle’s test token with no value.'
        : 'This Devnet token is not Circle USDC. USDC in policy code refers to this configured test token, which has no value.';
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canAllocate || unsaved || tx) return;
    const r = parseAmount(amount);
    if ('error' in r) {
      setErr(r.error);
      document.getElementById('alloc-amount')?.focus();
      return;
    }
    setErr(null);
    await run('approve', () => c.approve(r.value, token));
  };
  return (
    <form className="form" onSubmit={submit} noValidate>
      {!tx ? <div className="field-row">
          <div className="field">
            <label htmlFor="alloc-amount">Amount to approve</label>
            <input
              id="alloc-amount"
              className="num"
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              disabled={blocked || !canAllocate}
              onChange={e => {
                setAmount(e.target.value);
                if (err) setErr(null);
              }}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? 'alloc-err' : undefined}
            />
            {policy.fundingRequest ? <span className="field-hint">Requested: {policy.fundingRequest.amount} {tokenName(policy.network, policy.fundingRequest.token)}</span> : null}
            {policy.limit ? <span className="field-hint">Lifetime policy limit: {policy.limit} {tokenName(policy.network, policy.token || TOKENS[0])}</span> : null}
            <ErrorLine id="alloc-err" text={err} />
          </div>
          <div className="field">
            <label htmlFor="alloc-token" id="alloc-token-label">Token</label>
            <ListSelect
              id="alloc-token"
              value={token}
              options={TOKENS.map(t => ({value: t, label: tokenName(policy.network, t)}))}
              onChange={setToken}
              labelledBy="alloc-token-label"
              describedBy="alloc-token-hint"
              disabled={blocked || !canAllocate}
            />
            <span className="field-hint" id="alloc-token-hint">
              {tokenHint}
            </span>
          </div>
        </div> : null}
      {!canAllocate ? null : local ? <p className="small muted">Approve this budget and create the agent skill. Local actions count against it without moving funds.</p> : (
        <p className="small muted">
          {isMainnet(policy.network)
            ? 'Your wallet asks you to sign one Mainnet transaction. It sets a real USDC allowance for this amount and pays a SOL network fee.'
            : isTestnet(policy.network)
              ? 'Your wallet asks you to sign one Testnet transaction that allocates this amount of Test USDC, a test token not issued by Circle. It pays a Testnet SOL fee.'
              : 'Your wallet asks you to sign one Devnet transaction that allocates this amount. Devnet tokens have no value.'}{' '}
          An allowance is not a transfer: the tokens stay in your wallet, and each transfer your agent requests still waits
          for your wallet. If the wallet declines or the transaction fails, the error appears above and the policy stays a
          draft.
        </p>
      )}
      {gate ? (
        <p className="small gate" role="status" id="alloc-gate">
          <CircleAlert size={14} aria-hidden="true" />
          {gate}
        </p>
      ) : null}
      {unsaved?<p className="small" role="status">Save preference changes before approving.</p>:null}
      {tx?.phase === 'unknown' ? (
        <p className="small" role="status">
          Your wallet returned without a signature, so this allowance may have been sent. Check your wallet activity. This tab does not ask for another approval while the outcome is unknown. To remove any allowance it may have set, cancel the policy below.
        </p>
      ) : signed ? (
        <div className="stack">
          <p className="small" role="status">
            <strong>Signed · finalizing on {net}</strong>
          </p>
          <p className="small muted">
            Your wallet signed and sent this allowance. {net} has not finalized it yet.{signed.signature ? <> Signature <span className="mono" title={signed.signature}>{shortAddr(signed.signature)}</span>.</> : null}
          </p>
          {!signed.checking && signed.message ? <p className="small muted">{signed.message}</p> : null}
          <div className="btn-row">
            <button type="button" className="btn" disabled={blocked} onClick={() => run('recheck', () => c.recheckAllocation('approve'))}>
              {signed.checking ? <Spinner /> : null}
              {signed.checking ? 'Checking…' : 'Check again'}
            </button>
          </div>
        </div>
      ) : (
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={blocked || !canAllocate || unsaved} aria-describedby={gate ? 'alloc-gate' : undefined}>
            {pending === 'approve' ? <Spinner /> : null}
            {pending === 'approve' ? local ? 'Creating skill…' : 'Waiting for your wallet…' : local ? 'Approve and create skill' : 'Approve and sign allocation'}
          </button>
        </div>
      )}
    </form>
  );
}

/**
 * PaySH discovery is an instruction to the agent, not a policy check: the agent may look up paid APIs on pay.sh, and
 * still pays only through this policy's requests.
 */
const PAYSH_DISCOVERY = '\n\n## Paid API discovery\n\nFind paid APIs through PaySH: https://pay.sh/docs/using-pay/skills. Pay only through this policy\'s requests, within its rules. Do not pay with another wallet or with Pay payment tools as a fallback; report any payment the policy refuses.\n';

function Handoff({c, raise}: {c: MicroController; raise: (m: string) => void}) {
  const {pending, run, blocked} = useRun(c, raise);
  const [copy, setCopy] = useState<'idle' | 'done' | 'failed'>('idle');
  // Kept per owner on this device. It changes only the skill text handed to the agent, so it can change at any time.
  const [discoveryIds, saveDiscovery] = useOwnerIds(`allowit.paysh-discovery.${c.auth.session?.address || ''}`);
  const discovery = !!c.selected && discoveryIds.includes(c.selected.id);
  const setDiscovery = (on: boolean) => {
    const id = c.selected?.id;
    if (id) saveDiscovery(on ? [...discoveryIds.filter(v => v !== id), id] : discoveryIds.filter(v => v !== id));
  };
  // The server's copy of the skill stays as generated, so the section also goes into the harness prompt the agent starts from.
  const skill = c.skill && discovery ? c.skill.trimEnd() + PAYSH_DISCOVERY : c.skill;
  const prompt = c.harnessPrompt && discovery ? c.harnessPrompt.trimEnd() + PAYSH_DISCOVERY : c.harnessPrompt;
  const r = c.selected ? runtimeOf(c.selected) : null;
  const kind = r?.kind ?? null;
  const providerCall = !!r?.capabilities.providerCall;
  const stellarAccess = !!c.selected && isStellarPolicy(c.selected);
  const authorization = c.selected ? fundingPath(c.selected) === 'authorization' : false;
  // An empty list on an ordinary owner-wallet policy means no typed requests, not that its transfers are refused.
  const admitted = authorization || r?.capabilities.typedIngress?.length ? admittedSentence(r?.capabilities.typedIngress) : null;
  useEffect(() => {
    if (copy !== 'done') return;
    const t = window.setTimeout(() => setCopy('idle'), 2000);
    return () => window.clearTimeout(t);
  }, [copy]);
  // The access token is shown only on request; copying always copies the complete prompt.
  const [reveal, setReveal] = useState(false);
  useEffect(() => {
    setCopy('idle');
    setReveal(false);
  }, [prompt]);
  const doCopy = async () => {
    if (!prompt) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('unavailable');
      await navigator.clipboard.writeText(prompt);
      setCopy('done');
    } catch {
      setCopy('failed');
    }
  };
  return (
    <div className="stack">
      {/* Lifetime and replacement are stated only where the wallet's contract defines them. */}
      {kind === 'owner-wallet' && !authorization ? <p className="small muted">Its private access expires after 24 hours.</p> : null}
      <p className="small muted">{c.selected?.network === 'local:dev'
        ? 'Requests can describe SOL or USDC on Solana and XLM or USDC on Stellar, with an optional memo, data and before/after contract calls. Calls require your approval. Nothing is sent and no funds move.'
        : stellarAccess ? 'The agent signs each exact Stellar transfer locally. The server verifies current wallet authority and the authored policy before submission.' : authorization
          ? 'This policy’s budget is authorized. The agent can only make requests of a kind the policy admits.'
        : kind === 'owner-wallet'
          ? 'USDC transfers on this policy’s Solana network. Each transfer requires your wallet signature.'
          : providerCall
            ? `Paid calls run through this policy’s contract wallet within its signed limits, without another signature from you. Anyone with this skill’s access can make them. ${EXECUTION_AUTHORITY}`
            : 'This policy’s wallet does not make provider calls.'}</p>
      {admitted ? <p className="small muted">{admitted}</p> : null}
      {!stellarAccess ? <><label className="paysh-discovery">
        <input type="checkbox" checked={discovery} disabled={!c.selected} onChange={e => setDiscovery(e.target.checked)} aria-describedby="paysh-discovery-hint" />
        <span>Let the agent discover paid APIs through PaySH</span>
      </label>
      <p className="small muted" id="paysh-discovery-hint">Adds pay.sh discovery to the agent’s skill. Payments still go only through this policy.</p></> : null}
      {skill ? <SkillFile content={skill} /> : null}
      {prompt ? (
        <div className="field">
          <label htmlFor="harness">Harness prompt</label>
          <textarea id="harness" className="mono harness-textarea" readOnly value={reveal || copy === 'failed' ? prompt : maskSecrets(prompt)} onFocus={e => e.currentTarget.select()} />
          <div className="btn-row">
            <button type="button" className="btn" onClick={doCopy}>
              {copy === 'done' ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              {copy === 'done' ? 'Copied' : 'Copy prompt'}
            </button>
            <button type="button" className="btn btn-quiet" aria-pressed={reveal || copy === 'failed'} onClick={() => setReveal(v => !v)}>
              {reveal || copy === 'failed' ? 'Hide access token' : 'Show access token'}
            </button>
            <span className="small" role="status">
              {copy === 'failed' ? 'Copy failed. Select the text above and copy it yourself.' : copy === 'done' ? 'Prompt copied with its access token.' : ''}
            </span>
          </div>
        </div>
      ) : null}
      <div className="btn-row">
        <button type="button" className={`btn${prompt ? '' : ' btn-primary'}`} disabled={blocked} onClick={() => run('handoff', () => c.handoff())}>
          {pending === 'handoff' ? <Spinner /> : null}
          {pending === 'handoff' ? 'Preparing…' : prompt ? 'Create new skill' : 'Get harness prompt'}
        </button>
      </div>
    </div>
  );
}

function Usage({policy, requests: listed}: {policy: MicroPolicy; requests?: readonly PolicyRequest[]}) {
  const events = policy.activity ?? [];
  // Only the owner wallet reports spending in its allocation token. Other wallets settle in their own assets, so no
  // amount, total or ratio is computed across them here.
  // A budget authorization reports no spending in an allowance token either, so it uses the same count.
  if (isStellarPolicy(policy) || runtimeOf(policy).kind !== 'owner-wallet' || fundingPath(policy) === 'authorization') {
    const all = listed ?? policy.requests ?? [];
    const count = (pred: (r: PolicyRequest) => boolean) => all.filter(pred).length;
    const revoked = (r: PolicyRequest) => r.status === 'denied' && r.decisionCode === 'POLICY_REVOKED';
    const denied = count(r => r.status === 'denied' && !revoked(r)), waiting = count(r => r.status === 'awaiting_input' || revoked(r));
    return (
      <div className="stack">
        <p>{all.length === 0 ? (policy.status === 'cancelled' ? 'No requests were made.' : 'No requests yet.') : `${all.length} ${all.length === 1 ? 'request' : 'requests'}${denied ? `, ${denied} denied` : ''}${waiting ? `, ${waiting} ${policy.status === 'active' ? 'waiting for your answer' : 'no longer available'}` : ''}.`}</p>
        <p className="small muted">Payments count once their receipts are finalized. Each request lists its own transactions under Requests.</p>
      </div>
    );
  }
  const token = tokenName(policy.network, policy.allocation?.token || policy.token || TOKENS[0]);
  const net = networkLabel(policy.network);

  const requests=policy.requests??[];
  const revoked = (r: PolicyRequest) => r.status === 'denied' && r.decisionCode === 'POLICY_REVOKED';
  const denied = requests.filter(r => r.status === 'denied' && !revoked(r)).length;
  const waiting = requests.filter(r => r.status === 'awaiting_input' || revoked(r)).length;
  const spent = (policy.spentUnits ?? 0) / 1_000_000;
  const cap = num(policy.allocation?.amount ?? '');
  const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
  const summary =
    events.length === 0
      ? policy.status==='cancelled' ? 'No requests were made.' : 'No requests yet.'
      : `${fmtAmount(spent)} ${token}${cap > 0 ? ` of ${fmtAmount(cap)} ${token}` : ''} ${policy.network==='local:dev'?'recorded locally':'transferred'} · ${requests.length} ${
          requests.length === 1 ? 'request' : 'requests'
        }${denied ? `, ${denied} denied` : ''}${waiting ? `, ${waiting} ${policy.status === 'active' ? 'waiting for your answer' : 'no longer available'}` : ''}.`;
  return (
    <div className="stack">
      <p>{summary}</p>
      {cap > 0 && events.length > 0 ? (
        <div className="meter" role="img" aria-label={`${fmtAmount(spent)} of ${fmtAmount(cap)} ${token} ${policy.network==='local:dev'?'recorded locally':'transferred'}`} >
          <span className="meter-fill" style={{width: `${pct}%`}} />
        </div>
      ) : null}
      {events.length > 0 ? (
        <ol className="events">
          {events.map((e: UsageEvent) => (
            <li className={`event event-${e.outcome === 'awaiting_input' ? 'awaiting' : e.outcome}`} key={e.id}>
              <span className="event-when num">{fmtDateTime(e.at)}</span>
              <span className="event-main">
                <span className="event-detail">{e.detail}</span>
                <span className="event-kind">{e.kind === 'transaction' ? 'transaction' : 'judgment'}</span>
              </span>
              <span className="event-amount num">
                {e.amount} {tokenName(policy.network, e.token)}
              </span>
              <span className="event-outcome">{e.outcome === 'allowed' ? 'Allowed' : e.outcome === 'denied' ? 'Denied' : 'Approval requested'}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {/* Local dev states that no funds move once, in the agent skill. */}
      {policy.network==='local:dev'?null:<p className="small muted">Transfers count here once {net} finalizes them. An allowed check on its own moves nothing.</p>}
    </div>
  );
}

/** Whether a policy offers cancel or discard. A budget authorization has no allowance to revoke and no discard route here. */
function CancelControl({c, raise, requested = false, handled}: {c: MicroController; raise: (m: string) => void; requested?: boolean; handled?: () => void}) {
  const {pending, run, blocked} = useRun(c, raise);
  const [arm, setArm] = useState(false);
  // The nav close button cancels at once. A draft needs no wallet; a revocation still opens the wallet to sign.
  useEffect(() => {
    if (!requested) return;
    handled?.();
    void run('cancel', () => c.cancel());
  }, [requested]);
 const discard=c.selected?.status==='draft'&&!c.selected.approvalPending;
 const net = c.selected ? networkLabel(c.selected.network, c.networks) : '';
 const revokeCopy = c.selected?.network==='local:dev' ? 'Agent access stops immediately. No wallet transaction is needed.' : c.selected && isMainnet(c.selected.network)
   ? 'Harness access stops immediately. Your wallet will revoke the Mainnet USDC allowance, which costs a SOL network fee. Your USDC remains in your wallet.'
   : `Harness access stops immediately. Your wallet will revoke the ${net} allowance. Your tokens remain in your wallet.`;
  const revoke = c.selected ? c.txProgress('allocation', c.selected.id, 'cancel') : null;
  if (c.selected?.status === 'cancelling' && revoke?.phase === 'unknown') return <div className="stack"><p>Harness access is off.</p><p className="small" role="status">Your wallet did not return a signature, so this revocation may have been sent. Check your wallet activity. No new revocation is requested while the outcome is unknown, including from Stop all policies. Checking again asks Allowit whether the allowance is gone on {net}; it never opens your wallet.</p>{revoke.message ? <p className="small muted">{revoke.message}</p> : null}<div className="btn-row"><button type="button" className="btn" disabled={blocked} onClick={() => run('cancel', () => c.recheckAllocation('cancel'))}>{pending === 'cancel' ? 'Checking…' : 'Check again'}</button></div></div>;
  if (c.selected?.status === 'cancelling') return <div className="stack"><p>Harness access is off. {revoke?.phase === 'finalizing' ? <>Your wallet signed the revocation. {net} has not finalized it yet.{revoke.signature ? <> Signature <span className="mono" title={revoke.signature}>{shortAddr(revoke.signature)}</span>.</> : null}</> : <>Complete the wallet revocation to remove the {net} allowance.</>}</p>{revoke?.phase === 'finalizing' && !revoke.checking && revoke.message ? <p className="small muted">{revoke.message}</p> : null}<button className="btn btn-danger" disabled={blocked} onClick={() => run('cancel', () => revoke?.phase === 'finalizing' ? c.recheckAllocation('cancel') : c.cancel())}>{revoke?.phase === 'finalizing' ? revoke.checking ? 'Checking…' : 'Check again' : pending === 'cancel' ? 'Cancelling…' : 'Retry cancellation'}</button></div>;
  if (!arm)
    return (
      <div className="btn-row">
        <button type="button" className="btn btn-danger" disabled={blocked} onClick={() => setArm(true)}>
          {discard ? 'Discard draft' : 'Cancel policy'}
        </button>
      </div>
    );
  return (
    <div className="stack">
      <p className="small" role="status">
        {discard ? `Discard this draft? ${c.selected && runtimeOf(c.selected).capabilities.fork ? 'You can fork it later. ' : 'Its original terms remain on the server. '}No wallet transaction is needed.` : revokeCopy}
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-danger" disabled={blocked} onClick={() => run('cancel', () => c.cancel())}>
          {pending === 'cancel' ? <Spinner /> : null}
          {pending === 'cancel' ? 'Cancelling…' : discard ? 'Confirm discard' : 'Confirm cancel'}
        </button>
        <button type="button" className="btn" disabled={blocked} onClick={() => setArm(false)}>
          Keep policy
        </button>
      </div>
    </div>
  );
}

function LegacyNotice({c, policy, raise}: {c: MicroController; policy: MicroPolicy; raise: (m: string) => void}) {
  const {pending, run, blocked} = useRun(c, raise);
  const net = networkLabel(policy.network, c.networks);
  return (
    <div className="legacy">
      <h3 className="legacy-title">Update this policy to continue</h3>
      <p>
        This policy was written in an earlier format. Update it to see its steps and to let your agent make requests under it.
      </p>
      <p className="small muted">
        Updating creates a new draft on {net} from your original request. Nothing changes for this policy until you approve
        the new draft
        {policy.allocation && policy.status !== 'cancelled' ? '; your current allowance stays in place and can still be cancelled below' : ''}.
      </p>
      <div className="btn-row">
        <button type="button" className="btn btn-primary" disabled={blocked} onClick={() => run('migrate', () => c.migrate())}>
          {pending === 'migrate' ? <Spinner /> : null}
          {pending === 'migrate' ? 'Updating…' : 'Update policy'}
        </button>
      </div>
    </div>
  );
}

/** `closeIsRevoke`: the list already knows this policy has a vault, so its revoke dialog can open before the page reads it. */
function PolicyView({c, delegated, policy, raise, closeRequested = false, closeIsRevoke = false, closeHandled}: {c: MicroController; delegated:DelegateWorkspace; policy: MicroPolicy; raise: (m: string) => void; closeRequested?: boolean; closeIsRevoke?: boolean; closeHandled?: () => void}) {
  const {pending, run, blocked} = useRun(c, raise);
  const articleRef = useRef<HTMLElement>(null);
  const [pickedRequest, setPickedRequest] = useState<string | null>(null);
  const [dirtySteps,setDirtySteps]=useState<Set<string>>(()=>new Set());
  const markDirty=useCallback((id:string,dirty:boolean)=>setDirtySteps(prev=>{if(prev.has(id)===dirty)return prev;const next=new Set(prev);if(dirty)next.add(id);else next.delete(id);return next;}),[]);
  useEffect(() => {
    document.title = `${policy.title} – Allowit`;
  }, [policy.id, policy.title]);
  useEffect(() => { articleRef.current?.focus({preventScroll: true}); }, [policy.id]);
  const stateKey = `${policy.status}:${policy.revision}`;
  const parent = policy.parentId ? c.policies.find(p => p.id === policy.parentId) : undefined;
  const net = networkLabel(policy.network, c.networks);
  const legacy = policy.language === 'legacy';
  const typed = useTypedMetadata(policy);
  const runtime = runtimeOf(policy);
  const caps = runtime.capabilities;
  const stellarPolicy = isStellarPolicy(policy);
  const contract = !stellarPolicy && runtime.kind === 'contract-wallet';
  const ownerWallet = runtime.kind === 'owner-wallet';
  const delegatedProfile = hasDelegatedAuthority(policy);
  const delegatedView = delegated.view(policy);
  const delegatedGrant = delegatedView.grant;
  // Budget authorization never falls back to the allowance form, its USDC figure or its readiness.
  const authorization = fundingPath(policy) === 'authorization';
  const authFigure = authorization ? authorizationFigure(typed, policy.typedBudgetRequirements) : null;
  // Owner-session runs replace the policy's own entries by ID; entries only the policy lists are kept.
  const requests = mergeRuns(policy.requests ?? [], c.runs?.policyId === policy.id ? c.runs.requests : []);
  const serverSetup = runtime.state === 'typed' ? runtime.runtime.setup ?? null : null;
  const setupView = contract ? c.setup.view(policy.id) : null;
  const authView = authorization ? c.authorization.view(policy.id) : null;
  // Readiness evidence for this policy's own funding mode: the finalized setup, or the browser-verified authorization.
  const gateView = authorization ? authView : setupView;
  const owner = c.auth.session?.address ?? '';
  const native = !delegatedProfile && nativeCandidate(policy);
  const nativeFunding = useNativeFunding(c, policy, native);
  const ready = delegatedProfile ? delegatedView.ready : native ? nativeFunding.ready : handoffReady(policy, gateView, owner);
  // A Tempo policy is funded by a vault bound to this draft's exact snapshot; the Solana allowance sections do not apply.
  const tempoWorkspace = useTempoWorkspaceContext();
  const tempo = isTempoNetwork(policy.network);
  const tempoVault = tempo ? tempoWorkspace?.vaultFor(policy.id) ?? null : null;
  // An unread or unbound owner vault may still hold this draft. Editing waits for every binding to be checked.
  const tempoUnbound = tempo && !tempoVault && !!tempoWorkspace?.settled;
  // Preferences change on an unpending draft itself; any other policy whose wallet forks and revises saves them to a fork.
  const prefEditable = (!delegatedProfile || delegatedView.editable) && policy.status === 'draft' && !policy.approvalPending && caps.revise && (!tempo || tempoUnbound) && !nativeFunding.attachment && !hasNativeAttachment(policy);
  // Server-reported setup facts, or the finalized check from this session. Nothing is filled in by the client.
  const setupSignature = serverSetup?.signature || (setupView?.phase === 'finalized' ? setupView.proof.signature : '');
  const setupFacts: [string, ReactNode][] = contract ? ([
    ['Server-reported setup', serverSetup?.status],
    ['Policy account', serverSetup?.policyAccount ?? (setupView?.phase === 'finalized' ? setupView.state.chain?.policyAddress : undefined)],
    ['Setup signature', setupSignature || undefined],
    ['Policy expires', serverSetup?.expiresAt ? fmtDateTime(serverSetup.expiresAt) : undefined],
  ] as [string, ReactNode][]).filter(([, v]) => v !== undefined && v !== '') : [];
  // Tempo policy source counts in the USDC compatibility unit; the vault holds the configured token.
  const token = (symbol: string) => tempo && symbol === 'USDC' ? tempoWorkspace?.config?.tokenSymbol ?? 'tokens' : tokenName(policy.network, symbol);
  const assetToken = authFigure ? authFigure.token : runtime.state === 'typed' && contract ? runtime.runtime.fundingAsset.symbol : token(policy.allocation?.token || policy.token || 'USDC');
  const currentStatus = delegatedProfile ? delegatedView.status : native ? nativeFunding.status : policyState(policy, gateView, owner, tempoWorkspace);
  const fundingSummary = stellarPolicy ? ready ? 'Installed wallet' : 'Wallet verification pending' : delegatedProfile
    ? delegatedGrant ? `${displayDelegateAmount(delegatedGrant.budgetUnits)} USDC · ${delegatedView.status}` : delegated.loaded ? 'Not approved' : 'Checking wallet'
    : native
    ? currentStatus === 'Funds returned' ? 'Funds returned' : nativeFunding.loading || nativeFunding.readError || (!nativeFunding.reply?.state && currentStatus !== 'Draft') ? 'Checking vault' : nativeFunding.reply?.state && nativeFunding.attachment ? `${nativeFunding.attachment.initialFunding.amount} USDC budget` : 'Not funded'
    : tempo ? currentStatus === 'Funds returned' ? 'Funds returned' : currentStatus === 'Checking vault' ? 'Checking vault' : tempoVault?.state ? `${tempoVault.policy.totalLimit} ${token('USDC')} budget` : 'Not funded' : undefined;
  const accessReady = delegatedProfile ? delegatedView.ready : tempo ? currentStatus === 'Ready' : ready;
  const fundingVisible = stellarPolicy || delegatedProfile || native || (tempo ? policy.status !== 'cancelled' || !!tempoVault : (policy.status === 'draft' || (policy.status === 'active' && (contract || authorization) && !ready)) && runtime.state !== 'invalid');
  const accessVisible = delegatedProfile ? delegatedView.ready : native ? nativeFunding.ready : tempo ? accessReady : policy.status === 'active' && runtime.state !== 'invalid';
  // Solana request history lives in the header inbox; Stellar and Tempo retain their policy history.
  const nativeOps = nativeFunding.reply?.operations ?? [], tempoOps = tempoVault?.operations.filter(op => op.policyId === tempoVault.policy.id) ?? [];
  const historyVisible = stellarPolicy ? requests.length > 0 : tempo && (tempoOps.length > 0 || !!tempoVault?.activityError || !!tempoVault?.pendingInputs?.some(input => !input.answered));
  const legacyUsageVisible = policy.status !== 'draft' && (requests.length > 0 || (policy.spentUnits ?? 0) > 0);
  const usageVisible = delegatedProfile ? !!delegatedGrant && !delegateTerminal(delegatedGrant) && BigInt(delegatedGrant.spentUnits)>0n : native ? nativeOps.some(op => op.method === 'execute' && settledOperation(op)) : tempo ? !!tempoVault?.state && tempoOps.some(op => op.method === 'execute' && op.status === 'settled') : legacyUsageVisible;
  const stopVisible = delegatedProfile ? !!delegatedGrant && !delegateTerminal(delegatedGrant) && (!['draft','prepared'].includes(delegatedGrant.status)||!!delegated.proof(delegatedGrant,'approve')||!!delegated.proof(delegatedGrant,'revoke')) : native
    ? nativeStopSectionVisible(nativeFunding)
    : tempo ? !!tempoVault?.state || (tempoUnbound && cancelOffered(c, policy)) : cancelOffered(c, policy);
  const traced = requests.filter(r => r.sourceHash === policy.sourceHash && r.revision === policy.revision)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  // Follow the current run until a user deliberately picks a particular request.
  const selectedRequest = pickedRequest === null ? currentPolicyRequest(policy) : traced.find(r => r.id === pickedRequest) ?? null;
  const halted = haltedStep(policy, selectedRequest);
  const stepStatusById = workflowStatuses(policy, selectedRequest);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [reveal, setReveal] = useState(0);
  const selectStep = (nodeId: string) => {
    if (!policy.workflow.some(n => n.id === nodeId)) return;
    setSelectedStepId(nodeId);
    setReveal(n => n + 1);
  };
  useEffect(() => {
    if (!reveal || !selectedStepId) return;
    const step = articleRef.current?.querySelector<HTMLElement>(`[data-step-id="${CSS.escape(selectedStepId)}"]`);
    const details = step?.querySelector<HTMLDetailsElement>('details.wf-custom');
    if (details) details.open = true;
    step?.focus({preventScroll: true});
    step?.scrollIntoView({block: 'nearest', inline: 'nearest'});
    // Polling and trace updates never move the user's focus.
  }, [reveal]);
  useEffect(() => { setSelectedStepId(null); }, [policy.sourceHash]);
  return (
    <article className="policy" ref={articleRef} tabIndex={-1} aria-label={policy.title} data-policy-id={policy.id}>
      <header className="policy-head">
        <div className="policy-title-row">
          <div className="policy-actions">
            <button type="button" className="icon-action" aria-label="Copy complete policy source" title="Copy complete policy source" onClick={()=>navigator.clipboard.writeText(policy.code).catch(()=>raise('Copy failed. Select the policy code to copy it.'))}><Copy size={16}/></button>
            {!legacy&&caps.fork?<button type="button" className="icon-action" aria-label="Fork policy" title="Fork policy" disabled={blocked} onClick={()=>run('fork',()=>c.fork())}>{pending==='fork'?<Spinner/>:<GitFork size={17}/>}</button>:null}
          </div>
        </div>
        <div className="policy-metadata">
          <span title="The network is fixed for this policy."><NetworkIcon size={14}/>{net}</span>
          {/* Local dev has no wallet or signature; the network already says so. */}
          {policy.network==='local:dev'?null:<span title={c.auth.session?.address}><Wallet size={14}/>{shortAddr(c.auth.session?.address||'')}</span>}
          {delegatedProfile?<span title="Policy-checked spending from your wallet."><Wallet size={14}/>Owner wallet</span>:native?<span title="A separate native execution attachment preserves this policy source."><Vault size={14}/>Native vault</span>:tempo?<span title="The wallet is fixed for this policy."><Vault size={14}/>Tempo vault</span>:policy.network==='local:dev'||!runtime.kind?null:<span title="The wallet is fixed for this policy.">{runtime.kind==='contract-wallet'?<Vault size={14}/>:<Wallet size={14}/>}{stellarPolicy?walletName(policy.runtime!.wallet):WALLET_LABEL[runtime.kind]}</span>}
          <span title={policy.sourceHash}><Fingerprint size={14}/>Revision {policy.revision}<span className="mono">{policy.sourceHash?.slice(0,8)}</span></span>
          {delegatedProfile?<span title={delegatedGrant?.signature}><Signature size={14}/>{delegatedGrant?.signature?`Allowance tx ${shortAddr(delegatedGrant.signature)}`:delegatedView.status}</span>:native?<span><Signature size={14}/>{nativeFunding.status}</span>:tempo?<span><Signature size={14}/>{currentStatus}</span>:stellarPolicy?<span><Signature size={14}/>{ready?'Authority verified':'Not verified'}</span>:policy.network==='local:dev'?null:contract?<span title={setupSignature||undefined}><Signature size={14}/>{setupSignature?`Setup tx ${shortAddr(setupSignature)}`:'Not signed'}</span>:authorization?<AuthorizationChip view={authView}/>:<span title={policy.allocation?.signature||undefined}><Signature size={14}/>{policy.allocation?.signature?`Allocation tx ${shortAddr(policy.allocation.signature)}`:'Not signed'}</span>}
          {parent?<button type="button" className="link-btn" onClick={()=>c.select(parent.id)}><GitFork size={13}/>{parent.title}</button>:null}
        </div>
        {!legacy ? <nav className="policy-section-nav" aria-label="Policy sections">
          <a href="#p-summary">{sectionTitle('p-summary')}</a>
          <a href="#p-turns">{prefEditable && runtime.state !== 'invalid' ? 'Adjust rules' : sectionTitle('p-turns')}</a>
          {fundingVisible ? <a href="#p-approve">{sectionTitle('p-approve')}</a> : null}
          {accessVisible ? <a href="#p-handoff">{sectionTitle('p-handoff')}{accessReady ? ' · available' : ''}</a> : null}
          {historyVisible ? <a href="#p-requests">{sectionTitle('p-requests')}</a> : null}
          {usageVisible ? <a href="#p-usage">{sectionTitle('p-usage')}</a> : null}
          {stopVisible ? <a href="#p-cancel">{delegatedProfile?'Stop access':sectionTitle('p-cancel')}</a> : null}
        </nav> : null}
      </header>

      <div className={`policy-layout${legacy ? ' policy-layout-legacy' : ''}`}>
      <div className="policy-source">
      <PolicyCertificate policy={policy} owner={c.auth.session?.address||''} token={assetToken} status={currentStatus} authorityState={delegatedProfile?delegateAperture(delegatedView):undefined} amount={certificateAmount(stellarPolicy?undefined:delegatedProfile?delegatedGrant?displayDelegateAmount(delegatedGrant.budgetUnits):undefined:native?(nativeFunding.reply?.state?decimal(nativeFunding.reply.state.balance):nativeFunding.attachment?.initialFunding.amount):tempo?tempoVault?.policy.totalLimit:policy.allocation?.amount)} figure={stellarPolicy||native&&!nativeFunding.reply?.state||tempo&&!tempoVault?fundingSummary:authFigure?.figure} usageFraction={delegatedProfile?delegateUsageFraction(delegatedGrant):!stellarPolicy&&!native&&ownerWallet&&!authorization?allocationUsage(policy.allocation?.amount, policy.spentAmount):undefined} stepStatusById={stepStatusById} selectedStepId={selectedStepId} onSelectStep={selectStep} onRename={(!delegatedProfile||delegatedView.editable)&&policy.status==='draft'&&!policy.approvalPending&&!legacy&&caps.rename?c.rename:undefined} renaming={c.busy==='rename'} renameError={c.renameError}/>

      <div id="p-summary" className="section">
        {legacy ? (
          <LegacyNotice c={c} policy={policy} raise={raise} />
        ) : (
          <PolicyDefinition policy={policy} typed={typed} funding={fundingSummary ? {label: sectionTitle('p-approve'), text: fundingSummary} : undefined} />
        )}
      </div>
      <ServiceAllowlist policy={policy} config={c.runtimeConfig} />
      </div>

      {!legacy ? (
        <aside className="policy-workflow" aria-labelledby="workflow-title">
          <div className="workflow-panel">
            <h2 className="section-title" id="workflow-title">Workflow</h2>
            {traced.length && policy.workflow?.length ? (
              <div className="workflow-trace">
                <span id="workflow-request-label">Request</span>
                <ListSelect
                  id="workflow-request"
                  value={pickedRequest === null ? 'latest' : selectedRequest?.id ?? ''}
                  options={[
                    {value: 'latest', label: 'Latest'},
                    {value: '', label: 'None'},
                    ...traced.map(r => ({value: r.id, label: `${r.amount} ${token(r.token)}${r.action ? ` for ${r.action}` : ''}`, detail: fmtDateTime(r.createdAt)})),
                  ]}
                  onChange={v => {setPickedRequest(v === 'latest' ? null : v);setSelectedStepId(null);}}
                  labelledBy="workflow-request-label"
                />
              </div>
            ) : null}
            <PolicyWorkflow selectedStepId={selectedStepId} stepStatusById={stepStatusById} stopped={delegatedProfile || native || tempo ? !accessReady : policy.status !== 'active'} halt={halted && selectedRequest ? {nodeId: halted.id, status: selectedRequest.status === 'awaiting_input' ? (policy.status === 'active' ? 'awaiting_input' : 'unavailable') : selectedRequest.decisionCode === 'POLICY_REVOKED' ? 'unavailable' : 'denied', reason: selectedRequest.status === 'denied' ? selectedRequest.reason : undefined} : null} workflow={policy.workflow ?? []} calls={policy.calls} functionHelp={policy.functionHelp} typed={typed} code={policy.code} token={token} preference={{execution:native?'native':undefined,editable:prefEditable,busy:blocked,dirty:markDirty,save:c.configurePreference,fork:()=>run('fork',()=>c.fork()),forkSave:!prefEditable&&!legacy&&caps.fork&&caps.revise&&(!tempo||!!tempoWorkspace?.settled)&&!nativeFunding.attachment?c.forkPreference:undefined}} />
          </div>
        </aside>
      ) : null}

      <div className="policy-controls">
      <Section id="p-turns" title={sectionTitle('p-turns')}>
        <Transcript turns={policy.turns} />
        {legacy ? (
          <p className="small muted">Update this policy to keep revising it. The update starts a new draft from your original request.</p>
        ) : runtime.state === 'invalid' ? (
          <p className="small muted">This policy’s wallet details could not be read, so it cannot be changed or funded here.</p>
        ) : delegatedProfile && !delegatedView.editable ? (
          <p className="small muted">{delegatedView.bound?'This source revision is bound to its immutable wallet allowance. Fork it to write a new unbound policy.':'Check the wallet allowance before editing this policy.'}</p>
        ) : nativeFunding.attachment || hasNativeAttachment(policy) ? (
          <p className="small muted">This revision is bound to its native vault. Fork it to write a new draft.</p>
        ) : tempo && !tempoUnbound ? (
          <p className="small muted">{tempoVault ? 'This policy is bound to its Tempo vault. Fork it to write a new draft.' : 'Checking your vaults before this draft can change.'}</p>
        ) : policy.status === 'draft' && !policy.approvalPending && caps.revise ? (
          <ReviseForm key={stateKey} c={c} raise={raise} />
        ) : policy.status === 'draft' && !caps.revise ? (
          <p className="small muted">This policy’s wallet does not support revisions. Start a new draft to change it.</p>
        ) : (
          <p className="small muted">
            {policy.approvalPending ? 'An allowance request is pending. Retry approval or cancel it before revising.' : caps.fork ? `This policy is ${statusWord[policy.status].toLowerCase()}. Fork it to write a new draft on ${net}.` : contract&&!handoffReady(policy,setupView,c.auth.session?.address)?'This policy’s setup is pending. Refresh its status in Funding below.':authorization&&policy.status==='active'&&!ready?'This policy’s budget authorization is pending. See Funding below.':`This policy is ${statusWord[policy.status].toLowerCase()}.`}
          </p>
        )}

      </Section>

      {/* The service whitelist is a policy setting beside funding: a draft edits it, any other policy forks. */}
      {policyAllowlist(policy) === null && !delegatedProfile && !native && !stellarPolicy && !legacy ? <PolicyWhitelist c={c} policy={policy} raise={raise} editable={policy.status === 'draft' && !policy.approvalPending && caps.revise && (!tempo || tempoUnbound) && !nativeFunding.attachment} supported={c.runtimeConfig === null ? null : c.runtimeConfig !== 'unavailable' && c.runtimeConfig.features.policyWhitelist} /> : null}

      {delegatedProfile ? <DelegatePaySHCatalog workspace={delegated} policy={policy} /> : native ? <NativePaySHCatalog c={c} policy={policy} funding={nativeFunding} raise={raise} dirty={markDirty} /> : null}
      {delegatedProfile ? <><DelegateBudget workspace={delegated} policy={policy} raise={raise} unsaved={dirtySteps.size>0}/><DelegateAccess workspace={delegated} policy={policy} raise={raise}/><DelegateUsage workspace={delegated} policy={policy}/><DelegateStop workspace={delegated} policy={policy} raise={raise} requested={closeRequested} handled={closeHandled}/></> : native ? <NativeFunding model={nativeFunding} controller={c} policy={policy} unsaved={dirtySteps.size>0} unsavedIds={[...dirtySteps]} revokeRequested={closeRequested} revokeKnown={closeIsRevoke} revokeHandled={closeHandled} /> : tempo ? <>
        {tempoWorkspace && (policy.status !== 'cancelled' || tempoVault) ? <TempoFunding key={`${policy.id}:${policy.revision}`} draft={policy} workspace={tempoWorkspace} raise={raise} unsaved={dirtySteps.size>0} revokeRequested={closeRequested && closeIsRevoke} revokeHandled={closeHandled} /> : null}
        {tempoUnbound && cancelOffered(c, policy) ? <Section id="p-cancel" title={sectionTitle('p-cancel')}><CancelControl key={stateKey} c={c} raise={raise} requested={closeRequested} handled={closeHandled} /></Section> : null}
      </> : <>
      {(policy.status === 'draft' || (policy.status === 'active' && (contract || authorization) && !ready)) && !legacy && runtime.state !== 'invalid' ? (
        <Section id="p-approve" title={sectionTitle('p-approve')}>
          {stellarPolicy ? <Suspense fallback={<Spinner/>}><StellarFunding c={c} policy={policy} unsaved={dirtySteps.size>0}/></Suspense> : contract ? <ContractFunding c={c} policy={policy} unsaved={dirtySteps.size>0} /> : authorization ? <BudgetAuthorization c={c} policy={policy} typed={typed} view={authView} unsaved={dirtySteps.size>0} /> : <ApproveForm key={`${policy.id}:${policy.revision}`} c={c} policy={policy} raise={raise} unsaved={dirtySteps.size>0} />}
          <RuntimeSwitch c={c} policy={policy} raise={raise} />
        </Section>
      ) : null}

      {contract && (policy.allocation || setupFacts.length) ? (
        <Section id="p-alloc" title={sectionTitle('p-alloc')}>
          <dl className="facts">
            {policy.allocation ? <div><dt>Deposit</dt><dd>{policy.allocation.amount} {assetToken} on {net}</dd></div> : null}
            {setupFacts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
        </Section>
      ) : authorization && authView?.phase === 'verified' && ready ? (
        <Section id="p-alloc" title="Authorized budget">
          <CommitmentFacts c={authView.facts.commitment} expiresAt={authView.facts.expiresAt} signature={authView.facts.signatureBase64} />
          <p className="small muted">Budgets as listed in the policy definition. The authorization moved no funds.</p>
        </Section>
      ) : policy.allocation && !authorization && !stellarPolicy ? (
        <Section id="p-alloc" title={sectionTitle('p-alloc')}>
          <dl className="facts">
            <div>
              <dt>Amount</dt>
              <dd>
                {policy.allocation.amount} {tokenName(policy.network, policy.allocation.token)} on {net}
              </dd>
            </div>
            {policy.network==='local:dev'?<div><dt>Execution</dt><dd>Local actions only</dd></div>:<><div><dt>From</dt><dd>{policy.allocation.address}</dd></div><div><dt>Signature</dt><dd>{policy.allocation.signature}</dd></div></>}
          </dl>
        </Section>
      ) : null}

      {policy.status === 'active' && !legacy && runtime.state !== 'invalid' ? (
        <Section id="p-handoff" title={sectionTitle('p-handoff')}>
          {ready ? stellarPolicy ? <StellarHandoff c={c} policy={policy}/> : <Handoff c={c} raise={raise} /> : authorization ? <p className="small muted">The agent skill is available once this policy’s budget authorization is verified. An active status alone does not show a current authorization.</p> : <p className="small muted">The agent skill is available once this policy’s setup is finalized. An active status alone does not show that the setup is on chain.</p>}
        </Section>
      ) : null}

      {stellarPolicy ? <StellarHistory c={c} policy={policy} requests={requests} raise={raise} net={net} token={token} when={fmtDateTime}/> : null}

      {legacyUsageVisible ? (
        <Section id="p-usage" title={sectionTitle('p-usage')}>
          <Usage policy={policy} requests={requests} />
        </Section>
      ) : null}

      </>}

      {!delegatedProfile && cancelControlShown(c, policy) ? (
        <Section id="p-cancel" title={sectionTitle('p-cancel')}>
          <CancelControl key={stateKey} c={c} raise={raise} requested={closeRequested} handled={closeHandled} />
        </Section>
      ) : null}
      </div>
      </div>
    </article>
  );
}

/**
 * A v2 policy's own allowlist, exactly as its compiled runtime states it: one row per service with its input key. A
 * registry name is shown beside the ID only when the current registry lists that exact ID; nothing else is filled in.
 */
function ServiceAllowlist({policy, config}: {policy: MicroPolicy; config: MicroController['runtimeConfig']}) {
  const list = policyAllowlist(policy);
  if (!list) return null;
  const r = runtimeOf(policy);
  const op = r.state === 'typed' && config && config !== 'unavailable' ? config.operations.find(o => o.function === r.runtime.operation) : undefined;
  const name = (sid: string) => op?.services.find(s => s.id === sid)?.name;
  return (
    <Section id="p-services" title="Allowed services">
      {list.length ? (
        <>
          <p className="small muted service-allowlist-note">From the compiled policy. Requests for any other service do not match it.</p>
          <ul className="service-allowlist">
            {list.map(q => (
              <li key={q.service_id}>
                {name(q.service_id) ? <span className="service-name">{name(q.service_id)}</span> : null}
                <dl className="facts">
                  <div><dt>Service ID</dt><dd>{q.service_id}</dd></div>
                  <div><dt>Input key</dt><dd>{q.input_key}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="small muted">This policy’s compiled runtime lists no services.</p>}
    </Section>
  );
}

/** One server-advertised Devnet x402 resource can be compiled into an unbound draft. */
function DelegatePaySHCatalog({workspace, policy}: {workspace: DelegateWorkspace; policy: MicroPolicy}) {
  const config = workspace.config?.displayNetwork === policy.network ? workspace.config : null;
  const registered = connectedDelegateCatalog(config, policy.network);
  return <Section id="p-whitelist" title="x402 service">
    <p className="small muted">Browse the services connected on {networkLabel(policy.network)}. Browsing does not make a payment.</p>
    <ServiceWhitelist native browseOnly services={registered} selected={[]} onChange={() => {}} network={{id: policy.network, label: networkLabel(policy.network)}} disabled={false} note={!workspace.loaded ? 'Loading connected services.' : !config ? 'Connected services could not be loaded.' : !registered.length ? 'No x402 service is connected on this network.' : undefined} availability={{label: 'Not connected', detail: item => config?.catalogProviders?.find(provider => provider.id === item.id)?.reason ?? 'This service is listed for discovery and is not connected on this network.', filter: 'Connected services only'}} />
  </Section>;
}

function NativePaySHCatalog({c, policy, funding, raise, dirty}: {c: MicroController; policy: MicroPolicy; funding: NativeFundingModel; raise: (message: string) => void; dirty: (id: string, value: boolean) => void}) {
  const {pending, run, blocked} = useRun(c, raise);
  const sourceServices = useMemo(() => sourceWhitelist(policy.code), [policy.code]);
  const selectedService = selectedNativeX402Service(policy, funding.config);
  const service = funding.attachment?.x402Service ?? selectedService;
  const savedId = sourceServices.length === 1 ? sourceServices[0].id : '';
  const [ids, setIds] = useState<string[]>(() => savedId ? [savedId] : []);
  useEffect(() => setIds(savedId ? [savedId] : []), [policy.id, policy.revision, policy.sourceHash, savedId]);
  const registered = (funding.config?.x402Services ?? []).map(item => ({id: item.id, name: item.name}));
  const previewService = funding.config?.x402Services.find(item => item.id === ids[0]) ?? null;
  const changed = (ids[0] ?? '') !== savedId || (!!savedId && !selectedService && registered.some(item => item.id === savedId));
  useEffect(() => dirty('native-x402-service', changed), [changed, dirty]);
  useEffect(() => () => dirty('native-x402-service', false), [dirty, policy.id]);
  const canEdit = policy.status === 'draft' && !policy.approvalPending && !funding.attachment && !hasNativeAttachment(policy);
  const unavailable = blocked || !!funding.busy || funding.loading || !funding.config;
  const fork = () => void run('fork', () => c.fork());
  return <Section id="p-whitelist" title="x402 service">
    <p className="small muted">Choose the trusted Devnet resource this policy may call. Saving binds its service ID and recipient into a new source revision; it does not make a payment.</p>
    {canEdit ? <>
      <ServiceWhitelist native services={registered} selected={ids} onChange={setIds} network={{id: policy.network, label: policy.network==='solana:mainnet'?'Mainnet':'Devnet'}} disabled={unavailable} max={1} note={funding.loading ? 'Checking connected services.' : registered.length ? 'Only the connected Allowit Devnet service can be added to this policy.' : 'No API service is connected to this server. Paid API requests are unavailable.'} availability={{
        label: 'Not connected',
        detail: item => item.paysh ? `pay.sh lists payments on ${payshNetworks(item.paysh)}. This service is not connected to this vault.` : 'This service is not connected to this vault.',
        filter: 'Connected services only',
      }} />
      {previewService ? <>
        <p className="small muted">{changed ? 'Unsaved service preview. Save these exact values before setup.' : 'Saved service descriptor. These exact values will be frozen by setup.'}</p>
        <NativeX402Facts service={previewService} />
      </> : null}
      <div className="btn-row">
        <button type="button" className={changed ? 'btn btn-primary' : 'btn'} disabled={unavailable || !changed} onClick={() => void run('native-service', () => c.setNativeX402Service(ids[0] ?? ''))}>{pending === 'native-service' ? <Spinner /> : null}{pending === 'native-service' ? 'Saving…' : 'Save service'}</button>
        {changed ? <button type="button" className="btn btn-quiet" disabled={unavailable} onClick={() => setIds(savedId ? [savedId] : [])}>Discard changes</button> : null}
      </div>
    </> : service ? <>
      <p className="small muted">This service is fixed by the compiled policy and native vault binding.</p>
      <NativeX402Facts service={service} />
      <div className="btn-row"><button type="button" className="btn" disabled={blocked} onClick={fork}>Fork to edit</button></div>
    </> : <>
      <p className="small muted">No trusted x402 service is bound to this policy.</p>
      <div className="btn-row"><button type="button" className="btn" disabled={blocked} onClick={fork}>Fork to add a service</button></div>
    </>}
    <p className="small muted">Other PaySH catalog entries remain discovery-only here. The native agent can use only the exact saved Devnet service and policy limits.</p>
  </Section>;
}

function NativeX402Facts({service}: {service: NativeX402Service}) {
  return <dl className="facts">
    <div><dt>Service</dt><dd>{service.name}</dd></div>
    <div><dt>Service ID</dt><dd className="mono">{service.id}</dd></div>
    <div><dt>Resource URL</dt><dd><a href={service.resourceUrl} target="_blank" rel="noreferrer">{service.resourceUrl}</a></dd></div>
    <div><dt>Action</dt><dd className="mono">{service.action}</dd></div>
    <div><dt>Maximum per request</dt><dd>{service.maxAmount} USDC</dd></div>
    <div><dt>Recipient</dt><dd className="mono">{service.recipient}</dd></div>
    <div><dt>Network</dt><dd className="mono">{service.network}</dd></div>
    <div><dt>Scheme</dt><dd className="mono">{service.scheme}</dd></div>
  </dl>;
}

/**
 * The policy's pay.sh service whitelist, as compiled into its source. A draft edits it here and saves a new revision;
 * each service is bound to the wallet pay.sh publishes for it. Any other policy forks to change it.
 */
function PolicyWhitelist({c, policy, raise, editable, supported}: {c: MicroController; policy: MicroPolicy; raise: (m: string) => void; editable: boolean; supported: boolean | null}) {
  const {pending, run, blocked} = useRun(c, raise);
  const saved = useMemo(() => sourceWhitelist(policy.code), [policy.code]);
  // pay.sh takes payment for each provider on its listed networks; Local dev records actions without paying anyone.
  const services = useMemo(() => PAYSH_SERVICES.filter(s => policy.network === 'local:dev' || s.networks.includes(policy.network)).map(s => ({id: s.fqn, name: s.title})), [policy.network]);
  // An empty draft whitelist starts from the categories the owner's request names, for example "finance tasks". It is an
  // unsaved change: nothing reaches the policy source until the owner reviews the list and saves it.
  const canEdit = editable && supported === true;
  const suggestion = useMemo(() => (canEdit && !saved.length ? intentWhitelist(policy.originalIntent ?? '', services, MAX_SOURCE_WHITELIST) : null), [canEdit, saved, policy.originalIntent, services]);
  const initial = useCallback(() => (saved.length ? saved.map(e => e.id) : suggestion?.ids ?? []), [saved, suggestion]);
  const [ids, setIds] = useState(initial);
  useEffect(() => setIds(initial()), [initial]);
  const recipient = (id: string) => saved.find(e => e.id === id)?.recipient ?? PAYSH_SERVICES.find(s => s.fqn === id)?.payTo ?? '';
  const changed = ids.length !== saved.length || ids.some((id, i) => id !== saved[i]?.id);
  const net = {id: policy.network, label: networkLabel(policy.network, c.networks)};
  // Saved rules are always shown. Otherwise the section exists only where the owner can add a whitelist on this network.
  if (!saved.length && (supported !== true || !services.length)) return null;
  return (
    <Section id="p-whitelist" title={sectionTitle('p-whitelist')}>
      {canEdit ? (
        <>
          <ServiceWhitelist services={services} selected={ids} onChange={setIds} network={net} disabled={blocked} max={MAX_SOURCE_WHITELIST} note={suggestion ? intentWhitelistNote(suggestion, net.label, MAX_SOURCE_WHITELIST) : undefined} availability={{
            label: `Not paid on ${net.label}`,
            detail: s => s.paysh ? `pay.sh takes payment for this service on ${payshNetworks(s.paysh)} only, so a ${net.label} policy cannot pay it.` : `pay.sh does not list this service for ${net.label}.`,
            filter: `Paid on ${net.label} only`,
          }} />
          <p className="small muted service-whitelist-note">{ids.length ? 'Requests must name a listed service, and each service is paid only at the wallet pay.sh publishes for it.' : 'No whitelist: the agent may pay any service the other rules allow.'}</p>
          <div className="btn-row">
            <button type="button" className="btn" disabled={blocked || !changed} onClick={() => void run('whitelist', () => c.setWhitelist(ids.map(id => ({id, recipient: recipient(id)}))))}>
              {pending === 'whitelist' ? <Spinner /> : null}{pending === 'whitelist' ? 'Saving…' : 'Save whitelist'}
            </button>
            {changed ? <button type="button" className="btn btn-quiet" disabled={blocked} onClick={() => setIds(saved.map(e => e.id))}>Discard changes</button> : null}
          </div>
        </>
      ) : saved.length ? (
        <>
          <p className="small muted service-allowlist-note">From the compiled policy. Requests for any other service, or to any other wallet, do not match it.</p>
          <ul className="service-allowlist">
            {saved.map(e => (
              <li key={e.id}>
                <span className="service-name">{PAYSH_SERVICES.find(s => s.fqn === e.id)?.title ?? e.id}</span>
                <dl className="facts">
                  <div><dt>Service ID</dt><dd className="mono">{e.id}</dd></div>
                  <div><dt>Recipient</dt><dd className="mono">{e.recipient}</dd></div>
                </dl>
              </li>
            ))}
          </ul>
          {supported === true ? <div className="btn-row"><button type="button" className="btn" disabled={blocked} onClick={() => void run('fork', () => c.fork())}>Fork to edit</button></div> : null}
        </>
      ) : (
        <>
          <p className="small muted">No whitelist: the agent may pay any service the other rules allow.</p>
          <div className="btn-row"><button type="button" className="btn" disabled={blocked} onClick={() => void run('fork', () => c.fork())}>Fork to add a whitelist</button></div>
        </>
      )}
    </Section>
  );
}

/** Owner-session runs first, by ID; entries only the policy lists are kept after them. */
function mergeRuns(own: readonly PolicyRequest[], runs: readonly PolicyRequest[]): PolicyRequest[] {
  if (!runs.length) return [...own];
  const ids = new Set(runs.map(r => r.id));
  return [...runs, ...own.filter(r => !ids.has(r.id))];
}

/**
 * Another wallet for this request means a new draft: generation runs again from the owner's original words with the
 * other wallet. This draft and any signed proof stay exactly as they are; nothing is converted.
 */
function RuntimeSwitch({c, policy, raise}: {c: MicroController; policy: MicroPolicy; raise: (m: string) => void}) {
  const {pending, run, blocked} = useRun(c, raise);
  const [armed, setArmed] = useState<string | null>(null);
  const {picks, pick} = useScopedPicks(`${policy.network}|${armed ?? ''}`);
  const runtime = runtimeOf(policy);
  const owner = c.auth.session?.address ?? '';
  // The owner's exact stored words. Only a policy from before runtimes, which has none stored, uses its first request.
  const prompt = typeof policy.originalIntent === 'string' && policy.originalIntent ? policy.originalIntent : runtime.state === 'legacy' ? policy.turns.find(t => t.role === 'user')?.text ?? '' : '';
  const config = c.runtimeConfig && c.runtimeConfig !== 'unavailable' ? c.runtimeConfig : null;
  const view = runtime.kind === 'contract-wallet' ? c.setup.view(policy.id) : null;
  const untouched = !policy.approvalPending && !c.txProgress('allocation', policy.id, 'approve')
    && (runtime.kind !== 'contract-wallet' || (view?.phase === 'idle' && !browserBindings.read(owner, policy.id)));
  const current = runtime.state === 'typed' ? walletKey(runtime.runtime.wallet) : runtime.state === 'legacy' ? 'owner-wallet|' : '';
  const others = !config || !prompt || c.network !== policy.network || policy.network === 'local:dev' ? [] : walletChoices(config, policy.network).filter(w => {
    if (walletKey(w) === current || (runtime.state === 'legacy' && w.kind === 'owner-wallet')) return false;
    return walletUsable(config, w);
  });
  if (policy.status !== 'draft' || !untouched || !others.length || !config) return null;
  const target = others.find(w => walletKey(w) === armed) ?? null;
  const choice = target ? explicitChoice(config, target, picks) : null;
  return (
    <div className="runtime-switch">
      {target ? (
        <div className="stack" role="group" aria-label="Start a new draft with another wallet">
          <p className="small">This starts a new draft from your original request with the {walletName(target).toLowerCase()}. This draft and its revisions stay as they are. {WALLET_MEANING[target.kind]}</p>
          <RequestFields key={walletKey(target)} id="switch" config={config} wallet={target} picks={picks} pick={pick} disabled={blocked} intent={prompt} network={{id: policy.network, label: networkLabel(policy.network, c.networks)}} />
          <div className="btn-row">
            <button type="button" className="btn" disabled={blocked || !choice} onClick={() => {if (choice) void run('switch', () => c.generate(prompt, choice));}}>{pending === 'switch' ? <Spinner /> : null}{pending === 'switch' ? 'Generating…' : 'Start new draft'}</button>
            <button type="button" className="btn btn-quiet" disabled={blocked} onClick={() => setArmed(null)}>Keep this wallet</button>
          </div>
        </div>
      ) : others.map(w => (
        <button key={walletKey(w)} type="button" className="link-btn small" disabled={blocked} onClick={() => setArmed(walletKey(w))}>Use {walletName(w).toLowerCase()} instead</button>
      ))}
    </div>
  );
}

/** The certificate token: a typed wallet's funding asset, otherwise the allowance token. A budget authorization uses its own figure. */
function navToken(p: MicroPolicy) {
  const r = runtimeOf(p);
  return r.state === 'typed' && r.kind === 'contract-wallet' ? r.runtime.fundingAsset.symbol : tokenName(p.network, p.allocation?.token || p.token || 'USDC');
}

/** Header fact for a budget authorization: verified, signed here, expired, outdated or none. Muted, never red. */
function AuthorizationChip({view}: {view: AuthorizationView | null}) {
  const retained = view?.phase === 'idle' ? view.retained : null;
  const [text, title] = view?.phase === 'verified' ? [`Budget authorized ${shortValue(view.facts.signatureBase64)}`, view.facts.signatureBase64]
    : view?.phase === 'signed' ? ['Signed, not confirmed', view.entry.signature]
      : retained?.kind === 'expired' ? ['Authorization expired', undefined]
        : retained?.kind === 'stale' ? ['Authorization outdated', undefined] : ['Not authorized', undefined];
  return <span title={title}><Signature size={14} />{text}</span>;
}

/**
 * A budget authorization card. Its figure comes from the checked typed budgets, never from an allowance. A policy that
 * is not selected checks only its server-retained proof, read-only; the selected one uses the full controller view.
 */
function AuthorizationNavCertificate({policy, owner, view}: {policy: MicroPolicy; owner: string; view: AuthorizationView | null}) {
  const f = authorizationFigure(useTypedMetadata(policy), policy.typedBudgetRequirements);
  const key = authorizationKey(policy, owner);
  const [own, setOwn] = useState<{key: string; view: AuthorizationView} | null>(null);
  useEffect(() => {
    if (view || !owner) return;
    let live = true;
    evaluateAuthorization(policy, owner, null, location.origin, Date.now()).then(v => {if (live) setOwn({key, view: v});}, () => {});
    return () => {live = false;};
  }, [key, !!view]);
  const checked = view ?? (own?.key === key ? own.view : null);
  return <PolicyCertificate variant="compact" policy={policy} owner={owner} token={f.token} status={policyState(policy, checked, owner)} figure={f.figure} stepStatusById={workflowStatuses(policy)} />;
}

/* ---------------------------------------------------------------- picker */

/** A per-owner list of policy IDs kept in this browser. Storage is optional. */
function useOwnerIds(key:string):[string[],(ids:string[])=>void]{
 const [ids,setIds]=useState<string[]>(()=>{
  try { const stored:unknown=JSON.parse(localStorage.getItem(key)||'[]'); if(Array.isArray(stored))return stored.filter((id):id is string=>typeof id==='string'); } catch { /* Storage is optional. */ }
  return [];
 });
 return [ids,(next:string[])=>{setIds(next);try{localStorage.setItem(key,JSON.stringify(next));}catch{/* Storage is optional. */}}];
}

function PolicyNav({c,delegated,earlier,openEarlier,close,raise}:{c:MicroController;delegated:DelegateWorkspace;earlier:number;openEarlier:()=>void;close:(id:string,revoke?:boolean)=>void;raise:(message:string)=>void}){
 const owner=c.auth.session?.address||'';
  const tempo=useTempoWorkspaceContext();
 // Read synchronously so the first paint already uses the pinned order and hidden set. The nav is keyed by owner, so this runs per owner.
 const [pinned,savePins]=useOwnerIds(`allowit.pinned.${owner}`);
 // Closed policies the owner removed from the list. Only this device's list changes; the server keeps the policy.
 const [hidden,saveHidden]=useOwnerIds(`allowit.hidden.${owner}`);
 // Policies closed from the list leave it once their cancellation has finished.
 const [closingIds,setClosingIds]=useState<string[]>([]);
  const delegatedKept=(p:MicroPolicy)=>hasDelegatedAuthority(p)&&(!delegated.loaded||!!delegated.error||!!delegated.view(p).error||delegated.roots.some(g=>g.policyId===p.id&&g.status!=='revoked'));
  const selectedKept = !!c.selected && (delegatedKept(c.selected) || hasNativeAttachment(c.selected) || (isTempoNetwork(c.selected.network) && (!tempo?.settled || !!tempo.vaultFor(c.selected.id))));
 useEffect(()=>{
  const done=closingIds.filter(id=>{const p=c.policies.find(p=>p.id===id);return !!p&&(hasDelegatedAuthority(p)?!delegatedKept(p):p.status==='cancelled'&&!hasNativeAttachment(p));});
  if(!done.length)return;
  saveHidden([...hidden.filter(id=>!done.includes(id)),...done]);
  setClosingIds(ids=>ids.filter(id=>!done.includes(id)));
 },[c.policies,closingIds,delegated.grants,delegated.loaded,delegated.error]);
 useEffect(()=>{if(c.selected&&!selectedKept&&hidden.includes(c.selected.id))c.select(null);},[hidden,c.selected?.id,selectedKept]);
 // Native policies leave the list only after verified closure or a discarded unfunded draft.
 const {views:vaults,read:vaultsRead}=useNativeVaults(c);
 const returned=new Set(c.policies.filter(p=>{const view=vaults.get(p.id);return hasNativeAttachment(p)&&!!view&&leavesList(view,p.status==='cancelled');}).map(p=>p.id));
 // Once the open policy's vault has nothing left, move on to creating a new policy.
 // While the revoke dialog shows its result, Done moves on instead.
 useEffect(()=>{if(c.selected&&hasNativeAttachment(c.selected)&&returned.has(c.selected.id)&&!document.querySelector('.native-revoke-dialog[open]'))c.select(null);},[c.selected?.id,[...returned].join(',')]);
 const priority=(policy:MicroPolicy)=>{
  if(hasDelegatedAuthority(policy)){const v=delegated.view(policy);return !delegated.loaded||v.error||v.grant?.status==='revocation_pending'||v.grant?.status==='activation_pending'?3:v.ready?2:1;}
  const state=policyState(policy,fundingPath(policy)==='authorization'?c.authorization.view(policy.id):c.setup.view(policy.id),owner,tempo,vaults.get(policy.id));
  return state==='Checking vault'||state==='Setup pending'||state==='Authorization pending'||state==='Revoke pending'||state==='Check native vault'?3:state==='Ready'?2:state==='Draft'?1:0;
 };
 // A native card waits for its vault view, saved or fresh, so closed vaults never flash in; an unreadable one still appears.
 const policies=c.policies.filter(p=>delegatedKept(p)|| (hasNativeAttachment(p)?(vaults.has(p.id)?!returned.has(p.id):vaultsRead):(isTempoNetwork(p.network)&&(!tempo?.settled||(!!tempo.vaultFor(p.id)&&tempoPhase(tempo.vaultFor(p.id),true)!=='Funds returned')))||!hidden.includes(p.id))).sort((a,b)=>Number(pinned.includes(b.id))-Number(pinned.includes(a.id))||priority(b)-priority(a));
 // Opens the policy and brings its Revoke section into view once the page has read the vault.
 const openRevoke=(id:string)=>{
  c.select(id);
  let tries=0;
  const reveal=()=>{
   const section=document.querySelector(`article[data-policy-id="${CSS.escape(id)}"] #p-cancel`);
   if(section)section.scrollIntoView({block:'start',behavior:'smooth'});
   else if(++tries<20)setTimeout(reveal,150);
  };
  setTimeout(reveal,0);
 };
 // Closed: hide now. Cancellable: cancel at once, then hide once it finishes. Anything else stays listed and says why.
 const closeAction=(p:MicroPolicy):CloseAction=>{
  const label='Close policy';
  if(hasDelegatedAuthority(p)){
   const roots=delegated.roots.filter(g=>g.policyId===p.id),v=delegated.view(p);
   if(!delegated.loaded||delegated.error||v.error)return {label,reason:'Every retained allowance and earlier approval must be checked before this policy can leave the list.',open:{label:'Review wallet allowance',run:()=>c.select(p.id)}};
   if(roots.some(g=>g.status!=='revoked'))return {label:'Revoke policy',run:()=>{close(p.id,true);openRevoke(p.id);}};
   return {label,run:()=>saveHidden([...hidden,p.id])};
  }

  // A native policy's close button opens its revoke dialog over the policy page.
  if(hasNativeAttachment(p)){
   const vault=vaults.get(p.id);
   // No vault and no setup that can still land: close it like any draft.
   if(vault&&discardable(vault)&&p.status==='draft')return {label,run:()=>close(p.id)};
   if(vault&&!vault.hasVault)return {label,reason:vault.phase==='creating'?'Setup is still in progress. Close the policy once it finishes or fails.':'This policy’s vault could not be confirmed. Open it to check its status.',open:{label:'Open policy',run:()=>c.select(p.id)}};
   return {label:'Revoke policy',run:()=>close(p.id,!!vault?.hasVault)};
  }
  if(isTempoNetwork(p.network)){
   if(!tempo?.settled)return {label,reason:'The binding of every owned Tempo vault must be checked before this policy can leave the list.',open:{label:'Open policy',run:()=>c.select(p.id)}};
   // A funded Tempo vault opens the same revoke dialog as a native vault; a returned one leaves the list like a closed policy.
   const tv=tempo.vaultFor(p.id);
   if(tv)return tempoPhase(tv,true)==='Funds returned'?{label,run:()=>saveHidden([...hidden,p.id])}:{label:'Revoke policy',run:()=>close(p.id,true)};
   if(p.status==='cancelled')return {label,run:()=>saveHidden([...hidden,p.id])};
   if(cancelOffered(c,p))return {label,run:()=>{setClosingIds(ids=>ids.includes(p.id)?ids:[...ids,p.id]);close(p.id);}};
  }
  if(p.status==='cancelled')return {label,run:()=>saveHidden([...hidden,p.id])};
  if(!isTempoNetwork(p.network)&&cancelOffered(c,p))return {label,run:()=>{setClosingIds(ids=>ids.includes(p.id)?ids:[...ids,p.id]);close(p.id);}};
  const block=closeBlocker(c,p)??{reason:'This policy cannot be closed from the list. Open it to see what you can do.',revoke:false};
  return {label,reason:block.reason,open:block.revoke?{label:'Open revoke',run:()=>openRevoke(p.id)}:{label:'Open policy',run:()=>c.select(p.id)}};
 };
 return <PolicyNavFrame onNew={()=>c.select(null)} newDisabled={!!c.busy} empty={c.policies.length===0} before={<>
  {tempo?<TempoStopAll workspace={tempo} raise={raise}/>:<RevokePolicies c={c} delegated={delegated} returned={returned} onRevoke={ids=>setClosingIds(current=>[...current,...ids.filter(id=>!current.includes(id))])}/>}
  {earlier?<button type="button" className="link-btn small earlier-setups" disabled={!!c.busy} onClick={openEarlier}><History size={14} aria-hidden="true"/>{earlier===1?'1 earlier setup on this device':`${earlier} earlier setups on this device`}</button>:null}
  </>}>{policies.length===0?null:<ul>{policies.map(p=><li key={p.id} className="policy-nav-card">
    <button type="button" className={`policy-nav-item${c.selected?.id===p.id?' selected':''}`} disabled={!!c.busy} aria-current={c.selected?.id===p.id?'page':undefined} onClick={()=>c.select(p.id)}>
     {hasDelegatedAuthority(p)?<PolicyCertificate variant="compact" policy={p} owner={owner} token="USDC" status={delegated.view(p).status} authorityState={delegateAperture(delegated.view(p))} amount={delegated.view(p).grant?displayDelegateAmount(delegated.view(p).grant!.budgetUnits):undefined} usageFraction={delegateUsageFraction(delegated.view(p).grant)} stepStatusById={workflowStatuses(p)}/>:isTempoNetwork(p.network)?<PolicyCertificate variant="compact" policy={p} owner={owner} token={tempo?.config?.tokenSymbol??'tokens'} status={policyState(p,null,owner,tempo)} amount={certificateAmount(tempo?.vaultFor(p.id)?.policy.totalLimit)} figure={tempo?.vaultFor(p.id)?undefined:tempo?.settled?'Not funded':'Checking vault'} stepStatusById={workflowStatuses(p)}/>:fundingPath(p)==='authorization'?<AuthorizationNavCertificate policy={p} owner={owner} view={c.authorization.view(p.id)}/>:<PolicyCertificate variant="compact" policy={p} owner={owner} token={navToken(p)} status={policyState(p,c.setup.view(p.id),owner,null,vaults.get(p.id))} figure={hasNativeAttachment(p)?nativeFigure(vaults.get(p.id)):undefined} amount={certificateAmount(hasNativeAttachment(p)?(vaults.get(p.id)?.balance??vaults.get(p.id)?.funding)??undefined:p.allocation?.amount)} usageFraction={runtimeOf(p).kind==='owner-wallet'?allocationUsage(p.allocation?.amount, p.spentAmount):undefined} stepStatusById={workflowStatuses(p)}/>}
     <span className="policy-nav-meta">{networkLabel(p.network)}</span>
    </button>
    <PolicyNavActions title={p.title} pinned={pinned.includes(p.id)} disabled={!!c.busy} onPin={()=>savePins(pinned.includes(p.id)?pinned.filter(id=>id!==p.id):[...pinned,p.id])} close={closeAction(p)}/>
   </li>)}</ul>}
 </PolicyNavFrame>;
}

/* ---------------------------------------------------------------- shell */

/** Chooses the network for policies created from now on. Existing policies keep the network they were created with. */
function NetworkSelect({c, disabled, describedBy}: {c: MicroController; disabled: boolean; describedBy?: string}) {
  return <NetworkPicker networks={availableNetworks(c.networks,delegatedNetworks(c.runtimeConfig))} network={c.network} disabled={disabled} describedBy={describedBy} onChange={network => c.setNetwork(network as typeof c.network)} />;
}

/** Saved policy activity stays in Requests, independently of the selected policy. */
function PolicyRequestHistory({c,raise,pending=false}:{c:MicroController;raise:(message:string)=>void;pending?:boolean}){
  const policies=c.policies.filter(policy=>!isTempoNetwork(policy.network)&&!hasDelegatedAuthority(policy)&&!hasNativeAttachment(policy));
  const groups=policies.map(policy=>({policy,requests:mergeRuns(policy.requests??[],c.runs?.policyId===policy.id?c.runs.requests:[])}))
    .map(group=>({...group,requests:pending?group.requests.filter(request=>group.policy.network==='local:dev'&&group.policy.status==='active'&&request.status==='awaiting_input'):group.requests}))
    .filter(group=>group.requests.length>0);
  return groups.length?<div className="stack">{groups.map(({policy,requests})=><article className="owner-card" key={policy.id}>
    <h3 className="owner-question">{policy.title}</h3><p className="small muted">{networkLabel(policy.network,c.networks)}</p>
    {c.selected?.id!==policy.id?<button type="button" className="link-btn small" disabled={!!c.busy} onClick={()=>c.select(policy.id)}>Open policy to use its request controls</button>:null}
    <PolicyRequests c={c} policy={policy} requests={requests} raise={raise} net={networkLabel(policy.network,c.networks)} token={symbol=>tokenName(policy.network,symbol)} when={fmtDateTime} controlsAvailable={c.selected?.id===policy.id}/>
  </article>)}</div>:null;
}

function RequestHistory({c,delegated,raise}:{c:MicroController;delegated:DelegateWorkspace;raise:(message:string)=>void}){
  const native=c.auth.session?c.policies.filter(policy=>!isTempoNetwork(policy.network)&&hasNativeAttachment(policy)):[];
  const listed=c.policies.some(policy=>!isTempoNetwork(policy.network)&&!hasDelegatedAuthority(policy)&&!hasNativeAttachment(policy)&&mergeRuns(policy.requests??[],c.runs?.policyId===policy.id?c.runs.requests:[]).length>0);
  const receipts=delegated.roots.some(root=>root.receipts.length>0)||delegated.closedRequests.length>0;
  const loading=c.loading||!!delegated.owner&&!delegated.loaded&&!delegated.error;
  return <div className="stack">
    {loading?<p className="small muted" role="status">Loading history…</p>:null}
    <DelegateRequestHistory workspace={delegated}/>
    <PolicyRequestHistory c={c} raise={raise}/>
    {native.map(policy=><NativeRequestHistory key={policy.id} policy={policy} session={c.auth.session!}/>)}
    {!listed&&!receipts&&!native.length&&!loading&&!delegated.error&&!delegated.requestError?<p className="small muted">No request history to show.</p>:null}
  </div>;
}

export default function App({earlierLink = false, chain = 'solana'}: {earlierLink?: boolean; chain?: Chain}) {
  const c = useMicro(chain);
  const tempo = chain === 'tempo';
  const stellar = chain === 'stellar';
  const [earlierNotice, setEarlierNotice] = useState(earlierLink);
  const [requestLink,setRequestLink]=useState(()=>readRequestLink(window.location.search));
  const [deploymentLink,setDeploymentLink]=useState(()=>window.location.hash.startsWith(DEPLOYMENT_FRAGMENT)?window.location.hash:null);
  const [stellarOwnerLink,setStellarOwnerLink]=useState(()=>[STELLAR_OWNER_FRAGMENT,STELLAR_APPROVAL_FRAGMENT].some(prefix=>window.location.hash.startsWith(prefix))?window.location.hash:null);
  const [adkOwnerLink,setAdkOwnerLink]=useState(()=>window.location.hash.startsWith(ADK_OWNER_FRAGMENT)&&/^\/(?:allowances\/?)?$/.test(window.location.pathname)?window.location.hash:null);
  const deploymentNetworkSelected=useRef(false);
  useEffect(()=>{
    if(!deploymentLink||deploymentNetworkSelected.current||chain!=='solana'||!c.auth.session)return;
    try{const handoff=parseDeploymentHandoff(deploymentLink);if(c.auth.session.address!==handoff.owner||!['solana','solana:devnet'].includes(c.auth.session.network))return;}catch{deploymentNetworkSelected.current=true;return;}
    if(c.network==='solana:devnet'){deploymentNetworkSelected.current=true;return;}
    if(c.networks.some(network=>network.id==='solana:devnet'))c.setNetwork('solana:devnet');
  },[deploymentLink,chain,c.network,c.networks,c.setNetwork,c.auth.session]);
  const auth = c.auth;
  // Only the server-verified wallet session answers owner requests. Local dev's anonymous owner never signs.
  // Signed owner requests are Solana's; a Tempo owner answers its questions in the policy itself.
  const owner = !tempo && c.network !== 'local:dev' && auth.session && auth.session.network !== 'local:dev' ? auth.session.address : '';
  const tempoWorkspace = useTempoWorkspace(auth.session?.address ?? '', tempo && Boolean(auth.session));
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const signer = useMemo(() => (!stellar && owner ? sessionSigner(owner, () => ownerRef.current) : null), [owner, stellar]);
  const policyTitles = useRef(c.policies);
  policyTitles.current = c.policies;
  const inbox = useOwnerInbox({
    signer,
    available: !tempo && !stellar && !!auth.session,
    // Both owner-decision kinds name a listed policy by ID; the signed envelope's kind is never renamed.
    title: ref => policyTitles.current.find(p => ref.kind === 'native' ? p.nativeExecution?.policyId === ref.policyId : p.id === ref.policyId)?.title,
    onAnswered: () => {
      void c.refresh();
    },
  });
  const [localError, setLocalError] = useState<string | null>(null);
  const raise = useCallback((m: string) => setLocalError(m), []);
  const {pending, run, blocked} = useRun(c, raise);
  const delegated = useDelegateWorkspace(c, raise);
  const localPending=c.policies.filter(policy=>policy.network==='local:dev'&&policy.status==='active').reduce((count,policy)=>count+mergeRuns(policy.requests??[],c.runs?.policyId===policy.id?c.runs.requests:[]).filter(request=>request.status==='awaiting_input').length,0);
  const mainRef = useRef<HTMLElement>(null);
  const [reviewFocusState,setReviewFocusState]=useState<ReviewFocus|null>(null);
  const closeReview=()=>{const url=new URL(window.location.href);for(const key of ['network','owner','policy','request'])url.searchParams.delete(key);window.history.replaceState(null,'',url);setRequestLink(null);setReviewFocusState('closed');};
  const closeDeploymentReview=()=>{const url=new URL(window.location.href);url.hash='';window.history.replaceState(null,'',url);setDeploymentLink(null);setReviewFocusState('closed');};
  const closeStellarOwnerReview=()=>{const url=new URL(window.location.href);url.hash='';window.history.replaceState(null,'',url);setStellarOwnerLink(null);setReviewFocusState('closed');};
  const closeAdkOwnerHandoff=()=>{const url=new URL(window.location.href);url.hash='';url.searchParams.set('chain','stellar');window.history.replaceState(null,'',url);setAdkOwnerLink(null);setReviewFocusState('closed');};
  const loading = c.loading || auth.loading;
  const busy = Boolean(c.busy) || Boolean(auth.busy) || loading;
  const pickerDisabled = busy || blocked;
  const focusWaits=reviewFocusState!==null;
  // Any key or pointer input while focus waits leaves focus to the user.
  useEffect(()=>{
    if(!focusWaits)return;
    const stop=()=>setReviewFocusState(null);
    document.addEventListener('keydown',stop,true);
    document.addEventListener('pointerdown',stop,true);
    return ()=>{
      document.removeEventListener('keydown',stop,true);
      document.removeEventListener('pointerdown',stop,true);
    };
  },[focusWaits]);
  // On the frame after the review dialog has unmounted, so after native close and replacing any drawer return still
  // pending; again when the picker's disabled state changes while focus waits. A picker focus that does not take waits on main.
  useEffect(()=>{
    if(!reviewFocusState)return;
    return returnFocus(()=>{
      const trigger=document.getElementById('network') as HTMLButtonElement|null;
      const main=mainRef.current;
      const onMain=!!main&&document.activeElement===main;
      let step=reviewFocus(reviewFocusState,onMain,!!trigger&&!trigger.disabled);
      if(step.focus==='picker'){
        trigger?.focus();
        if(document.activeElement!==trigger)step=reviewFocus(reviewFocusState,onMain,false);
      }
      if(step.focus==='main')main?.focus();
      if(step.next!==reviewFocusState)setReviewFocusState(step.next);
    });
  },[reviewFocusState,pickerDisabled]);
  const signedIn = Boolean(auth.session);
  // Earlier setups on this device, for the signed-in wallet owner only. Listed policies recover their own.
  const walletOwner = owner;
  // One ID: a listed policy accounts only for setups under its own ID. Anything else stays in earlier-setup recovery.
  const accounted = useMemo(() => new Set(c.policies.map(p => p.id)), [c.policies]);
  const earlier = useLegacySetups(walletOwner, accounted, c.policiesLoaded===true);
  const [view, setView] = useState<{owner: string; mode: 'compose' | 'earlier'; seed?: string} | null>(null);
  const viewNow = view && view.owner === walletOwner ? view : null;
  const mode = viewNow?.mode ?? 'compose';
  const seed = viewNow?.mode === 'compose' ? viewNow.seed : undefined;
  useEffect(() => {if (c.selected) setView(null);}, [c.selected?.id]);
  // A nav close request opens that policy with its cancel confirmation armed; it lapses once another policy is selected.
  const [closing, setClosing] = useState<string | null>(null);
  // Set when the list asked to revoke a policy it knows has a vault.
  const [closingRevoke, setClosingRevoke] = useState(false);
  useEffect(() => {if (closing && c.selected?.id !== closing) setClosing(null);}, [c.selected?.id]);
 useEffect(()=>{if(c.error||auth.error||localError)document.querySelector('.banner-error')?.scrollIntoView({block:'center',behavior:'instant'});},[c.error,auth.error,localError]);

  useEffect(() => {
    if (!c.selected) document.title = 'Allowit';
  }, [c.selected]);

  // The signed-out page shows a quiet status only until the first session check settles, then stays mounted
  // through later loading so the network picker keeps focus and nothing flashes.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (!loading) setBooted(true);
  }, [loading]);

  const errors: Banner[] = [];
  // An earlier Allowit allowance on the same token account: the owner can revoke it here, then approve again.
  const release = c.errorCode === 'ALLOWIT_ALLOWANCE_EXISTS' && c.releaseAllowance ? c.releaseAllowance : null;
  // Older backends return this conflict without a code. It cannot use Allowit's
  // release action: that action only revokes its own pinned delegate.
  const otherAllowance = Boolean(c.error) && (c.errorCode === 'OTHER_DELEGATE_EXISTS' || (!c.errorCode && c.error === 'The matching token account has another delegate allowance. Revoke that allowance before approving this policy.'));
  const allowanceNetwork = c.selected ? networkLabel(c.selected.network, c.networks) : "this policy's network";
  const controllerError = otherAllowance
    ? `An existing USDC allowance on ${allowanceNetwork} blocks approval. Review and revoke it through the app that created it or a token-allowance tool for ${allowanceNetwork}, then try again. Disconnecting your wallet does not revoke it. Revoking it stops the earlier spending permission; tokens stay in your wallet.`
    : c.error;
  if (controllerError) errors.push({key: 'c', text: controllerError, dismiss: c.dismissError, action: release ? {label: 'Revoke earlier allowance', run: () => void release(), disabled: busy} : undefined});
  if (auth.error && auth.error !== c.error) errors.push({key: 'a', text: auth.error, dismiss: auth.dismissError});
  if (localError && !errors.some(e => e.text === localError))
    errors.push({key: 'l', text: localError, dismiss: () => setLocalError(null)});

  const skip = <SkipLink target={mainRef} />;
  const notices = (
    <>
      {earlierNotice ? (
        <div className="banner banner-notice" role="status">
          <Info size={18} aria-hidden="true" />
          <div className="banner-text">This earlier setup link now opens your policies. Nothing was signed or sent.</div>
          <div className="banner-actions">
            <button type="button" className="btn btn-sm" onClick={() => setEarlierNotice(false)}>Dismiss</button>
          </div>
        </div>
      ) : null}
      {/* Always mounted so screen readers announce sign-in and sign-out notices; the hook clears them after a few seconds. */}
      <div className="notice-region" role="status">
        {auth.notice ? (
          <div className="banner banner-notice">
            <Info size={18} aria-hidden="true" />
            <div className="banner-text">{auth.notice}</div>
          </div>
        ) : null}
      </div>
    </>
  );

  if (!signedIn)
    return (
      <OwnerInboxContext.Provider value={inbox}>
        {skip}
        <div className="auth-shell">
          <AuthHeader chain={chain} busy={busy} pickerDisabled={busy} theme={<ThemeSwitch theme={auth.theme} setTheme={auth.setTheme} />} />
          <main id="main" className="auth-main" tabIndex={-1} ref={mainRef} aria-busy={busy || undefined}>
            {notices}
            {loading && !booted ? (
              <div className="auth-boot">
                {errors.length > 0 ? (
                  <div className="auth-errors">
                    <ErrorBanners errors={errors} />
                  </div>
                ) : null}
                <p className="auth-loading muted" role="status">
                  <Spinner />
                  Loading…
                </p>
              </div>
            ) : (
              tempo ? <TempoSignIn busy={busy} errors={errors} onSignedIn={() => auth.refresh()} /> : stellar ? <StellarSignIn busy={busy} errors={errors} network={isStellarNetwork(c.network)?c.network:'stellar:testnet'} onSignedIn={() => auth.refresh()}/> : <SignIn c={c} raise={raise} errors={errors} busy={busy} />
            )}
          </main>
        </div>
      </OwnerInboxContext.Provider>
    );

  return (
    <OwnerInboxContext.Provider value={inbox}>
    <TempoWorkspaceProvider value={tempo ? tempoWorkspace : null}>
      {skip}
      <div className="shell">
        <TopHeader chain={chain} busy={busy} pickerDisabled={pickerDisabled} network={tempo ? <NetworkPicker networks={c.networks} network={c.network} disabled={pickerDisabled} onChange={() => {}} /> : <NetworkSelect c={c} disabled={pickerDisabled} />} aside={<>
              <TopNav current="policies" chain={chain} disabled={pickerDisabled} />
              {tempo || stellar ? null : <>
              <OwnerApprovalInbox inbox={inbox} extension={{
                available:!!auth.session,
                pendingCount:delegatePendingCount(delegated)+localPending,
                pending:<><DelegatePendingRequests workspace={delegated} raise={raise}/><PolicyRequestHistory c={c} raise={raise} pending/></>,
                answeredCount:delegateAnsweredCount(delegated),
                answered:<DelegateAnsweredRequests workspace={delegated}/>,
                history:<RequestHistory c={c} delegated={delegated} raise={raise}/>,
                loading:!!delegated.owner&&!delegated.loaded&&!delegated.error,
                error:delegated.requestError??delegated.error??localError,
              }} />
              </>}
              <ThemeSwitch theme={auth.theme} setTheme={auth.setTheme} />
              {auth.session ? (
                <>
                  <span className="session mono" title={auth.session.address}>
                    {c.network==='local:dev'?'Local workspace':shortAddr(auth.session.address)}
                  </span>
                  <button type="button" className="btn btn-sm btn-quiet" disabled={blocked} onClick={() => run('signout', () => auth.signOut())}>
                    {pending === 'signout' ? <Spinner /> : <LogOut size={14} aria-hidden="true" />}
                    <span className="top-label">{pending === 'signout' ? 'Closing…' : c.network==='local:dev'?'Close workspace':'Sign out'}</span>
                  </button>
                </>
              ) : null}
</>} />
        <div className="workspace-shell with-policies">
        {signedIn?<PolicyNav delegated={delegated} key={c.auth.session?.address||''} c={c} earlier={earlier.records.length} openEarlier={()=>{c.select(null);setView({owner:walletOwner,mode:'earlier'});}} close={(id,revoke)=>{c.select(id);setClosing(id);setClosingRevoke(!!revoke);}} raise={raise}/>:null}
        <main id="main" className="main" tabIndex={-1} ref={mainRef} aria-busy={busy || undefined}>
          <ErrorBanners errors={errors} />
          {notices}
          {tempo && tempoWorkspace.loaded ? <TempoOwnerRecovery workspace={tempoWorkspace} draftIds={accounted} raise={raise} /> : null}
          {!tempo ? <DelegateRecovery workspace={delegated} policies={c.policies} raise={raise}/> : null}
          {c.selected ? <PolicyView key={c.selected.id} c={c} delegated={delegated} policy={c.selected} raise={raise} closeRequested={closing === c.selected.id} closeIsRevoke={closing === c.selected.id && closingRevoke} closeHandled={() => setClosing(null)} />
            : mode === 'earlier' && walletOwner ? <Suspense fallback={<p className="muted" role="status">Loading…</p>}><LegacySetupRecovery key={walletOwner} owner={walletOwner} records={earlier.records} error={earlier.error} journal={earlier.journal} reload={earlier.reload} startDraft={text => {setView({owner: walletOwner, mode: 'compose', seed: text});}} /></Suspense>
            : <Composer key={composerScope(c.network, auth.session, seed)} c={c} raise={raise} seed={seed} />}

        </main>
        </div>
      </div>
      {adkOwnerLink&&auth.session&&stellar?<StellarSigningBoundary onError={raise}><AdkOwnerHandoff c={c} fragment={adkOwnerLink} close={closeAdkOwnerHandoff}/></StellarSigningBoundary>:stellarOwnerLink&&auth.session&&stellar?<StellarSigningBoundary onError={raise}><StellarBrowserReview c={c} fragment={stellarOwnerLink} close={closeStellarOwnerReview}/></StellarSigningBoundary>:deploymentLink&&auth.session&&!tempo&&!stellar?<DeploymentReview c={c} fragment={deploymentLink} close={closeDeploymentReview}/>:requestLink&&auth.session&&!tempo?<RequestReview c={c} link={requestLink} close={closeReview}/>:null}
      {!tempo&&!stellar?<DelegateConflictDialog notice={delegated.allowanceConflict} grants={delegated.grants} workspace={delegated} network={c.policies.find(policy=>policy.id===delegated.allowanceConflict?.policyId)?.network??c.network} busy={busy} dismiss={delegated.dismissAllowanceConflict} completed={()=>{delegated.dismissAllowanceConflict();setLocalError(null);c.dismissError();}} review={grant=>{
        const current=blockingDelegateGrant(delegated.allowanceConflict?.details??null,delegated.grants);
        delegated.dismissAllowanceConflict();setLocalError(null);c.dismissError();
        if(!grant||!current||current.id!==grant.id){c.select(null);setTimeout(()=>document.querySelector<HTMLButtonElement>('.revoke-policies-trigger')?.focus(),0);return;}
        const policy=c.policies.find(p=>p.id===current.policyId&&p.revision===current.revision&&p.delegatedExecution?.grantId===current.id);
        if(policy){c.select(policy.id);setClosing(policy.id);setClosingRevoke(true);}
        else c.select(null);
        setTimeout(()=>{const section=policy?document.querySelector(`article[data-policy-id="${CSS.escape(policy.id)}"] #p-cancel`):document.querySelector('[data-testid="delegate-recovery"]');section?.scrollIntoView({block:'start',behavior:'smooth'});section?.querySelector<HTMLButtonElement>('button')?.focus();},0);
      }}/>:null}


    </TempoWorkspaceProvider>
    </OwnerInboxContext.Provider>
  );
}
