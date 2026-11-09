import type {Page} from '@playwright/test';
import {generateKeyPairSync,sign,type KeyObject} from 'node:crypto';

// Test-only Wallet Standard provider. __rejectTransaction refuses with the user-rejection code 4001 before sending;
// __sendThenFail throws after a send began (its message deliberately contains refusal-like words); __omitSignature and
// __malformedSignature return no usable signature. __walletCalls counts every signAndSendTransaction call.
// The private key stays in the test worker,
// like a real wallet keeps signing outside app code. Linux WebKit's WebCrypto
// Ed25519 occasionally reports OperationError, so this fixture uses Node crypto.
// Signatures are real and are verified by the Rust authentication API.
// Returns the public key only, so a test-only fixture can verify the wallet's real signatures; the private key never leaves here.
export async function installWallet(page:Page,icon='data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='):Promise<{publicKey:KeyObject}>{
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const bytes=Array.from(publicKey.export({type:'spki',format:'der'}).subarray(-32));
 await page.exposeFunction('__allowitTestSign',(message:number[])=>Array.from(sign(null,Buffer.from(message),privateKey)));
 await page.addInitScript(({raw,icon}:{raw:number[];icon:string})=>{
  const pub=new Uint8Array(raw);
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n=0n;for(const b of pub)n=n*256n+BigInt(b);
  let address='';while(n>0){address=alphabet[Number(n%58n)]+address;n/=58n;}
  for(const b of pub){if(b!==0)break;address='1'+address;}
  const account={address,publicKey:pub,chains:['solana:mainnet','solana:testnet','solana:devnet'],features:['solana:signMessage','solana:signAndSendTransaction']};
  let connected=false,registered=false;
  const listeners=new Set<(p:{accounts:typeof account[]})=>void>();
  const loseAccess=()=>{connected=false;listeners.forEach(fn=>fn({accounts:[]}));};
  const wallet={
   version:'1.0.0',name:'Test signer (automated)',
   icon,
   chains:['solana:mainnet','solana:testnet','solana:devnet'],get accounts(){return connected?[account]:[];},
   features:{
    // __connectOtherAccount makes the wallet connect a different address, as when the user switched accounts.
    'standard:connect':{version:'1.0.0',connect:async()=>{if((window as any).__holdConnect||(window as any).__holdTestConnect)await new Promise<void>(resolve=>{(window as any).__releaseConnect=resolve;(window as any).__releaseTestConnect=resolve;});connected=true;return {accounts:[(window as any).__connectOtherAccount?{...account,address:'11111111111111111111111111111111'}:account]};}},
    'standard:events':{version:'1.0.0',on:(_event:string,fn:(p:{accounts:typeof account[]})=>void)=>{listeners.add(fn);return()=>listeners.delete(fn);}},
    'standard:disconnect':{version:'1.0.0',disconnect:async()=>loseAccess()},
    'solana:signAndSendTransaction':{version:'1.0.0',supportedTransactionVersions:['legacy',0],signAndSendTransaction:async({transaction,chain}:{transaction:Uint8Array;chain:string})=>{if(!account.chains.includes(chain))throw new Error('Wrong chain');(window as any).__lastTransactionChain=chain;(window as any).__walletCalls=((window as any).__walletCalls??0)+1;if((window as any).__rejectTransaction)throw Object.assign(new Error('Transaction rejected by the wallet.'),{code:4001});(window as any).__transactions=((window as any).__transactions??0)+1;if((window as any).__sendThenFail)throw Object.assign(new Error('Request rejected: upstream RPC cancelled after timeout'),{code:-32603});if((window as any).__omitSignature)return [];if((window as any).__malformedSignature)return [{signature:'5'.repeat(88)}];return [{signature:new Uint8Array(await (window as any).__allowitTestSign(Array.from(transaction)))}];}},
    'solana:signMessage':{version:'1.0.0',signMessage:async({message}:{message:Uint8Array})=>{
     if((window as any).__signatureProviderError)throw {code:-32603,message:'Unexpected error'};
     if((window as any).__holdSignIn)await new Promise<void>(resolve=>{(window as any).__releaseSignIn=resolve;});
     if((window as any).__rejectSignature)throw Object.assign(new Error('Signature rejected by the wallet.'),{code:4001});
     return [{signedMessage:message,signature:new Uint8Array(await (window as any).__allowitTestSign(Array.from(message)))}];
    }},
   },
  };
  const register=(api:any)=>{if(!registered){api.register(wallet);registered=true;}};
  window.addEventListener('wallet-standard:app-ready',(e:any)=>register(e.detail));
  window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet',{detail:register}));
  (window as any).__changeTestAccount=loseAccess;
 },{raw:bytes,icon});
 return {publicKey};
}
