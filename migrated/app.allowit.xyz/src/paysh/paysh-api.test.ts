import {afterEach, describe, expect, it, vi} from 'vitest';
import {deployment, draft, OWNER, policy, POLICY_ADDRESS, prepared, preparedJson, rawPolicy, REQUEST_ID, SOL_CUSTODY, walletSign} from './fixtures/paysh-setup';
import {archiveAbsentSetup, confirmSetup, prepareSetup, signPrepared, type SetupJournal} from './paysh-api';
import {fixtureSetupApi} from './fixtures/setup-api';
import type {SignedSetup} from './paysh-wallet-intent';

interface Sent {url: string; method: string; body: unknown; headers: Record<string, string>; credentials?: RequestCredentials; redirect?: RequestRedirect}
function backend(reply: (url: string, body: unknown) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const body = init.body === undefined ? undefined : JSON.parse(init.body as string);
    sent.push({url, method: init.method!, body, headers: init.headers as Record<string, string>, credentials: init.credentials, redirect: init.redirect});
    return reply(url, body);
  }));
  return sent;
}
function journal(failWrite = false) {
  const stored = new Map<string, SignedSetup>();
  const value: SetupJournal = {
    read: async (o, p) => stored.get(`${o}:${p}`) ?? null,
    write: async proof => {if (failWrite) throw new Error('Storage blocked'); stored.set(`${proof.owner}:${proof.policyId}`, structuredClone(proof));},
    clear: async (o, p) => {stored.delete(`${o}:${p}`);},
  };
  return {value, stored};
}
const signer = vi.fn(async () => walletSign(prepared()));
afterEach(() => {vi.unstubAllGlobals(); signer.mockClear();});

const submitted = () => ({policy: rawPolicy, requestId: REQUEST_ID, status: 'submitted'});
const chain = {initialized: true, policyAddress: POLICY_ADDRESS.toBase58(), owner: OWNER, solVault: SOL_CUSTODY.toBase58(), balanceLamports: 50_000_000};
const absent = (signature: string) => ({policy: rawPolicy, requestId: REQUEST_ID, status: 'absent', signature, chain: {initialized: false, policyAddress: chain.policyAddress, owner: chain.owner, solVault: chain.solVault}});
const finalized = (signature: string) => ({policy: rawPolicy, requestId: REQUEST_ID, status: 'finalized', signature, chain});

