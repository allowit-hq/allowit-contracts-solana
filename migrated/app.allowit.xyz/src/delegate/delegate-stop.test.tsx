import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {ReactElement} from 'react';
import type {MicroController} from '../micro/micro-contracts';
import type {DelegateGrant} from './delegate-contracts';
import type {DelegateWorkspace} from './useDelegateWorkspace';

const h=vi.hoisted(()=>({index:0,live:true,states:[] as unknown[],seed:undefined as unknown,refs:[] as {current:unknown}[],request:vi.fn()}));
vi.mock('react',()=>({
 useCallback:(fn:unknown)=>fn,useEffect:()=>{},useId:()=> 'stop-test',useRef:(current:unknown)=>{const ref={current};h.refs.push(ref);return ref;},
 useState:(initial:unknown)=>{const index=h.index++;if(!(index in h.states))h.states[index]=index===0&&h.seed!==undefined?h.seed:typeof initial==='function'?(initial as ()=>unknown)():initial;return [h.states[index],(value:unknown)=>{h.states[index]=typeof value==='function'?(value as (previous:unknown)=>unknown)(h.states[index]):value;}];},
}));
vi.mock('../native-vault/native-vault-list',async importOriginal=>({...await importOriginal<typeof import('../native-vault/native-vault-list')>(),nativeVaultChanged:vi.fn()}));
vi.mock('../api',()=>({request:h.request,ApiError:class extends Error{status=500;}}));
vi.mock('./delegate-wallet-intent',()=>({checkedDelegateConfig:vi.fn(value=>value),checkedDelegateTransaction:vi.fn(),verifyDelegateGrant:vi.fn(async()=>{}),signDelegateOwner:vi.fn()}));
vi.mock('./delegate-proof',()=>({archiveExpiredDelegateProof:vi.fn(()=>false),delegateProofArchived:vi.fn(()=>false),checkDelegateProofNotArchived:vi.fn(),checkDelegateProofStorage:vi.fn(),readDelegateProof:vi.fn(()=>null),saveDelegateProof:vi.fn(),retainDelegateProof:vi.fn(async()=>{}),projectDelegatePreparation:vi.fn(value=>value)}));
import useDelegateWorkspace from './useDelegateWorkspace';
import RevokePolicies from '../policy/RevokePolicies';
import {archiveExpiredDelegateProof} from './delegate-proof';

const owner='owner';
const grant=(id:string)=>({id,owner,policyId:'policy',revision:1,source:'original',intent:'research',commitmentHash:'c'.repeat(64),parentGrantId:null,status:'draft',children:[],receipts:[],displayNetwork:'solana:mainnet'} as unknown as DelegateGrant);
const controller=()=>({auth:{session:{address:owner,network:'solana:mainnet',expiresAt:'future'},busy:null,loading:false},policies:[],selected:null,network:'solana:mainnet',runtimeConfig:null,networks:[],busy:null,loading:false,runExternal:async(_name:string,work:(current:()=>boolean)=>Promise<void>)=>{await work(()=>h.live);return true;},revokeAll:async(before:((current:()=>boolean)=>Promise<void>)|undefined)=>{await before?.(()=>true);return true;}} as unknown as MicroController);
function workspace(grants:DelegateGrant[],extra:Record<string,unknown>={}){
 const sessionKey=JSON.stringify([`solana:mainnet:${owner}`,'future']);
 h.seed={sessionKey,configNetwork:'solana:mainnet',grants,config:null,paymentReady:false,loaded:true,error:null,requests:[],requestError:null,...extra};
 return useDelegateWorkspace(controller(),vi.fn());
}
const terminal=(g:DelegateGrant)=>({grant:{...g,status:'revoked'},offchainStopped:true,allowanceAbsent:true,pending:false,cleanupPending:false});
function buttons(value:unknown):ReactElement<Record<string,unknown>>[]{
 if(Array.isArray(value))return value.flatMap(buttons);
 if(!value||typeof value!=='object'||!('props' in value))return [];
 const element=value as ReactElement<Record<string,unknown>>;
 return [...(element.type==='button'?[element]:[]),...buttons(element.props.children)];
}
beforeEach(()=>{h.index=0;h.live=true;h.states=[];h.seed=undefined;h.refs=[];h.request.mockReset();vi.mocked(archiveExpiredDelegateProof).mockReset().mockResolvedValue(false);});

describe('Stop all delegated grants',()=>{
 it('does not report unread or failed grant lists as complete',async()=>{
  const g=grant('one'),w=workspace([g],{loaded:false,error:'Grant list unreadable'});
  const outcome=await w.stopAllWithin(()=>true);
  expect(outcome).toMatchObject({failures:expect.arrayContaining([expect.any(String)]),unresolvedGrantIds:['one']});
 });
 it('does not resolve an incomplete or contradictory no-transaction response',async()=>{
  const grants=[grant('one'),grant('two')],w=workspace(grants);
  h.request.mockResolvedValueOnce({offchainStopped:true,allowanceAbsent:true}).mockResolvedValueOnce({...terminal(grants[1]),cleanupPending:true});
  expect(await w.stopAllWithin(()=>true)).toEqual({failures:[],unresolvedGrantIds:['one','two']});
 });
});

describe('Stop all dialog completion',()=>{
 it('installs native and legacy server barriers before waiting for delegated archival',async()=>{
  const order:string[]=[],nativeId='a'.repeat(64);let release!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});
  const c={...controller(),policies:[{id:'native',title:'Native',revision:1,status:'active',network:'solana:devnet',nativeExecution:{policyId:nativeId}},{id:'legacy',title:'Legacy',revision:1,status:'active',network:'solana:devnet',mint:'mint'}],refresh:vi.fn(async()=>{order.push('wallet-cleanup');throw new Error('Fixture ends before wallet cleanup');})} as unknown as MicroController;
  const delegated={reviews:{},proof:()=>null,roots:[],retained:[grant('one')],loaded:true,error:null,pending:null,stopAllWithin:vi.fn(async(_current:()=>boolean,afterStops:Array<()=>Promise<void>>)=>{order.push('delegated-stop');afterStops.push(async()=>{order.push('archive');await held;});return {failures:[],unresolvedGrantIds:['one']};})} as unknown as DelegateWorkspace;
  h.request.mockImplementation(async(path:string)=>{order.push(path);return path==='native/stop-all'?{stopped:true,revocationStarted:true,policyIds:[nativeId]}:{};});
  const tree=RevokePolicies({c,delegated}),submit=buttons(tree).filter(button=>button.props.children==='Stop all policies').at(-1)!;
  (submit.props.onClick as ()=>void)();
  await vi.waitFor(()=>expect(order).toContain('archive'));
  expect(order).toEqual(['delegated-stop','native/stop-all','micro/allocation/cancel','archive']);expect(c.refresh).not.toHaveBeenCalled();
  release();await vi.waitFor(()=>expect(c.refresh).toHaveBeenCalledTimes(1));
  await vi.waitFor(()=>expect(h.states[2]).toBe(false));
 });
});
