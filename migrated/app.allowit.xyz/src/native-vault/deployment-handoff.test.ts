import {describe, expect, it, vi} from 'vitest';
import {config, owner, policy} from '../../tests/fixtures/devnet-vault';
import type {Session} from '../contracts';
import {ApiError} from '../api';
import {NativePolicyAPI} from './native-api';
import {checkDeploymentContext, checkDeploymentRequest, checkKnownDeployment, checkUnsignedDeployment, CLI_NEW_VAULT_RETIRED, deploymentJournal, DEPLOYMENT_FRAGMENT, DEPLOYMENT_NETWORK, deploymentIntentDigest, parseDeploymentHandoff, verifyDeploymentReview, verifyDeploymentRetry, type DeploymentHandoff} from './deployment-handoff';
import {BrowserJournal, type NativeJournal} from './native-journal';

const session: Session = {address: owner, network: 'solana', expiresAt: '2099-01-01T00:00:00Z'};
export function handoffFixture(): DeploymentHandoff {
  const value: Omit<DeploymentHandoff, 'intentDigest'> = {version: 1, profile: 'allowit-deploy-v1', requestId: 'cli-deploy-0001', network: DEPLOYMENT_NETWORK,
    owner, amount: '1', policy, deployment: config.deployment, wallet: {mint: config.mint, executor: config.executor, authority: config.authority}};
  return {...value, intentDigest: deploymentIntentDigest(value)};
}
const fragment = (value: unknown) => DEPLOYMENT_FRAGMENT + Buffer.from(JSON.stringify(value)).toString('base64url');

