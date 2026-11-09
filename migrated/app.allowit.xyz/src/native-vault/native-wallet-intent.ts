import {Buffer} from 'buffer';
import {ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction} from '@solana/web3.js';
import {recipientTokenAccount} from './native-recipient';
import {explorerUrl} from '../wallet/runtime-network';
import {canonicalUnsigned, DEVNET_GENESIS, decimal, isNativeNetwork, isOwnerMethod, matchesPinnedRelease, MAX_LIMIT_UNITS, units, type Binding, type NativeConfig, type Operation, type OwnerMethod, type Policy, type PolicyOptions, type Prepared} from './native-contracts';

/**
 * Browser-side reconstruction of the native-vault-v2 owner transactions. It mirrors the SDK's `public_binding`,
 * `intent_for` and `expected_instructions` (compute budget included) so the wallet is opened only for a message
 * this page derived itself from the owner's choice. The backend still validates policy correctness.
 */

const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const VAULT_SEED = 'allowit-vault-v2';
const COMPUTE_UNITS: Record<OwnerMethod, number> = {deploy: 400_000, fund: 200_000, withdraw: 200_000, close: 200_000, revoke: 200_000};
const BINDING_KEYS = ['owner', 'executor', 'authority', 'mint', 'vault', 'tokenAccount', 'policy', 'policyData', 'custody', 'bump'] as const;

const key = (value: string) => new PublicKey(value);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);
const u64 = (value: bigint) => {const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes;};
const hex32 = (value: string) => {if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid signing binding'); return Buffer.from(value, 'hex');};
const associated = (mint: PublicKey, owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA)[0];
const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({pubkey, isWritable, isSigner});
const idempotentAta = (payer: PublicKey, account: PublicKey, owner: PublicKey, mint: PublicKey) =>
  new TransactionInstruction({programId: ATA, data: Buffer.from([1]), keys: [meta(payer, true, true), meta(account, true), meta(owner), meta(mint), meta(SystemProgram.programId), meta(TOKEN)]});

/** Two fixed Compute Budget instructions lead every owner transaction: a unit limit and a price of one micro-lamport. */
export function computeBudget(method: OwnerMethod): TransactionInstruction[] {
  return [ComputeBudgetProgram.setComputeUnitLimit({units: COMPUTE_UNITS[method]}), ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1n})];
}

/** Values the instruction bytes carry. `revision` comes from the prepared operation; the vault checks it on chain. */
export interface OwnerFields {recipientWallet?: string; amount?: bigint; revision?: bigint; instanceSlot?: bigint; policyId: string; sourceBundle: string; policyArtifact: string; dailyLimit: bigint; actionLimit: bigint}

/** Exact owner instructions for one method, in the SDK's order. */
export function ownerInstructions(b: Binding, method: OwnerMethod, f: OwnerFields): TransactionInstruction[] {
  const owner = key(b.owner), vault = key(b.vault), mint = key(b.mint), tokenAccount = key(b.tokenAccount), custody = key(b.custody), policy = key(b.policy), policyData = key(b.policyData);
  const ownerToken = associated(mint, owner);
  const ix = (data: Buffer, keys: ReturnType<typeof meta>[]) => new TransactionInstruction({programId: custody, data, keys});
  const required = (value: bigint | undefined, what: string) => {if (value === undefined) throw new Error(`Specify the ${what}`); return value;};
  const deposit = (amount: bigint) => ix(Buffer.concat([Buffer.from([1]), u64(amount)]), [meta(vault, true), meta(owner, false, true), meta(ownerToken, true), meta(tokenAccount, true), meta(mint), meta(TOKEN)]);
  let operation: TransactionInstruction[];
  switch (method) {
    case 'deploy':
      operation = [
        idempotentAta(owner, tokenAccount, vault, mint),
        ix(Buffer.concat([Buffer.from([0]), hex32(f.policyId), hex32(f.sourceBundle), hex32(f.policyArtifact), u64(f.dailyLimit), u64(f.actionLimit)]), [meta(vault, true), meta(owner, true, true), meta(mint), meta(tokenAccount), meta(policy), meta(key(b.executor)), meta(SystemProgram.programId), meta(policyData), meta(key(b.authority))]),
        deposit(required(f.amount, 'amount')),
        ix(Buffer.concat([Buffer.from([2, 1]), u64(0n)]), [meta(vault, true), meta(owner, false, true), meta(policy), meta(policyData)]),
      ];
      break;
    case 'fund': operation = [deposit(required(f.amount, 'amount'))]; break;
    case 'revoke': operation = [ix(Buffer.concat([Buffer.from([2, 0]), u64(required(f.revision, 'revision'))]), [meta(vault, true), meta(owner, false, true), meta(policy)])]; break;
    case 'withdraw':
      operation = [idempotentAta(owner, ownerToken, owner, mint), ix(Buffer.concat([Buffer.from([5]), u64(required(f.amount, 'amount'))]), [meta(vault, true), meta(owner, false, true), meta(tokenAccount, true), meta(ownerToken, true), meta(mint), meta(TOKEN)])];
      break;
    case 'close':
      operation = [idempotentAta(owner, ownerToken, owner, mint), ix(Buffer.concat([Buffer.from([9]), u64(required(f.revision, 'revision')), u64(required(f.instanceSlot, 'vault instance slot'))]), [meta(vault, true), meta(owner, true, true), meta(tokenAccount, true), meta(ownerToken, true), meta(mint), meta(TOKEN)])];
      break;
    default: throw new Error('Unsupported owner operation');
  }
  if (f.recipientWallet !== undefined) {
    if (method !== 'deploy' && method !== 'fund') throw new Error('Only setup and funding may create a recipient token account.');
    operation.push(idempotentAta(owner, key(recipientTokenAccount(f.recipientWallet, b.mint)), key(f.recipientWallet), mint));
  }
  return [...computeBudget(method), ...operation];
}

