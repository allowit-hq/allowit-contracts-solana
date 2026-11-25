// The hooks of the SDK's owner workflows, with an owner key that signs and a fake RPC node.
import assert from 'node:assert/strict';
import test from 'node:test';
import {ed25519} from '@noble/curves/ed25519';
import {base58, base64, unbase64} from '../dist/bytes.js';
import {readWire, wire} from '../dist/message.js';
import {checkAsset, messageHash, prepareSetup, sendSetup, signedSetupOf} from '../dist/native-wallet.js';
import {expiredRecord, ownerChain, transaction} from '../dist/owner-chain.js';
import {signatureOf} from '../dist/signatures.js';
import {USDC, forgedRefill, node, v} from './helpers.mjs';

const secret = Uint8Array.from({length: 32}, (_, i) => i + 1);
const owner = base58(ed25519.getPublicKey(secret));
const NOW = 1_800_000_000_000;

/** A setup of `owner`, prepared against an empty ledger and signed as a wallet signs it. */
async function signedSetup(input = {}) {
  const fetch = node({
    getMinimumBalanceForRentExemption: ([length]) => length === 165 ? 1_488_440 : 2_810_840,
    getAccountInfo: {context: {slot: 10}, value: null},
    getLatestBlockhash: {context: {slot: 10}, value: {blockhash: v.blockhash, lastValidBlockHeight: 400}},
  });
  const setup = await prepareSetup({network: v.network, owner, agent: v.agent, server: v.server, amount: '5', asset: USDC, fetch, now: () => NOW, ...input});
  const message = unbase64(setup.step.payload);
  const sign = key => base64(wire([ed25519.sign(message, key)], message));
  return {setup, message, sign, signed: setup.complete(sign(secret))};
}

test('complete takes only the reviewed message with the owner signature', async () => {
  const {setup, message, sign, signed} = await signedSetup();
  assert.equal(readWire(unbase64(signed)).signatures.length, 1);
  assert.throws(() => setup.complete(sign(Uint8Array.from({length: 32}, () => 9))), /another account than the owner/);
  const other = await signedSetup({amount: '6'});
  assert.throws(() => setup.complete(other.signed), /another transaction/);
  assert.throws(() => setup.complete(base64(wire([new Uint8Array(64)], message))), /another account than the owner/);
  assert.throws(() => setup.complete('not base64'), /another transaction/);
  assert.throws(() => setup.complete(base64(message)), /another transaction/);
});

test('signed setup bytes state their hash, roles, token, allowance and time bound', async () => {
  const {setup, signed} = await signedSetup({amount: '12.5'});
  const read = ownerChain.keypairSetup.read(signed, v.network);
  assert.deepEqual(read, {hash: setup.step.hash, owner, wallet: setup.wallet, agent: v.agent, server: v.server, validUntil: NOW / 1000 + 90,
    asset: USDC, amount: '12.5'});
  assert.equal(ownerChain.keypairSetup.read(signed, 'solana:other'), null);
  // One changed byte of the message breaks the owner signature; one changed byte of the signature too.
  const bytes = unbase64(signed);
  for (const at of [1, 70, bytes.length - 1]) {
    const changed = bytes.slice();
    changed[at] ^= 1;
    assert.equal(ownerChain.keypairSetup.read(base64(changed), v.network), null, `byte ${at}`);
  }
  // The rail now knows the signature of the step's hash.
  assert.equal(signatureOf(setup.step.hash), base58(bytes.subarray(1, 65)));
  assert.equal(signatureOf('ab'.repeat(32)), null);
});

test('the token of signed setup bytes and of a refill step is checked against the reviewed policy', async () => {
  const {signed} = await signedSetup();
  const mismatch = (run, pattern) => assert.throws(run, error => error.code === 'asset_mismatch' && pattern.test(error.message));
  ownerChain.keypairSetup.checkAsset(signed, v.network, USDC);
  mismatch(() => checkAsset(signed, v.network, null), /not a token/);
  mismatch(() => checkAsset(signed, v.network, {symbol: 'SOL', issuer: null}), /not a token/);
  mismatch(() => checkAsset(signed, v.network, {symbol: 'USDC', issuer: v.agent}), /not a token/);
  // The refill step that the server prepares is the crate's owner step: one approval and a memo.
  checkAsset(v.refill.message, v.network, USDC);
  mismatch(() => checkAsset(v.setups[0].message, v.network, USDC), /neither/);
  mismatch(() => checkAsset('AAAA', v.network, USDC), /neither/);
  mismatch(() => checkAsset(signed, 'solana:other', USDC), /not a token/);
});

test('a refill step is checked against the wallet that its memo names, and every other approval is refused', async () => {
  const mismatch = (payload, pattern) => assert.throws(() => checkAsset(payload, v.network, USDC), error => error.code === 'asset_mismatch' && pattern.test(error.message));
  // The forger makes the crate's refill byte for byte, so the cases below differ from it only where they say.
  assert.equal(await forgedRefill(), v.refill.message);
  checkAsset(await forgedRefill(), v.network, USDC);
  // An approval of another delegate, here a key of the attacker, on the wallet itself.
  mismatch(await forgedRefill({delegate: v.recipient}), /neither/);
  // The same approval on another token account of the owner.
  mismatch(await forgedRefill({account: v.recipient}), /neither/);
  // A memo that names no roles, or another server, whose delegate the approval does not name.
  mismatch(await forgedRefill({memo: 'allowit:owner:fund'}), /neither/);
  mismatch(await forgedRefill({memo: `allowit:steps:${v.agent}:${v.recipient}:allowit:owner:fund`}), /neither/);
  // A stop, a recovery or a close is no refill.
  for (const step of v.ownerSteps) mismatch(step.message, /neither/);
});

