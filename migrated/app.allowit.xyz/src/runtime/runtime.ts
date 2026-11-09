import type {FundingAsset, FundingMode, IngressKind, MicroPolicy, PaymentAsset, PolicyRuntime, ProviderCallRequirement, RuntimeCapabilities, RuntimeSetup, RuntimeSetupEvidence, WalletKind} from '../micro/micro-contracts';
import {u64} from '../paysh/paysh-units';
import {privateLocalnetEnabled} from '../wallet/runtime-network';
import {STELLAR_FUNDING_MODE, isStellarNetwork as stellarNetwork, isStellarPolicy, registryProfileValid, paymentAssetValid, runtimeProfileValid, installationValid, installationReady} from '@allowit/engine/stellar/runtime';
import {stellarProfile} from '@allowit/engine/stellar/stellar-profiles';
export {isStellarPolicy} from '@allowit/engine/stellar/runtime';

/**
 * Typed wallet runtimes. `GET micro/runtime` lists the wallets the server can compile for and the networks each one
 * serves; every policy then carries the runtime fixed at generation. Parsers fail by field name, so a changed reply is
 * never shown as a weaker policy. A policy without `runtime` predates runtimes and keeps the original owner-wallet
 * behavior. Nothing here infers a contract wallet, a network or an asset from a profile name.
 */

export class RuntimeContractError extends Error {}
const fail = (field: string, what = 'is missing or invalid') => new RuntimeContractError(`The runtime field ${field} ${what}.`);
type Json = Record<string, unknown>;
const record = (value: unknown, field: string): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(field);
  return value as Json;
};
const text = (value: unknown, field: string, max = 200): string => {
  if (typeof value !== 'string' || !value || value.length > max) throw fail(field);
  return value;
};
const bool = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') throw fail(field);
  return value;
};
const texts = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > 32) throw fail(field);
  return value.map((v, i) => text(v, `${field}[${i}]`));
};
const optionalText = (value: unknown, field: string, max = 200): string | undefined => (value === undefined || value === null ? undefined : text(value, field, max));
/** Additive fields: an omitted (or null) value keeps the original meaning; any stated value must be one this client knows. */
const absent = (value: unknown) => value === undefined || value === null;

export const WALLET_KINDS: readonly WalletKind[] = ['owner-wallet', 'contract-wallet'];
export const INGRESS_KINDS: readonly IngressKind[] = ['execution-request', 'curl-request'];
export const FUNDING_MODES: readonly FundingMode[] = ['authorization', 'deposit', 'spl-delegate', STELLAR_FUNDING_MODE];
export const DELEGATED_PROFILE = 'solana-spl-delegate-x402-v1';
/** Fresh public policies keep autonomous, policy-checked delegation on both supported clusters. */
export const requiresDelegatedWallet=(network:string)=>network==='solana:devnet'||network==='solana:mainnet';
/** Temporary consumer choice: keep contract code and signed-proof recovery, pause new public-network setups. */
export const contractSetupPaused=requiresDelegatedWallet;
/** New Devnet policies fund a native vault whose executor is the owner's agent's own key. */
export const NATIVE_VAULT_PROFILE='solana-owner-signed';
/** Native vault setup is deployed on Devnet only. */
export const nativeSetupPaused=(network:string)=>network!=='solana:devnet';
/** An authority marker is retained even when its runtime/binding is malformed. It must never become a legacy allowance. */
export function hasDelegatedAuthority(policy: Pick<MicroPolicy, 'runtime'> & Partial<Pick<MicroPolicy,'delegatedExecution'>>) {
  return policy.delegatedExecution !== undefined || policy.runtime?.fundingMode === 'spl-delegate' || policy.runtime?.wallet?.profile === DELEGATED_PROFILE;
}
export const delegatedNetworks = (config: RuntimeConfig | null | 'unavailable') => config && config !== 'unavailable'
  ? config.wallets.filter(w => w.kind === 'owner-wallet' && w.profile === DELEGATED_PROFILE && w.capabilities.generate && w.capabilities.fund).flatMap(w => w.networks) : [];
const CAPABILITY_KEYS = ['providerCall', 'fund', 'withdraw', 'revoke', 'revise', 'fork', 'rename'] as const satisfies readonly (keyof RuntimeCapabilities)[];
export type RuntimeAction = (typeof CAPABILITY_KEYS)[number] | 'discard';

function walletKind(value: unknown, field: string): WalletKind {
  if (!WALLET_KINDS.includes(value as WalletKind)) throw fail(field, 'is not a supported wallet kind');
  return value as WalletKind;
}
function ingressKind(value: unknown, field: string): IngressKind {
  if (!INGRESS_KINDS.includes(value as IngressKind)) throw fail(field, 'is not a supported request kind');
  return value as IngressKind;
}
/** The admitted request kinds: each known, none repeated. An empty list admits none. */
function typedIngress(value: unknown, field: string): IngressKind[] | undefined {
  if (absent(value)) return undefined;
  if (!Array.isArray(value) || value.length > INGRESS_KINDS.length) throw fail(field);
  const kinds = value.map((v, i) => ingressKind(v, `${field}[${i}]`));
  if (new Set(kinds).size !== kinds.length) throw fail(field, 'repeats a request kind');
  return kinds;
}
function capabilities(value: unknown, field: string): RuntimeCapabilities {
  const c = record(value, field);
  const admitted = typedIngress(c.typedIngress, `${field}.typedIngress`);
  return {...Object.fromEntries(CAPABILITY_KEYS.map(k => [k, bool(c[k], `${field}.${k}`)])), discard: c.discard === undefined ? false : bool(c.discard, `${field}.discard`), ...(admitted ? {typedIngress: admitted} : {})} as unknown as RuntimeCapabilities;
}

