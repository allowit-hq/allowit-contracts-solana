// The plugin object and its elements, with a minimal DOM and a wallet that registers through the Wallet Standard.
import assert from 'node:assert/strict';
import test from 'node:test';
import {ed25519} from '@noble/curves/ed25519';
import {base58, base64, unbase64, utf8} from '../dist/bytes.js';
import {compile, messageBytes, readWire, verify, wire} from '../dist/message.js';
import {approvalStep, canonical, messageHash, prepareSetup} from '../dist/native-wallet.js';
import {signatureOf} from '../dist/signatures.js';
import {USDC, node, v} from './helpers.mjs';

class FakeNode extends EventTarget {
  constructor(tag) {
    super();
    this.localName = tag;
    this.attributes = new Map();
    this.children = [];
    this.isConnected = false;
    this.disabled = false;
    this._text = null;
  }
  setAttribute(name, value) {this.attributes.set(name, String(value));}
  append(...nodes) {this.children.push(...nodes);}
  replaceChildren(...nodes) {this.children = nodes;}
  set textContent(value) {this._text = String(value); this.children = [];}
  get textContent() {return this._text ?? this.children.map(child => typeof child === 'string' ? child : child.textContent).join('');}
  /** Every descendant with `tag`. */
  all(tag) {return this.children.flatMap(child => typeof child === 'string' ? [] : [...(child.localName === tag ? [child] : []), ...child.all(tag)]);}
}
const defined = new Map();
globalThis.HTMLElement = FakeNode;
globalThis.document = {createElement: tag => new FakeNode(tag)};
globalThis.customElements = {get: tag => defined.get(tag), define: (tag, ctor) => void defined.set(tag, ctor)};
globalThis.window = new EventTarget();
globalThis.location = {host: 'app.example.test'};

const {default: plugin} = await import('../dist/plugin.js');
const {describe, ownerStep, stepMessage} = await import('../dist/elements/signing.js');
const {formatUnits} = await import('../dist/elements/display.js');
const network = plugin.test.network, {fixtures} = plugin.test;

/** An element of `kind` with `data`, connected. */
function element(kind, data) {
  plugin.define();
  const node = new (customElements.get(plugin.elements[kind]))(plugin.elements[kind]);
  node.data = data;
  node.isConnected = true;
  node.connectedCallback();
  return node;
}
const events = (node, ...types) => {
  const seen = [];
  for (const type of types) node.addEventListener(type, event => seen.push([type, event.detail]));
  return seen;
};
const click = async (node, label) => {
  const button = node.all('button').find(b => b.textContent === label);
  assert.ok(button, `a button "${label}" among ${node.all('button').map(b => b.textContent)}`);
  button.dispatchEvent(new Event('click'));
  // The handler disables its button while it works and enables it when it is done.
  for (let i = 0; i < 2_000 && (i < 2 || button.disabled); i++) await new Promise(done => setImmediate(done));
};

const secret = Uint8Array.from({length: 32}, (_, i) => 200 - i);
const owner = base58(ed25519.getPublicKey(secret));
/** A wallet of the page. `tamper` changes what it returns for a transaction. */
function wallet({chains = ['solana:devnet'], key = secret, tamper = null} = {}) {
  const publicKey = ed25519.getPublicKey(key);
  const account = {address: base58(publicKey), publicKey, chains, features: []};
  const asked = [];
  const standard = {
    name: 'Test Wallet', chains, accounts: [],
    features: {
      'standard:connect': {connect: async () => ({accounts: [account]})},
      'solana:signMessage': {signMessage: async input => (asked.push(['message', input]), [{signedMessage: input.message, signature: ed25519.sign(input.message, key)}])},
      'solana:signTransaction': {signTransaction: async input => {
        asked.push(['transaction', input]);
        const {message} = readWire(input.transaction);
        const signed = wire([ed25519.sign(message, key)], message);
        return [{signedTransaction: tamper ? tamper(signed, key) : signed}];
      }},
    },
  };
  const announce = event => event.detail.register(standard);
  window.addEventListener('wallet-standard:app-ready', announce);
  return {asked, address: account.address, remove: () => window.removeEventListener('wallet-standard:app-ready', announce)};
}

