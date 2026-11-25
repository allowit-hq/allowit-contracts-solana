/** Byte helpers of the Solana rail: hashes, hexadecimal, base64, base58 and the compact length of a transaction. */
import { sha256 as hash } from '@noble/hashes/sha256';
export const sha256 = (bytes) => hash(bytes);
export const utf8 = (text) => new TextEncoder().encode(text);
export const hex = (bytes) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
export const equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
export function concat(...parts) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
/** Standard base64 with padding. */
export function base64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}
/** The bytes of standard base64 text with padding, or null. Text that is not the encoding of its own bytes is refused. */
export function unbase64(text, max = 4_096) {
    if (typeof text !== 'string' || text.length > max || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0)
        return null;
    try {
        const bytes = Uint8Array.from(atob(text), c => c.charCodeAt(0));
        return base64(bytes) === text ? bytes : null;
    }
    catch {
        return null;
    }
}
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes) {
    let value = 0n;
    for (const byte of bytes)
        value = value * 256n + BigInt(byte);
    let text = '';
    for (; value > 0n; value /= 58n)
        text = ALPHABET[Number(value % 58n)] + text;
    for (const byte of bytes) {
        if (byte !== 0)
            break;
        text = '1' + text;
    }
    return text;
}
/** The bytes of base58 text of exactly `length` bytes, or null. Only the one encoding of those bytes is read. */
export function unbase58(text, length) {
    // 32 bytes take at most 44 characters and 64 bytes at most 88: longer text is refused before it is decoded.
    if (typeof text !== 'string' || text.length === 0 || text.length > Math.ceil(length * 1.38) || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(text))
        return null;
    let value = 0n;
    for (const char of text)
        value = value * 58n + BigInt(ALPHABET.indexOf(char));
    const out = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i--, value /= 256n)
        out[i] = Number(value % 256n);
    return value === 0n && base58(out) === text ? out : null;
}
export function u32(value) {
    const out = new Uint8Array(4);
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
}
export function u64(value) {
    if (value < 0n || value > 0xffffffffffffffffn)
        throw new Error('The amount is out of range.');
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, value, true);
    return out;
}
export const readU64 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(at, true);
export const readU32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(at, true);
/** The compact length of a transaction's lists: seven bits a byte, low bits first. */
export function compact(length) {
    const out = [];
    for (let rest = length;;) {
        const byte = rest & 0x7f;
        rest >>= 7;
        if (rest === 0) {
            out.push(byte);
            return out;
        }
        out.push(byte | 0x80);
    }
}
/** A cursor over bytes. Every read past the end throws, so a short input is never a value. */
export class Reader {
    bytes;
    #at = 0;
    constructor(bytes) {
        this.bytes = bytes;
    }
    get done() {
        return this.#at === this.bytes.length;
    }
    take(length) {
        if (length < 0 || this.#at + length > this.bytes.length)
            throw new Error('The bytes end early.');
        this.#at += length;
        return this.bytes.subarray(this.#at - length, this.#at);
    }
    byte() {
        return this.take(1)[0];
    }
    /** Every byte that is left. */
    rest() {
        return this.take(this.bytes.length - this.#at);
    }
    /** A compact length in its shortest form, at most 16 bits as a transaction allows. */
    compact() {
        let value = 0;
        for (let shift = 0; shift <= 14; shift += 7) {
            const byte = this.byte();
            value |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                if (shift > 0 && byte === 0)
                    throw new Error('The length is not in its shortest form.');
                return value;
            }
        }
        throw new Error('The length is too long.');
    }
}
