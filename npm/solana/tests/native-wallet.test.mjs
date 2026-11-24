// The browser package against what the rail crate makes (`tests/vectors.json`, written by the crate's own test).
import assert from 'node:assert/strict';
import test from 'node:test';
import {base58, base64, hex, sha256, unbase58, unbase64, utf8} from '../dist/bytes.js';
import {address, canSign, messageBytes, readMessage, readWire, verify} from '../dist/message.js';
import {APPROVE_POLICY, SET_UP_WALLET, approvalHolds, approvalMessage, approvalSignedBy, approvalStep, canonical, messageHash,
  policyApproval, prepareSetup, setupMessage, setupOf, signedSetupOf, walletConfiguration, walletOf, walletOwner} from '../dist/native-wallet.js';

import {USDC, found, node, roles, v} from './helpers.mjs';

test('base58 and base64 read only the one encoding of their bytes', () => {
  const key = address(v.owner);
  assert.equal(key.length, 32);
  assert.equal(base58(key), v.owner);
  assert.equal(unbase58(`1${v.owner}`, 32), null);
  assert.equal(unbase58(v.owner.replace(/.$/, '0'), 32), null);
  assert.equal(unbase58('1'.repeat(32), 32).every(b => b === 0), true);
  assert.equal(unbase58('1'.repeat(33), 32), null);
  assert.equal(unbase58(v.owner, 64), null);
  assert.equal(base64(unbase64('AQID')), 'AQID');
  assert.equal(unbase64('AQI'), null);
  assert.equal(unbase64('AQJ='), null, 'padding bits must be zero');
  assert.equal(unbase64('AQ I='), null);
});

test('the wallet addresses are the addresses that the crate derives', () => {
  const own = walletOf(roles);
  assert.deepEqual(own, {tokenSeed: v.tokenSeed, delegateSeed: v.delegateSeed, tokenAccount: v.tokenAccount, delegate: v.delegate});
  // One key in two roles, a derived address as a key and an invalid mint are refused.
  assert.throws(() => walletOf({...roles, agent: v.server}), /three different keys/);
  assert.throws(() => walletOf({...roles, agent: v.owner}), /three different keys/);
  assert.throws(() => walletOf({...roles, agent: v.tokenAccount}), /agent key/);
  assert.throws(() => walletOf({...roles, mint: 'not-a-mint'}), /token/);
  assert.equal(canSign(v.owner), true);
  assert.equal(canSign(v.tokenAccount), false, 'a seeded address is no key');
  assert.equal(canSign('11111111111111111111111111111111'), false);
});

test('every setup message is byte for byte the message of the crate', () => {
  for (const vector of v.setups) {
    const terms = {...roles, allowance: BigInt(v.allowance), decimals: 6, token: found(vector.token), delegate: found(vector.delegate), tag: v.tag, blockhash: v.blockhash};
    const bytes = messageBytes(setupMessage(terms));
    assert.equal(base64(bytes), vector.message, JSON.stringify([vector.token, vector.delegate]));
    assert.equal(messageHash(bytes), vector.hash);
    // The message reads back to itself.
    assert.equal(base64(messageBytes(readMessage(bytes))), vector.message);
  }
  assert.throws(() => setupMessage({...roles, allowance: -1n, decimals: 6, token: 'ready', delegate: 'ready', tag: v.tag, blockhash: v.blockhash}), /out of range/);
  assert.throws(() => setupMessage({...roles, allowance: 1n, decimals: 6, token: 'ready', delegate: 'ready', tag: '', blockhash: v.blockhash}), /tag/);
});

test('message bytes that are cut, extended or versioned are no message', () => {
  const bytes = unbase64(v.setups[0].message);
  assert.equal(readMessage(bytes.subarray(0, bytes.length - 1)), null);
  assert.equal(readMessage(Uint8Array.of(...bytes, 0)), null);
  const versioned = bytes.slice();
  versioned[0] |= 0x80;
  assert.equal(readMessage(versioned), null);
  assert.equal(readWire(Uint8Array.of(2, ...new Uint8Array(128), ...bytes)), null, 'two signatures for one signer');
});