/* ------------------------------------------------------------------ registry */

export interface OperationService {id: string; name?: string}
/**
 * A registered function the policy checks requests with. `ingressKind` and `requiresService` are stated by the server or
 * absent; an entry without them is a provider call that needs a registered service, as before.
 */
export interface RuntimeOperation {function: string; services: OperationService[]; inputSchema: unknown; settlement: string; delivery: string; ingressKind?: IngressKind; requiresService?: boolean}
export interface RuntimeWallet {
  kind: WalletKind;
  profile: string;
  sourceProfiles: string[];
  operations: string[];
  capabilities: RuntimeCapabilities & {generate: boolean};
  /** Networks the wallet serves, as the server states them. */
  networks: string[];
}
/** Hosted contract wallets serve Testnet; private-validator acceptance is explicitly gated in development. */
export const WALLET_NETWORKS: Record<WalletKind, readonly string[]> = {
  'owner-wallet': ['solana:mainnet', 'solana:testnet', 'solana:devnet', ...(privateLocalnetEnabled ? ['solana:localnet'] : [])],
  'contract-wallet': ['solana:testnet', ...(privateLocalnetEnabled ? ['solana:localnet'] : [])],
};
export interface RuntimeFeatures {policyWhitelist: boolean}
export interface RuntimeConfig {wallets: RuntimeWallet[]; operations: RuntimeOperation[]; features: RuntimeFeatures}
/** Only the local development fixture may omit the registry. Hosted builds always require it. */
export const localLegacyRuntime = (development: boolean, hostname: string) => development && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

function service(value: unknown, field: string): OperationService {
  if (typeof value === 'string') return {id: text(value, field)};
  const s = record(value, field);
  const name = optionalText(s.name, `${field}.name`);
  return {id: text(s.id, `${field}.id`), ...(name ? {name} : {})};
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const r = record(value, 'runtime');
  const f = absent(r.features) ? null : record(r.features, 'features');
  // Capabilities are opt-in. An older server omits `features` and must never receive a newer mutation by accident.
  const features: RuntimeFeatures = {policyWhitelist: absent(f?.policyWhitelist) ? false : bool(f?.policyWhitelist, 'features.policyWhitelist')};
  if (!Array.isArray(r.wallets) || r.wallets.length > 16) throw fail('wallets');
  if (!Array.isArray(r.operations) || r.operations.length > 64) throw fail('operations');
  const fns = new Set<string>();
  const operations = r.operations.map((v, i): RuntimeOperation => {
    const o = record(v, `operations[${i}]`);
    if (!Array.isArray(o.services) || o.services.length > 256) throw fail(`operations[${i}].services`);
    const op: RuntimeOperation = {
      function: text(o.function, `operations[${i}].function`),
      services: o.services.map((s, j) => service(s, `operations[${i}].services[${j}]`)),
      inputSchema: o.inputSchema ?? null,
      settlement: text(o.settlement, `operations[${i}].settlement`),
      delivery: text(o.delivery, `operations[${i}].delivery`),
    };
    if (fns.has(op.function)) throw fail(`operations[${i}].function`, 'repeats a registered function');
    fns.add(op.function);
    if (!absent(o.ingressKind)) op.ingressKind = ingressKind(o.ingressKind, `operations[${i}].ingressKind`);
    if (!absent(o.requiresService)) op.requiresService = bool(o.requiresService, `operations[${i}].requiresService`);
    // The kind and the service rule must agree: a native request has no service, an HTTP request needs one. Only an
    // explicit native request may go without a service.
    if (op.ingressKind === 'execution-request' && op.requiresService !== false) throw fail(`operations[${i}].requiresService`, 'is not false for a native request');
    if (op.ingressKind === 'curl-request' && op.requiresService === false) throw fail(`operations[${i}].requiresService`, 'is false for an HTTP request');
    if (op.requiresService === false && op.ingressKind !== 'execution-request') throw fail(`operations[${i}].requiresService`, 'is false without a native request kind');
    if (op.requiresService === false && op.services.length) throw fail(`operations[${i}].services`, 'lists a service for a request that uses none');
    return op;
  });
  const seen = new Set<string>();
  const wallets = r.wallets.map((v, i): RuntimeWallet => {
    const w = record(v, `wallets[${i}]`);
    const kind = walletKind(w.kind, `wallets[${i}].kind`);
    const profile = text(w.profile, `wallets[${i}].profile`);
    if (seen.has(`${kind}|${profile}`)) throw fail(`wallets[${i}]`, 'repeats a wallet');
    seen.add(`${kind}|${profile}`);
    const c = record(w.capabilities, `wallets[${i}].capabilities`);
    const sourceProfiles = texts(w.sourceProfiles, `wallets[${i}].sourceProfiles`);
    if (!sourceProfiles.length) throw fail(`wallets[${i}].sourceProfiles`, 'is empty');
    const ops = texts(w.operations, `wallets[${i}].operations`);
    if (new Set(ops).size !== ops.length) throw fail(`wallets[${i}].operations`, 'repeats a function');
    for (const op of ops) if (!operations.some(o => o.function === op)) throw fail(`wallets[${i}].operations`, `names an unregistered function ${op}`);
    const caps = {...capabilities(c, `wallets[${i}].capabilities`), generate: bool(c.generate, `wallets[${i}].capabilities.generate`)};
    // A provider call is only a capability of a wallet that registers an operation able to make one.
    // The owner wallet has no verifier-compatible provider call: it never claims one.
    if(!registryProfileValid(profile, kind, sourceProfiles, ops))throw fail(`wallets[${i}]`,'does not match its Stellar custody profile');
    if (kind === 'owner-wallet' && caps.providerCall) throw fail(`wallets[${i}].capabilities.providerCall`, 'is not supported by the owner wallet');
    if (caps.providerCall && !ops.length) throw fail(`wallets[${i}].capabilities.providerCall`, 'has no registered operation');
    for (const fn of ops) {
      const op = operations.find(o => o.function === fn)!;
      // The owner wallet registers only operations with an explicit request kind. Any stated kind must be admitted by
      // the wallet's own list; nothing is admitted by name or by the provider-call flag.
      if (kind === 'owner-wallet' && !op.ingressKind) throw fail(`wallets[${i}].operations`, `names ${fn}, which states no request kind the owner wallet supports`);
      if (op.ingressKind && !caps.typedIngress?.includes(op.ingressKind)) throw fail(`wallets[${i}].capabilities.typedIngress`, `does not admit ${op.ingressKind} for ${fn}`);
    }
    const networks = texts(w.networks, `wallets[${i}].networks`);
    if (!networks.length) throw fail(`wallets[${i}].networks`, 'is empty');
    for (const n of networks) if (!(stellarProfile(profile) ? stellarNetwork(n) : WALLET_NETWORKS[kind].includes(n))) throw fail(`wallets[${i}].networks`, `names ${n}, which this wallet kind does not serve`);
    return {kind, profile, sourceProfiles, operations: ops, capabilities: caps, networks};
  });
  return {wallets, operations, features};
}