test('the plugin names its rail, its networks, its elements and its fixtures', () => {
  assert.equal(plugin.id, 'solana');
  for (const n of plugin.networks) assert.match(n.id, /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/);
  assert.ok(plugin.networks.some(n => n.id === network && n.testnet));
  for (const tag of Object.values(plugin.elements)) assert.ok(tag.startsWith('allowit-solana-'));
  assert.deepEqual(Object.keys(plugin.elements), ['address', 'explorer-link', 'amount', 'wallet-sign-in', 'owner-sign', 'owner-answer', 'receipt', 'binding-review']);
  for (const account of [fixtures.address, ...fixtures.accounts]) assert.equal(plugin.validateAddress(network, account), true);
  assert.equal(new Set([fixtures.address, ...fixtures.accounts]).size, 3);
  assert.equal(plugin.validateAddress(network, fixtures.invalidAddress), false);
  assert.equal(plugin.validateAddress('unknown:none', fixtures.address), false);
  assert.equal(plugin.validateAddress(network, fixtures.txHash), false, 'a signature is no address');
  for (const reason of Object.values(plugin.test.skips)) assert.ok(reason.length > 0);
});

test('explorer links name the id and the cluster, and refuse an id of another length', () => {
  assert.equal(plugin.explorerUrl(network, 'address', fixtures.address), `https://explorer.solana.com/address/${fixtures.address}?cluster=devnet`);
  assert.equal(plugin.explorerUrl(network, 'tx', fixtures.txHash), `https://explorer.solana.com/tx/${fixtures.txHash}?cluster=devnet`);
  assert.equal(plugin.explorerUrl(network, 'contract', fixtures.address), `https://explorer.solana.com/address/${fixtures.address}?cluster=devnet`);
  assert.equal(plugin.explorerUrl(network, 'tx', fixtures.address), null);
  assert.equal(plugin.explorerUrl(network, 'address', fixtures.txHash), null);
  assert.equal(plugin.explorerUrl(network, 'address', '../x?y='), null);
  assert.equal(plugin.explorerUrl('unknown:none', 'tx', fixtures.txHash), null);
});

test('assets, units and wallet kinds', () => {
  const list = plugin.assets(network);
  assert.deepEqual(list.map(a => [a.symbol, a.decimals, a.stablecoin]), [['SOL', 9, false], ['USDC', 6, true]]);
  assert.ok(list.some(a => a.id === fixtures.asset));
  assert.deepEqual(plugin.assets('unknown:none'), []);
  assert.deepEqual(plugin.nativeAsset(network), {symbol: 'SOL', decimals: 9, name: 'Solana', native: true});
  assert.equal(plugin.nativeAsset('unknown:none'), null);
  for (const asset of list) assert.deepEqual([plugin.assetDisplay(network, asset.id).symbol, plugin.assetDisplay(network, asset.symbol).decimals], [asset.symbol, asset.decimals]);
  assert.equal(plugin.assetDisplay(network, 'native').symbol, 'SOL');
  assert.equal(plugin.assetDisplay(network, fixtures.address), null, 'an unlisted mint has no unit');
  assert.equal(plugin.assetDisplay(network, fixtures.invalidAddress), null);
  assert.deepEqual(plugin.walletKinds(network), ['native']);
  assert.deepEqual(plugin.walletKinds('unknown:none'), []);
  assert.equal(plugin.walletKind(v.configuration), 'native');
  assert.equal(plugin.walletKind({runtime: {instanceBinding: {route: 'native'}}}), 'native');
  assert.equal(plugin.walletKind({config: {route: 'native', tier: 'simple'}}), null);
  assert.equal(plugin.walletKind({route: 'policyWallet', tier: 'common'}), null);
  assert.equal(plugin.walletKind({}), null);
  assert.equal(plugin.walletKind(null), null);
});

