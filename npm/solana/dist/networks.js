/** Solana Devnet by its CAIP-2 id: the first 32 characters of its genesis hash. The rail accepts no other spelling. */
export const DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
/** Circle's USDC mint on Solana Devnet. */
export const USDC_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
/** The mint of wrapped SOL: the id of SOL as an asset. */
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** The networks that the rail serves. Mainnet joins after the Devnet acceptance. */
export const NETWORKS = Object.freeze([
    { id: DEVNET, label: 'Solana Devnet', testnet: true, aliases: Object.freeze([]) },
]);
/** The canonical network id for an id, or null. */
export function canonicalNetwork(network) {
    return typeof network === 'string' ? NETWORKS.find(n => n.id === network || n.aliases.includes(network))?.id ?? null : null;
}
const RPC = { [DEVNET]: 'https://api.devnet.solana.com' };
const CLUSTER = { [DEVNET]: 'devnet' };
/** The public RPC endpoint of a network, or null. */
export const rpcUrl = (network) => RPC[canonicalNetwork(network) ?? ''] ?? null;
/** The cluster name of a network, as the Solana Explorer and the Wallet Standard chain id spell it, or null. */
export const cluster = (network) => CLUSTER[canonicalNetwork(network) ?? ''] ?? null;
const ASSETS = {
    // SOL is first: the native asset and the fee asset of the network.
    [DEVNET]: Object.freeze([
        { network: DEVNET, id: SOL_MINT, symbol: 'SOL', decimals: 9, stablecoin: false, label: 'Solana' },
        { network: DEVNET, id: USDC_DEVNET, symbol: 'USDC', decimals: 6, stablecoin: true, label: 'USD Coin' },
    ]),
};
const NONE = Object.freeze([]);
/** The assets that the rail lists on a network, SOL first; none on an unknown network. */
export const assets = (network) => ASSETS[canonicalNetwork(network) ?? ''] ?? NONE;
