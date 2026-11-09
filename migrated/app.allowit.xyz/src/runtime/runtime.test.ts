import {describe, expect, it} from 'vitest';
import type {MicroPolicy} from '../micro/micro-contracts';
import {checkedChoice, DELEGATED_PROFILE, NATIVE_VAULT_PROFILE, fundingPath, handoffReady, isAllowanceWallet, isOwnerWallet, localLegacyRuntime, parsePolicyRuntime, parseRuntimeConfig, revocable, runtimeOf, walletChoices} from './runtime';

// Schema-shaped test fixtures only: no compiler or chain output is represented here.
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const contract = {kind: 'contract-wallet', profile: 'solana-paysh-v1', sourceProfiles: ['oracle'], operations: ['paysh::call'], networks: ['solana:testnet'], capabilities: {generate: true, providerCall: true, fund: true, withdraw: false, revoke: false, revise: false, fork: false, rename: true}};
const ownerWallet = {kind: 'owner-wallet', profile: 'solana-owner-signed', sourceProfiles: ['oracle'], operations: [], networks: ['solana:mainnet', 'solana:testnet', 'solana:devnet'], capabilities: {generate: true, providerCall: false, fund: true, withdraw: false, revoke: true, revise: true, fork: true, rename: true}};
const registry = (extra: Record<string, unknown> = {}) => ({wallets: [contract, ownerWallet], operations: [{function: 'paysh::call', services: ['airquality'], inputSchema: {}, settlement: 'native-settlement', delivery: 'paid-http'}], ...extra});
it('new Devnet policies fund a native vault, never a new delegated allowance',()=>{
  const delegated={...ownerWallet,profile:DELEGATED_PROFILE};
  const config=parseRuntimeConfig(registry({wallets:[ownerWallet,delegated,contract]}));
  expect(walletChoices(config,'solana:devnet').map(w=>w.profile)).toEqual([NATIVE_VAULT_PROFILE]);
  expect(()=>checkedChoice(config,'solana:devnet',{sourceProfile:'oracle',wallet:{kind:'owner-wallet',profile:DELEGATED_PROFILE}})).toThrow(/not available/);
  const choice={sourceProfile:'oracle',wallet:{kind:'owner-wallet' as const,profile:NATIVE_VAULT_PROFILE}};
  expect(checkedChoice(config,'solana:devnet',choice)).toBe(choice);
});
const policyRuntime = {
  sourceProfile: 'oracle', wallet: {kind: 'contract-wallet', profile: 'solana-paysh-v1'}, capabilities: {providerCall: true, fund: true, withdraw: false, revoke: false, revise: false, fork: false, rename: true},
  fundingAsset: {network: 'solana:testnet', symbol: 'Testnet SOL', decimals: 9}, paymentAsset: {network: 'solana:testnet', symbol: 'Testnet token', decimals: 6, mint: MINT}, operation: 'paysh::call', setup: null,
};
const ownerRuntime = {...policyRuntime, wallet: {kind: 'owner-wallet', profile: 'solana-owner-signed'}, capabilities: {providerCall: false, fund: true, withdraw: false, revoke: true, revise: true, fork: true, rename: true}, fundingAsset: {network: 'solana:devnet', symbol: 'USDC', decimals: 6}, paymentAsset: {network: 'solana:devnet', symbol: 'USDC', decimals: 6, mint: MINT}, operation: null};
const policy = (runtime?: unknown, network: MicroPolicy['network'] = 'solana:testnet') => ({network, runtime} as Pick<MicroPolicy, 'runtime' | 'network'>);

describe('wallet registry', () => {
  it('permits the missing legacy registry only in local development, never in a hosted build', () => {
    expect(localLegacyRuntime(true, '127.0.0.1')).toBe(true);
    expect(localLegacyRuntime(false, '127.0.0.1')).toBe(false);
    expect(localLegacyRuntime(true, 'allowit.vercel.app')).toBe(false);
  });
});

