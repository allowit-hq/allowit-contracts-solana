/**
 * PaySH agent profile HTTP values. The adapters check shape, units and internal agreement: every missing, malformed or
 * contradictory field fails by name, so a backend change can never be shown as a weaker policy. Policy correctness stays with the backend and
 * the program; the owner's exact transaction intent is checked in paysh-wallet-intent.ts. Shapes follow the Rust
 * backend's `paysh_api.rs` and `engine::paysh` replies.
 */
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {decodeConfig} from './paysh-wallet-intent';
import {serviceIds, sameServiceIds, serviceAllowlistRoot} from './service-allowlist';
import {ContractError, parseReceipt, receiptFinalized, token6, u64, type OperationReceipt} from './paysh-units';
import {isPrivateLocalnet} from '../wallet/runtime-network';

export {ContractError, parseReceipt, scaled, sol, token6, u64, type OperationReceipt, type ReceiptAction} from './paysh-units';

export const PAYSH_TESTNET = 'solana:testnet';
export type PayshNetwork = typeof PAYSH_TESTNET | 'solana:localnet';
export const isPayshNetwork = (network: unknown): network is PayshNetwork => network === PAYSH_TESTNET || isPrivateLocalnet(network);
/** Solana Testnet genesis hash. The program binds it in Config.network; the browser checks the prepared Config. */
export const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';
const PUBLIC_OR_ZERO_GENESIS = [TESTNET_GENESIS, '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', '11111111111111111111111111111111'];
export const isPayshGenesis = (network: PayshNetwork, genesis: string): boolean => network === PAYSH_TESTNET
  ? genesis === TESTNET_GENESIS : isPrivateLocalnet(network) && !PUBLIC_OR_ZERO_GENESIS.includes(genesis);
const HEX32 = /^[0-9a-f]{64}$/;
const U64_MAX = 0xffffffffffffffffn;

const fail = (field: string, what = 'is missing or invalid') => new ContractError(`The PaySH backend response field ${field} ${what}.`);
type Json = Record<string, unknown>;
const record = (value: unknown, field: string): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(field);
  return value as Json;
};
const text = (value: unknown, field: string, max = 4000): string => {
  if (typeof value !== 'string' || !value || value.length > max) throw fail(field);
  return value;
};
const address = (value: unknown, field: string): string => {
  const s = text(value, field, 44);
  try {
    if (new PublicKey(s).toBase58() !== s) throw new Error();
  } catch {
    throw fail(field, 'is not a Solana address');
  }
  return s;
};
const hex32 = (value: unknown, field: string): string => {
  if (typeof value === 'string' && HEX32.test(value)) return value;
  // Rust [u8; 32] fields serialize as byte arrays.
  if (Array.isArray(value) && value.length === 32 && value.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) return value.map(b => b.toString(16).padStart(2, '0')).join('');
  throw fail(field, 'is not a 32-byte hex value');
};
const bool = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') throw fail(field);
  return value;
};

/* ------------------------------------------------------------------ config */

export interface PayshPool {program: string; state: string; wsol: string; usdc: string; oracle: string}
/** Public deployment values the owner's setup transaction must use. No keys. */
export interface PayshDeployment {
  program: string;
  genesis: string;
  moduleDigest: string;
  evaluator: string;
  treasury: string;
  usdcMint: string;
  vendorUsdc: string;
  pool: PayshPool;
  /** Compute-unit limit the setup requests. */
  computeLimit: number;
  /** The deployment's address lookup table and its public addresses, when setup needs one to fit a packet. */
  lookupTable: {address: string; addresses: string[]} | null;
}
/** Server caps the generator may narrow but never exceed. */
export interface PayshCaps {allocationLamports: string; maxPaymentUsdc: string; maxSwapLamports: string; maxServiceFeeLamports: string; preferenceThresholdBps: number}
export type PayshConfig =
  | {enabled: false; network: string; missing: string[]}
  | {enabled: true; network: PayshNetwork; serviceId: string; serviceName: string; deployment: PayshDeployment; caps: PayshCaps; missing: []};

function pool(value: unknown, field: string): PayshPool {
  const p = record(value, field);
  return {program: address(p.program, `${field}.program`), state: address(p.state, `${field}.state`), wsol: address(p.wsol, `${field}.wsol`), usdc: address(p.usdc, `${field}.usdc`), oracle: address(p.oracle, `${field}.oracle`)};
}

function computeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1_400_000) throw fail('deployment.computeLimit');
  return value;
}
function lookupTable(value: unknown): {address: string; addresses: string[]} {
  const t = record(value, 'deployment.lookupTable');
  if (!Array.isArray(t.addresses) || t.addresses.length > 256) throw fail('deployment.lookupTable.addresses');
  return {address: address(t.address, 'deployment.lookupTable.address'), addresses: t.addresses.map((a, i) => address(a, `deployment.lookupTable.addresses[${i}]`))};
}
function bps(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10000) throw fail(field);
  return value;
}
/** A string that may be empty. */
const plain = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || value.length > max) throw fail(field);
  return value;
};

/** Public deployment values. Testnet keeps its fixed genesis; private acceptance binds the actual validator genesis. */
export function parseDeployment(value: unknown, network: PayshNetwork = PAYSH_TESTNET): PayshDeployment {
  if (!isPayshNetwork(network)) throw fail('network', 'is not Solana Testnet or an enabled private validator');
  const d = record(value, 'deployment');
  const deployment: PayshDeployment = {
    program: address(d.program, 'deployment.program'),
    genesis: address(d.genesis, 'deployment.genesis'),
    moduleDigest: hex32(d.moduleDigest, 'deployment.moduleDigest'),
    evaluator: address(d.evaluator, 'deployment.evaluator'),
    treasury: address(d.treasury, 'deployment.treasury'),
    usdcMint: address(d.usdcMint, 'deployment.usdcMint'),
    vendorUsdc: address(d.vendorUsdc, 'deployment.vendorUsdc'),
    pool: pool(d.pool, 'deployment.pool'),
    computeLimit: computeLimit(d.computeLimit),
    lookupTable: d.lookupTable === null || d.lookupTable === undefined ? null : lookupTable(d.lookupTable),
  };
  if (!isPayshGenesis(network, deployment.genesis)) throw fail('deployment.genesis', network === PAYSH_TESTNET ? 'is not the Solana Testnet genesis hash' : 'is not a private validator genesis hash');
  return deployment;
}

export function parseConfig(value: unknown): PayshConfig {
  const c = record(value, 'config');
  const missing = Array.isArray(c.missing) ? c.missing.filter((m): m is string => typeof m === 'string').map(m => m.slice(0, 120)).slice(0, 40) : null;
  if (missing === null) throw fail('missing');
  if (c.enabled !== true || missing.length) {
    if (c.enabled !== false && c.enabled !== true) throw fail('enabled');
    return {enabled: false, network: typeof c.network === 'string' ? c.network.slice(0, 40) : '', missing};
  }
  if (!isPayshNetwork(c.network)) throw fail('network', 'is not Solana Testnet or an enabled private validator');
  const deployment = parseDeployment(c.deployment, c.network);
  const k = record(c.caps, 'caps');
  const caps: PayshCaps = {
    allocationLamports: u64(k.allocationLamports, 'caps.allocationLamports'),
    maxPaymentUsdc: u64(k.maxPaymentUsdc, 'caps.maxPaymentUsdc'),
    maxSwapLamports: u64(k.maxSwapLamports, 'caps.maxSwapLamports'),
    maxServiceFeeLamports: u64(k.maxServiceFeeLamports, 'caps.maxServiceFeeLamports'),
    preferenceThresholdBps: bps(k.preferenceThresholdBps, 'caps.preferenceThresholdBps'),
  };
  return {enabled: true, network: c.network, serviceId: text(c.serviceId, 'serviceId', 200), serviceName: text(c.serviceName, 'serviceName', 200), deployment, caps, missing: []};
}

/* ------------------------------------------------------------------ policy */

/** The backend's stored policy, as finalization saves it. */
export interface PayshPolicy {
  id: string;
  owner: string;
  originalIntent: string;
  network: PayshNetwork;
  serviceId: string;
  /** Present only for the v2 per-policy on-chain allowlist. */
  allowedServiceIds?: string[];
  policyAddress: string;
  moduleDigest: string;
  allocationLamports: string;
  maxPaymentUsdc: string;
  /** Explicit aggregate native ceiling for new common v2 policies; historical policies use the single-call ceiling. */
  maxPaymentUsdcPerPeriod?: string;
  maxSwapLamports: string;
  maxServiceFeeLamports: string;
  preferenceThresholdBps: number;
  /** Empty means the backend's fixed default question applies. */
  semanticQuestion: string;
}
export const POLICY_FIELDS = ['id', 'owner', 'originalIntent', 'network', 'serviceId', 'policyAddress', 'moduleDigest', 'allocationLamports', 'maxPaymentUsdc', 'maxPaymentUsdcPerPeriod', 'maxSwapLamports', 'maxServiceFeeLamports', 'preferenceThresholdBps', 'semanticQuestion'] as const;
/**
 * The question Jev answers when a policy's own question is empty. Copied from the backend's
 * `allowit_server_engine::paysh::PREFERENCE_QUESTION`; the generator currently always supplies one.
 */
