import {sha256} from '@noble/hashes/sha256';
import {PublicKey} from '@solana/web3.js';
import type {Session} from '../contracts';
import {ApiError} from '../api';
import {isPolicy, type NativePolicyAPI} from './native-api';
import {decimal, units, type NativeConfig, type NativeDeployment, type Operation, type Policy} from './native-contracts';
import type {NativeJournal, PreparationPointer} from './native-journal';
import {nativeBinding, ownerIntent} from './native-wallet-intent';

export const DEPLOYMENT_FRAGMENT = '#allowit-deploy=';
export const MAX_DEPLOYMENT_FRAGMENT = 65_536;
export const DEPLOYMENT_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
const POLICY_KEYS = ['version', 'instance', 'profile', 'network', 'prompt', 'dailyLimit', 'actionLimit', 'payDiscovery', 'executionPolicyDigest', 'executionRequirementsDigest', 'semanticRequired', 'sourceBundle', 'id', 'policyArtifact', 'rust'];
const DEPLOYMENT_KEYS = ['network', 'sourceBundle', 'policy', 'policyData', 'custody'];
const HANDOFF_KEYS = ['version', 'profile', 'requestId', 'network', 'owner', 'amount', 'policy', 'deployment', 'intentDigest'];
const WALLET_KEYS = ['mint', 'executor', 'authority'];

export interface DeploymentHandoff {
  version: 1; profile: 'allowit-deploy-v1'; requestId: string; network: typeof DEPLOYMENT_NETWORK;
  owner: string; amount: string; policy: Policy; deployment: NativeDeployment;
  wallet: Pick<NativeConfig, 'mint' | 'executor' | 'authority'>; intentDigest: string;
  retryPreparationOf?: string;
}

