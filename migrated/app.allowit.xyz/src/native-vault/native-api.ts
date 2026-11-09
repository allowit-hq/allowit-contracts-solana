import type {Transaction} from '@solana/web3.js';
import {ApiError, request} from '../api';
import {canonicalUnsigned, DEVNET_GENESIS, decimal, isNativeNetwork, isSlotMethod, matchesPinnedRelease, PINNED_NATIVE_RELEASE, settledOperation, supersededOwner, units, type AllowedService, type Binding, type BoundNativeX402Service, type NativeConfig, type NativeDeployment, type NativeNetwork, type NativeRelease, type Operation, type OwnerMethod, type Policy, type PolicyOptions, type Prepared, type PublicOperation, type VaultState} from './native-contracts';
import type {NativeJournal, PreparationPointer} from './native-journal';
import {checkedOwnerTransaction, nativeBinding, signedProof} from './native-wallet-intent';
import {parseConfig, parseRelease} from './native-vault';

const DEPLOYMENT_KEYS = ['network', 'sourceBundle', 'policy', 'policyData', 'custody'] as const;
const BINDING_KEYS = ['owner', 'executor', 'authority', 'mint', 'vault', 'tokenAccount', 'policy', 'policyData', 'custody', 'bump'] as const;

/** Shape checks only: the backend validates identity, release and digests. */
export function isPolicy(value: unknown): value is Policy {
  const p = value as Partial<Policy> | null;
  return !!p && p.version === 2 && p.profile === 'solana-native-v2' && isNativeNetwork(p.network) && typeof p.id === 'string' && /^[0-9a-f]{64}$/.test(p.id)
    && typeof p.instance === 'string' && p.instance.length > 0
    && typeof p.prompt === 'string' && typeof p.dailyLimit === 'string' && typeof p.actionLimit === 'string' && typeof p.rust === 'string' && typeof p.payDiscovery === 'boolean'
    && typeof p.semanticRequired === 'boolean' && [p.executionPolicyDigest, p.executionRequirementsDigest, p.sourceBundle, p.policyArtifact].every(d => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d));
}
function checkPolicyRelease(policy: unknown): asserts policy is Policy {
  if (!isPolicy(policy) || policy.sourceBundle !== PINNED_NATIVE_RELEASE.sourceBundle || policy.policyArtifact !== PINNED_NATIVE_RELEASE.artifacts.find(a => a.name === 'allowit_policy.so')?.sha256) throw new Error('The policy does not match the pinned Devnet release');
}
/** Loads public metadata only; callers must still verify the actual deployment before signing. */
export async function loadNativeConfig(): Promise<NativeConfig> {
  const [metadata, value] = await Promise.all([request('native/release'), request('native/config')]);
  const release = parseRelease(metadata);
  const config = release && parseConfig(value, release.release, release.network);
  if (!config) throw new Error('The configured deployment does not match the pinned Devnet release');
  return config;
}
export async function validatePolicy(policy: unknown): Promise<Policy> {
  checkPolicyRelease(policy);
  const checked = (await request<{policy: unknown}>('native/validate', {policy})).policy;
  if (!isPolicy(checked) || JSON.stringify(checked) !== JSON.stringify(policy)) throw new Error('The backend returned a different policy');
  return checked;
}

export interface StateReply {state: VaultState | null; binding: Binding; operations: PublicOperation[]; allowedServices: AllowedService[]; revocationStarted?: boolean; x402Service?: BoundNativeX402Service}

const isAllowedServices = (value: unknown): value is AllowedService[] =>
  Array.isArray(value) && value.every(s => !!s && typeof s.id === 'string' && typeof s.recipient === 'string');
const sameServices = (a: readonly AllowedService[], b: readonly AllowedService[]) =>
  a.length === b.length && a.every((s, i) => s.id === b[i].id && s.recipient === b[i].recipient);
const hasFinalizedSlot = (op: PublicOperation) => canonicalUnsigned(op.finalizedSlot)
  || (typeof op.finalizedSlot === 'number' && Number.isSafeInteger(op.finalizedSlot) && op.finalizedSlot >= 0);

