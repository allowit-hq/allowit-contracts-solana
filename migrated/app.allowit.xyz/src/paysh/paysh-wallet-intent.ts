import {Buffer} from 'buffer';
import {PublicKey, SystemProgram} from '@solana/web3.js';
import {isPayshGenesis, isPayshNetwork, samePolicy, type ChainConfig, type PayshDeployment, type PayshNetwork, type PolicyDraft, type PreparedSetup} from './paysh-contracts';
import {serviceAllowlistRoot} from './service-allowlist';

export const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const COMPUTE_BUDGET = new PublicKey('ComputeBudget111111111111111111111111111111');
export const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const PACKET_LIMIT = 1232;
const POLICY_SEED = Buffer.from('paysh-policy-v1');
const SOL_SEED = Buffer.from('paysh-sol-v1');
const CONFIG_BYTES = 14 * 32 + 13 * 8 + 8 + 1;

const key = (value: string) => new PublicKey(value);
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const u64 = (value: string) => {const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b;};
const i64 = (value: string) => {const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(value)); return b;};
const hex = (value: string) => Buffer.from(value, 'hex');

/** `[b"paysh-policy-v1", owner, instance_id]` under the PaySH program. */
export function policyAddress(program: string, owner: string, instanceId: string, version: 1 | 2 = 1): PublicKey {
  return PublicKey.findProgramAddressSync([version === 2 ? Buffer.from('paysh-policy-v2') : POLICY_SEED, key(owner).toBuffer(), hex(instanceId)], key(program))[0];
}
/** `[b"paysh-sol-v1", policy]`: the system-owned SOL custody the allocation is moved into. */
export function solCustody(program: string, policy: PublicKey, version: 1 | 2 = 1): PublicKey {
  return PublicKey.findProgramAddressSync([version === 2 ? Buffer.from('paysh-sol-v2') : SOL_SEED, policy.toBuffer()], key(program))[0];
}
export function associatedAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}

/* ------------------------------------------------------------------ Config */

const CONFIG_KEYS = ['evaluator', 'treasury', 'usdcMint', 'vaultUsdc', 'vaultWsol', 'vendorUsdc'] as const;
const POOL_KEYS = ['program', 'state', 'wsol', 'usdc', 'oracle'] as const;
const CONFIG_INTS = ['periodSeconds', 'maxUsdcPerPeriod', 'maxSwapLamportsPerPeriod', 'maxFeeLamportsPerPeriod', 'maxSolDebitsPerPeriod', 'maxSwapLamportsPerCall', 'maxTotalSwapLamports', 'allocationLamports', 'serviceFeeLamports', 'minUsdcPerSol', 'maxPoolFeeBps', 'maxAgeSlots', 'maxAgeSeconds'] as const;

/** Borsh `Config` in declaration order. */
export function encodeConfig(c: ChainConfig): Buffer {
  if (c.serviceAllowlistRoot !== undefined && !/^[0-9a-f]{64}$/.test(c.serviceAllowlistRoot)) throw new Error('The service allowlist root is invalid.');
  return Buffer.concat([
    hex(c.instanceId),
    key(c.network).toBuffer(),
    hex(c.moduleDigest),
    ...CONFIG_KEYS.map(k => key(c[k]).toBuffer()),
    ...POOL_KEYS.map(k => key(c.pool[k]).toBuffer()),
    ...CONFIG_INTS.map(k => u64(c[k])),
    i64(c.policyExpiresTimestamp),
    Buffer.from([c.ownerOnly ? 1 : 0]),
    ...(c.serviceAllowlistRoot === undefined ? [] : [hex(c.serviceAllowlistRoot)]),
  ]);
}
/** Borsh `Instruction::Initialize(Config)`: variant 0, then the Config. */
export const encodeInitialize = (c: ChainConfig) => Buffer.concat([Buffer.from([0]), encodeConfig(c)]);

