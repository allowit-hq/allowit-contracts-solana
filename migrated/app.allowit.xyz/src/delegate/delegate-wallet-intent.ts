import {Buffer} from 'buffer';
import {sha256} from '@noble/hashes/sha256';
import {ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction} from '@solana/web3.js';
import type {SolanaSignTransactionFeature} from '@solana/wallet-standard-features';
import {sha256Hex} from '../runtime/hash';
import {connectAccount, transactionWallet} from '../wallet/wallet';
import {encodeBase58} from '../wallet/allocation';
import {privateLocalnetEnabled} from '../wallet/runtime-network';
import {delegateUnits, type DelegateConfig, type DelegateGrant, type DelegatePreparation, type DelegateProof, type DelegateReturnPreparation} from './delegate-contracts';
import {recordDelegateWalletDiagnostic} from './delegate-wallet-diagnostics';

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const GENESIS = {
  'solana:mainnet': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  'solana:testnet': '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  'solana:devnet': 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
} as const;
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);
const meta = (value: string, isWritable = false, isSigner = false) => ({pubkey: new PublicKey(value), isWritable, isSigner});

export function delegateSourceAccount(owner: string, mint: string): string {
  return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(), TOKEN.toBuffer(), new PublicKey(mint).toBuffer()], ATA)[0].toBase58();
}

/** SPL token account size and its rent-exempt minimum, deposited by the fee payer and refunded on close. */
export const POLICY_ACCOUNT_RENT = 2_039_280;
/** Each root grant's own token account: PublicKey.createWithSeed(owner, grant id, SPL Token), computed synchronously. */
export function delegatePolicyAccount(owner: string, grantId: string): string {
  const seed = new TextEncoder().encode(grantId);
  if (!seed.length || seed.length > 32 || !/^[\x21-\x7e]+$/.test(grantId)) throw new Error('The grant ID cannot seed a policy token account.');
  return new PublicKey(sha256(Buffer.concat([new PublicKey(owner).toBuffer(), Buffer.from(seed), TOKEN.toBuffer()]))).toBase58();
}
/** True when a root grant spends from its own policy account; grants on the main account keep their original transactions. */
export function usesPolicyAccount(grant: Pick<DelegateGrant, 'id' | 'owner' | 'sourceAccount' | 'parentGrantId'>): boolean {
  try {return grant.parentGrantId === null && grant.sourceAccount === delegatePolicyAccount(grant.owner, grant.id);} catch {return false;}
}
const u64 = (value: bigint) => {const data = Buffer.alloc(8); data.writeBigUInt64LE(value); return data;};

/** Create, initialize and fund the policy account before its approval. The fee payer deposits the rent. */
function fundingInstructions(grant: DelegateGrant, feePayer: string): TransactionInstruction[] {
  const owner = new PublicKey(grant.owner), account = new PublicKey(grant.sourceAccount);
  return [
    SystemProgram.createAccountWithSeed({fromPubkey: new PublicKey(feePayer), newAccountPubkey: account, basePubkey: owner, seed: grant.id, lamports: POLICY_ACCOUNT_RENT, space: 165, programId: TOKEN}),
    new TransactionInstruction({programId: TOKEN, keys: [meta(grant.sourceAccount, true), meta(grant.mint)], data: Buffer.concat([Buffer.from([18]), owner.toBuffer()])}),
    new TransactionInstruction({programId: TOKEN, keys: [meta(delegateSourceAccount(grant.owner, grant.mint), true), meta(grant.mint), meta(grant.sourceAccount, true), meta(grant.owner, false, true)],
      data: Buffer.concat([Buffer.from([12]), u64(delegateUnits(grant.budgetUnits)), Buffer.from([6])])}),
  ];
}

function allowanceInstructions(grant: DelegateGrant, action: 'approve' | 'revoke', memoSigner?: string | null): TransactionInstruction[] {
  const amount = delegateUnits(grant.budgetUnits);
  if (amount === 0n) throw new Error('The reviewed allocation must be positive.');
  const data = action === 'approve' ? Buffer.alloc(10) : Buffer.from([5]);
  if (action === 'approve') {data[0] = 13; data.writeBigUInt64LE(amount, 1); data[9] = 6;}
  return [
    new TransactionInstruction({
      programId: TOKEN, data,
      keys: action === 'approve'
        ? [meta(grant.sourceAccount, true), meta(grant.mint), meta(grant.delegate), meta(grant.owner, false, true)]
        : [meta(grant.sourceAccount, true), meta(grant.owner, false, true)],
    }),
    new TransactionInstruction({programId: MEMO, keys: memoSigner ? [meta(memoSigner, false, true)] : [], data: Buffer.from(grant.memo, 'utf8')}),
  ];
}