/** The SDK's `public_binding`: the ABI-v2 vault PDA, its token account and the distinct owner, executor and authority. */
export function nativeBinding(config: NativeConfig, policy: Policy, owner: string): Binding {
  const d = config.deployment;
  if (!isNativeNetwork(config.network) || config.genesis !== DEVNET_GENESIS || !matchesPinnedRelease(config.release)
    || policy.network !== config.network || d.network !== config.network || d.sourceBundle !== config.release.sourceBundle
    || policy.sourceBundle !== config.release.sourceBundle || policy.policyArtifact !== config.release.artifacts.find(a => a.name === 'allowit_policy.so')?.sha256) throw new Error('Deployment/network or pinned release mismatch');
  const ownerKey = key(owner), executor = key(config.executor), authority = key(config.authority), mint = key(config.mint), custody = key(d.custody), program = key(d.policy);
  if (!key(d.policyData).equals(PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0])) throw new Error('Policy ProgramData mismatch');
  if (authority.equals(executor) || authority.equals(ownerKey) || executor.equals(ownerKey) || ![ownerKey, executor, authority].every(k => PublicKey.isOnCurve(k.toBytes()))) throw new Error('Native authority, executor, and owner must be distinct');
  const [vault, bump] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_SEED), ownerKey.toBuffer(), hex32(policy.id)], custody);
  return {owner, executor: config.executor, authority: config.authority, mint: config.mint, vault: vault.toBase58(), tokenAccount: associated(mint, vault).toBase58(), policy: d.policy, policyData: d.policyData, custody: d.custody, bump};
}

/** The SDK's canonical `intent_for` JSON, field for field. Only owner methods are built here. */
export function ownerIntent(policy: Policy, owner: string, method: OwnerMethod, options: PolicyOptions, binding: Binding): string {
  const instanceSlot = method === 'close' ? Number(slotOf(options.instanceSlot)) : null;
  return JSON.stringify({
    policyId: policy.id, network: policy.network, owner, method, amount: options.amount === undefined ? null : decimal(units(options.amount)),
    recipient: null, expiresAt: null, commitment: null, instanceSlot, binding: Object.fromEntries(BINDING_KEYS.map(k => [k, binding[k]])),
    ...(options.recipientWallet === undefined ? {} : {recipientWallet: options.recipientWallet}),
  });
}

