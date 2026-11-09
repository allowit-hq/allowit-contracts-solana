import {Buffer} from 'buffer';
import {PublicKey, SystemProgram, Transaction, TransactionInstruction} from '@solana/web3.js';
import {AuthorizationError, authorizationPreimage, canonicalBase64, deadline, digest, encodeTuple, HEX64, sameBytes, verifyOwnerSignature, wellFormed, type AuthorizationRecord} from './authorization-codec';
import {base58Hex} from '../policy/typed-budget-validation';
import {encodeBase58} from '../wallet/allocation';
import {TESTNET_GENESIS} from '../paysh/paysh-contracts';

/**
 * Owner-signed native transfer packets, checked entirely in this browser. Mirrors the Rust engine's
 * `owner::transaction::PreparedOwnerTransfer` and the SDK's `owner_wallet::Intent::transaction`: every field is parsed
 * strictly, the binding memo is recomputed, and the whole canonical legacy message and unsigned packet are rebuilt from
 * the binding alone and compared byte for byte. A signed packet must carry exactly that message and a valid Ed25519
 * signature by the binding's own owner key.
 *
 * Structural validity is not authority. A packet that parses here may still name any source, grant or run; only
 * `checkOwnerTransferAuthority` against an independently derived binding ties it to the current policy, grant and
 * request. Nothing here infers status, finality or absence from expiry or missing history.
 */

export class OwnerTransferError extends AuthorizationError {}
const fail = (what: string): never => {
  throw new OwnerTransferError(what);
};

export const OWNER_TRANSFER_KIND = 'solana-native-transfer';
export const OWNER_TRANSFER_PROFILE = 'solana-owner-typed-v1';
export const OWNER_TRANSFER_NETWORK = 'solana:testnet';
export const OWNER_RUN_DOMAIN = 'allowit-owner-run-v1';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** Solana Testnet genesis hash as lowercase hex, derived from the one pinned Base58 constant. */
export const TESTNET_GENESIS_HEX = base58Hex(TESTNET_GENESIS)!;
/** Solana's packet limit; the message and both wire forms are bounded by it. */
const PACKET = 1232;
const PACKET_B64 = 4 * Math.ceil(PACKET / 3);
const U64_MAX = 0xffffffffffffffffn;

export interface OwnerTransferBinding {
  version: 1;
  owner: string;
  policyId: string;
  policyInstance: string;
  sourceHash: string;
  irHash: string;
  revision: number;
  requestId: string;
  requestDigest: string;
  walletProfile: typeof OWNER_TRANSFER_PROFILE;
  network: typeof OWNER_TRANSFER_NETWORK;
  genesisHash: string;
  beneficiary: string;
  lamports: string;
  feeCeilingLamports: string;
  authorizationHash: string;
  authorizationExpiresAt: string;
}
/** Rust `OwnerTransferBinding` field order, which is also the memo tuple order. */
export const BINDING_ORDER = [
  'version', 'owner', 'policyId', 'policyInstance', 'sourceHash', 'irHash', 'revision', 'requestId', 'requestDigest', 'walletProfile', 'network', 'genesisHash', 'beneficiary', 'lamports',
  'feeCeilingLamports', 'authorizationHash', 'authorizationExpiresAt',
] as const satisfies readonly (keyof OwnerTransferBinding)[];
const PREPARED_KEYS = ['kind', 'binding', 'blockhash', 'lastValidBlockHeight', 'observedFeeLamports', 'preparedAt', 'contextSlot', 'memo', 'messageBase64', 'messageHash', 'unsignedBytes'] as const;

export interface PreparedOwnerTransfer {
  kind: typeof OWNER_TRANSFER_KIND;
  binding: OwnerTransferBinding;
  blockhash: string;
  lastValidBlockHeight: string;
  observedFeeLamports: string;
  preparedAt: string;
  contextSlot: string;
  memo: string;
  messageBase64: string;
  messageHash: string;
  unsignedBytes: string;
}