const setupCompute = () => [ComputeBudgetProgram.setComputeUnitLimit({units: 100_000}), ComputeBudgetProgram.setComputeUnitPrice({microLamports: 0})];

/** Bound setup work and pin zero priority fee before the wallet reviews the exact message. Only a policy-account approval moves the budget, into that account. */
export function delegateInstructions(grant: DelegateGrant, action: 'approve' | 'revoke', memoSigner?: string | null, feePayer = grant.owner): TransactionInstruction[] {
  return [
    ...setupCompute(),
    ...(action === 'approve' && usesPolicyAccount(grant) ? fundingInstructions(grant, feePayer) : []),
    ...allowanceInstructions(grant, action, memoSigner),
  ];
}

/** Return every remaining unit to the main account and close the policy account; its rent goes back to `rentPayer`. */
export function returnInstructions(grant: DelegateGrant, units: bigint, rentPayer: string): TransactionInstruction[] {
  const funding = delegateSourceAccount(grant.owner, grant.mint);
  return [
    ...setupCompute(),
    ...(units > 0n ? [new TransactionInstruction({programId: TOKEN, keys: [meta(grant.sourceAccount, true), meta(grant.mint), meta(funding, true), meta(grant.owner, false, true)],
      data: Buffer.concat([Buffer.from([12]), u64(units), Buffer.from([6])])})] : []),
    new TransactionInstruction({programId: TOKEN, keys: [meta(grant.sourceAccount, true), meta(rentPayer, true), meta(grant.owner, false, true)], data: Buffer.from([9])}),
    new TransactionInstruction({programId: MEMO, keys: [], data: Buffer.from(`allowit-return-v1:${grant.commitmentHash}`, 'utf8')}),
  ];
}

function checkedMemoSigner(value: unknown, grant: DelegateGrant, owner: string, feePayer: string, blockhash: string, programs: string[]): string | null {
  if (value === undefined || value === null) return null;
  const forbidden = new Set([owner, feePayer, grant.delegate, grant.sourceAccount, delegateSourceAccount(owner, grant.mint), grant.mint, grant.genesisHash, blockhash,
    TOKEN.toBase58(), ATA.toBase58(), MEMO.toBase58(), ComputeBudgetProgram.programId.toBase58(), '11111111111111111111111111111111', ...programs]);
  try {
    if (typeof value !== 'string' || feePayer !== owner || forbidden.has(value)
      || new PublicKey(value).toBase58() !== value || !PublicKey.isOnCurve(new PublicKey(value).toBytes())) throw new Error();
  } catch {throw new Error('The Memo signer must be a separate readonly signing account for this owner-paid transaction. Nothing was signed.');}
  return value;
}

/** Public clusters have an exact asset/genesis pair; local fixtures never opt into a public cluster. */
export function checkedDelegateConfig(config: DelegateConfig, expectedNetwork?: string): DelegateConfig {
  const local = config.displayNetwork === 'solana:localnet';
  const publicGenesis = Object.values(GENESIS).some(value => value === config.genesisHash);
  const expectedMint = config.displayNetwork === 'solana:mainnet' ? MAINNET_USDC : config.displayNetwork === 'solana:devnet' ? DEVNET_USDC : null;
  const correctGenesis = local
    ? privateLocalnetEnabled && !publicGenesis && config.genesisHash !== '11111111111111111111111111111111'
    : expectedMint !== null && GENESIS[config.displayNetwork as 'solana:mainnet'|'solana:devnet'] === config.genesisHash;
  if (config.decimals !== 6 || config.tokenProgram !== TOKEN.toBase58()
    || !correctGenesis
    || (expectedNetwork !== undefined && config.displayNetwork !== expectedNetwork)
    || (config.network !== config.displayNetwork && config.network !== `solana:${config.genesisHash.slice(0, 32)}`)
    || (local ? config.mint === MAINNET_USDC || config.mint === DEVNET_USDC : config.mint !== expectedMint)) {
    throw new Error('The delegated configuration does not match the requested network, canonical USDC mint or token program.');
  }
  for (const value of [config.mint,config.genesisHash,...(config.setupFeePayer?[config.setupFeePayer]:[])]) {
    if (new PublicKey(value).toBase58() !== value) throw new Error('The delegated configuration contains an invalid wallet address.');
  }
  return config;
}