/** Networks a wallet serves: only the server's own list. */
export const walletServes = (wallet: RuntimeWallet, network: string) => wallet.networks.includes(network);
export const CONTRACT_PROFILE = 'solana-paysh-v1';
/**
 * The per-policy service allowlist profile. A v2 policy names 1 to 8 exact registered services, each chosen by the owner;
 * the v1 profile keeps its single service. The two never share a request shape.
 */
export const ALLOWLIST_PROFILE = 'solana-paysh-v2';
export const MAX_ALLOWLIST = 8;
/**
 * A whitelist compiled into the policy source (the policy page's editor), not the contract wallet's on-chain allowlist.
 * The server compiles up to 32 entries; the on-chain allowlist stays at MAX_ALLOWLIST because the PaySH program caps its
 * membership proof depth.
 */
export const MAX_SOURCE_WHITELIST = 32;
export const allowlistWallet = (wallet: Pick<RuntimeWallet, 'profile'>) => wallet.profile === ALLOWLIST_PROFILE;

/**
 * What the Composer sends. Changing it after generation starts a new draft. `serviceId` is absent only for an operation
 * whose registry entry states `requiresService: false`; an allowlist wallet sends `serviceIds` instead, never both.
 */
export interface RuntimeChoice {sourceProfile: string; wallet: {kind: WalletKind; profile: string}; operation?: {function: string; serviceId?: string; serviceIds?: string[]}}

/** Whether a registered operation needs a service. Only an explicit `false` waives it. */
export const needsService = (op: Pick<RuntimeOperation, 'requiresService'>) => op.requiresService !== false;
/**
 * Whether a new policy for this wallet must name one of its operations: a provider wallet always, and any wallet that
 * states its admitted request kinds and registers operations. An ordinary owner wallet with none needs no request.
 */
export const requestRequired = (wallet: RuntimeWallet) => wallet.capabilities.providerCall || (wallet.capabilities.typedIngress !== undefined && wallet.operations.length > 0);
/** The wallet's registered operations, in the server's order. Empty when the wallet needs no request. */
export function walletOperations(config: RuntimeConfig, wallet: RuntimeWallet): RuntimeOperation[] {
  if (!requestRequired(wallet)) return [];
  return wallet.operations.map(fn => config.operations.find(o => o.function === fn)).filter((o): o is RuntimeOperation => !!o);
}
/** An operation a new policy can use: it needs no service, or the registry lists at least one. */
export const operationUsable = (op: RuntimeOperation) => !needsService(op) || op.services.length > 0;
/** Whether the wallet can be offered for a new policy at all: it needs no request, or one of its operations is usable. */
export const walletUsable = (config: RuntimeConfig, wallet: RuntimeWallet) => !requestRequired(wallet) || walletOperations(config, wallet).some(operationUsable);

