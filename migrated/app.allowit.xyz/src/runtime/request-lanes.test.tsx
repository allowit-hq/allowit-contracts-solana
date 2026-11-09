import {describe, expect, it} from 'vitest';
import type {PolicyRequest} from '../micro/micro-contracts';
import {laneSummary, requestLanes} from './request-lanes';

// Receipt values follow the native OperationReceipt schema; they are test values, not chain responses.
const pay = (signature: string, slot = '9') => ({signature, requestHash: 'ab'.repeat(32), challengeHash: 'cd'.repeat(32), invocationIndex: 1, finalizedSlot: slot, action: {type: 'pay', amountUsdc: '1500000'}});
const swap = (signature: string) => ({signature, requestHash: 'ab'.repeat(32), challengeHash: 'cd'.repeat(32), invocationIndex: 0, finalizedSlot: '8', action: {type: 'swap', amountInLamports: '10000000', minOutUsdc: '1200000'}});
type Row = Pick<PolicyRequest, 'status' | 'settlement' | 'delivery'>;
const row = (status: PolicyRequest['status'], settlement?: unknown, delivery?: unknown): Row => ({status, ...(settlement === undefined ? {} : {settlement: settlement as never}), ...(delivery === undefined ? {} : {delivery: delivery as never})});
const settled = (status: string, signatures: string[] = [], receipts: unknown[] = []) => ({status, signatures, receipts});

describe('coordinator lanes', () => {
  it('takes finality from receipts, never from a status word', () => {
    expect(requestLanes(row('confirmed', settled('finalized', ['s1', 's2'], [swap('s1'), pay('s2')]))).payment).toEqual({label: 'Finalized', tone: 'done'});
    // Finalized status without a receipt, or a signature without one, is unresolved.
    expect(requestLanes(row('confirmed', settled('finalized', ['s1']))).payment.label).toBe('Unresolved');
    const partial = requestLanes(row('confirmed', settled('finalized', ['s1', 's2'], [swap('s1')])));
    expect(partial.payment.label).toBe('Unresolved');
    expect(partial.unverified).toEqual(['s2']);
    expect(partial.unresolved).toBe(true);
    // A receipt without a finalized slot is not final.
    expect(requestLanes(row('confirmed', settled('finalized', ['s1'], [pay('s1', '0')]))).payment.label).toBe('Unresolved');
    // A finalized swap alone is not a finalized payment, whatever the settlement status says.
    expect(requestLanes(row('confirmed', settled('finalized', ['s1'], [swap('s1')]))).payment.label).toBe('Unresolved');
    // Every listed receipt must be finalized.
    expect(requestLanes(row('confirmed', settled('finalized', ['s1', 's2'], [swap('s1'), pay('s2'), pay('s2', '0')]))).payment.label).toBe('Unresolved');
  });

  it('never reads an unknown status as Allowed', () => {
    for (const status of ['queued', 'new', ''] as never[]) {
      const lanes = requestLanes(row(status, settled('not_started')));
      expect(lanes.decision).toEqual({label: 'Status not recognized', tone: 'unresolved'});
      expect(laneSummary(lanes).label).toBe('Status not recognized');
    }
  });

  it('never claims payment finality from a delivered status', () => {
    const lanes = requestLanes(row('delivered', undefined, {status: 'delivered'}));
    expect(lanes.payment.label).toBe('Not reported');
    expect(lanes.delivery).toEqual({label: 'Response received', tone: 'neutral'});
  });
});