function assertBinding(config: DelegateConfig, grant: DelegateGrant, owner: string): void {
  checkedDelegateConfig(config);
  if (grant.displayNetwork !== config.displayNetwork || grant.genesisHash !== config.genesisHash
    || (grant.network !== config.network && grant.network !== config.displayNetwork)
    || grant.owner !== owner || grant.mint !== config.mint || grant.delegate !== config.delegate
    || owner === grant.delegate || (grant.sourceAccount !== delegateSourceAccount(owner, config.mint) && !usesPolicyAccount(grant))
    || (grant.policyAccount !== undefined && grant.policyAccount !== usesPolicyAccount(grant))
    || !/^[a-f0-9]{64}$/.test(grant.sourceHash) || !/^[a-f0-9]{64}$/.test(grant.irHash)
    || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= 0
    || !Number.isSafeInteger(grant.revision) || grant.revision < 0
    || (grant.parentGrantId !== null && typeof grant.parentGrantId !== 'string') || typeof grant.policyId !== 'string'
    || !/^[a-f0-9]{64}$/.test(grant.commitmentHash) || grant.memo !== `allowit-grant-v1:${grant.commitmentHash}`) {
    throw new Error('The grant does not match this owner, network, USDC account or reviewed source binding. Nothing was signed.');
  }
  for (const value of [owner, grant.mint, grant.delegate, grant.sourceAccount, config.genesisHash, config.setupFeePayer ?? owner]) {
    if (new PublicKey(value).toBase58() !== value) throw new Error('The grant contains an invalid wallet address.');
  }
}

/** Exact server commitment bytes bind the source, original intent and allocation. */
export async function verifyDelegateGrant(config: DelegateConfig, grant: DelegateGrant, owner: string): Promise<void> {
  assertBinding(config, grant, owner);
  const bytes = Buffer.from(grant.commitmentBytesBase64, 'base64');
  if (bytes.length === 0 || bytes.length > 32_768
    || await sha256Hex(bytes) !== grant.commitmentHash
    || await sha256Hex(new TextEncoder().encode(grant.source)) !== grant.sourceHash) {
    throw new Error('The saved grant commitment or exact Rust source could not be verified. Nothing was signed.');
  }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The grant commitment is invalid.');
  const commitment = value as Record<string, unknown>;
  const committedBudget = commitment.budgetUnits;
  if ((typeof committedBudget !== 'string' && (typeof committedBudget !== 'number' || !Number.isSafeInteger(committedBudget)))
    || String(committedBudget) !== grant.budgetUnits) throw new Error('The grant commitment budget cannot be verified as exact integer units.');
  const expected = {
    version: 1, grantId: grant.id, owner: grant.owner, network: grant.network,
    genesisHash: grant.genesisHash, mint: grant.mint, sourceTokenAccount: grant.sourceAccount,
    delegate: grant.delegate, sourceHash: grant.sourceHash, irHash: grant.irHash,
    expiresAt: grant.expiresAt, revision: grant.revision, policyId: grant.policyId,
    intentHash: await sha256Hex(new TextEncoder().encode(grant.intent)),
  };
  for (const [key, field] of Object.entries(expected)) {
    if (commitment[key] !== field) throw new Error('The grant commitment differs from the source, intent or budget you are reviewing. Nothing was signed.');
  }
  // Core v1 omits None rather than encoding null. A child must bind its exact parent.
  if (grant.parentGrantId === null ? Object.hasOwn(commitment, 'parentGrantId') : commitment.parentGrantId !== grant.parentGrantId) {
    throw new Error('The grant commitment has a different parent binding. Nothing was signed.');
  }
}