/** A setup as this package prepares it, with the given ledger state. */
async function prepared(state = {}, now = 1_800_000_000_000) {
  const asked = [];
  const accounts = state.accounts ?? {};
  const fetch = node({
    getMinimumBalanceForRentExemption: ([length]) => length === 165 ? 1_488_440 : 2_810_840,
    getAccountInfo: ([at]) => ({context: {slot: 10}, value: accounts[at] ?? null}),
    getLatestBlockhash: {context: {slot: 10}, value: {blockhash: v.blockhash, lastValidBlockHeight: 400}},
  }, asked);
  const setup = await prepareSetup({network: v.network, owner: v.owner, agent: v.agent, server: v.server, amount: '5', asset: USDC, fetch, now: () => now, ...state.input});
  return {setup, asked};
}
/** Sign prepared setup bytes with a test key: the crate's signed setup gives the owner's key no secret here. */
const tokenAccountData = (mint, owner, delegate = null, allowance = 0n) => {
  const data = new Uint8Array(165);
  data.set(address(mint), 0);
  data.set(address(owner), 32);
  if (delegate) {
    data.set([1, 0, 0, 0], 72);
    data.set(address(delegate), 76);
    new DataView(data.buffer).setBigUint64(121, allowance, true);
  }
  data[108] = 1;
  return data;
};
const rpcAccount = (owner, data, lamports = 2_000_000) => ({lamports, owner, data: [base64(data), 'base64'], executable: false, rentEpoch: 0});

test('a prepared setup opens what the finalized bank lacks and is read back from its bytes', async () => {
  const {setup, asked} = await prepared();
  assert.equal(setup.wallet, v.tokenAccount);
  assert.equal(setup.step.action, SET_UP_WALLET);
  assert.equal(setup.step.expiresAt, 1_800_000_090);
  assert.ok(asked.every(call => call.url === 'https://api.devnet.solana.com'));
  // Every read is of the finalized bank.
  for (const call of asked) assert.equal((call.params.at(-1)).commitment, 'finalized', call.method);
  // The step's payload is the message that the owner signs, and its hash names that message.
  const message = unbase64(setup.step.payload);
  assert.equal(messageHash(message), setup.step.hash);
  const facts = setupOf(message, readMessage(message));
  assert.deepEqual({...facts, allowance: String(facts.allowance), deposits: String(facts.deposits)}, {
    ...roles, wallet: v.tokenAccount, delegate: v.delegate, allowance: '5000000', decimals: 6, deposits: String(1_488_440 + 2_810_840),
    validUntil: 1_800_000_090, blockhash: v.blockhash,
  });
  // The same roles on the crate's tag and deposits give the crate's first message.
  const same = setupMessage({...roles, allowance: 5_000_000n, decimals: 6, token: {nothing: 1_488_440n}, delegate: {nothing: 2_810_840n}, tag: v.tag, blockhash: v.blockhash});
  assert.equal(base64(messageBytes(same)), v.setups[0].message);
});

test('a setup reuses accounts that are ready, tops up a funded address and refuses any other account', async () => {
  const SYSTEM = '11111111111111111111111111111111', TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const multisig = new Uint8Array(355);
  multisig.set([2, 2, 1]);
  multisig.set(address(v.agent), 3);
  multisig.set(address(v.server), 35);
  const ready = await prepared({accounts: {
    [v.tokenAccount]: rpcAccount(TOKEN, tokenAccountData(v.mint, v.owner)), [v.delegate]: rpcAccount(TOKEN, multisig)}});
  const facts = payload => {const message = unbase64(payload); return setupOf(message, readMessage(message));};
  assert.equal(facts(ready.setup.step.payload).deposits, 0n);
  const funded = await prepared({accounts: {[v.tokenAccount]: rpcAccount(SYSTEM, new Uint8Array(), 1_000_000)}});
  assert.equal(facts(funded.setup.step.payload).deposits, 488_440n + 2_810_840n);
  // Another owner's token account, a frozen one, a multisig of other keys and a program account are refused.
  for (const accounts of [
    {[v.tokenAccount]: rpcAccount(TOKEN, tokenAccountData(v.mint, v.agent))},
    {[v.tokenAccount]: rpcAccount(TOKEN, Object.assign(tokenAccountData(v.mint, v.owner), {108: 2}))},
    {[v.delegate]: rpcAccount(TOKEN, Object.assign(multisig.slice(), {0: 1}))},
    {[v.delegate]: rpcAccount(v.agent, new Uint8Array(355))},
  ]) await assert.rejects(prepared({accounts}), /holds another account/);
});