/** The owner's explicit picks. Empty strings and an empty list are unchosen. */
export interface RuntimePicks {fn: string; serviceId: string; serviceIds: string[]; sourceProfile: string}
export const NO_PICKS: RuntimePicks = {fn: '', serviceId: '', serviceIds: [], sourceProfile: ''};

/**
 * What the registry leaves to the owner, resolved from the owner's picks. A single option is a stated fact; with several
 * nothing is preselected from the registry order.
 */
export function resolvePicks(config: RuntimeConfig, wallet: RuntimeWallet, picks: RuntimePicks) {
  const operations = walletOperations(config, wallet);
  const operation = operations.length === 1 ? operations[0] : operations.find(o => o.function === picks.fn) ?? null;
  const services = operation && needsService(operation) ? operation.services : [];
  const allowlist = allowlistWallet(wallet);
  // An allowlist is never preselected, even with one registered service: every entry is the owner's own pick.
  const serviceId = allowlist ? '' : services.length === 1 ? services[0].id : services.some(s => s.id === picks.serviceId) ? picks.serviceId : '';
  const serviceIds = allowlist ? services.filter(s => picks.serviceIds.includes(s.id)).map(s => s.id) : [];
  const sourceProfile = wallet.sourceProfiles.length === 1 ? wallet.sourceProfiles[0] : wallet.sourceProfiles.includes(picks.sourceProfile) ? picks.sourceProfile : '';
  return {operations, operation, services, allowlist, serviceId, serviceIds, sourceProfile};
}

/**
 * A choice is complete only with every value the registry leaves open chosen by the owner: the request, its service when
 * it needs one, and the policy runtime. Nothing is filled in from the registry order. Returns null while a choice is missing.
 */
export function explicitChoice(config: RuntimeConfig, wallet: RuntimeWallet, picks: RuntimePicks): RuntimeChoice | null {
  const r = resolvePicks(config, wallet, picks);
  if (!r.sourceProfile) return null;
  const base = {sourceProfile: r.sourceProfile, wallet: {kind: wallet.kind, profile: wallet.profile}};
  if (!requestRequired(wallet)) return base;
  if (!r.operation) return null;
  if (!needsService(r.operation)) return {...base, operation: {function: r.operation.function}};
  if (r.allowlist) return r.serviceIds.length && r.serviceIds.length <= MAX_ALLOWLIST ? {...base, operation: {function: r.operation.function, serviceIds: r.serviceIds}} : null;
  if (!r.serviceId) return null;
  return {...base, operation: {function: r.operation.function, serviceId: r.serviceId}};
}

// Allowit no longer creates delegated allowances: Devnet funds a native vault, and Mainnet waits for a vault deployment.
const newWalletAllowed=(wallet:Pick<RuntimeWallet,'kind'|'profile'>,network:string)=>network==='solana:devnet'?wallet.kind==='owner-wallet'&&wallet.profile===NATIVE_VAULT_PROFILE:!requiresDelegatedWallet(network)||(wallet.kind==='owner-wallet'&&wallet.profile===DELEGATED_PROFILE);
/** Wallets the owner may pick for this network. Saved policies keep their original runtime. */
export function walletChoices(config: RuntimeConfig | null | 'unavailable', network: string): RuntimeWallet[] {
  if (!config || config === 'unavailable') return [];
  return config.wallets.filter(w => w.capabilities.generate && walletServes(w, network) && newWalletAllowed(w,network)).sort((a, b) => WALLET_KINDS.indexOf(a.kind) - WALLET_KINDS.indexOf(b.kind) || Number(b.profile===DELEGATED_PROFILE)-Number(a.profile===DELEGATED_PROFILE));
}

/** The explicit generate body. No prompt parsing: the wallet, profile and service are the owner's own choices. */
export function generateBody(network: string, prompt: string, choice?: RuntimeChoice) {
  const o = choice?.operation;
  const operation = o ? {function: o.function, ...(o.serviceIds ? {serviceIds: [...o.serviceIds]} : o.serviceId === undefined ? {} : {serviceId: o.serviceId})} : null;
  return choice ? {network, prompt, runtime: {sourceProfile: choice.sourceProfile, wallet: {kind: choice.wallet.kind, profile: choice.wallet.profile}}, ...(operation ? {operation} : {})} : {prompt, network};
}

