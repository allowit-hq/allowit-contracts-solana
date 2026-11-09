import {parseDraft, type PolicyDraft} from '../paysh/paysh-contracts';
import type {SignedSetup} from '../paysh/paysh-wallet-intent';

/**
 * Setups started on the earlier PaySH page live only on this device: the generated draft in localStorage under
 * `allowit.paysh.v2:*` and any signed proof in the original IndexedDB journal. They are read for the signed-in owner
 * only, never migrated into a client-built policy, and never deleted here except an unsigned, never-prepared draft
 * the owner removes explicitly.
 */

export const LEGACY_PREFIX = 'allowit.paysh.v2:';

export interface LegacySaved {storageKey: string; draft: PolicyDraft; requestId: string | null; deployed: boolean}

export interface KeyStore {length: number; key(i: number): string | null; getItem(k: string): string | null; removeItem(k: string): void}

/** This owner's saved drafts. Entries that do not parse cannot be attributed to an owner and are not shown. */
export function readLegacySaved(owner: string, store: KeyStore | null = safeLocalStorage()): LegacySaved[] {
  if (!store || !owner) return [];
  const out: LegacySaved[] = [];
  for (let i = 0; i < store.length; i++) {
    const storageKey = store.key(i);
    if (!storageKey?.startsWith(LEGACY_PREFIX)) continue;
    try {
      const s = JSON.parse(store.getItem(storageKey) ?? 'null') as {response?: unknown; requestId?: unknown; deployed?: unknown} | null;
      if (!s || typeof s.response !== 'object' || !s.response) continue;
      const draft = parseDraft(s.response);
      if (draft.policy.owner !== owner) continue;
      out.push({storageKey, draft, requestId: typeof s.requestId === 'string' && s.requestId ? s.requestId : null, deployed: s.deployed === true});
    } catch {
      /* Unreadable: not attributable to this owner. */
    }
  }
  return out;
}

function safeLocalStorage(): KeyStore | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export interface LegacyRecord {
  /** The generated draft's policy ID, as the proof and the earlier routes use it. */
  policyId: string;
  title: string;
  saved: LegacySaved | null;
  proof: SignedSetup | null;
}

/**
 * One record per earlier setup this owner has on this device that no listed policy accounts for. A listed policy with
 * the same ID, or a policy whose setup bound that ID, recovers it in its own Funding step instead.
 */
export function legacyRecords(owner: string, saved: readonly LegacySaved[], proofs: readonly SignedSetup[], accounted: ReadonlySet<string>): LegacyRecord[] {
  const byId = new Map<string, LegacyRecord>();
  for (const s of saved) {
    if (s.draft.policy.owner !== owner) continue;
    byId.set(s.draft.policy.id, {policyId: s.draft.policy.id, title: s.draft.title, saved: s, proof: null});
  }
  for (const p of proofs) {
    if (p.owner !== owner) continue;
    const r = byId.get(p.policyId);
    if (r) r.proof = p;
    else byId.set(p.policyId, {policyId: p.policyId, title: '', saved: null, proof: p});
  }
  return [...byId.values()].filter(r => !accounted.has(r.policyId) && (r.proof || !r.saved?.deployed));
}