describe('policy runtime', () => {
  it('allows the agent skill for a contract wallet only after a finalized setup', () => {
    const active = {...policy(policyRuntime as never), status: 'active' as const};
    expect(handoffReady(active, null)).toBe(false);
    expect(handoffReady(active, {phase: 'signed'})).toBe(false);
    expect(handoffReady(active, {phase: 'finalized'})).toBe(false);
    const evidence = {status:'finalized',signature:'sig',policy:{id:'id',network:'solana:testnet',owner:'owner',policyAddress:'account'},chain:{initialized:true,policyAddress:'account',owner:'owner',solVault:'vault',finalizedSlot:'42'}};
    expect(handoffReady({...active,id:'id'}, {phase:'finalized',state:evidence},'owner')).toBe(true);
    expect(handoffReady({...active,id:'id'}, {phase:'finalized',state:evidence},'other')).toBe(false);
    for(const chain of [{...evidence.chain,finalizedSlot:'0'},{...evidence.chain,initialized:false},{...evidence.chain,policyAddress:'foreign'}])expect(handoffReady({...active,id:'id'}, {phase:'finalized',state:{...evidence,chain}})).toBe(false);
    expect(handoffReady({...active, runtime: {...policyRuntime, setup: {status: 'finalized'}} as never}, null)).toBe(false);
    expect(handoffReady({...active,id:'id', runtime: {...policyRuntime, setup: {status: 'finalized', signature: 'sig', policyAccount: 'acct'}} as never}, null)).toBe(false);
    expect(handoffReady({...active,id:'id',runtime:{...policyRuntime,setup:{state:evidence}} as never},null,'owner')).toBe(true);
    expect(handoffReady({...active, status: 'draft'}, {phase: 'finalized'})).toBe(false);
    expect(handoffReady({network: 'solana:devnet', runtime: undefined, status: 'active'}, null)).toBe(true);
  });
});

describe('funding mode', () => {
  const authorizationRuntime = {...ownerRuntime, fundingMode: 'authorization'};

  it('fails closed on an unknown mode or a mode the wallet kind does not use', () => {
    for (const [raw, network] of [
      [{...ownerRuntime, fundingMode: 'escrow'}, 'solana:devnet'],
      [{...ownerRuntime, fundingMode: 'deposit'}, 'solana:devnet'],
      [{...policyRuntime, fundingMode: 'authorization'}, 'solana:testnet'],
    ] as [unknown, MicroPolicy['network']][]) {
      const p = policy(raw as never, network);
      expect(runtimeOf(p).state, JSON.stringify(raw)).toBe('invalid');
      expect(fundingPath(p)).toBeNull();
      expect(isAllowanceWallet(p)).toBe(false);
    }
  });

  it('never routes an authorization policy to the allowance or reports it ready from an active status', () => {
    const p = {...policy(authorizationRuntime as never, 'solana:devnet'), status: 'active' as const};
    expect(isOwnerWallet(p)).toBe(true);
    expect(isAllowanceWallet(p)).toBe(false);
    expect(revocable(p)).toBe(false);
    expect(handoffReady(p, null, 'owner')).toBe(false);
    // The legacy owner-wallet rule is unchanged.
    expect(handoffReady({...policy(ownerRuntime as never, 'solana:devnet'), status: 'active'}, null)).toBe(true);
  });
});

it('admits only the exact Stellar transfer profile and current owner-bound installation',()=>{
 const network='stellar:testnet';const owner='GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
 const asset='C'+'A'.repeat(55);const sourceHash='ab'.repeat(32);const policyId='cd'.repeat(32);
 const capabilities={generate:true,providerCall:false,fund:true,withdraw:false,revoke:false,revise:false,fork:false,rename:false,typedIngress:['execution-request']};
 const wallet={kind:'owner-wallet',profile:'allowit-stellar-native-v1'};
 const config=parseRuntimeConfig({wallets:[{...wallet,sourceProfiles:['allowit-stellar-transfer-v1'],networks:[network],operations:['stellar::sep41_transfer'],capabilities}],operations:[{function:'stellar::sep41_transfer',services:[],ingressKind:'execution-request',requiresService:false,settlement:'stellar',delivery:'transfer'}]});
 expect(walletChoices(config,network)).toHaveLength(1);expect(walletChoices(config,'solana:testnet')).toHaveLength(0);
 const raw={sourceProfile:'allowit-stellar-transfer-v1',wallet,capabilities,fundingMode:'stellar-installed',operation:'stellar::sep41_transfer',fundingAsset:{network,symbol:'XLM',decimals:7},paymentAsset:{network,symbol:'XLM',decimals:7,mint:asset},providerCallRequirements:[],setup:{state:{status:'finalized'}},authorization:{state:'installed',policyId,owner,wallet:owner,network,sourceHash,moduleDigest:'ef'.repeat(32),route:'native',ledger:123}};
 const runtime=parsePolicyRuntime(raw,network);const p={runtime,network,status:'active',id:policyId,sourceHash} as MicroPolicy;
 expect(handoffReady(p,null,owner)).toBe(true);expect(handoffReady(p,null,'different-owner')).toBe(false);expect(handoffReady({...p,sourceHash:'ff'.repeat(32)},null,owner)).toBe(false);
 expect(()=>parsePolicyRuntime({...raw,sourceProfile:'oracle'},network)).toThrow();expect(()=>parsePolicyRuntime({...raw,operation:'stellar::other'},network)).toThrow();expect(()=>parsePolicyRuntime({...raw,wallet:{...wallet,profile:'solana-paysh-v1'}},network)).toThrow();
 expect(()=>parsePolicyRuntime({...raw,authorization:{...raw.authorization,network:'stellar:mainnet'}},network)).toThrow();
});
