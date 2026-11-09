import {confirmSetup, resendSetup, signPrepared, type SetupApi, type SetupJournal, type SetupOutcome} from '../paysh/paysh-api';
import {parseDeployment, parseDraft, parsePrepared, parseSetupState, isPayshNetwork, sol, type PayshDeployment, type PolicyDraft, type PreparedSetup, type SetupState} from '../paysh/paysh-contracts';
import {checkedSetup, type CheckedSetup, type SignedSetup} from '../paysh/paysh-wallet-intent';
import type {MicroPolicy} from '../micro/micro-contracts';
import {newSetupAllowed, runtimeOf} from './runtime';
import {checkBindingConfig, checkSourceBinding, parseSourceBinding, type SourceBinding} from './source-binding';
import type {BindingStore} from './setup-bindings';
import {boundDeposit} from './deposit';
import type {ServiceApprovalStore} from './service-approvals';
import {sameServiceIds, serviceIds} from '../paysh/service-allowlist';

/**
 * Contract-wallet setup through the common policy routes. The wire format, the transaction check, the Ed25519 proof,
 * the durable journal and the same-bytes resend are the existing PaySH functions, unchanged; only the transport is the
 * common `micro/allocation/*` route. The browser signs and never sends: the server broadcasts the journaled bytes.
 *
 * One ID: the common policy ID is the generated draft's ID, its native policy ID and the Config instance ID, and it is
 * recomputed from the draft's source binding. No ID is mapped onto another, so the proof, journal key and signed
 * identity are all that ID.
 */

export class SetupContractError extends Error {}
const fail = (field: string, what = 'is missing or invalid') => new SetupContractError(`The setup reply field ${field} ${what}.`);
type Json = Record<string, unknown>;
const record = (value: unknown, field: string): Json => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(field);
  return value as Json;
};
const HEX64 = /^[0-9a-f]{64}$/;
const setupProfile = (profile: unknown) => profile === 'solana-paysh-v1' || profile === 'solana-paysh-v2';

export interface MicroIdentity {id: string; revision: number}
/** One prepared setup: the exact generated draft and its binding, the public deployment and the unsigned transaction. */
export interface PreparedContractSetup {policyId: string; revision: number; requestId: string; preparationId: string; profile: string; draft: PolicyDraft; binding: SourceBinding; deployment: PayshDeployment; prepared: PreparedSetup; checked: CheckedSetup}
/** What a check or resend needs after a reload: the reviewed draft, its binding and the public deployment. */
export type SetupContext = Pick<PreparedContractSetup, 'policyId' | 'revision' | 'requestId' | 'draft' | 'binding' | 'deployment'>;

/** A reply's revision, when it states one, must be this revision; an absent field is not filled in. */
function sameRevision(s: Json, revision: number) {
  if (s.revision !== undefined && s.revision !== revision) throw fail('setup.revision', 'belongs to another revision');
}

/** `micro/allocation/prepare` → `{policies, setup}`. Every field must name this policy, request and owner. */
export function parsePreparedSetup(value: unknown, policy: MicroIdentity, requestId: string, owner: string): Omit<PreparedContractSetup, 'checked'> & {raw: {draft: unknown; deployment: unknown}} {
  const s = record(record(value, 'reply').setup, 'setup');
  if (s.policyId !== policy.id) throw fail('setup.policyId', 'belongs to another policy');
  if (s.requestId !== requestId) throw fail('setup.requestId', 'belongs to another request');
  sameRevision(s, policy.revision);
  if (!setupProfile(s.profile)) throw fail('setup.profile', 'is not the contract-wallet profile');
  if (s.phase !== 'prepared') throw fail('setup.phase', 'is not prepared');
  if (typeof s.preparationId !== 'string' || !s.preparationId || s.preparationId.length > 200) throw fail('setup.preparationId');
  const draft = parseDraft(s.draft);
  // A new common setup without its binding is refused, never treated as an earlier format.
  const binding = parseSourceBinding(record(s.draft, 'setup.draft').commonPolicyBinding);
  if (s.profile !== binding.walletProfile) throw fail('setup.profile', 'differs from the source binding');
  const deployment = parseDeployment(s.deployment, draft.policy.network);
  const prepared = parsePrepared(s.prepared);
  if (draft.draftId !== policy.id || draft.policy.id !== policy.id) throw fail('setup.draft.policy.id', 'is not this policy’s ID');
  if (prepared.requestId !== requestId) throw fail('setup.prepared.requestId', 'belongs to another request');
  if (draft.policy.owner !== owner) throw fail('setup.draft.policy.owner', 'belongs to another owner');
  if (!isPayshNetwork(draft.policy.network)) throw fail('setup.draft.policy.network', 'is not an enabled Solana contract-wallet network');
  // The fixed deployment module, not a digest of the generated source.
  if (draft.policy.moduleDigest !== deployment.moduleDigest) throw fail('setup.draft.policy.moduleDigest', 'differs from the deployment');
  return {policyId: policy.id, revision: policy.revision, requestId, preparationId: s.preparationId, profile: s.profile as string, draft, binding, deployment, prepared, raw: {draft: s.draft, deployment: s.deployment}};
}

