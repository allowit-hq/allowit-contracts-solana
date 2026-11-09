import {PublicKey} from '@solana/web3.js';
import {parseConfig, parseSetupState, samePolicy, type PayshConfig, type PayshDeployment, type PayshPolicy, type PolicyDraft, type PreparedSetup, type SetupState} from './paysh-contracts';
import {checkedSetup, signedSetupProof, solCustody, type CheckedSetup, type SignedSetup} from './paysh-wallet-intent';
import type {SetupJournal} from './setup-journal';

export class PayshError extends Error {constructor(message: string, readonly status: number) {super(message);}}

const MAX_REPLY = 1 << 20;
/** One owner request with the wallet session cookie, never retried here. */
async function call(method: 'GET' | 'POST', route: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {accept: 'application/json'};
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`/api/paysh/${route}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(45_000)});
  } catch {
    throw new PayshError('The setup service could not be reached. Its reply is unknown.', 0);
  }
  const raw = await response.text().catch(() => '');
  let data: unknown = null;
  if (raw.length <= MAX_REPLY) try {data = JSON.parse(raw);} catch {/* Reported below. */}
  if (!response.ok) {
    const error = (data as {error?: unknown} | null)?.error;
    throw new PayshError(typeof error === 'string' && error ? error.slice(0, 400) : `The setup service returned HTTP ${response.status}.`, response.status);
  }
  if (data === null) throw new PayshError('The setup service returned an unreadable reply.', response.status);
  return data;
}

/**
 * Recovery adapter for setups created on the earlier PaySH page. It reads the public deployment and reconciles,
 * an existing signed setup only. New policies, agent access and runs use the common policy routes.
 */
export const payshApi = {
  config: async (): Promise<PayshConfig> => parseConfig(await call('GET', 'config')),
  /** Reads chain state only; it never broadcasts. Finalization verifies the installed policy and saves it. */
  confirm: async (policyId: string, requestId: string): Promise<SetupState> => parseSetupState(await call('POST', 'confirm', {policyId, requestId})),

};
export type PayshApi = typeof payshApi;
/** The setup operations the checks below use. The common policy routes provide the same four. */
export interface SetupApi {
  prepare(policyId: string, requestId: string): Promise<PreparedSetup>;
  submit(policyId: string, requestId: string, signedBytes: string): Promise<SetupState>;
  confirm(policyId: string, requestId: string): Promise<SetupState>;
  archive(policyId: string): Promise<void>;
}

export {IndexedSetupJournal, type OwnerSetupJournal, type SetupJournal} from './setup-journal';

export type SetupOutcome = {proof: SignedSetup; submitted: true; state: SetupState} | {proof: SignedSetup; submitted: false; error: string};

/** Prepares the setup and checks it against the reviewed terms. Nothing is signed; the owner reviews the result. */
export async function prepareSetup(api: SetupApi, journal: SetupJournal, deployment: PayshDeployment, draft: PolicyDraft, owner: string, requestId: string): Promise<{prepared: PreparedSetup; checked: CheckedSetup}> {
  if (await journal.read(owner, draft.policy.id)) throw new Error('A signed setup is already saved for this policy. Check its status first.');
  const prepared = await api.prepare(draft.policy.id, requestId);
  return {prepared, checked: checkedSetup(deployment, draft, owner, requestId, prepared)};
}

/**
 * Sign, journal, submit. The browser never broadcasts and never retries: a lost submit reply leaves the journaled
 * proof for an explicit status check or an explicit resend of the identical bytes.
 */
export async function signPrepared(api: SetupApi, journal: SetupJournal, deployment: PayshDeployment, draft: PolicyDraft, owner: string, requestId: string, prepared: PreparedSetup, sign: (checked: CheckedSetup) => Promise<Uint8Array>): Promise<SetupOutcome> {
  if (await journal.read(owner, draft.policy.id)) throw new Error('A signed setup is already saved for this policy. Check its status first.');
  // Checked again immediately before the wallet opens.
  const checked = checkedSetup(deployment, draft, owner, requestId, prepared);
  const proof = await signedSetupProof(prepared, checked, draft.policy.id, owner, await sign(checked));
  // Storage failure stops here, before anything can be broadcast.
  await journal.write(proof);
  let state: SetupState;
  try {
    state = checkedState(await api.submit(proof.policyId, proof.requestId, proof.signedBytes), proof, draft.policy, deployment);
  } catch (error) {
    return {proof, submitted: false, error: error instanceof Error ? error.message : 'The submit reply is unknown.'};
  }
  return {proof, submitted: true, state};
}

/**
 * Explicit owner action only: resends the same signed bytes, so the signature and effect cannot change. A finalized,
 * proven-absent or archived setup is returned as confirmed without submitting.
 */
export async function resendSetup(api: SetupApi, journal: SetupJournal, deployment: PayshDeployment, policy: PayshPolicy, owner: string): Promise<{proof: SignedSetup; state: SetupState}> {
  const proof = await journal.read(owner, policy.id);
  if (!proof) throw new Error('No signed setup is saved on this device for this policy.');
  const current = await confirmSetup(api, proof, policy, deployment);
  if (current.status === 'finalized' || current.status === 'absent' || current.status === 'archived') return {proof, state: current};
  return {proof, state: checkedState(await api.submit(proof.policyId, proof.requestId, proof.signedBytes), proof, policy, deployment)};
}

/**
 * A setup reply must name this request and policy. `finalized` must also carry this signature and the initialized
 * policy account, owner and SOL custody; only then has the backend verified and saved the policy.
 */
export function checkedState(state: SetupState, proof: SignedSetup, policy: PayshPolicy, deployment: PayshDeployment): SetupState {
  if (state.requestId !== proof.requestId || state.policy.id !== proof.policyId || !samePolicy(state.policy, policy)) throw new Error('The backend reported a different setup request or policy.');
  if (state.signature !== null && state.signature !== proof.signature) throw new Error('The backend reported a different setup transaction.');
  if (state.status === 'absent' && (state.signature !== proof.signature || !state.chain || state.chain.initialized || state.chain.policyAddress !== policy.policyAddress || state.chain.owner !== proof.owner || state.chain.solVault !== solCustody(deployment.program, new PublicKey(policy.policyAddress), policy.allowedServiceIds === undefined ? 1 : 2).toBase58())) throw new Error('The absence reply does not prove this original signed setup and policy account.');
  if (state.status === 'finalized') {
    const c = state.chain;
    if (!c || !c.initialized || c.policyAddress !== policy.policyAddress || c.owner !== proof.owner || c.solVault !== solCustody(deployment.program, new PublicKey(policy.policyAddress), policy.allowedServiceIds === undefined ? 1 : 2).toBase58()) throw new Error('The finalized setup does not show this initialized policy account.');
  }
  return state;
}

/** Reads chain state for the journaled setup. It never resends. */
export async function confirmSetup(api: Pick<SetupApi, 'confirm'>, proof: SignedSetup, policy: PayshPolicy, deployment: PayshDeployment): Promise<SetupState> {
  return checkedState(await api.confirm(proof.policyId, proof.requestId), proof, policy, deployment);
}

/** Explicit owner action: archive only after a fresh positive absence check, retaining the exact signed journal. */
export async function archiveAbsentSetup(api: SetupApi, journal: SetupJournal, deployment: PayshDeployment, policy: PayshPolicy, owner: string): Promise<void> {
  const proof = await journal.read(owner, policy.id);
  if (!proof || proof.owner !== owner || policy.owner !== owner) throw new Error('The original signed setup proof must remain saved for this owner.');
  const state = await confirmSetup(api, proof, policy, deployment);
  if (state.status !== 'absent') throw new Error('The original signed setup has not been proven absent. Keep it and check status.');
  await api.archive(policy.id);
}
