import type {Network,NetworkConfig} from './networks';
import {address as solAddress,blockhash,pipe,createTransactionMessage,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,appendTransactionMessageInstructions,compileTransaction,getTransactionEncoder} from '@solana/kit';
import {getApproveCheckedInstruction,getRevokeInstruction} from '@solana-program/token';
import type {SolanaSignAndSendTransactionFeature} from '@solana/wallet-standard-features';
import {transactionWallet,connectAccount,sendWalletTransaction,type EventsFeature} from './wallet';
export interface AllocationIntent {network:Network;kind:'approve'|'revoke';owner:string;address:string;mint:string;delegate:string;amount:string;units:string;token:'USDC';blockhash:string;lastValidBlockHeight:number;memo:string;expiresAt:string;noTransaction?:boolean;release?:boolean}
export function encodeBase58(bytes:Uint8Array){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';let n=0n;for(const b of bytes)n=n*256n+BigInt(b);let out='';while(n){out=alphabet[Number(n%58n)]+out;n/=58n;}for(const b of bytes){if(b)break;out='1'+out;}return out;}
export async function signAllocation(intent:AllocationIntent,address:string,network:NetworkConfig|undefined):Promise<string>{
 if(intent.network==='local:dev')throw new Error('Local dev does not use wallet transactions.');
 // Test-network mints are pinned by the server's network configuration below.
 if((intent.network==='solana:mainnet'&&intent.mint!=='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')||(intent.network!=='solana:mainnet'&&intent.mint==='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'))throw new Error('The token mint does not match the policy network.');
 if(intent.delegate!==(intent.network==='solana:mainnet'?'87fX2a7BbnbJJKu4orKh6KriX3USZz9L8t593S1PnYZL':'37d8Upvk6ubJN4T5fXZ8D7PMH7K3b4n1XSuiQxG58FQA')||intent.owner!==address||intent.token!=='USDC'||!network?.allocationEnabled||intent.network!==network.id||intent.mint!==network.mint)throw new Error('The allocation does not match this account, policy network or configured token.');
 const wallet=transactionWallet(address);
 const feature=wallet.features['solana:signAndSendTransaction'] as SolanaSignAndSendTransactionFeature['solana:signAndSendTransaction']|undefined;
 if(!feature)throw new Error('This wallet cannot submit Solana transactions. Enable the policy network in your wallet.');
 const account=await connectAccount(wallet,address);if(account.address!==address||!account.chains.includes(intent.network))throw new Error('Select the signed-in account and enable the policy network in your wallet.');
 let valid=true;const stop=(wallet.features['standard:events'] as EventsFeature|undefined)?.on('change',p=>{if(p.accounts&&!p.accounts.some(a=>a.address===address))valid=false;});
 try{
 const owner=solAddress(address);
 const instruction=intent.kind==='approve'?getApproveCheckedInstruction({source:solAddress(intent.address),mint:solAddress(intent.mint),delegate:solAddress(intent.delegate),owner,amount:BigInt(intent.units),decimals:6}):getRevokeInstruction({source:solAddress(intent.address),owner});
 const message=pipe(createTransactionMessage({version:'legacy'}),m=>setTransactionMessageFeePayer(owner,m),m=>setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash(intent.blockhash),lastValidBlockHeight:BigInt(intent.lastValidBlockHeight)},m),m=>appendTransactionMessageInstructions([instruction,{programAddress:solAddress('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),data:new TextEncoder().encode(intent.memo)}],m));
 const transaction=new Uint8Array(getTransactionEncoder().encode(compileTransaction(message)));
 if(!valid)throw new Error('Wallet access changed. Sign in again.');
 return encodeBase58(await sendWalletTransaction(()=>feature.signAndSendTransaction({account,chain:intent.network,transaction,options:{preflightCommitment:'confirmed',skipPreflight:false}})));
 }finally{stop?.();}
}