/** Submit and confirm replies wrap the existing setup state as `setup.state`, for this exact policy and request. */
export function parseSetupReply(value: unknown, policy: MicroIdentity, requestId: string): SetupState {
  const s = record(record(value, 'reply').setup, 'setup');
  if (s.policyId !== policy.id) throw fail('setup.policyId', 'belongs to another policy');
  if (s.requestId !== requestId) throw fail('setup.requestId', 'belongs to another request');
  sameRevision(s, policy.revision);
  if (s.draft !== undefined && record(s.draft, 'setup.draft').draftId !== policy.id) throw fail('setup.draft.draftId', 'belongs to another policy');
  if (s.state === undefined) throw fail('setup.state');
  return parseSetupState(s.state);
}

export {boundDeposit} from './deposit';

/**
 * The prepared deposit must equal the deposit bound at generation. A mismatch stops before the wallet opens, and the
 * policy is never regenerated or refunded from another source on the owner's behalf.
 */
export function checkDeposit(policy: Pick<MicroPolicy, 'fundingRequest' | 'runtime' | 'network'>, draft: PolicyDraft) {
  if (boundDeposit(policy) !== BigInt(draft.policy.allocationLamports)) throw new SetupContractError(`The prepared deposit of ${sol(draft.policy.allocationLamports)} differs from this policy. Nothing was signed. Start a new draft to change the deposit.`);
}

/** Sends one common route. */
export type Send = (path: string, body: unknown) => Promise<unknown>;

/**
 * The common routes in the existing `SetupApi` shape, for this one policy ID. `stillCurrent` is checked before every
 * submit: after an owner change a signed proof stays saved and nothing is broadcast.
 */
export function commonSetupApi(send: Send, policy: MicroIdentity, stillCurrent: () => boolean): SetupApi {
  const same = (id: string) => {if (id !== policy.id) throw new SetupContractError('The setup names a different policy.');};
  return {
    prepare: async () => {throw new SetupContractError('Prepare through the policy funding step.');},
    submit: async (id, requestId, signedBytes) => {
      same(id);
      if (!stillCurrent()) throw new SetupContractError('The signed-in wallet changed. The signed setup is saved; sign in as its owner and check its status.');
      return parseSetupReply(await send('micro/allocation/submit', {id: policy.id, revision: policy.revision, requestId, signedBytes}), policy, requestId);
    },
    confirm: async (id, requestId) => {
      same(id);
      return parseSetupReply(await send('micro/allocation/confirm', {id: policy.id, revision: policy.revision, requestId}), policy, requestId);
    },
    archive: async () => {throw new SetupContractError('Archiving a signed setup is not available here.');},
  };
}

/** Serializes one owner-policy setup across tabs. Fails closed where the browser cannot serialize. */
export type SetupLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
export const browserLock: SetupLock = async (name, fn) => {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (!locks?.request) throw new SetupContractError('This browser cannot coordinate setup between tabs, so nothing was signed. Use a current browser.');
  return locks.request(`allowit-setup:${name}`, {ifAvailable: true}, async lock => {
    if (!lock) throw new SetupContractError('Setup for this policy is open in another tab. Finish or close it there first.');
    return fn();
  });
};

export {browserBindings, type BindingStore, type SetupBinding} from './setup-bindings';

export interface SetupDeps {send: Send; journal: SetupJournal; bindings: BindingStore; lock: SetupLock; newId: () => string; serviceApprovals?: ServiceApprovalStore}

function checkSelectedServices(deps: SetupDeps, owner: string, policy: MicroPolicy) {
  const approved = deps.serviceApprovals?.read(owner, policy.id);
  if (!approved) return;
  if (approved.rejected) throw new SetupContractError('This draft did not match your service selection and cannot be funded. Start a new draft.');
  const r = runtimeOf(policy);
  if (r.state !== 'typed' || r.runtime.wallet.profile !== 'solana-paysh-v2' || !sameServiceIds(serviceIds(r.runtime.providerCallRequirements?.map(q => q.service_id)), approved.requestedServiceIds)) throw new SetupContractError('This policy’s services differ from your saved selection. Nothing was signed.');
}

