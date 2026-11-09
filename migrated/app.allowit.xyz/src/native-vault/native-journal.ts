import type {Operation, PolicyOptions, Prepared} from './native-contracts';
export interface PreparationPointer {id: string; prepared?: Prepared; identity?: string; options?: Pick<PolicyOptions, 'additionalOwnerOperation' | 'retryPreparationOf'>}
export interface NativeJournal {
  read<T = Operation>(name: string): Promise<T | null>;
  write(name: string, value: Operation | PreparationPointer): Promise<unknown>;
  clear(name: string): Promise<unknown>;
  entries(prefix?: string): Promise<Operation[]>;
  locked<T>(run: () => Promise<T>): Promise<T>;
}
/** ABI-v2 proofs live in their own database. The ABI-v1 `allowit-native-v1` store is never opened or rewritten here. */
export const JOURNAL_DATABASE = 'allowit-native-v2';
/** Commit completion precedes every submit. */
export class BrowserJournal implements NativeJournal {
  constructor(readonly namespace: string, readonly database = JOURNAL_DATABASE, readonly lockScope = namespace) {}
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const opened = indexedDB.open(this.database, 1);
      opened.onupgradeneeded = () => opened.result.createObjectStore('operations');
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () => reject(opened.error);
    });
  }
  private async operation<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T | null> {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('operations', mode, {durability: 'strict'});
        const request = run(tx.objectStore('operations'));
        let result: T | null = null;
        request.onsuccess = () => {result = request.result;};
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('Journal commit aborted'));
      });
    } finally {db.close();}
  }
  read<T = Operation>(name: string) {return this.operation<T>('readonly', store => store.get(this.namespace + ':' + name)).then(v => v ?? null);}
  write(name: string, value: Operation | PreparationPointer) {return this.operation('readwrite', store => store.put(value, this.namespace + ':' + name));}
  clear(name: string) {return this.operation('readwrite', store => store.delete(this.namespace + ':' + name));}
  async entries(prefix = 'request-'): Promise<Operation[]> {
    return await this.operation<Operation[]>('readonly', store => store.getAll(IDBKeyRange.bound(this.namespace + ':' + prefix, this.namespace + ':' + prefix + '￿'))) ?? [];
  }
  async locked<T>(run: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error('This browser cannot safely serialize policy operations');
    return navigator.locks.request('allowit-native-v2:' + this.lockScope, {mode: 'exclusive'}, run);
  }
}
