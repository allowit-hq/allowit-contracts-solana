import {address as solAddress,blockhash,pipe,createTransactionMessage,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,appendTransactionMessageInstructions,compileTransaction,getTransactionEncoder} from '@solana/kit';
import {getTransferCheckedInstruction} from '@solana-program/token';
import type {SolanaSignAndSendTransactionFeature} from '@solana/wallet-standard-features';
import {transactionWallet,connectAccount,sendWalletTransaction,type EventsFeature} from './wallet';
import {encodeBase58} from './allocation';
import type {Network} from './networks';
export interface TransferIntent {network:Network;owner:string;source:string;destination:string;recipient:string;mint:string;amount:string;units:string;token:string;blockhash:string;lastValidBlockHeight:number;memo:string;expiresAt:string}
export async function signTransfer(intent:TransferIntent,expected:{owner:string;network:Network;mint:string;recipient:string;amount:string}):Promise<string>{
 if(intent.network==='local:dev')throw new Error('Local dev does not use wallet transactions.');
 if(intent.owner!==expected.owner||intent.network!==expected.network||intent.mint!==expected.mint||intent.recipient!==expected.recipient||intent.amount!==expected.amount||intent.token!=='USDC')throw new Error('The transfer does not match the request you reviewed.');
 // The exact test mint must match the reviewed policy, checked above.
 if(intent.network==='solana:mainnet'&&intent.mint!=='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')throw new Error('The token does not match this network.');
 if(intent.network!=='solana:mainnet'&&intent.mint==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')throw new Error('The token does not match this network.');
 const [whole,fraction='']=intent.amount.split('.');const expectedUnits=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));if(BigInt(intent.units)!==expectedUnits)throw new Error('The transfer amount does not match.');
 const wallet=transactionWallet(expected.owner);
 const feature=wallet.features['solana:signAndSendTransaction'] as SolanaSignAndSendTransactionFeature['solana:signAndSendTransaction']|undefined;if(!feature)throw new Error('This wallet cannot submit Solana transactions.');
 const account=await connectAccount(wallet,expected.owner);if(account.address!==expected.owner||!account.chains.includes(intent.network))throw new Error('Select the signed-in account and the policy network in your wallet.');
 let valid=true;const stop=(wallet.features['standard:events'] as EventsFeature|undefined)?.on('change',p=>{if(p.accounts&&!p.accounts.some(a=>a.address===expected.owner))valid=false;});
 try{const owner=solAddress(expected.owner);const ix=getTransferCheckedInstruction({source:solAddress(intent.source),mint:solAddress(intent.mint),destination:solAddress(intent.destination),authority:owner,amount:BigInt(intent.units),decimals:6});const message=pipe(createTransactionMessage({version:'legacy'}),m=>setTransactionMessageFeePayer(owner,m),m=>setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(intent.blockhash),lastValidBlockHeight:BigInt(intent.lastValidBlockHeight)},m),m=>appendTransactionMessageInstructions([ix,{programAddress:solAddress('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),data:new TextEncoder().encode(intent.memo)}],m));if(!valid)throw new Error('Wallet access changed. Sign in again.');const transaction=new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));return encodeBase58(await sendWalletTransaction(()=>feature.signAndSendTransaction({account,chain:intent.network,transaction,options:{preflightCommitment:'confirmed',skipPreflight:false}})));}finally{stop?.();}
}
