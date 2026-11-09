import {withAllowanceSigningLock} from './allowance-coordination';
import {afterEach, expect, it, vi} from 'vitest';
import {Buffer} from 'buffer';
import {Keypair, PublicKey, Transaction, TransactionInstruction} from '@solana/web3.js';
import {archiveExpiredDelegateProof, checkDelegateProofNotArchived, readDelegateProof, retainDelegateProof, saveDelegateProof} from './delegate-proof';
import {delegateInstructions, delegateSourceAccount} from './delegate-wallet-intent';
import {encodeBase58} from '../wallet/allocation';
import type {DelegateConfig, DelegateGrant, DelegatePreparation} from './delegate-contracts';

function fixture(legacy = false, action: 'approve' | 'revoke' = 'approve', sponsored = false, guarded = false) {
  const storage = new Map<string, string>();
  const local = {getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => {storage.set(key, value);}, removeItem: (key: string) => {storage.delete(key);}};
  vi.stubGlobal('localStorage', local);
  let tail:Promise<unknown>=Promise.resolve();
  vi.stubGlobal('navigator',{locks:{request:vi.fn((_name:string,run:()=>unknown)=>{
    const result=tail.then(run);tail=result.then(()=>undefined,()=>undefined);return result;
  })}});
  const signer = Keypair.generate(), owner = signer.publicKey.toBase58();
  const sponsor = sponsored ? Keypair.generate() : undefined;
  const memoSigner = guarded ? Keypair.generate() : undefined;
  const mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', delegate = Keypair.generate().publicKey.toBase58();
  const config: DelegateConfig = {ready: true, network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', displayNetwork: 'solana:devnet', genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', mint, delegate, decimals: 6, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', ...(sponsor ? {setupFeePayer: sponsor.publicKey.toBase58()} : {})};
  const grant: DelegateGrant = {id: 'grant', owner, network: config.network, displayNetwork: config.displayNetwork, genesisHash: config.genesisHash, mint, delegate, sourceAccount: delegateSourceAccount(owner, mint), source: 'original', intent: 'research', sourceHash: 'a'.repeat(64), irHash: 'b'.repeat(64), memo: `allowit-grant-v1:${'c'.repeat(64)}`, commitmentHash: 'c'.repeat(64), commitmentBytesBase64: 'e30=', budgetUnits: '2000', remainingUnits: '2000', reservedUnits: '0', spentUnits: '0', status: 'prepared', expiresAt: 4102444800, revision: 1, parentGrantId: null, policyId: 'policy', children: [], receipts: []};
  const instructions = delegateInstructions(grant, action).filter(ix => !legacy || ix.programId.toBase58() !== 'ComputeBudget111111111111111111111111111111');
  if (memoSigner) {
    const memo = instructions[instructions.length - 1];
    instructions[instructions.length - 1] = new TransactionInstruction({programId: memo.programId, data: memo.data,
      keys: [{pubkey: memoSigner.publicKey, isSigner: true, isWritable: false}]});
  }
  const transaction = new Transaction({feePayer: sponsor?.publicKey ?? new PublicKey(owner), recentBlockhash: mint}).add(...instructions);
  if (sponsor) transaction.partialSign(sponsor);
  if (memoSigner) transaction.partialSign(memoSigner);
  const preparation: DelegatePreparation = {grantId: grant.id, preparationId: 'old-preparation', transactionBase64: transaction.serialize({requireAllSignatures: false, verifySignatures: false}).toString('base64'), memo: grant.memo, sourceAccount: grant.sourceAccount, mint, delegate, budgetUnits: grant.budgetUnits, genesisHash: grant.genesisHash, lastValidBlockHeight: 100, feePayer: config.setupFeePayer ?? owner, action, ...(memoSigner ? {memoSigner: memoSigner.publicKey.toBase58()} : {})};
  transaction.partialSign(signer);
  const saved = {preparation, proof: {grantId: grant.id, preparationId: preparation.preparationId, operation: action, signedTransactionBase64: Buffer.from(transaction.serialize()).toString('base64'), signature: encodeBase58(transaction.signature!)}};
  saveDelegateProof(grant, saved);
  const next = {...preparation, preparationId: 'new-preparation', lastValidBlockHeight: 300, supersedes: {preparationId: preparation.preparationId, lastValidBlockHeight: 100, expiredAtFinalizedBlockHeight: 101, signature: saved.proof.signature}};
  return {storage, local, config, grant, saved, next};
}
afterEach(() => vi.unstubAllGlobals());
it('retains an unresolved signed proof when replacement lacks exact expiry evidence', async () => {
  const f = fixture();
  await expect(archiveExpiredDelegateProof(f.config, f.grant, {...f.next, supersedes: undefined}, 'approve')).rejects.toThrow(/unresolved/);
  await expect(archiveExpiredDelegateProof(f.config, f.grant, {...f.next, supersedes: {...f.next.supersedes, expiredAtFinalizedBlockHeight: 100}}, 'approve')).rejects.toThrow(/unresolved/);
  expect(readDelegateProof(f.config, f.grant, 'approve')?.proof.signature).toBe(f.saved.proof.signature);
});
it('keeps the active proof when durable archiving fails', async () => {
  const f = fixture();
  f.local.setItem = () => {throw new Error('Storage full');};
  await expect(archiveExpiredDelegateProof(f.config, f.grant, f.next, 'approve')).rejects.toThrow(/Storage full/);
  expect(readDelegateProof(f.config, f.grant, 'approve')?.proof.signature).toBe(f.saved.proof.signature);
});

it('serializes old archival, new signing retention and a second archival without deleting the new proof',async()=>{
 const f=fixture(),replacement={...f.saved,preparation:f.next,proof:{...f.saved.proof,preparationId:f.next.preparationId}};
 const first=archiveExpiredDelegateProof(f.config,f.grant,f.next,'approve');
 const signing=withAllowanceSigningLock(f.grant.displayNetwork,f.grant.owner,async()=>saveDelegateProof(f.grant,replacement));
 const second=archiveExpiredDelegateProof(f.config,f.grant,f.next,'approve');
 expect(await first).toBe(true);await signing;expect(await second).toBe(false);
 expect(readDelegateProof(f.config,f.grant,'approve')).toEqual(replacement);
 expect([...f.storage].some(([key,value])=>key.endsWith(':expired:old-preparation')&&JSON.parse(value).proof.preparationId==='old-preparation')).toBe(true);
});

it('a queued retry cannot replace a newer packet after archival and signing',async()=>{
 const f=fixture(),replacement={...f.saved,preparation:f.next,proof:{...f.saved.proof,preparationId:f.next.preparationId}};
 const archive=archiveExpiredDelegateProof(f.config,f.grant,f.next,'approve');
 const signing=withAllowanceSigningLock(f.grant.displayNetwork,f.grant.owner,async()=>saveDelegateProof(f.grant,replacement));
 const retry=retainDelegateProof(f.config,f.grant,f.saved);const rejected=expect(retry).rejects.toThrow('already archived');
 await archive;await signing;await rejected;
 expect(readDelegateProof(f.config,f.grant,'approve')).toEqual(replacement);
});
it('retry cannot restore an already archived packet to the active key',async()=>{
 const f=fixture();await archiveExpiredDelegateProof(f.config,f.grant,f.next,'approve');
 await expect(retainDelegateProof(f.config,f.grant,f.saved)).rejects.toThrow('already archived');
 expect(readDelegateProof(f.config,f.grant,'approve')).toBeNull();
});

it('blocks an old unsigned review after its preparation was signed and archived in another tab',async()=>{
 const f=fixture();await archiveExpiredDelegateProof(f.config,f.grant,f.next,'approve');
 const wallet=vi.fn();
 await expect(withAllowanceSigningLock(f.grant.displayNetwork,f.grant.owner,async()=>{
  checkDelegateProofNotArchived(f.grant,'approve',f.saved.preparation.preparationId);wallet();
 })).rejects.toThrow('already archived');
 expect(wallet).not.toHaveBeenCalled();expect(readDelegateProof(f.config,f.grant,'approve')).toBeNull();
});
