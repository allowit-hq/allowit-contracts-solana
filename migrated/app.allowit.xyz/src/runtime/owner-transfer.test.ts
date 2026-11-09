import {afterEach, describe, expect, it, vi} from 'vitest';
import {Buffer} from 'buffer';
import {createHash, createPrivateKey, sign as edSign} from 'node:crypto';
import {ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction} from '@solana/web3.js';
import VECTOR from './fixtures/owner-transfer-encoding-v1.json' with {type: 'json'};
import {toBase64} from './authorization-codec';
import {
  BINDING_ORDER, checkOwnerTransferAuthority, MEMO_PROGRAM, ownerRunMemo, ownerTransferMessage,
  parseOwnerTransferBinding, parsePreparedOwnerTransfer, verifySignedOwnerTransfer, type OwnerTransferBinding,
  type PreparedOwnerTransfer,
} from './owner-transfer';

/**
 * The owner-transfer vector is the untouched public Rust encoding fixture (sha256 8b6099ac…): synthetic signer [7; 32]
 * and placeholder source/grant hashes, encoding only. It is not installed authority, source compilation or chain finality.
 * The request-digest vector was produced by Rust serde_json 1.0.151 with the engine's features.
 */
type Prepared = PreparedOwnerTransfer;
const original = (): Prepared => structuredClone(VECTOR.prepared) as Prepared;
const SIGNED = VECTOR.signedBytes;
const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const seed = (n: number) => new Uint8Array(32).fill(n);
const keyOf = (n: number) => Keypair.fromSeed(seed(n)).publicKey.toBase58();
/** Ed25519 by seed through Node's own primitive, independent of the module under test. */
const signWith = (n: number, message: Uint8Array) =>
  new Uint8Array(edSign(null, message, createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed(n))]), format: 'der', type: 'pkcs8'})));
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const wire = (signature: Uint8Array, message: Uint8Array) => toBase64(new Uint8Array([1, ...signature, ...message]));

/** A self-consistent preparation for a binding, as a server would produce one. */
async function prepare(binding: OwnerTransferBinding, over: Partial<Prepared> = {}): Promise<Prepared> {
  const p = {...original(), binding, ...over};
  p.memo = await ownerRunMemo(p.binding);
  const message = ownerTransferMessage(p.binding, p.blockhash, p.memo);
  return {...p, messageBase64: toBase64(message), messageHash: sha(message), unsignedBytes: wire(new Uint8Array(64), message)};
}
const signedFor = (p: Prepared, n = 7) => wire(signWith(n, b64(p.messageBase64)), b64(p.messageBase64));

const OWNER = new PublicKey(VECTOR.prepared.binding.owner), BENEFICIARY = new PublicKey(VECTOR.prepared.binding.beneficiary);
const memoIx = (memo: string, writable = false, signer = true, extra: PublicKey[] = []) =>
  new TransactionInstruction({programId: new PublicKey(MEMO_PROGRAM), keys: [{pubkey: OWNER, isSigner: signer, isWritable: writable}, ...extra.map(pubkey => ({pubkey, isSigner: false, isWritable: false}))], data: Buffer.from(memo)});
const transferIx = (lamports: bigint, to = BENEFICIARY, toWritable = true) => {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return new TransactionInstruction({programId: SystemProgram.programId, keys: [{pubkey: OWNER, isSigner: true, isWritable: true}, {pubkey: to, isSigner: false, isWritable: toWritable}], data});
};
const tx = (ixs: TransactionInstruction[], payer = OWNER, blockhash = VECTOR.prepared.blockhash) => {
  const t = new Transaction();
  t.feePayer = payer;
  t.recentBlockhash = blockhash;
  return t.add(...ixs);
};

afterEach(() => vi.unstubAllGlobals());

describe('canonical Rust golden', () => {
  it('accepts the exact unsigned and signed vector and returns only the signature fact', async () => {
    const c = await parsePreparedOwnerTransfer(original());
    expect(toBase64(c.message)).toBe(VECTOR.prepared.messageBase64);
    expect(c.prepared.unsignedBytes).toBe(VECTOR.prepared.unsignedBytes);
    expect(c.lamports).toBe(1_000_000n);
    const signed = await verifySignedOwnerTransfer(c, SIGNED);
    expect(Object.keys(signed).sort()).toEqual(['signature', 'signedBytes']);
    expect(signed.signedBytes).toBe(SIGNED);
    expect(Buffer.from(signWith(7, c.message)).toString('base64')).toBe(Buffer.from(b64(SIGNED).subarray(1, 65)).toString('base64'));
    expect(new PublicKey(Keypair.fromSeed(seed(7)).publicKey).toBase58()).toBe(VECTOR.prepared.binding.owner);
    // The Base58 signature decodes back to the wire's signature bytes.
    const decoded = [...signed.signature].reduce((n, ch) => n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(ch)), 0n);
    expect(decoded.toString(16).padStart(128, '0')).toBe(Buffer.from(b64(SIGNED).subarray(1, 65)).toString('hex'));
  });

  it('keeps original bytes private when a wallet mutates its message copy', async () => {
    const c = await parsePreparedOwnerTransfer(original());
    const exposed = c.message;
    exposed[exposed.length - 1] ^= 1;
    expect(toBase64(c.message)).toBe(VECTOR.prepared.messageBase64);
    await expect(verifySignedOwnerTransfer(c, wire(signWith(7, exposed), exposed))).rejects.toThrow();
    expect((await verifySignedOwnerTransfer(c, SIGNED)).signedBytes).toBe(SIGNED);
  });
});

