import {isStellarNetwork} from '@allowit/engine/stellar/runtime';
import {stellarDisplayUrl} from '@allowit/engine/stellar/explorer';
/** The sandbox is an explicit, loopback-only development capability. Public builds never enable it. */
export const localSandboxEnabled = typeof window !== 'undefined' && import.meta.env.DEV
  && import.meta.env.VITE_ALLOWIT_LOCAL_SANDBOX === '1' && ['127.0.0.1', 'localhost'].includes(window.location.hostname);

/** A real private validator, explicitly enabled only for loopback development acceptance. */
export const privateLocalnetEnabled = typeof window !== 'undefined' && import.meta.env.DEV
  && import.meta.env.VITE_ALLOWIT_PRIVATE_LOCALNET === '1' && ['127.0.0.1', 'localhost'].includes(window.location.hostname);
export const PRIVATE_LOCALNET = 'solana:localnet';
export const isPrivateLocalnet = (network: unknown): network is typeof PRIVATE_LOCALNET => privateLocalnetEnabled && network === PRIVATE_LOCALNET;

export function localSandboxSelected(): boolean {
  if (!localSandboxEnabled) return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('native') === '1' && params.get('network') === 'solana:localnet';
}

export function localDevnetSelected(): boolean {
  if (!localSandboxEnabled) return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('native') === '1' && params.get('network') === 'solana:devnet';
}

export function apiUrl(path: string): string {
  const prefix = localSandboxSelected() ? '/__sandbox' : localDevnetSelected() ? '/__devnet' : '';
  return `${prefix}/api/${path}`;
}

export function matchesSelectedNetwork(network: string): boolean {
  const requested = new URLSearchParams(window.location.search).get('network');
  if (requested && requested !== network) return false;
  if (network === 'solana:localnet') return localSandboxSelected();
  if (network === 'solana:devnet' && requested === network) return !localSandboxEnabled || localDevnetSelected();
  return true;
}

export function explorerUrl(kind: 'address' | 'tx', value: string, network: string): string {
  if (isStellarNetwork(network)) return stellarDisplayUrl(kind,value,network);
  const base = network === 'solana:localnet' && localSandboxEnabled ? '/__local' : 'https://explorer.solana.com';
  return `${base}/${kind}/${encodeURIComponent(value)}?cluster=${encodeURIComponent(network.split(':')[1])}`;
}

/** The CLI accepts an origin, not an API path. Local executor capabilities must reach the local backend. */
export function executorBundleForNetwork(bundle: unknown, network: string): unknown {
  if (!localSandboxEnabled || network !== 'solana:localnet' || !bundle || typeof bundle !== 'object') return bundle;
  const value = bundle as {audit?: unknown};
  if (!value.audit || typeof value.audit !== 'object') return bundle;
  return {...value, audit: {...value.audit, origin: 'http://127.0.0.1:8082'}};
}