export const DEFAULT_QUESTION = "Is this exact API purchase, including any SOL to USDC swap and service fee, reasonable for the owner's original intent?";

export function parsePolicy(value: unknown, field = 'policy'): PayshPolicy {
  const p = record(value, field);
  if (typeof p.id !== 'string' || !HEX32.test(p.id)) throw fail(`${field}.id`, 'is not a 64-character lowercase hex ID');
  if (!isPayshNetwork(p.network)) throw fail(`${field}.network`, 'is not Solana Testnet or an enabled private validator');
  const policy: PayshPolicy = {
    id: p.id,
    owner: address(p.owner, `${field}.owner`),
    originalIntent: text(p.originalIntent, `${field}.originalIntent`),
    network: p.network,
    serviceId: text(p.serviceId, `${field}.serviceId`, 200),
    ...(p.allowedServiceIds === undefined ? {} : {allowedServiceIds: serviceIds(p.allowedServiceIds)}),
    policyAddress: address(p.policyAddress, `${field}.policyAddress`),
    moduleDigest: hex32(p.moduleDigest, `${field}.moduleDigest`),
    allocationLamports: u64(p.allocationLamports, `${field}.allocationLamports`),
    maxPaymentUsdc: u64(p.maxPaymentUsdc, `${field}.maxPaymentUsdc`),
    ...(p.maxPaymentUsdcPerPeriod === undefined ? {} : {maxPaymentUsdcPerPeriod: u64(p.maxPaymentUsdcPerPeriod, `${field}.maxPaymentUsdcPerPeriod`)}),
    maxSwapLamports: u64(p.maxSwapLamports, `${field}.maxSwapLamports`),
    maxServiceFeeLamports: u64(p.maxServiceFeeLamports, `${field}.maxServiceFeeLamports`),
    preferenceThresholdBps: bps(p.preferenceThresholdBps, `${field}.preferenceThresholdBps`),
    semanticQuestion: plain(p.semanticQuestion ?? '', `${field}.semanticQuestion`, 1000),
  };
  if (policy.allocationLamports === '0') throw fail(`${field}.allocationLamports`, 'is zero');
  if (policy.maxPaymentUsdcPerPeriod !== undefined && (!policy.allowedServiceIds || policy.maxPaymentUsdcPerPeriod === '0' || BigInt(policy.maxPaymentUsdcPerPeriod) < BigInt(policy.maxPaymentUsdc))) throw fail(`${field}.maxPaymentUsdcPerPeriod`, 'requires a v2 policy and must cover its single-call ceiling');
  if (policy.allowedServiceIds && policy.allowedServiceIds[0] !== policy.serviceId) throw fail(`${field}.serviceId`, 'differs from the primary allowed service');
  return policy;
}
export const samePolicy = (a: PayshPolicy, b: PayshPolicy) => POLICY_FIELDS.every(k => a[k] === b[k]) && (a.allowedServiceIds === undefined && b.allowedServiceIds === undefined || !!a.allowedServiceIds && !!b.allowedServiceIds && sameServiceIds(a.allowedServiceIds, b.allowedServiceIds));

/** The generator's answer. Its caps and question become the policy; it chooses no keys, pools or programs. */
export interface PayshProfile {
  title: string;
  explanation: string;
  serviceId: string;
  allocationLamports: string;
  maxPaymentUsdc: string;
  maxSwapLamports: string;
  maxServiceFeeLamports: string;
  preferenceThresholdBps: number;
  semanticQuestion: string;
  supported: boolean;
}
/** A generated, owner-bound draft. `raw` is the exact reply, kept on this device so the draft survives a reload. */
export interface PolicyDraft {
  draftId: string;
  policy: PayshPolicy;
  profile: PayshProfile;
  /** The Borsh Config the setup must install, decoded from `configBytes`. */
  config: ChainConfig;
  configBytes: string;
  title: string;
  explanation: string;
  methods: string[];
  raw: Json;
}

