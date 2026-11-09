import {sha256Hex} from './hash';
import {Buffer} from 'buffer';
import type {MicroPolicy} from '../micro/micro-contracts';
import type {PolicyDraft} from '../paysh/paysh-contracts';
import {runtimeOf} from './runtime';
import {serviceAllowlistRoot, serviceIds, sameServiceIds} from '../paysh/service-allowlist';
import {u64} from '../paysh/paysh-units';

/**
 * The common policy's source approval. A new contract-wallet setup carries `setup.draft.commonPolicyBinding`; its
 * fields hash, in the fixed order below, to the Config `instance_id` the owner signs. One ID names the common policy,
 * the generated draft, the native policy and the on-chain instance. The fixed deployment `moduleDigest` is separate
 * and unchanged: the host Rust compiler and evaluator check the source, and the program enforces the signed caps.
 *
 * The browser recomputes every hash it can from what it holds: the source text, the original intent, the Config bytes
 * and the instance ID. It cannot recompute the server's compiled IR, so `irHash` is compared with the policy's current
 * compiled `irHash` only.
 */

export class SourceBindingError extends Error {}
const fail = (field: string, what = 'is missing or invalid') => new SourceBindingError(`The source binding field ${field} ${what}. Nothing was signed.`);

export const BINDING_DOMAIN = 'allowit-policy-source-v1';
export const BINDING_FIELDS = ['owner', 'sourceHash', 'irHash', 'originalIntentHash', 'revision', 'nonce', 'walletKind', 'walletProfile', 'configCommitment'] as const;
/** Exact Borsh Config length; the masked ranges are the instance ID and the two derived vault token accounts. */
export const CONFIG_LENGTH = 561;
const MASKED: readonly [number, number][] = [[0, 32], [192, 256]];
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_REVISION = 20;

export interface SourceBinding {
  version: 1;
  owner: string;
  sourceHash: string;
  irHash: string;
  originalIntentHash: string;
  revision: number;
  nonce: string;
  walletKind: string;
  walletProfile: string;
  configCommitment: string;
}

type Json = Record<string, unknown>;
const KEYS = ['version', ...BINDING_FIELDS] as const;
const hex64 = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !HEX64.test(value)) throw fail(field, 'is not 64 lowercase hex characters');
  return value;
};
/** A NUL inside a field would make the encoding ambiguous, so it is refused rather than escaped. */
const field = (value: unknown, name: string, max: number) => {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) throw fail(name);
  return value;
};

/** Exactly the vector's fields, no more and no fewer. */
export function parseSourceBinding(value: unknown): SourceBinding {
  if (value === undefined || value === null) throw new SourceBindingError('This setup has no source binding, so it cannot be signed here. Nothing was signed.');
  if (typeof value !== 'object' || Array.isArray(value)) throw fail('commonPolicyBinding');
  const b = value as Json;
  const extra = Object.keys(b).filter(k => !(KEYS as readonly string[]).includes(k));
  if (extra.length) throw fail(extra[0], 'is not part of the source binding');
  if (b.version !== 1) throw fail('version', 'is not 1');
  const revision = b.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1 || revision > MAX_REVISION) throw fail('revision', `is not an integer from 1 to ${MAX_REVISION}`);
  return {
    version: 1,
    owner: field(b.owner, 'owner', 64),
    sourceHash: hex64(b.sourceHash, 'sourceHash'),
    irHash: hex64(b.irHash, 'irHash'),
    originalIntentHash: hex64(b.originalIntentHash, 'originalIntentHash'),
    revision,
    nonce: hex64(b.nonce, 'nonce'),
    walletKind: field(b.walletKind, 'walletKind', 64),
    walletProfile: field(b.walletProfile, 'walletProfile', 200),
    configCommitment: hex64(b.configCommitment, 'configCommitment'),
  };
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export {sha256Hex} from './hash';
/** Exact UTF-8: no trimming, Unicode normalization or line-ending conversion. */
export const utf8Hash = (text: string) => sha256Hex(new TextEncoder().encode(text));

/** `domain NUL owner NUL sourceHash … NUL configCommitment`, with no trailing NUL. */
export function bindingPreimage(b: SourceBinding): Uint8Array {
  const values = BINDING_FIELDS.map(k => (k === 'revision' ? String(b.revision) : b[k]));
  return new TextEncoder().encode([BINDING_DOMAIN, ...values].join('\0'));
}
export const bindingInstanceId = (b: SourceBinding) => sha256Hex(bindingPreimage(b));

/**
 * SHA-256 of a copy of the raw Config with only the instance ID and the two derived vault accounts zeroed. The input is
 * never changed. The zeroed bytes stay protected elsewhere: the instance ID by the recomputed binding, the vaults by
 * the associated-account derivation in the transaction check.
 */
export async function configCommitment(config: Uint8Array): Promise<string> {
  if (config.length !== CONFIG_LENGTH && config.length !== CONFIG_LENGTH + 32) throw new SourceBindingError('The setup Config has the wrong length. Nothing was signed.');
  const copy = new Uint8Array(config);
  for (const [from, to] of MASKED) copy.fill(0, from, to);
  return sha256Hex(copy);
}