/** Decodes the exact Config bytes the owner signs, so the terms shown are the terms stored. */
export function decodeConfig(bytes: Uint8Array): ChainConfig {
  if (bytes.length !== CONFIG_BYTES && bytes.length !== CONFIG_BYTES + 32) throw new Error('The setup Config has the wrong length.');
  const b = Buffer.from(bytes);
  let at = 0;
  const take = (n: number) => {const s = b.subarray(at, at + n); at += n; return s;};
  const k = () => new PublicKey(take(32)).toBase58();
  const c = {instanceId: take(32).toString('hex'), network: k(), moduleDigest: take(32).toString('hex')} as ChainConfig;
  for (const f of CONFIG_KEYS) c[f] = k();
  c.pool = {program: k(), state: k(), wsol: k(), usdc: k(), oracle: k()};
  for (const f of CONFIG_INTS) c[f] = take(8).readBigUInt64LE().toString();
  c.policyExpiresTimestamp = take(8).readBigInt64LE().toString();
  const flag = take(1)[0];
  if (flag > 1) throw new Error('The setup Config has an invalid flag.');
  c.ownerOnly = flag === 1;
  if (bytes.length === CONFIG_BYTES + 32) c.serviceAllowlistRoot = take(32).toString('hex');
  return c;
}

/* ------------------------------------------------------------------ messages */

export interface Meta {pubkey: string; isSigner: boolean; isWritable: boolean}
export interface Ix {programId: string; keys: Meta[]; data: Uint8Array}
export interface ParsedMessage {version: 'legacy' | 0; payer: string; signers: number; blockhash: string; instructions: Ix[]; lookups: {table: string; writable: number[]; readonly: number[]}[]; keyCount: number; referenced: Set<number>}

/**
 * Parses legacy and v0 message bytes exactly, resolving lookup-table indexes against the configured table's
 * public address list. Rejects trailing bytes, duplicate keys and program IDs loaded from a table.
 */
export function parseMessage(bytes: Uint8Array, lookupTable: PayshDeployment['lookupTable']): ParsedMessage {
  let at = 0;
  const byte = () => {if (at >= bytes.length) throw new Error('The setup message is truncated.'); return bytes[at++];};
  const take = (n: number) => {if (at + n > bytes.length) throw new Error('The setup message is truncated.'); const s = bytes.subarray(at, at + n); at += n; return s;};
  const compact = () => {let n = 0; for (let shift = 0; shift < 21; shift += 7) {const b = byte(); n |= (b & 0x7f) << shift; if (!(b & 0x80)) return n;} throw new Error('The setup message has an invalid length.');};
  const version = bytes[0] & 0x80 ? (bytes[0] & 0x7f) : 'legacy';
  if (version !== 'legacy' && version !== 0) throw new Error('The setup message version is not supported.');
  if (version === 0) at = 1;
  const [signers, readonlySigned, readonlyUnsigned] = [byte(), byte(), byte()];
  const statics = Array.from({length: compact()}, () => new PublicKey(take(32)).toBase58());
  const blockhash = new PublicKey(take(32)).toBase58();
  const raw = Array.from({length: compact()}, () => ({program: byte(), accounts: Array.from(take(compact())), data: Uint8Array.from(take(compact()))}));
  const lookups: ParsedMessage['lookups'] = [];
  if (version === 0) for (let n = compact(); n > 0; n--) lookups.push({table: new PublicKey(take(32)).toBase58(), writable: Array.from(take(compact())), readonly: Array.from(take(compact()))});
  if (at !== bytes.length) throw new Error('The setup message has trailing bytes.');
  if (signers < 1 || readonlySigned >= signers || signers + readonlyUnsigned > statics.length) throw new Error('The setup message header is invalid.');
  const loadedW: string[] = [], loadedR: string[] = [];
  for (const l of lookups) {
    if (!lookupTable || l.table !== lookupTable.address) throw new Error('The setup uses a lookup table that is not configured.');
    for (const [list, out] of [[l.writable, loadedW], [l.readonly, loadedR]] as const) for (const i of list) {
      if (i >= lookupTable.addresses.length) throw new Error('The setup uses a lookup index outside the configured table.');
      out.push(lookupTable.addresses[i]);
    }
  }
  const metas: Meta[] = [
    ...statics.map((pubkey, i) => ({pubkey, isSigner: i < signers, isWritable: i < signers ? i < signers - readonlySigned : i < statics.length - readonlyUnsigned})),
    ...loadedW.map(pubkey => ({pubkey, isSigner: false, isWritable: true})),
    ...loadedR.map(pubkey => ({pubkey, isSigner: false, isWritable: false})),
  ];
  if (new Set(metas.map(m => m.pubkey)).size !== metas.length) throw new Error('The setup message repeats an account.');
  const referenced = new Set<number>([0]);
  const instructions = raw.map(ix => {
    if (ix.program >= statics.length) throw new Error('The setup loads a program from a lookup table.');
    referenced.add(ix.program);
    return {programId: statics[ix.program], data: ix.data, keys: ix.accounts.map(i => {
      if (i >= metas.length) throw new Error('The setup references a missing account.');
      referenced.add(i);
      return metas[i];
    })};
  });
  return {version, payer: statics[0], signers, blockhash, instructions, lookups, keyCount: metas.length, referenced};
}

