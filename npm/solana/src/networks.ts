/**
 * The Solana networks of the rail and the tokens that it lists. It imports nothing of the package, so every module
 * reads the networks without an import cycle through the plugin.
 */
export interface RailNetwork {id: string; label: string; testnet: boolean; aliases: readonly string[]}
export interface AssetInfo {network: string; id: string; symbol: string; decimals: number; stablecoin: boolean; label: string}

/** Solana Devnet by its CAIP-2 id: the first 32 characters of its genesis hash. The rail accepts no other spelling. */
export const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
/** Circle's USDC mint on Solana Devnet. */
export const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
/** The mint of wrapped SOL: the id of SOL as an asset. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** The networks that the rail serves. Mainnet joins after the Devnet acceptance. */
export const NETWORKS: readonly RailNetwork[] = Object.freeze([
  {id: DEVNET, label: 'Solana Devnet', testnet: true, aliases: Object.freeze([])},
]);
/** The canonical network id for an id, or null. */
export function canonicalNetwork(network: unknown): string | null {
  return typeof network === 'string' ? NETWORKS.find(n => n.id === network || n.aliases.includes(network))?.id ?? null : null;
}

const RPC: Readonly<Record<string, string>> = {[DEVNET]: 'https://api.devnet.solana.com'};
const CLUSTER: Readonly<Record<string, string>> = {[DEVNET]: 'devnet'};
/** The public RPC endpoint of a network, or null. */
export const rpcUrl = (network: string): string | null => RPC[canonicalNetwork(network) ?? ''] ?? null;
/** The cluster name of a network, as the Solana Explorer and the Wallet Standard chain id spell it, or null. */
export const cluster = (network: string): string | null => CLUSTER[canonicalNetwork(network) ?? ''] ?? null;

const ASSETS: Readonly<Record<string, readonly AssetInfo[]>> = {
  // SOL is first: the native asset and the fee asset of the network.
  [DEVNET]: Object.freeze([
    {network: DEVNET, id: SOL_MINT, symbol: 'SOL', decimals: 9, stablecoin: false, label: 'Solana'},
    {network: DEVNET, id: USDC_DEVNET, symbol: 'USDC', decimals: 6, stablecoin: true, label: 'USD Coin'},
  ]),
};
const NONE: readonly AssetInfo[] = Object.freeze([]);
/** The assets that the rail lists on a network, SOL first; none on an unknown network. */
export const assets = (network: string): readonly AssetInfo[] => ASSETS[canonicalNetwork(network) ?? ''] ?? NONE;
