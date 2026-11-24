/**
 * Legacy Solana transaction messages: addresses, the compilation of instructions into a message, and the bytes of a
 * message and of a transaction. The rail builds a few fixed transactions and reads back only those, so this module has
 * no versioned messages and no address tables: bytes of either are refused.
 */
import {ed25519} from '@noble/curves/ed25519';
import {Reader, base58, compact, concat, equal, sha256, unbase58, utf8} from './bytes.js';

/** The 32 bytes of an address, or null. */
export const address = (text: unknown): Uint8Array | null => unbase58(text, 32);
/** The 64 bytes of a transaction signature, or null. */
export const signature = (text: unknown): Uint8Array | null => unbase58(text, 64);

/**
 * True for the address of a key that a signer can hold: the canonical encoding of a point of the prime-order subgroup.
 * A derived address, such as a token account, is no such key.
 */
export function canSign(text: unknown): boolean {
  const key = address(text);
  if (!key) return false;
  try {
    const point = ed25519.ExtendedPoint.fromHex(key);
    return point.isTorsionFree() && !point.isSmallOrder() && equal(point.toRawBytes(), key);
  } catch {
    return false;
  }
}

/** True when `sig` is the Ed25519 signature of `signer` over `message`. */
export function verify(signer: string, message: Uint8Array, sig: Uint8Array): boolean {
  const key = address(signer);
  if (!key || sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, message, key);
  } catch {
    return false;
  }
}

/** The address that `createAccountWithSeed` gives `base`, `seed` and the owning `program`. */
export function withSeed(base: string, seed: string, program: string): string {
  const [from, owner] = [address(base), address(program)];
  if (!from || !owner || seed.length > 32) throw new Error('The seeded address is invalid.');
  return base58(sha256(concat(from, utf8(seed), owner)));
}

export interface AccountMeta {address: string; signer: boolean; writable: boolean}
export interface Instruction {program: string; accounts: AccountMeta[]; data: Uint8Array}
/** A compiled message: its header counts, its account keys in order, its blockhash and its instructions. */
export interface Message {
  signers: number;
  readonlySigners: number;
  readonlyOthers: number;
  keys: string[];
  blockhash: string;
  instructions: {program: number; accounts: number[]; data: Uint8Array}[];
}

const compare = (a: Uint8Array, b: Uint8Array): number => {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/**
 * Compile `instructions` for `payer` and `blockhash`. The payer is first. The other keys follow in four groups,
 * writable signers, read-only signers, writable others and read-only others, each in the order of its key bytes.
 */
export function compile(instructions: readonly Instruction[], payer: string, blockhash: string): Message {
  const metas = new Map<string, {signer: boolean; writable: boolean}>();
  const note = (key: string, signer: boolean, writable: boolean) => {
    if (!address(key)) throw new Error('The transaction names an invalid address.');
    const seen = metas.get(key) ?? {signer: false, writable: false};
    metas.set(key, {signer: seen.signer || signer, writable: seen.writable || writable});
  };
  for (const ix of instructions) {
    note(ix.program, false, false);
    for (const account of ix.accounts) note(account.address, account.signer, account.writable);
  }
  note(payer, true, true);
  if (!address(blockhash)) throw new Error('The blockhash is invalid.');
  const group = (signer: boolean, writable: boolean) => [...metas]
    .filter(([key, meta]) => key !== payer && meta.signer === signer && meta.writable === writable)
    .map(([key]) => key)
    .sort((a, b) => compare(address(a)!, address(b)!));
  const [writableSigners, readonlySigners, writableOthers, readonlyOthers] = [group(true, true), group(true, false), group(false, true), group(false, false)];
  const keys = [payer, ...writableSigners, ...readonlySigners, ...writableOthers, ...readonlyOthers];
  if (keys.length > 255) throw new Error('The transaction names too many accounts.');
  return {
    signers: 1 + writableSigners.length + readonlySigners.length,
    readonlySigners: readonlySigners.length,
    readonlyOthers: readonlyOthers.length,
    keys,
    blockhash,
    instructions: instructions.map(ix => ({program: keys.indexOf(ix.program), accounts: ix.accounts.map(a => keys.indexOf(a.address)), data: ix.data})),
  };
}

/** The bytes of a message: what every signer signs. */
export function messageBytes(message: Message): Uint8Array {
  return concat(
    [message.signers, message.readonlySigners, message.readonlyOthers],
    compact(message.keys.length), ...message.keys.map(key => address(key)!),
    address(message.blockhash)!,
    compact(message.instructions.length),
    ...message.instructions.flatMap(ix => [[ix.program], compact(ix.accounts.length), ix.accounts, compact(ix.data.length), ix.data]),
  );
}

/** Read the bytes of a legacy message. Null for a versioned message, bytes that end early, or bytes left over. */
export function readMessage(bytes: Uint8Array): Message | null {
  try {
    const r = new Reader(bytes);
    const [signers, readonlySigners, readonlyOthers] = [r.byte(), r.byte(), r.byte()];
    // The high bit of the first byte marks a versioned message.
    if (signers & 0x80) return null;
    const keys = Array.from({length: r.compact()}, () => base58(r.take(32)));
    const blockhash = base58(r.take(32));
    const instructions = Array.from({length: r.compact()}, () => {
      const program = r.byte();
      const accounts = Array.from(r.take(r.compact()));
      const data = r.take(r.compact()).slice();
      return {program, accounts, data};
    });
    if (!r.done || signers === 0 || signers > keys.length || readonlySigners >= signers || readonlyOthers > keys.length - signers
      || new Set(keys).size !== keys.length || instructions.some(ix => ix.program >= keys.length || ix.accounts.some(a => a >= keys.length))) return null;
    return {signers, readonlySigners, readonlyOthers, keys, blockhash, instructions};
  } catch {
    return null;
  }
}

/** The instructions of a message with their addresses and the role of each account. */
export function instructionsOf(message: Message): Instruction[] {
  const meta = (index: number): AccountMeta => ({
    address: message.keys[index],
    signer: index < message.signers,
    writable: index < message.signers ? index < message.signers - message.readonlySigners : index < message.keys.length - message.readonlyOthers,
  });
  return message.instructions.map(ix => ({program: message.keys[ix.program], accounts: ix.accounts.map(meta), data: ix.data}));
}

/** The bytes of a transaction: its signatures in the order of its signers, then its message. */
export function wire(signatures: readonly Uint8Array[], message: Uint8Array): Uint8Array {
  if (signatures.some(sig => sig.length !== 64)) throw new Error('A signature has 64 bytes.');
  return concat(compact(signatures.length), ...signatures, message);
}

/** Read the bytes of a transaction: its signatures and its message. Null for anything else. */
export function readWire(bytes: Uint8Array): {signatures: Uint8Array[]; message: Uint8Array; parsed: Message} | null {
  try {
    const r = new Reader(bytes);
    const signatures = Array.from({length: r.compact()}, () => r.take(64).slice());
    const message = r.rest().slice();
    const parsed = readMessage(message);
    return parsed && r.done && parsed.signers === signatures.length ? {signatures, message, parsed} : null;
  } catch {
    return null;
  }
}
