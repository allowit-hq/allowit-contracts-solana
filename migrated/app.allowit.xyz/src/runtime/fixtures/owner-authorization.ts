/**
 * Synthetic owner-wallet budget authorization policies for unit and browser-boundary tests. The typed source, workflow
 * and budget requirements are the preserved SDK v6 draft output, unchanged. Everything else is written here: the
 * original intent, IR hash, nonces, asset label, origin, deadline and the runtime fields. Nothing is a compiled policy,
 * a granted authority, a server reply or a chain result. Signatures come from a key the caller holds.
 */
import EXECUTION from '../../policy/fixtures/typed-execution-v6.json' with {type: 'json'};
import {authorizationPreimage, budgetsPreimage, digest, instancePreimage, textDigest, toBase64, type Commitment} from '../authorization-codec';
import type {AssetDetails, TypedBudgetRequirement} from '../../policy/typed-metadata';
import type {MicroPolicy} from '../../micro/micro-contracts';

export const RFC8032_SEED_HEX = '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60';
export const RFC8032_OWNER = 'FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z';
export const FIXTURE_ORIGIN = 'https://owner.test';
export const FIXTURE_INTENT = 'Let my agent check native requests within 0.05 SOL. Café stays exact.';
export const FIXTURE_IR_HASH = '3c'.repeat(32);
export const INSTANCE_NONCE = '5a'.repeat(32);
export const GRANT_NONCE = 'a5'.repeat(32);
export const FIXTURE_OPERATION = 'allowit::execution_request_validate';
export const FIXTURE_WALLET_PROFILE = 'solana-owner-typed-v1';
/** SYNTHETIC host label for the v6 fixture's synthetic genesis. */
export const fixtureAssets = (): Record<string, unknown>[] => [{assetId: `native:solana:${'09'.repeat(32)}`, decimals: 9, symbol: 'Testnet SOL', network: 'solana:testnet', kind: 'native'}];

/** Ed25519 signing with a raw 32-byte seed, through WebCrypto PKCS#8. */
export async function seedSigner(seedHex: string): Promise<(message: Uint8Array) => Promise<Uint8Array>> {
  const hex = (h: string) => (h.match(/../g) ?? []).map(b => parseInt(b, 16));
  const pkcs8 = new Uint8Array([...hex('302e020100300506032b657004220420'), ...hex(seedHex)]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, {name: 'Ed25519'}, false, ['sign']);
  return async message => new Uint8Array(await crypto.subtle.sign({name: 'Ed25519'}, key, new Uint8Array(message)));
}

export interface FixtureOptions {owner?: string; origin?: string; expiresAt?: string; revision?: number; id?: string; status?: MicroPolicy['status']; fork?: boolean; typedIngress?: string[]; grantNonce?: string}

/** A policy whose runtime carries a correct instance binding for its own fields, plus the commitment it would sign. */
export async function authorizationPolicy(o: FixtureOptions = {}): Promise<{policy: MicroPolicy; commitment: Commitment; message: Uint8Array; budgetsHash: string}> {
  const owner = o.owner ?? RFC8032_OWNER, revision = o.revision ?? 2, id = o.id ?? 'policy-owner-typed';
  const p = structuredClone(EXECUTION.policy) as Record<string, unknown>;
  const assets = fixtureAssets();
  const budgets = (p.typedBudgetRequirements as TypedBudgetRequirement[]);
  const budgetsHash = await digest(budgetsPreimage(budgets, assets as unknown as AssetDetails[]));
  const intentHash = await textDigest(FIXTURE_INTENT);
  const unhashed = {version: 1 as const, owner, policyId: id, sourceHash: p.sourceHash as string, irHash: FIXTURE_IR_HASH, originalIntentHash: intentHash, revision, sourceProfile: 'oracle', walletKind: 'owner-wallet' as const, walletProfile: FIXTURE_WALLET_PROFILE, operation: FIXTURE_OPERATION, network: 'solana:testnet', typedBudgetsHash: budgetsHash, nonce: INSTANCE_NONCE};
  const instanceId = await digest(instancePreimage(unhashed));
  const runtime = {
    sourceProfile: 'oracle', wallet: {kind: 'owner-wallet', profile: FIXTURE_WALLET_PROFILE}, fundingMode: 'authorization',
    capabilities: {providerCall: false, fund: true, withdraw: false, revoke: false, revise: true, fork: o.fork ?? false, rename: true, typedIngress: o.typedIngress ?? []},
    fundingAsset: {network: 'solana:testnet', symbol: 'Testnet SOL', decimals: 9}, paymentAsset: {network: 'solana:testnet', symbol: 'Testnet token', decimals: 6, mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'},
    operation: FIXTURE_OPERATION, setup: null, instanceBinding: {...unhashed, instanceId}, assetMetadata: assets,
  };
  const policy = {
    ...p, id, revision, irHash: FIXTURE_IR_HASH, originalIntent: FIXTURE_INTENT, network: 'solana:testnet', status: o.status ?? 'draft', runtime, assetMetadata: structuredClone(assets),
    title: 'Native request budget', explanation: '', limit: '', token: '', mint: '', language: 'allowit-rust-v1', requests: [], activity: [], turns: [], spentUnits: 0, createdAt: '', updatedAt: '',
  } as unknown as MicroPolicy;
  const commitment: Commitment = {version: 1, owner, policyId: id, policyInstance: instanceId, sourceHash: p.sourceHash as string, irHash: FIXTURE_IR_HASH, originalIntentHash: intentHash, revision, walletProfile: FIXTURE_WALLET_PROFILE, sourceProfile: 'oracle', walletKind: 'owner-wallet', operation: FIXTURE_OPERATION, network: 'solana:testnet', typedBudgetsHash: budgetsHash, nonce: o.grantNonce ?? GRANT_NONCE, origin: o.origin ?? FIXTURE_ORIGIN, expiresAt: o.expiresAt ?? '2030-01-02T00:00:00Z'};
  return {policy, commitment, message: authorizationPreimage(commitment), budgetsHash};
}

/** The runtime-retained authorization for a signed commitment, in the frozen reply shape. */
export const retained = (commitment: Commitment, message: Uint8Array, signature: Uint8Array) => ({commitment, messageBase64: toBase64(message), signature: toBase64(signature)});
