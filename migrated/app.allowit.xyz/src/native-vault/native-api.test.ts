import {afterEach, describe, expect, it, vi} from 'vitest';
import {Buffer} from 'buffer';
import {Transaction} from '@solana/web3.js';
import {authority, binding, config, executor, owner, policy, prepared, walletSign} from '../../tests/fixtures/devnet-vault';
import {NativePolicyAPI, NativePolicyLifecycle} from './native-api';
import type {Operation, OwnerMethod} from './native-contracts';
import type {NativeJournal, PreparationPointer} from './native-journal';
import * as intent from './native-wallet-intent';

// HTTP-contract fixtures with synthetic keys. No RPC, SQL or chain acceptance claim.
type Stored = Operation | PreparationPointer;
function journal(failWrite = false, stored = new Map<string, Stored>()) {
  const value = {
    read: async (name: string) => stored.get(name) ?? null,
    write: async (name: string, v: Stored) => {if (failWrite) throw new Error('Storage blocked'); stored.set(name, structuredClone(v));},
    clear: async (name: string) => {stored.delete(name);},
    entries: async () => [...stored.entries()].filter(([k]) => k.startsWith('request-')).map(([, v]) => v),
    locked: async <T>(run: () => Promise<T>) => run(),
  } as NativeJournal;
  return {value, stored};
}
const signer = () => vi.fn(async (transaction: Transaction) => walletSign(transaction));
const lifecycle = (store: NativeJournal, sign: ReturnType<typeof vi.fn>) => {
  const api = new NativePolicyAPI(config);
  // Exact lifecycle fixtures isolate the release verifier, which has separate HTTP tests below.
  vi.spyOn(api, 'verifyRelease').mockResolvedValue(config.deployment);
  return new NativePolicyLifecycle(api, store, sign as never);
};
const body = (init: RequestInit) => JSON.parse(init.body as string);
/** The record a backend would publish for the exact proof it received. */
const published = (stored: Map<string, Stored>, id: string, status: string, extra: object = {}) => {
  const r = stored.get('request-' + id) as Operation;
  return {operation: {id, method: r.method, status, signature: r.signature, signatures: r.signatures, transactionUrl: r.transactionUrl, policyId: policy.id, ...(status === 'settled' ? {finalizedSlot: 25} : {}), ...extra}};
};
afterEach(() => vi.unstubAllGlobals());

describe('native v2 API', () => {
  it('requires the backend to verify the same authority, mint, executor and deployment', async () => {
    const reply = (c: object) => vi.stubGlobal('fetch', vi.fn(async () => Response.json({verified: true, verification: 'full', network: config.network, sourceBundle: config.release.sourceBundle, config: c})));
    const exact = {network: config.network, mint: config.mint, executor, authority, deployment: config.deployment};
    reply(exact);
    await expect(new NativePolicyAPI(config).verifyRelease()).resolves.toEqual(config.deployment);
    reply({...exact, authority: executor});
    await expect(new NativePolicyAPI(config).verifyRelease()).rejects.toThrow(/did not verify/);
    reply({...exact, deployment: {...config.deployment, custody: executor}});
    await expect(new NativePolicyAPI(config).verifyRelease()).rejects.toThrow(/did not verify/);
  });
  it('reads the vault only under the derived binding', async () => {
    let reply: object = {state: null, binding, operations: []};
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/save') ? {policy} : reply)));
    const api = new NativePolicyAPI(config);
    await expect(api.state(policy, owner)).resolves.toEqual({allowedServices: [], state: null, binding, operations: []});
    reply = {state: null, binding: {...binding, authority: executor}, operations: []};
    await expect(api.state(policy, owner)).rejects.toThrow(/different vault binding/);
    reply = {state: {...binding, vaultId: 'bb'.repeat(32), sourceBundle: policy.sourceBundle, policyArtifact: policy.policyArtifact}, binding, operations: []};
    await expect(api.state(policy, owner)).rejects.toThrow(/another policy/);
  });
});