function parseProfile(value: unknown): PayshProfile {
  const p = record(value, 'profile');
  return {
    title: text(p.title, 'profile.title', 120),
    explanation: plain(p.explanation, 'profile.explanation', 2000),
    serviceId: text(p.serviceId, 'profile.serviceId', 200),
    allocationLamports: u64(p.allocationLamports, 'profile.allocationLamports'),
    maxPaymentUsdc: u64(p.maxPaymentUsdc, 'profile.maxPaymentUsdc'),
    maxSwapLamports: u64(p.maxSwapLamports, 'profile.maxSwapLamports'),
    maxServiceFeeLamports: u64(p.maxServiceFeeLamports, 'profile.maxServiceFeeLamports'),
    preferenceThresholdBps: bps(p.preferenceThresholdBps, 'profile.preferenceThresholdBps'),
    semanticQuestion: plain(p.semanticQuestion, 'profile.semanticQuestion', 1000),
    supported: bool(p.supported, 'profile.supported'),
  };
}
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
function configFrom(value: unknown, field: string): {configBytes: string; config: ChainConfig} {
  const configBytes = text(value, field, 1024);
  if (!BASE64.test(configBytes)) throw fail(field, 'is not base64');
  try {
    return {configBytes, config: decodeConfig(Buffer.from(configBytes, 'base64'))};
  } catch {
    throw fail(field, 'is not a PaySH Config');
  }
}

/**
 * `paysh/generate`: `{draftId, policy, profile, configBytes, title, explanation, methods}`. The policy, profile and
 * Config must state the same terms; any disagreement fails here rather than being shown as one of them.
 */
export function parseDraft(value: unknown): PolicyDraft {
  const r = record(value, 'response');
  const policy = parsePolicy(r.policy);
  const profile = parseProfile(r.profile);
  const {configBytes, config} = configFrom(r.configBytes, 'configBytes');
  if ((config.serviceAllowlistRoot !== undefined) !== (policy.allowedServiceIds !== undefined)) throw fail('policy.allowedServiceIds', 'does not match the Config version');
  if (policy.allowedServiceIds && serviceAllowlistRoot(policy.allowedServiceIds, config) !== config.serviceAllowlistRoot) throw fail('configBytes serviceAllowlistRoot', 'differs from the allowed services');
  if (r.draftId !== policy.id) throw fail('draftId', 'differs from policy.id');
  if (!profile.supported) throw fail('profile.supported', 'is false');
  const agree: [string, unknown, unknown][] = [
    ['profile.serviceId', profile.serviceId, policy.serviceId],
    ['profile.allocationLamports', profile.allocationLamports, policy.allocationLamports],
    ['profile.maxPaymentUsdc', profile.maxPaymentUsdc, policy.maxPaymentUsdc],
    ['profile.maxSwapLamports', profile.maxSwapLamports, policy.maxSwapLamports],
    ['profile.maxServiceFeeLamports', profile.maxServiceFeeLamports, policy.maxServiceFeeLamports],
    ['profile.preferenceThresholdBps', profile.preferenceThresholdBps, policy.preferenceThresholdBps],
    ['profile.semanticQuestion', profile.semanticQuestion, policy.semanticQuestion],
    ['configBytes instanceId', config.instanceId, policy.id],
    ['configBytes moduleDigest', config.moduleDigest, policy.moduleDigest],
    ['configBytes allocationLamports', config.allocationLamports, policy.allocationLamports],
    ['configBytes maxUsdcPerPeriod', config.maxUsdcPerPeriod, policy.maxPaymentUsdcPerPeriod ?? policy.maxPaymentUsdc],
    ['configBytes maxSwapLamportsPerCall', config.maxSwapLamportsPerCall, policy.maxSwapLamports],
    ['configBytes serviceFeeLamports', config.serviceFeeLamports, policy.maxServiceFeeLamports],
  ];
  for (const [field, got, want] of agree) if (got !== want) throw fail(field, 'differs from the policy');
  const title = text(r.title, 'title', 120);
  if (title !== profile.title) throw fail('title', 'differs from profile.title');
  const explanation = plain(r.explanation, 'explanation', 2000);
  if (explanation !== profile.explanation) throw fail('explanation', 'differs from profile.explanation');
  if (!Array.isArray(r.methods) || !r.methods.length || r.methods.length > 8) throw fail('methods');
  const methods = r.methods.map((m, i) => text(m, `methods[${i}]`, 200));
  return {draftId: policy.id, policy, profile, config, configBytes, title, explanation, methods, raw: r};
}

