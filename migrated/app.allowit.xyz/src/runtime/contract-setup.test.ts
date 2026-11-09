import {describe, expect, it, vi} from 'vitest';
import {deployment, OWNER, REQUEST_ID, walletSign} from '../paysh/fixtures/paysh-setup';
import {encodeConfig, type SignedSetup} from '../paysh/paysh-wallet-intent';
import type {MicroPolicy} from '../micro/micro-contracts';
import {boundDeposit, checkContractSetup, discardContractDraft, findProof, prepareContractSetup, resendContractSetup, savedContext, signContractSetup, type BindingStore, type SetupBinding, type SetupDeps, type SetupLock} from './contract-setup';
import {boundSetup, type BoundSetup} from './fixtures/bound-setup';
import {serviceApprovalStore} from './service-approvals';

// Deterministic fixtures: no deployment, compiler, chain or wallet response here is real.
const OTHER = '11111111111111111111111111111111';
const setupReply = (s: BoundSetup, over: Record<string, unknown> = {}) => ({policies: [], setup: {policyId: s.id, requestId: REQUEST_ID, profile: s.binding.walletProfile, phase: 'prepared', preparationId: 'prep-1', prepared: s.preparedJson, draft: s.draft, deployment, ...over}});
const chain = (s: BoundSetup) => ({initialized: true, policyAddress: s.policyAddress, owner: OWNER, solVault: s.solCustody, balanceLamports: 50_000_000});
const state = (s: BoundSetup, status: string, signature?: string, over: Record<string, unknown> = {}) => ({policies: [], setup: {policyId: s.id, requestId: REQUEST_ID, draft: s.draft, state: {requestId: REQUEST_ID, policy: s.rawPolicy, status, ...(signature ? {signature} : {}), ...(status === 'finalized' ? {chain: chain(s)} : {})}, ...over}});

function harness(s: BoundSetup, opts: {failWrite?: boolean; bindingsFail?: boolean; reply?: (path: string, body: any) => unknown; lock?: SetupLock} = {}) {
  const stored = new Map<string, SignedSetup>();
  const log: {path: string; body: any}[] = [];
  const events: string[] = [];
  const bindingMap = new Map<string, SetupBinding>();
  const bindings: BindingStore = {
    read: (o, p) => bindingMap.get(`${o}:${p}`) ?? null,
    write: (o, p, v) => {if (opts.bindingsFail) return false; bindingMap.set(`${o}:${p}`, structuredClone(v)); return true;},
  };
  const deps: SetupDeps = {
    send: async (path, body) => {events.push(`send:${path}`); log.push({path, body}); return opts.reply ? opts.reply(path, body) : setupReply(s);},
    journal: {
      read: async (o, p) => stored.get(`${o}:${p}`) ?? null,
      write: async proof => {if (opts.failWrite) throw new Error('Storage blocked'); events.push('journal:write'); stored.set(`${proof.owner}:${proof.policyId}`, structuredClone(proof));},
      clear: async () => {throw new Error('A proof is never cleared here.');},
    },
    bindings,
    lock: opts.lock ?? (async (_name, fn) => fn()),
    newId: () => REQUEST_ID,
  };
  const sign = vi.fn(async () => {events.push('wallet:sign'); return walletSign(s.prepared);});
  return {deps, stored, log, events, sign, bindingMap};
}