/** Reject all server-provided instruction/account changes before opening a wallet. */
export function checkedDelegateTransaction(config: DelegateConfig, grant: DelegateGrant, owner: string, action: 'approve' | 'revoke', preparation: DelegatePreparation): Transaction {
  assertBinding(config, grant, owner);
  const feePayer = config.setupFeePayer ?? owner;
  if (preparation.grantId !== grant.id || !preparation.preparationId || preparation.action !== action
    || preparation.genesisHash !== grant.genesisHash || preparation.sourceAccount !== grant.sourceAccount
    || preparation.mint !== grant.mint || preparation.delegate !== grant.delegate
    || preparation.budgetUnits !== grant.budgetUnits || preparation.memo !== grant.memo
    || preparation.feePayer !== feePayer || !Number.isSafeInteger(preparation.lastValidBlockHeight)
    || preparation.lastValidBlockHeight <= 0 || preparation.transactionBase64.length > 8_192) {
    throw new Error('The prepared transaction differs from the reviewed grant. Nothing was signed.');
  }
  const funds = action === 'approve' && usesPolicyAccount(grant);
  if (funds && (preparation.fundingAccount !== delegateSourceAccount(owner, grant.mint) || preparation.rentLamports !== String(POLICY_ACCOUNT_RENT))) {
    throw new Error('The prepared transaction funds the policy token account from another account or deposit. Nothing was signed.');
  }
  const transaction = Transaction.from(Buffer.from(preparation.transactionBase64, 'base64'));
  if (!transaction.recentBlockhash || transaction.feePayer?.toBase58() !== feePayer
    || transaction.nonceInfo || transaction.signatures.some(entry => entry.publicKey.toBase58() === owner && entry.signature !== null)) {
    throw new Error('The transaction payer, lifetime or owner signature is invalid. Nothing was signed.');
  }
  const memoSigner = checkedMemoSigner(preparation.memoSigner, grant, owner, feePayer, transaction.recentBlockhash, transaction.instructions.map(ix => ix.programId.toBase58()));
  const expected = new Transaction({feePayer: new PublicKey(feePayer), recentBlockhash: transaction.recentBlockhash})
    .add(...delegateInstructions(grant, action, memoSigner, feePayer));
  // Existing saved proofs must remain recoverable with their exact original message. No such format funds an account.
  const legacy = new Transaction({feePayer: new PublicKey(feePayer), recentBlockhash: transaction.recentBlockhash})
    .add(...allowanceInstructions(grant, action));
  if (!equal(transaction.serializeMessage(), expected.serializeMessage())
    && (memoSigner !== null || funds || !equal(transaction.serializeMessage(), legacy.serializeMessage()))) {
    throw new Error('The transaction changes the allowance, memo or accounts you reviewed. Nothing was signed.');
  }
  if (memoSigner !== null && (!transaction.signatures.find(entry => entry.publicKey.toBase58() === memoSigner)?.signature
    || !transaction.verifySignatures(false))) {
    throw new Error('The Memo signer signature is missing or invalid. Nothing was signed.');
  }
  const allowed = new Set([owner, feePayer, ...(memoSigner ? [memoSigner] : [])]);
  if (transaction.signatures.length !== allowed.size || transaction.signatures.some(entry => !allowed.has(entry.publicKey.toBase58()))
    || !transaction.verifySignatures(false)
    || (feePayer !== owner && !transaction.signatures.find(entry => entry.publicKey.toBase58() === feePayer)?.signature)) {
    throw new Error('The transaction has an unapproved signer or missing sponsor signature. Nothing was signed.');
  }
  return transaction;
}

/** Rebuild the exact return. Its rent refund goes to whoever could have deposited it: the owner, this deployment's
 * setup fee payer, or the fee payer of this grant's own approval saved on this device. */
export function checkedReturnTransaction(config: DelegateConfig, grant: DelegateGrant, owner: string, preparation: DelegateReturnPreparation, approvalFeePayer?: string | null): Transaction {
  assertBinding(config, grant, owner);
  const feePayer = config.setupFeePayer ?? owner, funding = delegateSourceAccount(owner, grant.mint);
  let units: bigint;
  try {units = delegateUnits(preparation.returnUnits);} catch {throw new Error('The return amount is not an exact integer. Nothing was signed.');}
  if (!usesPolicyAccount(grant) || grant.status !== 'revoked' || preparation.action !== 'return' || preparation.grantId !== grant.id || !preparation.preparationId
    || preparation.sourceAccount !== grant.sourceAccount || preparation.fundingAccount !== funding || preparation.mint !== grant.mint
    || preparation.genesisHash !== grant.genesisHash || preparation.feePayer !== feePayer
    || ![owner, config.setupFeePayer, approvalFeePayer].includes(preparation.rentPayer)
    || preparation.memo !== `allowit-return-v1:${grant.commitmentHash}` || units > delegateUnits(grant.budgetUnits)
    || !Number.isSafeInteger(preparation.lastValidBlockHeight) || preparation.lastValidBlockHeight <= 0 || preparation.transactionBase64.length > 8_192) {
    throw new Error('The prepared return differs from this policy account, your USDC account or its rent refund. Nothing was signed.');
  }
  const transaction = Transaction.from(Buffer.from(preparation.transactionBase64, 'base64'));
  if (!transaction.recentBlockhash || transaction.feePayer?.toBase58() !== feePayer || transaction.nonceInfo
    || transaction.signatures.some(entry => entry.publicKey.toBase58() === owner && entry.signature !== null)) {
    throw new Error('The transaction payer, lifetime or owner signature is invalid. Nothing was signed.');
  }
  const expected = new Transaction({feePayer: new PublicKey(feePayer), recentBlockhash: transaction.recentBlockhash})
    .add(...returnInstructions(grant, units, preparation.rentPayer));
  if (!equal(transaction.serializeMessage(), expected.serializeMessage())) {
    throw new Error('The transaction changes the return amount, accounts or memo you reviewed. Nothing was signed.');
  }
  const allowed = new Set([owner, feePayer]);
  if (transaction.signatures.length !== allowed.size || transaction.signatures.some(entry => !allowed.has(entry.publicKey.toBase58()))
    || !transaction.verifySignatures(false)
    || (feePayer !== owner && !transaction.signatures.find(entry => entry.publicKey.toBase58() === feePayer)?.signature)) {
    throw new Error('The transaction has an unapproved signer or missing sponsor signature. Nothing was signed.');
  }
  return transaction;
}