/** Checks a choice against the registry before it is sent: an unregistered effect never reaches generation. */
export function checkedChoice(config: RuntimeConfig, network: string, choice: RuntimeChoice): RuntimeChoice {
  if(contractSetupPaused(network)&&choice.wallet.kind==='contract-wallet')throw new RuntimeContractError('Contract wallet is not available while setup is temporarily paused. Choose an owner wallet.');
  const wallet = config.wallets.find(w => w.kind === choice.wallet.kind && w.profile === choice.wallet.profile);
  if (!wallet || !wallet.capabilities.generate || !walletServes(wallet, network) || !newWalletAllowed(wallet,network)) throw new RuntimeContractError('This wallet is not available for new policies on this network.');
  if (!wallet.sourceProfiles.includes(choice.sourceProfile)) throw new RuntimeContractError('This wallet does not support the selected policy runtime.');
  if (choice.operation) {
    const op = walletOperations(config, wallet).find(o => o.function === choice.operation!.function);
    if (!op) throw new RuntimeContractError('This wallet does not support the selected operation.');
    if (op.ingressKind && !wallet.capabilities.typedIngress?.includes(op.ingressKind)) throw new RuntimeContractError('This wallet does not admit the selected request.');
    const {serviceId, serviceIds} = choice.operation;
    if (!needsService(op)) {
      if (serviceId !== undefined || serviceIds !== undefined) throw new RuntimeContractError('The selected request uses no service.');
    } else if (allowlistWallet(wallet)) {
      if (serviceId !== undefined || !Array.isArray(serviceIds) || !serviceIds.length) throw new RuntimeContractError('Choose at least one service this policy may pay.');
      if (serviceIds.length > MAX_ALLOWLIST) throw new RuntimeContractError(`Choose at most ${MAX_ALLOWLIST} services.`);
      if (new Set(serviceIds).size !== serviceIds.length) throw new RuntimeContractError('A service is listed twice.');
      if (!serviceIds.every(id => op.services.some(s => s.id === id))) throw new RuntimeContractError('A selected service is not registered for this operation.');
    } else if (serviceIds !== undefined) {
      throw new RuntimeContractError('This wallet pays one service; it takes no service list.');
    } else if (serviceId === undefined || !op.services.some(s => s.id === serviceId)) {
      throw new RuntimeContractError('The selected service is not registered for this operation.');
    }
  } else if (requestRequired(wallet)) {
    const ops = walletOperations(config, wallet);
    throw new RuntimeContractError(ops.length === 1 && needsService(ops[0]) ? 'Choose the service this policy pays for.' : 'Choose the request this policy checks.');
  }
  return choice;
}

/**
 * The allowlist a v2 policy was compiled with: one compiled requirement per service, in the policy's order. Null for any
 * other policy, so a v1 policy keeps its single-service view.
 */
export function policyAllowlist(policy: Pick<MicroPolicy, 'runtime' | 'network'>): ProviderCallRequirement[] | null {
  const r = runtimeOf(policy);
  return r.state === 'typed' && allowlistWallet(r.runtime.wallet) ? r.runtime.providerCallRequirements ?? [] : null;
}

/**
 * Checks a generated draft against the allowlist the owner sent. The draft must keep the requested wallet and operation
 * and compile exactly the requested services, each keyed by its own ID: a missing, added or substituted service is
 * refused. A choice without an allowlist passes unchanged.
 */
export function checkGeneratedAllowlist(choice: RuntimeChoice, policy: Pick<MicroPolicy, 'runtime' | 'network'> | undefined): void {
  const requested = choice.operation?.serviceIds;
  if (!requested) return;
  const refuse = (what: string) => new RuntimeContractError(`The generated draft ${what}, so it was not opened. Do not fund it; start a new draft.`);
  if (!policy) throw refuse('was not returned');
  const r = runtimeOf(policy);
  if (r.state !== 'typed') throw refuse('has no readable wallet runtime');
  const {wallet, operation} = r.runtime;
  if (wallet.kind !== choice.wallet.kind || wallet.profile !== choice.wallet.profile) throw refuse('uses another wallet');
  if (operation !== choice.operation!.function) throw refuse('checks another request');
  const compiled = r.runtime.providerCallRequirements ?? [];
  const ids = compiled.map(q => q.service_id);
  if (compiled.some(q => q.input_key !== q.service_id)) throw refuse('keys a service by another input');
  if (ids.length !== requested.length || new Set(ids).size !== ids.length || !requested.every(id => ids.includes(id))) throw refuse('lists services other than the ones you chose');
}

/* ------------------------------------------------------------------ policy runtime */

function fundingAsset(value: unknown, field: string): FundingAsset {
  const a = record(value, field);
  const decimals = a.decimals;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw fail(`${field}.decimals`);
  return {network: text(a.network, `${field}.network`, 64), symbol: text(a.symbol, `${field}.symbol`, 40), decimals};
}
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Payment and receipt amounts are six-decimal units of this configured mint. */
export const PAYMENT_DECIMALS = 6;
function paymentAsset(value: unknown, field: string): PaymentAsset {
  const a = fundingAsset(value, field);
  if (a.decimals !== PAYMENT_DECIMALS) throw fail(`${field}.decimals`, `is not ${PAYMENT_DECIMALS}`);
  const mint = (value as Json).mint;
  // An empty mint states that the network's test token is not configured: drafts stay readable, funding stays off.
  if (typeof mint !== 'string' || (mint !== '' && !BASE58.test(mint))) throw fail(`${field}.mint`, 'is not a configured mint address');
  return {...a, mint};
}
function setup(value: unknown, field: string): RuntimeSetup | null {
  if (value === undefined || value === null) return null;
  const s = record(value, field);
  const out: RuntimeSetup = {};
  for (const k of ['status', 'requestId', 'signature', 'policyAccount', 'expiresAt'] as const) {
    const v = optionalText(s[k], `${field}.${k}`, 200);
    if (v) out[k] = v;
  }
  if (out.status === undefined && typeof s.phase === 'string') out.status = text(s.phase, `${field}.phase`);
  if (s.state !== undefined && s.state !== null) {
    const e = record(s.state, `${field}.state`), p = record(e.policy, `${field}.state.policy`);
    const chain = e.chain === undefined || e.chain === null ? null : record(e.chain, `${field}.state.chain`);
    out.state = {status: text(e.status, `${field}.state.status`), signature: e.signature === null || e.signature === undefined ? null : text(e.signature, `${field}.state.signature`),
      policy: {id:text(p.id, `${field}.state.policy.id`), owner:text(p.owner, `${field}.state.policy.owner`), policyAddress:text(p.policyAddress, `${field}.state.policy.policyAddress`), network:text(p.network, `${field}.state.policy.network`)},
      chain: chain ? {initialized:bool(chain.initialized, `${field}.state.chain.initialized`), policyAddress:text(chain.policyAddress, `${field}.state.chain.policyAddress`), owner:text(chain.owner, `${field}.state.chain.owner`), solVault:text(chain.solVault, `${field}.state.chain.solVault`), ...(chain.finalizedSlot === undefined ? {} : {finalizedSlot:u64(chain.finalizedSlot, `${field}.state.chain.finalizedSlot`)})} : null};
  }
  return out;
}