/** The owner setup, as instructions. Signer and writable flags are the union across the message, as compiled. */
export function expectedInstructions(deployment: PayshDeployment, owner: string, c: ChainConfig, allocationLamports: string): Ix[] {
  const version = c.serviceAllowlistRoot === undefined ? 1 : 2;
  const program = deployment.program, policy = policyAddress(program, owner, c.instanceId, version), custody = solCustody(program, policy, version);
  const m = (k: PublicKey | string, isWritable = false, isSigner = false): Meta => ({pubkey: typeof k === 'string' ? k : k.toBase58(), isSigner, isWritable});
  const payer = m(owner, true, true), system = SystemProgram.programId.toBase58();
  const limit = Buffer.alloc(5); limit[0] = 2; limit.writeUInt32LE(deployment.computeLimit, 1);
  const transfer = Buffer.alloc(12); transfer.writeUInt32LE(2, 0); transfer.writeBigUInt64LE(BigInt(allocationLamports), 4);
  const ata = (account: string, mint: string): Ix => ({programId: ATA_PROGRAM.toBase58(), data: Uint8Array.from([1]), keys: [payer, m(account, true), m(policy), m(mint), m(system), m(TOKEN_PROGRAM)]});
  const list: Ix[] = [
    {programId: COMPUTE_BUDGET.toBase58(), data: limit, keys: []},
    ata(c.vaultUsdc, c.usdcMint),
    ata(c.vaultWsol, NATIVE_MINT.toBase58()),
    {programId: program, data: encodeInitialize(c), keys: [m(policy, true), payer, m(c.vaultUsdc), m(c.vaultWsol), m(c.usdcMint), m(c.vendorUsdc), m(c.treasury), m(system), m(custody, true), ...POOL_KEYS.map(k => m(c.pool[k]))]},
    {programId: system, data: transfer, keys: [payer, m(custody, true)]},
  ];
  const union = new Map<string, Meta>();
  for (const k of list.flatMap(ix => ix.keys)) {
    const u = union.get(k.pubkey);
    union.set(k.pubkey, {pubkey: k.pubkey, isSigner: !!u?.isSigner || k.isSigner, isWritable: !!u?.isWritable || k.isWritable});
  }
  return list.map(ix => ({...ix, keys: ix.keys.map(k => union.get(k.pubkey)!)}));
}

export interface CheckedSetup {message: Uint8Array; wire: Uint8Array; version: 'legacy' | 0; blockhash: string; network?: PayshNetwork}

