import {delegateUnits, type DelegateEvaluation, type DelegatePendingRequest, type DelegateRequestInbox} from './delegate-contracts';

const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const reason = (value: unknown) => value == null || typeof value === 'object' && typeof (value as {code?: unknown}).code === 'string' && typeof (value as {reason?: unknown}).reason === 'string';

/** History is read-only, but it must retain the same exact owner-answer bindings. */
export function checkedDelegateInbox(value: DelegateRequestInbox) {
  const evaluation = (e: DelegateEvaluation, q: DelegatePendingRequest) => {
    if (!e || typeof e.grantId !== 'string' || !hash(e.contextHash) || e.context === undefined || !e.decision || typeof e.decision.outcome !== 'string' || !reason(e.continuation)) return false;
    const a = e.answer;
    return !a || typeof a.approved === 'boolean' && Number.isSafeInteger(a.answeredAt) && a.answeredAt >= 0 && a.evaluationGrantId === e.grantId && a.actionHash === q.actionHash && a.contextHash === e.contextHash && a.inputKey === e.decision.input_key;
  };
  const groups = (values: DelegatePendingRequest[] | undefined, kind: 'pending' | 'answered' | 'closed') => {
    if (!Array.isArray(values)) throw new Error('The owner questions have incomplete action/context bindings.');
    for (const q of values) {
      if (!q || typeof q.requestId !== 'string' || typeof q.grantId !== 'string' || !hash(q.actionHash) || typeof q.amountUnits !== 'string' || typeof q.serviceUrl !== 'string' || !Array.isArray(q.evaluations) || !q.evaluations.every(e => evaluation(e, q)) || !reason(q.reason)) throw new Error('The owner questions have incomplete action/context bindings.');
      delegateUnits(q.amountUnits);
      if (kind !== 'pending' && (typeof q.signed !== 'boolean' || typeof q.paymentStatus !== 'string' || q.status !== kind)) throw new Error('The saved request has no verified payment status.');
      if (kind === 'answered' && !q.evaluations.every(e => e.answer) || kind !== 'answered' && q.evaluations.some(e => e.answer)) throw new Error('The owner question status does not match its saved answer.');
    }
    return values;
  };
  return {requests: groups(value.requests, 'pending'), answeredRequests: groups(value.answeredRequests ?? [], 'answered'), closedRequests: groups(value.closedRequests ?? [], 'closed')};
}