/** A preparation that passed every structural and byte check here. Only `parsePreparedOwnerTransfer` creates one. */
export interface CheckedOwnerTransfer {
  readonly prepared: Readonly<PreparedOwnerTransfer>;
  readonly message: Uint8Array;
  readonly lamports: bigint;
  readonly feeCeilingLamports: bigint;
  readonly observedFeeLamports: bigint;
  readonly lastValidBlockHeight: bigint;
  readonly contextSlot: bigint;
}
const checked = new WeakSet<CheckedOwnerTransfer>();
const originalMessages = new WeakMap<CheckedOwnerTransfer, Uint8Array>();

/* ------------------------------------------------------------------ strict fields */

function exactObject(v: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return fail(`${what} is not an object`);
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) fail(`${what} is not a plain object`);
  const own = Reflect.ownKeys(v);
  if (own.length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail(`${what} does not have exactly the expected fields`);
  for (const k of keys) if (!('value' in Object.getOwnPropertyDescriptor(v, k)!)) fail(`${what} has an accessor at ${k}`);
  return v as Record<string, unknown>;
}
const utf8Length = (s: string) => new TextEncoder().encode(s).length;
/** Exact identifier text, 1–128 UTF-8 bytes like the Rust check. Never trimmed or normalized. */
const ident = (v: unknown, what: string) => (typeof v === 'string' && wellFormed(v) && v.length > 0 && utf8Length(v) <= 128 ? v : fail(`${what} is not a 1–128 byte identifier`));
/** Lowercase SHA-256 hex that is not all zeros. */
const hash = (v: unknown, what: string) => (typeof v === 'string' && HEX64.test(v) && /[1-9a-f]/.test(v) ? v : fail(`${what} is not nonzero lowercase SHA-256 hex`));
const revision = (v: unknown, what: string) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail(`${what} is not a positive safe integer`));
/** A positive canonical decimal u64, kept as a string and returned as an exact BigInt. Numbers are never accepted. */
export function positiveU64(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v)) return fail(`${what} is not a positive canonical decimal`);
  const n = BigInt(v);
  return n <= U64_MAX ? n : fail(`${what} exceeds u64`);
}
/** Exactly 32 bytes in canonical Base58: the text must be the re-encoding of its bytes. */
export function key32(v: unknown, what: string): Uint8Array {
  if (typeof v !== 'string' || v.length < 32 || v.length > 44) return fail(`${what} is not a Solana address`);
  const hex = base58Hex(v);
  if (!hex || hex.length !== 64) return fail(`${what} is not 32 bytes`);
  const bytes = Uint8Array.from(hex.match(/../g)!, h => parseInt(h, 16));
  if (encodeBase58(bytes) !== v) fail(`${what} is not canonical Base58`);
  return bytes;
}
const SYSTEM = SystemProgram.programId.toBytes();
const MEMO = new PublicKey(MEMO_PROGRAM).toBytes();
const zero = (b: Uint8Array) => b.every(x => x === 0);
const time = (v: unknown, what: string) => (deadline(v, what), v as string);

