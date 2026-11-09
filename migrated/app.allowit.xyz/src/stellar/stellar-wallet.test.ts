import {sha256} from '@noble/hashes/sha256';
import {canonicalApprovalJson} from '@allowit/stellar/stellar-wallet';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ed25519} from '@noble/curves/ed25519';
import {Asset, Networks} from '@stellar/stellar-sdk/base';
import {request} from '../api';
import * as freighter from '@stellar/freighter-api';
import {signInStellar, signStellarTransaction, stellarAccountKey, stellarMessageDigest, verifyStellarInstallation, STELLAR_NETWORKS} from '../vendors/stellar/stellar-wallet';
vi.mock('../api', () => ({request: vi.fn()}));
vi.mock('@stellar/freighter-api', () => {const api = {requestAccess: vi.fn(), getAddress: vi.fn(), getNetworkDetails: vi.fn(), signMessage: vi.fn(), signTransaction: vi.fn(), isConnected: vi.fn(), WatchWalletChanges: vi.fn()}; return {...api, default: api};});
const address = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';
const seed = new Uint8Array(32).fill(7);
const issued = new Date(Math.floor(Date.now()/1000)*1000).toISOString().replace('.000Z','Z');
const expiration = new Date(Date.parse(issued)+300_000).toISOString().replace('.000Z','Z');
const nonce = 'ab'.repeat(32);
const challenge = {id: nonce, message: `app.example wants you to sign in with your Stellar account:\n${address}\n\nSign in to AllowIt. This does not authorize spending or move funds.\n\nURI: https://app.example\nVersion: 1\nNonce: ${nonce}\nIssued At: ${issued}\nExpiration Time: ${expiration}`, address, origin: 'https://app.example', expiresAt: expiration};
const signature = () => btoa(String.fromCharCode(...ed25519.sign(stellarMessageDigest(challenge.message), seed)));
beforeEach(() => {
  vi.resetAllMocks(); vi.stubGlobal('location', new URL('https://app.example/'));
  vi.mocked(freighter.requestAccess).mockResolvedValue({address});
  vi.mocked(freighter.getAddress).mockResolvedValue({address});
  vi.mocked(freighter.getNetworkDetails).mockResolvedValue({network:'TESTNET',networkUrl:'https://example.invalid',networkPassphrase:STELLAR_NETWORKS['stellar:testnet'].passphrase});
  vi.mocked(freighter.signMessage).mockResolvedValue({signedMessage:signature(), signerAddress:address});
  vi.mocked(request).mockImplementation(async path => path==='auth/challenge' ? challenge : path==='auth/verify' ? {session:{address,network:'stellar'}} : {});
});
describe('Stellar wallet identity and signing', () => {
  it('rejects checksum, origin, network and raw-message substitutions before server verification', async () => {
    expect(()=>stellarAccountKey(address.slice(0,-1)+'A')).toThrow();
    vi.mocked(request).mockResolvedValue({...challenge,origin:'https://attacker.example'});
    await expect(signInStellar('stellar:testnet')).rejects.toThrow('another account or site');
    expect(freighter.signMessage).not.toHaveBeenCalled();
    vi.mocked(request).mockResolvedValue(challenge);
    vi.mocked(freighter.getNetworkDetails).mockResolvedValue({network:'PUBLIC',networkUrl:'https://example.invalid',networkPassphrase:STELLAR_NETWORKS['stellar:mainnet'].passphrase});
    await expect(signInStellar('stellar:testnet')).rejects.toThrow('Select Testnet');
    vi.mocked(freighter.getNetworkDetails).mockResolvedValue({network:'TESTNET',networkUrl:'https://example.invalid',networkPassphrase:STELLAR_NETWORKS['stellar:testnet'].passphrase});
    vi.mocked(freighter.signMessage).mockResolvedValue({signedMessage:btoa(String.fromCharCode(...ed25519.sign(new TextEncoder().encode(challenge.message),seed))),signerAddress:address});
    await expect(signInStellar('stellar:testnet')).rejects.toThrow('could not be verified');
    expect(request).not.toHaveBeenCalledWith('auth/verify',expect.anything());
  });
  it('rejects approval-domain, nonce, template, origin and timestamp substitutions before the wallet prompt', async () => {
    const bad = [
      {...challenge,message:'AllowIt Native policy approval v1\n{}'},
      {...challenge,id:'wrong'},
      {...challenge,message:challenge.message+'\nextra'},
      {...challenge,message:challenge.message.replace(nonce,'cd'.repeat(32))},
      {...challenge,message:challenge.message.replace('URI: https://app.example','URI: https://other.example')},
      {...challenge,message:challenge.message.replace(issued,'2099-01-01T00:00:00Z')},
      {...challenge,expiresAt:'2099-01-01T00:00:00Z'},
      {...challenge,message:challenge.message.replaceAll(issued,'2000-01-01T00:00:00Z').replaceAll(expiration,'2000-01-01T00:05:00Z'),expiresAt:'2000-01-01T00:05:00Z'},
      {...challenge,message:challenge.message.replace(issued,issued.replace('T',' '))},
    ];
    for (const value of bad) {
      vi.mocked(request).mockResolvedValue(value);
      await expect(signInStellar('stellar:testnet')).rejects.toThrow('Nothing was signed');
      expect(freighter.signMessage).not.toHaveBeenCalled();
      expect(vi.mocked(request).mock.calls.every(([path]) => path === 'auth/challenge')).toBe(true);
    }
  });
  it('rejects account changes and clears a returned session with the wrong rail', async () => {
    vi.mocked(freighter.getAddress).mockResolvedValue({address:'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'});
    await expect(signInStellar('stellar:testnet')).rejects.toThrow('account changed');
    vi.mocked(freighter.getAddress).mockResolvedValue({address});
    vi.mocked(request).mockImplementation(async path=>path==='auth/challenge'?challenge:path==='auth/verify'?{session:{address,network:'solana'}}:{});
    await expect(signInStellar('stellar:testnet')).rejects.toThrow('another account');
    expect(request).toHaveBeenCalledWith('auth/logout',{});
  });
  it('approves only the exact selected Native source, wallet, issuer and version', async () => {
    const binding={wallet:address,route:'native',moduleDigest:'33'.repeat(32),policyInstance:'44'.repeat(32),maxFeeStroops:100,assetIssuer:null};
    const policy={id:'policy',revision:3,network:'stellar:testnet',code:'use allowit::v1::prelude::*; async fn _execute(ctx: &Context) -> PolicyResult { Ok(()) }',sourceHash:'11'.repeat(32),irHash:'22'.repeat(32),mint:'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',token:'XLM',runtime:{instanceBinding:binding}};
    const payload={version:1,policyId:policy.id,revision:policy.revision,network:policy.network,wallet:address,route:binding.route,policyInstance:binding.policyInstance,source:policy.code,sourceHash:policy.sourceHash,irHash:policy.irHash,moduleDigest:binding.moduleDigest,asset:policy.mint,assetSymbol:policy.token,assetIssuer:null,maxFeeStroops:100};
    const approval=(p:Record<string,unknown>)=>({required:true,payload:p,method:'sep53',message:`AllowIt Native policy approval v1\n${JSON.stringify(Object.fromEntries(Object.keys(p).sort().map(k=>[k,p[k]])))}`});
    for(const change of [{version:2},{assetIssuer:address},{wallet:'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'},{source:'permissive source'},{maxFeeStroops:101},{authority:'all'}]){
      vi.mocked(freighter.signMessage).mockClear();vi.mocked(request).mockResolvedValue(approval({...payload,...change}));
      await expect(verifyStellarInstallation(policy,{address,network:'stellar',expiresAt:challenge.expiresAt})).rejects.toThrow('Nothing was signed');
      expect(freighter.signMessage).not.toHaveBeenCalled();
    }
    const exact=approval(payload);
    vi.mocked(request).mockResolvedValue({...exact,message:exact.message.replaceAll('&','\\u0026').replaceAll('>','\\u003e')});
    await expect(verifyStellarInstallation(policy,{address,network:'stellar',expiresAt:challenge.expiresAt})).rejects.toThrow('Nothing was signed');
    expect(freighter.signMessage).not.toHaveBeenCalled();
    vi.mocked(request).mockImplementation(async path=>path==='native/approval'?exact:{});
    vi.mocked(freighter.signMessage).mockResolvedValue({signedMessage:btoa(String.fromCharCode(...ed25519.sign(stellarMessageDigest(exact.message),seed))),signerAddress:address});
    await verifyStellarInstallation(policy,{address,network:'stellar',expiresAt:challenge.expiresAt});
    expect(request).toHaveBeenCalledWith('micro/allocation/confirm',expect.objectContaining({id:'policy',revision:3,stellarSourceApproval:[expect.objectContaining({signer:address})]}),{expectedOwner:`stellar:${address}`});
  });
  it('binds the payload issuer and exact asset contract even when the stored binding omits the issuer', async () => {
    const issuer = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';
    const native = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
    const issued = new Asset('XLM', issuer).contractId(Networks.TESTNET);
    const session = {address, network: 'stellar' as const, expiresAt: challenge.expiresAt};
    const base = {wallet: address, route: 'native', moduleDigest: '33'.repeat(32), policyInstance: '44'.repeat(32), maxFeeStroops: 100};
    const prepare = (binding: Record<string, unknown>, mint: string, assetIssuer: string | null, asset = mint) => {
      const payload = {version: 1, policyId: 'policy', revision: 3, network: 'stellar:testnet', wallet: address, route: 'native', policyInstance: base.policyInstance, source: 'source', sourceHash: '11'.repeat(32), irHash: '22'.repeat(32), moduleDigest: base.moduleDigest, asset, assetSymbol: 'XLM', assetIssuer, maxFeeStroops: 100};
      const message = `AllowIt Native policy approval v1\n${JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(k => [k, payload[k as keyof typeof payload]])))}`;
      vi.mocked(request).mockImplementation(async path => path === 'native/approval' ? {required: true, payload, method: 'sep53', message} : {});
      return {id: 'policy', revision: 3, network: 'stellar:testnet', code: 'source', sourceHash: '11'.repeat(32), irHash: '22'.repeat(32), mint, token: 'XLM', runtime: {instanceBinding: binding}};
    };
    // A binding without an issuer is native XLM, so a payload issuer is a substitution. Issued XLM needs its own contract.
    for (const [binding, mint, assetIssuer] of [[base, native, issuer], [{...base, assetIssuer: issuer}, issued, 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'], [{...base, assetIssuer: issuer}, native, issuer]] as const) {
      await expect(verifyStellarInstallation(prepare(binding, mint, assetIssuer), session)).rejects.toThrow('Nothing was signed');
    }
    expect(freighter.signMessage).not.toHaveBeenCalled();
    vi.mocked(freighter.signMessage).mockImplementation(async message => ({signedMessage: btoa(String.fromCharCode(...ed25519.sign(stellarMessageDigest(message), seed))), signerAddress: address}));
    await verifyStellarInstallation(prepare({...base, assetIssuer: issuer}, issued, issuer), session);
    expect(freighter.signMessage).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('micro/allocation/confirm', expect.objectContaining({id: 'policy', revision: 3, stellarSourceApproval: [expect.objectContaining({signer: address})]}), {expectedOwner: `stellar:${address}`});
  });
  it('stops a policy continuation when its owner context changes during preparation', async()=>{
    let current=true;
    vi.mocked(request).mockImplementation(async()=>{current=false;return {required:false};});
    await expect(verifyStellarInstallation({id:'policy',revision:3},{address,network:'stellar',expiresAt:challenge.expiresAt},()=>current)).rejects.toThrow('changed');
    expect(freighter.signMessage).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('signs canonical pubnet authentication with the public passphrase and unchanged challenge', async()=>{
    vi.mocked(freighter.getNetworkDetails).mockResolvedValue({network:'PUBLIC',networkUrl:'https://example.invalid',networkPassphrase:STELLAR_NETWORKS['stellar:pubnet'].passphrase});
    await expect(signInStellar('stellar:pubnet')).resolves.toMatchObject({address,network:'stellar'});
    expect(freighter.signMessage).toHaveBeenCalledWith(challenge.message,{address,networkPassphrase:STELLAR_NETWORKS['stellar:mainnet'].passphrase});
  });
  it('signs the current server portable v1 twenty-field approval and rejects nested binding substitutions', async () => {
    const hash = (value: string) => Array.from(sha256(new TextEncoder().encode(value)), b => b.toString(16).padStart(2,'0')).join('');
    const code = 'use allowit::v1::prelude::*; async fn _execute(ctx: &Context) -> PolicyResult { Ok(()) }';
    const sourceHash = hash(code), params = {destination: {Address: address}, payment_limit: {Int: '10000000'}};
    const portable = {language:'allowit-portable-v1', tier:'custom', rules:[], params, paramsHash:hash(canonicalApprovalJson(params)), sourceHash};
    const moduleDigest = hash(canonicalApprovalJson({language:portable.language,tier:portable.tier,rules:portable.rules,sourceHash,paramsHash:portable.paramsHash}));
    const binding = {wallet:address,route:'native',moduleDigest,policyInstance:'44'.repeat(32),maxFeeStroops:100,assetIssuer:null,language:portable.language,portable};
    const policy = {id:'portable',revision:3,network:'stellar:testnet',code,sourceHash,irHash:'22'.repeat(32),mint:'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',token:'XLM',runtime:{instanceBinding:binding}};
    // This is the exact twenty-field wire schema produced by server source_approval_message.
    const payload = {version:1,policyId:policy.id,revision:3,network:policy.network,wallet:address,route:'native',policyInstance:binding.policyInstance,source:code,sourceHash,irHash:policy.irHash,moduleDigest,asset:policy.mint,assetSymbol:'XLM',assetIssuer:null,maxFeeStroops:100,language:portable.language,tier:portable.tier,rules:portable.rules,params,paramsHash:portable.paramsHash};
    const approval = (p: Record<string,unknown>) => ({required:true,payload:p,method:'sep53',message:`AllowIt Native policy approval v1\n${canonicalApprovalJson(p)}`});
    expect(Object.keys(payload)).toHaveLength(20);
    const owner = {address,network:'stellar' as const,expiresAt:challenge.expiresAt};
    for (const patch of [{params:{...params,payment_limit:{Int:'20000000'}}},{rules:['allowit::transfer']},{tier:'standard'},{paramsHash:'00'.repeat(32)},{language:'legacy'},{extra:'unknown'}]) {
      vi.mocked(request).mockResolvedValue(approval({...payload,...patch}));
      await expect(verifyStellarInstallation(policy,owner)).rejects.toThrow('Nothing was signed');
      expect(freighter.signMessage).not.toHaveBeenCalled();
    }
    // An old fifteen-field approval cannot silently drop the current portable consent identity.
    const legacy = {...payload} as Record<string,unknown>;
    for (const key of ['language','tier','rules','params','paramsHash']) delete legacy[key];
    vi.mocked(request).mockResolvedValue(approval(legacy));
    await expect(verifyStellarInstallation(policy,owner)).rejects.toThrow('Nothing was signed');
    vi.mocked(request).mockImplementation(async path => path === 'native/approval' ? approval(payload) : {});
    vi.mocked(freighter.signMessage).mockImplementation(async message => ({signedMessage:btoa(String.fromCharCode(...ed25519.sign(stellarMessageDigest(message),seed))),signerAddress:address}));
    await verifyStellarInstallation(policy,owner);
    expect(freighter.signMessage).toHaveBeenCalledExactlyOnceWith(approval(payload).message,{address,networkPassphrase:STELLAR_NETWORKS['stellar:testnet'].passphrase});
    expect(request).toHaveBeenLastCalledWith('micro/allocation/confirm',expect.objectContaining({id:policy.id,revision:3,stellarSourceApproval:[expect.objectContaining({signer:address})]}),{expectedOwner:`stellar:${address}`});
  });
  it('rejects a network change while the wallet signs a transaction',async()=>{
    vi.mocked(freighter.signTransaction).mockResolvedValue({signedTxXdr:'c2lnbmVk',signerAddress:address});
    vi.mocked(freighter.getNetworkDetails).mockResolvedValueOnce({network:'TESTNET',networkUrl:'https://example.invalid',networkPassphrase:STELLAR_NETWORKS['stellar:testnet'].passphrase}).mockResolvedValueOnce({network:'PUBLIC',networkUrl:'https://example.invalid',networkPassphrase:STELLAR_NETWORKS['stellar:mainnet'].passphrase});
    await expect(signStellarTransaction('eGRy',address,'stellar:testnet')).rejects.toThrow('Select Testnet');
    expect(request).not.toHaveBeenCalled();
  });
});
