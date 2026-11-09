import {request} from '../api';
import type {MicroPolicy} from '../micro/micro-contracts';
import type {Session} from '../contracts';
import {NativePolicyAPI, isPolicy, type StateReply} from './native-api';
import {decimal, finalizedSlot, MAX_LIMIT_UNITS, settledOperation, units, type BoundNativeX402Service, type NativeConfig, type Policy, type PublicOperation} from './native-contracts';
import {checkedRecipient, recipientTokenAccount, sameRecipient, sourceLimit, sourceRecipient, type RecipientBinding} from './native-recipient';
import {parseConfig, parseRelease} from './native-vault';
import {parseBoundNativeX402Service, sameNativeX402Service, selectedNativeX402Service} from './native-x402';
import {sourceWhitelist} from '../paysh/source-whitelist';
import {vaultPhase} from './native-vault';
import type {Operation} from './native-contracts';
import {PublicKey} from '@solana/web3.js';

const onCurve = (address: string) => {try {const key = new PublicKey(address); return key.toBase58() === address && PublicKey.isOnCurve(key.toBytes());} catch {return false;}};

export interface ExecutionBinding {policyId: string; revision: number; sourceHash: string; owner: string; network: 'solana:devnet'; recipientMode?: 'any-wallet'; recipientMint?: string}
export interface NativeAttachment {
  policy: Policy; executionPolicyId: string; executionBinding: ExecutionBinding; recipientBinding?: RecipientBinding; recipientMode?: 'any-wallet'; recipientMint?: string;
  x402Service?: BoundNativeX402Service;
  initialFunding: {amount: string; token: 'USDC'; mint: string};
  paymentKind: 'direct-token-transfer'; deliveryAttested: false;
  /** The owner's agent key frozen as this vault's executor. Absent for vaults set up with the former server executor. */
  executor?: string;
}
/** An agent the owner connected: it registered only its own public key with `allowit setup`. */
export interface NativeAgent {id: string; name: string; publicKey?: string; network?: string}
/** This vault's own view of the deployment: its executor is the agent key frozen at setup. */
export const vaultConfig = (config: NativeConfig, attachment: Pick<NativeAttachment, 'executor'>): NativeConfig => attachment.executor ? {...config, executor: attachment.executor} : config;
export interface ManagedAgent {endpoint: string; authorization: string; requestSchema: unknown; recovery: 'repeat-identical-request'; paymentKind: 'direct-token-transfer'; deliveryAttested: false; x402Service?: BoundNativeX402Service}
/** UI projection only; authorization always comes from the authenticated immutable native binding. */
export const hasNativeAttachment = (policy: Pick<MicroPolicy, 'nativeExecution'>) => policy.nativeExecution !== undefined && policy.nativeExecution !== null;
export type SelectedPolicy = Pick<MicroPolicy, 'id' | 'revision' | 'sourceHash' | 'network' | 'limit' | 'token' | 'mint' | 'fundingRequest' | 'code' | 'workflow'>;
const fields = ['policyId', 'revision', 'sourceHash', 'owner', 'network'] as const;
export function executionBinding(policy: SelectedPolicy, owner: string): ExecutionBinding {
  if (policy.network !== 'solana:devnet' || !owner || !Number.isSafeInteger(policy.revision) || policy.revision < 1 || !/^[0-9a-f]{64}$/.test(policy.sourceHash)) throw new Error('Select an exact Devnet policy revision and sign in with its owner.');
  return {policyId: policy.id, revision: policy.revision, sourceHash: policy.sourceHash, owner, network: 'solana:devnet'};
}
export function sameExecutionBinding(value: unknown, expected: ExecutionBinding): boolean {
  const actual = value as ExecutionBinding | null;
  return !!actual && fields.every(k => actual[k] === expected[k]) && (actual.recipientMode || undefined) === (expected.recipientMode || undefined) && (actual.recipientMint || undefined) === (expected.recipientMint || undefined);
}
/** Session scope is not policy network: an authenticated Solana session is normally "solana:<address>". */
export const sessionOwner = (session: Session) => session.network + ':' + session.address;
/** A former-executor vault on a server whose native/config omits that executor: the owner cannot reach the vault here. */
export const FORMER_EXECUTOR_UNLISTED = 'This vault was set up with the former server executor, and this server no longer lists that key. Allowit must restore the former executor’s public key on the server before the owner can check, recover, revoke or return funds from this vault here. Nothing was signed.';
export async function loadNativeSupport(): Promise<{config: NativeConfig; setupReady: boolean; formerExecutorReady: boolean; ownerContinuations: boolean; purchaseHistory: boolean; revokeAndReturnFunds: boolean; recipientAnyWallet: boolean}> {
  const [metadata, value] = await Promise.all([request('native/release'), request<{capabilities?: Record<string, unknown>}>('native/config')]);
  const release = parseRelease(metadata), config = release && parseConfig(value, release.release, release.network);
  const caps = value.capabilities;
  if (!config) throw new Error('The configured deployment does not match the pinned Devnet release.');
  const base = !!caps && ['bindExistingPolicy', 'oneSignatureDeploy', 'finalizedRevoke', 'walletRecipientAta'].every(k => caps[k] === true);
  // New setup needs the agent-held executor. A vault set up with the former server executor can spend only while the
  // backend advertises managed spending: co-signing agent-held vaults holds no key that can spend from it.
  // Its owner keeps recovery, revoke and return either way, while native/config still lists the former executor.
  return {config, formerExecutorReady: base && caps.managedSpend === true, recipientAnyWallet: caps?.recipientAnyWallet === true, ownerContinuations: caps?.ownerContinuations === true, purchaseHistory: caps?.purchaseHistory === true, revokeAndReturnFunds: caps?.revokeAndReturnFunds === true, setupReady: base && caps.agentExecutor === true};
}
export async function loadBoundConfig(): Promise<NativeConfig> {
  const support = await loadNativeSupport();
  if (!support.setupReady) throw new Error('Autonomous Devnet setup is unavailable. The server must verify its native deployment and co-signing authority. No owner-signed allowance was substituted.');
  return support.config;
}
/** A separate owner deposit choice; it never rewrites the source policy or supplies a default budget. */
export function checkedFundingAmount(value: string): string {
  try {
    const amount = units(value);
    if (amount > 0n) return decimal(amount);
  } catch { /* Keep a single form error; no unsafe or rounded amount reaches bind. */ }
  throw new Error('Enter a positive amount with up to 6 decimal places.');
}
export function checkedAttachment(value: unknown, selected: SelectedPolicy, owner: string, config: NativeConfig, recipientMode?: 'wallet' | 'any-wallet', fundingAmount?: string, agent?: NativeAgent): NativeAttachment {
  const v = value as NativeAttachment | null;
  // A new vault must name exactly the chosen agent's own key; an existing one keeps the executor frozen at setup.
  if (agent && (!agent.publicKey || v?.executor !== agent.publicKey)) throw new Error('The server returned a different agent executor.');
  if (v?.executor !== undefined && (typeof v.executor !== 'string' || v.executor === owner || v.executor === config.authority || !onCurve(v.executor))) throw new Error('The server returned an invalid agent executor.');
  const mode = v?.recipientMode || undefined;
  if ((mode !== undefined && mode !== 'any-wallet') || (recipientMode === 'any-wallet' && mode !== 'any-wallet') || (recipientMode === 'wallet' && mode !== undefined)) throw new Error('The server returned a different recipient mode.');
  if (mode === 'any-wallet' && v?.recipientMint !== config.mint) throw new Error('The server returned a different dynamic recipient mint.');
  if (mode === 'any-wallet' && (v?.recipientBinding != null || v?.x402Service != null)) throw new Error('The dynamic recipient mode returned a fixed recipient binding.');
  const expected = {...executionBinding(selected, owner), ...(mode ? {recipientMode: mode, recipientMint: config.mint} : {})};
  const sourceServices = sourceWhitelist(selected.code);
  const expectedService = selectedNativeX402Service(selected, config);
  if (!v || !sameExecutionBinding(v.executionBinding, expected) || v.executionPolicyId !== selected.id || !isPolicy(v.policy)
    || v.policy.network !== selected.network || v.policy.sourceBundle !== config.release.sourceBundle || v.policy.policyArtifact !== config.release.artifacts.find(a => a.name === 'allowit_policy.so')?.sha256
    || v.paymentKind !== 'direct-token-transfer' || v.deliveryAttested !== false || !v.initialFunding
    || v.initialFunding.token !== 'USDC' || v.initialFunding.mint !== config.mint || selected.token !== 'USDC'
    || (selected.mint && selected.mint !== config.mint)) throw new Error('The server returned a different policy, owner, network or token binding.');
  let x402Service: BoundNativeX402Service | undefined;
  if (recipientMode === 'wallet') {
    if (sourceServices.length && !expectedService) throw new Error('The saved native x402 service is no longer advertised. Fork the policy before setup.');
    if (expectedService) {
      if (!sameNativeX402Service(v.x402Service, expectedService, config.mint)) throw new Error('The server returned a missing or changed x402 service binding.');
      x402Service = parseBoundNativeX402Service(v.x402Service, config.mint)!;
    } else if (v.x402Service != null) throw new Error('The server returned an unexpected x402 service binding.');
  } else if (mode === 'any-wallet' && sourceServices.length) {
    throw new Error('A saved service requires its exact recipient binding.');
  } else if (sourceServices.length === 1 && v.recipientBinding) {
    const frozen = parseBoundNativeX402Service(v.x402Service, config.mint);
    if (!frozen || frozen.id !== sourceServices[0].id || frozen.recipient !== sourceServices[0].recipient) throw new Error('The server returned a missing or changed frozen x402 service binding.');
    x402Service = frozen;
  } else if (v.x402Service != null) throw new Error('The server returned an unexpected x402 service binding.');
  const funding = units(v.initialFunding.amount);
  if (fundingAmount !== undefined && funding !== units(checkedFundingAmount(fundingAmount))) throw new Error('The native funding amount differs from the reviewed deposit.');
  const daily = units(v.policy.dailyLimit), action = units(v.policy.actionLimit);
  const sourceAction = sourceLimit(selected, 'cap_per_transaction'), sourceDaily = sourceLimit(selected, 'set_cap_per_day');
  if (sourceAction === null) throw new Error('The selected policy has no verified per-transaction limit.');
  if (recipientMode === 'wallet' && !v.recipientBinding) throw new Error('Automatic recipient token account setup is unavailable. No legacy token-account binding was substituted.');
  const recipientBinding = v.recipientBinding ? checkedRecipient(v.recipientBinding, config, sourceRecipient(selected, x402Service)) : undefined;
  if (funding <= 0n || daily <= 0n || daily > funding || daily > MAX_LIMIT_UNITS || action <= 0n || action > daily || action > sourceAction || (sourceDaily !== null && daily > sourceDaily)
    || (selected.fundingRequest && (selected.fundingRequest.token !== 'USDC' || units(selected.fundingRequest.amount) !== funding))) throw new Error('The native funding or action limit differs from the selected policy.');
  const {x402Service: _reportedX402Service, recipientMode: _reportedRecipientMode, recipientMint: _reportedRecipientMint, recipientBinding: _reportedRecipientBinding, ...attachment} = v;
  return {...attachment, ...(mode ? {recipientMode: mode, recipientMint: config.mint} : {}), ...(recipientBinding ? {recipientBinding} : {}), ...(x402Service ? {x402Service} : {}), initialFunding: {...v.initialFunding, amount: decimal(funding)}};
}
export async function bindSelectedPolicy(selected: SelectedPolicy, session: Session, config: NativeConfig, recipientMode?: 'wallet' | 'any-wallet', fundingAmount?: string, agent?: NativeAgent): Promise<NativeAttachment> {
  if (fundingAmount !== undefined) {
    fundingAmount = checkedFundingAmount(fundingAmount);
    if (selected.fundingRequest && (selected.fundingRequest.token !== 'USDC' || units(selected.fundingRequest.amount) !== units(fundingAmount))) throw new Error('The deposit differs from the policy funding request.');
  } else if (recipientMode && !selected.fundingRequest) throw new Error('Enter the USDC deposit amount before setup.');
  const service = selectedNativeX402Service(selected, config);
  if (recipientMode === 'wallet' && sourceWhitelist(selected.code).length && !service) throw new Error('The saved native x402 service is no longer advertised. Fork the policy before setup.');
  if (recipientMode === 'wallet') {
    const wallet = sourceRecipient(selected, service);
    checkedRecipient({kind: 'wallet-ata', wallet, tokenAccount: recipientTokenAccount(wallet, config.mint), mint: config.mint, network: config.network}, config);
  }
  const value = await request('native/bind', {executionPolicyId: selected.id, expectedRevision: selected.revision, expectedSourceHash: selected.sourceHash, ...(agent ? {agentId: agent.id} : {}), ...(recipientMode && service ? {x402ServiceId: service.id} : {}), ...(recipientMode ? {recipientMode} : {}), ...(fundingAmount === undefined ? {} : {fundingAmount})}, {expectedOwner: sessionOwner(session)});
  return checkedAttachment(value, selected, session.address, config, recipientMode, fundingAmount, agent);
}
/** The owner's agents. Only public keys are ever stored. */
export async function loadAgents(session: Session): Promise<NativeAgent[]> {
  const reply = await request<{agents?: unknown}>('agents', undefined, {expectedOwner: sessionOwner(session)});
  if (!Array.isArray(reply.agents)) throw new Error('The server did not return the connected agents.');
  return reply.agents.filter((a): a is NativeAgent => !!a && typeof (a as NativeAgent).id === 'string' && typeof (a as NativeAgent).name === 'string');
}
/** One agent capability for `allowit setup`. It is shown once and never stored in the page. */
export async function issueAgent(name: string, session: Session): Promise<{agent: NativeAgent; token: string}> {
  const reply = await request<{agent?: NativeAgent; token?: unknown}>('agents/token', {name}, {expectedOwner: sessionOwner(session)});
  if (!reply.agent || typeof reply.agent.id !== 'string' || typeof reply.token !== 'string' || !/^agent\.[A-Za-z0-9_.-]+$/.test(reply.token)) throw new Error('The server did not issue an agent capability.');
  return {agent: reply.agent, token: reply.token};
}
/** Read-only discovery never freezes an unbound draft. Existing attachments are reloaded through idempotent bind. */
export async function findAttachment(selected: SelectedPolicy, session: Session): Promise<boolean> {
  const expected = executionBinding(selected, session.address);
  const reply = await request<{policies: unknown[]; executionBindings: Record<string, unknown>}>('native/policies', undefined, {expectedOwner: sessionOwner(session)});
  if (!Array.isArray(reply.policies) || !reply.executionBindings || typeof reply.executionBindings !== 'object' || Array.isArray(reply.executionBindings)) throw new Error('The server did not return policy execution bindings.');
  const matches = Object.entries(reply.executionBindings).filter(([, b]) => (b as ExecutionBinding | null)?.policyId === selected.id);
  if (matches.length > 1 || matches.some(([, b]) => !sameExecutionBinding(b, {...expected, ...((b as ExecutionBinding | null)?.recipientMode === 'any-wallet' ? {recipientMode: 'any-wallet' as const, recipientMint: selected.mint || (b as ExecutionBinding).recipientMint} : {})}))) throw new Error('This vault belongs to another saved policy revision. Restore that revision or fork a new policy; its signed proofs are retained.');
  return matches.some(([id]) => reply.policies.some(p => isPolicy(p) && p.id === id));
}
export class BoundNativeAPI extends NativePolicyAPI {
  constructor(config: NativeConfig, readonly attachment: NativeAttachment, readonly session: Session, readonly current: () => boolean) {super(vaultConfig(config, attachment));}
  override async call<T>(path: string, body?: unknown): Promise<T> {
    if (!this.current()) throw new Error('The selected policy or signed-in owner changed. Recover the original vault from its own policy.');
    // A former-executor vault is bound to that server key. The server needs its public key to read, recover or revoke the
    // vault (the native SDK refuses the binding without it), so the page cannot substitute another key.
    if (!this.config?.executor) throw new Error(FORMER_EXECUTOR_UNLISTED);
    const guarded = ['native/state', 'native/export', 'native/prepare', 'native/submit', 'native/recover', 'native/import', 'native/save'].includes(path);
    const binding = this.attachment.executionBinding;
    const reply = await request<T>(path, guarded ? {...body as object, executionPolicyId: binding.policyId, expectedRevision: binding.revision, expectedSourceHash: binding.sourceHash} : body, {expectedOwner: sessionOwner(this.session)});
    if (['native/state', 'native/export'].includes(path) && typeof (reply as {revocationStarted?: unknown})?.revocationStarted !== 'boolean') throw new Error('The backend did not report the durable native revocation barrier.');
    if (path === 'native/state' && !Array.isArray((reply as {allowedServices?: unknown}).allowedServices)) throw new Error('The backend did not report the bound service and recipient constraints.');
    if (guarded && !sameExecutionBinding((reply as {executionBinding?: unknown})?.executionBinding, binding)) throw new Error('The backend changed the immutable execution binding. Original proofs remain saved.');
    if (['native/state', 'native/prepare', 'native/export'].includes(path) && ((reply as {recipientMode?: unknown})?.recipientMode || undefined) !== this.attachment.recipientMode) throw new Error('The backend changed the immutable recipient mode. Original proofs remain saved.');
    if (['native/state', 'native/prepare', 'native/export'].includes(path) && this.attachment.recipientMode === 'any-wallet' && (reply as {recipientMint?: unknown})?.recipientMint !== this.attachment.recipientMint) throw new Error('The backend changed the immutable recipient mint. Original proofs remain saved.');
    if (['native/state', 'native/prepare'].includes(path) && !sameRecipient((reply as {recipientBinding?: unknown})?.recipientBinding, this.attachment.recipientBinding)) throw new Error('The backend changed the immutable recipient binding. Original proofs remain saved.');
    if (['native/state', 'native/export'].includes(path)) {
      const expectedService = this.attachment.x402Service;
      const rawService = (reply as {x402Service?: unknown})?.x402Service;
      const actualService = rawService == null ? undefined : rawService;
      if (expectedService ? !sameNativeX402Service(actualService, expectedService, this.config!.mint) : actualService !== undefined) throw new Error('The backend changed the immutable x402 service binding. Original proofs remain saved.');
    }
    return reply;
  }
  override async save(policy: Policy) {
    if (JSON.stringify(policy) !== JSON.stringify(this.attachment.policy)) throw new Error('The native policy differs from its saved execution attachment.');
    return {policy}; // native/bind has already persisted it, including its server-derived execution binding.
  }
  override async export(policy: Policy, owner: string): Promise<{skill: string; executor: unknown; managedAgent?: ManagedAgent}> {
    const reply = await super.export(policy, owner) as {skill: string; executor: unknown; managedAgent?: ManagedAgent};
    // The agent pays with its own key through the CLI; no server-managed endpoint exists for this vault.
    if (this.attachment.executor) {
      if (reply.managedAgent !== undefined && reply.managedAgent !== null) throw new Error('The backend offered a server-managed endpoint for an agent-held vault.');
      return {skill: reply.skill, executor: reply.executor};
    }
    const managed = reply.managedAgent;
    const expectedEndpoint = new URL(this.attachment.x402Service ? '/api/native/execute' : '/api/native/spend', window.location.origin).href;
    if (!managed || managed.endpoint !== expectedEndpoint || !managed.requestSchema || typeof managed.requestSchema !== 'object' || managed.recovery !== 'repeat-identical-request' || !/^Bearer [^\s]+$/.test(managed.authorization) || managed.paymentKind !== 'direct-token-transfer' || managed.deliveryAttested !== false) throw new Error('The managed agent export is unavailable. No local executor wallet is required or substituted.');
    const expectedService = this.attachment.x402Service;
    if (expectedService ? !sameNativeX402Service(managed.x402Service, expectedService, this.config!.mint) : managed.x402Service !== undefined) throw new Error('The managed agent export changed the immutable x402 service binding.');
    return {...reply, managedAgent: managed};
  }
}
/** An approved account or HTTP success is not finality evidence. */
export function nativeStatus(reply: StateReply | null, records: readonly Operation[] = []): 'Draft' | 'Checking vault' | 'Ready' | 'Revoked' | 'Revoke pending' | 'Funds returned' {
  if (!reply) return 'Checking vault';
  if (vaultPhase(reply.state, records, reply.operations).phase === 'closed') return 'Funds returned';
  if (!reply.state) return reply.operations.length ? 'Checking vault' : 'Draft';
  if (reply.revocationStarted && reply.state.approved) return 'Revoke pending';
  const method = reply.state.approved ? 'deploy' : 'revoke';
  const instance = BigInt(reply.state.instanceSlot);
  const proof = reply.operations.some(op => op.method === method && settledOperation(op) && (method === 'deploy' ? finalizedSlot(op.finalizedSlot) === instance : finalizedSlot(op.finalizedSlot)! >= instance));
  return proof ? (reply.state.approved ? 'Ready' : 'Revoked') : 'Checking vault';
}
export function operationStatus(op: PublicOperation): string {
  if (settledOperation(op)) return op.method === 'execute' ? 'Transfer finalized · delivery not attested' : 'Finalized';
  return op.status === 'failed' ? 'Failed' : 'Pending finality';
}