const MUTATIONS: [keyof OwnerTransferBinding, unknown, boolean][] = [
  ['version', 2, false], ['owner', keyOf(10), true], ['policyId', 'replacement-policy', true], ['policyInstance', '66'.repeat(32), true], ['sourceHash', '66'.repeat(32), true],
  ['irHash', '66'.repeat(32), true], ['revision', 2, true], ['requestId', 'replacement-run', true], ['requestDigest', '77'.repeat(32), true], ['walletProfile', 'solana-owner-v2', false],
  ['network', 'solana:mainnet', false], ['genesisHash', '09'.repeat(32), false], ['beneficiary', keyOf(10), true], ['lamports', '1000001', true], ['feeCeilingLamports', '10001', true],
  ['authorizationHash', '88'.repeat(32), true], ['authorizationExpiresAt', '2030-01-03T00:00:00Z', true],
];

describe('every committed binding field', () => {
  it('covers all 17 fields', () => expect(MUTATIONS.map(m => m[0]).sort()).toEqual([...BINDING_ORDER].sort()));

  for (const [field, value, consistent] of MUTATIONS) it(`${field}: the old memo and wire reject it, and a rebuilt packet cannot replace the original`, async () => {
    const changed = {...original().binding, [field]: value} as OwnerTransferBinding;
    await expect(parsePreparedOwnerTransfer({...original(), binding: changed})).rejects.toThrow();
    if (!consistent) {
      expect(() => parseOwnerTransferBinding(changed)).toThrow();
      return;
    }
    const replacement = await prepare(changed);
    const c = await parsePreparedOwnerTransfer(replacement);
    const signer = field === 'owner' ? 10 : 7;
    await expect(verifySignedOwnerTransfer(c, SIGNED)).rejects.toThrow();
    const orig = await parsePreparedOwnerTransfer(original());
    await expect(verifySignedOwnerTransfer(orig, signedFor(replacement, signer))).rejects.toThrow();
    expect(() => checkOwnerTransferAuthority(c, original().binding)).toThrow(new RegExp(`at ${field}$`));
  });
});

describe('preparation facts', () => {
  it('handles amounts above 2^53 as exact BigInt little-endian u64', async () => {
    for (const lamports of ['9007199254740993', '18446744073709551615']) {
      const p = await prepare({...original().binding, lamports, feeCeilingLamports: '18446744073709551615'});
      const c = await parsePreparedOwnerTransfer(p);
      expect(c.lamports).toBe(BigInt(lamports));
      const data = tx([transferIx(BigInt(lamports)), memoIx(p.memo)]).serializeMessage();
      expect(toBase64(c.message)).toBe(toBase64(new Uint8Array(data)));
    }
    expect(() => parseOwnerTransferBinding({...original().binding, lamports: '18446744073709551616'})).toThrow(/u64/);
    expect(() => parseOwnerTransferBinding({...original().binding, lamports: 9007199254740993})).toThrow();
  });
});

describe('the canonical transaction', () => {
  const memo = VECTOR.prepared.memo;
  const variants: [string, () => Transaction][] = [
    ['amount', () => tx([transferIx(1_000_001n), memoIx(memo)])],
    ['recipient', () => tx([transferIx(1_000_000n, new PublicKey(keyOf(10))), memoIx(memo)])],
    ['beneficiary read-only', () => tx([transferIx(1_000_000n, BENEFICIARY, false), memoIx(memo)])],
    ['memo text', () => tx([transferIx(1_000_000n), memoIx(memo.replace(/.$/, '0'))])],
    ['beneficiary signer', () => tx([new TransactionInstruction({...transferIx(1_000_000n), keys: [{pubkey: OWNER, isSigner: true, isWritable: true}, {pubkey: BENEFICIARY, isSigner: true, isWritable: true}]}), memoIx(memo)])],
    ['program writable', () => tx([transferIx(1_000_000n), memoIx(memo, false, true), new TransactionInstruction({programId: SystemProgram.programId, keys: [{pubkey: new PublicKey(MEMO_PROGRAM), isSigner: false, isWritable: true}], data: Buffer.alloc(0)})])],
    ['memo extra account', () => tx([transferIx(1_000_000n), memoIx(memo, false, true, [new PublicKey(keyOf(11))])])],
    ['instruction order', () => tx([memoIx(memo), transferIx(1_000_000n)])],
    ['priority fee', () => tx([ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1}), transferIx(1_000_000n), memoIx(memo)])],
    ['extra transfer', () => tx([transferIx(1_000_000n), memoIx(memo), transferIx(1n)])],
    ['sponsor payer', () => tx([transferIx(1_000_000n), memoIx(memo)], new PublicKey(keyOf(12)))],
    ['blockhash', () => tx([transferIx(1_000_000n), memoIx(memo)], OWNER, new PublicKey(seed(10)).toBase58())],
  ];

  it('rejects a corrupted or foreign signature and never uses a wallet-reported key', async () => {
    const c = await parsePreparedOwnerTransfer(original());
    const raw = b64(SIGNED);
    raw[1] ^= 1;
    await expect(verifySignedOwnerTransfer(c, toBase64(raw))).rejects.toThrow(/does not verify/);
    // A valid signature by another key over the exact message is still not the owner.
    await expect(verifySignedOwnerTransfer(c, signedFor(original(), 8))).rejects.toThrow(/does not verify/);
    await expect(verifySignedOwnerTransfer(c, 42)).rejects.toThrow();
  });
});
