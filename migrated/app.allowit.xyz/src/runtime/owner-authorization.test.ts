import {describe, expect, it} from 'vitest';
import GOLDEN from './fixtures/owner-authorization-golden-v2.json' with {type: 'json'};
import {authorizationPreimage, budgetsPreimage, canonicalBase64, deadline, digest, instancePreimage, parseCommitment, parseInstanceBinding, parsePreparation, toBase64, verifyOwnerSignature, type Commitment} from './authorization-codec';
import {confirmAuthorization, prepareAuthorization, signAuthorization, verifyRetained, type AuthorizationEntry, type AuthorizationJournal, type FlowDeps} from './owner-authorization';
import {authorizationPolicy, FIXTURE_ORIGIN, RFC8032_OWNER, RFC8032_SEED_HEX, retained, seedSigner} from './fixtures/owner-authorization';
import type {AssetDetails, TypedBudgetRequirement} from '../policy/typed-metadata';
import type {MicroPolicy} from '../micro/micro-contracts';

/**
 * The golden is the untouched synthetic v2 backend encoding fixture (sha256 ceb356ff…), encoding only: no compiled
 * policy, grant, signature or chain effect. Signatures here use the public RFC 8032 test key and are local only.
 */
const b64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const NOW = Date.parse('2026-10-09T00:00:00Z');
const g = GOLDEN as unknown as {typedBudgetRequirements: Record<string, unknown>[]; assetMetadata: Record<string, unknown>[]; authorization: Commitment; instanceBinding: Record<string, unknown>; budgetPreimageBase64: string; instancePreimageBase64: string; messageBase64: string; messageSha256: string};
const goldenBudgets = (): TypedBudgetRequirement[] => g.typedBudgetRequirements.map(r => ({operation: r.operation, budgetId: r.budget_id, assetId: r.asset_id, decimals: r.decimals, totalBudgetUnits: r.total_budget_units, maxDebitUnits: r.max_debit_units, maxFeeUnits: r.max_fee_units}) as TypedBudgetRequirement);

describe('golden encodings', () => {
  it('reproduces the exact budget, instance and authorization bytes and digests', async () => {
    const assets = g.assetMetadata as unknown as AssetDetails[];
    const budgets = budgetsPreimage(goldenBudgets(), assets);
    expect(toBase64(budgets)).toBe(g.budgetPreimageBase64);
    expect(await digest(budgets)).toBe(g.authorization.typedBudgetsHash);
    const binding = parseInstanceBinding(g.instanceBinding);
    const {instanceId, ...unhashed} = binding;
    expect(toBase64(instancePreimage(unhashed))).toBe(g.instancePreimageBase64);
    expect(await digest(instancePreimage(unhashed))).toBe(instanceId);
    expect(instanceId).toBe(g.authorization.policyInstance);
    const commitment = parseCommitment(g.authorization);
    expect(toBase64(authorizationPreimage(commitment))).toBe(g.messageBase64);
    expect(await digest(authorizationPreimage(commitment))).toBe(g.messageSha256);
    expect(parsePreparation({requestId: 'r1', commitment: g.authorization, messageBase64: g.messageBase64}, 'r1').commitment).toEqual(commitment);
  });

  it('parses only exact objects, canonical base64 and strict deadlines', () => {
    expect(() => parseCommitment({...g.authorization, extra: 1})).toThrow(/exactly/);
    const {nonce: _n, ...missing} = g.authorization;
    expect(() => parseCommitment(missing)).toThrow(/exactly/);
    for (const [k, v] of [['version', 2], ['revision', '1'], ['revision', 0], ['walletKind', 'contract-wallet'], ['sourceHash', 'AB'.repeat(32)], ['owner', '0OIl'], ['origin', 'https://owner.test/'], ['expiresAt', '2030-01-02T00:00:00.000Z'], ['expiresAt', '2030-02-30T00:00:00Z']] as const) {
      expect(() => parseCommitment({...g.authorization, [k]: v}), `${k}=${v}`).toThrow();
    }
    expect(() => canonicalBase64('AQ', 'x')).toThrow(/canonical/);
    expect(() => canonicalBase64('AR==', 'x')).toThrow(/canonical/);
    expect(() => canonicalBase64(' AQ==', 'x')).toThrow(/canonical/);
    expect(() => canonicalBase64('-_8=', 'x')).toThrow(/canonical/);
    expect(() => canonicalBase64('AQ==', 'x', 64)).toThrow(/64 bytes/);
    expect(deadline('2030-01-02T00:00:00Z')).toBe(Date.parse('2030-01-02T00:00:00Z'));
    // A message that is not the exact encoding of its commitment, or carries a trailing byte, is refused.
    const extra = toBase64(new Uint8Array([...b64(g.messageBase64), 0]));
    expect(() => parsePreparation({requestId: 'r1', commitment: g.authorization, messageBase64: extra}, 'r1')).toThrow(/exact encoding/);
    expect(() => parsePreparation({requestId: 'r2', commitment: g.authorization, messageBase64: g.messageBase64}, 'r1')).toThrow(/different request/);
  });
});

