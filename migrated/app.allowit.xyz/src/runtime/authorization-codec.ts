import {sha256Hex} from './hash';
import {ed25519} from '@noble/curves/ed25519.js';
import {base58Hex} from '../policy/typed-budget-validation';
import type {AssetDetails, TypedBudgetRequirement} from '../policy/typed-metadata';

/**
 * Owner-wallet budget authorization encodings. Each preimage is an ASCII domain, one NUL byte and compact UTF-8 JSON of
 * an array whose leaves are strings (or null for an absent mint). Field order is fixed here, never taken from object
 * property order. Strings are used exactly as received: no trimming, case folding or Unicode normalization, and a
 * string that is not well-formed UTF-16 is refused rather than replaced. Hashes are lowercase SHA-256 hex.
 */

export class AuthorizationError extends Error {}
const fail = (what: string): never => {
  throw new AuthorizationError(what);
};

export const BUDGETS_DOMAIN = 'allowit-typed-budgets-v1';
export const INSTANCE_DOMAIN = 'allowit-owner-policy-instance-v1';
export const AUTHORIZATION_DOMAIN = 'allowit-owner-policy-authorization-v1';

export const HEX64 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** RFC 3339 UTC to the second, the only deadline form accepted. */
const DEADLINE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

/** No lone surrogate: such text has no exact UTF-8 encoding and would be replaced. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const wellFormed = (s: string) => !LONE.test(s);
type Leaf = string | null | readonly Leaf[];
function checkLeaves(value: Leaf): void {
  if (value === null) return;
  if (typeof value === 'string') {
    if (!wellFormed(value)) fail('a committed string is not well-formed text');
    return;
  }
  if (!Array.isArray(value)) fail('a committed field is not a string');
  for (const v of value) checkLeaves(v);
}
/** Domain, NUL, compact JSON. Only strings, nulls and arrays of them are encoded. */
export function encodeTuple(domain: string, payload: readonly Leaf[]): Uint8Array {
  checkLeaves(payload);
  return new TextEncoder().encode(`${domain}\0${JSON.stringify(payload)}`);
}

/** A canonical decimal string for a non-negative safe integer. */
const decimal = (n: number) => (Number.isSafeInteger(n) && n >= 0 ? String(n) : fail('a committed number is not a non-negative integer'));

/** Budgets in compiler source order; installed asset metadata sorted by assetId in ASCII order. */
export function budgetsPreimage(budgets: readonly TypedBudgetRequirement[], assets: readonly AssetDetails[]): Uint8Array {
  const sorted = [...assets].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) if (sorted[i - 1].assetId === sorted[i].assetId) fail('asset metadata repeats an asset');
  return encodeTuple(BUDGETS_DOMAIN, [
    '1',
    budgets.map(b => [b.operation, b.budgetId, b.assetId, decimal(b.decimals), b.totalBudgetUnits, b.maxDebitUnits, b.maxFeeUnits]),
    sorted.map(a => [a.assetId, decimal(a.decimals), a.symbol, a.network, a.kind, a.mint ?? null]),
  ]);
}

export interface InstanceBinding {
  version: 1;
  owner: string;
  policyId: string;
  sourceHash: string;
  irHash: string;
  originalIntentHash: string;
  revision: number;
  sourceProfile: string;
  walletKind: 'owner-wallet';
  walletProfile: string;
  operation: string;
  network: string;
  typedBudgetsHash: string;
  nonce: string;
  instanceId: string;
}
const INSTANCE_ORDER = ['version', 'owner', 'policyId', 'sourceHash', 'irHash', 'originalIntentHash', 'revision', 'sourceProfile', 'walletKind', 'walletProfile', 'operation', 'network', 'typedBudgetsHash', 'nonce'] as const;
export function instancePreimage(b: Omit<InstanceBinding, 'instanceId'>): Uint8Array {
  return encodeTuple(INSTANCE_DOMAIN, INSTANCE_ORDER.map(k => (k === 'version' || k === 'revision' ? decimal(b[k]) : b[k])));
}

