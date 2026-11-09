import {describe, expect, it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import type {TempoOperation} from './tempo-contracts';
import {TEST_CONFIG, TEST_HASH, TEST_POLICY, testPrepared} from './tempo-fixtures';
import {tempoActivity} from './tempo-view';
import TempoPurchaseDetails from './TempoPurchaseDetails';

const config = {...TEST_CONFIG, network: 'tempo:testnet' as const, chainId: 42431, rpcUrl: 'https://rpc.moderato.tempo.xyz'};
const policy = {...TEST_POLICY, network: config.network, chainId: config.chainId};
const purchase = {protocol: 'mpp', method: 'GET', url: 'https://service.example/paid', origin: 'https://service.example',
  requestDigest: `0x${'12'.repeat(32)}`, challengeDigest: `0x${'34'.repeat(32)}`, chainId: config.chainId, token: TEST_POLICY.token,
  recipient: TEST_POLICY.recipient, amountUnits: '250000', memo: `0x${'56'.repeat(32)}`, challengeExpiresAt: 1900000000};
const delivery = {status: 'response_reported', reportedBy: 'executor', transactionHash: TEST_HASH, challengeDigest: purchase.challengeDigest,
  httpStatus: 200, reportedAt: '2026-10-13T01:00:00Z', receipt: {status: 'success', method: 'tempo', reference: TEST_HASH, timestamp: '2026-10-13T01:00:00Z'},
  responseDigest: `0x${'90'.repeat(32)}`, responseBytes: 42};
const payment = (): TempoOperation => ({id: 'mpp-purchase-fixture', policyId: TEST_POLICY.id, method: 'execute', status: 'settled',
  transactionHash: TEST_HASH, blockNumber: 123, transaction: {...testPrepared('fund').transaction, chainId: config.chainId, from: config.executor},
  execution: {amountUnits: purchase.amountUnits, recipient: purchase.recipient}, purchase, delivery});

describe('MPP activity keeps payment proofs separate from executor response reports', () => {
  it('binds the bounded service context to the exact token, charge and operation, with explicit report attribution', () => {
    const row = tempoActivity(policy, config, [], [payment()])[0];
    expect(row).toMatchObject({status: 'Confirmed', amount: '0.25', transactionHash: TEST_HASH, blockNumber: '123',
      purchase: {available: true, url: purchase.url, origin: purchase.origin, response: {status: 'response_reported', httpStatus: 200}}});
    const html = renderToStaticMarkup(<TempoPurchaseDetails purchase={row.purchase!} />);
    expect(html).toContain('Response reported'); expect(html).toContain('HTTP 200'); expect(html).toContain('Executor report');
    expect(html).toContain('Service delivery is not independently verified.'); expect(html).not.toContain('Delivered');
  });

  it.each([
    {transactionHash: `0x${'cd'.repeat(32)}`}, {challengeDigest: `0x${'78'.repeat(32)}`}, {reportedBy: 'service'}, {status: 'delivered'},
    {httpStatus: 99}, {httpStatus: 600}, {httpStatus: 200.5}, {httpStatus: '200'}, {httpStatus: 503}, {reportedAt: 'never'}, {reportedAt: '2026'}, {reportedAt: 0},
    {receipt: undefined}, {receipt: {...delivery.receipt, reference: `0x${'cd'.repeat(32)}`}}, {receipt: {...delivery.receipt, status: 'verified'}},
    {receipt: {...delivery.receipt, method: 'solana'}}, {receipt: {...delivery.receipt, timestamp: 'never'}},
    {responseDigest: 'invalid'}, {responseBytes: -1}, {responseBytes: 65537}, {responseBytes: 2.5}, {responseBytes: '42'},
  ])('does not accept a contradictory or malformed response report (%j)', patch => {
    const row = tempoActivity(policy, config, [], [{...payment(), delivery: {...delivery, ...patch}}])[0];
    expect(row.status).toBe('Confirmed'); expect(row.purchase).toMatchObject({available: true, response: {status: 'report_unavailable', httpStatus: null}});
  });
});
