import {withAllowanceSigningLock} from './allowance-coordination';
import {Buffer} from 'buffer';
import {Transaction} from '@solana/web3.js';
import {encodeBase58} from '../wallet/allocation';
import {checkedDelegateTransaction} from './delegate-wallet-intent';
import type {DelegateConfig, DelegateGrant, DelegatePreparation, DelegateProof} from './delegate-contracts';

export interface SavedDelegateProof {preparation: DelegatePreparation; proof: DelegateProof; scope?:{principal:string;policyId:string;revision:number;sourceHash:string;irHash:string;commitmentHash:string}}
const key = (grant: DelegateGrant, action: 'approve' | 'revoke') => `allowit.delegate.proof.v1:${grant.owner}:${grant.network}:${grant.id}:${action}`;
const MAX_SAVED_PROOF_LENGTH = 32_768;
const MAX_LEGACY_PROOF_LENGTH = 4 * 1024 * 1024;
const invalidProof = () => new Error('The saved grant approval is invalid.');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const stringFields = (value: Record<string, unknown>, fields: string[], allowEmpty = false) => fields.every(field => {
  const item = value[field];
  return typeof item === 'string' && (allowEmpty || item.length > 0);
});

/** Keep only the reviewed transaction fields, never the surrounding API response. */
export function projectDelegatePreparation(preparation: DelegatePreparation): DelegatePreparation {
  if (!record(preparation)
    || !stringFields(preparation, ['grantId', 'preparationId', 'transactionBase64', 'memo', 'sourceAccount', 'mint', 'delegate', 'budgetUnits', 'genesisHash', 'feePayer'])
    || (preparation.action !== 'approve' && preparation.action !== 'revoke')
    || !Number.isSafeInteger(preparation.lastValidBlockHeight) || preparation.lastValidBlockHeight <= 0
    || (preparation.memoSigner !== undefined && preparation.memoSigner !== null && typeof preparation.memoSigner !== 'string')
    || (preparation.fundingAccount !== undefined && typeof preparation.fundingAccount !== 'string')
    || (preparation.rentLamports !== undefined && typeof preparation.rentLamports !== 'string')) throw invalidProof();
  const projected: DelegatePreparation = {
    grantId: preparation.grantId, preparationId: preparation.preparationId,
    transactionBase64: preparation.transactionBase64, memo: preparation.memo,
    sourceAccount: preparation.sourceAccount, mint: preparation.mint, delegate: preparation.delegate,
    budgetUnits: preparation.budgetUnits, genesisHash: preparation.genesisHash,
    lastValidBlockHeight: preparation.lastValidBlockHeight, feePayer: preparation.feePayer,
    action: preparation.action,
  };
  if (preparation.memoSigner !== undefined) projected.memoSigner = preparation.memoSigner;
  // A policy-account approval also funds the account; the wallet check needs its source and rent deposit.
  if (preparation.fundingAccount !== undefined) projected.fundingAccount = preparation.fundingAccount;
  if (preparation.rentLamports !== undefined) projected.rentLamports = preparation.rentLamports;
  if (preparation.supersedes !== undefined) {
    const supersedes = preparation.supersedes;
    if (!record(supersedes) || typeof supersedes.preparationId !== 'string' || !supersedes.preparationId
      || !Number.isSafeInteger(supersedes.lastValidBlockHeight) || supersedes.lastValidBlockHeight <= 0
      || !Number.isSafeInteger(supersedes.expiredAtFinalizedBlockHeight) || supersedes.expiredAtFinalizedBlockHeight <= supersedes.lastValidBlockHeight
      || (supersedes.signature !== undefined && typeof supersedes.signature !== 'string')) throw invalidProof();
    projected.supersedes = {
      preparationId: supersedes.preparationId, lastValidBlockHeight: supersedes.lastValidBlockHeight,
      expiredAtFinalizedBlockHeight: supersedes.expiredAtFinalizedBlockHeight,
      ...(supersedes.signature !== undefined ? {signature: supersedes.signature} : {}),
    };
  }
  return projected;
}