export function parsePolicyRuntime(value: unknown, network: string): PolicyRuntime {
  const r = record(value, 'runtime');
  const w = record(r.wallet, 'runtime.wallet');
  const stellar = stellarProfile(w.profile) && stellarNetwork(network);
  const stellarPayment = stellar ? fundingAsset(r.paymentAsset,'runtime.paymentAsset') : null;
  if(stellarPayment && (!paymentAssetValid(stellarPayment, (r.paymentAsset as Json).mint))) throw fail('runtime.paymentAsset');
  const runtime: PolicyRuntime = {
    sourceProfile: text(r.sourceProfile, 'runtime.sourceProfile'),
    wallet: {kind: walletKind(w.kind, 'runtime.wallet.kind'), profile: text(w.profile, 'runtime.wallet.profile')},
    capabilities: capabilities(r.capabilities, 'runtime.capabilities'),
    fundingAsset: fundingAsset(r.fundingAsset, 'runtime.fundingAsset'),
    paymentAsset: stellarPayment ? {...stellarPayment,mint:(r.paymentAsset as Json).mint as string} : paymentAsset(r.paymentAsset, 'runtime.paymentAsset'),
    operation: r.operation === undefined || r.operation === null ? null : text(r.operation, 'runtime.operation'),
    setup: stellar ? {status: typeof (r.setup as Json)?.state==='object' ? ((r.setup as Json).state as Json)?.status as string : undefined} : setup(r.setup, 'runtime.setup'),
  };
  if (!absent(r.fundingMode)) {
    if (!FUNDING_MODES.includes(r.fundingMode as FundingMode)) throw fail('runtime.fundingMode', 'is not a supported funding mode');
    runtime.fundingMode = r.fundingMode as FundingMode;
  }
  if (runtime.fundingAsset.network !== network) throw fail('runtime.fundingAsset.network', 'differs from the policy network');
  if (runtime.paymentAsset.network !== network) throw fail('runtime.paymentAsset.network', 'differs from the policy network');
  // Only an owner-wallet policy can exist before its token is configured; any other wallet pays in that token.
  if (!runtime.paymentAsset.mint && runtime.wallet.kind !== 'owner-wallet') throw fail('runtime.paymentAsset.mint', 'is not a configured mint address');
  if (r.providerCallRequirements !== undefined) {
    if (!Array.isArray(r.providerCallRequirements) || r.providerCallRequirements.length > 32) throw fail('runtime.providerCallRequirements');
    runtime.providerCallRequirements = r.providerCallRequirements.map((value, i): ProviderCallRequirement => {
      const field = `runtime.providerCallRequirements[${i}]`, q = record(value, field);
      const units = (key: string) => {
        try {return u64(q[key], `${field}.${key}`);} catch {throw fail(`${field}.${key}`);}
      };
      const requirement = {operation: text(q.operation, `${field}.operation`), payment_asset_id: text(q.payment_asset_id, `${field}.payment_asset_id`), service_id: text(q.service_id, `${field}.service_id`), input_key: text(q.input_key, `${field}.input_key`, 512), max_payment_units: units('max_payment_units'), max_swap_lamports: units(q.operation==='allowit::service_call'?'max_rail_debit_units':'max_swap_lamports'), max_service_fee_lamports_per_execution: units(q.operation==='allowit::service_call'?'max_service_fee_units':'max_service_fee_lamports_per_execution')};
      if (requirement.operation !== runtime.operation || requirement.payment_asset_id !== runtime.paymentAsset.mint) throw fail(field, 'differs from the registered operation or payment mint');
      return requirement;
    });
  }
  if (runtime.wallet.kind === 'contract-wallet' && !(stellar ? stellarNetwork(network) : WALLET_NETWORKS['contract-wallet'].includes(network))) throw fail('runtime.wallet.kind', `does not serve ${network}`);
  // Budget authorization is an owner-wallet mode and a deposit is a contract-wallet mode; the other pairing is unreadable.
  if (runtime.fundingMode === 'authorization' && runtime.wallet.kind !== 'owner-wallet') throw fail('runtime.fundingMode', 'is authorization for a wallet other than the owner wallet');
  if (runtime.fundingMode === 'deposit' && runtime.wallet.kind !== 'contract-wallet') throw fail('runtime.fundingMode', 'is deposit for a wallet other than the contract wallet');
  if ((runtime.fundingMode===STELLAR_FUNDING_MODE) !== stellar) throw fail('runtime.fundingMode','does not match the Stellar installation');
  if(stellar){
    if(!runtimeProfileValid(runtime)) throw fail('runtime','does not match the admitted Stellar transfer');
    if(!absent(r.authorization)){const a=record(r.authorization,'runtime.authorization');if(!installationValid(a, runtime.wallet.profile, network))throw fail('runtime.authorization');runtime.authorization=a;runtime.stellarInstallation=a as unknown as NonNullable<PolicyRuntime['stellarInstallation']>;}
  }
  if ((runtime.fundingMode === 'spl-delegate') !== (runtime.wallet.profile === DELEGATED_PROFILE)
    || (runtime.fundingMode === 'spl-delegate' && (runtime.wallet.kind !== 'owner-wallet' || runtime.operation !== null || runtime.paymentAsset.symbol !== 'USDC' || runtime.paymentAsset.decimals !== 6 || !runtime.paymentAsset.mint))) throw fail('runtime.fundingMode', 'does not match the delegated owner-wallet profile');
  if (runtime.wallet.kind === 'owner-wallet') {
    // An owner-wallet policy never makes a provider call. It names an operation only when it states the request kinds it
    // admits; an ordinary owner-wallet policy has neither. A budget authorization states its list explicitly and may admit
    // none yet: the operation is then committed to, not offered for execution.
    if (runtime.capabilities.providerCall) throw fail('runtime.capabilities.providerCall', 'is not supported by the owner wallet');
    const admitted = runtime.capabilities.typedIngress;
    if (runtime.operation !== null && (admitted === undefined || (!admitted.length && runtime.fundingMode !== 'authorization'))) throw fail('runtime.operation', 'is not supported by the owner wallet without an admitted request kind');
  } else if (runtime.capabilities.providerCall && runtime.operation === null) {
    throw fail('runtime.operation', 'is missing for a provider wallet');
  }
  return runtime;
}