/** The saved signed proof for this policy ID, if any. Read before anything else renders in Funding. */
export async function findProof(deps: SetupDeps, owner: string, policy: Pick<MicroPolicy, 'id'>): Promise<SignedSetup | null> {
  const proof = await deps.journal.read(owner, policy.id);
  return proof && proof.owner === owner && proof.policyId === policy.id ? proof : null;
}

function contractPolicy(policy: MicroPolicy) {
  const r = runtimeOf(policy);
  if (r.state !== 'typed' || r.kind !== 'contract-wallet' || !r.capabilities.fund) throw new SetupContractError('This policy’s wallet does not support contract-wallet funding.');
  if (!setupProfile(r.runtime.wallet.profile)) throw new SetupContractError('This policy’s wallet profile cannot be funded here.');
  if (!isPayshNetwork(policy.network)) throw new SetupContractError('Contract-wallet setup requires Solana Testnet or an enabled private validator.');
  if (!HEX64.test(policy.id)) throw new SetupContractError('This policy’s ID is not a setup instance ID, so it cannot be funded here.');
  return r.runtime;
}

/**
 * Prepares the setup and checks the exact transaction and every source-binding field. Nothing is signed. The request
 * ID is saved before the route is called, so a repeated prepare returns the same preparation; without storage nothing
 * is prepared.
 */
export async function prepareContractSetup(deps: SetupDeps, owner: string, policy: MicroPolicy): Promise<{reply: unknown; setup: PreparedContractSetup}> {
  checkSelectedServices(deps, owner, policy);
  const runtime = contractPolicy(policy);
  if (!newSetupAllowed(policy)) throw new SetupContractError('This policy already has a setup or has ended. Nothing new can be prepared. Read its saved status.');
  boundDeposit(policy);
  if (await findProof(deps, owner, policy)) throw new SetupContractError('A signed setup is already saved for this policy. Check its status first.');
  const saved = deps.bindings.read(owner, policy.id);
  const requestId = runtime.setup?.requestId ?? (saved?.revision === policy.revision ? saved.requestId : undefined) ?? deps.newId();
  if (!deps.bindings.write(owner, policy.id, {requestId, revision: policy.revision})) throw new SetupContractError('This browser cannot save the setup request, so nothing was prepared. Allow site storage and retry.');
  const identity = {id: policy.id, revision: policy.revision};
  const reply = await deps.send('micro/allocation/prepare', {...identity, requestId});
  const parsed = parsePreparedSetup(reply, identity, requestId, owner);
  checkDeposit(policy, parsed.draft);
  await checkSourceBinding(parsed.binding, policy, owner, parsed.draft);
  const checked = checkedSetup(parsed.deployment, parsed.draft, owner, requestId, parsed.prepared);
  if (!deps.bindings.write(owner, policy.id, {requestId, revision: policy.revision, draft: parsed.raw.draft, deployment: parsed.raw.deployment})) throw new SetupContractError('This browser cannot save the setup request, so nothing can be signed. Allow site storage and retry.');
  if (await findProof(deps, owner, policy)) throw new SetupContractError('A signed setup is already saved for this policy. Check its status first.');
  const {raw: _raw, ...setup} = parsed;
  return {reply, setup: {...setup, checked}};
}

/**
 * The current policy, owner and selection must still be the ones the setup was prepared for. Prepared terms for an
 * earlier source, revision, runtime or owner are never signed.
 */
async function stillBound(setup: SetupContext, owner: string, latest: () => MicroPolicy | null, stillCurrent: () => boolean, requireDraft = false) {
  const changed = () => new SetupContractError('The policy or signed-in wallet changed after this setup was prepared. Nothing was signed. Prepare it again.');
  const policy = latest();
  if (!stillCurrent() || !policy || policy.id !== setup.policyId || policy.revision !== setup.revision) throw changed();
  if ((requireDraft && !newSetupAllowed(policy)) || (policy.status !== 'draft' && policy.status !== 'active')) throw changed();
  const before = boundTerms(policy);
  contractPolicy(policy);
  checkDeposit(policy, setup.draft);
  await checkSourceBinding(setup.binding, policy, owner, setup.draft);
  // The hashes above took a moment; a reply that arrived meanwhile must state the same bound terms.
  const now = latest();
  if (!stillCurrent() || !now || boundTerms(now) !== before) throw changed();
}
const boundTerms = (p: MicroPolicy) => JSON.stringify([p.id, p.status, p.revision, p.code, p.sourceHash, p.irHash, p.originalIntent ?? null, p.network, p.limit, p.token, p.mint, p.runtime ? {...p.runtime, setup: undefined} : null, p.fundingRequest ?? null]);

/**
 * Sign, journal, submit, under the owner-policy lock. The binding is checked against the current policy first and
 * again immediately before the wallet opens; the existing `signPrepared` checks the transaction, verifies the returned
 * signature and commits the proof before the first and only submit.
 */