/** The 17-field binding, strictly. Testnet and the typed owner profile are the only implemented profile. */
export function parseOwnerTransferBinding(v: unknown): OwnerTransferBinding {
  const o = exactObject(v, BINDING_ORDER, 'the transfer binding');
  if (o.version !== 1) fail('the transfer binding is not version 1');
  if (o.walletProfile !== OWNER_TRANSFER_PROFILE) fail('the wallet profile is not the typed owner profile');
  if (o.network !== OWNER_TRANSFER_NETWORK) fail('the transfer network is not Solana Testnet');
  if (o.genesisHash !== TESTNET_GENESIS_HEX) fail('the genesis hash is not Solana Testnet');
  const owner = key32(o.owner, 'the owner');
  const beneficiary = key32(o.beneficiary, 'the beneficiary');
  if (!PublicKey.isOnCurve(owner)) fail('the owner is not an Ed25519 wallet key');
  for (const [k, b] of [['owner', owner], ['beneficiary', beneficiary]] as const) if (sameBytes(b, SYSTEM) || sameBytes(b, MEMO)) fail(`the ${k} is a program`);
  if (sameBytes(owner, beneficiary)) fail('the beneficiary is the owner');
  positiveU64(o.lamports, 'the lamports');
  positiveU64(o.feeCeilingLamports, 'the fee ceiling');
  return {
    version: 1, owner: o.owner as string, policyId: ident(o.policyId, 'the policy ID'), policyInstance: hash(o.policyInstance, 'the policy instance'), sourceHash: hash(o.sourceHash, 'the source hash'),
    irHash: hash(o.irHash, 'the IR hash'), revision: revision(o.revision, 'the revision'), requestId: ident(o.requestId, 'the request ID'), requestDigest: hash(o.requestDigest, 'the request digest'),
    walletProfile: OWNER_TRANSFER_PROFILE, network: OWNER_TRANSFER_NETWORK, genesisHash: hash(o.genesisHash, 'the genesis hash'), beneficiary: o.beneficiary as string, lamports: o.lamports as string,
    feeCeilingLamports: o.feeCeilingLamports as string, authorizationHash: hash(o.authorizationHash, 'the authorization hash'), authorizationExpiresAt: time(o.authorizationExpiresAt, 'the authorization deadline'),
  };
}

/* ------------------------------------------------------------------ canonical packet */

/** `allowit-owner-run-v1:` + SHA-256(domain NUL compact JSON of the 17 binding strings in Rust order). */
export async function ownerRunMemo(b: OwnerTransferBinding): Promise<string> {
  const context = await digest(encodeTuple(OWNER_RUN_DOMAIN, BINDING_ORDER.map(k => String(b[k]))));
  if (!/[1-9a-f]/.test(context)) fail('the run commitment is zero');
  return `${OWNER_RUN_DOMAIN}:${context}`;
}

/**
 * The canonical legacy message: the owner is sole payer and signer; SystemProgram transfer (opcode 2, LE u64) from the
 * owner (writable signer) to the beneficiary (writable); then Memo with the owner as read-only signer and the exact memo.
 * Account order is fixed for these four keys: payer, writable non-signer, then the two read-only programs.
 */
export function ownerTransferMessage(b: OwnerTransferBinding, blockhash: string, memo: string): Uint8Array {
  const owner = new PublicKey(key32(b.owner, 'the owner'));
  const beneficiary = new PublicKey(key32(b.beneficiary, 'the beneficiary'));
  if (zero(key32(blockhash, 'the blockhash'))) fail('the blockhash is zero');
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(positiveU64(b.lamports, 'the lamports'), 4);
  const tx = new Transaction();
  tx.feePayer = owner;
  tx.recentBlockhash = blockhash;
  tx.add(
    new TransactionInstruction({programId: SystemProgram.programId, keys: [{pubkey: owner, isSigner: true, isWritable: true}, {pubkey: beneficiary, isSigner: false, isWritable: true}], data}),
    new TransactionInstruction({programId: new PublicKey(MEMO), keys: [{pubkey: owner, isSigner: true, isWritable: false}], data: Buffer.from(new TextEncoder().encode(memo))}),
  );
  const message = new Uint8Array(tx.serializeMessage());
  if (message.length + 65 > PACKET) fail('the transfer exceeds the packet limit');
  return message;
}
/** One signature slot (canonical shortvec 1), then the message. */
const wire = (signature: Uint8Array, message: Uint8Array) => {
  const out = new Uint8Array(65 + message.length);
  out[0] = 1;
  out.set(signature, 1);
  out.set(message, 65);
  return out;
};

