import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {IndexedSetupJournal} from '../paysh/setup-journal';
import {browserBindings} from './setup-bindings';
import type {LegacyRecord} from './legacy-setup';

const LEGACY_PREFIX = 'allowit.paysh.v2:';
function hasLegacyDrafts(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) if (localStorage.key(i)?.startsWith(LEGACY_PREFIX)) return true;
  } catch {
    /* Storage unavailable: nothing to recover from it. */
  }
  return false;
}

/**
 * Earlier setups this owner has on this device that no listed policy accounts for. The draft parser needs the Solana
 * SDK, so it loads only when this device holds an earlier draft or a signed proof for this owner.
 */
export function useLegacySetups(owner: string, accounted: ReadonlySet<string>, ready: boolean) {
  const journal = useMemo(() => new IndexedSetupJournal(), []);
  const [state, setState] = useState<{owner: string; records: LegacyRecord[]; error: string | null} | null>(null);
  const [version, setVersion] = useState(0);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const key = [...accounted].sort().join('|');
  useEffect(() => {
    if (!owner || !ready) {setState(null); return;}
    let live = true;
    const apply = (records: LegacyRecord[], error: string | null) => {if (live && ownerRef.current === owner) setState({owner, records, error});};
    void (async () => {
      let proofs: Awaited<ReturnType<IndexedSetupJournal['entries']>> = [];
      let error: string | null = null;
      try {
        proofs = (await journal.entries(owner)).filter(p => !browserBindings.read(owner, p.policyId));
      } catch (e) {
        error = `The signed setup journal could not be read: ${e instanceof Error ? e.message : 'unknown error'}`;
      }
      if (!proofs.length && !hasLegacyDrafts()) return apply([], error);
      const {legacyRecords, readLegacySaved} = await import('./legacy-setup');
      apply(legacyRecords(owner, readLegacySaved(owner), proofs, accounted), error);
    })().catch(e => apply([], `Earlier setups could not be read: ${e instanceof Error ? e.message : 'unknown error'}`));
    return () => {live = false;};
  }, [owner, key, version, journal, ready]);
  const current = ready && state && state.owner === owner ? state : null;
  return {records: current?.records ?? [], error: current?.error ?? null, journal, reload: useCallback(() => setVersion(v => v + 1), [])};
}
