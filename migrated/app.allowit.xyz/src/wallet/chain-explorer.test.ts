import {describe, expect, it} from 'vitest';
import {chainExplorerUrl} from './chain-explorer';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIGNATURE = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const STELLAR_ACCOUNT = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const TEMPO_TX = '0x' + '7f'.repeat(32);

describe('chainExplorerUrl', () => {
  it('rejects malformed, padded and injected Solana values', () => {
    const values = ['', ` ${USDC}`, `${USDC}\n`, `${USDC}1`, `${USDC.slice(0, -1)}0`, `${USDC}?cluster=mainnet-beta`, `../${USDC}`, `%2F${USDC}`, 'javascript:alert(1)', USDC.replace('E', '\u0415')];
    for (const value of values) {
      expect(chainExplorerUrl('address', value, 'solana:devnet')).toBeNull();
      expect(chainExplorerUrl('tx', value, 'solana:devnet')).toBeNull();
    }
    expect(chainExplorerUrl('address', SIGNATURE, 'solana:devnet')).toBeNull();
    expect(chainExplorerUrl('tx', USDC, 'solana:devnet')).toBeNull();
  });

  it('only produces https links on known explorer hosts', () => {
    const urls = [
      chainExplorerUrl('address', USDC, 'solana:devnet'), chainExplorerUrl('tx', SIGNATURE, 'solana:mainnet'),
      chainExplorerUrl('address', STELLAR_ACCOUNT, 'stellar:mainnet'), chainExplorerUrl('tx', TEMPO_TX, 'tempo:testnet'),
    ];
    for (const url of urls) {
      const parsed = new URL(url ?? 'invalid:');
      expect(parsed.protocol).toBe('https:');
      expect(['explorer.solana.com', 'stellar.expert', 'explore.testnet.tempo.xyz']).toContain(parsed.hostname);
    }
  });
});