/** The exact WalletAuthorization commitment the owner signs. */
export interface Commitment {
  version: 1;
  owner: string;
  policyId: string;
  policyInstance: string;
  sourceHash: string;
  irHash: string;
  originalIntentHash: string;
  revision: number;
  walletProfile: string;
  sourceProfile: string;
  walletKind: 'owner-wallet';
  operation: string;
  network: string;
  typedBudgetsHash: string;
  nonce: string;
  origin: string;
  expiresAt: string;
}
export const COMMITMENT_ORDER = ['version', 'owner', 'policyId', 'policyInstance', 'sourceHash', 'irHash', 'originalIntentHash', 'revision', 'walletProfile', 'sourceProfile', 'walletKind', 'operation', 'network', 'typedBudgetsHash', 'nonce', 'origin', 'expiresAt'] as const;
export function authorizationPreimage(c: Commitment): Uint8Array {
  return encodeTuple(AUTHORIZATION_DOMAIN, COMMITMENT_ORDER.map(k => (k === 'version' || k === 'revision' ? decimal(c[k]) : c[k])));
}

/* ------------------------------------------------------------------ strict parsing */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function exactKeys(o: Record<string, unknown>, keys: readonly string[], what: string) {
  const own = Object.keys(o);
  if (own.length !== keys.length || keys.some(k => !Object.hasOwn(o, k))) fail(`${what} does not have exactly the expected fields`);
}
const str = (v: unknown, what: string, max = 256): string => (typeof v === 'string' && v.length > 0 && v.length <= max && wellFormed(v) ? v : fail(`${what} is not a bounded string`));
const hex64 = (v: unknown, what: string) => (typeof v === 'string' && HEX64.test(v) ? v : fail(`${what} is not lowercase SHA-256 hex`));
const one = (v: unknown, what: string): 1 => (v === 1 ? 1 : fail(`${what} is not version 1`));
const revision = (v: unknown, what: string) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : fail(`${what} is not a positive integer`));
const ownerWallet = (v: unknown, what: string): 'owner-wallet' => (v === 'owner-wallet' ? v : fail(`${what} is not the owner wallet`));
/** A Solana address that decodes to exactly 32 bytes. */
export function ownerKey(address: string): Uint8Array {
  if (address.length < 32 || address.length > 44) fail('the owner is not a Solana address');
  const hex = base58Hex(address);
  if (!hex || hex.length !== 64) fail('the owner is not a 32-byte Solana address');
  return Uint8Array.from(hex!.match(/../g)!, h => parseInt(h, 16));
}
const owner = (v: unknown, what: string) => {
  const s = str(v, what, 44);
  ownerKey(s);
  return s;
};
/** Milliseconds of a strict `YYYY-MM-DDTHH:MM:SSZ` deadline whose fields round-trip exactly. */
export function deadline(v: unknown, what = 'the deadline'): number {
  const m = typeof v === 'string' ? DEADLINE.exec(v) : null;
  if (!m) return fail(`${what} is not an RFC 3339 UTC time`);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (new Date(t).toISOString() !== `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`) fail(`${what} is not a real time`);
  return t;
}
const origin = (v: unknown, what: string) => {
  const s = str(v, what, 512);
  let parsed: URL | null = null;
  try {parsed = new URL(s);} catch {fail(`${what} is not an origin`);}
  if (parsed!.origin !== s) fail(`${what} is not an exact origin`);
  return s;
};

export function parseInstanceBinding(v: unknown): InstanceBinding {
  if (!isObject(v)) return fail('the instance binding is not an object');
  exactKeys(v, [...INSTANCE_ORDER, 'instanceId'], 'the instance binding');
  return {
    version: one(v.version, 'the instance binding'), owner: owner(v.owner, 'the instance owner'), policyId: str(v.policyId, 'the instance policy ID'),
    sourceHash: hex64(v.sourceHash, 'the instance source hash'), irHash: hex64(v.irHash, 'the instance IR hash'), originalIntentHash: hex64(v.originalIntentHash, 'the instance intent hash'),
    revision: revision(v.revision, 'the instance revision'), sourceProfile: str(v.sourceProfile, 'the instance source profile'), walletKind: ownerWallet(v.walletKind, 'the instance wallet'),
    walletProfile: str(v.walletProfile, 'the instance wallet profile'), operation: str(v.operation, 'the instance operation'), network: str(v.network, 'the instance network', 64),
    typedBudgetsHash: hex64(v.typedBudgetsHash, 'the instance budgets hash'), nonce: hex64(v.nonce, 'the instance nonce'), instanceId: hex64(v.instanceId, 'the instance ID'),
  };
}