test('a setup is prepared only for a listed token, a readable amount and three keys', async () => {
  const refuse = (input, pattern) => assert.rejects(prepared({input}), pattern);
  await refuse({asset: null}, /token/);
  await refuse({asset: {symbol: 'SOL', issuer: null}}, /token/);
  await refuse({asset: {symbol: 'USDC', issuer: v.agent}}, /token/);
  await refuse({asset: {symbol: 'USDT', issuer: v.mint}}, /token/);
  await refuse({amount: '1.0000001'}, /at most 6 decimals/);
  await refuse({amount: '-1'}, /at most 6 decimals/);
  await refuse({amount: '1e3'}, /at most 6 decimals/);
  await refuse({agent: v.owner}, /three different keys/);
  await refuse({server: v.tokenAccount}, /server key/);
  await refuse({network: 'solana:mainnet'}, /supported Solana network/);
  // A node that answers nothing readable signs nothing.
  await assert.rejects(prepareSetup({network: v.network, owner: v.owner, agent: v.agent, server: v.server, amount: '5', asset: USDC, fetch: node({})}), /refused/);
});

test('signed setup bytes are read only with the owner signature over exactly a setup', () => {
  // The crate signed its own setup, whose tag is not this package's: its bytes are a valid transaction and no setup here.
  const crate = readWire(unbase64(v.signedSetup));
  assert.equal(base58(crate.signatures[0]), v.signedSetupSignature);
  assert.equal(verify(v.owner, crate.message, crate.signatures[0]), true);
  assert.equal(verify(v.agent, crate.message, crate.signatures[0]), false);
  assert.equal(signedSetupOf(v.signedSetup, v.network), null);
  assert.equal(setupOf(crate.message, crate.parsed), null);
});

test('the installation document is the document of the crate', () => {
  assert.deepEqual(walletConfiguration(v.network, v.tokenAccount, v.owner, v.agent, v.server, USDC), v.configuration);
  assert.throws(() => walletConfiguration(v.network, v.delegate, v.owner, v.agent, v.server, USDC), /not the token account/);
  assert.throws(() => walletConfiguration(v.network, v.tokenAccount, v.owner, v.agent, v.server, null), /token/);
  assert.throws(() => walletConfiguration('solana:other', v.tokenAccount, v.owner, v.agent, v.server, USDC), /network/);
});

/** An approval message as the server writes it, for `fields` over the crate's payload. */
function approvalOf(change = {}) {
  const [title, json] = [v.consent.message.slice(0, v.consent.message.indexOf('\n')), v.consent.message.slice(v.consent.message.indexOf('\n') + 1)];
  const source = 'pub fn execute() {}';
  const params = {payment_limit: {Int: '1000000'}};
  const fields = {...JSON.parse(json), source, sourceHash: hex(sha256(utf8(source))), params, paramsHash: hex(sha256(utf8(canonical(params)))), ...change};
  return {message: `${title}\n${JSON.stringify(fields)}`, source, params, fields};
}

test('the approval text of the crate is read, and its signature is the owner signature over the text itself', () => {
  // The crate's own text has placeholder hashes: it has the title and the plain form, and its hashes do not hold.
  assert.equal(policyApproval(v.consent.message, v.network), null);
  const {message, source, params, fields} = approvalOf();
  const read = policyApproval(message, v.network);
  assert.deepEqual([read.policyId, read.revision, read.wallet, read.source], ['policy-1', 3, v.tokenAccount, source]);
  assert.deepEqual(read.params, params);
  assert.deepEqual(read.fields, fields);
  // The wallet signs the message bytes: the crate's signature holds for the crate's text.
  const step = approvalStep(v.consent.message, 1_800_000_000_000);
  assert.deepEqual([step.action, step.expiresAt], [APPROVE_POLICY, 1_800_000_300]);
  assert.equal(approvalMessage(step), v.consent.message);
  assert.equal(approvalMessage({...step, hash: 'ab'.repeat(32)}), null);
  const signature = Array.from(unbase64(v.consent.signature));
  assert.equal(approvalSignedBy(v.owner, step.hash, signature), true);
  assert.equal(approvalSignedBy(v.agent, step.hash, signature), false);
  assert.equal(approvalSignedBy(v.owner, approvalStep(message).hash, signature), false, 'another message');
  assert.equal(approvalSignedBy(v.owner, 'cd'.repeat(32), signature), false, 'a hash that no step of this page has');
});