export async function signContractSetup(deps: SetupDeps, owner: string, setup: PreparedContractSetup, sign: (checked: CheckedSetup) => Promise<Uint8Array>, stillCurrent: () => boolean, latest: () => MicroPolicy | null): Promise<SetupOutcome> {
  return deps.lock(`${owner}:${setup.policyId}`, async () => {
    const currentPolicy = latest();
    if (currentPolicy) checkSelectedServices(deps, owner, currentPolicy);
    await stillBound(setup, owner, latest, stillCurrent, true);
    const api = commonSetupApi(deps.send, {id: setup.policyId, revision: setup.revision}, stillCurrent);
    const submit = api.submit;
    api.submit = async (...args) => {
      // signPrepared has already saved the verified proof. A changed policy stops broadcast without losing it.
      const currentPolicy = latest();
      if (currentPolicy) checkSelectedServices(deps, owner, currentPolicy);
      await stillBound(setup, owner, latest, stillCurrent, true);
      return submit(...args);
    };
    return signPrepared(api, deps.journal, setup.deployment, setup.draft, owner, setup.requestId, setup.prepared, async checked => {
      const currentPolicy = latest();
      if (currentPolicy) checkSelectedServices(deps, owner, currentPolicy);
      await stillBound(setup, owner, latest, stillCurrent, true);
      return sign(checked);
    });
  });
}

/** Reconciles a saved proof. Never resends, never opens the wallet. */
export async function checkContractSetup(deps: SetupDeps, setup: SetupContext, proof: SignedSetup, stillCurrent: () => boolean): Promise<SetupState> {
  const api = commonSetupApi(deps.send, {id: setup.policyId, revision: setup.revision}, stillCurrent);
  return confirmSetup(api, proof, setup.draft.policy, setup.deployment);
}

/** Explicit owner action: a status check, then the original signed bytes only. No new preparation. */
export async function resendContractSetup(deps: SetupDeps, owner: string, setup: SetupContext, stillCurrent: () => boolean, latest: () => MicroPolicy | null): Promise<{proof: SignedSetup; state: SetupState}> {
  return deps.lock(`${owner}:${setup.policyId}`, async () => {
    const api = commonSetupApi(deps.send, {id: setup.policyId, revision: setup.revision}, stillCurrent);
    const submit = api.submit;
    api.submit = async (...args) => {
      const currentPolicy = latest();
      if (currentPolicy) checkSelectedServices(deps, owner, currentPolicy);
      await stillBound(setup, owner, latest, stillCurrent);
      return submit(...args);
    };
    return resendSetup(api, deps.journal, setup.deployment, setup.draft.policy, owner);
  });
}

/**
 * The saved context for a proof: the binding's draft, source binding and deployment, which must name the proof's
 * policy, owner and request, and whose binding must still hash to that ID. Null when this device did not keep them;
 * the proof is then shown, but not checked or resent from here. The proof itself is never changed.
 */
export async function savedContext(bindings: BindingStore, owner: string, policy: MicroIdentity, proof: SignedSetup): Promise<SetupContext | null> {
  const b = bindings.read(owner, policy.id);
  if (!b || b.requestId !== proof.requestId || b.draft === undefined || b.deployment === undefined) return null;
  try {
    const draft = parseDraft(b.draft), deployment = parseDeployment(b.deployment, draft.policy.network);
    const binding = parseSourceBinding(record(b.draft, 'draft').commonPolicyBinding);
    if (draft.policy.id !== policy.id || proof.policyId !== policy.id || draft.policy.owner !== owner || proof.owner !== owner || draft.policy.moduleDigest !== deployment.moduleDigest) return null;
    if (b.revision !== binding.revision) return null;
    await checkBindingConfig(binding, draft, owner);
    return {policyId: policy.id, revision: b.revision, requestId: b.requestId, draft, binding, deployment};
  } catch {
    return null;
  }
}

/** Discard only an unsigned draft under the same lock used by signing. The server retains original terms. */
export async function discardContractDraft(deps: SetupDeps, owner: string, policy: MicroPolicy, stillCurrent: () => boolean): Promise<void> {
  await deps.lock(`${owner}:${policy.id}`, async () => {
    const r = runtimeOf(policy);
    if (!newSetupAllowed(policy) || policy.allocation || policy.approvalPending || r.state !== 'typed' || !r.capabilities.discard) throw new SetupContractError('This policy cannot be discarded here.');
    if (await findProof(deps, owner, policy)) throw new SetupContractError('A signed setup is saved. Keep the proof and check its status; this draft cannot be discarded.');
    if (!stillCurrent()) throw new SetupContractError('The policy or wallet changed. Nothing was discarded.');
    await deps.send('micro/discard', {id:policy.id,revision:policy.revision});
  });
}
