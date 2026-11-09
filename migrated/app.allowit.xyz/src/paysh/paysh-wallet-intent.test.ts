import {describe, expect, it} from 'vitest';
import {Buffer} from 'buffer';
import {ComputeBudgetProgram, Keypair, SystemProgram, TransactionInstruction} from '@solana/web3.js';
import {chainConfig, deployment, draft, instructions, OWNER, owner, policy, POLICY_ADDRESS, prepared, REQUEST_ID, SOL_CUSTODY, v0Message, walletSign} from './fixtures/paysh-setup';
import {GOLDEN_REQUEST_ID, goldenDeployment, goldenPolicy, goldenPrepared, goldenSetup} from './fixtures/paysh-golden';
import type {PayshPolicy, PreparedSetup} from './paysh-contracts';
import {checkedSetup, decodeConfig, parseMessage, signedSetupProof, type Ix} from './paysh-wallet-intent';

/** Field checks run against a draft carrying the same Config bytes, so each term check is reached on its own. */
const check = (p = prepared(), id = REQUEST_ID, pol: PayshPolicy = policy, who = OWNER) => checkedSetup(deployment, {policy: pol, configBytes: p.configBytes}, who, id, p);
const ix = (i: TransactionInstruction): Ix => ({programId: i.programId.toBase58(), data: Uint8Array.from(i.data), keys: i.keys.map(k => ({...k, pubkey: k.pubkey.toBase58()}))});
const edited = (edit: (list: Ix[]) => Ix[]) => prepared({message: v0Message(instructions(chainConfig, edit))});