/* ------------------------------------------------------------------ setup */

/** The exact Borsh `Config` the program stores at Initialize. */
export interface ChainConfig {
  instanceId: string;
  network: string;
  moduleDigest: string;
  evaluator: string;
  treasury: string;
  usdcMint: string;
  vaultUsdc: string;
  vaultWsol: string;
  vendorUsdc: string;
  pool: PayshPool;
  periodSeconds: string;
  maxUsdcPerPeriod: string;
  maxSwapLamportsPerPeriod: string;
  maxFeeLamportsPerPeriod: string;
  maxSolDebitsPerPeriod: string;
  maxSwapLamportsPerCall: string;
  maxTotalSwapLamports: string;
  allocationLamports: string;
  serviceFeeLamports: string;
  minUsdcPerSol: string;
  maxPoolFeeBps: string;
  maxAgeSlots: string;
  maxAgeSeconds: string;
  policyExpiresTimestamp: string;
  ownerOnly: boolean;
  /** Absent for historical v1 bytes; never infer v2 from an empty list. */
  serviceAllowlistRoot?: string;
}

/**
 * `paysh/prepare`: the native SDK's owner setup with the stored policy. The program is not in the reply; the
 * owner's transaction is checked against the public deployment from `paysh/config`.
 */
export interface PreparedSetup {
  requestId: string;
  policy: PayshPolicy;
  unsignedTransaction: string;
  message: string;
  configBytes: string;
  /** Decoded from the exact Borsh Config bytes inside Initialize. */
  config: ChainConfig;
  allocationLamports: string;
  blockhashContextSlot?: string;
  lastValidBlockHeight?: string;
  accounts: {owner: string; policy: string; solCustody: string};
}
export function parsePrepared(value: unknown): PreparedSetup {
  const r = record(value, 'response');
  const unsignedTransaction = text(r.unsignedTransaction, 'unsignedTransaction', 4096), message = text(r.message, 'message', 4096);
  for (const [v, name] of [[unsignedTransaction, 'unsignedTransaction'], [message, 'message']]) if (!BASE64.test(v)) throw fail(name, 'is not base64');
  const accounts = record(r.expectedAccounts, 'expectedAccounts');
  return {
    requestId: text(r.requestId, 'requestId', 128),
    policy: parsePolicy(r.policy),
    unsignedTransaction,
    message,
    ...configFrom(r.configBytes, 'configBytes'),
    allocationLamports: u64(r.allocationLamports, 'allocationLamports'),
    ...(r.blockhashContextSlot == null ? {} : {blockhashContextSlot: u64(r.blockhashContextSlot, 'blockhashContextSlot')}),
    ...(r.lastValidBlockHeight == null ? {} : {lastValidBlockHeight: u64(r.lastValidBlockHeight, 'lastValidBlockHeight')}),
    accounts: {owner: address(accounts.owner, 'expectedAccounts.owner'), policy: address(accounts.policy, 'expectedAccounts.policy'), solCustody: address(accounts.solVault, 'expectedAccounts.solVault')},
  };
}

/**
 * `paysh/submit` and `paysh/confirm` phases. Only `finalized` means the backend verified the installed policy on
 * chain and saved it. `absent` proves the exact signed setup expired without its policy account.
 * `archived` removes an unsigned draft or proven-absent signed setup from the owner list.
 * A verification failure is an HTTP error, not a phase.
 */