test('a review link opens on the rail network and its amounts count in the asset of the policy', () => {
  const proposal = {network, revision: 1, title: 'Pay', explanation: '', code: 'fn policy() {}', sourceHash: 'ab'.repeat(32), paramsHash: 'cd'.repeat(32), params: {}};
  const encode = envelope => plugin.review.fragment + Buffer.from(JSON.stringify(envelope)).toString('base64url');
  const link = plugin.review.parseLink(encode({proposal, workPrompt: 'Do the work.', agent: fixtures.address, amount: '5', walletKind: 'native'}));
  assert.deepEqual(link, {proposal, workPrompt: 'Do the work.', agent: fixtures.address, amount: '5', walletKind: 'native'});
  assert.throws(() => plugin.review.parseLink(encode({proposal: {...proposal, network: 'other:testnet'}, workPrompt: 'w'})), /invalid/);
  assert.throws(() => plugin.review.parseLink(encode({proposal, workPrompt: 'w', extra: 1})), /invalid/);
  const prompt = plugin.review.agentPrompt(link, 'https://example.test', 'policy-1', v.tokenAccount, fixtures.address);
  assert.match(prompt, /^Do the work\./);
  assert.match(prompt, /Solana Devnet policy: policy-1/);
  assert.ok(prompt.includes(`--rail ${network}`) && prompt.includes('wallet import allowit-solana-profile.json'));
  assert.deepEqual(plugin.review.paramLines({}, network), []);
  assert.equal(plugin.review.paramLines({payment_limit: {Int: '1000000000'}}, network)[0].value, '1 SOL');
  // With the policy's token rule the same param counts in that token.
  const usdc = plugin.review.paramLines({payment_limit: {Int: '2500000'}, tokens: {List: [{Addr: v.mint}]}}, network);
  assert.equal(usdc.find(line => line.key === 'payment_limit').value, '2.5 USDC');
  assert.equal(usdc.find(line => line.key === 'tokens').value, 'USDC');
});

test('display elements show an address, a link, an amount and a receipt', () => {
  const [anchor] = element('address', {network, address: fixtures.address}).children;
  assert.deepEqual([anchor.localName, anchor.attributes.get('href'), anchor.textContent], ['a', plugin.explorerUrl(network, 'address', fixtures.address), 'AKnL…RSZ9']);
  assert.equal(element('address', {network, address: 'nope'}).children[0].attributes.get('class'), 'invalid');
  assert.equal(element('explorer-link', {network, kind: 'tx', id: fixtures.txHash}).children[0].attributes.get('href'), plugin.explorerUrl(network, 'tx', fixtures.txHash));
  assert.equal(element('amount', {network, asset: v.mint, units: '1234500000'}).textContent, '1,234.5 USDC');
  assert.equal(element('amount', {network, asset: 'SOL', units: '5000'}).textContent, '0.000005 SOL');
  // An unlisted token stays in base units: no decimals are guessed.
  assert.equal(element('amount', {network, asset: fixtures.address, units: '7'}).textContent, `7 ${fixtures.address}`);
  assert.equal(formatUnits('-1500000', 6), '-1.5');
  const receipt = element('receipt', {network, receipt: {hash: fixtures.txHash, status: 'settled', fee: {native: '5001', charged: '0.0004 USDC'}, debits: [{asset: v.mint, units: '250000'}]}});
  assert.match(receipt.textContent, /settled.*0\.000005001 SOL.*0\.0004 USDC.*0\.25 USDC/);
});

test('the sign-in element connects, then signs only a message of this site and account', async () => {
  const page = wallet();
  try {
    const first = element('wallet-sign-in', {network});
    const seen = events(first, 'allowit-signed-in', 'allowit-error');
    await click(first, 'Sign in with a Solana wallet');
    assert.deepEqual(seen, [['allowit-signed-in', {address: owner}]]);
    const message = `app.example.test wants you to sign in with your wallet account:\n${owner}\n\nSign in to AllowIt. This does not authorize spending or move funds.\n\nURI: https://app.example.test`;
    const second = element('wallet-sign-in', {network, message});
    const signed = events(second, 'allowit-signed-in', 'allowit-error');
    await click(second, 'Approve the sign-in message');
    assert.equal(signed[0][0], 'allowit-signed-in');
    // The signature is over the message bytes, as the server verifies it.
    assert.equal(verify(owner, utf8(message), unbase64(signed[0][1].signature)), true);
    // A message of another site, or of another account, is not signed.
    for (const other of [message.replace('app.example.test wants', 'evil.example wants'), message.replace(owner, v.agent)]) {
      const refused = element('wallet-sign-in', {network, message: other});
      const errors = events(refused, 'allowit-signed-in', 'allowit-error');
      const before = page.asked.length;
      await click(refused, 'Approve the sign-in message');
      assert.deepEqual([errors[0][0], errors[0][1].code, page.asked.length], ['allowit-error', 'invalid', before]);
    }
  } finally {page.remove();}
  // Without a wallet of the network the element reports that none is available.
  const none = element('wallet-sign-in', {network});
  const errors = events(none, 'allowit-error');
  await click(none, 'Sign in with a Solana wallet');
  assert.equal(errors[0][1].code, 'wallet_unavailable');
});

