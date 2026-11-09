import {describe,it,expect,vi} from 'vitest';
import type {Wallet,WalletAccount} from '@wallet-standard/base';
import {
  blockhash,compileTransaction,createTransactionMessage,generateKeyPairSigner,
  getBase58Decoder,getTransactionDecoder,getTransactionEncoder,partiallySignTransaction,
  pipe,setTransactionMessageFeePayer,setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
} from '@solana/kit';
import {getCreateAccountInstruction} from '@solana-program/system';
import {TOKEN_PROGRAM_ADDRESS} from '@solana-program/token';
import {signTestnetTransaction,type PhantomSigningProvider} from './testnet-wallet-signing';

async function fixture(){
  const owner=await generateKeyPairSigner();
  const mint=await generateKeyPairSigner();
  const account={address:owner.address,publicKey:new Uint8Array(),chains:['solana:testnet'],features:['solana:signTransaction']} satisfies WalletAccount;
  const message=pipe(createTransactionMessage({version:'legacy'}),
    tx=>setTransactionMessageFeePayer(owner.address,tx),
    tx=>setTransactionMessageLifetimeUsingBlockhash({blockhash:blockhash('11111111111111111111111111111111'),lastValidBlockHeight:100n},tx),
    tx=>appendTransactionMessageInstructions([getCreateAccountInstruction({payer:owner,newAccount:mint,lamports:1_000_000n,space:82,programAddress:TOKEN_PROGRAM_ADDRESS})],tx));
  const partial=await partiallySignTransaction([mint.keyPair],compileTransaction(message));
  const fullySigned=await partiallySignTransaction([owner.keyPair],partial);
  const transaction=new Uint8Array(getTransactionEncoder().encode(partial));
  const signTransaction=vi.fn(async()=>[{signedTransaction:new Uint8Array(getTransactionEncoder().encode(fullySigned))}]);
  const wallet={name:'Phantom',version:'1.0.0',icon:'data:image/svg+xml;base64,',chains:['solana:testnet'],accounts:[account],features:{'solana:signTransaction':{version:'1.0.0',supportedTransactionVersions:['legacy'],signTransaction}}} satisfies Wallet;
  const request=vi.fn(async()=>({publicKey:owner.address,signature:getBase58Decoder().decode(fullySigned.signatures[owner.address]!)}));
  const phantom={isPhantom:true,publicKey:{toBase58:()=>owner.address},request} satisfies PhantomSigningProvider;
  return {owner,mint,account,wallet,partial,fullySigned,transaction,signTransaction,phantom,request};
}

describe('Testnet wallet signing',()=>{
  it('verifies both signatures and preserves the original mint co-signature',async()=>{
    const f=await fixture();
    const signed=await signTestnetTransaction(f.wallet,f.account,f.transaction);
    expect(getTransactionDecoder().decode(signed.transaction).signatures).toEqual(f.fullySigned.signatures);
    expect(f.signTransaction).toHaveBeenCalledWith({account:f.account,chain:'solana:testnet',transaction:f.transaction});
  });
  it('uses the Phantom sign-only request when the standard feature is absent',async()=>{
    const f=await fixture();
    const signed=await signTestnetTransaction({...f.wallet,features:{}},f.account,f.transaction,f.phantom);
    expect(signed.transaction).toEqual(new Uint8Array(getTransactionEncoder().encode(f.fullySigned)));
    expect(f.request).toHaveBeenCalledWith({method:'signTransaction',params:{message:getBase58Decoder().decode(f.partial.messageBytes)}});
  });
  it('rejects a wallet that changes the transaction message',async()=>{
    const f=await fixture();
    const altered=new Uint8Array(getTransactionEncoder().encode(f.fullySigned));
    altered[altered.length-1]^=1;
    f.signTransaction.mockResolvedValue([{signedTransaction:altered}]);
    await expect(signTestnetTransaction(f.wallet,f.account,f.transaction)).rejects.toThrow('изменил транзакцию');
  });
  it('rejects invalid signatures even if they have the right length',async()=>{
    const f=await fixture();
    f.request.mockResolvedValue({publicKey:f.owner.address,signature:getBase58Decoder().decode(new Uint8Array(64).fill(1))});
    await expect(signTestnetTransaction({...f.wallet,features:{}},f.account,f.transaction,f.phantom)).rejects.toThrow('недействительна');
  });
  it('does not retry through another signing API after the user rejects',async()=>{
    const f=await fixture();
    f.signTransaction.mockRejectedValue(new Error('User rejected'));
    await expect(signTestnetTransaction(f.wallet,f.account,f.transaction,f.phantom)).rejects.toThrow('User rejected');
    expect(f.request).not.toHaveBeenCalled();
  });
  it('rejects account changes during approval',async()=>{
    const f=await fixture();
    f.signTransaction.mockImplementation(async()=>{f.wallet.accounts=[];return [{signedTransaction:new Uint8Array(getTransactionEncoder().encode(f.fullySigned))}]});
    await expect(signTestnetTransaction(f.wallet,f.account,f.transaction)).rejects.toThrow('Аккаунт кошелька изменился');
  });
});
