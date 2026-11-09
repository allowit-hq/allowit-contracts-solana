/** Deterministic PaySH setup values for unit tests. Keys are generated from fixed seeds; none are real deployments. */
import {Buffer} from 'buffer';
import {AddressLookupTableAccount, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedMessage, VersionedTransaction} from '@solana/web3.js';
import {parseDraft, TESTNET_GENESIS, type ChainConfig, type PayshDeployment, type PayshPolicy, type PolicyDraft, type PreparedSetup} from '../paysh-contracts';
import {associatedAddress, encodeConfig, expectedInstructions, NATIVE_MINT, policyAddress, solCustody, TOKEN_PROGRAM, type Ix} from '../paysh-wallet-intent';

const key = (seed: number) => Keypair.fromSeed(new Uint8Array(32).fill(seed)).publicKey.toBase58();
export const owner = Keypair.fromSeed(new Uint8Array(32).fill(7));
export const OWNER = owner.publicKey.toBase58();
export const POLICY_ID = 'ab'.repeat(32);
export const MODULE = 'cd'.repeat(32);
const pool = {program: key(16), state: key(17), wsol: key(18), usdc: key(19), oracle: key(20)};
export const deployment: PayshDeployment = {
  program: key(11), genesis: TESTNET_GENESIS, moduleDigest: MODULE, evaluator: key(12), treasury: key(13), usdcMint: key(14), vendorUsdc: key(15), pool, computeLimit: 400_000,
  // Shared, read-only deployment accounts. Per-policy writable accounts are never in it.
  lookupTable: {address: key(22), addresses: [pool.program, pool.state, pool.wsol, pool.usdc, pool.oracle, key(14), key(15), key(13), TOKEN_PROGRAM.toBase58(), NATIVE_MINT.toBase58()]},
};
export const POLICY_ADDRESS = policyAddress(deployment.program, OWNER, POLICY_ID);
export const SOL_CUSTODY = solCustody(deployment.program, POLICY_ADDRESS);
export const VAULT_USDC = associatedAddress(POLICY_ADDRESS, new PublicKey(deployment.usdcMint)).toBase58();
export const VAULT_WSOL = associatedAddress(POLICY_ADDRESS, NATIVE_MINT).toBase58();
export const rawPolicy = {
  id: POLICY_ID, owner: OWNER, originalIntent: 'Let my agent buy air quality lookups.', network: 'solana:testnet', serviceId: 'solana-foundation/google/airquality',
  policyAddress: POLICY_ADDRESS.toBase58(), moduleDigest: MODULE, allocationLamports: 50_000_000, maxPaymentUsdc: 1000, maxSwapLamports: 2_000_000, maxServiceFeeLamports: 5000, preferenceThresholdBps: 9000,
  semanticQuestion: 'Is this exact air quality lookup, including any swap and fee, what the owner asked the agent to buy?',
};
export const policy: PayshPolicy = {...rawPolicy, network: 'solana:testnet', allocationLamports: '50000000', maxPaymentUsdc: '1000', maxSwapLamports: '2000000', maxServiceFeeLamports: '5000'};
export const chainConfig: ChainConfig = {
  instanceId: POLICY_ID, network: TESTNET_GENESIS, moduleDigest: MODULE, evaluator: deployment.evaluator, treasury: deployment.treasury, usdcMint: deployment.usdcMint,
  vaultUsdc: VAULT_USDC, vaultWsol: VAULT_WSOL, vendorUsdc: deployment.vendorUsdc, pool,
  periodSeconds: '86400', maxUsdcPerPeriod: '1000', maxSwapLamportsPerPeriod: '10000000', maxFeeLamportsPerPeriod: '50000', maxSolDebitsPerPeriod: '20000000', maxSwapLamportsPerCall: '2000000',
  maxTotalSwapLamports: '40000000', allocationLamports: '50000000', serviceFeeLamports: '5000', minUsdcPerSol: '100000000', maxPoolFeeBps: '30', maxAgeSlots: '150', maxAgeSeconds: '60',
  policyExpiresTimestamp: '1893456000', ownerOnly: false,
};
export const profile = {
  title: 'Air quality lookups', explanation: 'Buys current air quality readings for the agent.', serviceId: rawPolicy.serviceId, allocationLamports: rawPolicy.allocationLamports, maxPaymentUsdc: rawPolicy.maxPaymentUsdc,
  maxSwapLamports: rawPolicy.maxSwapLamports, maxServiceFeeLamports: rawPolicy.maxServiceFeeLamports, preferenceThresholdBps: rawPolicy.preferenceThresholdBps, semanticQuestion: rawPolicy.semanticQuestion, supported: true,
};
/** The `paysh/generate` reply, in the backend's shape. */
export const generated = {draftId: POLICY_ID, policy: rawPolicy, profile, configBytes: encodeConfig(chainConfig).toString('base64'), title: profile.title, explanation: profile.explanation, methods: ['execute(request)']};
export const draft: PolicyDraft = parseDraft(generated);
export const BLOCKHASH = key(21);
export const REQUEST_ID = 'setup-request-1';
const table = (addresses: string[]) => new AddressLookupTableAccount({key: new PublicKey(deployment.lookupTable!.address), state: {deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addresses.map(a => new PublicKey(a))}});