/** A setup of `owner` as the workflow prepares it. */
async function setup(now = Date.now()) {
  const fetch = node({
    getMinimumBalanceForRentExemption: ([length]) => length === 165 ? 1_488_440 : 2_810_840,
    getAccountInfo: {context: {slot: 10}, value: null},
    getLatestBlockhash: {context: {slot: 10}, value: {blockhash: v.blockhash, lastValidBlockHeight: 400}},
  });
  return prepareSetup({network, owner, agent: v.agent, server: v.server, amount: '5', asset: USDC, fetch, now: () => now});
}

test('the owner reads what a setup does and signs exactly its message', async () => {
  const prepared = await setup();
  const page = wallet();
  try {
    const node = element('owner-sign', {network, step: prepared.step, summary: [{label: 'Policy', value: 'Pay for data'}], owner});
    const text = node.textContent;
    assert.match(text, /Policy.*Pay for data/);
    assert.ok(text.includes(prepared.wallet) && text.includes(v.agent) && text.includes('USDC, mint'));
    assert.match(text, /spend up to 5 USDC from the wallet, only together\. This step moves no USDC/);
    assert.match(text, /0\.00429928 SOL that the network locks/);
    const seen = events(node, 'allowit-signed', 'allowit-error');
    await click(node, 'Sign in wallet');
    assert.equal(seen[0][0], 'allowit-signed', JSON.stringify(seen));
    assert.equal(seen[0][1].hash, prepared.step.hash);
    // The wallet got the transaction without a signature, and the workflow's `complete` takes what it signed.
    const [, input] = page.asked.find(([kind]) => kind === 'transaction');
    assert.equal(input.chain, 'solana:devnet');
    assert.ok(readWire(input.transaction).signatures[0].every(b => b === 0));
    assert.equal(prepared.complete(seen[0][1].signedPayload), seen[0][1].signedPayload);
    assert.equal(signatureOf(prepared.step.hash), base58(unbase64(seen[0][1].signedPayload).subarray(1, 65)));
    // Cancel reports and signs nothing.
    const cancelled = events(node, 'allowit-cancel');
    await click(node, 'Cancel');
    assert.equal(cancelled.length, 1);
  } finally {page.remove();}
});

test('a setup under another owner, an expired step and a changed transaction are not signed', async () => {
  const prepared = await setup();
  const invalid = data => assert.equal(element('owner-sign', data).textContent, 'This owner step is invalid.');
  invalid({network, step: prepared.step, summary: [], owner: v.agent});
  invalid({network, step: {...prepared.step, hash: 'ab'.repeat(32)}, summary: []});
  invalid({network: 'unknown:none', step: prepared.step, summary: []});
  invalid({network, step: {...prepared.step, payload: 'AAAA'}, summary: []});
  // A transaction that is no setup is refused under the setup action.
  invalid({network, step: {...prepared.step, payload: v.refill.message, hash: v.refill.hash}, summary: []});
  const sign = async (data, options) => {
    const page = wallet(options);
    try {
      const node = element('owner-sign', data);
      const seen = events(node, 'allowit-signed', 'allowit-error');
      await click(node, 'Sign in wallet');
      return {seen, asked: page.asked};
    } finally {page.remove();}
  };
  const old = await setup(1_700_000_000_000);
  const expired = await sign({network, step: old.step, summary: [], owner});
  assert.deepEqual([expired.seen[0][0], expired.seen[0][1].code, expired.asked.length], ['allowit-error', 'expired', 0]);
  // A wallet that adds an instruction returns another message: nothing is reported as signed.
  const added = await sign({network, step: prepared.step, summary: [], owner}, {tamper: (signed, key) => {
    const {parsed} = readWire(signed);
    const message = messageBytes(compile([], parsed.keys[0], parsed.blockhash));
    return wire([ed25519.sign(message, key)], message);
  }});
  assert.deepEqual([added.seen[0][0], added.seen[0][1].code], ['allowit-error', 'wallet_signed_other_transaction']);
  // A wallet whose account is another key is refused before it signs.
  const other = await sign({network, step: prepared.step, summary: [], owner}, {key: Uint8Array.from({length: 32}, () => 5)});
  assert.deepEqual([other.seen[0][0], other.seen[0][1].code, other.asked.length], ['allowit-error', 'wallet_wrong_account', 0]);
  // A wallet that offers only another cluster is not asked.
  const mainnet = await sign({network, step: prepared.step, summary: [], owner}, {chains: ['solana:mainnet']});
  assert.equal(mainnet.seen[0][1].code, 'wallet_unavailable');
});

