import {describe, it, expect} from 'vitest';
import {Buffer} from 'buffer';
import {Keypair, PublicKey, Transaction} from '@solana/web3.js';
import codec from '../../tests/fixtures/native-v2-codec-reference.json' with {type: 'json'};
import {authority, binding, config, executor, key, owner, ownerKeypair, policy, prepared, walletSign} from '../../tests/fixtures/devnet-vault';
import {checkedOwnerTransaction, nativeBinding, ownerInstructions, signedProof} from './native-wallet-intent';
import type {Binding, NativeConfig, Prepared} from './native-contracts';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const fresh = (p: Prepared): Prepared => structuredClone(p);
/** Replaces the message as a backend that rewrote it would, echoing the change in both fields. */
function echo(p: Prepared, edit: (tx: Transaction) => void): Prepared {
  const tx = Transaction.from(Buffer.from(p.unsignedTransaction, 'base64'));
  edit(tx);
  const message = tx.serializeMessage();
  return {...p, message: message.toString('base64'), unsignedTransaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64')};
}

describe('SDK v2 codec reference (allowit-sdk native-rust/tests/v2-codec-reference.json)', () => {
  // The SDK fixture uses placeholder vault and token accounts (keys 5 and 6), so this binding is taken from it as-is.
  const fixtureBinding: Binding = {
    owner: codec.setup.payer, executor: Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58(), authority: codec.execute.authority,
    mint: key(4).toBase58(), vault: key(5).toBase58(), tokenAccount: key(6).toBase58(), policy: key(7).toBase58(), policyData: key(8).toBase58(), custody: key(9).toBase58(), bump: 255,
  };
  const fields = {amount: 100_000n, policyId: 'aa'.repeat(32), sourceBundle: '793db01595fbcb15503914744e49b45f470e9ca1d2805aceadeac00a0d843fc7', policyArtifact: 'cb55e2015dbc437cce58a53727c947cd1d8db75453623c5e53a4e4ea15b40dde', dailyLimit: 5_000_000n, actionLimit: 1_000_000n};

  it('rebuilds the single setup message and signed bytes exactly', () => {
    expect(codec.source).toBe('@solana/web3.js 1.98.4');
    expect(ownerKeypair.publicKey.toBase58()).toBe(codec.setup.payer);
    const tx = new Transaction({feePayer: ownerKeypair.publicKey, recentBlockhash: key(10).toBase58()}).add(...ownerInstructions(fixtureBinding, 'deploy', fields));
    expect(b64(tx.serializeMessage())).toBe(codec.setup.message);
    tx.sign(ownerKeypair);
    expect(b64(tx.serialize())).toBe(codec.setup.signed);
    expect(tx.serialize().length).toBe(codec.setup.bytes);
  });
});

describe('native v2 owner wallet intent', () => {
  it('derives the ABI-v2 binding with distinct owner, executor and authority', () => {
    expect(nativeBinding(config, policy, owner)).toEqual(binding);
    const v1 = PublicKey.findProgramAddressSync([Buffer.from('allowit-vault-v1'), ownerKeypair.publicKey.toBuffer(), Buffer.from(policy.id, 'hex')], key(9))[0].toBase58();
    expect(binding.vault).not.toBe(v1);
    expect(() => nativeBinding({...config, authority: config.executor}, policy, owner)).toThrow(/distinct/);
    expect(() => nativeBinding({...config, authority: owner}, policy, owner)).toThrow(/distinct/);
    expect(() => nativeBinding({...config, deployment: {...config.deployment, policyData: key(8).toBase58()}}, policy, owner)).toThrow(/ProgramData/);
    expect(() => nativeBinding({...config, network: 'solana:testnet'} as unknown as NativeConfig, policy, owner)).toThrow(/network/);
  });

  it('rejects any changed intent, binding or option before a signature', () => {
    const fund = prepared('fund', {amount: '1'});
    expect(() => checkedOwnerTransaction(config, policy, owner, 'fund', {amount: '2'}, fund)).toThrow(/intent/);
    expect(() => checkedOwnerTransaction(config, policy, owner, 'fund', {amount: '1'}, {...fresh(fund), intent: fund.intent.replace('"amount":"1"', '"amount":"1.0"')})).toThrow(/intent/);
    expect(() => checkedOwnerTransaction(config, policy, owner, 'fund', {amount: '1'}, {...fresh(fund), intent: fund.intent.replace(authority, executor)})).toThrow(/intent/);
    expect(() => checkedOwnerTransaction(config, policy, owner, 'fund', {amount: '1'}, {...fresh(fund), binding: {...binding, authority: executor}})).toThrow(/binding/);
    expect(() => checkedOwnerTransaction({...config, authority: Keypair.fromSeed(new Uint8Array(32).fill(5)).publicKey.toBase58()}, policy, owner, 'fund', {amount: '1'}, fund)).toThrow(/intent/);
    expect(() => checkedOwnerTransaction(config, {...policy, policyArtifact: '00'.repeat(32)}, owner, 'fund', {amount: '1'}, fund)).toThrow(/release/);
    expect(() => checkedOwnerTransaction(config, policy, owner, 'fund', {amount: '0'}, fund)).toThrow(/above 0/);
    expect(() => checkedOwnerTransaction(config, policy, owner, 'revoke', {amount: '1'}, prepared('revoke'))).toThrow(/no amount/);
    expect(() => checkedOwnerTransaction(config, policy, owner, 'deploy', {}, prepared('deploy', {amount: '1'}))).toThrow(/above 0/);
  });

  it('rejects message mutations even when the backend echoes them', () => {
    const fund = prepared('fund', {amount: '1'});
    const mutations: [string, (tx: Transaction) => void][] = [
      ['amount byte', tx => {tx.instructions[2].data[1] ^= 1;}],
      ['compute unit limit', tx => {tx.instructions[0].data[1] ^= 1;}],
      ['compute unit price', tx => {tx.instructions[1].data[1] = 2;}],
      ['dropped compute budget', tx => {tx.instructions.splice(0, 2);}],
      ['account role', tx => {tx.instructions[2].keys[3].isWritable = false;}],
      ['destination account', tx => {tx.instructions[2].keys[3].pubkey = key(6);}],
      ['blockhash', tx => {tx.recentBlockhash = key(11).toBase58();}],
    ];
    for (const [name, edit] of mutations) expect(() => checkedOwnerTransaction(config, policy, owner, 'fund', {amount: '1'}, echo(fund, edit)), name).toThrow(/wallet intent/);
    const signedSlot = {...fresh(fund), unsignedTransaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 7), Buffer.from(fund.message, 'base64')]).toString('base64')};
    expect(() => checkedOwnerTransaction(config, policy, owner, 'fund', {amount: '1'}, signedSlot)).toThrow(/wallet intent/);
    expect(() => checkedOwnerTransaction(config, policy, owner, 'fund', {amount: '1'}, {...fresh(fund), message: prepared('fund', {amount: '2'}).message})).toThrow(/wallet intent/);
  });

  it('refuses changed wallet bytes or a missing signature', () => {
    const value = prepared('fund', {amount: '1'});
    const tx = Transaction.from(Buffer.from(value.unsignedTransaction, 'base64'));
    expect(() => signedProof(value, tx, 'solana:devnet')).toThrow(/invalid signatures/);
    tx.instructions[2].data[1] ^= 1;
    expect(() => signedProof(value, walletSign(tx), 'solana:devnet')).toThrow(/wallet changed/);
  });
});
