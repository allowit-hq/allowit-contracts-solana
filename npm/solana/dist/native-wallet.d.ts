/**
 * The Native wallet of an agent on Solana: the owner's token account of one mint for one agent, with an SPL Token
 * multisig of the agent and the server, two of two, as its delegate. The owner opens both accounts from its own key
 * and approves the delegate for an allowance with one signed transaction. No Allowit program runs.
 *
 * The setup approves and moves no tokens. The wallet pays from what its token account holds, up to the allowance; the
 * owner sends tokens to the wallet address. Only the owner stops, refills, recovers and closes it.
 *
 * This module builds the setup exactly as the rail crate does (`crates/allowit-solana/src/native.rs`), reads signed
 * setup bytes back, and returns the installation document that the server registers. `tests/vectors.json` holds what
 * the crate makes, and the tests compare every byte. The SDK's owner workflow keeps the signed setup and decides when
 * to send it again or replace it.
 */
import type { ReviewedPolicy, WalletAsset } from '@allowit/core';
import { type Message } from './message.js';
import { type Send } from './rpc.js';
/** The action of the owner step that sets up the agent's wallet. */
export declare const SET_UP_WALLET = "set_up_wallet";
/**
 * The action of the owner step that approves the policy of a wallet. It signs a message and moves nothing. Its
 * payload is the base64 text of the message, as UTF-8, and its hash is the SHA-256 of those bytes.
 */
export declare const APPROVE_POLICY = "approve_policy";
export declare const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export declare const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** SPL Memo, the version that x402 facilitators accept. */
export declare const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
/** The size of an SPL Token account and of an SPL Token multisig. */
export declare const TOKEN_ACCOUNT_LEN = 165;
export declare const MULTISIG_LEN = 355;
/** The most that the network takes for a payment of the wallet, in lamports: the ceiling that an approval may state. */
export declare const MAX_FEE_LAMPORTS = 20000;
/** The roles of one wallet: the owner's account of `mint` for `agent`, with the delegate of `agent` and `server`. */
export interface Roles {
    owner: string;
    mint: string;
    agent: string;
    server: string;
}
/** The addresses that the roles give: the wallet's token account and its delegate, each with its seed. */
export interface WalletAddresses {
    tokenSeed: string;
    delegateSeed: string;
    tokenAccount: string;
    delegate: string;
}
/**
 * Checks the roles and derives the wallet's addresses. The owner, the agent and the server are three keys that can
 * sign: with one key as both agent and server, one signature would meet the two-of-two delegate.
 */
export declare function walletOf({ owner, mint, agent, server }: Roles): WalletAddresses;
/** What a setup finds at one of the wallet's two addresses. */
export type Found = 
/** No account: create it with its deposit, in lamports. */
{
    nothing: bigint;
}
/** A System account with lamports and no data, such as one that someone funded: add the missing deposit and allocate it. */
 | {
    funded: bigint;
}
/** The account is already the one that the wallet needs: reuse it. */
 | 'ready';
/** The terms of one setup: the roles, the allowance in base units, what the ledger holds, the memo and the blockhash. */
export interface SetupTerms extends Roles {
    allowance: bigint;
    decimals: number;
    token: Found;
    delegate: Found;
    tag: string;
    blockhash: string;
}
/**
 * The setup message: each account that is not ready, with its deposit, then the approval of the allowance to the
 * delegate, then the memo. Only the owner signs, and the owner pays the fee and the deposits.
 */
export declare function setupMessage(terms: SetupTerms): Message;
/** What a setup message does, read from its bytes. */
export interface SetupFacts extends Roles {
    /** The wallet address: the owner's token account. */
    wallet: string;
    delegate: string;
    /** What the delegate may spend, in base units of the token. */
    allowance: bigint;
    decimals: number;
    /** The deposits that the owner pays for accounts that the setup opens, in lamports. */
    deposits: bigint;
    /** Until when, as a Unix time, the same signed bytes are sent again. The blockhash decides whether they can still run. */
    validUntil: number;
    blockhash: string;
}
/**
 * Reads a setup message. The memo names the agent, the server and the time bound; the approval names the owner, the
 * token, the wallet and the delegate. The bytes are a setup only when the setup builder makes exactly them from what
 * was read: the wallet and the delegate are then the addresses of those roles, and the message holds nothing else.
 */
export declare function setupOf(messageBytesIn: Uint8Array, parsed: Message): SetupFacts | null;
/** Decimal text of base units as a person writes it: no trailing zeros. */
export declare function plainDecimal(value: bigint, decimals: number): string;
/** Whether `data` is the wallet's token account: the mint, the owner, initialized, not frozen, closable by the owner. */
export declare function isTokenAccount(data: Uint8Array, mint: string, owner: string): boolean;
/** The roles and allowance of a wallet's setup. */
export interface SetupInput {
    network: string;
    /** The owner's key. It pays for the setup and signs it. */
    owner: string;
    agent: string;
    /** The server's key on this network. */
    server: string;
    /** What the agent and the server may spend together, as decimal text in the wallet's token. */
    amount: string;
    /** The token that the wallet holds, from the policy that the owner reviewed: its code and, as its issuer, its mint. */
    asset?: WalletAsset | null | undefined;
    fetch?: Send;
    now?: () => number;
}
/** A setup prepared for the owner's signature. */
export interface PreparedSetup {
    /** The wallet address: the owner's token account. */
    wallet: string;
    /** The step that the owner's wallet signs: its payload is the base64 text of the exact setup message. */
    step: {
        action: string;
        payload: string;
        hash: string;
        expiresAt: number;
    };
    /** Checks that `ownerSigned` is this transaction with the owner's one signature, and returns the bytes to send. */
    complete(ownerSigned: string): string;
}
/** The hash of a step: the SHA-256 of the message that the owner signs, as lowercase hexadecimal. */
export declare const messageHash: (message: Uint8Array) => string;
/**
 * Prepares the setup of the wallet of an agent: one transaction on a finalized blockhash, built from what the
 * finalized bank holds at the wallet's two addresses. Only the owner signs it.
 */