test('a step that the server prepared is described instruction by instruction', () => {
  const step = ownerStep({action: 'fund', payload: v.refill.message, hash: v.refill.hash, expiresAt: Math.floor(Date.now() / 1000) + 60});
  const tx = stepMessage(step);
  assert.equal(tx.owner, v.owner);
  assert.deepEqual(describe(tx.parsed, network), [
    `Let the wallet's agent and the server spend up to 7 USDC from the wallet ${v.tokenAccount}. This replaces the earlier allowance and moves no tokens.`,
    'A note that names this request.',
  ]);
  const text = element('owner-sign', {network, step, summary: []}).textContent;
  assert.match(text, /spend up to 7 USDC/);
  assert.equal(stepMessage({...step, hash: 'ab'.repeat(32)}), null);
  assert.equal(ownerStep({...step, hash: 'AB'.repeat(32)}), null);
  assert.equal(ownerStep({...step, expiresAt: 0}), null);
  // An approval message is no transaction.
  assert.equal(stepMessage(approvalStep('text')), null);
});

test('the approval step signs the approval message of the reviewed policy', async () => {
  const source = 'pub fn execute() {}', params = {payment_limit: {Int: '1000000'}};
  const {sha256, hex} = await import('../dist/bytes.js');
  const json = v.consent.message.slice(v.consent.message.indexOf('\n') + 1);
  const fields = {...JSON.parse(json), source, sourceHash: hex(sha256(utf8(source))), params, paramsHash: hex(sha256(utf8(canonical(params))))};
  const message = `Allowit: I approve this policy source for my wallet.\n${JSON.stringify(fields)}`;
  const step = approvalStep(message);
  const page = wallet();
  try {
    const node = element('owner-sign', {network, step, summary: [], owner, expected: {policyId: 'policy-1', wallet: v.tokenAccount, sourceHash: fields.sourceHash}});
    assert.match(node.textContent, /It moves no funds\./);
    const seen = events(node, 'allowit-signed', 'allowit-error');
    await click(node, 'Sign the approval');
    assert.equal(seen[0][0], 'allowit-signed');
    assert.equal(verify(owner, utf8(message), unbase64(seen[0][1].signedPayload)), true);
    assert.equal(plugin.ownerChain.approval.signedBy(owner, step.hash, Array.from(unbase64(seen[0][1].signedPayload))), true);
    assert.equal(messageHash(utf8(message)), step.hash);
  } finally {page.remove();}
  // Another policy than the page reviewed, or a text that is no approval, is not shown for signing.
  const invalid = data => assert.equal(element('owner-sign', data).textContent, 'This owner step is invalid.');
  invalid({network, step, summary: [], expected: {policyId: 'policy-2'}});
  invalid({network, step, summary: [], expected: {wallet: v.delegate}});
  invalid({network, step: approvalStep('Send all funds'), summary: []});
  invalid({network, step: {...step, payload: base64(utf8(`${message} `))}, summary: []});
});

test('the binding review reports whether an installation is of this network', async () => {
  const report = async installation => {
    const node = element('binding-review', {network, installation});
    const seen = events(node, 'allowit-verified');
    node.render();
    await new Promise(done => setImmediate(done));
    return seen.at(-1)[1];
  };
  const installed = {network, owner: v.owner, wallet: v.tokenAccount, sourceHash: 'ab'.repeat(32), state: 'installed'};
  assert.deepEqual(await report(installed), {ok: true, detail: 'installed'});
  assert.deepEqual(await report({...installed, network: 'other:testnet'}), {ok: false, detail: 'mismatch'});
  assert.deepEqual(await report({...installed, owner: v.tokenAccount}), {ok: false, detail: 'mismatch'});
  assert.deepEqual(await report({...installed, state: 'draft'}), {ok: false, detail: 'mismatch'});
});
