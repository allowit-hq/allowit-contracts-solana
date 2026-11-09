// Wallet adapter conformance, not native-wallet acceptance.
import {describe,it,expect} from 'vitest';
import {signChallenge} from './wallet';
import type {Wallet,WalletAccount} from '@wallet-standard/base';
const account={} as WalletAccount;
const wallet=(changed=false)=>({features:{'solana:signMessage':{signMessage:async({message}:{message:Uint8Array})=>[{signedMessage:changed?new Uint8Array([0]):message,signature:new Uint8Array(64)}]}}}) as unknown as Wallet;
describe('exact sign-in bytes',()=>{
 it('rejects wallets modifying the signed message',async()=>{await expect(signChallenge(wallet(true),account,'Sign in')).rejects.toThrow('changed');});
});
