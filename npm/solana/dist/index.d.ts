/** The Solana browser adapter of AllowIt. Hosts reach it through the SDK registry; see `plugin.ts`. */
export { default as plugin } from './plugin.js';
export { NETWORKS, DEVNET, USDC_DEVNET, assets, canonicalNetwork } from './networks.js';
export { ownerChain } from './owner-chain.js';
export { APPROVE_POLICY, SET_UP_WALLET } from './native-wallet.js';
