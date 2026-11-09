import {stellarReceiptIdentityMismatch, stellarReceiptSucceeded, stellarReceiptFailed} from '@allowit/engine/stellar/receipt';
import {parseReceipt, receiptFinalized, type OperationReceipt} from '../paysh/paysh-units';
import type {CoordinatorStatus, DeliveryStatus, OwnerRequestReference, PolicyRequest, RequestDelivery, RequestSettlement, SettlementStatus} from '../micro/micro-contracts';

/**
 * Three independent lanes per run: the policy decision, the wallet settlement and the provider delivery. They are not
 * a ladder. Delivery can be reported while payment is unresolved, and expiry or failure can follow finalized receipts.
 * Finality comes from receipts only; a status word alone never makes a payment final, and a reply never implies one.
 */

export const COORDINATOR_STATUSES: readonly CoordinatorStatus[] = ['evaluating', 'awaiting_input', 'owner_approved', 'approved', 'preparing', 'signed', 'submitted', 'confirmed', 'delivering', 'delivered', 'denied', 'failed', 'expired', 'settlement_unknown', 'unknown'];
export const SETTLEMENT_STATUSES: readonly SettlementStatus[] = ['not_started', 'preparing', 'signed', 'submitted', 'pending', 'partially_finalized', 'finalized', 'failed', 'unknown'];
export const DELIVERY_STATUSES: readonly DeliveryStatus[] = ['not_started', 'pending', 'delivered', 'unknown'];
/** Statuses only the coordinator reports. A row with one of these, or with settlement or delivery, uses lanes. */
const COORDINATOR_ONLY = new Set<string>(['owner_approved', 'approved', 'preparing', 'signed', 'confirmed', 'delivering', 'delivered', 'failed', 'expired', 'settlement_unknown', 'unknown']);
export const usesLanes = (r: Pick<PolicyRequest, 'status' | 'settlement' | 'delivery'>) => r.settlement !== undefined || r.delivery !== undefined || COORDINATOR_ONLY.has(r.status);

type Parsed<T> = {ok: true; value: T} | {ok: false; error: string};

export function parseSettlement(value: unknown): Parsed<RequestSettlement> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('settlement');
    const s = value as Record<string, unknown>;
    if (!SETTLEMENT_STATUSES.includes(s.status as SettlementStatus)) throw new Error('settlement.status');
    if (!Array.isArray(s.signatures) || s.signatures.length > 64 || !s.signatures.every(x => typeof x === 'string' && x.length > 0 && x.length <= 100)) throw new Error('settlement.signatures');
    if (!Array.isArray(s.receipts) || s.receipts.length > 64) throw new Error('settlement.receipts');
    const receipts: OperationReceipt[] = s.receipts.map((r, i) => parseReceipt(r, `settlement.receipts[${i}]`));
    return {ok: true, value: {status: s.status as SettlementStatus, signatures: [...(s.signatures as string[])], receipts}};
  } catch (e) {
    return {ok: false, error: e instanceof Error ? e.message : 'settlement'};
  }
}

export function parseDelivery(value: unknown): Parsed<RequestDelivery> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {ok: false, error: 'delivery'};
  const d = value as Record<string, unknown>;
  if (!DELIVERY_STATUSES.includes(d.status as DeliveryStatus)) return {ok: false, error: 'delivery.status'};
  return {ok: true, value: {status: d.status as DeliveryStatus, ...('response' in d ? {response: d.response} : {})}};
}

/** `owner` marks an owner action (sparse red); `bad` a refusal (red); `unresolved` stays ink with the warning text. */
export type LaneTone = 'neutral' | 'done' | 'owner' | 'bad' | 'unresolved';
export interface Lane {label: string; tone: LaneTone}
export interface Lanes {
  decision: Lane;
  payment: Lane;
  /** Only when the server reports a delivery status. */
  delivery: Lane | null;
  receipts: OperationReceipt[];
  /** Signatures without a receipt: listed as unverified, never as final. */
  unverified: string[];
  /** Payment may have been sent: no retry, no replacement payment, no refund claim. */
  unresolved: boolean;
  /** The server sent a settlement or delivery value this client cannot read. Nothing is inferred from it. */
  unreadable: string | null;
}

