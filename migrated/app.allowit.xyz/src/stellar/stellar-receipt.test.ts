import {describe,it,expect} from 'vitest';
import {parseReceipt} from '../paysh/paysh-units';
import {requestLanes} from '../runtime/request-lanes';
import {receiptText,explorerTx} from '../policy/RequestLanes';
const signature='ab'.repeat(32),requestHash='cd'.repeat(32),asset='C'+'A'.repeat(55),recipient='GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const receipt={chain:'stellar',network:'stellar:testnet',signature,requestHash,invocationIndex:0,finalizedLedger:'123',result:'success',action:{type:'stellar-transfer',amountUnits:'12345678',asset,recipient}};
const run=(r:unknown=receipt,status='finalized')=>({status:status==='failed'?'failed':'confirmed',requestHash,signature,settlement:{status,signatures:[signature],receipts:[r]}} as Parameters<typeof requestLanes>[0]);
describe('Stellar transfer receipts in existing run lanes',()=>{
 it('shows finality only for a bound positive ledger receipt with exact asset units',()=>{
  const parsed=parseReceipt(receipt,'receipt');
  expect(requestLanes(run()).payment).toEqual({label:'Finalized',tone:'done'});
  expect(receiptText(parsed,{payment:{network:'stellar:testnet',symbol:'XLM',decimals:7,mint:asset},funding:null})).toContain('1.2345678 XLM');
  expect(explorerTx('stellar:testnet',signature)).toBe(`https://stellar.expert/explorer/testnet/tx/${signature}`);
  expect(requestLanes(run({...receipt,finalizedLedger:'0'})).payment.tone).toBe('unresolved');
  expect(requestLanes(run({...receipt,requestHash:'ef'.repeat(32)})).unreadable).toContain('identity');
  expect(requestLanes(run({...receipt,signature:'ef'.repeat(32)})).unreadable).toContain('identity');
 });
});