export class NativePolicyAPI {
  constructor(readonly config: NativeConfig | null) {}
  call<T>(path: string, body?: unknown): Promise<T> {return request<T>(path, body);}
  async verifyRelease(recovery = false): Promise<NativeDeployment> {
    if (!this.config || !isNativeNetwork(this.config.network) || this.config.genesis !== DEVNET_GENESIS || !matchesPinnedRelease(this.config.release)) throw new Error('The backend did not verify the selected native release');
    const verified = await this.call<{verified: boolean; verification: string; network: string; sourceBundle: string; config: {network: string; mint: string; executor: string; authority: string; deployment: NativeDeployment}}>('native/verify', {recovery});
    const c = this.config, v = verified.config;
    if (!c || verified.verified !== true || verified.network !== c.network || verified.sourceBundle !== c.release.sourceBundle || v?.network !== c.network || v.mint !== c.mint || v.authority !== c.authority
      || DEPLOYMENT_KEYS.some(k => v.deployment?.[k] !== c.deployment[k]) || !['full', 'recovery-only'].includes(verified.verification) || (!recovery && verified.verification !== 'full')) throw new Error('The backend did not verify the selected native release');
    return v.deployment;
  }
  /**
   * Numeric generation: the prompt carries the daily limit; the per-action limit is always sent explicitly. A PaySH
   * whitelist is bound into the server's execution policy, which the policy digest identifies.
   */
  async generate(input: {network: NativeNetwork; prompt: string; actionLimit: string; payDiscovery: boolean; allowedServices: AllowedService[]}): Promise<{policy: Policy; allowedServices: AllowedService[]}> {
    if (!isNativeNetwork(input.network) || (this.config && this.config.network !== input.network)) throw new Error('Choose the configured Devnet release');
    const actionLimit = decimal(units(input.actionLimit));
    const reply = await this.call<{policy: unknown; allowedServices?: unknown}>('native/generate', {network: input.network, prompt: input.prompt, actionLimit, payDiscovery: input.payDiscovery, allowedServices: input.allowedServices});
    const {policy} = reply, allowedServices = reply.allowedServices ?? [];
    checkPolicyRelease(policy);
    if (!isPolicy(policy) || policy.network !== input.network || policy.prompt !== input.prompt || policy.actionLimit !== actionLimit || policy.payDiscovery !== input.payDiscovery || policy.semanticRequired
      || !isAllowedServices(allowedServices) || !sameServices(allowedServices, input.allowedServices)) throw new Error('The backend generated a different policy than requested');
    return {policy, allowedServices};
  }
  /** Numeric policies omit `executionPolicyId`; the backend recomputes their binding from the prompt. */
  async save(policy: Policy) {
    checkPolicyRelease(policy);
    const reply = await this.call<{policy: Policy}>('native/save', {policy});
    if (JSON.stringify(reply.policy) !== JSON.stringify(policy)) throw new Error('The backend saved a different policy');
    return reply;
  }
  async list(): Promise<Policy[]> {
    const reply = await this.call<{policies: unknown}>('native/policies');
    if (!Array.isArray(reply.policies)) throw new Error('The backend returned an invalid policy list');
    for (const policy of reply.policies) checkPolicyRelease(policy);
    return reply.policies;
  }
  private checkBinding(policy: Policy, owner: string, binding: Binding | undefined) {
    if (binding?.owner !== owner) throw new Error('Connect the policy owner before reading this vault');
    if (!this.config) throw new Error('Native configuration is unavailable');
    const expected = nativeBinding(this.config, policy, owner);
    if (BINDING_KEYS.some(k => binding[k] !== expected[k])) throw new Error('The backend returned a different vault binding');
  }
  async state(policy: Policy, owner: string, recoverClosure = false): Promise<StateReply> {
    await this.save(policy);
    const read = async (): Promise<StateReply> => {
      const reply = await this.call<StateReply>('native/state', {policyId: policy.id});
      this.checkBinding(policy, owner, reply.binding);
      const s = reply.state;
      if (s !== null && (!s || typeof s !== 'object' || Array.isArray(s))) throw new Error('The backend returned an invalid vault state');
      if (s && (s.vaultId !== policy.id || s.sourceBundle !== policy.sourceBundle || s.policyArtifact !== policy.policyArtifact || BINDING_KEYS.some(k => s[k] !== reply.binding[k]))) throw new Error('The vault on chain belongs to another policy or binding');
      if (s && (s.abi !== 2 || typeof s.approved !== 'boolean' || ![s.dailyLimit, s.actionLimit, s.spent, s.spentDay, s.nonce, s.revision, s.instanceSlot, s.balance].every(canonicalUnsigned))) throw new Error('The backend returned an invalid vault state');
      if (reply.revocationStarted !== undefined && typeof reply.revocationStarted !== 'boolean') throw new Error('The backend returned an invalid revocation barrier');
      if (reply.allowedServices !== undefined && !isAllowedServices(reply.allowedServices)) throw new Error('The backend returned an invalid service whitelist');
      if (!Array.isArray(reply.operations) || reply.operations.some(op => !op || typeof op.id !== 'string' || typeof op.method !== 'string' || typeof op.status !== 'string' || (op.policyId !== undefined && op.policyId !== policy.id))) throw new Error('The backend returned operations for a different policy');
      return {state: s ?? null, binding: reply.binding, ...(reply.revocationStarted === undefined ? {} : {revocationStarted: reply.revocationStarted}), ...(reply.x402Service == null ? {} : {x402Service: reply.x402Service}), operations: Array.isArray(reply.operations) ? reply.operations : [], allowedServices: isAllowedServices(reply.allowedServices) ? reply.allowedServices : []};
    };
    const reply = await read();
    if (!recoverClosure || reply.state || !reply.operations.some(op => op.method === 'close' && op.status === 'settled')) return reply;
    // Older server journals lack receipt slots. The server retains their exact signed proofs: recovery only observes
    // finalized receipts, without importing browser metadata, signing or broadcasting. Bound work per owner refresh.
    const legacy = reply.operations.filter(op => typeof op.signature === 'string'
      && ((op.method === 'deploy' && (op.status === 'uncertain' || op.status === 'submitted'))
        || ((op.method === 'deploy' || op.method === 'close') && op.status === 'settled' && !hasFinalizedSlot(op)))).slice(0, 16);
    for (const op of legacy) {
      try {await this.call('native/recover', {policyId: policy.id, requestId: op.id});}
      catch { /* Missing or unavailable receipts leave closure unproven. The next state read remains authoritative. */ }
    }
    return legacy.length ? read() : reply;
  }
  async export(policy: Policy, owner: string): Promise<{skill: string; executor: unknown; x402Service?: BoundNativeX402Service}> {
    await this.save(policy);
    const reply = await this.call<{binding: Binding; skill: string; executor: unknown; x402Service?: BoundNativeX402Service}>('native/export', {policyId: policy.id});
    this.checkBinding(policy, owner, reply.binding);
    if (typeof reply.skill !== 'string' || !reply.executor || typeof reply.executor !== 'object') throw new Error('The backend returned an invalid executor export');
    return reply;
  }
}

