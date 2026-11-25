/**
 * What the SDK's owner workflows read from Solana and check with its keys: Core's `OwnerChain` contract. The SDK holds
 * the workflows, their journal and their recovery rules; these hooks build, send and read Solana transactions and
 * check Solana signatures.
 *
 * A step is named by the SHA-256 of its message. The network names a transaction by its signature, which the rail
 * remembers from the signed bytes that it reads (`signatures.ts`).
 */
import type { OwnerChain } from '@allowit/core';
import { type Send } from './rpc.js';
/**
 * The record of the step with `hash`: its slot and whether it succeeded once the finalized bank holds it, `'missing'`
 * when the node holds no transaction of its signature, and null without a clear answer: a transaction that is not
 * finalized yet, a node that cannot be read, or a hash whose signed bytes this browser never saw.
 */
export declare function transaction(network: string, hash: string, send?: Send): ReturnType<OwnerChain['transaction']>;
/**
 * For signed bytes past their time bound: the slot when they ran successfully, or null when they can never take
 * effect. They can never take effect when the finalized bank holds them as failed, or when their blockhash is no
 * longer valid at the finalized bank and a node at that bank or past it holds no transaction of their signature.
 * Anything else throws, and the SDK keeps the step: a transaction that is not finalized, a blockhash that is still
 * valid, or a node that is behind.
 */
export declare function expiredRecord(network: string, hash: string, signedPayload: string, send?: Send): Promise<{
    ledger: number;
} | null>;
/** The hooks of the SDK's owner workflows. */
export declare const ownerChain: OwnerChain;
