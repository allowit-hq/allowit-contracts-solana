/**
 * The Solana networks of the rail and the tokens that it lists. It imports nothing of the package, so every module
 * reads the networks without an import cycle through the plugin.
 */
export interface RailNetwork {
    id: string;
    label: string;
    testnet: boolean;
    aliases: readonly string[];
}
export interface AssetInfo {
    network: string;
    id: string;
    symbol: string;
    decimals: number;
    stablecoin: boolean;
    label: string;
}
/** Solana Devnet by its CAIP-2 id: the first 32 characters of its genesis hash. The rail accepts no other spelling. */
export declare const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
/** Circle's USDC mint on Solana Devnet. */
export declare const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/** The mint of wrapped SOL: the id of SOL as an asset. */
export declare const SOL_MINT = "So11111111111111111111111111111111111111112";
/** The networks that the rail serves. Mainnet joins after the Devnet acceptance. */
export declare const NETWORKS: readonly RailNetwork[];
/** The canonical network id for an id, or null. */
export declare function canonicalNetwork(network: unknown): string | null;
/** The public RPC endpoint of a network, or null. */
export declare const rpcUrl: (network: string) => string | null;
/** The cluster name of a network, as the Solana Explorer and the Wallet Standard chain id spell it, or null. */
export declare const cluster: (network: string) => string | null;
/** The assets that the rail lists on a network, SOL first; none on an unknown network. */
export declare const assets: (network: string) => readonly AssetInfo[];