const UNRESOLVED_PAYMENT: Lane = {label: 'Unresolved', tone: 'unresolved'};

/** Receipt presence with a positive finalized slot, not status words, establishes a finalized step. */
export const finalizedReceipts = (receipts: readonly OperationReceipt[]) => receipts.filter(receiptFinalized);
/** Allowed is said only for phases that exist after the policy allowed the call. */
const AFTER_ALLOW = new Set<string>(['approved', 'preparing', 'signed', 'submitted', 'confirmed', 'delivering', 'delivered', 'settlement_unknown', 'ready', 'settled', 'recorded']);

export function requestLanes(r: Pick<PolicyRequest, 'status' | 'settlement' | 'delivery'> & Partial<Pick<PolicyRequest, 'requestHash' | 'signature'>>): Lanes {
  let unreadable: string | null = null;
  let settlement: RequestSettlement | null = null;
  if (r.settlement !== undefined) {
    const parsed = parseSettlement(r.settlement);
    if (parsed.ok) {if(parsed.value.receipts.some(receipt=>stellarReceiptIdentityMismatch(receipt,r)))unreadable='Stellar receipt identity differs from the original request';else settlement = parsed.value;}
    else unreadable = parsed.error;
  }
  let delivery: RequestDelivery | null = null;
  if (r.delivery !== undefined) {
    const parsed = parseDelivery(r.delivery);
    if (parsed.ok) delivery = parsed.value;
    else unreadable ??= parsed.error;
  }
  const receipts = settlement?.receipts ?? [];
  const finalized = finalizedReceipts(receipts);
  const unverified = (settlement?.signatures ?? []).filter(s => !finalized.some(x => x.signature === s));
  const activity = receipts.length > 0 || (settlement?.signatures.length ?? 0) > 0 || (!!settlement && settlement.status !== 'not_started');

  const decision = ((): Lane => {
    switch (r.status) {
      case 'evaluating': return {label: 'Checking', tone: 'neutral'};
      case 'awaiting_input': return {label: 'Needs your answer', tone: 'owner'};
      case 'owner_approved': return {label: 'Re-checking after your Yes', tone: 'neutral'};
      case 'denied': return {label: 'Denied', tone: 'bad'};
      case 'expired': return activity ? {label: 'Expired after it started', tone: 'neutral'} : {label: 'Expired before start', tone: 'neutral'};
      case 'failed': return activity ? {label: 'Allowed', tone: 'done'} : {label: 'Failed', tone: 'neutral'};
      case 'unknown': return {label: 'Marked unresolved', tone: 'unresolved'};
      // A status this client does not know is not read as a decision.
      default: return AFTER_ALLOW.has(r.status) ? {label: 'Allowed', tone: 'done'} : {label: 'Status not recognized', tone: 'unresolved'};
    }
  })();
  const paidReceipt = finalized.some(x => x.action.type === 'pay' || stellarReceiptSucceeded(x));
  const stellarFailed=finalized.some(x=>stellarReceiptFailed(x));

  const payment = ((): Lane => {
    if (r.status === 'settlement_unknown' || r.status === 'unknown') return UNRESOLVED_PAYMENT;
    if (unreadable && r.settlement !== undefined && !settlement) return {label: 'Status unreadable', tone: 'unresolved'};
    if (!settlement) {
      // No settlement record: say only what the decision implies, and never "not sent" after the coordinator moved on.
      if (r.status === 'evaluating' || r.status === 'awaiting_input' || r.status === 'owner_approved' || r.status === 'denied') return {label: 'Not sent', tone: 'neutral'};
      if (r.status === 'expired' || r.status === 'failed') return {label: 'Not reported', tone: 'neutral'};
      return {label: 'Not reported', tone: 'neutral'};
    }
    switch (settlement.status) {
      case 'not_started': return activity && (receipts.length || settlement.signatures.length) ? UNRESOLVED_PAYMENT : {label: 'Not sent', tone: 'neutral'};
      case 'preparing': return {label: 'Preparing', tone: 'neutral'};
      case 'signed': return {label: 'Signed · not yet finalized', tone: 'neutral'};
      case 'submitted':
      case 'pending': return {label: 'Submitted · waiting for finality', tone: 'neutral'};
      case 'partially_finalized': return finalized.length ? {label: 'Partially finalized', tone: unverified.length ? 'unresolved' : 'neutral'} : UNRESOLVED_PAYMENT;
      // Finalized needs a finalized payment receipt and every signature accounted for; a swap receipt alone is not payment.
      case 'finalized': return paidReceipt && !unverified.length && finalized.length === receipts.length ? {label: 'Finalized', tone: 'done'} : UNRESOLVED_PAYMENT;
      case 'failed': return stellarFailed ? {label:'Failed · transfer not executed',tone:'neutral'} : finalized.length ? {label: 'Failed after finalized steps', tone: 'neutral'} : settlement.signatures.length ? UNRESOLVED_PAYMENT : {label: 'Failed · nothing finalized', tone: 'neutral'};
      case 'unknown': return UNRESOLVED_PAYMENT;
    }
  })();

  const paid = payment.tone === 'done';
  const deliveryLane = !delivery ? null : ((): Lane => {
    switch (delivery.status) {
      case 'not_started': return {label: 'Not started', tone: 'neutral'};
      case 'pending': return {label: 'In progress', tone: 'neutral'};
      // A reply on its own never claims a finalized payment; the payment lane keeps its own state.
      case 'delivered': return paid ? {label: 'Delivered', tone: 'done'} : {label: 'Response received', tone: 'neutral'};
      case 'unknown': return {label: 'Unknown', tone: 'unresolved'};
    }
  })();

  const unresolved = payment.tone === 'unresolved' || deliveryLane?.tone === 'unresolved' || (r.status === 'expired' && unverified.length > 0);
  return {decision, payment, delivery: deliveryLane, receipts, unverified, unresolved, unreadable};
}