export declare function prepareSetup({ network, owner, agent, server, amount, asset, fetch: send, now }: SetupInput): Promise<PreparedSetup>;
/**
 * What signed setup bytes are: their hash, their roles, the token of their wallet, the allowance that they approve,
 * as decimal text, and the time until which they are sent again. Null for bytes that are no setup of this network
 * with its owner's signature. The signed bytes decide; saved metadata is unsigned.
 */
export declare function signedSetupOf(signedPayload: string, network: string): {
    hash: string;
    owner: string;
    wallet: string;
    agent: string;
    server: string;
    validUntil: number;
    asset: WalletAsset;
    amount: string;
    signature: Uint8Array;
    blockhash: string;
} | null;
/**
 * Checks the token of a wallet's bytes against `asset`, the token of the reviewed policy: Core's
 * `keypairSetup.checkAsset`. `payload` is signed setup bytes, which must set up a wallet of that token, or the refill
 * step that the server prepared, which must approve it. Throws an error whose `code` is `asset_mismatch` otherwise,
 * for a payload that is neither, and when `asset` is no token that the network lists. The check is of the token only.
 */
export declare function checkAsset(payload: string, network: string, asset?: WalletAsset | null): void;
/**
 * Sends signed setup bytes and waits until the finalized bank holds them. The slot of the successful transaction, or
 * null without a certain answer: a refused send, a failed transaction and a wait that ends early are all null, and the
 * workflow settles them from the saved bytes.
 */
export declare function sendSetup(network: string, signedPayload: string, hash: string, send?: Send, wait?: (ms: number) => Promise<void>): Promise<number | null>;
/**
 * The installation document of a wallet, as the server registers it: the document of the rail crate's own setup
 * (`owner_client::installation`). It names the roles and the token and holds no policy yet; the server binds the
 * owner's approved policy to it. The server reads the wallet from the ledger and refuses a document that it does not
 * match.
 */
export declare function walletConfiguration(network: string, wallet: string, owner: string, agent: string, server: string, asset?: WalletAsset | null): Record<string, unknown>;
/** Canonical text of a JSON value: object keys in code-unit order at every level. */
export declare function canonical(value: unknown): string;
/** What a policy approval message approves: the policy and its revision, the wallet, the source and the values. */
export interface PolicyApproval {
    policyId: string;
    revision: number;
    network: string;
    wallet: string;
    source: string;
    sourceHash: string;
    paramsHash: string;
    params: Record<string, unknown>;
    /** Every field of the message, as the owner's wallet signs it. */
    fields: Record<string, unknown>;
}
/**
 * Reads the exact text of a policy approval of `network`: its title line, then the JSON of the approval, with no
 * space and no key twice. Any other text is null: another title, a text that is not the plain form of its own
 * content, another network or route, or a source or values whose hash differs from the hash that the message states.
 */
export declare function policyApproval(message: unknown, network: string): PolicyApproval | null;
/**
 * Whether a policy approval of `wallet` is exactly what the owner reviewed. Every field that the wallet signs is
 * checked. The policy and its revision come from the service. The source, rules, values and tier must be the reviewed
 * ones, and a Native wallet has no tier. The network, wallet and route must be the wallet's own, the token must be the
 * token of the reviewed policy, and the fee ceiling is at most the rail's. The agent and the server must be two keys:
 * which keys they are is decided by the wallet address, which binds the agent, and by the delegate that the ledger
 * holds, which binds both. Any other field, or any other value, is refused.
 */
export declare function approvalHolds(approval: PolicyApproval, wallet: string, reviewed: ReviewedPolicy): boolean;
/** The step that asks the owner's wallet to approve a policy. It signs the message and moves nothing. */
export declare function approvalStep(message: string, now?: number): {
    action: string;
    payload: string;
    hash: string;
    expiresAt: number;
};
/** The message of an approval step, or null when the payload is no UTF-8 text or differs from the step's hash. */
export declare function approvalMessage(step: {
    payload: string;
    hash: string;
}): string | null;
/**
 * Whether `signature` is the signature of `signer` over the message of the approval step with `hash`. A Solana wallet
 * signs the message itself, so the step must be one that `approvalStep` made in this page.
 */
export declare function approvalSignedBy(signer: string, hash: string, signature: readonly number[]): boolean;
/** The owner of a wallet: the owner of its token account in the finalized bank, or null. */
export declare function walletOwner(network: string, wallet: string, send?: Send): Promise<string | null>;