export const SETUP_STATUSES = ['draft', 'preparing', 'prepared', 'submitted', 'finalized', 'absent', 'archived'] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];
export interface SetupChain {finalizedSlot?: string; initialized: boolean; policyAddress: string; owner: string; solVault: string; balanceLamports?: string}
export interface SetupState {requestId: string; policy: PayshPolicy; status: SetupStatus; signature: string | null; chain: SetupChain | null}
export function parseSetupState(value: unknown): SetupState {
  const r = record(value, 'response');
  if (!SETUP_STATUSES.includes(r.status as SetupStatus)) throw fail('status', 'is not a known setup status');
  const status = r.status as SetupStatus;
  const finalized = status === 'finalized';
  const absent = status === 'absent';
  const chain = finalized || absent || (r.chain !== undefined && r.chain !== null) ? record(r.chain, 'chain') : null;
  return {
    requestId: text(r.requestId, 'requestId', 128),
    policy: parsePolicy(r.policy),
    status,
    signature: finalized || absent || r.signature !== undefined ? text(r.signature, 'signature', 100) : null,
    chain: chain ? {...(chain.finalizedSlot === undefined ? {} : {finalizedSlot: u64(chain.finalizedSlot, 'chain.finalizedSlot')}), initialized: bool(chain.initialized, 'chain.initialized'), policyAddress: address(chain.policyAddress, 'chain.policyAddress'), owner: address(chain.owner, 'chain.owner'), solVault: address(chain.solVault, 'chain.solVault'), ...(absent && chain.balanceLamports === undefined ? {} : {balanceLamports: u64(chain.balanceLamports, 'chain.balanceLamports')})} : null,
  };
}

/** `paysh/archive`: `{draftId, status: "archived"}`. The backend refuses signed setups unless their absence was positively verified. */
export function parseArchived(value: unknown, policyId: string): void {
  const r = record(value, 'response');
  if (r.draftId !== policyId) throw fail('draftId', 'belongs to another draft');
  if (r.status !== 'archived') throw fail('status', 'is not archived');
}

export interface AgentExport {capability: string; skill: string}
export function parseExport(value: unknown, policyId: string): AgentExport {
  const r = record(value, 'response');
  if (parsePolicy(r.policy).id !== policyId) throw fail('policy.id', 'belongs to another policy');
  const capability = text(r.capability, 'capability', 512);
  if (capability.length < 32 || /\s/.test(capability)) throw fail('capability', 'is not a scoped capability');
  return {capability, skill: text(r.skill, 'skill', 64_000)};
}

/* ------------------------------------------------------------------ agent operations */

/**
 * Backend operation phases. `denied` is recorded when the policy refuses a call. `unknown` is set only by the owner
 * for an unresolved operation: it may lack a verified payment transaction. Neither state establishes delivery.
 * `awaiting_input` waits for the owner's signed answer under Requests; `owner_approved` records a signed Yes for this
 * call only, which queues a new, full policy evaluation with only that question answered. Neither one sends a payment:
 * the re-evaluation needs no further owner signature, and its fresh quote must still fit the signed limits. `expired` means the answer-and-start deadline passed before the agent
 * started; it is never a No, even when a signed Yes was recorded. Payment finality still comes only from receipts.
 */
export const PHASES = ['evaluating', 'awaiting_input', 'owner_approved', 'approved', 'preparing', 'signed', 'submitted', 'confirmed', 'delivering', 'delivered', 'denied', 'failed', 'expired', 'settlement_unknown', 'unknown'] as const;
export type Phase = (typeof PHASES)[number];
export interface AgentOperation {operationId: string; status: Phase; signatures: string[]; receipts: OperationReceipt[]; response: unknown}
/** `{operationId, status, signatures, receipts, response}`. A bare `{operationId, status: "failed"}` reply has no lists. */
export function parseOperation(value: unknown, operationId: string): AgentOperation {
  const r = record(value, 'response');
  if (r.operationId !== operationId) throw fail('operationId', 'belongs to another operation');
  if (!PHASES.includes(r.status as Phase)) throw fail('status', 'is not a known operation status');
  const signatures = r.signatures === undefined ? [] : Array.isArray(r.signatures) ? r.signatures.map((s, i) => text(s, `signatures[${i}]`, 100)) : null;
  if (!signatures) throw fail('signatures');
  const receipts = r.receipts === undefined ? [] : Array.isArray(r.receipts) ? r.receipts.map((x, i) => parseReceipt(x, `receipts[${i}]`)) : null;
  if (!receipts) throw fail('receipts');
  return {operationId, status: r.status as Phase, signatures, receipts, response: r.response ?? null};
}

/** Receipt presence, rather than operation status or a consumed authorization, establishes payment finality. */
export const hasFinalizedPayment = (op: AgentOperation) => op.receipts.some(r => r.action.type === 'pay' && receiptFinalized(r));
/**
 * Expiry is not evidence that nothing executed. An expired call stays unresolved while it has a finalized payment, a
 * payment receipt without a finalized slot, or a signature without any receipt.
 */
export const expiredUnresolved = (op: AgentOperation) =>
  op.status === 'expired' && (hasFinalizedPayment(op) || op.receipts.some(r => r.action.type !== 'swap') || op.signatures.some(s => !op.receipts.some(r => r.signature === s)));