/** One label for the row: an owner action first, then a refusal or unresolved payment, then delivery, then payment. */
export function laneSummary(l: Lanes): Lane {
  if (l.decision.tone === 'owner' || l.decision.tone === 'bad') return l.decision;
  if (l.payment.tone === 'unresolved') return {label: 'Payment unresolved', tone: 'unresolved'};
  if (l.decision.tone === 'unresolved') return l.decision;
  if (l.delivery && l.delivery.label !== 'Not started') return {label: l.delivery.label, tone: l.delivery.tone};
  if (l.payment.label !== 'Not reported' && l.payment.label !== 'Not sent') return l.payment;
  return l.decision;
}

/**
 * The owner-decision reference for a row. Only the server's explicit reference for this exact policy and request is
 * used. An owner-wallet row without one keeps its original `micro` reference; a contract-wallet row without one has
 * none, so no inbox item is opened for it.
 */
export function ownerReference(r: Pick<PolicyRequest, 'id' | 'ownerRequest' | 'ownerRef'>, policyId: string, ownerWallet: boolean): OwnerRequestReference | null {
  const explicit = r.ownerRequest ?? r.ownerRef;
  if (explicit !== undefined) {
    if (!explicit || typeof explicit !== 'object') return null;
    const {kind, policyId: p, requestId} = explicit;
    return (kind === 'micro' || kind === 'paysh') && p === policyId && requestId === r.id ? {kind, policyId: p, requestId} : null;
  }
  return ownerWallet ? {kind: 'micro', policyId, requestId: r.id} : null;
}

/* ------------------------------------------------------------------ response preview */

export const RESPONSE_LIMIT = 4000;
/** Bounded plain text. JSON is pretty-printed when it parses; nothing is ever interpreted as markup. */
export function responsePreview(value: unknown): {text: string; truncated: boolean; total: number} {
  let text: string;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      text = parsed !== null && typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : value;
    } catch {
      text = value;
    }
  } else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = 'The response could not be shown as text.';
    }
  }
  const total = text.length;
  return total > RESPONSE_LIMIT ? {text: text.slice(0, RESPONSE_LIMIT), truncated: true, total} : {text, truncated: false, total};
}
