import {useEffect, useState} from 'react';
import type {MicroController, MicroPolicy} from '../micro/micro-contracts';
import {bindSelectedPolicy, hasNativeAttachment, loadNativeSupport, nativeStatus, sessionOwner} from './native-bound';
import {createNativeOwnerContext} from './native-owner-context';
import {vaultPhase, type VaultPhase} from './native-vault';
import type {StateReply} from './native-api';
import {decimal} from './native-contracts';

/** What a policy card shows for its native vault: the page's status and the USDC left in the vault (initial funding until read). */
export interface NativeVaultView {status: ReturnType<typeof nativeStatus>; phase: VaultPhase; funding: string | null; balance: string | null; hasVault: boolean}

const CHANGED = 'allowit:native-vault-changed';
const NONE: ReadonlyMap<string, NativeVaultView> = new Map();

/**
 * Tells the policy list a native vault changed. The policy page passes its fresh view;
 * without one the list re-reads every vault.
 */
export const nativeVaultChanged = (update?: {policyId: string; view: NativeVaultView}) => window.dispatchEvent(new CustomEvent(CHANGED, {detail: update}));

/** A vault counts as returned only when a finalized, server-verified close covers every deployment and the vault is gone. */
export const fundsReturned = (reply: Pick<StateReply, 'state' | 'operations'>) => vaultPhase(reply.state, [], reply.operations).phase === 'closed';

/** No vault exists and no setup can still create one: every setup attempt failed, or none was signed. */
export const discardable = (view: NativeVaultView) => !view.hasVault && view.phase === 'draft';

/** A card leaves only after its verified close, or when a cancelled draft never got a vault. Empty live vaults remain recoverable. */
export const leavesList = (view: NativeVaultView, cancelled = false) => view.status === 'Funds returned' || (cancelled && discardable(view));

/** The card view of one vault read. */
/** Only a signed operation can still land: an unsigned preparation never creates a vault, so it never holds a card open. */
export const signedOperations = <T extends {signature?: unknown}>(ops: readonly T[]) => ops.filter(op => typeof op.signature === 'string' && op.signature.length > 0);

export const vaultView = (reply: StateReply, funding: string | null): NativeVaultView => ({status: nativeStatus(reply), phase: vaultPhase(reply.state, [], signedOperations(reply.operations)).phase, funding, balance: reply.state ? decimal(reply.state.balance) : null, hasVault: !!reply.state});

const PHASES: readonly VaultPhase[] = ['draft', 'creating', 'active', 'revoked', 'closed', 'missing', 'unknown'];
const STATUSES: readonly string[] = ['Draft', 'Checking vault', 'Ready', 'Revoked', 'Revoke pending', 'Funds returned'];
const cacheKey = (owner: string) => `allowit.native-vaults.${owner}`;
const isView = (v: unknown): v is NativeVaultView => {
  const o = v as Partial<NativeVaultView> | null;
  return !!o && typeof o === 'object' && STATUSES.includes(o.status as string) && PHASES.includes(o.phase as VaultPhase)
    && typeof o.hasVault === 'boolean' && (o.funding === null || typeof o.funding === 'string') && (o.balance === null || typeof o.balance === 'string');
};
/** The last views this browser read for an owner, so the list opens without flashing closed vaults. */
export function parseCachedViews(raw: string | null): Map<string, NativeVaultView> {
  try {
    const entries: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(entries)) return new Map();
    return new Map(entries.filter((e): e is [string, NativeVaultView] => Array.isArray(e) && typeof e[0] === 'string' && isView(e[1])));
  } catch {return new Map();}
}
const cached = (owner: string) => {
  try {return owner ? parseCachedViews(localStorage.getItem(cacheKey(owner))) : new Map<string, NativeVaultView>();} catch {return new Map<string, NativeVaultView>();}
};
const remember = (owner: string, byId: ReadonlyMap<string, NativeVaultView>) => {
  try {if (owner) localStorage.setItem(cacheKey(owner), JSON.stringify([...byId]));} catch { /* Storage is optional. */ }
};

/** Card views by policy id. `read` turns true once this page has read every vault at least once. */
export interface NativeVaults {views: ReadonlyMap<string, NativeVaultView>; read: boolean}

/**
 * Reads every native vault for the policy list, starting from the views this browser last saw.
 * A vault that cannot be read keeps its last known view, or none: it is never hidden on a guess.
 */
export function useNativeVaults(c: Pick<MicroController, 'auth' | 'policies'>): NativeVaults {
  const session = c.auth.session;
  const owner = session ? sessionOwner(session) : '';
  const native: MicroPolicy[] = c.policies.filter(hasNativeAttachment);
  const key = owner + '|' + native.map(p => p.id + ':' + p.revision).join(',');
  const [views, setViews] = useState<{owner: string; byId: ReadonlyMap<string, NativeVaultView>; read: boolean}>(() => ({owner, byId: cached(owner), read: false}));
  const [round, setRound] = useState(0);
  useEffect(() => {if (views.owner !== owner) setViews({owner, byId: cached(owner), read: false});}, [owner]);
  useEffect(() => {
    const changed = (event: Event) => {
      const update = (event as CustomEvent<{policyId: string; view: NativeVaultView} | undefined>).detail;
      if (!update) {setRound(r => r + 1); return;}
      setViews(current => {
        const byId = new Map(current.byId).set(update.policyId, update.view);
        remember(current.owner, byId);
        return {...current, byId};
      });
    };
    window.addEventListener(CHANGED, changed);
    return () => window.removeEventListener(CHANGED, changed);
  }, []);
  useEffect(() => {
    if (!session || !native.length) return;
    let live = true;
    void (async () => {
      const fresh = new Map<string, NativeVaultView>();
      try {
        const support = await loadNativeSupport();
        for (const policy of native) {
          if (!live) return;
          try {
            const attachment = await bindSelectedPolicy(policy, session, support.config);
            const ctx = createNativeOwnerContext(support.config, attachment, session, () => live);
            fresh.set(policy.id, vaultView(await ctx.api.state(attachment.policy, attachment.executionBinding.owner, true), attachment.initialFunding.amount));
          } catch { /* An unreadable vault keeps its last known view. */ }
        }
      } catch { /* Without native support the last known views stay. */ }
      if (!live) return;
      setViews(current => {
        const byId = new Map<string, NativeVaultView>();
        for (const policy of native) {
          const view = fresh.get(policy.id) ?? (current.owner === owner ? current.byId.get(policy.id) : undefined);
          if (view) byId.set(policy.id, view);
        }
        remember(owner, byId);
        return {owner, byId, read: true};
      });
    })();
    return () => {live = false;};
    // `key` covers the session and the native policy set; `round` re-reads after a vault changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, round]);
  return owner && views.owner === owner ? {views: views.byId, read: views.read} : {views: NONE, read: false};
}
