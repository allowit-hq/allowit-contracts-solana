import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ApiError} from '../api';
import type {AllocationIntent} from '../wallet/allocation';
import type {MicroPolicy} from '../micro/micro-contracts';
import {revokePolicyBatch} from './revoke-policy-batch';
import {allocationKey, createTxRecovery} from '../wallet/tx-recovery';
import {WalletOutcomeUnknown} from '../wallet/wallet';

// Explicitly block storage in every case: recovery must work from memory alone on any supported Node runtime.
const owner = 'OwnerAddress';
const policy = (id: string, status: MicroPolicy['status'] = 'cancelling') => ({id, title: id, revision: 1, status, network: 'solana:devnet', mint: 'mint'}) as MicroPolicy;
const intent = {kind: 'revoke', network: 'solana:devnet', owner} as AllocationIntent;
const networks = [{id: 'solana:devnet' as const, label: 'Devnet', mint: 'mint', allocationEnabled: true}];

function gateway(confirm: (n: number) => unknown) {
  const calls: {path: string; body: any}[] = [];
  let confirms = 0;
  const send = vi.fn(async (path: string, body: any) => {
    calls.push({path, body});
    if (path === 'micro/allocation/cancel') return {policies: [policy(body.id)], intent};
    const result = confirm(++confirms);
    if (result instanceof Error) throw result;
    return {policies: [policy(body.id, 'cancelled')]};
  });
  return {send, calls};
}
const options = (extra: Partial<Parameters<typeof revokePolicyBatch>[0]>) => ({owner, policies: [policy('p1')], networks, isCurrent: () => true, progress: () => {}, ...extra}) as Parameters<typeof revokePolicyBatch>[0];

beforeEach(() => vi.stubGlobal('sessionStorage', undefined));
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('bulk revocation shares single-cancellation recovery', () => {
  it('confirms a pending single cancellation with its signature instead of signing a new revocation', async () => {
    const recovery = createTxRecovery();
    recovery.remember(allocationKey(owner, 'p1', 'cancel'), 'single-signature');
    const sign = vi.fn();
    const {send, calls} = gateway(() => ({}));
    await revokePolicyBatch(options({recovery, sign, send}));
    expect(sign).not.toHaveBeenCalled();
    expect(calls).toEqual([{path: 'micro/allocation/confirm', body: {id: 'p1', revision: 1, signature: 'single-signature'}}]);
    expect(recovery.signature(allocationKey(owner, 'p1', 'cancel'))).toBe('');
  });

  it('keeps a broadcast signature in memory through a non-retryable error and reuses it on retry', async () => {
    const recovery = createTxRecovery();
    const sign = vi.fn(async () => 'bulk-signature');
    const failing = gateway(() => new ApiError('This policy changed in another tab.', 400));
    await expect(revokePolicyBatch(options({recovery, sign, send: failing.send}))).rejects.toThrow('changed in another tab');
    expect(recovery.signature(allocationKey(owner, 'p1', 'cancel'))).toBe('bulk-signature');
    const ok = gateway(() => ({}));
    await revokePolicyBatch(options({recovery, sign, send: ok.send}));
    expect(sign).toHaveBeenCalledTimes(1);
    expect(ok.calls.map(c => c.body.signature)).toEqual(['bulk-signature']);
  });

  it('never signs again after a wallet returned without a signature, for bulk or single recovery', async () => {
    const recovery = createTxRecovery();
    const sign = vi.fn(async () => { throw new WalletOutcomeUnknown(); });
    const {send, calls} = gateway(() => ({}));
    await expect(revokePolicyBatch(options({recovery, sign, send}))).rejects.toThrow('did not return a transaction signature');
    expect(recovery.unknown(allocationKey(owner, 'p1', 'cancel'))).toBe(true);
    await expect(revokePolicyBatch(options({recovery, sign, send}))).rejects.toThrow('may have been sent');
    expect(sign).toHaveBeenCalledTimes(1);
    // The retry asked the gateway, which returned a revoke intent: unresolved, so nothing was signed or confirmed.
    expect(calls.map(c => c.path)).toEqual(['micro/allocation/cancel', 'micro/allocation/cancel']);
    expect(recovery.unknown(allocationKey(owner, 'p1', 'cancel'))).toBe(true);
  });
});