function slotOf(value: string | undefined): bigint {
  if (!canonicalUnsigned(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Specify the current vault instance');
  return BigInt(value);
}

function checkOptions(method: OwnerMethod, options: PolicyOptions) {
  if (options.recipientWallet !== undefined && method !== 'deploy' && method !== 'fund') throw new Error('Only setup and funding may create a recipient token account.');
  const amount = options.amount === undefined ? undefined : units(options.amount);
  if ((method === 'deploy' || method === 'fund' || method === 'withdraw') && !amount) throw new Error('Enter an amount above 0');
  if ((method === 'revoke' || method === 'close') && amount !== undefined) throw new Error('This owner operation takes no amount');
  if (method === 'close') slotOf(options.instanceSlot);
  else if (options.instanceSlot !== undefined) throw new Error('Only closing names the vault instance');
}

/** Checks the backend's prepared intent, binding and exact message against this page's own reconstruction. */
export function checkedOwnerTransaction(config: NativeConfig, policy: Policy, owner: string, method: OwnerMethod, options: PolicyOptions, prepared: Prepared): Transaction {
  if (!isOwnerMethod(method)) throw new Error('This browser signs only the supported owner operations');
  checkOptions(method, options);
  const artifact = config.release.artifacts.find(a => a.name === 'allowit_policy.so')?.sha256;
  if (policy.network !== config.network || policy.sourceBundle !== config.deployment.sourceBundle || policy.sourceBundle !== config.release.sourceBundle || policy.policyArtifact !== artifact) throw new Error('The selected policy release changed');
  const binding = nativeBinding(config, policy, owner);
  if (prepared.intent !== ownerIntent(policy, owner, method, options, binding)) throw new Error('The prepared operation changed the requested intent');
  for (const name of BINDING_KEYS) if (prepared.binding?.[name] !== binding[name]) throw new Error('The prepared transaction changed the owner or deployment binding');
  const op = prepared.operation;
  if (op.policyId !== policy.id || op.method !== method || !Number.isSafeInteger(op.lastValidBlockHeight) || op.lastValidBlockHeight < 0) throw new Error('Invalid prepared operation identity');
  const needsRevision = method === 'revoke' || method === 'close';
  if (needsRevision && !canonicalUnsigned(op.revision)) throw new Error('Invalid prepared operation revision');
  if (method === 'close' && String(op.instanceSlot) !== options.instanceSlot) throw new Error('The prepared close names another vault instance');
  const expected = new Transaction({feePayer: key(owner), blockhash: op.blockhash, lastValidBlockHeight: op.lastValidBlockHeight}).add(...ownerInstructions(binding, method, {
    recipientWallet: options.recipientWallet,
    amount: options.amount === undefined ? undefined : units(options.amount), revision: needsRevision ? BigInt(op.revision!) : undefined,
    instanceSlot: method === 'close' ? slotOf(options.instanceSlot) : undefined, policyId: policy.id, sourceBundle: policy.sourceBundle, policyArtifact: policy.policyArtifact,
    dailyLimit: limit(policy.dailyLimit), actionLimit: limit(policy.actionLimit),
  }));
  const returned = Transaction.from(Buffer.from(prepared.unsignedTransaction, 'base64'));
  const message = Buffer.from(prepared.message, 'base64');
  if (returned.signatures.length !== 1 || !returned.signatures[0].publicKey.equals(key(owner)) || returned.signatures.some(s => s.signature !== null)) throw new Error('The backend prepared a different wallet intent');
  if (!equal(returned.serializeMessage(), message) || !equal(expected.serializeMessage(), message)) throw new Error('The backend prepared a different wallet intent');
  return returned;
}

function limit(value: string) {
  const n = units(value);
  if (n === 0n || n > MAX_LIMIT_UNITS) throw new Error('Policy limit outside the native ceiling');
  return n;
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let n = 0n, out = '';
  for (const b of bytes) n = n * 256n + BigInt(b);
  while (n) {out = ALPHABET[Number(n % 58n)] + out; n /= 58n;}
  for (const b of bytes) {if (b) break; out = '1' + out;}
  return out;
}

/** The SDK `Record` for the wallet's exact signed bytes. Any changed message or invalid signature is refused. */
export function signedProof(prepared: Prepared, transaction: Transaction, network: NativeConfig['network'], now = new Date()): Operation {
  if (!equal(transaction.serializeMessage(), Buffer.from(prepared.message, 'base64')) || !transaction.verifySignatures() || !transaction.signature) throw new Error('The wallet changed the message or returned invalid signatures');
  const bytes = transaction.serialize();
  const signatures = transaction.signatures.map(s => base58(s.signature!));
  const signature = signatures[0];
  const {id, method, blockhash, lastValidBlockHeight, nonce, revision, instanceSlot} = prepared.operation;
  return {
    id, method, intent: prepared.intent, status: 'uncertain', signature, signatures, signedBytes: bytes.toString('base64'), blockhash, lastValidBlockHeight,
    ...(typeof nonce === 'string' ? {nonce} : {}), ...(typeof revision === 'string' ? {revision} : {}), ...(instanceSlot === undefined || instanceSlot === null ? {} : {instanceSlot: String(instanceSlot)}),
    transactionUrl: explorerUrl('tx', signature, network), signedAt: now.toISOString(),
  };
}

