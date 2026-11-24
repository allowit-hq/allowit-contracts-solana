/** The 32 bytes of an address, or null. */
export declare const address: (text: unknown) => Uint8Array | null;
/** The 64 bytes of a transaction signature, or null. */
export declare const signature: (text: unknown) => Uint8Array | null;
/**
 * True for the address of a key that a signer can hold: the canonical encoding of a point of the prime-order subgroup.
 * A derived address, such as a token account, is no such key.
 */
export declare function canSign(text: unknown): boolean;
/** True when `sig` is the Ed25519 signature of `signer` over `message`. */
export declare function verify(signer: string, message: Uint8Array, sig: Uint8Array): boolean;
/** The address that `createAccountWithSeed` gives `base`, `seed` and the owning `program`. */
export declare function withSeed(base: string, seed: string, program: string): string;
export interface AccountMeta {
    address: string;
    signer: boolean;
    writable: boolean;
}
export interface Instruction {
    program: string;
    accounts: AccountMeta[];
    data: Uint8Array;
}
/** A compiled message: its header counts, its account keys in order, its blockhash and its instructions. */
export interface Message {
    signers: number;
    readonlySigners: number;
    readonlyOthers: number;
    keys: string[];
    blockhash: string;
    instructions: {
        program: number;
        accounts: number[];
        data: Uint8Array;
    }[];
}
/**
 * Compile `instructions` for `payer` and `blockhash`. The payer is first. The other keys follow in four groups,
 * writable signers, read-only signers, writable others and read-only others, each in the order of its key bytes.
 */
export declare function compile(instructions: readonly Instruction[], payer: string, blockhash: string): Message;
/** The bytes of a message: what every signer signs. */
export declare function messageBytes(message: Message): Uint8Array;
/** Read the bytes of a legacy message. Null for a versioned message, bytes that end early, or bytes left over. */
export declare function readMessage(bytes: Uint8Array): Message | null;
/** The instructions of a message with their addresses and the role of each account. */
export declare function instructionsOf(message: Message): Instruction[];
/** The bytes of a transaction: its signatures in the order of its signers, then its message. */
export declare function wire(signatures: readonly Uint8Array[], message: Uint8Array): Uint8Array;
/** Read the bytes of a transaction: its signatures and its message. Null for anything else. */
export declare function readWire(bytes: Uint8Array): {
    signatures: Uint8Array[];
    message: Uint8Array;
    parsed: Message;
} | null;