/** Sign only through Wallet Standard. Submission always goes back to the owner-session API. */
export async function signDelegateOwner(config: DelegateConfig, grant: DelegateGrant, owner: string, action: 'approve' | 'revoke', preparation: DelegatePreparation, current: () => boolean): Promise<DelegateProof> {
  if (action === 'approve' && !config.ready) throw new Error('New approvals are unavailable on this deployment. Existing proofs and revocation remain available.');
  await verifyDelegateGrant(config, grant, owner);
  const transaction = checkedDelegateTransaction(config, grant, owner, action, preparation);
  if (transaction.instructions.length === 2 || (preparation.feePayer === owner && !preparation.memoSigner)) {
    throw new Error('Wait for this preparation to expire, then prepare a fresh transaction before signing. Nothing was signed.');
  }
  const signed = await signReviewed(config, owner, transaction, action, current);
  return {grantId: grant.id, preparationId: preparation.preparationId, operation: action, ...signed};
}

/** Owner-only: moves the policy account's own remaining USDC back to the main account. */
export async function signDelegateReturn(config: DelegateConfig, grant: DelegateGrant, owner: string, preparation: DelegateReturnPreparation, current: () => boolean, approvalFeePayer?: string | null): Promise<Omit<DelegateProof, 'operation'> & {operation: 'return'}> {
  await verifyDelegateGrant(config, grant, owner);
  const transaction = checkedReturnTransaction(config, grant, owner, preparation, approvalFeePayer);
  const signed = await signReviewed(config, owner, transaction, 'return', current);
  return {grantId: grant.id, preparationId: preparation.preparationId, operation: 'return', ...signed};
}

async function signReviewed(config: DelegateConfig, owner: string, transaction: Transaction, action: DelegateProof['operation'] | 'return', current: () => boolean): Promise<Pick<DelegateProof, 'signedTransactionBase64' | 'signature'>> {
  if (!current()) throw new Error('The signed-in owner or selected grant changed. Nothing was signed.');
  const wallet = transactionWallet(owner);
  const feature = wallet.features['solana:signTransaction'] as SolanaSignTransactionFeature['solana:signTransaction'] | undefined;
  if (!feature?.supportedTransactionVersions.includes('legacy')) throw new Error('Use a wallet that supports signing a Solana transaction without sending it.');
  const account = await connectAccount(wallet, owner);
  if (!current() || account.address !== owner || !account.chains.includes(config.displayNetwork)
    || !account.features.includes('solana:signTransaction')) throw new Error('Select the signed-in owner and the reviewed network in your wallet. Nothing was signed.');
  const request = Uint8Array.from(transaction.serialize({requireAllSignatures: false, verifySignatures: false}));
  const [result] = await feature.signTransaction({
    account, chain: config.displayNetwork,
    transaction: new Uint8Array(request),
  });
  if (!(result?.signedTransaction instanceof Uint8Array)) throw new Error('The wallet returned no signed transaction. Nothing was submitted.');
  const signed = Transaction.from(result.signedTransaction);
  if (!equal(signed.serializeMessage(), transaction.serializeMessage())) {
    const changes = await recordDelegateWalletDiagnostic({walletName: wallet.name, featureVersion: feature.version,
      chain: config.displayNetwork, action, request, returned: result.signedTransaction});
    throw new Error(`The wallet changed the reviewed transaction. ${changes} Nothing was submitted.`);
  }
  if (!signed.verifySignatures()) {
    throw new Error('The wallet returned an invalid signature. Nothing was submitted.');
  }
  const ownerSignature = signed.signatures.find(entry => entry.publicKey.toBase58() === owner)?.signature;
  if (!ownerSignature) throw new Error('The owner signature is missing. Nothing was submitted.');
  return {
    signedTransactionBase64: Buffer.from(signed.serialize()).toString('base64'),
    signature: encodeBase58(signed.signature ?? ownerSignature),
  };
}
