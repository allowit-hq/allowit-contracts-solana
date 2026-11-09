import type {Session} from '../contracts';
import {NativePolicyLifecycle} from './native-api';
import {BoundNativeAPI, vaultConfig, type NativeAttachment} from './native-bound';
import type {NativeConfig} from './native-contracts';
import {BrowserJournal} from './native-journal';
import {storageKey} from './native-vault';
import {signNativeOwner} from './native-wallet';

/** Single-card and bulk owner actions retain proofs in the same immutable journal. */
export function createNativeOwnerContext(shared: NativeConfig, attachment: NativeAttachment, session: Session, current: () => boolean) {
  const config = vaultConfig(shared, attachment);
  const api = new BoundNativeAPI(config, attachment, session, current);
  const journal = new BrowserJournal([storageKey(config), session.address, attachment.policy.id, attachment.executionBinding.policyId, attachment.executionBinding.revision, attachment.executionBinding.sourceHash].join(':'), undefined, [storageKey(config), session.address, attachment.policy.id].join(':'));
  const lifecycle = new NativePolicyLifecycle(api, journal, async (transaction, role) => {
    if (role !== 'owner') throw new Error('Only the policy owner may sign a vault operation.');
    return signNativeOwner(session.address, transaction, current);
  });
  return {current, config, attachment, api, journal, lifecycle};
}
export type NativeOwnerContext = ReturnType<typeof createNativeOwnerContext>;
