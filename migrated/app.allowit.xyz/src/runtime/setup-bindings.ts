/**
 * The setup request the owner started for a policy revision, kept on this device before prepare. After prepare it
 * also keeps the public generated draft, including its exact source binding, and the deployment exactly as received,
 * so a reload can check or resend the signed proof without preparing again. It holds no key, signature or capability.
 * No Solana SDK is needed to read it.
 */
export interface SetupBinding {requestId: string; revision: number; draft?: unknown; deployment?: unknown}
export interface BindingStore {read(owner: string, policyId: string): SetupBinding | null; write(owner: string, policyId: string, value: SetupBinding): boolean}
const bindingKey = (owner: string, policyId: string) => `allowit.setup.v1:${owner}:${policyId}`;
export const browserBindings: BindingStore = {
  read: (owner, policyId) => {
    try {
      const v = JSON.parse(localStorage.getItem(bindingKey(owner, policyId)) ?? 'null') as Partial<SetupBinding> | null;
      if (!v || typeof v.requestId !== 'string' || !v.requestId || typeof v.revision !== 'number') return null;
      return {requestId: v.requestId, revision: v.revision, ...(v.draft !== undefined ? {draft: v.draft} : {}), ...(v.deployment !== undefined ? {deployment: v.deployment} : {})};
    } catch {
      return null;
    }
  },
  write: (owner, policyId, value) => {
    try {
      localStorage.setItem(bindingKey(owner, policyId), JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};