describe('contract-wallet setup through the common routes', () => {
  it('refuses aggregate or single-call metadata changed before the wallet opens', async () => {
    const s = await boundSetup({allowedServiceIds: ['weather/current', 'weather/forecast'], maxPaymentUsdcPerPeriod: '2000'});
    for (const change of [{limit: '0.001'}, {mint: OTHER}, {token: OTHER}]) {
      const h = harness(s);
      const {setup} = await prepareContractSetup(h.deps, OWNER, s.micro());
      await expect(signContractSetup(h.deps, OWNER, setup, h.sign, () => true, () => s.micro(change))).rejects.toThrow(/payment budget/);
      expect(h.sign).not.toHaveBeenCalled();
    }
    const h = harness(s), p = s.micro();
    const {setup} = await prepareContractSetup(h.deps, OWNER, p);
    let reads = 0;
    await expect(signContractSetup(h.deps, OWNER, setup, h.sign, () => true, () => ++reads < 3 ? p : {...p, limit: '0.003'})).rejects.toThrow(/changed/);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('refuses rejected or replaced generation selections even when the entire server reply agrees with itself', async () => {
    const s = await boundSetup({allowedServiceIds: ['solana-foundation/google/airquality', 'api/evil']});
    for (const rejected of [true, false]) {
      const h = harness(s), records = new Map<string, string>();
      h.deps.serviceApprovals = serviceApprovalStore({getItem: k => records.get(k) ?? null, setItem: (k, v) => {records.set(k, v);}});
      h.deps.serviceApprovals.remember(OWNER, s.id, ['solana-foundation/google/airquality', 'api/weather'], rejected);
      await expect(prepareContractSetup(h.deps, OWNER, s.micro())).rejects.toThrow(/selection/);
      expect(h.log).toHaveLength(0);
      expect(h.sign).not.toHaveBeenCalled();
    }
  });

  it('refuses a reply for another policy, request, revision, owner, profile or phase, and a tampered transaction', async () => {
    const s = await boundSetup();
    const tamperedConfig = encodeConfig({...s.config, maxSwapLamportsPerCall: '3000000'}).toString('base64');
    for (const [over, pattern] of [
      [{policyId: 'other'}, /another policy/], [{requestId: 'other'}, /another request/], [{revision: 3}, /another revision/], [{profile: 'solana-owner-signed'}, /profile/], [{phase: 'submitted'}, /prepared/],
      [{draft: {...s.draft, policy: {...s.rawPolicy, owner: OTHER}}}, /./], [{prepared: {...s.preparedJson, configBytes: tamperedConfig}}, /Config differs/],
      [{deployment: {...deployment, genesis: OTHER}}, /genesis/], [{deployment: {...deployment, moduleDigest: 'ee'.repeat(32)}}, /moduleDigest/],
    ] as [Record<string, unknown>, RegExp][]) {
      const h = harness(s, {reply: () => setupReply(s, over)});
      await expect(prepareContractSetup(h.deps, OWNER, s.micro())).rejects.toThrow(pattern);
      expect(h.sign).not.toHaveBeenCalled();
    }
  });

  it('requires the bound deposit in the funding asset, with no silent skip', async () => {
    const s = await boundSetup();
    for (const [extra, pattern] of [
      [{fundingRequest: {amount: '0.06', token: 'Testnet SOL'}}, /differs from this policy.*new draft/],
      [{fundingRequest: undefined}, /no requested deposit/],
      [{fundingRequest: {amount: '0.05', token: 'USDC'}}, /not Testnet SOL/],
      [{fundingRequest: {amount: '0.0500000001', token: 'Testnet SOL'}}, /exact amount/],
    ] as [Partial<MicroPolicy>, RegExp][]) {
      const h = harness(s);
      await expect(prepareContractSetup(h.deps, OWNER, s.micro(extra))).rejects.toThrow(pattern);
      expect(h.sign).not.toHaveBeenCalled();
    }
    expect(boundDeposit(s.micro())).toBe(50_000_000n);
  });

  it('prepares nothing without storage for the request ID, and nothing for an owner wallet or another network', async () => {
    const s = await boundSetup();
    const h = harness(s, {bindingsFail: true});
    await expect(prepareContractSetup(h.deps, OWNER, s.micro())).rejects.toThrow(/cannot save/);
    expect(h.log).toEqual([]);
    const legacy = harness(s);
    await expect(prepareContractSetup(legacy.deps, OWNER, s.micro({runtime: undefined}))).rejects.toThrow(/does not support/);
    await expect(prepareContractSetup(legacy.deps, OWNER, s.micro({network: 'solana:devnet'}))).rejects.toThrow(/does not support|Testnet/);
    expect(legacy.log).toEqual([]);
  });

  it('signs once, journals the verified proof under the one ID before the only submit, and sends the exact bytes', async () => {
    const s = await boundSetup();
    const h = harness(s, {reply: path => (path.endsWith('prepare') ? setupReply(s) : state(s, 'submitted'))});
    const p = s.micro();
    const {setup} = await prepareContractSetup(h.deps, OWNER, p);
    const outcome = await signContractSetup(h.deps, OWNER, setup, h.sign, () => true, () => p);
    expect(outcome.submitted).toBe(true);
    expect(h.events).toEqual(['send:micro/allocation/prepare', 'wallet:sign', 'journal:write', 'send:micro/allocation/submit']);
    expect(h.log[1]).toEqual({path: 'micro/allocation/submit', body: {id: s.id, revision: 2, requestId: REQUEST_ID, signedBytes: outcome.proof.signedBytes}});
    expect(outcome.proof.policyId).toBe(s.id);
    expect(h.stored.get(`${OWNER}:${s.id}`)).toEqual(outcome.proof);
    await expect(signContractSetup(h.deps, OWNER, setup, h.sign, () => true, () => p)).rejects.toThrow(/already saved/);
    await expect(prepareContractSetup(h.deps, OWNER, p)).rejects.toThrow(/already saved/);
    expect(h.sign).toHaveBeenCalledTimes(1);
  });

  it('keeps the proof under the original owner and broadcasts nothing after an owner change during signing', async () => {
    const s = await boundSetup();
    const h = harness(s);
    const p = s.micro();
    const {setup} = await prepareContractSetup(h.deps, OWNER, p);
    let current = true;
    const sign = vi.fn(async () => {current = false; return walletSign(s.prepared);});
    const outcome = await signContractSetup(h.deps, OWNER, setup, sign, () => current, () => p);
    expect(outcome.submitted).toBe(false);
    expect(h.log.map(l => l.path)).toEqual(['micro/allocation/prepare']);
    expect(h.stored.get(`${OWNER}:${s.id}`)?.owner).toBe(OWNER);
    expect(await findProof(h.deps, OTHER, p)).toBeNull();
  });

  it('keeps the original proof and stops broadcast when source changes while the wallet signs', async () => {
    const s = await boundSetup(), h = harness(s), p = s.micro();
    const {setup} = await prepareContractSetup(h.deps, OWNER, p);
    const sign = vi.fn(async () => {p.code += '// changed while signing\n'; return walletSign(s.prepared);});
    const outcome = await signContractSetup(h.deps, OWNER, setup, sign, () => true, () => p);
    expect(outcome.submitted).toBe(false);
    expect(h.log.map(l => l.path)).toEqual(['micro/allocation/prepare']);
    expect(h.stored.get(`${OWNER}:${s.id}`)).toEqual(outcome.proof);
    const context = (await savedContext(h.deps.bindings, OWNER, p, outcome.proof))!;
    expect(context).not.toBeNull(); // Original context stays available for read-only reconciliation.
    h.log.length = 0;
    const resendDeps = {...h.deps, send: async (path: string, body: unknown) => {h.log.push({path, body}); return state(s, 'submitted');}};
    await expect(resendContractSetup(resendDeps, OWNER, context, () => true, () => p)).rejects.toThrow(/sourceHash/);
    expect(h.log.map(l => l.path)).toEqual(['micro/allocation/confirm']);
    expect(h.stored.get(`${OWNER}:${s.id}`)).toEqual(outcome.proof);
  });

  it('signs nothing when setup cannot be serialized across tabs', async () => {
    const s = await boundSetup();
    const h = harness(s, {lock: async () => {throw new Error('Setup for this policy is open in another tab.');}});
    const p = s.micro();
    const {setup} = await prepareContractSetup(h.deps, OWNER, p);
    await expect(signContractSetup(h.deps, OWNER, setup, h.sign, () => true, () => p)).rejects.toThrow(/another tab/);
    expect(h.sign).not.toHaveBeenCalled();
  });

  it('after a reload, checks without resending and resends only the original bytes', async () => {
    const s = await boundSetup();
    const h = harness(s, {reply: path => (path.endsWith('prepare') ? setupReply(s) : path.endsWith('submit') ? (() => {throw new TypeError('network down');})() : state(s, 'submitted'))});
    const p = s.micro();
    const {setup} = await prepareContractSetup(h.deps, OWNER, p);
    const outcome = await signContractSetup(h.deps, OWNER, setup, h.sign, () => true, () => p);
    expect(outcome.submitted).toBe(false);
    const proof = (await findProof(h.deps, OWNER, p))!;
    const context = (await savedContext(h.deps.bindings, OWNER, {id: s.id, revision: 2}, proof))!;
    expect(context.binding).toEqual(s.binding);
    h.log.length = 0;
    expect((await checkContractSetup(h.deps, context, proof, () => true)).status).toBe('submitted');
    expect(h.log).toEqual([{path: 'micro/allocation/confirm', body: {id: s.id, revision: 2, requestId: REQUEST_ID}}]);
    h.log.length = 0;
    const h2 = {...h.deps, send: async (path: string, body: unknown) => {h.log.push({path, body}); return state(s, 'submitted');}};
    await resendContractSetup(h2, OWNER, context, () => true, () => p);
    expect(h.log.map(l => l.path)).toEqual(['micro/allocation/confirm', 'micro/allocation/submit']);
    expect(h.log[1].body).toEqual({id: s.id, revision: 2, requestId: REQUEST_ID, signedBytes: proof.signedBytes});
    expect(h.sign).toHaveBeenCalledTimes(1);
    // The saved proof is never rewritten by a check or resend.
    expect(h.stored.get(`${OWNER}:${s.id}`)).toEqual(proof);
  });
});

describe('unsigned contract draft discard',()=>{
  it('refuses any locally journaled signed proof even before the server has seen it',async()=>{
    const s=await boundSetup(),h=harness(s),p=s.micro();
    p.runtime!.capabilities.discard=true;
    const proof:SignedSetup={requestId:REQUEST_ID,policyId:s.id,owner:OWNER,signature:'fixture',signedBytes:'AQ=='};
    h.stored.set(`${OWNER}:${s.id}`,proof);
    await expect(discardContractDraft(h.deps,OWNER,p,()=>true)).rejects.toThrow(/signed setup/);
    expect(h.log).toEqual([]);expect(h.stored.get(`${OWNER}:${s.id}`)).toEqual(proof);
  });
});

it('refuses a new preparation or signature for an already active policy',async()=>{
  const s=await boundSetup(),h=harness(s),p=s.micro({status:'active'});
  await expect(prepareContractSetup(h.deps,OWNER,p)).rejects.toThrow(/Nothing new/);
  expect(h.log).toEqual([]);
  const draft=s.micro();const {setup}=await prepareContractSetup(h.deps,OWNER,draft);h.log.length=0;
  await expect(signContractSetup(h.deps,OWNER,setup,h.sign,()=>true,()=>p)).rejects.toThrow(/changed/);
  expect(h.sign).not.toHaveBeenCalled();expect(h.log).toEqual([]);
});

it('refuses a draft whose original setup is already signed on another device',async()=>{
 const s=await boundSetup(),h=harness(s),p=s.micro();
 p.runtime!.setup={status:'submitted',signature:'original-signature',requestId:REQUEST_ID};
 await expect(prepareContractSetup(h.deps,OWNER,p)).rejects.toThrow(/Nothing new/);
 expect(h.log).toEqual([]);expect(h.sign).not.toHaveBeenCalled();
});

it.each(['signed','submitted','unknown','finalized'])('refuses discard for a server %s setup without a local proof',async status=>{
 const s=await boundSetup(),h=harness(s),p=s.micro();
 p.runtime!.capabilities.discard=true;
 p.runtime!.setup={status,signature:'original-signature',requestId:REQUEST_ID};
 await expect(discardContractDraft(h.deps,OWNER,p,()=>true)).rejects.toThrow(/cannot be discarded/);
 expect(h.log).toEqual([]);expect(h.sign).not.toHaveBeenCalled();
});