function projectSavedDelegateProof(value: SavedDelegateProof): SavedDelegateProof {
  if (!record(value) || !record(value.proof)
    || (value.proof.operation !== 'approve' && value.proof.operation !== 'revoke')
    || !stringFields(value.proof, ['grantId', 'preparationId', 'signedTransactionBase64', 'signature'])) throw invalidProof();
  const saved: SavedDelegateProof = {
    preparation: projectDelegatePreparation(value.preparation),
    proof: {
      grantId: value.proof.grantId, preparationId: value.proof.preparationId, operation: value.proof.operation,
      signedTransactionBase64: value.proof.signedTransactionBase64, signature: value.proof.signature,
    },
  };
  if (value.scope !== undefined) {
    const scope = value.scope;
    if (!record(scope) || !stringFields(scope, ['principal', 'policyId', 'sourceHash', 'irHash', 'commitmentHash'], true)
      || !Number.isSafeInteger(scope.revision) || scope.revision < 0) throw invalidProof();
    saved.scope = {principal: scope.principal, policyId: scope.policyId, revision: scope.revision,
      sourceHash: scope.sourceHash, irHash: scope.irHash, commitmentHash: scope.commitmentHash};
  }
  if (JSON.stringify(saved).length > MAX_SAVED_PROOF_LENGTH) throw invalidProof();
  return saved;
}

/** Refuse to open the wallet when recovery storage is already unavailable. */
export function checkDelegateProofStorage(): void {
  const check = `allowit.delegate.storage-check:${crypto.randomUUID()}`;
  try {
    const value = '0'.repeat(MAX_SAVED_PROOF_LENGTH);
    localStorage.setItem(check, value);
    if (localStorage.getItem(check) !== value) throw new Error('Storage is unavailable');
  } catch {
    throw new Error('This browser cannot save approval recovery data. Enable site storage before signing. Nothing was signed.');
  } finally {try {localStorage.removeItem(check);} catch {/* No approval has been signed. */}}
}

/** Public signed transaction bytes only. Never stores a key or agent capability. */
export function saveDelegateProof(grant: DelegateGrant, value: SavedDelegateProof): void {
  const saved = projectSavedDelegateProof(value);
  if (saved.scope && (saved.scope.policyId !== grant.policyId || saved.scope.revision !== grant.revision || saved.scope.sourceHash !== grant.sourceHash || saved.scope.irHash !== grant.irHash || saved.scope.commitmentHash !== grant.commitmentHash || !saved.scope.principal.endsWith(`:${grant.owner}`))) throw new Error('The recovery proof has a different owner or policy snapshot.');
  const encoded = JSON.stringify(saved);
  localStorage.setItem(key(grant, saved.proof.operation), encoded);
  if (localStorage.getItem(key(grant, saved.proof.operation)) !== encoded) throw new Error('The signed approval could not be saved on this device. Nothing was submitted.');
}

/** Call under the signing lock before opening the wallet or restoring missing active proof. */
export function checkDelegateProofNotArchived(grant:DelegateGrant,action:'approve'|'revoke',preparationId:string):void{
 if(localStorage.getItem(`${key(grant,action)}:expired:${preparationId}`)!==null)throw new Error('This original signed approval was already archived. Check its retained status; it was not signed or submitted again.');
}

/** Retry retention uses the same lock as signing and archival; it cannot replace a newer packet. */
export async function retainDelegateProof(config:DelegateConfig,grant:DelegateGrant,value:SavedDelegateProof):Promise<void>{
 await withAllowanceSigningLock(grant.displayNetwork,grant.owner,async()=>{
  checkDelegateProofNotArchived(grant,value.proof.operation,value.preparation.preparationId);
  const existing=readDelegateProof(config,grant,value.proof.operation,value.scope?.principal);
  if(existing){
   if(JSON.stringify(existing)!==JSON.stringify(projectSavedDelegateProof(value)))throw new Error('A different signed approval is active. Its original proof was retained; the older packet was not submitted.');
   return;
  }
  saveDelegateProof(grant,value);
 });
}

/** Observe another tab's completed archive without changing active or retained bytes. */
export function delegateProofArchived(config:DelegateConfig,grant:DelegateGrant,next:DelegatePreparation,action:'approve'|'revoke',saved:SavedDelegateProof):boolean{
 const supersedes=next.supersedes;
 if(!supersedes||supersedes.preparationId!==saved.preparation.preparationId
  ||supersedes.lastValidBlockHeight!==saved.preparation.lastValidBlockHeight
  ||!Number.isSafeInteger(supersedes.expiredAtFinalizedBlockHeight)
  ||supersedes.expiredAtFinalizedBlockHeight<=supersedes.lastValidBlockHeight
  ||(supersedes.signature!==undefined&&supersedes.signature!==saved.proof.signature)
  ||!/^[a-zA-Z0-9_-]{1,128}$/.test(supersedes.preparationId))return false;
 const archived=localStorage.getItem(`${key(grant,action)}:expired:${supersedes.preparationId}`);
 if(archived===null)return false;
 try{
  if(archived.length>MAX_LEGACY_PROOF_LENGTH||JSON.stringify(projectSavedDelegateProof(JSON.parse(archived) as SavedDelegateProof))!==JSON.stringify(projectSavedDelegateProof(saved)))throw new Error();
 }catch{throw new Error('The archived proof differs from the original signed transaction. Its recovery data was retained.');}
 const active=readDelegateProof(config,grant,action,saved.scope?.principal);
 return active?.preparation.preparationId!==supersedes.preparationId;
}

