/** Versioned HTTP values for the native-vault-v2 profile. These types do not validate or compile policy code. */
import release from '../../tests/fixtures/native-release.json' with {type: 'json'};
export type NativeNetwork = 'solana:devnet';
export const NATIVE_NETWORKS: readonly NativeNetwork[] = ['solana:devnet'];
export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const PINNED_NATIVE_RELEASE: NativeRelease = release;
export const isNativeNetwork = (value: unknown): value is NativeNetwork => value === 'solana:devnet';
export interface NativeDeployment {network: NativeNetwork; sourceBundle: string; policy: string; custody: string; policyData: string}
/** A server-advertised x402 resource that this native profile can bind into one immutable policy revision. */
export interface NativeX402Service {
  id: string; name: string; resourceUrl: string; recipient: string; action: string; maxAmount: string;
  network: 'solana:devnet'; scheme: 'allowit-native';
}
/** Bind/state/export may additionally publish the exact ATA derived for the trusted recipient wallet. */
export interface BoundNativeX402Service extends NativeX402Service {tokenAccount: string}
/** SDK `Policy`: `dailyLimit`/`actionLimit` are the initial on-chain limits; the digests identify the server-side gate. */
export interface Policy {
  version: 2; instance: string; profile: 'solana-native-v2'; network: NativeNetwork; prompt: string; dailyLimit: string; actionLimit: string; payDiscovery: boolean;
  executionPolicyDigest: string; executionRequirementsDigest: string; semanticRequired: boolean; sourceBundle: string; id: string; policyArtifact: string; rust: string;
}
/** A PaySH whitelist entry: the service ID the agent names and the token account it is paid at. */
export interface AllowedService {id: string; recipient: string}
/** The policy SDK's list check takes 1 to 32 strings, so a whitelist names at most 32 services. */
export const MAX_ALLOWED_SERVICES = 32;
export interface Binding {owner: string; executor: string; authority: string; mint: string; vault: string; tokenAccount: string; policy: string; policyData: string; custody: string; bump: number}
export interface VaultState extends Binding {abi: number; sourceBundle: string; policyArtifact: string; vaultId: string; dailyLimit: string; actionLimit: string; spent: string; spentDay: string; nonce: string; revision: string; instanceSlot: string; approved: boolean; balance: string}
export type PolicyMethod = 'deploy' | 'fund' | 'execute' | 'tune' | 'tune_action' | 'revoke' | 'withdraw' | 'close';
/** Owner methods this browser signs. `tune`/`tune_action` stay CLI/API-only. */
export type OwnerMethod = 'deploy' | 'fund' | 'withdraw' | 'close' | 'revoke';
export const OWNER_METHODS: readonly OwnerMethod[] = ['deploy', 'fund', 'withdraw', 'close', 'revoke'];
export const isOwnerMethod = (m: unknown): m is OwnerMethod => OWNER_METHODS.includes(m as OwnerMethod);
/** Funding, withdrawal and closure share the backend's per-method reservation and explicit additional-operation rule. */
export const isSlotMethod = (m: unknown): m is 'fund' | 'withdraw' | 'close' => m === 'fund' || m === 'withdraw' || m === 'close';
export interface PolicyOptions {recipientWallet?: string; amount?: string; instanceSlot?: string; additionalOwnerOperation?: boolean; retryPreparationOf?: string}
/** SDK `Record` as journaled by this browser. `signedAt` is local display metadata the backend discards on import. */
export interface Operation {
  id: string; status: 'uncertain' | 'submitted' | 'settled' | 'failed'; method: PolicyMethod; signature: string; signatures: string[]; transactionUrl: string; intent: string; signedBytes: string;
  blockhash: string; lastValidBlockHeight: number; nonce?: string; revision?: string; instanceSlot?: string; blockhashExpired?: boolean; signedAt?: string; [key: string]: unknown;
}
/** A backend operation as `native/state` publishes it: no intent or signed bytes. */
export interface PublicOperation {id: string; method: string; status: string; policyId?: string; signature?: string; transactionUrl?: string; instanceSlot?: string | number; blockhashExpired?: boolean; [key: string]: unknown}
export interface NativeRelease {contractRevision: string; sourceBundle: string; sources: Record<string, string>; artifacts: {name: string; bytes: number; sha256: string}[]}
/** Metadata is pinned locally; only native/verify establishes actual on-chain deployment acceptance. */
export function matchesPinnedRelease(value: unknown): value is NativeRelease {
  const r = value as NativeRelease | null;
  return !!r && r.contractRevision === release.contractRevision && r.sourceBundle === release.sourceBundle
    && !!r.sources && typeof r.sources === 'object' && Object.keys(r.sources).length === Object.keys(release.sources).length
    && Object.entries(release.sources).every(([name, source]) => r.sources[name] === source)
    && Array.isArray(r.artifacts) && r.artifacts.length === release.artifacts.length
    && release.artifacts.every(a => r.artifacts.filter(b => b?.name === a.name && b.bytes === a.bytes && b.sha256 === a.sha256).length === 1);
}
export function finalizedSlot(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  return canonicalUnsigned(value) ? BigInt(value) : null;
}
/** Call only on an exact operation returned by the authenticated native API. */
export function settledOperation(operation: Pick<PublicOperation, 'status' | 'signature'> & {finalizedSlot?: unknown}): boolean {
  return operation.status === 'settled' && typeof operation.signature === 'string' && operation.signature.length > 0 && finalizedSlot(operation.finalizedSlot) !== null;
}
export interface NativeConfig {network: NativeNetwork; genesis: typeof DEVNET_GENESIS; rpcUrl: string; mint: string; executor: string; authority: string; deployment: NativeDeployment; release: NativeRelease; x402Services: NativeX402Service[]}
export interface Simulation {contextSlot: number; unitsConsumed: number; transactionBytes: number}
export interface Prepared {
  intent: string; message: string; unsignedTransaction: string; binding: Binding;
  operation: {id: string; method: PolicyMethod; policyId: string; status?: string; blockhash: string; lastValidBlockHeight: number; nonce?: string | null; revision?: string | null; instanceSlot?: number | string; simulation?: Simulation};
}

/** The SDK's compiled ceiling for either on-chain limit, in base units. */
export const MAX_LIMIT_UNITS = 50_000_000n;
export const U64_MAX = 0xffffffffffffffffn;

/** Exact amount parsing is a form/signing safeguard, not policy correctness validation. */
export function units(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) throw new Error('Use an exact decimal with at most six places');
  const [whole, fraction = ''] = value.split('.');
  const result = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  if (result > U64_MAX) throw new Error('Amount exceeds u64');
  return result;
}
export function decimal(value: bigint | string): string {
  const n = BigInt(value), fraction = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return (n / 1_000_000n).toString() + (fraction ? '.' + fraction : '');
}
/** A canonical unsigned integer string, as the SDK's `number` accepts. */
export function canonicalUnsigned(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= U64_MAX;
}
export const networkName = (_network: NativeNetwork) => 'Devnet';
export const cluster = (network: NativeNetwork) => network.split(':')[1];

/** An expired proof is retired only by a durably signed successor of the same owner method. */
export function supersededOwner(record: Operation, records: readonly Operation[]): boolean {
  return isSlotMethod(record.method) && record.blockhashExpired === true && typeof record.supersededBy === 'string'
    && records.some(next => next.id !== record.id && next.id === record.supersededBy && next.method === record.method && !!next.signedBytes && !!next.signature);
}