export function parseCommitment(v: unknown): Commitment {
  if (!isObject(v)) return fail('the authorization commitment is not an object');
  exactKeys(v, COMMITMENT_ORDER, 'the authorization commitment');
  const c: Commitment = {
    version: one(v.version, 'the commitment'), owner: owner(v.owner, 'the committed owner'), policyId: str(v.policyId, 'the committed policy ID'), policyInstance: hex64(v.policyInstance, 'the committed instance'),
    sourceHash: hex64(v.sourceHash, 'the committed source hash'), irHash: hex64(v.irHash, 'the committed IR hash'), originalIntentHash: hex64(v.originalIntentHash, 'the committed intent hash'),
    revision: revision(v.revision, 'the committed revision'), walletProfile: str(v.walletProfile, 'the committed wallet profile'), sourceProfile: str(v.sourceProfile, 'the committed source profile'),
    walletKind: ownerWallet(v.walletKind, 'the committed wallet'), operation: str(v.operation, 'the committed operation'), network: str(v.network, 'the committed network', 64),
    typedBudgetsHash: hex64(v.typedBudgetsHash, 'the committed budgets hash'), nonce: hex64(v.nonce, 'the committed nonce'), origin: origin(v.origin, 'the committed origin'), expiresAt: str(v.expiresAt, 'the committed deadline', 20),
  };
  deadline(c.expiresAt, 'the committed deadline');
  return c;
}

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** Standard padded base64 whose re-encoding is identical: no whitespace, URL alphabet or non-zero padding bits. */
export function canonicalBase64(v: unknown, what: string, length?: number): Uint8Array {
  if (typeof v !== 'string' || !B64.test(v)) return fail(`${what} is not canonical base64`);
  const bytes = Uint8Array.from(atob(v), c => c.charCodeAt(0));
  if (toBase64(bytes) !== v) fail(`${what} is not canonical base64`);
  if (length !== undefined && bytes.length !== length) fail(`${what} is not ${length} bytes`);
  return bytes;
}
export const toBase64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
export const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface Preparation {requestId: string; commitment: Commitment; message: Uint8Array; messageBase64: string}
export function parsePreparation(v: unknown, requestId: string): Preparation {
  if (!isObject(v)) return fail('the authorization preparation is missing');
  exactKeys(v, ['requestId', 'commitment', 'messageBase64'], 'the authorization preparation');
  if (v.requestId !== requestId) fail('the preparation names a different request');
  const commitment = parseCommitment(v.commitment);
  const message = canonicalBase64(v.messageBase64, 'the authorization message');
  if (!sameBytes(message, authorizationPreimage(commitment))) fail('the authorization message is not the exact encoding of its commitment');
  return {requestId, commitment, message, messageBase64: v.messageBase64 as string};
}

export interface AuthorizationRecord {commitment: Commitment; message: Uint8Array; messageBase64: string; signature: Uint8Array; signatureBase64: string}
export function parseAuthorizationRecord(v: unknown): AuthorizationRecord {
  if (!isObject(v)) return fail('the authorization is not an object');
  exactKeys(v, ['commitment', 'messageBase64', 'signature'], 'the authorization');
  const commitment = parseCommitment(v.commitment);
  const message = canonicalBase64(v.messageBase64, 'the authorization message');
  if (!sameBytes(message, authorizationPreimage(commitment))) fail('the authorization message is not the exact encoding of its commitment');
  const signature = canonicalBase64(v.signature, 'the authorization signature', 64);
  return {commitment, message, messageBase64: v.messageBase64 as string, signature, signatureBase64: v.signature as string};
}

/* ------------------------------------------------------------------ crypto */

export async function digest(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) fail('this browser has no Web Crypto, so the authorization cannot be checked');
  return sha256Hex(bytes);
}
export const textDigest = (text: string) => {
  if (!wellFormed(text)) fail('the hashed text is not well-formed');
  return digest(new TextEncoder().encode(text));
};

/**
 * Ed25519 over the exact message with the key decoded from the owner address. Canonical, non-small-order points
 * in the prime subgroup keep verification consistent with strict backend verification for wallet signatures,
 * including browsers whose Web Crypto does not implement Ed25519.
 */
export async function verifyOwnerSignature(ownerAddress: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fail('this browser has no Web Crypto, so the signature cannot be checked');
  if (signature.length !== 64) return false;
  const key = ownerKey(ownerAddress);
  try {
    const a = ed25519.Point.fromBytes(key, false);
    const r = ed25519.Point.fromBytes(signature.subarray(0, 32), false);
    if (a.isSmallOrder() || r.isSmallOrder() || !a.isTorsionFree() || !r.isTorsionFree()) return false;
    return ed25519.verify(signature, message, key, {zip215: false});
  } catch {
    return false;
  }
}