/** The binding's own consistency with the Config and draft it came with. Used again on reload, before any check. */
export async function checkBindingConfig(binding: SourceBinding, draft: Pick<PolicyDraft, 'draftId' | 'policy' | 'configBytes' | 'config'>, owner: string): Promise<void> {
  if (binding.owner !== owner || draft.policy.owner !== owner) throw fail('owner', 'is not the signed-in wallet');
  const v2 = binding.walletProfile === 'solana-paysh-v2';
  if (v2 !== (draft.config.serviceAllowlistRoot !== undefined) || v2 !== (draft.policy.allowedServiceIds !== undefined)) throw fail('walletProfile', 'differs from the Config version');
  if (v2 && serviceAllowlistRoot(serviceIds(draft.policy.allowedServiceIds), draft.config) !== draft.config.serviceAllowlistRoot) throw fail('serviceAllowlistRoot', 'does not match the approved services');
  if (await configCommitment(Buffer.from(draft.configBytes, 'base64')) !== binding.configCommitment) throw fail('configCommitment', 'does not match the setup Config');
  const id = await bindingInstanceId(binding);
  if (id !== draft.config.instanceId || id !== draft.policy.id || id !== draft.draftId) throw fail('instance ID', 'does not match the setup Config');
}

export type BoundPolicy = Pick<MicroPolicy, 'id' | 'code' | 'sourceHash' | 'irHash' | 'revision' | 'originalIntent' | 'runtime' | 'network' | 'limit' | 'token' | 'mint'>;

/**
 * Every binding field against the current common policy, the signed-in owner and the prepared draft. Runs before the
 * prepared terms are shown and again immediately before the wallet opens; any change stops signing.
 */
export async function checkSourceBinding(binding: SourceBinding, policy: BoundPolicy, owner: string, draft: Pick<PolicyDraft, 'draftId' | 'policy' | 'configBytes' | 'config'>): Promise<void> {
  const r = runtimeOf(policy);
  if (r.state !== 'typed') throw fail('walletKind', 'has no readable policy runtime');
  if (r.runtime.paymentAsset.mint !== draft.config.usdcMint || r.runtime.paymentAsset.network !== draft.policy.network || r.runtime.paymentAsset.decimals !== 6) throw fail('paymentAsset', 'differs from the signed payment mint or units');
  if (r.runtime.fundingAsset.network !== draft.policy.network || r.runtime.fundingAsset.decimals !== 9) throw fail('fundingAsset', 'differs from the signed SOL funding units');
  if (binding.walletKind !== r.runtime.wallet.kind || binding.walletProfile !== r.runtime.wallet.profile) throw fail('wallet', 'differs from the policy runtime');
  if (binding.walletProfile === 'solana-paysh-v2') {
    const requirements = r.runtime.providerCallRequirements;
    const approved = serviceIds(requirements?.map(q => q.service_id));
    if (!requirements || requirements.some(q => !['allowit::service_call','paysh::call'].includes(q.operation) || q.input_key !== q.service_id) || !sameServiceIds(approved, serviceIds(draft.policy.allowedServiceIds))) throw fail('allowedServiceIds', 'differs from this policy’s approved services');
    if (draft.policy.maxPaymentUsdcPerPeriod !== undefined) {
      const amount = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(policy.limit);
      if (!amount || policy.token !== draft.config.usdcMint || policy.mint !== draft.config.usdcMint) throw fail('payment budget', 'does not name an exact compiled amount of the payment mint');
      const aggregate = BigInt(amount[1] + (amount[2] ?? '').padEnd(6, '0'));
      const period = BigInt(draft.policy.maxPaymentUsdcPerPeriod);
      if (aggregate > 0xffffffffffffffffn || period === 0n || period > aggregate || draft.config.maxUsdcPerPeriod !== draft.policy.maxPaymentUsdcPerPeriod) throw fail('payment budget', 'exceeds the compiled aggregate cap or differs from the signed Config');
      let perCall = 0n;
      for (const requirement of requirements) {
        if (requirement.payment_asset_id !== draft.config.usdcMint) throw fail('payment budget', 'differs from a compiled provider payment asset');
        const ceiling = BigInt(u64(requirement.max_payment_units, 'providerCallRequirements.max_payment_units'));
        if (ceiling > perCall) perCall = ceiling;
      }
      if (perCall === 0n || perCall > period || perCall.toString() !== draft.policy.maxPaymentUsdc) throw fail('payment budget', 'differs from the compiled single-call ceiling');
    }
  }
  if (typeof policy.originalIntent !== 'string' || !policy.originalIntent) throw fail('originalIntent', 'is missing from the policy');
  if (draft.policy.originalIntent !== policy.originalIntent) throw fail('originalIntent', 'differs between the policy and the setup');
  if (await utf8Hash(policy.originalIntent) !== binding.originalIntentHash) throw fail('originalIntentHash', 'does not match the original intent');
  if (await utf8Hash(policy.code) !== binding.sourceHash || policy.sourceHash !== binding.sourceHash) throw fail('sourceHash', 'does not match the policy source');
  if (policy.irHash !== binding.irHash) throw fail('irHash', 'differs from the compiled policy');
  if (policy.revision !== binding.revision) throw fail('revision', 'differs from the policy revision');
  await checkBindingConfig(binding, draft, owner);
  if (policy.id !== draft.policy.id) throw fail('instance ID', 'does not name this policy');
}
