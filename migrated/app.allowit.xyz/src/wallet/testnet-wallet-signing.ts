import type {Wallet,WalletAccount} from '@wallet-standard/base';
import type {SolanaSignTransactionFeature} from '@solana/wallet-standard-features';
import {
  address,assertIsSignatureBytes,getBase58Encoder,getBase58Decoder,
  getPublicKeyFromAddress,getTransactionDecoder,getTransactionEncoder,verifySignature,
  type Transaction,
} from '@solana/kit';

export interface PhantomSigningProvider {
  isPhantom?: boolean;
  publicKey?: {toBase58():string}|null;
  request(input:{method:'signTransaction';params:{message:string}}):Promise<unknown>;
}

// Sign only: the caller submits the verified bytes to its pinned Testnet RPC.
// Phantom's native request is needed when its Wallet Standard registration does
// not expose solana:signTransaction. It never receives any private signing key.
export async function signTestnetTransaction(
  wallet:Wallet,account:WalletAccount,transaction:Uint8Array,phantom?:PhantomSigningProvider,
):Promise<{transaction:Uint8Array;signature:string}>{
  const owner=address(account.address);
  const expected=getTransactionDecoder().decode(transaction);
  if(Object.keys(expected.signatures)[0]!==owner)throw new Error('Кошелёк не совпадает с плательщиком транзакции.');
  const checkAccount=()=>{
    if(!account.chains.includes('solana:testnet')||!wallet.accounts.some(item=>item.address===owner))throw new Error('Аккаунт кошелька изменился. Подключите его заново.');
  };
  checkAccount();
  const feature=wallet.features['solana:signTransaction'] as SolanaSignTransactionFeature['solana:signTransaction']|undefined;
  const signatureFromTransaction=(bytes:Uint8Array)=>{
    const signed=getTransactionDecoder().decode(bytes);
    if(signed.messageBytes.length!==expected.messageBytes.length||!signed.messageBytes.every((byte,index)=>byte===expected.messageBytes[index]))throw new Error('Кошелёк изменил транзакцию. Отправка остановлена.');
    return signed.signatures[owner];
  };
  let ownerSignature;
  if(feature?.supportedTransactionVersions.includes('legacy')&&account.features.includes('solana:signTransaction')){
    const [output]=await feature.signTransaction({account,chain:'solana:testnet',transaction});
    if(!output)throw new Error('Кошелёк не вернул подписанную транзакцию.');
    ownerSignature=signatureFromTransaction(output.signedTransaction);
  }else{
    if(wallet.name!=='Phantom'||!phantom?.isPhantom||phantom.publicKey?.toBase58()!==owner)throw new Error('Этот кошелёк не поддерживает отдельную подпись транзакции.');
    const output=await phantom.request({method:'signTransaction',params:{message:getBase58Decoder().decode(expected.messageBytes)}});
    if(!output||typeof output!=='object')throw new Error('Phantom не вернул подпись.');
    const result=output as {signature?:unknown;publicKey?:unknown;serialize?:(options:{requireAllSignatures:boolean;verifySignatures:boolean})=>Uint8Array};
    if(typeof result.serialize==='function'){
      ownerSignature=signatureFromTransaction(result.serialize({requireAllSignatures:false,verifySignatures:false}));
    }else{
      const returnedKey=typeof result.publicKey==='string'?result.publicKey:
        (result.publicKey as {toBase58?:()=>string}|undefined)?.toBase58?.();
      if(returnedKey!==owner)throw new Error('Phantom подписал другим аккаунтом. Отправка остановлена.');
      ownerSignature=typeof result.signature==='string'?getBase58Encoder().encode(result.signature):result.signature;
      if(!(ownerSignature instanceof Uint8Array))throw new Error('Phantom вернул неподдерживаемый формат подписи.');
    }
  }
  checkAccount();
  if(!ownerSignature)throw new Error('Подпись владельца отсутствует.');
  assertIsSignatureBytes(ownerSignature);
  // Preserve the mint signature; never accept changed instructions or signatures
  // for other accounts from a wallet's returned transaction.
  const signatures:Transaction['signatures']={...expected.signatures,[owner]:ownerSignature};
  for(const [signer,signature] of Object.entries(signatures)){
    if(!signature||!await verifySignature(await getPublicKeyFromAddress(address(signer)),signature,expected.messageBytes))throw new Error('Подпись транзакции недействительна. Отправка остановлена.');
  }
  return {transaction:new Uint8Array(getTransactionEncoder().encode({...expected,signatures})),signature:getBase58Decoder().decode(ownerSignature)};
}
