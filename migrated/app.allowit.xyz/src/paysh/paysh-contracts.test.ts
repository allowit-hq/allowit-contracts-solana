import {describe, expect, it} from 'vitest';
import {deliveryWord, hasFinalizedPayment, NATIVE_TESTNET_FIXTURE, paymentWord, parseOperation, u64} from './paysh-contracts';
const receipt = {signature: 'a', requestHash: 'ab'.repeat(32), challengeHash: 'cd'.repeat(32), invocationIndex: 0, finalizedSlot: 5, action: {type: 'swap', amountInLamports: 1000, minOutUsdc: 990}};

describe('PaySH response adapters', () => {
  it('accepts exact u64 values only', () => {
    expect(u64('18446744073709551615', 'x')).toBe('18446744073709551615');
    expect(() => u64('18446744073709551616', 'x')).toThrow();
    expect(() => u64(2 ** 53, 'x')).toThrow();
    expect(() => u64(-1, 'x')).toThrow();
    expect(() => u64('01', 'x')).toThrow();
    expect(() => u64(1.5, 'x')).toThrow();
  });

  it('keeps consumed-authorization and owner-unknown outcomes unresolved without a verified payment receipt', () => {
    for (const status of ['settlement_unknown', 'unknown', 'confirmed', 'delivering', 'delivered']) {
      for (const receipts of [[], [receipt]]) {
        const op = parseOperation({operationId: 'op', status, signatures: ['unlocated'], receipts, response: null}, 'op');
        expect(hasFinalizedPayment(op)).toBe(false);
        expect(paymentWord(op)).toContain('Unresolved');
        expect(paymentWord(op)).not.toContain('Finalized');
        expect(deliveryWord(op)).not.toContain('payment is finalized');
        if (status === 'settlement_unknown' || status === 'unknown') expect(deliveryWord(op)).toContain('Do not retry or create a replacement payment');
      }
    }
    const op = parseOperation({operationId: 'op', status: 'unknown', signatures: ['a'], receipts: [{...receipt, action: {type: 'pay', amountUsdc: 1000}}], response: null}, 'op');
    expect(hasFinalizedPayment(op)).toBe(true);
    expect(paymentWord(op)).toBe('Finalized on Testnet.');
    expect(deliveryWord(op)).toContain('payment is finalized');
    expect(deliveryWord(op)).not.toBe('Delivered.');
  });

  // The isolated cooperating backend's real `GET /api/paysh/catalog` reply.
  const fixture = {description: 'Native payment fixture only. Google Air Quality is Mainnet-only and unavailable on Testnet.', id: NATIVE_TESTNET_FIXTURE, name: 'PaySH native Testnet compatibility', network: 'solana:testnet', priceUsdcUnits: 1000};
  const cooperating = {profile: 'cooperating-v1', reputation: null, services: [fixture]};
  const AIR = 'solana-foundation/google/airquality';
});
