export declare const sha256: (bytes: Uint8Array) => Uint8Array;
export declare const utf8: (text: string) => Uint8Array;
export declare const hex: (bytes: Uint8Array) => string;
export declare const equal: (a: Uint8Array, b: Uint8Array) => boolean;
export declare function concat(...parts: (Uint8Array | number[])[]): Uint8Array;
/** Standard base64 with padding. */
export declare function base64(bytes: Uint8Array): string;
/** The bytes of standard base64 text with padding, or null. Text that is not the encoding of its own bytes is refused. */
export declare function unbase64(text: unknown, max?: number): Uint8Array | null;
export declare function base58(bytes: Uint8Array): string;
/** The bytes of base58 text of exactly `length` bytes, or null. Only the one encoding of those bytes is read. */
export declare function unbase58(text: unknown, length: number): Uint8Array | null;
export declare function u32(value: number): Uint8Array;
export declare function u64(value: bigint): Uint8Array;
export declare const readU64: (bytes: Uint8Array, at: number) => bigint;
export declare const readU32: (bytes: Uint8Array, at: number) => number;
/** The compact length of a transaction's lists: seven bits a byte, low bits first. */
export declare function compact(length: number): number[];
/** A cursor over bytes. Every read past the end throws, so a short input is never a value. */
export declare class Reader {
    #private;
    readonly bytes: Uint8Array;
    constructor(bytes: Uint8Array);
    get done(): boolean;
    take(length: number): Uint8Array;
    byte(): number;
    /** Every byte that is left. */
    rest(): Uint8Array;
    /** A compact length in its shortest form, at most 16 bits as a transaction allows. */
    compact(): number;
}
