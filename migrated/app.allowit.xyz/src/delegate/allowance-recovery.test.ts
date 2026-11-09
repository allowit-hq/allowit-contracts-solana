import {afterEach, expect, it, vi} from 'vitest';
import {Buffer} from 'buffer';
import {Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction} from '@solana/web3.js';
import {encodeBase58} from '../wallet/allocation';
import {delegateSourceAccount} from './delegate-wallet-intent';
import {archiveResolvedAllowanceRecovery, checkedAllowancePreparation, checkedAllowanceView, saveAllowanceRecovery, signAllowance, submitAllowance, type AllowanceRecoveryView, type SavedAllowanceRecovery} from './allowance-recovery';

const mocks=vi.hoisted(()=>({wallet:vi.fn(),connect:vi.fn(),request:vi.fn()}));
vi.mock('../wallet/wallet',()=>({transactionWallet:mocks.wallet,connectAccount:mocks.connect}));
vi.mock('../api',()=>({request:mocks.request}));
function fixture(id='recovery-one') {
 const ownerKey=Keypair.fromSeed(new Uint8Array(32).fill(1)),memoKey=Keypair.fromSeed(new Uint8Array(32).fill(2));
 const owner=ownerKey.publicKey.toBase58(),delegate=Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey.toBase58();
 const genesisHash='EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',mint='4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
 const sourceAccount=delegateSourceAccount(owner,mint),tokenProgram='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',memo=`allowit-allowance-revoke-v1:${id}`;
 const tx=new Transaction({feePayer:ownerKey.publicKey,recentBlockhash:mint}).add(
  new TransactionInstruction({programId:new PublicKey(tokenProgram),keys:[{pubkey:new PublicKey(sourceAccount),isWritable:true,isSigner:false},{pubkey:ownerKey.publicKey,isWritable:false,isSigner:true}],data:Buffer.from([5])}),
  new TransactionInstruction({programId:new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),keys:[{pubkey:memoKey.publicKey,isWritable:false,isSigner:true}],data:Buffer.from(memo)}));
 tx.partialSign(memoKey);
 const preparation=checkedAllowancePreparation({preparationId:id,owner,network:`solana:${genesisHash.slice(0,32)}`,displayNetwork:'solana:devnet',genesisHash,mint,tokenProgram,sourceAccount,currentDelegate:delegate,feePayer:owner,transactionBase64:tx.serialize({requireAllSignatures:false}).toString('base64'),lastValidBlockHeight:100,feeLamports:10000,memoSigner:memoKey.publicKey.toBase58(),memo},owner,'solana:devnet');
 tx.partialSign(ownerKey);
 const saved:SavedAllowanceRecovery={principal:`solana:${owner}`,preparation,signedTransactionBase64:tx.serialize().toString('base64'),signature:encodeBase58(tx.signature!)};
 const view:AllowanceRecoveryView={...preparation,balanceUnits:'5000000',delegatedUnits:'1000000',status:'submitted',preparation,preparationStatus:'submitted',signature:saved.signature,cleanupPending:true,pendingGrantIds:['grant-one'],stoppedGrantIds:['grant-one']};
 const entries=new Map<string,string>();
 const storage={getItem:(key:string)=>entries.get(key)??null,setItem:(key:string,value:string)=>{entries.set(key,value);},removeItem:(key:string)=>{entries.delete(key);}};
 vi.stubGlobal('localStorage',storage);
 let tail=Promise.resolve<unknown>(undefined);
 vi.stubGlobal('navigator',{locks:{request:(_name:string,run:()=>Promise<unknown>)=>{const next=tail.then(run);tail=next.catch(()=>{});return next;}}});
 return {ownerKey,memoKey,preparation,saved,view,entries,storage};
}
afterEach(()=>vi.unstubAllGlobals());
it('binds recovery to the exact owner, network, canonical source and two-instruction packet',()=>{
 const f=fixture(),p=f.preparation;
 expect(checkedAllowanceView(f.view,p.owner,p.displayNetwork).preparation).toEqual(p);
 for(const changed of [{owner:p.currentDelegate},{sourceAccount:p.currentDelegate},{genesisHash:p.mint},{feeLamports:10001},{memo:'changed'}])expect(()=>checkedAllowancePreparation({...p,...changed},p.owner,p.displayNetwork)).toThrow();
 expect(()=>checkedAllowancePreparation(p,p.owner,'solana:mainnet')).toThrow();
 const tx=Transaction.from(Buffer.from(p.transactionBase64,'base64'));
 tx.add(SystemProgram.transfer({fromPubkey:f.ownerKey.publicKey,toPubkey:f.memoKey.publicKey,lamports:1}));
 tx.partialSign(f.memoKey);
 expect(()=>checkedAllowancePreparation({...p,transactionBase64:tx.serialize({requireAllSignatures:false}).toString('base64')},p.owner,p.displayNetwork)).toThrow();
});
it('does not submit a signed revocation when its retry cannot retain exact bytes durably',async()=>{
 const f=fixture();mocks.request.mockClear();f.storage.setItem=()=>{throw new Error('Storage full');};
 await expect(submitAllowance(f.saved)).rejects.toThrow('Storage full');expect(mocks.request).not.toHaveBeenCalled();
 expect(f.saved.signedTransactionBase64).not.toBe('');
});

it('rejects an archived unsigned review before invoking the wallet',async()=>{
 const f=fixture();saveAllowanceRecovery(f.saved);await archiveResolvedAllowanceRecovery(f.saved,{...f.view,preparationStatus:'expired'});
 mocks.wallet.mockClear();mocks.request.mockClear();
 await expect(signAllowance(f.preparation,f.saved.principal,()=>true)).rejects.toThrow('already resolved');
 expect(mocks.wallet).not.toHaveBeenCalled();expect(mocks.request).not.toHaveBeenCalled();
});
