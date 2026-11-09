import {describe,it,expect} from 'vitest';
import {signAllocation,type AllocationIntent} from './allocation';
import {NETWORKS} from './networks';
describe('Mainnet allowance boundary',()=>{
 it('binds a custom Devnet mint to the server configuration',async()=>{
 const mint='37d8Upvk6ubJN4T5fXZ8D7PMH7K3b4n1XSuiQxG58FQA';
 const cfg={id:'solana:devnet' as const,label:'Devnet',mint,allocationEnabled:true};
 const intent={network:cfg.id,mint,owner:'owner',token:'USDC',delegate:mint} as AllocationIntent;
 await expect(signAllocation(intent,'owner',cfg)).rejects.toThrow('No Solana wallet is available');
 await expect(signAllocation({...intent,mint:'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'},'owner',cfg)).rejects.toThrow('does not match');
 });
 it('rejects a different delegate or network before contacting any wallet',async()=>{
 const cfg={...NETWORKS.find(n=>n.id==='solana:mainnet')!,allocationEnabled:true};const intent={owner:'owner',network:cfg.id,mint:cfg.mint,token:'USDC',delegate:'37d8Upvk6ubJN4T5fXZ8D7PMH7K3b4n1XSuiQxG58FQA'} as AllocationIntent;
 await expect(signAllocation(intent,'owner',cfg)).rejects.toThrow('does not match');
 await expect(signAllocation({...intent,network:'solana:devnet'},'owner',{...cfg,id:'solana:devnet'})).rejects.toThrow('token mint');
 intent.delegate='87fX2a7BbnbJJKu4orKh6KriX3USZz9L8t593S1PnYZL';await expect(signAllocation(intent,'owner',{...cfg,id:'solana:devnet'})).rejects.toThrow('does not match');
 });
});