/**
 * Strictly parses a server preparation and checks it against its own binding: observed fee within the bound, exact
 * times, the recomputed memo, the whole rebuilt message, its SHA-256 and the unsigned packet with exactly one zero
 * signature. Any difference, extra byte or missing primitive fails.
 */
export async function parsePreparedOwnerTransfer(v: unknown): Promise<CheckedOwnerTransfer> {
  const o = {...exactObject(v, PREPARED_KEYS, 'the transfer preparation')};
  if (o.kind !== OWNER_TRANSFER_KIND) fail('the preparation is not a native transfer');
  const binding = parseOwnerTransferBinding(o.binding);
  const lamports = positiveU64(binding.lamports, 'the lamports');
  const feeCeilingLamports = positiveU64(binding.feeCeilingLamports, 'the fee ceiling');
  const observedFeeLamports = positiveU64(o.observedFeeLamports, 'the observed fee');
  if (observedFeeLamports > feeCeilingLamports) fail('the observed fee exceeds the fee ceiling');
  const lastValidBlockHeight = positiveU64(o.lastValidBlockHeight, 'the last valid block height');
  const contextSlot = positiveU64(o.contextSlot, 'the context slot');
  const preparedAt = time(o.preparedAt, 'the preparation time');
  if (typeof o.blockhash !== 'string') return fail('the blockhash is not a string');
  const memo = await ownerRunMemo(binding);
  if (o.memo !== memo) fail('the memo is not the commitment of this binding');
  const message = ownerTransferMessage(binding, o.blockhash, memo);
  if (typeof o.messageBase64 !== 'string' || o.messageBase64.length > PACKET_B64 || !sameBytes(canonicalBase64(o.messageBase64, 'the message'), message)) fail('the message is not the canonical transfer for this binding');
  const messageHash = hash(o.messageHash, 'the message hash');
  if ((await digest(message)) !== messageHash) fail('the message hash is not the SHA-256 of the message');
  if (typeof o.unsignedBytes !== 'string' || o.unsignedBytes.length > PACKET_B64 || !sameBytes(canonicalBase64(o.unsignedBytes, 'the unsigned packet'), wire(new Uint8Array(64), message))) fail('the unsigned packet is not the canonical transfer with one empty signature');
  const prepared: PreparedOwnerTransfer = Object.freeze({
    kind: OWNER_TRANSFER_KIND, binding: Object.freeze(binding), blockhash: o.blockhash, lastValidBlockHeight: o.lastValidBlockHeight as string, observedFeeLamports: o.observedFeeLamports as string, preparedAt,
    contextSlot: o.contextSlot as string, memo, messageBase64: o.messageBase64 as string, messageHash, unsignedBytes: o.unsignedBytes as string,
  });
  const result: CheckedOwnerTransfer = Object.freeze({prepared, get message() {return message.slice();}, lamports, feeCeilingLamports, observedFeeLamports, lastValidBlockHeight, contextSlot});
  originalMessages.set(result, message);
  checked.add(result);
  return result;
}

/** The owner's signature as a fact: Base58, plus the exact signed bytes. No status, finality or broadcast is implied. */
export interface SignedOwnerTransfer {readonly signature: string; readonly signedBytes: string}
const signedBy = new WeakMap<SignedOwnerTransfer, CheckedOwnerTransfer>();

/**
 * The signed wire is one signature over exactly the checked message, verified with the key decoded from the binding's
 * owner, never a wallet-reported key. A missing Web Crypto or Ed25519 primitive fails closed.
 */
