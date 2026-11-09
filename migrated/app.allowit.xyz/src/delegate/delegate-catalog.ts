import {displayDelegateAmount, delegateUnits, type DelegateConfig, type DelegateService} from './delegate-contracts';
import {PAYSH_SERVICES, type RegisteredCatalogService} from '../paysh/paysh-catalog';

/** A provider is connected only when this network's server registers at least one usable endpoint. */
export function connectedDelegateCatalog(config: DelegateConfig | null, network: string): RegisteredCatalogService[] {
  if (!config || config.displayNetwork !== network || !Array.isArray(config.services)) return [];
  const registered = config.services.filter(service => {
    try {
      if (!service || typeof service.id !== 'string' || !service.id || typeof service.action !== 'string'
        || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(service.method) || typeof service.url !== 'string' || !service.url.startsWith('https://')) return false;
      const cap = service.maxAmountUnits === null ? null : delegateUnits(service.maxAmountUnits);
      return cap === null ? service.amountLimit === 'approved-grant' : cap > 0n;
    } catch { return false; }
  });
  const providers = new Map<string, {row: RegisteredCatalogService; services: DelegateService[]}>();
  for (const service of registered) {
    try {
      const catalog = service.providerId ? service : registered.find(candidate => candidate.providerId && candidate.method === service.method && candidate.url === service.url);
      const id = catalog?.providerId || service.id;
      let provider = providers.get(id);
      if (!provider) {
        const listed = PAYSH_SERVICES.find(item => item.fqn === id);
        provider = {row: {
          id,
          name: catalog?.providerName ?? service.providerName ?? listed?.title ?? service.name ?? id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' '),
          category: catalog?.category ?? service.category ?? listed?.category ?? service.action,
          action: service.action,
        }, services: []};
        providers.set(id, provider);
      }
      provider.services.push(service);
    } catch { /* A malformed descriptor cannot make a service look connected. */ }
  }
  return [...providers.values()].map(({row, services}) => {
    const distinct = new Map<string, DelegateService>();
    for (const service of services) {
      const key = JSON.stringify([service.method, service.url]);
      if (!distinct.has(key)) distinct.set(key, service);
    }
    const endpoints = [...distinct.values()];
    const caps = services.map(service => service.maxAmountUnits);
    const cap = caps.every(value => value !== null) ? caps.reduce((maximum, value) => delegateUnits(value!) > delegateUnits(maximum!) ? value : maximum) : null;
    return {...row, endpointCount: endpoints.length,
      ...(cap === null ? {} : {maxAmount: displayDelegateAmount(cap)}),
      ...(endpoints.length === 1 ? {method: endpoints[0].method, url: endpoints[0].url} : {}),
    };
  });
}
