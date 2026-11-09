import {sameServiceIds, serviceIds} from '../paysh/service-allowlist';

export interface ServiceApproval {requestedServiceIds: string[]; rejected: boolean}
export interface ServiceApprovalStore {
  read(owner: string, policyId: string): ServiceApproval | null;
  remember(owner: string, policyId: string, ids: string[], rejected: boolean): void;
}
/** The owner's exact generation choices survive reloads and cannot be replaced by later server replies. */
export function serviceApprovalStore(storage: Pick<Storage, 'getItem' | 'setItem'>): ServiceApprovalStore {
  const key = (owner: string, policyId: string) => `allowit.services.v2:${owner}:${policyId}`;
  const read: ServiceApprovalStore['read'] = (owner, policyId) => {
    const raw = storage.getItem(key(owner, policyId));
    if (raw === null) return null;
    const value = JSON.parse(raw) as ServiceApproval;
    if (typeof value?.rejected !== 'boolean') throw new Error('The saved service selection is unreadable. Nothing can be signed.');
    return {requestedServiceIds: serviceIds(value.requestedServiceIds), rejected: value.rejected};
  };
  return {read, remember(owner, policyId, ids, rejected) {
    if (!owner || !/^[0-9a-f]{64}$/.test(policyId)) throw new Error('The generated policy identity is invalid.');
    const exact = serviceIds(ids), previous = read(owner, policyId);
    storage.setItem(key(owner, policyId), JSON.stringify({requestedServiceIds: previous?.requestedServiceIds ?? exact, rejected: rejected || !!previous?.rejected || !!previous && !sameServiceIds(previous.requestedServiceIds, exact)}));
  }};
}
export const browserServiceApprovals: ServiceApprovalStore = {
  read: (owner, id) => serviceApprovalStore(localStorage).read(owner, id),
  remember: (owner, id, ids, rejected) => serviceApprovalStore(localStorage).remember(owner, id, ids, rejected),
};