/** The original semantics of a policy without a runtime: owner wallet, allowance funding, owner-signed transfers. */
export const LEGACY_CAPABILITIES: RuntimeCapabilities = {providerCall: false, fund: true, withdraw: false, revoke: true, revise: true, fork: true, rename: true};
const NONE: RuntimeCapabilities = {providerCall: false, fund: false, withdraw: false, revoke: false, revise: false, fork: false, rename: false};

export type ResolvedRuntime =
  | {state: 'legacy'; kind: 'owner-wallet'; capabilities: RuntimeCapabilities}
  | {state: 'typed'; kind: WalletKind; capabilities: RuntimeCapabilities; runtime: PolicyRuntime}
  /** Present but unreadable: every action is unavailable, and the wallet kind is not guessed. */
  | {state: 'invalid'; kind: null; capabilities: RuntimeCapabilities; error: string};

/** Parsed on every read, so capabilities always come from the current value; nothing is cached by object identity. */
export function runtimeOf(policy: Pick<MicroPolicy, 'runtime'> & {network: string}): ResolvedRuntime {
  const raw = policy.runtime;
  if (hasDelegatedAuthority(policy) && (!raw || raw.fundingMode !== 'spl-delegate' || raw.wallet?.profile !== DELEGATED_PROFILE)) return {state:'invalid',kind:null,capabilities:NONE,error:'The retained delegated authority does not match this policy runtime. Review its original grant before changing it.'};
  if (raw === undefined || raw === null) return {state: 'legacy', kind: 'owner-wallet', capabilities: LEGACY_CAPABILITIES};
  try {
    const runtime = parsePolicyRuntime(raw, policy.network);
    return {state: 'typed', kind: runtime.wallet.kind, capabilities: runtime.capabilities, runtime};
  } catch (e) {
    return {state: 'invalid', kind: null, capabilities: NONE, error: e instanceof Error ? e.message : 'The runtime is unreadable.'};
  }
}

export const supports = (policy: Pick<MicroPolicy, 'runtime' | 'network'>, action: RuntimeAction) => runtimeOf(policy).capabilities[action] === true;
/**
 * How the policy is funded: `allowance` for a legacy or ordinary owner-wallet policy, `deposit` for a contract wallet,
 * `authorization` only when the runtime states it. Null for an unreadable runtime.
 */
export type FundingPath = 'allowance' | FundingMode;
export function fundingPath(policy: Pick<MicroPolicy, 'runtime' | 'network'>): FundingPath | null {
  const r = runtimeOf(policy);
  if (r.state === 'legacy') return 'allowance';
  if (r.state === 'invalid') return null;
  return r.runtime.fundingMode ?? (r.kind === 'contract-wallet' ? 'deposit' : 'allowance');
}
export const isAuthorization = (policy: Pick<MicroPolicy, 'runtime' | 'network'>) => fundingPath(policy) === 'authorization';
export const isContractWallet = (policy: Pick<MicroPolicy, 'runtime' | 'network'>) => runtimeOf(policy).kind === 'contract-wallet';
/** The owner wallet, legacy or typed, whatever its funding mode. */
export const isOwnerWallet = (policy: Pick<MicroPolicy, 'runtime' | 'network'>) => runtimeOf(policy).kind === 'owner-wallet';
/**
 * Allowance approval, revocation and new owner-signed transfers run only on the allowance path. A budget authorization
 * never falls back to them.
 */