const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
const hash = (text: string) => Array.from(sha256(new TextEncoder().encode(text)), byte => byte.toString(16).padStart(2, '0')).join('');
/** The manifest has only public string fields. Sorting preserves the SDK's canonical JSON digest. */
const canonicalDeployment = (deployment: NativeDeployment) => JSON.stringify(Object.fromEntries(Object.entries(deployment).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
export const deploymentIntentDigest = (value: Omit<DeploymentHandoff, 'intentDigest'>): string => {
  const fields = ['allowit-deploy-v1', value.requestId, value.network, value.owner, value.amount, value.policy.id,
    hash(value.policy.rust), hash(canonicalDeployment(value.deployment)),
    hash(JSON.stringify(Object.fromEntries(Object.entries(value.wallet).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))))];
  if (value.retryPreparationOf !== undefined) fields.push(value.retryPreparationOf);
  return hash(JSON.stringify(fields));
};

/** Decode public intent only. Opening the link cannot prepare, sign or send a transaction. */
export function parseDeploymentHandoff(fragment: string): DeploymentHandoff {
  if (!fragment.startsWith(DEPLOYMENT_FRAGMENT) || fragment.length > MAX_DEPLOYMENT_FRAGMENT) throw new Error('The deployment link is invalid or too large.');
  const encoded = fragment.slice(DEPLOYMENT_FRAGMENT.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('The deployment link is invalid.');
  let value: unknown;
  try {
    const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
    if (btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') !== encoded) throw new Error();
    value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
  } catch {throw new Error('The deployment link is invalid.');}
  const retry = value && typeof value === 'object' && Object.hasOwn(value, 'retryPreparationOf');
  if (!exactKeys(value, [...HANDOFF_KEYS, 'wallet', ...(retry ? ['retryPreparationOf'] : [])]) || value.version !== 1 || value.profile !== 'allowit-deploy-v1'
    || typeof value.requestId !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(value.requestId)
    || value.network !== DEPLOYMENT_NETWORK || typeof value.owner !== 'string'
    || typeof value.amount !== 'string' || typeof value.intentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.intentDigest)
    || !exactKeys(value.policy, POLICY_KEYS) || !isPolicy(value.policy)
    || !exactKeys(value.deployment, DEPLOYMENT_KEYS) || !Object.values(value.deployment).every(field => typeof field === 'string')
    || !exactKeys(value.wallet, WALLET_KEYS) || !Object.values(value.wallet).every(field => typeof field === 'string')
    || value.deployment.network !== 'solana:devnet' || value.policy.network !== 'solana:devnet') throw new Error('The deployment link does not contain a supported Devnet intent.');
  if (retry && (typeof value.retryPreparationOf !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(value.retryPreparationOf)
    || value.retryPreparationOf === value.requestId)) throw new Error('The deployment retry must name a different original request.');
  try {
    if (new PublicKey(value.owner).toBase58() !== value.owner || units(value.amount) <= 0n || decimal(units(value.amount)) !== value.amount) throw new Error();
    for (const key of ['policy', 'policyData', 'custody']) {
      const address = value.deployment[key] as string;
      if (new PublicKey(address).toBase58() !== address) throw new Error();
    }
    for (const address of Object.values(value.wallet)) if (new PublicKey(address as string).toBase58() !== address) throw new Error();
  } catch {throw new Error('The deployment owner, amount or program address is invalid.');}
  const handoff = value as unknown as DeploymentHandoff;
  if (handoff.intentDigest !== deploymentIntentDigest(handoff)) throw new Error('The deployment intent changed. Return to the original CLI link.');
  return handoff;
}

/** Bind public intent to the signed-in wallet and the backend's exact pinned deployment. */
export function checkDeploymentContext(handoff: DeploymentHandoff, session: Session | null, selectedNetwork: string, config: NativeConfig): void {
  if (!session || !['solana', 'solana:devnet'].includes(session.network) || session.address !== handoff.owner) throw new Error(`Sign in with wallet ${handoff.owner} to review this request.`);
  if (selectedNetwork !== 'solana:devnet' || config.network !== 'solana:devnet'
    || canonicalDeployment(handoff.deployment) !== canonicalDeployment(config.deployment)
    || handoff.policy.sourceBundle !== config.release.sourceBundle
    || handoff.policy.policyArtifact !== config.release.artifacts.find(artifact => artifact.name === 'allowit_policy.so')?.sha256) throw new Error('The deployment link does not match the configured Devnet release.');
  if (WALLET_KEYS.some(key => handoff.wallet[key as keyof typeof handoff.wallet] !== config[key as keyof typeof handoff.wallet])) throw new Error('The configured mint, executor or authority differs from the CLI deployment intent. Nothing was signed.');
}

/** A CLI link names the former server executor key, so it may only continue a vault this server already holds. */
export const CLI_NEW_VAULT_RETIRED = "This command-line link would create a new vault with Allowit's own executor key. Allowit holds no key that can spend, so new vaults use your agent's own key: connect your agent, then set up this policy from its Funding step in Allowit. Nothing was signed.";
export const isRetiredVaultSetup = (error: unknown) => error instanceof ApiError && error.status === 410 && error.code === 'NATIVE_SERVER_EXECUTOR_RETIRED';

/** Read-only: a link for a vault the server does not hold stops before consent, saving or any wallet prompt. */
export async function checkKnownDeployment(handoff: DeploymentHandoff, api: NativePolicyAPI): Promise<void> {
  const {policies} = await api.call<{policies?: unknown}>('native/policies');
  if (!Array.isArray(policies)) throw new Error('The backend returned an invalid policy list');
  // The policy ID is the digest of the exact policy, so matching it names this vault and no other.
  if (!policies.some(policy => !!policy && typeof policy === 'object' && (policy as {id?: unknown}).id === handoff.policy.id)) throw new Error(CLI_NEW_VAULT_RETIRED);
}

/** Validation and release checks have no wallet or transaction preparation effects. */
export async function verifyDeploymentReview(handoff: DeploymentHandoff, session: Session | null, network: string, api: NativePolicyAPI, validate: (policy: Policy) => Promise<Policy>): Promise<void> {
  if (!api.config) throw new Error('Native configuration is unavailable');
  checkDeploymentContext(handoff, session, network, api.config);
  const checked = await validate(handoff.policy);
  if (JSON.stringify(checked) !== JSON.stringify(handoff.policy)) throw new Error('The backend returned a different policy');
  await api.verifyRelease();
}

/** Status and replay must describe the original reviewed deployment, never a new link's amount or source. */
export async function verifySavedDeployment(handoff: DeploymentHandoff, config: NativeConfig, saved: Operation | null, validate: (policy: Policy) => Promise<Policy>): Promise<void> {
  const expected = ownerIntent(handoff.policy, handoff.owner, 'deploy', {amount: handoff.amount}, nativeBinding(config, handoff.policy, handoff.owner));
  if (!saved || saved.id !== handoff.requestId || saved.method !== 'deploy' || saved.intent !== expected || typeof saved.signedBytes !== 'string') throw new Error('The saved proof belongs to a different deployment intent. Open its original CLI link.');
  const checked = await validate(handoff.policy);
  if (JSON.stringify(checked) !== JSON.stringify(handoff.policy)) throw new Error('The backend returned a different policy');
}

/** A CLI request must never adopt an earlier link's unsigned preparation ID. */
export async function checkDeploymentRequest(journal: NativeJournal, requestId: string, retryPreparationOf?: string): Promise<void> {
  if (retryPreparationOf) {
    const original = await journal.read('request-' + retryPreparationOf);
    if (original && typeof original.signedBytes === 'string') throw new Error('The original deployment has a signed proof. Recover its original request before authorizing a replacement.');
  }
  for (const name of ['preparing-deploy', 'prepared-deploy']) {
    const kept = await journal.read<PreparationPointer>(name);
    if (kept && kept.id !== requestId && kept.id !== retryPreparationOf) throw new Error(`An earlier deployment request ${kept.id} is unresolved. Open its original CLI link.`);
  }
}

/** Check under the same lifecycle lock that protects preparation and signed proofs. */
export function deploymentJournal(journal: NativeJournal, requestId: string, retryPreparationOf?: string): NativeJournal {
  return {
    read: journal.read.bind(journal), write: journal.write.bind(journal), clear: journal.clear.bind(journal), entries: journal.entries.bind(journal),
    locked: run => journal.locked(async () => {await checkDeploymentRequest(journal, requestId, retryPreparationOf); return run();}),
  };
}

/** Only an unsigned preparation with authoritative expiry can be replaced. */
export async function verifyDeploymentRetry(handoff: DeploymentHandoff, api: NativePolicyAPI): Promise<void> {
  if (!handoff.retryPreparationOf) return;
  const {operation} = await api.call<{operation: {id: string; method: string; policyId?: string; signature?: string; blockhashExpired?: boolean; retryPreparationAllowed?: boolean; supersededBy?: string}}>('native/recover', {policyId: handoff.policy.id, requestId: handoff.retryPreparationOf});
  if (!operation || operation.id !== handoff.retryPreparationOf || operation.method !== 'deploy'
    || (operation.policyId !== undefined && operation.policyId !== handoff.policy.id)
    || operation.signature || operation.blockhashExpired !== true
    || (operation.retryPreparationAllowed !== true && operation.supersededBy !== handoff.requestId)) throw new Error('The original unsigned deployment has not been verified expired. Keep its original request and proof.');
}

/** An old link explains the real CLI retry path before another wallet prompt. */
export async function checkUnsignedDeployment(handoff: DeploymentHandoff, api: NativePolicyAPI): Promise<void> {
  // A link can be opened on another device without any local preparation pointer.
  try {
    const {operation} = await api.call<{operation: {id: string; signature?: string; blockhashExpired?: boolean; retryPreparationAllowed?: boolean; supersededBy?: string}}>('native/recover', {policyId: handoff.policy.id, requestId: handoff.requestId});
    if (operation?.id !== handoff.requestId) throw new Error('The backend returned a different deployment request.');
    if (operation.signature) throw new Error('This deployment already has a signed proof. Recover it in the browser where it was signed.');
    if (operation.supersededBy) throw new Error(`This preparation was replaced by ${operation.supersededBy}. Open that request's CLI link.`);
    if (operation.blockhashExpired) {
      if (operation.retryPreparationAllowed) throw new Error(`The unsigned deployment expired. In the CLI, set ALLOWIT_RETRY_PREPARATION_OF=${handoff.requestId}, choose a new ALLOWIT_REQUEST_ID, and run policy deploy again with the same policy and amount.`);
      throw new Error(operation.supersededBy ? `This preparation was replaced by ${operation.supersededBy}. Open that request's CLI link.` : 'The original preparation expired. Keep its proof and check its status before authorizing another request.');
    }
  } catch (error) {
    // A lost prepare reply can leave a local pointer before the backend admits it.
    // Retain that identity and let explicit consent retry only that same ID.
    if (error instanceof ApiError && error.status === 404) return;
    throw error;
  }
}
