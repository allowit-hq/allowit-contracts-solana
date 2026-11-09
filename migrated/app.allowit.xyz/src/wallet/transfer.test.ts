import {it,expect} from 'vitest';
import {signTransfer,type TransferIntent} from './transfer';

it('uses the reviewed Devnet mint and rejects substituted mints before signing',async()=>{
 const expected={owner:'owner',network:'solana:devnet' as const,mint:'37d8Upvk6ubJN4T5fXZ8D7PMH7K3b4n1XSuiQxG58FQA',recipient:'recipient',amount:'1'};
 const intent={...expected,token:'USDC',units:'1000000'} as TransferIntent;
 await expect(signTransfer(intent,expected)).rejects.toThrow('No Solana wallet is available');
 await expect(signTransfer({...intent,mint:'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'},expected)).rejects.toThrow('does not match');
 const mainnetMint='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
 await expect(signTransfer({...intent,mint:mainnetMint},{...expected,mint:mainnetMint})).rejects.toThrow('does not match this network');
});
