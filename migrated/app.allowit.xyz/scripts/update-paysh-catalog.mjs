#!/usr/bin/env node
// Refreshes src/paysh/paysh-catalog.json: the Solana wallet each pay.sh provider is paid at, per network.
// Reads the public pay.sh skills index and provider details; a provider whose details publish no Solana payTo is
// asked once, unpaid, for its HTTP 402 payment requirements. Nothing is paid and no credential is sent.
import {writeFile} from 'node:fs/promises';

const BASE = 'https://storage.googleapis.com/pay-skills/v1';
const OUT = new URL('../src/paysh/paysh-catalog.json', import.meta.url);
const NETWORKS = {
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'solana:mainnet',
  solana: 'solana:mainnet',
  'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1': 'solana:devnet',
  'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z': 'solana:testnet',
};
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const json = async url => {
  const response = await fetch(url, {signal: AbortSignal.timeout(60_000)});
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
};

/** Every x402 `accepts` entry anywhere in a document. */
function accepts(node, found = []) {
  if (Array.isArray(node)) node.forEach(v => accepts(v, found));
  else if (node && typeof node === 'object') {
    if (typeof node.payTo === 'string' && typeof node.network === 'string') found.push(node);
    Object.values(node).forEach(v => accepts(v, found));
  }
  return found;
}

async function live(provider, detail) {
  const endpoints = (detail.endpoints ?? []).filter(e => e && typeof e.path === 'string').slice(0, 3);
  for (const e of endpoints) {
    const method = String(e.method ?? 'GET').toUpperCase();
    const url = `${provider.service_url.replace(/\/+$/, '')}/${e.path.replace(/^\/+/, '')}`;
    try {
      const response = await fetch(url, {method, headers: {'content-type': 'application/json'}, body: ['POST', 'PUT', 'PATCH'].includes(method) ? '{}' : undefined, signal: AbortSignal.timeout(30_000)});
      if (response.status !== 402) continue;
      const header = response.headers.get('payment-required');
      const required = header ? JSON.parse(Buffer.from(header, 'base64').toString('utf8')) : await response.json().catch(() => ({}));
      const found = accepts(required);
      if (found.some(a => a.network.startsWith('solana'))) return found;
    } catch {
      // An unreachable endpoint leaves the provider without a target.
    }
  }
  return [];
}

const index = await json(`${BASE}/skills.json`);
const providers = [];
for (const provider of index.providers) {
  const detail = await json(`${BASE}/providers/${provider.fqn}.json`);
  let found = accepts(detail).filter(a => a.network.startsWith('solana'));
  if (!found.length) found = (await live(provider, detail)).filter(a => a.network.startsWith('solana'));
  const payTo = [...new Set(found.map(a => a.payTo))];
  const networks = [...new Set(found.map(a => NETWORKS[a.network]).filter(Boolean))].sort();
  // One wallet per provider; a provider naming several is left out rather than guessed.
  if (payTo.length !== 1 || !BASE58.test(payTo[0]) || !networks.length) continue;
  providers.push({
    fqn: provider.fqn, title: provider.title, description: provider.description, category: provider.category,
    endpointCount: provider.endpoint_count, freeTier: provider.has_free_tier, metered: provider.has_metering,
    minPriceUsd: provider.min_price_usd, maxPriceUsd: provider.max_price_usd, payTo: payTo[0], networks,
  });
}
providers.sort((a, b) => a.fqn.localeCompare(b.fqn));
await writeFile(OUT, JSON.stringify({generatedAt: index.generated_at, source: `${BASE}/skills.json`, providers}, null, 1) + '\n');
console.log(`${providers.length} of ${index.providers.length} pay.sh providers have one Solana payTo.`);
