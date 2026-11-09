import {withAllowanceSigningLock} from './allowance-coordination';
import {Buffer} from 'buffer';
import {PublicKey, Transaction, TransactionInstruction} from '@solana/web3.js';
import type {SolanaSignTransactionFeature} from '@solana/wallet-standard-features';
import {request} from '../api';
import {encodeBase58} from '../wallet/allocation';
import {connectAccount, transactionWallet} from '../wallet/wallet';
import {checkedDelegateConfig, delegateSourceAccount} from './delegate-wallet-intent';
import {checkDelegateProofStorage} from './delegate-proof';
import {delegateUnits} from './delegate-contracts';

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MAX_PROOF = 24_576;
const MAX_FEE = 10_000;
const statuses = ['available','prepared','submitted','confirmed','absent','expired','failed','changed'] as const;
type Status = typeof statuses[number];
export interface AllowanceRecoveryPreparation {
 preparationId:string; owner:string; network:string; displayNetwork:'solana:mainnet'|'solana:devnet';
 genesisHash:string; mint:string; tokenProgram:string; sourceAccount:string; currentDelegate:string;
 feePayer:string; transactionBase64:string; lastValidBlockHeight:number; feeLamports:number;
 memoSigner:string; memo:string;
}
export interface AllowanceRecoveryView {
 owner:string; network:string; displayNetwork:'solana:mainnet'|'solana:devnet'; genesisHash:string;
 mint:string; tokenProgram:string; sourceAccount:string; currentDelegate:string|null;
 balanceUnits:string; delegatedUnits:string; status:Status; preparation?:AllowanceRecoveryPreparation;
 preparationStatus?:'prepared'|'submitted'|'confirmed'|'expired'|'failed';
 signature?:string; cleanupPending:boolean; pendingGrantIds:string[]; stoppedGrantIds:string[]; reason?:string;
}
export interface SavedAllowanceRecovery {
 principal:string; preparation:AllowanceRecoveryPreparation; signedTransactionBase64:string; signature:string;
}
const record = (value:unknown):value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new Error('The wallet allowance recovery response could not be verified. Nothing was signed.');
const text = (value:unknown,max=128):value is string => typeof value === 'string' && value.length>0 && value.length<=max;
const equal = (a:Uint8Array,b:Uint8Array) => a.length===b.length && a.every((value,index)=>value===b[index]);
const address = (value:string) => {if(new PublicKey(value).toBase58()!==value)throw invalid();};
function checkIdentity(value:Record<string,unknown>,owner:string,network:string):void {
 if(value.owner!==owner || value.displayNetwork!==network || !['solana:mainnet','solana:devnet'].includes(network)
  || !['network','genesisHash','mint','tokenProgram','sourceAccount'].every(key=>text(value[key])))throw invalid();
 checkedDelegateConfig({ready:false,network:value.network as string,displayNetwork:network as 'solana:mainnet'|'solana:devnet',
  genesisHash:value.genesisHash as string,mint:value.mint as string,tokenProgram:value.tokenProgram as string,decimals:6,delegate:''},network);
 if(value.network!==`solana:${(value.genesisHash as string).slice(0,32)}` || value.tokenProgram!==TOKEN
  || value.sourceAccount!==delegateSourceAccount(owner,value.mint as string))throw invalid();
 address(owner);address(value.sourceAccount as string);
}
export function checkedAllowancePreparation(value:unknown,owner:string,network:string):AllowanceRecoveryPreparation {
 if(!record(value))throw invalid();
 checkIdentity(value,owner,network);
 if(!text(value.preparationId) || !/^[A-Za-z0-9_-]{1,128}$/.test(value.preparationId)
  || !text(value.currentDelegate) || value.feePayer!==owner || !text(value.transactionBase64,8192)
  || !Number.isSafeInteger(value.lastValidBlockHeight) || Number(value.lastValidBlockHeight)<=0
  || !Number.isSafeInteger(value.feeLamports) || Number(value.feeLamports)<=0 || Number(value.feeLamports)>MAX_FEE
  || !text(value.memoSigner) || value.memo!==`allowit-allowance-revoke-v1:${value.preparationId}`)throw invalid();
 const preparation:AllowanceRecoveryPreparation={
  preparationId:value.preparationId,owner,network:value.network as string,displayNetwork:network as 'solana:mainnet'|'solana:devnet',
  genesisHash:value.genesisHash as string,mint:value.mint as string,tokenProgram:TOKEN,sourceAccount:value.sourceAccount as string,
  currentDelegate:value.currentDelegate,feePayer:owner,transactionBase64:value.transactionBase64,
  lastValidBlockHeight:value.lastValidBlockHeight as number,feeLamports:value.feeLamports as number,memoSigner:value.memoSigner,memo:value.memo,
 };
 checkedAllowanceTransaction(preparation);
 return preparation;
}
export function checkedAllowanceView(value:unknown,owner:string,network:string):AllowanceRecoveryView {
 if(!record(value))throw invalid();
 checkIdentity(value,owner,network);
 if(value.currentDelegate!==null && !text(value.currentDelegate))throw invalid();
 if(value.currentDelegate!==null)address(value.currentDelegate as string);
 if(!text(value.balanceUnits,32)||!text(value.delegatedUnits,32)
  || !statuses.includes(value.status as Status) || typeof value.cleanupPending!=='boolean')throw invalid();
 delegateUnits(value.balanceUnits);delegateUnits(value.delegatedUnits);
 const ids=(items:unknown):string[]=>{
  if(!Array.isArray(items)||items.length>4096||items.some(item=>!text(item)))throw invalid();
  return items as string[];
 };
 const view:AllowanceRecoveryView={owner,network:value.network as string,displayNetwork:network as 'solana:mainnet'|'solana:devnet',
  genesisHash:value.genesisHash as string,mint:value.mint as string,tokenProgram:TOKEN,sourceAccount:value.sourceAccount as string,
  currentDelegate:value.currentDelegate as string|null,balanceUnits:value.balanceUnits,delegatedUnits:value.delegatedUnits,
  status:value.status as Status,cleanupPending:value.cleanupPending,pendingGrantIds:ids(value.pendingGrantIds),stoppedGrantIds:ids(value.stoppedGrantIds)};
 if(value.preparation!==undefined && value.preparation!==null)view.preparation=checkedAllowancePreparation(value.preparation,owner,network);
 if(value.preparationStatus!==undefined && value.preparationStatus!==null){
  if(!['prepared','submitted','confirmed','expired','failed'].includes(value.preparationStatus as string))throw invalid();
  view.preparationStatus=value.preparationStatus as AllowanceRecoveryView['preparationStatus'];
 }
 if(value.signature!==undefined && value.signature!==null){
  if(!text(value.signature,100)||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value.signature))throw invalid();view.signature=value.signature;
 }
 if(value.reason!==undefined && value.reason!==null){if(!text(value.reason,2048))throw invalid();view.reason=value.reason;}
 return view;
}
/** Exact Revoke and a frozen Memo cosignature. No token transfer, approval or other instruction is admitted. */
export function checkedAllowanceTransaction(preparation:AllowanceRecoveryPreparation):Transaction {
 const transaction=Transaction.from(Buffer.from(preparation.transactionBase64,'base64'));
 const signer=new PublicKey(preparation.memoSigner);
 const forbidden=[preparation.owner,preparation.sourceAccount,preparation.currentDelegate,preparation.mint,TOKEN,MEMO,preparation.genesisHash,transaction.recentBlockhash];
 if(!transaction.recentBlockhash || transaction.nonceInfo || transaction.feePayer?.toBase58()!==preparation.owner
  || forbidden.includes(preparation.memoSigner) || !PublicKey.isOnCurve(signer.toBytes()))throw invalid();
 address(preparation.currentDelegate);address(preparation.memoSigner);
 const expected=new Transaction({feePayer:new PublicKey(preparation.owner),recentBlockhash:transaction.recentBlockhash}).add(
  new TransactionInstruction({programId:new PublicKey(TOKEN),keys:[
   {pubkey:new PublicKey(preparation.sourceAccount),isWritable:true,isSigner:false},
   {pubkey:new PublicKey(preparation.owner),isWritable:false,isSigner:true},
  ],data:Buffer.from([5])}),
  new TransactionInstruction({programId:new PublicKey(MEMO),keys:[{pubkey:signer,isSigner:true,isWritable:false}],data:Buffer.from(preparation.memo,'utf8')}),
 );
 if(!equal(transaction.serializeMessage(),expected.serializeMessage()) || transaction.signatures.length!==2
  || transaction.signatures.some(entry=>![preparation.owner,preparation.memoSigner].includes(entry.publicKey.toBase58()))
  || transaction.signatures.find(entry=>entry.publicKey.toBase58()===preparation.owner)?.signature!==null
  || !transaction.signatures.find(entry=>entry.publicKey.toBase58()===preparation.memoSigner)?.signature
  || !transaction.verifySignatures(false))throw invalid();
 return transaction;
}
export function allowanceRecoveryComplete(view:AllowanceRecoveryView):boolean {
 return (view.status==='absent'||view.status==='confirmed') && view.currentDelegate===null
  && !view.cleanupPending && view.pendingGrantIds.length===0;
}
const proofKey=(owner:string,network:string,source:string)=>`allowit.allowance.recovery.v1:${owner}:${network}:${source}`;
const unreadableSaved=()=>new Error('This browser could not read the saved revocation. Nothing new was signed or sent. Use Check allowance status. Keep the original saved data for recovery.');
function parseSaved(encoded:string):unknown {try{return JSON.parse(encoded);}catch{throw unreadableSaved();}}
function checkedSaved(value:unknown,owner:string,network:string,principal:string):SavedAllowanceRecovery {
 try{
 if(!record(value)||value.principal!==principal||!text(value.signedTransactionBase64,8192)||!text(value.signature,100))throw new Error('The saved allowance revocation is unreadable. Its original data was retained; check server status.');
 const preparation=checkedAllowancePreparation(value.preparation,owner,network);
 const expected=checkedAllowanceTransaction(preparation),signed=Transaction.from(Buffer.from(value.signedTransactionBase64,'base64'));
 if(!equal(signed.serializeMessage(),expected.serializeMessage()) || signed.signatures.length!==2
  || !signed.verifySignatures() || !signed.signature || encodeBase58(signed.signature)!==value.signature)throw new Error('The saved allowance revocation differs from the reviewed account. Its original data was retained.');
 return {principal,preparation,signedTransactionBase64:value.signedTransactionBase64,signature:value.signature};
 }catch{throw unreadableSaved();}
}
export function readAllowanceRecovery(owner:string,network:string,source:string,principal:string):SavedAllowanceRecovery|null {
 const encoded=localStorage.getItem(proofKey(owner,network,source));
 if(encoded===null)return null;
 if(encoded.length>MAX_PROOF)throw new Error('The saved allowance revocation is too large. Its original data was retained; check server status.');
 const saved=checkedSaved(parseSaved(encoded),owner,network,principal);
 if(saved.preparation.sourceAccount!==source)throw invalid();
 return saved;
}
/** Called only while the owner/network signing lock is held. */
export function saveAllowanceRecovery(saved:SavedAllowanceRecovery):void {
 const p=saved.preparation;
 const compact=checkedSaved(saved,p.owner,p.displayNetwork,saved.principal);
 const encoded=JSON.stringify(compact),key=proofKey(p.owner,p.displayNetwork,p.sourceAccount);
 if(encoded.length>MAX_PROOF)throw invalid();
 if(localStorage.getItem(`${key}:resolved:${p.preparationId}`)!==null)throw new Error('This revocation is already resolved. Use Check allowance status. Nothing was submitted.');
 const existing=localStorage.getItem(key);
 if(existing===encoded)return;
 if(existing!==null && existing!==encoded)throw new Error('An earlier allowance revocation remains saved. Check its exact transaction before signing another.');
 localStorage.setItem(key,encoded);
 if(localStorage.getItem(key)!==encoded)throw new Error('The signed revocation could not be saved. Keep this page open; nothing was submitted.');
}
/** Only the exact server-retained packet's final receipt or proven expiry resolves a signed recovery packet. */
export async function archiveResolvedAllowanceRecovery(saved:SavedAllowanceRecovery,view:AllowanceRecoveryView):Promise<boolean> {
 if(view.preparation?.preparationId!==saved.preparation.preparationId
  || !['confirmed','expired','failed'].includes(view.preparationStatus??'')
  || (view.preparationStatus!=='expired' && view.signature!==saved.signature)
  || (view.signature!==undefined && view.signature!==saved.signature))return false;
 return withAllowanceSigningLock(saved.preparation.displayNetwork,saved.preparation.owner,async()=>{
 if(JSON.stringify(view.preparation)!==JSON.stringify(saved.preparation))throw new Error('The retained revocation preparation changed. Its original signed proof remains saved.');
 const p=saved.preparation,key=proofKey(p.owner,p.displayNetwork,p.sourceAccount),active=localStorage.getItem(key);
 if(active===null)return true;
 if(active.length>MAX_PROOF || JSON.stringify(checkedSaved(parseSaved(active),p.owner,p.displayNetwork,saved.principal))!==JSON.stringify(saved))throw new Error('The saved allowance revocation changed. Check its original transaction.');
 const archive=`${key}:resolved:${p.preparationId}`;
 localStorage.setItem(archive,active);
 if(localStorage.getItem(archive)!==active)throw new Error('The resolved revocation could not be archived. Its original proof remains saved.');
 if(localStorage.getItem(key)!==active)throw new Error('The saved allowance revocation changed. Check its original transaction.');
 localStorage.removeItem(key);
 if(localStorage.getItem(key)!==null)throw new Error('The original revocation remains saved. No new signature is available.');
 return true;
 });
}
export async function inspectAllowance(owner:string,network:string,principal:string):Promise<AllowanceRecoveryView> {
 return checkedAllowanceView(await request<unknown>(`delegate/allowance?network=${encodeURIComponent(network)}`,undefined,{expectedOwner:principal}),owner,network);
}
export async function prepareAllowance(view:AllowanceRecoveryView,principal:string):Promise<AllowanceRecoveryView> {
 if(!view.currentDelegate)throw new Error('No token allowance remains. Check its status instead of signing.');
 return checkedAllowanceView(await request<unknown>('delegate/allowance-revoke/prepare',{
  network:view.displayNetwork,sourceAccount:view.sourceAccount,currentDelegate:view.currentDelegate,
 },{expectedOwner:principal}),view.owner,view.displayNetwork);
}
export async function checkAllowance(owner:string,network:string,principal:string,preparationId?:string):Promise<AllowanceRecoveryView> {
 return checkedAllowanceView(await request<unknown>('delegate/allowance-revoke/check',{network,...(preparationId?{preparationId}:{})},{expectedOwner:principal}),owner,network);
}
export async function submitAllowance(saved:SavedAllowanceRecovery):Promise<AllowanceRecoveryView> {
 const p=saved.preparation;
 await withAllowanceSigningLock(p.displayNetwork,p.owner,async()=>{saveAllowanceRecovery(saved);});
 return checkedAllowanceView(await request<unknown>('delegate/allowance-revoke/submit',{
  network:p.displayNetwork,preparationId:p.preparationId,signedTransactionBase64:saved.signedTransactionBase64,signature:saved.signature,
 },{expectedOwner:saved.principal}),p.owner,p.displayNetwork);
}
export async function signAllowance(preparation:AllowanceRecoveryPreparation,principal:string,current:()=>boolean):Promise<SavedAllowanceRecovery> {
 const transaction=checkedAllowanceTransaction(preparation);
 if(localStorage.getItem(`${proofKey(preparation.owner,preparation.displayNetwork,preparation.sourceAccount)}:resolved:${preparation.preparationId}`)!==null)throw new Error('This revocation is already resolved. Use Check allowance status. Nothing was signed or submitted.');
 checkDelegateProofStorage();
 if(!current())throw new Error('The owner or network changed. Nothing was signed.');
 const wallet=transactionWallet(preparation.owner);
 const feature=wallet.features['solana:signTransaction'] as SolanaSignTransactionFeature['solana:signTransaction']|undefined;
 if(!feature?.supportedTransactionVersions.includes('legacy'))throw new Error('Use a wallet that can sign a Solana transaction without sending it.');
 const account=await connectAccount(wallet,preparation.owner);
 if(!current() || account.address!==preparation.owner || !account.chains.includes(preparation.displayNetwork)
  || !account.features.includes('solana:signTransaction'))throw new Error('Select the signed-in wallet and the reviewed network. Nothing was signed.');
 const latest=await checkAllowance(preparation.owner,preparation.displayNetwork,principal,preparation.preparationId);
 if(!current() || latest.currentDelegate!==preparation.currentDelegate || latest.preparation?.preparationId!==preparation.preparationId
  || latest.preparation.transactionBase64!==preparation.transactionBase64 || latest.preparationStatus!=='prepared')throw new Error('The wallet allowance or preparation changed. Review its current status before signing.');
 if(readAllowanceRecovery(preparation.owner,preparation.displayNetwork,preparation.sourceAccount,principal))throw new Error('A signed allowance revocation is already saved. Check or submit that exact transaction.');
 const [result]=await feature.signTransaction({account,chain:preparation.displayNetwork,
  transaction:new Uint8Array(transaction.serialize({requireAllSignatures:false,verifySignatures:false}))});
 if(!(result?.signedTransaction instanceof Uint8Array))throw new Error('The wallet returned no signed transaction. Nothing was submitted.');
 try{
 const saved=checkedSaved({principal,preparation,signedTransactionBase64:Buffer.from(result.signedTransaction).toString('base64'),
  signature:encodeBase58(Transaction.from(result.signedTransaction).signature??new Uint8Array())},preparation.owner,preparation.displayNetwork,principal);
 return saved;
 }catch{throw new Error('The wallet returned an invalid transaction or one that differs from the reviewed revocation. It was not saved or submitted.');}
}
