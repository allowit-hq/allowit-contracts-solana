import {afterEach, describe, expect, it, vi} from 'vitest';
import {binding, config, owner, policy, projectedSource, projectedShortSource, projectedX402Source, recipientWallet, x402Service} from '../../tests/fixtures/devnet-vault';
import {bindSelectedPolicy, BoundNativeAPI, checkedAttachment, executionBinding, type NativeAttachment, type SelectedPolicy} from './native-bound';
import {recipientTokenAccount} from './native-recipient';
import type {Session} from '../contracts';

const selected: SelectedPolicy = {...projectedSource(), id: 'source-policy', revision: 7, sourceHash: '91'.repeat(32), network: 'solana:devnet', limit: '1', token: 'USDC', mint: config.mint, fundingRequest: {amount: '5', token: 'USDC'}};
const session: Session = {address: owner, network: 'solana', expiresAt: '2099-01-01'};
const attachment: NativeAttachment = {policy, executionPolicyId: selected.id, executionBinding: executionBinding(selected, owner), initialFunding: {amount: '5', token: 'USDC', mint: config.mint}, paymentKind: 'direct-token-transfer', deliveryAttested: false};
const x402Selected: SelectedPolicy = {...selected, ...projectedX402Source()};
const boundX402 = {...x402Service, tokenAccount: recipientTokenAccount(x402Service.recipient, config.mint)};
const x402RecipientBinding = {kind: 'wallet-ata' as const, wallet: recipientWallet, tokenAccount: recipientTokenAccount(recipientWallet, config.mint), mint: config.mint, network: config.network};
const x402Attachment: NativeAttachment = {...attachment, executionBinding: executionBinding(x402Selected, owner), recipientBinding: x402RecipientBinding, x402Service: boundX402};
afterEach(() => vi.unstubAllGlobals());
describe('immutable selected-policy native binding', () => {
  it('explicit new wallet setup verifies source wallet and the derived Devnet USDC account', async () => {
    const recipientBinding = {kind: 'wallet-ata' as const, wallet: recipientWallet, tokenAccount: recipientTokenAccount(recipientWallet, config.mint), mint: config.mint, network: config.network};
    const value = {...attachment, recipientBinding};
    const fetch = vi.fn(async () => Response.json(value)); vi.stubGlobal('fetch', fetch);
    await expect(bindSelectedPolicy({...selected, limit: ''}, session, config, 'wallet')).resolves.toEqual(value);
    expect(JSON.parse((fetch.mock.calls as unknown as [string, RequestInit][])[0][1].body as string).recipientMode).toBe('wallet');
    expect(() => checkedAttachment(attachment, selected, owner, config, 'wallet')).toThrow(/No legacy/);
    for (const changed of [
      {...recipientBinding, wallet: owner}, {...recipientBinding, tokenAccount: owner}, {...recipientBinding, mint: owner},
      {...recipientBinding, network: 'solana:mainnet'}, {...recipientBinding, kind: 'token-account'},
    ]) expect(() => checkedAttachment({...value, recipientBinding: changed}, selected, owner, config, 'wallet')).toThrow();
  });
  it('refuses a dynamic recipient mode changed after binding before using its reply', async () => {
    const dynamic = {...attachment, recipientMode: 'any-wallet' as const, recipientMint: config.mint, executionBinding: {...attachment.executionBinding, recipientMode: 'any-wallet' as const, recipientMint: config.mint}};
    let response: unknown = {executionBinding: dynamic.executionBinding, recipientMode: 'any-wallet', recipientMint: config.mint, recipientBinding: null};
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)));
    const api = new BoundNativeAPI(config, dynamic, session, () => true);
    await expect(api.call('native/prepare', {})).resolves.toEqual(response);
    response = {...response as object, recipientMode: undefined};
    await expect(api.call('native/prepare', {})).rejects.toThrow(/recipient mode/);
    response = {executionBinding: attachment.executionBinding, recipientMode: 'any-wallet', recipientMint: config.mint, recipientBinding: null};
    await expect(api.call('native/prepare', {})).rejects.toThrow(/execution binding/);
  });
  it('verifies the dynamic wallet mint before admitting a binding or owner operation', async () => {
    const unrestricted = {...selected, workflow: selected.workflow.filter(n => n.name !== 'require_recipient')};
    const dynamic = {...attachment, recipientMode: 'any-wallet' as const, recipientMint: config.mint, executionBinding: {...attachment.executionBinding, recipientMode: 'any-wallet' as const, recipientMint: config.mint}};
    expect(() => checkedAttachment({...dynamic, recipientMint: owner}, unrestricted, owner, config, 'any-wallet')).toThrow(/recipient.*mint/);
    expect(() => checkedAttachment({...dynamic, executionBinding: {...dynamic.executionBinding, recipientMint: owner}}, unrestricted, owner, config, 'any-wallet')).toThrow(/different/);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({executionBinding: dynamic.executionBinding, recipientMode: 'any-wallet', recipientMint: owner})));
    await expect(new BoundNativeAPI(config, dynamic, session, () => true).call('native/prepare', {})).rejects.toThrow(/recipient.*mint/);
  });
  it('binds an owner-reviewed deposit for a short policy without inventing a funding rule', async () => {
    const minimal = {...selected,...projectedShortSource(),fundingRequest:undefined};
    const dynamic = {...attachment,policy:{...policy,dailyLimit:'10',actionLimit:'10'},initialFunding:{...attachment.initialFunding,amount:'10'},recipientMode:'any-wallet' as const,recipientMint:config.mint,executionBinding:{...attachment.executionBinding,recipientMode:'any-wallet' as const,recipientMint:config.mint}};
    const before=JSON.stringify(minimal);
    const fetch=vi.fn(async()=>Response.json(dynamic));vi.stubGlobal('fetch',fetch);
    await expect(bindSelectedPolicy(minimal,session,config,'any-wallet','10.00')).resolves.toMatchObject({initialFunding:{amount:'10'}});
    expect(JSON.parse((fetch.mock.calls as unknown as [string,RequestInit][])[0][1].body as string)).toEqual({executionPolicyId:selected.id,expectedRevision:7,expectedSourceHash:selected.sourceHash,recipientMode:'any-wallet',fundingAmount:'10'});
    expect(JSON.stringify(minimal)).toBe(before);
    expect(()=>checkedAttachment(dynamic,minimal,owner,config,'any-wallet','9')).toThrow(/reviewed deposit/);
  });
  it('normalizes a fractional owner deposit exactly before sending it to bind', async () => {
    const minimal={...selected,...projectedShortSource(),fundingRequest:undefined};
    const dynamic={...attachment,policy:{...policy,dailyLimit:'0.1',actionLimit:'0.1'},initialFunding:{...attachment.initialFunding,amount:'0.1'},recipientMode:'any-wallet' as const,recipientMint:config.mint,executionBinding:{...attachment.executionBinding,recipientMode:'any-wallet' as const,recipientMint:config.mint}};
    const fetch=vi.fn(async()=>Response.json(dynamic));vi.stubGlobal('fetch',fetch);
    await expect(bindSelectedPolicy(minimal,session,config,'any-wallet','0.10')).resolves.toMatchObject({initialFunding:{amount:'0.1'}});
    expect(JSON.parse((fetch.mock.calls as unknown as [string,RequestInit][])[0][1].body as string).fundingAmount).toBe('0.1');
  });
  it('does not accept changed or omitted recipient mapping on preparation or state', async () => {
    const recipientBinding = {kind: 'wallet-ata' as const, wallet: recipientWallet, tokenAccount: recipientTokenAccount(recipientWallet, config.mint), mint: config.mint, network: config.network};
    let response: unknown = {executionBinding: attachment.executionBinding, recipientBinding};
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)));
    const api = new BoundNativeAPI(config, {...attachment, recipientBinding}, session, () => true);
    await expect(api.call('native/prepare', {})).resolves.toEqual(response);
    response = {executionBinding: attachment.executionBinding};
    await expect(api.call('native/prepare', {})).rejects.toThrow(/recipient binding/);
    response = {executionBinding: attachment.executionBinding, revocationStarted: false, allowedServices: [], recipientBinding: {...recipientBinding, wallet: owner}};
    await expect(api.call('native/state', {})).rejects.toThrow(/recipient binding/);
  });
  it('binds the server-advertised x402 ID and rejects missing or changed bound descriptors', async () => {
    const fetch = vi.fn(async () => Response.json(x402Attachment)); vi.stubGlobal('fetch', fetch);
    await expect(bindSelectedPolicy(x402Selected, session, config, 'wallet')).resolves.toEqual(x402Attachment);
    const body = JSON.parse((fetch.mock.calls as unknown as [string, RequestInit][])[0][1].body as string);
    expect(body).toEqual({executionPolicyId: selected.id, expectedRevision: 7, expectedSourceHash: selected.sourceHash, x402ServiceId: x402Service.id, recipientMode: 'wallet'});
    expect(() => checkedAttachment({...x402Attachment, x402Service: undefined}, x402Selected, owner, config, 'wallet')).toThrow(/x402 service binding/);
    expect(() => checkedAttachment({...x402Attachment, x402Service: {...x402Service}}, x402Selected, owner, config, 'wallet')).toThrow(/x402 service binding/);
    expect(() => checkedAttachment({...x402Attachment, x402Service: {...boundX402, resourceUrl: 'https://other.example.test/research'}}, x402Selected, owner, config, 'wallet')).toThrow(/x402 service binding/);
    expect(() => checkedAttachment({...x402Attachment, x402Service: {...boundX402, tokenAccount: owner}}, x402Selected, owner, config, 'wallet')).toThrow(/x402 service binding/);
    expect(() => checkedAttachment({...attachment, x402Service: boundX402}, selected, owner, config)).toThrow(/x402 service binding/);
    expect(checkedAttachment({...attachment, x402Service: null} as unknown, selected, owner, config)).toEqual(attachment);
  });
  it('requires the exact x402 binding in state and managed export replies', async () => {
    const managed = {endpoint: 'https://app.example.test/api/native/execute', authorization: 'Bearer exact-capability', requestSchema: {requestId: 'string'}, recovery: 'repeat-identical-request' as const, paymentKind: 'direct-token-transfer' as const, deliveryAttested: false as const, x402Service: boundX402};
    let response: unknown = {executionBinding: x402Attachment.executionBinding, recipientBinding: x402RecipientBinding, revocationStarted: false, allowedServices: [{id: x402Service.id, recipient: x402Service.recipient}], x402Service: boundX402};
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)));
    vi.stubGlobal('window', {location: {origin: 'https://app.example.test'}});
    const api = new BoundNativeAPI(config, x402Attachment, session, () => true);
    await expect(api.call('native/state', {})).resolves.toEqual(response);
    response = {executionBinding: x402Attachment.executionBinding, recipientBinding: x402RecipientBinding, revocationStarted: false, allowedServices: []};
    await expect(api.call('native/state', {})).rejects.toThrow(/x402 service binding/);
    response = {executionBinding: x402Attachment.executionBinding, revocationStarted: false, binding, skill: '# exact', executor: {version: 2}, x402Service: boundX402, managedAgent: managed};
    await expect(api.export(policy, owner)).resolves.toMatchObject({managedAgent: managed, x402Service: boundX402});
    response = {...response as object, managedAgent: {...managed, x402Service: {...boundX402, action: 'other'}}};
    await expect(api.export(policy, owner)).rejects.toThrow(/managed agent export changed/);
  });
  it.each(['policyId', 'revision', 'sourceHash', 'owner', 'network'] as const)('rejects changed execution %s', field => {
    const altered = {...attachment, executionBinding: {...attachment.executionBinding, [field]: field === 'revision' ? 8 : 'different'}};
    expect(() => checkedAttachment(altered, selected, owner, config)).toThrow(/different/);
  });
  it('rejects changed mint, funding, limit, profile and delivery claims', () => {
    for (const changed of [
      {...attachment, initialFunding: {...attachment.initialFunding, mint: owner}},
      {...attachment, initialFunding: {...attachment.initialFunding, amount: '6'}},
      {...attachment, policy: {...policy, actionLimit: '2'}},
      {...attachment, policy: {...policy, network: 'solana:testnet'}},
      {...attachment, deliveryAttested: true},
      {...attachment, paymentKind: 'paid-api'},
    ]) expect(() => checkedAttachment(changed, selected, owner, config)).toThrow();
  });
  it('guards every owner mutation and rejects missing or changed reply binding', async () => {
    let response: unknown = {executionBinding: attachment.executionBinding, revocationStarted: false, allowedServices: []};
    const fetch = vi.fn(async () => Response.json(response)); vi.stubGlobal('fetch', fetch);
    const api = new BoundNativeAPI(config, attachment, session, () => true);
    for (const route of ['prepare', 'submit', 'recover', 'import', 'export', 'state']) await api.call('native/' + route, {policyId: policy.id});
    for (const [, init] of fetch.mock.calls as unknown as [string, RequestInit][]) expect(JSON.parse(init.body as string)).toEqual({policyId: policy.id, executionPolicyId: selected.id, expectedRevision: 7, expectedSourceHash: selected.sourceHash});
    response = {}; await expect(api.call('native/submit', {})).rejects.toThrow(/immutable execution binding/);
    response = {executionBinding: {...attachment.executionBinding, owner: config.executor}}; await expect(api.call('native/recover', {})).rejects.toThrow(/immutable execution binding/);
  });
  it('does not call the server after selection or owner changes; bind persistence avoids numeric save', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const api = new BoundNativeAPI(config, attachment, session, () => false);
    await expect(api.call('native/prepare', {})).rejects.toThrow(/selected policy/);
    await expect(api.save(policy)).resolves.toEqual({policy}); expect(fetch).not.toHaveBeenCalled();
    await expect(api.save({...policy, id: '00'.repeat(32)})).rejects.toThrow(/saved execution attachment/);
  });
});