export const isAllowanceWallet = (policy: Pick<MicroPolicy, 'runtime' | 'network'>) => isOwnerWallet(policy) && fundingPath(policy) === 'allowance';

/**
 * Identity of every input a budget authorization check reads: the owner and the policy's code, hashes, intent, network,
 * runtime and typed metadata. A result computed for one key is never used for another.
 */
export function authorizationKey(policy: Partial<MicroPolicy>, owner: string): string {
  return JSON.stringify([owner, policy.id, policy.revision, policy.status, policy.code, policy.sourceHash, policy.irHash, policy.originalIntent ?? null, policy.network, policy.runtime ?? null, policy.typedBudgetRequirements ?? null, policy.assetMetadata ?? null, policy.registryVersion ?? null, policy.typeDeclarations ?? null, policy.typedWorkflowRequirements ?? null, policy.calls ?? null, policy.functionHelp ?? null]);
}
/** A browser-verified authorization result for exactly this policy and owner, before its deadline. */
export interface VerifiedAuthorizationView {phase: 'verified'; key: string; facts: {expiresAt: number}}
const verifiedFor = (view: unknown, policy: Partial<MicroPolicy>, owner: string) => {
  const v = view as Partial<VerifiedAuthorizationView> | null;
  return !!v && v.phase === 'verified' && !!owner && v.key === authorizationKey(policy, owner) && typeof v.facts?.expiresAt === 'number' && v.facts.expiresAt > Date.now();
};

/**
 * Whether the agent skill may be requested. An owner-wallet policy keeps its original rule. A contract-wallet policy
 * needs its setup finalized: checked in this browser against the saved proof and binding, or reported by the server's
 * setup state with its signature and policy account. An active status or an allocation alone is not finality.
 */
export function handoffReady(policy: Pick<MicroPolicy, 'runtime' | 'network' | 'status'> & Partial<MicroPolicy>, view: {phase: string; state?: RuntimeSetupEvidence} | null, owner = ''): boolean {
  const r = runtimeOf(policy);
  if (hasDelegatedAuthority(policy)) return false;
  if(isStellarPolicy(policy))return r.state==='typed'&&installationReady(policy,r.runtime.stellarInstallation,owner);
  // A budget authorization is ready only with a browser-verified, current, retained proof for this exact policy and
  // owner. An active status alone does not show a current authorization.
  if (r.state === 'typed' && r.runtime.fundingMode === 'authorization') return policy.status === 'active' && verifiedFor(view, policy, owner);
  if (r.state === 'legacy' || r.kind === 'owner-wallet') return policy.status === 'active';
  if (r.state !== 'typed' || policy.status !== 'active') return false;
  const s = view?.phase === 'finalized' ? view.state : r.runtime.setup?.state;
  if (!s || s.status !== 'finalized' || !s.signature || !s.chain?.initialized || !s.chain.finalizedSlot || !/^\d+$/.test(s.chain.finalizedSlot) || BigInt(s.chain.finalizedSlot) <= 0n) return false;
  return !!owner && s.policy.owner === owner && s.policy.id === policy.id && s.policy.network === policy.network && s.chain.policyAddress === s.policy.policyAddress && s.chain.owner === s.policy.owner && !!s.chain.solVault;
}

/** Bulk revocation runs the allowance protocol, so it covers only policies whose wallet supports revocation. */
export const revocable = (p: Pick<MicroPolicy, 'runtime' | 'network'>) => isAllowanceWallet(p) && supports(p, 'revoke');

export const WALLET_LABEL: Record<WalletKind, string> = {'owner-wallet': 'Owner wallet', 'contract-wallet': 'Contract wallet'};
/** The one sentence the owner reads before funding, per wallet kind. */
export const WALLET_MEANING: Record<WalletKind, string> = {
  'owner-wallet': 'Funds stay in your wallet. Each transfer waits for your wallet.',
  'contract-wallet': 'Setup moves the deposit into the policy’s account. The agent can spend it within the limits without another signature from you.',
};
/**
 * Who enforces what, wherever execution authority is described. The policy source is not uploaded to the chain and
 * does not run there.
 */
export const EXECUTION_AUTHORITY = 'Allowit’s host Rust compiler and evaluator check each call against this policy’s source. The fixed on-chain program enforces only the limits you sign; the source does not run on chain.';

/** A server's signed, unresolved or ended setup is never a new signing opportunity on another device. */
export function newSetupAllowed(policy: Pick<MicroPolicy,'runtime'|'network'|'status'>): boolean {
  if(contractSetupPaused(policy.network))return false;
  if(policy.status!=='draft')return false;
  const r=runtimeOf(policy);if(r.state!=='typed'||r.kind!=='contract-wallet'||!r.capabilities.fund)return false;
  const s=r.runtime.setup;if(!s)return true;
  if(s.signature||s.state?.signature)return false;
  return [s.status,s.state?.status].every(v=>v===undefined||v==='draft'||v==='prepared');
}