export async function verifySignedOwnerTransfer(c: CheckedOwnerTransfer, signedBytes: unknown): Promise<SignedOwnerTransfer> {
  if (!checked.has(c)) fail('the preparation was not checked here');
  if (typeof signedBytes !== 'string' || signedBytes.length > PACKET_B64) return fail('the signed packet is not bounded base64');
  const message = originalMessages.get(c)!;
  const raw = canonicalBase64(signedBytes, 'the signed packet');
  if (raw.length !== 65 + message.length || raw[0] !== 1 || !sameBytes(raw.subarray(65), message)) fail('the signed packet is not the original message with one signature');
  const signature = raw.slice(1, 65);
  if (zero(signature)) fail('the owner signature is missing');
  if (!(await verifyOwnerSignature(c.prepared.binding.owner, message, signature))) fail('the signature does not verify for the owner');
  const result: SignedOwnerTransfer = Object.freeze({signature: encodeBase58(signature), signedBytes});
  signedBy.set(result, c);
  return result;
}

/* ------------------------------------------------------------------ authority */

/**
 * Compares every one of the 17 fields with a binding the caller derived independently from the current policy, the
 * verified grant and the bound request. This is the only authority check here; it never yields a Ready state.
 */
export function checkOwnerTransferAuthority(c: CheckedOwnerTransfer, expected: unknown): void {
  if (!checked.has(c)) fail('the preparation was not checked here');
  const want = parseOwnerTransferBinding(expected);
  for (const k of BINDING_ORDER) if (c.prepared.binding[k] !== want[k]) fail(`the transfer differs from the expected binding at ${k}`);
}

/** SHA-256 of the exact authorization commitment message bytes; the signature is not part of it. */
export async function authorizationHash(record: AuthorizationRecord): Promise<string> {
  if (!sameBytes(record.message, authorizationPreimage(record.commitment))) fail('the authorization message is not the exact encoding of its commitment');
  return digest(record.message);
}
/** Binding fields an authorization commits to. The caller must already have verified it against the current policy. */
export async function authorizationBindingFields(record: AuthorizationRecord): Promise<Pick<OwnerTransferBinding, 'owner' | 'policyId' | 'policyInstance' | 'sourceHash' | 'irHash' | 'revision' | 'authorizationHash' | 'authorizationExpiresAt'> & {walletProfile: string; network: string}> {
  const c = record.commitment;
  return {owner: c.owner, policyId: c.policyId, policyInstance: c.policyInstance, sourceHash: c.sourceHash, irHash: c.irHash, revision: c.revision, walletProfile: c.walletProfile, network: c.network, authorizationHash: await authorizationHash(record), authorizationExpiresAt: c.expiresAt};
}

/* ------------------------------------------------------------------ request digest */

export interface JsonLimits {depth: number; nodes: number; bytes: number}
export const JSON_LIMITS: JsonLimits = {depth: 32, nodes: 4096, bytes: 65536};
/** Rust `String` order: UTF-8 bytes, which equals Unicode code point order (not UTF-16 unit order). */
function codePointOrder(a: string, b: string): number {
  const x = Array.from(a, c => c.codePointAt(0)!), y = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

/**
 * Compact JSON with object keys sorted recursively by code point, matching Rust serde_json sorted maps. Only plain
 * JSON values: well-formed strings, booleans, null, arrays, plain objects and safe integers. Fractions, negative zero
 * and unsafe integers are refused because a JS number cannot reproduce their original text.
 */
export function canonicalJson(value: unknown, limits: JsonLimits = JSON_LIMITS): string {
  let nodes = 0;
  const walk = (v: unknown, depth: number): string => {
    if (++nodes > limits.nodes) fail('the JSON has too many values');
    if (depth > limits.depth) fail('the JSON is nested too deeply');
    if (v === null || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'string') return wellFormed(v) ? JSON.stringify(v) : fail('a JSON string is not well-formed text');
    if (typeof v === 'number') return Number.isSafeInteger(v) && !Object.is(v, -0) ? String(v) : fail('a JSON number is not a safe integer');
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype) fail('a JSON array is not plain');
      return `[${Array.from({length: v.length}, (_, i) => (Object.hasOwn(v, i) ? walk(v[i], depth + 1) : fail('a JSON array has a hole'))).join(',')}]`;
    }
    if (typeof v !== 'object') return fail('a value is not JSON');
    const keys = Reflect.ownKeys(v);
    const o = exactObject(v, keys.map(k => (typeof k === 'string' ? k : fail('a JSON key is not a string'))), 'a JSON object');
    const names = (keys as string[]).map(k => (wellFormed(k) ? k : fail('a JSON key is not well-formed text'))).sort(codePointOrder);
    return `{${names.map(k => `${JSON.stringify(k)}:${walk(o[k], depth + 1)}`).join(',')}}`;
  };
  const text = walk(value, 0);
  if (utf8Length(text) > limits.bytes) fail('the JSON exceeds its byte limit');
  return text;
}