describe('PaySH setup lifecycle', () => {
  it('never opens the wallet for a tampered preparation', async () => {
    const store = journal();
    backend(() => Response.json(preparedJson(prepared({config: {allocationLamports: '60000000'}}))));
    await expect(prepareSetup(fixtureSetupApi, store.value, deployment, draft, OWNER, REQUEST_ID)).rejects.toThrow(/Config differs/);
    backend(() => Response.json({...preparedJson(), requestId: 'other-request'}));
    await expect(prepareSetup(fixtureSetupApi, store.value, deployment, draft, OWNER, REQUEST_ID)).rejects.toThrow(/request identity/);
    backend(() => Response.json({...preparedJson(), policy: {...rawPolicy, maxPaymentUsdc: 999}}));
    await expect(prepareSetup(fixtureSetupApi, store.value, deployment, draft, OWNER, REQUEST_ID)).rejects.toThrow(/different policy/);
    expect(signer).not.toHaveBeenCalled();
  });

  it('never submits when the journal cannot save the signed bytes', async () => {
    const store = journal(true);
    const sent = backend(() => Response.json({}));
    await expect(signPrepared(fixtureSetupApi, store.value, deployment, draft, OWNER, REQUEST_ID, prepared(), signer)).rejects.toThrow('Storage blocked');
    expect(sent).toHaveLength(0);
  });

  it('keeps the signed proof and does not retry when the submit reply is lost', async () => {
    const store = journal();
    const sent = backend(() => {throw new TypeError('network down');});
    const outcome = await signPrepared(fixtureSetupApi, store.value, deployment, draft, OWNER, REQUEST_ID, prepared(), signer);
    expect(outcome.submitted).toBe(false);
    expect(sent).toHaveLength(1);
    expect(store.stored.get(`${OWNER}:${rawPolicy.id}`)).toEqual(outcome.proof);
    await expect(signPrepared(fixtureSetupApi, store.value, deployment, draft, OWNER, REQUEST_ID, prepared(), signer)).rejects.toThrow(/already saved/);
    await expect(prepareSetup(fixtureSetupApi, store.value, deployment, draft, OWNER, 'another-request')).rejects.toThrow(/already saved/);
    expect(signer).toHaveBeenCalledTimes(1);
  });

  it('counts a setup only when finalized with this signature, initialized policy account, owner and SOL custody', async () => {
    const proof: SignedSetup = {requestId: REQUEST_ID, policyId: rawPolicy.id, owner: OWNER, signature: 'a', signedBytes: 'x'};
    const sent = backend(() => Response.json(finalized('a')));
    expect((await confirmSetup(fixtureSetupApi, proof, policy, deployment)).status).toBe('finalized');
    expect(sent[0]).toMatchObject({url: '/api/paysh/confirm', body: {policyId: rawPolicy.id, requestId: REQUEST_ID}});
    backend(() => Response.json(finalized('c')));
    await expect(confirmSetup(fixtureSetupApi, proof, policy, deployment)).rejects.toThrow(/different setup transaction/);
    backend(() => Response.json({...finalized('a'), chain: {...chain, initialized: false}}));
    await expect(confirmSetup(fixtureSetupApi, proof, policy, deployment)).rejects.toThrow(/initialized/);
    backend(() => Response.json({...finalized('a'), chain: {...chain, solVault: POLICY_ADDRESS.toBase58()}}));
    await expect(confirmSetup(fixtureSetupApi, proof, policy, deployment)).rejects.toThrow(/initialized/);
    backend(() => Response.json({...finalized('a'), requestId: 'other'}));
    await expect(confirmSetup(fixtureSetupApi, proof, policy, deployment)).rejects.toThrow(/different setup request/);
    backend(() => Response.json({...finalized('a'), policy: {...rawPolicy, preferenceThresholdBps: 5000}}));
    await expect(confirmSetup(fixtureSetupApi, proof, policy, deployment)).rejects.toThrow(/policy/);
    backend(() => Response.json(submitted()));
    expect((await confirmSetup(fixtureSetupApi, proof, policy, deployment)).status).toBe('submitted');
    backend(() => Response.json({policy: rawPolicy, requestId: REQUEST_ID, status: 'prepared'}));
    expect((await confirmSetup(fixtureSetupApi, proof, policy, deployment)).status).toBe('prepared');
  });
});

describe('proven-absent signed setup recovery', () => {
  it('archives only after a fresh positive absence check, without signing, submitting or deleting the original proof', async () => {
    const store = journal();
    const proof: SignedSetup = {requestId: REQUEST_ID, policyId: rawPolicy.id, owner: OWNER, signature: 'a', signedBytes: 'x'};
    await store.value.write(proof);
    const sent = backend(url => Response.json(url.endsWith('/confirm') ? absent('a') : {draftId: rawPolicy.id, status: 'archived'}));
    await archiveAbsentSetup(fixtureSetupApi, store.value, deployment, policy, OWNER);
    expect(sent.map(s => s.url)).toEqual(['/api/paysh/confirm', '/api/paysh/archive']);
    expect(store.stored.get(`${OWNER}:${rawPolicy.id}`)).toEqual(proof);
    expect(signer).not.toHaveBeenCalled();
  });
  it('preserves the proof and refuses archive for unresolved, mismatched, finalized or unreadable replies', async () => {
    const store = journal();
    const proof: SignedSetup = {requestId: REQUEST_ID, policyId: rawPolicy.id, owner: OWNER, signature: 'a', signedBytes: 'x'};
    await store.value.write(proof);
    for (const reply of [submitted(), {...absent('a'), requestId: 'other'}, absent('wrong'), {...absent('a'), chain: {...chain, initialized: true}}, {...absent('a'), chain: {...chain, initialized: false, policyAddress: OWNER}}, finalized('a')]) {
      const sent = backend(() => Response.json(reply));
      await expect(archiveAbsentSetup(fixtureSetupApi, store.value, deployment, policy, OWNER)).rejects.toThrow();
      expect(sent.map(s => s.url)).toEqual(['/api/paysh/confirm']);
      expect(store.stored.get(`${OWNER}:${rawPolicy.id}`)).toEqual(proof);
    }
    const sent = backend(() => {throw new TypeError('network down');});
    await expect(archiveAbsentSetup(fixtureSetupApi, store.value, deployment, policy, OWNER)).rejects.toThrow();
    expect(sent).toHaveLength(1);
    expect(store.stored.get(`${OWNER}:${rawPolicy.id}`)).toEqual(proof);
  });
});
