import {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowDown, ArrowLeft, ArrowUp, Check, Plus, Search} from 'lucide-react';
import {billing, categoryLabel, PAYSH_CATALOG_DATE, payshNetworks, policyCatalog, priceRange, type CatalogService, type RegisteredCatalogService} from './paysh-catalog';
import './paysh-catalog.css';

type SortKey = 'service' | 'endpoints' | 'price';
type Sort = {key: SortKey; dir: 1 | -1};

interface Props {
  /** The services the server registers for this request; only these can be listed. */
  registered: readonly RegisteredCatalogService[];
  /** Service IDs on the policy's list, in order. */
  selected: readonly string[];
  max: number;
  /** The policy network, as a CAIP-style ID and in words. */
  network: string;
  networkLabel: string;
  onChange: (ids: string[]) => void;
  onDone: () => void;
  /** Why a row cannot be added, in words. Defaults to the server not registering it. */
  availability?: Availability;
  /** Native vaults start with their connected services; pay.sh discovery is an explicit choice. */
  native?: boolean;
  browseOnly?: boolean;
}
export interface Availability {label: string; detail: (s: CatalogService) => string; filter: string}
const SERVER_AVAILABILITY: Availability = {
  label: 'Not on this server',
  detail: () => 'This server does not register this service, so a policy cannot pay it.',
  filter: 'Available on this server only',
};

const compare: Record<SortKey, (a: CatalogService, b: CatalogService) => number> = {
  service: (a, b) => a.title.localeCompare(b.title),
  endpoints: (a, b) => (a.connection?.endpointCount ?? a.paysh?.endpointCount ?? (a.connection?.url ? 1 : -1)) - (b.connection?.endpointCount ?? b.paysh?.endpointCount ?? (b.connection?.url ? 1 : -1)),
  price: (a, b) => (a.paysh?.maxPriceUsd ?? Number(a.connection?.maxAmount ?? -1)) - (b.paysh?.maxPriceUsd ?? Number(b.connection?.maxAmount ?? -1)) || (a.paysh?.minPriceUsd ?? -1) - (b.paysh?.minPriceUsd ?? -1),
};

/**
 * The pay.sh catalog as the policy's service list: search, category tabs with counts and sortable columns. Only services
 * the server registers for this request can be added, because the compiled policy and its wallet check exactly those
 * service IDs. Other pay.sh services stay visible and say so. Services this server can use come first.
 */