export function paymentWord(op: AgentOperation) {
  if (hasFinalizedPayment(op)) return 'Finalized on Testnet.';
  if (op.status === 'awaiting_input') return 'Not sent. This call waits for your answer under Requests.';
  if (op.status === 'owner_approved') return 'Not sent yet, and no payment was approved. Your Yes queued a new, full policy evaluation of this call with only that question answered. It uses a fresh quote and context and every hard limit; only if it passes does the agent send a freshly signed native run, without another signature from you, within the signed limits.';
  if (expiredUnresolved(op)) return 'Unresolved. This call expired, but a transaction below could not be verified. Payment may have been sent, and no finalized payment receipt is available.';
  if (op.status === 'expired') return op.receipts.length ? 'Expired after the finalized steps below. No finalized payment receipt is available.' : 'Not sent. This call expired before the agent started it.';
  if (['evaluating', 'approved', 'preparing'].includes(op.status)) return 'Not sent. The policy is still checking this call.';
  if (op.status === 'signed' || op.status === 'submitted') return 'Submitted. Waiting for Testnet finality.';
  if (op.status === 'denied') return 'Not sent. The policy or your answer denied this call.';
  if (op.status === 'failed') return op.receipts.length ? 'Failed after the finalized steps below. The final payment did not execute.' : 'Failed. No payment executed.';
  return 'Unresolved. Payment may have been sent, but no finalized payment receipt is available.';
}
export function deliveryWord(op: AgentOperation) {
  const paid = hasFinalizedPayment(op);
  if (op.status === 'delivered') return paid ? 'Delivered.' : 'Response received. Payment remains unresolved.';
  if (op.status === 'delivering') return paid
    ? 'Not complete. The payment is finalized and the API response has not been recovered. It is not requested again, and no refund is reported.'
    : 'Not complete. Payment and delivery remain unresolved. Do not retry or create a replacement payment. No refund is reported.';
  if (op.status === 'confirmed') return paid ? 'Not started. The payment is finalized.' : 'Not started. Payment remains unresolved.';
  if (op.status === 'settlement_unknown') return 'Unresolved. The execution transaction could not be verified. Payment may have been sent. Do not retry or create a replacement payment.';
  if (op.status === 'unknown') return paid
    ? 'Unknown. The payment is finalized and you marked the delivery unresolved. It is not requested again, it is not counted as failed or delivered, and no refund is reported.'
    : 'Unknown. You marked the operation unresolved. Payment may have been sent. Do not retry or create a replacement payment. It is not counted as failed or delivered, and no refund is reported.';
  if (expiredUnresolved(op)) return paid
    ? 'Unresolved. The payment is finalized and this call expired without a delivered response. Do not retry or create a replacement payment. No refund is reported.'
    : 'Unresolved. This call expired, and payment may have been sent. Do not retry or create a replacement payment. No refund is reported.';
  if (op.status === 'denied' || op.status === 'failed' || op.status === 'expired') return 'Not delivered.';
  if (op.status === 'awaiting_input') return 'Not started. Waiting for your answer.';
  return 'Waiting for the payment.';
}

/* ------------------------------------------------------------------ catalog */

/** The native Testnet fixture a cooperating backend may configure. It exercises swap and payment only; it delivers no Google data. */
export const NATIVE_TESTNET_FIXTURE = 'native-paysh-testnet-compatibility';

/**
 * `paysh/catalog`, informational only; the policy binds the service ID. Either the public pay.sh index
 * (`providers[].fqn`, USD prices) or a cooperating backend's own list (`{profile: "cooperating-v1", reputation, services[]}`,
 * prices in six-decimal token units on the service's network). Only the configured service's entry is read.
 */
export type PayshCatalog =
  | {source: 'paysh'; entry: {title: string; priceUsd: string | null} | null}
  | {source: 'cooperating-v1'; entry: {name: string; description: string; network: string; priceUsdcUnits: string} | null};

function only(list: unknown[], key: string, serviceId: string, field: string): number {
  const found = list.flatMap((x, i) => ((x as Json | null)?.[key] === serviceId ? [i] : []));
  if (found.length > 1) throw fail(field, 'lists the service more than once');
  return found.length ? found[0] : -1;
}

