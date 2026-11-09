/**
 * A common-policy setup whose single ID is computed from its source binding, for unit and UI fixture tests. Keys come
 * from the fixed seeds in paysh-setup; the source, intent, IR hash and nonce are fixture values, not compiler output,
 * and nothing here is a real deployment, chain or wallet response.
 */
import {Buffer} from 'buffer';
import {PublicKey} from '@solana/web3.js';
import {chainConfig, deployment, instructions, OWNER, profile, rawPolicy, REQUEST_ID, v0Message} from '../../paysh/fixtures/paysh-setup';
import {associatedAddress, encodeConfig, NATIVE_MINT, policyAddress, solCustody} from '../../paysh/paysh-wallet-intent';
import {parsePrepared, type ChainConfig, type PreparedSetup} from '../../paysh/paysh-contracts';
import type {MicroPolicy} from '../../micro/micro-contracts';
import {bindingInstanceId, configCommitment, utf8Hash, type SourceBinding} from '../source-binding';
import {serviceAllowlistRoot} from '../../paysh/service-allowlist';
import {token6} from '../../paysh/paysh-units';

export const SOURCE = 'use allowit::v1::prelude::*;\n// Fixture source ☕, not compiler output.\nfn new() -> PolicyParams { PolicyParams {} }\n';
export const INTENT = 'Let my agent buy air quality lookups.\nKeep café context unchanged.';
export const IR_HASH = 'ef'.repeat(32);
export const NONCE = '01'.repeat(32);
export const PAYMENT_MINT = deployment.usdcMint;
export const contractRuntime = {
  sourceProfile: 'oracle', wallet: {kind: 'contract-wallet', profile: 'solana-paysh-v1'},
  capabilities: {providerCall: true, fund: true, withdraw: false, revoke: false, revise: false, fork: false, rename: true},
  fundingAsset: {network: 'solana:testnet', symbol: 'Testnet SOL', decimals: 9},
  paymentAsset: {network: 'solana:testnet', symbol: 'Testnet token', decimals: 6, mint: PAYMENT_MINT},
  operation: 'paysh::call', setup: null,
};

export interface BoundSetup {
  id: string;
  binding: SourceBinding;
  config: ChainConfig;
  configBytes: string;
  policyAddress: string;
  solCustody: string;
  rawPolicy: typeof rawPolicy & {maxPaymentUsdcPerPeriod?: string};
  /** `setup.draft` as the common route sends it, with `commonPolicyBinding`. */
  draft: Record<string, unknown>;
  prepared: PreparedSetup;
  preparedJson: Record<string, unknown>;
  micro: (extra?: Partial<MicroPolicy>) => MicroPolicy;
}

export async function boundSetup(over: {revision?: number; config?: Partial<ChainConfig>; binding?: Partial<SourceBinding>; allowedServiceIds?: string[]; maxPaymentUsdcPerPeriod?: string} = {}): Promise<BoundSetup> {
  const revision = over.revision ?? 2;
  const terms = {...chainConfig, ...over.config};
  if (over.maxPaymentUsdcPerPeriod !== undefined) terms.maxUsdcPerPeriod = over.maxPaymentUsdcPerPeriod;
  const version = over.allowedServiceIds ? 2 : 1;
  const walletProfile = `solana-paysh-v${version}`;
  if (over.allowedServiceIds) terms.serviceAllowlistRoot = serviceAllowlistRoot(over.allowedServiceIds, terms);
  // The commitment ignores the instance ID and vault bytes, so it can be taken before they are derived.
  const binding: SourceBinding = {
    version: 1, owner: OWNER, sourceHash: await utf8Hash(SOURCE), irHash: IR_HASH, originalIntentHash: await utf8Hash(INTENT), revision, nonce: NONCE,
    walletKind: 'contract-wallet', walletProfile, configCommitment: await configCommitment(encodeConfig(terms)), ...over.binding,
  };
  const id = await bindingInstanceId(binding);
  const policy = policyAddress(deployment.program, OWNER, id, version);
  const config: ChainConfig = {...terms, instanceId: id, vaultUsdc: associatedAddress(policy, new PublicKey(deployment.usdcMint)).toBase58(), vaultWsol: associatedAddress(policy, NATIVE_MINT).toBase58()};
  const configBytes = encodeConfig(config).toString('base64');
  const custody = solCustody(deployment.program, policy, version).toBase58();
  const raw = {...rawPolicy, id, originalIntent: INTENT, policyAddress: policy.toBase58(), ...(over.allowedServiceIds ? {allowedServiceIds: over.allowedServiceIds, serviceId: over.allowedServiceIds[0]} : {}), ...(over.maxPaymentUsdcPerPeriod === undefined ? {} : {maxPaymentUsdcPerPeriod: over.maxPaymentUsdcPerPeriod})};
  const draft = {draftId: id, policy: raw, profile: {...profile, serviceId: raw.serviceId}, configBytes, title: profile.title, explanation: profile.explanation, methods: ['execute(request)'], commonPolicyBinding: binding};
  const message = v0Message(instructions(config));
  const preparedJson = {
    policy: raw, requestId: REQUEST_ID,
    unsignedTransaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(message)]).toString('base64'),
    message: Buffer.from(message).toString('base64'),
    expectedAccounts: {owner: OWNER, policy: policy.toBase58(), solVault: custody},
    configBytes, allocationLamports: Number(config.allocationLamports),
  };
  const micro = (extra: Partial<MicroPolicy> = {}): MicroPolicy => ({
    id, revision, network: 'solana:testnet', runtime: {...contractRuntime, wallet: {...contractRuntime.wallet, profile: walletProfile}, ...(over.allowedServiceIds ? {providerCallRequirements: over.allowedServiceIds.map(serviceId => ({operation: 'paysh::call', payment_asset_id: deployment.usdcMint, service_id: serviceId, input_key: serviceId, max_payment_units: raw.maxPaymentUsdc.toString(), max_swap_lamports: terms.maxSwapLamportsPerCall, max_service_fee_lamports_per_execution: terms.serviceFeeLamports}))} : {})} as never, fundingRequest: {amount: '0.05', token: 'Testnet SOL'},
    sourceHash: binding.sourceHash, irHash: IR_HASH, code: SOURCE, originalIntent: INTENT,
    language: 'allowit-rust-v1', workflow: [], calls: [], functionHelp: [], requests: [], spentUnits: 0, mint: PAYMENT_MINT, title: profile.title, explanation: '', limit: token6(terms.maxUsdcPerPeriod), token: PAYMENT_MINT,
    status: 'draft', turns: [], createdAt: '', updatedAt: '', activity: [], ...extra,
  });
  return {id, binding, config, configBytes, policyAddress: policy.toBase58(), solCustody: custody, rawPolicy: raw, draft, prepared: parsePrepared(preparedJson), preparedJson, micro};
}
