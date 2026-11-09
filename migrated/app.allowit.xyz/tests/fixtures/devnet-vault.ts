import {Buffer} from 'buffer';
import {Keypair, PublicKey, Transaction} from '@solana/web3.js';
import release from './native-release.json' with {type: 'json'};
import type {WorkflowNode} from '../../src/micro/micro-contracts';
import {ownerInstructions} from '../../src/native-vault/native-wallet-intent';
import {units, type Binding, type NativeConfig, type NativeX402Service, type OwnerMethod, type Policy, type Prepared} from '../../src/native-vault/native-contracts';

/**
 * Synthetic native-vault-v2 owner fixtures. Keys follow the SDK's v2 codec reference (owner/executor/authority seeds
 * 1/2/3, mint 4, policy 7, custody 9, blockhash 10); the vault PDA and token account are derived as the SDK's
 * `public_binding` does. No RPC, chain or backend acceptance is implied. Prepared values mirror the Rust backend's
 * `native/prepare` reply: intent, message, a one-slot zero-signature unsigned transaction, binding and operation.
 */

export const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
export const ownerKeypair = Keypair.fromSeed(new Uint8Array(32).fill(1));
export const executor = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();
export const authority = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
export const owner = ownerKeypair.publicKey.toBase58();
export const recipientWallet = Keypair.fromSeed(new Uint8Array(32).fill(6)).publicKey.toBase58();
export const x402Service: NativeX402Service = {
  id: 'x402-demo-merchant', name: 'Allowit x402 research demo', resourceUrl: 'https://x402-demo.example.test/research', recipient: recipientWallet,
  action: 'research', maxAmount: '1', network: 'solana:devnet', scheme: 'allowit-native',
};
/** Compiler-style scalar projection for browser cross-checks. No compiler execution is claimed. */
export function projectedSource(action = '1', daily = '5', recipient = recipientWallet) {
  const rules = [
    {name: 'cap_per_transaction', source: `allowit::cap_per_transaction(ctx.amount_units, &ctx.token, ${Number(action) * 1_000_000}, "USDC", 6)?`, arguments: [action, 'USDC']},
    {name: 'set_cap_per_day', source: `allowit::set_cap_per_day(ctx.spent_today_units, ctx.amount_units, &ctx.token, ${Number(daily) * 1_000_000}, "USDC", 6)?`, arguments: [daily, 'USDC']},
    {name: 'require_recipient', source: `allowit::require_recipient(&ctx.recipient, "${recipient}")?`, arguments: [recipient]},
  ];
  const code = 'use allowit::v1::prelude::*;\nasync fn _execute(ctx: &Context, params: &PolicyParams) -> PolicyResult {\n' + rules.map(r => r.source + ';').join('\n') + '\nOk(())\n}';
  const workflow: WorkflowNode[] = rules.map((r, i) => ({...r, id: 'rule-' + i, kind: 'function', label: r.name, description: '', start: code.indexOf(r.source), end: code.indexOf(r.source) + r.source.length}));
  return {code, workflow};
}
/** The one-rule tail expression from the reported short-policy case. */
export function projectedShortSource() {
  const source = 'allowit::cap_per_transaction(ctx.amount_units, &ctx.token, 10_000_000, "USDC", 6)';
  const code = 'use allowit::v1::prelude::*;\nasync fn _execute(ctx: &Context, params: &PolicyParams) -> PolicyResult {\n    ' + source + '\n}';
  const workflow: WorkflowNode[] = [{id:'short-cap',name:'cap_per_transaction',kind:'function',label:'Per transaction limit',description:'',arguments:['10','USDC'],source,start:code.indexOf(source),end:code.indexOf(source)+source.length}];
  return {code,workflow};
}
/** Mirrors native-service's replacement of a standalone recipient with one compiler custom block. */
export function projectedX402Source(source = projectedSource()) {
  const direct = source.workflow.filter(n => n.kind === 'function' && n.name === 'require_recipient');
  let base = source.code;
  for (const node of direct) base = base.replace(node.source + (node.source.endsWith(';') ? '' : ';'), '');
  const inner = `if !allowit::is_one_of(&ctx.merchant, &["${x402Service.id}"])? {\n        return allowit::fail("Service is not on the owner's whitelist");\n    }\n    if allowit::is_one_of(&ctx.merchant, &["${x402Service.id}"])? {\n        allowit::require_recipient(&ctx.recipient, "${x402Service.recipient}")?;\n    }`;
  const block = `\n    // AllowIt service whitelist: start\n    ${inner}\n    // AllowIt service whitelist: end\n`;
  const at = base.indexOf('{', base.indexOf('async fn _execute')) + 1;
  const code = base.slice(0, at) + block + base.slice(at);
  const start = code.indexOf(inner);
  const workflow: WorkflowNode[] = [
    {id: 'native-x402-whitelist', name: 'custom', kind: 'custom', label: 'Custom code', description: '', arguments: [], source: inner, start, end: start + inner.length},
    ...source.workflow.filter(n => !direct.includes(n)).map(n => ({...n, start: code.indexOf(n.source), end: code.indexOf(n.source) + n.source.length})),
  ];
  return {code, workflow};
}
export const blockhash = key(10).toBase58();
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export const config: NativeConfig = {
  genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', network: 'solana:devnet', rpcUrl: 'https://api.devnet.solana.com', mint: key(4).toBase58(), executor, authority, release,
  deployment: {network: 'solana:devnet', sourceBundle: release.sourceBundle, policy: key(7).toBase58(), policyData: PublicKey.findProgramAddressSync([key(7).toBuffer()], LOADER)[0].toBase58(), custody: key(9).toBase58()},
  x402Services: [x402Service],
};
export const policy: Policy = {
  version: 2, instance: '00000000-0000-4000-8000-000000000000', profile: 'solana-native-v2', network: 'solana:devnet', prompt: 'Spend up to 5 test tokens per day', dailyLimit: '5', actionLimit: '1', payDiscovery: false,
  executionPolicyDigest: '21'.repeat(32), executionRequirementsDigest: '22'.repeat(32), semanticRequired: false, sourceBundle: release.sourceBundle, id: 'aa'.repeat(32),
  policyArtifact: release.artifacts.find(a => a.name === 'allowit_policy.so')!.sha256, rust: release.sources['policy.rs'],
};