export function parseCatalog(value: unknown, serviceId: string): PayshCatalog {
  const r = record(value, 'catalog');
  if (r.services !== undefined && r.providers !== undefined) throw fail('catalog', 'lists both services and providers');
  if (r.services !== undefined) {
    if (!Array.isArray(r.services)) throw fail('services');
    if (r.profile !== 'cooperating-v1') throw fail('profile', 'is not cooperating-v1');
    // No reputation format is defined; anything else could only be shown as an invented ranking.
    if (r.reputation !== null && r.reputation !== undefined) throw fail('reputation', 'is not null');
    const i = only(r.services, 'id', serviceId, 'services');
    if (i < 0) return {source: 'cooperating-v1', entry: null};
    const s = record(r.services[i], `services[${i}]`);
    return {
      source: 'cooperating-v1',
      entry: {name: text(s.name, `services[${i}].name`, 200), description: plain(s.description, `services[${i}].description`, 2000), network: text(s.network, `services[${i}].network`, 40), priceUsdcUnits: u64(s.priceUsdcUnits, `services[${i}].priceUsdcUnits`)},
    };
  }
  if (r.profile !== undefined) throw fail('profile', 'requires a services list');
  if (r.providers === undefined || !Array.isArray(r.providers)) throw fail('services or providers');
  const i = only(r.providers, 'fqn', serviceId, 'providers');
  if (i < 0) return {source: 'paysh', entry: null};
  const p = record(r.providers[i], `providers[${i}]`);
  const min = p.min_price_usd, max = p.max_price_usd;
  return {source: 'paysh', entry: {title: typeof p.title === 'string' && p.title ? p.title.slice(0, 120) : serviceId, priceUsd: typeof min === 'number' && Number.isFinite(min) && min >= 0 && min === max ? String(min) : null}};
}

/** The listed price in its own unit and source. A cooperating Testnet price is test-token units, never USD or USDC. */
export function catalogPrice(c: PayshCatalog): string | null {
  if (!c.entry) return null;
  if (c.source === 'paysh') return c.entry.priceUsd ? `The PaySH catalog lists ${c.entry.priceUsd} USD per request. A catalog listing does not establish Testnet compatibility.` : null;
  return c.entry.network === PAYSH_TESTNET ? `This server lists ${token6(c.entry.priceUsdcUnits)} test token per call on Solana Testnet, not USD or USDC.` : `This server lists it for ${c.entry.network}, not Solana Testnet, so no Testnet price is shown.`;
}
export function catalogWord(c: PayshCatalog, serviceId: string): string {
  if (c.source === 'paysh') return c.entry ? `${c.entry.title} is listed in the PaySH catalog${c.entry.priceUsd ? ` at ${c.entry.priceUsd} USD per request` : ''}. A catalog listing does not establish Testnet compatibility.` : `${serviceId} is not in the PaySH catalog reply.`;
  if (!c.entry) return `${serviceId} is not in this server's service list.`;
  return `${c.entry.name} is listed by this server, not the public PaySH catalog.${c.entry.description ? ` This server describes it as: ${c.entry.description}` : ''} ${catalogPrice(c)} No reputation data.`;
}

/** The page's starting prompt. The native Testnet fixture delivers no real API data, so its prompt asks only for a swap and payment check. */
export function defaultPrompt(serviceId: string, serviceName: string, funding: string) {
  if (serviceId === NATIVE_TESTNET_FIXTURE) {
    return `Let my agent validate PaySH native payments with the ${serviceName} fixture. Fund it with ${funding} Testnet SOL. When a call needs the test token, swap SOL directly in the configured Orca Whirlpool pool, within my maximum input, slippage and minimum output, then pay the fixture. This checks the swap and payment only; no real Google Air Quality data is expected. Check each payment for reasonableness before paying. Sponsor network fees, and charge the capped service fee when a payment or swap executes.`;
  }
  return `Let my agent buy current air quality lookups from the ${serviceName} through PaySH. Fund it with ${funding} Testnet SOL. When a call needs the test token, swap SOL directly in the configured Orca Whirlpool pool, within my maximum input, slippage and minimum output. Check each purchase for reasonableness before paying. Sponsor network fees, and charge the capped service fee when a payment or swap executes.`;
}

/* ------------------------------------------------------------------ units */

/** Exact SOL decimal to lamports. */
export function lamports(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(value)) throw new Error('Use a number with at most nine decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const n = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  if (n > U64_MAX) throw new Error('The amount is too large.');
  return n;
}
