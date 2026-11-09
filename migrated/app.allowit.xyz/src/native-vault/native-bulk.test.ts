import {afterEach, expect, it, vi} from 'vitest';
import {revokePolicyBatch} from '../policy/revoke-policy-batch';
import {createTxRecovery} from '../wallet/tx-recovery';
import type {AllocationIntent} from '../wallet/allocation';
import type {MicroPolicy} from '../micro/micro-contracts';

afterEach(() => vi.unstubAllGlobals());
const policy = {id: 'bound', title: 'Bound source', revision: 1, status: 'draft', network: 'solana:devnet', language: 'allowit-rust-v1', nativeExecution: {policyId: 'aa'.repeat(32), revocationStarted: false}} as MicroPolicy;
const run = (send: Parameters<typeof revokePolicyBatch>[0]['send'], sign = vi.fn(), progress = vi.fn()) => {
  vi.stubGlobal('sessionStorage', undefined);
  return {sign, progress, done: revokePolicyBatch({owner: 'owner', policies: [policy], networks: [], isCurrent: () => true, recovery: createTxRecovery(), send, sign, progress})};
};
it('native attachments are not silently recast as legacy allowance revokes', async () => {
  const check = run(async () => ({policies: [policy], intent: {kind: 'revoke', network: 'solana:devnet', owner: 'owner'} as AllocationIntent}));
  await expect(check.done).rejects.toThrow(/No owner allowance signature/);
  expect(check.sign).not.toHaveBeenCalled();
});
