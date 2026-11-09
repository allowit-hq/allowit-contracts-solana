import {describe,expect,it} from 'vitest';
import {createHash} from 'node:crypto';
import {Buffer} from 'buffer';
import {Keypair} from '@solana/web3.js';
import {checkedRootAccess, type RootAccessResponse} from './delegate-root-access';
import {delegateSourceAccount} from './delegate-wallet-intent';
import type {DelegateConfig,DelegateGrant} from './delegate-contracts';

const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const owner=Keypair.generate().publicKey.toBase58(),delegate=Keypair.generate().publicKey.toBase58(),mint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
 const config:DelegateConfig={ready:true,network:'solana:mainnet',displayNetwork:'solana:mainnet',genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',mint,delegate,decimals:6,tokenProgram:'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'};
 const source='approved exact Rust',intent='Research only approved primary sources.',sourceHash=hash(source),sourceAccount=delegateSourceAccount(owner,mint);
 const commitment={version:1,grantId:'real-root',owner,network:config.network,genesisHash:config.genesisHash,mint,sourceTokenAccount:sourceAccount,delegate,sourceHash,irHash:'b'.repeat(64),expiresAt:4102444800,revision:2,policyId:'policy',intentHash:hash(intent),budgetUnits:'3000'};
 const bytes=JSON.stringify(commitment),commitmentHash=hash(bytes);
 const grant:DelegateGrant={id:commitment.grantId,owner,network:config.network,displayNetwork:config.displayNetwork,genesisHash:config.genesisHash,mint,delegate,sourceAccount,source,intent,sourceHash,irHash:commitment.irHash,memo:`allowit-grant-v1:${commitmentHash}`,commitmentHash,commitmentBytesBase64:Buffer.from(bytes).toString('base64'),budgetUnits:'3000',remainingUnits:'3000',reservedUnits:'0',spentUnits:'0',status:'active',expiresAt:commitment.expiresAt,revision:2,parentGrantId:null,policyId:'policy',children:[],receipts:[]};
 const token=`dlg1.${owner}.${grant.id}.rh1_${'a'.repeat(43)}`;
 const response:RootAccessResponse={grant,config,capability:token,grantId:grant.id};
 return {config,grant,token,response};
}
describe('exact root prompt access',()=>{
 it('rejects a token mixed from another owner or grant even when the returned grant is valid',async()=>{
  const f=fixture();for(const capability of [f.token.replace(f.grant.owner,Keypair.generate().publicKey.toBase58()),f.token.replace('.real-root.','.another-root.'),f.token.replace('rh1_','old_'),f.token+'x'])await expect(checkedRootAccess(f.config,f.grant,{...f.response,capability})).rejects.toThrow(/token/);
 });
 it('rejects a changed source, root identity, active status or ready network configuration',async()=>{
  const f=fixture();for(const response of [
   {...f.response,grantId:'other'}, {...f.response,grant:{...f.grant,parentGrantId:'parent'}},
   {...f.response,grant:{...f.grant,status:'revocation_pending' as const}}, {...f.response,grant:{...f.grant,source:'changed Rust'}},
   {...f.response,config:{...f.config,ready:false}}, {...f.response,config:{...f.config,delegate:Keypair.generate().publicKey.toBase58()}},
   {...f.response,config:{...f.config,ready:'false' as unknown as boolean}},
  ])await expect(checkedRootAccess(f.config,f.grant,response)).rejects.toThrow();
 });
 it('does not issue a root prompt for expired or stopped original authority',async()=>{
  const f=fixture();for(const grant of [{...f.grant,status:'revoked' as const},{...f.grant,expiresAt:1}])await expect(checkedRootAccess(f.config,grant,f.response)).rejects.toThrow();
 });
});