/**
 * Checks that the backend's unsigned setup is exactly the reviewed owner intent before the wallet opens: one
 * compute-unit limit from the public deployment, idempotent creation of the policy's two associated token
 * accounts, Initialize with the generated Config on the configured program, and one System transfer of exactly the
 * allocation to the policy's SOL custody. Nothing else and one signer. A v0 message may load accounts, writable or
 * not, from the configured lookup table; each resolved account and its signer/writable role must still equal the
 * expected instruction list, against the pinned public address snapshot. Never sign server bytes not checked here.
 */
export function checkedSetup(deployment: PayshDeployment, draft: Pick<PolicyDraft, 'policy' | 'configBytes'>, owner: string, requestId: string, prepared: PreparedSetup): CheckedSetup {
  const c = prepared.config, policy = draft.policy;
  if ((c.serviceAllowlistRoot !== undefined) !== (policy.allowedServiceIds !== undefined)) throw new Error('The service allowlist does not match the setup version.');
  if (policy.allowedServiceIds && serviceAllowlistRoot(policy.allowedServiceIds, c) !== c.serviceAllowlistRoot) throw new Error('The setup service allowlist differs from the reviewed services.');
  const version = c.serviceAllowlistRoot === undefined ? 1 : 2;
  if (policy.maxPaymentUsdcPerPeriod !== undefined && (version !== 2 || policy.maxPaymentUsdcPerPeriod === '0' || BigInt(policy.maxPaymentUsdcPerPeriod) < BigInt(policy.maxPaymentUsdc))) throw new Error('The setup has an invalid aggregate test-token payment budget.');
  const derived = policyAddress(deployment.program, owner, policy.id, version), custody = solCustody(deployment.program, derived, version);
  const vaultUsdc = associatedAddress(derived, key(deployment.usdcMint)), vaultWsol = associatedAddress(derived, NATIVE_MINT);
  if (prepared.requestId !== requestId) throw new Error('The backend changed the setup request identity.');
  if (policy.owner !== owner || prepared.accounts.owner !== owner) throw new Error('This policy belongs to another owner.');
  if (!samePolicy(prepared.policy, policy)) throw new Error('The backend prepared a different policy than the one reviewed.');
  if (prepared.configBytes !== draft.configBytes) throw new Error('The setup Config differs from the generated policy.');
  if (policy.policyAddress !== derived.toBase58() || prepared.accounts.policy !== derived.toBase58()) throw new Error('The policy account is not derived from this owner and policy.');
  if (prepared.accounts.solCustody !== custody.toBase58()) throw new Error('The SOL custody account is not derived from this policy.');
  if (c.vaultUsdc !== vaultUsdc.toBase58() || c.vaultWsol !== vaultWsol.toBase58()) throw new Error('The policy token accounts are not its associated accounts.');
  // Reviewed terms: the signed Config must carry exactly what the owner approved.
  if (c.instanceId !== policy.id || c.moduleDigest !== policy.moduleDigest || c.moduleDigest !== deployment.moduleDigest) throw new Error('The setup binds a different policy or module.');
  if (!isPayshNetwork(policy.network) || c.network !== deployment.genesis || !isPayshGenesis(policy.network, c.network)) throw new Error(`The setup is not bound to ${policy.network === 'solana:testnet' ? 'Solana Testnet' : 'the reviewed Solana network'}.`);
  if (c.allocationLamports !== policy.allocationLamports || prepared.allocationLamports !== policy.allocationLamports) throw new Error('The setup funds a different allocation.');
  if (c.serviceFeeLamports !== policy.maxServiceFeeLamports) throw new Error('The setup charges a different service fee.');
  if (c.maxSwapLamportsPerCall !== policy.maxSwapLamports) throw new Error('The setup allows a different swap input.');
  if (c.maxUsdcPerPeriod !== (policy.maxPaymentUsdcPerPeriod ?? policy.maxPaymentUsdc)) throw new Error('The setup allows a different test-token payment budget.');
  if (c.ownerOnly) throw new Error('The setup disables sponsored execution.');
  // Public deployment: every external account the policy may pay or read.
  const pinned: [string, string][] = [[c.evaluator, deployment.evaluator], [c.treasury, deployment.treasury], [c.usdcMint, deployment.usdcMint], [c.vendorUsdc, deployment.vendorUsdc], ...POOL_KEYS.map(k => [c.pool[k], deployment.pool[k]] as [string, string])];
  if (pinned.some(([got, want]) => got !== want)) throw new Error('The setup uses a different evaluator, treasury, token, vendor or pool.');

  const message = Buffer.from(prepared.message, 'base64'), wire = Buffer.from(prepared.unsignedTransaction, 'base64');
  if (!equal(wire, Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]))) throw new Error('The backend prepared a different wallet intent.');
  if (wire.length > PACKET_LIMIT) throw new Error('The setup transaction exceeds the Solana packet limit.');
  let parsed: ParsedMessage;
  try {
    parsed = parseMessage(message, deployment.lookupTable);
  } catch (e) {
    throw new Error(`The backend prepared a different wallet intent. ${e instanceof Error ? e.message : ''}`.trim());
  }
  const expected = expectedInstructions(deployment, owner, c, policy.allocationLamports);
  const same = (a: Ix, b: Ix) => a.programId === b.programId && equal(a.data, b.data) && a.keys.length === b.keys.length && a.keys.every((k, i) => k.pubkey === b.keys[i].pubkey && k.isSigner === b.keys[i].isSigner && k.isWritable === b.keys[i].isWritable);
  if (parsed.payer !== owner || parsed.signers !== 1 || parsed.referenced.size !== parsed.keyCount || parsed.instructions.length !== expected.length || !parsed.instructions.every((ix, i) => same(ix, expected[i]))) throw new Error('The backend prepared a different wallet intent.');
  return {message, wire, version: parsed.version, blockhash: parsed.blockhash, network: policy.network};
}

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let n = 0n, out = '';
  for (const b of bytes) n = n * 256n + BigInt(b);
  while (n) {out = ALPHABET[Number(n % 58n)] + out; n /= 58n;}
  for (const b of bytes) {if (b) break; out = '1' + out;}
  return out;
}

