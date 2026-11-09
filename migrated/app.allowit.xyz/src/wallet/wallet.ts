import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { SolanaSignMessageFeature } from '@solana/wallet-standard-features';
export type ConnectFeature = { connect:(input?:{silent?:boolean})=>Promise<{accounts:readonly WalletAccount[]}> };
export type EventsFeature = { on:(event:'change',listener:(properties:{accounts?:readonly WalletAccount[]})=>void)=>()=>void };
export async function waitForWallet<T>(pending:Promise<T>,timeoutMs=60000):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([pending,new Promise<T>((_,reject)=>{timer=setTimeout(()=>reject(new Error('The wallet did not respond. Close its old prompt and try again.')),timeoutMs);})]);}
 finally{if(timer)clearTimeout(timer);}
}
export function solanaWallets():Wallet[]{return getWallets().get().filter(w=>w.chains.some(c=>c.startsWith('solana:'))&&!!w.features['standard:connect']&&!!w.features['solana:signMessage']);}
export const walletRegistry=getWallets;
export class WalletConnectionError extends Error {}
let sessionWallet:{wallet:Wallet;owner:string}|null=null;
export function rememberSessionWallet(wallet:Wallet|null,owner=''){sessionWallet=wallet?{wallet,owner}:null;}
/** A saved name is a preference, not proof that a wallet is connected. */
export function transactionWallet(owner:string):Wallet{
 const wallets=solanaWallets();
 if(!wallets.length)throw new WalletConnectionError('No Solana wallet is available in this browser. Enable Phantom or Solflare for this site, unlock it, and reload. You can also open this site in your wallet’s browser.');
 if(sessionWallet?.owner===owner&&wallets.includes(sessionWallet.wallet))return sessionWallet.wallet;
 let name:string|null=null;try{name=localStorage.getItem('allowit.wallet');}catch{/* Storage is optional. */}
 const preferred=wallets.find(w=>w.name===name);
 if(preferred)return preferred;
 const authorized=wallets.filter(w=>w.accounts.some(a=>a.address===owner));
 if(authorized.length===1)return authorized[0];
 // Connecting a single available provider is safe: callers still require the
 // exact signed-in owner and policy network before requesting a signature.
 if(wallets.length===1)return wallets[0];
 throw new WalletConnectionError('Reconnect the wallet for your signed-in address, then retry.');
}
export async function connectAccount(wallet:Wallet,owner?:string):Promise<WalletAccount>{const connected=await waitForWallet((wallet.features['standard:connect'] as ConnectFeature).connect());const account=connected.accounts.find(a=>(!owner||a.address===owner)&&a.chains.some(c=>c.startsWith('solana:'))&&a.features.includes('solana:signMessage'));if(!account){if(owner)throw new WalletConnectionError('Select the signed-in address in your wallet, reconnect, then retry.');throw new Error('This wallet has no Solana account that supports message signing.');}return account;}
/** The wallet call started but returned no usable signature, so whether it broadcast the transaction is unknown. */
export class WalletOutcomeUnknown extends Error{constructor(cause?:unknown){super(cause===undefined?'The wallet did not return a transaction signature, so this transaction may have been sent. Check your wallet activity.':'The wallet reported an error after it started sending, so this transaction may have been sent. Check your wallet activity.',{cause});}}
/**
 * The only conclusive "nothing was sent" signal: the provider's user-rejection code 4001 (EIP-1193, used by Solana
 * wallets such as Phantom). Messages are never matched, because a timeout or backend cancellation after a broadcast
 * can contain words like "rejected" or "cancelled", and an error class name alone does not say whether a send began.
 */
export function isUserRefusal(error:unknown):boolean{return typeof error==='object'&&error!==null&&(error as {code?:unknown}).code===4001;}
/**
 * Runs `solana:signAndSendTransaction` and returns its 64-byte signature. Callers finish every validation, connect,
 * owner and network check before calling this. Once the call starts, any throw except a user refusal, and any missing
 * or malformed signature, is an unknown send outcome.
 */
export async function sendWalletTransaction(send:()=>Promise<readonly unknown[]>):Promise<Uint8Array>{
 let outputs:unknown;
 try{outputs=await send();}
 catch(error){
  if(!isUserRefusal(error))throw new WalletOutcomeUnknown(error);
  // Keep the wallet's own refusal message for the owner; a plain object is not an Error.
  if(error instanceof Error)throw error;
  const message=(error as {message?:unknown}).message;
  throw new Error(typeof message==='string'&&message?message:'The wallet request was rejected.');
 }
 const first:unknown=Array.isArray(outputs)?outputs[0]:undefined;
 const signature=typeof first==='object'&&first!==null?(first as {signature?:unknown}).signature:undefined;
 if(!(signature instanceof Uint8Array)||signature.length!==64)throw new WalletOutcomeUnknown();
 return signature;
}
/**
 * `solana:signMessage` over exact bytes. The wallet must return the same bytes unchanged and a 64-byte Ed25519
 * signature; the caller still verifies that signature against the owner's own key. Never signs or sends a transaction.
 */
export async function signExactMessage(wallet:Wallet,account:WalletAccount,bytes:Uint8Array):Promise<Uint8Array>{const feature=(wallet.features as Partial<SolanaSignMessageFeature>)['solana:signMessage'];if(!feature||!account.features.includes('solana:signMessage'))throw new Error('This wallet cannot sign messages.');const [output]=await feature.signMessage({account,message:new Uint8Array(bytes)});if(!output||(output.signatureType!==undefined&&output.signatureType!=='ed25519')||output.signedMessage.length!==bytes.length||!output.signedMessage.every((b,i)=>b===bytes[i])||output.signature.length!==64)throw new Error('The wallet changed the message to sign. Use a wallet that supports exact Solana message signing.');return new Uint8Array(output.signature);}
export async function signChallenge(wallet:Wallet,account:WalletAccount,message:string):Promise<string>{const bytes=new TextEncoder().encode(message);const [output]=await waitForWallet((wallet.features as SolanaSignMessageFeature)['solana:signMessage'].signMessage({account,message:bytes}));if(!output||(output.signatureType!==undefined&&output.signatureType!=="ed25519")||output.signedMessage.length!==bytes.length||!output.signedMessage.every((b,i)=>b===bytes[i])||output.signature.length!==64)throw new Error('The wallet changed the message to sign. Use a wallet that supports exact Solana message signing.');return btoa(String.fromCharCode(...output.signature));}
