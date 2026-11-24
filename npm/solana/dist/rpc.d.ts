/**
 * The reads and the one send that the rail asks a Solana RPC node. Every read is of the finalized bank: an owner
 * workflow settles a step only from what can no longer change. A reply of another shape is an error, never a value.
 */
import { base58 } from './bytes.js';
export type Send = typeof fetch;
/** One JSON-RPC call. Throws on a transport failure, an error reply or a reply without a result. */
export declare function call(network: string, method: string, params: unknown[], send?: Send, timeoutMs?: number): Promise<unknown>;
export interface Account {
    lamports: bigint;
    owner: string;
    data: Uint8Array;
}
/** The account at `at` in the finalized bank, or null when there is none. */
export declare function account(network: string, at: string, send?: Send): Promise<Account | null>;
/** The deposit that keeps an account of `length` bytes, in lamports. */
export declare function deposit(network: string, length: number, send?: Send): Promise<bigint>;
/** A blockhash of the finalized bank. */
export declare function recentBlockhash(network: string, send?: Send): Promise<string>;
/** What the node holds for a signature: nothing, or its slot, whether it is finalized and whether it failed. */
export interface Status {
    slot: number;
    finalized: boolean;
    failed: boolean;
}
/** The status of `signature` with the node's whole history, and the slot of the bank that answered. */
export declare function status(network: string, signature: string, send?: Send): Promise<{
    at: number;
    status: Status | null;
}>;
/** Whether `blockhash` can still carry a transaction into a block after the finalized bank, and that bank's slot. */
export declare function blockhashValid(network: string, blockhash: string, send?: Send): Promise<{
    at: number;
    valid: boolean;
}>;
/** Sends signed transaction bytes as base64 text. The node simulates them on the finalized bank first. */
export declare function sendRaw(network: string, wireBase64: string, send?: Send): Promise<string>;
export { base58 };
