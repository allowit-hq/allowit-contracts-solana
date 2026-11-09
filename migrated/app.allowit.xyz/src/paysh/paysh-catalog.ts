import catalog from './paysh-catalog.json' with {type: 'json'};

/**
 * pay.sh providers and the Solana wallet each is paid at, from `scripts/update-paysh-catalog.mjs`. `networks` lists the
 * Solana networks the provider's published or live payment requirements accept.
 */
export interface PayshService {
  fqn: string; title: string; description: string; category: string; endpointCount: number; freeTier: boolean; metered: boolean;
  minPriceUsd: number; maxPriceUsd: number; payTo: string; networks: string[];
}
export const PAYSH_SERVICES: readonly PayshService[] = catalog.providers;
export const PAYSH_CATALOG_DATE: string = catalog.generatedAt;

const NETWORK_LABELS: Record<string, string> = {'solana:mainnet': 'Mainnet', 'solana:devnet': 'Devnet', 'solana:testnet': 'Testnet'};
/** The Solana networks pay.sh takes payment on for a service, in words. */
export const payshNetworks = (svc: PayshService) => svc.networks.map(n => NETWORK_LABELS[n] ?? n).join(' and ');

const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? `$${Number(n.toPrecision(2))}` : `$${n.toFixed(2).replace(/\.00$/, '')}`);
/** The price range pay.sh states for a provider, in words. */
export const priceRange = (s: Pick<PayshService, 'minPriceUsd' | 'maxPriceUsd'>) =>
  s.maxPriceUsd <= 0 ? 'Free' : s.minPriceUsd === s.maxPriceUsd ? usd(s.maxPriceUsd) : s.minPriceUsd <= 0 ? `up to ${usd(s.maxPriceUsd)}` : `${usd(s.minPriceUsd)}–${usd(s.maxPriceUsd)}`;

const CATEGORY: Record<string, string> = {ai_ml: 'AI / ML', devtools: 'Dev tools'};
/** pay.sh's category slug in words. */
export const categoryLabel = (c: string) => CATEGORY[c] ?? c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, ' ');
/** How pay.sh bills a provider: a free tier first, else per use, else a fixed price. */
export const billing = (s: Pick<PayshService, 'freeTier' | 'metered'>) => (s.freeTier ? 'Free tier' : s.metered ? 'Metered' : 'Fixed price');

/** One row of a policy's service list: a server-registered service, a pay.sh provider, or both under one ID. */
export interface RegisteredCatalogService {
  id: string; name?: string; category?: string; action?: string; method?: string; url?: string; maxAmount?: string; endpointCount?: number;
}
export interface CatalogService {id: string; title: string; category: string; registered: boolean; paysh: PayshService | null; connection?: RegisteredCatalogService}

/**
 * Every pay.sh provider plus every service the server registers, matched by ID (the pay.sh FQN). Only registered rows
 * can be put on a policy; a registered service pay.sh does not publish keeps the server's name and no pay.sh details.
 */
export function policyCatalog(registered: readonly RegisteredCatalogService[]): CatalogService[] {
  const ids = new Set(registered.map(s => s.id));
  const paysh = new Map(PAYSH_SERVICES.map(s => [s.fqn, s]));
  return [
    ...PAYSH_SERVICES.map(s => ({id: s.fqn, title: s.title, category: s.category, registered: ids.has(s.fqn), paysh: s, connection: registered.find(item => item.id === s.fqn)})),
    ...registered.filter(s => !paysh.has(s.id)).map(s => ({id: s.id, title: s.name ?? s.id, category: s.category ?? s.action ?? 'other', registered: true, paysh: null, connection: s})),
  ];
}
