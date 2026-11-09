import {ed25519} from '@noble/curves/ed25519';
import {researchSource, researchQuestions} from './fixtures/research-policy';
import type {OwnerRequest} from '../src/owner/owner-requests';
import {expect, type Page} from '@playwright/test';
import {Buffer} from 'node:buffer';
import {Transaction} from '@solana/web3.js';
import release from './fixtures/native-release.json' with {type: 'json'};
import {binding, config, executor, owner, ownerKeypair, policy, prepared, projectedSource, projectedShortSource, projectedX402Source, recipientWallet, x402Service} from './fixtures/devnet-vault';
/** The owner's registered agent: its public key is the fixture executor. */
const AGENT_ID = 'fixture-agent';
import {recipientTokenAccount} from '../src/native-vault/native-recipient';
import {base58} from '../src/native-vault/native-wallet-intent';
import {executionBinding} from '../src/native-vault/native-bound';
import type {MicroPolicy} from '../src/micro/micro-contracts';
import {type Prepared} from '../src/native-vault/native-contracts';

export const selected: MicroPolicy = {
  id: 'exact-quicknode-policy', title: 'QuickNode Devnet policy', revision: 1, sourceHash: '91'.repeat(32), irHash: '92'.repeat(32),
  network: 'solana:devnet', language: 'allowit-rust-v1', status: 'draft', limit: '', token: 'USDC', mint: config.mint,
  fundingRequest: {amount: '5', token: 'USDC'}, originalIntent: 'QuickNode RPC only; recipient fixed, daily 5, per action 1 USDC.',
  ...projectedSource(), explanation: '', calls: [], functionHelp: [], requests: [], turns: [], activity: [], spentUnits: 0,
  createdAt: '2026-10-16T00:00:00Z', updatedAt: '2026-10-16T00:00:00Z',
};
export async function fixture(page: Page, options: {shortPolicy?: boolean; deny?: boolean; verify?: boolean; chain?: string; noFinality?: boolean; changedRecipient?: boolean; legacy?: boolean; missingRecipient?: boolean; research?: boolean; deferredFinality?: boolean; orphanedService?: boolean; noX402Service?: boolean; returnFunds?: boolean; deferredReturnFinality?: boolean; missingFunding?: boolean; noAgent?: boolean} = {}) {
  let selectedPolicy = options.shortPolicy ? {...selected,...projectedShortSource(),title:'Short payment policy',fundingRequest:undefined,originalIntent:'Limit each payment to 10 USDC.'} : options.research ? {...selected,...researchSource(),title:'Research Primary Evidence Policy',fundingRequest:{amount:'10',token:'USDC'}} : options.missingRecipient ? {...selected, code: selected.code.replace(/.*allowit::require_recipient.*\n/, ''), workflow: selected.workflow.filter(node => node.name !== 'require_recipient')} : selected;
  let serviceBase = {code: selectedPolicy.code, workflow: selectedPolicy.workflow};
  if (options.orphanedService) selectedPolicy = {...selectedPolicy, ...projectedX402Source(serviceBase)};
  if (options.missingFunding) {const {fundingRequest: _omitted, ...rest} = selectedPolicy; selectedPolicy = rest;}
  let nativePolicy = options.shortPolicy ? {...policy,dailyLimit:'10',actionLimit:'10'} : options.research ? {...policy,dailyLimit:'10',semanticRequired:true} : policy;
  let funding = options.research || options.shortPolicy ? '10' : '5';
  const microUnits = (value: string) => BigInt(Math.round(Number(value) * 1e6));
  const fundingUnits = () => microUnits(funding);
  // A smaller deposit narrows the vault's daily and per-action limits, as native bind does.
  const sourceActionLimit = nativePolicy.actionLimit;
  const actionLimit = () => (fundingUnits() < microUnits(sourceActionLimit) ? funding : sourceActionLimit);
  const ownerRequests:OwnerRequest[]=[];
  const decisions=new Map<string,{item:OwnerRequest;decision:string;note:string;message:string}>();
  const purchases=new Map<string,{input:string;status:string;amount:string;question:number;counted:boolean}>();
  const tierCounts=new Map<number,number>();
  let hasX402Service = options.orphanedService === true;
  const boundX402 = {...x402Service, tokenAccount: recipientTokenAccount(x402Service.recipient, config.mint)};
  const b = {returnFinalityReady: !options.deferredReturnFinality, expireClose: false, returnedUnits: 0n, withdrawnUnits: 0n, closed: false, finalityReady: !options.deferredFinality, failImport: false, recoveries: 0, messageSigns:0, spendCount:0, totalUnits:0n, questionMode:false, dropAnswer:false, signs: 0, bound: options.legacy === true, agentBound: false, agentRegistered: options.noAgent !== true, cancelled: false, nonRevocable: false, setupReady: true, formerBackend: false, stopFailure: false, approved: false, exists: false, revocationStarted: false, dropSubmit: false, offline: false, holdState: false, heldState: null as (() => Promise<void>) | null, calls: [] as string[], unexpected: [] as string[], ops: new Map<string, {prepared: Prepared; signedBytes?: string; signature?: string; status: string; method: string; amount?: string; finalizedSlot?: number}>()};
  // What the vault holds now: its funding less settled spends and owner withdrawals.
  const balanceUnits = () => fundingUnits() - b.totalUnits - b.withdrawnUnits;
  const dynamicMode = () => !options.legacy && !hasX402Service && !selectedPolicy.workflow.some(n => n.kind === 'function' && n.name === 'require_recipient') ? {recipientMode: 'any-wallet' as const, recipientMint: config.mint} : {};
  const bound = () => ({...executionBinding(selectedPolicy, owner), ...dynamicMode()});
  const recipientBinding = () => options.legacy || dynamicMode().recipientMode ? undefined : {kind: 'wallet-ata' as const, wallet: recipientWallet, tokenAccount: recipientTokenAccount(recipientWallet, config.mint), mint: config.mint, network: config.network};
  const envelope = () => ({recipientBinding: recipientBinding(), ...dynamicMode(), ...(hasX402Service ? {x402Service: boundX402} : {}), policy:nativePolicy, executionPolicyId: selectedPolicy.id, selectedId: policy.id, executionBinding: bound(), initialFunding: {amount: funding, token: 'USDC', mint: config.mint}, paymentKind: 'direct-token-transfer', deliveryAttested: false, ...(b.agentBound ? {executor} : {})});
  const publicOp = (id: string, op: typeof b.ops extends Map<string, infer T> ? T : never) => ({id, method: op.method, policyId: policy.id, status: op.status, signature: op.signature, instanceSlot: op.prepared.operation.instanceSlot, finalizedSlot: options.noFinality ? undefined : op.finalizedSlot, ...(!op.signedBytes && op.method === 'close' && b.expireClose ? {blockhashExpired: true, additionalOwnerOperationAllowed: true} : {})});
  const closeVault = () => {if (!b.closed) b.returnedUnits = balanceUnits(); b.closed = true; b.exists = false; b.approved = false;};
  const credited = new Set<string>();
  const withdrawn = (op: {signature?: string; amount?: string}) => {if (op.signature && !credited.has(op.signature)) {credited.add(op.signature); b.withdrawnUnits += BigInt(Math.round(Number(op.amount) * 1e6));}};
  await page.exposeFunction('__nativeFixtureSign', (raw: number[]) => {const tx = Transaction.from(Buffer.from(raw)); tx.sign(ownerKeypair); b.signs++; return Array.from(tx.serialize());});
  await page.exposeFunction('__nativeFixtureMessage', (raw:number[])=>{b.messageSigns++;return Array.from(ed25519.sign(new Uint8Array(raw),ownerKeypair.secretKey.slice(0,32)));});
  await page.addInitScript(({address, publicKey, chain}) => {
    localStorage.setItem('allowit.network', 'solana:devnet');
    localStorage.setItem('allowit.wallet', 'Native policy fixture');
    const account = {address, publicKey: new Uint8Array(publicKey), chains: [chain], features: ['solana:signMessage', 'solana:signTransaction']};
    const wallet = {version: '1.0.0', name: 'Native policy fixture', icon: 'data:image/svg+xml;base64,PHN2Zy8+', chains: [chain], accounts: [account], features: {
      'standard:connect': {version: '1.0.0', connect: async () => ({accounts: [account]})},
      'standard:events': {version: '1.0.0', on: () => () => {}},
      'solana:signMessage': {version: '1.0.0', signMessage: async ({message}:{message:Uint8Array}) => [{signedMessage:message,signature:new Uint8Array(await (window as unknown as {__nativeFixtureMessage:(v:number[])=>Promise<number[]>}).__nativeFixtureMessage(Array.from(message)))}]},
      'solana:signTransaction': {version: '1.0.0', supportedTransactionVersions: ['legacy'], signTransaction: async ({transaction, chain: requested}: {transaction: Uint8Array; chain: string}) => {
        if (requested !== 'solana:devnet') throw new Error('Wrong chain');
        if ((window as unknown as {__nativeDecline?: boolean}).__nativeDecline) {(window as unknown as {__nativeDecline?: boolean}).__nativeDecline = false; throw {code: 4001};}
        return [{signedTransaction: new Uint8Array(await (window as unknown as {__nativeFixtureSign: (v: number[]) => Promise<number[]>}).__nativeFixtureSign(Array.from(transaction)))}];
      }},
      'solana:signAndSendTransaction': {version: '1.0.0', supportedTransactionVersions: ['legacy'], signAndSendTransaction: async () => {throw new Error('Owner broadcast is forbidden');}},
    }};
    let registered = false;
    const register = (api: {register: (w: unknown) => void}) => {if (!registered) {registered = true; api.register(wallet);}};
    window.addEventListener('wallet-standard:app-ready', event => register((event as CustomEvent).detail));
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', {detail: register}));
  }, {address: owner, publicKey: Array.from(ownerKeypair.publicKey.toBytes()), chain: options.chain ?? 'solana:devnet'});
  await page.route('https://api.devnet.solana.com/**', () => {throw new Error('No fixture RPC allowed');});
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method(), input = method === 'POST' ? request.postDataJSON() : {};
    b.calls.push(method + ' ' + path);
    // This fixture models the older native backend, before delegated wallets.
    // Owner-wide recovery probes are read-only; writes and every other route remain strict.
    if (method === 'GET' && ['/api/delegate/config', '/api/delegate/grants', '/api/delegate/requests'].includes(path)) {
      return route.fulfill({status: 404, json: {error: 'Endpoint not found.'}});
    }
    if (path === '/api/session') return route.fulfill({json: {session: {address: owner, network: 'solana', expiresAt: '2099-01-01T00:00:00Z'}}});
    if (path === '/api/health') return route.fulfill({json: {status: 'ok', agentRunsAvailable: false}});
    if (path === '/api/networks') return route.fulfill({json: {networks: [{id: 'solana:devnet', label: 'Devnet', mint: config.mint, allocationEnabled: true}]}});
    // The agent registers only its own public key, after the owner issued its capability.
    if (path === '/api/agents') return route.fulfill({json: {agents: [{id: AGENT_ID, name: 'Agent', ...(b.agentRegistered ? {publicKey: executor, network: 'solana:devnet'} : {})}]}});
    if (path === '/api/agents/token') {expect(input).toEqual({name: 'Agent'}); return route.fulfill({json: {agent: {id: AGENT_ID, name: 'Agent'}, token: 'agent.fixture-token'}});}
    if (path === '/api/micro/runtime') return route.fulfill({json: {wallets: [{kind: 'owner-wallet', profile: 'solana-owner-signed', sourceProfiles: ['oracle'], operations: [], networks: ['solana:devnet'], capabilities: {generate: true, providerCall: false, fund: true, withdraw: false, revoke: true, revise: true, fork: true, rename: true}}], operations: []}});
    if (path === '/api/micro/policies' && method === 'GET') return route.fulfill({json: {policies: [{...selectedPolicy, status: b.cancelled ? 'cancelled' : 'draft', ...(b.nonRevocable ? {runtime: {sourceProfile: 'oracle', wallet: {kind: 'owner-wallet', profile: 'solana-owner-signed'}, capabilities: {providerCall: false, fund: true, withdraw: false, revoke: false, revise: true, fork: true, rename: true}, fundingAsset: {network: 'solana:devnet', symbol: 'USDC', decimals: 6}, paymentAsset: {network: 'solana:devnet', symbol: 'USDC', decimals: 6, mint: config.mint}, operation: null, setup: null}} : {}), ...(b.bound ? {nativeExecution: {policyId: policy.id, revocationStarted: b.revocationStarted}} : {})}], selectedId: selectedPolicy.id}});
    if(path==='/api/micro/recipient'){
      expect(request.headers()['x-allowit-expected-owner']).toBe('solana:'+owner);
      expect(input).toEqual({id:selectedPolicy.id,revision:selectedPolicy.revision,sourceHash:selectedPolicy.sourceHash,recipient:recipientWallet});
      expect(b.bound).toBe(false);
      const insertion='\n    allowit::require_recipient(&ctx.recipient, '+JSON.stringify(recipientWallet)+')?;\n';
      const at=selectedPolicy.code.indexOf('{',selectedPolicy.code.indexOf('async fn _execute'))+1;
      const code=selectedPolicy.code.slice(0,at)+insertion+selectedPolicy.code.slice(at);
      const guard=insertion.trim().slice(0,-1),start=code.indexOf(guard);
      selectedPolicy={...selectedPolicy,code,revision:selectedPolicy.revision+1,sourceHash:'94'.repeat(32),workflow:[{id:'saved-recipient',name:'require_recipient',kind:'function',label:'Required recipient',description:'',arguments:[recipientWallet],source:guard,start,end:start+guard.length},...selectedPolicy.workflow.map(n=>({...n,start:n.start>=at?n.start+insertion.length:n.start,end:n.end>=at?n.end+insertion.length:n.end}))]};
      return route.fulfill({json:{policies:[selectedPolicy],selectedId:selectedPolicy.id}});
    }
    if(path==='/api/micro/funding'){
      expect(request.headers()['x-allowit-expected-owner']).toBe('solana:'+owner);
      expect(input).toEqual({id:selectedPolicy.id,revision:selectedPolicy.revision,amount:input.amount,token:'USDC'});
      expect(b.bound).toBe(false);
      funding=input.amount;nativePolicy={...nativePolicy,dailyLimit:funding,actionLimit:actionLimit()};
      selectedPolicy={...selectedPolicy,fundingRequest:{amount:funding,token:'USDC'},revision:selectedPolicy.revision+1};
      return route.fulfill({json:{policies:[selectedPolicy],selectedId:selectedPolicy.id}});
    }
    if(path==='/api/micro/native-service'){
      expect(request.headers()['x-allowit-expected-owner']).toBe('solana:'+owner);
      expect(input).toEqual({id:selectedPolicy.id,revision:selectedPolicy.revision,sourceHash:selectedPolicy.sourceHash,nativeServiceId:input.nativeServiceId});
      expect(['',x402Service.id]).toContain(input.nativeServiceId);expect(b.bound).toBe(false);
      if (!hasX402Service) serviceBase = {code: selectedPolicy.code, workflow: selectedPolicy.workflow};
      hasX402Service=input.nativeServiceId===x402Service.id;
      selectedPolicy={...selectedPolicy,...(hasX402Service?projectedX402Source(serviceBase):serviceBase),revision:selectedPolicy.revision+1,sourceHash:(selectedPolicy.revision+1).toString(16).repeat(64)};
      return route.fulfill({json:{policies:[selectedPolicy],selectedId:selectedPolicy.id}});
    }
    if (path === '/api/micro/allocation/cancel') {
      expect(b.revocationStarted).toBe(true); b.cancelled = true;
      return route.fulfill({json: {policies: [{...selectedPolicy, status: 'cancelled', nativeExecution: {policyId: policy.id, revocationStarted: true}}], selectedId: selectedPolicy.id, intent: {noTransaction: true}}});
    }
    if (path === '/api/micro/runs') return route.fulfill({json:{requests:[]}});
    if(path==='/api/owner/requests')return route.fulfill({json:{requests:ownerRequests}});
    if(path==='/api/owner/requests/challenge'){
      const item=ownerRequests.find(r=>r.requestId===input.requestId)!;
      expect(item.status).toBe('awaiting_input');
      const now=Math.floor(Date.now()/1000),expiresAt=Math.min(now+300,item.expiresAt!),decisionId='decision-'+decisions.size;
      const boundAnswer={kind:'native',origin:new URL(request.url()).origin,owner,network:'solana:devnet',policyId:policy.id,requestId:item.requestId,inputHash:item.inputHash,question:item.question,purpose:item.purpose,scope:item.scope,envelope:item.envelope};
      const content={domain:'allowit-owner-decision',version:1,origin:boundAnswer.origin,decision:input.decision,nonce:decisionId,issuedAt:now,expiresAt,expiryMeaning:'answer_deadline',binding:boundAnswer,...(input.note?{note:input.note}:{})};
      const message='AllowIt owner decision v1\nAnswer: '+(input.decision==='yes'?'Yes':'No')+'\nAnswer by expiresAt. This answer resumes only the exact native purchase. It is not a transfer signature.\n'+JSON.stringify(content,null,2);
      decisions.set(decisionId,{item:{...item},decision:input.decision,note:input.note,message});
      return route.fulfill({json:{decisionId,message,expiresAt,expiryMeaning:'answer_deadline',decision:input.decision,binding:boundAnswer,note:input.note}});
    }
    if(path==='/api/owner/requests/answer'){
      const d=decisions.get(input.decisionId)!;
      expect(ed25519.verify(new Uint8Array(Buffer.from(input.signature,'base64')),new TextEncoder().encode(d.message),ownerKeypair.publicKey.toBytes())).toBe(true);
      if(b.revocationStarted)return route.fulfill({status:409,json:{error:'The vault is revoked.'}});
      const item=ownerRequests.find(r=>r.requestId===input.requestId)!;
      const purchase=purchases.get(input.requestId)!;
      const now=Math.floor(Date.now()/1000),approved=d.decision==='yes';
      const history={decisionId:input.decisionId,approved,answeredAt:now,expiresAt:JSON.parse(d.message.slice(d.message.indexOf('{'))).expiresAt,origin:new URL(request.url()).origin};
      if(!item.decisionHistory.some(v=>v.decisionId===input.decisionId)){
        if(approved&&purchase.question===0){
          purchase.question=1;item.question=researchQuestions[1];item.envelope={...item.envelope,inputKey:'7'.repeat(64)};item.decisionHistory.push(history);
        }else{
          purchase.status=approved?'settled':'denied';
          Object.assign(item,{status:purchase.status,approved,answeredAt:now,decisionId:input.decisionId,note:input.note,origin:new URL(request.url()).origin});
          if(approved&&!purchase.counted){purchase.counted=true;b.spendCount++;b.totalUnits+=BigInt(Math.round(Number(purchase.amount)*1e6));}
        }
      }
      if(b.dropAnswer){b.dropAnswer=false;return route.abort();}
      return route.fulfill({json:{kind:'native',policyId:policy.id,requestId:input.requestId,status:purchase.status,approved,decisionId:input.decisionId,answeredAt:now,note:input.note}});
    }
    if(path==='/api/native/spend'){
      expect(request.headers().authorization).toBe('Bearer synthetic-fixture-capability');
      const serialized=JSON.stringify(input),prior=purchases.get(input.requestId);
      if(prior&&prior.input!==serialized)return route.fulfill({status:409,json:{error:'Request identity changed'}});
      if(b.revocationStarted||!b.approved)return route.fulfill({status:409,json:{error:'Native spending is stopped'}});
      const amount=BigInt(Math.round(Number(input.options.amount)*1e6));
      if(amount<=0n||amount>1000000n)return route.fulfill({status:422,json:{error:'Per-purchase limit exceeded'}});
      let band=0,ceiling=1000000n;while(amount<=ceiling/2n){ceiling/=2n;band++;}
      if(!prior&&(tierCounts.get(band)??0)>=2*2**band)return route.fulfill({status:422,json:{error:'Purchase tier exhausted'}});
      if(b.totalUnits+amount>fundingUnits())return route.fulfill({status:422,json:{error:'Daily vault limit exceeded'}});
      const purchase=prior??{input:serialized,status:b.questionMode?'awaiting_input':'settled',amount:input.options.amount,question:0,counted:false};
      purchases.set(input.requestId,purchase);
      if(!prior)tierCounts.set(band,(tierCounts.get(band)??0)+1);
      if(purchase.status==='awaiting_input'){
        let item=ownerRequests.find(q=>q.requestId===input.requestId);
        if(!item){const expiresAt=Math.floor(Date.now()/1000)+600;item={kind:'native',owner,origin:'',policyId:policy.id,requestId:input.requestId,status:'awaiting_input',question:researchQuestions[0],purpose:'Original research purchase',network:'solana:devnet',inputHash:'6'.repeat(64),scope:{executionPolicyId:selectedPolicy.id,revision:selectedPolicy.revision,sourceHash:selectedPolicy.sourceHash,irHash:selectedPolicy.irHash,executionPolicyDigest:policy.executionPolicyDigest},envelope:{inputKey:'8'.repeat(64),amount:input.options.amount,token:'USDC',mint:config.mint,recipient:input.options.recipient,action:input.action,merchant:input.merchant,contextHash:'9'.repeat(64),requestExpiresAt:expiresAt,context:input.context},expiresAt,decisionHistory:[]};ownerRequests.push(item);}
        return route.fulfill({json:{status:'awaiting_input',request:item,executionBinding:bound()}});
      }
      if(purchase.status==='settled'&&!purchase.counted){purchase.counted=true;b.spendCount++;b.totalUnits+=amount;}
      return route.fulfill({json:{executionBinding:bound(),operation:{id:input.requestId,policyId:policy.id,method:'execute',status:purchase.status,finalizedSlot:30+b.spendCount}}});
    }
    if (path === '/api/native/release') return route.fulfill({json: {profile: 'solana-native-v2', network: config.network, release}});
    if (path === '/api/native/config') return route.fulfill({json: {...config, ...(options.orphanedService || options.noX402Service?{x402Services:[]}:{}) , capabilities: {bindExistingPolicy: b.setupReady, agentExecutor: b.setupReady && !b.formerBackend, managedSpend: b.formerBackend || options.legacy === true, oneSignatureDeploy: b.setupReady, finalizedRevoke: true, walletRecipientAta: b.setupReady, recipientAnyWallet: b.setupReady, ownerContinuations:b.setupReady, purchaseHistory:b.setupReady, revokeAndReturnFunds: options.returnFunds === true}}});
    if (path.startsWith('/api/native/')) {
      expect(request.headers()['x-allowit-expected-owner']).toBe('solana:' + owner);
      if (b.offline) return route.abort();
      if (path === '/api/native/policies') return route.fulfill({json: {policies: b.bound ? [nativePolicy] : [], executionBindings: b.bound ? {[policy.id]: bound()} : {}}});
      if (path === '/api/native/bind') {
        // A new vault names the owner's registered agent; reloading a bound one sends no agent.
        expect(input).toEqual({executionPolicyId: selectedPolicy.id, expectedRevision: selectedPolicy.revision, expectedSourceHash: selectedPolicy.sourceHash, ...(!b.bound&&hasX402Service ? {x402ServiceId:x402Service.id} : {}), ...(b.bound ? {} : {recipientMode: dynamicMode().recipientMode ?? 'wallet', agentId: AGENT_ID})});
        if (!b.bound) b.agentBound = true;
        if (options.deny) return route.fulfill({status: 422, json: {error: 'This deny-all policy cannot authorize a native transfer. Revise the original policy or fork.'}});
        b.bound = true; return route.fulfill({json: envelope()});
      }
      if (path === '/api/native/stop-all') {
        if (b.stopFailure) return route.fulfill({status: 503, json: {error: 'Durable server stop is not confirmed'}});
        b.revocationStarted = true;
        return route.fulfill({json: {stopped: true, revocationStarted: true, policyIds: [policy.id]}});
      }
      if (path === '/api/native/verify') return options.verify === false ? route.fulfill({status: 503, json: {error: 'Native deployment verification unavailable'}}) : route.fulfill({json: {verified: true, verification: 'full', network: config.network, sourceBundle: release.sourceBundle, config}});
      expect(input).toMatchObject({executionPolicyId: selectedPolicy.id, expectedRevision: selectedPolicy.revision, expectedSourceHash: selectedPolicy.sourceHash});
      if (path === '/api/native/state') {
        const json = {executionBinding: bound(), recipientBinding: recipientBinding(), ...dynamicMode(), ...(hasX402Service?{x402Service:boundX402}:{}), binding, revocationStarted: b.revocationStarted, allowedServices: hasX402Service?[{id:x402Service.id,recipient:x402Service.recipient}]:[{id: 'quicknode/rpc', recipient: '2LWbc9Mi6dRUrdEHBttoNS4udDtH1A4xwBdm1EKqcT57'}], state: b.exists ? {...binding, abi: 2, sourceBundle: policy.sourceBundle, policyArtifact: policy.policyArtifact, vaultId: policy.id, dailyLimit: String(fundingUnits()), actionLimit: String(microUnits(actionLimit())), spent: '0', spentDay: '0', nonce: '0', revision: b.approved ? '0' : '1', instanceSlot: '25', approved: b.approved, balance: String(balanceUnits())} : null, operations: [...b.ops].map(([id, op]) => publicOp(id, op))};
        if (b.holdState) {b.holdState = false; b.heldState = () => route.fulfill({json}); return;}
        return route.fulfill({json});
      }
      if (path === '/api/native/prepare') {
        expect(['deploy', 'revoke', 'close', 'withdraw']).toContain(input.method);
        if (input.method === 'withdraw') {expect(b.exists).toBe(true); expect(BigInt(Math.round(Number(input.options.amount) * 1e6))).toBeLessThanOrEqual(balanceUnits());}
        if (input.method === 'revoke' || input.method === 'close') b.revocationStarted = true;
        if (input.method === 'close') {expect(options.returnFunds).toBe(true); expect(input.options.instanceSlot).toBe(25); if (input.options.additionalOwnerOperation) expect(b.expireClose).toBe(true);}
        let op = b.ops.get(input.requestId);
        if (!op) {op = {prepared: prepared(input.method, {id: input.requestId, amount: input.options.amount, dailyLimit:funding, actionLimit:actionLimit(), revision: b.approved ? '0' : '1', ...(input.method === 'close' ? {instanceSlot: input.options.instanceSlot} : {}), ...(input.method === 'deploy' && recipientBinding() ? {recipientWallet} : {})}), status: 'prepared', method: input.method, ...(input.method === 'withdraw' ? {amount: input.options.amount} : {})}; b.ops.set(input.requestId, op);}
        return route.fulfill({json: {...op.prepared, executionBinding: bound(), ...dynamicMode(), recipientBinding: options.changedRecipient && recipientBinding() ? {...recipientBinding(), wallet: owner} : recipientBinding()}});
      }
      if (path === '/api/native/submit') {
        const op = b.ops.get(input.requestId)!;
        const durable = await page.evaluate(({id, bytes}) => new Promise<boolean>((resolve, reject) => {
          const opened = indexedDB.open('allowit-native-v2', 1); opened.onerror = () => reject(opened.error);
          opened.onsuccess = () => {const db = opened.result, read = db.transaction('operations').objectStore('operations').getAll(); read.onsuccess = () => {resolve(read.result.some((r: {id?: string; signedBytes?: string}) => r.id === id && r.signedBytes === bytes)); db.close();};};
        }), {id: input.requestId, bytes: input.signedBytes});
        expect(durable).toBe(true);
        const tx = Transaction.from(Buffer.from(input.signedBytes, 'base64'));
        expect(tx.verifySignatures()).toBe(true); expect(tx.serializeMessage().toString('base64')).toBe(op.prepared.message);
        if (op.signedBytes) expect(input.signedBytes).toBe(op.signedBytes);
        op.signedBytes = input.signedBytes; op.signature = base58(tx.signatures[0].signature!); const final = op.method === 'close' ? b.returnFinalityReady : !options.deferredFinality; op.status = final ? 'settled' : 'submitted';
        if (final) op.finalizedSlot = op.method === 'deploy' ? 25 : 26;
        if (op.method === 'close') {if (final) closeVault();} else if (op.method === 'withdraw') {if (final) withdrawn(op);} else {b.exists = true; b.approved = op.method === 'deploy';}
        if (b.dropSubmit) {b.dropSubmit = false; b.offline = true; return route.abort();}
        return route.fulfill({json: {executionBinding: bound(), operation: publicOp(input.requestId, op)}});
      }
      if (path === '/api/native/import') {
        const op = b.ops.get(input.record.id)!; expect(input.record.signedBytes).toBe(op.signedBytes);
        return b.failImport ? route.fulfill({status: 409, json: {error: 'The native execution-policy binding changed.'}}) : route.fulfill({json: {executionBinding: bound(), operation: publicOp(input.record.id, op)}});
      }
      if (path === '/api/native/recover') {
        const op = b.ops.get(input.requestId); b.recoveries++;
        if (op?.signedBytes && (op.method === 'close' ? b.returnFinalityReady : b.finalityReady)) {op.status = 'settled'; op.finalizedSlot = op.method === 'deploy' ? 25 : 26; if (op.method === 'close') closeVault(); if (op.method === 'withdraw') withdrawn(op);}
        return op ? route.fulfill({json: {executionBinding: bound(), operation: publicOp(input.requestId, op)}}) : route.fulfill({status: 404, json: {error: 'No such original request'}});
      }
      if (path === '/api/native/export' && b.agentBound) return route.fulfill({json: {...dynamicMode(), executionBinding: bound(), revocationStarted: b.revocationStarted, binding, ...(hasX402Service?{x402Service:boundX402}:{}), skill: `# Agent skill
This vault names your own key ${executor} as its executor. Pay with allowit policy execute. Direct token transfer; delivery not attested. Never ask for an owner private key.`, executor: {version: 2}}});
      if (path === '/api/native/export') return route.fulfill({json: {...dynamicMode(), executionBinding: bound(), revocationStarted: b.revocationStarted, binding, ...(hasX402Service?{x402Service:boundX402}:{}), skill: `# Bound agent skill\nUse ${hasX402Service?'/api/native/execute':'/api/native/spend'} with the exported capability. Direct token transfer; delivery not attested. Never ask for an owner private key.`, executor: {version: 2}, managedAgent: {endpoint: new URL(hasX402Service?'/api/native/execute':'/api/native/spend', request.url()).href, requestSchema: {requestId: 'string', amount: 'decimal'}, recovery: 'repeat-identical-request', authorization: 'Bearer synthetic-fixture-capability', paymentKind: 'direct-token-transfer', deliveryAttested: false, ...(hasX402Service?{x402Service:boundX402}:{})}}});
    }
    b.unexpected.push(method + ' ' + path); return route.fulfill({status: 500, json: {error: 'Unexpected fixture call'}});
  });
  await page.goto('/allowances');
  await expect(page.getByRole('article', {name: selectedPolicy.title})).toBeVisible({timeout:20_000});
  // Approve stays enabled while setup is blocked: a click points at the block that fixes it.
  await expect(page.getByRole('button', {name: 'Approve and sign once', exact: true})).toBeEnabled();
  return b;
}