/** Derived independently of the implementation: seed `allowit-vault-v2`, owner, policy id; ATA off curve. */
const [vault, bump] = PublicKey.findProgramAddressSync([Buffer.from('allowit-vault-v2'), new PublicKey(owner).toBuffer(), Buffer.from(policy.id, 'hex')], key(9));
export const binding: Binding = {
  owner, executor, authority, mint: config.mint, vault: vault.toBase58(), tokenAccount: PublicKey.findProgramAddressSync([vault.toBuffer(), TOKEN.toBuffer(), key(4).toBuffer()], ATA)[0].toBase58(),
  policy: config.deployment.policy, policyData: config.deployment.policyData, custody: config.deployment.custody, bump,
};

/** The SDK `Intent` serialization, written out literally in its field order. */
export function intentJson(method: OwnerMethod, amount: string | null, instanceSlot: number | null, b: Binding = binding, recipientWallet?: string) {
  const s = (v: string | null) => (v === null ? 'null' : `"${v}"`);
  return `{"policyId":"${policy.id}","network":"${policy.network}","owner":"${owner}","method":"${method}","amount":${s(amount)},"recipient":null,"expiresAt":null,"commitment":null,"instanceSlot":${instanceSlot === null ? 'null' : instanceSlot},` +
    `"binding":{"owner":"${b.owner}","executor":"${b.executor}","authority":"${b.authority}","mint":"${b.mint}","vault":"${b.vault}","tokenAccount":"${b.tokenAccount}","policy":"${b.policy}","policyData":"${b.policyData}","custody":"${b.custody}","bump":${b.bump}}${recipientWallet === undefined ? '': `,"recipientWallet":"${recipientWallet}"`}}`;
}

export interface PrepareInput {dailyLimit?: string; actionLimit?: string; recipientWallet?: string; id?: string; amount?: string; revision?: string; nonce?: string; instanceSlot?: number; lastValidBlockHeight?: number}
export function prepared(method: OwnerMethod, input: PrepareInput = {}): Prepared {
  const {recipientWallet, id = `owner-${method}-0001`, amount, revision = '0', nonce = '0', instanceSlot, lastValidBlockHeight = 100} = input;
  const tx = new Transaction({feePayer: new PublicKey(owner), blockhash, lastValidBlockHeight}).add(...ownerInstructions(binding, method, {
    recipientWallet, amount: amount === undefined ? undefined : units(amount), revision: BigInt(revision), instanceSlot: instanceSlot === undefined ? undefined : BigInt(instanceSlot),
    policyId: policy.id, sourceBundle: policy.sourceBundle, policyArtifact: policy.policyArtifact, dailyLimit: units(input.dailyLimit ?? '5'), actionLimit: units(input.actionLimit ?? '1'),
  }));
  const message = tx.serializeMessage();
  return {
    intent: intentJson(method, amount ?? null, instanceSlot ?? null, binding, recipientWallet), message: message.toString('base64'),
    unsignedTransaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64'), binding,
    operation: {id, method, policyId: policy.id, status: 'prepared', blockhash, lastValidBlockHeight, nonce: method === 'deploy' ? null : nonce, revision: method === 'deploy' ? null : revision, ...(instanceSlot === undefined ? {} : {instanceSlot})},
  };
}

/** What a wallet returns: the exact message with the owner's signature. */
export function walletSign(transaction: Transaction) {
  transaction.sign(ownerKeypair);
  return transaction;
}
