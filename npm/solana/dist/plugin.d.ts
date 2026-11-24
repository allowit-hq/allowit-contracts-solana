/**
 * The Solana rail plugin for the AllowIt SDK registry. Hosts never import this module directly: the SDK
 * registration imports it, and hosts render its elements through `<allowit-rail kind network>`.
 * Importing it touches no DOM; `define()` registers the elements on first use.
 */
import type { AssetDisplay, WalletKindId } from '@allowit/core';
import { defineElements } from './elements/index.js';
import { type ExplorerKind } from './elements/display.js';
import { NETWORKS, assets, canonicalNetwork, type AssetInfo, type RailNetwork } from './networks.js';
import { parseReviewLink, reviewAgentPrompt, type AdkProposal } from './review.js';
export type ElementKind = 'address' | 'explorer-link' | 'amount' | 'wallet-sign-in' | 'owner-sign' | 'owner-answer' | 'receipt' | 'binding-review';
export type Feature = 'transfer' | 'swap' | 'deposit' | 'redeem' | 'owner-setup' | 'deploy' | 'fund' | 'activate' | 'binding-review' | 'explorer-links';
export type { AssetInfo, RailNetwork };
export { NETWORKS, assets, canonicalNetwork };
/** A Solana network offers the Native wallet: the owner's token account with the agent and the server as its delegate. */
export declare function walletKinds(network: string): readonly WalletKindId[];
/**
 * The wallet kind that a policy, draft, wallet profile or installation binds, or null when it binds none yet.
 * It reads the route of `runtime.instanceBinding`, of `config` or of the document itself. A Native wallet has no tier.
 */
export declare function walletKind(document: unknown): WalletKindId | null;
/** SOL: the native asset and the fee asset of every Solana network. */
export declare function nativeAsset(network: string): AssetDisplay | null;
/**
 * Display metadata of an asset reference: `native`, a listed code, or the mint of a listed token. A mint that the rail
 * does not list has no known unit, so the result is null and never a placeholder.
 */
export declare function assetDisplay(network: string, asset: string): AssetDisplay | null;
/** True for a 32-byte base58 address on a network of the rail. */
export declare function validateAddress(network: string, text: string): boolean;
export declare function explorerUrl(network: string, kind: ExplorerKind, id: string): string | null;
declare const plugin: Readonly<{
    id: "solana";
    networks: readonly RailNetwork[];
    elements: Readonly<{
        readonly address: "allowit-solana-address";
        readonly 'explorer-link': "allowit-solana-explorer-link";
        readonly amount: "allowit-solana-amount";
        readonly 'wallet-sign-in': "allowit-solana-wallet-sign-in";
        readonly 'owner-sign': "allowit-solana-owner-sign";
        readonly 'owner-answer': "allowit-solana-owner-answer";
        readonly receipt: "allowit-solana-receipt";
        readonly 'binding-review': "allowit-solana-binding-review";
    }>;
    define: typeof defineElements;
    validateAddress: typeof validateAddress;
    explorerUrl: typeof explorerUrl;
    assets: (network: string) => readonly AssetInfo[];
    walletKinds: typeof walletKinds;
    walletKind: typeof walletKind;
    nativeAsset: typeof nativeAsset;
    assetDisplay: typeof assetDisplay;
    /** Review and sign links: the fragment, its parser, the agent prompt and the owner-readable params. */
    review: Readonly<{
        fragment: "#adk-proposal-v1=";
        parseLink: typeof parseReviewLink;
        agentPrompt: typeof reviewAgentPrompt;
        paramLines: (params: AdkProposal["params"], network: string) => import("./review.js").AdkParamLine[];
    }>;
    /**
     * What the SDK's owner workflows read from Solana and check with its keys: transaction records, the record of an
     * expired step, the Native wallet's setup and the owner's approval. The SDK holds the workflows and their journal.
     */
    ownerChain: import("@allowit/core").OwnerChain;
    test: Readonly<{
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
        skips: Readonly<Partial<Record<Feature, string>>>;
        fixtures: Readonly<{
            address: "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9";
            /** Two more keys, each distinct from `address`, for a test that needs several roles, such as a wallet setup. */
            accounts: readonly string[];
            invalidAddress: "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ0";
            txHash: "KW8ZFo7QWDums1FiKwn3YvBTTRxGyF1KGJEUAPZSb4jTS9ZGVW7Wb2GxnNBrNYroDE2VWmrAR3s5zWPpdzdTsMA";
            asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
        }>;
    }>;
}>;
export default plugin;
