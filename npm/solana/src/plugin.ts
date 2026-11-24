/**
 * The Solana rail plugin for the AllowIt SDK registry. Hosts never import this module directly: the SDK
 * registration imports it, and hosts render its elements through `<allowit-rail kind network>`.
 * Importing it touches no DOM; `define()` registers the elements on first use.
 */
import type {AssetDisplay, WalletKindId} from '@allowit/core';
import {defineElements, ELEMENTS} from './elements/index.js';
import {explorerUrl as explorerLink, type ExplorerKind} from './elements/display.js';
import {address} from './message.js';
import {DEVNET, NETWORKS, USDC_DEVNET, assets, canonicalNetwork, type AssetInfo, type RailNetwork} from './networks.js';
import {ownerChain} from './owner-chain.js';
import {ADK_OWNER_FRAGMENT, adkParamLines, parseReviewLink, reviewAgentPrompt, type AdkProposal} from './review.js';

export type ElementKind = 'address'|'explorer-link'|'amount'|'wallet-sign-in'|'owner-sign'|'owner-answer'|'receipt'|'binding-review';
export type Feature = 'transfer'|'swap'|'deposit'|'redeem'|'owner-setup'|'deploy'|'fund'|'activate'|'binding-review'|'explorer-links';
export type {AssetInfo, RailNetwork};
export {NETWORKS, assets, canonicalNetwork};

const KINDS: readonly WalletKindId[] = Object.freeze(['native']);
const NO_KINDS: readonly WalletKindId[] = Object.freeze([]);
/** A Solana network offers the Native wallet: the owner's token account with the agent and the server as its delegate. */
export function walletKinds(network: string): readonly WalletKindId[] {
  return canonicalNetwork(network) ? KINDS : NO_KINDS;
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
/**
 * The wallet kind that a policy, draft, wallet profile or installation binds, or null when it binds none yet.
 * It reads the route of `runtime.instanceBinding`, of `config` or of the document itself. A Native wallet has no tier.
 */
export function walletKind(document: unknown): WalletKindId | null {
  const top = record(document);
  const binding = record(record(top?.runtime)?.instanceBinding) ?? record(top?.config) ?? top;
  const route = binding?.route ?? top?.route, tier = binding?.tier;
  return route === 'native' && (tier === undefined || tier === null) ? 'native' : null;
}

const display = (asset: AssetInfo): AssetDisplay => ({symbol: asset.symbol, decimals: asset.decimals, name: asset.label, native: asset.symbol === 'SOL'});
/** SOL: the native asset and the fee asset of every Solana network. */
export function nativeAsset(network: string): AssetDisplay | null {
  const native = assets(network)[0];
  return native ? display(native) : null;
}
/**
 * Display metadata of an asset reference: `native`, a listed code, or the mint of a listed token. A mint that the rail
 * does not list has no known unit, so the result is null and never a placeholder.
 */
export function assetDisplay(network: string, asset: string): AssetDisplay | null {
  const list = assets(network);
  if (!list.length || typeof asset !== 'string') return null;
  const listed = asset === 'native' ? list[0] : list.find(item => item.symbol === asset || item.id === asset);
  return listed ? display(listed) : null;
}

/** True for a 32-byte base58 address on a network of the rail. */
export function validateAddress(network: string, text: string): boolean {
  return canonicalNetwork(network) !== null && address(text) !== null;
}
export function explorerUrl(network: string, kind: ExplorerKind, id: string): string | null {
  return explorerLink(network, kind, id);
}

const plugin = Object.freeze({
  id: 'solana',
  networks: NETWORKS,
  elements: ELEMENTS,
  define: defineElements,
  validateAddress,
  explorerUrl,
  assets,
  walletKinds,
  walletKind,
  nativeAsset,
  assetDisplay,
  /** Review and sign links: the fragment, its parser, the agent prompt and the owner-readable params. */
  review: Object.freeze({fragment: ADK_OWNER_FRAGMENT, parseLink: parseReviewLink, agentPrompt: reviewAgentPrompt,
    paramLines: (params: AdkProposal['params'], network: string) => adkParamLines(params, assets(network))}),
  /**
   * What the SDK's owner workflows read from Solana and check with its keys: transaction records, the record of an
   * expired step, the Native wallet's setup and the owner's approval. The SDK holds the workflows and their journal.
   */
  ownerChain,
  test: Object.freeze({
    network: DEVNET,
    skips: Object.freeze({
      swap: 'a Native wallet makes transfers only',
      deposit: 'a Native wallet makes transfers only',
      redeem: 'a Native wallet makes transfers only',
      deploy: 'a Native wallet has no code to deploy',
    } as Partial<Record<Feature, string>>),
    fixtures: Object.freeze({
      address: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9',
      /** Two more keys, each distinct from `address`, for a test that needs several roles, such as a wallet setup. */
      accounts: Object.freeze(['9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu', 'GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse']),
      invalidAddress: 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ0',
      txHash: 'KW8ZFo7QWDums1FiKwn3YvBTTRxGyF1KGJEUAPZSb4jTS9ZGVW7Wb2GxnNBrNYroDE2VWmrAR3s5zWPpdzdTsMA',
      asset: USDC_DEVNET,
    }),
  }),
});
export default plugin;
