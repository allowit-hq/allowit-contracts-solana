import {isStellarNetwork} from '@allowit/engine/stellar/runtime';
import {stellarExplorerUrl} from '@allowit/engine/stellar/explorer';
import {PublicKey} from '@solana/web3.js';
import {tempoModerato} from 'viem/chains';
import {explorerUrl, localSandboxEnabled} from './runtime-network';

/** Programs and contracts open on the explorer's address page, except Stellar contracts, which have their own page. */
export type ExplorerKind = 'address' | 'tx' | 'contract';

/** Public explorers only. CAIP-2 IDs are the first 32 characters of each cluster's genesis hash. */
const SOLANA_CLUSTERS = new Map<string, string>([
  ['solana:mainnet', 'mainnet-beta'], ['solana:mainnet-beta', 'mainnet-beta'], ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'mainnet-beta'],
  ['solana:devnet', 'devnet'], ['solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1', 'devnet'],
  ['solana:testnet', 'testnet'], ['solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z', 'testnet'],
]);
// Tempo testnet is viem's Moderato chain, the definition tempo-view links with. x402 and the SDK CLI name it by its
// CAIP-2 chain ID, pinned to 42431 in tempo-contracts.ts.
const TEMPO_TESTNET_EXPLORER = tempoModerato.blockExplorers.default.url.replace(/\/+$/, '');
const TEMPO_EXPLORERS = new Map<string, string>([['tempo:testnet', TEMPO_TESTNET_EXPLORER], ['eip155:42431', TEMPO_TESTNET_EXPLORER]]);

// Base58 text long enough and short enough for 64 bytes. The text alone does not fix the size; solanaSignature decodes it.
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TEMPO_ADDRESS = /^0x[\da-fA-F]{40}$/;
const TEMPO_TX = /^0x[\da-fA-F]{64}$/;

const solanaKey = (value: string) => {
  try {return new PublicKey(value).toBase58() === value;} catch {return false;}
};
/**
 * A transaction signature is 64 Ed25519 bytes in base58: each leading '1' is a zero byte and the rest is one big-endian
 * number. Matching the alphabet is not enough; a 64-digit hex digest with no zero digit is also base58 text and usually
 * decodes to 47 bytes. The all-zero value is an unsigned transaction's placeholder, not a signature.
 */
function solanaSignature(value: string): boolean {
  if (!SOLANA_SIGNATURE.test(value)) return false;
  let number = 0n;
  for (const char of value) number = number * 58n + BigInt(BASE58.indexOf(char));
  if (number === 0n) return false;
  let bytes = 0;
  while (value[bytes] === '1') bytes++;
  for (; number > 0n; number /= 256n) bytes++;
  return bytes === 64;
}
const solanaValue = (kind: ExplorerKind, value: string) => kind === 'tx' ? solanaSignature(value) : solanaKey(value);


/** An explorer URL for a validated public value on a known network, otherwise null. Local IDs and digests have no explorer. */
export function chainExplorerUrl(kind: ExplorerKind, value: string, network: string): string | null {
  if (typeof value !== 'string' || typeof network !== 'string' || value.length > 128) return null;
  if (network === 'solana:localnet') return localSandboxEnabled && solanaValue(kind, value) ? explorerUrl(kind === 'tx' ? 'tx' : 'address', value, network) : null;
  const cluster = SOLANA_CLUSTERS.get(network);
  if (cluster) return solanaValue(kind, value) ? `https://explorer.solana.com/${kind === 'tx' ? 'tx' : 'address'}/${value}${cluster === 'mainnet-beta' ? '' : `?cluster=${cluster}`}` : null;
  if (isStellarNetwork(network)) return stellarExplorerUrl(kind,value,network);
  const tempo = TEMPO_EXPLORERS.get(network);
  if (tempo) return (kind === 'tx' ? TEMPO_TX : TEMPO_ADDRESS).test(value) ? `${tempo}/${kind === 'tx' ? 'tx' : 'address'}/${value}` : null;
  return null;
}