/** A node that holds `held` for the setup's signature; `sent` collects what was sent. */
const chain = (held, sent = [], extra = {}) => node({
  sendTransaction: ([bytes]) => (sent.push(bytes), 'ignored'),
  getSignatureStatuses: () => ({context: {slot: 50}, value: [typeof held === 'function' ? held() : held]}),
  ...extra,
});
const finalized = (slot, err = null) => ({slot, confirmations: null, err, confirmationStatus: 'finalized'});

test('a setup is sent once and is done only when the finalized bank holds it without an error', async () => {
  const {setup, signed} = await signedSetup();
  const wait = async () => {};
  const sent = [];
  assert.equal(await sendSetup(v.network, signed, setup.step.hash, chain(finalized(77), sent), wait), 77);
  assert.deepEqual(sent, [signed]);
  // A refused send proves nothing: the status decides.
  assert.equal(await sendSetup(v.network, signed, setup.step.hash, chain(finalized(78), [], {sendTransaction: new Error('already processed')}), wait), 78);
  assert.equal(await sendSetup(v.network, signed, setup.step.hash, chain(finalized(79, {InstructionError: [0, 'Custom']})), wait), null);
  // Confirmed and not finalized is not done; a node without an answer is not done.
  let polls = 0;
  assert.equal(await sendSetup(v.network, signed, setup.step.hash, chain(() => (polls++, {slot: 80, err: null, confirmationStatus: 'confirmed'})), wait), null);
  assert.equal(polls, 30);
  assert.equal(await sendSetup(v.network, signed, setup.step.hash, chain(null), wait), null);
  // Bytes of another hash are not sent.
  const other = [];
  assert.equal(await sendSetup(v.network, signed, 'ab'.repeat(32), chain(finalized(81), other), wait), null);
  assert.deepEqual(other, []);
});

test('the record of a step is its finalized slot, missing, or no answer', async () => {
  const {setup} = await signedSetup();
  const hash = setup.step.hash;
  assert.deepEqual(await transaction(v.network, hash, chain(finalized(90))), {hash, ledger: 90, successful: true});
  assert.deepEqual(await transaction(v.network, hash, chain(finalized(91, 'AccountInUse'))), {hash, ledger: 91, successful: false});
  assert.equal(await transaction(v.network, hash, chain(null)), 'missing');
  assert.equal(await transaction(v.network, hash, chain({slot: 92, err: null, confirmationStatus: 'confirmed'})), null);
  assert.equal(await transaction(v.network, hash, node({})), null);
  // A hash whose signed bytes this browser never saw has no answer: it is never called missing.
  assert.equal(await transaction(v.network, 'cd'.repeat(32), chain(null)), null);
  assert.equal(await transaction('solana:other', hash, chain(finalized(93))), null);
});

test('past its time bound a step never applied only when its blockhash lapsed and a current node holds no transaction', async () => {
  const {setup, signed} = await signedSetup();
  const hash = setup.step.hash;
  const at = (held, valid, slots = [50, 50]) => node({
    isBlockhashValid: {context: {slot: slots[0]}, value: valid},
    getSignatureStatuses: {context: {slot: slots[1]}, value: [held]},
  });
  assert.deepEqual(await expiredRecord(v.network, hash, signed, at(finalized(60), false)), {ledger: 60});
  assert.deepEqual(await expiredRecord(v.network, hash, signed, at(finalized(60), true)), {ledger: 60});
  // Finalized with an error: it ran, created nothing and can never run again.
  assert.equal(await expiredRecord(v.network, hash, signed, at(finalized(61, 'err'), false)), null);
  assert.equal(await expiredRecord(v.network, hash, signed, at(null, false)), null);
  // Not proven: a valid blockhash, a transaction that is not finalized, a node behind the bank, a silent node.
  await assert.rejects(expiredRecord(v.network, hash, signed, at(null, true)), /can still run/);
  await assert.rejects(expiredRecord(v.network, hash, signed, at({slot: 62, err: null, confirmationStatus: 'confirmed'}, false)), /not finalized/);
  await assert.rejects(expiredRecord(v.network, hash, signed, at(null, false, [50, 49])), /behind/);
  await assert.rejects(expiredRecord(v.network, hash, signed, node({})), /refused/);
  // Bytes of another hash, or without a signature, are no step of this hash.
  await assert.rejects(expiredRecord(v.network, 'ab'.repeat(32), signed, at(null, false)), /not the step/);
  const unsignedWire = base64(wire([new Uint8Array(64)], unbase64(setup.step.payload)));
  await assert.rejects(expiredRecord(v.network, hash, unsignedWire, at(null, false)), /not the step/);
  assert.equal(messageHash(unbase64(setup.step.payload)), hash);
  assert.ok(signedSetupOf(signed, v.network));
});
