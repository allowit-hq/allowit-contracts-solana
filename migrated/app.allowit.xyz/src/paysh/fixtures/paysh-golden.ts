/**
 * The actual Rust native SDK owner setup from the public Solana Testnet run, as `paysh/prepare` returns it. The
 * setup, signed bytes and deployment are public artifacts (see `paysh-testnet-setup.json`); no keys. On-chain policy
 * fields come from its Config. `originalIntent` and `semanticQuestion` are backend-only and are test values here.
 */
import golden from './paysh-testnet-setup.json';
import {parsePrepared, type PayshDeployment, type PayshPolicy} from '../paysh-contracts';

export const GOLDEN_REQUEST_ID = 'testnet-setup-1';
export const goldenDeployment: PayshDeployment = golden.deployment;
export const goldenSetup = golden.setup;
export const goldenSignedBytes = golden.signedBytes;
export const goldenRawPolicy = {
  id: '5f11ee731388f3ab430f455cd59b2d84e49e0c5ce66e52e8800d16f46cec782d', owner: golden.setup.owner, originalIntent: 'Let my agent buy air quality lookups.', network: 'solana:testnet', serviceId: 'solana-foundation/google/airquality',
  policyAddress: golden.setup.policy, moduleDigest: golden.deployment.moduleDigest, allocationLamports: 5_000_000, maxPaymentUsdc: 50_000, maxSwapLamports: 3_000_000, maxServiceFeeLamports: 1000, preferenceThresholdBps: 9000,
  semanticQuestion: 'Is this exact air quality lookup what the owner asked for?',
};
export const goldenPolicy: PayshPolicy = {...goldenRawPolicy, network: 'solana:testnet', allocationLamports: '5000000', maxPaymentUsdc: '50000', maxSwapLamports: '3000000', maxServiceFeeLamports: '1000'};
/** The backend `paysh/prepare` reply around the SDK setup, optionally with edited setup fields. */
export function goldenJson(edit: Partial<typeof golden.setup> = {}) {
  const s = {...golden.setup, ...edit};
  return {policy: goldenRawPolicy, requestId: GOLDEN_REQUEST_ID, unsignedTransaction: s.unsignedTransaction, message: s.message, expectedAccounts: {owner: s.owner, policy: s.policy, solVault: s.solVault}, configBytes: s.configBytes, allocationLamports: s.allocationLamports};
}
export const goldenPrepared = (edit: Partial<typeof golden.setup> = {}) => parsePrepared(goldenJson(edit));