describe('PaySH owner setup intent', () => {
  it('rejects any additional instruction, even when the backend echoes its own message', () => {
    expect(() => check(edited(l => [...l, ix(ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1}))]))).toThrow(/wallet intent/);
    expect(() => check(edited(l => [ix(ComputeBudgetProgram.setComputeUnitPrice({microLamports: 1})), ...l]))).toThrow(/wallet intent/);
    expect(() => check(edited(l => [...l, ix(SystemProgram.transfer({fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1}))]))).toThrow(/wallet intent/);
    expect(() => check(edited(l => l.slice(1)))).toThrow(/wallet intent/);
  });

  it('rejects a changed transfer amount or recipient, compute limit or program', () => {
    expect(() => check(edited(l => [...l.slice(0, 4), ix(SystemProgram.transfer({fromPubkey: owner.publicKey, toPubkey: SOL_CUSTODY, lamports: 50_000_001}))]))).toThrow(/wallet intent/);
    expect(() => check(edited(l => [...l.slice(0, 4), ix(SystemProgram.transfer({fromPubkey: owner.publicKey, toPubkey: POLICY_ADDRESS, lamports: 50_000_000}))]))).toThrow(/wallet intent/);
    expect(() => check(edited(l => [ix(ComputeBudgetProgram.setComputeUnitLimit({units: 1_400_000})), ...l.slice(1)]))).toThrow(/wallet intent/);
    expect(() => check(edited(l => l.map((x, i) => (i === 3 ? {...x, programId: Keypair.generate().publicKey.toBase58()} : x))))).toThrow(/wallet intent/);
    expect(() => checkedSetup({...deployment, program: Keypair.generate().publicKey.toBase58()}, draft, OWNER, REQUEST_ID, prepared())).toThrow(/derived/);
  });

  it('rejects Config terms that differ from the reviewed policy or public deployment', () => {
    expect(() => check(prepared({config: {allocationLamports: '60000000'}}))).toThrow(/allocation/);
    expect(() => check(prepared({allocation: '40000000'}))).toThrow(/allocation/);
    expect(() => check(prepared({config: {serviceFeeLamports: '5001'}}))).toThrow(/service fee/);
    expect(() => check(prepared({config: {maxSwapLamportsPerCall: '2000001'}}))).toThrow(/swap input/);
    expect(() => check(prepared({config: {maxUsdcPerPeriod: '1001'}}))).toThrow(/test-token payment/);
    expect(() => check(prepared({config: {ownerOnly: true}}))).toThrow(/sponsored/);
    expect(() => check(prepared({config: {treasury: Keypair.generate().publicKey.toBase58()}}))).toThrow(/treasury/);
    expect(() => check(prepared({config: {pool: {...chainConfig.pool, state: Keypair.generate().publicKey.toBase58()}}}))).toThrow(/pool/);
    expect(() => check(prepared({config: {network: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'}}))).toThrow(/Testnet/);
    expect(() => check(prepared({config: {instanceId: 'ef'.repeat(32)}}))).toThrow(/different policy/);
  });

  it('rejects displayed terms that differ from the signed Config bytes', () => {
    const p = prepared();
    p.config = {...p.config, maxPoolFeeBps: '31'};
    expect(() => check(p)).toThrow(/wallet intent/);
  });

  it('rejects another owner, request identity, fee payer or non-derived accounts', () => {
    const other = Keypair.generate();
    expect(() => check(prepared(), REQUEST_ID, policy, other.publicKey.toBase58())).toThrow(/another owner|derived/);
    expect(() => check(prepared({id: 'other-request'}))).toThrow(/request identity/);
    expect(() => check(prepared({solCustody: other.publicKey.toBase58()}))).toThrow(/SOL custody/);
    expect(() => check(prepared({config: {vaultUsdc: other.publicKey.toBase58()}}))).toThrow(/associated/);
    const moved = {...policy, policyAddress: other.publicKey.toBase58()};
    expect(() => check(prepared({policy: moved}), REQUEST_ID, moved)).toThrow(/derived/);
    expect(() => check(prepared({message: v0Message(instructions(), true, other.publicKey)}))).toThrow(/wallet intent/);
  });

  it('rejects unknown or unpinned lookup tables', () => {
    expect(() => checkedSetup({...deployment, lookupTable: null}, draft, OWNER, REQUEST_ID, prepared())).toThrow(/wallet intent.*lookup table/);
    expect(() => checkedSetup({...deployment, lookupTable: {...deployment.lookupTable!, address: Keypair.generate().publicKey.toBase58()}}, draft, OWNER, REQUEST_ID, prepared())).toThrow(/wallet intent.*lookup table/);
    expect(() => checkedSetup({...deployment, lookupTable: {...deployment.lookupTable!, addresses: deployment.lookupTable!.addresses.slice(0, 2)}}, draft, OWNER, REQUEST_ID, prepared())).toThrow(/wallet intent.*outside/);
  });

  it('verifies the wallet signature over the unchanged message', async () => {
    const p = prepared(), checked = check(p);
    const proof = await signedSetupProof(p, checked, policy.id, OWNER, walletSign(p));
    expect(proof).toEqual({requestId: REQUEST_ID, policyId: policy.id, owner: OWNER, signature: proof.signature, signedBytes: proof.signedBytes, blockhash: proof.blockhash});
    expect(proof.signedBytes).toBe(Buffer.from(walletSign(p)).toString('base64'));
    const forged = walletSign(p);
    forged[1] ^= 1;
    await expect(signedSetupProof(p, checked, policy.id, OWNER, forged)).rejects.toThrow(/invalid signatures/);
    const changed = walletSign(p);
    changed[changed.length - 1] ^= 1;
    await expect(signedSetupProof(p, checked, policy.id, OWNER, changed)).rejects.toThrow(/changed the message/);
    await expect(signedSetupProof(p, checked, policy.id, OWNER, checked.wire)).rejects.toThrow(/invalid signatures/);
  });
});

/* The actual Rust SDK v0 owner setup from the public Testnet run. */
describe('PaySH golden Rust SDK setup', () => {
  const golden = {policy: goldenPolicy, configBytes: goldenSetup.configBytes};
  const checkGolden = (p: PreparedSetup = goldenPrepared(), d = goldenDeployment) => checkedSetup(d, golden, goldenSetup.owner, GOLDEN_REQUEST_ID, p);
  /** The same setup with edited message bytes; the unsigned wire follows the message. */
  const withMessage = (edit: (m: Buffer) => void) => {
    const m = Buffer.from(goldenSetup.message, 'base64');
    edit(m);
    return goldenPrepared({message: m.toString('base64'), unsignedTransaction: Buffer.concat([Buffer.from([1]), Buffer.alloc(64), m]).toString('base64')});
  };
  const message = Buffer.from(goldenSetup.message, 'base64');

  it('accepts the exact SDK packet, which loads the policy, SOL custody and both token accounts as writable', () => {
    const checked = checkGolden();
    expect(checked.version).toBe(0);
    expect(checked.wire.length).toBe(968);
    const parsed = parseMessage(checked.message, goldenDeployment.lookupTable);
    expect(parsed.lookups).toHaveLength(1);
    const {vaultUsdc, vaultWsol} = decodeConfig(Buffer.from(goldenSetup.configBytes, 'base64'));
    const loaded = parsed.lookups[0].writable.map(i => goldenDeployment.lookupTable!.addresses[i]).sort();
    expect(loaded).toEqual([goldenSetup.policy, goldenSetup.solVault, vaultUsdc, vaultWsol].sort());
    expect(Buffer.from(parsed.instructions[4].data).readBigUInt64LE(4)).toBe(5_000_000n);
    expect(parsed.instructions[4].keys[1]).toEqual({pubkey: goldenSetup.solVault, isSigner: false, isWritable: true});
  });

  it('rejects a changed loaded recipient: another snapshot address or swapped lookup indexes', () => {
    const table = goldenDeployment.lookupTable!;
    const custody = table.addresses.indexOf(goldenSetup.solVault);
    const moved = {...goldenDeployment, lookupTable: {...table, addresses: table.addresses.map((a, i) => (i === custody ? Keypair.generate().publicKey.toBase58() : a))}};
    expect(() => checkGolden(goldenPrepared(), moved)).toThrow(/wallet intent/);
    // Writable lookup indexes are 14..11 bytes from the end: swap custody with the policy account.
    expect(() => checkGolden(withMessage(m => {const at = m.length - 14; [m[at], m[at + 2]] = [m[at + 2], m[at]];}))).toThrow(/wallet intent/);
  });

  it('rejects changed roles: a writable account moved to the read-only list, or a changed header', () => {
    expect(() => checkGolden(withMessage(m => {const w = m.length - 14, r = m.length - 9; [m[w], m[r]] = [m[r], m[w]];}))).toThrow(/wallet intent/);
    expect(() => checkGolden(withMessage(m => {m[3] -= 1;}))).toThrow(/wallet intent/);
    expect(() => checkGolden(withMessage(m => {m[2] = 1;}))).toThrow(/wallet intent/);
  });
});