/** The identities a request digest commits to, derived by the caller from the current policy and the original run. */
export interface BoundRequestIdentity {owner: string; policyId: string; requestId: string; revision: number; sourceHash: string; irHash: string}

/**
 * Verifies a bound request preimage and returns its digest. The preimage must be exactly the canonical JSON of
 * `{input, inputKey: '', irHash, owner, policyId, requestId, revision, sourceHash}` built from the expected identities and
 * the full original tagged input, never only its transfer instruction. The digest is SHA-256 of that exact UTF-8 text.
 */
export async function boundRequestDigest(expected: BoundRequestIdentity, input: unknown, canonicalInputJson: unknown): Promise<string> {
  if (typeof canonicalInputJson !== 'string' || !wellFormed(canonicalInputJson) || canonicalInputJson.length > JSON_LIMITS.bytes) return fail('the request preimage is not bounded text');
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('the original input is not a tagged object');
  key32(expected.owner, 'the request owner');
  const preimage = canonicalJson({
    input, inputKey: '', irHash: hash(expected.irHash, 'the request IR hash'), owner: expected.owner, policyId: ident(expected.policyId, 'the request policy ID'),
    requestId: ident(expected.requestId, 'the request ID'), revision: revision(expected.revision, 'the request revision'), sourceHash: hash(expected.sourceHash, 'the request source hash'),
  });
  if (preimage !== canonicalInputJson) fail('the request preimage is not the canonical encoding of the expected request');
  return digest(new TextEncoder().encode(preimage));
}

/* ------------------------------------------------------------------ settlement liability */

/** Mirrors SDK `owner_wallet::Settlement`. There is no absent, expired or resend state. */
export type OwnerTransferSettlement =
  | {state: 'unknown'}
  | {state: 'finalized' | 'finalized-failure'; signature: string; slot: string; feeLamports: string};
export interface Liability {debitLamports: bigint; feeLamports: bigint; terminal: boolean}

/**
 * Liability for a verified signed packet. Unknown keeps the full amount and fee ceiling reserved. A finalized success
 * consumes the exact amount and observed fee; a finalized failure of the exact original transaction consumes the fee only.
 */
export function settlementLiability(c: CheckedOwnerTransfer, signed: SignedOwnerTransfer, s: OwnerTransferSettlement): Liability {
  if (!checked.has(c) || signedBy.get(signed) !== c) fail('the signed packet was not verified here for this preparation');
  if (s.state === 'unknown') return {debitLamports: c.lamports, feeLamports: c.feeCeilingLamports, terminal: false};
  if (s.state !== 'finalized' && s.state !== 'finalized-failure') return fail('the settlement state is not supported');
  if (s.signature !== signed.signature) fail('the settlement names another signature');
  if (positiveU64(s.slot, 'the finalized slot') < c.contextSlot) fail('the finalized slot precedes the preparation');
  if (positiveU64(s.feeLamports, 'the finalized fee') !== c.observedFeeLamports) fail('the finalized fee differs from the observed fee');
  return {debitLamports: s.state === 'finalized' ? c.lamports : 0n, feeLamports: c.observedFeeLamports, terminal: true};
}
