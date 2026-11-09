import {useEffect, useState} from 'react';
import {numberToHex} from 'viem';
import type {TempoConfig} from './tempo-contracts';
import type {TempoProvider} from './tempo-wallet';

/** One EVM wallet found in this browser. EIP-6963 wallets announce their own name and icon; an injected
 *  `window.ethereum` without an announcement is listed once as the browser wallet. */
export interface EvmWallet {id: string; name: string; icon?: string; provider: TempoProvider}
interface Announcement {info?: {uuid?: unknown; name?: unknown; icon?: unknown; rdns?: unknown}; provider?: TempoProvider}

const SELECTED = 'allowit.tempo.wallet';
export const BROWSER_WALLET = 'injected';
// Only image data URIs are rendered; a wallet cannot point the page at a remote URL. An unencoded '#' in an
// SVG data URI would end the image at the fragment, so it is escaped.
function safeIcon(icon: unknown) {
  if (typeof icon !== 'string' || !/^data:image\/[\w.+-]+[;,]/i.test(icon.trim())) return undefined;
  const value = icon.trim();
  return /^data:image\/svg\+xml(?:;(?!base64)[^,]*)?,/i.test(value) ? value.replace(/#/g, '%23') : value;
}

/** Popular EVM wallets that can add the Tempo network. Ones not in this browser are offered for install. */
export const SUGGESTED_WALLETS = [
  {id: 'io.metamask', name: 'MetaMask', href: 'https://metamask.io/download/', icon: '/wallets/metamask.svg'},
  {id: 'io.rabby', name: 'Rabby', href: 'https://rabby.io/', icon: '/wallets/rabby.svg'},
  {id: 'com.coinbase.wallet', name: 'Coinbase Wallet', href: 'https://www.coinbase.com/wallet/downloads', icon: '/wallets/coinbase.svg'},
  {id: 'com.okex.wallet', name: 'OKX Wallet', href: 'https://www.okx.com/web3', icon: '/wallets/okx.svg'},
] as const;
/** Wallets that cannot add a custom EVM network, so they cannot hold a Tempo vault. */
const NO_CUSTOM_CHAINS: ReadonlySet<string> = new Set(['app.phantom']);

export function useEvmWallets(): EvmWallet[] {
  const [wallets, setWallets] = useState<EvmWallet[]>([]);
  useEffect(() => {
    const found = new Map<string, EvmWallet>();
    let announcedAny = false;
    const publish = () => {
      const announced = [...found.values()];
      const injected = window.ethereum;
      // Announcing wallets often inject window.ethereum too, behind a different proxy object. The generic entry
      // appears only for an older wallet that announces nothing.
      if (injected && !announcedAny) announced.push({id: BROWSER_WALLET, name: 'Browser wallet', provider: injected});
      setWallets(announced);
    };
    const announce = (event: Event) => {
      const {info, provider} = (event as CustomEvent<Announcement>).detail ?? {};
      if (!provider || typeof provider.request !== 'function' || typeof info?.name !== 'string' || !info.name.trim()) return;
      const id = typeof info.rdns === 'string' && info.rdns ? info.rdns : typeof info.uuid === 'string' ? info.uuid : info.name;
      announcedAny = true;
      // A wallet that cannot add the Tempo network is not offered at all.
      if (found.has(id) || NO_CUSTOM_CHAINS.has(id)) {publish(); return;}
      // A known wallet without a usable announced icon keeps its bundled logo.
      found.set(id, {id, name: info.name.trim().slice(0, 40), icon: safeIcon(info.icon) ?? SUGGESTED_WALLETS.find(w => w.id === id)?.icon, provider});
      publish();
    };
    window.addEventListener('eip6963:announceProvider', announce);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    publish();
    // Some extensions inject window.ethereum shortly after the page loads.
    const late = window.setTimeout(publish, 600);
    return () => {window.removeEventListener('eip6963:announceProvider', announce); window.clearTimeout(late);};
  }, []);
  return wallets;
}

export function rememberWallet(id: string) {
  try {localStorage.setItem(SELECTED, id);} catch {/* The owner picks the wallet again after a reload. */}
}
export function rememberedWallet(): string | null {
  try {return localStorage.getItem(SELECTED);} catch {return null;}
}

/** Asks the wallet to switch to the configured Tempo chain, adding it first when the wallet does not know it.
 *  The sign-in still verifies the chain afterwards; a refusal leaves the wallet unchanged. */
export async function selectTempoChain(provider: TempoProvider, config: TempoConfig) {
  const chainId = numberToHex(config.chainId);
  const current = await provider.request({method: 'eth_chainId'}).catch(() => null);
  if (typeof current === 'string' && current.toLowerCase() === chainId) return;
  try {
    await provider.request({method: 'wallet_switchEthereumChain', params: [{chainId}]});
  } catch (error) {
    const code = (error as {code?: number; data?: {originalError?: {code?: number}}})?.code;
    const nested = (error as {data?: {originalError?: {code?: number}}})?.data?.originalError?.code;
    if (code !== 4902 && nested !== 4902) throw error;
    const testnet = config.network === 'tempo:testnet';
    await provider.request({method: 'wallet_addEthereumChain', params: [{
      chainId,
      chainName: testnet ? 'Tempo Testnet (Moderato)' : 'Tempo Localnet',
      // Tempo has no native gas token; wallets still require a placeholder currency.
      nativeCurrency: {name: 'USD', symbol: 'USD', decimals: 18},
      rpcUrls: [config.rpcUrl],
      ...(testnet ? {blockExplorerUrls: ['https://explore.testnet.tempo.xyz']} : {}),
    }]});
  }
}
