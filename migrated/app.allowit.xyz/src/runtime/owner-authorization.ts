import type {MicroPolicy} from '../micro/micro-contracts';
import type {AssetDetails, TypedBudgetRequirement} from '../policy/typed-metadata';
import {parseBudgetView} from '../policy/typed-budget-validation';
import {validateTypedMetadata} from '../policy/typed-metadata-validation';
import {
  AuthorizationError, authorizationPreimage, budgetsPreimage, canonicalBase64, deadline, digest, HEX64, instancePreimage, parseAuthorizationRecord, parseInstanceBinding,
  parsePreparation, sameBytes, textDigest, toBase64, verifyOwnerSignature, type AuthorizationRecord, type Commitment, type InstanceBinding, type Preparation,
} from './authorization-codec';
import {authorizationKey, runtimeOf} from './runtime';
export {authorizationKey};

/**
 * Owner-wallet budget authorization, checked entirely in this browser. Before anything is prepared, signed, shown as
 * Ready or handed off, the current policy is recomputed from its own fields: the SHA-256 of the exact code and original
 * intent, the stored hashes, revision, owner, policy, wallet, runtime, operation and network, the compiler's typed
 * budgets and both copies of the installed asset metadata. The budgets hash, the policy instance and the whole message
 * are recomputed and compared byte for byte. A server flag, a status or a wallet-reported key never stands in for these.
 */