test('an approval text of another form, network, route or hash is not read', () => {
  const {message} = approvalOf();
  const body = message.slice(message.indexOf('\n') + 1);
  for (const bad of [
    message.replace('Allowit:', 'AllowIt:'), `${message} `, message.replace('{"', '{ "'), `Allowit: I approve this policy source for my wallet.\n[]`,
    // A key twice: the text is not the plain form of its own content.
    message.replace('{"agent"', '{"agent":"x","agent"'),
    approvalOf({network: 'solana:other'}).message, approvalOf({route: 'policyWallet'}).message, approvalOf({revision: 0}).message,
    approvalOf({policyId: ''}).message, approvalOf({wallet: 'x'}).message, approvalOf({sourceHash: 'ab'.repeat(32)}).message,
    approvalOf({paramsHash: 'ab'.repeat(32)}).message, body, 7, null,
  ]) assert.equal(policyApproval(bad, v.network), null, String(bad).slice(0, 80));
  assert.equal(policyApproval(message, 'solana:other'), null);
});

test('an approval holds only for exactly the reviewed policy, wallet and token', () => {
  const {message, source, params} = approvalOf();
  const read = policyApproval(message, v.network);
  const reviewed = {source, params, asset: USDC};
  assert.equal(approvalHolds(read, v.tokenAccount, reviewed), true);
  assert.equal(approvalHolds(read, v.tokenAccount, {...reviewed, rules: ['payment_limit'], tier: null}), true);
  const refused = (change, wallet = v.tokenAccount, policy = reviewed) =>
    assert.equal(approvalHolds(policyApproval(approvalOf(change).message, v.network), wallet, policy), false, JSON.stringify(change));
  refused({}, v.delegate);
  refused({}, v.tokenAccount, {...reviewed, source: `${source} `});
  refused({}, v.tokenAccount, {...reviewed, params: {payment_limit: {Int: '1000001'}}});
  refused({}, v.tokenAccount, {...reviewed, rules: ['daily_spending_limit']});
  refused({}, v.tokenAccount, {...reviewed, tier: 'common'});
  refused({}, v.tokenAccount, {...reviewed, asset: {symbol: 'SOL', issuer: null}});
  refused({}, v.tokenAccount, {...reviewed, asset: null});
  refused({mint: v.agent});
  refused({tier: 'simple'});
  refused({maxFeeLamports: 20_001});
  refused({maxFeeLamports: 0});
  refused({agent: v.server});
  refused({agent: v.tokenAccount});
  refused({language: 'Portable V1'});
  refused({extra: 1});
  refused({toString: 1});
  // The server's own digests may be any value: a Native wallet enforces none of them.
  assert.equal(approvalHolds(policyApproval(approvalOf({irHash: 'ef'.repeat(32)}).message, v.network), v.tokenAccount, reviewed), true);
});

test('the owner of a wallet is the owner of its token account in the finalized bank', async () => {
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const read = accounts => walletOwner(v.network, v.tokenAccount, node({getAccountInfo: ([at]) => ({context: {slot: 1}, value: accounts[at] ?? null})}));
  assert.equal(await read({[v.tokenAccount]: rpcAccount(TOKEN, tokenAccountData(v.mint, v.owner))}), v.owner);
  assert.equal(await read({}), null);
  assert.equal(await read({[v.tokenAccount]: rpcAccount(v.agent, tokenAccountData(v.mint, v.owner))}), null);
  assert.equal(await walletOwner(v.network, v.tokenAccount, node({})), null);
});