const web3 = (ix: Ix) => new TransactionInstruction({programId: new PublicKey(ix.programId), data: Buffer.from(ix.data), keys: ix.keys.map(k => ({...k, pubkey: new PublicKey(k.pubkey)}))});
/** The expected setup instructions, optionally edited, compiled by web3.js (a different key order than the SDK). */
export function instructions(config: ChainConfig = chainConfig, edit?: (list: Ix[]) => Ix[]): Ix[] {
  const list = expectedInstructions(deployment, OWNER, config, config.allocationLamports);
  return edit ? edit(list) : list;
}
export function v0Message(list: Ix[] = instructions(), lookup = true, payer = owner.publicKey, addresses = deployment.lookupTable!.addresses): Uint8Array {
  return new TransactionMessage({payerKey: payer, recentBlockhash: BLOCKHASH, instructions: list.map(web3)}).compileToV0Message(lookup ? [table(addresses)] : []).serialize();
}
/** A parsed prepare reply. Defaults to the exact SDK-shaped v0 setup. */
export function prepared(overrides: {config?: Partial<ChainConfig>; message?: Uint8Array; id?: string; solCustody?: string; allocation?: string; owner?: string; policy?: PayshPolicy} = {}): PreparedSetup {
  const config = {...chainConfig, ...overrides.config};
  const message = overrides.message ?? v0Message(instructions(config));
  return {
    requestId: overrides.id ?? REQUEST_ID,
    policy: overrides.policy ?? policy,
    unsignedTransaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), Buffer.from(message)]).toString('base64'),
    message: Buffer.from(message).toString('base64'),
    configBytes: encodeConfig(config).toString('base64'),
    config,
    allocationLamports: overrides.allocation ?? config.allocationLamports,
    accounts: {owner: overrides.owner ?? OWNER, policy: POLICY_ADDRESS.toBase58(), solCustody: overrides.solCustody ?? SOL_CUSTODY.toBase58()},
  };
}
/** The JSON `paysh/prepare` sends for `prepared()`: top-level SDK setup fields with the stored policy. */
export function preparedJson(p: PreparedSetup = prepared()) {
  return {
    policy: rawPolicy,
    requestId: p.requestId,
    unsignedTransaction: p.unsignedTransaction,
    message: p.message,
    expectedAccounts: {owner: p.accounts.owner, policy: p.accounts.policy, solVault: p.accounts.solCustody},
    configBytes: p.configBytes,
    allocationLamports: Number(p.allocationLamports),
  };
}
/** What a wallet returns: the same message with the owner signature. */
export function walletSign(p: PreparedSetup): Uint8Array {
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(p.message, 'base64')));
  tx.sign([owner]);
  return tx.serialize();
}