describe('owner signature', () => {
  // Synthetic vectors use only the public RFC 8032 key. They distinguish strict wallet verification from
  // cofactored verification: both identity R and a canonical mixed-order R otherwise verify with this key.
  const syntheticMessage = new TextEncoder().encode('allowit-owner-policy-authorization-v1\0["synthetic-review"]');
  const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, h => parseInt(h, 16));
  it.each([
    ['identity R', '01000000000000000000000000000000000000000000000000000000000000006ad05954a10371360cc5117a56dab47268d0047403c55618021ef4ae2023040a'],
    ['mixed-order R', '003789297ce02defa2f4bc7635d1d7ce99b96d76eb91d31f905101674ddab720de7c173f01a7cedaf07610387a1028d740266983c2a4140fe9a19450e55b940c'],
    ['noncanonical R', 'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f6ad05954a10371360cc5117a56dab47268d0047403c55618021ef4ae2023040a'],
    ['out-of-range S', '08878f4f8295bc542240242e16179a939d1b81d8a401bf1266ca3230b74b2975edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010'],
  ])('rejects %s with a strong owner key', async (_, signature) => {
    expect(await verifyOwnerSignature(RFC8032_OWNER, syntheticMessage, bytes(signature))).toBe(false);
  });
  it('rejects an identity-owner forgery', async () => {
    const signature = new Uint8Array(64); signature[0] = 1;
    expect(await verifyOwnerSignature('4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM', syntheticMessage, signature)).toBe(false);
  });
});

/** A fixture policy whose runtime retains a proof signed by the RFC 8032 key. */
async function signedPolicy(o: Parameters<typeof authorizationPolicy>[0] = {}) {
  const f = await authorizationPolicy({status: 'active', ...o});
  const signature = await (await seedSigner(RFC8032_SEED_HEX))(f.message);
  (f.policy.runtime as unknown as Record<string, unknown>).authorization = retained(f.commitment, f.message, signature);
  return {...f, signature};
}
const rt = (p: MicroPolicy) => p.runtime as unknown as Record<string, any>;

