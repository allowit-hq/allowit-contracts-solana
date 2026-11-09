import type {SignedSetup} from './paysh-wallet-intent';

/** Signed setup proofs, durable before submit. Keyed by owner and policy. No Solana SDK is needed to read them. */
export interface SetupJournal {
  read(owner: string, policyId: string): Promise<SignedSetup | null>;
  write(proof: SignedSetup): Promise<void>;
  clear(owner: string, policyId: string): Promise<void>;
}
/** A journal that can list one owner's proofs, for recovery of setups no listed policy names. */
export interface OwnerSetupJournal extends SetupJournal {
  entries(owner: string): Promise<SignedSetup[]>;
}

export class IndexedSetupJournal implements OwnerSetupJournal {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('allowit-paysh-v1', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('setup');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  private async run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('setup', mode, {durability: 'strict'});
        const request = op(tx.objectStore('setup'));
        let result: T | null = null;
        request.onsuccess = () => {result = (request.result as T) ?? null;};
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('The setup journal could not be saved.'));
      });
    } finally {db.close();}
  }
  read(owner: string, policyId: string) {return this.run<SignedSetup>('readonly', s => s.get(`${owner}:${policyId}`));}
  async write(proof: SignedSetup) {await this.run('readwrite', s => s.put(proof, `${proof.owner}:${proof.policyId}`));}
  async clear(owner: string, policyId: string) {await this.run('readwrite', s => s.delete(`${owner}:${policyId}`));}
  /** Every proof under `${owner}:`. Entries whose own owner field differs are not returned. */
  async entries(owner: string) {
    const all = (await this.run<unknown[]>('readonly', s => s.getAll(IDBKeyRange.bound(`${owner}:`, `${owner}:￿`)))) ?? [];
    return all.filter((p): p is SignedSetup => !!p && typeof p === 'object' && (p as SignedSetup).owner === owner && typeof (p as SignedSetup).policyId === 'string' && typeof (p as SignedSetup).signedBytes === 'string');
  }
}
