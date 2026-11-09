import {describe, expect, it} from 'vitest';
import {Buffer} from 'buffer';
import {Transaction} from '@solana/web3.js';
import release from '../../tests/fixtures/native-release.json' with {type: 'json'};
import {binding, config, policy, prepared, walletSign, x402Service} from '../../tests/fixtures/devnet-vault';
import {admission, fmt, parseAmount, parseConfig, parseRelease, pendingOf, vaultPhase, type Retained} from './native-vault';
import {signedProof} from './native-wallet-intent';
import type {Operation, OwnerMethod, PublicOperation, VaultState} from './native-contracts';

const state = (over: Partial<VaultState> = {}): VaultState => ({
  ...binding, abi: 2, sourceBundle: policy.sourceBundle, policyArtifact: policy.policyArtifact, vaultId: policy.id, dailyLimit: '5000000', actionLimit: '1000000',
  spent: '0', spentDay: '0', nonce: '0', revision: '0', instanceSlot: '19', approved: true, balance: '12500000', ...over,
});
function record(method: OwnerMethod, id: string, status: Operation['status'], input: Parameters<typeof prepared>[1] = {}, at = '2026-10-09T10:00:00.000Z'): Operation {
  const p = prepared(method, {...input, id});
  return {...signedProof(p, walletSign(Transaction.from(Buffer.from(p.unsignedTransaction, 'base64'))), 'solana:devnet', new Date(at)), status};
}
const server = (id: string, method: string, status: string, extra: Partial<PublicOperation> = {}): PublicOperation => ({id, method, status, signature: 'sig-' + id, transactionUrl: `https://explorer.solana.com/tx/sig-${id}?cluster=devnet`, ...extra});

describe('vault phase', () => {
  const deployed = record('deploy', 'setup', 'settled', {amount: '10'});
  const observed = (r: Operation, finalizedSlot: number | string, extra: Partial<PublicOperation> = {}): PublicOperation =>
    server(r.id, r.method, 'settled', {signature: r.signature, instanceSlot: r.instanceSlot, finalizedSlot, ...extra});
  it('never reads a missing vault as closed without a settled close', () => {
    expect(vaultPhase(null, [deployed], [])).toEqual({phase: 'missing', closedBy: null});
    expect(vaultPhase(null, [deployed, record('close', 'close-a', 'uncertain', {instanceSlot: 19})], []).phase).toBe('missing');
    expect(vaultPhase(null, [deployed, record('close', 'close-a', 'failed', {instanceSlot: 19})], []).phase).toBe('missing');
    const closed = record('close', 'close-a', 'settled', {instanceSlot: 19});
    expect(vaultPhase(null, [deployed, closed], [observed(deployed, 19), observed(closed, 20)])).toEqual({phase: 'closed', closedBy: 'close-a'});
    // The backend's finalized observation counts even when this device's copy is still uncertain.
    expect(vaultPhase(null, [deployed, {...closed, status: 'uncertain'}], [observed(deployed, 19), observed(closed, 20)]).phase).toBe('closed');
  });
  it('requires finalized receipt provenance and a valid matching close instance', () => {
    const closed = record('close', 'close-a', 'uncertain', {instanceSlot: 19});
    const closeObservation = observed(closed, 25);
    for (const extra of [{method: 'deploy'}, {instanceSlot: 18}, {status: 'uncertain'}, {status: 'failed'}]) {
      expect(vaultPhase(null, [deployed, closed], [observed(deployed, 19), {...closeObservation, ...extra}]).phase).not.toBe('closed');
    }
    for (const finalizedSlot of [undefined, null, -1, 19, 18, 19.5, Number.MAX_SAFE_INTEGER + 1, 'garbage', '019', '18446744073709551616']) {
      expect(vaultPhase(null, [deployed, closed], [observed(deployed, 19), {...closeObservation, finalizedSlot}]).phase).toBe('missing');
    }
    for (const instanceSlot of [undefined, null, -1, 19.5, 'garbage', '019']) {
      expect(vaultPhase(null, [], [observed(deployed, 19), {...closeObservation, instanceSlot} as PublicOperation]).phase).toBe('missing');
    }
    // Imported/local metadata does not substitute for the backend's verified receipt.
    expect(vaultPhase(null, [{...deployed, finalizedSlot: 19}, {...closed, status: 'settled', finalizedSlot: 25}], []).phase).toBe('missing');
    expect(vaultPhase(null, [deployed, closed], [observed(deployed, '19'), observed(closed, '25')]).phase).toBe('closed');
  });
});

describe('pending owner operations and admission', () => {
  const retained = (method: OwnerMethod, id: string, status: Retained['status'], extra: Partial<Retained> = {}): Retained => ({id, method, amount: null, instanceSlot: null, status, absent: false, ...extra});
  it('blocks every new signature but revocation while a signed proof is unconfirmed', () => {
    const p = pendingOf([record('fund', 'fund-a', 'submitted', {amount: '2'})], [], state());
    expect(p).toMatchObject([{id: 'fund-a', method: 'fund', amount: '2', signed: true, expired: false}]);
    for (const m of ['deploy', 'fund', 'withdraw', 'close'] as const) expect(admission(m, p, []).ok, m).toBe(false);
    expect(admission('revoke', p, [])).toEqual({ok: true, mode: 'new'});
  });
});

describe('public configuration', () => {
  const live = {network: 'solana:devnet', rpcUrl: 'https://api.devnet.solana.com', mint: config.mint, executor: config.executor, authority: config.authority, deployment: config.deployment, x402Services: [x402Service]};
  it('rejects changed source bytes, custody artifacts, genesis, RPC and non-Devnet metadata', () => {
    for (const changed of [
      {...release, sources: {...release.sources, 'policy.rs': release.sources['policy.rs'] + '\n'}},
      {...release, artifacts: release.artifacts.map(a => a.name === 'allowit_vault.so' ? {...a, sha256: '00'.repeat(32)} : a)},
      {...release, artifacts: release.artifacts.slice(0, 1)},
      {...release, contractRevision: '00'.repeat(20)},
    ]) expect(parseRelease({profile: 'solana-native-v2', network: 'solana:devnet', release: changed})).toBeNull();
    expect(parseRelease({profile: 'solana-native-v2', network: 'solana:testnet', release})).toBeNull();
    expect(parseConfig({...live, genesis: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'}, release, 'solana:devnet')).toBeNull();
    expect(parseConfig({...live, rpcUrl: 'https://api.mainnet-beta.solana.com'}, release, 'solana:devnet')).toBeNull();
  });
});

describe('exact amounts', () => {
  it('parses and formats base units without floating point', () => {
    expect(parseAmount('0,1')).toEqual({amount: 100_000n, error: null});
    expect(parseAmount('18446744073709.551615')).toEqual({amount: 0xffffffffffffffffn, error: null});
    expect(parseAmount('18446744073709.551616').error).toMatch(/too large/);
    expect(parseAmount('1.0000001').error).toMatch(/six decimal/);
    expect(parseAmount('2', 1_000_000n, 'The vault holds 1.00 test tokens.').error).toBe('The vault holds 1.00 test tokens.');
    expect(parseAmount('1e3').error).toMatch(/digits/);
    expect(fmt(12_500_000n)).toBe('12.50');
    expect(fmt('1')).toBe('0.000001');
  });
});