describe('browser verification of the retained proof', () => {
  const tampers: [string, (p: MicroPolicy) => void][] = [
    ['code', p => {p.code = p.code.replace('Burn is not allowed', 'Burn is not permitted');}],
    ['source hash', p => {p.sourceHash = '00'.repeat(32);}],
    ['IR hash', p => {p.irHash = '3d'.repeat(32);}],
    ['original intent', p => {p.originalIntent = p.originalIntent + ' ';}],
    ['revision', p => {p.revision = 3;}],
    ['policy ID', p => {p.id = 'policy-other';}],
    ['network', p => {p.network = 'solana:devnet'; for (const m of [p.assetMetadata, rt(p).assetMetadata] as Record<string, unknown>[][]) m[0].network = 'solana:devnet';}],
    ['source profile', p => {rt(p).sourceProfile = 'native-v2';}],
    ['wallet profile', p => {rt(p).wallet.profile = 'solana-owner-typed-v2';}],
    ['operation', p => {rt(p).operation = 'allowit::other';}],
    ['budget units', p => {(p.typedBudgetRequirements as Record<string, unknown>[])[0].totalBudgetUnits = '50000001';}],
    ['asset label in both copies', p => {(p.assetMetadata as Record<string, unknown>[])[0].symbol = 'SOL'; rt(p).assetMetadata[0].symbol = 'SOL';}],
    ['runtime asset copy only', p => {rt(p).assetMetadata[0].symbol = 'SOL';}],
    ['top-level asset copy only', p => {(p.assetMetadata as Record<string, unknown>[])[0].symbol = 'SOL';}],
    ['missing runtime asset copy', p => {delete rt(p).assetMetadata;}],
    ['missing top-level asset copy', p => {delete (p as unknown as Record<string, unknown>).assetMetadata;}],
    ['duplicate asset entry', p => {rt(p).assetMetadata.push({...rt(p).assetMetadata[0]});}],
    ['instance nonce', p => {rt(p).instanceBinding.nonce = '00'.repeat(32);}],
    ['instance ID', p => {rt(p).instanceBinding.instanceId = '00'.repeat(32);}],
    ['funding mode', p => {rt(p).fundingMode = 'deposit';}],
  ];
  it.each(tampers)('refuses a changed %s', async (_, mutate) => {
    const {policy} = await signedPolicy();
    mutate(policy);
    await expect(verifyRetained(policy, RFC8032_OWNER, FIXTURE_ORIGIN, NOW)).rejects.toThrow();
  });

  it('refuses another owner, another site and a passed deadline', async () => {
    const {policy} = await signedPolicy();
    await expect(verifyRetained(policy, '11111111111111111111111111111111', FIXTURE_ORIGIN, NOW)).rejects.toThrow();
    await expect(verifyRetained(policy, RFC8032_OWNER, 'https://evil.test', NOW)).rejects.toThrow(/another site/);
    await expect(verifyRetained(policy, RFC8032_OWNER, FIXTURE_ORIGIN, Date.parse('2030-01-02T00:00:00Z'))).rejects.toThrow(/deadline/);
  });

  it('refuses a modified message, signature or key', async () => {
    const {policy, commitment, message, signature} = await signedPolicy();
    const flipped = signature.slice(); flipped[10] ^= 1;
    for (const auth of [
      {commitment, messageBase64: toBase64(new Uint8Array([...message, 0])), signature: toBase64(signature)},
      retained(commitment, message, flipped),
      {commitment, messageBase64: toBase64(message), signature: toBase64(signature) + '='},
    ]) {
      rt(policy).authorization = auth;
      await expect(verifyRetained(policy, RFC8032_OWNER, FIXTURE_ORIGIN, NOW)).rejects.toThrow();
    }
    // Signed by another key for the same owner address.
    const other = await (await seedSigner('11'.repeat(32)))(message);
    rt(policy).authorization = retained(commitment, message, other);
    await expect(verifyRetained(policy, RFC8032_OWNER, FIXTURE_ORIGIN, NOW)).rejects.toThrow(/does not verify/);
  });
});

/* ------------------------------------------------------------------ flow */

class MemoryJournal implements AuthorizationJournal {
  entries = new Map<string, AuthorizationEntry>();
  failWrites = false;
  async list(owner: string, policyId: string) {return [...this.entries.values()].filter(e => e.owner === owner && e.policyId === policyId).map(e => structuredClone(e));}
  async write(e: AuthorizationEntry) {if (this.failWrites) throw new Error('quota'); this.entries.set(`${e.owner}:${e.policyId}:${e.requestId}`, structuredClone(e));}
}
const freeLock: FlowDeps['lock'] = (_name, fn) => fn();