describe('native v2 browser lifecycle', () => {
  it('requires full chain verification before opening the wallet and retains its preparation on failure', async () => {
    const store = journal(), id = 'verified-before-owner-sign', sign = signer();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/save')) return Response.json({policy});
      if (url.endsWith('/prepare')) return Response.json(prepared('deploy', {id, amount: '0.01'}));
      expect(url).toBe('/api/native/verify');
      return Response.json({verified: true, verification: 'recovery-only', network: config.network, sourceBundle: config.release.sourceBundle, config});
    });
    vi.stubGlobal('fetch', fetch);
    const lc = new NativePolicyLifecycle(new NativePolicyAPI(config), store.value, sign);
    await expect(lc.submit(policy, owner, 'deploy', {amount: '0.01'}, id)).rejects.toThrow(/did not verify/);
    expect(sign).not.toHaveBeenCalled();
    expect(store.stored.has('prepared-deploy')).toBe(true);
    expect(store.stored.has('request-' + id)).toBe(false);
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/submit'))).toBe(false);
  });
  it('does not label a submitted proof settled without exact finalized receipt metadata', async () => {
    const store = journal(), id = 'missing-finalized-slot', sign = signer();
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/save')) return Response.json({policy});
      if (url.endsWith('/prepare')) return Response.json(prepared('fund', {id, amount: '1'}));
      return Response.json(published(store.stored, id, 'settled', {finalizedSlot: undefined}));
    });
    const result = await lifecycle(store.value, sign).submit(policy, owner, 'fund', {amount: '1'}, id);
    expect(result.status).toBe('uncertain');
    expect(result.signedBytes).toBe((store.stored.get('request-' + id) as Operation).signedBytes);
  });
  it('rejects a recovery observation with a different method even when id and signature match', async () => {
    const store = journal(), id = 'same-id-wrong-method', sign = signer();
    await store.value.write('request-' + id, await lifecycleSeed('fund', id, {amount: '1'}));
    vi.stubGlobal('fetch', async () => Response.json(published(store.stored, id, 'settled', {method: 'execute'})));
    await expect(lifecycle(store.value, sign).recover(id, policy, owner)).rejects.toThrow(/different operation proof/);
    expect((store.stored.get('request-' + id) as Operation).status).toBe('uncertain');
    expect(sign).not.toHaveBeenCalled();
  });
  it('journals exact signed bytes before the only submit request', async () => {
    const store = journal(), id = 'owner-fund-once', sign = signer(), calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/save')) return Response.json({policy});
      if (url.endsWith('/prepare')) {expect(body(init)).toEqual({policyId: policy.id, requestId: id, method: 'fund', options: {amount: '1'}}); return Response.json(prepared('fund', {id, amount: '1'}));}
      const kept = store.stored.get('request-' + id) as Operation;
      expect(body(init).signedBytes).toBe(kept.signedBytes);
      expect(store.stored.get('last')).toEqual({id});
      expect(store.stored.has('prepared-fund')).toBe(false);
      return Response.json(published(store.stored, id, 'submitted'));
    }));
    const result = await lifecycle(store.value, sign).submit(policy, owner, 'fund', {amount: '1.0'}, id);
    expect(result.status).toBe('submitted');
    expect(calls).toEqual(['/api/native/save', '/api/native/prepare', '/api/native/submit']);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('creates, funds and activates in one signed setup transaction', async () => {
    const store = journal(), sign = signer(), phases: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/save')) return Response.json({policy});
      if (url.endsWith('/prepare')) {const input = body(init); expect(input.method).toBe('deploy'); expect(input.options).toEqual({amount: '10'}); return Response.json(prepared('deploy', {id: input.requestId, amount: '10'}));}
      return Response.json(published(store.stored, body(init).requestId, 'settled'));
    }));
    const result = await lifecycle(store.value, sign).submit(policy, owner, 'deploy', {amount: '10'}, 'setup-0001', p => phases.push(p));
    expect(result.status).toBe('settled');
    expect(phases).toEqual(['preparing', 'signing', 'sending']);
    const tx = Transaction.from(Buffer.from(result.signedBytes, 'base64'));
    expect(tx.instructions.map(i => i.programId.toBase58().slice(0, 13))).toEqual(['ComputeBudget', 'ComputeBudget', 'ATokenGPvbdGV', config.deployment.custody.slice(0, 13), config.deployment.custody.slice(0, 13), config.deployment.custody.slice(0, 13)]);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('never opens the wallet or submits when preparation storage fails', async () => {
    const store = journal(true), send = vi.fn(async (url: string) => Response.json(url.endsWith('/save') ? {policy} : prepared('fund', {id: 'owner-fund-once', amount: '1'})));
    vi.stubGlobal('fetch', send);
    const sign = signer();
    await expect(lifecycle(store.value, sign).submit(policy, owner, 'fund', {amount: '1'}, 'owner-fund-once')).rejects.toThrow('Storage blocked');
    expect(sign).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('retries a lost preparation reply with the original durable request id', async () => {
    const store = journal(), id = 'lost-preparation', sign = signer();
    let lost = true;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/save')) return Response.json({policy});
      if (url.endsWith('/recover')) return Response.json({operation: {id, status: 'prepared'}});
      if (url.endsWith('/prepare')) {
        expect(body(init).requestId).toBe(id);
        if (lost) throw new Error('Lost preparation reply');
        return Response.json(prepared('fund', {id, amount: '1'}));
      }
      return Response.json(published(store.stored, id, 'settled'));
    });
    const lc = lifecycle(store.value, sign);
    await expect(lc.submit(policy, owner, 'fund', {amount: '1'}, id)).rejects.toThrow('could not be reached');
    expect(sign).not.toHaveBeenCalled();
    lost = false;
    await expect(lc.submit(policy, owner, 'fund', {amount: '2'}, 'other-click')).rejects.toThrow(/original preparation/);
    const result = await lc.submit(policy, owner, 'fund', {amount: '1'}, 'other-click');
    expect(result.id).toBe(id);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('retains a refused preparation and retries the same id without changing its amount', async () => {
    const store = journal(), id = 'refused-fund', calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.endsWith('/save')) return Response.json({policy});
      if (url.endsWith('/recover')) return Response.json({operation: {id, status: 'prepared'}});
      if (url.endsWith('/prepare')) {expect(body(init).requestId).toBe(id); return Response.json(prepared('fund', {id, amount: '1'}));}
      return Response.json(published(store.stored, id, 'settled'));
    });
    const sign = vi.fn().mockRejectedValueOnce({code: 4001}).mockImplementation(async (t: Transaction) => walletSign(t));
    const lc = lifecycle(store.value, sign);
    await expect(lc.submit(policy, owner, 'fund', {amount: '1'}, id)).rejects.toEqual({code: 4001});
    expect(store.stored.has('prepared-fund')).toBe(true);
    await expect(lc.submit(policy, owner, 'fund', {amount: '2'}, 'changed')).rejects.toThrow(/intent/);
    expect(sign).toHaveBeenCalledTimes(1);
    const result = await lc.submit(policy, owner, 'fund', {amount: '1'}, 'different-click');
    expect(result.id).toBe(id);
    expect(sign).toHaveBeenCalledTimes(2);
    // The same request id returns the backend's stored preparation; it never names a new operation.
    expect(calls.filter(u => u.endsWith('/prepare'))).toHaveLength(2);
    expect(calls.filter(u => u.endsWith('/submit'))).toHaveLength(1);
  });

  it('recovers a lost submit reply from the original proof without another signature', async () => {
    const store = journal(), id = 'owner-withdraw-once', sign = signer();
    let lost = true;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/save')) return Response.json({policy});
      if (url.endsWith('/prepare')) return Response.json(prepared('withdraw', {id, amount: '1'}));
      if (url.endsWith('/submit') && lost) throw new Error('Lost reply');
      const kept = store.stored.get('request-' + id) as Operation;
      if (url.endsWith('/import')) expect(body(init).record.signedBytes).toBe(kept.signedBytes);
      // The backend publishes a close-style numeric slot; the journal keeps its exact record fields.
      return Response.json(published(store.stored, id, 'settled', {instanceSlot: 7, revision: '9'}));
    });
    const lc = lifecycle(store.value, sign);
    const uncertain = await lc.submit(policy, owner, 'withdraw', {amount: '1'}, id);
    expect(uncertain.status).toBe('uncertain');
    lost = false;
    const recovered = await lc.recover(id, policy, owner);
    expect(recovered.status).toBe('settled');
    expect(recovered.signedBytes).toBe(uncertain.signedBytes);
    expect(recovered.revision).toBe(uncertain.revision);
    expect(recovered).not.toHaveProperty('instanceSlot');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('after a reload, replays the saved proof unchanged and opens no wallet', async () => {
    const shared = new Map<string, Stored>(), id = 'reload-close';
    let lost = true;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const input = body(init);
      if (url.endsWith('/save')) return Response.json({policy});
      if (url.endsWith('/prepare')) return Response.json(prepared('close', {id, revision: '4', instanceSlot: 31}));
      if (url.endsWith('/submit')) {
        expect(input.signedBytes).toBe((shared.get('request-' + id) as Operation).signedBytes);
        if (lost) throw new Error('Tab closed before the reply');
        return Response.json(published(shared, id, 'submitted', {instanceSlot: 31}));
      }
      if (url.endsWith('/import')) {expect(input.record.instanceSlot).toBe('31'); return Response.json(published(shared, id, 'uncertain'));}
      return Response.json(published(shared, id, 'uncertain', {instanceSlot: 31}));
    });
    const first = signer();
    expect((await lifecycle(journal(false, shared).value, first).submit(policy, owner, 'close', {instanceSlot: '31'}, id)).status).toBe('uncertain');
    lost = false;
    const reloaded = signer();
    const replayed = await lifecycle(journal(false, shared).value, reloaded).replay(id, policy, owner);
    expect(replayed.status).toBe('submitted');
    expect(replayed.instanceSlot).toBe('31');
    expect(first).toHaveBeenCalledTimes(1);
    expect(reloaded).not.toHaveBeenCalled();
    // A fresh close while that proof is unresolved needs its recovery first, never a second signature.
    await expect(lifecycle(journal(false, shared).value, reloaded).submit(policy, owner, 'close', {instanceSlot: '31'}, 'second-close')).rejects.toThrow(/unresolved/);
    expect(reloaded).not.toHaveBeenCalled();
  });

  it('requires verified expiry and explicit consent for an additional owner operation', async () => {
    const store = journal(), oldId = 'old-preparation', newId = 'additional-fund', sign = signer();
    store.stored.set('prepared-fund', {id: oldId, prepared: prepared('fund', {id: oldId, amount: '1'})});
    let expired = false;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('/recover')) return Response.json({operation: {id: oldId, blockhashExpired: expired, additionalOwnerOperationAllowed: expired}});
      if (url.endsWith('/save')) return Response.json({policy});
      if (url.endsWith('/prepare')) {expect(body(init).options).toEqual({amount: '3', additionalOwnerOperation: true}); return Response.json(prepared('fund', {id: newId, amount: '3'}));}
      return Response.json(published(store.stored, newId, 'settled'));
    });
    const lc = lifecycle(store.value, sign);
    await expect(lc.submit(policy, owner, 'fund', {amount: '3', additionalOwnerOperation: true}, newId)).rejects.toThrow(/not been verified expired/);
    expired = true;
    await expect(lc.submit(policy, owner, 'fund', {amount: '1'}, newId)).rejects.toThrow(/expired/);
    expect(sign).not.toHaveBeenCalled();
    const result = await lc.submit(policy, owner, 'fund', {amount: '3', additionalOwnerOperation: true}, newId);
    expect(result.id).toBe(newId);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(store.stored.get('preparation-' + oldId)).toMatchObject({id: oldId});
  });

  it('does not open the wallet for an altered backend intent', async () => {
    const wrong = prepared('fund', {id: 'owner-fund-once', amount: '1'});
    wrong.intent = wrong.intent.replace('"amount":"1"', '"amount":"2"');
    vi.stubGlobal('fetch', async (url: string) => Response.json(url.endsWith('/save') ? {policy} : wrong));
    const sign = signer();
    await expect(lifecycle(journal().value, sign).submit(policy, owner, 'fund', {amount: '1'}, 'owner-fund-once')).rejects.toThrow(/intent/);
    expect(sign).not.toHaveBeenCalled();
  });
});

async function lifecycleSeed(method: OwnerMethod, id: string, input: Parameters<typeof prepared>[1]): Promise<Operation> {
  const p = prepared(method, {...input, id});
  return intent.signedProof(p, walletSign(Transaction.from(Buffer.from(p.unsignedTransaction, 'base64'))), 'solana:devnet');
}