const isRecord = (record: unknown): record is Operation => !!record && typeof record === 'object' && typeof (record as Operation).signedBytes === 'string';
const terminal = (record: Operation) => record.status === 'settled' || record.status === 'failed';
const amountOf = (options: PolicyOptions) => (options.amount === undefined ? null : decimal(units(options.amount)));
const slotOf = (method: string, options: PolicyOptions) => (method === 'close' ? options.instanceSlot ?? null : null);
/** One owner intent. Closing names the vault incarnation, so a close for an earlier instance never matches a new vault. */
export const ownerIdentity = (owner: string, policyId: string, method: OwnerMethod, options: PolicyOptions) =>
  JSON.stringify({owner, policyId, method, amount: amountOf(options), instanceSlot: slotOf(method, options), ...(options.recipientWallet === undefined ? {} : {recipientWallet: options.recipientWallet})});
/** Only the backend's observations are taken; the journaled proof fields, including the string instance slot, stay exact. */
function observed(prior: Operation, operation: Partial<Operation>): Operation {
  const intent = JSON.parse(prior.intent);
  if (operation.id !== prior.id || operation.signature !== prior.signature || operation.method !== prior.method || operation.policyId !== intent.policyId) throw new Error('The backend returned a different operation proof');
  let status = ['uncertain', 'submitted', 'settled', 'failed'].includes(operation.status as string) ? operation.status! : prior.status;
  if (status === 'settled' && !settledOperation(operation as Operation)) status = 'uncertain';
  const extra = Object.fromEntries(['supersededBy', 'decisionCode', 'absence', 'error'].filter(k => operation[k] !== undefined).map(k => [k, operation[k]]));
  return {...prior, ...extra, ...(status === 'settled' ? {finalizedSlot: operation.finalizedSlot} : {}), status, blockhashExpired: operation.blockhashExpired === true};
}
const intentSlot = (intent: {instanceSlot?: unknown}) => (intent.instanceSlot === null || intent.instanceSlot === undefined ? null : String(intent.instanceSlot));
export interface PreparationStatus {id: string; status?: string; blockhashExpired?: boolean; additionalOwnerOperationAllowed?: boolean; retryPreparationAllowed?: boolean; supersededBy?: string}
export type Signer = (transaction: Transaction, role: 'owner' | 'executor') => Promise<Transaction>;
export type Progress = (phase: 'preparing' | 'signing' | 'sending') => void;

