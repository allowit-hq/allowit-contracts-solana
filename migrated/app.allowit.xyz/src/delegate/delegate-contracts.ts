/** Owner-session views. Integer token units are always decimal strings. */
export type DelegateNetwork = 'solana:mainnet' | 'solana:testnet' | 'solana:devnet' | 'solana:localnet';
export interface DelegateService {
  id: string;
  name?: string;
  action: string;
  method: string;
  url: string;
  maxAmountUnits: string | null;
  amountLimit?: 'approved-grant';
  providerId?: string;
  providerName?: string;
  category?: string;
  sourceUrl?: string;
  sourceSha256?: string;
  urlTemplate?: boolean;
  input?: {
    format: 'path-query-body';
    pathParameters?: unknown;
    queryParameters?: unknown;
    bodySchema?: unknown;
    bodyRequired?: boolean;
    bodyContentTypes?: string[];
  };
}
export interface DelegateCatalogProvider {
  id: string;
  name: string;
  category?: string;
  endpointCount: number;
  availableEndpointCount: number;
  reason?: string;
}
export interface DelegateConfig {
  ready: boolean;
  reason?: string;
  network: string;
  displayNetwork: DelegateNetwork;
  genesisHash: string;
  mint: string;
  decimals: number;
  delegate: string;
  tokenProgram: string;
  setupFeePayer?: string | null;
  recoveryAvailable?: boolean;
  services?: DelegateService[];
  catalogProviders?: DelegateCatalogProvider[];
}
export interface DelegateBudget {
  budgetUnits: string;
  remainingUnits: string;
  reservedUnits: string;
  spentUnits: string;
  /** Parent funds not already charged or promised as guaranteed child shares. */
  unallocatedUnits?: string;
}
export interface DelegateChild extends DelegateBudget {
  id: string;
  status: string;
}
export interface DelegateReceipt {
  id: string;
  childId: string;
  status: string;
  amountUnits: string;
  resource?: string;
  signature?: string;
  createdAt?: string;
}
export interface DelegateEvaluation {
  grantId: string;
  contextHash: string;
  context: unknown;
  decision: {outcome: string; prompt?: string; input_key?: string; question?: string; evidence_key?: string};
  status?: 'answered';
  answer?: {
    approved: boolean;
    answeredAt: number;
    evaluationGrantId: string;
    actionHash: string;
    contextHash: string;
    inputKey: string;
  };
  continuation?: DelegateRequestReason | null;
}
export interface DelegateRequestReason {status?: string; code: string; reason: string}
export interface DelegatePendingRequest {
  requestId: string;
  grantId: string;
  actionHash: string;
  amountUnits: string;
  serviceUrl: string;
  evaluations: DelegateEvaluation[];
  status?: 'awaiting_input' | 'answered' | 'closed';
  paymentStatus?: string;
  signed?: boolean;
  reason?: DelegateRequestReason | null;
}
export interface DelegateRequestInbox {
  requests: DelegatePendingRequest[];
  answeredRequests?: DelegatePendingRequest[];
  closedRequests?: DelegatePendingRequest[];
}
export interface DelegateGrant extends DelegateBudget {
  /** Saved chain configuration remains available for revocation during a signer/service outage. */
  config?: DelegateConfig;
  id: string;
  owner: string;
  network: string;
  displayNetwork: DelegateNetwork;
  genesisHash: string;
  mint: string;
  delegate: string;
  sourceAccount: string;
  source: string;
  intent: string;
  sourceHash: string;
  irHash: string;
  /** Exact memo of the immutable, owner-reviewed grant. */
  memo: string;
  commitmentBytesBase64: string;
  commitmentHash: string;
  status: 'draft' | 'prepared' | 'activation_pending' | 'active' | 'revocation_pending' | 'revoked' | 'failed';
  expiresAt: number;
  revision: number;
  parentGrantId: string | null;
  children: DelegateChild[];
  receipts: DelegateReceipt[];
  signature?: string;
  approvalStatus?: 'expired' | 'finalized_failed' | 'unknown';
  approvalRequired?: boolean;
  reason?: string;
  code?: string;
  policyId: string;
  title?: string;
  /** The grant funds and spends from its own owner-owned token account, not the owner's main USDC account. */
  policyAccount?: boolean;
  /** The owner's main USDC account that funded the policy account. */
  fundingAccount?: string;
  /** The policy account is closed and its remaining USDC is back in the main account. */
  returned?: boolean;
}
export interface DelegateSubmissionResult {
  grant: DelegateGrant;
  config?: DelegateConfig;
  pending?: boolean;
  approvalStatus?: 'expired' | 'finalized_failed' | 'unknown';
  approvalRequired?: boolean;
  reason?: string;
  code?: string;
}
export interface DelegatePreparation {
  grantId: string;
  preparationId: string;
  transactionBase64: string;
  memo: string;
  sourceAccount: string;
  mint: string;
  delegate: string;
  budgetUnits: string;
  genesisHash: string;
  lastValidBlockHeight: number;
  feePayer: string;
  /** Fresh readonly signer on the existing commitment Memo; its exact signature is already present. */
  memoSigner?: string | null;
  action: 'approve' | 'revoke';
  supersedes?: {preparationId: string; lastValidBlockHeight: number; expiredAtFinalizedBlockHeight: number; signature?: string};
  /** Policy-account approvals only: the funding account and the refundable rent the fee payer deposits. */
  fundingAccount?: string;
  rentLamports?: string;
}
/** Returns a revoked policy account's remaining USDC to the main account and closes it. */
export interface DelegateReturnPreparation {
  grantId: string;
  preparationId: string;
  action: 'return';
  transactionBase64: string;
  feePayer: string;
  sourceAccount: string;
  fundingAccount: string;
  mint: string;
  genesisHash: string;
  returnUnits: string;
  rentPayer: string;
  memo: string;
  lastValidBlockHeight: number;
}
export interface DelegateProof {
  grantId: string;
  preparationId: string;
  operation: 'approve' | 'revoke';
  signedTransactionBase64: string;
  signature: string;
}

const MAX_UNITS = 18_446_744_073_709_551_615n;
export function delegateUnits(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('The token amount is not an exact integer.');
  const units = BigInt(value);
  if (units > MAX_UNITS) throw new Error('The token amount is too large.');
  return units;
}
export function parseDelegateAmount(value: string): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(value.trim());
  if (!match) throw new Error('Enter a positive USDC amount with at most six decimal places.');
  const units = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? '').padEnd(6, '0'));
  if (units <= 0n || units > MAX_UNITS) throw new Error('Enter a positive USDC amount within the token limit.');
  return units.toString();
}
export function displayDelegateAmount(value: string): string {
  const units = delegateUnits(value);
  const fraction = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${units / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}