export type AuthorizationProblem = 'context' | 'stale' | 'expired' | 'invalid';
export class AuthorizationCheckError extends AuthorizationError {
  constructor(readonly kind: AuthorizationProblem, message: string) {super(message);}
}
const problem = (kind: AuthorizationProblem, message: string): never => {
  throw new AuthorizationCheckError(kind, message);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Everything the current policy commits to, recomputed here. */
export interface AuthorizationContext {
  owner: string;
  policyId: string;
  revision: number;
  binding: InstanceBinding;
  budgets: TypedBudgetRequirement[];
  assets: AssetDetails[];
  budgetsHash: string;
  /** The commitment fields that must equal the current policy. Nonce, origin and deadline belong to each grant. */
  expected: Omit<Commitment, 'nonce' | 'origin' | 'expiresAt'>;
}

function checkedAssets(view: ReturnType<typeof parseBudgetView>, budgets: readonly TypedBudgetRequirement[], which: string): AssetDetails[] {
  if (view.state !== 'checked' || view.assets.state !== 'checked') return problem('context', `${which} asset metadata is missing or invalid`);
  const assets = [...view.assets.byId.values()];
  for (const b of budgets) {
    const a = view.assets.byId.get(b.assetId);
    if (!a || a.decimals !== b.decimals) problem('context', `${which} asset metadata does not describe every budget asset`);
  }
  return assets;
}

/** The current policy's own commitments, or a `context` problem. Never reads a fallback asset. */
export async function authorizationContext(policy: MicroPolicy, owner: string): Promise<AuthorizationContext> {
  const r = runtimeOf(policy);
  if (r.state !== 'typed' || r.kind !== 'owner-wallet' || r.runtime.fundingMode !== 'authorization') return problem('context', 'this policy does not use budget authorization');
  if (r.runtime.capabilities.providerCall) problem('context', 'an owner-wallet policy makes no provider call');
  const operation = r.runtime.operation;
  if (!operation) return problem('context', 'the policy names no registered operation');
  if (!owner) return problem('context', 'no wallet owner is signed in');
  if (!/^solana:(mainnet|testnet|devnet)$/.test(policy.network)) problem('context', 'the policy network has no Solana owner wallet');
  if (typeof policy.originalIntent !== 'string' || !policy.originalIntent) return problem('context', 'the original intent is missing');
  if (!HEX64.test(policy.sourceHash) || !HEX64.test(policy.irHash)) problem('context', 'the stored source or IR hash is not SHA-256 hex');
  const raw = policy.runtime as unknown as Record<string, unknown>;
  // The compiler's typed metadata and the exact code, checked again here rather than read from a displayed view.
  const typed = await validateTypedMetadata(policy);
  if (typed.state !== 'typed') return problem('context', `typed metadata is not checked: ${typed.state === 'invalid' ? typed.reason : typed.state}`);
  if (typed.budget.state !== 'checked' || !typed.budget.budgets.length) return problem('context', 'the policy has no checked typed budget to authorize');
  const budgets = typed.budget.budgets;
  const top = checkedAssets(typed.budget, budgets, 'The policy');
  const runtimeCopy = checkedAssets(parseBudgetView({typedBudgetRequirements: policy.typedBudgetRequirements, assetMetadata: raw.assetMetadata, network: policy.network}, typed.requirements, typed.signatures), budgets, 'The runtime');
  if (!sameBytes(budgetsPreimage(budgets, top), budgetsPreimage(budgets, runtimeCopy))) problem('context', 'the two copies of the asset metadata differ');
  const [sourceHash, intentHash, budgetsHash] = await Promise.all([textDigest(policy.code), textDigest(policy.originalIntent), digest(budgetsPreimage(budgets, top))]);
  if (sourceHash !== policy.sourceHash) problem('context', 'the code does not hash to the stored source hash');
  let binding: InstanceBinding;
  try {binding = parseInstanceBinding(raw.instanceBinding);} catch (e) {return problem('context', `the policy instance is unreadable: ${(e as Error).message}`);}
  const expectedBinding = {version: 1, owner, policyId: policy.id, sourceHash, irHash: policy.irHash, originalIntentHash: intentHash, revision: policy.revision, sourceProfile: r.runtime.sourceProfile, walletKind: 'owner-wallet', walletProfile: r.runtime.wallet.profile, operation, network: policy.network, typedBudgetsHash: budgetsHash} as const;
  for (const [k, v] of Object.entries(expectedBinding)) if (binding[k as keyof InstanceBinding] !== v) problem('context', `the policy instance differs from the current policy at ${k}`);
  const {instanceId, ...unhashed} = binding;
  if ((await digest(instancePreimage(unhashed))) !== instanceId) problem('context', 'the policy instance ID is not the hash of its fields');
  return {
    owner, policyId: policy.id, revision: policy.revision, binding, budgets, assets: top, budgetsHash,
    expected: {version: 1, owner, policyId: policy.id, policyInstance: instanceId, sourceHash, irHash: policy.irHash, originalIntentHash: intentHash, revision: policy.revision, walletProfile: r.runtime.wallet.profile, sourceProfile: r.runtime.sourceProfile, walletKind: 'owner-wallet', operation, network: policy.network, typedBudgetsHash: budgetsHash},
  };
}

/**
 * The commitment names this owner, this exact current policy, this site and a deadline still ahead. Returns the
 * deadline in milliseconds. A different revision or source is `stale`; a passed deadline is `expired`.
 */
export function checkCommitment(c: Commitment, ctx: AuthorizationContext, origin: string, now: number): number {
  for (const [k, v] of Object.entries(ctx.expected)) {
    if (c[k as keyof Commitment] !== v) problem(k === 'owner' ? 'invalid' : 'stale', `the authorization differs from the current policy at ${k}`);
  }
  if (c.origin !== origin) problem('invalid', 'the authorization names another site');
  const until = deadline(c.expiresAt);
  if (until <= now) problem('expired', 'the authorization deadline has passed');
  return until;
}

export interface VerifiedAuthorization {commitment: Commitment; signatureBase64: string; expiresAt: number}
/** A full browser check of one signed authorization against the current context: fields, exact bytes and Ed25519. */
export async function verifyAuthorization(record: AuthorizationRecord, ctx: AuthorizationContext, origin: string, now: number): Promise<VerifiedAuthorization> {
  const expiresAt = checkCommitment(record.commitment, ctx, origin, now);
  if (!sameBytes(record.message, authorizationPreimage(record.commitment))) problem('invalid', 'the signed message is not the exact encoding of its commitment');
  if (!(await verifyOwnerSignature(ctx.owner, record.message, record.signature))) problem('invalid', 'the signature does not verify for the owner');
  return {commitment: record.commitment, signatureBase64: record.signatureBase64, expiresAt};
}

/** The server-retained proof for the current policy, verified here. Null when the runtime retains none. */
export async function verifyRetained(policy: MicroPolicy, owner: string, origin: string, now: number): Promise<VerifiedAuthorization | null> {
  const raw = isObject(policy.runtime) ? (policy.runtime as unknown as Record<string, unknown>).authorization : undefined;
  if (raw === undefined || raw === null) return null;
  const ctx = await authorizationContext(policy, owner);
  let record: AuthorizationRecord;
  try {record = parseAuthorizationRecord(raw);} catch (e) {return problem('invalid', `the retained authorization is unreadable: ${(e as Error).message}`);}
  return verifyAuthorization(record, ctx, origin, now);
}

/* ------------------------------------------------------------------ journal and flow */

/**
 * One authorization request on this device, keyed by owner, policy and request ID. The request ID is saved before the
 * route is called, the preparation before the wallet opens and the signature before submit. Records are never deleted
 * here: a signed proof stays even after the source changes or the deadline passes.
 */
export interface AuthorizationEntry {owner: string; policyId: string; revision: number; requestId: string; createdAt: string; commitment?: unknown; messageBase64?: string; signature?: string}
export interface AuthorizationJournal {
  list(owner: string, policyId: string): Promise<AuthorizationEntry[]>;
  write(entry: AuthorizationEntry): Promise<void>;
}
/** Serializes one owner-policy authorization across tabs; fails closed where it cannot. */
export type AuthorizationLock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
export type Send = (path: string, body: unknown) => Promise<unknown>;
export interface FlowDeps {
  send: Send;
  journal: AuthorizationJournal;
  lock: AuthorizationLock;
  newId: () => string;
  now: () => number;
  origin: string;
}

/** A signed entry as a record, or null when it holds no signature. */
export function entryRecord(e: AuthorizationEntry): AuthorizationRecord | null {
  if (e.signature === undefined) return null;
  return parseAuthorizationRecord({commitment: e.commitment, messageBase64: e.messageBase64, signature: e.signature});
}
const newest = (entries: AuthorizationEntry[]) => [...entries].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

export interface PreparedAuthorization {policyId: string; revision: number; requestId: string; preparation: Preparation; expiresAt: number; ctx: AuthorizationContext}

async function saved(deps: FlowDeps, entry: AuthorizationEntry, what: string) {
  try {await deps.journal.write(entry);} catch {problem('context', `this browser cannot save ${what}, so nothing was ${what === 'the signed authorization' ? 'sent' : 'signed'}. Allow site storage and retry.`);}
}

/**
 * Prepares one authorization. An unsigned request for this revision is resumed with its original ID, and the server's
 * message for it must be byte-identical. A request ID is minted only when none can be resumed, and saved before the
 * route is called. Nothing is prepared over a current verified grant or a current signed proof.
 */
export async function prepareAuthorization(deps: FlowDeps, owner: string, policy: MicroPolicy): Promise<PreparedAuthorization> {
  return deps.lock(`${owner}:${policy.id}`, async () => {
    const ctx = await authorizationContext(policy, owner);
    const now = deps.now();
    const current = await verifyRetained(policy, owner, deps.origin, now).catch(() => null);
    if (current) problem('context', 'this policy already has a current verified authorization');
    const entries = newest(await deps.journal.list(owner, policy.id));
    for (const e of entries) {
      const record = (() => {try {return entryRecord(e);} catch {return null;}})();
      if (record && (await verifyAuthorization(record, ctx, deps.origin, now).then(() => true, () => false))) problem('context', 'a signed authorization for this policy is saved on this device. Check its status first');
    }
    const resumable = entries.find(e => e.signature === undefined && e.revision === policy.revision && (e.commitment === undefined || (() => {try {return deadline((e.commitment as Commitment).expiresAt) > now;} catch {return false;}})()));
    const entry: AuthorizationEntry = resumable ?? {owner, policyId: policy.id, revision: policy.revision, requestId: deps.newId(), createdAt: new Date(now).toISOString()};
    if (!resumable) await saved(deps, entry, 'the authorization request');
    const reply = await deps.send('micro/allocation/prepare', {id: policy.id, revision: policy.revision, requestId: entry.requestId});
    const preparation = parsePreparation(isObject(reply) ? reply.authorizationPreparation : undefined, entry.requestId);
    if (entry.messageBase64 !== undefined && entry.messageBase64 !== preparation.messageBase64) problem('invalid', 'the server returned a different message for the same request');
    const expiresAt = checkCommitment(preparation.commitment, ctx, deps.origin, now);
    await saved(deps, {...entry, commitment: preparation.commitment, messageBase64: preparation.messageBase64}, 'the prepared authorization');
    return {policyId: policy.id, revision: policy.revision, requestId: entry.requestId, preparation, expiresAt, ctx};
  });
}

export type SubmitOutcome = {proof: AuthorizationRecord; requestId: string; recorded: true} | {proof: AuthorizationRecord; requestId: string; recorded: false; error: string};

/** The server's authorization in a reply must be exactly this proof. */
function sameProof(reply: unknown, proof: AuthorizationRecord): boolean {
  const raw = isObject(reply) ? reply.authorization : undefined;
  if (raw === undefined || raw === null) return false;
  const r = parseAuthorizationRecord(raw);
  if (!sameBytes(r.message, proof.message) || !sameBytes(r.signature, proof.signature)) problem('invalid', 'the server reports a different authorization for this request');
  return true;
}

/**
 * Sign, journal, submit, under the owner-policy lock. The current policy and owner are checked before the wallet opens
 * and again before submit; the signature is verified against the owner's own key and saved before the first submit.
 * A changed context after signing keeps the proof and sends nothing.
 */
export async function signAuthorization(deps: FlowDeps, owner: string, prepared: PreparedAuthorization, sign: (message: Uint8Array) => Promise<Uint8Array>, stillCurrent: () => boolean, latest: () => MicroPolicy | null): Promise<SubmitOutcome> {
  return deps.lock(`${owner}:${prepared.policyId}`, async () => {
    const recheck = async () => {
      const policy = latest();
      if (!stillCurrent() || !policy || policy.id !== prepared.policyId || policy.revision !== prepared.revision) problem('stale', 'the policy or signed-in wallet changed');
      const ctx = await authorizationContext(policy!, owner);
      checkCommitment(prepared.preparation.commitment, ctx, deps.origin, deps.now());
      if (!stillCurrent() || latest() !== policy) problem('stale', 'the policy or signed-in wallet changed');
    };
    await recheck();
    const entries = await deps.journal.list(owner, prepared.policyId);
    const entry = entries.find(e => e.requestId === prepared.requestId);
    if (!entry || entry.messageBase64 !== prepared.preparation.messageBase64) problem('context', 'the prepared authorization is no longer saved on this device, so nothing was signed');
    if (entry!.signature !== undefined) problem('context', 'this request is already signed. Check its status');
    const signature = await sign(prepared.preparation.message);
    if (signature.length !== 64 || !(await verifyOwnerSignature(owner, prepared.preparation.message, signature))) problem('invalid', 'the wallet signature does not verify for the signed-in owner, so nothing was saved or sent');
    const signatureBase64 = toBase64(signature);
    await saved(deps, {...entry!, signature: signatureBase64}, 'the signed authorization');
    const proof: AuthorizationRecord = {commitment: prepared.preparation.commitment, message: prepared.preparation.message, messageBase64: prepared.preparation.messageBase64, signature, signatureBase64};
    try {
      await recheck();
    } catch (e) {
      return {proof, requestId: prepared.requestId, recorded: false, error: `${(e as Error).message}. The signed authorization is saved and was not sent.`};
    }
    try {
      const reply = await deps.send('micro/allocation/submit', {id: prepared.policyId, revision: prepared.revision, requestId: prepared.requestId, signedBytes: signatureBase64});
      return sameProof(reply, proof) ? {proof, requestId: prepared.requestId, recorded: true} : {proof, requestId: prepared.requestId, recorded: false, error: 'The server reply did not include the authorization'};
    } catch (e) {
      return {proof, requestId: prepared.requestId, recorded: false, error: e instanceof Error ? e.message : 'The submit outcome is unknown'};
    }
  });
}

/** Read-only lookup of a saved proof by its original IDs. Never prepares, signs or submits. */
export async function confirmAuthorization(deps: FlowDeps, entry: AuthorizationEntry): Promise<boolean> {
  const proof = entryRecord(entry);
  if (!proof) return problem('context', 'nothing signed is saved for this request');
  const reply = await deps.send('micro/allocation/confirm', {id: entry.policyId, revision: entry.revision, requestId: entry.requestId});
  return sameProof(reply, proof);
}

/** Canonical base64 of a signature a wallet returned, for display and storage checks. */
export const signatureBytes = (v: string) => canonicalBase64(v, 'the saved signature', 64);