describe('CLI deployment browser handoff', () => {
  it('rejects secret or unknown fields at every public boundary', () => {
    for (const value of [
      {...handoffFixture(), agentKey: 'private-material'},
      {...handoffFixture(), wallet: {...handoffFixture().wallet, seed: 'private-material'}},
      {...handoffFixture(), policy: {...policy, privateKey: 'private-material'}},
      {...handoffFixture(), deployment: {...config.deployment, secretShare: 'private-material'}},
    ]) expect(() => parseDeploymentHandoff(fragment(value))).toThrow();
  });
  it('binds all intended amounts, identities, source, programs and wallet public keys', () => {
    const original = handoffFixture();
    const changes = [
      {...original, requestId: 'different-request'}, {...original, amount: '2'},
      {...original, owner: config.executor}, {...original, policy: {...policy, id: 'ab'.repeat(32)}},
      {...original, policy: {...policy, rust: policy.rust + '\n'}},
      {...original, deployment: {...config.deployment, custody: config.executor}},
      {...original, wallet: {...original.wallet, executor: config.authority}},
      {...original, wallet: {...original.wallet, mint: config.authority}},
      {...original, wallet: {...original.wallet, authority: config.executor}},
    ];
    for (const changed of changes) expect(() => parseDeploymentHandoff(fragment(changed))).toThrow('intent changed');
  });
  it('requires the connected owner and exact configured network, programs and wallet roles', () => {
    const value = handoffFixture();
    for (const changed of [null, {...session, address: config.executor}, {...session, network: 'tempo' as const}]) {
      expect(() => checkDeploymentContext(value, changed, 'solana:devnet', config)).toThrow('Sign in');
    }
    expect(() => checkDeploymentContext(value, session, 'local:dev', config)).toThrow('Devnet release');
    expect(() => checkDeploymentContext(value, session, 'solana:devnet', {...config, executor: config.authority})).toThrow('executor or authority');
    expect(() => checkDeploymentContext(value, session, 'solana:devnet', {...config, deployment: {...config.deployment, custody: config.authority}})).toThrow('Devnet release');
  });
  it('continues only a vault the server already holds, never creating a new server-executor vault', async () => {
    const api = new NativePolicyAPI(config);
    const save = vi.spyOn(api, 'save');
    const call = vi.spyOn(api, 'call').mockResolvedValueOnce({policies: [{id: 'ab'.repeat(32)}, policy]});
    await expect(checkKnownDeployment(handoffFixture(), api)).resolves.toBeUndefined();
    expect(call).toHaveBeenCalledWith('native/policies');
    // A link for an unknown vault stops before consent: no save, preparation or signature.
    call.mockResolvedValueOnce({policies: [{id: 'ab'.repeat(32)}, null, 'not-a-policy']});
    await expect(checkKnownDeployment(handoffFixture(), api)).rejects.toThrow(CLI_NEW_VAULT_RETIRED);
    call.mockResolvedValueOnce({});
    await expect(checkKnownDeployment(handoffFixture(), api)).rejects.toThrow('invalid policy list');
    expect(call.mock.calls.map(([path]) => path)).toEqual(['native/policies', 'native/policies', 'native/policies']);
    expect(save).not.toHaveBeenCalled();
    expect(CLI_NEW_VAULT_RETIRED).toContain("agent's own key");
    expect(CLI_NEW_VAULT_RETIRED).toContain('Nothing was signed.');
  });
  it('rejects a changed validated source before release checks or preparation', async () => {
    const api = new NativePolicyAPI(config);
    const verify = vi.spyOn(api, 'verifyRelease');
    await expect(verifyDeploymentReview(handoffFixture(), session, 'solana:devnet', api, async () => ({...policy, rust: 'changed'}))).rejects.toThrow('different policy');
    expect(verify).not.toHaveBeenCalled();
  });
  it('rejects wallet substitution before any server validation call', async () => {
    const api = new NativePolicyAPI({...config, executor: config.authority});
    const validate = vi.fn(async () => policy);
    await expect(verifyDeploymentReview(handoffFixture(), session, 'solana:devnet', api, validate)).rejects.toThrow('executor or authority');
    expect(validate).not.toHaveBeenCalled();
  });
  it('does not adopt another CLI request id from an unsigned preparation', async () => {
    for (const prefix of ['preparing-deploy', 'prepared-deploy']) {
      const read = vi.fn(async (name: string) => name === prefix ? {id: 'original-other-request'} : null);
      const journal = {read} as unknown as NativeJournal;
      await expect(checkDeploymentRequest(journal, 'new-request')).rejects.toThrow('original-other-request');
    }
  });
  it('checks the request id inside the same lifecycle lock before preparing or signing', async () => {
    const events: string[] = [];
    const journal = {read: vi.fn(async () => {events.push('read'); return null;}), write: vi.fn(), clear: vi.fn(), entries: vi.fn(), locked: async <T>(run: () => Promise<T>) => {events.push('lock'); const result = await run(); events.push('unlock'); return result;}} as unknown as NativeJournal;
    await deploymentJournal(journal, 'cli-request').locked(async () => {events.push('prepare');});
    expect(events).toEqual(['lock', 'read', 'read', 'prepare', 'unlock']);
  });
  it('serializes source-specific journals with the same immutable vault identity', async () => {
    const request = vi.fn(async (_name: string, _options: unknown, run: () => Promise<void>) => run());
    vi.stubGlobal('navigator', {locks: {request}});
    try {
      await new BrowserJournal('vault:source-revision', undefined, 'exact-vault').locked(async () => {});
      await new BrowserJournal('vault:cli-deploy', undefined, 'exact-vault').locked(async () => {});
      expect(request.mock.calls.map(([name]) => name)).toEqual(['allowit-native-v2:exact-vault', 'allowit-native-v2:exact-vault']);
    } finally {vi.unstubAllGlobals();}
  });
  it('requires authoritative unsigned expiry or the already approved identical successor', async () => {
    const handoff = {...handoffFixture(), retryPreparationOf: 'expired-original-0001'};
    const api = new NativePolicyAPI(config);
    const base = {id: handoff.retryPreparationOf, method: 'deploy', policyId: policy.id, blockhashExpired: true};
    for (const value of [{...base, retryPreparationAllowed: true}, {...base, supersededBy: handoff.requestId}]) {
      vi.spyOn(api, 'call').mockResolvedValue({operation: value});
      await expect(verifyDeploymentRetry(handoff, api)).resolves.toBeUndefined();
    }
    for (const value of [{...base, blockhashExpired: false, retryPreparationAllowed: true}, {...base, signature: 'signed-proof', retryPreparationAllowed: true}, {...base, supersededBy: 'another-successor'}, {...base, method: 'fund', retryPreparationAllowed: true}]) {
      vi.spyOn(api, 'call').mockResolvedValue({operation: value});
      await expect(verifyDeploymentRetry(handoff, api)).rejects.toThrow('not been verified expired');
    }
  });
  it('permits only the named unsigned predecessor and refuses replacement of a signed proof', async () => {
    const original = 'expired-original-0001';
    const journal = {read: vi.fn(async (name: string) => name === 'prepared-deploy' ? {id: original} : null)} as unknown as NativeJournal;
    await expect(checkDeploymentRequest(journal, 'new-request', original)).resolves.toBeUndefined();
    vi.spyOn(journal, 'read').mockResolvedValue({id: original, signedBytes: 'original-signed-proof'} as never);
    await expect(checkDeploymentRequest(journal, 'new-request', original)).rejects.toThrow('signed proof');
  });
  it('checks superseded links without a local pointer and permits only authoritative absence', async () => {
    const handoff = handoffFixture(), api = new NativePolicyAPI(config);
    vi.spyOn(api, 'call').mockResolvedValue({operation: {id: handoff.requestId, supersededBy: 'approved-successor'}});
    await expect(checkUnsignedDeployment(handoff, api)).rejects.toThrow('approved-successor');
    vi.spyOn(api, 'call').mockRejectedValue(new ApiError('No operation', 404));
    await expect(checkUnsignedDeployment(handoff, api)).resolves.toBeUndefined();
    vi.spyOn(api, 'call').mockRejectedValue(new ApiError('Unavailable', 503));
    await expect(checkUnsignedDeployment(handoff, api)).rejects.toThrow('Unavailable');
  });
});