/** The browser signs and journals. Only the backend prepares, broadcasts and reconciles. */
export class NativePolicyLifecycle {
  constructor(readonly api: NativePolicyAPI, readonly journal: NativeJournal, readonly sign: Signer) {}
  private checkOriginal(prior: Operation, policy: Policy, owner: string) {
    const intent = JSON.parse(prior.intent);
    if (intent.owner !== owner || intent.policyId !== policy.id || intent.network !== policy.network) throw new Error('The saved proof belongs to another owner or policy');
  }
  private sameIntent(original: {method?: unknown; amount?: unknown; instanceSlot?: unknown; recipientWallet?: unknown}, method: OwnerMethod, options: PolicyOptions) {
    return original.method === method && original.amount === amountOf(options) && intentSlot(original) === slotOf(method, options) && original.recipientWallet === options.recipientWallet;
  }
  async preparationStatus(policy: Policy, owner: string, method: OwnerMethod): Promise<PreparationStatus | null> {
    const kept = await this.journal.read<{id: string; prepared: Prepared}>('prepared-' + method);
    const preparing = kept ?? await this.journal.read<{id: string; identity: string}>('preparing-' + method);
    if (!preparing) return null;
    const intent = kept ? JSON.parse(kept.prepared.intent) : JSON.parse((preparing as {identity: string}).identity);
    if (intent.owner !== owner || intent.policyId !== policy.id) throw new Error('The saved preparation belongs to another owner or policy');
    const {operation} = await this.api.call<{operation: PreparationStatus}>('native/recover', {policyId: policy.id, requestId: preparing.id});
    if (operation.id !== preparing.id) throw new Error('The backend returned a different preparation');
    return operation;
  }
  private async reconcile(prior: Operation, policy: Policy): Promise<Operation> {
    // Import validates the exact original proof and never broadcasts it. It is never replaced.
    await this.api.call('native/import', {policy, record: prior});
    const {operation} = await this.api.call<{operation: Partial<Operation>}>('native/recover', {policyId: policy.id, requestId: prior.id});
    if (operation.id !== prior.id || operation.signature !== prior.signature) throw new Error('The backend returned a different operation proof');
    const result = observed(prior, operation);
    await this.journal.write('request-' + prior.id, result);
    return result;
  }
  private async replayRecord(prior: Operation, policy: Policy, owner: string): Promise<Operation> {
    this.checkOriginal(prior, policy, owner);
    const reconciled = await this.reconcile(prior, policy);
    if (terminal(reconciled) || reconciled.blockhashExpired) return reconciled;
    const {operation} = await this.api.call<{operation: Partial<Operation>}>('native/submit', {policyId: policy.id, requestId: prior.id, signedBytes: reconciled.signedBytes});
    if (operation.id !== prior.id || operation.signature !== prior.signature) throw new Error('The backend returned a different operation proof');
    const result = observed(reconciled, operation);
    await this.journal.write('request-' + prior.id, result);
    return result;
  }
  /** Status/reload may resend an original signed proof unchanged. This path cannot prepare or open a wallet. */
  async replay(id: string, policy: Policy, owner: string): Promise<Operation> {
    return this.journal.locked(async () => {
      const prior = await this.journal.read('request-' + id);
      if (!isRecord(prior)) throw new Error('No original signed proof is saved for this request');
      return this.replayRecord(prior, policy, owner);
    });
  }
  async submit(policy: Policy, owner: string, method: OwnerMethod, options: PolicyOptions = {}, requestId?: string, progress?: Progress): Promise<Operation> {
    const config = this.api.config;
    if (!config) throw new Error('Native configuration is unavailable');
    if (method === 'close' && !options.instanceSlot) throw new Error('Read the current vault before closing it');
    const identity = ownerIdentity(owner, policy.id, method, options);
    let id = requestId ?? crypto.randomUUID();
    const slot = isSlotMethod(method);
    return this.journal.locked(async () => {
      const explicitPrior = requestId ? await this.journal.read('request-' + requestId) : null;
      if (isRecord(explicitPrior)) {
        if (!this.sameIntent(JSON.parse(explicitPrior.intent), method, options)) throw new Error('Recover the original request before changing its intent');
        return this.replayRecord(explicitPrior, policy, owner);
      }
      const unsigned = await this.journal.read<PreparationPointer & {prepared: Prepared}>('prepared-' + method);
      const preparing = await this.journal.read<PreparationPointer & {identity: string}>('preparing-' + method);
      const retained = unsigned ?? preparing;
      const continuingSuccessor = !!retained?.options && this.sameIntent(unsigned ? JSON.parse(unsigned.prepared.intent) : JSON.parse(preparing!.identity), method, options)
        && ((!options.additionalOwnerOperation && !options.retryPreparationOf) || !requestId || requestId === retained.id)
        && (retained.options.additionalOwnerOperation === true || !!retained.options.retryPreparationOf);
      if (continuingSuccessor) options = {...options, ...retained!.options};
      const retryPreparation = !continuingSuccessor && !!retained && options.retryPreparationOf === retained.id && !slot;
      const additional = !continuingSuccessor && !!retained && slot && options.additionalOwnerOperation === true;
      if (!unsigned && preparing && !additional && !retryPreparation) {
        if (preparing.identity !== identity) throw new Error('Retry the original preparation before changing its intent');
        id = preparing.id;
      }
      if (unsigned && !additional && !retryPreparation) {
        checkedOwnerTransaction(config, policy, owner, method, options, unsigned.prepared);
        id = unsigned.id;
      }
      if (retained && retryPreparation) {
        const status = await this.preparationStatus(policy, owner, method);
        if (status?.blockhashExpired !== true || (status.retryPreparationAllowed !== true && status.supersededBy !== id)) throw new Error('The original preparation has not been verified expired');
        if (id === retained.id) throw new Error('An explicit retry needs its own request identity');
        await this.journal.write('preparation-' + retained.id, retained);
        const retry = await this.journal.read<{id: string; identity: string}>('retry-' + method);
        if (retry && retry.identity !== identity) throw new Error('Retry the same owner intent');
        id = retry?.id ?? id;
        await this.journal.write('retry-' + method, {id, identity});
      }
      if (retained && additional) {
        const status = await this.preparationStatus(policy, owner, method);
        if (status?.blockhashExpired !== true || status.additionalOwnerOperationAllowed !== true) throw new Error('The original preparation has not been verified expired');
        await this.journal.write('preparation-' + retained.id, retained);
        const retry = await this.journal.read<{id: string; identity: string}>('additional-' + method);
        if (retry && retry.identity !== identity) throw new Error('Retry the original additional operation before changing its intent');
        id = retry?.id ?? id;
        if (id === retained.id) throw new Error('An additional operation needs its own request identity');
        await this.journal.write('additional-' + method, {id, identity});
      }
      if (retained && !additional && !retryPreparation) {
        let status: PreparationStatus | null;
        try {status = await this.preparationStatus(policy, owner, method);}
        catch (error) {
          // An explicit same-intent retry may replay the same ID after a lost prepare reply.
          // Absence cannot discard a full preparation or an original signed proof.
          if (!unsigned && preparing && error instanceof ApiError && error.status === 404) status = null;
          else throw error;
        }
        if (status?.blockhashExpired === true) throw new Error('The original preparation expired. Keep it and authorize an additional owner operation explicitly.');
      }
      const prior = await this.journal.read('request-' + id);
      if (isRecord(prior)) {
        this.checkOriginal(prior, policy, owner);
        if (!this.sameIntent(JSON.parse(prior.intent), method, options)) throw new Error('Recover the original request before changing its intent');
        return this.replayRecord(prior, policy, owner);
      }
      {
        for (const kept of await this.journal.entries()) {
          if (kept.method !== method || terminal(kept)) continue;
          this.checkOriginal(kept, policy, owner);
          const original = await this.reconcile(kept, policy);
          if (!terminal(original) && !supersededOwner(original, await this.journal.entries()) && !(slot && original.blockhashExpired === true && options.additionalOwnerOperation === true)) throw new Error('An earlier owner operation is unresolved. Recover its original proof first.');
        }
      }
      // Keep a lost-reply original reachable while its additional/retry request is pending.
      // The separate additional/retry pointer already retains the new request identity.
      if (!(preparing && retained === preparing && (additional || retryPreparation))) {
        await this.journal.write('preparing-' + method, {id, identity, options: {additionalOwnerOperation: options.additionalOwnerOperation, retryPreparationOf: options.retryPreparationOf}});
      }
      progress?.('preparing');
      await this.api.save(policy);
      const executionOptions = {
        ...(options.amount === undefined ? {} : {amount: decimal(units(options.amount))}),
        ...(method === 'close' ? {instanceSlot: Number(options.instanceSlot)} : {}),
        ...(options.additionalOwnerOperation ? {additionalOwnerOperation: true} : {}),
      };
      let prepared: Prepared;
      try {
        prepared = await this.api.call<Prepared>('native/prepare', {policyId: policy.id, requestId: id, method, options: executionOptions, ...(options.retryPreparationOf ? {retryPreparationOf: options.retryPreparationOf} : {})});
      } catch (error) {
        // A completed rejection plus authoritative absence permits correcting form input.
        // Absence alone never cancels a timed-out or still-running preparation.
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          try {await this.api.call('native/recover', {policyId: policy.id, requestId: id});}
          catch (absence) {
            if (absence instanceof ApiError && absence.status === 404) {
              for (const prefix of ['preparing-', 'additional-', 'retry-']) {
                const pointer = await this.journal.read<{id: string}>(prefix + method);
                if (pointer?.id === id) await this.journal.clear(prefix + method);
              }
            }
          }
        }
        throw error;
      }
      if (prepared.operation.id !== id) throw new Error('The backend changed the request identity');
      const transaction = checkedOwnerTransaction(config, policy, owner, method, options, prepared);
      await this.journal.write('prepared-' + method, {id, prepared, options: {additionalOwnerOperation: options.additionalOwnerOperation, retryPreparationOf: options.retryPreparationOf}});
      await this.journal.clear('additional-' + method);
      await this.journal.clear('retry-' + method);
      // Public metadata is not a chain acceptance witness. The SDK verifies the Devnet genesis,
      // immutable program bytes and mint immediately before this browser opens the owner wallet.
      await this.api.verifyRelease(method === 'revoke' || method === 'withdraw' || method === 'close');
      progress?.('signing');
      const signed = signedProof(prepared, await this.sign(transaction, 'owner'), config.network);
      progress?.('sending');
      // Commit each durable pointer before submit. Storage failure prevents broadcast.
      await this.journal.write('request-' + id, signed);
      if (slot) await this.journal.write('owner-slot-' + method, {id});
      await this.journal.write('last', {id});
      await this.journal.clear('prepared-' + method);
      await this.journal.clear('preparing-' + method);
      await this.journal.clear('additional-' + method);
      try {
        const {operation} = await this.api.call<{operation: Partial<Operation>}>('native/submit', {policyId: policy.id, requestId: id, signedBytes: signed.signedBytes});
        if (operation.id !== id || operation.signature !== signed.signature) throw new Error('The backend returned a different operation proof');
        const result = observed(signed, operation);
        await this.journal.write('request-' + id, result);
        return result;
      } catch {return signed;}
    });
  }
  async recover(id: string, policy: Policy, owner: string): Promise<Operation> {
    return this.journal.locked(async () => {
      const prior = await this.journal.read('request-' + id);
      if (!isRecord(prior)) throw new Error('Unknown signed request. Preserve its original journal before recovery');
      this.checkOriginal(prior, policy, owner);
      return this.reconcile(prior, policy);
    });
  }
  /** Bounded status observation only. Never prepares, signs or rebroadcasts. */
  async recoverPending(policy: Policy, owner: string, current: () => boolean, records?: readonly Operation[]): Promise<boolean> {
    if (!current()) return false;
    const pending = (records ?? await this.journal.entries()).filter(record => !settledOperation(record) && record.status !== 'failed').slice(0, 16);
    for (const record of pending) {
      if (!current()) return false;
      await this.recover(record.id, policy, owner);
    }
    return current();
  }
}
export type {NativeRelease};