export default function PayshCatalog({registered, selected, max, network, networkLabel, onChange, onDone, availability = SERVER_AVAILABILITY, native = false, browseOnly = false}: Props) {
  const services = useMemo(() => policyCatalog(registered), [registered]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [availableOnly, setAvailableOnly] = useState(native);
  const [sort, setSort] = useState<Sort>({key: 'endpoints', dir: -1});
  const searchRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  // The hatched filler closes the last row of tabs only; the grid reports how many columns it laid out.
  const [columns, setColumns] = useState(0);
  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const measure = () => setColumns(getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const full = !browseOnly && selected.length >= max;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter(v => v !== id) : [...selected, id]);

  useEffect(() => {
    // "/" jumps to the search field, as on pay.sh.
    const slash = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || target?.closest('input, textarea, select, [contenteditable]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', slash);
    return () => document.removeEventListener('keydown', slash);
  }, []);

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return services.filter(s => (!availableOnly || s.registered) && (!q || `${s.title} ${s.id} ${categoryLabel(s.category)} ${s.paysh?.description ?? ''}`.toLowerCase().includes(q)));
  }, [services, query, availableOnly]);
  const tabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of searched) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    const categories = native && availableOnly ? services.filter(s => s.registered) : services;
    const all = [...new Set(categories.map(s => s.category))].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b));
    return [{id: 'all', label: 'All', count: searched.length}, ...all.map(id => ({id, label: categoryLabel(id), count: counts.get(id) ?? 0}))];
  }, [services, searched, native, availableOnly]);
  const rows = useMemo(
    () => searched.filter(s => category === 'all' || s.category === category).sort((a, b) => Number(b.registered) - Number(a.registered) || sort.dir * compare[sort.key](a, b) || a.title.localeCompare(b.title)),
    [searched, category, sort],
  );
  // A new filter replays the row entrance; sorting alone keeps rows still.
  const pass = `${query}|${category}|${availableOnly}`;

  const resort = (key: SortKey) => setSort(s => ({key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'service' ? 1 : -1}));
  const header = (key: SortKey, label: string) => {
    const on = sort.key === key;
    const Icon = sort.dir === 1 ? ArrowUp : ArrowDown;
    return (
      <th scope="col" aria-sort={on ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button type="button" className="wl-sort" data-on={on || undefined} onClick={() => resort(key)}>
          {label}
          <Icon size={13} aria-hidden="true" />
        </button>
      </th>
    );
  };

  return (
    <section className="wl" aria-labelledby="wl-title">
      <div className="wl-head">
        <button type="button" className="wl-back" onClick={onDone}>
          <ArrowLeft size={16} aria-hidden="true" />
          Back to the policy
        </button>
        <div className="wl-title-row">
          <div>
            <h1 className="wl-title" id="wl-title" tabIndex={-1}>
              {native ? 'API services' : 'PaySH whitelist'}
            </h1>
            <p className="wl-lede">{browseOnly ? 'Connected services on this network. Each paid request must satisfy the saved policy.' : native ? 'Choose a connected service for this policy. Adding a service does not make a payment.' : 'Pick the services this policy may pay. The compiled policy pays only listed services; a request for any other service fails.'}</p>
          </div>
          <div className="wl-summary">
            <span className="wl-count" aria-live="polite">
              <span className="mono">{browseOnly ? registered.length : selected.length}</span>
              <span className="wl-count-of">{browseOnly ? ' connected' : ` / ${max} selected`}</span>
            </span>
            <button type="button" className="btn btn-primary" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      </div>

      {native && !availableOnly ? <p className="wl-note" role="status">{browseOnly ? 'Other PaySH services are listed for discovery. Payments use connected services and the saved policy.' : 'PaySH lists more services. Only connected services can be added to this policy.'}</p> : null}

      <div className="wl-search">
        <Search size={18} aria-hidden="true" />
        <input ref={searchRef} type="search" aria-label="Search pay.sh services" placeholder="Search services" autoComplete="off" spellCheck={false} value={query} onChange={e => setQuery(e.target.value)} />
        <kbd aria-hidden="true">/</kbd>
      </div>

      <div className="wl-tabs" role="group" aria-label="Category" ref={tabsRef}>
        {tabs.map(t => (
          <button key={t.id} type="button" className="wl-tab" aria-pressed={category === t.id} disabled={!t.count && category !== t.id} onClick={() => setCategory(t.id)}>
            <span>{t.label}</span>
            <span className="wl-tab-count mono">{t.count}</span>
          </button>
        ))}
        {columns && tabs.length % columns ? <span className="wl-tab-fill" aria-hidden="true" style={{gridColumn: `span ${columns - (tabs.length % columns)}`}} /> : null}
      </div>

      <div className="wl-filters">
        <label className="wl-switch">
          <input type="checkbox" role="switch" checked={availableOnly} onChange={e => {setAvailableOnly(e.target.checked); if (native) setCategory('all');}} />
          <span className="wl-switch-track" aria-hidden="true" />
          {availability.filter}
        </label>
        {/* Narrow screens hide the table header, so the same sort choices sit here. */}
        <div className="wl-sort-bar" role="group" aria-label="Sort">
          {(['service', 'endpoints', 'price'] as const).map(key => (
            <button key={key} type="button" className="wl-sort" data-on={sort.key === key || undefined} aria-pressed={sort.key === key} onClick={() => resort(key)}>
              {{service: 'Service', endpoints: 'Endpoints', price: 'Price'}[key]}
              {sort.key === key ? (sort.dir === 1 ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />) : null}
            </button>
          ))}
        </div>
        <span className="wl-meta">
          {rows.length} of {services.length} · catalog of {PAYSH_CATALOG_DATE.slice(0, 10)}
        </span>
      </div>

      <div className="wl-table-wrap">
        <table className="wl-table">
          <thead>
            <tr>
              {header('service', 'Service')}
              <th scope="col">Category</th>
              {header('endpoints', 'Endpoints')}
              {header('price', 'Price')}
              <th scope="col">{native ? 'Listed payment networks' : 'Paid on'}</th>
              <th scope="col">
                <span className="sr-only">{browseOnly ? 'Availability' : 'Whitelist'}</span>
              </th>
            </tr>
          </thead>
          <tbody key={pass}>
            {rows.map((s, i) => {
              const on = selected.includes(s.id);
              const p = s.paysh;
              return (
                <tr key={s.id} className="wl-row" data-selected={on || undefined} data-unavailable={!s.registered || undefined} style={{['--i' as string]: Math.min(i, 18)}}>
                  <td className="wl-service">
                    <span className="wl-service-title">{s.title}</span>
                    <span className="wl-fqn mono">{s.id}</span>
                    {p ? <span className="wl-desc" title={p.description}>{p.description}</span> : null}
                    {s.connection?.url ? <span className="wl-desc">{s.connection.method} {s.connection.url}</span> : null}
                  </td>
                  <td data-label="Category">
                    <span className="wl-chip">{categoryLabel(s.category)}</span>
                  </td>
                  <td className="mono wl-num" data-label="Endpoints">{s.connection?.endpointCount ?? p?.endpointCount ?? (s.connection?.url ? 1 : '—')}</td>
                  <td data-label="Price">
                    {p ? (
                      <>
                        <span className="mono wl-price">{priceRange(p)}</span>
                        <span className="wl-billing">{billing(p)}</span>
                      </>
                    ) : s.connection?.maxAmount ? <>
                      <span className="mono wl-price">Up to {s.connection.maxAmount} USDC</span>
                      <span className="wl-billing">Per request · policy limits apply</span>
                    </> : (
                      <span className="wl-billing">Registered on this server</span>
                    )}
                  </td>
                  <td data-label={native ? 'Listed payment networks' : 'Paid on'}>
                    {p ? <span className="wl-net" data-here={p.networks.includes(network) && (!native || s.registered) || undefined}>{payshNetworks(p)}</span> : <span className="wl-net" data-here>{networkLabel}</span>}
                  </td>
                  <td className="wl-action">
                    {browseOnly ? <span className="wl-unavailable" title={s.registered ? 'Requests to this service are checked against the saved policy before payment.' : availability.detail(s)}>{s.registered ? 'Connected' : availability.label}</span> : s.registered || on ? (
                      <button type="button" className="wl-add" aria-pressed={on} aria-label={`${on ? 'Remove' : 'Add'} ${s.id}`} disabled={!on && full} onClick={() => toggle(s.id)}>
                        {on ? <Check size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
                        <span>{on ? 'Added' : 'Add'}</span>
                      </button>
                    ) : (
                      <span className="wl-unavailable" title={availability.detail(s)}>{availability.label}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length ? null : <p className="wl-empty">{native && availableOnly && !registered.length && !query.trim() ? 'No API service is connected to this server. Paid API requests are unavailable.' : <>No service matches{query.trim() ? <> “{query.trim()}”</> : null}.</>}</p>}
      </div>
      {full ? <p className="wl-note">The whitelist holds {max} services. Remove one to add another.</p> : null}
    </section>
  );
}
