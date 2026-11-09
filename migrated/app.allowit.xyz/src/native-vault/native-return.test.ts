import {describe,expect,it,vi} from 'vitest';
import {binding,owner,policy} from '../../tests/fixtures/devnet-vault';
import type {StateReply} from './native-api';
import type {NativeOwnerContext} from './native-owner-context';
import type {Operation,VaultState} from './native-contracts';
import {returnNativeBatch,returnNativeFunds} from './native-return';

const state:VaultState={...binding,abi:2,sourceBundle:policy.sourceBundle,policyArtifact:policy.policyArtifact,vaultId:policy.id,dailyLimit:'5000000',actionLimit:'1000000',spent:'10000',spentDay:'0',nonce:'1',revision:'0',instanceSlot:'19',approved:true,balance:'4990000'};
const close=(extra:Partial<Operation>={}):Operation=>({id:'return-a',method:'close',status:'uncertain',signature:'original-signature',signatures:['original-signature'],signedBytes:'original-proof',intent:'original-intent',transactionUrl:'',blockhash:'original-blockhash',lastValidBlockHeight:100,instanceSlot:'19',...extra});
function setup({closed=false,live=true,records=[] as Operation[],unsignedSetup=false}={}){
 let current=true,finalized=closed;
 const reply=():StateReply=>({state:finalized?null:live?state:null,binding,allowedServices:[],revocationStarted:true,operations:finalized?[{id:'setup',method:'deploy',status:'settled',signature:'setup-sig',finalizedSlot:19},{...close({status:'settled'}),finalizedSlot:20}]:live?[{id:'setup',method:'deploy',status:'settled',signature:'setup-sig',finalizedSlot:19}]:[]});
 const submit=vi.fn(async()=>close()),recover=vi.fn(async()=>{finalized=true;return close({status:'settled',finalizedSlot:20});}),replay=vi.fn(async()=>close());
 const ctx={current:()=>current,attachment:{policy,executionBinding:{owner}},api:{state:vi.fn(async()=>reply())},journal:{entries:vi.fn(async()=>records),read:vi.fn(async(key:string)=>unsignedSetup&&key==='preparing-deploy'?{id:'original-setup'}:null)},lifecycle:{recoverPending:vi.fn(async()=>true),submit,recover,replay}} as unknown as NativeOwnerContext;
 return {ctx,submit,recover,replay,setCurrent:(value:boolean)=>{current=value;},finalize:()=>{finalized=true;}};
}
const checks={checks:2,pause:async()=>{}};
describe('native returns in a bulk revocation',()=>{
 it('stops a multi-vault queue after refusal and retains the first finalized return on retry',async()=>{
  const first=setup({closed:true}),second=setup(),third=setup();
  second.submit.mockRejectedValueOnce(new Error('Wallet declined'));
  second.submit.mockImplementationOnce(async()=>{second.finalize();return close({status:'settled',finalizedSlot:20});});
  third.submit.mockImplementationOnce(async()=>{third.finalize();return close({status:'settled',finalizedSlot:20});});
  const policies=[{title:'First'},{title:'Second'},{title:'Third'}];
  const contexts=[first.ctx,second.ctx,third.ctx];
  const open=vi.fn(async(p:{title:string})=>contexts[policies.indexOf(p)]);
  const progress=vi.fn(),afterEach=vi.fn(async()=>{});
  await expect(returnNativeBatch(policies,{current:()=>true,open,progress,afterEach})).rejects.toThrow('Remaining USDC returned from 1 vault. Stopped at “Second”');
  expect(open).toHaveBeenCalledTimes(2);expect(first.submit).not.toHaveBeenCalled();expect(third.submit).not.toHaveBeenCalled();
  const result=await returnNativeBatch(policies,{current:()=>true,open,progress,afterEach});
  expect(result).toMatchObject({returned:3,unused:0,phase:'completed'});
  expect(first.submit).not.toHaveBeenCalled();expect(third.submit).toHaveBeenCalledTimes(1);
 });
 it('uses owner close with the exact current instance, never a displayed balance or arbitrary recipient',async()=>{
  const f=setup();
  await expect(returnNativeFunds(f.ctx,checks)).resolves.toBe('returned');
  expect(f.submit).toHaveBeenCalledExactlyOnceWith(policy,owner,'close',{instanceSlot:'19'},undefined,undefined);
  expect(f.recover).toHaveBeenCalledExactlyOnceWith('return-a',policy,owner);
 });
 it('recognizes a previous finalized return without preparing or signing again',async()=>{
  const f=setup({closed:true});
  await expect(returnNativeFunds(f.ctx,checks)).resolves.toBe('returned');
  expect(f.submit).not.toHaveBeenCalled();expect(f.replay).not.toHaveBeenCalled();
 });
 it('recovers an unresolved original close instead of replacing its proof',async()=>{
  const f=setup({records:[close()]});
  await expect(returnNativeFunds(f.ctx,checks)).resolves.toBe('returned');
  expect(f.replay).toHaveBeenCalledExactlyOnceWith('return-a',policy,owner);expect(f.submit).not.toHaveBeenCalled();
 });
});