/** Contains no keys. */
export interface SignedSetup {requestId: string; policyId: string; owner: string; signature: string; signedBytes: string; blockhash?: string; blockhashContextSlot?: string; lastValidBlockHeight?: string}

/** The wallet may only add the owner signature to the checked message. The signature is verified here. */
export async function signedSetupProof(prepared: PreparedSetup, checked: CheckedSetup, policyId: string, owner: string, signed: Uint8Array): Promise<SignedSetup> {
  if (signed.length !== checked.wire.length || signed[0] !== 1 || !equal(signed.subarray(65), checked.message)) throw new Error('The wallet changed the message or returned invalid signatures.');
  const signature = signed.subarray(1, 65);
  let valid = false;
  try {
    const publicKey = await crypto.subtle.importKey('raw', Uint8Array.from(key(owner).toBytes()), {name: 'Ed25519'}, false, ['verify']);
    valid = await crypto.subtle.verify({name: 'Ed25519'}, publicKey, Uint8Array.from(signature), Uint8Array.from(checked.message));
  } catch {
    throw new Error('This browser cannot verify the wallet signature. Use a current browser.');
  }
  if (!valid) throw new Error('The wallet changed the message or returned invalid signatures.');
  return {requestId: prepared.requestId, policyId, owner, signature: base58(signature), signedBytes: Buffer.from(signed).toString('base64'), blockhash: checked.blockhash, ...(prepared.blockhashContextSlot === undefined ? {} : {blockhashContextSlot: prepared.blockhashContextSlot}), ...(prepared.lastValidBlockHeight === undefined ? {} : {lastValidBlockHeight: prepared.lastValidBlockHeight})};
}