/** Retain a superseded public proof before a new, explicit wallet review. */
export async function archiveExpiredDelegateProof(config: DelegateConfig, grant: DelegateGrant, next: DelegatePreparation, action: 'approve' | 'revoke'): Promise<boolean> {
 const current=readDelegateProof(config,grant,action);
 if(!current||current.preparation.preparationId===next.preparationId)return false;
 return withAllowanceSigningLock(grant.displayNetwork,grant.owner,async()=>{
  const old = readDelegateProof(config, grant, action);
  if (!old || old.preparation.preparationId === next.preparationId) return false;
  const supersedes = next.supersedes;
  if (!supersedes || supersedes.preparationId !== old.preparation.preparationId
    || supersedes.lastValidBlockHeight !== old.preparation.lastValidBlockHeight
    || !Number.isSafeInteger(supersedes.expiredAtFinalizedBlockHeight)
    || supersedes.expiredAtFinalizedBlockHeight <= supersedes.lastValidBlockHeight
    || (supersedes.signature !== undefined && supersedes.signature !== old.proof.signature)
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(supersedes.preparationId)) {
    throw new Error('The earlier signed approval remains unresolved. Its recovery proof was retained; a fresh signature is blocked.');
  }
  const encoded = JSON.stringify(old), activeKey = key(grant, action);
  const active = localStorage.getItem(activeKey);
  if (active === null || active.length > MAX_LEGACY_PROOF_LENGTH
    || JSON.stringify(projectSavedDelegateProof(JSON.parse(active) as SavedDelegateProof)) !== encoded) {
    throw new Error('The active approval changed. Review its original proof before continuing.');
  }
  const archiveKey = `${activeKey}:expired:${supersedes.preparationId}`;
  localStorage.setItem(archiveKey, active);
  if (localStorage.getItem(archiveKey) !== active) throw new Error('The expired proof could not be archived. Its active recovery proof remains; nothing new was signed.');
  if (localStorage.getItem(activeKey) !== active) throw new Error('The active approval changed. Review its original proof before continuing.');
  localStorage.removeItem(activeKey);
  if (localStorage.getItem(activeKey) !== null) throw new Error('The original approval remains active in storage. Nothing new was signed.');
  return true;
 });
}

/** Reading recovery data cannot trigger fresh signing. Only these verified exact bytes may be reconciled. */
export function readDelegateProof(config: DelegateConfig, grant: DelegateGrant, action: 'approve' | 'revoke', principal?:string): SavedDelegateProof | null {
  const activeKey = key(grant, action), encoded = localStorage.getItem(activeKey);
  if (encoded === null) return null;
  if (encoded.length > MAX_LEGACY_PROOF_LENGTH) throw invalidProof();
  const saved = projectSavedDelegateProof(JSON.parse(encoded) as SavedDelegateProof);
  if (saved.scope && (saved.scope.policyId !== grant.policyId || saved.scope.revision !== grant.revision || saved.scope.sourceHash !== grant.sourceHash || saved.scope.irHash !== grant.irHash || saved.scope.commitmentHash !== grant.commitmentHash || !saved.scope.principal.endsWith(`:${grant.owner}`) || (principal !== undefined && saved.scope.principal !== principal))) throw new Error('The saved approval belongs to a different owner session or policy snapshot.');
  if (saved.proof.operation !== action || saved.proof.grantId !== grant.id
    || saved.proof.preparationId !== saved.preparation.preparationId) throw new Error('The saved approval belongs to a different grant.');
  const expected = checkedDelegateTransaction(config, grant, grant.owner, action, saved.preparation);
  const signed = Transaction.from(Buffer.from(saved.proof.signedTransactionBase64, 'base64'));
  const before = expected.serializeMessage(), after = signed.serializeMessage();
  if (before.length !== after.length || !before.every((value, index) => value === after[index]) || !signed.verifySignatures()
    || !signed.signature || encodeBase58(signed.signature) !== saved.proof.signature) {
    throw new Error('The saved approval does not match the reviewed grant.');
  }
  // Return the verified core without rewriting an active proof during a recovery read.
  return saved;
}