async function flow() {
  const f = await authorizationPolicy();
  const journal = new MemoryJournal();
  const sent: {path: string; body: Record<string, unknown>}[] = [];
  let reply: (path: string, body: Record<string, unknown>) => unknown = (path, body) => {
    if (path === 'micro/allocation/prepare') return {authorizationPreparation: {requestId: body.requestId, commitment: f.commitment, messageBase64: toBase64(f.message)}};
    if (path === 'micro/allocation/submit' || path === 'micro/allocation/confirm') return {authorization: recorded};
    throw new Error('unexpected');
  };
  let recorded: unknown = null;
  let ids = 0;
  const deps: FlowDeps = {send: async (path, body) => {sent.push({path, body: body as Record<string, unknown>}); return reply(path, body as Record<string, unknown>);}, journal, lock: freeLock, newId: () => `request-${++ids}`, now: () => NOW, origin: FIXTURE_ORIGIN};
  const sign = await seedSigner(RFC8032_SEED_HEX);
  return {f, journal, sent, deps, sign, setReply: (r: typeof reply) => {reply = r;}, record: (v: unknown) => {recorded = v;}};
}

describe('prepare, sign, journal, submit', () => {
  it('saves the request ID before the route, the preparation before the wallet and the proof before submit', async () => {
    const t = await flow();
    const order: string[] = [];
    const write = t.journal.write.bind(t.journal);
    t.journal.write = async e => {order.push(e.signature ? 'journal:signed' : e.messageBase64 ? 'journal:prepared' : 'journal:request'); return write(e);};
    const send = t.deps.send;
    t.deps.send = async (p, b) => {order.push(p); return send(p, b);};
    const prepared = await prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy);
    expect(prepared.requestId).toBe('request-1');
    const out = await signAuthorization(t.deps, RFC8032_OWNER, prepared, async m => {order.push('wallet'); return t.sign(m);}, () => true, () => t.f.policy);
    expect(order).toEqual(['journal:request', 'micro/allocation/prepare', 'journal:prepared', 'wallet', 'journal:signed', 'micro/allocation/submit']);
    expect(out.recorded).toBe(false);
    expect(t.sent.at(-1)?.body).toEqual({id: t.f.policy.id, revision: 2, requestId: 'request-1', signedBytes: out.proof.signatureBase64});
    expect(canonicalBase64(t.sent.at(-1)!.body.signedBytes, 's', 64)).toHaveLength(64);
  });

  it('resumes the stored request ID after reload and refuses a different message for it', async () => {
    const t = await flow();
    t.setReply(() => {throw new Error('network');});
    await expect(prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy)).rejects.toThrow('network');
    t.setReply((_, body) => ({authorizationPreparation: {requestId: body.requestId, commitment: t.f.commitment, messageBase64: toBase64(t.f.message)}}));
    expect((await prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy)).requestId).toBe('request-1');
    expect((await prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy)).requestId).toBe('request-1');
    const other = {...t.f.commitment, nonce: 'bb'.repeat(32)};
    t.setReply((_, body) => ({authorizationPreparation: {requestId: body.requestId, commitment: other, messageBase64: toBase64(authorizationPreimage(other))}}));
    await expect(prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy)).rejects.toThrow(/different message/);
    expect(t.sent.filter(s => s.path === 'micro/allocation/prepare').map(s => s.body.requestId)).toEqual(['request-1', 'request-1', 'request-1', 'request-1']);
  });

  it('prepares nothing without durable storage and signs nothing when the proof cannot be saved', async () => {
    const t = await flow();
    t.journal.failWrites = true;
    await expect(prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy)).rejects.toThrow(/cannot save/);
    expect(t.sent).toEqual([]);
    t.journal.failWrites = false;
    const prepared = await prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy);
    t.journal.failWrites = true;
    await expect(signAuthorization(t.deps, RFC8032_OWNER, prepared, t.sign, () => true, () => t.f.policy)).rejects.toThrow(/nothing was sent/);
    expect(t.sent.some(s => s.path === 'micro/allocation/submit')).toBe(false);
  });

  it('honours a cross-tab lock denial before anything is prepared', async () => {
    const t = await flow();
    t.deps.lock = async () => {throw new Error('Authorization for this policy is open in another tab.');};
    await expect(prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy)).rejects.toThrow(/another tab/);
    expect(t.sent).toEqual([]);
    expect(t.journal.entries.size).toBe(0);
  });

  it('opens no wallet when the owner changed, and keeps a signed proof unsent when the owner changes while the wallet is open', async () => {
    const t = await flow();
    const prepared = await prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy);
    let opened = 0;
    await expect(signAuthorization(t.deps, RFC8032_OWNER, prepared, async m => {opened++; return t.sign(m);}, () => false, () => t.f.policy)).rejects.toThrow(/changed/);
    expect(opened).toBe(0);
    let current = true;
    const out = await signAuthorization(t.deps, RFC8032_OWNER, prepared, async m => {current = false; return t.sign(m);}, () => current, () => t.f.policy);
    expect(out.recorded).toBe(false);
    expect(out.recorded === false && out.error).toMatch(/saved and was not sent/);
    expect(t.sent.some(s => s.path === 'micro/allocation/submit')).toBe(false);
    expect([...t.journal.entries.values()][0].signature).toBe(out.proof.signatureBase64);
  });

  it('keeps a proof unsent when the source changes while the wallet is open', async () => {
    const t = await flow();
    const prepared = await prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy);
    let latest = t.f.policy;
    const out = await signAuthorization(t.deps, RFC8032_OWNER, prepared, async m => {latest = {...latest, revision: 3}; return t.sign(m);}, () => true, () => latest);
    expect(out.recorded).toBe(false);
    expect(t.sent.some(s => s.path === 'micro/allocation/submit')).toBe(false);
  });

  it('refuses a wallet signature that does not verify for the owner, saving and sending nothing', async () => {
    const t = await flow();
    const prepared = await prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy);
    const other = await seedSigner('22'.repeat(32));
    await expect(signAuthorization(t.deps, RFC8032_OWNER, prepared, other, () => true, () => t.f.policy)).rejects.toThrow(/does not verify/);
    expect([...t.journal.entries.values()][0].signature).toBeUndefined();
    expect(t.sent.some(s => s.path === 'micro/allocation/submit')).toBe(false);
  });

  it('recovers an uncertain submit only by a same-ID read-only confirm, never a fresh prepare', async () => {
    const t = await flow();
    const prepared = await prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy);
    t.setReply(p => {if (p === 'micro/allocation/submit') throw new Error('timeout'); return {authorization: null};});
    const out = await signAuthorization(t.deps, RFC8032_OWNER, prepared, t.sign, () => true, () => t.f.policy);
    expect(out.recorded).toBe(false);
    const entry = [...t.journal.entries.values()][0];
    // The same proof blocks a new preparation.
    await expect(prepareAuthorization(t.deps, RFC8032_OWNER, t.f.policy)).rejects.toThrow(/signed authorization .* saved/);
    expect(await confirmAuthorization(t.deps, entry)).toBe(false);
    t.record(retained(t.f.commitment, t.f.message, out.proof.signature));
    t.setReply(p => (p === 'micro/allocation/confirm' ? {authorization: retained(t.f.commitment, t.f.message, out.proof.signature)} : (() => {throw new Error('unexpected');})()));
    expect(await confirmAuthorization(t.deps, entry)).toBe(true);
    expect(t.sent.filter(s => s.path !== 'micro/allocation/confirm').map(s => s.path)).toEqual(['micro/allocation/prepare', 'micro/allocation/submit']);
    expect(t.sent.filter(s => s.path === 'micro/allocation/confirm').every(s => s.body.requestId === 'request-1' && !('signedBytes' in s.body))).toBe(true);
    // A confirm that reports a different proof for the request is refused.
    const other = await (await seedSigner('33'.repeat(32)))(t.f.message);
    t.setReply(() => ({authorization: retained(t.f.commitment, t.f.message, other)}));
    await expect(confirmAuthorization(t.deps, entry)).rejects.toThrow(/different authorization/);
  });

  it('prepares nothing over a current verified grant', async () => {
    const {policy} = await signedPolicy();
    const t = await flow();
    await expect(prepareAuthorization(t.deps, RFC8032_OWNER, policy)).rejects.toThrow(/already has a current verified/);
    expect(t.sent).toEqual([]);
  });
});
